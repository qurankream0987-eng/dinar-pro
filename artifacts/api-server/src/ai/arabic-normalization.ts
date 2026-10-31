/**
 * Deterministic marketplace Arabic: digits, number words, ordinals, comparison,
 * negation, and context-typed numeric mentions. No model is involved here.
 */

const DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

export function normalizeDigits(value: string): string {
  return value
    .replace(/[٠-٩۰-۹]/g, (digit) => DIGITS[digit] ?? digit)
    .replace(/[٬،]/g, ",");
}

/**
 * Dialect words with one meaning everywhere, folded to the form DINAR's rules already read
 * (W04). Whole words only, with an attached و/ب/ف; applied to queries and listing text alike,
 * so matching stays symmetric. Ambiguous words stay as typed: «تاني» is also «again» and
 * «دي»/«هاي» have other meanings, so only the definite ordinals and unambiguous forms fold.
 */
const DIALECT_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  // Egyptian and Levantine ordinals (ث → ت).
  [/^التاني$/u, "الثاني"], [/^التاني[ةه]$/u, "الثانيه"],
  [/^التالت$/u, "الثالث"], [/^التالت[ةه]$/u, "الثالثه"],
  // Wanting across dialects → «ابي», which every request rule reads.
  [/^(?:بغيت|نبغي|بغينا|عايز|عاوز|عايز[ةه]|عاوز[ةه]|اشتي|نشتي|داير|داير[ةه]|دايرين|ابغا|ابغي)$/u, "ابي"],
  // English condition word typed inside Arabic («جوال used»).
  [/^used$/u, "مستعمل"],
  // Demonstratives → «هذا».
  [/^(?:هادا|هاذا|هاد|ده)$/u, "هذا"],
];

/**
 * Cheap pre-check: folding runs thousands of times per turn (category alias matching), and
 * almost no text contains a dialect word, so the per-word pass runs only when one may occur.
 */
const MAY_HAVE_DIALECT_WORD =
  /(?:^|[\s،,؟?!.])[وبف]?(?:التاني|التالت|بغيت|نبغي|بغينا|عايز|عاوز|اشتي|نشتي|داير|ابغا|ابغي|used|هادا|هاذا|هاد|ده)/u;

function foldDialectWords(value: string): string {
  if (!MAY_HAVE_DIALECT_WORD.test(value)) return value;
  return value.replace(/(^|[\s،,؟?!.])([^\s،,؟?!.]+)/gu, (whole, lead: string, word: string) => {
    for (const [pattern, canonical] of DIALECT_WORDS) {
      if (pattern.test(word)) return `${lead}${canonical}`;
      // «والتالت», «بالتاني»: a conjunction or preposition attached to the article stays attached
      // (only before «ال», so «بده» — «he wants» — is not read as «ب» + «ده»).
      if (/^[وبف]ال/u.test(word) && pattern.test(word.slice(1))) return `${lead}${word[0]}${canonical}`;
    }
    return whole;
  });
}

