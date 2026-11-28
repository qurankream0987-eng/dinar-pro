/**
 * Jassim Ads — paid promotions through a collection provider (provider-neutral, 2026-11-28).
 * JassimAI owns the promotion; the provider (Whop today) only collects and reports. Built switched
 * off; it can run only when every gate is open:
 *
 *   1. DINAR_JASSIM_ADS_PAYMENTS=true (and BDINAR_PROMOTIONS_ENABLED=true) on the deployment;
 *   2. the market's provider is registered by the server (Whop: DINAR_WHOP_BILLING_ENABLED + keys);
 *   3. the market's commercial policy says advertisingBillingActivation = PROVIDER_DIRECT (and
 *      advertisingBillingProvider names the provider, "whop" by default);
 *   4. the market's legal file enables ELECTRONIC_PAYMENT (never in pre-legal operation);
 *   5. the market currency is one the provider charges in (others stay closed, decision 2a).
 *
 * Payment success and campaign state are separate: the payment proves the right to the service;
 * the campaign has its own status, window and results.
 *
 * Money rules (CLAUDE.md invariants):
 *   - The price, currency and duration are the server's product snapshot; nothing comes from the client.
 *   - A browser returning from the provider grants nothing. A campaign starts only from the
 *     provider's signed payment event, after the server re-reads the payment from the provider and
 *     matches paid status, the JassimAI account, the seller, the currency and the exact pre-tax amount.
 *   - Every event is deduplicated by (provider, provider event id) in billing_webhook_events.
 *   - A full refund (the provider reports the whole total refunded) ends the campaign; a dispute pauses it.
 *     Nothing here ever issues a refund. A payment that cannot be honoured (campaign cancelled, slot
 *     taken, amount mismatch) is recorded and logged for the owner's review: never served, never
 *     silently kept.
 */
import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { billingWebhookEvents, db, listingPromotions, markets, offers, users } from "@workspace/db";
import { promotionBillingProvider, providerMoneyToMinor, type PromotionProviderEvent } from "./promotion-billing";
import { getCommercialPolicy } from "./commercial-policy";
import { assertMarketLegalCapability } from "./d16-readiness";
import { logger } from "./logger";
import { isPaidAdsPaymentsEnabled } from "./promotion-policy";
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
/** An unpaid checkout keeps its slot this long; a new request after that starts afresh. */
export const PROMOTION_PENDING_MINUTES = 60;

export type PromotionWebhookResult = { status: number; outcome: string; failureCode?: string | null; duplicate?: boolean };

const fail = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

export type PromotionPaymentAvailability =
  | { available: true; providerKey: string; displayName: string }
  | { available: false; code: "PAYMENTS_OFF" | "PROVIDER_NOT_CONNECTED" | "POLICY_DISABLED" | "CURRENCY_UNSUPPORTED" | "MARKET_NOT_APPROVED"; reason: string };

/** Whether this market can take a real promotion payment right now, and through which provider. */
export async function promotionPaymentAvailability(market: Market, tx: any = db): Promise<PromotionPaymentAvailability> {
  if (!isPaidAdsPaymentsEnabled()) return { available: false, code: "PAYMENTS_OFF", reason: "الدفع الحقيقي للترويج غير مفعّل بعد" };
  const policy = await getCommercialPolicy(market.id, tx);
  const provider = promotionBillingProvider(policy.advertisingBillingProvider);
  if (!provider) return { available: false, code: "PROVIDER_NOT_CONNECTED", reason: "مزود الدفع غير موصول" };
  if (policy.advertisingBillingActivation !== "PROVIDER_DIRECT") return { available: false, code: "POLICY_DISABLED", reason: "الدفع للترويج غير مفعّل في هذا السوق" };
  if (!provider.currencies.has(market.currencyCode))
    return { available: false, code: "CURRENCY_UNSUPPORTED", reason: "الدفع الإلكتروني للترويج غير متاح بعملة هذا السوق" };
  try {
    await assertMarketLegalCapability(market.id, "ELECTRONIC_PAYMENT", tx);
  } catch {
    return { available: false, code: "MARKET_NOT_APPROVED", reason: "الدفع الإلكتروني غير متاح في هذا السوق قبل اكتمال الاعتماد القانوني" };
  }
  return { available: true, providerKey: provider.key, displayName: provider.displayName };
}

/** Only one-off, fixed-price listing products are sold this way (no budgets, bundles or wallets). */
function directProduct(product: Awaited<ReturnType<typeof effectiveProduct>>) {
  return (LISTING_PRODUCT_TYPES as readonly string[]).includes(product.productType) && product.chargingMode === "FIXED" && product.priceMinor > 0;
}

