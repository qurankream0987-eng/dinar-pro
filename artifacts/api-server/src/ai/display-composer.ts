/**
 * Phase 2 — model-driven display. The model chooses a *form* (DisplayDirective); this module
 * decides whether DINAR's own verified data fits that form and builds the card from those
 * records only. Nothing here reads a figure from model output. A form the data cannot support
 * returns the canonical form with a short, honest notice instead of an invented display.
 */
import {
  ComposedSurfaceSchema,
  type ComposedSurface,
  type ComposedSurfaceInput,
  type DisplayDirective,
  type DisplayFormat,
} from "@workspace/api-zod/surface-composition";
import type { BusinessOverview } from "./model-read-capabilities";

type Analytics = NonNullable<BusinessOverview["businesses"][number]["analytics"]>;

export type DisplayOutcome = {
  /** The validated server-composed card, when one fits. */
  surface?: ComposedSurface;
  /** A truthful explanation shown with the answer when the requested form does not fit. */
  notice?: string;
  /** The form actually used, for logs and acceptance measurements. */
  applied: DisplayFormat | "NONE";
};

const MONTH = new Intl.DateTimeFormat("ar", { month: "short", year: "numeric", timeZone: "UTC" });
const monthLabel = (month: string) => {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? month : MONTH.format(date);
};
const amount = (minor: number, scale: number, currency: string) => `${(minor / 10 ** scale).toFixed(scale)} ${currency}`;
const count = (value: number) => new Intl.NumberFormat("en").format(value);
const clip = (value: string, max: number) => value.slice(0, max);

export const NOT_PROFIT_NOTE = "هذه إيرادات طلبات مكتملة وليست ربحًا: لا يسجّل DINAR تكاليفك أو مصاريفك.";
const SOURCE_MONTHS = "طلبات مكتملة في DINAR حسب شهر الطلب";
const SOURCE_CATEGORIES = "طلبات مكتملة في DINAR حسب تصنيف المنتج";

