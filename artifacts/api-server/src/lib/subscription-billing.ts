/**
 * DINAR NEXT pre-integration: the subscription billing contract for Free / Go / Pro.
 *
 * Plans, prices and allowances stay where they are: DINAR_BUSINESS products (admin-configured,
 * snapshotted at purchase) and the AI usage policy (`approved: false` until the owner approves).
 * Nothing here invents a price or charges anyone. What this module adds:
 *   - one lifecycle state machine for every subscription event (simulation today, provider later);
 *   - plan-change and renewal previews that never compute an unapproved proration;
 *   - a provider-neutral billing adapter interface and a signed, idempotent webhook intake that
 *     answers "not connected" until an adapter is registered. No live provider exists.
 * Marketplace rights (selling, buying, commission) never depend on a subscription; only AI
 * usage allowances and business tools do.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { billingWebhookEvents, businessSubscriptions, db } from "@workspace/db";
import { AI_TIER_ENTITLEMENTS, type AiPlanTier } from "./ai-usage-policy";
import { logger } from "./logger";

export const SUBSCRIPTION_STATUSES = ["PENDING", "ACTIVE", "PAST_DUE", "CANCEL_AT_PERIOD_END", "CANCELLED", "EXPIRED", "PAYMENT_FAILED"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const id = z.string().min(1).max(180);
const at = z.string().datetime();
export const BillingWebhookEventSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("SUBSCRIPTION_ACTIVATED"), subscriptionId: id, providerSubscriptionId: id, periodStart: at, periodEnd: at, amountMinor: z.number().int().positive(), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  z.object({ id, type: z.literal("SUBSCRIPTION_RENEWED"), subscriptionId: id, providerSubscriptionId: id, periodStart: at, periodEnd: at, amountMinor: z.number().int().positive(), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  z.object({ id, type: z.literal("PAYMENT_FAILED"), subscriptionId: id, providerSubscriptionId: id }).strict(),
  z.object({ id, type: z.literal("CANCELLATION_SCHEDULED"), subscriptionId: id, providerSubscriptionId: id }).strict(),
  z.object({ id, type: z.literal("SUBSCRIPTION_ENDED"), subscriptionId: id, providerSubscriptionId: id }).strict(),
  z.object({ id, type: z.literal("REFUNDED"), subscriptionId: id, providerSubscriptionId: id, amountMinor: z.number().int().positive(), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).strict(),
]);
export type BillingWebhookEvent = z.infer<typeof BillingWebhookEventSchema>;

const TERMINAL: readonly SubscriptionStatus[] = ["PAYMENT_FAILED", "CANCELLED", "EXPIRED"];
type Transition = { to: SubscriptionStatus; setPeriod?: boolean; cancelled?: boolean } | { ignored: string };

/**
 * The only place a subscription status moves on a billing event. A refund ends entitlements at
 * once (conservative until the owner approves a refund policy); a failed renewal is PAST_DUE
 * (entitlements stop because only ACTIVE / CANCEL_AT_PERIOD_END grant anything).
 */
export function subscriptionTransition(from: SubscriptionStatus, event: BillingWebhookEvent["type"]): Transition {
  switch (event) {
    case "SUBSCRIPTION_ACTIVATED":
      // PAYMENT_FAILED, CANCELLED and EXPIRED are final in the database (integrity trigger): a
      // retry after a failed first payment is a new checkout, never a revived row.
      return from === "PENDING" ? { to: "ACTIVE", setPeriod: true } : { ignored: TERMINAL.includes(from) ? "TERMINAL_STATUS" : "NOT_PENDING" };
    case "SUBSCRIPTION_RENEWED":
      return from === "ACTIVE" || from === "PAST_DUE" ? { to: "ACTIVE", setPeriod: true } : { ignored: from === "CANCEL_AT_PERIOD_END" ? "RENEWAL_AFTER_CANCELLATION" : "NOT_RENEWABLE" };
    case "PAYMENT_FAILED":
      return from === "PENDING" ? { to: "PAYMENT_FAILED" } : from === "ACTIVE" ? { to: "PAST_DUE" } : { ignored: "NOT_BILLABLE" };
    case "CANCELLATION_SCHEDULED":
      return from === "ACTIVE" ? { to: "CANCEL_AT_PERIOD_END", cancelled: true } : { ignored: "NOT_ACTIVE" };
    case "SUBSCRIPTION_ENDED":
      return ["ACTIVE", "PAST_DUE", "CANCEL_AT_PERIOD_END"].includes(from) ? { to: "EXPIRED" } : { ignored: "NOT_LIVE" };
    case "REFUNDED":
      // An EXPIRED subscription grants nothing already and its status is final: the refund is recorded only.
      return ["ACTIVE", "PAST_DUE", "CANCEL_AT_PERIOD_END"].includes(from) ? { to: "CANCELLED", cancelled: true } : { ignored: from === "EXPIRED" ? "TERMINAL_STATUS" : "NOTHING_TO_REFUND" };
  }
}

