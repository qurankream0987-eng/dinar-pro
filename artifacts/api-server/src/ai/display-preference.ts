import type { DisplayDirective } from "@workspace/api-zod/surface-composition";
import { normalizeSearch } from "./search-context";

/**
 * Phase 2: the explicit, low-risk part of a display request, read deterministically so that a
 * request to change only the *form* of the latest results is never mistaken for a sale («اعرضها»)
 * or a purchase. Comparisons stay with the existing compare handlers. It needs a format word and a reference to what is already on
 * screen, and refuses anything that names a price or a sale. The model handles every other
 * phrasing; this is a floor, not the understanding.
 */
const FORMAT_WORDS: Array<[RegExp, DisplayDirective["format"]]> = [
  [/(?:^|\s)(?:ب|ك|في|على\s+شكل\s+)?(?:جدول|الجدول|table)(?=\s|$)/u, "TABLE"],
  [/(?:^|\s)(?:ب|ك)?(?:بطاقات|البطاقات|كروت|الكروت|cards)(?=\s|$)/u, "CARDS"],
];
const REFERENCE = /(?:ها|هم)(?=\s|$)|(?:^|\s)(?:النتائج|نتائج|العروض|حول|حولها|حوليها|اعرضها|خليها|سوها|سويها|رجع|رجعها|نفسها)(?=\s|$)/u;

export function displayPreference(message: string): DisplayDirective | undefined {
  const text = normalizeSearch(message).replace(/[؟?!.،,]/gu, " ").replace(/\s+/gu, " ").trim();
  const words: string[] = text.split(" ").filter(Boolean);
  if (!words.length || words.length > 9) return undefined;
  // A price, a quantity or a sale/purchase verb means this is not only about form.
  if (/\d/u.test(text) || /(?:^|\s)(?:بيع|ابيع|للبيع|انشر|سعر|بسعر|اشتري|اطلب|ادفع|سله|السله|سلة|السلة)(?=\s|$)/u.test(text)) return undefined;
  const match = FORMAT_WORDS.find(([pattern]) => pattern.test(text));
  if (!match || !REFERENCE.test(text)) return undefined;
  const format = match[1];
  return { version: 1, format, scope: "LATEST_RESULTS" };
}
