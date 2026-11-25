/**
 * The single money rule for Whop checkouts. DINAR prices are JOD with three decimal
 * places; Whop charges in USD with two. Both conversions and the commission are integer
 * arithmetic on minor units, so no order can round a fee outside its own total.
 */
export const JOD_MINOR_SCALE = 3;
export const USD_MINOR_SCALE = 2;
export const JOD_MINOR_PER_MAJOR = 10 ** JOD_MINOR_SCALE;
export const USD_MINOR_PER_MAJOR = 10 ** USD_MINOR_SCALE;

export class WhopRuleError extends Error {
  constructor(
    readonly code:
      | "WHOP_AMOUNT_INVALID"
      | "WHOP_FEE_OUT_OF_BOUNDS"
      | "WHOP_AMOUNT_TOO_SMALL",
    message: string,
  ) {
    super(message);
    this.name = "WhopRuleError";
  }
}

/** Converts a DINAR JOD minor amount to USD minor units, rounding half up once. */
export function jodMinorToUsdMinor(jodMinor: number, usdPerJod: number): number {
  if (!Number.isSafeInteger(jodMinor) || jodMinor <= 0)
    throw new WhopRuleError("WHOP_AMOUNT_INVALID", "Order amount is not a positive integer");
  if (!(usdPerJod > 0))
    throw new WhopRuleError("WHOP_AMOUNT_INVALID", "USD per JOD rate is not positive");
  const minor = Math.round((jodMinor * usdPerJod) / 10);
  if (!Number.isSafeInteger(minor) || minor <= 0)
    throw new WhopRuleError("WHOP_AMOUNT_TOO_SMALL", "Order converts to less than one cent");
  return minor;
}

/** One flat platform rate for every order value (no tiers; owner decision 2026-11-25). */
export function selectFeePercent(_totalUsdMinor: number, rule: { feePercent: number }) {
  return rule.feePercent;
}

/**
 * A fee is refused when it rounds to zero or consumes the whole payment: Whop requires a
 * positive application fee below the price, and a zero fee would silently under-collect.
 */
export function computeCommission(
  totalUsdMinor: number,
  rule: { feePercent: number },
) {
  if (!Number.isSafeInteger(totalUsdMinor) || totalUsdMinor <= 0)
    throw new WhopRuleError("WHOP_AMOUNT_INVALID", "Checkout amount is not a positive integer");
  const feePercent = selectFeePercent(totalUsdMinor, rule);
  const basisPoints = Math.round(feePercent * 100);
  const feeMinor = Math.floor((totalUsdMinor * basisPoints) / 10_000);
  if (feeMinor <= 0)
    throw new WhopRuleError("WHOP_FEE_OUT_OF_BOUNDS", "Commission rounds to zero");
  if (feeMinor >= totalUsdMinor)
    throw new WhopRuleError("WHOP_FEE_OUT_OF_BOUNDS", "Commission is not below the total");
  return { feePercent, feeMinor, sellerMinor: totalUsdMinor - feeMinor };
}

/** Whop request amounts are decimal major units ("25.00"), never minor units. */
export function usdMinorToAmount(usdMinor: number): number {
  if (!Number.isSafeInteger(usdMinor) || usdMinor < 0)
    throw new WhopRuleError("WHOP_AMOUNT_INVALID", "USD minor amount is invalid");
  return Number((usdMinor / USD_MINOR_PER_MAJOR).toFixed(2));
}
