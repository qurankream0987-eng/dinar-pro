/**
 * «جاسم روح بيع لي» (DEMAND_CAPTURE) proactive matching against buyer-authorised demand.
 *
 * Demand that may be matched is ONLY a buyer's saved request («نبّهني إذا توفر»): structured
 * fields (need words, category, city, max price) saved with an explicit consent version, never a
 * copy or a scan of conversations. Requests expire (policy `demandRequestRetentionDays`), can be
 * opted out of or deleted, and are never shown to a seller: a seller only ever learns an
 * aggregate count of buyers notified by its own campaign.
 *
 * Matching runs when a DEMAND campaign is activated and again when a new request is saved while a
 * campaign serves — only inside the campaign window (`startsAt` ≤ now < `expiresAt`; the product
 * sets the duration, 10 days in the current proposal; no renewal). Each (request, listing) pair
 * produces at most one in-app notice (unique index). Hard gates first, as everywhere: market,
 * published listing, active seller, policy, inventory, category, city, price, then model numbers
 * (every number in the need must be in the listing: «آيفون 13» never matches a 14), then word
 * coverage ≥ policy `demandRelevanceMinCoverage`. Nothing here charges, guarantees a buyer, a
 * contact or a sale.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import { buyerDemandRequests, db, demandMatchNotices, listingPromotions, offers, users } from "@workspace/db";
import { getCommercialPolicy } from "./commercial-policy";
import { needCoverage, needTokens } from "./demand-normalization";
import { formatMinor, isServingCampaign, listingPromotionEligibility } from "./promotions";
import type { marketFor } from "./markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEMAND_REQUEST_CONSENT_VERSION = "demand-alert-2026-11-14";
export const DEMAND_REQUEST_DISCLOSURE =
  "سأحفظ طلبك (الكلمات والمدينة والسعر الأعلى فقط، دون محادثتك) لمدة محدودة، وأنبهك داخل جاسم إذا ظهر عرض مناسب من بائع مشترك في «جاسم روح بيع لي». لن يعرف أي بائع هويتك، ويمكنك إيقاف التنبيه أو حذف الطلب في أي وقت.";
const MAX_ACTIVE_REQUESTS = 10;
const fail = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

const numbersOf = (tokens: string[]) => tokens.filter((token) => /^\d+$/.test(token));

export type DemandMatch = { coverage: number; exact: boolean } | undefined;

/** The pure decision for one request against one listing's own facts. */
export function demandMatch(
  request: { needText: string; categoryId: string | null; city: string | null; priceMaxMinor: number | null },
  listing: { title: string; description: string; attributes: Record<string, unknown>; categoryId: string | null; city: string | null; priceMinor: number | null },
  minCoverage: number,
): DemandMatch {
  const tokens = needTokens(request.needText);
  if (!tokens.length) return undefined;
  if (request.categoryId && listing.categoryId !== request.categoryId) return undefined;
  const fold = (value: string) => value.trim().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").toLowerCase();
  if (request.city && fold(listing.city ?? "") !== fold(request.city)) return undefined;
  if (request.priceMaxMinor != null && (listing.priceMinor == null || listing.priceMinor > request.priceMaxMinor)) return undefined;
  const text = [listing.title, listing.description, ...Object.values(listing.attributes ?? {}).map(String)].join(" ");
  const listingTokens = new Set(needTokens(text));
  if (numbersOf(tokens).some((number) => !listingTokens.has(number))) return undefined;
  const coverage = needCoverage(tokens, text);
  if (coverage < minCoverage) return undefined;
  return { coverage, exact: coverage === 1 };
}

