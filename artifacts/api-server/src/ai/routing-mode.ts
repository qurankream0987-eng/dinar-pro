/**
 * How the conversation combines the model with DINAR's own intelligence (model-native mandate).
 *
 *   LEGACY       DINAR's deterministic runtime first; the model answers only what nothing claimed,
 *                and its suggestions map onto the existing reviews (the established behaviour).
 *   HYBRID       as LEGACY, plus: when DINAR's reading of a request comes back empty (a search with
 *                no results, a generic clarification), the model is asked once to restate the request
 *                in DINAR's own words, and that canonical request re-enters the same runtime.
 *   MODEL_FIRST  the model reads every ordinary turn first and its canonical request re-enters the
 *                runtime. Decision turns (a pending review, «نعم», «أرسل», «أوافق…») never reach the
 *                model. When the model is unavailable the turn runs exactly as in LEGACY.
 *   SHADOW       the user is served LEGACY; the model's reading is computed and logged only (never
 *                executed, never shown), to compare the two before switching.
 *
 * The model never executes anything in any mode: a canonical request is an utterance that runs
 * through the same handlers, reviews, confirmations, ownership and market checks a typed message
 * does, with the model disabled for that re-entry (depth one).
 */
import { findListingContactText } from "../lib/listing-contact";

export const AI_ROUTING_MODES = ["LEGACY", "HYBRID", "MODEL_FIRST", "SHADOW"] as const;
export type AiRoutingMode = (typeof AI_ROUTING_MODES)[number];

/** DINAR_AI_ROUTING_MODE; anything unknown or absent is LEGACY (fails to the established path). */
export function aiRoutingMode(env: NodeJS.ProcessEnv = process.env): AiRoutingMode {
  const value = env.DINAR_AI_ROUTING_MODE?.trim().toUpperCase();
  return (AI_ROUTING_MODES as readonly string[]).includes(value ?? "") ? (value as AiRoutingMode) : "LEGACY";
}

const fold = (value: string) =>
  value
    .replace(/[أإآ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/[ً-ْ]/gu, "")
    .replace(/[؟?!.،,]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * Words that decide something: a canonical request may never contain one, so the model can
 * neither confirm, send, pay, accept terms, approve nor publish on the user's behalf. Those
 * decisions stay the user's own words, answered by the deterministic decision handlers.
 */
const DECISION =
  /(?:^|\s)(?:نعم|ايوه|اكيد|اكد|تاكيد|موافق|اوافق|اقبل|قبلت|وافق|وافقت|نفذ|ارسل|ارسله|ارسلها|ابعث|ادفع|الدفع|اشتر|اشتري الان|اطلبه الان|انشر|انشره|انشرها|اعتمد|ثبت|confirm|yes|send|pay|accept|publish|approve)(?:\s|$)/u;

export type CanonicalProblem = "EMPTY" | "TOO_LONG" | "DECISION" | "CONTACT" | "SAME_AS_MESSAGE";

/** Why a canonical request may not re-enter the runtime, or undefined when it may. */
export function canonicalRequestProblem(canonical: string | undefined, original: string, marketId: string): CanonicalProblem | undefined {
  const text = canonical?.trim() ?? "";
  if (text.length < 2) return "EMPTY";
  if (text.length > 160) return "TOO_LONG";
  if (DECISION.test(fold(text))) return "DECISION";
  if (findListingContactText(text, marketId) || /\d{8,}/u.test(text.replace(/[\s-]/gu, ""))) return "CONTACT";
  // Restating the message unchanged adds nothing: the runtime already read it that way.
  if (fold(text) === fold(original)) return "SAME_AS_MESSAGE";
  return undefined;
}

/** A decision reply: it answers the open review deterministically and never goes to the model first. */
export function isDecisionUtterance(message: string): boolean {
  return DECISION.test(fold(message)) || /^(?:لا|كلا|الغاء|الغ|الغي|تراجع|لا اوافق|ارفض)(?:\s|$)/u.test(fold(message));
}

/** The instruction added to the model's system prompt outside LEGACY. */
export const CANONICAL_REQUEST_INSTRUCTION =
  "When the user asks DINAR to do something DINAR itself does — find or browse listings, refine or sort the shown results, open or compare shown results, ask about a shown listing's recorded facts, start a seller listing draft, or open a purchase, price-offer or seller-question review — also set canonicalRequest to ONE short Arabic request in DINAR's plain command words that says exactly that, resolving references from the conversation (for example «ابحث عن جوال مستعمل بأقل من 100 دينار», «قارن الأول بالثاني», «الثاني كم سعره؟», «اسأل البائع عن البطارية»). canonicalRequest is never a confirmation, a send, a payment, an approval, an acceptance of terms or a publication, and never contains a phone number, email or link; leave it out for general questions.";
