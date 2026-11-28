/**
 * Whop billing adapter for JassimAI subscriptions (Jassim Go / Pro / Business) — prepared, off by
 * default. Built against Whop's current docs (docs.whop.com, read 2026-11-13) and the official
 * `@whop/sdk` 2.8.0 verifier, without adding the SDK as a dependency:
 *   - webhooks follow Standard Webhooks: headers `webhook-id`, `webhook-timestamp`,
 *     `webhook-signature` (`v1,<base64>` entries, space separated); HMAC-SHA256 over
 *     `{id}.{timestamp}.{raw body}` keyed by the literal UTF-8 bytes of the whole `ws_…` secret;
 *     timestamps more than 5 minutes away are refused; deliveries are at-least-once with the same
 *     `webhook-id` on every retry, for about three days;
 *   - REST: `https://api.whop.com/api/v1` (sandbox `https://sandbox-api.whop.com/api/v1`), bearer
 *     key from the server only, a pinned `Api-Version-Date`; checkouts are
 *     `POST /checkout_configurations` with `variant_id` (a `plan_…` id) and `metadata` that Whop
 *     copies to payments and memberships; amounts are `Money { amount: "10.00", currency: "usd",
 *     decimals }` in major units.
 *
 * Authority: a webhook body is only a hint. Every decision is taken from the payment or membership
 * the server retrieves from Whop itself, then applied through the one lifecycle machine and ledger
 * in subscription-billing.ts (amount/currency snapshot match, owner match, idempotency by
 * `webhook-id`). A browser returning from checkout grants nothing. Marketplace order payments are a
 * separate domain (lib/payments) and never pass through here.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { billingWebhookEvents, businessSubscriptions, db, markets } from "@workspace/db";
import { applyBillingEvent, registerSubscriptionBillingProvider, unregisterSubscriptionBillingProvider, type BillingWebhookEvent, type SubscriptionBillingProvider } from "../subscription-billing";
import { applyPromotionBillingEvent, registerPromotionBillingProvider, unregisterPromotionBillingProvider, type PromotionBillingEvent, type PromotionBillingProvider } from "../promotion-billing";
import { parseBlockedCountries } from "../whop/config";
import { logger } from "../logger";
import { scaleOfCurrency } from "../commercial-policy";

export const WHOP_PROVIDER_KEY = "whop";
export const WHOP_PROMOTION_CURRENCIES = new Set(["AED", "BHD", "DZD", "EGP", "ILS", "JOD", "KWD", "MAD", "OMR", "QAR", "SAR", "TND"]);
// 2026-10-24: payments carry `Money` objects, `account_id` and `membership_id` (verified in the
// sandbox 2026-11-16; the 2026-08-14 pin returns plain numbers and nested objects instead).
export const WHOP_API_VERSION_DATE = "2026-10-24";
export const WHOP_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const BASE_URLS = { sandbox: "https://sandbox-api.whop.com/api/v1", production: "https://api.whop.com/api/v1" } as const;

export type WhopConfig = {
  environment: "sandbox" | "production";
  apiKey: string;
  webhookSecret: string;
  /** The JassimAI Whop account (`biz_…`); events for any other account are refused. */
  accountId: string;
  /**
   * Our plan → Whop plan (`plan_…`), keyed `PLAN_CODE:periodDays` (e.g. `DINAR_GO:30`,
   * `DINAR_GO:365`); a bare `PLAN_CODE` key is the 30-day plan. Prices live in Whop and must equal
   * our snapshot. Whop renewal plans must have `initial_price: 0`: an initial price on a renewal
   * plan is an extra one-time fee on top of the first period (seen in the sandbox checkout).
   */
  plans: Record<string, string>;
  redirectUrl?: string;
};

