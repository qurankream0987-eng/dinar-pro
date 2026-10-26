/**
 * «دينار — روح بِع لي» at the buyer's side (Monetization V3). Organic search always runs
 * first and keeps its results and order. Only when supply is zero, deterministically low
 * (fewer organic results than the policy threshold) or the buyer explicitly said none
 * fits, eligible DEMAND_CAPTURE campaigns may add at most the policy's number of clearly
 * labelled paid options after the organic results. The need is also recorded as a
 * DemandSignal for aggregate Market Pulse.
 */
import type { ListingRecord } from "./dinar-data";
import { getCommercialPolicy } from "./commercial-policy";
import { needFromSearch, recordDemandSignal, type DemandNeed } from "./demand-signals";
import { searchMarketplaceListings } from "./marketplace-listings";
import { demandCaptureCandidates } from "./promotions";

type Market = Parameters<typeof searchMarketplaceListings>[0];

export type DemandRescue = {
  listings: ListingRecord[];
  sponsoredCampaigns: Record<string, { promotionId: string; placement: string }>;
  trigger?: "ZERO_RESULTS" | "LOW_SUPPLY" | "USER_UNSATISFIED";
};

/** Paid demand options for a need, as canonical listing records labelled sponsored. */
export async function demandOptions(
  market: Market,
  need: DemandNeed,
  options: { excludeIds: string[]; viewerUserId?: string },
): Promise<DemandRescue> {
  const policy = await getCommercialPolicy(market.id);
  const picked = await demandCaptureCandidates(market, need, {
    excludeIds: options.excludeIds,
    slots: policy.demandRescueSlots,
    minCoverage: policy.demandRelevanceMinCoverage,
    viewerUserId: options.viewerUserId,
  });
  if (!picked.length) return { listings: [], sponsoredCampaigns: {} };
  const ids = picked.map((item) => item.listingId);
  const records = await searchMarketplaceListings(market, { search: "", allowedIds: ids, sponsoredIds: ids, limit: ids.length });
  const byId = new Map(records.map((record) => [record.id, record]));
  const sponsoredCampaigns: DemandRescue["sponsoredCampaigns"] = {};
  const listings: ListingRecord[] = [];
  for (const item of picked) {
    const record = byId.get(item.listingId);
    if (!record) continue;
    sponsoredCampaigns[item.listingId] = { promotionId: item.promotionId, placement: "DEMAND" };
    listings.push({ ...record, isSponsored: true, sponsoredCampaignId: item.promotionId, sponsoredPlacement: "DEMAND", sponsoredTier: "STANDARD" });
  }
  return { listings, sponsoredCampaigns };
}

/**
 * After an organic search turn: record the need and, on zero or low supply, append paid
 * demand options. The organic list is returned unchanged in front of them.
 */
export async function afterOrganicSearch(input: {
  market: Market;
  actorId?: string;
  query: Record<string, unknown>;
  listings: ListingRecord[];
}): Promise<DemandRescue & { need?: DemandNeed }> {
  const need = needFromSearch(input.market, input.query);
  if (!need || !input.actorId) return { listings: [], sponsoredCampaigns: {} };
  const organic = input.listings.filter((listing) => !listing.isSponsored);
  await recordDemandSignal({ market: input.market, userId: input.actorId, need, resultCount: organic.length });
  const policy = await getCommercialPolicy(input.market.id);
  const trigger = organic.length === 0 ? "ZERO_RESULTS" : organic.length < policy.lowSupplyThreshold ? "LOW_SUPPLY" : undefined;
  if (!trigger) return { listings: [], sponsoredCampaigns: {}, need };
  const rescue = await demandOptions(input.market, need, { excludeIds: input.listings.map((listing) => listing.id), viewerUserId: input.actorId });
  return { ...rescue, need, ...(rescue.listings.length ? { trigger } : {}) };
}
