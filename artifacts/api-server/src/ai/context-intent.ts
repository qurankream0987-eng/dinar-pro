/**
 * The linguistic form of contextual messages (R3E): a status question, a correction, a price
 * edit or a quotation request. Each function reads only the words — the conversation decides
 * what they refer to (negotiation-turn.ts, listing-draft.ts, seller-management.ts) — and none
 * invents an amount, a target or a party the user did not state.
 */
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";

const NUMBER = "(\\d+(?:\\.\\d+)?)";

/** Folded, digit-normalised, punctuation as word breaks; a decimal point survives. */
export function contextText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/[ً-ْـ]/gu, "")
    .replace(/ة/gu, "ه")
    .replace(/(\d)[.٫](\d)/gu, "$1\u0000$2")
    .replace(/[؟?!،,؛;:.()«»"']+/gu, " ")
    .replaceAll("\u0000", ".")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/^(?:يا\s+)?دينار\s+/u, "");
}

// ─── Status questions ────────────────────────────────────────────────────────

const OFFER_NOUN = /(?:^|\s)(?:عرضي|عروضي|العرض|عرض(?:\s+(?:الشراء|السعر))?|السعر الجديد|سعري|التفاوض|المفاوضه)(?=\s|$)/u;
const ORDER_NOUN = /(?:^|\s)(?:طلبي|طلبيتي|اوردري|الطلب|طلبياتي)(?=\s|$)/u;
/** A state, a change of state, or a request for news: what a status question asks about. */
const STATUS_PREDICATE = /(?:^|\s)(?:وصل|وصلت|صار|صارت|وافق|وافقت|رفض|رفضت|رد|ردت|معلق|معلقه|انرسل|ارسل|ارسال|انقبل|قبل|مقبول|مرفوض|شاف|حاله|وضع|اخبار|مصير|وين|فين|اين|لسه|لسا|بعده|لساته|تم|اتقبل)(?=\s|$)/u;
const INTERROGATIVE = /(?:^|\s)(?:هل|شو|وش|ايش|شنو|ماذا|ما|وين|فين|اين|كيف|لسه|لسا)(?=\s|$)/u;
const BUYER_SUBJECT = /(?:^|\s)(?:البائع|البايع|التاجر|عرضي)(?=\s|$)/u;
const SELLER_SUBJECT = /(?:^|\s)(?:المشتري|الزبون)(?=\s|$)/u;

/**
 * «هل وصل عرضي؟», «البائع وافق؟», «شو صار على طلبي؟»: a question about the state of the
 * user's offer or order. Asking about the seller makes the user the buyer, and the reverse.
 * Anything carrying an amount is a proposal, not a question.
 */
export function statusQuestion(message: string): { subject: "OFFER" | "ORDER"; party?: "BUYER" | "SELLER" } | undefined {
  const text = contextText(message);
  if (/\d/u.test(text) || !STATUS_PREDICATE.test(text)) return undefined;
  const asked = /[؟?]\s*$/u.test(message.trim()) || INTERROGATIVE.test(text);
  if (!asked) return undefined;
  if (ORDER_NOUN.test(text) && !OFFER_NOUN.test(text)) return { subject: "ORDER" };
  const party = BUYER_SUBJECT.test(text) ? "BUYER" : SELLER_SUBJECT.test(text) ? "SELLER" : undefined;
  if (!OFFER_NOUN.test(text) && !party) return undefined;
  return { subject: "OFFER", ...(party ? { party } : {}) };
}

// ─── Corrections ─────────────────────────────────────────────────────────────

const MEAN = "(?:اقصد|قصدي|بقصد|بقصدي|يعني|المقصود|كنت\\s+اقصد)";
/**
 * «أقصد عرض الشراء», «لا، أقصد التفاوض», «مو الإعلان، العرض», «لا، العرض 15 مو 20»,
 * «خلّينا نرجع للعرض السابق»: the clause the user meant (and the one they rejected, or a
 * return to something earlier). A bare «لا» is a refusal, not a correction.
 */
