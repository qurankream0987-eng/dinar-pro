/**
 * Jassim Ads — Phase 2 (owner decisions 2026-11-27, "1a 2a"): a seller pays one fixed-price
 * promotion directly through Whop. Built switched off; it can run only when every gate is open:
 *
 *   1. DINAR_JASSIM_ADS_PAYMENTS=true (and BDINAR_PROMOTIONS_ENABLED=true) on the deployment;
 *   2. Whop billing installed by the server (DINAR_WHOP_BILLING_ENABLED + keys);
 *   3. the market's commercial policy says advertisingBillingActivation = WHOP_DIRECT;
 *   4. the market's legal file enables ELECTRONIC_PAYMENT (never in pre-legal operation);
 *   5. the market currency is one Whop accepts for plans (the 10 others stay closed, decision 2a).
 *
 * Money rules (CLAUDE.md invariants):
 *   - The price, currency and duration are the server's product snapshot; nothing comes from the client.
 *   - A browser returning from Whop grants nothing. A campaign starts only from Whop's signed
 *     `payment.succeeded`, after the server re-reads the payment from Whop and matches paid status,
 *     the JassimAI company, the seller, the currency and the exact pre-tax amount.
 *   - Every event is deduplicated by Whop's `webhook-id` (billing_webhook_events).
 *   - A full refund (Whop reports the whole total refunded) ends the campaign; a dispute pauses it.
 *     Nothing here ever issues a refund. A payment that cannot be honoured (campaign cancelled, slot
 *     taken, amount mismatch) is recorded and logged for the owner's review: never served, never
 *     silently kept.
 */
import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { billingWebhookEvents, db, listingPromotions, markets, users } from "@workspace/db";
import { activeWhopAdapter, moneyToMinor, WHOP_PROVIDER_KEY, type WhopPromotionEvent, type WhopWebhookResult } from "./billing/whop";
import { getCommercialPolicy } from "./commercial-policy";
import { assertMarketLegalCapability } from "./d16-readiness";
import { logger } from "./logger";
import { isWhopAdsPaymentsEnabled } from "./promotion-policy";
import {
  effectiveProduct,
  expireStalePromotions,
  formatMinor,
  LISTING_PRODUCT_TYPES,
  listingPromotionEligibility,
  liveCampaignAt,
  ownedOffer,
  promotionViews,
  refreshLimitBreach,
  type SellerPromotionView,
} from "./promotions";
import type { marketFor } from "./markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
type PromotionRow = typeof listingPromotions.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
/** An unpaid Whop checkout keeps its slot this long; a new request after that starts afresh. */
export const WHOP_PROMOTION_PENDING_MINUTES = 60;

/** Arab-market currencies Whop accepts for plans (docs.whop.com, read 2026-11-27). */
export const WHOP_PROMOTION_CURRENCIES = new Set(["AED", "BHD", "DZD", "EGP", "ILS", "JOD", "KWD", "MAD", "OMR", "QAR", "SAR", "TND"]);

const fail = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

export type WhopPromotionAvailability =
  | { available: true }
  | { available: false; code: "PAYMENTS_OFF" | "PROVIDER_NOT_CONNECTED" | "POLICY_DISABLED" | "CURRENCY_UNSUPPORTED" | "MARKET_NOT_APPROVED"; reason: string };

/** Whether this market can take a real promotion payment right now. Changes nothing. */
export async function whopPromotionAvailability(market: Market, tx: any = db): Promise<WhopPromotionAvailability> {
  if (!isWhopAdsPaymentsEnabled()) return { available: false, code: "PAYMENTS_OFF", reason: "الدفع الحقيقي للترويج غير مفعّل بعد" };
  if (!activeWhopAdapter()) return { available: false, code: "PROVIDER_NOT_CONNECTED", reason: "مزود الدفع غير موصول" };
  const policy = await getCommercialPolicy(market.id, tx);
  if (policy.advertisingBillingActivation !== "WHOP_DIRECT") return { available: false, code: "POLICY_DISABLED", reason: "الدفع للترويج غير مفعّل في هذا السوق" };
  if (!WHOP_PROMOTION_CURRENCIES.has(market.currencyCode))
    return { available: false, code: "CURRENCY_UNSUPPORTED", reason: "الدفع الإلكتروني للترويج غير متاح بعملة هذا السوق" };
  try {
    await assertMarketLegalCapability(market.id, "ELECTRONIC_PAYMENT", tx);
  } catch {
    return { available: false, code: "MARKET_NOT_APPROVED", reason: "الدفع الإلكتروني غير متاح في هذا السوق قبل اكتمال الاعتماد القانوني" };
  }
  return { available: true };
}

