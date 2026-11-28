/**
 * M3 Store Checkout Adapter interface & lookup.
 *
 * Keeps store payment gateways strictly separate from Jassim's own commercial billing
 * (subscriptions, Jassim Ads) and from platform commissions.
 */
import { and, eq } from "drizzle-orm";
import { db, storeCheckoutAdapters } from "@workspace/db";

export type StoreCheckoutAdapterKind = "SIMULATED_GATEWAY" | "CUSTOM_OPENAPI";

export interface StoreCheckoutAdapterRecord {
  id: string;
  businessId: string;
  marketId: string;
  adapterKind: StoreCheckoutAdapterKind;
  displayName: string;
  enabled: boolean;
  supportedCountries: string[];
  supportedCurrencies: string[];
  minAmountMinor: number;
  maxAmountMinor: number | null;
  config: Record<string, unknown>;
}

export interface CreateCheckoutInput {
  sessionId: string;
  orderId: string;
  amountMinor: number;
  currencyCode: string;
  buyerId: string;
  returnUrl?: string;
}

export interface CreateCheckoutResult {
  providerSessionId: string;
  checkoutUrl: string;
}

export interface StoreCheckoutWebhookVerification {
  valid: boolean;
  reason?: string;
  eventId?: string;
  eventType?: "PAID" | "FAILED" | "EXPIRED" | "CANCELLED" | "IGNORED";
  providerSessionId?: string;
  orderId?: string;
  amountMinor?: number;
  currencyCode?: string;
  providerStatus?: string;
}

export interface StoreCheckoutAdapter {
  readonly kind: StoreCheckoutAdapterKind;
  readonly record: StoreCheckoutAdapterRecord;
  supports(input: { country: string; currency: string; amountMinor: number }): boolean;
  createSession(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  verifyWebhook(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
    parsedBody: Record<string, unknown>;
  }): Promise<StoreCheckoutWebhookVerification>;
  fetchSessionState(providerSessionId: string): Promise<{
    providerSessionId: string;
    status: "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "CANCELLED";
    orderId?: string;
    amountMinor?: number;
    currencyCode?: string;
  }>;
}

export function isSimulatedStoreGatewayEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DINAR_SIMULATED_STORE_GATEWAY === "true"
  );
}

export function isStoreCheckoutEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.DINAR_MERCHANT_POLICIES_M3 === "true"
  );
}

export function adapterSupports(
  adapter: Pick<
    StoreCheckoutAdapterRecord,
    "enabled" | "adapterKind" | "supportedCountries" | "supportedCurrencies" | "minAmountMinor" | "maxAmountMinor"
  >,
  input: { country: string; currency: string; amountMinor: number },
): boolean {
  if (!adapter.enabled) return false;
  if (adapter.adapterKind === "SIMULATED_GATEWAY" && !isSimulatedStoreGatewayEnabled()) {
    return false;
  }
  const country = input.country.trim().toUpperCase();
  const currency = input.currency.trim().toUpperCase();
  if (
    adapter.supportedCountries.length > 0 &&
    !adapter.supportedCountries.map((c) => c.toUpperCase()).includes(country)
  ) {
    return false;
  }
  if (
    adapter.supportedCurrencies.length > 0 &&
    !adapter.supportedCurrencies.map((c) => c.toUpperCase()).includes(currency)
  ) {
    return false;
  }
  if (input.amountMinor < adapter.minAmountMinor) return false;
  if (adapter.maxAmountMinor !== null && input.amountMinor > adapter.maxAmountMinor) return false;
  return true;
}

export async function findSupportingStoreCheckoutAdapter(input: {
  businessId: string | null;
  country: string;
  currency: string;
  amountMinor: number;
}): Promise<StoreCheckoutAdapterRecord | null> {
  if (!input.businessId || !isStoreCheckoutEnabled()) return null;
  const rows = await db
    .select()
    .from(storeCheckoutAdapters)
    .where(and(eq(storeCheckoutAdapters.businessId, input.businessId), eq(storeCheckoutAdapters.enabled, true)));
  for (const row of rows) {
    const rec: StoreCheckoutAdapterRecord = {
      id: row.id,
      businessId: row.businessId,
      marketId: row.marketId,
      adapterKind: row.adapterKind as StoreCheckoutAdapterKind,
      displayName: row.displayName,
      enabled: row.enabled,
      supportedCountries: row.supportedCountries ?? [],
      supportedCurrencies: row.supportedCurrencies ?? [],
      minAmountMinor: row.minAmountMinor,
      maxAmountMinor: row.maxAmountMinor,
      config: (row.config ?? {}) as Record<string, unknown>,
    };
    if (adapterSupports(rec, input)) return rec;
  }
  return null;
}
