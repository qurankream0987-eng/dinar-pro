import assert from "node:assert/strict";
import test from "node:test";
import {
  canConfigurePromotionCatalog,
  isEligibleSearchPromotion,
  isPromotionFeatureEnabled,
  isPromotionSimulationEnabled,
  type PromotionCampaignSnapshot,
  type PromotionListingSnapshot,
} from "../src/lib/promotion-policy";

const now = new Date("2026-01-15T12:00:00.000Z");
const campaign: PromotionCampaignSnapshot = {
  marketId: "market-kw",
  categoryIdSnapshot: "cars",
  status: "ACTIVE",
  paymentMode: "DEVELOPMENT_SIMULATED",
  paymentStatus: "SIMULATION_CAPTURED",
  placementSnapshot: "SEARCH_AND_CHAT",
  startsAt: new Date("2026-01-01T00:00:00.000Z"),
  expiresAt: new Date("2026-02-01T00:00:00.000Z"),
};
const listing: PromotionListingSnapshot = {
  id: "listing-1",
  marketId: "market-kw",
  categoryId: "cars",
  status: "PUBLISHED",
};
const options = {
  marketId: "market-kw",
  categoryId: "cars",
  queryText: "used car",
  searchableText: "used car for sale",
  now,
  simulationEnabled: true,
};

test("only active development campaigns for the same market and category are eligible", () => {
  assert.equal(isEligibleSearchPromotion(campaign, listing, options), true);
  assert.equal(
    isEligibleSearchPromotion(campaign, listing, {
      ...options,
      marketId: "market-bh",
    }),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(
      { ...campaign, marketId: "market-bh" },
      listing,
      options,
    ),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(
      { ...campaign, categoryIdSnapshot: "property" },
      listing,
      options,
    ),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(
      campaign,
      { ...listing, categoryId: "property" },
      options,
    ),
    false,
  );
});

test("expired, not-yet-started, non-published, or non-search campaigns do not surface", () => {
  assert.equal(
    isEligibleSearchPromotion(
      { ...campaign, expiresAt: new Date(now.getTime()) },
      listing,
      options,
    ),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(
      { ...campaign, startsAt: new Date(now.getTime() + 1) },
      listing,
      options,
    ),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(
      { ...campaign, status: "CANCELLED" },
      listing,
      options,
    ),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(
      { ...campaign, placementSnapshot: "DETAIL_PAGE" },
      listing,
      options,
    ),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(
      { ...campaign, paymentMode: "REAL_PAYMENT" },
      listing,
      options,
    ),
    false,
  );
});

test("only a captured simulated payment can serve, whatever the status says", () => {
  for (const paymentStatus of ["SIMULATION_PENDING", "SIMULATION_FAILED", "LEGACY_UNVERIFIED"])
    assert.equal(
      isEligibleSearchPromotion({ ...campaign, paymentStatus }, listing, options),
      false,
    );
});

test("campaign must still match the user's search terms", () => {
  assert.equal(
    isEligibleSearchPromotion(campaign, listing, {
      ...options,
      queryText: "real estate",
    }),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(campaign, listing, {
      ...options,
      categoryId: "property",
    }),
    false,
  );
  assert.equal(
    isEligibleSearchPromotion(campaign, listing, {
      ...options,
      simulationEnabled: false,
    }),
    false,
  );
});

test("simulated purchases are enabled only in development or test", () => {
  assert.equal(isPromotionSimulationEnabled("development", true), true);
  assert.equal(isPromotionSimulationEnabled("test", true), true);
  assert.equal(isPromotionSimulationEnabled("production", true), false);
  assert.equal(isPromotionSimulationEnabled("staging", true), false);
  assert.equal(isPromotionSimulationEnabled(undefined, true), false);
  assert.equal(isPromotionSimulationEnabled("development", false), false);
  assert.equal(isPromotionFeatureEnabled("true"), true);
  assert.equal(isPromotionFeatureEnabled(undefined), false);
});

test("promotion catalog configuration is administrator-only", () => {
  assert.equal(canConfigurePromotionCatalog("ADMIN"), true);
  assert.equal(canConfigurePromotionCatalog("USER"), false);
  assert.equal(canConfigurePromotionCatalog(undefined), false);
});