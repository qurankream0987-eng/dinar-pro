import { aliasStem, normalizeSearch } from "../ai/search-context";
import {
  validateSearchFilters,
  type SearchFilter,
  type SearchSort,
} from "@workspace/api-zod/marketplace-schemas";
import {
  db,
  offers,
  users,
  type markets,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
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

export type OfferRow = {
  offer: typeof offers.$inferSelect;
  seller: typeof users.$inferSelect;
};

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
  return {
    id: row.id,
    title: typeof row.data.title === "string" ? row.data.title : "",
    description:
      typeof row.data.description === "string" ? row.data.description : "",
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
  const [rows, allCategories, policyRules] = await Promise.all([
    offerRows(market.id),
    listMarketplaceCategories(true),
    activePolicyRules(market.id),
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
  const allTokens = normalizeSearch(term).split(/\s+/).filter(Boolean);
  const meaningful = allTokens.filter((token) => !SERVICE_ROLE_WORDS.has(token));
  const tokens = meaningful.length ? meaningful : allTokens;
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
  const searchableText = (offer: typeof offers.$inferSelect) =>
    normalizeSearch(
      [
        offer.data.title,
        offer.data.description,
        offer.data.category,
        offer.data.city,
        offer.data.area,
        ...Object.entries(
          schemasById.get(
            typeof offer.data.categoryId === "string"
              ? offer.data.categoryId
              : categoryIdsByLabel.get(String(offer.data.category ?? "")) ?? "",
          )?.attributes ?? {},
        )
          .filter(([, definition]) => definition.searchable !== false)
          .map(([field]) => offer.data.attributes?.[field]),
      ]
        .filter((value) => value != null)
        .join(" "),
    );
  const matchedRows = rows
    .filter(
      ({ offer, seller }) =>
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
          ? tokens.every((token) => searchableText(offer).includes(tokenNeedle(token)))
          : searchableText(offer).includes(normalizeSearch(term))),
    );
  const requestedSort =
    options.sort ?? schema?.rules.sorting.defaultSort ?? undefined;
  if (requestedSort && requestedSort !== "RELEVANCE") {
    const sortDefinition = schema?.rules.sorting.options.find(
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
    const field = sortDefinition?.field ??
      (requestedSort === "NEWEST" ? "CREATED_AT" : "PRICE");
    const direction =
      sortDefinition?.direction ??
      (requestedSort === "PRICE_ASC" ? "ASC" : "DESC");
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
  const limit = options.limit ?? 24;
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
  const defaultView =
    !options.sort ||
    options.sort === "RELEVANCE" ||
    options.sort === (schema?.rules.sorting.defaultSort ?? "NEWEST");
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
          options.sponsoredSlots ?? (await getCommercialPolicy(market.id)).searchSponsoredSlots,
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
