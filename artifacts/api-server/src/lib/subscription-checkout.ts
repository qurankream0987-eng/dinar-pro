/**
 * Whop phase 2: one checkout path shared by the HTTP route and the conversation card.
 *
 * A checkout creates (or resumes) one PENDING subscription and asks the registered billing
 * provider for a hosted payment page. PENDING grants nothing; entitlements start only from a
 * verified provider webhook. Without a registered provider nothing is created.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { businessSubscriptions, conversations, db, promotionProducts, users } from "@workspace/db";
import { isCountryBlocked } from "./whop/countries";
import { whopConfig } from "./whop/config";
import { assertPlanEligibility, businessPlans, cancelBusinessSubscription } from "./business";
import { planCodeOfProduct } from "./subscription-plans";
import { getSubscriptionBillingProvider, subscriptionBillingStatus } from "./subscription-billing";

type Market = Parameters<typeof businessPlans>[0];

const fail = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

/** Shown on every paid checkout card and review: the provider is the merchant of record. */
export const SUBSCRIPTION_TAX_NOTE =
  "السعر المعروض قبل الضريبة. Whop هو البائع المسجّل وقد يضيف ضريبة المبيعات أو القيمة المضافة حسب بلدك، وتظهر قيمتها في صفحة الدفع قبل التأكيد.";

/**
 * The redirect origin comes only from the deployment's APP_ORIGIN (never the Host header), so a
 * forged Host cannot send a buyer's return trip elsewhere. Without it Whop's configured redirect applies.
 */
export function configuredAppOrigin(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  return configured && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(configured) ? configured : undefined;
}

/** The path the buyer returns to after paying: the same conversation, with the checkout to check. */
export function checkoutReturnPath(subscriptionId: string, conversationId?: string | null) {
  const params = new URLSearchParams({ checkout: subscriptionId });
  if (conversationId) params.set("conversation", conversationId);
  return `/?${params.toString()}`;
}

export async function startSubscriptionCheckout(input: {
  actorId: string;
  market: Market;
  planId: string;
  idempotencyKey: string;
  businessId?: string;
  conversationId?: string;
  /** Absolute origin of this deployment (server-derived, never from the request body). */
  origin?: string;
}) {
  if (!subscriptionBillingStatus().connected) throw fail(503, "الدفع الحقيقي للاشتراكات غير موصول بعد؛ لم يُنشأ اشتراك ولم يُخصم شيء.", "BILLING_PROVIDER_NOT_CONNECTED");
  const provider = getSubscriptionBillingProvider()!;
  // Whop payments only, per the provider's support and legal requirements; Jassim itself stays open.
  const [buyer] = await db.select({ country: users.accountCountry }).from(users).where(eq(users.id, input.actorId));
  if (provider.providerKey === "whop" && buyer?.country && isCountryBlocked(buyer.country, whopConfig().blockedCountries))
    throw fail(403, "الدفع عبر Whop غير متاح في بلدك حاليًا؛ يبقى استخدام جاسم والسوق والبيع النقدي متاحًا.", "PAYMENT_PROVIDER_COUNTRY_UNSUPPORTED");
  const [plan] = await db.select().from(promotionProducts).where(and(eq(promotionProducts.id, input.planId), eq(promotionProducts.marketId, input.market.id)));
  if (!plan || plan.productType !== "DINAR_BUSINESS" || !(await businessPlans(input.market)).some((item) => item.id === plan.id))
    throw fail(404, "خطة جاسم بزنس غير متاحة في سوقك", "PRODUCT_DISABLED");
  // The conversation must be the actor's own AI conversation in this market; a stranger's id is 404.
  if (input.conversationId) {
    const [owned] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerUserId, input.actorId), eq(conversations.marketId, input.market.id), eq(conversations.kind, "AI")));
    if (!owned) throw fail(404, "المحادثة غير موجودة", "CONVERSATION_NOT_FOUND");
  }
  // Eligibility is the server's: Business needs the actor's own VERIFIED business; payment never verifies.
  const planCode = planCodeOfProduct(plan);
  const businessProfileId = await assertPlanEligibility({ actorId: input.actorId, market: input.market, planCode, businessId: input.businessId });
  const [prior] = await db.select().from(businessSubscriptions).where(and(eq(businessSubscriptions.userId, input.actorId), eq(businessSubscriptions.idempotencyKey, input.idempotencyKey)));
  if (prior && prior.planId !== plan.id) throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
  const [live] = prior
    ? []
    : await db
        .select({ id: businessSubscriptions.id, status: businessSubscriptions.status, planId: businessSubscriptions.planId, conversationId: businessSubscriptions.conversationId })
        .from(businessSubscriptions)
        .where(and(eq(businessSubscriptions.userId, input.actorId), eq(businessSubscriptions.marketId, input.market.id), inArray(businessSubscriptions.status, ["PENDING", "ACTIVE", "PAST_DUE", "CANCEL_AT_PERIOD_END"])));
  // An unpaid checkout for the same plan is resumed (its provider checkout is reissued idempotently), so an
  // abandoned payment page never locks the buyer out and never creates a second subscription.
  const resumed = live?.status === "PENDING" && live.planId === plan.id ? live : undefined;
  if (live && !resumed) throw fail(409, "لديك اشتراك جاسم بزنس قائم أو قيد الدفع", "ALREADY_SUBSCRIBED");
  const subscriptionId = prior?.id ?? resumed?.id ?? randomUUID();
  const conversationId = input.conversationId ?? prior?.conversationId ?? resumed?.conversationId ?? null;
  if (!prior && !resumed)
    await db.insert(businessSubscriptions).values({
      id: subscriptionId,
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
      providerKey: provider.providerKey,
      conversationId,
    });
  const returnPath = checkoutReturnPath(subscriptionId, conversationId);
  const checkout = await provider.createCheckout({
    subscriptionId,
    planId: plan.id,
    amountMinor: plan.priceMinor,
    currencyCode: plan.currencyCode,
    periodDays: plan.durationDays,
    idempotencyKey: resumed ? `resume-${resumed.id}` : input.idempotencyKey,
    ...(input.origin ? { returnUrl: `${input.origin}${returnPath}` } : {}),
  });
  await db
    .update(businessSubscriptions)
    .set({ providerKey: provider.providerKey, providerCheckoutId: checkout.providerCheckoutId, ...(conversationId ? { conversationId } : {}), updatedAt: new Date() })
    .where(and(eq(businessSubscriptions.id, subscriptionId), eq(businessSubscriptions.status, "PENDING")));
  return {
    subscriptionId,
    status: "PENDING" as const,
    checkout,
    plan: { id: plan.id, name: plan.name, priceMinor: plan.priceMinor, currencyCode: plan.currencyCode, durationDays: plan.durationDays },
    conversationId,
    returnPath,
    taxNote: SUBSCRIPTION_TAX_NOTE,
    autoRenew: false as const,
  };
}

