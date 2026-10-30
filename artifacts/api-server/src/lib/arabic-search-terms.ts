/**
 * General Arabic matching for conversational search. Tokens arrive already folded by
 * normalizeSearch (hamza forms → ا, ى → ي, diacritics removed; ة is kept). Nothing here knows
 * about any product: it handles attached particles, tanween, possessive endings, sound plurals,
 * the verb ↔ verbal-noun pair of form II («ينظف» ↔ «تنظيف»), a small everyday lexicon, and words
 * that describe the request rather than the item («أحد», weekdays, «المنتجات»).
 */

/** Words that say who/when/what-in-general, never what the listing is. */
const REQUEST_WORDS = new Set([
  "احد", "حد", "شخص", "واحد", "لي", "لنا", "الي", "عندي", "ابي", "ابغي", "ابغى", "اريد", "بدي", "ودي",
  "ورني", "وريني", "ورينا", "ارني", "راويني", "فرجني", "اعرض", "اعرضلي", "ابحث", "دورلي", "فقط", "بس",
  "السبت", "الاحد", "الاثنين", "الثلاثاء", "الاربعاء", "الخميس", "الجمعه", "الجمعة", "اليوم", "بكره", "بكرة", "غدا",
  "منتج", "منتجات", "المنتج", "المنتجات", "اغراض", "الاغراض", "اشياء", "الاشياء", "سلع", "السلع", "بضاعه", "بضاعة",
  // Wants and needs across dialects, and the verbs of looking for something.
  "عايز", "عاوز", "محتاج", "محتاجه", "محتاجة", "نبي", "نبغى", "بدنا", "اشتري", "اشتريه", "دور", "ادور", "فتش", "شوف",
  // Questions and politeness around the item: «في عندكم …؟», «مين يصمم …», «لو سمحت».
  "عندكم", "عندك", "لديكم", "في", "فيه", "شو", "وش", "ايش", "مين", "هل", "على", "عن", "لو", "سمحت", "فضلك", "من",
  // Doing verbs and the generic word for a service: «يسوي لي لوجو», «خدمة تنظيف».
  "يسوي", "يسويلي", "يعمل", "يعملي", "خدمه", "خدمة", "خدمات",
  // A negation particle left beside a value («… مو جديد») never names the item (W04).
  "مو", "مش", "ليس", "ليست",
]);

/**
 * Generic nouns for a kind of thing («موبايل ايفون», «سيارة برادو»). When nothing matches the
 * whole request, the specific words alone may be searched; the reply names what was relaxed.
 */
const GENERIC_NOUNS = new Set(["هاتف", "جوال", "موبايل", "تلفون", "تليفون", "سياره", "سيارة", "عربيه", "عربية", "جهاز"]);

/** Everyday synonyms; a token matches if the listing text contains any member of its group. */
const LEXICON: readonly (readonly string[])[] = [
  ["بيت", "بيوت", "منزل", "منازل", "شقه", "شقة", "شقق"],
  ["هاتف", "جوال", "موبايل", "تلفون", "تليفون"],
  ["ماكينه", "ماكينة", "مكينه", "مكينة"],
  ["سياره", "سيارة", "عربيه", "عربية"],
  ["مقهي", "كافيه", "كوفي"],
  ["شعار", "لوجو", "لوغو"],
  ["طعام", "سفره", "سفرة"],
  ["كوب", "اكواب", "كاس", "كاسات", "كاسه", "كاسة"],
];
const LEXICON_BY_WORD = new Map<string, readonly string[]>(
  LEXICON.flatMap((group) => group.map((word) => [word, group] as const)),
);

const PROCLITICS = ["وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ك", "ل"];
const POSSESSIVES = ["كم", "هم", "ها", "نا", "ي", "ك"];

