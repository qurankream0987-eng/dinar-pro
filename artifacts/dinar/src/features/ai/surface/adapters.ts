import type { SellerBusinessInsight, SellerSalesInsight } from "@workspace/api-zod/conversation-runtime";
import type { ComposedSurfaceInput, SurfaceAction } from "@workspace/api-zod/surface-composition";
import type { CommercialPayload } from "../commercial-types";

/**
 * Deterministic adapters: a canonical server payload in, a composition of shared primitives
 * out. No model call, no arithmetic on money, no invented values — each figure is copied from
 * the payload. Follow-up actions are utterances the server already understands, so pressing
 * one is the same as typing it and goes through the same checks.
 */

const number = (value: number) => value.toLocaleString("en-US");

// ─── Seller analytics ─────────────────────────────────────────────────────────

const SALES_PERIOD_WORDS: Record<SellerSalesInsight["period"]["key"], string> = {
  TODAY: "اليوم",
  LAST_7_DAYS: "آخر 7 أيام",
  THIS_MONTH: "هذا الشهر",
  LAST_MONTH: "الشهر الماضي",
  LAST_30_DAYS: "آخر 30 يوم",
  ALL_TIME: "كل الفترات",
};

function salesFollowUps(insight: SellerSalesInsight): SurfaceAction[] {
  const key = insight.period.key;
  const actions: SurfaceAction[] = [];
  if (key !== "LAST_7_DAYS")
    actions.push({ kind: "SEND", label: "آخر 7 أيام", message: "إحصائيات مبيعاتي آخر 7 أيام", emphasis: "SECONDARY", testId: "sales-period-week" });
  if (key !== "THIS_MONTH")
    actions.push({ kind: "SEND", label: "هذا الشهر", message: "إحصائيات مبيعاتي هذا الشهر", emphasis: "SECONDARY", testId: "sales-period-month" });
  if (!insight.previous && key !== "ALL_TIME")
    actions.push({
      kind: "SEND",
      label: "قارن بالفترة السابقة",
      message: `قارن مبيعاتي ${SALES_PERIOD_WORDS[key]} بالفترة السابقة`,
      emphasis: "SECONDARY",
      testId: "sales-compare",
    });
  return actions.slice(0, 3);
}

export function salesSurface(insight: SellerSalesInsight): ComposedSurfaceInput {
  const previous = new Map(insight.previous?.metrics.map((metric) => [metric.key, metric]) ?? []);
  const trend = (raw: number, before?: number) =>
    before === undefined ? undefined : raw > before ? ("UP" as const) : raw < before ? ("DOWN" as const) : ("FLAT" as const);
  const actions = salesFollowUps(insight);
  return {
    version: 1,
    label: "مبيعاتك",
    size: insight.previous ? "WIDE" : "MEDIUM",
    testId: "sales-summary",
    state: insight.metrics.some((metric) => metric.raw) || insight.previous?.metrics.some((metric) => metric.raw) ? "READY" : "EMPTY",
    sections: [
      { type: "header", title: "مبيعاتك", source: "من سجل DINAR", badge: { label: insight.currencyCode, tone: "GOLD" }, icon: "CHART" },
      {
        type: "text",
        muted: true,
        testId: "sales-period",
        text: `${insight.period.label}${insight.previous ? ` مقابل ${insight.previous.period.label}` : ""}`,
      },
      {
        type: "metrics",
        label: "أرقام الفترة",
        items: insight.metrics.map((metric) => ({
          key: metric.key,
          label: metric.label,
          value: metric.value,
          previous: previous.get(metric.key)?.value,
          trend: trend(metric.raw, previous.get(metric.key)?.raw),
          testId: `sales-metric-${metric.key}`,
        })),
      },
      ...(insight.topProducts.length
        ? [{
            type: "bars" as const,
            label: "أكثر منتجاتك طلبًا",
            items: insight.topProducts.map((item) => ({
              label: item.label || "إعلان بلا عنوان",
              value: item.units,
              display: `${number(item.units)} قطعة · ${number(item.orders)} طلب`,
              testId: "sales-top-product",
            })),
          }]
        : []),
      ...insight.notes.map((note) => ({ type: "text" as const, text: note, muted: true })),
      ...(actions.length ? [{ type: "actions" as const, items: actions }] : []),
    ],
  };
}

