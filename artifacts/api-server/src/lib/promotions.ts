/**
 * Listing promotion authority (Block E). REST routes and the conversation adapter both
 * go through these functions; nothing else creates, activates or changes a campaign.
 *
 * - The seller is always the authenticated actor and the market their active market.
 * - Price, currency, duration and placement come only from the admin plan and are
 *   snapshotted on the campaign; later plan edits never rewrite an accepted campaign.
 * - Activation needs a captured simulated payment from the Wave 4 test adapter,
 *   verified by its signature and provider snapshot. A client can never report payment.
 * - Serving is evaluated on read (status, payment and time window), so an expired or
 *   paused row never boosts a listing even when no sweeper has run.
 * - A promotion is not an order: it never creates orders, commission, dues or delivery.
 *
 * Disabled plans: no new purchases; campaigns already bought keep their own window.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  commercialAccounts,
  commercialEntitlements,
  commercialLedger,
  db,
  listingPromotions,
  marketAudit,
  markets,
  offers,
  promotionAttributions,
  promotionProducts,
  users,
} from "@workspace/db";
import {
  balanceView,
  chargeAvailable,
  creditSplit,
  getCommercialBalance,
  insufficient,
  lockedAccount,
  post,
  type CommercialBalanceView,
  type LedgerPosting,
} from "./commercial-ledger";
import { getCommercialPolicy, scaleOfCurrency, type CommercialPolicy } from "./commercial-policy";
import { needCoverage } from "./demand-normalization";
import { logger } from "./logger";
import { resolveMarket, type marketFor } from "./markets";
import {
  categoryIsRestricted,
  listMarketplaceCategories,
  resolveMarketplaceCategory,
} from "./marketplace-categories";
import { activePolicyRules, offerPolicyViolation } from "./publication-policy";
import {
  campaignPaymentServes,
  isPromotionFeatureEnabled,
  isPromotionSimulationEnabled,
  isSponsoredServingEnabled,
  servingPaymentModes,
} from "./promotion-policy";
import { testOnlyPaymentAdapter } from "./payments/test-adapter";
import { DEFAULT_COMMERCIAL_POLICY } from "./commercial-policy";

type Market = Awaited<ReturnType<typeof marketFor>>;
type PromotionRow = typeof listingPromotions.$inferSelect;
type OfferRowData = typeof offers.$inferSelect;
type ProductRow = typeof promotionProducts.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
export const PROMOTION_PLACEMENT = "SEARCH_AND_CHAT" as const;
/**
 * Base (policy version 0) paid slots per result page; the effective values come from the
 * versioned commercial policy. Organic results always keep the rest.
 */
export const MAX_SPONSORED_SEARCH_SLOTS = DEFAULT_COMMERCIAL_POLICY.searchSponsoredSlots;
export const MAX_SPONSORED_RECOMMENDATION_SLOTS = DEFAULT_COMMERCIAL_POLICY.recommendationSponsoredSlots;
export const SPONSORED_LABEL = "إعلان ممول";

/** Where each paid placement may appear. Demand capture serves only demand rescue. */
export const SEARCH_PLACEMENTS = ["SEARCH_AND_CHAT", "FEATURED", "VIP", "REFRESH", "SPONSORED_SEARCH"] as const;
export const RECOMMENDATION_PLACEMENTS = ["SEARCH_AND_CHAT", "FEATURED", "VIP", "SPONSORED_RECOMMENDATION"] as const;
export const DEMAND_PLACEMENTS = ["DEMAND"] as const;
/** Payment outcomes that may serve: a verified simulated capture, a commercial-balance charge or a bundle unit. */
export const SERVING_PAYMENT_STATUSES = ["SIMULATION_CAPTURED", "BALANCE_CHARGED", "ENTITLEMENT_CONSUMED", "PROVIDER_PAID"] as const;

export const LIVE_STATUSES = ["PENDING_PAYMENT", "ACTIVE", "PAUSED"] as const;

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export function assertPromotionsAvailable() {
  if (!isPromotionFeatureEnabled())
    throw fail(503, "عروض الترويج غير مفعلة في هذه البيئة");
}

function assertSimulationAvailable() {
  assertPromotionsAvailable();
  if (!isPromotionSimulationEnabled())
    throw fail(403, "تفعيل الترويج المحاكى متاح في بيئة التطوير والاختبار فقط");
}

/** The one serving rule. Status alone never serves; time is checked on every read. */
export function isServingCampaign(
  campaign: Pick<PromotionRow, "status" | "paymentStatus" | "paymentMode" | "startsAt" | "expiresAt"> &
    Partial<Pick<PromotionRow, "budgetMinor" | "spentMinor" | "releasedMinor" | "unitChargeMinorSnapshot">>,
  now: Date,
): boolean {
  return (
    campaign.status === "ACTIVE" &&
    (SERVING_PAYMENT_STATUSES as readonly string[]).includes(campaign.paymentStatus) &&
    campaignPaymentServes(campaign) &&
    campaign.startsAt.getTime() <= now.getTime() &&
    campaign.expiresAt.getTime() > now.getTime() &&
    hasBudgetForOneCharge(campaign)
  );
}

/** A budget campaign competes only while its remaining reserve covers one more charge. */
export function hasBudgetForOneCharge(
  campaign: Partial<Pick<PromotionRow, "budgetMinor" | "spentMinor" | "releasedMinor" | "unitChargeMinorSnapshot">>,
): boolean {
  if (campaign.budgetMinor == null) return true;
  const remaining = campaign.budgetMinor - (campaign.spentMinor ?? 0) - (campaign.releasedMinor ?? 0);
  return remaining >= (campaign.unitChargeMinorSnapshot ?? Number.POSITIVE_INFINITY);
}

/** Lifecycle as the seller sees it: a time-expired live row reads as EXPIRED. */
export function effectivePromotionStatus(row: PromotionRow, now: Date): string {
  if ((row.status === "ACTIVE" || row.status === "PAUSED") && row.expiresAt.getTime() <= now.getTime())
    return "EXPIRED";
  if (row.status === "ACTIVE" && row.startsAt.getTime() > now.getTime()) return "SCHEDULED";
  return row.status;
}

/** Campaigns that may boost these listings right now (payment, status, window, budget). */
export async function servingCampaignsFor(
  marketId: string,
  listingIds: string[],
  now = new Date(),
  placements: readonly string[] = SEARCH_PLACEMENTS,
): Promise<PromotionRow[]> {
  if (!listingIds.length || !isSponsoredServingEnabled()) return [];
  const rows: PromotionRow[] = await db
    .select()
    .from(listingPromotions)
    .where(
      and(
        eq(listingPromotions.marketId, marketId),
        eq(listingPromotions.status, "ACTIVE"),
        inArray(listingPromotions.paymentStatus, [...SERVING_PAYMENT_STATUSES]),
        inArray(listingPromotions.paymentMode, servingPaymentModes()),
        inArray(listingPromotions.placementSnapshot, [...placements]),
        lte(listingPromotions.startsAt, now),
        gt(listingPromotions.expiresAt, now),
        inArray(listingPromotions.listingId, listingIds),
      ),
    );
  return rows.filter((row) => hasBudgetForOneCharge(row));
}

// ─── Sponsored score ─────────────────────────────────────────────────────────

/**
 * Deterministic paid ranking among candidates that already passed every hard gate:
 * SponsoredScore = Relevance × CommercialWeight × QualityWeight.
 * - Relevance comes from the canonical organic order (the user's need dominates).
 * - CommercialWeight: the product's priority (VIP > standard) and, for budget campaigns,
 *   a bounded bid factor. Money can reorder eligible paid candidates, never add one.
 * - QualityWeight: only deterministic listing facts, kept in a narrow band so it breaks
 *   ties without overturning relevance.
 */
export function sponsoredScore(input: {
  organicIndex: number;
  priorityWeight: number;
  unitChargeMinor?: number | null;
  minorUnitScale: number;
  hasImage: boolean;
  descriptionLength: number;
}): number {
  const relevance = 1 / (1 + 0.05 * Math.max(0, input.organicIndex));
  const priority = Math.min(3, Math.max(1, input.priorityWeight / 100));
  const bidMajor = input.unitChargeMinor ? input.unitChargeMinor / 10 ** input.minorUnitScale : 0;
  const bid = 1 + Math.min(1, bidMajor) * 0.25;
  const quality = 0.98 + (input.hasImage ? 0.01 : 0) + (input.descriptionLength >= 30 ? 0.01 : 0);
  return relevance * priority * bid * quality;
}

/** Orders eligible candidates by score, then a stable id tie-break; caps to `slots`. */
export function rankSponsored<T extends { id: string; score: number }>(candidates: T[], slots: number): T[] {
  return [...candidates].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.max(0, slots));
}

/** For one listing, the serving campaign that represents it (highest priority, newest). */
export function representativeCampaign(campaigns: PromotionRow[], listingId: string): PromotionRow | undefined {
  return campaigns
    .filter((campaign) => campaign.listingId === listingId)
    .sort((a, b) => b.priorityWeightSnapshot - a.priorityWeightSnapshot || b.startsAt.getTime() - a.startsAt.getTime() || a.id.localeCompare(b.id))[0];
}

// ─── Eligibility ─────────────────────────────────────────────────────────────

export type PromotionEligibility =
  | { ok: true; categoryId: string }
  | { ok: false; reason: string };

