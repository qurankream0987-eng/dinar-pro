/**
 * Jassim Ads placement campaigns (owner decision 2026-11-28, closure).
 *
 * The seller chooses WHERE an ad appears: one placement or several in one campaign, each with its own
 * server price and duration (per-day placements take the number of days the policy allows). One
 * provider payment covers the whole campaign; every placement keeps its own delivery status.
 *
 * Not a second ad engine: the catalog is `promotion_products` (per market, currency, versioned and
 * audited); a listing campaign's placements are ordinary `listing_promotions` rows (same serving,
 * attribution, expiry and analytics); a store campaign's placements are `store_promotions` rows
 * served only in HERO/SIDEBAR. Prices are computed here and nowhere else: the client and the model
 * never price anything, and a total that changed since the seller's review is refused (PRICE_CHANGED).
 *
 * Paying is not serving: placements start only on a provider-signed, amount-matched payment event,
 * each checked again at that moment. A placement that can no longer run is recorded as paid and
 * flagged for refund review; the others run. Nothing is marked refunded without a signed refund.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import {
  billingWebhookEvents,
  businessProfiles,
  db,
  listingPromotions,
  markets,
  offers,
  promotionAttributions,
  promotionCampaigns,
  promotionProducts,
  storePromotionEvents,
  storePromotions,
  users,
} from "@workspace/db";
import { actorKey, trafficClass } from "./commercial-policy";
import { logger } from "./logger";
import { promotionBillingProvider, providerMoneyToMinor, type PromotionProviderEvent } from "./promotion-billing";
import { PROMOTION_PENDING_MINUTES, promotionPaymentAvailability, type PromotionWebhookResult } from "./promotion-payments";
import {
  CAMPAIGN_ONLY_TYPES,
  PLACEMENT_LABELS,
  PRODUCT_TYPE_LABELS,
  commercialProducts,
  effectiveProduct,
  formatMinor,
  listingPromotionEligibility,
} from "./promotions";
import type { marketFor } from "./markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
type ProductRow = typeof promotionProducts.$inferSelect;
type CampaignRow = typeof promotionCampaigns.$inferSelect;
type ListingItem = typeof listingPromotions.$inferSelect;
type StoreItem = typeof storePromotions.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 10;
const fail = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, code, expose: true, ...extra });

export type CampaignSubject = { kind: "LISTING"; listingId: string } | { kind: "STORE"; businessId: string };
export type CampaignItemRequest = { productId: string; days?: number };

/** Where each placement appears, in the seller's words (shown in the card). */
export const PLACEMENT_WHERE: Record<string, string> = {
  HERO: "الشريط الإعلاني الرئيسي أعلى الصفحة",
  SIDEBAR: "المساحة الإعلانية في الشريط الجانبي",
  FEATURED: "بطاقات المنتجات المميزة في قسم الإعلانات",
  VIP: "أولوية في الخانات الممولة (الرئيسي والجانبي والبحث)",
  SPONSORED_SEARCH: "إبراز ضمن نتائج البحث عندما يطابق بحث المشتري",
  SPONSORED_RECOMMENDATION: "اقتراح ممول داخل المحادثة عندما يطابق طلب المشتري",
  DEMAND: "«جاسم روح بيع لي»: تنبيه المشترين الذين طلبوا منتجًا مثله",
  REFRESH: "ظهور ممول مؤقت بعد تجديد الإعلان",
  SEARCH_AND_CHAT: "نتائج البحث والمحادثة",
};

const money = (minor: number, market: Market, currency = market.currencyCode) => `${formatMinor(minor, market.minorUnitScale)} ${currency}`;
const daysLabel = (days: number) => (days === 1 ? "يوم واحد" : days === 2 ? "يومان" : days <= 10 ? `${days} أيام` : `${days} يومًا`);

// ─── Subject (the listing or the store being promoted; owner-checked, 404 for strangers) ─────────

type ResolvedSubject = {
  kind: "LISTING" | "STORE";
  id: string;
  title: string;
  imagePath: string | null;
  categoryId: string | null;
  available: boolean;
  reason?: string;
};

async function resolveSubject(actorId: string, market: Market, subject: CampaignSubject, tx: any = db): Promise<ResolvedSubject> {
  if (subject.kind === "LISTING") {
    const [row] = await tx
      .select({ offer: offers, sellerStatus: users.status })
      .from(offers)
      .innerJoin(users, eq(users.id, offers.sellerId))
      .where(and(eq(offers.id, subject.listingId), eq(offers.sellerId, actorId)));
    if (!row || row.offer.marketId !== market.id) throw fail(404, "الإعلان غير موجود", "SUBJECT_NOT_FOUND");
    const eligible = await listingPromotionEligibility(row.offer, row.sellerStatus, market, tx);
    const title = typeof row.offer.data.title === "string" ? row.offer.data.title : "إعلان";
    const imagePath = listingImageOf(row.offer.data as { imageUrl?: unknown; imageUrls?: unknown });
    return eligible.ok
      ? { kind: "LISTING", id: row.offer.id, title, imagePath, categoryId: eligible.categoryId, available: true }
      : { kind: "LISTING", id: row.offer.id, title, imagePath, categoryId: null, available: false, reason: eligible.reason };
  }
  const [store] = await tx
    .select({ profile: businessProfiles, ownerStatus: users.status })
    .from(businessProfiles)
    .innerJoin(users, eq(users.id, businessProfiles.ownerUserId))
    .where(and(eq(businessProfiles.id, subject.businessId), eq(businessProfiles.ownerUserId, actorId)));
  if (!store || store.profile.marketId !== market.id) throw fail(404, "المتجر غير موجود", "SUBJECT_NOT_FOUND");
  const ok = store.profile.publicationStatus === "PUBLISHED" && store.ownerStatus === "ACTIVE";
  return {
    kind: "STORE",
    id: store.profile.id,
    title: store.profile.displayName,
    imagePath: await storeImage(store.profile.ownerUserId, market.id),
    categoryId: null,
    available: ok,
    ...(ok ? {} : { reason: store.ownerStatus !== "ACTIVE" ? "حساب صاحب المتجر غير نشط حاليًا" : "يجب أن يكون المتجر منشورًا وموثقًا للترويج له" }),
  };
}

/** The seller's own published store in this market, if any (for «روّج لمتجري»). */
export async function sellerStore(actorId: string, market: Market) {
  const [row] = await db
    .select()
    .from(businessProfiles)
    .where(and(eq(businessProfiles.ownerUserId, actorId), eq(businessProfiles.marketId, market.id)))
    .orderBy(desc(businessProfiles.createdAt))
    .limit(1);
  return row;
}

// ─── Catalog and quote ─────────────────────────────────────────────────────────────────────────

export type PlacementOption = {
  productId: string;
  placement: string;
  placementLabel: string;
  where: string;
  name: string;
  description: string;
  productTypeLabel: string;
  pricingUnit: "PERIOD" | "DAY";
  unitPriceLabel: string;
  priceMinor: number;
  defaultDays: number;
  minDays: number;
  maxDays: number;
  pricingVersion: number;
  available: boolean;
  reason?: string;
};

function priceFor(product: ProductRow, days: number) {
  return product.pricingUnit === "DAY" ? product.priceMinor * days : product.priceMinor;
}

