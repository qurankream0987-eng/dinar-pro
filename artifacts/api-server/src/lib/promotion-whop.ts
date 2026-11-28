/**
 * Compatibility names for the Jassim Ads payment flow. The flow is provider-neutral
 * (see promotion-payments.ts); Whop is one registered PromotionBillingProvider (billing/whop.ts).
 */
export {
  promotionPaymentAvailability as whopPromotionAvailability,
  startPromotionCheckout as startWhopPromotionCheckout,
  applyPromotionProviderEvent,
  providerDirectApplies as whopDirectApplies,
  PROMOTION_PENDING_MINUTES as WHOP_PROMOTION_PENDING_MINUTES,
} from "./promotion-payments";