export async function saveDemandRequest(input: {
  buyerId: string;
  market: Market;
  needText: string;
  categoryId?: string;
  city?: string;
  priceMaxMinor?: number;
  consent: boolean;
  now?: Date;
}) {
  if (input.consent !== true) throw fail(400, "لا أحفظ طلبك إلا بموافقتك الصريحة.", "CONSENT_REQUIRED");
  const now = input.now ?? new Date();
  const needText = input.needText.replace(/\s+/g, " ").trim().slice(0, 200);
  if (needTokens(needText).length === 0) throw fail(400, "صف ما تبحث عنه بكلمات أوضح.", "NEED_UNCLEAR");
  const [active] = await db
    .select({ n: count() })
    .from(buyerDemandRequests)
    .where(and(eq(buyerDemandRequests.buyerId, input.buyerId), eq(buyerDemandRequests.status, "ACTIVE"), gt(buyerDemandRequests.expiresAt, now)));
  if ((active?.n ?? 0) >= MAX_ACTIVE_REQUESTS) throw fail(409, "لديك عشرة طلبات محفوظة؛ احذف أحدها أولًا.", "TOO_MANY_REQUESTS");
  const policy = await getCommercialPolicy(input.market.id);
  const [row] = await db
    .insert(buyerDemandRequests)
    .values({
      id: randomUUID(),
      buyerId: input.buyerId,
      marketId: input.market.id,
      needText,
      categoryId: input.categoryId ?? null,
      city: input.city?.trim().slice(0, 60) || null,
      priceMaxMinor: input.priceMaxMinor ?? null,
      currencyCode: input.market.currencyCode,
      consentVersion: DEMAND_REQUEST_CONSENT_VERSION,
      status: "ACTIVE",
      expiresAt: new Date(now.getTime() + policy.demandRequestRetentionDays * DAY_MS),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  // New demand during a running campaign is matched too (inside each campaign's own window).
  const notified = await matchRequestAgainstCampaigns(row!.id, input.market, now);
  return { request: requestView(row!), notified };
}

function requestView(row: typeof buyerDemandRequests.$inferSelect) {
  return { id: row.id, needText: row.needText, city: row.city, priceMaxMinor: row.priceMaxMinor, currencyCode: row.currencyCode, status: row.status, expiresAt: row.expiresAt.toISOString() };
}

export async function listDemandRequests(buyerId: string, now = new Date()) {
  const rows = await db.select().from(buyerDemandRequests).where(and(eq(buyerDemandRequests.buyerId, buyerId), ne(buyerDemandRequests.status, "DELETED"))).orderBy(desc(buyerDemandRequests.createdAt));
  return rows.map((row) => requestView(row.status === "ACTIVE" && row.expiresAt <= now ? { ...row, status: "EXPIRED" } : row));
}

async function ownRequest(buyerId: string, requestId: string) {
  const [row] = await db.select().from(buyerDemandRequests).where(eq(buyerDemandRequests.id, requestId));
  // Another buyer's request does not exist for this caller.
  if (!row || row.buyerId !== buyerId || row.status === "DELETED") throw fail(404, "الطلب غير موجود", "NOT_FOUND");
  return row;
}

export async function optOutDemandRequest(buyerId: string, requestId: string, now = new Date()) {
  await ownRequest(buyerId, requestId);
  const [row] = await db.update(buyerDemandRequests).set({ status: "OPTED_OUT", updatedAt: now }).where(eq(buyerDemandRequests.id, requestId)).returning();
  return requestView(row!);
}

/** Deletion removes the request's need text and its notices; the row keeps only its id and status. */
export async function deleteDemandRequest(buyerId: string, requestId: string, now = new Date()) {
  await ownRequest(buyerId, requestId);
  await db.transaction(async (tx) => {
    await tx.delete(demandMatchNotices).where(eq(demandMatchNotices.requestId, requestId));
    await tx.update(buyerDemandRequests).set({ status: "DELETED", needText: "--", city: null, priceMaxMinor: null, categoryId: null, updatedAt: now }).where(eq(buyerDemandRequests.id, requestId));
  });
  return { deleted: true };
}

/** The buyer's in-app notices: the listing as any buyer may see it; never another buyer's data. */
export async function listDemandMatches(buyerId: string, market: Market) {
  const rows = await db
    .select({ notice: demandMatchNotices, offer: offers, request: buyerDemandRequests })
    .from(demandMatchNotices)
    .innerJoin(offers, eq(offers.id, demandMatchNotices.listingId))
    .innerJoin(buyerDemandRequests, eq(buyerDemandRequests.id, demandMatchNotices.requestId))
    .where(and(eq(demandMatchNotices.buyerId, buyerId), inArray(buyerDemandRequests.status, ["ACTIVE", "EXPIRED", "OPTED_OUT"])))
    .orderBy(desc(demandMatchNotices.matchedAt));
  return rows
    .filter((row) => row.offer.status === "PUBLISHED")
    .map((row) => ({
      id: row.notice.id,
      requestId: row.request.id,
      need: row.request.needText,
      listingId: row.offer.id,
      title: String((row.offer.data as { title?: string }).title ?? ""),
      price: row.offer.unitPriceMinor == null ? null : formatMinor(row.offer.unitPriceMinor, market.minorUnitScale),
      currency: market.currencyCode,
      status: row.notice.status,
      matchedAt: row.notice.matchedAt.toISOString(),
      label: "إعلان ممول — جاسم روح بيع لي",
    }));
}

type CampaignRow = typeof listingPromotions.$inferSelect;

async function listingFacts(listingId: string, market: Market) {
  const [row] = await db.select({ offer: offers, sellerStatus: users.status }).from(offers).innerJoin(users, eq(users.id, offers.sellerId)).where(eq(offers.id, listingId));
  if (!row) return undefined;
  const eligible = await listingPromotionEligibility(row.offer, row.sellerStatus, market);
  if (!eligible.ok) return undefined;
  const data = row.offer.data as { title?: string; description?: string; attributes?: Record<string, unknown>; city?: string };
  return {
    sellerId: row.offer.sellerId,
    facts: { title: String(data.title ?? ""), description: String(data.description ?? ""), attributes: data.attributes ?? {}, categoryId: eligible.categoryId ?? null, city: data.city ?? null, priceMinor: row.offer.unitPriceMinor },
  };
}

async function notify(requests: (typeof buyerDemandRequests.$inferSelect)[], campaign: CampaignRow, market: Market, now: Date) {
  const listing = await listingFacts(campaign.listingId, market);
  if (!listing) return 0;
  const policy = await getCommercialPolicy(market.id);
  let created = 0;
  for (const request of requests) {
    if (request.buyerId === listing.sellerId) continue;
    if (!demandMatch(request, listing.facts, policy.demandRelevanceMinCoverage)) continue;
    const [row] = await db
      .insert(demandMatchNotices)
      .values({ id: randomUUID(), requestId: request.id, buyerId: request.buyerId, promotionId: campaign.id, listingId: campaign.listingId, status: "UNREAD", matchedAt: now })
      .onConflictDoNothing()
      .returning({ id: demandMatchNotices.id });
    if (row) created++;
  }
  return created;
}

const liveRequests = (marketId: string, now: Date) =>
  and(eq(buyerDemandRequests.marketId, marketId), eq(buyerDemandRequests.status, "ACTIVE"), gt(buyerDemandRequests.expiresAt, now));

/**
 * Matches one DEMAND campaign against every live authorised request in its market. Returns only
 * the number of buyers newly notified (identity-free); 0 outside the campaign window.
 */
export async function matchDemandCampaign(promotionId: string, market: Market, now = new Date()) {
  const [campaign] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promotionId));
  if (!campaign || campaign.placementSnapshot !== "DEMAND" || campaign.marketId !== market.id || !isServingCampaign(campaign, now)) return { notified: 0, serving: false };
  const requests = await db.select().from(buyerDemandRequests).where(liveRequests(market.id, now));
  return { notified: await notify(requests, campaign, market, now), serving: true };
}

