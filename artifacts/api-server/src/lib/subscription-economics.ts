/**
 * D1.6 — what each plan could cost DINAR in AI inference at full use, computed only from what is
 * configured: the plan's usage allowance (ai-usage-policy), the owner-entered model prices
 * (ai_model_prices, never a guessed price) and explicit per-request assumptions below. Nothing here
 * selects or activates a provider, and no number is "approved": the owner reads a range.
 *
 * Model routing is modelled as a range: every request priced at the cheapest current model and at
 * the most expensive one. Long conversations, tool calls and multi-step agent work enter through the
 * per-resource token assumptions (agent tasks carry several model calls). The tier's token budget
 * caps the token-driven part: a plan can never consume more tokens than its allowance.
 */
import { AI_PLAN_TIERS, AI_USAGE_RESOURCES, type AiPlanTier, type AiUsageResource } from "./ai-usage-policy";
import { callCostMicros, listModelPrices } from "./ai-spend";
import { getCommercialPolicy } from "./commercial-policy";
import { intendedAiTier, PLAN_CODES } from "./subscription-plans";

/** Engineering assumptions per request (not measurements). Owner-reviewable; see the D1 docs. */
export const USAGE_ASSUMPTIONS: Record<AiUsageResource, { calls: number; inputTokens: number; outputTokens: number; imageUnits: number; audioSeconds: number }> = {
  // A conversation turn re-sends recent history: input dominates on long conversations.
  TEXT_REQUEST: { calls: 1, inputTokens: 3_000, outputTokens: 400, imageUnits: 0, audioSeconds: 0 },
  MARKETING_GENERATION: { calls: 1, inputTokens: 2_000, outputTokens: 900, imageUnits: 0, audioSeconds: 0 },
  BUSINESS_ANALYTICS: { calls: 2, inputTokens: 3_500, outputTokens: 700, imageUnits: 0, audioSeconds: 0 },
  IMAGE_UNDERSTANDING: { calls: 1, inputTokens: 1_500, outputTokens: 500, imageUnits: 1, audioSeconds: 0 },
  // Multi-step agent work: several calls, each with tool results in context.
  AGENT_MULTI_STEP: { calls: 5, inputTokens: 4_000, outputTokens: 600, imageUnits: 0, audioSeconds: 0 },
  AUDIO_TRANSCRIPTION: { calls: 1, inputTokens: 200, outputTokens: 300, imageUnits: 0, audioSeconds: 45 },
};

/** External integration costs per subscriber and month (none connected today: zero, flagged). */
export const EXTERNAL_COSTS_MICROS_PER_MONTH: Record<AiPlanTier, number> = { GUEST: 0, FREE: 0, BUSINESS_GO: 0, BUSINESS_PRO: 0 };

type CurrentPrice = Awaited<ReturnType<typeof listModelPrices>>[number];

function tierCost(policy: Awaited<ReturnType<typeof getCommercialPolicy>>["aiUsage"], tier: AiPlanTier, price: CurrentPrice, currencyCode: string) {
  const allowance = policy.tiers[tier];
  const plannedTokens = AI_USAGE_RESOURCES.reduce((sum, resource) => {
    const item = USAGE_ASSUMPTIONS[resource];
    return sum + allowance.requests[resource] * item.calls * (item.inputTokens + item.outputTokens);
  }, 0);
  // The token budget caps token-driven cost; images, audio and per-request fees are not token-bound.
  const tokenScale = plannedTokens > allowance.tokens && plannedTokens > 0 ? allowance.tokens / plannedTokens : 1;
  let total = 0;
  const perResource: Partial<Record<AiUsageResource, number>> = {};
  for (const resource of AI_USAGE_RESOURCES) {
    const item = USAGE_ASSUMPTIONS[resource];
    const requests = allowance.requests[resource];
    if (!requests) {
      perResource[resource] = 0;
      continue;
    }
    const one = callCostMicros(
      price as unknown as Parameters<typeof callCostMicros>[0],
      {
        inputTokens: Math.round(item.inputTokens * tokenScale),
        cachedInputTokens: 0,
        outputTokens: Math.round(item.outputTokens * tokenScale),
        imageUnits: item.imageUnits,
        audioSeconds: item.audioSeconds,
      },
      currencyCode,
    );
    if (one === undefined) return { priced: false as const, unpricedResource: resource };
    perResource[resource] = one * item.calls * requests;
    total += perResource[resource]!;
  }
  return { priced: true as const, totalMicros: total + EXTERNAL_COSTS_MICROS_PER_MONTH[tier], perResource, tokenBudgetBinding: tokenScale < 1 };
}

