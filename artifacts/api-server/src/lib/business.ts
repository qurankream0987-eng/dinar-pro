/**
 * DINAR Business (Monetization V3): an optional subscription that unlocks deeper tools —
 * never organic rank, eligibility or truth. Plans are DINAR_BUSINESS products of the same
 * commercial catalog; a subscription is paid from the commercial balance through the
 * commercial ledger (SIMULATION_ONLY funding), snapshotted at purchase, and never renews
 * by itself. Entitlements are checked on the server for every request.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { businessSubscriptions, db, promotionProducts, users } from "@workspace/db";
import {
  chargeAvailable,
  fail,
  getCommercialBalance,
  lockedAccount,
} from "./commercial-ledger";
import { formatMinorAmount } from "./commercial-policy";
import { assertPromotionsAvailable, commercialProductView, commercialProducts } from "./promotions";
import { isPromotionSimulationEnabled } from "./promotion-policy";
import { logger } from "./logger";
import { AI_TIER_ENTITLEMENTS, type AiPlanTier } from "./ai-usage-policy";
import { getCommercialPolicy } from "./commercial-policy";
import { BUSINESS_ONLY_ENTITLEMENTS, formatReferencePrice, planCodeOfProduct, planCodeOfSubscription, type PlanCode } from "./subscription-plans";
import { isVerifiedBusinessOf, verifiedBusinessForSubscription } from "./business-profiles";

type Market = Parameters<typeof commercialProducts>[0];
type SubscriptionRow = typeof businessSubscriptions.$inferSelect;

export const BUSINESS_ENTITLEMENT_LABELS: Record<string, string> = {
  MARKET_PULSE_ADVANCED: "نبض السوق المتقدم (24 ساعة و7 و30 يومًا، مقارنة الفترات، فرص أكثر)",
  CAMPAIGN_ANALYTICS_ADVANCED: "تحليلات الحملات المفصلة",
  BUSINESS_REPORTING: "تقارير تجارية مجمعة",
  INVENTORY_INSIGHTS: "رؤى المخزون",
  AI_USAGE_BUSINESS_GO: "سعة استخدام أكبر للذكاء الاصطناعي (Business Go)",
  AI_USAGE_BUSINESS_PRO: "أعلى سعة استخدام للذكاء الاصطناعي (Business Pro)",
  BUSINESS_PROFILE_TOOLS: "أدوات النشاط التجاري الموثّق",
};
export const BUSINESS_RANK_NOTE = "الاشتراك يضيف أدوات فقط؛ لا يغيّر ترتيب نتائج البحث العادية ولا شروط الظهور.";
const LIVE = ["PENDING", "ACTIVE", "PAST_DUE", "CANCEL_AT_PERIOD_END"];

/**
 * The market's purchasable plans: enabled DINAR_BUSINESS catalog products whose public plan is
 * available and not retired in the market's plan policy (legacy products without a plan code keep
 * appearing as they did). Prices are the market product's own, in the market currency.
 */
export async function businessPlans(market: Market) {
  const policy = (await getCommercialPolicy(market.id)).subscriptionPlans;
  return (await commercialProducts(market, { productTypes: ["DINAR_BUSINESS"] }))
    .map((plan) => ({ plan, planCode: planCodeOfProduct(plan) }))
    .filter(({ planCode }) => !planCode || (policy.plans[planCode].availableInMarket && policy.plans[planCode].status !== "RETIRED"))
    .map(({ plan, planCode }) => ({
      ...commercialProductView(plan, market),
      planCode,
      ...(planCode ? { planName: policy.plans[planCode].nameAr, eligibility: policy.plans[planCode].eligibility, referencePriceLabel: formatReferencePrice(policy.plans[planCode].referencePrice), planStatus: policy.plans[planCode].status } : {}),
      entitlementLabels: (plan.businessEntitlements ?? []).map((key) => BUSINESS_ENTITLEMENT_LABELS[key] ?? key),
    }));
}

/**
 * The live subscription row that grants something now. A DINAR Business subscription grants
 * nothing unless its business is VERIFIED (not suspended) and still the subscriber's in this market:
 * payment never stands in for verification. Business-only keys never count on any other plan.
 */
