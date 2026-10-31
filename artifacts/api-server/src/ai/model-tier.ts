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
import type { ConversationModelGateway, ReasoningEffort } from "./model-gateway";
import type { ModelFailure } from "./model-turn";
import { isDecisionUtterance } from "./routing-mode";
import { normalizeSearch } from "./search-context";

export type ModelTier = "LIGHT" | "HEAVY";
export type TierReason =
  | "TIERING_OFF"
  | "DEFAULT_LIGHT"
  | "DECISION_NEVER_ESCALATES"
  | "LONG_REQUEST"
  | "ANALYSIS"
  | "MULTI_QUESTION"
  | "WRITING"
  | "LIGHT_OUTPUT_INVALID"
  | "HEAVY_CAP_REACHED";
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

const ANALYSIS = /(?:^|\s)(?:اشرح|اشرحلي|وضح|وضحلي|حلل|حللي|ليش|لماذا|ليه|خطه|خطة|استراتيجيه|استراتيجية|دراسه|دراسة|ما\s+الفرق|ايش\s+الفرق|شو\s+الفرق|وش\s+الفرق|ايهما\s+افضل|كيف\s+ابدا|كيف\s+أبدأ|نصيحه|نصيحة|انصحني)(?=\s|$)/u;
const WRITING = /(?:^|\s)(?:اكتب|اكتبلي|صيغ|صيغلي|صغ|صغلي|ألف|الف|اعد\s+صياغه|اعد\s+صياغة|وصف\s+تسويقي|اعلان\s+تسويقي|منشور)(?=\s|$)/u;

/** The deterministic, model-free tier choice for one message. */
export function selectModelTier(message: string, env: NodeJS.ProcessEnv = process.env): TierDecision {
  if (!modelTieringEnabled(env)) return { tier: "LIGHT", reason: "TIERING_OFF" };
  if (isDecisionUtterance(message)) return { tier: "LIGHT", reason: "DECISION_NEVER_ESCALATES" };
  if (message.trim().length >= heavyMinChars(env)) return { tier: "HEAVY", reason: "LONG_REQUEST" };
  const text = normalizeSearch(message);
  if (ANALYSIS.test(text)) return { tier: "HEAVY", reason: "ANALYSIS" };
  if (WRITING.test(text)) return { tier: "HEAVY", reason: "WRITING" };
  if ((message.match(/[?؟]/gu) ?? []).length >= 3) return { tier: "HEAVY", reason: "MULTI_QUESTION" };
  return { tier: "LIGHT", reason: "DEFAULT_LIGHT" };
}

/** One bounded escalation: only a structured-output failure of LIGHT earns a HEAVY retry. */
export function escalatesAfterLight(reason: ModelFailure): boolean {
  return reason === "MALFORMED" || reason === "UNKNOWN_ACTION";
}

/**
 * The gateway and effort for a tier. HEAVY prefers the configured heavy model; otherwise it is
 * the LIGHT model at "high" effort (marked so observability does not claim a second model).
 */
export function gatewayForTier(
  light: ConversationModelGateway,
  tier: ModelTier,
  requestedEffort?: ReasoningEffort,
): { gateway: ConversationModelGateway; reasoningEffort?: ReasoningEffort; heavyKind?: "SEPARATE_MODEL" | "SAME_MODEL_HIGH_EFFORT" } {
  if (tier === "LIGHT") return { gateway: light, ...(requestedEffort ? { reasoningEffort: requestedEffort } : {}) };
  if (light.heavy) return { gateway: light.heavy, ...(requestedEffort ? { reasoningEffort: requestedEffort } : {}), heavyKind: "SEPARATE_MODEL" };
  return { gateway: light, reasoningEffort: "high", heavyKind: "SAME_MODEL_HIGH_EFFORT" };
}
