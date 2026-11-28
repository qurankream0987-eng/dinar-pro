/**
 * M2 Merchant Policy Enforcement — deterministic runtime checks for checkout and chat.
 *
 * Reuses `effectivePolicy` from `engine.ts`, `demand-requests.ts` for out-of-stock interest,
 * and `ai/fact-provenance.ts` for provenance on every fact shown.
 */
import { and, desc, eq, ne, or, isNull, sql } from "drizzle-orm";
import { db, offers } from "@workspace/db";
import { commerceProvenance, type CommerceProvenance } from "../../ai/fact-provenance";
import { effectivePolicy } from "./engine";
import { merchantPoliciesM2Enabled } from "./flag";

type MarketRef = { id: string; countryCode: string; currencyCode: string; minorUnitScale: number };

const formatMoney = (minor: number, scale: number, currency: string) =>
  `${(minor / 10 ** scale).toFixed(scale)} ${currency}`;

export type PolicyOrderCheck =
  | {
      allowed: true;
      shippingFeeMinor: number | null;
      shippingProvenance: CommerceProvenance | null;
      appliedPolicies: Array<{ kind: string; version: number; provenance: CommerceProvenance }>;
    }
  | {
      allowed: false;
      code: "ORDERING_PAUSED" | "GEO_RESTRICTION" | "MIN_ORDER_NOT_MET";
      message: string;
      provenance: CommerceProvenance;
    };

/**
 * Evaluates ORDERING_PAUSED, GEO_RESTRICTION, MIN_ORDER, and SHIPPING for a single order group
 * (or purchase review) belonging to `businessId`.
 */
export async function evaluateOrderPolicies(input: {
  businessId: string | null | undefined;
  market: MarketRef;
  quantity: number;
  subtotalMinor: number;
  productId?: string;
  category?: string;
  region?: string;
  tx?: any;
}): Promise<PolicyOrderCheck> {
  if (!merchantPoliciesM2Enabled() || !input.businessId) {
    return { allowed: true, shippingFeeMinor: null, shippingProvenance: null, appliedPolicies: [] };
  }
  const tx = input.tx ?? db;
  const ctx = { productId: input.productId, category: input.category, region: input.region };
  const appliedPolicies: Array<{ kind: string; version: number; provenance: CommerceProvenance }> = [];

  const paused = await effectivePolicy(input.businessId, "ORDERING_PAUSED", ctx, tx);
  if (paused && (paused.rule as { paused?: boolean }).paused === true) {
    const prov = commerceProvenance("MERCHANT_POLICY", paused.version);
    const reason = (paused.rule as { reason?: string }).reason?.trim();
    return {
      allowed: false,
      code: "ORDERING_PAUSED",
      message: reason || "استقبال الطلبات متوقف مؤقتًا حسب سياسة المتجر.",
      provenance: prov,
    };
  }

  const geo = await effectivePolicy(input.businessId, "GEO_RESTRICTION", ctx, tx);
  if (geo) {
    const allowedCountries = (geo.rule as { allowedCountries?: string[] }).allowedCountries ?? [];
    if (allowedCountries.length && !allowedCountries.includes(input.market.countryCode)) {
      return {
        allowed: false,
        code: "GEO_RESTRICTION",
        message: `الطلب غير متاح في ${input.market.countryCode} حسب سياسة المتجر.`,
        provenance: commerceProvenance("MERCHANT_POLICY", geo.version),
      };
    }
  }

  const minOrder = await effectivePolicy(input.businessId, "MIN_ORDER", ctx, tx);
  if (minOrder) {
    const rule = minOrder.rule as { minQuantity?: number; minAmountMinor?: number };
    const prov = commerceProvenance("MERCHANT_POLICY", minOrder.version);
    if (rule.minQuantity !== undefined && input.quantity < rule.minQuantity) {
      return {
        allowed: false,
        code: "MIN_ORDER_NOT_MET",
        message: `الحد الأدنى للطلب حسب سياسة المتجر هو ${rule.minQuantity} ${input.quantity === 1 ? "قطع" : "قطعة"} (المطلوب الآن ${input.quantity}).`,
        provenance: prov,
      };
    }
    if (rule.minAmountMinor !== undefined && input.subtotalMinor < rule.minAmountMinor) {
      return {
        allowed: false,
        code: "MIN_ORDER_NOT_MET",
        message: `الحد الأدنى للطلب حسب سياسة المتجر هو ${formatMoney(rule.minAmountMinor, input.market.minorUnitScale, input.market.currencyCode)}.`,
        provenance: prov,
      };
    }
    appliedPolicies.push({ kind: "MIN_ORDER", version: minOrder.version, provenance: prov });
  }

  const shipping = await effectivePolicy(input.businessId, "SHIPPING", ctx, tx);
  let shippingFeeMinor: number | null = null;
  let shippingProvenance: CommerceProvenance | null = null;
  if (shipping) {
    const rule = shipping.rule as { feeMinor: number; freeAboveMinor?: number };
    shippingFeeMinor =
      rule.freeAboveMinor !== undefined && input.subtotalMinor >= rule.freeAboveMinor ? 0 : rule.feeMinor;
    shippingProvenance = commerceProvenance("MERCHANT_POLICY", shipping.version);
    appliedPolicies.push({ kind: "SHIPPING", version: shipping.version, provenance: shippingProvenance });
  }

  return {
    allowed: true,
    shippingFeeMinor,
    shippingProvenance,
    appliedPolicies,
  };
}

