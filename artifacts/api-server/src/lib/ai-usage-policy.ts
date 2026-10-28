/**
 * DINAR NEXT G1: AI usage allowances per plan tier. Every tier keeps the same AI
 * capabilities; a tier only changes how much can be used in a period. The numbers here
 * are version-0 placeholders (`approved: false`) — not commercial approval. An admin row in
 * `commercial_policies` (`aiUsage`) replaces the whole object for a market or globally.
 */
import { z } from "zod";

export const AI_USAGE_RESOURCES = [
  "TEXT_REQUEST",
  "MARKETING_GENERATION",
  "BUSINESS_ANALYTICS",
  "IMAGE_UNDERSTANDING",
  "AGENT_MULTI_STEP",
  "AUDIO_TRANSCRIPTION",
] as const;
export type AiUsageResource = (typeof AI_USAGE_RESOURCES)[number];

export const AI_PLAN_TIERS = ["GUEST", "FREE", "BUSINESS_GO", "BUSINESS_PRO"] as const;
export type AiPlanTier = (typeof AI_PLAN_TIERS)[number];

/** Business entitlement keys on DINAR_BUSINESS plans that carry an AI usage tier. */
export const AI_TIER_ENTITLEMENTS = {
  AI_USAGE_BUSINESS_GO: "BUSINESS_GO",
  AI_USAGE_BUSINESS_PRO: "BUSINESS_PRO",
} as const satisfies Record<string, AiPlanTier>;

const Count = z.number().int().min(0).max(10_000_000);
const TokenCount = z.number().int().min(0).max(2_000_000_000);
/** Resources added after version 0 default to "not included" in older admin rows (fail closed). */
const LATER_RESOURCES: readonly AiUsageResource[] = ["AUDIO_TRANSCRIPTION"];
function perResource(item: typeof Count, laterDefault: number) {
  const withLaterDefault = item.default(laterDefault);
  return z
    .object(Object.fromEntries(AI_USAGE_RESOURCES.map((resource) => [resource, LATER_RESOURCES.includes(resource) ? withLaterDefault : item])) as Record<AiUsageResource, typeof Count>)
    .strict();
}
const TierAllowance = z
  .object({
    requests: perResource(Count, 0),
    tokens: TokenCount,
  })
  .strict();
export type TierAllowance = z.infer<typeof TierAllowance>;

const Period = z
  .object({
    /** Calendar boundaries are computed in `timeZone` (IANA). */
    kind: z.enum(["CALENDAR_MONTH", "CALENDAR_DAY"]),
    timeZone: z.string().min(1).max(64).refine((zone) => isValidTimeZone(zone)),
  })
  .strict();

const ORDERED: readonly AiPlanTier[] = ["FREE", "BUSINESS_GO", "BUSINESS_PRO"];

export const AiUsagePolicySchema = z
  .object({
    /** False until the owner approves the numbers; shown to users as "provisional". */
    approved: z.boolean(),
    period: Period,
    tiers: z.object(Object.fromEntries(AI_PLAN_TIERS.map((tier) => [tier, TierAllowance])) as Record<AiPlanTier, typeof TierAllowance>).strict(),
    /** Tokens reserved before a call whose real usage is not known yet. */
    tokenEstimates: perResource(z.number().int().min(1).max(200_000), 2_000),
    /** A reservation not settled within this time is reconciled as abandoned. */
    reservationTtlSeconds: z.number().int().min(30).max(3600),
    /** Usage share at which an honest one-line notice is added to an answer. */
    nearLimitRatio: z.number().min(0.5).max(0.99),
    /** Platform-wide spending guard across all owners, independent of individual quotas. */
    globalGuard: z
      .object({
        enabled: z.boolean(),
        period: Period,
        requests: z.number().int().min(1).max(100_000_000),
        tokens: z.number().int().min(1).max(2_000_000_000),
      })
      .strict(),
    /** Monetary spending limits (see `ai-spend.ts`). Older rows without it get the unconfigured default. */
    spend: z.lazy(() => AiSpendPolicySchema).default(() => DEFAULT_AI_SPEND_POLICY),
  })
  .strict()
  // A higher tier may never get less than a lower one for any metered resource.
  .refine(
    (policy) =>
      ORDERED.every((tier, index) =>
        index === 0 ||
        (policy.tiers[tier].tokens >= policy.tiers[ORDERED[index - 1]!].tokens &&
          AI_USAGE_RESOURCES.every((resource) => policy.tiers[tier].requests[resource] >= policy.tiers[ORDERED[index - 1]!].requests[resource])),
      ),
    { message: "BUSINESS_PRO >= BUSINESS_GO >= FREE for every allowance" },
  );
export type AiUsagePolicy = z.infer<typeof AiUsagePolicySchema>;

const requests = (text: number, marketing: number, analytics: number, image: number, agent: number, audio: number) => ({
  TEXT_REQUEST: text,
  MARKETING_GENERATION: marketing,
  BUSINESS_ANALYTICS: analytics,
  IMAGE_UNDERSTANDING: image,
  AGENT_MULTI_STEP: agent,
  AUDIO_TRANSCRIPTION: audio,
});

