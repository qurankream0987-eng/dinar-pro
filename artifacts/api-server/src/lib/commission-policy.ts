import { currencyScale } from "@workspace/global";
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { commissionPolicies } from "@workspace/db";
import {
  calculatePlatformFeeMinor,
  PLATFORM_FEE_BASIS_POINTS,
} from "./market-pricing";

export const COMMISSION_POLICY_KEY = "PLATFORM_COMMISSION";

export const COMMISSION_BASES = ["GROSS_ITEM_SUBTOTAL"] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];

export const COMMISSION_ROUNDING_MODES = ["HALF_UP"] as const;
export type CommissionRounding = (typeof COMMISSION_ROUNDING_MODES)[number];

export type ResolvedCommissionPolicy = {
  id: string | null;
  policyKey: string;
  version: number;
  rateBasisPoints: number;
  basis: CommissionBasis;
  roundingMode: CommissionRounding;
  marketId: string | null;
  source: "PUBLISHED_MARKET" | "PUBLISHED_GLOBAL" | "DEFAULT_BASELINE";
};

/**
 * The owner's baseline is 10% (1,000 bps). It is the fallback only when no published
 * policy applies; a published policy (global or market-scoped) always wins. A configured
 * table is never allowed to silently disagree with the documented fallback rate.
 */
export const DEFAULT_COMMISSION_POLICY: ResolvedCommissionPolicy = Object.freeze({
  id: null,
  policyKey: COMMISSION_POLICY_KEY,
  version: 0,
  rateBasisPoints: PLATFORM_FEE_BASIS_POINTS,
  basis: "GROSS_ITEM_SUBTOTAL",
  roundingMode: "HALF_UP",
  marketId: null,
  source: "DEFAULT_BASELINE",
});

export function commissionPolicyContentHash(input: {
  policyKey: string;
  version: number;
  rateBasisPoints: number;
  basis: string;
  roundingMode: string;
  marketId: string | null;
  effectiveFrom: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        policyKey: input.policyKey,
        version: input.version,
        rateBasisPoints: input.rateBasisPoints,
        basis: input.basis,
        roundingMode: input.roundingMode,
        marketId: input.marketId,
        effectiveFrom: input.effectiveFrom,
      }),
    )
    .digest("hex");
}

function toResolved(
  row: typeof commissionPolicies.$inferSelect,
  source: ResolvedCommissionPolicy["source"],
): ResolvedCommissionPolicy {
  return {
    id: row.id,
    policyKey: row.policyKey,
    version: row.version,
    rateBasisPoints: row.rateBasisPoints,
    basis: row.basis as CommissionBasis,
    roundingMode: row.roundingMode as CommissionRounding,
    marketId: row.marketId,
    source,
  };
}

/**
 * The policy in force for a market at a point in time: a published market policy first,
 * then the published global policy, then the documented baseline. The query is scoped to
 * one policy key and one effective window; there is no "latest row" shortcut.
 */
export async function resolveCommissionPolicy(
  tx: any,
  input: { marketId?: string | null; at?: Date } = {},
): Promise<ResolvedCommissionPolicy> {
  const at = input.at ?? new Date();
  const window = and(
    eq(commissionPolicies.policyKey, COMMISSION_POLICY_KEY),
    eq(commissionPolicies.status, "PUBLISHED"),
    lte(commissionPolicies.effectiveFrom, at),
    or(
      isNull(commissionPolicies.effectiveTo),
      sql`${commissionPolicies.effectiveTo} > ${at}`,
    ),
    input.marketId
      ? or(
          eq(commissionPolicies.marketId, input.marketId),
          isNull(commissionPolicies.marketId),
        )
      : isNull(commissionPolicies.marketId),
  );
  const [row] = await tx
    .select()
    .from(commissionPolicies)
    .where(window)
    // Market-specific rows sort before the global row; newest version wins within a scope.
    .orderBy(sql`${commissionPolicies.marketId} IS NULL`, desc(commissionPolicies.version))
    .limit(1);
  if (!row) return DEFAULT_COMMISSION_POLICY;
  return toResolved(row, row.marketId ? "PUBLISHED_MARKET" : "PUBLISHED_GLOBAL");
}

/** The commission charged on a gross amount, in integer minor units. */
export function calculateCommissionMinor(
  grossMinor: number,
  policy: Pick<ResolvedCommissionPolicy, "rateBasisPoints">,
): number {
  return calculatePlatformFeeMinor(grossMinor, policy.rateBasisPoints);
}

/** The snapshot stored on an order, so later policy versions cannot reprice it. */
export function commissionSnapshot(
  policy: ResolvedCommissionPolicy,
): {
  policyId: string | null;
  policyKey: string;
  version: number;
  rateBasisPoints: number;
  basis: CommissionBasis;
  roundingMode: CommissionRounding;
  source: ResolvedCommissionPolicy["source"];
} {
  return {
    policyId: policy.id,
    policyKey: policy.policyKey,
    version: policy.version,
    rateBasisPoints: policy.rateBasisPoints,
    basis: policy.basis,
    roundingMode: policy.roundingMode,
    source: policy.source,
  };
}

/** The rate an existing order must keep using, from its persisted snapshot. */
export function commissionRateForOrder(order: {
  data?: Record<string, unknown> | null;
  platformFeeMinor: number;
  subtotalMinor: number;
}): number {
  const snapshot = order.data?.commissionPolicy;
  if (snapshot && typeof snapshot === "object") {
    const rate = (snapshot as Record<string, unknown>).rateBasisPoints;
    if (Number.isSafeInteger(rate) && (rate as number) >= 0 && (rate as number) <= 10_000)
      return rate as number;
  }
  const legacy = order.data?.commissionRateBps;
  if (Number.isSafeInteger(legacy) && (legacy as number) >= 0 && (legacy as number) <= 10_000)
    return legacy as number;
  // An order without a snapshot keeps the fee it was actually charged.
  return order.subtotalMinor > 0
    ? Math.round((order.platformFeeMinor * 10_000) / order.subtotalMinor)
    : PLATFORM_FEE_BASIS_POINTS;
}

