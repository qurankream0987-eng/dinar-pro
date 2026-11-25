import { parseBlockedCountries } from "./config";

export class WhopCountryBlockedError extends Error {
  readonly status = 403;
  readonly code = "WHOP_COUNTRY_BLOCKED";
}

export function normalizeCountry(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

export function isCountryBlocked(
  country: unknown,
  blocked: readonly string[] = parseBlockedCountries(undefined),
): boolean {
  const code = normalizeCountry(country);
  return Boolean(code && blocked.includes(code));
}

/**
 * Applied to both sides of every Whop flow: the seller at onboarding and the buyer at
 * checkout. An unrecognised country is refused rather than assumed safe.
 */
export function assertCountryAllowed(
  country: unknown,
  blocked: readonly string[],
): string {
  const code = normalizeCountry(country);
  if (!code || blocked.includes(code))
    throw new WhopCountryBlockedError("Whop payments are not available in this country");
  return code;
}