/** Reads the flag-gated configuration. Absent or partial configuration means "not connected". */
export function whopConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhopConfig | undefined {
  if (env.DINAR_WHOP_BILLING_ENABLED !== "true") return undefined;
  const environment = env.DINAR_WHOP_ENVIRONMENT === "production" ? "production" : "sandbox";
  if (environment === "production" && env.DINAR_LIVE_PROVIDERS_ENABLED !== "true") return undefined;
  // One Whop company, two signed webhooks: Whop for Platforms (orders, `/api/whop/webhooks`,
  // WHOP_WEBHOOK_SECRET) and subscriptions (`/api/billing/whop/webhook`, its own secret). Each Whop
  // webhook has its own signing secret, so the two are never read from one variable. The API key and
  // company id are shared (WHOP_COMPANY_ID, or the older WHOP_ACCOUNT_ID).
  const apiKey = env.WHOP_API_KEY;
  const webhookSecret = env.WHOP_BILLING_WEBHOOK_SECRET;
  const accountId = env.WHOP_COMPANY_ID ?? env.WHOP_ACCOUNT_ID;
  let plans: Record<string, string> = {};
  try {
    plans = JSON.parse(env.DINAR_WHOP_PLAN_MAP ?? "{}");
  } catch {
    return undefined;
  }
  if (!apiKey || !webhookSecret?.startsWith("ws_") || !/^biz_[A-Za-z0-9]+$/.test(accountId ?? "")) return undefined;
  if (!Object.entries(plans).every(([key, plan]) => /^DINAR_(GO|PRO|BUSINESS)(:\d{1,3})?$/.test(key) && typeof plan === "string" && /^plan_[A-Za-z0-9]+$/.test(plan))) return undefined;
  return { environment, apiKey, webhookSecret, accountId: accountId!, plans, redirectUrl: env.DINAR_WHOP_REDIRECT_URL };
}

// ─── Signature verification (Standard Webhooks, Whop key derivation) ────────────────────────────

export type WhopVerifyFailure = "MISSING_HEADERS" | "STALE_TIMESTAMP" | "INVALID_SIGNATURE";
export function signWhopPayload(secret: string, id: string, timestamp: string, raw: string | Buffer): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${timestamp}.`).update(raw).digest("base64");
}

export function verifyWhopSignature(
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true; id: string } | { ok: false; reason: WhopVerifyFailure; id?: string } {
  const header = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const id = header("webhook-id");
  const timestamp = header("webhook-timestamp");
  const signatures = header("webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp) || id.length > 200) return { ok: false, reason: "MISSING_HEADERS" };
  if (Math.abs(nowSeconds - Number(timestamp)) > WHOP_SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "STALE_TIMESTAMP", id };
  const expected = Buffer.from(signWhopPayload(secret, id, timestamp, raw), "base64");
  const match = signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { ok: true, id } : { ok: false, reason: "INVALID_SIGNATURE", id };
}

// ─── REST transport (injectable; no network in tests) ───────────────────────────────────────────

export type WhopTransport = (request: { method: "GET" | "POST"; path: string; body?: unknown; idempotencyKey?: string }) => Promise<{ status: number; json: unknown }>;

export function fetchWhopTransport(config: WhopConfig): WhopTransport {
  return async ({ method, path, body, idempotencyKey }) => {
    const response = await fetch(`${BASE_URLS[config.environment]}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Api-Version-Date": WHOP_API_VERSION_DATE,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}

type Money = { amount: string; currency: string; decimals?: number };
type WhopPayment = {
  id: string;
  status: string;
  billing_reason: string | null;
  membership_id: string | null;
  account_id?: string | null;
  /** The price before tax: what our snapshot is compared with (tax is Whop's as merchant of record). */
  subtotal: Money | null;
  total: Money | null;
  refunded_amount?: Money | null;
  metadata: Record<string, unknown> | null;
};
type WhopMembership = { id: string; status: string; cancel_at_period_end: boolean; current_period_start: string | null; current_period_end: string | null; metadata: Record<string, unknown> | null };
type WhopRefundEvent = { id: string; status: string; payment?: { id?: string } | null; payment_id?: string };

/** The Whop plan for a subscription snapshot: `CODE:days`, or the bare code for a 30-day plan. */
export function whopPlanFor(plans: Record<string, string>, planCode: string, periodDays: number): string | undefined {
  return plans[`${planCode}:${periodDays}`] ?? (periodDays === 30 ? plans[planCode] : undefined);
}

/** Exact major-unit decimal → integer minor units at `scale`; a fraction finer than the scale fails. */
export function moneyToMinor(money: Money, scale: number): number | undefined {
  const match = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(money.amount);
  if (!match) return undefined;
  const fraction = (match[2] ?? "").padEnd(scale, "0");
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return undefined;
  return Number(match[1]) * 10 ** scale + Number(fraction.slice(0, scale) || "0");
}

