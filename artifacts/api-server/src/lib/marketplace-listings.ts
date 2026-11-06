import { aliasStem, normalizeSearch } from "../ai/search-context";
import {
  validateSearchFilters,
  type SearchFilter,
  type SearchSort,
} from "@workspace/api-zod/marketplace-schemas";
import {
  businessOperatingProfiles,
  businessProfiles,
  db,
  offers,
  users,
  type markets,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { ListingRecord } from "./dinar-data";
import { acceptsPriceProposals, priceRepresentationOf } from "@workspace/api-zod/listing-pricing";
import { marketError, type marketFor } from "./markets";
import {
  categorySchema as categorySchemaFromRow,
  listMarketplaceCategories,
  resolveMarketplaceCategory,
} from "./marketplace-categories";
import {
  activePolicyRules,
  offerPolicyViolation,
} from "./publication-policy";
import {
  isEligibleSearchPromotion,
  isPromotionSimulationEnabled,
} from "./promotion-policy";
import { rankSponsored, representativeCampaign, servingCampaignsFor, sponsoredScore } from "./promotions";
import { getCommercialPolicy } from "./commercial-policy";
import { itemTokens, textMatchesToken, tokenVariants } from "./arabic-search-terms";
import { searchTextContext, searchableTextOf, searchTextVersionReady, SEARCH_TEXT_VERSION } from "./marketplace-search-index";
import { offerSearchDocuments, listingPromotions } from "@workspace/db";
import { SEARCH_PLACEMENTS, SERVING_PAYMENT_STATUSES } from "./promotions";
import { redactListingContactText } from "./listing-contact";
import { assertMarketLegalCapability } from "./d16-readiness";

export type OfferRow = {
  offer: typeof offers.$inferSelect;
  seller: typeof users.$inferSelect;
};

/**
 * Every listing of a market with its seller. Unbounded: no request path calls it since C1 (search
 * reads indexed candidates; carts and listing pages read their ids with offerRowsByIds). Kept for
 * maintenance tooling and comparison.
 */
export async function offerRows(
  marketId: string,
  tx: any = db,
): Promise<OfferRow[]> {
  return tx
    .select({ offer: offers, seller: users })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(eq(offers.marketId, marketId));
}

/** The given listings of a market with their sellers: the same rows offerRows returns for those ids. */
export async function offerRowsByIds(
  marketId: string,
  ids: readonly unknown[],
  tx: any = db,
): Promise<OfferRow[]> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (!wanted.length) return [];
  return tx
    .select({ offer: offers, seller: users })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(and(eq(offers.marketId, marketId), inArray(offers.id, wanted)));
}

/** Public city values of published DINAR inventory; lets parsing recognise a real place name. */
const SERVICE_ROLE_WORDS = new Set(["فني", "فنيه", "فنية", "معلم", "حرفي", "اخصائي", "مختص", "متخصص"]);

export async function publishedListingCities(marketId: string): Promise<string[]> {
  const rows: { city: string | null }[] = await db
    .selectDistinct({ city: sql<string | null>`${offers.data}->>'city'` })
    .from(offers)
    .where(and(eq(offers.marketId, marketId), eq(offers.status, "PUBLISHED")))
    .limit(500);
  return rows
    .map((row) => row.city?.trim() ?? "")
    .filter((city) => city.length >= 2 && city.length <= 60);
}

/** Search words that only repeat a category alias; dropping them broadens within the category. */
export function categoryAliasWords(
  category: { aliases: readonly string[] } | undefined,
  search: string,
): { aliasWords: string[]; remaining: string } {
  const aliases = new Set((category?.aliases ?? []).map((alias) => normalizeSearch(alias)));
  const words = normalizeSearch(search).split(/\s+/).filter(Boolean);
  return {
    aliasWords: words.filter((word) => aliases.has(word)),
    remaining: words.filter((word) => !aliases.has(word)).join(" "),
  };
}

/**
 * Listings whose business is not ACTIVE are never shown by search: a suspended or closed
 * business must not leak its catalog into buyer discovery. Unlinked listings are unaffected.
 */
export async function inactiveBusinessListingIds(
  marketId: string,
  executor: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db = db,
): Promise<Set<string>> {
  const rows = await executor
    .select({ listingId: offers.id })
    .from(offers)
    .innerJoin(
      businessProfiles,
      eq(businessProfiles.id, offers.businessProfileId),
    )
    .leftJoin(
      businessOperatingProfiles,
      eq(businessOperatingProfiles.d2BusinessId, offers.businessProfileId),
    )
    .where(and(
      eq(offers.marketId, marketId),
      eq(businessProfiles.marketId, marketId),
      sql`(
        ${businessProfiles.verificationStatus} <> 'VERIFIED'
        OR ${businessProfiles.publicationStatus} <> 'PUBLISHED'
        OR (
          ${businessOperatingProfiles.id} IS NOT NULL
          AND (${businessOperatingProfiles.marketId} <> ${marketId} OR ${businessOperatingProfiles.status} <> 'ACTIVE')
        )
      )`,
    ));
  return new Set(rows.map((row) => row.listingId));
}