/** Same public-visibility gates as organic search: payment never bypasses any of them. */
export async function listingPromotionEligibility(
  offer: OfferRowData,
  sellerStatus: string,
  market: Market,
  tx: any = db,
): Promise<PromotionEligibility> {
  if (offer.marketId !== market.id) return { ok: false, reason: "العرض ليس في سوقك الحالي" };
  if (sellerStatus !== "ACTIVE") return { ok: false, reason: "حساب البائع غير نشط حاليًا" };
  if (offer.status !== "PUBLISHED")
    return { ok: false, reason: "يجب أن يكون العرض منشورًا للترويج له" };
  if (
    offer.inventoryMode === "LIMITED" &&
    (offer.availableQuantity ?? 0) - offer.reservedQuantity <= 0
  )
    return { ok: false, reason: "العرض غير متوفر حاليًا" };
  const category = await resolveMarketplaceCategory(
    typeof offer.data.categoryId === "string" ? offer.data.categoryId : undefined,
    typeof offer.data.category === "string" ? offer.data.category : undefined,
    tx,
  );
  if (!category || categoryIsRestricted(market, category))
    return { ok: false, reason: "لا يمكن ترويج عرض هذا التصنيف في السوق" };
  const [rules, categories] = await Promise.all([
    activePolicyRules(market.id),
    listMarketplaceCategories(true),
  ]);
  if (offerPolicyViolation(rules, offer, new Map(categories.map((row) => [row.id, row]))))
    return { ok: false, reason: "العرض لا يطابق سياسات السوق الحالية" };
  return { ok: true, categoryId: category.id };
}

export async function ownedOffer(actorId: string, market: Market, listingId: string, tx: any = db, lock = false) {
  const query = tx
    .select({ offer: offers, sellerStatus: users.status })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(and(eq(offers.id, listingId), eq(offers.sellerId, actorId), eq(offers.marketId, market.id)))
    .limit(1);
  const [row] = lock ? await query.for("update", { of: offers }) : await query;
  if (!row) throw fail(404, "العرض غير موجود");
  return row as { offer: OfferRowData; sellerStatus: string };
}

async function enabledPlansFor(market: Market, categoryId: string, tx: any = db): Promise<ProductRow[]> {
  const rows: ProductRow[] = await tx
    .select()
    .from(promotionProducts)
    .where(
      and(
        eq(promotionProducts.marketId, market.id),
        eq(promotionProducts.enabled, true),
        eq(promotionProducts.categoryId, categoryId),
        eq(promotionProducts.placement, PROMOTION_PLACEMENT),
      ),
    )
    .orderBy(asc(promotionProducts.durationDays), asc(promotionProducts.priceMinor), asc(promotionProducts.id));
  return rows.filter((plan) => plan.currencyCode === market.currencyCode);
}

/** Time-expired live rows become EXPIRED (history kept). Correctness never depends on it. */
export async function expireStalePromotions(input: { listingId?: string; sellerId?: string; tx?: any } = {}) {
  const run = async (tx: any) => {
    const rows = await tx
      .update(listingPromotions)
      .set({ status: "EXPIRED", endedAt: sql`${listingPromotions.expiresAt}`, updatedAt: new Date() })
      .where(
        and(
          inArray(listingPromotions.status, ["ACTIVE", "PAUSED"]),
          lte(listingPromotions.expiresAt, new Date()),
          ...(input.listingId ? [eq(listingPromotions.listingId, input.listingId)] : []),
          ...(input.sellerId ? [eq(listingPromotions.sellerId, input.sellerId)] : []),
        ),
      )
      .returning({ id: listingPromotions.id, budgetMinor: listingPromotions.budgetMinor });
    // An expired budget campaign returns its unused reserve (or forfeits it, per policy).
    for (const row of rows as { id: string; budgetMinor: number | null }[])
      if (row.budgetMinor != null) await releaseCampaignBudget(tx, row.id);
    return rows.length as number;
  };
  return input.tx ? run(input.tx) : db.transaction(run);
}