/** Every surface form a request token may take in a listing. */
export function tokenVariants(token: string): string[] {
  const forms = new Set<string>([token]);
  for (const prefix of PROCLITICS)
    if (token.startsWith(prefix) && token.length - prefix.length >= 3) forms.add(token.slice(prefix.length));
  for (const form of [...forms]) {
    // Tanween fatha leaves a final alef once diacritics are removed: «شعارًا» → «شعارا».
    if (form.endsWith("ا") && form.length >= 4) forms.add(form.slice(0, -1));
    for (const suffix of POSSESSIVES)
      if (form.endsWith(suffix) && form.length - suffix.length >= 3) forms.add(form.slice(0, -suffix.length));
    // Plurals in «ات»: «ماكينات» → «ماكينة»; «شعارات» → «شعار».
    if (form.endsWith("ات") && form.length >= 5) {
      const stem = form.slice(0, -2);
      forms.add(`${stem}ة`).add(`${stem}ه`).add(stem);
    }
    // Final «ه» written for «ة» and back: «طاوله» ↔ «طاولة».
    if (form.length >= 3 && form.endsWith("ه")) forms.add(`${form.slice(0, -1)}ة`);
    if (form.length >= 3 && form.endsWith("ة")) forms.add(`${form.slice(0, -1)}ه`);
    // A singular in ة names one of a collective noun: «كنبة» ↔ «كنب», «شجرة» ↔ «شجر» (W04).
    if (form.length >= 4 && /[ةه]$/u.test(form)) forms.add(form.slice(0, -1));
  }
  // The common ض/ظ spelling slip: «ينضف» for «ينظف».
  for (const form of [...forms]) {
    if (form.includes("ض")) forms.add(form.replaceAll("ض", "ظ"));
    if (form.includes("ظ")) forms.add(form.replaceAll("ظ", "ض"));
  }
  for (const form of [...forms]) {
    // Form II imperfect ↔ verbal noun: «ينظف» ↔ «تنظيف», «يصمم» ↔ «تصميم», «نوصل» ↔ «توصيل»;
    // the Levantine «بـ» imperfect too: «بنظف».
    const verb = /^[يتناب](\S)(\S)(\S)$/u.exec(form);
    if (verb) forms.add(`ت${verb[1]}${verb[2]}ي${verb[3]}`);
    // Form II agent noun ↔ verbal noun: «مصمم» ↔ «تصميم», «منظف» ↔ «تنظيف».
    // A lexicon noun is a thing, not an agent: «منزل» (house) is never «تنزيل» (download).
    const agent = LEXICON_BY_WORD.has(form) ? null : /^م(\S)(\S)(\S)$/u.exec(form);
    if (agent) forms.add(`ت${agent[1]}${agent[2]}ي${agent[3]}`);
  }
  for (const form of [...forms]) for (const synonym of LEXICON_BY_WORD.get(form) ?? []) forms.add(synonym);
  return [...forms];
}

/**
 * Words that describe an item without naming one. «هاتف جديد» relaxed to «جديد» would match any
 * new listing, so a description alone never justifies relaxing the generic noun (W04).
 */
const DESCRIPTIVE = /^(?:ال)?(?:جديد|جديده|جديدة|مستعمل|مستعمله|مستعملة|مستخدم|مستخدمه|مستخدمة|نظيف|نظيفه|نظيفة|كويس|كويسه|كويسة|ممتاز|ممتازه|ممتازة|مميز|مميزه|مميزة|اصلي|اصليه|اصلية|رخيص|رخيصه|رخيصة|غالي|غاليه|غالية|كبير|كبيره|كبيرة|صغير|صغيره|صغيرة|اسود|ابيض|احمر|ازرق|اخضر|اصفر|رمادي|بني|وردي|ذهبي|فضي)$/u;

/** The generic kind-of-thing words among the item words, when a specific (naming) word remains beside them. */
export function genericTokens(tokens: readonly string[]): string[] {
  const generic = tokens.filter((token) => tokenVariants(token).some((form) => GENERIC_NOUNS.has(form)));
  const specific = tokens.filter((token) => !generic.includes(token) && !DESCRIPTIVE.test(token));
  return generic.length < tokens.length && specific.length > 0 ? generic : [];
}

/** Drops words that describe the request rather than the item, unless nothing would remain. */
export function itemTokens(tokens: readonly string[]): string[] {
  const kept = tokens.filter((token) => !REQUEST_WORDS.has(token));
  return kept.length ? kept : [...tokens];
}

/**
 * «لمقهى», «لتغليف»: a word carrying the purpose particle لـ says what the buyer needs the item
 * for. When no listing matches the whole request, these may be relaxed — and the reply must name
 * them (`broadenedFrom`). The first item word is never relaxed.
 */
export function purposeTokens(tokens: readonly string[]): string[] {
  return tokens.slice(1).filter((token) => /^ل(?!ل|ا)/u.test(token) && token.length >= 4);
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The token itself keeps plain containment (unchanged behaviour). A derived form must begin a
 * word of the listing, optionally after an attached particle, so short stems cannot match inside
 * unrelated words.
 */
export function textMatchesToken(text: string, token: string): boolean {
  if (text.includes(token)) return true;
  // …and end it, allowing only an inflectional ending: the stem «سيار» (from «سيارات») matches
  // «سيارة», but a stem is never the prefix of another word.
  return tokenVariants(token).some(
    (form) =>
      form !== token &&
      new RegExp(`(?:^|\\s)(?:و|ف|ب|ل|ك)?(?:ال)?${escape(form)}(?:ة|ه|ات|ي|يه|ية)?(?=\\s|$)`, "u").test(text),
  );
}
