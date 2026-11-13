/**
 * DINAR NEXT G1 inside the conversation: what an exhausted allowance tells the user, and
 * which metered resource a model turn consumes. Deterministic; no model call is needed to
 * explain usage, and ordinary marketplace actions never depend on an AI allowance.
 */
import { subscriptionPlansOverview } from "../lib/subscription-overview";
import { aiUsagePolicyFor, aiUsageSummary, globalGuardOpen, type AiUsageRefusal, type AiUsageSummary } from "../lib/ai-usage";
import { AI_RESOURCE_LABELS, AI_TIER_LABELS, AI_USAGE_RESOURCES, type AiUsageResource } from "../lib/ai-usage-policy";
import { businessPlans, getBusinessStatus, planAiTier } from "../lib/business";
import { isPromotionSimulationEnabled } from "../lib/promotion-policy";
import { modelGatewayFor } from "./model-turn";
import { isMarketingRequest, isSellerBusinessQuestion } from "./seller-management";

export function usageResourceFor(message: string): AiUsageResource {
  if (isMarketingRequest(message)) return "MARKETING_GENERATION";
  if (isSellerBusinessQuestion(message)) return "BUSINESS_ANALYTICS";
  return "TEXT_REQUEST";
}

/** «2026-11-01 00:00 (UTC)» in the policy's own time zone. */
export function renewalLabel(at: Date | string, timeZone = "UTC"): string {
  const date = typeof at === "string" ? new Date(at) : at;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${timeZone})`;
}

export const ESSENTIALS_STILL_AVAILABLE =
  "ما زال بإمكانك البحث في العروض والشراء ومتابعة طلباتك واستفساراتك للبائعين ومعرفة استهلاكك («كم باقي من حصتي؟»).";

/**
 * Honest, specific and non-pushy: which allowance ran out, when it renews, what still works,
 * and the plan comparison only when plans are actually configured and not already shown.
 */
export function usageLimitMessage(
  refusal: AiUsageRefusal,
  summary: AiUsageSummary | undefined,
  options: { plansConfigured: boolean; planHintAlreadyShown: boolean },
): string {
  const zone = summary?.period.timeZone ?? "UTC";
  const label = AI_RESOURCE_LABELS[refusal.resource];
  switch (refusal.reason) {
    case "DUPLICATE_IN_FLIGHT":
      return "طلبك نفسه ما زال قيد المعالجة؛ لم أرسله مرة ثانية ولم يُحتسب مرتين.";
    case "ALREADY_PROCESSED":
      return "عولج هذا الطلب نفسه من قبل؛ لم أكرره ولم يُحتسب مرة أخرى.";
    case "GLOBAL_BUDGET_EXHAUSTED":
      return `المساعد الذكي متوقف مؤقتًا على مستوى جاسم لضبط تكلفة التشغيل حتى ${renewalLabel(refusal.renewsAt)}. لم يُخصم شيء من حصتك. ${ESSENTIALS_STILL_AVAILABLE}`;
    case "SPEND_BUDGET_UNCONFIGURED":
    case "MODEL_UNPRICED":
      return `المساعد الذكي غير مفعّل في هذه البيئة بعد: لم يُعتمد حد إنفاق أو سعر للنموذج، فلا أرسل أي طلب مدفوع. لم يُخصم شيء من حصتك. ${ESSENTIALS_STILL_AVAILABLE}`;
    case "GLOBAL_SPEND_EXHAUSTED":
    case "PLAN_SPEND_EXHAUSTED":
      return `المساعد الذكي متوقف مؤقتًا لأن سقف الإنفاق المعتمد لهذه الفترة بلغ حده، حتى ${renewalLabel(refusal.renewsAt)}. لم يُخصم شيء من حصتك. ${ESSENTIALS_STILL_AVAILABLE}`;
    case "ACCOUNT_SPEND_EXHAUSTED":
      return `بلغ حسابك سقف تكلفة الذكاء الاصطناعي المعتمد لهذه الفترة؛ يتجدد في ${renewalLabel(refusal.renewsAt, zone)}. لم يُنفّذ أي طلب ذكي ولم يُخصم شيء. ${ESSENTIALS_STILL_AVAILABLE}`;
    case "NOT_INCLUDED":
      return refusal.tier === "GUEST"
        ? `«${label}» تحتاج إلى حساب. سجّل الدخول لتحصل على حصة الحساب المجاني؛ لم يُنفّذ شيء.`
        : `«${label}» غير مشمولة في حصتك الحالية. لم يُنفّذ شيء. ${ESSENTIALS_STILL_AVAILABLE}`;
    default: {
      const which = refusal.reason === "TOKEN_ALLOWANCE_EXHAUSTED" ? "حد معالجة الذكاء الاصطناعي (الرموز)" : `حد «${label}»`;
      const tier = AI_TIER_LABELS[refusal.tier];
      const others = (summary?.resources ?? [])
        .filter((item) => item.resource !== refusal.resource && item.included && item.remaining > 0 && refusal.reason !== "TOKEN_ALLOWANCE_EXHAUSTED")
        .slice(0, 2)
        .map((item) => `${item.label}: متبقٍ ${item.remaining}`);
      const lines = [
        `وصلت إلى ${which} في باقتك (${tier}) لهذه الفترة. تتجدد الحصة في ${renewalLabel(refusal.renewsAt, zone)}.`,
        "لم يُنفّذ أي طلب ذكي ولم يُخصم شيء، ومحادثتك ومسوداتك محفوظة كما هي.",
        ...(others.length ? [`ما زال متاحًا لك: ${others.join("، ")}.`] : []),
        ESSENTIALS_STILL_AVAILABLE,
        ...(options.plansConfigured && !options.planHintAlreadyShown ? ["إن أردت سعة أكبر قل «اعرض الباقات» لمقارنتها."] : []),
      ];
      return lines.join("\n");
    }
  }
}

export const PLAN_HINT_MARKER = "قل «اعرض الباقات» لمقارنتها";

export function nearLimitNote(resource: AiUsageResource, percent: number, renewsAt: string, timeZone: string): string {
  return `ملاحظة: استخدمت ${percent}% من حصة «${AI_RESOURCE_LABELS[resource]}» لهذه الفترة، وتتجدد في ${renewalLabel(renewsAt, timeZone)}.`;
}

// ─── Usage and plan cards (rebuilt from live server state on every read) ─────

type CardMarket = { id: string; countryCode: string; currencyCode: string; minorUnitScale: number };

/** Whether a model could answer right now: configured gateway, without calling it. */
async function providerStatus(market: CardMarket): Promise<"AVAILABLE" | "NOT_CONFIGURED"> {
  try {
    const gateway = await modelGatewayFor(undefined, { marketId: market.id, countryCode: market.countryCode, currencyCode: market.currencyCode });
    return gateway ? "AVAILABLE" : "NOT_CONFIGURED";
  } catch {
    return "NOT_CONFIGURED";
  }
}

export async function usageCardView(actorId: string, market: CardMarket) {
  const owner = { kind: "USER" as const, userId: actorId, market };
  const [summary, guardOpen, provider, subscription] = await Promise.all([
    aiUsageSummary(owner),
    globalGuardOpen(market),
    providerStatus(market),
    getBusinessStatus(actorId, market as Parameters<typeof getBusinessStatus>[1]),
  ]);
  const zone = summary.period.timeZone;
  return {
    tier: summary.tier,
    tierLabel: summary.tierLabel,
    entitlementSource: summary.entitlementSource,
    provisional: !summary.approved,
    renewsAt: summary.period.renewsAt,
    renewsAtLabel: renewalLabel(summary.period.renewsAt, zone),
    periodLabel: summary.period.kind === "CALENDAR_MONTH" ? "شهر تقويمي" : "يوم تقويمي",
    resources: summary.resources.map((item) => ({ key: item.resource, label: item.label, used: item.used, limit: item.limit, remaining: item.remaining, percent: item.percent, included: item.included, inProgress: item.inProgress })),
    tokens: summary.tokens,
    premiumTrial: summary.premiumTrial,
    exhaustedLabels: summary.exhausted.map((resource) => AI_RESOURCE_LABELS[resource]),
    platformPaused: !guardOpen,
    providerStatus: provider,
    subscription: { statusLabel: subscription.statusLabel, ...("planName" in subscription ? { planName: subscription.planName, currentPeriodEnd: subscription.currentPeriodEnd } : {}) },
    costNote: "لا تُحتسب عليك تكلفة مالية لكل طلب؛ الاستخدام يُقاس بعدد الطلبات والرموز ضمن حصة باقتك.",
    essentials: ESSENTIALS_STILL_AVAILABLE,
  };
}
export type UsageCardView = Awaited<ReturnType<typeof usageCardView>>;

export function usageCardPrompt(view: UsageCardView, question: "SUMMARY" | "RENEWAL" | "WHY_STOPPED"): string {
  const text = view.resources.find((item) => item.key === "TEXT_REQUEST")!;
  const lines = [
    `باقتك: ${view.tierLabel}${view.provisional ? " (الحدود الحالية مؤقتة وغير معتمدة نهائيًا)" : ""}.`,
    `${text.label}: استخدمت ${text.used} من ${text.limit}${text.percent !== null ? ` (${text.percent}%)` : ""}، والمتبقي ${text.remaining}.`,
    ...(view.premiumTrial.eligible
      ? [`التجربة المميزة: متبقٍ ${view.premiumTrial.remaining} من ${view.premiumTrial.limit} رسالة${view.premiumTrial.inProgress ? ` (${view.premiumTrial.inProgress} قيد المعالجة)` : ""}${view.premiumTrial.status === "DISABLED" ? "؛ غير مفعّلة حاليًا." : view.premiumTrial.status === "EXHAUSTED" ? "؛ انتهت." : "."}`]
      : []),
    `معالجة الذكاء (الرموز): ${view.tokens.used.toLocaleString("en-US")} من ${view.tokens.limit.toLocaleString("en-US")}${view.tokens.percent !== null ? ` (${view.tokens.percent}%)` : ""}.`,
    `تتجدد الحصة في ${view.renewsAtLabel}.`,
  ];
  if (question === "RENEWAL") return [`تتجدد حصتك في ${view.renewsAtLabel} (بداية ${view.periodLabel} جديد).`, lines[0]!].join("\n");
  if (question === "WHY_STOPPED") {
    const reasons = [
      ...(view.exhaustedLabels.length ? [`نفدت حصة: ${view.exhaustedLabels.join("، ")}. تتجدد في ${view.renewsAtLabel}.`] : []),
      ...(view.tokens.remaining === 0 ? ["نفد حد معالجة الذكاء (الرموز) لهذه الفترة."] : []),
      ...(view.platformPaused ? ["المساعد الذكي متوقف مؤقتًا على مستوى المنصة لضبط تكلفة التشغيل؛ لم يُخصم ذلك من حصتك."] : []),
      ...(view.providerStatus === "NOT_CONFIGURED" ? ["مزود الذكاء الاصطناعي غير متاح أو غير مهيأ في هذه البيئة الآن."] : []),
    ];
    return [
      ...(reasons.length ? reasons : ["حصتك لم تنفد والمزود مهيأ؛ لا أجد سببًا مسجلًا لتوقف الذكاء. إن تكرر ذلك فقد يكون عطلًا مؤقتًا لدى المزود."]),
      view.essentials,
    ].join("\n");
  }
  return lines.join("\n");
}

export async function plansCardView(actorId: string, market: CardMarket) {
  const [policy, plans, summary, overview] = await Promise.all([
    aiUsagePolicyFor(market),
    businessPlans(market as Parameters<typeof businessPlans>[0]).catch((): Awaited<ReturnType<typeof businessPlans>> => []),
    aiUsageSummary({ kind: "USER", userId: actorId, market }),
    subscriptionPlansOverview(actorId, market as Parameters<typeof subscriptionPlansOverview>[1]),
  ]);
  const simulation = isPromotionSimulationEnabled();
  const tiers = (["FREE", "BUSINESS_GO", "BUSINESS_PRO"] as const).map((tier) => {
    const plan = plans.find((item) => planAiTier(item.businessEntitlements) === tier);
    return {
      tier,
      label: AI_TIER_LABELS[tier],
      current: summary.tier === tier,
      priceLabel: tier === "FREE" ? "مجانًا" : plan ? `${plan.priceLabel} لكل ${plan.durationDays} يومًا` : null,
      priceConfigured: tier === "FREE" || Boolean(plan),
      planId: plan?.id,
      allowances: AI_USAGE_RESOURCES.map((resource) => ({ key: resource, label: AI_RESOURCE_LABELS[resource], value: policy.tiers[tier].requests[resource] })),
      tokens: policy.tiers[tier].tokens,
    };
  });
  return {
    currentTier: summary.tier,
    provisional: !policy.approved,
    tiers,
    sameCapabilities: "كل الباقات تعطي قدرات جاسم الذكية نفسها؛ الفرق في سعة الاستخدام فقط، ولا تمنح أي باقة وصولًا لبيانات بائعين أو مشترين آخرين.",
    billing: {
      status: "NOT_CONNECTED" as const,
      simulationAvailable: simulation,
      note: simulation
        ? "الفوترة الحقيقية غير متصلة. في بيئة التطوير يمكن تجربة التفعيل من رصيد تجريبي فقط (TEST_NO_TRANSFER) دون تحويل أموال."
        : "الفوترة غير متصلة بعد؛ لا يمكن تفعيل باقة مدفوعة الآن، ولن يُخصم أي مبلغ.",
    },
    renewalNote: "لا تجديد تلقائي؛ تنتهي الباقة المدفوعة بنهاية فترتها وتعود حصتك إلى المجاني.",
    // D1: the three public plans as the server defines them (price, eligibility, status).
    publicPlans: overview.plans.map((plan) => ({
      planCode: plan.planCode,
      name: plan.name,
      description: plan.description,
      features: plan.features.slice(0, 4),
      statusLabel: plan.statusLabel,
      referencePriceLabel: plan.referencePriceLabel,
      marketPriceLabel: plan.marketPrice?.label ?? null,
      requiresVerifiedBusiness: plan.requiresVerifiedBusiness,
      eligible: plan.eligible,
      eligibilityNote: plan.eligibilityNote,
      current: plan.current,
    })),
    publicPlansNote: overview.approvals.note,
  };
}
export type PlansCardView = Awaited<ReturnType<typeof plansCardView>>;

export function plansCardPrompt(view: PlansCardView, focus?: "BUSINESS_GO" | "BUSINESS_PRO"): string {
  if (focus) {
    const tier = view.tiers.find((item) => item.tier === focus)!;
    return tier.priceConfigured
      ? `سعر ${tier.label}: ${tier.priceLabel}. ${view.billing.note}`
      : `لم يُعتمد سعر ${tier.label} بعد في سوقك، لذلك لا يمكن الاشتراك فيها الآن. ${view.sameCapabilities}`;
  }
  return [
    ...view.tiers.map((tier) => `• ${tier.label}${tier.current ? " (باقتك الحالية)" : ""}: ${tier.priceConfigured ? tier.priceLabel : "السعر غير معتمد بعد"} — المحادثات الذكية ${tier.allowances.find((item) => item.key === "TEXT_REQUEST")!.value} لكل فترة.`),
    view.sameCapabilities,
    ...(view.provisional ? ["الحدود المعروضة مؤقتة وغير معتمدة نهائيًا."] : []),
  ].join("\n");
}

/**
 * A projection of the current period's text-request use to its end, from the actual pace so far.
 * Returned only when enough of the period has elapsed and something has been used; otherwise the
 * reason is returned instead of a number. Arithmetic only: no model, no invented history.
 */
export function usageProjection(
  resource: { used: number; limit: number; remaining: number },
  period: { start: string; renewsAt: string },
  now = new Date(),
  until?: Date,
): { kind: "PROJECTED"; projectedUseAtEnd: number; likelyToRunOut: boolean; basisHours: number; untilLabel: "PERIOD_END" | "REQUESTED_DATE" } | { kind: "INSUFFICIENT_DATA"; reason: string } {
  const start = Date.parse(period.start);
  const end = Date.parse(period.renewsAt);
  const target = until && until.getTime() < end ? until.getTime() : end;
  const elapsedMs = now.getTime() - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { kind: "INSUFFICIENT_DATA", reason: "PERIOD_UNKNOWN" };
  if (resource.limit <= 0) return { kind: "INSUFFICIENT_DATA", reason: "NO_LIMIT_CONFIGURED" };
  // Less than 6 hours of the period, or nothing used yet, is not a defensible pace.
  if (elapsedMs < 6 * 60 * 60 * 1000 || resource.used === 0) return { kind: "INSUFFICIENT_DATA", reason: resource.used === 0 ? "NO_USE_YET" : "PERIOD_TOO_YOUNG" };
  const ratePerMs = resource.used / elapsedMs;
  const projectedUseAtEnd = Math.round(resource.used + ratePerMs * Math.max(0, target - now.getTime()));
  return {
    kind: "PROJECTED",
    projectedUseAtEnd,
    likelyToRunOut: projectedUseAtEnd > resource.limit,
    basisHours: Math.round(elapsedMs / 3_600_000),
    untilLabel: target === end ? "PERIOD_END" : "REQUESTED_DATE",
  };
}
