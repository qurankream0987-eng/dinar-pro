/**
 * Jassim Ads — Phase 1 (owner decision 2026-11-27): the conversational marketing assistant for a
 * seller, inside the JassimAI conversation. Off unless DINAR_JASSIM_ADS=true.
 *
 * Read-only and honest by construction:
 *   - Facts come only from the seller's own rows in the active market (listings, their campaigns,
 *     server-attributed campaign results). Nothing is invented: no reach, sales or price promises.
 *   - «جاسم روح بيع لي» is suggested only from authorised buyer requests, as an aggregate count at
 *     or above the policy cohort size (see `waitingBuyersForListing`) — never who or what they wrote.
 *   - Ad copy drafts use only the listing's own facts (title, price, city, condition) and are
 *     labelled as drafts for the seller to approve; nothing is published or charged here.
 *   - Buying a promotion stays in the existing promotion flow (confirmation, server price in the
 *     market currency, receipt). This module never charges, activates or changes anything.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, demandSignals, listingPromotions, offers } from "@workspace/db";
import { getCommercialPolicy } from "./commercial-policy";
import { formatMoney } from "@workspace/global";
import { isPromotionFeatureEnabled } from "./promotion-policy";
import { campaignAnalytics, type CampaignAnalyticsView } from "./promotions";
import { waitingBuyersForListing } from "./demand-requests";
import type { marketFor } from "./markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Environment = Record<string, string | undefined>;

export function jassimAdsEnabled(env: Environment = process.env) {
  return env.DINAR_JASSIM_ADS?.trim().toLowerCase() === "true";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_STATUSES = ["ACTIVE", "SCHEDULED", "PENDING_PAYMENT", "PAUSED"];

export type AdsListing = {
  id: string;
  title: string;
  priceLabel: string | null;
  city: string | null;
  condition: string | null;
  ageDays: number;
  livePromotion: { status: string; expiresAt: string | null } | null;
  waitingBuyers: number | null;
};

export type AdsOpportunity = {
  kind: "DEMAND_CAPTURE" | "NOT_PROMOTED" | "PROMOTION_ENDING";
  listingId: string;
  text: string;
};

const text = (value: unknown, max: number) => (typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : "");

/** The seller's own published listings in this market with promotion and «روح بيع لي» facts. */
export async function sellerAdsListings(actorId: string, market: Market, now = new Date()): Promise<AdsListing[]> {
  const rows = await db
    .select()
    .from(offers)
    .where(and(eq(offers.sellerId, actorId), eq(offers.marketId, market.id), eq(offers.status, "PUBLISHED")))
    .orderBy(desc(offers.createdAt))
    .limit(12);
  if (!rows.length) return [];
  const campaigns = await db
    .select({ listingId: listingPromotions.listingId, status: listingPromotions.status, expiresAt: listingPromotions.expiresAt })
    .from(listingPromotions)
    .where(and(eq(listingPromotions.sellerId, actorId), eq(listingPromotions.marketId, market.id), inArray(listingPromotions.listingId, rows.map((row) => row.id)), inArray(listingPromotions.status, LIVE_STATUSES), gt(listingPromotions.expiresAt, now)));
  const result: AdsListing[] = [];
  for (const row of rows) {
    const data = row.data as { title?: unknown; city?: unknown; attributes?: Record<string, unknown> };
    const live = campaigns.find((campaign) => campaign.listingId === row.id);
    const waiting = await waitingBuyersForListing(row.id, actorId, market, now).catch(() => ({ status: "NOT_ENOUGH_DATA" as const }));
    result.push({
      id: row.id,
      title: text(data.title, 120) || "إعلان",
      priceLabel: row.unitPriceMinor === null ? null : formatMoney(row.unitPriceMinor, market.currencyCode).replace(/\s+/g, " ").trim(),
      city: text(data.city, 60) || null,
      condition: text(data.attributes?.condition, 40) || null,
      ageDays: Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / DAY_MS)),
      livePromotion: live ? { status: live.status, expiresAt: live.expiresAt?.toISOString() ?? null } : null,
      waitingBuyers: waiting.status === "COUNT" ? waiting.buyers : null,
    });
  }
  return result;
}

/** Deterministic opportunities from the facts above; at most one per listing, demand first. */
export function adsOpportunities(listings: AdsListing[], now = new Date()): AdsOpportunity[] {
  const out: AdsOpportunity[] = [];
  for (const listing of listings) {
    if (listing.waitingBuyers !== null && !listing.livePromotion) {
      out.push({
        kind: "DEMAND_CAPTURE",
        listingId: listing.id,
        text: `${listing.waitingBuyers} مشترين طلبوا تنبيههم عن منتج مثل «${listing.title}». «جاسم روح بيع لي» يُبلغهم داخل جاسم لمدة محدودة، دون أن تعرف هويتهم ودون ضمان بيع.`,
      });
      continue;
    }
    if (listing.livePromotion?.expiresAt) {
      const left = new Date(listing.livePromotion.expiresAt).getTime() - now.getTime();
      if (left > 0 && left <= 2 * DAY_MS) {
        out.push({ kind: "PROMOTION_ENDING", listingId: listing.id, text: `ينتهي ترويج «${listing.title}» خلال أقل من يومين.` });
        continue;
      }
    }
    if (!listing.livePromotion && listing.ageDays >= 7)
      out.push({ kind: "NOT_PROMOTED", listingId: listing.id, text: `«${listing.title}» منشور منذ ${listing.ageDays} يومًا دون ترويج. يمكن تمييزه أو إبرازه في نتائج البحث.` });
  }
  return out.sort((a, b) => (a.kind === "DEMAND_CAPTURE" ? -1 : 0) - (b.kind === "DEMAND_CAPTURE" ? -1 : 0)).slice(0, 6);
}