async function grantingSubscription(userId: string, marketId: string) {
  const [row] = await db
    .select()
    .from(businessSubscriptions)
    .where(and(eq(businessSubscriptions.userId, userId), eq(businessSubscriptions.marketId, marketId), inArray(businessSubscriptions.status, ["ACTIVE", "CANCEL_AT_PERIOD_END"])))
    .limit(1);
  if (!row?.currentPeriodEnd || row.currentPeriodEnd.getTime() <= Date.now()) return undefined;
  const planCode = planCodeOfSubscription(row);
  if (row.planCodeSnapshot === "DINAR_BUSINESS" && !(await isVerifiedBusinessOf(userId, marketId, row.businessProfileId))) return undefined;
  const entitlements = row.planCodeSnapshot === "DINAR_BUSINESS" ? row.entitlementsSnapshot : row.entitlementsSnapshot.filter((key) => !BUSINESS_ONLY_ENTITLEMENTS.has(key));
  return { row, planCode, entitlements };
}

/** Period ends are settled on read, so an ended subscription never grants anything. */
async function settle(userId: string, marketId: string) {
  await db
    .update(businessSubscriptions)
    .set({ status: "EXPIRED", updatedAt: new Date() })
    .where(and(eq(businessSubscriptions.userId, userId), eq(businessSubscriptions.marketId, marketId), inArray(businessSubscriptions.status, ["ACTIVE", "CANCEL_AT_PERIOD_END", "PAST_DUE"]), lte(businessSubscriptions.currentPeriodEnd, new Date())));
}

export async function businessEntitlements(userId: string | undefined, market: { id: string }): Promise<Set<string>> {
  if (!userId) return new Set();
  await settle(userId, market.id);
  return new Set((await grantingSubscription(userId, market.id))?.entitlements ?? []);
}

/** The public plan this account holds now in this market (FREE when nothing grants). */
export async function accessPlanFor(userId: string, market: { id: string }): Promise<{ plan: "FREE" | PlanCode; legacy: boolean; subscriptionId?: string; periodEnd: Date | null }> {
  await settle(userId, market.id);
  const granting = await grantingSubscription(userId, market.id);
  if (!granting) return { plan: "FREE", legacy: false, periodEnd: null };
  return { plan: granting.planCode ?? "FREE", legacy: !granting.row.planCodeSnapshot, subscriptionId: granting.row.id, periodEnd: granting.row.currentPeriodEnd };
}

/**
 * The AI usage tier for this account in this market, resolved only from the server's live
 * subscription snapshot (period-settled). Nothing the client sends can change it. A plan
 * without an AI tier key, or no live subscription, is FREE; PRO wins if both keys exist.
 */
export async function aiPlanFor(userId: string, market: { id: string }): Promise<{ tier: AiPlanTier; source: string; periodEnd: Date | null }> {
  await settle(userId, market.id);
  const granting = await grantingSubscription(userId, market.id);
  if (!granting) return { tier: "FREE", source: "DEFAULT_FREE", periodEnd: null };
  const row = granting.row;
  const tiers = granting.entitlements.flatMap((key) => (key in AI_TIER_ENTITLEMENTS ? [AI_TIER_ENTITLEMENTS[key as keyof typeof AI_TIER_ENTITLEMENTS]] : []));
  const tier: AiPlanTier = tiers.includes("BUSINESS_PRO") ? "BUSINESS_PRO" : tiers.includes("BUSINESS_GO") ? "BUSINESS_GO" : "FREE";
  return tier === "FREE" ? { tier, source: "DEFAULT_FREE", periodEnd: null } : { tier, source: `subscription:${row.id}`, periodEnd: row.currentPeriodEnd };
}

/** The AI tier a catalog plan grants (null: the plan adds tools only, no AI capacity). */
export function planAiTier(entitlements: readonly string[] | null | undefined): AiPlanTier | null {
  const keys = entitlements ?? [];
  return keys.includes("AI_USAGE_BUSINESS_PRO") ? "BUSINESS_PRO" : keys.includes("AI_USAGE_BUSINESS_GO") ? "BUSINESS_GO" : null;
}

