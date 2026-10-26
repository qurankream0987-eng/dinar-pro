/**
 * DINAR NEXT (conversation-first C): «أعطني إحصائيات مبيعاتي», «كم بعت هذا الشهر؟»,
 * «كم طلب مكتمل عندي؟», «ما أكثر منتجاتي طلبًا؟», «قارن مبيعات الشهر الحالي بالسابق».
 * Deterministic aggregates of the seller's own orders and payment records in the active market,
 * for an explicit period. No model, no estimate: an empty period is reported as empty.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, offers, orderItems, orders, paymentIntents } from "@workspace/db";
import { SellerSalesInsight } from "@workspace/api-zod/conversation-runtime";
import { formatMinorAmount } from "../lib/commercial-policy";
import { usagePeriod } from "../lib/ai-usage-policy";

type Market = { id: string; currencyCode: string; minorUnitScale: number };
type PeriodKey = SellerSalesInsight["period"]["key"];

export const SALES_QUESTION =
  /(?:^|\s)(?:احصائيات|احصاءات|احصائياتي|تقرير|ملخص)\s+(?:ال)?(?:مبيعات|مبيعاتي|بيعي|متجري|محلي|بيع)(?:\s|$)|(?:^|\s)(?:مبيعاتي|ارباحي|ايراداتي|ايرادي)(?:\s|$)|(?:^|\s)كم\s+(?:بعت|ربحت|دخلي)(?:\s|$)|(?:^|\s)كم\s+(?:طلب|طلبا|طلبات)\s+(?:مكتمل|مكتمله|منجز|منجزه|اكتمل)(?:\s|$)|(?:^|\s)قارن\s+(?:ال)?(?:مبيعات|مبيعاتي|بيعي)(?:\s|$)|(?:^|\s)(?:اكثر|افضل)\s+(?:منتجاتي|اعلاناتي|عروضي|منتج)\s+(?:طلبا|طلب|مبيعا|بيعا)(?:\s|$)/u;

const COMPLETED = ["BUYER_CONFIRMED", "COMPLETED"];
const CLOSED = ["CANCELLED", "EXPIRED"];
const TIME_ZONE = "UTC";

function period(text: string, now = new Date()): { key: PeriodKey; start: Date | null; end: Date } {
  const day = 24 * 60 * 60 * 1000;
  const month = usagePeriod({ kind: "CALENDAR_MONTH", timeZone: TIME_ZONE }, now);
  if (/(?:الشهر\s+(?:الماضي|السابق|اللي\s+فات|الفائت))/u.test(text)) {
    const previous = usagePeriod({ kind: "CALENDAR_MONTH", timeZone: TIME_ZONE }, new Date(month.start.getTime() - 1));
    return { key: "LAST_MONTH", start: previous.start, end: previous.end };
  }
  if (/(?:^|\s)اليوم(?:\s|$)/u.test(text)) {
    const today = usagePeriod({ kind: "CALENDAR_DAY", timeZone: TIME_ZONE }, now);
    return { key: "TODAY", start: today.start, end: today.end };
  }
  if (/(?:الاسبوع|اخر\s+(?:7|سبع(?:ه)?)\s+ايام)/u.test(text)) return { key: "LAST_7_DAYS", start: new Date(now.getTime() - 7 * day), end: now };
  if (/اخر\s+(?:30|ثلاثين)\s+(?:يوم|يوما)/u.test(text)) return { key: "LAST_30_DAYS", start: new Date(now.getTime() - 30 * day), end: now };
  if (/(?:كل\s+(?:ال)?وقت|منذ\s+البدايه|الاجمالي|من\s+البدايه|كل\s+الفترات)/u.test(text)) return { key: "ALL_TIME", start: null, end: now };
  return { key: "THIS_MONTH", start: month.start, end: month.end };
}

function previousOf(current: { key: PeriodKey; start: Date | null; end: Date }) {
  if (current.key === "THIS_MONTH" || current.key === "LAST_MONTH") {
    const previous = usagePeriod({ kind: "CALENDAR_MONTH", timeZone: TIME_ZONE }, new Date(current.start!.getTime() - 1));
    return { key: "LAST_MONTH" as const, start: previous.start, end: previous.end };
  }
  if (!current.start) return undefined;
  const length = current.end.getTime() - current.start.getTime();
  return { key: current.key, start: new Date(current.start.getTime() - length), end: current.start };
}

const date = (value: Date) => value.toISOString().slice(0, 10);
function periodLabel(range: { key: PeriodKey; start: Date | null; end: Date }, previous = false): string {
  const names: Record<PeriodKey, string> = { TODAY: "اليوم", LAST_7_DAYS: "آخر 7 أيام", THIS_MONTH: "هذا الشهر", LAST_MONTH: "الشهر الماضي", LAST_30_DAYS: "آخر 30 يومًا", ALL_TIME: "كل الفترات" };
  const span = range.start ? ` (${date(range.start)} – ${date(new Date(range.end.getTime() - 1))}، ${TIME_ZONE})` : "";
  return `${previous && range.key !== "LAST_MONTH" ? "الفترة السابقة" : names[range.key]}${span}`;
}

async function metrics(sellerId: string, market: Market, range: { start: Date | null; end: Date }) {
  const scope = and(eq(orders.sellerId, sellerId), eq(orders.marketId, market.id), ...(range.start ? [gte(orders.createdAt, range.start)] : []), lt(orders.createdAt, range.end));
  const [totals] = await db
    .select({
      orders: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${inArray(orders.status, COMPLETED)})::int`,
      cancelled: sql<number>`count(*) filter (where ${inArray(orders.status, CLOSED)})::int`,
      gross: sql<number>`coalesce(sum(${orders.subtotalMinor}) filter (where not ${inArray(orders.status, CLOSED)}), 0)::bigint`,
      recognized: sql<number>`coalesce(sum(${orders.sellerAmountMinor}) filter (where ${inArray(orders.status, COMPLETED)}), 0)::bigint`,
    })
    .from(orders)
    .where(scope);
  const [payments] = await db
    .select({
      paid: sql<number>`coalesce(sum(${paymentIntents.capturedAmountMinor}), 0)::bigint`,
      refunded: sql<number>`coalesce(sum(${paymentIntents.refundedAmountMinor}), 0)::bigint`,
    })
    .from(paymentIntents)
    .innerJoin(orders, eq(orders.id, paymentIntents.orderId))
    .where(scope);
  const money = (minor: number) => formatMinorAmount(Number(minor), market.minorUnitScale, market.currencyCode);
  const row = { orders: Number(totals?.orders ?? 0), completed: Number(totals?.completed ?? 0), cancelled: Number(totals?.cancelled ?? 0), gross: Number(totals?.gross ?? 0), paid: Number(payments?.paid ?? 0), refunded: Number(payments?.refunded ?? 0), recognized: Number(totals?.recognized ?? 0) };
  return [
    { key: "orders" as const, label: "كل الطلبات", value: String(row.orders), raw: row.orders },
    { key: "completed" as const, label: "طلبات مكتملة", value: String(row.completed), raw: row.completed },
    { key: "cancelled" as const, label: "ملغاة أو منتهية", value: String(row.cancelled), raw: row.cancelled },
    { key: "gross" as const, label: "قيمة الطلبات (غير الملغاة)", value: money(row.gross), raw: row.gross },
    { key: "paid" as const, label: "مدفوع إلكترونيًا (محاكاة)", value: money(row.paid), raw: row.paid },
    { key: "refunded" as const, label: "مسترد", value: money(row.refunded), raw: row.refunded },
    { key: "recognized" as const, label: "صافي المكتمل بعد عمولة DINAR", value: money(row.recognized), raw: row.recognized },
  ];
}

async function topProducts(sellerId: string, market: Market, range: { start: Date | null; end: Date }) {
  const rows = await db
    .select({ listingId: orderItems.offerId, units: sql<number>`sum(${orderItems.quantity})::int`, orders: sql<number>`count(distinct ${orders.id})::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.sellerId, sellerId), eq(orders.marketId, market.id), sql`not ${inArray(orders.status, CLOSED)}`, ...(range.start ? [gte(orders.createdAt, range.start)] : []), lt(orders.createdAt, range.end)))
    .groupBy(orderItems.offerId)
    .orderBy(sql`sum(${orderItems.quantity}) desc`)
    .limit(5);
  if (!rows.length) return [];
  const titles = new Map((await db.select({ id: offers.id, data: offers.data }).from(offers).where(inArray(offers.id, rows.map((row) => row.listingId)))).map((row) => [row.id, String(row.data.title ?? "")]));
  return rows.map((row) => ({ listingId: row.listingId, label: (titles.get(row.listingId) ?? "").slice(0, 250), units: Number(row.units), orders: Number(row.orders) }));
}

export async function sellerSalesInsight(sellerId: string, market: Market, text: string, now = new Date()) {
  const range = period(text, now);
  const compare = /(?:^|\s)(?:قارن|مقارنه|مقارنة|مقابل)(?:\s|$)/u.test(text);
  const previous = compare ? previousOf(range) : undefined;
  const current = await metrics(sellerId, market, range);
  const insight = SellerSalesInsight.parse({
    kind: "BUSINESS_SUMMARY",
    source: "DINAR_ONLY",
    topic: "SALES",
    currencyCode: market.currencyCode,
    period: { key: range.key, label: periodLabel(range), start: range.start?.toISOString() ?? null, end: range.end.toISOString(), timeZone: TIME_ZONE },
    metrics: current,
    ...(previous ? { previous: { period: { key: previous.key, label: periodLabel(previous, true), start: previous.start.toISOString(), end: previous.end.toISOString(), timeZone: TIME_ZONE }, metrics: await metrics(sellerId, market, previous) } } : {}),
    topProducts: await topProducts(sellerId, market, range),
    notes: [
      "الأرقام من سجل طلبات DINAR لإعلاناتك في هذا السوق فقط.",
      "الطلبات النقدية لا يسجّل DINAR استلام مالها، فلا تُحتسب «مدفوعة»؛ والدفع الإلكتروني في هذه البيئة محاكاة دون أموال حقيقية.",
      "«صافي المكتمل» هو حصتك من الطلبات المكتملة بعد العمولة كما سُجّلت، وليس مبلغًا مستلمًا بالضرورة.",
    ],
  });
  return insight;
}

export function salesPrompt(insight: SellerSalesInsight, asksTop: boolean): string {
  const value = (key: string, metrics = insight.metrics) => metrics.find((metric) => metric.key === key)!;
  if (!value("orders").raw && !insight.previous?.metrics.some((metric) => metric.raw))
    return `لا توجد طلبات على إعلاناتك في ${insight.period.label}. لا أستطيع إعطاء أرقام لفترة بلا سجلات.`;
  if (asksTop)
    return insight.topProducts.length
      ? [`أكثر منتجاتك طلبًا في ${insight.period.label}:`, ...insight.topProducts.map((item, index) => `${index + 1}. «${item.label}» — ${item.units} قطعة في ${item.orders} طلب`)].join("\n")
      : `لا توجد منتجات مطلوبة في ${insight.period.label}.`;
  const line = (metrics: SellerSalesInsight["metrics"], label: string) =>
    `${label}: ${value("orders", metrics).value} طلب، المكتمل ${value("completed", metrics).value}، قيمة الطلبات ${value("gross", metrics).value}، صافي المكتمل ${value("recognized", metrics).value}، مسترد ${value("refunded", metrics).value}.`;
  return [line(insight.metrics, insight.period.label), ...(insight.previous ? [line(insight.previous.metrics, insight.previous.period.label)] : []), insight.notes[1]!].join("\n");
}