async function liveCampaignFor(listingId: string, tx: any = db): Promise<PromotionRow | undefined> {
  const [row] = await tx
    .select()
    .from(listingPromotions)
    .where(
      and(
        eq(listingPromotions.listingId, listingId),
        eq(listingPromotions.placementSnapshot, PROMOTION_PLACEMENT),
        inArray(listingPromotions.status, [...LIVE_STATUSES]),
      ),
    )
    .limit(1);
  return row;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function formatMinor(minor: number, scale: number) {
  const digits = String(minor).padStart(scale + 1, "0");
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export type PromotionPlanView = {
  id: string;
  name: string;
  placement: string;
  durationDays: number;
  priceMinor: number;
  currencyCode: string;
  priceLabel: string;
};

export function planView(plan: ProductRow, market: Market): PromotionPlanView {
  return {
    id: plan.id,
    name: plan.name,
    placement: plan.placement,
    durationDays: plan.durationDays,
    priceMinor: plan.priceMinor,
    currencyCode: plan.currencyCode,
    priceLabel: `${formatMinor(plan.priceMinor, market.minorUnitScale)} ${plan.currencyCode}`,
  };
}

export type SellerPromotionView = {
  id: string;
  listingId: string;
  listingTitle: string;
  productName: string;
  placement: string;
  placementLabel: string;
  durationDays: number;
  priceMinor: number;
  currencyCode: string;
  priceLabel: string;
  status: string;
  effectiveStatus: string;
  paymentStatus: string;
  /** PROVIDER_LIVE: a real payment through the collection provider; otherwise no money moves. */
  paymentMode: "TEST_NO_TRANSFER" | "PROVIDER_LIVE";
  serving: boolean;
  servingNote: string;
  startsAt: string;
  expiresAt: string;
  createdAt: string;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  autoRenew: false;
  productType: string;
  productTypeLabel: string;
  tier: "VIP" | "STANDARD";
  paymentSource: string;
  chargingMode: string;
  budgetLabel?: string;
  spentLabel?: string;
  remainingLabel?: string;
  unitChargeLabel?: string;
};

export const PLACEMENT_LABELS: Record<string, string> = {
  SEARCH_AND_CHAT: "نتائج البحث والمحادثة (مع شارة «إعلان ممول»)",
  FEATURED: "خانات الظهور الممول في البحث والاقتراحات (مع شارة «ممول»)",
  VIP: "أولوية ضمن الخانات الممولة المؤهلة (شارتا «VIP» و«ممول»)",
  REFRESH: "ظهور ممول مؤقت بعد التجديد؛ تاريخ النشر الأصلي لا يتغير",
  SPONSORED_SEARCH: "خانات البحث الممولة عند تطابق البحث",
  SPONSORED_RECOMMENDATION: "خانة اقتراح ممولة عند تطابق الطلب",
  DEMAND: "خيار ممول عند طلب حقيقي غير مُلبّى يطابق إعلانك",
};

const STATUS_NOTES: Record<string, string> = {
  PENDING_PAYMENT: "بانتظار نتيجة الدفع التجريبي",
  SCHEDULED: "مجدول ولم يبدأ بعد",
  PAUSED: "موقوف مؤقتًا — لا يظهر كإعلان ممول",
  EXPIRED: "انتهت المدة — لا تجديد تلقائي",
  CANCELLED: "ملغى — لا يظهر كإعلان ممول",
  PAYMENT_FAILED: "فشل الدفع التجريبي — لم يُفعّل الترويج",
  BUDGET_EXHAUSTED: "نفدت الميزانية — توقف الظهور الممول",
};

const PROVIDER_STATUS_NOTES: Record<string, string> = {
  PENDING_PAYMENT: "بانتظار إتمام الدفع في صفحة مزود الدفع — لا يبدأ قبل تأكيده الموقّع",
  PAUSED: "موقوف — الدفع عليه نزاع قيد المراجعة أو أوقفته أنت",
  CANCELLED: "ملغى — لا يظهر كإعلان ممول",
  PAYMENT_FAILED: "لم يكتمل الدفع — لم يُفعّل الترويج",
};

export async function promotionViews(rows: PromotionRow[], market: Market, now = new Date()): Promise<SellerPromotionView[]> {
  if (!rows.length) return [];
  const listingRows: { offer: OfferRowData; sellerStatus: string }[] = await db
    .select({ offer: offers, sellerStatus: users.status })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(inArray(offers.id, [...new Set(rows.map((row) => row.listingId))]));
  const byId = new Map(listingRows.map((row) => [row.offer.id, row]));
  const eligibility = new Map<string, PromotionEligibility>();
  for (const row of listingRows)
    eligibility.set(row.offer.id, await listingPromotionEligibility(row.offer, row.sellerStatus, market));
  return rows.map((row) => {
    const listing = byId.get(row.listingId);
    const effectiveStatus = effectivePromotionStatus(row, now);
    const listingOk = eligibility.get(row.listingId);
    const serving = isServingCampaign(row, now) && listingOk?.ok === true;
    const servingNote =
      effectiveStatus === "ACTIVE"
        ? serving
          ? "يظهر الآن مع شارة «إعلان ممول» عندما يطابق بحث المشتري"
          : `لا يظهر حاليًا: ${listingOk && !listingOk.ok ? listingOk.reason : "العرض غير متاح"}`
        : row.paymentMode === "PROVIDER_LIVE" && effectiveStatus === "CANCELLED" && row.paymentStatus === "PROVIDER_PAID"
          ? "وصل دفعك، لكن الإعلان لم يعد متاحًا فلم يبدأ الترويج. سُجّل الطلب لمراجعة الاسترداد."
        : row.paymentMode === "PROVIDER_LIVE" && PROVIDER_STATUS_NOTES[effectiveStatus]
          ? PROVIDER_STATUS_NOTES[effectiveStatus]!
          : STATUS_NOTES[effectiveStatus] ?? effectiveStatus;
    const live = effectiveStatus === "ACTIVE" || effectiveStatus === "PAUSED" || effectiveStatus === "SCHEDULED";
    return {
      id: row.id,
      listingId: row.listingId,
      listingTitle: typeof listing?.offer.data.title === "string" ? listing.offer.data.title : "إعلان",
      productName: row.productNameSnapshot,
      placement: row.placementSnapshot,
      placementLabel: PLACEMENT_LABELS[row.placementSnapshot] ?? row.placementSnapshot,
      durationDays: row.durationDaysSnapshot,
      priceMinor: row.priceMinorSnapshot,
      currencyCode: row.currencyCodeSnapshot,
      priceLabel: `${formatMinor(row.priceMinorSnapshot, market.minorUnitScale)} ${row.currencyCodeSnapshot}`,
      status: row.status,
      effectiveStatus,
      paymentStatus: row.paymentStatus,
      paymentMode: row.paymentMode === "PROVIDER_LIVE" ? "PROVIDER_LIVE" : "TEST_NO_TRANSFER",
      serving,
      servingNote,
      startsAt: row.startsAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      canPause: effectiveStatus === "ACTIVE",
      canResume: effectiveStatus === "PAUSED",
      canCancel: live || effectiveStatus === "PENDING_PAYMENT",
      autoRenew: false,
      productType: row.productTypeSnapshot,
      productTypeLabel: PRODUCT_TYPE_LABELS[row.productTypeSnapshot] ?? row.productTypeSnapshot,
      tier: row.placementSnapshot === "VIP" ? "VIP" : "STANDARD",
      paymentSource: row.paymentSource,
      chargingMode: row.chargingModeSnapshot,
      ...(row.budgetMinor != null
        ? {
            budgetLabel: `${formatMinor(row.budgetMinor, market.minorUnitScale)} ${row.currencyCodeSnapshot}`,
            spentLabel: `${formatMinor(row.spentMinor, market.minorUnitScale)} ${row.currencyCodeSnapshot}`,
            remainingLabel: `${formatMinor(row.budgetMinor - row.spentMinor - row.releasedMinor, market.minorUnitScale)} ${row.currencyCodeSnapshot}`,
            ...(row.unitChargeMinorSnapshot ? { unitChargeLabel: `${formatMinor(row.unitChargeMinorSnapshot, market.minorUnitScale)} ${row.currencyCodeSnapshot}` } : {}),
          }
        : {}),
    };
  });
}

// ─── Seller reads ────────────────────────────────────────────────────────────

/** Owned listings that may be promoted now, in the seller's active market. */
export async function promotableListings(actorId: string, market: Market) {
  assertPromotionsAvailable();
  const rows: { offer: OfferRowData; sellerStatus: string }[] = await db
    .select({ offer: offers, sellerStatus: users.status })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(and(eq(offers.sellerId, actorId), eq(offers.marketId, market.id), eq(offers.status, "PUBLISHED")))
    .orderBy(desc(offers.createdAt), asc(offers.id))
    .limit(24);
  const result: { id: string; title: string; categoryId: string; hasLivePromotion: boolean }[] = [];
  for (const row of rows) {
    const eligible = await listingPromotionEligibility(row.offer, row.sellerStatus, market);
    if (!eligible.ok) continue;
    const live = await liveCampaignFor(row.offer.id);
    const liveNow = live && effectivePromotionStatus(live, new Date()) !== "EXPIRED";
    result.push({
      id: row.offer.id,
      title: typeof row.offer.data.title === "string" ? row.offer.data.title : "إعلان",
      categoryId: eligible.categoryId,
      hasLivePromotion: Boolean(liveNow),
    });
  }
  return result;
}

export async function promotionPlansForListing(actorId: string, market: Market, listingId: string) {
  assertPromotionsAvailable();
  const { offer, sellerStatus } = await ownedOffer(actorId, market, listingId);
  const eligible = await listingPromotionEligibility(offer, sellerStatus, market);
  if (!eligible.ok) throw fail(409, eligible.reason);
  const plans = await enabledPlansFor(market, eligible.categoryId);
  return {
    listing: { id: offer.id, title: typeof offer.data.title === "string" ? offer.data.title : "إعلان" },
    plans: plans.map((plan) => planView(plan, market)),
  };
}

export async function listSellerPromotions(actorId: string, market: Market) {
  assertPromotionsAvailable();
  const rows: PromotionRow[] = await db
    .select()
    .from(listingPromotions)
    .where(and(eq(listingPromotions.sellerId, actorId), eq(listingPromotions.marketId, market.id)))
    .orderBy(desc(listingPromotions.createdAt), asc(listingPromotions.id))
    .limit(24);
  return promotionViews(rows, market);
}

/** Owner and active market only; anything else is indistinguishable from "not found". */
export async function getSellerPromotion(actorId: string, market: Market, promotionId: string) {
  assertPromotionsAvailable();
  const [row] = await db
    .select()
    .from(listingPromotions)
    .where(
      and(
        eq(listingPromotions.id, promotionId),
        eq(listingPromotions.sellerId, actorId),
        eq(listingPromotions.marketId, market.id),
      ),
    )
    .limit(1);
  if (!row) throw fail(404, "الحملة غير موجودة");
  return (await promotionViews([row], market))[0]!;
}

// ─── Review and purchase ─────────────────────────────────────────────────────

export type PromotionReview = {
  listingId: string;
  categoryId: string;
  listingTitle: string;
  plan: PromotionPlanView;
  placementLabel: string;
  sponsoredLabel: string;
  startNote: string;
  endNote: string;
  paymentMode: "TEST_NO_TRANSFER";
  autoRenew: false;
};

/** What the seller is about to accept, built only from server state. Changes nothing. */
export async function reviewPromotion(input: {
  actorId: string;
  market: Market;
  listingId: string;
  productId: string;
}): Promise<PromotionReview> {
  assertPromotionsAvailable();
  const { offer, sellerStatus } = await ownedOffer(input.actorId, input.market, input.listingId);
  const eligible = await listingPromotionEligibility(offer, sellerStatus, input.market);
  if (!eligible.ok) throw fail(409, eligible.reason);
  const plan = (await enabledPlansFor(input.market, eligible.categoryId)).find(
    (row) => row.id === input.productId,
  );
  if (!plan) throw fail(404, "خطة الترويج غير متاحة لهذا العرض والسوق");
  const live = await liveCampaignFor(offer.id);
  if (live && effectivePromotionStatus(live, new Date()) !== "EXPIRED")
    throw fail(409, "لدى العرض ترويج قائم بالفعل");
  return {
    listingId: offer.id,
    categoryId: eligible.categoryId,
    listingTitle: typeof offer.data.title === "string" ? offer.data.title : "إعلان",
    plan: planView(plan, input.market),
    placementLabel: PLACEMENT_LABELS[plan.placement] ?? plan.placement,
    sponsoredLabel: SPONSORED_LABEL,
    startNote: "يبدأ فور نجاح الدفع التجريبي",
    endNote: `ينتهي تلقائيًا بعد ${plan.durationDays} ${plan.durationDays === 1 ? "يوم" : "أيام"} من البدء، دون تجديد تلقائي`,
    paymentMode: "TEST_NO_TRANSFER",
    autoRenew: false,
  };
}

export type PurchaseOutcome = {
  created: boolean;
  promotion: SellerPromotionView;
};

/**
 * Buys one campaign through the simulated payment authority. Retries with the same
 * idempotency key return the same campaign and never create a second intent.
 * `simulateDecline` is the test-card equivalent: it can only make a payment fail.
 */
export async function purchasePromotion(input: {
  actorId: string;
  market: Market;
  listingId: string;
  productId: string;
  idempotencyKey: string;
  simulateDecline?: boolean;
}): Promise<PurchaseOutcome> {
  assertSimulationAvailable();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey))
    throw fail(400, "مفتاح عدم التكرار غير صالح");
  const existing = await campaignByKey(input.actorId, input.idempotencyKey);
  if (existing) return replay(existing, input);

  let created: PromotionRow | undefined;
  let prior: PromotionRow | undefined;
  try {
    created = await db.transaction(async (tx) => {
      const { offer, sellerStatus } = await ownedOffer(input.actorId, input.market, input.listingId, tx, true);
      // Concurrent confirmations queue on the listing lock; the later one replays.
      prior = await campaignByKey(input.actorId, input.idempotencyKey, tx);
      if (prior) return undefined;
      const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId)).for("share");
      if (actor?.status !== "ACTIVE")
        throw fail(403, "حسابك مقيّد حاليًا ولا يمكن شراء ترويج جديد.");
      const eligible = await listingPromotionEligibility(offer, sellerStatus, input.market, tx);
      if (!eligible.ok) throw fail(409, eligible.reason);
      const plan = (await enabledPlansFor(input.market, eligible.categoryId, tx)).find(
        (row) => row.id === input.productId,
      );
      if (!plan) throw fail(404, "خطة الترويج غير متاحة لهذا العرض والسوق");
      await expireStalePromotions({ listingId: offer.id, tx });
      if (await liveCampaignFor(offer.id, tx)) throw fail(409, "لدى العرض ترويج قائم بالفعل");
      const now = new Date();
      const [row] = await tx
        .insert(listingPromotions)
        .values({
          id: randomUUID(),
          listingId: offer.id,
          sellerId: input.actorId,
          marketId: input.market.id,
          productId: plan.id,
          productNameSnapshot: plan.name,
          categoryIdSnapshot: eligible.categoryId,
          priceMinorSnapshot: plan.priceMinor,
          currencyCodeSnapshot: plan.currencyCode,
          placementSnapshot: plan.placement,
          durationDaysSnapshot: plan.durationDays,
          status: "PENDING_PAYMENT",
          paymentStatus: "SIMULATION_PENDING",
          paymentMode: "DEVELOPMENT_SIMULATED",
          paymentProviderKey: testOnlyPaymentAdapter.providerKey,
          paymentReference: testOnlyPaymentAdapter.allocateIntentReference(),
          idempotencyKey: input.idempotencyKey,
          // Provisional window; activation sets the real one from the capture time.
          startsAt: now,
          expiresAt: new Date(now.getTime() + plan.durationDays * DAY_MS),
        })
        .returning();
      return row as PromotionRow;
    });
    if (prior) return replay(prior, input);
  } catch (error) {
    // A concurrent request with the same key won the insert; answer with its campaign.
    if ((error as { code?: string; cause?: { code?: string } }).code === "23505" ||
        (error as { cause?: { code?: string } }).cause?.code === "23505") {
      const raced = await campaignByKey(input.actorId, input.idempotencyKey);
      if (raced) return replay(raced, input);
      throw fail(409, "لدى العرض ترويج قائم بالفعل");
    }
    throw error;
  }
  const settled = await settlePromotionPayment(created!.id, Boolean(input.simulateDecline));
  return { created: true, promotion: (await promotionViews([settled], input.market))[0]! };
}