const INVENTORY_STATUS: Record<string, string> = { PUBLISHED: "منشور", PAUSED: "موقوف", DRAFT: "مسودة", ARCHIVED: "مؤرشف" };
const BUSINESS_TITLES: Record<SellerBusinessInsight["topic"], string> = {
  INVENTORY: "بضاعتك",
  ORDERS: "طلبات إعلاناتك",
  PERFORMANCE: "أداء إعلاناتك",
};

export function businessSurface(insight: SellerBusinessInsight): ComposedSurfaceInput {
  const title = BUSINESS_TITLES[insight.topic];
  const header = { type: "header" as const, title, source: "من سجل DINAR", icon: insight.topic === "INVENTORY" ? ("TAG" as const) : ("CHART" as const) };
  const base = { version: 1 as const, label: title, testId: "business-summary" };
  if (insight.topic === "ORDERS")
    return {
      ...base,
      size: "MEDIUM",
      sections: [
        header,
        {
          type: "metrics",
          label: "طلباتك",
          items: insight.metrics.map((metric) => ({ key: metric.key, label: metric.label, value: number(metric.value), testId: `business-metric-${metric.key}` })),
        },
        { type: "actions", items: [{ kind: "SEND", label: "إحصائيات المبيعات", message: "إحصائيات مبيعاتي", emphasis: "SECONDARY" }] },
      ],
    };
  if (insight.topic === "INVENTORY")
    return {
      ...base,
      size: "MEDIUM",
      state: insight.metrics.length ? "READY" : "EMPTY",
      sections: [
        header,
        ...(insight.metrics.length
          ? [{
              type: "facts" as const,
              rows: insight.metrics.map((row) => ({
                label: row.label || "إعلان بلا عنوان",
                value: `${row.value} · ${INVENTORY_STATUS[row.status] ?? row.status}`,
                testId: "business-row",
              })),
            }]
          : []),
      ],
    };
  return {
    ...base,
    size: "MEDIUM",
    sections: [
      header,
      {
        type: "facts",
        rows: insight.metrics.map((row) => ({
          label: row.label || "إعلان بلا عنوان",
          value: [
            `${number(row.orders)} طلب`,
            `${number(row.priceOffers)} عرض سعر`,
            ...(row.campaignImpressions !== undefined ? [`${number(row.campaignImpressions)} ظهور ممول مؤهل`] : []),
          ].join(" · "),
          testId: "business-row",
        })),
      },
    ],
  };
}

// ─── AI usage and plans ───────────────────────────────────────────────────────

type Usage = NonNullable<CommercialPayload["usage"]>;
type Plans = NonNullable<CommercialPayload["aiPlans"]>;

export function usageSurface(usage: Usage): ComposedSurfaceInput {
  const notices = [
    ...(usage.exhaustedLabels.length ? [{ tone: "WARNING" as const, text: `نفدت حصة: ${usage.exhaustedLabels.join("، ")}.` }] : []),
    ...(usage.platformPaused ? [{ tone: "INFO" as const, text: "المساعد الذكي متوقف مؤقتًا على مستوى المنصة؛ لم يُخصم ذلك من حصتك." }] : []),
    ...(usage.providerStatus === "NOT_CONFIGURED" ? [{ tone: "INFO" as const, text: "مزود الذكاء الاصطناعي غير مهيأ في هذه البيئة الآن." }] : []),
    ...(usage.provisional ? [{ tone: "NEUTRAL" as const, text: "الحدود الحالية مؤقتة وغير معتمدة نهائيًا." }] : []),
  ];
  return {
    version: 1,
    label: "استهلاكك للذكاء الاصطناعي",
    size: "COMPACT",
    testId: "ai-usage",
    sections: [
      { type: "header", title: "استهلاكك للذكاء الاصطناعي", badge: { label: usage.tierLabel, tone: "GOLD" }, icon: "GAUGE" },
      { type: "facts", rows: [{ label: "باقتك", value: usage.tierLabel }, { label: "تتجدد في", value: usage.renewsAtLabel }] },
      ...(usage.premiumTrial?.eligible
        ? [{
            type: "facts" as const,
            rows: [{
              label: "التجربة المميزة",
              value: `${usage.premiumTrial.remaining} من ${usage.premiumTrial.limit} رسالة متبقية${usage.premiumTrial.status === "DISABLED" ? " · غير مفعّلة" : ""}`,
            }],
          }]
        : []),
      ...usage.resources
        .filter((item) => item.included)
        .map((item) => ({ type: "meter" as const, label: item.label, used: item.used, limit: item.limit, testId: "usage-meter" })),
      { type: "meter", label: "معالجة الذكاء (الرموز)", used: usage.tokens.used, limit: usage.tokens.limit, testId: "usage-meter" },
      ...notices.map((notice) => ({ type: "notice" as const, ...notice })),
      { type: "text", muted: true, text: usage.costNote },
      { type: "text", muted: true, text: usage.essentials },
      { type: "actions", items: [{ kind: "SEND", label: "اعرض الباقات", message: "اعرض الباقات", emphasis: "SECONDARY", testId: "usage-show-plans" }] },
    ],
  };
}

