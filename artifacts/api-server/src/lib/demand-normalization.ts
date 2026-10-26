/**
 * Generic need normalisation shared by demand signals, Market Pulse and demand-capture
 * matching. It reuses DINAR's Arabic search normalisation and a small cross-category
 * synonym table (spelling and script variants), never category-specific branches.
 */
import { normalizeSearch } from "../ai/search-context";
import { foldArabicLetters, normalizeDigits } from "../ai/arabic-normalization";

const SYNONYMS: Record<string, string> = {
  ايفون: "ايفون",
  iphone: "ايفون",
  تلفون: "جوال",
  تليفون: "جوال",
  هاتف: "جوال",
  موبايل: "جوال",
  جوالات: "جوال",
  هواتف: "جوال",
  camry: "كامري",
  toyota: "تويوتا",
  سياره: "سيارات",
  سيارة: "سيارات",
  laptop: "لابتوب",
  لاب: "لابتوب",
  كمبيوتر: "لابتوب",
};

/** Request words that carry no product meaning ("أريد", "أبحث عن", "تحت", currency...). */
const STOP = new Set([
  "اريد", "ابي", "ابغي", "ابغا", "بدي", "ودي", "ابحث", "عن", "دور", "لي", "علي", "على", "في", "من", "الى", "الي",
  "تحت", "اقل", "اكثر", "حدود", "بحدود", "حوالي", "ب", "و", "او", "ال", "عندكم", "عندك", "شي", "شيء", "حاجه",
  "دينار", "دنانير", "jod", "kwd", "ريال", "درهم", "مستعمل", "مستعمله", "جديد", "جديده", "نظيف", "نظيفه", "رخيص",
  "مطلوب", "المطلوب", "منتج", "منتجات", "اشتري", "اشتر", "بيع", "ابيع", "خلي", "خل", "هذا", "هذه", "هذي",
]);

export function needTokens(text: string): string[] {
  const normalized = normalizeSearch(foldArabicLetters(normalizeDigits(text)).toLowerCase())
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = normalized
    .split(" ")
    .map((word) => word.replace(/^ال(?=\S{3,})/u, ""))
    .map((word) => SYNONYMS[word] ?? word)
    // Model numbers («17», «256») stay; single characters and request words do not.
    .filter((word) => word.length >= 2 && !STOP.has(word));
  return [...new Set(tokens)].slice(0, 8);
}

/** A stable cluster key: category plus the sorted significant non-numeric need words. */
export function needKey(tokens: string[], categoryId?: string | null): string {
  const words = tokens.filter((token) => !/^\d+$/.test(token)).sort();
  return `${categoryId ?? "any"}:${words.join(" ") || tokens.slice().sort().join(" ")}`;
}

/** Share of the need's words that a listing's own text contains (0..1). */
export function needCoverage(tokens: string[], listingText: string): number {
  if (!tokens.length) return 0;
  const haystack = new Set(needTokens(listingText));
  const words = tokens.filter((token) => !/^\d+$/.test(token));
  const counted = words.length ? words : tokens;
  return counted.filter((token) => haystack.has(token)).length / counted.length;
}
