/**
 * Whop platform configuration. Every value is read once from the server environment;
 * nothing here is ever sent to a browser. A production environment never falls back to
 * sandbox credentials: an unknown or missing `WHOP_ENVIRONMENT` resolves to sandbox, and
 * `production` without its own key and signing secret is reported as misconfigured.
 */
export type WhopEnvironmentName = "sandbox" | "production";

export type WhopConfig = {
  enabled: boolean;
  environment: WhopEnvironmentName;
  apiKey?: string;
  webhookSecret?: string;
  companyId?: string;
  feePercent: number;
  largeFeePercent: number;
  thresholdUsd: number;
  usdPerJod: number;
  blockedCountries: string[];
  /** Problems are names of invalid settings, never their values. */
  problems: string[];
  configured: boolean;
};

const truthy = (value: string | undefined) => value?.trim().toLowerCase() === "true";

function finiteNumber(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function parseWhopConfig(
  env: Record<string, string | undefined>,
): WhopConfig {
  const enabled = truthy(env.WHOP_ENABLED);
  // Sandbox is the only default. A typo must not silently point at production.
  const environment: WhopEnvironmentName =
    env.WHOP_ENVIRONMENT?.trim().toLowerCase() === "production"
      ? "production"
      : "sandbox";
  const feePercent = finiteNumber(env.WHOP_FEE_PERCENT, 10);
  const largeFeePercent = finiteNumber(env.WHOP_FEE_PERCENT_LARGE, 5);
  const thresholdUsd = finiteNumber(env.THRESHOLD_USD, 500);
  const usdPerJod = finiteNumber(env.WHOP_USD_PER_JOD, 0);
  const problems: string[] = [];
  if (!(feePercent > 0 && feePercent < 100))
    problems.push("WHOP_FEE_PERCENT must be between 0 and 100");
  if (!(largeFeePercent > 0 && largeFeePercent <= feePercent))
    problems.push("WHOP_FEE_PERCENT_LARGE must be positive and at most WHOP_FEE_PERCENT");
  if (!(thresholdUsd >= 0))
    problems.push("THRESHOLD_USD must be zero or positive");
  if (!(usdPerJod > 0))
    problems.push("WHOP_USD_PER_JOD must be positive");
  if (enabled) {
    if (!env.WHOP_API_KEY?.trim()) problems.push("WHOP_API_KEY is required");
    if (!env.WHOP_WEBHOOK_SECRET?.trim())
      problems.push("WHOP_WEBHOOK_SECRET is required");
    if (!env.WHOP_COMPANY_ID?.trim()) problems.push("WHOP_COMPANY_ID is required");
  }
  return {
    enabled,
    environment,
    apiKey: env.WHOP_API_KEY?.trim() || undefined,
    webhookSecret: env.WHOP_WEBHOOK_SECRET?.trim() || undefined,
    companyId: env.WHOP_COMPANY_ID?.trim() || undefined,
    feePercent,
    largeFeePercent,
    thresholdUsd,
    usdPerJod,
    blockedCountries: parseBlockedCountries(env.WHOP_BLOCKED_COUNTRIES),
    problems,
    configured: enabled && problems.length === 0,
  };
}

let cached: WhopConfig | undefined;

export function whopConfig(): WhopConfig {
  cached ??= parseWhopConfig(process.env);
  return cached;
}

/** Test-only reset; production reads the environment once per process. */
export function resetWhopConfigForTests() {
  cached = undefined;
}

const DEFAULT_BLOCKED_COUNTRIES = ["IQ", "IR", "KP", "SY", "CU"];

/**
 * The owner's list always applies; the environment variable can only add countries.
 * This is an operational blocklist, not a legal sanctions determination.
 */
export function parseBlockedCountries(value: string | undefined): string[] {
  const extra = (value ?? "")
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));
  return [...new Set([...DEFAULT_BLOCKED_COUNTRIES, ...extra])].sort();
}
