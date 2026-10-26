/**
 * One generic internal recommender (Block E). It ranks DINAR's own published inventory
 * from signals that are already public on listings: category, registry attributes,
 * title words, price, public city, quality and freshness. There is no per-category
 * engine, no behavioural profile, no external catalogue and no precise location.
 *
 * Candidates come from the Block A search authority (market, moderation, seller
 * status, policy, hard filters, availability), then must pass a similarity gate.
 * Only afterwards may a serving campaign take one labelled slot, so payment never
 * creates relevance. Every reason shown is the signal that actually matched.
 */
import type { SearchFilter, SearchSort } from "@workspace/api-zod/marketplace-schemas";
import { normalizeSearch } from "../ai/search-context";
import type { ListingRecord } from "./dinar-data";
import type { marketFor } from "./markets";
import {
  categorySchema,
  listMarketplaceCategories,
} from "./marketplace-categories";
import { searchMarketplaceListings } from "./marketplace-listings";
import { getCommercialPolicy } from "./commercial-policy";
import {
  RECOMMENDATION_PLACEMENTS,
  rankSponsored,
  representativeCampaign,
  servingCampaignsFor,
  sponsoredScore,
} from "./promotions";

type Market = Awaited<ReturnType<typeof marketFor>>;

export const RECOMMENDATION_LIMIT = 6;

export type RecommendationRequest = {
  /** A listing the user is looking at; never the user's own location. */
  anchorId?: string;
  /** Results already on screen are not repeated as "alternatives". */
  excludeIds?: string[];
  /** Category from the conversation context when there is no anchor. */
  categoryId?: string;
  /** Hard filters from the current context (city, explicit price ceiling, …). */
  filters?: SearchFilter[];
  sort?: SearchSort;
  cheaper?: boolean;
  /** Same public city as the anchor listing. */
  nearby?: boolean;
};

export type StoredRecommendation = {
  anchorId?: string;
  anchorTitle?: string;
  cheaper?: boolean;
  nearby?: boolean;
  excludeIds: string[];
  reasons: Record<string, string[]>;
};

export type RecommendationResult = {
  listings: ListingRecord[];
  categoryId?: string;
  filters: SearchFilter[];
  sort?: SearchSort;
  sponsoredIds: string[];
  recommendation: StoredRecommendation;
  /** Why nothing was filtered by location, when the user asked for nearby items. */
  nearbyUnavailable?: boolean;
};

// Words too common to signal similarity on their own.
const STOP_WORDS = new Set([
  "في", "من", "مع", "على", "الى", "عن", "او", "و", "ال", "للبيع", "بيع", "جديد", "مستعمل",
  "نظيف", "ممتاز", "اصلي", "حالة", "حاله", "لون", "سعر", "عرض", "اختبار", "قطعة", "قطعه",
]);

function words(value: string): Set<string> {
  return new Set(
    normalizeSearch(value)
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .map((word) => word.replace(/^(?:وال|بال|لل|ال)/u, ""))
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)),
  );
}

