/**
 * Multi-tier model routing (owner policy 2026-11-13): FREE → alternative FREE → approved ECONOMY →
 * approved CORE, or CORE/ADVANCED directly when the task or the user's permitted choice calls for
 * it. The planner is pure and bounded: it returns at most two models (one primary, one failover —
 * the conversation runtime fails over once), never sends a message through every model, and never
 * includes a model that is not in the owner's catalog with an approved price that fits the per-turn
 * ceilings. Money is then held and settled by the existing usage/spend transaction (ai-usage.ts,
 * ai-spend.ts), which enforces the per-account, per-plan (daily per audience) and global caps.
 */
import type { aiModelPrices } from "@workspace/db";
import type { AiPlanTier, CatalogModel, ModelClass, ModelRoutingPolicy } from "../lib/ai-usage-policy";

type Price = typeof aiModelPrices.$inferSelect;

/** User-facing classes (server-controlled aliases); saved conversations keep working as models change. */
export const MODEL_PREFERENCES = ["AUTO", "ECONOMY", "CORE", "ADVANCED"] as const;
export type ModelPreference = (typeof MODEL_PREFERENCES)[number];
export type TaskDifficulty = "LIGHT" | "HEAVY";

export type RouteExclusion =
  | "CLASS_NOT_ALLOWED"
  | "NOT_QUALIFIED"
  | "CONTEXT_TOO_SMALL"
  | "NO_APPROVED_PRICE"
  | "CURRENCY_MISMATCH"
  | "FREE_NOT_ZERO_PRICE"
  | "FREE_NOT_ALLOWLISTED"
  | "PAID_FALLBACK_DISABLED"
  | "OVER_TURN_CEILING"
  | "UNAVAILABLE";

export type RouteCandidate = {
  provider: string;
  model: string;
  class: ModelClass;
  contextWindow: number;
  paid: boolean;
  projectedMicros: number;
};

export type RoutePlan =
  | { kind: "ROUTE"; attempts: RouteCandidate[]; order: ModelClass[]; excluded: { model: string; reason: RouteExclusion }[] }
  | { kind: "NO_CAPACITY"; order: ModelClass[]; excluded: { model: string; reason: RouteExclusion }[] };

/** Class order by the user's permitted choice and the task. CORE can be chosen directly. */
export function classOrder(preference: ModelPreference, difficulty: TaskDifficulty): ModelClass[] {
  switch (preference) {
    case "ECONOMY":
      return ["ECONOMY", "FREE"];
    case "CORE":
      return ["CORE", "ECONOMY"];
    case "ADVANCED":
      return ["ADVANCED", "CORE"];
    default:
      return difficulty === "HEAVY" ? ["CORE", "ECONOMY", "FREE"] : ["FREE", "ECONOMY", "CORE"];
  }
}

/** Projected cost of one turn in spend micros from an approved price row (never a guess). */
export function projectedTurnMicros(price: Price, projection: ModelRoutingPolicy["projection"]): number {
  return Math.ceil(
    (projection.inputTokens * price.inputPerMillionMicros + projection.outputTokens * price.outputPerMillionMicros) / 1_000_000 +
      (price.requestMicros ?? 0),
  );
}

const zeroPrice = (price: Price) =>
  price.inputPerMillionMicros === 0 && price.outputPerMillionMicros === 0 && (price.requestMicros ?? 0) === 0 &&
  (price.cachedInputPerMillionMicros ?? 0) === 0 && (price.cacheWriteInputPerMillionMicros ?? 0) === 0 && (price.cacheWrite12hInputPerMillionMicros ?? 0) === 0;

export function planModelRoute(input: {
  policy: ModelRoutingPolicy;
  tier: AiPlanTier;
  preference: ModelPreference;
  difficulty: TaskDifficulty;
  needs: { tools: boolean; structuredOutput: boolean; contextTokens: number };
  /** Approved (non-placeholder, sourced) price per `${provider}\u0000${model}`, or undefined. */
  prices: Map<string, Price | undefined>;
  spendCurrency: string;
  available: (entry: CatalogModel) => boolean;
  freeAllowlisted: (entry: CatalogModel) => boolean;
  /** DINAR_PAID_FALLBACK_KILL=1: no paid catalog model is routed to, for anyone. */
  paidKilled: boolean;
}): RoutePlan {
  const audience = input.policy.audiences[input.tier];
  const order = classOrder(input.preference, input.difficulty).filter((cls) => audience.classes.includes(cls));
  const excluded: { model: string; reason: RouteExclusion }[] = [];
  const attempts: RouteCandidate[] = [];
  const paidAllowed = input.policy.paidFallbackEnabled && audience.paidFallback && !input.paidKilled;
  for (const cls of order) {
    for (const entry of input.policy.models.filter((model) => model.class === cls)) {
      const reject = (reason: RouteExclusion) => excluded.push({ model: entry.model, reason });
      if (!entry.qualified.arabic || (input.needs.tools && !entry.qualified.tools) || (input.needs.structuredOutput && !entry.qualified.structuredOutput)) { reject("NOT_QUALIFIED"); continue; }
      if (entry.contextWindow < input.needs.contextTokens) { reject("CONTEXT_TOO_SMALL"); continue; }
      const price = input.prices.get(`${entry.provider}\u0000${entry.model}`);
      if (!price || price.source === "TEST_PLACEHOLDER" || !price.sourceReference?.trim()) { reject("NO_APPROVED_PRICE"); continue; }
      if (price.currencyCode !== input.spendCurrency) { reject("CURRENCY_MISMATCH"); continue; }
      const free = zeroPrice(price);
      if (cls === "FREE") {
        if (!free) { reject("FREE_NOT_ZERO_PRICE"); continue; }
        if (!input.freeAllowlisted(entry)) { reject("FREE_NOT_ALLOWLISTED"); continue; }
      } else if (!free && !paidAllowed) { reject("PAID_FALLBACK_DISABLED"); continue; }
      const projected = projectedTurnMicros(price, input.policy.projection);
      if (projected > audience.perTurnMaxMicros || projected > entry.maxTurnMicros) { reject("OVER_TURN_CEILING"); continue; }
      if (!input.available(entry)) { reject("UNAVAILABLE"); continue; }
      attempts.push({ provider: entry.provider, model: entry.model, class: cls, contextWindow: entry.contextWindow, paid: !free, projectedMicros: projected });
    }
  }
  // Bounded: one primary and one failover. The failover prefers the next class (FREE → ECONOMY), so a
  // free-quota outage still has an authorized answer path; an unavailable (breaker-open) model is
  // already excluded above, which is how a second free model takes over from an exhausted first.
  const [primary] = attempts;
  const failover = primary ? attempts.find((item) => item.class !== primary.class) ?? attempts[1] : undefined;
  attempts.splice(0, attempts.length, ...[primary, failover].filter((item): item is RouteCandidate => Boolean(item)));
  return attempts.length ? { kind: "ROUTE", attempts, order, excluded } : { kind: "NO_CAPACITY", order, excluded };
}

/** Honest text when no authorized model or budget is left; nothing was sent and nothing charged. */
export const NO_CAPACITY_MESSAGE =
  "قدرة النماذج المتاحة لك مستنفدة مؤقتًا؛ لم أرسل طلبك إلى أي نموذج ولم يُخصم شيء. حاول بعد قليل، وتبقى ميزات السوق متاحة.";

/** Emergency switch outside the database: an operator can stop all paid catalog routing instantly. */
export const paidFallbackKilled = (env: NodeJS.ProcessEnv = process.env) => env.DINAR_PAID_FALLBACK_KILL === "1";
