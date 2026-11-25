import { decimalToMinor, minorToDecimal, currencyScale } from "@workspace/global";

const MAX_DEFAULT_ORDER_QUANTITY = 1_000_000;
const maxQuantitySetting = process.env.BDINAR_MAX_ORDER_QUANTITY;
const parsedMaxQuantity = maxQuantitySetting === undefined
  ? MAX_DEFAULT_ORDER_QUANTITY
  : Number(maxQuantitySetting);

if (!Number.isSafeInteger(parsedMaxQuantity) || parsedMaxQuantity < 1) {
  throw new Error("BDINAR_MAX_ORDER_QUANTITY must be a positive safe integer");
}

export const MAX_ORDER_QUANTITY = parsedMaxQuantity;
/** Legacy defaults retained for the pre-market-scoped in-memory checkout API. */
export const MARKET_CURRENCY = "KWD";
/** Owner decision 2026-11-25: 5% of the sale value for every category (was 10%). Snapshotted per order. */
export const PLATFORM_FEE_BASIS_POINTS = 500;

/** Format an integer minor-unit amount using the currency's ISO scale. */
export function formatMinorUnits(minor: number, currencyCode: string): string {
  return minorToDecimal(minor, currencyCode);
}

/** Parse a decimal amount into integer minor units using the currency's ISO scale. */
export function parseMinorUnits(amount: string | number, currencyCode: string): number {
  return decimalToMinor(amount, currencyCode);
}

export function calculatePlatformFeeMinor(
  totalMinor: number,
  rateBasisPoints = PLATFORM_FEE_BASIS_POINTS,
): number {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
    throw new RangeError("Total must be a non-negative integer in minor units");
  }
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10_000) {
    throw new RangeError("Commission rate must be an integer from 0 to 10000 basis points");
  }
  const scaled = totalMinor * rateBasisPoints;
  if (!Number.isSafeInteger(scaled)) throw new RangeError("Fee calculation exceeds the safe integer range");
  return Math.floor((scaled + 5_000) / 10_000);
}

/** @deprecated Use formatMinorUnits(amount, currencyCode). */
export const formatKwdFromFils = (fils: number) => formatMinorUnits(fils, MARKET_CURRENCY);
/** @deprecated Use parseMinorUnits(amount, currencyCode). */
export const parseKwdToFils = (amount: string | number) => parseMinorUnits(amount, MARKET_CURRENCY);
/** @deprecated Use calculatePlatformFeeMinor(totalMinor). */
export const calculatePlatformFeeFils = calculatePlatformFeeMinor;