/** Integer micro-units of the spend currency (1 USD = 1_000_000 micros). */
const Micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const perTier = <T extends z.ZodTypeAny>(item: T) =>
  z.object(Object.fromEntries(AI_PLAN_TIERS.map((tier) => [tier, item])) as Record<AiPlanTier, T>).strict();

export const AiSpendPolicySchema = z
  .object({
    /** Currency of every limit and hold; provider prices in another currency are not converted (unpriced). */
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    /** Platform-wide money cap per period. null = not configured: paid inference fails closed where spend is required. */
    global: z.object({ period: Period, limitMicros: Micros.nullable() }).strict(),
    /** Cap per account and usage period (`period`), by plan tier. null = only the other caps apply. */
    perAccount: perTier(Micros.nullable()),
    /** Aggregate cap for all accounts of a tier per global period. null = none. */
    perPlan: perTier(Micros.nullable()),
    /** Money held before one operation of each resource, released or corrected at settlement. */
    holdMicros: perResource(Micros.min(1), 50_000),
    /** A call whose model has no applicable price: refused up front, or charged its full hold. Never zero. */
    unpricedModel: z.enum(["REFUSE", "CHARGE_HOLD"]),
  })
  .strict();
export type AiSpendPolicy = z.infer<typeof AiSpendPolicySchema>;

/**
 * Unconfigured: no money limit is approved. Development records holds and costs without a cap;
 * staging/production (or DINAR_AI_SPEND_REQUIRED=true) refuse paid inference until an owner sets
 * `global.limitMicros`. Hold amounts are unapproved engineering placeholders, not prices.
 */
export const DEFAULT_AI_SPEND_POLICY: AiSpendPolicy = {
  currencyCode: "USD",
  global: { period: { kind: "CALENDAR_DAY", timeZone: "UTC" }, limitMicros: null },
  perAccount: { GUEST: null, FREE: null, BUSINESS_GO: null, BUSINESS_PRO: null },
  perPlan: { GUEST: null, FREE: null, BUSINESS_GO: null, BUSINESS_PRO: null },
  holdMicros: requests(20_000, 30_000, 30_000, 30_000, 60_000, 20_000),
  unpricedModel: "CHARGE_HOLD",
};

/** Version-0 placeholders. Not approved quotas; replace through `commercial_policies`. */
export const DEFAULT_AI_USAGE_POLICY: AiUsagePolicy = {
  approved: false,
  period: { kind: "CALENDAR_MONTH", timeZone: "UTC" },
  tiers: {
    GUEST: { requests: requests(10, 0, 0, 0, 0, 5), tokens: 40_000 },
    FREE: { requests: requests(150, 30, 30, 20, 10, 60), tokens: 600_000 },
    BUSINESS_GO: { requests: requests(600, 150, 150, 100, 50, 240), tokens: 2_400_000 },
    BUSINESS_PRO: { requests: requests(2_000, 600, 600, 400, 200, 800), tokens: 8_000_000 },
  },
  tokenEstimates: requests(4_000, 6_000, 5_000, 6_000, 12_000, 2_000),
  reservationTtlSeconds: 180,
  nearLimitRatio: 0.8,
  globalGuard: { enabled: true, period: { kind: "CALENDAR_DAY", timeZone: "UTC" }, requests: 200_000, tokens: 400_000_000 },
  spend: DEFAULT_AI_SPEND_POLICY,
};

export const AI_RESOURCE_LABELS: Record<AiUsageResource, string> = {
  TEXT_REQUEST: "المحادثات الذكية",
  MARKETING_GENERATION: "كتابة الإعلانات والنصوص التسويقية",
  BUSINESS_ANALYTICS: "المساعدة الذكية في تحليل الأعمال",
  IMAGE_UNDERSTANDING: "فهم الصور",
  AGENT_MULTI_STEP: "المهام الذكية متعددة الخطوات",
  AUDIO_TRANSCRIPTION: "تحويل الرسائل الصوتية إلى نص",
};

export const AI_TIER_LABELS: Record<AiPlanTier, string> = {
  GUEST: "زائر",
  FREE: "المجاني",
  BUSINESS_GO: "Business Go",
  BUSINESS_PRO: "Business Pro",
};

/** Offset of `timeZone` from UTC at `at`, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - (at.getTime() - at.getUTCMilliseconds());
}

/** The UTC instant of local midnight on the given local calendar date in `timeZone`. */
function zonedMidnight(year: number, monthIndex: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, monthIndex, day);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

/** Calendar period containing `now` (renewal = the next local midnight boundary). */
export function usagePeriod(period: AiUsagePolicy["period"], now = new Date()): { start: Date; end: Date } {
  const local = new Date(now.getTime() + zoneOffsetMs(now, period.timeZone));
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  if (period.kind === "CALENDAR_DAY") {
    const day = local.getUTCDate();
    return { start: zonedMidnight(year, month, day, period.timeZone), end: zonedMidnight(year, month, day + 1, period.timeZone) };
  }
  return { start: zonedMidnight(year, month, 1, period.timeZone), end: zonedMidnight(year, month + 1, 1, period.timeZone) };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
