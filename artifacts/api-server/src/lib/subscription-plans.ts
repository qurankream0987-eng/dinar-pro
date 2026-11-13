/**
 * D1 — the three public DINAR subscription plans and how they map onto what already exists.
 *
 * Five things are kept apart on purpose:
 *   1. the public plan (DINAR_GO / DINAR_PRO / DINAR_BUSINESS) — this module's plan definitions,
 *      owner-controlled through `commercial_policies.policy.subscriptionPlans` (versioned rows with
 *      their author: the audit history), proposed and unapproved until the owner says otherwise;
 *   2. the internal AI capacity tier (FREE / BUSINESS_GO / BUSINESS_PRO in ai-usage-policy.ts) —
 *      unchanged; a plan reaches it only through the AI_USAGE_* entitlement on its catalog product;
 *   3. the commercial feature entitlements — the existing `businessEntitlements` of the market's
 *      DINAR_BUSINESS catalog product, snapshotted on the subscription at purchase;
 *   4. business verification — business-profiles.ts; payment never produces it;
 *   5. the billing status — business_subscriptions + subscription-billing.ts; verification never
 *      produces it.
 * The legacy technical names (BUSINESS_GO, BUSINESS_PRO, AI_USAGE_BUSINESS_*) stay: historical
 * subscriptions, usage counters and spend rows keep their meaning. A subscription bought before D1
 * (plan_code_snapshot NULL) keeps its own snapshot; its public plan is derived for display only.
 */
import { z } from "zod";
import { AI_TIER_ENTITLEMENTS, type AiPlanTier } from "./ai-usage-policy";

export const PLAN_CODES = ["DINAR_GO", "DINAR_PRO", "DINAR_BUSINESS"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];
export type AccessPlan = "FREE" | PlanCode;

/** Every entitlement key a DINAR_BUSINESS catalog product may carry. */
export const BUSINESS_ENTITLEMENT_KEYS = [
  "MARKET_PULSE_ADVANCED",
  "CAMPAIGN_ANALYTICS_ADVANCED",
  "BUSINESS_REPORTING",
  "INVENTORY_INSIGHTS",
  "AI_USAGE_BUSINESS_GO",
  "AI_USAGE_BUSINESS_PRO",
  "BUSINESS_PROFILE_TOOLS",
] as const;
export type BusinessEntitlementKey = (typeof BUSINESS_ENTITLEMENT_KEYS)[number];

/**
 * Entitlements that only a verified business may use. A product may carry them only for the
 * DINAR_BUSINESS plan, and at runtime they are granted only while the subscription's business is
 * VERIFIED and owned by the subscriber (business.ts). Older keys stay ungated so historical
 * subscriptions keep exactly what they bought.
 */
export const BUSINESS_ONLY_ENTITLEMENTS: ReadonlySet<string> = new Set(["BUSINESS_PROFILE_TOOLS"]);

const Money = z.object({ amountMinor: z.number().int().positive().max(100_000_000), currencyCode: z.string().regex(/^[A-Z]{3}$/), minorUnitScale: z.number().int().min(0).max(3) }).strict();

const PlanDefinition = z
  .object({
    nameAr: z.string().trim().min(2).max(60),
    nameEn: z.string().trim().min(2).max(60),
    descriptionAr: z.string().trim().min(2).max(400),
    /** Proposed reference price. Display only: never charged, never converted to a market currency. */
    referencePrice: Money,
    /** Version of the reference price; bumps on every owner change. */
    priceVersion: z.number().int().min(1),
    /** PROPOSED: shown with «مقترح»; ACTIVE: owner-approved; RETIRED: no new subscriptions. */
    status: z.enum(["PROPOSED", "ACTIVE", "RETIRED"]),
    /** Whether this market offers the plan at all (the market row overrides the global one). */
    availableInMarket: z.boolean(),
    eligibility: z.enum(["AUTHENTICATED_ACCOUNT", "VERIFIED_BUSINESS"]),
    /** The AI capacity entitlement the market product is expected to carry (null: tools only). */
    aiTierEntitlement: z.enum(["AI_USAGE_BUSINESS_GO", "AI_USAGE_BUSINESS_PRO"]).nullable(),
    /** Entitlement keys a catalog product for this plan may carry. */
    allowedEntitlements: z.array(z.enum(BUSINESS_ENTITLEMENT_KEYS)).max(BUSINESS_ENTITLEMENT_KEYS.length),
    /** Feature lines for the comparison card (Arabic), owner-edited text. */
    featuresAr: z.array(z.string().trim().min(2).max(120)).max(12),
  })
  .strict();
export type PlanDefinition = z.infer<typeof PlanDefinition>;