function priceOf(listing: ListingRecord): number | undefined {
  if (listing.unitPrice === null || listing.unitPrice === undefined) return undefined;
  const value = Number(listing.unitPrice);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const sameText = (a: unknown, b: unknown) =>
  a !== undefined &&
  a !== null &&
  b !== undefined &&
  b !== null &&
  String(a).trim() !== "" &&
  normalizeSearch(String(a)) === normalizeSearch(String(b));

// Attributes that almost every listing shares say nothing about similarity.
const GENERIC_ATTRIBUTES = new Set(["condition"]);

export async function recommendListings(
  market: Market,
  request: RecommendationRequest,
): Promise<RecommendationResult> {
  const anchor = request.anchorId
    ? (
        await searchMarketplaceListings(market, {
          search: "",
          allowedIds: [request.anchorId],
          limit: 1,
        })
      )[0]
    : undefined;
  const categoryId = anchor?.categoryId ?? request.categoryId;
  const anchorPrice = anchor ? priceOf(anchor) : undefined;
  const filters: SearchFilter[] = [...(request.filters ?? [])].filter(
    (filter) => !(request.cheaper && anchorPrice !== undefined && filter.field === "price" && filter.operator === "lt"),
  );
  if (request.cheaper && anchorPrice !== undefined)
    filters.push({ field: "price", operator: "lt", value: anchorPrice });
  const anchorCity = anchor?.city?.trim();
  const nearbyUnavailable = Boolean(request.nearby && !anchorCity);
  if (request.nearby && anchorCity && !filters.some((filter) => filter.field === "city"))
    filters.push({ field: "city", operator: "eq", value: anchorCity });

  const categories = await listMarketplaceCategories();
  const categoryRow = categoryId ? categories.find((row) => row.id === categoryId) : undefined;
  const schema = categoryRow ? categorySchema(categoryRow) : undefined;

  // Block A authority: published, moderated, seller ACTIVE, market, hard filters, stock.
  const candidates = await searchMarketplaceListings(market, {
    search: "",
    conversational: true,
    ...(categoryRow ? { categoryId: categoryRow.id } : {}),
    filters,
    sponsoredPlacement: false,
    limit: 200,
  });

  const excluded = new Set([...(request.excludeIds ?? []), ...(anchor ? [anchor.id] : [])]);
  // Titles name the item; free-text descriptions share boilerplate too often to count.
  const anchorWords = anchor ? words(anchor.title) : new Set<string>();
  const specialized = Boolean(categoryRow && categoryRow.renderer !== "GENERIC");
  const now = Date.now();
  const seen = new Set<string>();
  const scored: { listing: ListingRecord; score: number; reasons: string[] }[] = [];

  for (const listing of candidates) {
    if (excluded.has(listing.id)) continue;
    // Simple near-duplicate suppression: one copy per seller and title.
    const duplicateKey = `${listing.sellerId}\u0000${normalizeSearch(listing.title)}`;
    if (seen.has(duplicateKey)) continue;
    if (anchor && normalizeSearch(listing.title) === normalizeSearch(anchor.title) && listing.sellerId === anchor.sellerId)
      continue;

    const reasons: string[] = [];
    let score = 0;
    if (anchor) {
      const attributeMatches = Object.entries(schema?.attributes ?? {})
        .filter(([key]) => !GENERIC_ATTRIBUTES.has(key))
        .filter(([key]) => sameText(anchor.attributes?.[key], listing.attributes?.[key]))
        .map(([key, definition]) => `${definition.label}: ${listing.attributes?.[key]}`);
      const sharedWords = [...words(listing.title)].filter((word) =>
        anchorWords.has(word),
      );
      // Similarity gate: a specialised category (vehicles, property) is comparable as a
      // whole; broad categories (services, general goods, "Other") need a shared
      // attribute or title word with the listing being viewed.
      if (!specialized && !attributeMatches.length && !sharedWords.length) continue;
      score += attributeMatches.length * 3 + Math.min(sharedWords.length, 4) * 2;
      if (categoryId && listing.categoryId === categoryId) reasons.push("من نفس الفئة");
      if (attributeMatches.length) reasons.push(`نفس ${attributeMatches.slice(0, 2).join("، ")}`);
      else if (sharedWords.length) reasons.push("مشابه لما شاهدته");
      const price = priceOf(listing);
      if (price !== undefined && anchorPrice !== undefined) {
        const distance = Math.abs(price - anchorPrice) / anchorPrice;
        score += Math.max(0, 1 - distance);
        if (price < anchorPrice && request.cheaper) reasons.push("أرخص مما شاهدته");
        else if (distance <= 0.2) reasons.push("قريب من سعر ما شاهدته");
      }
      if (anchorCity && sameText(listing.city, anchorCity)) {
        score += 1;
        reasons.push(`متوفر في ${listing.city}`);
      }
      // Quality and freshness only break ties among already similar listings.
      if (listing.reviewCount > 0) score += Math.min(listing.rating, 5) / 10;
      const ageDays = (now - new Date(listing.createdAt).getTime()) / 86_400_000;
      score += ageDays <= 30 ? 0.25 : 0;
    } else {
      // Without a listing to compare, the order is simply newest first.
      reasons.push(categoryRow ? `من أحدث عروض ${categoryRow.label}` : "من أحدث العروض في سوقك");
    }
    seen.add(duplicateKey);
    scored.push({ listing, score, reasons });
  }

  const priceOrNull = (listing: ListingRecord) => priceOf(listing) ?? null;
  scored.sort((a, b) => {
    if (request.sort === "PRICE_ASC" || request.sort === "PRICE_DESC") {
      const av = priceOrNull(a.listing);
      const bv = priceOrNull(b.listing);
      if (av !== bv) {
        if (av === null) return 1;
        if (bv === null) return -1;
        return request.sort === "PRICE_ASC" ? av - bv : bv - av;
      }
    } else if (request.sort === "NEWEST") {
      const diff = new Date(b.listing.createdAt).getTime() - new Date(a.listing.createdAt).getTime();
      if (diff) return diff;
    } else if (b.score !== a.score) return b.score - a.score;
    const age = new Date(b.listing.createdAt).getTime() - new Date(a.listing.createdAt).getTime();
    return age || a.listing.id.localeCompare(b.listing.id);
  });

  // A serving campaign may lift one already-recommended listing into a labelled slot,
  // only when there is a listing to be similar to: payment never creates relevance.
  // Only listings that already satisfy the recommendation need can take a paid slot; the
  // slot count is versioned commercial policy and money orders, never admits, candidates.
  const sponsoredIds: string[] = [];
  const paidCampaigns = new Map<string, { promotionId: string; placement: string }>();
  if (anchor && (!request.sort || request.sort === "RELEVANCE")) {
    const slots = (await getCommercialPolicy(market.id)).recommendationSponsoredSlots;
    const campaigns = (await servingCampaignsFor(market.id, scored.map((item) => item.listing.id), new Date(), RECOMMENDATION_PLACEMENTS)).filter((campaign) => {
      const listing = scored.find((item) => item.listing.id === campaign.listingId)?.listing;
      return listing && campaign.categoryIdSnapshot === listing.categoryId;
    });
    const ranked = rankSponsored(
      scored.flatMap((item, organicIndex) => {
        const campaign = representativeCampaign(campaigns, item.listing.id);
        if (!campaign) return [];
        return [{
          id: item.listing.id,
          campaign,
          score: sponsoredScore({
            organicIndex,
            priorityWeight: campaign.priorityWeightSnapshot,
            unitChargeMinor: campaign.unitChargeMinorSnapshot,
            minorUnitScale: market.minorUnitScale,
            hasImage: Boolean(item.listing.imageUrl),
            descriptionLength: String(item.listing.description ?? "").length,
          }),
        }];
      }),
      slots,
    );
    for (const item of ranked) {
      sponsoredIds.push(item.id);
      paidCampaigns.set(item.id, { promotionId: item.campaign.id, placement: item.campaign.placementSnapshot });
    }
  }
  const ordered = [
    ...scored.filter((item) => sponsoredIds.includes(item.listing.id)),
    ...scored.filter((item) => !sponsoredIds.includes(item.listing.id)),
  ].slice(0, RECOMMENDATION_LIMIT);

  return {
    listings: ordered.map((item) => ({
      ...item.listing,
      ...(sponsoredIds.includes(item.listing.id)
        ? {
            isSponsored: true,
            sponsoredCampaignId: paidCampaigns.get(item.listing.id)!.promotionId,
            sponsoredPlacement: paidCampaigns.get(item.listing.id)!.placement,
            sponsoredTier: paidCampaigns.get(item.listing.id)!.placement === "VIP" ? ("VIP" as const) : ("STANDARD" as const),
          }
        : {}),
      recommendationReasons: item.reasons,
    })),
    ...(categoryRow ? { categoryId: categoryRow.id } : {}),
    filters,
    ...(request.sort ? { sort: request.sort } : {}),
    sponsoredIds: sponsoredIds.filter((id) => ordered.some((item) => item.listing.id === id)),
    recommendation: {
      ...(anchor ? { anchorId: anchor.id, anchorTitle: anchor.title } : {}),
      ...(request.cheaper ? { cheaper: true } : {}),
      ...(request.nearby ? { nearby: true } : {}),
      excludeIds: [...excluded],
      reasons: Object.fromEntries(ordered.map((item) => [item.listing.id, item.reasons])),
    },
    ...(nearbyUnavailable ? { nearbyUnavailable } : {}),
  };
}

/** Restores stored placement labels and recommendation reasons onto live listings. */
export function decorateStoredResults(
  listings: ListingRecord[],
  query: unknown,
): ListingRecord[] {
  const stored = (query ?? {}) as {
    recommendation?: { reasons?: Record<string, unknown> };
    buyer?: { reasons?: Record<string, unknown> };
  };
  // Recommendation reasons, or the buyer ranking's reasons (Block F2).
  const reasons = stored.recommendation?.reasons ?? stored.buyer?.reasons;
  if (!reasons || typeof reasons !== "object") return listings;
  return listings.map((listing) => {
    const value = reasons[listing.id];
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? { ...listing, recommendationReasons: value as string[] }
      : listing;
  });
}

export function storedSponsoredIds(query: unknown): string[] {
  const value = (query as { sponsoredIds?: unknown } | null)?.sponsoredIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 24) : [];
}