function optionView(product: ProductRow, market: Market, available: boolean, reason?: string): PlacementOption {
  const day = product.pricingUnit === "DAY";
  return {
    productId: product.id,
    placement: product.placement,
    placementLabel: PLACEMENT_LABELS[product.placement] ?? product.placement,
    where: PLACEMENT_WHERE[product.placement] ?? product.placement,
    name: product.name,
    description: product.description,
    productTypeLabel: PRODUCT_TYPE_LABELS[product.productType] ?? product.productType,
    pricingUnit: day ? "DAY" : "PERIOD",
    unitPriceLabel: day ? `${money(product.priceMinor, market, product.currencyCode)} لليوم` : `${money(product.priceMinor, market, product.currencyCode)} لمدة ${daysLabel(product.durationDays)}`,
    priceMinor: product.priceMinor,
    defaultDays: product.durationDays,
    minDays: day ? product.minDays! : product.durationDays,
    maxDays: day ? product.maxDays! : product.durationDays,
    pricingVersion: product.pricingVersion,
    available,
    ...(reason ? { reason } : {}),
  };
}

/** Pending/live campaigns holding a slot of this placement product (abandoned checkouts excluded). */
async function usedCapacity(productId: string, tx: any): Promise<number> {
  const cutoff = new Date(Date.now() - PROMOTION_PENDING_MINUTES * 60_000).toISOString();
  const live = sql`((status IN ('ACTIVE', 'PAUSED') AND expires_at > now()) OR (status = 'PENDING_PAYMENT' AND created_at > ${cutoff}))`;
  const [a] = await tx.select({ n: sql<number>`count(*)::int` }).from(listingPromotions).where(and(eq(listingPromotions.productId, productId), live));
  const [b] = await tx.select({ n: sql<number>`count(*)::int` }).from(storePromotions).where(and(eq(storePromotions.productId, productId), live));
  return (a?.n ?? 0) + (b?.n ?? 0);
}

/** Whether this subject already has a pending or live campaign on this placement (no boost stacking). */
async function subjectHolds(subject: ResolvedSubject, placement: string, tx: any): Promise<boolean> {
  const cutoff = new Date(Date.now() - PROMOTION_PENDING_MINUTES * 60_000);
  if (subject.kind === "LISTING") {
    const rows = await tx
      .select({ status: listingPromotions.status, createdAt: listingPromotions.createdAt, expiresAt: listingPromotions.expiresAt, source: listingPromotions.paymentSource })
      .from(listingPromotions)
      .where(and(eq(listingPromotions.listingId, subject.id), eq(listingPromotions.placementSnapshot, placement), inArray(listingPromotions.status, ["PENDING_PAYMENT", "ACTIVE", "PAUSED"])));
    return rows.some((row: any) => (row.status === "PENDING_PAYMENT" ? row.source !== "PROVIDER_DIRECT" || row.createdAt > cutoff : row.expiresAt > new Date()));
  }
  const rows = await tx
    .select({ status: storePromotions.status, createdAt: storePromotions.createdAt, expiresAt: storePromotions.expiresAt })
    .from(storePromotions)
    .where(and(eq(storePromotions.businessId, subject.id), eq(storePromotions.placementSnapshot, placement), inArray(storePromotions.status, ["PENDING_PAYMENT", "ACTIVE", "PAUSED"])));
  return rows.some((row: any) => (row.status === "PENDING_PAYMENT" ? row.createdAt > cutoff : row.expiresAt > new Date()));
}

async function placementAvailability(product: ProductRow, subject: ResolvedSubject, tx: any): Promise<string | undefined> {
  if (!subject.available) return subject.reason ?? "غير متاح للترويج";
  if (!(product.subjectKinds ?? ["LISTING"]).includes(subject.kind)) return subject.kind === "STORE" ? "هذا الموضع يعرض منتجات فقط، لا المتاجر" : "هذا الموضع للمتاجر فقط";
  if (subject.kind === "LISTING" && product.categoryId && product.categoryId !== subject.categoryId) return "هذا الموضع لا يخص فئة إعلانك";
  if ((product.placement === "HERO" || product.placement === "SIDEBAR") && !subject.imagePath)
    return subject.kind === "STORE" ? "أضف صورة لمنتج واحد على الأقل في متجرك؛ هذا الموضع يعرض صورة" : "أضف صورة للمنتج أولًا؛ هذا الموضع يعرض صورة المنتج";
  if (await subjectHolds(subject, product.placement, tx)) return "لديك حملة قائمة أو دفع قيد الإتمام على هذا الموضع";
  if (product.capacity != null && (await usedCapacity(product.id, tx)) >= product.capacity) return "هذا الموضع ممتلئ حاليًا في سوقك";
  return undefined;
}

/** The placements this seller can buy now for this subject, each with its own price and days. */
export async function placementCatalog(actorId: string, market: Market, subject: CampaignSubject) {
  const resolved = await resolveSubject(actorId, market, subject);
  const products = (await commercialProducts(market, { campaign: true })).filter(
    (row) => row.placement !== "NONE" && row.chargingMode === "FIXED" && row.productType !== "REFRESH_LISTING" && (row.subjectKinds ?? ["LISTING"]).includes(resolved.kind),
  );
  const options: PlacementOption[] = [];
  for (const product of products) {
    if (resolved.kind === "LISTING" && product.categoryId && product.categoryId !== resolved.categoryId) continue;
    const reason = await placementAvailability(product, resolved, db);
    options.push(optionView(product, market, !reason, reason));
  }
  return { subject: { kind: resolved.kind, id: resolved.id, title: resolved.title, imagePath: resolved.imagePath, available: resolved.available, reason: resolved.reason }, options };
}

export type CampaignQuoteLine = {
  productId: string;
  placement: string;
  where: string;
  name: string;
  days: number;
  unitPriceLabel: string;
  priceMinor: number;
  priceLabel: string;
  pricingVersion: number;
  available: boolean;
  reason?: string;
};
export type CampaignQuote = {
  subject: { kind: "LISTING" | "STORE"; id: string; title: string };
  lines: CampaignQuoteLine[];
  totalMinor: number;
  totalLabel: string;
  currencyCode: string;
  ok: boolean;
  /** A short fingerprint of what was priced (product versions, days, total); confirmation must match it. */
  quoteKey: string;
};

function normaliseItems(items: CampaignItemRequest[]) {
  if (!Array.isArray(items) || items.length < 1) throw fail(400, "اختر موضعًا إعلانيًا واحدًا على الأقل", "NO_PLACEMENT");
  if (items.length > MAX_ITEMS) throw fail(400, `يمكن اختيار ${MAX_ITEMS} مواضع كحد أقصى`, "TOO_MANY_PLACEMENTS");
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.productId)) throw fail(400, "الموضع نفسه مختار مرتين", "DUPLICATE_PLACEMENT");
    ids.add(item.productId);
  }
}