const TIER_RANK: Record<AiPlanTier, number> = { GUEST: 0, FREE: 1, BUSINESS_GO: 2, BUSINESS_PRO: 3 };
export function tierOfEntitlements(entitlements: readonly string[]): AiPlanTier {
  const tiers = entitlements.map((key) => AI_TIER_ENTITLEMENTS[key as keyof typeof AI_TIER_ENTITLEMENTS]).filter(Boolean) as AiPlanTier[];
  return tiers.sort((a, b) => TIER_RANK[b] - TIER_RANK[a])[0] ?? "FREE";
}

/**
 * What a plan change would do, without amounts DINAR has not approved: an upgrade starts after
 * its payment is confirmed; a downgrade or cancellation takes effect at the end of the paid period.
 */
export function planChangePreview(current: { tier: AiPlanTier; periodEnd: Date | null }, target: AiPlanTier) {
  if (target === current.tier) return { kind: "NO_CHANGE" as const };
  const upgrade = TIER_RANK[target] > TIER_RANK[current.tier];
  return {
    kind: upgrade ? ("UPGRADE" as const) : ("DOWNGRADE" as const),
    effective: upgrade ? ("AFTER_PAYMENT_CONFIRMATION" as const) : ("AT_PERIOD_END" as const),
    effectiveAt: upgrade ? null : current.periodEnd?.toISOString() ?? null,
    proration: "NOT_APPROVED" as const,
    autoRenew: false as const,
    marketplaceRightsUnchanged: true as const,
  };
}

/** A billing provider adapter. None is registered: every caller gets a truthful "not connected". */
export interface SubscriptionBillingProvider {
  readonly providerKey: string;
  createCheckout(input: { subscriptionId: string; planId: string; amountMinor: number; currencyCode: string; periodDays: number; idempotencyKey: string }): Promise<{ checkoutUrl: string; providerCheckoutId: string; expiresAt: string }>;
  scheduleCancellation(input: { providerSubscriptionId: string; idempotencyKey: string }): Promise<{ effectiveAt: string }>;
  /** Verifies the provider's signature over the canonical event; never trusts an unsigned body. */
  verifyWebhook(event: BillingWebhookEvent, signature: string): boolean;
}

const registered = new Map<string, SubscriptionBillingProvider>();
/** Registration is server code, never configuration from a request; production has none yet. */
export function registerSubscriptionBillingProvider(provider: SubscriptionBillingProvider) {
  if (process.env.NODE_ENV === "production" && process.env.DINAR_LIVE_PROVIDERS_ENABLED !== "true")
    throw new Error("Live billing providers are disabled");
  registered.set(provider.providerKey, provider);
}
export function unregisterSubscriptionBillingProvider(providerKey: string) {
  registered.delete(providerKey);
}
/** The one registered adapter (ambiguous registrations select none). */
export function getSubscriptionBillingProvider(): SubscriptionBillingProvider | undefined {
  return registered.size === 1 ? [...registered.values()][0] : undefined;
}
export function subscriptionBillingStatus() {
  return {
    connected: registered.size === 1,
    providers: [...registered.keys()],
    mode: registered.size === 1 ? ("REGISTERED_ADAPTER" as const) : ("NOT_CONNECTED" as const),
    note: "لا يوجد مزود فوترة حيّ؛ الاشتراك الحالي محاكاة بلا تحويل أموال (TEST_NO_TRANSFER) ولا يتجدد تلقائيًا.",
  };
}

