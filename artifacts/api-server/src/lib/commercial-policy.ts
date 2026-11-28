/**
 * Versioned commercial policy (Monetization V3). Every commercial limit, window and
 * threshold is read from here: the code defaults are version 0, and an admin row in
 * `commercial_policies` (market-specific over global, highest version effective now)
 * overrides them. Nothing in search, recommendations or the UI hardcodes these values.
 */
import { createHmac } from "node:crypto";
import { DEFAULT_SUBSCRIPTION_PLANS_POLICY, SubscriptionPlansPolicySchema } from "./subscription-plans";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { commercialPolicies, db } from "@workspace/db";
import { AiUsagePolicySchema, DEFAULT_AI_USAGE_POLICY } from "./ai-usage-policy";

export const ENGAGEMENT_KINDS = [
  "DETAIL_OPENED",
  "COMPARISON_STARTED",
  "NEGOTIATION_STARTED",
  "PURCHASE_REVIEW_STARTED",
] as const;
export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number];

export const PulseWindow = z.enum(["24h", "7d", "30d"]);
export type PulseWindow = z.infer<typeof PulseWindow>;
export const PULSE_WINDOW_MS: Record<PulseWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export const CommercialPolicySchema = z
  .object({
    /** Paid slots per search page; organic results always keep the rest. */
    searchSponsoredSlots: z.number().int().min(0).max(4),
    recommendationSponsoredSlots: z.number().int().min(0).max(2),
    /** Paid demand-capture options added when supply is zero/low or the buyer is unsatisfied. */
    demandRescueSlots: z.number().int().min(0).max(4),
    /** Organic result counts below this are a deterministic low-supply condition. */
    lowSupplyThreshold: z.number().int().min(0).max(10),
    /** Minimum share of the buyer's need words a demand-capture listing must contain. */
    demandRelevanceMinCoverage: z.number().min(0.25).max(1),
    minCohortSize: z.number().int().min(3).max(1000),
    impressionDedupMinutes: z.number().int().min(1).max(24 * 60),
    engagementDedupHours: z.number().int().min(1).max(24 * 30),
    billableEngagementKinds: z.array(z.enum(ENGAGEMENT_KINDS)),
    attributionTokenTtlMinutes: z.number().int().min(5).max(7 * 24 * 60),
    conversionWindowDays: z.number().int().min(1).max(30),
    /** Which credit a charge or reservation consumes first. */
    creditConsumptionOrder: z.enum(["PROMO_FIRST", "PAID_FIRST"]),
    refreshMinIntervalHours: z.number().int().min(1).max(24 * 30),
    refreshMaxPerDay: z.number().int().min(1).max(10),
    topupMinMajor: z.number().int().min(1),
    topupMaxMajor: z.number().int().min(1),
    freePulseWindows: z.array(PulseWindow).min(1),
    businessPulseWindows: z.array(PulseWindow).min(1),
    freePulseInsightLimit: z.number().int().min(1).max(20),
    businessPulseInsightLimit: z.number().int().min(1).max(50),
    rawEventRetentionDays: z.number().int().min(1).max(365),
    demandSignalRetentionDays: z.number().int().min(1).max(365),
    /** Sponsored Conversation, WELCOME placement: cards on an empty new conversation (never more than 2). */
    welcomeSponsoredSlots: z.number().int().min(0).max(3),
    /** Newly created conversations per viewer per 24 h that may show welcome cards at all. */
    welcomeSponsoredDailyConversations: z.number().int().min(0).max(20),
    /** How long a buyer's saved, authorised request («نبّهني إذا توفر») stays matchable. */
    demandRequestRetentionDays: z.number().int().min(1).max(90),
    /**
     * The paid advertising products a market may sell. Unset (v0) keeps every legacy type for
     * compatibility; the owner's proposal sets exactly the three: Sponsored Conversation
     * (SPONSORED_RECOMMENDATION, placements WELCOME + in-chat), «جاسم روح بيع لي» (DEMAND_CAPTURE)
     * and Sponsored Search (SPONSORED_SEARCH).
     */
    advertisingProducts: z.array(z.enum(["SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE", "SPONSORED_SEARCH", "FEATURED_LISTING", "VIP_LISTING", "REFRESH_LISTING", "PROMOTION_BUNDLE", "HERO_BANNER", "SIDEBAR_AD"])).min(1).max(9).optional(),
    /**
     * Owner reference tariffs for the three advertising products (decision 2026-11-14), in USD
     * at the currency's own precision (2). A market's product must use exactly the tariff's
     * duration; where the market currency is the tariff currency its price must equal the
     * tariff; elsewhere the market's own price is set by the commercial admin (no automatic
     * conversion). Billing stays disabled: this is a price list, not an activation.
     */
    advertisingTariffs: z
      .array(
        z
          .object({
            productType: z.enum(["SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE", "SPONSORED_SEARCH"]),
            referencePrice: z.object({ amountMinor: z.number().int().min(0), currencyCode: z.string().regex(/^[A-Z]{3}$/), minorUnitScale: z.number().int().min(0).max(3) }).strict(),
            durationDays: z.number().int().min(1).max(90),
            autoRenew: z.literal(false),
          })
          .strict(),
      )
      .max(3),
    /** Jassim Ads: PROVIDER_DIRECT lets a fixed-price promotion be paid through a collection provider (default off). */
    advertisingBillingActivation: z.enum(["DISABLED", "PROVIDER_DIRECT"]),
    /** Which registered PromotionBillingProvider collects promotion payments in this market. */
    advertisingBillingProvider: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    /** G1: AI usage allowances per plan tier and the global AI spending guard. */
    aiUsage: AiUsagePolicySchema,
    /** D1: the public Go / Pro / Business plan definitions (proposed until the owner approves). */
    subscriptionPlans: SubscriptionPlansPolicySchema,
  })
  .strict();
