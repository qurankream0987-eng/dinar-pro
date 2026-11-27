export type PromotionCampaignSnapshot = {
  marketId: string;
  categoryIdSnapshot: string;
  status: string;
  paymentMode: string;
  /** Only a captured simulated payment can ever serve. */
  paymentStatus: string;
  placementSnapshot: string;
  startsAt: Date;
  expiresAt: Date;
};

export type PromotionListingSnapshot = {
  id: string;
  marketId: string;
  categoryId?: string;
  status: string;
};

/** Verified simulated capture, commercial-balance charge or bundle unit; nothing else serves. */
const SIMULATED_SERVING_STATUSES: readonly string[] = ["SIMULATION_CAPTURED", "BALANCE_CHARGED", "ENTITLEMENT_CONSUMED"];
const SERVING_PAYMENT_STATUSES: readonly string[] = [...SIMULATED_SERVING_STATUSES, "PROVIDER_PAID"];

/**
 * Jassim Ads Phase 2: real direct payment per promotion through Whop. Off unless the deployment sets
 * DINAR_JASSIM_ADS_PAYMENTS=true (and promotions are enabled). Separate from the simulation switch.
 */
export function isWhopAdsPaymentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BDINAR_PROMOTIONS_ENABLED === "true" && env.DINAR_JASSIM_ADS_PAYMENTS?.trim().toLowerCase() === "true";
}

/** Payment modes whose campaigns may serve right now: simulation in development/test, Whop when live. */
export function servingPaymentModes(): string[] {
  return [...(isPromotionSimulationEnabled() ? ["DEVELOPMENT_SIMULATED"] : []), ...(isWhopAdsPaymentsEnabled() ? ["WHOP_LIVE"] : [])];
}

/** Sponsored placements serve at all only when at least one payment mode may serve. */
export function isSponsoredServingEnabled(): boolean {
  return servingPaymentModes().length > 0;
}

/** One campaign's payment proves it may serve: each mode only with its own statuses. */
export function campaignPaymentServes(campaign: { paymentMode: string; paymentStatus: string }): boolean {
  if (!servingPaymentModes().includes(campaign.paymentMode)) return false;
  return campaign.paymentMode === "WHOP_LIVE" ? campaign.paymentStatus === "PROVIDER_PAID" : SIMULATED_SERVING_STATUSES.includes(campaign.paymentStatus);
}
const SEARCH_SERVING_PLACEMENTS: readonly string[] = ["SEARCH_AND_CHAT", "FEATURED", "VIP", "REFRESH", "SPONSORED_SEARCH"];

export function isPromotionFeatureEnabled(
  configured?: string,
): boolean {
  const effectiveConfiguration =
    arguments.length === 0 ? process.env.BDINAR_PROMOTIONS_ENABLED : configured;
  return effectiveConfiguration === "true";
}

export function isPromotionSimulationEnabled(
  nodeEnv?: string,
  promotionsEnabled?: boolean,
): boolean {
  const effectiveNodeEnv =
    arguments.length === 0 ? process.env.NODE_ENV : nodeEnv;
  const effectivePromotionsEnabled =
    promotionsEnabled ?? isPromotionFeatureEnabled();
  return (
    effectivePromotionsEnabled &&
    (effectiveNodeEnv === "development" || effectiveNodeEnv === "test")
  );
}

export function canConfigurePromotionCatalog(role: string | undefined): boolean {
  return role === "ADMIN";
}

export function isEligibleSearchPromotion(
  campaign: PromotionCampaignSnapshot,
  listing: PromotionListingSnapshot,
  options: {
    marketId: string;
    categoryId?: string;
    queryText?: string;
    searchableText: string;
    now: Date;
    simulationEnabled: boolean;
    /** Placements that may serve in this surface (search by default). */
    placements?: readonly string[];
  },
): boolean {
  if (
    !options.simulationEnabled ||
    campaign.status !== "ACTIVE" ||
    !campaignPaymentServes(campaign) ||
    !SERVING_PAYMENT_STATUSES.includes(campaign.paymentStatus) ||
    !(options.placements ?? SEARCH_SERVING_PLACEMENTS).includes(campaign.placementSnapshot) ||
    campaign.marketId !== options.marketId ||
    listing.marketId !== options.marketId ||
    listing.status !== "PUBLISHED" ||
    !listing.categoryId ||
    campaign.categoryIdSnapshot !== listing.categoryId ||
    (options.categoryId !== undefined &&
      options.categoryId !== listing.categoryId) ||
    campaign.startsAt > options.now ||
    campaign.expiresAt <= options.now
  ) {
    return false;
  }

  const tokens = (options.queryText ?? "").trim().split(/\s+/).filter(Boolean);
  return tokens.every((token) => options.searchableText.includes(token));
}