const metadataSubscription = (metadata: Record<string, unknown> | null | undefined) => {
  const value = metadata?.jassim_subscription_id;
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? value : undefined;
};
/** Jassim Ads (Phase 2): a one-time promotion payment names its campaign, never a subscription. */
export const metadataPromotion = (metadata: Record<string, unknown> | null | undefined) => {
  const value = metadata?.jassim_promotion_id;
  return metadata?.kind === "JASSIM_PROMOTION" && typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? value : undefined;
};
const metadataUser = (metadata: Record<string, unknown> | null | undefined) => (typeof metadata?.jassim_user_id === "string" ? metadata.jassim_user_id : undefined);

export class WhopUnavailableError extends Error {
  readonly status = 503;
  readonly code = "WHOP_UNAVAILABLE";
  readonly expose = true;
}

export type WhopWebhookResult = { status: number; outcome: string; failureCode?: string | null; duplicate?: boolean };
export type { Money as WhopMoney, WhopPayment };

/** What a promotion event handler receives: Whop's own payment, read by the server. */
export type WhopPromotionEvent = {
  eventId: string;
  type: "PAID" | "FAILED" | "REFUNDED" | "DISPUTED";
  eventType: string;
  digest: string;
  promotionId: string;
  payment: WhopPayment;
  accountId: string;
};