export type CommercialPolicy = z.infer<typeof CommercialPolicySchema> & { version: number };

/** Version 0: the base policy (Block E slot limits kept). */
export const DEFAULT_COMMERCIAL_POLICY: CommercialPolicy = {
  version: 0,
  searchSponsoredSlots: 2,
  recommendationSponsoredSlots: 1,
  demandRescueSlots: 2,
  lowSupplyThreshold: 2,
  demandRelevanceMinCoverage: 0.5,
  minCohortSize: 10,
  impressionDedupMinutes: 30,
  engagementDedupHours: 24,
  billableEngagementKinds: [...ENGAGEMENT_KINDS],
  attributionTokenTtlMinutes: 24 * 60,
  conversionWindowDays: 7,
  creditConsumptionOrder: "PROMO_FIRST",
  refreshMinIntervalHours: 24,
  refreshMaxPerDay: 1,
  topupMinMajor: 1,
  topupMaxMajor: 1000,
  freePulseWindows: ["7d"],
  businessPulseWindows: ["24h", "7d", "30d"],
  freePulseInsightLimit: 3,
  businessPulseInsightLimit: 10,
  rawEventRetentionDays: 90,
  demandSignalRetentionDays: 90,
  welcomeSponsoredSlots: 2,
  welcomeSponsoredDailyConversations: 3,
  demandRequestRetentionDays: 30,
  aiUsage: DEFAULT_AI_USAGE_POLICY,
  subscriptionPlans: DEFAULT_SUBSCRIPTION_PLANS_POLICY,
  advertisingTariffs: [
    { productType: "SPONSORED_RECOMMENDATION", referencePrice: { amountMinor: 500, currencyCode: "USD", minorUnitScale: 2 }, durationDays: 7, autoRenew: false },
    { productType: "DEMAND_CAPTURE", referencePrice: { amountMinor: 500, currencyCode: "USD", minorUnitScale: 2 }, durationDays: 10, autoRenew: false },
    { productType: "SPONSORED_SEARCH", referencePrice: { amountMinor: 200, currencyCode: "USD", minorUnitScale: 2 }, durationDays: 7, autoRenew: false },
  ],
  advertisingBillingActivation: "DISABLED",
  advertisingBillingProvider: "whop",
};

/** The effective policy for a market: its own latest version, else the global one, else v0. */
export async function getCommercialPolicy(marketId: string, tx: any = db, now = new Date()): Promise<CommercialPolicy> {
  const rows = await tx
    .select()
    .from(commercialPolicies)
    .where(and(or(eq(commercialPolicies.marketId, marketId), isNull(commercialPolicies.marketId)), lte(commercialPolicies.effectiveFrom, now)))
    // Scope precedence must be applied before limiting: newer global history must never
    // evict an effective market-specific override from the candidate set.
    .orderBy(desc(sql`${commercialPolicies.marketId} IS NOT NULL`), desc(commercialPolicies.version))
    .limit(1);
  const row = rows.find((item: typeof commercialPolicies.$inferSelect) => item.marketId === marketId) ?? rows.find((item: typeof commercialPolicies.$inferSelect) => item.marketId === null);
  if (!row) return DEFAULT_COMMERCIAL_POLICY;
  const merged = CommercialPolicySchema.safeParse({ ...withoutVersion(DEFAULT_COMMERCIAL_POLICY), ...(row.policy as object) });
  return merged.success ? { ...merged.data, version: row.version } : DEFAULT_COMMERCIAL_POLICY;
}

function withoutVersion(policy: CommercialPolicy) {
  const { version: _version, ...rest } = policy;
  return rest;
}

/**
 * Production analytics count LIVE traffic only. Development, test and acceptance
 * runs write TEST rows and read TEST rows, so they never pollute production metrics.
 */
export function trafficClass(): "LIVE" | "TEST" {
  return process.env.NODE_ENV === "production" ? "LIVE" : "TEST";
}

function commercialSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Commercial signing key is unavailable");
  return secret;
}

/** One-way, domain-separated actor reference: counts distinct people, identifies nobody. */
export function actorKey(userId: string): string {
  return createHmac("sha256", commercialSecret()).update(`dinar-commercial-actor\0${userId}`).digest("base64url").slice(0, 32);
}

export function commercialSignature(domain: string, payload: string): string {
  return createHmac("sha256", commercialSecret()).update(`dinar-${domain}\0${payload}`).digest("base64url");
}

export function majorToMinor(major: number, scale: number): number {
  if (!Number.isFinite(major) || major <= 0) return NaN;
  // Integer arithmetic on the decimal string; never float multiplication.
  const [whole, fraction = ""] = String(major).split(".");
  if (fraction.length > scale) return NaN;
  return Number(`${whole}${fraction.padEnd(scale, "0")}`);
}

/**
 * Minor-unit scale of a price's own currency. A market's currency uses the market's scale; JassimAI
 * subscriptions may be priced in USD in every market (owner decision 2026-11-16: Go $10 / Pro $20 /
 * Business $49 monthly, ×10 annually), so a few ISO 4217 scales are known here. Unknown → undefined.
 */
const ISO_SCALES: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, SAR: 2, AED: 2, QAR: 2, KWD: 3, JOD: 3, BHD: 3, OMR: 3 };
export function scaleOfCurrency(currencyCode: string, market: { currencyCode: string; minorUnitScale: number }): number | undefined {
  return currencyCode === market.currencyCode ? market.minorUnitScale : ISO_SCALES[currencyCode];
}

export function formatMinorAmount(minor: number, scale: number, currency: string): string {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(scale + 1, "0");
  const value = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return `${negative ? "-" : ""}${value} ${currency}`;
}
