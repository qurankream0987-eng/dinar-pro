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
