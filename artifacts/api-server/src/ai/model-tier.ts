/**
 * Dual-tier model routing (option C: deterministic DINAR first, then LIGHT, HEAVY only when earned).
 *
 * - The tier is chosen by deterministic signals over the user's message: no extra model call
 *   decides the routing.
 * - LIGHT is the default model turn. HEAVY is used for long, analytical or writing requests, or
 *   once after LIGHT produced an invalid structured answer (MALFORMED / UNKNOWN_ACTION). It is
 *   never used for an outage (the gateway's fallback handles that), a timeout (the deadline is
 *   spent) or a quota refusal.
 * - Both tiers go through the same counted gateway (proposeThroughGateway), so the disable
 *   switch, circuit breaker, usage reservation and per-call costing apply to each.
 * - Without a configured HEAVY model, HEAVY is the same model at reasoning effort "high"
 *   (option A as the fallback of option B).
 * - Decisions (confirm, send, pay, accept terms) never reach any model: isDecisionUtterance.
 *
 * Off by default (DINAR_AI_TIERING unset or "off"): the single-model behaviour is unchanged.
 */
import { gatewayLocallyAvailable, type ConversationModelGateway, type ReasoningEffort } from "./model-gateway";
import type { ModelFailure } from "./model-turn";
import { isDecisionUtterance } from "./routing-mode";
import { normalizeSearch } from "./search-context";

export type ModelTier = "LIGHT" | "HEAVY";
export type TierReason =
  | "TIERING_OFF"
  | "DEFAULT_LIGHT"
  | "DECISION_NEVER_ESCALATES"
  | "USER_PREFERENCE"
  | "LONG_REQUEST"
  | "ANALYSIS"
  | "CALCULATION"
  | "MULTI_QUESTION"
  | "WRITING"
  | "LIGHT_OUTPUT_INVALID"
  | "HEAVY_CAP_REACHED"
  | "HEAVY_UNAVAILABLE";
export type TierDecision = { tier: ModelTier; reason: TierReason };

export function modelTieringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DINAR_AI_TIERING ?? "").trim().toLowerCase() === "on";
}

/** Characters from which a request is treated as long (DINAR_AI_HEAVY_MIN_CHARS, 120–2000, default 400). */
export function heavyMinChars(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DINAR_AI_HEAVY_MIN_CHARS);
  return Number.isInteger(value) ? Math.min(Math.max(value, 120), 2000) : 400;
}

/** HEAVY turns per actor per model-turn window (DINAR_AI_HEAVY_TURNS_PER_WINDOW, 0–20, default 5; 0 = never). */
export function heavyTurnLimit(env: NodeJS.ProcessEnv = process.env): number {
  if (env.DINAR_AI_HEAVY_TURNS_PER_WINDOW === undefined) return 5;
  const value = Number(env.DINAR_AI_HEAVY_TURNS_PER_WINDOW);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 20) : 0;
}

// Explaining one thing («اشرح», «ليش», «ما الفرق», «انصحني») is LIGHT work; these name reasoning load.
const ANALYSIS = /(?:^|\s)(?:حلل|حللي|حللّي|تحليل|خطه|خطة|استراتيجيه|استراتيجية|دراسه\s+جدوى|دراسة\s+جدوى|بالتفصيل|خطوه\s+بخطوه|خطوة\s+بخطوة|نقطه\s+التعادل|نقطة\s+التعادل|قارن\s+(?:لي\s+)?بين|من\s+حيث)(?=\s|$)/u;
// A calculation: three or more figures together with a money/arithmetic term.
const CALCULATION_TERMS = /(?:^|\s)(?:احسب|احسبلي|حساب|ربح|ربحي|الربح|صافي|نسبه|نسبة|خصم|عموله|عمولة|ضريبه|ضريبة|تكلفه|تكلفة|التكلفه|التكلفة|هامش|مصاريف|يطلع)(?=\s|$)|%/u;
const WRITE_VERB = /(?:^|\s)(?:اكتب|اكتبلي|صيغ|صيغلي|صغ|صغلي|جهزلي|جهز)(?=\s|$)/u;
// Writing is HEAVY only when long-form or multi-variant; one listing's copy is LIGHT.
const LONG_FORM = /(?:^|\s)(?:حمله|حملة|مقال|سلسله|سلسلة|نسخ|اساليب|أساليب|عده|عدة|خمس|ثلاث|عشر|كامله|كاملة)(?=\s|$)/u;
// Quoted or pasted material is not the user's instruction: its length earns nothing.
const QUOTED = /«[^»]*»|“[^”]*”|"[^"]*"|```[\s\S]*?```/gu;