export function subscriptionView(row: SubscriptionRow | undefined, market: Market) {
  if (!row) return { status: "FREE" as const, statusLabel: "الحساب المجاني", note: BUSINESS_RANK_NOTE };
  const labels: Record<string, string> = {
    PENDING: "بانتظار الدفع",
    ACTIVE: "نشط",
    PAST_DUE: "متأخر الدفع",
    CANCEL_AT_PERIOD_END: "نشط حتى نهاية الفترة ثم يتوقف",
    CANCELLED: "ملغى",
    EXPIRED: "منتهٍ",
    PAYMENT_FAILED: "فشل الدفع",
  };
  return {
    id: row.id,
    status: row.status,
    statusLabel: labels[row.status] ?? row.status,
    planCode: planCodeOfSubscription(row),
    businessProfileId: row.businessProfileId ?? null,
    planName: row.planNameSnapshot,
    priceLabel: formatMinorAmount(row.priceMinorSnapshot, market.minorUnitScale, row.currencyCodeSnapshot),
    periodDays: row.periodDaysSnapshot,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    entitlements: row.entitlementsSnapshot,
    entitlementLabels: row.entitlementsSnapshot.map((key) => BUSINESS_ENTITLEMENT_LABELS[key] ?? key),
    autoRenew: false as const,
    renewalNote: "لا تجديد تلقائي؛ ينتهي الاشتراك بنهاية الفترة ما لم تجدده بنفسك.",
    paymentMode: "TEST_NO_TRANSFER" as const,
    note: BUSINESS_RANK_NOTE,
  };
}

export async function getBusinessStatus(userId: string, market: Market) {
  await settle(userId, market.id);
  const [row] = await db
    .select()
    .from(businessSubscriptions)
    .where(and(eq(businessSubscriptions.userId, userId), eq(businessSubscriptions.marketId, market.id)))
    .orderBy(desc(businessSubscriptions.createdAt))
    .limit(1);
  return subscriptionView(row && !["CANCELLED", "EXPIRED", "PAYMENT_FAILED"].includes(row.status) ? row : row?.status === "EXPIRED" ? row : undefined, market);
}

/**
 * Server-side eligibility for a plan purchase. Go and Pro need an active account only; DINAR
 * Business needs the actor's own VERIFIED business in this market (never a document, never a
 * payment). Returns the business id to snapshot, if any.
 */
const refuse = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

export async function assertPlanEligibility(input: { actorId: string; market: Market; planCode: PlanCode | null; businessId?: string }) {
  if (input.planCode !== "DINAR_BUSINESS") {
    if (input.businessId) throw refuse(400, "هذه الخطة لا ترتبط بنشاط تجاري", "BUSINESS_NOT_APPLICABLE");
    return null;
  }
  if (!input.businessId) throw refuse(409, "جاسم بزنس يتطلب نشاطًا تجاريًا موثّقًا؛ أضف نشاطك أولًا وانتظر توثيقه", "BUSINESS_REQUIRED");
  return (await verifiedBusinessForSubscription(input.actorId, input.market, input.businessId)).id;
}

export async function reviewBusinessSubscription(input: { actorId: string; market: Market; planId: string; businessId?: string }) {
  assertPromotionsAvailable();
  const plan = (await businessPlans(input.market)).find((item) => item.id === input.planId);
  if (!plan) throw fail(404, "خطة جاسم بزنس غير متاحة في سوقك", "PRODUCT_DISABLED");
  await assertPlanEligibility({ actorId: input.actorId, market: input.market, planCode: plan.planCode, businessId: input.businessId });
  const balance = await getCommercialBalance(input.actorId, input.market);
  const sufficient = balance.availableMinor >= plan.priceMinor;
  return {
    plan,
    balance,
    sufficient,
    balanceAfterLabel: formatMinorAmount(Math.max(0, balance.availableMinor - plan.priceMinor), input.market.minorUnitScale, input.market.currencyCode),
    ...(sufficient ? {} : { missingLabel: formatMinorAmount(plan.priceMinor - balance.availableMinor, input.market.minorUnitScale, input.market.currencyCode), failureCode: "INSUFFICIENT_BALANCE" }),
    renewalNote: "لا تجديد تلقائي؛ يمكنك إلغاء التجديد أو التجديد يدويًا.",
    rankNote: BUSINESS_RANK_NOTE,
    paymentMode: "TEST_NO_TRANSFER" as const,
    autoRenew: false as const,
  };
}

