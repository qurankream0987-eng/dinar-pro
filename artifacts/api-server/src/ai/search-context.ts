import { searchTerms } from "./intent";
import {
  normalizeDigits,
  foldAgreement,
  foldArabicLetters,
  parseResultReference,
} from "./arabic-normalization";

/** Applied to both queries and listing text, so agreement forms ("سوداء") meet stored values ("أسود"). */
export function normalizeSearch(value: string): string {
  return foldAgreement(
    foldArabicLetters(normalizeDigits(value))
      .replace(/تي[\s-]*شي?رت/g, "تيشيرت")
      // Letter-by-letter spellings of one product word: «اتش دي ام اي» → hdmi, «بلاي ستيشن».
      .replace(/(^|\s)اتش\s*دي\s*ام\s*اي(?=\s|$)/gu, "$1hdmi")
      .replace(/بلاي\s+ستيشن/gu, "بلايستيشن")
      .replace(/(^|\s)(?:اس|إس|ايه|بي|سي|دي)\s*(?=\d)/gu, (word, lead: string) => `${lead}${({اس:"s",إس:"s",ايه:"a",بي:"b",سي:"c",دي:"d"} as Record<string,string>)[word.trim()] ?? word.trim()}`)
      .replace(/(^|\s)ال(?=اسود|ابيض|احمر|ازرق|اخضر)/g, "$1")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function normalizeCategoryToken(value: string): string {
  return normalizeSearch(value)
    .replace(/^(?:و|ف)?(?:ب|ك|ل)?ال/u, "")
    .replace(/^لل/u, "");
}

/** «هاتفي», «سيارتي»: in a sale the possessive ending names the seller's own item. */
function categoryTokenForms(value: string): string[] {
  const token = normalizeCategoryToken(value);
  const forms = [token];
  // «المنزلي» (household) is an adjective: a word with the article never takes a possessive.
  if (/^(?:و|ف)?(?:ب|ك|ل)?ال|^لل/u.test(normalizeSearch(value))) return forms;
  for (const suffix of ["كم", "هم", "ها", "نا", "ي", "ك"]) {
    if (!token.endsWith(suffix) || token.length - suffix.length < 3) continue;
    const stem = token.slice(0, -suffix.length);
    forms.push(stem);
    if (stem.endsWith("ت")) forms.push(`${stem.slice(0, -1)}ة`, `${stem.slice(0, -1)}ه`);
  }
  return forms;
}

/**
 * Bounded memo for the pure normalizers below. hasCategoryAlias runs once per category alias on
 * the same message; without this it re-normalized the whole message per alias and every word per
 * alias word, so a hostile 2,000-character message cost ≈0.8 s of CPU (hostile-input-performance).
 * Entries are keyed by the exact input and the cache is simply cleared when full.
 */
function boundedMemo<T>(fn: (value: string) => T, limit: number, maxKeyLength = Infinity): (value: string) => T {
  const cache = new Map<string, T>();
  return (value) => {
    if (value.length > maxKeyLength) return fn(value);
    const hit = cache.get(value);
    if (hit !== undefined) return hit;
    const result = fn(value);
    if (cache.size >= limit) cache.clear();
    cache.set(value, result);
    return result;
  };
}
const messageWords = boundedMemo((message) => Object.freeze(normalizeSearch(message).split(/\s+/).filter(Boolean)), 32, 4_000);
const aliasTokens = boundedMemo((alias) => Object.freeze(normalizeSearch(alias).split(/\s+/).filter(Boolean).map(normalizeCategoryToken)), 2_048, 200);
const plainTokenForms = boundedMemo((word) => Object.freeze([normalizeCategoryToken(word)]), 8_192, 200);
const possessiveTokenForms = boundedMemo((word) => Object.freeze(categoryTokenForms(word)), 8_192, 200);

/** Match category aliases as complete words, allowing common attached Arabic articles and prepositions. */
export function hasCategoryAlias(message: string, alias: string, options: { possessive?: boolean } = {}): boolean {
  const words = messageWords(message);
  const wanted = aliasTokens(alias);
  if (!wanted.length || wanted.length > words.length) return false;
  const formsOf = options.possessive ? possessiveTokenForms : plainTokenForms;
  for (let start = 0; start + wanted.length <= words.length; start++) {
    let matched = true;
    for (let offset = 0; offset < wanted.length; offset++) {
      if (!formsOf(words[start + offset]!).includes(wanted[offset]!)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** Conservative fallback: preserve prior product/size constraints, replace only an explicit color. */
export function contextualQuery(message: string, previous = ""): string {
  const text = normalizeSearch(searchTerms(message));
  const colorText = text.replace(/^(?:ال)?لون\s+/, "").trim();
  if (
    /^(الارخص|ارخص|غالية\.?|غالي\.?|بدينار(?: فقط)?|فقط)$/.test(
      normalizeSearch(message),
    ) &&
    previous
  )
    return previous;
  const colors = /(?:اسود|ابيض|احمر|ازرق|اخضر)/g;
  const color = colorText.match(colors);
  if (previous && color && colorText.split(" ").length === 1) {
    return `${normalizeSearch(previous).replace(colors, " ")} ${color[0]}`
      .replace(/\s+/g, " ")
      .trim();
  }
  if (previous && /^(xs|s|m|l|xl|xxl|xxxl)$/i.test(text)) {
    return `${previous.replace(/\b(?:xs|s|m|l|xl|xxl|xxxl)\b/gi, " ")} ${text}`
      .replace(/\s+/g, " ")
      .trim();
  }
  return text;
}

/** Index of a whole-utterance result reference; numbers inside ordinary requests never count. */
export function resultPosition(message: string): number | undefined {
  const reference = parseResultReference(message);
  return reference?.kind === "INDEX" ? reference.index : undefined;
}

/** Light Arabic/English stem for alias comparison: articles, plural and feminine endings. */
export function aliasStem(word: string): string {
  const base = normalizeSearch(word)
    .replace(/^(?:و|ف)?(?:ب|ك|ل)?ال(?=\S{3,})/u, "")
    .replace(/^لل(?=\S{3,})/u, "");
  return base
    .replace(/(?:ات|ين|ون)$/u, "")
    .replace(/[ةه]$/u, "")
    .replace(/(?<=[a-z]{4})s$/u, "");
}

/**
 * An alias that is only the category's own name ("سيارة" for سيارات) identifies the category.
 * Other aliases ("سماعة", "كنب") also name a product, so they remain search words.
 */
export function isCategoryNameAlias(
  category: { id: string; label: string; labelEn?: string },
  alias: string,
): boolean {
  const names = [category.id, category.label, category.labelEn]
    .filter((name): name is string => Boolean(name))
    .map(aliasStem);
  const words = normalizeSearch(alias).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((word) => names.includes(aliasStem(word)));
}