/** The commission a refund gives back, computed cumulatively so rounding never drifts. */
export function commissionReversalForRefund(input: {
  grossMinor: number;
  previouslyRefundedMinor: number;
  refundAmountMinor: number;
  rateBasisPoints: number;
}): number {
  const { grossMinor, previouslyRefundedMinor, refundAmountMinor, rateBasisPoints } =
    input;
  for (const [name, value] of [
    ["grossMinor", grossMinor],
    ["previouslyRefundedMinor", previouslyRefundedMinor],
    ["refundAmountMinor", refundAmountMinor],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  if (previouslyRefundedMinor > grossMinor)
    throw new RangeError("previouslyRefundedMinor cannot exceed the gross amount");
  const before = Math.min(grossMinor, previouslyRefundedMinor);
  const after = Math.min(grossMinor, previouslyRefundedMinor + refundAmountMinor);
  const reversal =
    calculatePlatformFeeMinor(after, rateBasisPoints) -
    calculatePlatformFeeMinor(before, rateBasisPoints);
  return Math.max(0, reversal);
}

/** The approved tier direction is prepared for review only. No checkout caller enables it. */
export const COMMISSION_TIER_ACTIVATION_ENABLED = false as const;
export type TieredCommissionRule = {
  policyKey: string;
  version: number;
  marketId: string;
  currencyCode: string;
  minorUnitScale: number;
  thresholdMinor: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  approved: boolean;
};
export type TieredCommissionPreview =
  | { status: "BLOCKED"; reason: string; activationEnabled: false }
  | { status: "READY_FOR_REVIEW"; activationEnabled: false; approved: boolean; rateBasisPoints: number; feeMinor: number; snapshot: {
      policyKey: string; version: number; marketId: string; currencyCode: string;
      thresholdMinor: number; eligibleSubtotalMinor: number; rateBasisPoints: number;
      basis: "GROSS_ITEM_SUBTOTAL"; roundingMode: "HALF_UP"; effectiveFrom: string; effectiveTo: string | null;
    } };

/**
 * Side-effect-free preview of a versioned market rule. Thresholds are local-currency minor
 * units, never FX-derived. This cannot publish policy or alter an order. Shipping/tax are
 * separately recorded values and are deliberately absent from the eligible item subtotal.
 * At the threshold, 5% applies to the WHOLE subtotal; above it, 10% applies to the WHOLE subtotal.
 * Historical orders continue using commissionRateForOrder and their immutable fee snapshot.
 */
export function previewTieredCommission(rule: TieredCommissionRule, input: {
  marketId: string; currencyCode: string; minorUnitScale: number;
  eligibleSubtotalMinor: number; at: Date;
}): TieredCommissionPreview {
  const blocked = (reason: string): TieredCommissionPreview => ({status:"BLOCKED",reason,activationEnabled:false});
  if (rule.policyKey !== COMMISSION_POLICY_KEY || !Number.isSafeInteger(rule.version) || rule.version < 1) return blocked("INVALID_VERSION");
  if (rule.marketId !== input.marketId || rule.currencyCode !== input.currencyCode || rule.minorUnitScale !== input.minorUnitScale) return blocked("MARKET_CURRENCY_MISMATCH");
  try {if(currencyScale(input.currencyCode)!==input.minorUnitScale) return blocked("INVALID_CURRENCY_SCALE");}catch{return blocked("INVALID_CURRENCY");}
  if (!Number.isInteger(rule.minorUnitScale) || rule.minorUnitScale < 0 || rule.minorUnitScale > 3) return blocked("INVALID_CURRENCY_SCALE");
  if (!Number.isSafeInteger(rule.thresholdMinor) || rule.thresholdMinor! < 0) return blocked("THRESHOLD_NOT_CONFIGURED");
  if (!Number.isSafeInteger(input.eligibleSubtotalMinor) || input.eligibleSubtotalMinor < 0) return blocked("INVALID_ELIGIBLE_SUBTOTAL");
  const from=Date.parse(rule.effectiveFrom),to=rule.effectiveTo===null ? Infinity : Date.parse(rule.effectiveTo),at=input.at.getTime();
  if (!Number.isFinite(from) || !(Number.isFinite(to)||to===Infinity) || to<=from || !Number.isFinite(at) || at<from || at>=to) return blocked("NOT_EFFECTIVE");
  const rateBasisPoints=input.eligibleSubtotalMinor<=rule.thresholdMinor! ? 500 : 1000;
  let feeMinor:number;try {feeMinor=calculatePlatformFeeMinor(input.eligibleSubtotalMinor,rateBasisPoints);} catch {return blocked("AMOUNT_OUT_OF_RANGE");}
  return {status:"READY_FOR_REVIEW",activationEnabled:false,approved:rule.approved,rateBasisPoints,feeMinor,snapshot:{policyKey:rule.policyKey,version:rule.version,marketId:rule.marketId,currencyCode:rule.currencyCode,thresholdMinor:rule.thresholdMinor!,eligibleSubtotalMinor:input.eligibleSubtotalMinor,rateBasisPoints,basis:"GROSS_ITEM_SUBTOTAL",roundingMode:"HALF_UP",effectiveFrom:rule.effectiveFrom,effectiveTo:rule.effectiveTo}};
}
