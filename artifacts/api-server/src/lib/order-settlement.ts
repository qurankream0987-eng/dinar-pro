/**
 * Until DINAR offers in-app card payment for orders, buyer and seller settle directly. Two
 * things make that safe and simple:
 *
 * 1. Contact after acceptance: once the SELLER has accepted the order, the buyer and the seller
 *    each see the other's name and phone (the delivery location is already shared by Block D).
 *    Nothing is revealed before acceptance, to anyone else, or after cancellation.
 * 2. Settlement preference: the buyer can state how they prefer to pay outside DINAR (cash,
 *    bank transfer, or the country's local instant method). It is information for the seller
 *    only: it never marks an order paid, never moves money and never changes order status,
 *    commission or the price snapshot.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, offers, orders, users } from "@workspace/db";

export const SETTLEMENT_METHODS = ["CASH", "BANK_TRANSFER", "CLIQ", "KNET", "MADA", "STC_PAY", "BENEFIT_PAY"] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export const SETTLEMENT_LABELS: Record<SettlementMethod, string> = {
  CASH: "نقدًا عند الاستلام",
  BANK_TRANSFER: "تحويل بنكي",
  CLIQ: "كليك (CliQ)",
  KNET: "كي نت (KNET)",
  MADA: "مدى (mada)",
  STC_PAY: "STC Pay",
  BENEFIT_PAY: "بنفت باي (BenefitPay)",
};

/** Local instant methods by market country; every market also offers cash and bank transfer. */
const LOCAL_METHODS: Record<string, SettlementMethod[]> = {
  JO: ["CLIQ"],
  KW: ["KNET"],
  SA: ["MADA", "STC_PAY"],
  BH: ["BENEFIT_PAY"],
};

export function settlementMethodsFor(countryCode: string): SettlementMethod[] {
  return ["CASH", "BANK_TRANSFER", ...(LOCAL_METHODS[countryCode] ?? [])];
}

/** The seller accepted and the order is still live or finished normally. */
const CONTACT_STATUSES = new Set(["ACCEPTED", "IN_PROGRESS", "SELLER_MARKED_DELIVERED", "BUYER_CONFIRMED", "COMPLETED"]);
const PREFERENCE_STATUSES = new Set(["CREATED", "ACCEPTED", "IN_PROGRESS"]);

const notFound = () => Object.assign(new Error("الطلب غير موجود"), { status: 404, code: "ORDER_NOT_FOUND", expose: true });
const fail = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

type Preference = { method: SettlementMethod; label: string; setAt: string } | null;

function preferenceOf(data: any): Preference {
  const value = data?.settlementPreference;
  return value && (SETTLEMENT_METHODS as readonly string[]).includes(value.method)
    ? { method: value.method, label: SETTLEMENT_LABELS[value.method as SettlementMethod], setAt: String(value.setAt) }
    : null;
}

export type CounterpartContact = {
  orderId: string;
  available: boolean;
  /** Why contact is not shown yet: the seller has not accepted, or the order ended. */
  reason: "AVAILABLE" | "AWAITING_SELLER_ACCEPTANCE" | "ORDER_CLOSED";
  counterpart: null | { role: "BUYER" | "SELLER"; name: string; phone: string };
  settlementPreference: Preference;
  settlementMethods: { method: SettlementMethod; label: string }[];
  notice: string;
};

const NOTICE = "الدفع يتم مباشرة بينكما خارج دينار. لا يحتفظ دينار بالمال ولا يؤكد الدفع؛ لا تدفع قبل التأكد من المنتج والبائع.";

export async function counterpartContact(input: { actorId: string; orderId: string; marketId: string; countryCode: string }): Promise<CounterpartContact> {
  const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order || order.marketId !== input.marketId || (order.buyerId !== input.actorId && order.sellerId !== input.actorId)) throw notFound();
  const role = order.buyerId === input.actorId ? "BUYER" : "SELLER";
  const base = {
    orderId: order.id,
    settlementPreference: preferenceOf(order.data),
    settlementMethods: settlementMethodsFor(input.countryCode).map((method) => ({ method, label: SETTLEMENT_LABELS[method] })),
    notice: NOTICE,
  };
  if (!CONTACT_STATUSES.has(order.status))
    return { ...base, available: false, reason: order.status === "CREATED" ? "AWAITING_SELLER_ACCEPTANCE" : "ORDER_CLOSED", counterpart: null };
  const counterpartId = role === "BUYER" ? order.sellerId : order.buyerId;
  const [person] = await db
    .select({ name: users.displayName, phone: users.normalizedPhone, status: users.status })
    .from(users)
    .where(eq(users.id, counterpartId))
    .limit(1);
  if (!person || person.status !== "ACTIVE")
    return { ...base, available: false, reason: "ORDER_CLOSED", counterpart: null };
  // A listing-specific contact number (Block B contactPhone) takes precedence for the seller.
  let listingPhone: string | undefined;
  if (role === "BUYER") {
    const items = Array.isArray(order.data?.items) ? order.data.items : [];
    const listingIds = [...new Set(items.map((item: any) => item?.listingId).filter((id: unknown): id is string => typeof id === "string"))];
    if (listingIds.length) {
      const rows = await db
        .select({ data: offers.data })
        .from(offers)
        .where(and(inArray(offers.id, listingIds), eq(offers.sellerId, order.sellerId), eq(offers.marketId, order.marketId)));
      listingPhone = rows.map((row) => (row.data as any)?.contactPhone).find((value: unknown): value is string => typeof value === "string" && value.trim().length > 0);
    }
  }
  return {
    ...base,
    available: true,
    reason: "AVAILABLE",
    counterpart: { role: role === "BUYER" ? "SELLER" : "BUYER", name: person.name, phone: listingPhone?.trim() || person.phone },
  };
}

export async function setSettlementPreference(input: { actorId: string; orderId: string; marketId: string; countryCode: string; method: string }) {
  if (!(settlementMethodsFor(input.countryCode) as string[]).includes(input.method))
    throw fail(400, "طريقة الدفع هذه غير متاحة في سوقك.", "SETTLEMENT_METHOD_UNAVAILABLE");
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update").limit(1);
    if (!order || order.marketId !== input.marketId || order.buyerId !== input.actorId) throw notFound();
    if (!PREFERENCE_STATUSES.has(order.status)) throw fail(409, "لا يمكن تغيير طريقة الدفع المفضلة بعد انتهاء الطلب.", "ORDER_CLOSED");
    const now = new Date();
    const data = { ...(order.data as object), settlementPreference: { method: input.method, setAt: now.toISOString() } };
    await tx.update(orders).set({ data, updatedAt: now }).where(and(eq(orders.id, order.id), eq(orders.buyerId, input.actorId)));
    return { orderId: order.id, settlementPreference: preferenceOf(data) };
  });
}