async function campaignByKey(actorId: string, idempotencyKey: string, tx: any = db) {
  const [row] = await tx
    .select()
    .from(listingPromotions)
    .where(
      and(
        eq(listingPromotions.sellerId, actorId),
        eq(listingPromotions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row as PromotionRow | undefined;
}

async function replay(row: PromotionRow, input: { listingId: string; productId: string; market: Market }) {
  if (row.listingId !== input.listingId || row.productId !== input.productId || row.marketId !== input.market.id)
    throw fail(409, "مفتاح عدم التكرار مستخدم لطلب ترويج مختلف", "IDEMPOTENCY_KEY_REUSED");
  // An interrupted purchase resumes its own single intent; it never opens a second one.
  const settled = row.status === "PENDING_PAYMENT" ? await settlePromotionPayment(row.id, false) : row;
  return { created: false, promotion: (await promotionViews([settled], input.market))[0]! };
}

/**
 * Settles one pending campaign against the test adapter. Success needs a webhook whose
 * signature verifies and whose amount and currency equal the snapshot, plus a CAPTURED
 * provider snapshot. Activation re-checks the listing in the same transaction.
 */
async function settlePromotionPayment(promotionId: string, decline: boolean): Promise<PromotionRow> {
  const adapter = testOnlyPaymentAdapter;
  const [pending] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promotionId));
  if (!pending || pending.status !== "PENDING_PAYMENT" || !pending.paymentReference) return pending;
  const reference = pending.paymentReference;
  if (!(await adapter.getSnapshot(reference)))
    adapter.registerIntent(reference, {
      amountMinor: pending.priceMinorSnapshot,
      currencyCode: pending.currencyCodeSnapshot,
    });
  let verifiedCapture = false;
  const before = await adapter.getSnapshot(reference);
  if (before?.status === "PENDING") {
    if (decline) adapter.declineIntent(reference);
    else {
      const signed = adapter.createCaptureWebhook(reference);
      verifiedCapture =
        adapter.verifyWebhook(signed.event, signed.signature) &&
        signed.event.type === "CAPTURE_SUCCEEDED" &&
        signed.event.providerIntentId === reference &&
        signed.event.amountMinor === pending.priceMinorSnapshot &&
        signed.event.currencyCode === pending.currencyCodeSnapshot;
    }
  }
  const provider = await adapter.getSnapshot(reference);
  const captured =
    provider?.status === "CAPTURED" &&
    provider.capturedAmountMinor === pending.priceMinorSnapshot &&
    provider.currencyCode === pending.currencyCodeSnapshot &&
    (verifiedCapture || before?.status === "CAPTURED");
  const declined = provider?.status === "DECLINED";

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(listingPromotions)
      .where(eq(listingPromotions.id, promotionId))
      .for("update");
    if (!row || row.status !== "PENDING_PAYMENT") return row;
    const now = new Date();
    if (declined || (!captured && provider?.status !== "PENDING")) {
      const [failed] = await tx
        .update(listingPromotions)
        .set({ status: "PAYMENT_FAILED", paymentStatus: "SIMULATION_FAILED", endedAt: now, updatedAt: now })
        .where(eq(listingPromotions.id, row.id))
        .returning();
      return failed;
    }
    if (!captured) return row;
    const [offerRow] = await tx
      .select({ offer: offers, sellerStatus: users.status })
      .from(offers)
      .innerJoin(users, eq(users.id, offers.sellerId))
      .where(eq(offers.id, row.listingId))
      .for("update", { of: offers });
    const eligible = offerRow
      ? await listingPromotionEligibility(offerRow.offer, offerRow.sellerStatus, await marketById(row.marketId, tx), tx)
      : ({ ok: false, reason: "" } as const);
    const [settled] = await tx
      .update(listingPromotions)
      .set(
        eligible.ok
          ? {
              status: "ACTIVE",
              paymentStatus: "SIMULATION_CAPTURED",
              startsAt: now,
              expiresAt: new Date(now.getTime() + row.durationDaysSnapshot * DAY_MS),
              updatedAt: now,
            }
          : // Paid but no longer eligible: never activated. Refunds are deferred (simulation only).
            { status: "CANCELLED", paymentStatus: "SIMULATION_CAPTURED", endedAt: now, updatedAt: now },
      )
      .where(eq(listingPromotions.id, row.id))
      .returning();
    return settled;
  });
}

async function marketById(marketId: string, tx: any): Promise<Market> {
  const [row] = await tx.select().from(markets).where(eq(markets.id, marketId)).limit(1);
  return resolveMarket(row, tx);
}

// ─── Lifecycle changes ───────────────────────────────────────────────────────

export type PromotionChange = "PAUSE" | "RESUME" | "CANCEL";

/**
 * Server-defined transitions only: ACTIVE→PAUSED, PAUSED→ACTIVE, live→CANCELLED.
 * Pausing never extends the window; resuming re-checks the listing and seller.
 */
export async function changePromotion(input: {
  actorId: string;
  market: Market;
  promotionId: string;
  action: PromotionChange;
}): Promise<{ changed: boolean; promotion: SellerPromotionView }> {
  assertPromotionsAvailable();
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(listingPromotions)
      .where(
        and(
          eq(listingPromotions.id, input.promotionId),
          eq(listingPromotions.sellerId, input.actorId),
          eq(listingPromotions.marketId, input.market.id),
        ),
      )
      .for("update");
    if (!row) throw fail(404, "الحملة غير موجودة");
    const now = new Date();
    const effective = effectivePromotionStatus(row as PromotionRow, now);
    if (effective === "EXPIRED") throw fail(409, "انتهت مدة هذه الحملة؛ لا يمكن تغييرها.");
    const set = (values: Partial<PromotionRow>) =>
      tx.update(listingPromotions).set({ ...values, updatedAt: now }).where(eq(listingPromotions.id, row.id)).returning();
    if (input.action === "PAUSE") {
      if (row.status === "PAUSED") return { changed: false, row };
      if (row.status !== "ACTIVE") throw fail(409, "يمكن إيقاف الحملة النشطة فقط");
      const [next] = await set({ status: "PAUSED", pausedAt: now });
      await tx.insert(marketAudit).values({
        id: randomUUID(),
        marketId: input.market.id,
        actorId: input.actorId,
        action: "PROMOTION_PAUSE",
        data: { promotionId: row.id, listingId: row.listingId, from: row.status, to: "PAUSED" },
      });
      return { changed: true, row: next };
    }
    if (input.action === "RESUME") {
      if (row.status === "ACTIVE") return { changed: false, row };
      if (row.status !== "PAUSED") throw fail(409, "يمكن استئناف الحملة الموقوفة فقط");
      const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId)).for("share");
      if (actor?.status !== "ACTIVE") throw fail(403, "حسابك مقيّد حاليًا ولا يمكن استئناف الترويج.");
      const { offer, sellerStatus } = await ownedOffer(input.actorId, input.market, row.listingId, tx, true);
      const eligible = await listingPromotionEligibility(offer, sellerStatus, input.market, tx);
      if (!eligible.ok) throw fail(409, `لا يمكن الاستئناف: ${eligible.reason}`);
      const [next] = await set({ status: "ACTIVE", pausedAt: null });
      await tx.insert(marketAudit).values({
        id: randomUUID(),
        marketId: input.market.id,
        actorId: input.actorId,
        action: "PROMOTION_RESUME",
        data: { promotionId: row.id, listingId: row.listingId, from: row.status, to: "ACTIVE" },
      });
      return { changed: true, row: next };
    }
    if (row.status === "CANCELLED") return { changed: false, row };
    if (!(LIVE_STATUSES as readonly string[]).includes(row.status))
      throw fail(409, "لا يمكن إلغاء حملة منتهية");
    // No real refund: Wave 4 is simulation only and refund policy belongs to Integration.
    // A budget campaign's unused reserve follows its snapshotted refund policy.
    const [next] = await set({ status: "CANCELLED", endedAt: now });
    let cancelled = next;
    if (row.budgetMinor != null) {
      await releaseCampaignBudget(tx, row.id);
      const [released] = await tx.select().from(listingPromotions).where(eq(listingPromotions.id, row.id));
      if (released) cancelled = released;
    }
    await tx.insert(marketAudit).values({
      id: randomUUID(),
      marketId: input.market.id,
      actorId: input.actorId,
      action: "PROMOTION_CANCEL",
      data: { promotionId: row.id, listingId: row.listingId, from: row.status, to: "CANCELLED", releasedMinor: cancelled.releasedMinor },
    });
    return { changed: true, row: cancelled };
  });
  return { changed: outcome.changed, promotion: (await promotionViews([outcome.row as PromotionRow], input.market))[0]! };
}

// ─── Admin (operational view, no buyer data) ────────────────────────────────

export async function adminMarketPromotions(market: Market) {
  const rows: PromotionRow[] = await db
    .select()
    .from(listingPromotions)
    .where(eq(listingPromotions.marketId, market.id))
    .orderBy(desc(listingPromotions.createdAt))
    .limit(100);
  return (await promotionViews(rows, market)).map((view, index) => ({
    ...view,
    sellerId: rows[index]!.sellerId,
  }));
}

// ════ Commercial economy (Monetization V3) ══════════════════════════════════
// The same promotion authority sells every listing product (featured, VIP, refresh,
// sponsored search/recommendation, demand capture) and bundles, paid from the seller's
// prepaid commercial balance or a bundle unit through the commercial ledger.

