import { cardinalWordValue } from "../ai/arabic-normalization";
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
  "حاب", "حابه", "حابب", "حابة", "ابغا", "ابا", "نبغي", "نفسي", "اشوف", "شوفلي", "جيبلي", "هاتلي", "لقيلي", "لاقيلي", "طالعلي", "دورولي", "فتشلي",
  // «غرض للبيت», «شي للبيت»: the generic word for "an item" names nothing; «اذا في» is a question frame.
  "غرض", "الغرض", "شي", "شيء", "اشي", "اذا", "اذ", "ارجع", "رجعني", "نرجع", "خلينا",
  // Questions and politeness around the item: «في عندكم …؟», «مين يصمم …», «لو سمحت».
  "عندكم", "عندك", "لديكم", "في", "فيه", "شو", "وش", "ايش", "مين", "هل", "على", "عن", "لو", "سمحت", "فضلك", "من",
  // Doing verbs and the generic word for a service: «يسوي لي لوجو», «خدمة تنظيف».
  "يسوي", "يسويلي", "يعمل", "يعملي", "خدمه", "خدمة", "خدمات",
  // A negation particle left beside a value («… مو جديد») never names the item (W04).
  "مو", "مش", "ليس", "ليست",
  // «سامسونج ابو الالترا» (the one with…), «موديل ٢٠١٩»: framing words, never the item.
  "ابو", "موديل", "موديله", "موديلها",
]);

/**
 * Generic nouns for a kind of thing («موبايل ايفون», «سيارة برادو»). When nothing matches the
 * whole request, the specific words alone may be searched; the reply names what was relaxed.
 */
const GENERIC_NOUNS = new Set(["هاتف", "جوال", "موبايل", "تلفون", "تليفون", "سياره", "سيارة", "عربيه", "عربية", "جهاز", "كمبيوتر", "حاسوب", "كونسول"]);

/** Everyday synonyms; a token matches if the listing text contains any member of its group. */
const LEXICON: readonly (readonly string[])[] = [
  ["بيت", "بيوت", "منزل", "منازل", "شقه", "شقة", "شقق"],
  ["هاتف", "جوال", "موبايل", "تلفون", "تليفون"],
  ["ماكينه", "ماكينة", "مكينه", "مكينة"],
  ["سياره", "سيارة", "عربيه", "عربية"],
  ["مقهي", "كافيه", "كوفي"],
  ["شعار", "لوجو", "لوغو"],
  ["طعام", "سفره", "سفرة"],
  ["تصليح", "اصلاح", "صيانه", "صيانة"],
  ["لابتوب", "laptop"],
  ["كوب", "اكواب", "كاس", "كاسات", "كاسه", "كاسة"],
  // Brands and model words written in Arabic or Latin letters: a buyer types «ايفون», the seller
  // titled the listing «iPhone» (and back). Transliteration only — no product facts.
  ["ايفون", "iphone", "ايفونات"], ["سامسونج", "سامسونغ", "سامسونك", "samsung"], ["جالاكسي", "جالكسي", "galaxy"],
  ["الترا", "ultra"], ["ماكبوك", "macbook"], ["لينوفو", "lenovo"], ["ديل", "dell"], ["شاومي", "xiaomi"],
  ["ريدمي", "redmi"], ["بلايستيشن", "بلاستيشن", "playstation"], ["سوني", "sony"], ["لوجيتك", "logitech"],
  // Everyday and dialect names of the same thing (held-out H-DIA misses): exact equivalents only.
  ["سيكل", "دراجه", "دراجة", "بسكليت", "بايسكل"], ["فراخ", "دجاج", "فروج"], ["لوقو", "لوجو", "لوغو", "شعار", "logo"],
  ["ترجمه", "ترجمة", "يترجم", "مترجم", "ترجمات"], ["تلفزيون", "تلفاز", "شاشه", "شاشة", "tv"], ["عربيه", "عربية", "سياره", "سيارة"],
  ["تويوتا", "toyota"],
  ["كيبل", "كيبلات", "كابل", "كابلات", "سلك", "اسلاك", "cable"], ["اكله", "اكلة", "وجبه", "وجبة"],
  ["محمول", "لابتوب", "laptop"], ["ثينك", "think", "thinkpad"], ["سمارت", "ذكي", "smart"],
  ["تبريد", "مكيف", "تكييف", "مكيفات"], ["كونسول", "console", "بلايستيشن", "playstation", "اكسبوكس", "xbox"],
  ["اوراق", "ورق", "مستند", "مستندات", "وثائق", "صفحه", "صفحة"], ["كامري", "camry"], ["كورولا", "corolla"], ["هيونداي", "hyundai"], ["ايربودز", "airpods"],
];
const LEXICON_BY_WORD = new Map<string, readonly string[]>(
  LEXICON.flatMap((group) => group.map((word) => [word, group] as const)),
);