export function listing(
  row: typeof offers.$inferSelect,
  seller: typeof users.$inferSelect,
  market: typeof markets.$inferSelect,
  includeSellerContact = false,
): ListingRecord {
  const currencyCode = "currencyCode" in market ? market.currencyCode : "KWD";
  const minorUnitScale = "minorUnitScale" in market ? market.minorUnitScale : 3;
  const representation = priceRepresentationOf(row);
  const imageUrls = Array.isArray(row.data.imageUrls)
    ? row.data.imageUrls.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const paymentMethods = Array.isArray(row.data.paymentMethods)
    ? row.data.paymentMethods.filter(
        (value): value is "CASH_DIRECT" | "CARD" =>
          value === "CASH_DIRECT" || value === "CARD",
      )
    : market.paymentMethods.filter(
        (value): value is "CASH_DIRECT" | "CARD" =>
          value === "CASH_DIRECT" || value === "CARD",
      );
  const fulfilmentType =
    row.data.fulfilmentType === "DELIVERY" ||
    row.data.fulfilmentType === "DIGITAL" ||
    row.data.fulfilmentType === "SERVICE"
      ? row.data.fulfilmentType
      : "PICKUP";
  // Buyers never see contact details stored in the text (written before the write-time rule);
  // the owner's own management view keeps what they wrote.
  const publicText = (value: unknown) =>
    typeof value !== "string" ? "" : includeSellerContact ? value : redactListingContactText(value, row.marketId);
  return {
    id: row.id,
    title: publicText(row.data.title),
    description: publicText(row.data.description),
    category: typeof row.data.category === "string" ? row.data.category : "",
    ...(typeof row.data.categoryId === "string"
      ? { categoryId: row.data.categoryId }
      : {}),
    area: typeof row.data.area === "string" ? row.data.area : "",
    ...(typeof row.data.city === "string" ? { city: row.data.city } : {}),
    ...(row.data.attributes &&
    typeof row.data.attributes === "object" &&
    !Array.isArray(row.data.attributes)
      ? { attributes: row.data.attributes as Record<string, string | number> }
      : {}),
    paymentMethods,
    imageUrl: typeof row.data.imageUrl === "string" ? row.data.imageUrl : "",
    imageUrls,
    fulfilmentType,
    rating: typeof row.data.rating === "number" ? row.data.rating : 0,
    reviewCount:
      typeof row.data.reviewCount === "number" ? row.data.reviewCount : 0,
    sellerId: row.sellerId,
    sellerName: seller.displayName,
    sellerAvatarObjectPath: seller.avatarObjectPath,
    marketId: row.marketId,
    status: row.status,
    pricingMode: row.pricingMode as ListingRecord["pricingMode"],
    ...(representation ? { priceRepresentation: representation } : {}),
    inventoryMode: row.inventoryMode,
    availableQuantity: row.availableQuantity,
    reservedQuantity: row.reservedQuantity,
    // Explicit listing consent is still private; only seller-owned management
    // responses may include it. Buyers use the order-bound release authority.
    contactPhone: includeSellerContact && typeof row.data.contactPhone === "string" ? row.data.contactPhone : null,
    negotiable: acceptsPriceProposals(representation),
    unitPrice:
      row.unitPriceMinor === null
        ? null
        : (row.unitPriceMinor / 10 ** minorUnitScale).toFixed(minorUnitScale),
    currency: currencyCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as unknown as ListingRecord;
}

type ResolvedMarket = Awaited<ReturnType<typeof marketFor>>;

export async function searchMarketplaceListings(
  market: ResolvedMarket,
  options: {
    search?: string;
    conversational?: boolean;
    category?: string;
    categoryId?: string;
    filters?: SearchFilter[];
    sort?: SearchSort;
    ownSellerId?: string;
    allowedIds?: string[];
    /** Restoring a stored result: listings whose stored placement was paid. */
    sponsoredIds?: string[];
    /** false: organic only (callers that apply their own relevance gate first). */
    sponsoredPlacement?: false;
    sponsoredSlots?: number;
    limit?: number;
  },
): Promise<ListingRecord[]> {
  await assertMarketLegalCapability(market.id, "BROWSING");
  const engine = searchEngine();
  const [allCategories, policyRules, inactiveBusinessListings] = await Promise.all([
    listMarketplaceCategories(true),
    activePolicyRules(market.id),
    inactiveBusinessListingIds(market.id),
  ]);
  const categoriesById = new Map(allCategories.map((item) => [item.id, item]));
  const schemasById = new Map(
    allCategories.map((item) => [item.id, categorySchemaFromRow(item)]),
  );
  const categoryLabelsById = new Map(
    allCategories.map((item) => [item.id, item.label]),
  );
  const categoryIdsByLabel = new Map(
    allCategories.map((item) => [item.label, item.id]),
  );
  const activeCategoryIds = new Set(
    allCategories.filter((item) => item.isActive).map((item) => item.id),
  );
  const categoryRow =
    options.categoryId || options.category
      ? await resolveMarketplaceCategory(options.categoryId, options.category)
      : undefined;
  if ((options.categoryId || options.category) && !categoryRow)
    throw marketError(400, "التصنيف غير موجود أو غير نشط");
  const schema = categoryRow ? categorySchemaFromRow(categoryRow) : undefined;
  const category = categoryRow?.label;
  const filtersValid = validateSearchFilters(
    categoryRow?.id,
    options.filters,
    schema,
  );
  if (!filtersValid.ok) throw new Error(filtersValid.reason);
  const term = (options.search ?? "").slice(0, 200).toLocaleLowerCase("ar");
  // «فني مكيفات», «معلم بلاط»: a generic role noun names who does the work, not a word
  // the listing must contain; it is dropped only when other words remain.
  // «…مستعملة؟»: punctuation is a word break, never part of a word to find.
  const allTokens = normalizeSearch(term.replace(/[؟?!،,؛;.()«»"']+/gu, " ")).split(/\s+/).filter(Boolean);
  const meaningful = allTokens.filter((token) => !SERVICE_ROLE_WORDS.has(token));
  const tokens = itemTokens(meaningful.length ? meaningful : allTokens);
  // Product words that are also category aliases ("سماعات") match inflections by stem.
  const aliasTokens = new Set(
    (categoryRow?.aliases ?? []).map((alias) => normalizeSearch(alias)),
  );
  const tokenNeedle = (token: string) =>
    aliasTokens.has(token) ? aliasStem(token) || token : token;
  const minorUnitScale = "minorUnitScale" in market ? market.minorUnitScale : 3;
  const matchesFilters = (offer: typeof offers.$inferSelect) =>
    (options.filters ?? []).every((filter) => {
      const actual =
        filter.field === "price"
          ? offer.unitPriceMinor === null
            ? undefined
            : offer.unitPriceMinor / 10 ** minorUnitScale
          : filter.field === "city" ||
              (filter.field === "area" && !schema?.attributes.area)
            ? offer.data[filter.field] ?? ""
          : offer.data.attributes?.[filter.field];
      if (actual == null) return false;
      if (typeof filter.value === "number") {
        const numericActual = typeof actual === "number" ? actual : Number(actual);
        if (!Number.isFinite(numericActual)) return false;
        switch (filter.operator) {
          case "eq": return numericActual === filter.value;
          case "ne": return numericActual !== filter.value;
          case "gt": return numericActual > filter.value;
          case "gte": return numericActual >= filter.value;
          case "lt": return numericActual < filter.value;
          case "lte": return numericActual <= filter.value;
          default: return false;
        }
      }
      const normalizedActual = normalizeSearch(String(actual));
      const normalizedValue = normalizeSearch(filter.value);
      switch (filter.operator) {
        case "eq": return normalizedActual === normalizedValue;
        // Negation excludes every inflection that contains the unwanted value.
        case "ne": return !normalizedActual.includes(normalizedValue);
        case "contains": return normalizedActual.includes(normalizedValue);
        default: return false;
      }
    });
  // The same text the C1 search documents store (marketplace-search-index.ts).
  const textContext = searchTextContext(allCategories);
  const searchableText = (offer: typeof offers.$inferSelect) => searchableTextOf(offer, textContext);
  // Every server-side eligibility rule, applied to each candidate exactly as before C1.
  const accepted = ({ offer, seller }: OfferRow) =>
    !inactiveBusinessListings.has(offer.id) &&
    seller.status === "ACTIVE" &&
        !market.restrictedCategories.includes(offer.data.category) &&
        !market.restrictedCategories.includes(offer.data.categoryId ?? "") &&
        !market.restrictedCategories.includes(
          categoryLabelsById.get(offer.data.categoryId) ?? "",
        ) &&
        (options.ownSellerId
          ? offer.sellerId === options.ownSellerId
          : offer.status === "PUBLISHED" &&
            !offerPolicyViolation(policyRules, offer, categoriesById)) &&
        (!category ||
          offer.data.categoryId === categoryRow?.id ||
          (!offer.data.categoryId && offer.data.category === category)) &&
        matchesFilters(offer) &&
        (!options.allowedIds || options.allowedIds.includes(offer.id)) &&
        (!options.conversational ||
          offer.inventoryMode === "UNLIMITED" ||
          (offer.availableQuantity ?? 0) - offer.reservedQuantity > 0) &&
        (options.conversational
          ? (() => {
              const text = searchableText(offer);
              // Category-alias words keep their stem rule and, like other words, also match their
              // general Arabic forms and everyday synonyms («هاتف» ↔ «جوال»; lib/arabic-search-terms.ts).
              return tokens.every((token) =>
                (aliasTokens.has(token) && text.includes(tokenNeedle(token))) || textMatchesToken(text, token),
              );
            })()
          : searchableText(offer).includes(normalizeSearch(term)));
  const requestedSort =
    options.sort ?? schema?.rules.sorting.defaultSort ?? undefined;
  type SortField = "PRICE" | "CREATED_AT" | "ATTRIBUTE";
  type SortDirection = "ASC" | "DESC";
  let sortField: SortField | undefined;
  let sortDirection = "DESC" as SortDirection;
  let sortDefinition: NonNullable<typeof schema>["rules"]["sorting"]["options"][number] | undefined;
  if (requestedSort && requestedSort !== "RELEVANCE") {
    sortDefinition = schema?.rules.sorting.options.find(
      (option) => option.id === requestedSort,
    );
    const globalSort =
      !schema &&
      ["PRICE_ASC", "PRICE_DESC", "NEWEST"].includes(requestedSort);
    if (!sortDefinition && !globalSort)
      throw marketError(
        400,
        `الترتيب ${requestedSort} غير مدعوم لهذا التصنيف.`,
      );
    sortField = (sortDefinition?.field ??
      (requestedSort === "NEWEST" ? "CREATED_AT" : "PRICE")) as SortField;
    sortDirection =
      (sortDefinition?.direction ??
      (requestedSort === "PRICE_ASC" ? "ASC" : "DESC")) as SortDirection;
  }
  const limit = options.limit ?? 24;
  // Sponsored slots apply to the default view only (see below); they need every eligible paid
  // listing's organic position, so the SQL scan continues until it has passed all of them.
  const defaultView =
    !options.sort ||
    options.sort === "RELEVANCE" ||
    options.sort === (schema?.rules.sorting.defaultSort ?? "NEWEST");
  const sponsoredSlotCount =
    options.ownSellerId || options.sponsoredPlacement === false || !defaultView || options.allowedIds
      ? 0
      : options.sponsoredSlots ?? (await getCommercialPolicy(market.id)).searchSponsoredSlots;
  const matchedRows: OfferRow[] =
    engine === "LEGACY"
      ? await legacyCandidates(market.id, accepted)
      : await sqlCandidates({
          market,
          accepted,
          limit,
          options,
          categoryRow,
          sortField,
          sortDirection,
          textNeedles: options.conversational
            ? tokens.map((token) => [...new Set([token, ...tokenVariants(token), ...(aliasTokens.has(token) ? [tokenNeedle(token)] : [])])])
            : normalizeSearch(term)
              ? [[normalizeSearch(term)]]
              : [],
          sponsoredSlots: sponsoredSlotCount,
        });
  if (sortField) {
    const field = sortField;
    const direction: SortDirection = sortDirection;
    matchedRows.sort((a, b) => {
      const getValue = (offer: typeof offers.$inferSelect) => {
        if (field === "PRICE") return offer.unitPriceMinor;
        if (field === "CREATED_AT") return offer.createdAt.getTime();
        const attribute = sortDefinition?.attribute;
        const raw = attribute ? offer.data.attributes?.[attribute] : undefined;
        const numeric = typeof raw === "number" ? raw : Number(raw);
        return Number.isFinite(numeric) ? numeric : null;
      };
      const av = getValue(a.offer);
      const bv = getValue(b.offer);
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      if (av !== null && bv !== null && av !== bv)
        return direction === "ASC" ? av - bv : bv - av;
      return b.offer.createdAt.getTime() - a.offer.createdAt.getTime();
    });
  }
  const toRecord = ({ offer, seller }: OfferRow, sponsored: boolean | PaidSlot): ListingRecord => {
    const categoryId =
      typeof offer.data.categoryId === "string"
        ? offer.data.categoryId
        : categoryIdsByLabel.get(String(offer.data.category ?? ""));
    return {
      ...listing(offer, seller, market, options.ownSellerId === offer.sellerId),
      ...(categoryId ? { categoryId } : {}),
      ...(sponsored ? { isSponsored: true } : {}),
      ...(typeof sponsored === "object"
        ? { sponsoredCampaignId: sponsored.promotionId, sponsoredPlacement: sponsored.placement, sponsoredTier: sponsored.placement === "VIP" ? "VIP" as const : "STANDARD" as const }
        : {}),
    };
  };

  // A stored result keeps its order; a paid label is shown only where the stored
  // placement was paid, and only for listings that are still publicly eligible.
  if (options.allowedIds) {
    const byId = new Map(matchedRows.map((row) => [row.offer.id, row]));
    const paid = new Set(options.ownSellerId ? [] : options.sponsoredIds ?? []);
    return options.allowedIds
      .map((id) => byId.get(id))
      .filter((row): row is OfferRow => !!row)
      .slice(0, limit)
      .map((row) => toRecord(row, paid.has(row.offer.id)));
  }

  // Sponsored placement composes with organic relevance and never replaces it:
  // only rows that already passed market, moderation, seller, category, hard
  // filters, availability and query relevance may be lifted into a capped number
  // of labelled slots. The default view (relevance or the category's default
  // order) carries those slots; an order the user chose instead, such as cheapest
  // first, is never reordered or labelled by payment.
  const paidSlots: Map<string, PaidSlot> =
    options.ownSellerId ||
    options.sponsoredPlacement === false ||
    !defaultView
      ? new Map<string, PaidSlot>()
      : await sponsoredPlacementIds(
          market,
          matchedRows,
          {
            categoryId: categoryRow?.id,
            queryText: tokens.join(" "),
            searchableText,
            categoryIdOf: (offer) =>
              typeof offer.data.categoryId === "string"
                ? offer.data.categoryId
                : categoryIdsByLabel.get(String(offer.data.category ?? "")),
            activeCategoryIds,
          },
          sponsoredSlotCount,
        );
  // Paid slots first in score order; the organic rest keeps its canonical order.
  const rowsById = new Map(matchedRows.map((row) => [row.offer.id, row]));
  const ordered = [
    ...[...paidSlots.keys()].map((id) => rowsById.get(id)!),
    ...matchedRows.filter((row) => !paidSlots.has(row.offer.id)),
  ];
  return ordered.slice(0, limit).map((row) => toRecord(row, paidSlots.get(row.offer.id) ?? false));
}

/**
 * Deterministic paid slots: among eligible rows with a serving campaign, the first
 * `slots` in organic relevance order. Each listing appears once (duplicate
 * suppression); stacked historical campaigns never add weight.
 */
async function sponsoredPlacementIds(
  market: ResolvedMarket,
  rankedRows: OfferRow[],
  context: {
    categoryId?: string;
    queryText: string;
    searchableText: (offer: typeof offers.$inferSelect) => string;
    categoryIdOf: (offer: typeof offers.$inferSelect) => string | undefined;
    activeCategoryIds: Set<string>;
  },
  slots: number,
): Promise<Map<string, PaidSlot>> {
  if (slots <= 0 || !rankedRows.length || !isPromotionSimulationEnabled())
    return new Map();
  const now = new Date();
  const campaigns = await servingCampaignsFor(
    market.id,
    rankedRows.map((row) => row.offer.id),
    now,
  );
  const rowsById = new Map(rankedRows.map((row) => [row.offer.id, row]));
  const eligible = new Set<string>();
  for (const campaign of campaigns) {
    const row = rowsById.get(campaign.listingId);
    if (!row) continue;
    const categoryId = context.categoryIdOf(row.offer);
    if (
      categoryId &&
      context.activeCategoryIds.has(categoryId) &&
      row.seller.status === "ACTIVE" &&
      isEligibleSearchPromotion(
        campaign,
        {
          id: row.offer.id,
          marketId: row.offer.marketId,
          categoryId,
          status: row.offer.status,
        },
        {
          marketId: market.id,
          categoryId: context.categoryId,
          queryText: context.queryText,
          searchableText: context.searchableText(row.offer),
          now,
          simulationEnabled: true,
        },
      )
    )
      eligible.add(campaign.listingId);
  }
  // Every candidate here already passed the organic gates; money only orders them.
  const ranked = rankSponsored(
    rankedRows.flatMap((row, organicIndex) => {
      if (!eligible.has(row.offer.id)) return [];
      const campaign = representativeCampaign(campaigns, row.offer.id)!;
      return [{
        id: row.offer.id,
        score: sponsoredScore({
          organicIndex,
          priorityWeight: campaign.priorityWeightSnapshot,
          unitChargeMinor: campaign.unitChargeMinorSnapshot,
          minorUnitScale: market.minorUnitScale,
          hasImage: Boolean(row.offer.data.imageUrl),
          descriptionLength: String(row.offer.data.description ?? "").length,
        }),
      }];
    }),
    slots,
  );
  return new Map(ranked.map((item) => {
    const campaign = representativeCampaign(campaigns, item.id)!;
    return [item.id, { promotionId: campaign.id, placement: campaign.placementSnapshot }];
  }));
}

type PaidSlot = { promotionId: string; placement: string };

// ─── C1: candidate sources ───────────────────────────────────────────────────

/**
 * DINAR_SEARCH_ENGINE: SQL (default) reads a bounded, indexed superset of candidates from PostgreSQL;
 * LEGACY loads every listing of the market (the pre-C1 path), kept for comparison and rollback.
 * Both apply the same eligibility predicates, sort and sponsored placement in JavaScript.
 */
export function searchEngine(env: NodeJS.ProcessEnv = process.env): "SQL" | "LEGACY" {
  return (env.DINAR_SEARCH_ENGINE ?? "").trim().toUpperCase() === "LEGACY" ? "LEGACY" : "SQL";
}

export type SearchStats = { engine: "SQL" | "LEGACY"; rowsRead: number; batches: number; matched: number; staleRows: number; textIndexUsed: boolean; ms?: { textCandidates: number; sponsoredLookup: number; batches: number; sellers: number; predicates: number }; sql?: { sql: string; params: unknown[] } };
let lastStats: SearchStats | undefined;
/** Diagnostics of the most recent search in this process (tests and benchmarks). */
export function lastSearchStats(): SearchStats | undefined {
  return lastStats;
}

async function legacyCandidates(marketId: string, accepted: (row: OfferRow) => boolean): Promise<OfferRow[]> {
  // The whole market, as before C1 — in the same deterministic organic order as the SQL engine
  // (the pre-C1 order was the heap's, which the database never guaranteed).
  const rows: OfferRow[] = await db
    .select({ offer: offers, seller: users })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(eq(offers.marketId, marketId))
    .orderBy(asc(offers.createdAt), asc(offers.id));
  const matched = rows.filter(accepted);
  lastStats = { engine: "LEGACY", rowsRead: rows.length, batches: 1, matched: matched.length, staleRows: 0, textIndexUsed: false };
  return matched;
}

/** Above this many text candidates the batches use the inline subquery instead of an id list. */
const TEXT_CANDIDATE_CAP = 20_000;
const likeNeedle = (needle: string) => `%${needle.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/**
 * The SQL candidate stage. Every condition here is implied by the JavaScript predicates (a superset),
 * so `accepted` still decides; the scan reads candidates in the final order, in bounded keyset batches,
 * and stops once it has `limit` accepted rows and has passed every possibly-sponsored listing.
 *  - exact: market, active seller, PUBLISHED or own seller, allowedIds, conversational availability;
 *  - widened: category (id or label), price (±1 minor unit), text (any needle of each token in a fresh
 *    document — a stale row is always a candidate);
 *  - left to JavaScript: restricted categories, policy rules, other filters, exact text rules.
 */
async function sqlCandidates(input: {
  market: ResolvedMarket;
  accepted: (row: OfferRow) => boolean;
  limit: number;
  options: Parameters<typeof searchMarketplaceListings>[1];
  categoryRow?: { id: string; label: string };
  sortField?: "PRICE" | "CREATED_AT" | "ATTRIBUTE";
  sortDirection: "ASC" | "DESC";
  textNeedles: string[][];
  sponsoredSlots: number;
}): Promise<OfferRow[]> {
  const { market, options } = input;
  const stats: SearchStats = { engine: "SQL", rowsRead: 0, batches: 0, matched: 0, staleRows: 0, textIndexUsed: false, ms: { textCandidates: 0, sponsoredLookup: 0, batches: 0, sellers: 0, predicates: 0 } };
  const clock = () => performance.now();
  lastStats = stats;
  if (options.allowedIds && !options.allowedIds.length) return [];
  // Sellers are not joined: the candidate query reads offers alone, so PostgreSQL can walk the
  // (market, status, created_at, id) index in order and stop at the batch size. The active-seller
  // rule stays in `accepted` (sellers are loaded per batch by id).
  const conditions: SQL[] = [eq(offers.marketId, market.id)];
  conditions.push(options.ownSellerId ? eq(offers.sellerId, options.ownSellerId) : eq(offers.status, "PUBLISHED"));
  // Same rule as `accepted`: a listing whose business is not ACTIVE is not a candidate.
  conditions.push(sql`NOT EXISTS (
    SELECT 1
    FROM business_profiles d2
    LEFT JOIN business_operating_profiles bp ON bp.d2_business_id = d2.id
    WHERE d2.id = ${offers.businessProfileId}
      AND (d2.verification_status <> 'VERIFIED' OR d2.publication_status <> 'PUBLISHED'
        OR (bp.id IS NOT NULL AND (bp.market_id <> ${market.id} OR bp.status <> 'ACTIVE')))
  )`);
  if (options.allowedIds) conditions.push(inArray(offers.id, [...new Set(options.allowedIds)]));
  if (options.conversational)
    conditions.push(sql`(${offers.inventoryMode} = 'UNLIMITED' OR coalesce(${offers.availableQuantity}, 0) - ${offers.reservedQuantity} > 0)`);
  if (input.categoryRow)
    conditions.push(sql`(${offers.data}->>'categoryId' = ${input.categoryRow.id} OR ${offers.data}->>'category' = ${input.categoryRow.label})`);
  const scale = 10 ** ("minorUnitScale" in market ? market.minorUnitScale : 3);
  for (const filter of options.filters ?? []) {
    if (filter.field !== "price") continue;
    conditions.push(sql`${offers.unitPriceMinor} IS NOT NULL`);
    if (typeof filter.value !== "number" || !Number.isFinite(filter.value)) continue;
    const target = filter.value * scale;
    if (filter.operator === "eq") conditions.push(sql`${offers.unitPriceMinor} BETWEEN ${Math.floor(target) - 1} AND ${Math.ceil(target) + 1}`);
    else if (filter.operator === "gt" || filter.operator === "gte") conditions.push(sql`${offers.unitPriceMinor} >= ${Math.floor(target) - 1}`);
    else if (filter.operator === "lt" || filter.operator === "lte") conditions.push(sql`${offers.unitPriceMinor} <= ${Math.ceil(target) + 1}`);
  }
  const needles = input.textNeedles.filter((group) => group.length && !group.includes(""));
  // A bounded text candidate set is ordered once by PostgreSQL (ids only), then read in that order.
  let textIdList = false;
  if (needles.length && (await searchTextVersionReady())) {
    stats.textIndexUsed = true;
    // Each token: any of its needles (LIKE ANY lets pg_trgm combine the patterns in one GIN scan).
    // No text_version predicate here: when any document has another version, documents are not used.
    const matching = sql.join(
      needles.map((group) => sql`d.search_text LIKE ANY (${sql.param(group.map(likeNeedle))}::text[])`),
      sql` AND `,
    );
    // Candidates: listings whose current document matches every token, plus every stale listing of
    // this market (its document cannot be trusted, so it is always a candidate). Evaluated once per
    // search and reused by every batch; a very broad match keeps the inline subquery instead.
    const textCandidates = sql`SELECT d.offer_id AS id FROM ${offerSearchDocuments} d WHERE ${matching} UNION SELECT s.id FROM ${offers} s WHERE s.market_id = ${market.id} AND s.search_document_stale`;
    const textStarted = clock();
    const ids = (await db.execute(sql`${textCandidates} LIMIT ${TEXT_CANDIDATE_CAP + 1}`)).rows.map((row) => (row as { id: string }).id);
    stats.ms!.textCandidates = clock() - textStarted;
    if (!ids.length) return [];
    textIdList = ids.length <= TEXT_CANDIDATE_CAP;
    conditions.push(
      textIdList
        ? sql`${offers.id} IN (SELECT unnest(${sql.param(ids)}::text[]))`
        : sql`${offers.id} IN (${textCandidates})`,
    );
  }
  const where = and(...conditions)!;

  // The final order, as sort keys PostgreSQL can walk; JavaScript re-sorts identically (stable).
  // Organic (no explicit sort): creation time, then id — the pre-C1 order was the heap's, unspecified.
  const priceMissing = sql<number>`(${offers.unitPriceMinor} IS NULL)::int`;
  const price = sql<number>`coalesce(${offers.unitPriceMinor}, 0)`;
  type Key = { expr: SQL; dir: "ASC" | "DESC"; cast: string };
  const created: Key = { expr: sql`${offers.createdAt}`, dir: "ASC", cast: "timestamptz" };
  const id: Key = { expr: sql`${offers.id}`, dir: "ASC", cast: "text" };
  const keys: Key[] =
    input.sortField === "PRICE"
      ? [{ expr: priceMissing, dir: "ASC", cast: "int" }, { expr: price, dir: input.sortDirection, cast: "bigint" }, { ...created, dir: "DESC" }, id]
      : input.sortField === "CREATED_AT"
        ? [{ ...created, dir: input.sortDirection }, id]
        : [created, id];
  // Attribute sorts keep JavaScript's exact numeric coercion, and a stored result keeps its own id
  // order: both read their (bounded) candidate set in full. Everything else may stop early.
  const readAll = input.sortField === "ATTRIBUTE" || Boolean(options.allowedIds);

  const orderOf = keys.map((key) => (key.dir === "ASC" ? asc(key.expr) : desc(key.expr)));
  let orderedIds: string[] | undefined;
  if (textIdList) {
    const started = clock();
    const orderedQuery = db.select({ id: offers.id }).from(offers).where(where).orderBy(...orderOf);
    if (process.env.DINAR_SEARCH_CAPTURE_SQL === "1") stats.sql = orderedQuery.toSQL();
    orderedIds = (await orderedQuery).map((row) => row.id);
    stats.ms!.batches += clock() - started;
  }
  let pendingSponsored = new Set<string>();
  const sponsoredStarted = clock();
  if (!readAll && input.sponsoredSlots > 0 && isPromotionSimulationEnabled()) {
    const now = new Date();
    const serving = await db
      .selectDistinct({ id: listingPromotions.listingId })
      .from(listingPromotions)
      .where(and(
        eq(listingPromotions.marketId, market.id),
        eq(listingPromotions.status, "ACTIVE"),
        inArray(listingPromotions.paymentStatus, [...SERVING_PAYMENT_STATUSES]),
        eq(listingPromotions.paymentMode, "DEVELOPMENT_SIMULATED"),
        inArray(listingPromotions.placementSnapshot, [...SEARCH_PLACEMENTS]),
        sql`${listingPromotions.startsAt} <= ${now}`,
        sql`${listingPromotions.expiresAt} > ${now}`,
      ));
    if (serving.length && orderedIds) {
      const candidates = new Set(orderedIds);
      pendingSponsored = new Set(serving.map((row) => row.id).filter((id) => candidates.has(id)));
    } else if (serving.length) {
      const inSuperset = await db
        .select({ id: offers.id })
        .from(offers)
        .where(and(where, inArray(offers.id, serving.map((row) => row.id))));
      pendingSponsored = new Set(inSuperset.map((row) => row.id));
    }
  }
  stats.ms!.sponsoredLookup = clock() - sponsoredStarted;

  const matched: OfferRow[] = [];
  const sellers = new Map<string, typeof users.$inferSelect>();
  let cursor: string[] | undefined;
  // A set read in full starts large; an early-stopping scan starts near the requested size.
  let batch = readAll ? 2_000 : Math.min(Math.max(input.limit * 2, 50), 500);
  let position = 0;
  for (;;) {
    let rows: Array<{ offer: typeof offers.$inferSelect; k?: string[] }>;
    const batchStarted = clock();
    if (orderedIds) {
      const chunk = orderedIds.slice(position, position + batch);
      position += chunk.length;
      const byId = new Map(
        (chunk.length ? await db.select().from(offers).where(sql`${offers.id} IN (SELECT unnest(${sql.param(chunk)}::text[]))`) : []).map((offer) => [offer.id, offer]),
      );
      // A row edited between the two reads keeps the eligibility checks below; one deleted is skipped.
      rows = chunk.flatMap((id) => (byId.has(id) ? [{ offer: byId.get(id)! }] : []));
      if (chunk.length < batch) position = Number.POSITIVE_INFINITY;
    } else {
    const after = cursor ? keysetAfter(keys, cursor) : undefined;
    const query = db
      .select({ offer: offers, k: sql<string[]>`ARRAY[${sql.join(keys.map((key) => sql`(${key.expr})::text`), sql`, `)}]` })
      .from(offers)
      .where(after ? and(where, after) : where)
      .orderBy(...orderOf)
      .limit(batch);
    // Benchmarks only (DINAR_SEARCH_CAPTURE_SQL=1): the first batch's statement, for EXPLAIN ANALYZE.
    if (!stats.sql && process.env.DINAR_SEARCH_CAPTURE_SQL === "1") stats.sql = query.toSQL();
    rows = await query;
    }
    stats.ms!.batches += clock() - batchStarted;
    stats.batches += 1;
    stats.rowsRead += rows.length;
    const missingSellers = [...new Set(rows.map((row) => row.offer.sellerId))].filter((sellerId) => !sellers.has(sellerId));
    const sellersStarted = clock();
    if (missingSellers.length)
      for (const seller of await db.select().from(users).where(inArray(users.id, missingSellers))) sellers.set(seller.id, seller);
    stats.ms!.sellers += clock() - sellersStarted;
    const predicatesStarted = clock();
    for (const row of rows) {
      pendingSponsored.delete(row.offer.id);
      if (row.offer.searchDocumentStale) stats.staleRows += 1;
      const seller = sellers.get(row.offer.sellerId);
      if (seller && input.accepted({ offer: row.offer, seller })) matched.push({ offer: row.offer, seller });
    }
    stats.ms!.predicates += clock() - predicatesStarted;
    stats.matched = matched.length;
    if (orderedIds ? position >= orderedIds.length : rows.length < batch) break;
    if (!readAll && matched.length >= input.limit && pendingSponsored.size === 0) break;
    if (!orderedIds) cursor = rows.at(-1)!.k;
    batch = Math.min(batch * 2, 2_000);
  }
  return matched;
}

/** Rows strictly after `cursor` in the order of `keys` (lexicographic, per-key direction). */
function keysetAfter(keys: { expr: SQL; dir: "ASC" | "DESC"; cast: string }[], cursor: string[]): SQL {
  const value = (index: number) => sql`${cursor[index]}::${sql.raw(keys[index]!.cast)}`;
  return or(
    ...keys.map((key, index) =>
      and(
        ...keys.slice(0, index).map((previous, earlier) => sql`(${previous.expr}) = ${value(earlier)}`),
        key.dir === "ASC" ? sql`(${key.expr}) > ${value(index)}` : sql`(${key.expr}) < ${value(index)}`,
      ),
    ),
  )!;
}