export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  STANDARD_PROMOTION: "ترويج",
  FEATURED_LISTING: "إعلان مميز",
  VIP_LISTING: "VIP",
  REFRESH_LISTING: "تجديد الإعلان",
  SPONSORED_SEARCH: "تمييز في نتائج البحث",
  SPONSORED_RECOMMENDATION: "إعلان داخل المحادثة",
  DEMAND_CAPTURE: "جاسم روح بيع لي",
  PROMOTION_BUNDLE: "باقة إعلانات",
  DINAR_BUSINESS: "جاسم بزنس",
};
export const REFUND_POLICY_LABELS: Record<string, string> = {
  NON_REFUNDABLE_ON_ACTIVATION: "يُستهلك عند التفعيل ولا يُسترد",
  RELEASE_UNUSED_BUDGET: "الميزانية غير المستخدمة تعود إلى رصيدك عند الإلغاء أو الانتهاء",
  UNUSED_UNITS_TO_CREDIT: "الوحدات غير المستخدمة تخضع لسياسة الاسترداد إلى الرصيد",
  NO_REFUND: "لا استرداد",
};
export const LISTING_PRODUCT_TYPES = ["FEATURED_LISTING", "VIP_LISTING", "REFRESH_LISTING", "SPONSORED_SEARCH", "SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE"] as const;
export const ENTITLEMENT_PRODUCT_TYPES = ["FEATURED_LISTING", "VIP_LISTING", "REFRESH_LISTING"] as const;
const PURCHASE_ENTRY_TYPE: Record<string, string> = {
  FEATURED_LISTING: "FEATURED_PURCHASE",
  VIP_LISTING: "VIP_PURCHASE",
  REFRESH_LISTING: "REFRESH_PURCHASE",
  PROMOTION_BUNDLE: "BUNDLE_PURCHASE",
  STANDARD_PROMOTION: "PROMOTION_PURCHASE",
};
export const DEMAND_CAPTURE_PITCH = "خلّ جاسم يعرض إعلانك كخيار ممول عندما يوجد طلب حقيقي مناسب.";
export const DEMAND_PRIVACY_NOTE = "لن ترى هوية أي مشترٍ أو رسائله أو موقعه؛ تصلك أرقام مجمّعة فقط. لا يضمن الظهور أي بيع.";

function productIsEffective(product: ProductRow, now = new Date()) {
  return (
    product.enabled &&
    (!product.effectiveFrom || product.effectiveFrom.getTime() <= now.getTime()) &&
    (!product.effectiveTo || product.effectiveTo.getTime() > now.getTime())
  );
}

export type CommercialProductView = {
  id: string;
  name: string;
  productType: string;
  productTypeLabel: string;
  chargingMode: string;
  categoryId: string | null;
  durationDays: number;
  priceMinor: number;
  priceLabel: string;
  currencyCode: string;
  minBudgetLabel?: string;
  maxBudgetLabel?: string;
  unitChargeLabel?: string;
  bundleItems: { productType: string; productTypeLabel: string; units: number; durationDays: number }[];
  entitlementExpiryDays: number | null;
  businessEntitlements: string[];
  pricingVersion: number;
  refundPolicy: string;
  refundPolicyLabel: string;
};

export function commercialProductView(product: ProductRow, market: Market): CommercialProductView {
  const f = (minor: number) => `${formatMinor(minor, scaleOfCurrency(product.currencyCode, market) ?? market.minorUnitScale)} ${product.currencyCode}`;
  const budget = product.chargingMode === "PREPAID_BUDGET";
  return {
    id: product.id,
    name: product.name,
    productType: product.productType,
    productTypeLabel: PRODUCT_TYPE_LABELS[product.productType] ?? product.productType,
    chargingMode: product.chargingMode,
    categoryId: product.categoryId,
    durationDays: product.durationDays,
    priceMinor: product.priceMinor,
    priceLabel: f(product.priceMinor),
    currencyCode: product.currencyCode,
    ...(budget ? { minBudgetLabel: f(product.priceMinor) } : {}),
    ...(budget && product.maxBudgetMinor ? { maxBudgetLabel: f(product.maxBudgetMinor) } : {}),
    ...(budget && product.unitChargeMinor ? { unitChargeLabel: f(product.unitChargeMinor) } : {}),
    bundleItems: (product.bundleItems ?? []).map((item) => ({
      productType: item.productType,
      productTypeLabel: PRODUCT_TYPE_LABELS[item.productType] ?? item.productType,
      units: item.units,
      durationDays: item.durationDays,
    })),
    entitlementExpiryDays: product.entitlementExpiryDays,
    businessEntitlements: product.businessEntitlements ?? [],
    pricingVersion: product.pricingVersion,
    refundPolicy: product.refundPolicy,
    refundPolicyLabel: REFUND_POLICY_LABELS[product.refundPolicy] ?? product.refundPolicy,
  };
}

/** Effective products in the market's currency; listing products narrowed to a category. */
const LISTING_AD_TYPES = new Set(["SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE", "SPONSORED_SEARCH", "FEATURED_LISTING", "VIP_LISTING", "REFRESH_LISTING", "PROMOTION_BUNDLE"]);
export async function commercialProducts(
  market: Market,
  filter: { productTypes?: readonly string[]; categoryId?: string } = {},
  tx: any = db,
): Promise<ProductRow[]> {
  const rows: ProductRow[] = await tx
    .select()
    .from(promotionProducts)
    .where(and(eq(promotionProducts.marketId, market.id), eq(promotionProducts.enabled, true)))
    .orderBy(asc(promotionProducts.priceMinor), asc(promotionProducts.durationDays), asc(promotionProducts.id));
  // A product type the current policy no longer sells is not offered (existing campaigns keep running).
  const allowedAds = (await getCommercialPolicy(market.id)).advertisingProducts as readonly string[] | undefined;
  return rows.filter(
    (row) =>
      productIsEffective(row) &&
      // A subscription plan may be priced in USD (paid through Whop); everything else is market currency.
      (row.currencyCode === market.currencyCode || (row.productType === "DINAR_BUSINESS" && !!row.planCode && row.currencyCode === "USD")) &&
      row.productType !== "STANDARD_PROMOTION" &&
      (!allowedAds || row.productType === "DINAR_BUSINESS" || !LISTING_AD_TYPES.has(row.productType) || allowedAds.includes(row.productType)) &&
      (!filter.productTypes || filter.productTypes.includes(row.productType)) &&
      (filter.categoryId === undefined || row.categoryId === null || row.categoryId === filter.categoryId),
  );
}

export async function effectiveProduct(market: Market, productId: string, tx: any = db): Promise<ProductRow> {
  const [row] = (await tx.select().from(promotionProducts).where(and(eq(promotionProducts.id, productId), eq(promotionProducts.marketId, market.id)))) as ProductRow[];
  if (!row || row.productType === "STANDARD_PROMOTION") throw fail(404, "المنتج التجاري غير موجود في سوقك", "PRODUCT_NOT_FOUND");
  if (!productIsEffective(row) || row.currencyCode !== market.currencyCode)
    throw fail(409, "هذا المنتج غير متاح للشراء حاليًا", "PRODUCT_DISABLED");
  return row;
}

/** Bundle units of this type the seller can still use now (soonest expiry first). */
async function usableEntitlement(userId: string, market: Market, productType: string, tx: any = db) {
  const now = new Date();
  const rows: (typeof commercialEntitlements.$inferSelect)[] = await tx
    .select()
    .from(commercialEntitlements)
    .where(and(eq(commercialEntitlements.userId, userId), eq(commercialEntitlements.marketId, market.id), eq(commercialEntitlements.productType, productType)))
    .orderBy(asc(commercialEntitlements.expiresAt), asc(commercialEntitlements.createdAt), asc(commercialEntitlements.id));
  return rows.find((row) => row.unitsUsed < row.unitsTotal && (!row.expiresAt || row.expiresAt.getTime() > now.getTime()));
}

export async function refreshLimitBreach(listingId: string, policy: CommercialPolicy, tx: any = db): Promise<string | undefined> {
  const since = new Date(Date.now() - DAY_MS);
  const recent: PromotionRow[] = await tx
    .select()
    .from(listingPromotions)
    .where(and(eq(listingPromotions.listingId, listingId), eq(listingPromotions.placementSnapshot, "REFRESH"), inArray(listingPromotions.status, ["ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"])))
    .orderBy(desc(listingPromotions.startsAt))
    .limit(20);
  if (recent.filter((row) => row.startsAt.getTime() >= since.getTime()).length >= policy.refreshMaxPerDay)
    return `الحد الأقصى ${policy.refreshMaxPerDay} تجديد في اليوم لهذا الإعلان`;
  const last = recent[0];
  if (last && Date.now() - last.startsAt.getTime() < policy.refreshMinIntervalHours * 60 * 60 * 1000)
    return `يمكن تجديد الإعلان مرة كل ${policy.refreshMinIntervalHours} ساعة`;
  return undefined;
}

export type CommercialPaymentSource = "COMMERCIAL_BALANCE" | "BUNDLE_ENTITLEMENT";

export type CommercialPurchaseReview = {
  product: CommercialProductView;
  listing?: { id: string; title: string };
  amountMinor: number;
  amountLabel: string;
  budgetMinor?: number;
  budgetLabel?: string;
  durationDays: number;
  paymentSource: CommercialPaymentSource;
  entitlement?: { id: string; remainingUnits: number };
  balance: CommercialBalanceView;
  balanceAfterLabel: string;
  sufficient: boolean;
  missingLabel?: string;
  sponsoredLabel: string;
  disclosure: string;
  refundNote: string;
  startNote: string;
  endNote: string;
  privacyNote?: string;
  pitch?: string;
  paymentMode: "TEST_NO_TRANSFER";
  autoRenew: false;
  failure?: string;
  failureCode?: string;
};

type PurchaseInput = {
  actorId: string;
  market: Market;
  productId: string;
  listingId?: string;
  budgetMinor?: number;
  paymentSource?: CommercialPaymentSource;
};