export type ComparablePrices = {
  count: number;
  min: number | null;
  max: number | null;
  median: number | null;
  currency: string;
  listingIds: string[];
  source: "DINAR_ONLY";
};

/**
 * Published DINAR listings comparable to a seller's item, for price guidance only: same
 * category, fixed price, another seller, and a shared title word or a shared specific
 * attribute. Nothing outside DINAR is consulted and nothing is changed.
 */
export async function comparablePrices(
  market: Market,
  subject: {
    categoryId?: string;
    title: string;
    attributes?: Record<string, string | number>;
    excludeIds?: string[];
    sellerId: string;
  },
): Promise<ComparablePrices> {
  const categories = await listMarketplaceCategories();
  const categoryRow = subject.categoryId ? categories.find((row) => row.id === subject.categoryId) : undefined;
  const schema = categoryRow ? categorySchema(categoryRow) : undefined;
  const subjectWords = words(subject.title);
  const candidates = categoryRow
    ? await searchMarketplaceListings(market, {
        search: "",
        categoryId: categoryRow.id,
        sponsoredPlacement: false,
        limit: 500,
      })
    : [];
  const prices = candidates
    .filter((listing) => listing.sellerId !== subject.sellerId && !subject.excludeIds?.includes(listing.id))
    .filter((listing) => listing.pricingMode === "FIXED" && priceOf(listing) !== undefined)
    .filter((listing) => {
      const shared = [...words(listing.title)].some((word) => subjectWords.has(word));
      const attribute = Object.keys(schema?.attributes ?? {})
        .filter((key) => !GENERIC_ATTRIBUTES.has(key))
        .some((key) => sameText(subject.attributes?.[key], listing.attributes?.[key]));
      return shared || attribute;
    })
    .map((listing) => ({ id: listing.id, price: priceOf(listing)! }))
    .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  const values = prices.map((item) => item.price);
  const middle = Math.floor(values.length / 2);
  return {
    count: values.length,
    min: values.length ? values[0]! : null,
    max: values.length ? values.at(-1)! : null,
    median: values.length >= 3 ? (values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2) : null,
    currency: market.currencyCode,
    listingIds: prices.map((item) => item.id),
    source: "DINAR_ONLY",
  };
}
