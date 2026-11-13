/**
 * D1.7 — one server-built comparison of Free, DINAR Go, DINAR Pro and DINAR Business for the
 * current account and market. The conversation card and the subscription page both render this
 * object; neither computes a price, an allowance or a status on the client.
 */
import { AI_RESOURCE_LABELS, AI_USAGE_RESOURCES, AI_TIER_ENTITLEMENTS } from "./ai-usage-policy";
import { aiUsageSummary } from "./ai-usage";
import { accessPlanFor, businessPlans, getBusinessStatus } from "./business";
import { getCommercialPolicy } from "./commercial-policy";
import { isPromotionSimulationEnabled } from "./promotion-policy";
import { subscriptionBillingStatus } from "./subscription-billing";
import { formatReferencePrice, intendedAiTier, PLAN_CODES, type PlanCode } from "./subscription-plans";
import { listOwnBusinesses } from "./business-profiles";

type Market = Parameters<typeof businessPlans>[0];

export async function subscriptionPlansOverview(actorId: string, market: Market) {
  const commercial = await getCommercialPolicy(market.id);
  const policy = commercial.subscriptionPlans;
  const [catalog, access, usage, status, businesses] = await Promise.all([
    businessPlans(market).catch((): Awaited<ReturnType<typeof businessPlans>> => []),
    accessPlanFor(actorId, market),
    aiUsageSummary({ kind: "USER", userId: actorId, market }),
    getBusinessStatus(actorId, market),
    listOwnBusinesses(actorId, market),
  ]);
  const verified = businesses.filter((item) => item.verificationStatus === "VERIFIED");
  const billing = subscriptionBillingStatus();
  const simulation = isPromotionSimulationEnabled();
  const allowances = (tier: keyof typeof commercial.aiUsage.tiers) =>
    AI_USAGE_RESOURCES.map((resource) => ({ key: resource, label: AI_RESOURCE_LABELS[resource], value: commercial.aiUsage.tiers[tier].requests[resource] }));
  const plans = PLAN_CODES.map((code: PlanCode) => {
    const plan = policy.plans[code];
    const product = catalog.find((item) => item.planCode === code);
    const tier = product ? Object.entries(AI_TIER_ENTITLEMENTS).find(([key]) => product.businessEntitlements?.includes(key))?.[1] ?? "FREE" : intendedAiTier(plan);
    const eligible = code !== "DINAR_BUSINESS" || verified.length > 0;
    return {
      planCode: code,
      name: plan.nameAr,
      nameEn: plan.nameEn,
      description: plan.descriptionAr,
      features: plan.featuresAr,
      status: plan.status,
      statusLabel: plan.status === "ACTIVE" ? "معتمدة" : plan.status === "RETIRED" ? "متوقفة" : "مقترحة",
      referencePriceLabel: `${formatReferencePrice(plan.referencePrice)} شهريًا (سعر مرجعي مقترح)`,
      marketPrice: product ? { planId: product.id, label: `${product.priceLabel} لكل ${product.durationDays} يومًا`, durationDays: product.durationDays } : null,
      marketPriceNote: product ? null : "لم يُعتمد سعر هذه الخطة بعملة سوقك بعد؛ لا تُحوَّل الأسعار بين العملات تلقائيًا.",
      availableInMarket: plan.availableInMarket,
      requiresVerifiedBusiness: code === "DINAR_BUSINESS",
      requiresDocuments: code === "DINAR_BUSINESS",
      eligible,
      eligibilityNote: code === "DINAR_BUSINESS" ? (eligible ? "لديك نشاط موثّق يمكن ربط الاشتراك به." : "يتطلب نشاطًا تجاريًا موثّقًا من مراجع دينار؛ الدفع لا يوثّق النشاط.") : "يكفي حساب دينار؛ لا يحتاج سجلًا تجاريًا.",
      aiTier: tier,
      allowances: allowances(tier),
      tokens: commercial.aiUsage.tiers[tier].tokens,
      current: access.plan === code,
    };
  });
  const canActivate = billing.connected || simulation;
  return {
    marketId: market.id,
    currentPlan: access.plan,
    currentPlanLabel: access.plan === "FREE" ? "الحساب المجاني" : policy.plans[access.plan].nameAr,
    legacySubscription: access.legacy,
    subscription: status,
    free: {
      name: "الحساب المجاني",
      features: ["البيع والشراء والتفاوض في دينار", "المساعد الذكي الأساسي", "الإعلانات المدفوعة متاحة بشكل منفصل"],
      allowances: allowances("FREE"),
      tokens: commercial.aiUsage.tiers.FREE.tokens,
      current: access.plan === "FREE",
    },
    plans,
    usage: {
      tier: usage.tier,
      renewsAt: usage.period.renewsAt,
      timeZone: usage.period.timeZone,
      resources: usage.resources,
      tokens: usage.tokens,
      premiumTrial: usage.premiumTrial,
    },
    approvals: {
      plansApproved: policy.approved,
      allowancesApproved: commercial.aiUsage.approved,
      note: !policy.approved || !commercial.aiUsage.approved ? "الخطط والأسعار والحدود مقترحة وغير معتمدة نهائيًا." : null,
    },
    billing: {
      status: billing.connected ? ("CONNECTED" as const) : ("NOT_CONNECTED" as const),
      activation: policy.billingActivation,
      simulationAvailable: simulation && !billing.connected,
      canActivate,
      note: billing.connected
        ? "الدفع يتم عبر مزوّد الفوترة؛ لا تُفعّل أي خطة قبل تأكيد موثّق منه."
        : simulation
          ? "الفوترة الحقيقية غير متصلة. في بيئة التطوير يمكن تجربة التفعيل من رصيد تجريبي فقط (TEST_NO_TRANSFER) دون تحويل أموال."
          : "الفوترة غير متصلة بعد؛ لا يمكن تفعيل خطة مدفوعة الآن، ولن يُخصم أي مبلغ.",
    },
    businesses: businesses.map((item) => ({ id: item.id, displayName: item.displayName, verificationStatus: item.verificationStatus, statusLabel: item.statusLabel })),
    renewalNote: "لا تجديد تلقائي؛ تنتهي الخطة المدفوعة بنهاية فترتها وتعود إلى المجاني ما لم تجددها بنفسك.",
    rankNote: "الاشتراك يضيف أدوات وسعة فقط؛ لا يغيّر ترتيب نتائج البحث العادية ولا شروط الظهور.",
    cancellation: { available: status.status === "ACTIVE", note: "الإلغاء يوقف التجديد فقط وتبقى المزايا حتى نهاية الفترة المدفوعة." },
  };
}
export type SubscriptionPlansOverview = Awaited<ReturnType<typeof subscriptionPlansOverview>>;
