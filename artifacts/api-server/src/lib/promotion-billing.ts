/**
 * Jassim Ads Phase 2 — provider-neutral billing contract & registry.
 *
 * JassimAI owns its advertising products, prices, campaigns, and legal/policy gates.
 * A registered `PromotionBillingProvider` only executes payment collection and reports signed,
 * verified payment outcomes. Replacing a provider (e.g. Whop -> local gateway) requires only
 * registering a new provider implementation; no ads-flow code changes are needed.
 */
import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { billingWebhookEvents, db, listingPromotions, markets, users } from "@workspace/db";
import { getCommercialPolicy } from "./commercial-policy";
import { assertMarketLegalCapability } from "./d16-readiness";
import { logger } from "./logger";
import { isProviderAdsPaymentsEnabled } from "./promotion-policy";
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
/** An unpaid provider checkout keeps its slot this long; a new request after that starts afresh. */
export const PROVIDER_PROMOTION_PENDING_MINUTES = 60;

const fail = (status: number, message: string, code: string) =>
  Object.assign(new Error(message), { status, code, expose: true });

export type PromotionWebhookResult = {
  status: number;
  outcome: string;
  failureCode: string | null;
  duplicate?: boolean;
};

export type PromotionBillingEvent = {
  eventId: string;
  eventType: string;
  digest: string;
  type: "PAID" | "FAILED" | "REFUNDED" | "DISPUTED";
  promotionId: string;
  sellerId: string;
  /** Provider's re-read payment status (e.g. "paid" for PAID). */
  providerPaymentStatus: string;
  currencyCode?: string;
  amountMinor?: number;
  refundedMinor?: number;
  totalMinor?: number;
  accountMismatch?: boolean;
};

export interface PromotionBillingProvider {
  readonly providerKey: string;
  readonly displayName: string;
  readonly supportedCurrencies: ReadonlySet<string>;
  readonly blockedCountries: readonly string[];
  createPromotionCheckout(input: {
    promotionId: string;
    userId: string;
    currencyCode: string;
    priceMinor: number;
    scale: number;
    productRef: string;
    title: string;
  }): Promise<{ checkoutId: string; checkoutUrl: string }>;
  promotionCheckoutUrl(checkoutId: string): Promise<string>;
  verifyAndParseWebhook?(
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
    nowSeconds?: number,
  ): Promise<
    | { ok: true; event: PromotionBillingEvent }
    | { ok: false; result: PromotionWebhookResult }
  >;
}

const registered = new Map<string, PromotionBillingProvider>();

export function registerPromotionBillingProvider(provider: PromotionBillingProvider): void {
  if (process.env.NODE_ENV === "production" && process.env.DINAR_LIVE_PROVIDERS_ENABLED !== "true") {
    throw new Error("Live billing providers are disabled");
  }
  registered.set(provider.providerKey, provider);
}

export function unregisterPromotionBillingProvider(providerKey: string): void {
  registered.delete(providerKey);
}

export function getPromotionBillingProvider(providerKey?: string): PromotionBillingProvider | undefined {
  if (providerKey) return registered.get(providerKey);
  return registered.size === 1 ? [...registered.values()][0] : undefined;
}

export function listPromotionBillingProviders(): PromotionBillingProvider[] {
  return [...registered.values()];
}

export type PromotionBillingAvailability =
  | { available: true; provider: PromotionBillingProvider }
  | {
      available: false;
      code:
        | "PAYMENTS_OFF"
        | "PROVIDER_NOT_CONNECTED"
        | "POLICY_DISABLED"
        | "COUNTRY_BLOCKED"
        | "CURRENCY_UNSUPPORTED"
        | "MARKET_NOT_APPROVED";
      reason: string;
    };

