// Frozen copy from 776afc8 (before the hostile-input fix), used only by hostile-input-performance HIP-04.
import { searchTerms } from "../../../src/ai/intent";
import {
  foldAgreement,
  foldArabicLetters,
  parseResultReference,
} from "./arabic-normalization";

/** Applied to both queries and listing text, so agreement forms ("سوداء") meet stored values ("أسود"). */
export function normalizeSearch(value: string): string {
  return foldAgreement(
    foldArabicLetters(value)
      .replace(/تي[\s-]*شي?رت/g, "تيشيرت")
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

/** Match category aliases as complete words, allowing common attached Arabic articles and prepositions. */
export function hasCategoryAlias(message: string, alias: string, options: { possessive?: boolean } = {}): boolean {
  const words = normalizeSearch(message).split(/\s+/).filter(Boolean);
  const aliasWords = normalizeSearch(alias).split(/\s+/).filter(Boolean);
  if (!aliasWords.length || aliasWords.length > words.length) return false;

  return words.some((_, start) =>
    aliasWords.every(
      (word, offset) =>
        words[start + offset] !== undefined &&
        (options.possessive
          ? categoryTokenForms(words[start + offset]!)
          : [normalizeCategoryToken(words[start + offset]!)]
        ).includes(normalizeCategoryToken(word)),
    ),
  );
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
