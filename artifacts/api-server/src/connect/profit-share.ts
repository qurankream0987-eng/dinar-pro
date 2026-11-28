/**
 * Jassim Connect profit share (owner terms): Jassim's share is a percentage (default 10%) of the
 * DIRECT PROFIT realised on a transaction — revenue minus approved, documented direct costs — never
 * a percentage of the invoice or revenue. A cost counts only when it is both approved and documented;
 * the result is never negative. Integer minor units, BigInt arithmetic, half-up rounding.
 *
 * Pure calculation. It does not change the existing Connect agreement/finance flow (which today
 * computes a percentage of gross per agreement terms); wiring it there is an owner decision.
 */
export type DirectCost = { label: string; amountMinor: number; approved: boolean; documented: boolean; reference?: string };

export function connectProfitShare(input: { revenueMinor: number; costs: DirectCost[]; shareBasisPoints?: number }) {
  const bps = input.shareBasisPoints ?? 1_000;
  for (const [name, value] of [["revenueMinor", input.revenueMinor], ["shareBasisPoints", bps]] as const)
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  if (bps > 10_000) throw new RangeError("shareBasisPoints must be at most 10000");
  const counted = input.costs.filter((cost) => {
    if (!Number.isSafeInteger(cost.amountMinor) || cost.amountMinor < 0) throw new RangeError(`cost ${cost.label} must be a non-negative safe integer`);
    return cost.approved && cost.documented;
  });
  const excluded = input.costs.filter((cost) => !counted.includes(cost));
  const costsMinor = counted.reduce((sum, cost) => sum + BigInt(cost.amountMinor), 0n);
  const profit = BigInt(input.revenueMinor) - costsMinor;
  const directProfitMinor = profit > 0n ? profit : 0n;
  const share = (directProfitMinor * BigInt(bps) * 2n + 10_000n) / 20_000n;
  return {
    revenueMinor: input.revenueMinor,
    approvedDirectCostsMinor: Number(costsMinor),
    directProfitMinor: Number(directProfitMinor),
    shareBasisPoints: bps,
    jassimShareMinor: Number(share),
    excludedCosts: excluded.map((cost) => ({ label: cost.label, reason: !cost.approved ? "NOT_APPROVED" : "NOT_DOCUMENTED" })),
    basis: "DIRECT_PROFIT_AFTER_APPROVED_DOCUMENTED_COSTS" as const,
  };
}