/** Whether this market can take a real direct promotion payment right now. Changes nothing. */
export async function promotionBillingAvailability(
  market: Market,
  tx: any = db,
): Promise<PromotionBillingAvailability> {
  if (!isProviderAdsPaymentsEnabled()) {
    return { available: false, code: "PAYMENTS_OFF", reason: "الدفع الحقيقي للترويج غير مفعّل بعد" };
  }
  const policy = await getCommercialPolicy(market.id, tx);
  if (policy.advertisingBillingActivation !== "PROVIDER_DIRECT") {
    return { available: false, code: "POLICY_DISABLED", reason: "الدفع للترويج غير مفعّل في هذا السوق" };
  }
  const provider = getPromotionBillingProvider(policy.advertisingBillingProvider);
  if (!provider) {
    return { available: false, code: "PROVIDER_NOT_CONNECTED", reason: "مزود الدفع غير موصول" };
  }
  if (provider.blockedCountries.includes(market.countryCode.toUpperCase())) {
    return { available: false, code: "COUNTRY_BLOCKED", reason: "الدفع الإلكتروني للترويج غير متاح في هذا البلد" };
  }
  if (!provider.supportedCurrencies.has(market.currencyCode.toUpperCase())) {
    return { available: false, code: "CURRENCY_UNSUPPORTED", reason: "الدفع الإلكتروني للترويج غير متاح بعملة هذا السوق" };
  }
  try {
    await assertMarketLegalCapability(market.id, "ELECTRONIC_PAYMENT", tx);
  } catch {
    return {
      available: false,
      code: "MARKET_NOT_APPROVED",
      reason: "الدفع الإلكتروني غير متاح في هذا السوق قبل اكتمال الاعتماد القانوني",
    };
  }
  return { available: true, provider };
}

function directProduct(product: Awaited<ReturnType<typeof effectiveProduct>>) {
  return (
    (LISTING_PRODUCT_TYPES as readonly string[]).includes(product.productType) &&
    product.chargingMode === "FIXED" &&
    product.priceMinor > 0
  );
}

export type ProviderPromotionCheckout = {
  created: boolean;
  providerKey: string;
  providerDisplayName: string;
  promotion: SellerPromotionView;
  checkoutUrl: string;
  amountLabel: string;
  note: string;
};

/**
 * Starts (or repeats) a provider checkout for one promotion of the seller's own listing.
 * Idempotent per seller key.
 */
