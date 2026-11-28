/**
 * M2 PAYMENT_OPTIONS card composer — builds ONE unified payment card per order from:
 *   1. Store's active `PAYMENT_METHODS` policy (if any, provenance: MERCHANT_POLICY vN),
 *   2. Seller's accepted direct/COD methods (`seller_payment_methods`, provenance: STORE_SYSTEM),
 *   3. `COD_AREAS` policy restriction for COD,
 *   4. Store checkout gateway ONLY when `PAYMENT_GATEWAY` policy is enabled AND a real/simulated
 *      `StoreCheckoutAdapter` exists, is enabled, and supports `{ country, currency, amountMinor }`.
 *
 * Choosing a direct method delegates to existing `deal_payment_*` (never a second state machine).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, offers, orderFulfillments, orders, sellerPaymentMethods, transactionLocations } from "@workspace/db";
import { commerceProvenance, type CommerceProvenance } from "../../ai/fact-provenance";
import { definitionFor, METHODS, methodLabel, methodStanding, negotiable, resolveCountry, STANDING_LABELS_AR } from "../deal-payments/catalog";
import { findSupportingStoreCheckoutAdapter } from "../store-checkout/types";
import { effectivePolicy } from "./engine";
import { codAreaPolicyCheck } from "./enforcement";
import { merchantPoliciesM2Enabled } from "./flag";

export type PaymentOptionItem = {
  kind: "DIRECT" | "COD" | "STORE_GATEWAY";
  code: string;
  label: string;
  available: boolean;
  reason?: string;
  standingLabel?: string;
  adapterId?: string;
  provenance: CommerceProvenance;
};

export type PaymentOptionsCard = {
  kind: "PAYMENT_OPTIONS";
  orderId: string;
  orderReference: string;
  currency: string;
  amountMinor: number;
  amountLabel: string;
  shippingFeeMinor: number | null;
  shippingLabel: string | null;
  options: PaymentOptionItem[];
  hasStoreGateway: boolean;
  notice: string;
};

export async function composePaymentOptions(input: {
  actorId: string;
  orderId: string;
  market: { id: string; countryCode: string; currencyCode: string; minorUnitScale: number };
  tx?: any;
}): Promise<PaymentOptionsCard | null> {
  const tx = input.tx ?? db;
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (!order || order.marketId !== input.market.id || (order.buyerId !== input.actorId && order.sellerId !== input.actorId)) {
    return null;
  }

  const items = (Array.isArray(order.data?.items) ? order.data.items : []) as { listingId?: string; paymentMethods?: string[] }[];
  const listingIds = items.map((i) => i.listingId).filter((id): id is string => typeof id === "string");
  const offerRows = listingIds.length
    ? await tx.select({ id: offers.id, businessProfileId: offers.businessProfileId }).from(offers).where(inArray(offers.id, listingIds))
    : [];
  const businessId = offerRows.find((r: { businessProfileId: string | null }) => r.businessProfileId)?.businessProfileId ?? null;

  const country = await resolveCountry(order.countryCode, tx);
  const sellerRows = await tx
    .select()
    .from(sellerPaymentMethods)
    .where(and(eq(sellerPaymentMethods.sellerId, order.sellerId), eq(sellerPaymentMethods.marketId, order.market.id), eq(sellerPaymentMethods.paused, false)));

  const m2 = merchantPoliciesM2Enabled();
  const paymentPolicy = m2 && businessId ? await effectivePolicy(businessId, "PAYMENT_METHODS", {}, tx) : null;
  const gatewayPolicy = m2 && businessId ? await effectivePolicy(businessId, "PAYMENT_GATEWAY", {}, tx) : null;

  const [fulfilment] = await tx.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, order.id));
  const [destination] = await tx
    .select({ city: transactionLocations.city, area: transactionLocations.area })
    .from(transactionLocations)
    .where(and(eq(transactionLocations.orderId, order.id), eq(transactionLocations.purpose, "DELIVERY_DESTINATION")));

  // Build candidate direct/COD codes from policy + seller_payment_methods
  const candidateMap = new Map<string, { label: string; provenance: CommerceProvenance }>();
  if (paymentPolicy) {
    const prov = commerceProvenance("MERCHANT_POLICY", paymentPolicy.version);
    const methods = ((paymentPolicy.rule as { methods?: Array<{ code: string; customLabel?: string }> }).methods ?? []);
    for (const m of methods) {
      candidateMap.set(m.code, { label: methodLabel(m.code, m.customLabel), provenance: prov });
    }
  }
  for (const row of sellerRows) {
    if (!candidateMap.has(row.methodCode)) {
      candidateMap.set(row.methodCode, {
        label: methodLabel(row.methodCode, row.customLabel),
        provenance: commerceProvenance("STORE_SYSTEM"),
      });
    }
  }
  // Legacy fallback if neither policy nor seller_payment_methods exist
  if (!candidateMap.size && items.length && items.every((item) => item.paymentMethods?.includes("CASH_DIRECT"))) {
    candidateMap.set("CASH_IN_PERSON", { label: methodLabel("CASH_IN_PERSON"), provenance: commerceProvenance("STORE_SYSTEM") });
    candidateMap.set("COD", { label: methodLabel("COD"), provenance: commerceProvenance("STORE_SYSTEM") });
  }

  const options: PaymentOptionItem[] = [];
  for (const [code, meta] of candidateMap.entries()) {
    const def = definitionFor(code, meta.label);
    const kind: "DIRECT" | "COD" = def?.kind === "COD" ? "COD" : "DIRECT";
    const standing = methodStanding(country, code, order.currencyCode);
    let available = negotiable(standing);
    let reason: string | undefined;

    if (kind === "COD") {
      if (!fulfilment || ["CANCELLED", "FAILED"].includes(fulfilment.status)) {
        available = false;
        reason = "اختر طريقة توصيل أولًا؛ الدفع عند الاستلام يحتاج توصيلًا.";
      } else if (!["SELLER_DELIVERY", "COURIER", "EXTERNAL_PROVIDER"].includes(fulfilment.method)) {
        available = false;
        reason = "الدفع عند الاستلام متاح مع التوصيل فقط، لا مع الاستلام الشخصي.";
      } else {
        const areaCheck = await codAreaPolicyCheck({ businessId, city: destination?.city, area: destination?.area, tx });
        if (!areaCheck.allowed) {
          available = false;
          reason = areaCheck.reason;
        }
      }
    }

    options.push({
      kind,
      code,
      label: meta.label,
      available,
      ...(reason ? { reason } : {}),
      standingLabel: STANDING_LABELS_AR[standing],
      provenance: meta.provenance,
    });
  }

  // Store Gateway: ONLY when PAYMENT_GATEWAY policy is enabled (or keepStoreGateway !== false) AND an enabled adapter exists & supports this transaction
  const gatewayEnabledInPolicy = Boolean(gatewayPolicy && (gatewayPolicy.rule as { enabled?: boolean }).enabled === true);
  const shippingFeeMinor = typeof (order.data as { shippingPolicy?: { feeMinor?: unknown } })?.shippingPolicy?.feeMinor === "number"
    ? (order.data as { shippingPolicy: { feeMinor: number } }).shippingPolicy.feeMinor
    : null;
  const totalMinor = order.subtotalMinor + (shippingFeeMinor ?? 0);

  let hasStoreGateway = false;
  if (gatewayEnabledInPolicy) {
    const adapter = await findSupportingStoreCheckoutAdapter({
      businessId,
      country: order.countryCode,
      currency: order.currencyCode,
      amountMinor: totalMinor,
    });
    if (adapter) {
      hasStoreGateway = true;
      options.push({
        kind: "STORE_GATEWAY",
        code: `GATEWAY:${adapter.id}`,
        label: (gatewayPolicy!.rule as { providerLabel?: string }).providerLabel?.trim() || adapter.displayName,
        available: true,
        adapterId: adapter.id,
        provenance: commerceProvenance("MERCHANT_POLICY", gatewayPolicy!.version),
      });
    }
  }

  const scale = order.minorUnitScale;
  const format = (m: number) => `${(m / 10 ** scale).toFixed(scale)} ${order.currencyCode}`;
  return {
    kind: "PAYMENT_OPTIONS",
    orderId: order.id,
    orderReference: order.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
    currency: order.currencyCode,
    amountMinor: totalMinor,
    amountLabel: format(totalMinor),
    shippingFeeMinor,
    shippingLabel: shippingFeeMinor !== null ? format(shippingFeeMinor) : null,
    options,
    hasStoreGateway,
    notice: hasStoreGateway
      ? "طرق الدفع المباشرة تُدار عبر اتفاق الصفقة، وبوابة المتجر تفتح صفحة الدفع الآمنة الخاصة بالمتجر."
      : "طرق الدفع المتاحة لهذا الطلب مباشرة بينك وبين البائع؛ لا يجمع جاسم أموالًا هنا.",
  };
}