async function matchRequestAgainstCampaigns(requestId: string, market: Market, now: Date) {
  const [request] = await db.select().from(buyerDemandRequests).where(eq(buyerDemandRequests.id, requestId));
  if (!request) return 0;
  const campaigns = (await db
    .select()
    .from(listingPromotions)
    .where(and(eq(listingPromotions.marketId, market.id), eq(listingPromotions.placementSnapshot, "DEMAND"), eq(listingPromotions.status, "ACTIVE"), lte(listingPromotions.startsAt, now), gt(listingPromotions.expiresAt, now))))
    .filter((row) => isServingCampaign(row, now));
  let created = 0;
  for (const campaign of campaigns) created += await notify([request], campaign, market, now);
  return created;
}

/** The seller's view of its own campaign's reach: a count, never who. */
export async function demandCampaignReach(sellerId: string, promotionId: string) {
  const [campaign] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promotionId));
  if (!campaign || campaign.sellerId !== sellerId) throw fail(404, "الحملة غير موجودة", "NOT_FOUND");
  const [row] = await db.select({ n: count() }).from(demandMatchNotices).where(eq(demandMatchNotices.promotionId, promotionId));
  return { promotionId, buyersNotified: row?.n ?? 0, startsAt: campaign.startsAt.toISOString(), expiresAt: campaign.expiresAt.toISOString(), note: "عدد مشترين أُبلغوا داخل جاسم؛ لا يضمن تواصلًا أو بيعًا، ولا تُعرض هوية أي مشترٍ." };
}