/** Digest of the event with keys sorted, so a replay with the same content is recognised. */
export function eventDigest(event: BillingWebhookEvent): string {
  const sorted = Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

const fail = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

/**
 * Signed webhook intake. Unknown provider → 503 not connected (nothing stored). Bad signature →
 * recorded as REJECTED and 401. A repeated event id is answered from the record, never re-applied.
 */
export async function receiveBillingWebhook(providerKey: string, raw: unknown) {
  const provider = registered.get(providerKey);
  if (!provider) throw fail(503, "مزود الفوترة غير موصول", "BILLING_PROVIDER_NOT_CONNECTED");
  const body = z.object({ event: BillingWebhookEventSchema, signature: z.string().min(16).max(512) }).strict().parse(raw);
  const digest = eventDigest(body.event);
  const [seen] = await db.select().from(billingWebhookEvents).where(and(eq(billingWebhookEvents.providerKey, providerKey), eq(billingWebhookEvents.providerEventId, body.event.id)));
  if (seen) {
    if (seen.payloadDigest !== digest) throw fail(409, "حدث مكرر بمحتوى مختلف", "EVENT_CONFLICT");
    return { duplicate: true, status: seen.status, failureCode: seen.failureCode };
  }
  if (!provider.verifyWebhook(body.event, body.signature)) {
    await db.insert(billingWebhookEvents).values({ id: randomUUID(), providerKey, providerEventId: body.event.id, eventType: body.event.type, payloadDigest: digest, status: "REJECTED", failureCode: "INVALID_SIGNATURE", processedAt: new Date() }).onConflictDoNothing();
    throw fail(401, "توقيع غير صالح", "INVALID_SIGNATURE");
  }
  return applyBillingEvent(providerKey, body.event, digest);
}

/**
 * Applies one verified canonical event inside a transaction: unknown subscription, amount or
 * currency mismatch and impossible periods are recorded as REJECTED; transitions the lifecycle
 * does not allow are IGNORED. Shared by the canonical intake and provider adapters (Whop) that
 * verify their own signed transport first. The (provider, event id) record makes it idempotent.
 */
export async function applyBillingEvent(providerKey: string, event: BillingWebhookEvent, digest = eventDigest(event), expectedUserId?: string) {
  return db.transaction(async (tx) => {
    const record = async (status: "APPLIED" | "IGNORED" | "REJECTED", failureCode: string | null, subscriptionId: string | null) => {
      const [row] = await tx
        .insert(billingWebhookEvents)
        .values({ id: randomUUID(), providerKey, providerEventId: event.id, eventType: event.type, payloadDigest: digest, status, failureCode, subscriptionId, processedAt: new Date() })
        .onConflictDoNothing()
        .returning();
      return { duplicate: !row, status, failureCode };
    };
    const [subscription] = await tx.select().from(businessSubscriptions).where(eq(businessSubscriptions.id, event.subscriptionId)).for("update");
    if (!subscription) return record("REJECTED", "UNKNOWN_SUBSCRIPTION", null);
    // A concurrent delivery of the same event waited on the row lock: answer it from the record.
    const [already] = await tx.select().from(billingWebhookEvents).where(and(eq(billingWebhookEvents.providerKey, providerKey), eq(billingWebhookEvents.providerEventId, event.id)));
    if (already) return { duplicate: true, status: already.status as "APPLIED" | "IGNORED" | "REJECTED", failureCode: already.failureCode };
    // The provider names the account the payment was made for; it must be the subscription's owner.
    if (expectedUserId !== undefined && expectedUserId !== subscription.userId) return record("REJECTED", "ACCOUNT_MISMATCH", subscription.id);
    if ("amountMinor" in event && (event.amountMinor !== subscription.priceMinorSnapshot || event.currencyCode !== subscription.currencyCodeSnapshot))
      return record("REJECTED", "AMOUNT_MISMATCH", subscription.id);
    const transition = subscriptionTransition(subscription.status as SubscriptionStatus, event.type);
    if ("ignored" in transition) return record("IGNORED", transition.ignored, subscription.id);
    if (transition.setPeriod && "periodStart" in event) {
      const start = new Date(event.periodStart);
      const end = new Date(event.periodEnd);
      if (!(end > start) || (subscription.currentPeriodEnd && end <= subscription.currentPeriodEnd)) return record("REJECTED", "INVALID_PERIOD", subscription.id);
    }
    const now = new Date();
    await tx
      .update(businessSubscriptions)
      .set({
        status: transition.to,
        ...(transition.setPeriod && "periodStart" in event ? { currentPeriodStart: new Date(event.periodStart), currentPeriodEnd: new Date(event.periodEnd) } : {}),
        ...(transition.cancelled ? { cancelledAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(businessSubscriptions.id, subscription.id));
    logger.info({ event: "subscription_changed", status: transition.to, source: "billing_webhook" }, "subscription changed");
    return record("APPLIED", null, subscription.id);
  });
}