export function correction(message: string): { meant?: string; rejected?: string; back?: boolean } | undefined {
  const raw = message.trim();
  const text = contextText(raw);
  const back = text.match(/^(?:لا\s+)?(?:خلينا|خلنا|خلي\s+نا|بدي|ابي|اريد)\s+(?:نرجع|نعود|ارجع|اعود|رجعنا)\s+(?:(?:الي|على|علي)\s+)?(.+)$/u);
  // «للعرض» is ل + العرض; «لعرضي» is ل + عرضي.
  if (back) return { meant: back[1]!.replace(/^لل/u, "ال").replace(/^ل(?!ل)(?=\S{3,})/u, ""), back: true };
  const meant = text.match(new RegExp(`^(?:لا\\s+)?${MEAN}\\s+(.+)$`, "u"));
  if (meant) return { meant: meant[1]! };
  // «مو X، Y»: the comma in the original separates what was rejected from what was meant.
  const rejected = raw.match(/^\s*(?:لا\s*[،,]?\s*)?(?:مو|مش|مب|ليس|مهو)\s+([^،,]+)[،,]\s*(?:بل\s+|بس\s+|انما\s+|إنما\s+)?(?:أقصد\s+|اقصد\s+)?(.+)$/u);
  if (rejected) return { meant: contextText(rejected[2]!), rejected: contextText(rejected[1]!) };
  // «لا، …»: a correction only when what follows names a commercial object («لا، العرض 15 مو 20»)
  // or a price change («لا، غيّر السعر فقط»); «لا، الأفضل حتى لو أغلى» refines a search instead.
  const no = raw.match(/^\s*لا\s*[،,]\s*(.+)$/u);
  if (no) {
    const rest = contextText(no[1]!);
    if (namesCommercialObject(rest) || namesPrice(rest)) return { meant: rest };
  }
  return undefined;
}

// A price mentioned as a criterion («الأفضل مقابل السعر») is not an object; a price change is
// recognised by its own form (priceEdit, namesPrice).
const COMMERCIAL_OBJECT = /(?:^|\s)(?:العرض|عرض|عرضي|عروضي|التفاوض|المفاوضه|الاعلان|اعلان|اعلاني|المنتج|القطعه|الطلب|طلبي|السابق|الاول|الاولي|الثاني|الثانيه|الثالث|الثالثه|الرابع|الرابعه|الخامس|الخامسه|الاخير|الاخيره|رقم)(?=\s|$)/u;
/** Whether a clause names an offer, listing, order, list position or «the previous one». */
export function namesCommercialObject(text: string): boolean {
  return COMMERCIAL_OBJECT.test(contextText(text));
}

// ─── Price edits ─────────────────────────────────────────────────────────────

const EDIT_VERB = "(?:عدل|عدلي|غير|غيري|نزل|انزل|انزلها|انزله|نزلها|نزله|ارفع|ارفعها|ارفعه|زود|زيد|خفض|قلل|خلي|خليه|خليها|خله|خلها|اجعل|اجعله|اجعلها|صير|صيره|صيرها|حط|حطه|حطها)";
const PRICE_NOUN = "(?:السعر|سعر|سعرها|سعره|المبلغ|العرض|البدايه|بدايته|بدايتها)";

/**
 * «عدّل السعر», «خليه 15», «بدي أنزلها من 20 إلى 15», «العرض 15 مو 20», «خلّي البداية من 30»:
 * a change of a price, with the new amount only when the user wrote it. «ارفع السعر شوي» has a
 * direction and no amount: nothing is guessed. «البداية من N» keeps STARTING_FROM's meaning.
 */