export async function startProviderPromotionCheckout(input: {
  actorId: string;
  market: Market;
  productId: string;
  listingId: string;
  idempotencyKey: string;
}): Promise<ProviderPromotionCheckout> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    throw fail(400, "مفتاح عدم التكرار غير صالح", "IDEMPOTENCY_KEY_INVALID");
  }
  const availability = await promotionBillingAvailability(input.market);
  if (!availability.available) {
    throw fail(409, availability.reason, `PROVIDER_PROMOTION_${availability.code}`);
  }
  const { provider } = availability;

  const reserved = await db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, input.actorId))
      .for("share");
    if (actor?.status !== "ACTIVE") {
      throw fail(403, "حسابك مقيّد حاليًا ولا يمكن شراء ترويج.", "ACTOR_RESTRICTED");
    }
    const product = await effectiveProduct(input.market, input.productId, tx);
    if (!directProduct(product)) {
      throw fail(409, "هذا المنتج لا يُدفع مباشرةً عبر مزود الدفع", "PROVIDER_PROMOTION_PRODUCT_UNSUPPORTED");
    }
    const listing = await ownedOffer(input.actorId, input.market, input.listingId, tx, true);
    const [prior] = await tx
      .select()
      .from(listingPromotions)
      .where(and(eq(listingPromotions.sellerId, input.actorId), eq(listingPromotions.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.listingId !== input.listingId || prior.productId !== product.id || prior.paymentSource !== "PROVIDER_DIRECT") {
        throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      }
      return { row: prior as PromotionRow, created: false };
    }
    const eligible = await listingPromotionEligibility(listing.offer, listing.sellerStatus, input.market, tx);
    if (!eligible.ok) throw fail(409, eligible.reason, "LISTING_INELIGIBLE");
    if (product.categoryId !== eligible.categoryId) {
      throw fail(409, "هذا المنتج لا يخص فئة هذا الإعلان", "LISTING_INELIGIBLE");
    }
    await expireStalePromotions({ listingId: listing.offer.id, tx });
    const now = new Date();
    await tx
      .update(listingPromotions)
      .set({ status: "CANCELLED", endedAt: now, updatedAt: now })
      .where(
        and(
          eq(listingPromotions.listingId, listing.offer.id),
          eq(listingPromotions.placementSnapshot, product.placement),
          eq(listingPromotions.status, "PENDING_PAYMENT"),
          eq(listingPromotions.paymentSource, "PROVIDER_DIRECT"),
          lte(listingPromotions.createdAt, new Date(now.getTime() - PROVIDER_PROMOTION_PENDING_MINUTES * 60_000)),
        ),
      );
    const live = await liveCampaignAt(listing.offer.id, product.placement, tx);
    if (
      live?.status === "PENDING_PAYMENT" &&
      live.paymentSource === "PROVIDER_DIRECT" &&
      live.productId === product.id &&
      live.sellerId === input.actorId
    ) {
      return { row: live as PromotionRow, created: false };
    }
    if (live) {
      throw fail(
        409,
        live.status === "PENDING_PAYMENT" ? "لدى الإعلان دفع ترويج قيد الإتمام" : "لدى الإعلان حملة قائمة من النوع نفسه",
        "ALREADY_LIVE",
      );
    }
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
        paymentProviderKey: provider.providerKey,
        idempotencyKey: input.idempotencyKey,
        productTypeSnapshot: product.productType,
        chargingModeSnapshot: product.chargingMode,
        pricingVersionSnapshot: product.pricingVersion,
        refundPolicySnapshot: product.refundPolicy,
        priorityWeightSnapshot: product.priorityWeight,
        taxPolicyVersion: product.taxPolicyVersion,
        startsAt: now,
        expiresAt: new Date(now.getTime() + product.durationDays * DAY_MS),
      })
      .returning();
    return { row: row as PromotionRow, created: true };
  });

  let row = reserved.row;
  if (row.status !== "PENDING_PAYMENT") {
    const promotion = (await promotionViews([row], input.market))[0]!;
    throw Object.assign(fail(409, "هذا الطلب لم يعد بانتظار الدفع", "PROVIDER_PROMOTION_NOT_PENDING"), { promotion });
  }
  const activeProvider = getPromotionBillingProvider(row.paymentProviderKey ?? provider.providerKey) ?? provider;
  let checkoutUrl: string;
  if (row.paymentReference) {
    checkoutUrl = await activeProvider.promotionCheckoutUrl(row.paymentReference);
  } else {
    let checkout: { checkoutId: string; checkoutUrl: string };
    try {
      checkout = await activeProvider.createPromotionCheckout({
        promotionId: row.id,
        userId: input.actorId,
        currencyCode: row.currencyCodeSnapshot,
        priceMinor: row.priceMinorSnapshot,
        scale: input.market.minorUnitScale,
        productRef: row.productId,
        title: row.productNameSnapshot,
      });
    } catch (error) {
      if (reserved.created) {
        await db
          .update(listingPromotions)
          .set({ status: "CANCELLED", endedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(listingPromotions.id, row.id), eq(listingPromotions.status, "PENDING_PAYMENT")));
      }
      throw error;
    }
    const [updated] = await db
      .update(listingPromotions)
      .set({
        paymentProviderKey: activeProvider.providerKey,
        paymentReference: checkout.checkoutId,
        updatedAt: new Date(),
      })
      .where(eq(listingPromotions.id, row.id))
      .returning();
    row = updated as PromotionRow;
    checkoutUrl = checkout.checkoutUrl;
  }

  logger.info(
    { event: "provider_promotion_checkout", providerKey: activeProvider.providerKey, marketId: input.market.id, created: reserved.created },
    "promotion checkout opened",
  );
  return {
    created: reserved.created,
    providerKey: activeProvider.providerKey,
    providerDisplayName: activeProvider.displayName,
    promotion: (await promotionViews([row], input.market))[0]!,
    checkoutUrl,
    amountLabel: `${formatMinor(row.priceMinorSnapshot, input.market.minorUnitScale)} ${row.currencyCodeSnapshot}`,
    note: `الدفع في صفحة ${activeProvider.displayName} الآمنة. يبدأ الترويج ${row.durationDaysSnapshot} ${row.durationDaysSnapshot === 1 ? "يومًا" : "أيام"} فقط بعد أن يؤكد ${activeProvider.displayName} الدفع، دون تجديد تلقائي.`,
  };
}