/** One live subscription per seller and market; idempotent per key. */
export async function subscribeBusiness(input: { actorId: string; market: Market; planId: string; idempotencyKey: string; businessId?: string }) {
  assertPromotionsAvailable();
  if (!isPromotionSimulationEnabled()) throw fail(403, "الاشتراك التجريبي متاح في بيئة التطوير والاختبار فقط");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw fail(400, "مفتاح عدم التكرار غير صالح");
  const [plan] = await db.select().from(promotionProducts).where(and(eq(promotionProducts.id, input.planId), eq(promotionProducts.marketId, input.market.id)));
  if (!plan || plan.productType !== "DINAR_BUSINESS" || !(await businessPlans(input.market)).some((item) => item.id === plan.id))
    throw fail(404, "خطة جاسم بزنس غير متاحة في سوقك", "PRODUCT_DISABLED");
  const planCode = planCodeOfProduct(plan);
  const businessProfileId = await assertPlanEligibility({ actorId: input.actorId, market: input.market, planCode, businessId: input.businessId });
  await settle(input.actorId, input.market.id);
  const row = await db.transaction(async (tx) => {
    const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId)).for("share");
    if (actor?.status !== "ACTIVE") throw fail(403, "حسابك مقيّد حاليًا.");
    const account = await lockedAccount(input.actorId, input.market, tx);
    const [prior] = await tx.select().from(businessSubscriptions).where(and(eq(businessSubscriptions.userId, input.actorId), eq(businessSubscriptions.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.planId !== plan.id) throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      return prior;
    }
    const [live] = await tx.select().from(businessSubscriptions).where(and(eq(businessSubscriptions.userId, input.actorId), eq(businessSubscriptions.marketId, input.market.id), inArray(businessSubscriptions.status, LIVE)));
    if (live) throw fail(409, "لديك اشتراك قائم بالفعل؛ تغيير الخطة يبدأ بعد انتهاء فترتك أو بعد تأكيد الدفع", "ALREADY_SUBSCRIBED");
    const id = randomUUID();
    await tx.insert(businessSubscriptions).values({
      id,
      userId: input.actorId,
      marketId: input.market.id,
      planId: plan.id,
      planNameSnapshot: plan.name,
      priceMinorSnapshot: plan.priceMinor,
      currencyCodeSnapshot: plan.currencyCode,
      periodDaysSnapshot: plan.durationDays,
      pricingVersionSnapshot: plan.pricingVersion,
      entitlementsSnapshot: plan.businessEntitlements ?? [],
      planCodeSnapshot: plan.planCode ?? null,
      businessProfileId,
      status: "PENDING",
      idempotencyKey: input.idempotencyKey,
    });
    await chargeAvailable(tx, account, {
      entryType: "SUBSCRIPTION_CHARGE",
      amountMinor: plan.priceMinor,
      subscriptionId: id,
      productId: plan.id,
      productType: plan.productType,
      pricingVersion: plan.pricingVersion,
      idempotencyKey: `subscription:${id}`,
      market: input.market,
    });
    const now = new Date();
    const [active] = await tx
      .update(businessSubscriptions)
      .set({ status: "ACTIVE", currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000), updatedAt: now })
      .where(eq(businessSubscriptions.id, id))
      .returning();
    logger.info({ event: "subscription_changed", status: "ACTIVE", marketId: input.market.id }, "subscription changed");
    return active!;
  });
  return subscriptionView(row, input.market);
}

/** Stops future renewal only; the paid period keeps its entitlements to its end. */
export async function cancelBusinessSubscription(input: { actorId: string; market: Market }) {
  await settle(input.actorId, input.market.id);
  const [row] = await db
    .update(businessSubscriptions)
    .set({ status: "CANCEL_AT_PERIOD_END", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(businessSubscriptions.userId, input.actorId), eq(businessSubscriptions.marketId, input.market.id), eq(businessSubscriptions.status, "ACTIVE")))
    .returning();
  if (!row) throw fail(404, "لا يوجد اشتراك نشط لإلغائه", "SUBSCRIPTION_REQUIRED");
  logger.info({ event: "subscription_changed", status: "CANCEL_AT_PERIOD_END", marketId: input.market.id }, "subscription changed");
  return subscriptionView(row, input.market);
}