export type PromotionCheckout = {
  created: boolean;
  promotion: SellerPromotionView;
  checkoutUrl: string;
  amountLabel: string;
  note: string;
  providerKey: string;
  providerName: string;
};

/**
 * Starts (or repeats) a provider checkout for one promotion of the seller's own listing. Idempotent
 * per seller key: the same key returns the same pending campaign and the same payment page.
 */
export async function startPromotionCheckout(input: { actorId: string; market: Market; productId: string; listingId: string; idempotencyKey: string }): Promise<PromotionCheckout> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw fail(400, "مفتاح عدم التكرار غير صالح", "IDEMPOTENCY_KEY_INVALID");
  const availability = await promotionPaymentAvailability(input.market);
  if (!availability.available) throw fail(409, availability.reason, `PROMOTION_PAYMENT_${availability.code}`);
  const provider = promotionBillingProvider(availability.providerKey)!;
  const reserved = await db.transaction(async (tx) => {
    const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId)).for("share");
    if (actor?.status !== "ACTIVE") throw fail(403, "حسابك مقيّد حاليًا ولا يمكن شراء ترويج.", "ACTOR_RESTRICTED");
    const product = await effectiveProduct(input.market, input.productId, tx);
    if (!directProduct(product)) throw fail(409, "هذا المنتج لا يُدفع مباشرةً عبر مزود الدفع", "PROMOTION_PAYMENT_PRODUCT_UNSUPPORTED");
    const listing = await ownedOffer(input.actorId, input.market, input.listingId, tx, true);
    const [prior] = await tx
      .select()
      .from(listingPromotions)
      .where(and(eq(listingPromotions.sellerId, input.actorId), eq(listingPromotions.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.listingId !== input.listingId || prior.productId !== product.id || prior.paymentSource !== "PROVIDER_DIRECT")
        throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      return { row: prior as PromotionRow, created: false };
    }
    const eligible = await listingPromotionEligibility(listing.offer, listing.sellerStatus, input.market, tx);
    if (!eligible.ok) throw fail(409, eligible.reason, "LISTING_INELIGIBLE");
    if (product.categoryId !== eligible.categoryId) throw fail(409, "هذا المنتج لا يخص فئة هذا الإعلان", "LISTING_INELIGIBLE");
    await expireStalePromotions({ listingId: listing.offer.id, tx });
    const now = new Date();
    // An abandoned checkout of this seller frees its slot after the pending window.
    await tx
      .update(listingPromotions)
      .set({ status: "CANCELLED", endedAt: now, updatedAt: now })
      .where(
        and(
          eq(listingPromotions.listingId, listing.offer.id),
          eq(listingPromotions.placementSnapshot, product.placement),
          eq(listingPromotions.status, "PENDING_PAYMENT"),
          eq(listingPromotions.paymentSource, "PROVIDER_DIRECT"),
          lte(listingPromotions.createdAt, new Date(now.getTime() - PROMOTION_PENDING_MINUTES * 60_000)),
        ),
      );
    const live = await liveCampaignAt(listing.offer.id, product.placement, tx);
    if (live?.status === "PENDING_PAYMENT" && live.paymentSource === "PROVIDER_DIRECT" && live.productId === product.id && live.sellerId === input.actorId)
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
        paymentMode: "PROVIDER_LIVE",
        paymentStatus: "PROVIDER_PENDING",
        paymentSource: "PROVIDER_DIRECT",
        idempotencyKey: input.idempotencyKey,
        productTypeSnapshot: product.productType,
        chargingModeSnapshot: product.chargingMode,
        pricingVersionSnapshot: product.pricingVersion,
        refundPolicySnapshot: product.refundPolicy,
        priorityWeightSnapshot: product.priorityWeight,
        taxPolicyVersion: product.taxPolicyVersion,
        // Placeholder window; the real one starts when the provider confirms the payment.
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
    throw Object.assign(fail(409, "هذا الطلب لم يعد بانتظار الدفع", "PROMOTION_PAYMENT_NOT_PENDING"), { promotion });
  }
  let checkoutUrl: string;
  if (row.paymentReference) checkoutUrl = await provider.checkoutUrl(row.paymentReference);
  else {
    let checkout;
    try {
      checkout = await provider.createCheckout({
        promotionId: row.id,
        userId: input.actorId,
        currencyCode: row.currencyCodeSnapshot,
        priceMinor: row.priceMinorSnapshot,
        scale: input.market.minorUnitScale,
        productRef: row.productId,
        title: row.productNameSnapshot,
      });
    } catch (error) {
      // The provider could not open a page: release the slot (no money can exist without a page).
      if (reserved.created)
        await db
          .update(listingPromotions)
          .set({ status: "CANCELLED", endedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(listingPromotions.id, row.id), eq(listingPromotions.status, "PENDING_PAYMENT")));
      throw error;
    }
    const [updated] = await db
      .update(listingPromotions)
      // The provider and its checkout reference are recorded together (listing_promotions_reference_consistent).
      .set({ paymentProviderKey: provider.key, paymentReference: checkout.checkoutId, updatedAt: new Date() })
      .where(eq(listingPromotions.id, row.id))
      .returning();
    row = updated as PromotionRow;
    checkoutUrl = checkout.checkoutUrl;
  }
  logger.info({ event: "promotion_checkout", provider: provider.key, marketId: input.market.id, created: reserved.created }, "promotion checkout opened");
  return {
    created: reserved.created,
    promotion: (await promotionViews([row], input.market))[0]!,
    checkoutUrl,
    amountLabel: `${formatMinor(row.priceMinorSnapshot, input.market.minorUnitScale)} ${row.currencyCodeSnapshot}`,
    note: `الدفع في صفحة ${provider.displayName} الآمنة. يبدأ الترويج ${row.durationDaysSnapshot} ${row.durationDaysSnapshot === 1 ? "يومًا" : "أيام"} فقط بعد أن يؤكد مزود الدفع الدفع، دون تجديد تلقائي. قد يضيف المزود الضريبة المطبقة.`,
    providerKey: provider.key,
    providerName: provider.displayName,
  };
}