/** The user's own words: the message without quoted or pasted spans. */
export function instructionText(message: string): string {
  return message.replace(QUOTED, " ").replace(/\s+/gu, " ").trim();
}

/**
 * The deterministic, model-free tier choice for one message. `requestedEffort` is the user's own
 * depth preference from the composer, when given: «high» asks for HEAVY, «low» keeps LIGHT.
 */
export function selectModelTier(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { requestedEffort?: ReasoningEffort } = {},
): TierDecision {
  if (!modelTieringEnabled(env)) return { tier: "LIGHT", reason: "TIERING_OFF" };
  if (isDecisionUtterance(message)) return { tier: "LIGHT", reason: "DECISION_NEVER_ESCALATES" };
  if (options.requestedEffort === "high") return { tier: "HEAVY", reason: "USER_PREFERENCE" };
  if (options.requestedEffort === "low") return { tier: "LIGHT", reason: "USER_PREFERENCE" };
  const instruction = instructionText(message);
  if (instruction.length >= heavyMinChars(env)) return { tier: "HEAVY", reason: "LONG_REQUEST" };
  const text = normalizeSearch(instruction);
  if (ANALYSIS.test(text)) return { tier: "HEAVY", reason: "ANALYSIS" };
  if ((text.match(/\d+(?:[.,]\d+)?/gu) ?? []).length >= 3 && CALCULATION_TERMS.test(text)) return { tier: "HEAVY", reason: "CALCULATION" };
  if (WRITE_VERB.test(text) && LONG_FORM.test(text)) return { tier: "HEAVY", reason: "WRITING" };
  if ((instruction.match(/[?؟]/gu) ?? []).length >= 3) return { tier: "HEAVY", reason: "MULTI_QUESTION" };
  return { tier: "LIGHT", reason: "DEFAULT_LIGHT" };
}

/**
 * One bounded escalation, for a malformed structure only (a format failure LIGHT could not meet).
 * An out-of-allowlist action (UNKNOWN_ACTION) is not a capability gap but a refusal-worthy answer,
 * often an injection attempt: escalating it would hand the attacker a second, stronger try.
 * Outages belong to the fallback path, timeouts have spent the deadline, quota is a refusal.
 */
export function escalatesAfterLight(reason: ModelFailure): boolean {
  return reason === "MALFORMED";
}

export type TierRoute = {
  /** The tier actually used: HEAVY degrades to LIGHT when it cannot be served right now. */
  tier: ModelTier;
  gateway: ConversationModelGateway;
  reasoningEffort?: ReasoningEffort;
  heavyKind?: "SEPARATE_MODEL" | "SAME_MODEL_HIGH_EFFORT";
  degraded?: "HEAVY_UNAVAILABLE";
};

/** A per-call effort only where the model takes it (DeepSeek accepts and ignores one; test doubles have no provider). */
function effortFor(gateway: ConversationModelGateway, effort?: ReasoningEffort): ReasoningEffort | undefined {
  if (!effort) return undefined;
  return gateway.perCallReasoningEffort === true || gateway.providerInfo?.provider === "DEEPSEEK" || !gateway.providerInfo ? effort : undefined;
}

/**
 * The gateway and effort for a tier. HEAVY prefers the configured heavy model when it is available
 * (not disabled, breaker not open); otherwise the LIGHT model at "high" effort when that model
 * applies a per-call effort; otherwise the turn degrades to LIGHT rather than failing.
 */
export function gatewayForTier(light: ConversationModelGateway, tier: ModelTier, requestedEffort?: ReasoningEffort): TierRoute {
  const lightRoute = (degraded?: "HEAVY_UNAVAILABLE"): TierRoute => {
    const reasoningEffort = effortFor(light, requestedEffort);
    return { tier: "LIGHT", gateway: light, ...(reasoningEffort ? { reasoningEffort } : {}), ...(degraded ? { degraded } : {}) };
  };
  if (tier === "LIGHT") return lightRoute();
  if (light.heavy && gatewayLocallyAvailable(light.heavy)) {
    const reasoningEffort = effortFor(light.heavy, requestedEffort);
    return { tier: "HEAVY", gateway: light.heavy, ...(reasoningEffort ? { reasoningEffort } : {}), heavyKind: "SEPARATE_MODEL" };
  }
  if (light.perCallReasoningEffort === true && gatewayLocallyAvailable(light))
    return { tier: "HEAVY", gateway: light, reasoningEffort: "high", heavyKind: "SAME_MODEL_HIGH_EFFORT" };
  return lightRoute("HEAVY_UNAVAILABLE");
}