/**
 * Applies one verified canonical promotion billing event to its campaign.
 * Deduplicated by `(providerKey, eventId)` in `billing_webhook_events` in the same transaction.
 */
export async function applyPromotionBillingEvent(
  providerKey: string,
  event: PromotionBillingEvent,
): Promise<PromotionWebhookResult> {
  let demandMatch: { id: string; marketId: string } | undefined;
  const result = await db.transaction(async (tx) => {
    const record = async (status: "APPLIED" | "IGNORED" | "REJECTED", failureCode: string | null) => {
      const [inserted] = await tx
        .insert(billingWebhookEvents)
        .values({
          id: randomUUID(),
          providerKey,
          providerEventId: event.eventId,
          eventType: event.eventType.slice(0, 80),
          payloadDigest: event.digest,
          status,
          failureCode,
          processedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      return inserted;
    };
    const done = async (
      status: "APPLIED" | "IGNORED" | "REJECTED",
      failureCode: string | null,
      apply?: () => Promise<void>,
    ): Promise<PromotionWebhookResult> => {
      const inserted = await record(status, failureCode);
      if (!inserted) return { status: 200, outcome: status, failureCode, duplicate: true };
      if (apply) await apply();
      if (status !== "APPLIED") {
        logger.warn({ event: "provider_promotion_event", providerKey, type: event.type, failureCode }, "promotion payment event recorded for review");
      }
      return { status: 200, outcome: status, failureCode, duplicate: false };
    };

    const [row] = (await tx
      .select()
      .from(listingPromotions)
      .where(eq(listingPromotions.id, event.promotionId))
      .for("update")) as PromotionRow[];
    if (
      !row ||
      row.paymentSource !== "PROVIDER_DIRECT" ||
      row.paymentMode !== "PROVIDER_LIVE" ||
      (row.paymentProviderKey && row.paymentProviderKey !== providerKey)
    ) {
      return done("REJECTED", "UNKNOWN_PROMOTION");
    }
    if (event.accountMismatch) return done("REJECTED", "ACCOUNT_MISMATCH");
    if (event.sellerId !== row.sellerId) return done("REJECTED", "OWNER_MISMATCH");
    const now = new Date();

    if (event.type === "PAID") {
      if (event.providerPaymentStatus !== "paid") return done("IGNORED", "PROVIDER_STATE_NOT_PAID");
      if (
        !event.currencyCode ||
        event.currencyCode.toUpperCase() !== row.currencyCodeSnapshot ||
        event.amountMinor !== row.priceMinorSnapshot
      ) {
        return done("REJECTED", "AMOUNT_MISMATCH_REVIEW");
      }
      if (row.paymentStatus === "PROVIDER_PAID") return done("IGNORED", "ALREADY_PAID_SECOND_PAYMENT_REVIEW");
      if (row.paymentStatus === "PROVIDER_DISPUTED" || row.paymentStatus === "PROVIDER_REFUNDED") {
        return done("IGNORED", "ALREADY_SETTLED_PAYMENT_REVIEW");
      }
      if (row.status !== "PENDING_PAYMENT") return done("REJECTED", "PAID_AFTER_CANCEL_REFUND_REVIEW");
      return done("APPLIED", null, async () => {
        await tx
          .update(listingPromotions)
          .set({
            status: "ACTIVE",
            paymentStatus: "PROVIDER_PAID",
            startsAt: now,
            expiresAt: new Date(now.getTime() + row.durationDaysSnapshot * DAY_MS),
            updatedAt: now,
          })
          .where(eq(listingPromotions.id, row.id));
        if (row.placementSnapshot === "DEMAND") demandMatch = { id: row.id, marketId: row.marketId };
        logger.info({ event: "provider_promotion_activated", providerKey, marketId: row.marketId }, "promotion activated from verified provider payment");
      });
    }

    if (event.type === "FAILED") {
      if (event.providerPaymentStatus === "paid") return done("IGNORED", "PROVIDER_STATE_PAID");
      return done("IGNORED", "ATTEMPT_FAILED_RETRY_ALLOWED");
    }

    if (event.type === "REFUNDED") {
      if (!event.refundedMinor || !event.totalMinor) return done("REJECTED", "AMOUNT_MISMATCH_REVIEW");
      if (event.refundedMinor < event.totalMinor) return done("IGNORED", "PARTIAL_REFUND_FOR_REVIEW");
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

    // DISPUTED
    if (row.paymentStatus === "PROVIDER_PENDING" && row.status === "PENDING_PAYMENT") {
      return done("APPLIED", null, async () => {
        await tx
          .update(listingPromotions)
          .set({ paymentStatus: "PROVIDER_DISPUTED", status: "CANCELLED", endedAt: now, updatedAt: now })
          .where(eq(listingPromotions.id, row.id));
      });
    }
    if (row.paymentStatus !== "PROVIDER_PAID") return done("IGNORED", "DISPUTE_RECORDED_FOR_REVIEW");
    return done("APPLIED", null, async () => {
      await tx
        .update(listingPromotions)
        .set({
          paymentStatus: "PROVIDER_DISPUTED",
          ...(row.status === "ACTIVE" ? { status: "PAUSED", pausedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(listingPromotions.id, row.id));
    });
  });

  if (demandMatch) {
    const { matchDemandCampaign } = await import("./demand-requests");
    const { resolveMarket } = await import("./markets");
    const [marketRow] = await db.select().from(markets).where(eq(markets.id, demandMatch.marketId));
    const market = marketRow ? await resolveMarket(marketRow).catch(() => undefined) : undefined;
    if (market) {
      await matchDemandCampaign(demandMatch.id, market).catch((error) =>
        logger.warn({ event: "demand_match_failed", err: error }, "demand match failed"),
      );
    }
  }
  return result;
}

/** Generic signed webhook handler for any registered PromotionBillingProvider. */
export async function receivePromotionProviderWebhook(
  providerKey: string,
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  nowSeconds?: number,
): Promise<PromotionWebhookResult> {
  const provider = getPromotionBillingProvider(providerKey);
  if (!provider || !provider.verifyAndParseWebhook) {
    return { status: 503, outcome: "REJECTED", failureCode: "PROVIDER_NOT_CONNECTED" };
  }
  const parsed = await provider.verifyAndParseWebhook(raw, headers, nowSeconds);
  if (!parsed.ok) return parsed.result;
  return applyPromotionBillingEvent(provider.providerKey, parsed.event);
}

/**
 * Whether a commercial purchase in the conversation is paid through a registered provider instead
 * of the test balance: a direct fixed-price listing product, not a bundle unit, and every gate open.
 */
export async function providerDirectApplies(input: {
  market: Market;
  productId: string;
  paymentSource?: string;
}): Promise<{ applies: true; provider: PromotionBillingProvider } | { applies: false }> {
  if (input.paymentSource === "BUNDLE_ENTITLEMENT") return { applies: false };
  const availability = await promotionBillingAvailability(input.market);
  if (!availability.available) return { applies: false };
  const product = await effectiveProduct(input.market, input.productId).catch(() => undefined);
  if (!product || !directProduct(product)) return { applies: false };
  return { applies: true, provider: availability.provider };
}

export function providerPromotionReviewNote(provider: Pick<PromotionBillingProvider, "displayName">): string {
  return `دفع حقيقي عبر صفحة ${provider.displayName} الآمنة بعملة سوقك. لا يُخصم شيء عند «تأكيد»؛ يبدأ الترويج فقط بعد تأكيد ${provider.displayName} الموقّع للدفع، دون تجديد تلقائي.`;
}
