/**
 * AI-02 — MODEL_FIRST Multi-Dialect Router Guard.
 * Keeps deterministic decision/confirmation utterances completely isolated from the LLM,
 * while guiding MODEL_FIRST mode across Gulf, Levantine, Egyptian, and Maghrebi Arabic.
 */
import { aiRoutingMode, isDecisionUtterance, type AiRoutingMode } from "./routing-mode";

export type ModelFirstDecision =
  | { route: "BYPASS_DECISION_GUARD"; mode: AiRoutingMode; reason: "PENDING_DECISION" | "DECISION_UTTERANCE" }
  | { route: "MODEL_FIRST"; mode: AiRoutingMode; timeoutMs: number }
  | { route: "FALLBACK_LEGACY"; mode: AiRoutingMode; reason: "MODE_NOT_MODEL_FIRST" | "MODEL_UNAVAILABLE" };

export const DIALECT_NORMALIZATION_HINTS: ReadonlyArray<[string, string]> = [
  ["أبي / أبغى / بدي / عايز / بغيت", "أريد"],
  ["جوال / موبايل / تليفون / نقال", "هاتف"],
  ["جزمة / كندرة / صباط / شوز", "حذاء"],
  ["كم سعره / بكم / قديش / شحال / بكام", "كم سعره"],
  ["رخيص / على قد الميزانية / مو غالي", "بسعر اقتصادي"],
  ["توصيل / دليفري / شحن للبيت", "توصيل للمنزل"],
];

export function modelFirstTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DINAR_MODEL_FIRST_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 500 || parsed > 15_000) return 2500;
  return Math.trunc(parsed);
}

export function decideModelFirstEntry(input: {
  message: string;
  hasPendingDecision: boolean;
  modelAvailable: boolean;
  env?: NodeJS.ProcessEnv;
}): ModelFirstDecision {
  const mode = aiRoutingMode(input.env);
  if (input.hasPendingDecision) {
    return { route: "BYPASS_DECISION_GUARD", mode, reason: "PENDING_DECISION" };
  }
  if (isDecisionUtterance(input.message)) {
    return { route: "BYPASS_DECISION_GUARD", mode, reason: "DECISION_UTTERANCE" };
  }
  if (mode !== "MODEL_FIRST") {
    return { route: "FALLBACK_LEGACY", mode, reason: "MODE_NOT_MODEL_FIRST" };
  }
  if (!input.modelAvailable) {
    return { route: "FALLBACK_LEGACY", mode, reason: "MODEL_UNAVAILABLE" };
  }
  return { route: "MODEL_FIRST", mode, timeoutMs: modelFirstTimeoutMs(input.env) };
}

export function buildModelFirstDialectPrompt(market?: { countryNameAr?: string; currencyCode?: string }): string {
  const hints = DIALECT_NORMALIZATION_HINTS.map(([dialect, standard]) => `- (${dialect}) ← «${standard}»`).join("\n");
  const marketLine = market?.countryNameAr
    ? `السوق النشط: ${market.countryNameAr} (${market.currencyCode ?? "—"}).`
    : "احترم السوق والعملة المختارة من الخادم فقط.";
  return [
    "افهم جميع اللهجات العربية (الخليجية، الشامية، المصرية، المغاربية) وحوّل النية إلى أوامر جاسم القياسية بوضوح دون افتراض تفاصيل لم يذكرها المستخدم.",
    marketLine,
    "مرجع تطبيع اللهجات:",
    hints,
  ].join("\n");
}