async function preparePurchase(input: PurchaseInput, tx: any = db, lock = false) {
  const product = await effectiveProduct(input.market, input.productId, tx);
  if (product.productType === "DINAR_BUSINESS") throw fail(400, "اشتراك جاسم بزنس له مراجعة خاصة", "WRONG_FLOW");
  const isListingProduct = (LISTING_PRODUCT_TYPES as readonly string[]).includes(product.productType);
  let listing: { offer: OfferRowData; sellerStatus: string } | undefined;
  if (isListingProduct) {
    if (!input.listingId) throw fail(400, "حدّد الإعلان أولًا");
    listing = await ownedOffer(input.actorId, input.market, input.listingId, tx, lock);
    const eligible = await listingPromotionEligibility(listing.offer, listing.sellerStatus, input.market, tx);
    if (!eligible.ok) throw fail(409, eligible.reason, "LISTING_INELIGIBLE");
    if (product.categoryId !== eligible.categoryId) throw fail(409, "هذا المنتج لا يخص فئة هذا الإعلان", "LISTING_INELIGIBLE");
  } else if (input.listingId) throw fail(400, "هذا المنتج لا يخص إعلانًا محددًا");
  let budgetMinor: number | undefined;
  if (product.chargingMode === "PREPAID_BUDGET") {
    budgetMinor = input.budgetMinor ?? product.priceMinor;
    if (!Number.isSafeInteger(budgetMinor) || budgetMinor < product.priceMinor || (product.maxBudgetMinor && budgetMinor > product.maxBudgetMinor))
      throw fail(400, `الميزانية يجب أن تكون بين ${formatMinor(product.priceMinor, input.market.minorUnitScale)} و${formatMinor(product.maxBudgetMinor ?? product.priceMinor * 100, input.market.minorUnitScale)} ${input.market.currencyCode}`, "BUDGET_INVALID");
  }
  const entitlement = (ENTITLEMENT_PRODUCT_TYPES as readonly string[]).includes(product.productType)
    ? await usableEntitlement(input.actorId, input.market, product.productType, tx)
    : undefined;
  const paymentSource: CommercialPaymentSource =
    input.paymentSource ?? (entitlement ? "BUNDLE_ENTITLEMENT" : "COMMERCIAL_BALANCE");
  if (paymentSource === "BUNDLE_ENTITLEMENT" && !(ENTITLEMENT_PRODUCT_TYPES as readonly string[]).includes(product.productType))
    throw fail(400, "لا تُستخدم الباقات لهذا المنتج");
  const amountMinor = paymentSource === "BUNDLE_ENTITLEMENT" ? 0 : budgetMinor ?? product.priceMinor;
  return { product, listing, budgetMinor, entitlement, paymentSource, amountMinor };
}

/** What the seller is about to accept, from server state only. Changes nothing. */
export async function reviewCommercialPurchase(input: PurchaseInput): Promise<CommercialPurchaseReview> {
  assertPromotionsAvailable();
  const prepared = await preparePurchase(input);
  const { product, listing, budgetMinor, entitlement, paymentSource, amountMinor } = prepared;
  const policy = await getCommercialPolicy(input.market.id);
  let failure: string | undefined;
  let failureCode: string | undefined;
  if (listing) {
    const live = await liveCampaignAt(listing.offer.id, product.placement);
    if (live && effectivePromotionStatus(live, new Date()) !== "EXPIRED") {
      failure = "لدى الإعلان حملة قائمة من النوع نفسه";
      failureCode = "ALREADY_LIVE";
    }
    if (!failure && product.productType === "REFRESH_LISTING") {
      failure = await refreshLimitBreach(listing.offer.id, policy);
      if (failure) failureCode = "REFRESH_LIMIT";
    }
  }
  if (paymentSource === "BUNDLE_ENTITLEMENT" && !entitlement) {
    failure = "لا توجد وحدات متبقية في باقاتك لهذا المنتج";
    failureCode = "BUNDLE_EXHAUSTED";
  }
  const balance = await getCommercialBalance(input.actorId, input.market);
  const sufficient = amountMinor <= balance.availableMinor;
  const f = (minor: number) => `${formatMinor(minor, input.market.minorUnitScale)} ${input.market.currencyCode}`;
  const durationDays = paymentSource === "BUNDLE_ENTITLEMENT" && entitlement ? entitlement.unitDurationDays : product.durationDays;
  const view = commercialProductView(product, input.market);
  return {
    product: view,
    ...(listing ? { listing: { id: listing.offer.id, title: typeof listing.offer.data.title === "string" ? listing.offer.data.title : "إعلان" } } : {}),
    amountMinor,
    amountLabel: f(amountMinor),
    ...(budgetMinor !== undefined ? { budgetMinor, budgetLabel: f(budgetMinor) } : {}),
    durationDays,
    paymentSource,
    ...(entitlement ? { entitlement: { id: entitlement.id, remainingUnits: entitlement.unitsTotal - entitlement.unitsUsed } } : {}),
    balance,
    balanceAfterLabel: f(Math.max(0, balance.availableMinor - amountMinor)),
    sufficient,
    ...(!sufficient ? { missingLabel: f(amountMinor - balance.availableMinor), failure: failure ?? "رصيدك التجاري غير كافٍ", failureCode: failureCode ?? "INSUFFICIENT_BALANCE" } : failure ? { failure, failureCode } : {}),
    sponsoredLabel: SPONSORED_LABEL,
    disclosure:
      product.productType === "PROMOTION_BUNDLE"
        ? "وحدات تُستخدم لاحقًا على إعلاناتك؛ كل استخدام يظهر بشارة «ممول»."
        : "ظهور مدفوع بشارة «ممول»: لا يتجاوز شروط المشتري ولا يعني أن البائع موثّق أو أن العرض الأفضل.",
    refundNote: view.refundPolicyLabel,
    startNote: product.productType === "PROMOTION_BUNDLE" ? "تُضاف الوحدات إلى رصيد باقاتك فور التأكيد" : "يبدأ فور التأكيد",
    endNote:
      product.productType === "PROMOTION_BUNDLE"
        ? product.entitlementExpiryDays ? `تنتهي الوحدات غير المستخدمة بعد ${product.entitlementExpiryDays} يومًا` : "لا تاريخ انتهاء للوحدات"
        : `ينتهي بعد ${durationDays} ${durationDays === 1 ? "يوم" : "أيام"} دون تجديد تلقائي`,
    ...(product.productType === "DEMAND_CAPTURE" ? { privacyNote: DEMAND_PRIVACY_NOTE, pitch: DEMAND_CAPTURE_PITCH } : {}),
    paymentMode: "TEST_NO_TRANSFER",
    autoRenew: false,
  };
}

export async function liveCampaignAt(listingId: string, placement: string, tx: any = db): Promise<PromotionRow | undefined> {
  const [row] = await tx
    .select()
    .from(listingPromotions)
    .where(and(eq(listingPromotions.listingId, listingId), eq(listingPromotions.placementSnapshot, placement), inArray(listingPromotions.status, [...LIVE_STATUSES])))
    .limit(1);
  return row;
}

export type CommercialPurchaseOutcome = {
  created: boolean;
  promotion?: SellerPromotionView;
  entitlements?: { id: string; productType: string; unitsTotal: number; unitsUsed: number }[];
  balance: CommercialBalanceView;
};

/**
 * Buys one commercial product. Idempotent per seller key; activation only after the ledger
 * charge (or bundle unit) commits in the same transaction, so nothing is ever served on
 * credit. Insufficient balance or an exhausted bundle changes nothing.
 */