const PROCLITICS = ["وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ك", "ل"];
const POSSESSIVES = ["كم", "هم", "ها", "نا", "ي", "ك"];

/** Every surface form a request token may take in a listing. */
export function tokenVariants(token: string): string[] {
  const forms = new Set<string>([token]);
  if (token.endsWith("تي") && token.length>=5) forms.add(`${token.slice(0,-2)}ة`).add(`${token.slice(0,-2)}ه`);
  const beneficiary = /^([يتنب][\p{Script=Arabic}]{3,5})لي$/u.exec(token);
  if (beneficiary) for (const form of tokenVariants(beneficiary[1]!)) forms.add(form);
  const cardinal = cardinalWordValue(token);
  if (cardinal !== undefined) forms.add(String(cardinal));
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
    if (token.endsWith("تي") && form.endsWith("ت") && form.length >= 4) forms.add(`${form.slice(0,-1)}ة`).add(`${form.slice(0,-1)}ه`);
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
    // Regular form-I passive participle مفعول ↔ imperfect يفعل. Whole-word matching below
    // keeps unrelated longer words out; no product-specific roots or global stemming.
    const passive = /^م([\p{Script=Arabic}])([\p{Script=Arabic}])و([\p{Script=Arabic}])$/u.exec(form);
    if (passive) forms.add(`ي${passive[1]}${passive[2]}${passive[3]}`);
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
  for (const form of [...forms]) for (const synonym of LEXICON_BY_WORD.get(form) ?? []) forms.add(synonym);
  return [...forms];
}

/**
 * Words that describe an item without naming one. «هاتف جديد» relaxed to «جديد» would match any
 * new listing, so a description alone never justifies relaxing the generic noun (W04).
 */
const DESCRIPTIVE = /^(?:ال)?(?:جديد|جديده|جديدة|مستعمل|مستعمله|مستعملة|مستخدم|مستخدمه|مستخدمة|نظيف|نظيفه|نظيفة|كويس|كويسه|كويسة|ممتاز|ممتازه|ممتازة|مميز|مميزه|مميزة|اصلي|اصليه|اصلية|رخيص|رخيصه|رخيصة|غالي|غاليه|غالية|كبير|كبيره|كبيرة|صغير|صغيره|صغيرة|اسود|ابيض|احمر|ازرق|اخضر|اصفر|رمادي|بني|وردي|ذهبي|فضي)$/u;

/** True when every word only describes (new, used, big, a colour …) and none names an item. */
export function isDescriptiveOnly(tokens: readonly string[]): boolean {
  return tokens.every((token) => DESCRIPTIVE.test(token) || GENERIC_NOUNS.has(token));
}

/** The generic kind-of-thing words among the item words, when a specific (naming) word remains beside them. */
export function genericTokens(tokens: readonly string[]): string[] {
  const generic = tokens.filter((token) => tokenVariants(token).some((form) => GENERIC_NOUNS.has(form)));
  const specific = tokens.filter((token) => !generic.includes(token) && !DESCRIPTIVE.test(token));
  return generic.length < tokens.length && specific.length > 0 ? generic : [];
}