function validated(input: ComposedSurfaceInput): ComposedSurface | undefined {
  const parsed = ComposedSurfaceSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Resolves a display for the owner's business figures. The business is the first one the
 * server read with analytics permission; the figures are exactly that read's.
 */
export function composeBusinessDisplay(directive: DisplayDirective | undefined, overview: BusinessOverview | undefined): DisplayOutcome {
  const format = directive?.format ?? "AUTO";
  if (format === "TEXT") return { applied: "TEXT" };
  // With several businesses, the one with recorded sales is shown (its name heads the card);
  // a tie keeps the server's order. The model never names which business's figures to draw.
  const business = [...(overview?.businesses ?? [])]
    .filter((entry) => entry.analytics?.monthly)
    .sort((a, b) => (b.analytics!.completedOrders ?? 0) - (a.analytics!.completedOrders ?? 0))[0];
  const analytics = business?.analytics;
  if (!business || !analytics || analytics.minorUnitScale === undefined)
    return {
      applied: "NONE",
      notice: overview?.businesses.length
        ? "لا تتوفر أرقام مبيعات يمكن عرضها لهذا النشاط (الصلاحية أو التوثيق غير مكتمل)، فلم أعرض أي رسم."
        : undefined,
    };
  const scale = analytics.minorUnitScale;
  const currency = analytics.currency;
  const months = (analytics.monthly ?? []).filter((row) => /^\d{4}-\d{2}$/.test(row.month));
  const categories = (analytics.byCategory ?? []).filter((row) => row.revenueMinor >= 0);
  const hasMonthlySales = months.length >= 2 && months.some((row) => row.completedOrders > 0);
  const period = months.length ? `${monthLabel(months[0]!.month)} – ${monthLabel(months.at(-1)!.month)}` : undefined;
  const header = { type: "header" as const, title: clip(business.name, 120) || "نشاطك", subtitle: "أرقام من سجلات DINAR", icon: "CHART" as const };
  const metric = {
    type: "metrics" as const,
    label: "الإجمالي",
    items: [
      { key: "d-orders", label: "طلبات مكتملة", value: count(analytics.completedOrders) },
      { key: "d-revenue", label: "إيراد مكتمل", value: clip(amount(analytics.completedRevenueMinor ?? 0, scale, currency), 120) },
    ],
  };
  const monthTable = {
    type: "table" as const,
    label: "الطلبات المكتملة حسب الشهر",
    columns: [
      { key: "month", label: "الشهر", kind: "TEXT" as const },
      { key: "orders", label: "طلبات مكتملة", kind: "NUMBER" as const, sortable: true },
      { key: "revenue", label: "الإيراد", kind: "MONEY" as const, sortable: true },
    ],
    rows: months.map((row) => ({
      key: `m-${row.month}`,
      cells: [
        { display: monthLabel(row.month) },
        { display: count(row.completedOrders), sort: row.completedOrders },
        { display: amount(row.revenueMinor, scale, currency), sort: row.revenueMinor },
      ],
    })),
    source: SOURCE_MONTHS,
  };
  const monthLine = {
    type: "series" as const,
    kind: "LINE" as const,
    label: clip(`الإيراد المكتمل شهريًا (${currency})`, 80),
    ...(period ? { period: clip(period, 80) } : {}),
    source: SOURCE_MONTHS,
    points: months.map((row) => ({ label: monthLabel(row.month), value: row.revenueMinor / 10 ** scale, display: amount(row.revenueMinor, scale, currency) })),
  };
  const total = categories.reduce((sum, row) => sum + row.revenueMinor, 0);
  const categoryShare = categories.length >= 2 && categories.length <= 6 && total > 0;
  const categoryDonut = {
    type: "series" as const,
    kind: "DONUT" as const,
    label: "حصة كل تصنيف من الإيراد المكتمل",
    source: SOURCE_CATEGORIES,
    // Percentages are computed from the same integers shown in the table; they add up to ~100.
    points: categories.map((row) => ({ label: clip(row.category, 40), value: row.revenueMinor / 10 ** scale, display: `${((row.revenueMinor / total) * 100).toFixed(1)}% · ${amount(row.revenueMinor, scale, currency)}` })),
  };
  const categoryBars = {
    type: "bars" as const,
    label: "الإيراد المكتمل حسب التصنيف",
    items: categories.slice(0, 8).map((row, index) => ({ label: clip(row.category, 120), value: row.revenueMinor, display: clip(amount(row.revenueMinor, scale, currency), 80), testId: `d-cat-${index}` })),
  };
  const note = { type: "text" as const, muted: true, text: NOT_PROFIT_NOTE };
  const card = (sections: ComposedSurfaceInput["sections"], label: string): ComposedSurface | undefined =>
    validated({ version: 1, label, size: "WIDE", testId: "model-display", sections: [header, ...sections, note] });

  const noSales = "لا توجد طلبات مكتملة في الأشهر الستة الأخيرة، فلا يوجد اتجاه أرسمه؛ هذه الأرقام الإجمالية من السجلات.";
  switch (format) {
    case "METRIC":
      return { applied: "METRIC", surface: card([metric], "الإجمالي") };
    case "LINE":
    case "AUTO":
      if (!hasMonthlySales) return { applied: "METRIC", surface: card([metric], "الإجمالي"), notice: format === "LINE" ? noSales : undefined };
      return { applied: "LINE", surface: card(format === "AUTO" ? [metric, monthLine, monthTable] : [monthLine, monthTable], "المبيعات الشهرية") };
    case "TABLE":
      return months.length
        ? { applied: "TABLE", surface: card([monthTable, ...(categories.length ? [{ ...categoryTableOf(categories, scale, currency) }] : [])], "جدول المبيعات") }
        : { applied: "METRIC", surface: card([metric], "الإجمالي") };
    case "BAR":
      if (categories.length >= 2) return { applied: "BAR", surface: card([categoryBars], "المبيعات حسب التصنيف") };
      if (!hasMonthlySales) return { applied: "METRIC", surface: card([metric], "الإجمالي"), notice: noSales };
      return {
        applied: "BAR",
        surface: card([{ type: "bars", label: "الإيراد المكتمل حسب الشهر", items: months.slice(-8).map((row, index) => ({ label: monthLabel(row.month), value: row.revenueMinor, display: amount(row.revenueMinor, scale, currency), testId: `d-month-${index}` })) }], "المبيعات الشهرية"),
      };
    case "DONUT":
      if (categoryShare) return { applied: "DONUT", surface: card([categoryDonut, categoryTableOf(categories, scale, currency)], "توزيع المبيعات") };
      return {
        applied: "METRIC",
        surface: card([metric], "الإجمالي"),
        notice: categories.length > 6
          ? "لديك أكثر من ستة تصنيفات، والرسم الدائري لا يبقى مقروءًا؛ هذه الأرقام كجدول بدلًا منه."
          : "لا يوجد في سجلاتك أكثر من تصنيف واحد بمبيعات مكتملة، فلا توجد نسب أعرضها برسم دائري.",
      };
    default:
      // CARDS / COMPARISON describe listing results, not business figures.
      return { applied: "METRIC", surface: card([metric], "الإجمالي") };
  }
}

function categoryTableOf(categories: { category: string; completedOrders: number; revenueMinor: number }[], scale: number, currency: string) {
  return {
    type: "table" as const,
    label: "المبيعات حسب التصنيف",
    columns: [
      { key: "category", label: "التصنيف", kind: "TEXT" as const },
      { key: "orders", label: "طلبات مكتملة", kind: "NUMBER" as const, sortable: true },
      { key: "revenue", label: "الإيراد", kind: "MONEY" as const, sortable: true },
    ],
    rows: categories.slice(0, 30).map((row, index) => ({
      key: `c-${index}`,
      cells: [
        { display: clip(row.category, 120) },
        { display: count(row.completedOrders), sort: row.completedOrders },
        { display: amount(row.revenueMinor, scale, currency), sort: row.revenueMinor },
      ],
    })),
    source: SOURCE_CATEGORIES,
  };
}

/** A user who asked for words gets words: model card fences are removed from a TEXT answer. */
export function withoutVisualFences(reply: string): string {
  return reply.replace(/```dinar-[a-z]+[\s\S]*?```/gu, "").replace(/\n{3,}/gu, "\n\n").trim();
}