export async function subscriptionEconomics(marketId: string) {
  const commercial = await getCommercialPolicy(marketId);
  const currencyCode = commercial.aiUsage.spend.currencyCode;
  const prices = (await listModelPrices()).filter((row) => row.current && row.currencyCode === currencyCode);
  const tiers = Object.fromEntries(
    AI_PLAN_TIERS.filter((tier) => tier !== "GUEST").map((tier) => {
      const priced = prices.map((price) => ({ model: `${price.provider}/${price.model}`, cost: tierCost(commercial.aiUsage, tier, price, currencyCode) }));
      const usable = priced.filter((item): item is { model: string; cost: Extract<ReturnType<typeof tierCost>, { priced: true }> } => item.cost.priced);
      const sorted = [...usable].sort((a, b) => a.cost.totalMicros - b.cost.totalMicros);
      return [
        tier,
        sorted.length
          ? {
              status: "PRICED" as const,
              cheapest: { model: sorted[0]!.model, worstCaseMicros: sorted[0]!.cost.totalMicros },
              mostExpensive: { model: sorted.at(-1)!.model, worstCaseMicros: sorted.at(-1)!.cost.totalMicros, perResource: sorted.at(-1)!.cost.perResource },
              tokenBudgetBinding: sorted.at(-1)!.cost.tokenBudgetBinding,
              unpricedModels: priced.filter((item) => !item.cost.priced).map((item) => item.model),
            }
          : { status: "UNPRICED" as const, reason: prices.length ? "no current model price covers every billed unit" : `no current model price in ${currencyCode}` },
      ];
    }),
  ) as Record<Exclude<AiPlanTier, "GUEST">, unknown>;
  const plans = PLAN_CODES.map((code) => {
    const plan = commercial.subscriptionPlans.plans[code];
    const tier = intendedAiTier(plan);
    const cost = tiers[tier as Exclude<AiPlanTier, "GUEST">] as { status: string; mostExpensive?: { worstCaseMicros: number } };
    const referenceMicros = plan.referencePrice.currencyCode === currencyCode ? Math.round((plan.referencePrice.amountMinor / 10 ** plan.referencePrice.minorUnitScale) * 1_000_000) : null;
    const worst = cost.mostExpensive?.worstCaseMicros;
    return {
      planCode: code,
      aiTier: tier,
      referencePrice: plan.referencePrice,
      referencePriceMicros: referenceMicros,
      worstCaseAiCostMicros: worst ?? null,
      worstCaseMarginMicros: referenceMicros !== null && worst !== undefined ? referenceMicros - worst : null,
      verdict: worst === undefined || referenceMicros === null ? "UNKNOWN" : worst > referenceMicros ? "LOSS_AT_FULL_USE" : worst > referenceMicros * 0.5 ? "THIN_MARGIN_AT_FULL_USE" : "COVERED_AT_FULL_USE",
    };
  });
  return {
    currencyCode,
    allowancesApproved: commercial.aiUsage.approved,
    plansApproved: commercial.subscriptionPlans.approved,
    unlimited: false as const,
    assumptions: USAGE_ASSUMPTIONS,
    externalCostsMicrosPerMonth: EXTERNAL_COSTS_MICROS_PER_MONTH,
    externalCostsNote: "لا توجد تكاليف تكامل خارجي محسوبة لأن أي تكامل غير موصول بعد.",
    tiers,
    plans,
    spendLimits: {
      globalLimitMicros: commercial.aiUsage.spend.global.limitMicros,
      perAccount: commercial.aiUsage.spend.perAccount,
      note: "حدود الإنفاق يضعها المالك؛ عند غيابها في بيئات الإنتاج يرفض النظام الاستدعاءات المدفوعة.",
    },
  };
}