/** What the buyer sees on return: the server's record only, never the query string's claim. */
export async function subscriptionCheckoutStatus(input: { actorId: string; subscriptionId: string }) {
  const [row] = await db
    .select({ id: businessSubscriptions.id, status: businessSubscriptions.status, planName: businessSubscriptions.planNameSnapshot, currentPeriodEnd: businessSubscriptions.currentPeriodEnd, conversationId: businessSubscriptions.conversationId })
    .from(businessSubscriptions)
    .where(and(eq(businessSubscriptions.id, input.subscriptionId), eq(businessSubscriptions.userId, input.actorId)));
  if (!row) throw fail(404, "الاشتراك غير موجود", "SUBSCRIPTION_NOT_FOUND");
  return { ...row, currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null, paid: row.status === "ACTIVE" || row.status === "CANCEL_AT_PERIOD_END" };
}

/**
 * Cancellation of a provider-billed subscription is requested at the provider; our record changes
 * only when the provider's signed webhook confirms it (no success text without a receipt).
 */
export async function requestProviderCancellation(input: { actorId: string; market: Market }) {
  const [row] = await db
    .select()
    .from(businessSubscriptions)
    .where(and(eq(businessSubscriptions.userId, input.actorId), eq(businessSubscriptions.marketId, input.market.id), inArray(businessSubscriptions.status, ["ACTIVE", "PAST_DUE"])));
  if (!row) throw fail(404, "لا يوجد اشتراك نشط لإلغائه", "SUBSCRIPTION_REQUIRED");
  if (!row.providerKey || !row.providerSubscriptionId) return { provider: false as const, subscription: row };
  const provider = getSubscriptionBillingProvider();
  if (!provider || provider.providerKey !== row.providerKey) throw fail(503, "مزود الفوترة غير موصول الآن؛ لم يتغير شيء.", "BILLING_PROVIDER_NOT_CONNECTED");
  const result = await provider.scheduleCancellation({ providerSubscriptionId: row.providerSubscriptionId, idempotencyKey: `cancel-${row.id}-${row.currentPeriodEnd?.getTime() ?? 0}` });
  return { provider: true as const, subscription: row, effectiveAt: result.effectiveAt };
}

/**
 * One cancel for chat and HTTP: a provider-billed subscription is cancelled at the provider (our
 * record follows its signed webhook); a wallet-paid test subscription is cancelled here directly.
 */
export async function cancelSubscriptionEverywhere(input: { actorId: string; market: Market }) {
  const requested = await requestProviderCancellation(input).catch((error: { code?: string }) => {
    if (error?.code === "SUBSCRIPTION_REQUIRED") return undefined;
    throw error;
  });
  if (requested?.provider)
    return {
      status: "CANCELLATION_REQUESTED" as const,
      subscriptionId: requested.subscription.id,
      effectiveAt: requested.effectiveAt || requested.subscription.currentPeriodEnd?.toISOString() || null,
      message: "طُلب إيقاف التجديد من Whop. تبقى مزايا اشتراكك حتى نهاية الفترة المدفوعة، ويتحدّث حسابك فور وصول تأكيد Whop الموقّع.",
    };
  const view = await cancelBusinessSubscription(input);
  return { status: "CANCEL_AT_PERIOD_END" as const, subscription: view, message: "لن يتجدد اشتراكك؛ تبقى مزاياه حتى نهاية الفترة المدفوعة." };
}