/** Only one-off, fixed-price listing products are sold this way (no budgets, bundles or wallets). */
function directProduct(product: Awaited<ReturnType<typeof effectiveProduct>>) {
  return (LISTING_PRODUCT_TYPES as readonly string[]).includes(product.productType) && product.chargingMode === "FIXED" && product.priceMinor > 0;
}

export type WhopPromotionCheckout = {
  created: boolean;
  promotion: SellerPromotionView;
  checkoutUrl: string;
  amountLabel: string;
  note: string;
};

/**
 * Starts (or repeats) a Whop checkout for one promotion of the seller's own listing. Idempotent per
 * seller key: the same key returns the same pending campaign and the same Whop page.
 */
export async function startWhopPromotionCheckout(input: { actorId: string; market: Market; productId: string; listingId: string; idempotencyKey: string }): Promise<WhopPromotionCheckout> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw fail(400, "مفتاح عدم التكرار غير صالح", "IDEMPOTENCY_KEY_INVALID");
  const availability = await whopPromotionAvailability(input.market);
  if (!availability.available) throw fail(409, availability.reason, `WHOP_PROMOTION_${availability.code}`);
  const adapter = activeWhopAdapter()!;
  const reserved = await db.transaction(async (tx) => {
    const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId)).for("share");
    if (actor?.status !== "ACTIVE") throw fail(403, "حسابك مقيّد حاليًا ولا يمكن شراء ترويج.", "ACTOR_RESTRICTED");
    const product = await effectiveProduct(input.market, input.productId, tx);
    if (!directProduct(product)) throw fail(409, "هذا المنتج لا يُدفع مباشرةً عبر Whop", "WHOP_PROMOTION_PRODUCT_UNSUPPORTED");
    const listing = await ownedOffer(input.actorId, input.market, input.listingId, tx, true);
    const [prior] = await tx
      .select()
      .from(listingPromotions)
      .where(and(eq(listingPromotions.sellerId, input.actorId), eq(listingPromotions.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.listingId !== input.listingId || prior.productId !== product.id || prior.paymentSource !== "WHOP_DIRECT")
        throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      return { row: prior as PromotionRow, created: false };
    }
    const eligible = await listingPromotionEligibility(listing.offer, listing.sellerStatus, input.market, tx);
    if (!eligible.ok) throw fail(409, eligible.reason, "LISTING_INELIGIBLE");
    if (product.categoryId !== eligible.categoryId) throw fail(409, "هذا المنتج لا يخص فئة هذا الإعلان", "LISTING_INELIGIBLE");
    await expireStalePromotions({ listingId: listing.offer.id, tx });
    const now = new Date();
    // An abandoned Whop checkout of this seller frees its slot after the pending window.
    await tx
      .update(listingPromotions)
      .set({ status: "CANCELLED", endedAt: now, updatedAt: now })
      .where(
        and(
          eq(listingPromotions.listingId, listing.offer.id),
          eq(listingPromotions.placementSnapshot, product.placement),
          eq(listingPromotions.status, "PENDING_PAYMENT"),
          eq(listingPromotions.paymentSource, "WHOP_DIRECT"),
          lte(listingPromotions.createdAt, new Date(now.getTime() - WHOP_PROMOTION_PENDING_MINUTES * 60_000)),
        ),
      );
    const live = await liveCampaignAt(listing.offer.id, product.placement, tx);
    if (live?.status === "PENDING_PAYMENT" && live.paymentSource === "WHOP_DIRECT" && live.productId === product.id && live.sellerId === input.actorId)
      return { row: live as PromotionRow, created: false };
    if (live) throw fail(409, live.status === "PENDING_PAYMENT" ? "لدى الإعلان دفع ترويج قيد الإتمام" : "لدى الإعلان حملة قائمة من النوع نفسه", "ALREADY_LIVE");
    if (product.productType === "REFRESH_LISTING") {
      const breach = await refreshLimitBreach(listing.offer.id, await getCommercialPolicy(input.market.id, tx), tx);
      if (breach) throw fail(409, breach, "REFRESH_LIMIT");
    }
    const id = randomUUID();
    const [row] = await tx
      .insert(listingPromotions)
      .values({
        id,
        listingId: listing.offer.id,
        sellerId: input.actorId,
        marketId: input.market.id,
        productId: product.id,
        productNameSnapshot: product.name,
        categoryIdSnapshot: product.categoryId!,
        priceMinorSnapshot: product.priceMinor,
        currencyCodeSnapshot: product.currencyCode,
        placementSnapshot: product.placement,
        durationDaysSnapshot: product.durationDays,
        status: "PENDING_PAYMENT",
        paymentMode: "WHOP_LIVE",
        paymentStatus: "PROVIDER_PENDING",
        paymentSource: "WHOP_DIRECT",
        idempotencyKey: input.idempotencyKey,
        productTypeSnapshot: product.productType,
        chargingModeSnapshot: product.chargingMode,
        pricingVersionSnapshot: product.pricingVersion,
        refundPolicySnapshot: product.refundPolicy,
        priorityWeightSnapshot: product.priorityWeight,
        taxPolicyVersion: product.taxPolicyVersion,
        // Placeholder window; the real one starts when Whop confirms the payment.
        startsAt: now,
        expiresAt: new Date(now.getTime() + product.durationDays * DAY_MS),
      })
      .returning();
    return { row: row as PromotionRow, created: true };
  });

  let row = reserved.row;
  if (row.status !== "PENDING_PAYMENT") {
    // A repeated request after the payment was confirmed (or ended): no new page, just the state.
    const promotion = (await promotionViews([row], input.market))[0]!;
    throw Object.assign(fail(409, "هذا الطلب لم يعد بانتظار الدفع", "WHOP_PROMOTION_NOT_PENDING"), { promotion });
  }
  let checkoutUrl: string;
  if (row.paymentReference) checkoutUrl = await adapter.promotionCheckoutUrl(row.paymentReference);
  else {
    let checkout;
    try {
      checkout = await adapter.createPromotionCheckout({
        promotionId: row.id,
        userId: input.actorId,
        currencyCode: row.currencyCodeSnapshot,
        priceMinor: row.priceMinorSnapshot,
        scale: input.market.minorUnitScale,
        productRef: row.productId,
        title: row.productNameSnapshot,
      });
    } catch (error) {
      // Whop could not open a page: release the slot (no money can exist without a page).
      if (reserved.created)
        await db
          .update(listingPromotions)
          .set({ status: "CANCELLED", endedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(listingPromotions.id, row.id), eq(listingPromotions.status, "PENDING_PAYMENT")));
      throw error;
    }
    const [updated] = await db
      .update(listingPromotions)
      .set({ paymentProviderKey: WHOP_PROVIDER_KEY, paymentReference: checkout.checkoutId, updatedAt: new Date() })
      .where(eq(listingPromotions.id, row.id))
      .returning();
    row = updated as PromotionRow;
    checkoutUrl = checkout.checkoutUrl;
  }
  logger.info({ event: "whop_promotion_checkout", marketId: input.market.id, created: reserved.created }, "promotion checkout opened");
  return {
    created: reserved.created,
    promotion: (await promotionViews([row], input.market))[0]!,
    checkoutUrl,
    amountLabel: `${formatMinor(row.priceMinorSnapshot, input.market.minorUnitScale)} ${row.currencyCodeSnapshot}`,
    note: `الدفع في صفحة Whop الآمنة. يبدأ الترويج ${row.durationDaysSnapshot} ${row.durationDaysSnapshot === 1 ? "يومًا" : "أيام"} فقط بعد أن يؤكد Whop الدفع، دون تجديد تلقائي. قد يضيف Whop الضريبة المطبقة.`,
  };
}