/** Three short copy drafts from the listing's own facts only. */
export function adCopyDrafts(listing: Pick<AdsListing, "title" | "priceLabel" | "city" | "condition">): string[] {
  const price = listing.priceLabel ? ` بسعر ${listing.priceLabel}` : "";
  const where = listing.city ? ` في ${listing.city}` : "";
  const condition = listing.condition ? ` (${listing.condition})` : "";
  return [
    `${listing.title}${condition}${price}. متوفر الآن${where} — اطلبه مباشرةً عبر جاسم.`,
    `تبحث عن ${listing.title}؟ لدينا واحد${condition}${price}${where}. راسلنا في جاسم وتفاوض بسهولة.`,
    `${listing.title}${price} — جاهز للبيع${where}. اسأل جاسم عن التفاصيل واطلبه الآن.`,
  ].map((line) => line.replace(/\s+/g, " ").trim());
}

/** Server-attributed results of the seller's campaigns (empty when promotions are off). */
export async function sellerAdsReport(actorId: string, market: Market): Promise<CampaignAnalyticsView[]> {
  if (!isPromotionFeatureEnabled()) return [];
  return campaignAnalytics(actorId, market).catch(() => []);
}

export type SellingInsight = { kind: "REAL" | "TIP" | "LIMIT"; text: string };

/**
 * Jassim Go Sell for Me: what Jassim actually knows about selling this listing. REAL facts come from
 * recorded data and are shown only at or above the market's privacy cohort size (never who); TIPs
 * come from the listing's own fields; LIMIT says plainly what Jassim cannot know or promise.
 */
export async function sellingInsights(listingId: string, actorId: string, market: Market, quantity?: number, now = new Date()): Promise<SellingInsight[]> {
  const [row] = await db.select().from(offers).where(and(eq(offers.id, listingId), eq(offers.sellerId, actorId)));
  if (!row) return [];
  const data = row.data as { title?: unknown; description?: unknown; imageUrl?: unknown; imageUrls?: unknown; categoryId?: unknown; attributes?: Record<string, unknown> };
  const policy = await getCommercialPolicy(market.id);
  const out: SellingInsight[] = [];
  const waiting = await waitingBuyersForListing(listingId, actorId, market, now).catch(() => ({ status: "NOT_ENOUGH_DATA" as const }));
  if (waiting.status === "COUNT") out.push({ kind: "REAL", text: `${waiting.buyers} مشترين طلبوا تنبيههم عن منتج مثل هذا (طلبات حقيقية محفوظة، دون كشف هوياتهم).` });
  const categoryId = typeof data.categoryId === "string" ? data.categoryId : undefined;
  if (categoryId) {
    const since = new Date(now.getTime() - 7 * DAY_MS);
    const [searchers] = await db
      .select({ n: sql<number>`count(distinct ${demandSignals.actorKey})::int`, unmet: sql<number>`count(distinct ${demandSignals.actorKey}) filter (where ${demandSignals.state} in ('ZERO_RESULTS', 'LOW_SUPPLY', 'USER_UNSATISFIED'))::int` })
      .from(demandSignals)
      .where(and(eq(demandSignals.marketId, market.id), eq(demandSignals.categoryId, categoryId), gt(demandSignals.createdAt, since)));
    if ((searchers?.n ?? 0) >= policy.minCohortSize) out.push({ kind: "REAL", text: `${searchers!.n} مستخدمين مختلفين بحثوا في هذه الفئة خلال آخر 7 أيام.` });
    if ((searchers?.unmet ?? 0) >= policy.minCohortSize) out.push({ kind: "REAL", text: `${searchers!.unmet} منهم لم يجدوا ما يكفيهم — طلب غير ملبّى في الفئة.` });
  }
  if (!out.some((item) => item.kind === "REAL")) out.push({ kind: "LIMIT", text: "لا توجد بيانات اهتمام كافية لعرض أرقام دون المساس بخصوصية المشترين." });
  const images = Array.isArray(data.imageUrls) ? data.imageUrls.length : data.imageUrl ? 1 : 0;
  if (!images) out.push({ kind: "TIP", text: "أضف صورة واضحة للمنتج؛ الإعلانات بلا صور تجذب نقرات أقل." });
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (description.length < 60) out.push({ kind: "TIP", text: "وسّع الوصف: الحالة، المواصفات المهمة، وطريقة التسليم." });
  if (!data.attributes?.condition) out.push({ kind: "TIP", text: "حدّد حالة المنتج (جديد أو مستعمل)؛ المشترون يصفّون بها." });
  if (quantity && quantity > 1) out.push({ kind: "LIMIT", text: `لا أستطيع أن أعدك ببيع ${quantity} قطعة أو تقدير عدد ما سيُباع؛ الترويج يزيد الظهور فقط.` });
  return out.slice(0, 6);
}