/** Letter-level folding shared by queries and listing text, plus the dialect word fold. */
export function foldArabicLetters(value: string): string {
  return foldDialectWords(
    value
      .toLocaleLowerCase("ar")
      .replace(/[أإآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ـ/g, "")
      .replace(/[ً-ٰٟ]/g, "")
  );
}

// Indefinite feminine adjectives fold to the masculine value sellers store ("سماعة سوداء").
// Definite forms are left alone: "الزرقاء" is the city of Zarqa, not the colour blue.
const AGREEMENT_FORMS: [RegExp, string][] = [
  [/(^|\s)سوداء(?=\s|$)/g, "$1اسود"],
  [/(^|\s)بيضاء(?=\s|$)/g, "$1ابيض"],
  [/(^|\s)حمراء(?=\s|$)/g, "$1احمر"],
  [/(^|\s)زرقاء(?=\s|$)/g, "$1ازرق"],
  [/(^|\s)خضراء(?=\s|$)/g, "$1اخضر"],
  [/(^|\s)صفراء(?=\s|$)/g, "$1اصفر"],
  [/(^|\s)مستعمل[ةه](?=\s|$)/g, "$1مستعمل"],
  [/(^|\s)جديد[ةه](?=\s|$)/g, "$1جديد"],
];

export function foldAgreement(value: string): string {
  return AGREEMENT_FORMS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

const UNIT_WORDS: Record<string, number> = {
  واحد: 1, واحده: 1, واحدة: 1,
  اثنين: 2, اثنان: 2, اتنين: 2, ثنتين: 2,
  ثلاث: 3, ثلاثة: 3, ثلاثه: 3, تلات: 3, تلاتة: 3, تلاته: 3,
  اربع: 4, اربعة: 4, اربعه: 4,
  خمس: 5, خمسة: 5, خمسه: 5,
  ست: 6, ستة: 6, سته: 6,
  سبع: 7, سبعة: 7, سبعه: 7,
  ثمان: 8, ثماني: 8, ثمانية: 8, ثمانيه: 8, تمن: 8, تمنية: 8, تمنيه: 8,
  تسع: 9, تسعة: 9, تسعه: 9,
  عشر: 10, عشرة: 10, عشره: 10,
};
const TENS_WORDS: Record<string, number> = {
  عشرين: 20, ثلاثين: 30, تلاتين: 30, اربعين: 40, خمسين: 50,
  ستين: 60, سبعين: 70, ثمانين: 80, تمانين: 80, تسعين: 90,
};
const HUNDRED_WORDS: Record<string, number> = {
  مية: 100, ميه: 100, مئة: 100, مائة: 100, مئه: 100, مائه: 100,
  ميتين: 200, مئتين: 200, مائتين: 200, الفين: 2000,
};
const MULTIPLIER = /^(?:الف|الاف|مليون)$/;
const UNIT_NOUN =
  /^(?:بالمئه|بالمئة|بالميه|بالمية|بالمائه|بالمائة|%|٪|الف|الاف|مليون|مية|ميه|مئة|مائة|غرف|غرفة|غرفه|حمام|حمامات|دينار|دنانير|ريال|ريالات|دولار|دولارات|درهم|كم|كيلو|متر|قطع|قطعة|حبات|سنين|سنوات)$/;
const COMPARATOR_TAIL = /(?:^|\s)(?:اقل من|اكثر من|اعلى من|فوق|تحت|دون|اقصى|بحدود|حوالي|حدود|ب|من|الى|الي|بين)$/;

function cardinalWordValue(word: string): number | undefined {
  return UNIT_WORDS[word] ?? TENS_WORDS[word] ?? HUNDRED_WORDS[word];
}

/**
 * Converts Arabic cardinal words to digits only where a number is clearly meant:
 * before a unit or multiplier, or after a comparison phrase. Ordinals are untouched.
 */
export function normalizeNumberWords(value: string): string {
  let text = value
    // Start only at the first digit of a run: a later start matches only where the first does.
    .replace(/(?<!\d)(\d+(?:\.\d+)?)\s*k(?=\s|$)/gi, "$1 الف")
    .replace(/(^|\s)(?:غرفتين|غرفتان)(?=\s|$)/g, (_, lead: string) => `${lead}2 غرف`)
    .replace(/(^|\s)(?:حمامين|حمامتين|حمامان)(?=\s|$)/g, (_, lead: string) => `${lead}2 حمام`)
    .replace(/(^|\s)(?:الفين|ألفين)(?=\s|$)/g, (_, lead: string) => `${lead}2000`);
  const words = text.split(/\s+/).filter(Boolean);
  const output: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    // «بعشرة بالمئة», «بخمسة دنانير»: the attached «ب» is the same comparator as «ب عشرة».
    const clitic = cardinalWordValue(word) === undefined && word.startsWith("ب") && cardinalWordValue(word.slice(1)) !== undefined;
    let numeric = cardinalWordValue(clitic ? word.slice(1) : word);
    let consumed = 0;
    // "خمسة وعشرين" → 25
    const next = words[index + 1];
    if (
      numeric !== undefined &&
      numeric < 10 &&
      next?.startsWith("و") &&
      TENS_WORDS[next.slice(1)] !== undefined
    ) {
      numeric += TENS_WORDS[next.slice(1)]!;
      consumed = 1;
    }
    const following = words[index + 1 + consumed];
    // COMPARATOR_TAIL is anchored at the end and spans at most two words, so the last two output
    // entries are enough (an entry boundary is a space in the joined text). Joining the whole
    // output for every word made this quadratic on long messages (hostile-input-performance).
    if (
      numeric !== undefined &&
      ((following !== undefined && UNIT_NOUN.test(following)) ||
        COMPARATOR_TAIL.test(output.slice(-2).join(" ")))
    ) {
      output.push(clitic ? `ب ${numeric}` : String(numeric));
      index += consumed;
      continue;
    }
    output.push(word);
  }
  text = output.join(" ");
  // A bare multiplier after a comparison means one unit of it: "اقل من الف" → 1000.
  return text.replace(
    /((?:^|\s)(?:اقل من|اكثر من|فوق|تحت|دون|بحدود|حوالي))\s+الف(?=\s|$)/g,
    "$1 1000",
  );
}

export type ResultReference =
  | { kind: "INDEX"; index: number }
  | { kind: "LAST" };

const ORDINAL_WORDS: [RegExp, number][] = [
  [/^(?:الاول|الاولي|الاوله|اول|الاولى)$/, 0],
  [/^(?:الثاني|الثانية|الثانيه|ثاني|التاني|التانية|التانيه|تاني)$/, 1],
  [/^(?:الثالث|الثالثة|الثالثه|ثالث|التالت|التالتة|التالته)$/, 2],
  [/^(?:الرابع|الرابعة|الرابعه|رابع)$/, 3],
  [/^(?:الخامس|الخامسة|الخامسه|خامس)$/, 4],
  [/^(?:السادس|السادسة|السادسه)$/, 5],
  [/^(?:السابع|السابعة|السابعه)$/, 6],
  [/^(?:الثامن|الثامنة|الثامنه)$/, 7],
  [/^(?:التاسع|التاسعة|التاسعه)$/, 8],
  [/^(?:العاشر|العاشرة|العاشره)$/, 9],
];

function ordinalWord(word: string): ResultReference | undefined {
  if (/^(?:الاخير|الاخيرة|الاخيره|الاخر)$/.test(word)) return { kind: "LAST" };
  const match = ORDINAL_WORDS.find(([pattern]) => pattern.test(word));
  return match ? { kind: "INDEX", index: match[1] } : undefined;
}

const REFERENCE_VERBS =
  "(?:افتح|افتحلي|اعرض|اعرضلي|وريني|ورجيني|فرجيني|شوف|شوفلي|اختار|اختر|بدي|اريد|ابي|ابغي|ابغى|خذ|عطني|اعطني|اين|وين|فين)";
const REFERENCE_NOUNS =
  "(?:تفاصيل|معلومات|العرض|الاعلان|النتيجة|النتيجه|الخيار|الاختيار|المنتج|الخدمة|الخدمه|البطاقة|البطاقه|السيارة|السياره|الشقة|الشقه|الجهاز|القطعة|القطعه|السماعة|السماعه|رقم)";
const REFERENCE_TAIL =
  "(?:\\s+(?:منها|منهم|من النتائج|من القائمة|لو سمحت|من فضلك|بليز))?";

/**
 * A whole-utterance reference to a shown result ("الثانية", "افتح الثالثة",
 * "العرض رقم 2", "الأخير"). Numbers inside ordinary requests ("3 غرف") never match.
 */
export function parseResultReference(message: string): ResultReference | undefined {
  const text = foldArabicLetters(normalizeDigits(message))
    .replace(/[؟?!.،,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:اللي|الي|يلي)?\s*علي اليمين$/.test(text)) return { kind: "INDEX", index: 0 };
  if (/^(?:اخر واحد(?:ة|ه)?|اخر وحده)$/.test(text)) return { kind: "LAST" };
  const match = text.match(
    new RegExp(
      `^(?:${REFERENCE_VERBS}\\s+)?(?:${REFERENCE_NOUNS}\\s+){0,2}(?:رقم\\s+)?(\\S+)${REFERENCE_TAIL}$`,
      "u",
    ),
  );
  if (!match) return undefined;
  const token = match[1]!;
  const numeric = token.match(/^(\d{1,2})$/);
  if (numeric) {
    const value = Number(numeric[1]);
    return value >= 1 && value <= 24 ? { kind: "INDEX", index: value - 1 } : undefined;
  }
  return ordinalWord(token);
}

/** An ordinal anywhere in a command ("أضف الثانية للسلة"); bare digits need a listing noun. */
export function findOrdinalMention(message: string): ResultReference | undefined {
  const text = foldArabicLetters(normalizeDigits(message));
  const withNoun = text.match(
    new RegExp(`(?:^|\\s)${REFERENCE_NOUNS}\\s+(?:رقم\\s+)?(\\d{1,2})(?=\\s|$)`, "u"),
  );
  if (withNoun) {
    const value = Number(withNoun[1]);
    if (value >= 1 && value <= 24) return { kind: "INDEX", index: value - 1 };
  }
  for (const word of text.split(/\s+/)) {
    const reference = ordinalWord(word);
    if (reference) return reference;
  }
  return undefined;
}

/** All result ordinals in an action such as «أضف الأول والثالث». */
export function findOrdinalMentions(message: string): ResultReference[] {
  const text = foldArabicLetters(normalizeDigits(message))
    .replace(/[؟?!.،,؛;:()«»"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.split(/\s+/);
  const references: ResultReference[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!.replace(
      /^و(?=(?:ال)?(?:اول|ثاني|ثالث|رابع|خامس|سادس|سابع|ثامن|تاسع|عاشر|اخير|اخر))/u,
      "",
    );
    const ordinal = ordinalWord(word);
    if (ordinal) references.push(ordinal);
    if (
      /^(?:رقم|الاعلان|العرض|الخيار|المنتج)$/u.test(words[index]!) &&
      /^\d{1,2}$/u.test(words[index + 1] ?? "")
    ) {
      const value = Number(words[index + 1]);
      if (value >= 1 && value <= 24)
        references.push({ kind: "INDEX", index: value - 1 });
    }
  }
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = reference.kind === "LAST" ? "LAST" : `INDEX:${reference.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Seller commands name a listing explicitly ("الإعلان الثاني"); then a later number is a value. */
export function explicitListingOrdinal(message: string): number | undefined {
  const text = foldArabicLetters(normalizeDigits(message));
  const match = text.match(
    /(?:^|\s)(?:الاعلان|العرض)\s*(?:رقم\s*)?(\S+)(?=\s|$)/u,
  );
  if (!match) return undefined;
  const numeric = match[1]!.match(/^(\d{1,2})$/);
  if (numeric) {
    const value = Number(numeric[1]);
    return value >= 1 && value <= 24 ? value - 1 : undefined;
  }
  const reference = ordinalWord(match[1]!);
  return reference?.kind === "INDEX" ? reference.index : undefined;
}

const NEGATION =
  /(?:^|\s)(?:لا\s+(?:اريد|ابغي|ابغى|ابي|بدي)|ما\s+(?:بدي|ابي|ابغي|ابغى|اريد|بدنا)|مش\s+بدي|مابدي|بدون|من غير|مو|مش|ليس|ليست|ما\s+بيكون)(?=\s|$)/;

/** True when a negation phrase directly governs `phrase` (within two words before it). */
export function isNegated(text: string, phrase: string): boolean {
  const index = ` ${text} `.indexOf(` ${phrase} `);
  if (index < 0) return false;
  const before = text.slice(0, index).trim().split(/\s+/).slice(-3).join(" ");
  return NEGATION.test(` ${before}`);
}

export function hasNegation(text: string): boolean {
  return NEGATION.test(` ${text}`);
}

export type NumericKind =
  | "PRICE"
  | "YEAR"
  | "MILEAGE"
  | "ROOMS"
  | "BATHROOMS"
  | "AREA_SIZE"
  | "QUANTITY"
  | "ORDINAL"
  | "GENERAL";

export type NumericComparator = "eq" | "lt" | "lte" | "gt" | "gte" | "approx";

export type NumericMention = {
  value: number;
  kind: NumericKind;
  comparator: NumericComparator;
  /** Upper bound when the mention is a range ("من 3000 إلى 6000"). */
  rangeTo?: number;
  /** Whether the kind came from explicit context (unit, field word) rather than a guess. */
  explicit: boolean;
  start: number;
  end: number;
};

const CURRENCY = /^(?:دينار|دنانير|ريال|ريالات|دولار|دولارات|درهم|جنيه|jd|jod|kwd|sar|usd)$/;
const LESS = /(?:اقل من|دون|تحت|ما يزيد عن|لا يزيد عن|ما بيزيد عن)$/;
/**
 * A negated «exceed» or «more than» is an upper bound (W04): «لا يتعدى 450», «ما يتجاوز 300»,
 * «ما ابي اكثر من 300», «مو اكثر من 200».
 */
const NOT_MORE = /(?:(?:لا|ما|مو|مش)\s+(?:بي)?(?:يتعدي|يتعدى|يتجاوز|يعدي)(?:\s+(?:عن|ال))?|(?:لا|ما|مو|مش)\s+(?:(?:ابي|ابغي|بدي|اريد|ودي|اقدر)\s+)?(?:ادفع\s+)?(?:اكثر|اكتر|ازيد|فوق)(?:\s+(?:من|عن))?)$/;
const AT_MOST = /(?:حد اقصي|حد اقصى|بحد اقصي|بحد اقصى|اقصي|اقصى|لحد|ميزانيتي|ميزانية|بميزانية|ميزانيه|بميزانيه)$/;
const MORE = /(?:اكثر من|اعلى من|اعلي من|فوق)$/;
const AT_LEAST = /(?:علي الاقل|على الاقل|بالاقل)$/;
const APPROX = /(?:بحدود|حدود|حوالي|تقريبا|بحوالي)$/;
const PRICE_WORDS = /(?:السعر|سعر|بسعر|سعرها|سعره|ثمن|بثمن)$/;
const YEAR_WORDS = /(?:موديل|الموديل|سنة|سنه|السنة|سنة الصنع|صنع)$/;
const MILEAGE_WORDS = /(?:ماشية|ماشيه|ماشي|ممشى|ممشي|الممشى|الممشي|عداد|العداد|مشي|مقطوعة|قاطعة)$/;
const AREA_WORDS = /(?:مساحة|مساحه|المساحة|المساحه|مساحتها)$/;
const ORDINAL_NOUNS = /(?:رقم|الاعلان|العرض|النتيجة|النتيجه|الخيار)$/;
const AT_LEAST_TAIL = /^(?:وفوق|وما فوق|فما فوق|فوق|او اكثر|واكثر|وطالع|او احدث|واحدث|وانت طالع)/;
const AT_MOST_TAIL = /^(?:وتحت|وما دون|او اقل|واقل|ونازل|وانت نازل)/;

/**
 * Finds every standalone number with its typed meaning, using the words around it.
 * "الإعلان الثاني إلى 50" yields only PRICE 50 (the ordinal is a word), "3 غرف" is ROOMS,
 * "موديل 2021 ماشية 70 ألف" is YEAR 2021 and MILEAGE 70000.
 */
export function parseNumericMentions(normalizedText: string): NumericMention[] {
  const text = normalizedText;
  const pattern =
    /(?<![\p{L}\d.,])(\d+(?:[.,]\d+)?)(?:\s*(الف|الاف|مليون))?(?![\p{L}\d])/gu;
  const raw: { value: number; multiplied: boolean; start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    const base = Number(match[1]!.replace(/,(?=\d{3}(?!\d))/g, "").replace(",", "."));
    const multiplier =
      match[2] === "مليون" ? 1_000_000 : match[2] ? 1_000 : 1;
    const value = base * multiplier;
    if (!Number.isFinite(value)) continue;
    raw.push({
      value,
      multiplied: Boolean(match[2]),
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  const mentions: NumericMention[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index]!;
    // Context rules read only the nearby words; a bounded window keeps long inputs linear.
    const before = text.slice(Math.max(0, current.start - 80), current.start).trim();
    const after = text.slice(current.end, current.end + 80).trim();
    const nextWord = after.split(/\s+/)[0] ?? "";

    // Range: "من X الى Y" / "بين X و Y" / "X - Y". A dash pair inside a longer hyphenated code
    // ("174f6878-7754-4335-a1b2", "AB-1200-3400-C") is part of that code, not a range.
    const partner = raw[index + 1];
    const between = partner ? text.slice(current.end, partner.start).trim() : "";
    const insideCode = partner !== undefined && (/[-–]/.test(text[current.start - 1] ?? "") || /[-–]/.test(text[partner.end] ?? ""));
    const isRange =
      partner !== undefined &&
      (/^(?:الى|الي|لـ|ل|حتى|حتي|-|–)$/.test(between) && /(?:^|\s)من$/.test(before) ||
        /^و$/.test(between) && /(?:^|\s)بين$/.test(before) ||
        /^(?:-|–)$/.test(between) && !insideCode);

    const rangeTail = isRange ? text.slice(partner!.end, partner!.end + 80).trim() : "";
    const context = isRange ? `${before} ${rangeTail.split(/\s+/)[0] ?? ""}` : before;
    const unitWord = isRange ? rangeTail.split(/\s+/)[0] ?? "" : nextWord;

    let kind: NumericKind = "GENERAL";
    let explicit = true;
    if (ORDINAL_NOUNS.test(before)) kind = "ORDINAL";
    else if (/^(?:غرف|غرفة|غرفه|غرف نوم)$/.test(unitWord) || /(?:غرف النوم|عدد الغرف)$/.test(before))
      kind = "ROOMS";
    else if (/^(?:حمام|حمامات)$/.test(unitWord)) kind = "BATHROOMS";
    else if (/^(?:متر|م2|م²|مترمربع)$/.test(unitWord) || AREA_WORDS.test(before))
      kind = "AREA_SIZE";
    else if (/^(?:كم|كيلو|كيلومتر|كيلومترات)$/.test(unitWord) || MILEAGE_WORDS.test(before))
      kind = "MILEAGE";
    else if (YEAR_WORDS.test(before)) kind = "YEAR";
    else if (CURRENCY.test(unitWord) || PRICE_WORDS.test(context.replace(/\s+(?:اقل من|اكثر من|فوق|تحت|الى|الي|من|بين|بحدود|حوالي)$/, "")))
      kind = "PRICE";
    else if (/^(?:قطع|قطعة|قطعه|حبات|حبة|حبه)$/.test(unitWord)) kind = "QUANTITY";
    // "غير سعر الإعلان الثاني إلى 50": a target value in a clause that names the price.
    else if (
      /(?:^|\s)(?:السعر|سعر|سعره|سعرها)(?:\s|$)/.test(before) &&
      /(?:^|\s)(?:الى|الي|ل|ب|يصير|ليصبح)$/.test(before)
    )
      kind = "PRICE";
    else if (
      !current.multiplied &&
      Number.isInteger(current.value) &&
      current.value >= 1950 &&
      current.value <= 2035 &&
      (!isRange || (partner!.value >= 1950 && partner!.value <= 2035)) &&
      !LESS.test(before) && !MORE.test(before) && !AT_MOST.test(before) && !APPROX.test(before) && !NOT_MORE.test(before)
    ) {
      kind = "YEAR";
      explicit = false;
    } else explicit = false;

    let comparator: NumericComparator = "eq";
    const comparatorContext = before.replace(/\s+(?:السعر|سعر|بسعر)$/, "");
    if (NOT_MORE.test(comparatorContext)) comparator = "lte";
    else if (LESS.test(comparatorContext)) comparator = "lt";
    else if (AT_MOST.test(comparatorContext)) comparator = "lte";
    else if (MORE.test(comparatorContext)) comparator = "gt";
    else if (AT_LEAST.test(comparatorContext)) comparator = "gte";
    else if (APPROX.test(comparatorContext)) comparator = "approx";
    const tail = isRange ? rangeTail : after;
    const tailWithoutUnit = tail.replace(/^\S+\s+/, "");
    if (AT_LEAST_TAIL.test(tail) || (CURRENCY.test(unitWord) && AT_LEAST_TAIL.test(tailWithoutUnit)))
      comparator = "gte";
    else if (AT_MOST_TAIL.test(tail) || (CURRENCY.test(unitWord) && AT_MOST_TAIL.test(tailWithoutUnit)))
      comparator = "lte";

    if (isRange) {
      const low = Math.min(current.value, partner!.value);
      const high = Math.max(current.value, partner!.value);
      mentions.push({
        value: low,
        rangeTo: high,
        kind,
        comparator: "gte",
        explicit,
        start: current.start,
        end: partner!.end,
      });
      index += 1;
      continue;
    }
    mentions.push({
      value: current.value,
      kind,
      comparator,
      explicit,
      start: current.start,
      end: current.end,
    });
  }
  return mentions;
}

/** Full deterministic preparation for parsing a marketplace request. */
export function normalizeMarketplaceText(message: string): string {
  return normalizeNumberWords(
    foldAgreement(
      foldArabicLetters(normalizeDigits(message))
        .replace(/[؟?!،]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
}