// ─── Signed provider events (called only by a provider's verified webhook handler) ─────────────

/**
 * Applies one verified provider event to its campaign. The (provider, event id) pair is recorded in
 * the same transaction as the change, so a redelivery changes nothing. Only this function decides
 * what a campaign becomes; a provider supplies facts it read from its own API.
 */
export async function applyPromotionProviderEvent(event: PromotionProviderEvent): Promise<PromotionWebhookResult> {
  // 0084: a multi-placement campaign is settled as one payment (same dedup, amount and owner rules).
  const campaigns = await import("./promotion-campaigns");
  if (await campaigns.isCampaignId(event.promotionId)) return campaigns.applyCampaignProviderEvent(event);
  let demandMatch: { id: string; marketId: string } | undefined;
  const result = await db.transaction(async (tx) => {
    const record = async (status: "APPLIED" | "IGNORED" | "REJECTED", failureCode: string | null) => {
      const [inserted] = await tx
        .insert(billingWebhookEvents)
        .values({ id: randomUUID(), providerKey: event.providerKey, providerEventId: event.eventId, eventType: event.eventType.slice(0, 80), payloadDigest: event.digest, status, failureCode, processedAt: new Date() })
        .onConflictDoNothing()
        .returning();
      return inserted;
    };
    const done = async (status: "APPLIED" | "IGNORED" | "REJECTED", failureCode: string | null, apply?: () => Promise<void>) => {
      const inserted = await record(status, failureCode);
      // A concurrent delivery of the same event already decided it: change nothing.
      if (!inserted) return { status: 200, outcome: status, failureCode, duplicate: true };
      if (apply) await apply();
      if (status !== "APPLIED") logger.warn({ event: "promotion_payment_event", provider: event.providerKey, type: event.type, failureCode }, "promotion payment event recorded for review");
      return { status: 200, outcome: status, failureCode, duplicate: false };
    };

    const [row] = (await tx.select().from(listingPromotions).where(eq(listingPromotions.id, event.promotionId)).for("update")) as PromotionRow[];
    if (!row || row.paymentSource !== "PROVIDER_DIRECT" || row.paymentMode !== "PROVIDER_LIVE") return done("REJECTED", "UNKNOWN_PROMOTION");
    // A provider may only settle campaigns opened through it.
    if (row.paymentProviderKey !== event.providerKey) return done("REJECTED", "PROVIDER_MISMATCH");
    const payment = event.facts;
    if (payment.accountId && payment.accountId !== event.expectedAccountId) return done("REJECTED", "ACCOUNT_MISMATCH");
    if (payment.ownerUserId !== row.sellerId) return done("REJECTED", "OWNER_MISMATCH");
    const [market] = await tx.select({ scale: markets.minorUnitScale }).from(markets).where(eq(markets.id, row.marketId));
    const scale = market?.scale;
    const now = new Date();

    if (event.type === "PAID") {
      if (payment.status !== "paid") return done("IGNORED", "PROVIDER_STATE_NOT_PAID");
      const amount = payment.subtotal && scale !== undefined ? providerMoneyToMinor(payment.subtotal, scale) : undefined;
      if (!payment.subtotal || payment.subtotal.currency.toUpperCase() !== row.currencyCodeSnapshot || amount !== row.priceMinorSnapshot)
        return done("REJECTED", "AMOUNT_MISMATCH_REVIEW");
      if (row.paymentStatus === "PROVIDER_PAID") return done("IGNORED", "ALREADY_PAID_SECOND_PAYMENT_REVIEW");
      // Out of order: a refund or dispute was already recorded on this campaign. Never activate.
      if (row.paymentStatus === "PROVIDER_DISPUTED" || row.paymentStatus === "PROVIDER_REFUNDED")
        return done("IGNORED", "ALREADY_SETTLED_PAYMENT_REVIEW");
      // The campaign was cancelled before the money arrived: never served on it, the owner reviews
      // the payment for a refund at the provider (nothing here marks money refunded).
      if (row.status !== "PENDING_PAYMENT") return done("REJECTED", "PAID_AFTER_CANCEL_REFUND_REVIEW");
      // Paying is not serving: if the listing was removed (or the seller restricted) while the
      // payment was pending, the payment is recorded as paid but the campaign never starts; the
      // owner reviews it for a refund at the provider.
      const [listing] = await tx.select({ status: offers.status }).from(offers).where(eq(offers.id, row.listingId));
      const [seller] = await tx.select({ status: users.status }).from(users).where(eq(users.id, row.sellerId));
      if (listing?.status !== "PUBLISHED" || seller?.status !== "ACTIVE")
        return done("APPLIED", "PAID_LISTING_UNAVAILABLE_REFUND_REVIEW", async () => {
          await tx.update(listingPromotions).set({ status: "CANCELLED", paymentStatus: "PROVIDER_PAID", endedAt: now, updatedAt: now }).where(eq(listingPromotions.id, row.id));
          logger.warn({ event: "promotion_paid_listing_unavailable", provider: event.providerKey }, "paid promotion not started: listing unavailable; refund review");
        });
      return done("APPLIED", null, async () => {
        await tx
          .update(listingPromotions)
          .set({ status: "ACTIVE", paymentStatus: "PROVIDER_PAID", startsAt: now, expiresAt: new Date(now.getTime() + row.durationDaysSnapshot * DAY_MS), updatedAt: now })
          .where(eq(listingPromotions.id, row.id));
        if (row.placementSnapshot === "DEMAND") demandMatch = { id: row.id, marketId: row.marketId };
        logger.info({ event: "promotion_activated", provider: event.providerKey, marketId: row.marketId }, "promotion activated from a verified provider payment");
      });
    }

    if (event.type === "FAILED") {
      // A declined attempt keeps the checkout open: the seller may retry on the same page.
      if (payment.status === "paid") return done("IGNORED", "PROVIDER_STATE_PAID");
      return done("IGNORED", "ATTEMPT_FAILED_RETRY_ALLOWED");
    }

    if (event.type === "REFUNDED") {
      const refunded = payment.refunded && scale !== undefined ? providerMoneyToMinor(payment.refunded, scale) : undefined;
      const total = payment.total && scale !== undefined ? providerMoneyToMinor(payment.total, scale) : undefined;
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

    // DISPUTED: disputed money never serves. A campaign still waiting for its payment is cancelled
    // (so a delayed payment.succeeded can never start it); a live one pauses until the owner decides.
    if (row.paymentStatus === "PROVIDER_PENDING" && row.status === "PENDING_PAYMENT")
      return done("APPLIED", null, async () => {
        await tx
          .update(listingPromotions)
          .set({ paymentStatus: "PROVIDER_DISPUTED", status: "CANCELLED", endedAt: now, updatedAt: now })
          .where(eq(listingPromotions.id, row.id));
      });
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
 * Whether a commercial purchase in the conversation is paid through the provider instead of the
 * test balance: a direct fixed-price listing product, not a bundle unit, and every gate open.
 */
export async function providerDirectApplies(input: { market: Market; productId: string; paymentSource?: string }) {
  if (input.paymentSource === "BUNDLE_ENTITLEMENT") return false;
  if (!(await promotionPaymentAvailability(input.market)).available) return false;
  const product = await effectiveProduct(input.market, input.productId).catch(() => undefined);
  return !!product && directProduct(product);
}

export const promotionReviewNote = (providerName: string) =>
  `دفع حقيقي عبر صفحة ${providerName} الآمنة بعملة سوقك. لا يُخصم شيء عند «تأكيد»؛ يبدأ الترويج فقط بعد التأكيد الموقّع للدفع من مزود الدفع، دون تجديد تلقائي. قد يضيف المزود الضريبة المطبقة.`;
