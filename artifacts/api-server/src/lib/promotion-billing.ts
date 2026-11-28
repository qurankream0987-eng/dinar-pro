/**
 * Jassim Ads payment collection, provider-neutral (owner decision 2026-11-28).
 *
 * JassimAI owns the promotion: its product, price, duration, placement, activation and records.
 * A provider only collects the money and reports the result. Whop is one registered provider today;
 * a local gateway can be registered tomorrow without changing the ads flow. Mirrors the existing
 * SubscriptionBillingProvider registry used by JassimAI subscriptions.
 *
 * A provider:
 *   - opens a hosted checkout for the server's own price snapshot (never a client amount);
 *   - verifies its own signed events, re-reads the payment from its own API, and hands the facts to
 *     `applyPromotionProviderEvent` — which alone decides what the campaign becomes.
 */

/** A provider money value as a decimal string in major units, with its ISO currency. */
export type ProviderMoney = { amount: string; currency: string };

/** What the provider's own API says about one payment, read by the server after a signed event. */
export type PromotionPaymentFacts = {
  /** "paid" when the provider reports the payment as settled; anything else is not paid. */
  status: string;
  /** The provider-side merchant account the payment belongs to (must be JassimAI's). */
  accountId?: string | null;
  /** The JassimAI user the checkout was opened for (from the provider metadata we set). */
  ownerUserId?: string;
  /** Pre-tax amount: compared with the server's price snapshot. */
  subtotal?: ProviderMoney | null;
  total?: ProviderMoney | null;
  refunded?: ProviderMoney | null;
};

export type PromotionProviderEvent = {
  providerKey: string;
  /** The provider's own event id: one event changes a campaign at most once. */
  eventId: string;
  type: "PAID" | "FAILED" | "REFUNDED" | "DISPUTED";
  eventType: string;
  digest: string;
  promotionId: string;
  facts: PromotionPaymentFacts;
  /** JassimAI's merchant account at this provider. */
  expectedAccountId: string;
};

export type PromotionCheckoutRequest = {
  promotionId: string;
  userId: string;
  currencyCode: string;
  priceMinor: number;
  scale: number;
  productRef: string;
  title: string;
};

export interface PromotionBillingProvider {
  key: string;
  /** Shown to the seller: «الدفع عبر …». */
  displayName: string;
  /** Currencies this provider can charge in (others stay closed for paid promotions). */
  currencies: ReadonlySet<string>;
  createCheckout(input: PromotionCheckoutRequest): Promise<{ checkoutId: string; checkoutUrl: string }>;
  checkoutUrl(checkoutId: string): Promise<string>;
}

const providers = new Map<string, PromotionBillingProvider>();

export function registerPromotionBillingProvider(provider: PromotionBillingProvider) {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(provider.key)) throw new Error("invalid promotion provider key");
  providers.set(provider.key, provider);
}
export function unregisterPromotionBillingProvider(key: string) {
  providers.delete(key);
}
export function promotionBillingProvider(key: string | null | undefined) {
  return key ? providers.get(key) : undefined;
}

/** Exact major-unit decimal → integer minor units at `scale`; a fraction finer than the scale fails. */
export function providerMoneyToMinor(money: ProviderMoney, scale: number): number | undefined {
  const match = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(money.amount);
  if (!match) return undefined;
  const fraction = (match[2] ?? "").padEnd(scale, "0");
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return undefined;
  return Number(match[1]) * 10 ** scale + Number(fraction.slice(0, scale) || "0");
}
