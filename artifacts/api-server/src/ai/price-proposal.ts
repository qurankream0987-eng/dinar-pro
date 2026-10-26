/**
 * A price proposal: an offer verb whose whole object is an amount — «أعرض 15 بدل 20», «بعرض 15»,
 * «عرضي 12», «أقدّم 15 دينار بدلًا من 20». A sale names an item («أعرض 3 كراسي بـ20»), so it never
 * matches. The words do not say whose price it is: a buyer's offer, a seller's counter or a
 * draft's asking price is decided by the actor's role and context (negotiation-turn.ts,
 * listing-draft.ts), never here.
 */
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";

const NUMBER = "(\\d+(?:\\.\\d+)?)";
const CURRENCY_WORD = "(?:دينار|دنانير|ريال|درهم|جنيه|دولار|ليره|jod|kwd|usd)";
const PRICE_PROPOSAL = new RegExp(
  `^(?:(?:طيب|اوكي|تمام|لا|انا)\\s+)*(?:(?:بدي|ابي|ابغي|اريد|حاب|رح|راح)\\s+(?:ان\\s+)?)?(?:اعرض|بعرض|نعرض|اقدم|بقدم|اقترح|بقترح|عرضي|سعري)(?:\\s+(?:عليه|عليها|له|لها|عليك|للبائع|للبايع|للمشتري))?\\s*(?:ب\\s*)?${NUMBER}(?:\\s*${CURRENCY_WORD})?(?:\\s+(?:بدل|بدال|بدلا|عوض|عوضا|مكان|مقابل)(?:\\s+(?:من|عن))?\\s+(?:ال\\s*)?${NUMBER}(?:\\s*${CURRENCY_WORD})?)?$`,
  "u",
);

function normalizeProposal(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/[ً-ْـ]/gu, "")
    .replace(/ة/gu, "ه")
    // A decimal point survives; other punctuation is a word break.
    .replace(/(\d)[.٫](\d)/gu, "$1\u0000$2")
    .replace(/[؟?!،,؛;:.()«»"']+/gu, " ")
    .replaceAll("\u0000", ".")
    .replace(/(?:^|\s)بـ?\s*(?=\d)/gu, " ب")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    // «دينار، أعرض …» addresses the assistant; the proposal is what follows.
    .replace(/^(?:يا\s+)?دينار\s+/u, "");
}

/** The amount a price proposal names, and the amount it replaces when it says so. */
export function priceProposal(message: string): { amount: number; replaces?: number } | undefined {
  const match = normalizeProposal(message).match(PRICE_PROPOSAL);
  const amount = Number(match?.[1]);
  if (!match || !Number.isFinite(amount) || amount <= 0) return undefined;
  const replaces = Number(match[2]);
  return { amount, ...(match[2] !== undefined && Number.isFinite(replaces) && replaces > 0 ? { replaces } : {}) };
}

/** «اعرض 2»: a bare number after «اعرض» may instead name a position in the visible results. */
export function isBareShowNumber(message: string): boolean {
  return /^(?:اعرض|اعرضلي)\s+\d+$/u.test(normalizeProposal(message));
}