// ─── Signed Whop events (called only by the verified webhook in billing/whop.ts) ───────────────

/**
 * Applies one verified Whop event to its campaign. The webhook id is recorded in the same
 * transaction as the change, so a redelivery changes nothing.
 */
export async function applyWhopPromotionEvent(event: WhopPromotionEvent): Promise<WhopWebhookResult> {
  let demandMatch: { id: string; marketId: string } | undefined;
  const result = await db.transaction(async (tx) => {
    const record = async (status: "APPLIED" | "IGNORED" | "REJECTED", failureCode: string | null) => {
      const [inserted] = await tx
        .insert(billingWebhookEvents)
        .values({ id: randomUUID(), providerKey: WHOP_PROVIDER_KEY, providerEventId: event.eventId, eventType: event.eventType.slice(0, 80), payloadDigest: event.digest, status, failureCode, processedAt: new Date() })
        .onConflictDoNothing()
        .returning();
      return inserted;
    };
    const done = async (status: "APPLIED" | "IGNORED" | "REJECTED", failureCode: string | null, apply?: () => Promise<void>) => {
      const inserted = await record(status, failureCode);
      // A concurrent delivery of the same event already decided it: change nothing.
      if (!inserted) return { status: 200, outcome: status, failureCode, duplicate: true };
      if (apply) await apply();
      if (status !== "APPLIED") logger.warn({ event: "whop_promotion_event", type: event.type, failureCode }, "promotion payment event recorded for review");
      return { status: 200, outcome: status, failureCode, duplicate: false };
    };

    const [row] = (await tx.select().from(listingPromotions).where(eq(listingPromotions.id, event.promotionId)).for("update")) as PromotionRow[];
    if (!row || row.paymentSource !== "WHOP_DIRECT" || row.paymentMode !== "WHOP_LIVE") return done("REJECTED", "UNKNOWN_PROMOTION");
    const payment = event.payment;
    if (payment.account_id && payment.account_id !== event.accountId) return done("REJECTED", "ACCOUNT_MISMATCH");
    const metadataUser = typeof payment.metadata?.jassim_user_id === "string" ? payment.metadata.jassim_user_id : undefined;
    if (metadataUser !== row.sellerId) return done("REJECTED", "OWNER_MISMATCH");
    const [market] = await tx.select({ scale: markets.minorUnitScale }).from(markets).where(eq(markets.id, row.marketId));
    const scale = market?.scale;
    const now = new Date();

    if (event.type === "PAID") {
      if (payment.status !== "paid") return done("IGNORED", "PROVIDER_STATE_NOT_PAID");
      const amount = payment.subtotal && scale !== undefined ? moneyToMinor(payment.subtotal, scale) : undefined;
      if (!payment.subtotal || payment.subtotal.currency.toUpperCase() !== row.currencyCodeSnapshot || amount !== row.priceMinorSnapshot)
        return done("REJECTED", "AMOUNT_MISMATCH_REVIEW");
      if (row.paymentStatus === "PROVIDER_PAID" || row.paymentStatus === "PROVIDER_DISPUTED" || row.paymentStatus === "PROVIDER_REFUNDED")
        return done("IGNORED", "ALREADY_PAID_SECOND_PAYMENT_REVIEW");
      // The campaign was cancelled before the money arrived: never served on it, the owner reviews
      // the payment for a refund in Whop (nothing here marks money refunded).
      if (row.status !== "PENDING_PAYMENT") return done("REJECTED", "PAID_AFTER_CANCEL_REFUND_REVIEW");
      return done("APPLIED", null, async () => {
        await tx
          .update(listingPromotions)
          .set({ status: "ACTIVE", paymentStatus: "PROVIDER_PAID", startsAt: now, expiresAt: new Date(now.getTime() + row.durationDaysSnapshot * DAY_MS), updatedAt: now })
          .where(eq(listingPromotions.id, row.id));
        if (row.placementSnapshot === "DEMAND") demandMatch = { id: row.id, marketId: row.marketId };
        logger.info({ event: "whop_promotion_activated", marketId: row.marketId }, "promotion activated from verified Whop payment");
      });
    }

    if (event.type === "FAILED") {
      // Whop keeps the checkout open after a decline: the seller may retry on the same page.
      if (payment.status === "paid") return done("IGNORED", "PROVIDER_STATE_PAID");
      return done("IGNORED", "ATTEMPT_FAILED_RETRY_ALLOWED");
    }

    if (event.type === "REFUNDED") {
      const refunded = payment.refunded_amount && scale !== undefined ? moneyToMinor(payment.refunded_amount, scale) : undefined;
      const total = payment.total && scale !== undefined ? moneyToMinor(payment.total, scale) : undefined;
      if (!refunded || !total) return done("REJECTED", "AMOUNT_MISMATCH_REVIEW");
      if (refunded < total) return done("IGNORED", "PARTIAL_REFUND_FOR_REVIEW");
      if (row.paymentStatus === "PROVIDER_REFUNDED") return done("IGNORED", "ALREADY_REFUNDED");
      return done("APPLIED", null, async () => {
        await tx
          .update(listingPromotions)
          .set({
            paymentStatus: "PROVIDER_REFUNDED",
            ...(["ACTIVE", "PAUSED", "PENDING_PAYMENT"].includes(row.status) ? { status: "CANCELLED", endedAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(listingPromotions.id, row.id));
      });
    }

    // DISPUTED: disputed money never serves; the campaign pauses until the owner decides.
    if (row.paymentStatus !== "PROVIDER_PAID") return done("IGNORED", "DISPUTE_RECORDED_FOR_REVIEW");
    return done("APPLIED", null, async () => {
      await tx
        .update(listingPromotions)
        .set({ paymentStatus: "PROVIDER_DISPUTED", ...(row.status === "ACTIVE" ? { status: "PAUSED", pausedAt: now } : {}), updatedAt: now })
        .where(eq(listingPromotions.id, row.id));
    });
  });
  // «جاسم روح بيع لي»: notify buyer-authorised saved requests once the campaign serves.
  if (demandMatch) {
    const { matchDemandCampaign } = await import("./demand-requests");
    const { resolveMarket } = await import("./markets");
    const [marketRow] = await db.select().from(markets).where(eq(markets.id, demandMatch.marketId));
    const market = marketRow ? await resolveMarket(marketRow).catch(() => undefined) : undefined;
    if (market) await matchDemandCampaign(demandMatch.id, market).catch((error) => logger.warn({ event: "demand_match_failed", err: error }, "demand match failed"));
  }
  return result;
}

/**
 * Whether a commercial purchase in the conversation is paid through Whop instead of the test
 * balance: a direct fixed-price listing product, not a bundle unit, and every gate open.
 */
export async function whopDirectApplies(input: { market: Market; productId: string; paymentSource?: string }) {
  if (input.paymentSource === "BUNDLE_ENTITLEMENT") return false;
  if (!(await whopPromotionAvailability(input.market)).available) return false;
  const product = await effectiveProduct(input.market, input.productId).catch(() => undefined);
  return !!product && directProduct(product);
}

export const WHOP_PROMOTION_REVIEW_NOTE =
  "دفع حقيقي عبر صفحة Whop الآمنة بعملة سوقك. لا يُخصم شيء عند «تأكيد»؛ يبدأ الترويج فقط بعد تأكيد Whop الموقّع للدفع، دون تجديد تلقائي. قد يضيف Whop الضريبة المطبقة.";
