import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoSellCampaignDraft, DEMAND_PRIVACY_THRESHOLD, evaluateCampaignAnalytics, scoreGoSellOpportunities, type SellerListingMetrics, type SellerMarketingMandate } from "../src/ai/jassim-go-sell-engine";
import { EXTERNAL_AD_PLATFORMS } from "../src/ai/external-ads-contract";

const mandate: SellerMarketingMandate = { mandateId: "mnd_1001", sellerId: "seller_42", marketId: "JO", currencyCode: "JOD", allowedListingIds: ["l1", "l2", "l3", "l4"], allowedPlacements: ["DEMAND_MATCH", "FEATURED_LISTING", "VIP_LISTING", "SPONSORED_SEARCH"], maxBudgetMinor: 5000, durationDays: 10, allowAutoOptimizationProposals: true, requireConfirmationForNewSpend: true };
const listings: SellerListingMetrics[] = [
  { listingId: "l1", title: "عطر عود فاخر", category: "عطور", stockQuantity: 8, unitPriceMinor: 3500, recentViews: 20, recentOrders: 1, matchedDemandCount: 14 },
  { listingId: "l2", title: "ساعة ذكية نفدت", category: "إلكترونيات", stockQuantity: 0, unitPriceMinor: 8900, recentViews: 200, recentOrders: 10, matchedDemandCount: 25 },
  { listingId: "l3", title: "حذاء رياضي", category: "أزياء", stockQuantity: 5, unitPriceMinor: 4200, recentViews: 80, recentOrders: 0, matchedDemandCount: 6 },
];

test("Jassim Go Sell: excludes 0-stock items and strictly enforces k >= 10 demand privacy threshold", () => {
  const scored = scoreGoSellOpportunities(listings, mandate);
  assert.equal(scored.some((s) => s.listingId === "l2"), false);
  assert.equal(scored[0].listingId, "l1");
  assert.equal(scored[0].recommendedPlacement, "DEMAND_MATCH");
  assert.equal(scored.find((s) => s.listingId === "l3")!.aggregatedDemandBadge, null);
  assert.equal(DEMAND_PRIVACY_THRESHOLD, 10);
});

test("Jassim Go Sell: enforces budget cap, blocks PRE_LEGAL & flags Whop-restricted markets honestly", () => {
  assert.throws(() => buildGoSellCampaignDraft({ mandate, listings, marketOperationMode: "FULL", requestedBudgetMinor: 9999 }));
  assert.equal(buildGoSellCampaignDraft({ mandate, listings, marketOperationMode: "PRE_LEGAL", requestedBudgetMinor: 2500 }).paymentChannelStatus, "MARKET_PRE_LEGAL_BLOCKED");
  assert.equal(buildGoSellCampaignDraft({ mandate: { ...mandate, marketId: "IQ", currencyCode: "IQD" }, listings, marketOperationMode: "FULL", requestedBudgetMinor: 2500 }).paymentChannelStatus, "LOCAL_ALTERNATIVE_REQUIRED");
});

test("Jassim Go Sell Analytics: never counts clicks as sales and gives honest optimization advice", () => {
  const clicksOnly = evaluateCampaignAnalytics({ campaignId: "c1", impressions: 1000, qualifiedClicks: 50, attributedOrders: 0, spendMinor: 2000, attributedRevenueMinor: 0 });
  assert.equal(clicksOnly.conversionRatePercent, 0);
  assert.equal(clicksOnly.cacMinor, null);
  assert.equal(EXTERNAL_AD_PLATFORMS.META_INSTAGRAM.status, "NOT_CONNECTED_YET");
});
