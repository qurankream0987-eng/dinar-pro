import type { DisplayDirective } from "@workspace/api-zod/surface-composition";
import { normalizeSearch } from "./search-context";

/**
 * Phase 2/3: the explicit, low-risk part of a request to work with what is already on screen,
 * read deterministically (no model call). A format change, a sort or filter of the current
 * results, or a question about the current figures («أي شهر الأعلى؟»). It never names an item,
 * a price or a sale, so it can never be mistaken for one, and it is applied only when the
 * conversation's latest display is of the matching kind (display-interaction.ts). The model
 * handles every other phrasing; this is a floor, not the understanding.
 */
export type DisplayInteraction =
  | { kind: "FORMAT"; directive: DisplayDirective }
  | { kind: "SORT"; by: "PRICE"; direction: "ASC" | "DESC" }
  | { kind: "FILTER"; available: true }
  | { kind: "ANALYZE"; op: "MAX" | "MIN" | "MAX_VS_MIN" | "LAST_VS_PREVIOUS" };

const FORMAT_WORDS: Array<[RegExp, DisplayDirective["format"]]> = [
  [/(?:^|\s)(?:ب|ك|في|على\s+شكل\s+)?(?:جدول|الجدول|table)(?=\s|$)/u, "TABLE"],
  [/(?:^|\s)(?:ب|ك)?(?:بطاقات|البطاقات|كروت|الكروت|cards)(?=\s|$)/u, "CARDS"],
  [/(?:^|\s)(?:رسم|الرسم)\s+(?:خطي|الخطي)(?=\s|$)|(?:^|\s)(?:خط|خطي|منحني)(?=\s|$)/u, "LINE"],
  [/(?:^|\s)(?:ب|ك)?(?:اعمده|الاعمده|اعمدة|الاعمدة|bars?)(?=\s|$)/u, "BAR"],
  [/(?:^|\s)(?:رسم\s+)?(?:دائري|الدائري|دائره|دائرة|كعكه|كعكة)(?=\s|$)/u, "DONUT"],
  // «ورني الأرقام», «اعرض الأرقام مش الرسم»: the exact values as a table.
  [/(?:^|\s)(?:الارقام|ارقام)(?=\s|$)/u, "TABLE"],
];
// A word that points at what is already shown (pronoun, «النتائج», a verb of changing form).
const REFERENCE = /(?:ها|هم|هن)(?=\s|$)|(?:^|\s)(?:النتائج|نتائج|العروض|الرسم|الجدول|حول|حولها|حوليها|اعرضها|خليها|خلها|خل|سوها|سويها|رجع|رجعها|نفسها|بدل)(?=\s|$)/u;
const SALE_OR_PURCHASE = /(?:^|\s)(?:بيع|ابيع|للبيع|انشر|بسعر|اشتري|اطلب|ادفع|ضيف|اضف|حط|سله|السله|سلة|السلة)(?=\s|$)/u;

/** Kept for Phase 2 callers: the form-only part of an interaction. */
export function displayPreference(message: string): DisplayDirective | undefined {
  const interaction = displayInteraction(message);
  return interaction?.kind === "FORMAT" ? interaction.directive : undefined;
}

export function displayInteraction(message: string): DisplayInteraction | undefined {
  const text = normalizeSearch(message).replace(/[؟?!.،,]/gu, " ").replace(/\s+/gu, " ").trim();
  const words = text.split(" ").filter(Boolean);
  if (!words.length || words.length > 9) return undefined;
  // A number, a sale or a purchase verb means this is not only about what is on screen.
  if (/\d/u.test(text) || SALE_OR_PURCHASE.test(text)) return undefined;

  // Questions about the figures on screen.
  if (/(?:^|\s)(?:ب|و|مع\s+)?(?:ال)?(?:اعلي|اكثر|اكبر)(?=\s|$)/u.test(text) && /(?:^|\s)(?:ب|و|مع\s+)?(?:ال)?(?:اقل|اصغر|ادني)(?=\s|$)/u.test(text))
    return { kind: "ANALYZE", op: "MAX_VS_MIN" };
  if (/(?:^|\s)(?:شهر|الشهر|اي|انهي|انهو|وين)(?=\s|$)/u.test(text) || /^(?:مين|شو|ايش|وش)\s/u.test(text)) {
    if (/(?:^|\s)(?:اعلي|الاعلي|اكثر|الاكثر|اكبر|الاكبر|افضل|الافضل)(?=\s|$)/u.test(text)) return { kind: "ANALYZE", op: "MAX" };
    if (/(?:^|\s)(?:اقل|الاقل|اضعف|الاضعف|ادني|الادني|اسوا|الاسوا)(?=\s|$)/u.test(text)) return { kind: "ANALYZE", op: "MIN" };
  }
  if (/(?:^|\s)(?:قارن|مقارنه|مقارنة)(?=\s|$)/u.test(text) && /(?:^|\s)(?:الشهر|شهر)(?=\s|$)/u.test(text) && /(?:قبل|السابق|الماضي|اللي\s+قبله)/u.test(text))
    return { kind: "ANALYZE", op: "LAST_VS_PREVIOUS" };

  // Sorting and filtering the results on screen (price is the one verified sort key here).
  if (/(?:^|\s)(?:رتب|رتبها|رتبهم|رتبهن|رتبلي|نظم|نظمهم|خلهم|خليهم)(?=\s|$)/u.test(text) || /(?:^|\s)من\s+(?:ال)?(?:ارخص|رخيص|اغلي|غالي)(?=\s|$)/u.test(text)) {
    if (/(?:^|\s)(?:من\s+)?(?:ال)?(?:اغلي|غالي)(?=\s|$)/u.test(text)) return { kind: "SORT", by: "PRICE", direction: "DESC" };
    if (/(?:^|\s)(?:من\s+)?(?:ال)?(?:ارخص|رخيص|اقل)(?=\s|$)/u.test(text)) return { kind: "SORT", by: "PRICE", direction: "ASC" };
  }
  if (/(?:^|\s)(?:ال)?(?:متوفر|متوفره|متوفرة|المتاح|متاح)(?=\s|$)/u.test(text) && /(?:^|\s)(?:بس|فقط|خلني|ورني|وريني|اعرض|خل|خلي)(?=\s|$)/u.test(text))
    return { kind: "FILTER", available: true };

  const match = FORMAT_WORDS.find(([pattern]) => pattern.test(text));
  // «الأرقام» is itself a reference to the figures on screen; other format words need one.
  const numbersOnScreen = /(?:^|\s)(?:الارقام|ارقام)(?=\s|$)/u.test(text);
  if (!match || (!numbersOnScreen && !REFERENCE.test(text))) return undefined;
  return { kind: "FORMAT", directive: { version: 1, format: match[1], scope: "LATEST_RESULTS" } };
}
