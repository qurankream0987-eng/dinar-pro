/**
 * Compatibility shim — Jassim Ads Phase 2 is now provider-neutral in `lib/promotion-billing.ts`.
 */
export {
  applyPromotionBillingEvent,
  promotionBillingAvailability as whopPromotionAvailability,
  providerDirectApplies,
  providerPromotionReviewNote,
  startProviderPromotionCheckout as startWhopPromotionCheckout,
  type PromotionBillingAvailability as WhopPromotionAvailability,
  type ProviderPromotionCheckout as WhopPromotionCheckout,
} from "./promotion-billing";