/** True when no word names an item: empty, or only request words («ابي», «ابحث», «عن»). */
export function isRequestOnly(tokens: readonly string[]): boolean {
  return tokens.every((token) => REQUEST_WORDS.has(token));
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
  return tokens.slice(1).filter((token) => /^ل(?!ا)/u.test(token) && token.length >= 4 && !/[\d٠-٩۰-۹]/u.test(token) && !tokenVariants(token).some(form=>/^\d+$/u.test(form)));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The token itself keeps plain containment (unchanged behaviour). A derived form must begin a
 * word of the listing, optionally after an attached particle, so short stems cannot match inside
 * unrelated words.
 */
export function textMatchesToken(text: string, token: string): boolean {
  if (/^\d+$/u.test(token)) return new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\d[.,٫])${escape(token)}(?![\\p{L}\\p{N}]|[.,٫]\\d)`, "u").test(text);
  if (text.includes(token)) return true;
  // …and end it, allowing only an inflectional ending: the stem «سيار» (from «سيارات») matches
  // «سيارة», but a stem is never the prefix of another word.
  return tokenVariants(token).some(
    (form) =>
      form !== token &&
      new RegExp(`(?:^|\\s)(?:و|ف|ب|ل|ك)?(?:ال)?${escape(form)}(?:ة|ه|ات|ي|يه|ية)?(?=\\s|$)`, "u").test(text),
  );
}

/** Shared bounded recall; callers retain every hard filter and eligibility check. */
export async function boundedItemRelaxation<T extends { title: string }>(query: string, normalize: (text: string) => string, run: (query: string) => Promise<T[]>): Promise<{ listings: T[]; dropped: string[] } | undefined> {
  const words = itemTokens(normalize(query).split(/\s+/u).filter(Boolean)).slice(0, 6);
  if (words.length < 3) return undefined;
  const [head, ...others] = words;
  // A definite adjective after a purpose/recipient phrase describes that destination,
  // not the item: do not turn «للمنزل الجديد» into a hard new-item constraint.
  const purposeAdjectives = new Set<number>();
  for (let i = 1; i < words.length - 1; i++) {
    if (!/^ل\S{2,}$/u.test(words[i]!)) continue;
    for (let j = i + 1; j < Math.min(words.length, i + 3) && /^ال/u.test(words[j]!) && DESCRIPTIVE.test(words[j]!); j++) purposeAdjectives.add(j);
  }
  const hardDescriptors = new Set(words.filter((word, index) => DESCRIPTIVE.test(word) && !purposeAdjectives.has(index)));
  let tried = 0;
  const combinations = (items: string[], count: number): string[][] => count === 0 ? [[]] : items.flatMap((item, i) => combinations(items.slice(i + 1), count - 1).map((rest) => [item, ...rest]));
  for (let keep = others.length - 1; keep >= 0 && keep >= others.length - 3 && keep + 1 >= Math.ceil(words.length / 2); keep--) {
    for (const rest of combinations(others, keep)) {
      const subset = [head!, ...rest];
      const dropped = others.filter((word) => !rest.includes(word));
      if (dropped.some((word) => /\d/u.test(word) || cardinalWordValue(word) !== undefined || hardDescriptors.has(word)) || isDescriptiveOnly(subset)) continue;
      if (++tried > 14) return undefined;
      let listings = await run(subset.join(" "));
      if (!rest.length) listings = listings.filter((listing) => textMatchesToken(normalize(listing.title), head!));
      if (listings.length) return { listings, dropped };
    }
  }
  return undefined;
}

/** A service's target noun must not be discarded to find a different service. */
export function hasServiceMeaning(tokens: readonly string[]): boolean {
  const nouns=new Set(["تنظيف","تصليح","اصلاح","صيانة","صيانه","تصميم","طباعه","طباعة","تركيب","غسيل","تبريد","دهان"]);
  return tokens.some(token=>/^(?:ي|ت|ن|ب|بي|بن)(?:نظف|صلح|غسل|صمم|طبع|ركب|برد|دهن|رسم)(?:لي)?$/u.test(token) || tokenVariants(token).some(form=>nouns.has(form)));
}