/**
 * Plan cards from the configured policy only: an unpriced tier says so, no tier is called
 * "most popular", and subscribing is offered only where a price is approved — the review
 * that follows is the server's, and billing that is not connected is stated as such.
 */
export function plansSurface(plans: Plans): ComposedSurfaceInput {
  return {
    version: 1,
    label: "باقات DINAR",
    size: "WIDE",
    testId: "ai-plans",
    sections: [
      { type: "header", title: "باقات DINAR", subtitle: "القدرات نفسها في كل الباقات؛ الفرق في سعة الاستخدام.", icon: "SPARKLE" },
      // D1: the three public plans as one facts list (the tier grid above stays the only options grid).
      ...(plans.publicPlans?.length
        ? [
            { type: "text" as const, text: "خطط دينار: جو وبرو لحساب دينار، وبزنس لنشاط تجاري موثّق." },
            {
              type: "facts" as const,
              rows: plans.publicPlans.map((plan) => ({
                label: `${plan.name}${plan.current ? " (خطتك)" : ""} — ${plan.statusLabel}`,
                value: (plan.marketPriceLabel ?? plan.referencePriceLabel).slice(0, 120),
                testId: "dinar-plan",
              })),
            },
            ...plans.publicPlans.filter((plan) => plan.requiresVerifiedBusiness).map((plan) => ({ type: "text" as const, muted: true, text: plan.eligibilityNote })),
            ...(plans.publicPlansNote ? [{ type: "text" as const, muted: true, text: plans.publicPlansNote }] : []),
            {
              type: "actions" as const,
              items: plans.publicPlans
                .filter((plan) => !plan.current)
                .map((plan) => ({ kind: "SEND" as const, label: `مراجعة ${plan.name}`, message: plan.planCode === "DINAR_BUSINESS" ? "أبي أشترك في بزنس" : `اشترك في ${plan.planCode === "DINAR_PRO" ? "Pro" : "Go"}`, emphasis: "SECONDARY" as const })),
            },
          ]
        : []),
      {
        type: "options",
        label: "الباقات",
        layout: "GRID",
        items: plans.tiers.map((tier) => ({
          key: tier.tier.toLowerCase().replace(/_/g, "-"),
          title: tier.label,
          subtitle: tier.priceConfigured && tier.priceLabel ? tier.priceLabel : "السعر غير معتمد بعد",
          subtitleMuted: !(tier.priceConfigured && tier.priceLabel),
          badge: tier.current ? { label: "باقتك", tone: "GOLD" as const } : undefined,
          highlighted: tier.current,
          facts: [
            ...tier.allowances.filter((item) => item.value > 0).map((item) => ({ label: item.label, value: number(item.value), ltr: true })),
            { label: "الرموز", value: number(tier.tokens), ltr: true },
          ].slice(0, 8),
          actions:
            !tier.current && tier.tier !== "FREE" && tier.priceConfigured
              ? [{ kind: "SEND" as const, label: `مراجعة ${tier.label}`, message: `اشترك في ${tier.tier === "BUSINESS_PRO" ? "Pro" : "Go"}`, emphasis: "SECONDARY" as const }]
              : undefined,
          testId: "ai-plan",
        })),
      },
      { type: "text", muted: true, text: plans.sameCapabilities },
      { type: "notice", tone: plans.billing.status === "NOT_CONNECTED" ? "INFO" : "NEUTRAL", text: plans.billing.note, testId: "ai-plans-billing" },
      { type: "text", muted: true, text: plans.renewalNote },
      ...(plans.provisional ? [{ type: "text" as const, muted: true, text: "الحدود المعروضة مؤقتة وغير معتمدة نهائيًا." }] : []),
      { type: "actions", items: [{ kind: "SEND", label: "كم بقي من حصتي؟", message: "كم بقي من حصتي؟", emphasis: "SECONDARY", testId: "plans-show-usage" }] },
    ],
  };
}