export const SubscriptionPlansPolicySchema = z
  .object({
    /** False until the owner approves the plan definitions commercially. */
    approved: z.boolean(),
    /**
     * Real billing stays DISABLED in D1. It is not a switch: enabling paid activation needs a
     * verified provider adapter in server code and an owner activation policy (not a policy row).
     */
    billingActivation: z.literal("DISABLED"),
    /** Business includes Pro's AI capacity only when the owner configures it (decision D1-4). */
    businessIncludesProCapacity: z.boolean(),
    plans: z.object({ DINAR_GO: PlanDefinition, DINAR_PRO: PlanDefinition, DINAR_BUSINESS: PlanDefinition }).strict(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    for (const code of PLAN_CODES) {
      const plan = policy.plans[code];
      if (code === "DINAR_BUSINESS" ? plan.eligibility !== "VERIFIED_BUSINESS" : plan.eligibility !== "AUTHENTICATED_ACCOUNT")
        ctx.addIssue({ code: "custom", path: ["plans", code, "eligibility"], message: "DINAR_BUSINESS needs a verified business; Go and Pro need an account only" });
      if (code !== "DINAR_BUSINESS" && plan.allowedEntitlements.some((key) => BUSINESS_ONLY_ENTITLEMENTS.has(key)))
        ctx.addIssue({ code: "custom", path: ["plans", code, "allowedEntitlements"], message: "business-only entitlements belong to DINAR_BUSINESS" });
      if (plan.aiTierEntitlement && !plan.allowedEntitlements.includes(plan.aiTierEntitlement))
        ctx.addIssue({ code: "custom", path: ["plans", code, "aiTierEntitlement"], message: "the AI tier entitlement must be allowed" });
    }
    const business = policy.plans.DINAR_BUSINESS;
    if (policy.businessIncludesProCapacity !== (business.aiTierEntitlement === "AI_USAGE_BUSINESS_PRO"))
      ctx.addIssue({ code: "custom", path: ["businessIncludesProCapacity"], message: "must match DINAR_BUSINESS.aiTierEntitlement" });
  });
export type SubscriptionPlansPolicy = z.infer<typeof SubscriptionPlansPolicySchema>;

const usd = (amountMinor: number) => ({ amountMinor, currencyCode: "USD", minorUnitScale: 2 });

/**
 * Proposed defaults (owner decision 2026-10-31, D1): Go 10 USD, Pro 20 USD, Business 49 USD per
 * month, all PROPOSED and unapproved. Business carries business tools only; whether it also
 * includes Pro's AI capacity is an open owner decision, so it is off here.
 */
export const DEFAULT_SUBSCRIPTION_PLANS_POLICY: SubscriptionPlansPolicy = {
  approved: false,
  billingActivation: "DISABLED",
  businessIncludesProCapacity: false,
  plans: {
    DINAR_GO: {
      nameAr: "جاسم جو",
      nameEn: "Jassim Go",
      descriptionAr: "للأفراد: سعة أكبر للمساعد الذكي وأدوات إنتاجية، دون سجل تجاري.",
      referencePrice: usd(1_000),
      priceVersion: 1,
      status: "PROPOSED",
      availableInMarket: true,
      eligibility: "AUTHENTICATED_ACCOUNT",
      aiTierEntitlement: "AI_USAGE_BUSINESS_GO",
      allowedEntitlements: ["AI_USAGE_BUSINESS_GO", "MARKET_PULSE_ADVANCED"],
      featuresAr: ["سعة أكبر للمحادثات الذكية", "كتابة إعلانات ونصوص تسويقية أكثر", "فهم صور ورسائل صوتية أكثر"],
    },
    DINAR_PRO: {
      nameAr: "جاسم برو",
      nameEn: "Jassim Pro",
      descriptionAr: "للأفراد والمحترفين: أعلى سعة للمساعد ومهام ذكية متقدمة متعددة الخطوات.",
      referencePrice: usd(2_000),
      priceVersion: 1,
      status: "PROPOSED",
      availableInMarket: true,
      eligibility: "AUTHENTICATED_ACCOUNT",
      aiTierEntitlement: "AI_USAGE_BUSINESS_PRO",
      allowedEntitlements: ["AI_USAGE_BUSINESS_PRO", "MARKET_PULSE_ADVANCED", "CAMPAIGN_ANALYTICS_ADVANCED"],
      featuresAr: ["أعلى سعة للمحادثات الذكية", "مهام ذكية متعددة الخطوات أكثر", "نبض السوق المتقدم وتحليلات الحملات"],
    },
    DINAR_BUSINESS: {
      nameAr: "جاسم بزنس",
      nameEn: "Jassim Business",
      descriptionAr: "للأنشطة التجارية الموثّقة: أدوات النشاط وتقاريره ومخزونه. يتطلب نشاطًا موثّقًا من مراجع جاسم.",
      referencePrice: usd(4_900),
      priceVersion: 1,
      status: "PROPOSED",
      availableInMarket: true,
      eligibility: "VERIFIED_BUSINESS",
      aiTierEntitlement: null,
      allowedEntitlements: ["BUSINESS_PROFILE_TOOLS", "BUSINESS_REPORTING", "INVENTORY_INSIGHTS", "MARKET_PULSE_ADVANCED", "CAMPAIGN_ANALYTICS_ADVANCED", "AI_USAGE_BUSINESS_GO", "AI_USAGE_BUSINESS_PRO"],
      featuresAr: ["ملف نشاط تجاري موثّق في جاسم", "تقارير النشاط ورؤى المخزون", "نبض السوق المتقدم وتحليلات الحملات"],
    },
  },
};

/** The public plan of a catalog product: its own code, or (legacy rows) derived from its AI tier. */
export function planCodeOfProduct(product: { planCode?: string | null; businessEntitlements?: readonly string[] | null }): PlanCode | null {
  if (product.planCode && (PLAN_CODES as readonly string[]).includes(product.planCode)) return product.planCode as PlanCode;
  const keys = product.businessEntitlements ?? [];
  if (keys.includes("AI_USAGE_BUSINESS_PRO")) return "DINAR_PRO";
  if (keys.includes("AI_USAGE_BUSINESS_GO")) return "DINAR_GO";
  return null;
}

/** The public plan of a subscription: its snapshot, or (pre-D1 rows) derived from its snapshot. */
export function planCodeOfSubscription(row: { planCodeSnapshot?: string | null; entitlementsSnapshot: readonly string[] }): PlanCode | null {
  return planCodeOfProduct({ planCode: row.planCodeSnapshot, businessEntitlements: row.entitlementsSnapshot });
}

/** Admin validation of a DINAR_BUSINESS catalog product against its plan definition. */
export function validateCatalogProductForPlan(policy: SubscriptionPlansPolicy, planCode: PlanCode | null, entitlements: readonly string[]): string | null {
  if (!planCode) return entitlements.some((key) => BUSINESS_ONLY_ENTITLEMENTS.has(key)) ? "مزايا النشاط الموثّق تخص خطة جاسم بزنس فقط" : null;
  const plan = policy.plans[planCode];
  const outside = entitlements.filter((key) => !(plan.allowedEntitlements as readonly string[]).includes(key));
  if (outside.length) return `مزايا غير مسموحة لخطة ${plan.nameAr}: ${outside.join(", ")}`;
  if (plan.aiTierEntitlement && !entitlements.includes(plan.aiTierEntitlement)) return `خطة ${plan.nameAr} تحتاج سعة الذكاء المحددة لها`;
  return null;
}

/** Order used for upgrade/downgrade wording: by proposed reference price. */
export function planRank(policy: SubscriptionPlansPolicy, plan: AccessPlan): number {
  return plan === "FREE" ? 0 : policy.plans[plan].referencePrice.amountMinor;
}

export function planChangeKind(policy: SubscriptionPlansPolicy, current: AccessPlan, target: AccessPlan) {
  if (current === target) return { kind: "NO_CHANGE" as const };
  const upgrade = planRank(policy, target) > planRank(policy, current);
  return {
    kind: upgrade ? ("UPGRADE" as const) : ("DOWNGRADE" as const),
    effective: upgrade ? ("AFTER_PAYMENT_CONFIRMATION" as const) : ("AT_PERIOD_END" as const),
    proration: "NOT_APPROVED" as const,
    requiresVerifiedBusiness: target === "DINAR_BUSINESS",
  };
}

/** The AI tier a plan definition intends (for display; the real tier comes from the snapshot). */
export function intendedAiTier(plan: PlanDefinition): AiPlanTier {
  return plan.aiTierEntitlement ? AI_TIER_ENTITLEMENTS[plan.aiTierEntitlement] : "FREE";
}

export function formatReferencePrice(price: PlanDefinition["referencePrice"]): string {
  const major = (price.amountMinor / 10 ** price.minorUnitScale).toFixed(price.minorUnitScale).replace(/\.0+$/, "");
  return `${major} ${price.currencyCode === "USD" ? "دولار" : price.currencyCode}`;
}

/** Every public plan a folded Arabic text names («جو وبرو» → Go and Pro), in plan order. */
export function namedPlanCodes(text: string): PlanCode[] {
  const padded = ` ${text} `;
  return [
    ...(/(?:\s|و)(?:go|جو)(?:\s|$)/u.test(padded) ? (["DINAR_GO"] as const) : []),
    ...(/(?:\s|و)(?:pro|برو)(?:\s|$)/u.test(padded) ? (["DINAR_PRO"] as const) : []),
    ...(/(?:\s|و)(?:بزنس|بيزنس|business)(?:\s|$)/u.test(padded) ? (["DINAR_BUSINESS"] as const) : []),
  ];
}

/** «جاسم برو», «دينار برو» (old name, still understood), «برو», «pro» … → plan code. Folded Arabic expected (ة→ه). */
export function namedPlanCode(text: string): PlanCode | undefined {
  if (/(?:^|\s)(?:(?:جاسم|دينار)\s+)?(?:بزنس|بيزنس|business)(?:\s|$)/u.test(text)) return "DINAR_BUSINESS";
  if (/(?:^|\s)(?:(?:جاسم|دينار)\s+)?(?:pro|برو)(?:\s|$)/u.test(text)) return "DINAR_PRO";
  if (/(?:^|\s)(?:(?:جاسم|دينار)\s+)?(?:go|جو)(?:\s|$)/u.test(text)) return "DINAR_GO";
  return undefined;
}