/** Server price of a selection. Never trusts a client amount; recomputed again at confirmation. */
export async function quoteCampaign(input: { actorId: string; market: Market; subject: CampaignSubject; items: CampaignItemRequest[] }, tx: any = db): Promise<CampaignQuote> {
  normaliseItems(input.items);
  const subject = await resolveSubject(input.actorId, input.market, input.subject, tx);
  const lines: CampaignQuoteLine[] = [];
  const placements = new Set<string>();
  for (const item of input.items) {
    const product = await effectiveProduct(input.market, item.productId, tx, { campaign: true }).catch(() => undefined);
    if (!product || product.placement === "NONE" || product.chargingMode !== "FIXED")
      throw fail(409, "أحد المواضع المختارة لم يعد متاحًا للشراء", "PLACEMENT_NOT_FOR_SALE");
    if (placements.has(product.placement)) throw fail(400, "اخترت الموضع نفسه بسعرين مختلفين؛ اختر واحدًا", "DUPLICATE_PLACEMENT");
    placements.add(product.placement);
    const day = product.pricingUnit === "DAY";
    const days = item.days ?? product.durationDays;
    if (!Number.isInteger(days)) throw fail(400, "عدد الأيام غير صالح", "DAYS_INVALID");
    if (!day && days !== product.durationDays) throw fail(400, `مدة «${product.name}» ثابتة: ${daysLabel(product.durationDays)}`, "DAYS_FIXED");
    if (day && (days < product.minDays! || days > product.maxDays!)) throw fail(400, `مدة «${product.name}» بين ${product.minDays} و${product.maxDays} يومًا`, "DAYS_OUT_OF_RANGE");
    const reason = await placementAvailability(product, subject, tx);
    const priceMinor = priceFor(product, days);
    lines.push({
      productId: product.id,
      placement: product.placement,
      where: PLACEMENT_WHERE[product.placement] ?? product.placement,
      name: product.name,
      days,
      unitPriceLabel: optionView(product, input.market, true).unitPriceLabel,
      priceMinor,
      priceLabel: money(priceMinor, input.market),
      pricingVersion: product.pricingVersion,
      available: !reason,
      ...(reason ? { reason } : {}),
    });
  }
  const totalMinor = lines.reduce((sum, line) => sum + line.priceMinor, 0);
  const quoteKey = createHash("sha256")
    .update(JSON.stringify([subject.kind, subject.id, totalMinor, lines.map((line) => [line.productId, line.pricingVersion, line.days, line.priceMinor])]))
    .digest("hex")
    .slice(0, 24);
  return {
    subject: { kind: subject.kind, id: subject.id, title: subject.title },
    lines,
    totalMinor,
    totalLabel: money(totalMinor, input.market),
    currencyCode: input.market.currencyCode,
    ok: lines.every((line) => line.available),
    quoteKey,
  };
}

// ─── Checkout: one campaign, one provider payment ───────────────────────────────────────────────

export type CampaignCheckout = { created: boolean; campaignId: string; checkoutUrl: string; amountLabel: string; providerName: string; note: string; quote: CampaignQuote };

/** Frees slots held by this seller's own checkouts that were never paid within the pending window. */
async function releaseAbandoned(actorId: string, tx: any) {
  const cutoff = new Date(Date.now() - PROMOTION_PENDING_MINUTES * 60_000);
  const stale: CampaignRow[] = await tx
    .select()
    .from(promotionCampaigns)
    .where(and(eq(promotionCampaigns.sellerId, actorId), eq(promotionCampaigns.status, "PENDING_PAYMENT"), lte(promotionCampaigns.createdAt, cutoff)));
  if (!stale.length) return;
  const ids = stale.map((row) => row.id);
  const now = new Date();
  await tx.update(listingPromotions).set({ status: "CANCELLED", endedAt: now, updatedAt: now }).where(and(inArray(listingPromotions.campaignId, ids), eq(listingPromotions.status, "PENDING_PAYMENT")));
  await tx.update(storePromotions).set({ status: "CANCELLED", endedAt: now, updatedAt: now }).where(and(inArray(storePromotions.campaignId, ids), eq(storePromotions.status, "PENDING_PAYMENT")));
  await tx.update(promotionCampaigns).set({ status: "CANCELLED", failureCode: "ABANDONED_CHECKOUT", updatedAt: now }).where(inArray(promotionCampaigns.id, ids));
}