export type OutOfStockGuidance = {
  message: string;
  provenance: CommerceProvenance;
  promiseDateProvenance: CommerceProvenance | null;
  captureInterest: boolean;
  alternatives: Array<{
    id: string;
    title: string;
    unitPriceMinor: number | null;
    available: number | null;
    provenance: CommerceProvenance;
  }>;
};

/**
 * Evaluates OUT_OF_STOCK and ALTERNATIVES policies when a listing is out of stock (or insufficient stock).
 * Never promises a restock date the merchant did not explicitly set.
 */
export async function evaluateOutOfStockAndAlternatives(input: {
  businessId: string | null | undefined;
  sellerId: string;
  marketId: string;
  listingId: string;
  categoryId?: string;
  tx?: any;
}): Promise<OutOfStockGuidance> {
  const tx = input.tx ?? db;
  if (!merchantPoliciesM2Enabled() || !input.businessId) {
    return {
      message: "المنتج غير متوفر حاليًا.",
      provenance: commerceProvenance("STORE_SYSTEM"),
      promiseDateProvenance: null,
      captureInterest: false,
      alternatives: [],
    };
  }
  const ctx = { productId: input.listingId, category: input.categoryId };
  const oos = await effectivePolicy(input.businessId, "OUT_OF_STOCK", ctx, tx);
  const altPolicy = await effectivePolicy(input.businessId, "ALTERNATIVES", ctx, tx);

  const oosRule = (oos?.rule ?? {}) as {
    action?: "TELL_AND_CAPTURE_INTEREST" | "HIDE_OR_SAY_UNAVAILABLE" | "NOT_SOLD";
    message?: string;
    promiseDate?: string | null;
  };
  const provenance = oos
    ? commerceProvenance("MERCHANT_POLICY", oos.version)
    : commerceProvenance("STORE_SYSTEM");
  const baseMessage = oosRule.message?.trim() || "المنتج غير متوفر حاليًا.";
  const promiseDateProvenance = oos
    ? oosRule.promiseDate
      ? commerceProvenance("MERCHANT_POLICY", oos.version)
      : commerceProvenance("UNCONFIRMED")
    : null;
  const fullMessage = oos
    ? oosRule.promiseDate
      ? `${baseMessage} (موعد التوفر المتوقع: ${oosRule.promiseDate})`
      : `${baseMessage} (لا يوجد موعد مؤكد لإعادة التوفر)`
    : baseMessage;

  const alternatives: OutOfStockGuidance["alternatives"] = [];
  const suggestAlts =
    (altPolicy?.rule as { suggest?: boolean; sameCategoryOnly?: boolean } | undefined)?.suggest === true &&
    oosRule.action !== "NOT_SOLD";
  if (suggestAlts) {
    const sameCategoryOnly = Boolean((altPolicy?.rule as { sameCategoryOnly?: boolean }).sameCategoryOnly);
    const rows = await tx
      .select({
        id: offers.id,
        data: offers.data,
        unitPriceMinor: offers.unitPriceMinor,
        inventoryMode: offers.inventoryMode,
        availableQuantity: offers.availableQuantity,
        reservedQuantity: offers.reservedQuantity,
      })
      .from(offers)
      .where(
        and(
          eq(offers.marketId, input.marketId),
          eq(offers.status, "PUBLISHED"),
          ne(offers.id, input.listingId),
          input.businessId
            ? eq(offers.businessProfileId, input.businessId)
            : eq(offers.sellerId, input.sellerId),
          or(
            eq(offers.inventoryMode, "UNLIMITED"),
            sql`coalesce(${offers.availableQuantity}, 0) - coalesce(${offers.reservedQuantity}, 0) > 0`,
          ),
        ),
      )
      .orderBy(desc(offers.createdAt))
      .limit(12);

    for (const row of rows) {
      if (sameCategoryOnly && input.categoryId && (row.data as { categoryId?: string })?.categoryId !== input.categoryId) {
        continue;
      }
      alternatives.push({
        id: row.id,
        title: String((row.data as { title?: unknown })?.title ?? "عرض بديل"),
        unitPriceMinor: row.unitPriceMinor,
        available:
          row.inventoryMode === "UNLIMITED"
            ? null
            : Math.max(0, (row.availableQuantity ?? 0) - (row.reservedQuantity ?? 0)),
        provenance: commerceProvenance("STORE_SYSTEM"),
      });
      if (alternatives.length >= 5) break;
    }
  }

  return {
    message: fullMessage,
    provenance,
    promiseDateProvenance,
    captureInterest: oosRule.action === "TELL_AND_CAPTURE_INTEREST",
    alternatives,
  };
}