export function priceEdit(message: string): { amount?: number; from?: number; startingFrom?: boolean } | undefined {
  const text = contextText(message).replace(/(?:^|\s)بـ?\s*(?=\d)/gu, " ب").replace(/\s+/gu, " ").trim();
  const lead = `^(?:(?:بدي|ابي|ابغي|اريد|حاب|ممكن|طيب|لا)\\s+)*(?:ان\\s+)?`;
  // «X من A الي B»
  const fromTo = text.match(new RegExp(`${lead}${EDIT_VERB}(?:\\s+${PRICE_NOUN})?\\s+من\\s+${NUMBER}\\s+(?:الي|الى|ل|لـ)\\s*${NUMBER}$`, "u"));
  if (fromTo) return { amount: Number(fromTo[2]), from: Number(fromTo[1]) };
  // «البدايه من N» / «خلي البدايه من N» / «يبدا من N»
  const starting = text.match(new RegExp(`${lead}(?:${EDIT_VERB}\\s+)?(?:البدايه|بدايته|بدايتها|السعر\\s+يبدا|يبدا)\\s+(?:من\\s+)?(?:ب\\s*)?${NUMBER}$`, "u"));
  if (starting) return { amount: Number(starting[1]), startingFrom: true };
  // «العرض 15 مو 20» / «السعر 15 مش 20»
  const notThat = text.match(new RegExp(`^(?:لا\\s+)?${PRICE_NOUN}\\s+(?:ب\\s*)?${NUMBER}\\s+(?:مو|مش|مب|ليس|بدل|بدال)\\s+${NUMBER}$`, "u"));
  if (notThat) return { amount: Number(notThat[1]), from: Number(notThat[2]) };
  // «غير السعر الي 12.5» / «خليه 15» / «خلي سعرها 15» / «عدل السعر» / «ارفع السعر شوي»
  const edit = text.match(new RegExp(`${lead}${EDIT_VERB}(?:\\s+${PRICE_NOUN})?(?:\\s+(?:الي|الى|ل|ب|يكون|يصير))?(?:\\s*(?:ب\\s*)?${NUMBER})?(?:\\s+(?:شوي|شويه|قليل|شي|حبه|بسيط|فقط|بس))*$`, "u"));
  if (!edit) return undefined;
  const named = new RegExp(`${EDIT_VERB}\\s+${PRICE_NOUN}`, "u").test(text);
  // A bare verb with no price word and no amount («غيّر», «خليه») is not a price edit.
  if (!named && edit[1] === undefined) return undefined;
  // «خليه 15» needs a pronoun or a price word: «خلي 15» alone stays a number.
  return edit[1] !== undefined ? { amount: Number(edit[1]) } : {};
}

/**
 * Whether the message says it is the price that changes: a price word with the verb, «من A إلى
 * B», «البداية من N» or «X مو Y». A bare «خليه 3» is not: under a purchase review it is a quantity.
 */
export function namesPrice(message: string): boolean {
  const edit = priceEdit(message);
  if (!edit) return false;
  if (edit.from !== undefined || edit.startingFrom) return true;
  return new RegExp(`${EDIT_VERB}\\s+${PRICE_NOUN}`, "u").test(contextText(message));
}

// ─── Quotation requests ──────────────────────────────────────────────────────

/** «اطلب منهم تسعيرة», «بدي تسعيرة منهم»: a request for a quote, with any addressee. */
export function quoteRequest(message: string): boolean {
  const text = contextText(message);
  if (/[؟?]\s*$/u.test(message.trim()) && !/(?:^|\s)اطلب(?:\s|$)/u.test(text)) return false;
  return /^(?:(?:بدي|ابي|ابغي|اريد|ممكن)\s+)?(?:اطلب\s+(?:لي\s+)?)?(?:(?:منهم|منه|منها|من\s+(?:البائع|البايع|التاجر))\s+)?تسعيره(?:\s+(?:منهم|منه|منها|من\s+(?:البائع|البايع|التاجر)))?$/u.test(text) &&
    /(?:اطلب|بدي|ابي|ابغي|اريد|ممكن)/u.test(text);
}