export async function startCampaignCheckout(input: {
  actorId: string;
  market: Market;
  subject: CampaignSubject;
  items: CampaignItemRequest[];
  adCopy?: string;
  /** The quote the seller reviewed; a different server price now is refused, never silently charged. */
  quoteKey: string;
  idempotencyKey: string;
}): Promise<CampaignCheckout> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw fail(400, "مفتاح عدم التكرار غير صالح", "IDEMPOTENCY_KEY_INVALID");
  const adCopy = (input.adCopy ?? "").trim().replace(/\s+/g, " ");
  if (adCopy.length > 280) throw fail(400, "النص الإعلاني أطول من 280 حرفًا", "AD_COPY_TOO_LONG");
  const availability = await promotionPaymentAvailability(input.market);
  if (!availability.available) throw fail(409, availability.reason, `PROMOTION_PAYMENT_${availability.code}`);
  const provider = promotionBillingProvider(availability.providerKey)!;
  const reserved = await db.transaction(async (tx) => {
    const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId)).for("update");
    if (actor?.status !== "ACTIVE") throw fail(403, "حسابك مقيّد حاليًا ولا يمكن شراء ترويج.", "ACTOR_RESTRICTED");
    const [prior] = await tx.select().from(promotionCampaigns).where(and(eq(promotionCampaigns.sellerId, input.actorId), eq(promotionCampaigns.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      const subjectId = input.subject.kind === "LISTING" ? input.subject.listingId : input.subject.businessId;
      if ((prior.listingId ?? prior.businessId) !== subjectId) throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      return { campaign: prior as CampaignRow, created: false, quote: undefined as CampaignQuote | undefined };
    }
    await releaseAbandoned(input.actorId, tx);
    // Serialise competing purchases of the same capacity-limited placements.
    for (const item of input.items) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`jassim-placement:${item.productId}`}))`);
    const quote = await quoteCampaign({ actorId: input.actorId, market: input.market, subject: input.subject, items: input.items }, tx);
    if (quote.quoteKey !== input.quoteKey) throw fail(409, "تغيّر السعر أو الشروط منذ مراجعتك. راجع الإجمالي الجديد قبل التأكيد.", "PRICE_CHANGED", { quote });
    if (!quote.ok) throw fail(409, quote.lines.find((line) => !line.available)?.reason ?? "أحد المواضع غير متاح", "PLACEMENT_UNAVAILABLE", { quote });
    const now = new Date();
    const id = randomUUID();
    const [campaign] = await tx
      .insert(promotionCampaigns)
      .values({
        id,
        sellerId: input.actorId,
        marketId: input.market.id,
        subjectKind: quote.subject.kind,
        listingId: quote.subject.kind === "LISTING" ? quote.subject.id : null,
        businessId: quote.subject.kind === "STORE" ? quote.subject.id : null,
        adCopy,
        currencyCode: quote.currencyCode,
        totalMinor: quote.totalMinor,
        itemsCount: quote.lines.length,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    for (const line of quote.lines) {
      const product = await effectiveProduct(input.market, line.productId, tx, { campaign: true });
      const window = { startsAt: now, expiresAt: new Date(now.getTime() + line.days * DAY_MS) };
      if (quote.subject.kind === "LISTING")
        await tx.insert(listingPromotions).values({
          id: randomUUID(),
          campaignId: id,
          listingId: quote.subject.id,
          sellerId: input.actorId,
          marketId: input.market.id,
          productId: product.id,
          productNameSnapshot: product.name,
          // HERO/SIDEBAR products may be market-wide; the snapshot keeps the listing's own category.
          categoryIdSnapshot: product.categoryId ?? (await resolveSubject(input.actorId, input.market, input.subject, tx)).categoryId!,
          priceMinorSnapshot: line.priceMinor,
          currencyCodeSnapshot: product.currencyCode,
          placementSnapshot: product.placement,
          durationDaysSnapshot: line.days,
          status: "PENDING_PAYMENT",
          paymentMode: "PROVIDER_LIVE",
          paymentStatus: "PROVIDER_PENDING",
          paymentSource: "PROVIDER_DIRECT",
          productTypeSnapshot: product.productType,
          chargingModeSnapshot: product.chargingMode,
          pricingVersionSnapshot: product.pricingVersion,
          refundPolicySnapshot: product.refundPolicy,
          priorityWeightSnapshot: product.priorityWeight,
          taxPolicyVersion: product.taxPolicyVersion,
          ...window,
        });
      else
        await tx.insert(storePromotions).values({
          id: randomUUID(),
          campaignId: id,
          businessId: quote.subject.id,
          sellerId: input.actorId,
          marketId: input.market.id,
          productId: product.id,
          productNameSnapshot: product.name,
          placementSnapshot: product.placement,
          priceMinorSnapshot: line.priceMinor,
          currencyCodeSnapshot: product.currencyCode,
          durationDaysSnapshot: line.days,
          pricingVersionSnapshot: product.pricingVersion,
          priorityWeightSnapshot: product.priorityWeight,
          ...window,
        });
    }
    return { campaign: campaign as CampaignRow, created: true, quote };
  });
  let campaign = reserved.campaign;
  const quote = reserved.quote ?? (await campaignQuoteFromRows(campaign, input.market));
  if (campaign.status !== "PENDING_PAYMENT") throw fail(409, "هذه الحملة لم تعد بانتظار الدفع", "CAMPAIGN_NOT_PENDING", { campaignId: campaign.id });
  let checkoutUrl: string;
  if (campaign.paymentReference) checkoutUrl = await provider.checkoutUrl(campaign.paymentReference);
  else {
    let checkout;
    try {
      checkout = await provider.createCheckout({
        promotionId: campaign.id,
        userId: input.actorId,
        currencyCode: campaign.currencyCode,
        priceMinor: campaign.totalMinor,
        scale: input.market.minorUnitScale,
        productRef: `campaign-${campaign.itemsCount}`,
        title: `حملة ترويج «${quote.subject.title}» (${campaign.itemsCount} ${campaign.itemsCount === 1 ? "موضع" : "مواضع"})`,
      });
    } catch (error) {
      if (reserved.created) await cancelPending(campaign.id, "CHECKOUT_NOT_OPENED");
      throw error;
    }
    const [updated] = await db
      .update(promotionCampaigns)
      .set({ paymentProviderKey: provider.key, paymentReference: checkout.checkoutId, updatedAt: new Date() })
      .where(eq(promotionCampaigns.id, campaign.id))
      .returning();
    campaign = updated as CampaignRow;
    checkoutUrl = checkout.checkoutUrl;
  }
  logger.info({ event: "promotion_campaign_checkout", provider: provider.key, marketId: input.market.id, items: campaign.itemsCount, created: reserved.created }, "promotion campaign checkout opened");
  return {
    created: reserved.created,
    campaignId: campaign.id,
    checkoutUrl,
    amountLabel: money(campaign.totalMinor, input.market),
    providerName: provider.displayName,
    note: `الدفع مرة واحدة لكل المواضع في صفحة ${provider.displayName} الآمنة. لم يُخصم شيء بعد. يبدأ كل موضع فقط بعد التأكيد الموقّع للدفع، وينتهي تلقائيًا بعد مدته، دون تجديد تلقائي.`,
    quote,
  };
}

async function cancelPending(campaignId: string, code: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(listingPromotions).set({ status: "CANCELLED", endedAt: now, updatedAt: now }).where(and(eq(listingPromotions.campaignId, campaignId), eq(listingPromotions.status, "PENDING_PAYMENT")));
    await tx.update(storePromotions).set({ status: "CANCELLED", endedAt: now, updatedAt: now }).where(and(eq(storePromotions.campaignId, campaignId), eq(storePromotions.status, "PENDING_PAYMENT")));
    await tx.update(promotionCampaigns).set({ status: "CANCELLED", failureCode: code, updatedAt: now }).where(and(eq(promotionCampaigns.id, campaignId), eq(promotionCampaigns.status, "PENDING_PAYMENT")));
  });
}

async function campaignItems(campaignId: string, tx: any = db): Promise<{ listing: ListingItem[]; store: StoreItem[] }> {
  const [listing, store] = await Promise.all([
    tx.select().from(listingPromotions).where(eq(listingPromotions.campaignId, campaignId)).orderBy(asc(listingPromotions.createdAt), asc(listingPromotions.id)),
    tx.select().from(storePromotions).where(eq(storePromotions.campaignId, campaignId)).orderBy(asc(storePromotions.createdAt), asc(storePromotions.id)),
  ]);
  return { listing, store };
}

async function campaignQuoteFromRows(campaign: CampaignRow, market: Market): Promise<CampaignQuote> {
  const { listing, store } = await campaignItems(campaign.id);
  const lines = [...listing, ...store].map((row) => ({
    productId: row.productId,
    placement: row.placementSnapshot,
    where: PLACEMENT_WHERE[row.placementSnapshot] ?? row.placementSnapshot,
    name: row.productNameSnapshot,
    days: row.durationDaysSnapshot,
    unitPriceLabel: money(row.priceMinorSnapshot, market),
    priceMinor: row.priceMinorSnapshot,
    priceLabel: money(row.priceMinorSnapshot, market),
    pricingVersion: row.pricingVersionSnapshot,
    available: true,
  }));
  return { subject: { kind: campaign.subjectKind as "LISTING" | "STORE", id: (campaign.listingId ?? campaign.businessId)!, title: await subjectTitle(campaign) }, lines, totalMinor: campaign.totalMinor, totalLabel: money(campaign.totalMinor, market), currencyCode: campaign.currencyCode, ok: true, quoteKey: "" };
}

async function subjectTitle(campaign: Pick<CampaignRow, "listingId" | "businessId">) {
  if (campaign.listingId) {
    const [row] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, campaign.listingId));
    return typeof row?.data?.title === "string" ? row.data.title : "إعلان";
  }
  const [row] = await db.select({ name: businessProfiles.displayName }).from(businessProfiles).where(eq(businessProfiles.id, campaign.businessId!));
  return row?.name ?? "متجر";
}

// ─── Signed provider events for a campaign (called from applyPromotionProviderEvent) ──────────

export async function isCampaignId(id: string, tx: any = db) {
  const [row] = await tx.select({ id: promotionCampaigns.id }).from(promotionCampaigns).where(eq(promotionCampaigns.id, id));
  return !!row;
}

/** Whether one placement can still start now (re-checked at payment time, never trusted from checkout). */
async function itemCanStart(item: { productId: string; marketId: string }, campaign: CampaignRow, tx: any): Promise<string | undefined> {
  const [product] = await tx.select().from(promotionProducts).where(eq(promotionProducts.id, item.productId));
  if (!product?.enabled) return "PLACEMENT_WITHDRAWN";
  if (campaign.subjectKind === "LISTING") {
    const [row] = await tx.select({ offer: offers, sellerStatus: users.status }).from(offers).innerJoin(users, eq(users.id, offers.sellerId)).where(eq(offers.id, campaign.listingId!));
    if (row?.offer.status !== "PUBLISHED" || row.sellerStatus !== "ACTIVE") return "LISTING_UNAVAILABLE";
    return undefined;
  }
  const [store] = await tx.select({ profile: businessProfiles, ownerStatus: users.status }).from(businessProfiles).innerJoin(users, eq(users.id, businessProfiles.ownerUserId)).where(eq(businessProfiles.id, campaign.businessId!));
  if (store?.profile.publicationStatus !== "PUBLISHED" || store.ownerStatus !== "ACTIVE") return "STORE_UNAVAILABLE";
  return undefined;
}

export async function applyCampaignProviderEvent(event: PromotionProviderEvent): Promise<PromotionWebhookResult> {
  const demandItems: { id: string; marketId: string }[] = [];
  const result = await db.transaction(async (tx) => {
    const done = async (status: "APPLIED" | "IGNORED" | "REJECTED", failureCode: string | null, apply?: () => Promise<void>) => {
      const [inserted] = await tx
        .insert(billingWebhookEvents)
        .values({ id: randomUUID(), providerKey: event.providerKey, providerEventId: event.eventId, eventType: event.eventType.slice(0, 80), payloadDigest: event.digest, status, failureCode, processedAt: new Date() })
        .onConflictDoNothing()
        .returning();
      if (!inserted) return { status: 200, outcome: status, failureCode, duplicate: true };
      if (apply) await apply();
      if (status !== "APPLIED" || failureCode) logger.warn({ event: "promotion_campaign_payment_event", provider: event.providerKey, type: event.type, failureCode }, "campaign payment event recorded for review");
      return { status: 200, outcome: status, failureCode, duplicate: false };
    };
    const [campaign] = (await tx.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, event.promotionId)).for("update")) as CampaignRow[];
    if (!campaign) return done("REJECTED", "UNKNOWN_PROMOTION");
    if (campaign.paymentProviderKey !== event.providerKey) return done("REJECTED", "PROVIDER_MISMATCH");
    const payment = event.facts;
    if (payment.accountId && payment.accountId !== event.expectedAccountId) return done("REJECTED", "ACCOUNT_MISMATCH");
    if (payment.ownerUserId !== campaign.sellerId) return done("REJECTED", "OWNER_MISMATCH");
    const [market] = await tx.select({ scale: markets.minorUnitScale }).from(markets).where(eq(markets.id, campaign.marketId));
    const scale = market?.scale;
    const now = new Date();
    const { listing, store } = await campaignItems(campaign.id, tx);

    if (event.type === "PAID") {
      if (payment.status !== "paid") return done("IGNORED", "PROVIDER_STATE_NOT_PAID");
      const amount = payment.subtotal && scale !== undefined ? providerMoneyToMinor(payment.subtotal, scale) : undefined;
      if (!payment.subtotal || payment.subtotal.currency.toUpperCase() !== campaign.currencyCode || amount !== campaign.totalMinor) return done("REJECTED", "AMOUNT_MISMATCH_REVIEW");
      if (campaign.paymentStatus === "PROVIDER_PAID") return done("IGNORED", "ALREADY_PAID_SECOND_PAYMENT_REVIEW");
      if (campaign.paymentStatus === "PROVIDER_DISPUTED" || campaign.paymentStatus === "PROVIDER_REFUNDED") return done("IGNORED", "ALREADY_SETTLED_PAYMENT_REVIEW");
      if (campaign.status !== "PENDING_PAYMENT") return done("REJECTED", "PAID_AFTER_CANCEL_REFUND_REVIEW");
      // Each placement is checked again now; one that cannot run never claims to.
      const outcomes: { kind: "LISTING" | "STORE"; row: ListingItem | StoreItem; failure?: string }[] = [];
      for (const row of listing) outcomes.push({ kind: "LISTING", row, failure: await itemCanStart(row, campaign, tx) });
      for (const row of store) outcomes.push({ kind: "STORE", row, failure: await itemCanStart(row, campaign, tx) });
      const failed = outcomes.filter((item) => item.failure);
      const refundReview = failed.reduce((sum, item) => sum + item.row.priceMinorSnapshot, 0);
      const status = failed.length === 0 ? "ACTIVE" : failed.length === outcomes.length ? "CANCELLED" : "PARTIAL";
      return done("APPLIED", failed.length ? "PLACEMENT_UNAVAILABLE_REFUND_REVIEW" : null, async () => {
        for (const item of outcomes) {
          const table = item.kind === "LISTING" ? listingPromotions : storePromotions;
          const values = item.failure
            ? { status: "CANCELLED", paymentStatus: "PROVIDER_PAID", endedAt: now, updatedAt: now, ...(item.kind === "STORE" ? { failureCode: item.failure } : {}) }
            : { status: "ACTIVE", paymentStatus: "PROVIDER_PAID", startsAt: now, expiresAt: new Date(now.getTime() + item.row.durationDaysSnapshot * DAY_MS), updatedAt: now };
          await tx.update(table).set(values as any).where(eq(table.id, item.row.id));
          if (!item.failure && item.kind === "LISTING" && item.row.placementSnapshot === "DEMAND") demandItems.push({ id: item.row.id, marketId: campaign.marketId });
        }
        await tx
          .update(promotionCampaigns)
          .set({ paymentStatus: "PROVIDER_PAID", status, refundReviewMinor: refundReview, failureCode: failed.length ? `PLACEMENT_UNAVAILABLE:${failed.map((item) => item.failure).join(",")}`.slice(0, 200) : null, updatedAt: now })
          .where(eq(promotionCampaigns.id, campaign.id));
        logger.info({ event: "promotion_campaign_paid", provider: event.providerKey, started: outcomes.length - failed.length, refundReview: failed.length }, "campaign placements started from a verified payment");
      });
    }

    if (event.type === "FAILED") return done("IGNORED", payment.status === "paid" ? "PROVIDER_STATE_PAID" : "ATTEMPT_FAILED_RETRY_ALLOWED");

    if (event.type === "REFUNDED") {
      const refunded = payment.refunded && scale !== undefined ? providerMoneyToMinor(payment.refunded, scale) : undefined;
      const total = payment.total && scale !== undefined ? providerMoneyToMinor(payment.total, scale) : undefined;
      if (!refunded || !total) return done("REJECTED", "AMOUNT_MISMATCH_REVIEW");
      if (campaign.paymentStatus === "PROVIDER_REFUNDED") return done("IGNORED", "ALREADY_REFUNDED");
      const unserved = [...listing.map((row) => ({ kind: "LISTING" as const, row })), ...store.map((row) => ({ kind: "STORE" as const, row }))].filter((item) => item.row.status === "CANCELLED" && item.row.paymentStatus === "PROVIDER_PAID");
      // Refund of exactly the placements that never ran: those are refunded, the running ones keep serving.
      if (refunded < total) {
        if (campaign.refundReviewMinor > 0 && refunded === campaign.refundReviewMinor)
          return done("APPLIED", "UNSERVED_PLACEMENTS_REFUNDED", async () => {
            for (const item of unserved) {
              const table = item.kind === "LISTING" ? listingPromotions : storePromotions;
              await tx.update(table).set({ paymentStatus: "PROVIDER_REFUNDED", updatedAt: now } as any).where(eq(table.id, item.row.id));
            }
            await tx.update(promotionCampaigns).set({ refundReviewMinor: 0, updatedAt: now }).where(eq(promotionCampaigns.id, campaign.id));
          });
        return done("IGNORED", "PARTIAL_REFUND_FOR_REVIEW");
      }
      return done("APPLIED", null, async () => {
        for (const [table, rows] of [[listingPromotions, listing], [storePromotions, store]] as const)
          for (const row of rows as (ListingItem | StoreItem)[]) {
            const live = ["ACTIVE", "PAUSED", "PENDING_PAYMENT"].includes(row.status);
            await tx.update(table).set({ paymentStatus: "PROVIDER_REFUNDED", ...(live ? { status: "CANCELLED", endedAt: now } : {}), updatedAt: now } as any).where(eq(table.id, row.id));
          }
        await tx.update(promotionCampaigns).set({ paymentStatus: "PROVIDER_REFUNDED", status: campaign.status === "PENDING_PAYMENT" ? "CANCELLED" : "ENDED", refundReviewMinor: 0, updatedAt: now }).where(eq(promotionCampaigns.id, campaign.id));
      });
    }

    // DISPUTED: disputed money never serves. Pending → cancelled; running placements pause.
    if (campaign.status === "PENDING_PAYMENT")
      return done("APPLIED", null, async () => {
        for (const [table, rows] of [[listingPromotions, listing], [storePromotions, store]] as const)
          for (const row of rows as (ListingItem | StoreItem)[])
            await tx.update(table).set({ paymentStatus: "PROVIDER_DISPUTED", status: "CANCELLED", endedAt: now, updatedAt: now } as any).where(eq(table.id, row.id));
        await tx.update(promotionCampaigns).set({ paymentStatus: "PROVIDER_DISPUTED", status: "CANCELLED", updatedAt: now }).where(eq(promotionCampaigns.id, campaign.id));
      });
    if (campaign.paymentStatus !== "PROVIDER_PAID") return done("IGNORED", "DISPUTE_RECORDED_FOR_REVIEW");
    return done("APPLIED", null, async () => {
      for (const row of listing)
        await tx.update(listingPromotions).set({ paymentStatus: "PROVIDER_DISPUTED", ...(row.status === "ACTIVE" ? { status: "PAUSED", pausedAt: now } : {}), updatedAt: now }).where(eq(listingPromotions.id, row.id));
      for (const row of store)
        await tx.update(storePromotions).set({ paymentStatus: "PROVIDER_DISPUTED", ...(row.status === "ACTIVE" ? { status: "PAUSED" } : {}), updatedAt: now }).where(eq(storePromotions.id, row.id));
      await tx.update(promotionCampaigns).set({ paymentStatus: "PROVIDER_DISPUTED", updatedAt: now }).where(eq(promotionCampaigns.id, campaign.id));
    });
  });
  if (demandItems.length) {
    const { matchDemandCampaign } = await import("./demand-requests");
    const { resolveMarket } = await import("./markets");
    for (const item of demandItems) {
      const [marketRow] = await db.select().from(markets).where(eq(markets.id, item.marketId));
      const market = marketRow ? await resolveMarket(marketRow).catch(() => undefined) : undefined;
      if (market) await matchDemandCampaign(item.id, market).catch((error) => logger.warn({ event: "demand_match_failed", err: error }, "demand match failed"));
    }
  }
  return result;
}

// ─── Serving: store placements in HERO/SIDEBAR ──────────────────────────────────────────────────

export function storeItemServes(row: Pick<StoreItem, "status" | "paymentStatus" | "startsAt" | "expiresAt">, now: Date) {
  return row.status === "ACTIVE" && row.paymentStatus === "PROVIDER_PAID" && row.startsAt.getTime() <= now.getTime() && row.expiresAt.getTime() > now.getTime();
}

/** The cover photo of the store owner's latest published listing with a photo in this market. */
export async function storeImage(ownerUserId: string, marketId: string): Promise<string | null> {
  const rows = await db.select({ data: offers.data }).from(offers).where(and(eq(offers.sellerId, ownerUserId), eq(offers.marketId, marketId), eq(offers.status, "PUBLISHED"))).orderBy(desc(offers.createdAt)).limit(20);
  for (const row of rows) {
    const image = listingImageOf(row.data as { imageUrl?: unknown; imageUrls?: unknown });
    if (image) return image;
  }
  return null;
}
function listingImageOf(data: { imageUrl?: unknown; imageUrls?: unknown }): string | null {
  if (typeof data.imageUrl === "string" && data.imageUrl.trim()) return data.imageUrl;
  const first = Array.isArray(data.imageUrls) ? data.imageUrls.find((item) => typeof item === "string" && item.trim()) : undefined;
  return typeof first === "string" ? first : null;
}

export async function servingStoreItems(marketId: string, placement: "HERO" | "SIDEBAR", now: Date, viewerId?: string) {
  const rows: StoreItem[] = await db
    .select()
    .from(storePromotions)
    .where(and(eq(storePromotions.marketId, marketId), eq(storePromotions.placementSnapshot, placement), eq(storePromotions.status, "ACTIVE"), eq(storePromotions.paymentStatus, "PROVIDER_PAID")))
    .limit(50);
  const live = rows.filter((row) => storeItemServes(row, now) && row.sellerId !== viewerId);
  if (!live.length) return [];
  const stores = await db
    .select({ profile: businessProfiles, ownerStatus: users.status })
    .from(businessProfiles)
    .innerJoin(users, eq(users.id, businessProfiles.ownerUserId))
    .where(inArray(businessProfiles.id, [...new Set(live.map((row) => row.businessId))]));
  const ok = new Map(stores.filter((s) => s.profile.publicationStatus === "PUBLISHED" && s.ownerStatus === "ACTIVE").map((s) => [s.profile.id, s.profile]));
  const out: { row: StoreItem; profile: typeof businessProfiles.$inferSelect; imagePath: string }[] = [];
  for (const row of live) {
    const profile = ok.get(row.businessId);
    if (!profile) continue;
    // A store card shows a product photo from the store; a store with no photo is not shown.
    const imagePath = await storeImage(profile.ownerUserId, marketId);
    if (imagePath) out.push({ row, profile, imagePath });
  }
  return out;
}

/** One impression per store placement, viewer and day (never billable; the viewer is an HMAC key). */
export async function recordStoreEvent(storePromotionId: string, placement: string, viewerId: string | undefined, eventType: "IMPRESSION" | "ENGAGEMENT", now = new Date()) {
  const viewerKey = viewerId ? actorKey(viewerId) : "anonymous";
  const day = now.toISOString().slice(0, 10);
  const dedupKey = createHash("sha256").update(`${storePromotionId}|${placement}|${viewerKey}|${eventType}|${viewerId ? day : now.toISOString()}`).digest("hex");
  await db.insert(storePromotionEvents).values({ id: randomUUID(), storePromotionId, placement, viewerKey, eventType, dedupKey, trafficClass: trafficClass() }).onConflictDoNothing();
}

export async function storeEngagement(storePromotionId: string, viewerId: string | undefined) {
  const [row] = await db.select().from(storePromotions).where(eq(storePromotions.id, storePromotionId));
  if (!row || !storeItemServes(row, new Date())) throw fail(404, "الإعلان غير موجود", "NOT_FOUND");
  if (row.sellerId !== viewerId) await recordStoreEvent(row.id, row.placementSnapshot, viewerId, "ENGAGEMENT");
  return { path: `/business/${encodeURIComponent(row.businessId)}` };
}

// ─── Results: per placement and per campaign, from recorded events only ─────────────────────────

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "بانتظار الدفع",
  ACTIVE: "نشط",
  PARTIAL: "نشط جزئيًا",
  PAUSED: "متوقف مؤقتًا",
  EXPIRED: "انتهى",
  ENDED: "انتهى",
  CANCELLED: "ملغى",
  PAYMENT_FAILED: "فشل الدفع",
};

export type CampaignPlacementResult = {
  placement: string;
  where: string;
  name: string;
  status: string;
  statusLabel: string;
  note: string;
  days: number;
  priceLabel: string;
  startsAt: string | null;
  expiresAt: string | null;
  remainingDays: number | null;
  impressions: number;
  clicks: number;
  engagements: number;
  /** null: no reliable attribution exists for this placement (store cards); never shown as 0. */
  orders: number | null;
  ordersNote?: string;
};
export type CampaignResult = {
  campaignId: string;
  subjectKind: "LISTING" | "STORE";
  subjectTitle: string;
  subjectImage: string | null;
  status: string;
  statusLabel: string;
  paymentNote: string;
  totalLabel: string;
  refundReviewLabel: string | null;
  adCopy: string;
  placements: CampaignPlacementResult[];
  /** orders: the sum of placements WITH reliable attribution; ordersPartial when some have none. */
  totals: { impressions: number; clicks: number; engagements: number; orders: number; ordersPartial: boolean };
  previous: { impressions: number; clicks: number; engagements: number; orders: number } | null;
  advice: string[];
  createdAt: string;
};

function itemStatus(row: { status: string; startsAt: Date; expiresAt: Date }, now: Date) {
  if ((row.status === "ACTIVE" || row.status === "PAUSED") && row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return row.status;
}

async function countsFor(listingIds: string[], storeIds: string[]) {
  const listing = listingIds.length
    ? ((await db
        .select({ id: promotionAttributions.promotionId, eventType: promotionAttributions.eventType, kind: promotionAttributions.engagementKind, n: sql<number>`count(*)::int` })
        .from(promotionAttributions)
        .where(and(inArray(promotionAttributions.promotionId, listingIds), ne(promotionAttributions.chargeStatus, "SKIPPED_SELF")))
        .groupBy(promotionAttributions.promotionId, promotionAttributions.eventType, promotionAttributions.engagementKind)) as { id: string; eventType: string; kind: string | null; n: number }[])
    : [];
  const store = storeIds.length
    ? ((await db
        .select({ id: storePromotionEvents.storePromotionId, eventType: storePromotionEvents.eventType, n: sql<number>`count(*)::int` })
        .from(storePromotionEvents)
        .where(inArray(storePromotionEvents.storePromotionId, storeIds))
        .groupBy(storePromotionEvents.storePromotionId, storePromotionEvents.eventType)) as { id: string; eventType: string; n: number }[])
    : [];
  return (id: string) => {
    const l = listing.filter((row) => row.id === id);
    const s = store.filter((row) => row.id === id);
    const sum = (rows: { n: number }[]) => rows.reduce((total, row) => total + row.n, 0);
    return {
      impressions: sum(l.filter((row) => row.eventType === "IMPRESSION")) + sum(s.filter((row) => row.eventType === "IMPRESSION")),
      // A click is an opened ad (listing detail or store page), never a guess.
      clicks: sum(l.filter((row) => row.eventType === "ENGAGEMENT" && row.kind === "DETAIL_OPENED")) + sum(s.filter((row) => row.eventType === "ENGAGEMENT")),
      engagements: sum(l.filter((row) => row.eventType === "ENGAGEMENT")) + sum(s.filter((row) => row.eventType === "ENGAGEMENT")),
      // Orders only where the attribution recorded a conversion for this exact placement.
      orders: sum(l.filter((row) => row.eventType === "CONVERSION")),
    };
  };
}

function adviceFor(result: Pick<CampaignResult, "status" | "totals" | "placements" | "subjectKind">): string[] {
  const advice: string[] = [];
  const live = result.placements.some((item) => item.status === "ACTIVE");
  if (result.status === "PENDING_PAYMENT") return ["الحملة لم تبدأ بعد: تبدأ فقط بعد تأكيد الدفع."];
  if (live && result.totals.impressions === 0) advice.push("لا ظهور مسجل بعد. مواضع البحث والمحادثة تظهر فقط عندما يطابق طلب المشتري إعلانك؛ وضوح العنوان والفئة يرفع فرص المطابقة.");
  if (result.totals.impressions >= 20 && result.totals.clicks === 0) advice.push("ظهر إعلانك دون نقرات: جرّب صورة أوضح أو نصًا يذكر السعر والحالة والمدينة.");
  if (result.totals.clicks > 0 && result.totals.orders === 0 && !result.totals.ordersPartial) advice.push("هناك اهتمام دون طلبات حتى الآن: راجع السعر وطريقة التسليم وردّك على الاستفسارات.");
  const best = [...result.placements].filter((item) => item.impressions > 0).sort((a, b) => b.clicks / b.impressions - a.clicks / a.impressions)[0];
  if (best && result.placements.length > 1 && best.clicks > 0) advice.push(`أفضل نسبة نقر حتى الآن في «${best.name}» (${best.clicks} من ${best.impressions}).`);
  if (!advice.length && live) advice.push("الأرقام قليلة حتى الآن للحكم؛ تابع النتائج بعد يومين.");
  return advice;
}

/** The seller's campaigns with per-placement results (only recorded counts; no viewer is identified). */
export async function campaignResults(actorId: string, market: Market, campaignId?: string, now = new Date()): Promise<CampaignResult[]> {
  const campaigns: CampaignRow[] = await db
    .select()
    .from(promotionCampaigns)
    .where(and(eq(promotionCampaigns.sellerId, actorId), eq(promotionCampaigns.marketId, market.id), ...(campaignId ? [eq(promotionCampaigns.id, campaignId)] : [])))
    .orderBy(desc(promotionCampaigns.createdAt))
    .limit(12);
  if (campaignId && !campaigns.length) throw fail(404, "الحملة غير موجودة", "NOT_FOUND");
  const results: CampaignResult[] = [];
  for (const campaign of campaigns) {
    const { listing, store } = await campaignItems(campaign.id);
    const counts = await countsFor(listing.map((row) => row.id), store.map((row) => row.id));
    const placements: CampaignPlacementResult[] = [...listing, ...store].map((row) => {
      const status = itemStatus(row, now);
      const c = counts(row.id);
      const started = row.paymentStatus === "PROVIDER_PAID" || row.paymentStatus === "PROVIDER_DISPUTED" || row.paymentStatus === "PROVIDER_REFUNDED";
      const running = status === "ACTIVE" || status === "PAUSED";
      const note =
        status === "CANCELLED" && row.paymentStatus === "PROVIDER_PAID"
          ? "دُفع ثمن هذا الموضع لكنه لم يبدأ لأنه لم يعد متاحًا؛ سُجّل لمراجعة الاسترداد."
          : status === "CANCELLED" && row.paymentStatus === "PROVIDER_REFUNDED"
            ? "ملغى — أكّد مزود الدفع استرداد المبلغ."
            : status === "PAUSED"
              ? "متوقف مؤقتًا بسبب نزاع على الدفع."
              : status === "PENDING_PAYMENT"
                ? "يبدأ بعد تأكيد الدفع."
                : status === "EXPIRED"
                  ? "انتهت مدته تلقائيًا."
                  : status === "ACTIVE"
                    ? "يظهر الآن مع شارة «ممول» حيث يكون ذا صلة."
                    : STATUS_LABELS[status] ?? status;
      return {
        placement: row.placementSnapshot,
        where: PLACEMENT_WHERE[row.placementSnapshot] ?? row.placementSnapshot,
        name: row.productNameSnapshot,
        status,
        statusLabel: STATUS_LABELS[status] ?? status,
        note,
        days: row.durationDaysSnapshot,
        priceLabel: money(row.priceMinorSnapshot, market),
        startsAt: started && status !== "CANCELLED" ? row.startsAt.toISOString() : null,
        expiresAt: started && status !== "CANCELLED" ? row.expiresAt.toISOString() : null,
        remainingDays: running ? Math.max(0, Math.ceil((row.expiresAt.getTime() - now.getTime()) / DAY_MS)) : null,
        ...c,
        ...("businessId" in row ? { orders: null, ordersNote: "غير متاح: لا توجد بعد آلية موثوقة تربط طلبًا بإعلان المتجر" } : {}),
      };
    });
    const totals = placements.reduce((t, p) => ({ impressions: t.impressions + p.impressions, clicks: t.clicks + p.clicks, engagements: t.engagements + p.engagements, orders: t.orders + (p.orders ?? 0), ordersPartial: t.ordersPartial || p.orders === null }), { impressions: 0, clicks: 0, engagements: 0, orders: 0, ordersPartial: false });
    const anyRunning = placements.some((p) => p.status === "ACTIVE" || p.status === "PAUSED");
    const status = campaign.status === "PENDING_PAYMENT" || campaign.status === "CANCELLED" ? campaign.status : anyRunning ? (placements.some((p) => p.status === "CANCELLED") ? "PARTIAL" : "ACTIVE") : "ENDED";
    // The previous comparable campaign: same subject, created earlier, actually paid.
    const [previous] = await db
      .select({ id: promotionCampaigns.id })
      .from(promotionCampaigns)
      .where(and(
        eq(promotionCampaigns.sellerId, actorId),
        campaign.listingId ? eq(promotionCampaigns.listingId, campaign.listingId) : eq(promotionCampaigns.businessId, campaign.businessId!),
        inArray(promotionCampaigns.paymentStatus, ["PROVIDER_PAID", "PROVIDER_REFUNDED", "PROVIDER_DISPUTED"]),
        sql`${promotionCampaigns.createdAt} < ${campaign.createdAt}`,
      ))
      .orderBy(desc(promotionCampaigns.createdAt))
      .limit(1);
    let previousTotals: CampaignResult["previous"] = null;
    if (previous) {
      const items = await campaignItems(previous.id);
      const prevCounts = await countsFor(items.listing.map((row) => row.id), items.store.map((row) => row.id));
      previousTotals = [...items.listing, ...items.store].map((row) => prevCounts(row.id)).reduce((t, c) => ({ impressions: t.impressions + c.impressions, clicks: t.clicks + c.clicks, engagements: t.engagements + c.engagements, orders: t.orders + c.orders }), { impressions: 0, clicks: 0, engagements: 0, orders: 0 });
    }
    const paymentNote =
      campaign.paymentStatus === "PROVIDER_PENDING"
        ? "لم يُخصم شيء بعد."
        : campaign.paymentStatus === "PROVIDER_PAID"
          ? campaign.refundReviewMinor > 0
            ? "وصل الدفع. بعض المواضع لم تبدأ وسُجّلت لمراجعة الاسترداد؛ لم يُسترد شيء بعد."
            : "وصل الدفع وأكّده مزود الدفع."
          : campaign.paymentStatus === "PROVIDER_REFUNDED"
            ? "أكّد مزود الدفع استرداد المبلغ."
            : campaign.paymentStatus === "PROVIDER_DISPUTED"
              ? "يوجد نزاع على الدفع؛ المواضع متوقفة حتى يُحسم."
              : "لم يكتمل الدفع.";
    const base = { status, totals, placements, subjectKind: campaign.subjectKind as "LISTING" | "STORE" };
    results.push({
      campaignId: campaign.id,
      subjectKind: base.subjectKind,
      subjectTitle: await subjectTitle(campaign),
      subjectImage: campaign.listingId
        ? await db.select({ data: offers.data }).from(offers).where(eq(offers.id, campaign.listingId)).then(([row]) => (row ? listingImageOf(row.data as { imageUrl?: unknown; imageUrls?: unknown }) : null))
        : await storeImage(campaign.sellerId, campaign.marketId),
      status,
      statusLabel: STATUS_LABELS[status] ?? status,
      paymentNote,
      totalLabel: money(campaign.totalMinor, market),
      refundReviewLabel: campaign.refundReviewMinor > 0 ? money(campaign.refundReviewMinor, market) : null,
      adCopy: campaign.adCopy,
      placements,
      totals,
      previous: previousTotals,
      advice: adviceFor(base),
      createdAt: campaign.createdAt.toISOString(),
    });
  }
  return results;
}

/** Suggest one to three placement sets from the catalog, each with the reason (the seller decides). */
export function suggestPlacementSets(options: PlacementOption[], goal: "SELL_STOCK" | "STORE" | "VISIBILITY") {
  const open = options.filter((option) => option.available);
  const pick = (placements: string[]) => placements.map((p) => open.find((o) => o.placement === p)).filter(Boolean) as PlacementOption[];
  const sets: { productIds: string[]; reason: string }[] = [];
  const add = (items: PlacementOption[], reason: string) => {
    if (!items.length) return;
    const ids = items.map((item) => item.productId);
    if (sets.some((set) => set.productIds.join() === ids.join())) return;
    sets.push({ productIds: ids, reason });
  };
  if (goal === "STORE") {
    add(pick(["SIDEBAR"]), "الأقل كلفة لظهور متجرك بشكل دائم في الشريط الجانبي.");
    add(pick(["HERO", "SIDEBAR"]), "أوسع ظهور لمتجرك: أعلى الصفحة والشريط الجانبي معًا.");
  } else if (goal === "SELL_STOCK") {
    add(pick(["SPONSORED_SEARCH", "DEMAND"]), "يصل إلى من يبحث فعلًا عن منتج مثله، وإلى من طلب تنبيهه عنه.");
    add(pick(["SPONSORED_SEARCH", "SIDEBAR"]), "إبراز في البحث مع ظهور ثابت في الشريط الجانبي لكمية كبيرة.");
    add(pick(["SPONSORED_SEARCH"]), "الأبسط: يظهر فقط عندما يطابق بحث المشتري إعلانك.");
  } else {
    add(pick(["SPONSORED_SEARCH"]), "يظهر فقط عندما يطابق بحث المشتري إعلانك.");
    add(pick(["SPONSORED_SEARCH", "SPONSORED_RECOMMENDATION"]), "البحث والاقتراحات داخل المحادثة عندما يطلب مشترٍ منتجًا مشابهًا.");
    add(pick(["HERO"]), "أوسع ظهور أعلى الصفحة لكل زوار سوقك.");
  }
  if (!sets.length && open.length) {
    const cost = (o: PlacementOption) => (o.pricingUnit === "DAY" ? o.priceMinor * o.defaultDays : o.priceMinor);
    const cheapest = [...open].sort((a, b) => cost(a) - cost(b))[0]!;
    add([cheapest], "الخيار الأقل كلفة المتاح الآن.");
  }
  return sets.slice(0, 3);
}

export { CAMPAIGN_ONLY_TYPES };