export function createWhopAdapter(config: WhopConfig, transport: WhopTransport = fetchWhopTransport(config)) {
  async function get<T>(path: string): Promise<T> {
    let response;
    try {
      response = await transport({ method: "GET", path });
    } catch {
      throw new WhopUnavailableError("تعذر التحقق من Whop الآن");
    }
    if (response.status !== 200 || !response.json) throw new WhopUnavailableError(`Whop ${response.status}`);
    return response.json as T;
  }

  async function cancelMembershipNow(membershipId: string) {
    let response;
    try {
      response = await transport({ method: "POST", path: `/memberships/${encodeURIComponent(membershipId)}/cancel`, body: { cancel_at_period_end: false }, idempotencyKey: `jassim-refund-cancel-${membershipId}` });
    } catch {
      throw new WhopUnavailableError("تعذر إنهاء العضوية في Whop الآن");
    }
    // Already canceled at Whop is fine; anything else is retried through Whop's redelivery.
    if (response.status !== 200 && response.status !== 201 && response.status !== 409 && response.status !== 422) throw new WhopUnavailableError(`Whop ${response.status}`);
  }

  /** One record for events that never reach a subscription (refused, unrelated, informational). */
  async function recordOnly(eventId: string, type: string, digest: string, status: "IGNORED" | "REJECTED", failureCode: string, subscriptionId: string | null = null) {
    const [row] = await db
      .insert(billingWebhookEvents)
      .values({ id: randomUUID(), providerKey: WHOP_PROVIDER_KEY, providerEventId: eventId, eventType: type.slice(0, 80), payloadDigest: digest, status, failureCode, subscriptionId, processedAt: new Date() })
      .onConflictDoNothing()
      .returning();
    // 200 either way: a refused event must not be retried by Whop for three days.
    return { status: 200, outcome: status, failureCode, duplicate: !row };
  }

  async function subscriptionScale(subscriptionId: string) {
    const [row] = await db
      .select({ marketScale: markets.minorUnitScale, marketCurrency: markets.currencyCode, currency: businessSubscriptions.currencyCodeSnapshot, userId: businessSubscriptions.userId })
      .from(businessSubscriptions)
      .innerJoin(markets, eq(markets.id, businessSubscriptions.marketId))
      .where(eq(businessSubscriptions.id, subscriptionId));
    if (!row) return undefined;
    // The subscription's own price currency decides the scale (USD plans in a KWD market are 2 decimals).
    const scale = scaleOfCurrency(row.currency, { currencyCode: row.marketCurrency, minorUnitScale: row.marketScale });
    return scale === undefined ? undefined : { scale, userId: row.userId };
  }

  const provider: SubscriptionBillingProvider = {
    providerKey: WHOP_PROVIDER_KEY,
    async createCheckout({ subscriptionId, planId, idempotencyKey, returnUrl }) {
      const [subscription] = await db
        .select({ userId: businessSubscriptions.userId, planCode: businessSubscriptions.planCodeSnapshot, periodDays: businessSubscriptions.periodDaysSnapshot })
        .from(businessSubscriptions)
        .where(eq(businessSubscriptions.id, subscriptionId));
      const whopPlan = subscription?.planCode ? whopPlanFor(config.plans, subscription.planCode, subscription.periodDays) : undefined;
      if (!subscription || !whopPlan) throw Object.assign(new Error("هذه الخطة غير مربوطة بخطة في Whop"), { status: 503, code: "WHOP_PLAN_NOT_MAPPED", expose: true });
      let response;
      try {
        response = await transport({
          method: "POST",
          path: "/checkout_configurations",
          idempotencyKey: `jassim-${idempotencyKey}`,
          body: { variant_id: whopPlan, metadata: { jassim_subscription_id: subscriptionId, jassim_user_id: subscription.userId, jassim_plan: planId }, ...(returnUrl ?? config.redirectUrl ? { redirect_url: returnUrl ?? config.redirectUrl } : {}) },
        });
      } catch {
        throw new WhopUnavailableError("تعذر الوصول إلى Whop");
      }
      const body = response.json as { id?: string; purchase_url?: string } | null;
      if (response.status !== 200 && response.status !== 201) throw new WhopUnavailableError(`Whop ${response.status}`);
      if (!body?.id || !body.purchase_url?.startsWith("https://")) throw new WhopUnavailableError("Whop checkout without a purchase URL");
      return { checkoutUrl: body.purchase_url, providerCheckoutId: body.id, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
    },
    async scheduleCancellation({ providerSubscriptionId, idempotencyKey }) {
      // Phase 2: the membership id is stored from the verified activation. Whop stops renewal at the
      // period end; our record changes only when Whop's signed `membership.updated` arrives.
      if (!/^mem_[A-Za-z0-9]+$/.test(providerSubscriptionId)) throw Object.assign(new Error("عضوية Whop غير معروفة"), { status: 409, code: "WHOP_MEMBERSHIP_UNKNOWN", expose: true });
      let response;
      try {
        response = await transport({ method: "POST", path: `/memberships/${encodeURIComponent(providerSubscriptionId)}/cancel`, body: { cancel_at_period_end: true }, idempotencyKey: `jassim-${idempotencyKey}` });
      } catch {
        throw new WhopUnavailableError("تعذر الوصول إلى Whop");
      }
      if (response.status !== 200 && response.status !== 201) throw new WhopUnavailableError(`Whop ${response.status}`);
      const body = response.json as { renewal_period_end?: string | null; current_period_end?: string | null } | null;
      const end = body?.renewal_period_end ?? body?.current_period_end;
      return { effectiveAt: end ? new Date(end).toISOString() : "" };
    },
    // The canonical JSON intake is never used for Whop: only the raw, signed transport below.
    verifyWebhook() {
      return false;
    },
  };

  /**
   * Jassim Ads: a one-time checkout for one promotion at the server's snapshot price. The plan is
   * created inline (no price lives in Whop beforehand); metadata ties the payment to the campaign.
   */
  async function createPromotionCheckout(input: { promotionId: string; userId: string; currencyCode: string; priceMinor: number; scale: number; productRef: string; title: string }) {
    const major = input.priceMinor / 10 ** input.scale;
    let response;
    try {
      response = await transport({
        method: "POST",
        path: "/checkout_configurations",
        idempotencyKey: `jassim-promotion-${input.promotionId}`,
        body: {
          plan: {
            company_id: config.accountId,
            currency: input.currencyCode.toLowerCase(),
            plan_type: "one_time",
            initial_price: Number(major.toFixed(input.scale)),
            product: { external_identifier: `jassim-promotion-${input.productRef}`.slice(0, 120), title: input.title.slice(0, 80) },
          },
          metadata: { kind: "JASSIM_PROMOTION", jassim_promotion_id: input.promotionId, jassim_user_id: input.userId },
          ...(config.redirectUrl ? { redirect_url: config.redirectUrl } : {}),
        },
      });
    } catch {
      throw new WhopUnavailableError("تعذر الوصول إلى Whop");
    }
    const body = response.json as { id?: string; purchase_url?: string } | null;
    if (response.status !== 200 && response.status !== 201) throw new WhopUnavailableError(`Whop ${response.status}`);
    if (!body?.id || !body.purchase_url?.startsWith("https://")) throw new WhopUnavailableError("Whop checkout without a purchase URL");
    return { checkoutId: body.id, checkoutUrl: body.purchase_url };
  }

  /** The purchase page of an existing checkout (a repeated request shows the same page again). */
  async function promotionCheckoutUrl(checkoutId: string) {
    const body = await get<{ id?: string; purchase_url?: string }>(`/checkout_configurations/${encodeURIComponent(checkoutId)}`);
    if (!body.purchase_url?.startsWith("https://")) throw new WhopUnavailableError("Whop checkout without a purchase URL");
    return body.purchase_url;
  }

  /** Maps a verified Whop payment event to the provider-neutral promotion billing domain. */
  async function promotion(event: Omit<WhopPromotionEvent, "accountId">): Promise<WhopWebhookResult> {
    const scale = event.payment.subtotal?.currency
      ? await db
          .select({ scale: markets.minorUnitScale })
          .from(markets)
          .where(eq(markets.currencyCode, event.payment.subtotal.currency.toUpperCase()))
          .limit(1)
          .then((r) => r[0]?.scale)
      : undefined;
    const effectiveScale = scale ?? scaleOfCurrency(event.payment.subtotal?.currency?.toUpperCase() ?? "");
    const sellerId = typeof event.payment.metadata?.jassim_user_id === "string" ? event.payment.metadata.jassim_user_id : "";
    const canonical: PromotionBillingEvent = {
      eventId: event.eventId,
      eventType: event.eventType,
      digest: event.digest,
      type: event.type,
      promotionId: event.promotionId,
      sellerId,
      providerPaymentStatus: event.payment.status ?? "",
      currencyCode: event.payment.subtotal?.currency?.toUpperCase(),
      amountMinor: event.payment.subtotal && effectiveScale !== undefined ? moneyToMinor(event.payment.subtotal, effectiveScale) : undefined,
      refundedMinor: event.payment.refunded_amount && effectiveScale !== undefined ? moneyToMinor(event.payment.refunded_amount, effectiveScale) : undefined,
      totalMinor: event.payment.total && effectiveScale !== undefined ? moneyToMinor(event.payment.total, effectiveScale) : undefined,
      accountMismatch: Boolean(event.payment.account_id && event.payment.account_id !== config.accountId),
    };
    return applyPromotionBillingEvent(WHOP_PROVIDER_KEY, canonical);
  }

  /** The signed Whop webhook: verify, read the provider's own state, apply through the one machine. */
  async function receive(raw: Buffer, headers: Record<string, string | string[] | undefined>, nowSeconds?: number): Promise<WhopWebhookResult> {
    const digest = createHash("sha256").update(raw).digest("hex");
    const verified = verifyWhopSignature(raw, headers, config.webhookSecret, nowSeconds);
    if (!verified.ok) {
      // A forged or replayed request is refused before anything is read; a well-formed id is logged once.
      if (verified.id) await recordOnly(verified.id, "unverified", digest, "REJECTED", verified.reason);
      return { status: 401, outcome: "REJECTED", failureCode: verified.reason };
    }
    const [seen] = await db.select().from(billingWebhookEvents).where(and(eq(billingWebhookEvents.providerKey, WHOP_PROVIDER_KEY), eq(billingWebhookEvents.providerEventId, verified.id)));
    if (seen) return { status: 200, outcome: seen.status, failureCode: seen.failureCode, duplicate: true };
    let envelope: { id?: string; type?: string; account_id?: string; company_id?: string; data?: Record<string, unknown> };
    try {
      envelope = JSON.parse(raw.toString("utf8"));
    } catch {
      return recordOnly(verified.id, "malformed", digest, "REJECTED", "MALFORMED_BODY");
    }
    const type = typeof envelope.type === "string" ? envelope.type : "unknown";
    const account = envelope.account_id ?? envelope.company_id;
    if (account !== config.accountId) return recordOnly(verified.id, type, digest, "REJECTED", "ACCOUNT_MISMATCH");
    const objectId = typeof envelope.data?.id === "string" ? envelope.data.id : undefined;

    const apply = async (event: BillingWebhookEvent, userId: string | undefined) => {
      const result = await applyBillingEvent(WHOP_PROVIDER_KEY, event, digest, userId);
      return { status: 200, outcome: result.status, failureCode: result.failureCode, duplicate: result.duplicate };
    };

    if (type === "payment.succeeded" || type === "payment.failed") {
      if (!objectId?.startsWith("pay_")) return recordOnly(verified.id, type, digest, "REJECTED", "MALFORMED_BODY");
      const payment = await get<WhopPayment>(`/payments/${encodeURIComponent(objectId)}`);
      const promotionId = metadataPromotion(payment.metadata);
      if (promotionId) return promotion({ eventId: verified.id, type: type === "payment.succeeded" ? "PAID" : "FAILED", eventType: type, digest, promotionId, payment });
      const subscriptionId = metadataSubscription(payment.metadata);
      if (!subscriptionId) return recordOnly(verified.id, type, digest, "IGNORED", "NOT_A_JASSIM_SUBSCRIPTION");
      const owner = await subscriptionScale(subscriptionId);
      if (!owner) return recordOnly(verified.id, type, digest, "REJECTED", "UNKNOWN_SUBSCRIPTION");
      const userId = metadataUser(payment.metadata) ?? "";
      const membershipId = payment.membership_id ?? "unknown";
      if (type === "payment.failed") {
        if (payment.status === "paid") return recordOnly(verified.id, type, digest, "IGNORED", "PROVIDER_STATE_PAID", subscriptionId);
        // A declined first payment leaves Whop's checkout open (seen in the sandbox: status "open"):
        // the buyer may retry with another card on the same page, so the subscription stays PENDING
        // and activates from that later success. Only a failed renewal moves a live plan to PAST_DUE.
        if (payment.billing_reason !== "subscription_cycle") return recordOnly(verified.id, type, digest, "IGNORED", "INITIAL_ATTEMPT_FAILED_RETRY_ALLOWED", subscriptionId);
        return apply({ id: verified.id, type: "PAYMENT_FAILED", subscriptionId, providerSubscriptionId: membershipId }, userId);
      }
      // `payment.succeeded` is believed only when Whop itself reports the payment as paid now.
      if (payment.status !== "paid") return recordOnly(verified.id, type, digest, "IGNORED", "PROVIDER_STATE_NOT_PAID", subscriptionId);
      if (!payment.membership_id) return recordOnly(verified.id, type, digest, "REJECTED", "NO_MEMBERSHIP", subscriptionId);
      const membership = await get<WhopMembership>(`/memberships/${encodeURIComponent(payment.membership_id)}`);
      if (payment.account_id && payment.account_id !== config.accountId) return recordOnly(verified.id, type, digest, "REJECTED", "ACCOUNT_MISMATCH", subscriptionId);
      // The plan price is compared before tax: Whop adds sales tax/VAT on top as merchant of record.
      const amountMinor = payment.subtotal ? moneyToMinor(payment.subtotal, owner.scale) : undefined;
      if (amountMinor === undefined || amountMinor <= 0 || !payment.subtotal) return recordOnly(verified.id, type, digest, "REJECTED", "AMOUNT_MISMATCH", subscriptionId);
      if (!["active", "trialing", "canceling", "completed"].includes(membership.status) || !membership.current_period_start || !membership.current_period_end)
        return recordOnly(verified.id, type, digest, "IGNORED", "MEMBERSHIP_NOT_ACTIVE", subscriptionId);
      const renewal = payment.billing_reason === "subscription_cycle";
      const event: BillingWebhookEvent = {
        id: verified.id,
        type: renewal ? "SUBSCRIPTION_RENEWED" : "SUBSCRIPTION_ACTIVATED",
        subscriptionId,
        providerSubscriptionId: membership.id,
        periodStart: new Date(membership.current_period_start).toISOString(),
        periodEnd: new Date(membership.current_period_end).toISOString(),
        amountMinor,
        currencyCode: payment.subtotal.currency.toUpperCase(),
      };
      const result = await apply(event, userId);
      // Out of order: a cancellation that reached us before the activation is reconciled from
      // Whop's current membership, under its own derived id (idempotent like any other event).
      if (result.outcome === "APPLIED" && (membership.cancel_at_period_end || membership.status === "canceling"))
        await applyBillingEvent(WHOP_PROVIDER_KEY, { id: `${verified.id}:cancel`, type: "CANCELLATION_SCHEDULED", subscriptionId, providerSubscriptionId: membership.id }, digest, userId);
      return result;
    }

    if (type === "membership.updated" || type === "membership.activated" || type === "membership.deactivated") {
      if (!objectId?.startsWith("mem_")) return recordOnly(verified.id, type, digest, "REJECTED", "MALFORMED_BODY");
      const membership = await get<WhopMembership>(`/memberships/${encodeURIComponent(objectId)}`);
      const subscriptionId = metadataSubscription(membership.metadata);
      if (!subscriptionId) return recordOnly(verified.id, type, digest, "IGNORED", "NOT_A_JASSIM_SUBSCRIPTION");
      const userId = metadataUser(membership.metadata) ?? "";
      if (["canceled", "expired", "completed"].includes(membership.status))
        return apply({ id: verified.id, type: "SUBSCRIPTION_ENDED", subscriptionId, providerSubscriptionId: membership.id }, userId);
      if (membership.cancel_at_period_end || membership.status === "canceling")
        return apply({ id: verified.id, type: "CANCELLATION_SCHEDULED", subscriptionId, providerSubscriptionId: membership.id }, userId);
      if (membership.status === "past_due")
        return apply({ id: verified.id, type: "PAYMENT_FAILED", subscriptionId, providerSubscriptionId: membership.id }, userId);
      // Activation is taken from the paid payment (amount and period), never from this event alone.
      return recordOnly(verified.id, type, digest, "IGNORED", "COVERED_BY_PAYMENT", subscriptionId);
    }

    if (type === "refund.updated" || type === "refund.created") {
      // The body only names the payment; the refunded amount is read from Whop's payment itself.
      const refund = envelope.data as unknown as WhopRefundEvent;
      const paymentId = refund.payment?.id ?? refund.payment_id;
      if (!objectId || !paymentId?.startsWith("pay_")) return recordOnly(verified.id, type, digest, "REJECTED", "MALFORMED_BODY");
      if (refund.status !== "succeeded") return recordOnly(verified.id, type, digest, "IGNORED", "REFUND_NOT_SUCCEEDED");
      const payment = await get<WhopPayment>(`/payments/${encodeURIComponent(paymentId)}`);
      const refundPromotion = metadataPromotion(payment.metadata);
      if (refundPromotion) return promotion({ eventId: verified.id, type: "REFUNDED", eventType: type, digest, promotionId: refundPromotion, payment });
      const subscriptionId = metadataSubscription(payment.metadata);
      if (!subscriptionId) return recordOnly(verified.id, type, digest, "IGNORED", "NOT_A_JASSIM_SUBSCRIPTION");
      const owner = await subscriptionScale(subscriptionId);
      const refunded = payment.refunded_amount && owner ? moneyToMinor(payment.refunded_amount, owner.scale) : undefined;
      const total = payment.total && owner ? moneyToMinor(payment.total, owner.scale) : undefined;
      const price = payment.subtotal && owner ? moneyToMinor(payment.subtotal, owner.scale) : undefined;
      if (!owner || !refunded || !total || !price || !payment.subtotal) return recordOnly(verified.id, type, digest, "REJECTED", "AMOUNT_MISMATCH", subscriptionId);
      // Only a full refund (Whop reports the whole charged total refunded) ends the entitlement; a
      // partial refund is recorded for the owner's review and changes nothing.
      if (refunded < total) return recordOnly(verified.id, type, digest, "IGNORED", "PARTIAL_REFUND_FOR_REVIEW", subscriptionId);
      // Sandbox-verified 2026-11-16: a full refund leaves the Whop membership active and renewing.
      // End it at Whop first (idempotent); if Whop cannot be reached nothing is recorded and Whop's
      // retry of this event cancels it later — a refunded buyer is never charged again.
      if (payment.membership_id) await cancelMembershipNow(payment.membership_id);
      return apply({ id: verified.id, type: "REFUNDED", subscriptionId, providerSubscriptionId: payment.membership_id ?? "unknown", amountMinor: price, currencyCode: payment.subtotal.currency.toUpperCase() }, metadataUser(payment.metadata) ?? "");
    }

    if (type === "dispute.created" || type === "dispute.updated" || type.startsWith("resolution_center_case.")) {
      // A dispute on a promotion payment pauses that campaign (it never serves on disputed money);
      // for subscriptions a dispute changes no entitlement by itself. Both are recorded for review.
      const data = envelope.data as { payment?: { id?: string } | null; payment_id?: string } | undefined;
      const disputedPayment = data?.payment?.id ?? data?.payment_id;
      if (type.startsWith("dispute.") && disputedPayment?.startsWith("pay_")) {
        // A payment Whop no longer finds is recorded for review (never retried for days); any other
        // failure to reach Whop is retried by Whop, so a disputed promotion is always paused.
        const payment = await get<WhopPayment>(`/payments/${encodeURIComponent(disputedPayment)}`).catch((error) => {
          if (error instanceof WhopUnavailableError && error.message === "Whop 404") return undefined;
          throw error;
        });
        const disputedPromotion = payment ? metadataPromotion(payment.metadata) : undefined;
        if (disputedPromotion && payment) return promotion({ eventId: verified.id, type: "DISPUTED", eventType: type, digest, promotionId: disputedPromotion, payment });
      }
      logger.warn({ event: "whop_dispute", type }, "Whop dispute received for review");
      return recordOnly(verified.id, type, digest, "IGNORED", "DISPUTE_RECORDED_FOR_REVIEW");
    }
    return recordOnly(verified.id, type, digest, "IGNORED", "UNHANDLED_EVENT_TYPE");
  }

  const promotionProvider: PromotionBillingProvider = {
    providerKey: WHOP_PROVIDER_KEY,
    displayName: "Whop",
    supportedCurrencies: WHOP_PROMOTION_CURRENCIES,
    blockedCountries: parseBlockedCountries(process.env.DINAR_WHOP_BLOCKED_COUNTRIES),
    createPromotionCheckout,
    promotionCheckoutUrl,
  };

  return { provider, promotionProvider, receive, createPromotionCheckout, promotionCheckoutUrl, config: { accountId: config.accountId, environment: config.environment } };
}

// ─── Installation (server code only; never from a request) ──────────────────────────────────────

let active: ReturnType<typeof createWhopAdapter> | undefined;
/** Registers the adapter for checkout and enables the signed webhook route. Returns an uninstaller. */
export function installWhopBilling(config: WhopConfig, transport?: WhopTransport) {
  const adapter = createWhopAdapter(config, transport);
  registerSubscriptionBillingProvider(adapter.provider);
  registerPromotionBillingProvider(adapter.promotionProvider);
  active = adapter;
  return () => {
    unregisterSubscriptionBillingProvider(WHOP_PROVIDER_KEY);
    unregisterPromotionBillingProvider(WHOP_PROVIDER_KEY);
    active = undefined;
  };
}
/** The installed adapter, if the owner connected Whop billing in this deployment. */
export function activeWhopAdapter() {
  return active;
}
/** Installs from the environment when the owner has enabled it; otherwise nothing is connected. */
export function installWhopBillingFromEnv() {
  const config = whopConfigFromEnv();
  if (config) installWhopBilling(config);
}

/** Express handler for `POST /api/billing/whop/webhook`, mounted with a raw JSON body parser. */
export async function whopWebhookHandler(req: { body: unknown; headers: Record<string, string | string[] | undefined> }, res: { status(code: number): { json(body: unknown): void } }) {
  if (!active) return res.status(503).json({ error: "مزود الفوترة غير موصول", code: "BILLING_PROVIDER_NOT_CONNECTED" });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "طلب غير صالح", code: "RAW_BODY_REQUIRED" });
  try {
    const result = await active.receive(req.body, req.headers);
    return res.status(result.status).json(result);
  } catch (error) {
    // Whop could not be asked for the authoritative state: nothing was recorded, so Whop's retry
    // schedule delivers the same event again later.
    if (error instanceof WhopUnavailableError) return res.status(503).json({ error: error.message, code: error.code });
    throw error;
  }
}