export async function purchaseCommercialProduct(input: PurchaseInput & { idempotencyKey: string }): Promise<CommercialPurchaseOutcome> {
  assertSimulationAvailable();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw fail(400, "مفتاح عدم التكرار غير صالح");
  const outcome = await db.transaction(async (tx) => {
    const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId)).for("share");
    if (actor?.status !== "ACTIVE") throw fail(403, "حسابك مقيّد حاليًا ولا يمكن شراء منتج تجاري.");
    const prepared = await preparePurchase(input, tx, true);
    const { product, listing, budgetMinor, paymentSource } = prepared;
    const account = await lockedAccount(input.actorId, input.market, tx);
    const ledgerKey = `purchase:${input.idempotencyKey}`;
    const [priorEntry] = await tx
      .select()
      .from(commercialLedger)
      .where(and(eq(commercialLedger.accountId, account.id), eq(commercialLedger.idempotencyKey, ledgerKey)));
    const prior = listing ? await campaignByKey(input.actorId, input.idempotencyKey, tx) : undefined;
    if (prior || priorEntry) {
      if (prior && (prior.listingId !== listing?.offer.id || prior.productId !== product.id)) throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      if (priorEntry && priorEntry.productId !== product.id) throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      return { created: false, promotionId: prior?.id, bundleEntryId: !prior ? priorEntry?.id : undefined, account };
    }
    const policy = await getCommercialPolicy(input.market.id, tx);
    const now = new Date();

    if (product.productType === "PROMOTION_BUNDLE") {
      const charged = await chargeAvailable(tx, account, {
        entryType: "BUNDLE_PURCHASE",
        amountMinor: product.priceMinor,
        productId: product.id,
        productType: product.productType,
        pricingVersion: product.pricingVersion,
        idempotencyKey: ledgerKey,
        market: input.market,
      });
      const expiresAt = product.entitlementExpiryDays ? new Date(now.getTime() + product.entitlementExpiryDays * DAY_MS) : null;
      for (const item of product.bundleItems ?? [])
        await tx.insert(commercialEntitlements).values({
          id: randomUUID(),
          accountId: account.id,
          userId: input.actorId,
          marketId: input.market.id,
          bundleProductId: product.id,
          sourceEntryId: charged.entry.id,
          productType: item.productType,
          unitsTotal: item.units,
          unitDurationDays: item.durationDays,
          unitPriorityWeight: item.priorityWeight ?? 100,
          pricingVersion: product.pricingVersion,
          refundPolicy: product.refundPolicy,
          expiresAt,
        });
      logger.info({ event: "bundle_purchased", marketId: input.market.id }, "bundle purchased");
      return { created: true, bundleEntryId: charged.entry.id, account: charged.account };
    }

    // Listing product.
    await expireStalePromotions({ listingId: listing!.offer.id, tx });
    if (await liveCampaignAt(listing!.offer.id, product.placement, tx)) throw fail(409, "لدى الإعلان حملة قائمة من النوع نفسه", "ALREADY_LIVE");
    if (product.productType === "REFRESH_LISTING") {
      const breach = await refreshLimitBreach(listing!.offer.id, policy, tx);
      if (breach) throw fail(409, breach, "REFRESH_LIMIT");
    }
    let entitlement: typeof commercialEntitlements.$inferSelect | undefined;
    if (paymentSource === "BUNDLE_ENTITLEMENT") {
      // Atomic unit consumption: two requests for the last unit cannot both succeed.
      const candidate = await usableEntitlement(input.actorId, input.market, product.productType, tx);
      const [used] = candidate
        ? await tx
            .update(commercialEntitlements)
            .set({ unitsUsed: sql`${commercialEntitlements.unitsUsed} + 1`, updatedAt: now })
            .where(and(eq(commercialEntitlements.id, candidate.id), sql`${commercialEntitlements.unitsUsed} < ${commercialEntitlements.unitsTotal}`))
            .returning()
        : [];
      if (!used) throw fail(409, "لا توجد وحدات متبقية في باقاتك لهذا المنتج", "BUNDLE_EXHAUSTED");
      entitlement = used;
    }
    const budget = product.chargingMode === "PREPAID_BUDGET" ? budgetMinor! : undefined;
    const split = budget !== undefined ? creditSplit(account, budget, policy) : undefined;
    if (budget !== undefined && !split) throw insufficient(account, budget, input.market);
    const durationDays = entitlement ? entitlement.unitDurationDays : product.durationDays;
    const promotionId = randomUUID();
    await tx.insert(listingPromotions).values({
      id: promotionId,
      listingId: listing!.offer.id,
      sellerId: input.actorId,
      marketId: input.market.id,
      productId: product.id,
      productNameSnapshot: product.name,
      categoryIdSnapshot: product.categoryId!,
      priceMinorSnapshot: product.priceMinor,
      currencyCodeSnapshot: product.currencyCode,
      placementSnapshot: product.placement,
      durationDaysSnapshot: durationDays,
      status: "ACTIVE",
      paymentMode: "DEVELOPMENT_SIMULATED",
      paymentStatus: entitlement ? "ENTITLEMENT_CONSUMED" : "BALANCE_CHARGED",
      paymentSource: entitlement ? "BUNDLE_ENTITLEMENT" : "COMMERCIAL_BALANCE",
      entitlementId: entitlement?.id ?? null,
      idempotencyKey: input.idempotencyKey,
      productTypeSnapshot: product.productType,
      chargingModeSnapshot: product.chargingMode,
      pricingVersionSnapshot: product.pricingVersion,
      refundPolicySnapshot: product.refundPolicy,
      priorityWeightSnapshot: entitlement ? entitlement.unitPriorityWeight : product.priorityWeight,
      unitChargeMinorSnapshot: budget !== undefined ? product.unitChargeMinor : null,
      budgetMinor: budget ?? null,
      budgetPromoMinor: split?.promo ?? 0,
      taxPolicyVersion: product.taxPolicyVersion,
      startsAt: now,
      expiresAt: new Date(now.getTime() + durationDays * DAY_MS),
    });
    let after = account;
    if (entitlement) {
      after = (await post(tx, account, {
        entryType: "ENTITLEMENT_CONSUMED",
        amountMinor: 0,
        entitlementId: entitlement.id,
        promotionId,
        productId: product.id,
        productType: product.productType,
        pricingVersion: entitlement.pricingVersion,
        idempotencyKey: ledgerKey,
        policyVersion: policy.version,
      })).account;
    } else if (budget !== undefined) {
      after = (await post(tx, account, {
        entryType: "CAMPAIGN_RESERVE",
        amountMinor: budget,
        paidDelta: -split!.paid,
        promoDelta: -split!.promo,
        reservedDelta: budget,
        promotionId,
        productId: product.id,
        productType: product.productType,
        pricingVersion: product.pricingVersion,
        idempotencyKey: ledgerKey,
        policyVersion: policy.version,
        metadata: { consumption: policy.creditConsumptionOrder, promoMinor: split!.promo },
      })).account;
      logger.info({ event: "campaign_budget_reserved", marketId: input.market.id, amountMinor: budget }, "campaign budget reserved");
    } else {
      after = (await chargeAvailable(tx, account, {
        entryType: (PURCHASE_ENTRY_TYPE[product.productType] ?? "PROMOTION_PURCHASE") as LedgerPosting["entryType"],
        amountMinor: product.priceMinor,
        promotionId,
        productId: product.id,
        productType: product.productType,
        pricingVersion: product.pricingVersion,
        idempotencyKey: ledgerKey,
        market: input.market,
      })).account;
    }
    logger.info({ event: `${product.productType.toLowerCase()}_activated`, marketId: input.market.id }, "commercial product activated");
    return { created: true, promotionId, account: after };
  });
  const balance = balanceView(outcome.account, input.market);
  if (outcome.promotionId) {
    const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, outcome.promotionId));
    // «جاسم روح بيع لي»: match buyer-authorised saved requests as soon as the campaign serves.
    if (outcome.created && row?.placementSnapshot === "DEMAND") {
      const { matchDemandCampaign } = await import("./demand-requests");
      await matchDemandCampaign(row.id, input.market).catch((error) => logger.warn({ event: "demand_match_failed", err: error }, "demand match failed"));
    }
    return { created: outcome.created, promotion: (await promotionViews([row as PromotionRow], input.market))[0]!, balance: await getCommercialBalance(input.actorId, input.market) };
  }
  const entitlements = await db.select().from(commercialEntitlements).where(eq(commercialEntitlements.sourceEntryId, outcome.bundleEntryId!));
  return {
    created: outcome.created,
    entitlements: entitlements.map((row) => ({ id: row.id, productType: row.productType, unitsTotal: row.unitsTotal, unitsUsed: row.unitsUsed })),
    balance: outcome.created ? balance : await getCommercialBalance(input.actorId, input.market),
  };
}

export async function listEntitlements(userId: string, market: Market) {
  const rows = await db
    .select()
    .from(commercialEntitlements)
    .where(and(eq(commercialEntitlements.userId, userId), eq(commercialEntitlements.marketId, market.id)))
    .orderBy(desc(commercialEntitlements.createdAt));
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    productType: row.productType,
    productTypeLabel: PRODUCT_TYPE_LABELS[row.productType] ?? row.productType,
    unitsTotal: row.unitsTotal,
    unitsUsed: row.unitsUsed,
    unitsRemaining: row.unitsTotal - row.unitsUsed,
    unitDurationDays: row.unitDurationDays,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    status: row.expiresAt && row.expiresAt.getTime() <= now ? "EXPIRED" : row.unitsUsed >= row.unitsTotal ? "EXHAUSTED" : "ACTIVE",
  }));
}

// ─── Budget charging and release ─────────────────────────────────────────────

async function sellerAccount(tx: any, campaign: PromotionRow) {
  const [account] = await tx
    .select()
    .from(commercialAccounts)
    .where(and(eq(commercialAccounts.userId, campaign.sellerId), eq(commercialAccounts.marketId, campaign.marketId)))
    .for("update");
  return account as typeof commercialAccounts.$inferSelect | undefined;
}

/**
 * Ends a budget campaign's commitment: the unused reserve returns to the buckets it came
 * from (RELEASE_UNUSED_BUDGET) or is recognised as consumed (NO_REFUND). Idempotent.
 */
export async function releaseCampaignBudget(tx: any, campaignId: string): Promise<number> {
  const [campaign] = (await tx.select().from(listingPromotions).where(eq(listingPromotions.id, campaignId)).for("update")) as PromotionRow[];
  if (!campaign || campaign.budgetMinor == null) return 0;
  const remaining = campaign.budgetMinor - campaign.spentMinor - campaign.releasedMinor;
  if (remaining <= 0) return 0;
  const account = await sellerAccount(tx, campaign);
  if (!account) return 0;
  // Spend consumed the promotional share first, so what is left of it returns first.
  const promoBack = Math.min(remaining, Math.max(0, campaign.budgetPromoMinor - campaign.spentMinor));
  const forfeited = campaign.refundPolicySnapshot === "NO_REFUND";
  await tx.update(listingPromotions).set({ releasedMinor: campaign.releasedMinor + remaining, updatedAt: new Date() }).where(eq(listingPromotions.id, campaign.id));
  await post(tx, account, forfeited
    ? { entryType: "EXPIRE", amountMinor: remaining, reservedDelta: -remaining, spentDelta: remaining, promotionId: campaign.id, productType: campaign.productTypeSnapshot, idempotencyKey: `release:${campaign.id}` }
    : { entryType: "CAMPAIGN_RELEASE", amountMinor: remaining, reservedDelta: -remaining, promoDelta: promoBack, paidDelta: remaining - promoBack, promotionId: campaign.id, productType: campaign.productTypeSnapshot, idempotencyKey: `release:${campaign.id}` });
  logger.info({ event: "campaign_budget_released", marketId: campaign.marketId, amountMinor: remaining }, "campaign budget released");
  return remaining;
}

export type CampaignChargeOutcome = { status: "CHARGED" | "SKIPPED_BUDGET" | "SKIPPED_INACTIVE"; chargeMinor: number; ledgerEntryId?: string };

/**
 * One qualified billable event against a budget campaign. Under the campaign row lock:
 * spend can never exceed budget minus release, the reserve moves to spent in the ledger,
 * and a campaign that cannot cover another charge becomes BUDGET_EXHAUSTED and releases
 * its remainder. Concurrent events serialise on the lock; none overspends.
 */