/**
 * Checks COD_AREAS merchant policy for a given delivery city/area.
 */
export async function codAreaPolicyCheck(input: {
  businessId: string | null | undefined;
  city?: string | null;
  area?: string | null;
  tx?: any;
}): Promise<{ allowed: true } | { allowed: false; reason: string; provenance: CommerceProvenance }> {
  if (!merchantPoliciesM2Enabled() || !input.businessId) return { allowed: true };
  const tx = input.tx ?? db;
  const policy = await effectivePolicy(input.businessId, "COD_AREAS", {}, tx);
  if (!policy) return { allowed: true };
  const areas = ((policy.rule as { areas?: string[] }).areas ?? []).map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!areas.length) return { allowed: true };
  const candidates = [input.city, input.area].map((v) => (v ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!candidates.length) {
    return {
      allowed: false,
      reason: "شارك موقع التسليم أو منطقتك أولًا للتحقق من تغطية الدفع عند الاستلام حسب سياسة المتجر.",
      provenance: commerceProvenance("MERCHANT_POLICY", policy.version),
    };
  }
  const covered = areas.some((a) => candidates.includes(a));
  if (!covered) {
    return {
      allowed: false,
      reason: `الدفع عند الاستلام غير متاح في هذه المنطقة حسب سياسة المتجر (المناطق المشمولة: ${areas.join("، ")}).`,
      provenance: commerceProvenance("MERCHANT_POLICY", policy.version),
    };
  }
  return { allowed: true };
}