export async function chargeCampaignEvent(tx: any, campaignId: string, idempotencyKey: string, kind: string): Promise<CampaignChargeOutcome> {
  const [campaign] = (await tx.select().from(listingPromotions).where(eq(listingPromotions.id, campaignId)).for("update")) as PromotionRow[];
  if (!campaign || campaign.budgetMinor == null || campaign.unitChargeMinorSnapshot == null) return { status: "SKIPPED_INACTIVE", chargeMinor: 0 };
  const now = new Date();
  if (!isServingCampaign({ ...campaign, budgetMinor: null }, now)) return { status: "SKIPPED_INACTIVE", chargeMinor: 0 };
  const unit = campaign.unitChargeMinorSnapshot;
  const remaining = campaign.budgetMinor - campaign.spentMinor - campaign.releasedMinor;
  if (remaining < unit) {
    await exhaust(tx, campaign, now);
    return { status: "SKIPPED_BUDGET", chargeMinor: 0 };
  }
  const account = await sellerAccount(tx, campaign);
  if (!account) return { status: "SKIPPED_INACTIVE", chargeMinor: 0 };
  const [updated] = await tx
    .update(listingPromotions)
    .set({ spentMinor: sql`${listingPromotions.spentMinor} + ${unit}`, updatedAt: now })
    .where(and(eq(listingPromotions.id, campaign.id), sql`${listingPromotions.spentMinor} + ${listingPromotions.releasedMinor} + ${unit} <= ${listingPromotions.budgetMinor}`))
    .returning();
  if (!updated) return { status: "SKIPPED_BUDGET", chargeMinor: 0 };
  const promoShare = Math.max(0, Math.min(unit, campaign.budgetPromoMinor - campaign.spentMinor));
  const charged = await post(tx, account, {
    entryType: "CAMPAIGN_CHARGE",
    amountMinor: unit,
    reservedDelta: -unit,
    spentDelta: unit,
    promotionId: campaign.id,
    productType: campaign.productTypeSnapshot,
    pricingVersion: campaign.pricingVersionSnapshot,
    idempotencyKey: `charge:${idempotencyKey}`,
    metadata: { kind, promoMinor: promoShare },
  });
  logger.info({ event: "campaign_charge_posted", marketId: campaign.marketId, amountMinor: unit }, "campaign charge posted");
  if ((updated as PromotionRow).budgetMinor! - (updated as PromotionRow).spentMinor - (updated as PromotionRow).releasedMinor < unit) await exhaust(tx, updated as PromotionRow, now);
  return { status: "CHARGED", chargeMinor: unit, ledgerEntryId: charged.entry.id };
}

async function exhaust(tx: any, campaign: PromotionRow, now: Date) {
  if (campaign.status !== "ACTIVE" && campaign.status !== "PAUSED") return;
  await tx.update(listingPromotions).set({ status: "BUDGET_EXHAUSTED", endedAt: now, updatedAt: now }).where(eq(listingPromotions.id, campaign.id));
  await releaseCampaignBudget(tx, campaign.id);
  logger.info({ event: "campaign_budget_exhausted", marketId: campaign.marketId }, "campaign budget exhausted");
}

// ─── Campaign analytics (aggregates only) ────────────────────────────────────

export type CampaignAnalyticsView = {
  promotionId: string;
  listingTitle: string;
  productTypeLabel: string;
  effectiveStatus: string;
  qualifiedImpressions: number;
  qualifiedEngagements: number;
  detailOpens: number;
  comparisons: number;
  negotiations: number;
  purchaseReviews: number;
  ordersAttributed: number;
  conversionRate: string;
  budgetLabel?: string;
  spentLabel: string;
  remainingLabel?: string;
};

/**
 * The owner's campaign results from server-attributed events: counts and spend only, no
 * viewer keys, buyers, orders' prices or negotiated terms. Other sellers see nothing.
 */
export async function campaignAnalytics(actorId: string, market: Market, promotionIds?: string[]): Promise<CampaignAnalyticsView[]> {
  assertPromotionsAvailable();
  const rows: PromotionRow[] = await db
    .select()
    .from(listingPromotions)
    .where(
      and(
        eq(listingPromotions.sellerId, actorId),
        eq(listingPromotions.marketId, market.id),
        ...(promotionIds ? [inArray(listingPromotions.id, promotionIds.length ? promotionIds : ["-"])] : []),
      ),
    )
    .orderBy(desc(listingPromotions.createdAt))
    .limit(24);
  if (!rows.length) return [];
  const counts = (await db
    .select({
      promotionId: promotionAttributions.promotionId,
      eventType: promotionAttributions.eventType,
      kind: promotionAttributions.engagementKind,
      n: sql<number>`count(*)::int`,
    })
    .from(promotionAttributions)
    .where(and(inArray(promotionAttributions.promotionId, rows.map((row) => row.id)), sql`${promotionAttributions.chargeStatus} <> 'SKIPPED_SELF'`))
    .groupBy(promotionAttributions.promotionId, promotionAttributions.eventType, promotionAttributions.engagementKind)) as { promotionId: string; eventType: string; kind: string | null; n: number }[];
  const views = await promotionViews(rows, market);
  const f = (minor: number) => `${formatMinor(minor, market.minorUnitScale)} ${market.currencyCode}`;
  return rows.map((row, index) => {
    const of = (eventType: string, kind?: string) => counts.filter((item) => item.promotionId === row.id && item.eventType === eventType && (kind === undefined || item.kind === kind)).reduce((sum, item) => sum + item.n, 0);
    const engagements = of("ENGAGEMENT");
    const orders = of("CONVERSION");
    const spent = row.budgetMinor != null ? row.spentMinor : row.paymentSource === "BUNDLE_ENTITLEMENT" ? 0 : row.priceMinorSnapshot;
    return {
      promotionId: row.id,
      listingTitle: views[index]!.listingTitle,
      productTypeLabel: PRODUCT_TYPE_LABELS[row.productTypeSnapshot] ?? row.productTypeSnapshot,
      effectiveStatus: views[index]!.effectiveStatus,
      qualifiedImpressions: of("IMPRESSION"),
      qualifiedEngagements: engagements,
      detailOpens: of("ENGAGEMENT", "DETAIL_OPENED"),
      comparisons: of("ENGAGEMENT", "COMPARISON_STARTED"),
      negotiations: of("ENGAGEMENT", "NEGOTIATION_STARTED"),
      purchaseReviews: of("ENGAGEMENT", "PURCHASE_REVIEW_STARTED"),
      ordersAttributed: orders,
      conversionRate: engagements ? `${Math.round((orders / engagements) * 100)}%` : "—",
      ...(row.budgetMinor != null ? { budgetLabel: f(row.budgetMinor), remainingLabel: f(row.budgetMinor - row.spentMinor - row.releasedMinor) } : {}),
      spentLabel: f(spent),
    };
  });
}

// ─── Demand capture («روح بِع لي») candidate selection ──────────────────────

export type DemandNeed = {
  tokens: string[];
  categoryId?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  city?: string;
  condition?: string;
};

/**
 * Paid candidates for a buyer's unmet need. Every hard gate runs first, in order: market,
 * listing published, seller active, moderation/policy, inventory, category, buyer
 * constraints (price, coarse city, condition), then campaign state and budget, then
 * relevance (share of need words in the listing's own text); only then the commercial
 * score. A sofa campaign can never answer a laptop need, and no bid lifts a listing over
 * a price limit.
 */
export async function demandCaptureCandidates(
  market: Market,
  need: DemandNeed,
  options: { excludeIds?: string[]; slots: number; minCoverage: number; viewerUserId?: string },
): Promise<{ listingId: string; promotionId: string }[]> {
  if (!need.tokens.length || options.slots <= 0 || !isSponsoredServingEnabled()) return [];
  const now = new Date();
  const campaigns = ((await db
    .select()
    .from(listingPromotions)
    .where(
      and(
        eq(listingPromotions.marketId, market.id),
        eq(listingPromotions.status, "ACTIVE"),
        inArray(listingPromotions.placementSnapshot, [...DEMAND_PLACEMENTS]),
        inArray(listingPromotions.paymentStatus, [...SERVING_PAYMENT_STATUSES]),
        lte(listingPromotions.startsAt, now),
        gt(listingPromotions.expiresAt, now),
      ),
    )) as PromotionRow[]).filter((row) => isServingCampaign(row, now));
  if (!campaigns.length) return [];
  const listingRows: { offer: OfferRowData; sellerStatus: string }[] = await db
    .select({ offer: offers, sellerStatus: users.status })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(inArray(offers.id, [...new Set(campaigns.map((row) => row.listingId))]));
  const exclude = new Set(options.excludeIds ?? []);
  const scored: { id: string; listingId: string; promotionId: string; score: number }[] = [];
  for (const row of listingRows) {
    const offer = row.offer;
    if (exclude.has(offer.id) || offer.sellerId === options.viewerUserId) continue;
    const eligible = await listingPromotionEligibility(offer, row.sellerStatus, market);
    if (!eligible.ok) continue;
    if (need.categoryId && eligible.categoryId !== need.categoryId) continue;
    const price = offer.unitPriceMinor;
    if ((need.maxPriceMinor !== undefined || need.minPriceMinor !== undefined) && price == null) continue;
    if (need.maxPriceMinor !== undefined && price! > need.maxPriceMinor) continue;
    if (need.minPriceMinor !== undefined && price! < need.minPriceMinor) continue;
    if (need.city && normalizeCity(String(offer.data.city ?? "")) !== normalizeCity(need.city)) continue;
    if (need.condition && String(offer.data.attributes?.condition ?? "") !== need.condition) continue;
    const text = [offer.data.title, offer.data.description, ...Object.values(offer.data.attributes ?? {})].filter(Boolean).join(" ");
    const coverage = needCoverage(need.tokens, text);
    if (coverage < options.minCoverage) continue;
    const campaign = representativeCampaign(campaigns, offer.id);
    if (!campaign) continue;
    scored.push({
      id: offer.id,
      listingId: offer.id,
      promotionId: campaign.id,
      score:
        coverage *
        sponsoredScore({
          organicIndex: 0,
          priorityWeight: campaign.priorityWeightSnapshot,
          unitChargeMinor: campaign.unitChargeMinorSnapshot,
          minorUnitScale: market.minorUnitScale,
          hasImage: Boolean(offer.data.imageUrl),
          descriptionLength: String(offer.data.description ?? "").length,
        }),
    });
  }
  return rankSponsored(scored, options.slots).map(({ listingId, promotionId }) => ({ listingId, promotionId }));
}

function normalizeCity(value: string) {
  return value.trim().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").toLowerCase();
}
