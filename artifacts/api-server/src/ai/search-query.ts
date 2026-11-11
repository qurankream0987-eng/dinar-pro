import {
  CORE_SEARCH_FILTERS,
  GLOBAL_SEARCH_SORTS,
  type CategoryAttributeDefinition,
  type MarketplaceCategorySchema,
  type SearchFilter,
  type SearchQuery,
  type SearchSort,
} from "@workspace/api-zod/marketplace-schemas";
import { tokenVariants } from "../lib/arabic-search-terms";
import { searchTerms, stripCorrectionPrefix } from "./intent";
import {
  hasCategoryAlias,
  isCategoryNameAlias,
  normalizeSearch,
} from "./search-context";
import {
  isNegated,
  normalizeDigits,
  normalizeNumberWords,
  parseNumericMentions,
  type NumericKind,
  type NumericMention,
} from "./arabic-normalization";

export function normalizeSearchNumberText(value: string): string {
  return normalizeDigits(value);
}

function parseAmount(value: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeSearchNumberText(value).trim().replace(/,/g, "");
  // «5 آلاف» folds to «5 الاف»: the plural is the same multiplier as «الف».
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(الف|الاف|مليون)?$/);
  if (!match) return undefined;
  const multiplier = match[2] === "مليون" ? 1_000_000 : match[2] === "الف" || match[2] === "الاف" ? 1_000 : 1;
  const amount = Number(match[1]) * multiplier;
  return Number.isFinite(amount) ? amount : undefined;
}

function numericFilter(
  message: string,
  field: string,
  vocabulary: string,
  requireVocabulary = false,
): SearchFilter | undefined {
  if (requireVocabulary && !new RegExp(vocabulary).test(message))
    return undefined;
  const numberPattern = String.raw`(\d+(?:[,.]\d{3})*(?:\.\d+)?(?:\s*(?:الف|الاف|مليون))?)`;
  const less = requireVocabulary
    ? undefined
    : new RegExp(String.raw`(?:اقل من|دون|تحت|حد اقصى)\s*${numberPattern}`).exec(message);
  const more = requireVocabulary
    ? undefined
    : new RegExp(String.raw`(?:اكثر من|اعلى من|فوق|على الاقل)\s*${numberPattern}`).exec(message);
  const tagged = vocabulary
    ? new RegExp(String.raw`(?:${vocabulary})\s*(?:(?:اقل من|اكثر من|فوق|تحت|الى|الي|هو|يساوي)\s*)?${numberPattern}`).exec(message)
    : undefined;
  const match = less ?? more ?? tagged;
  if (!match) return undefined;
  const value = parseAmount(match[1]);
  if (value === undefined) return undefined;
  const operator = less ? "lt" : more ? (/على الاقل/.test(more[0]) ? "gte" : "gt") : "eq";
  return { field, operator, value };
}

const FIELD_TERMS: Record<string, string[]> = {
  price: ["السعر", "سعر", "دينار", "ريال", "دولار", "kwd", "sar"],
  city: ["المدينة", "مدينة", "في مدينة", "في"],
  area: ["المنطقة", "منطقة", "الحي", "حي"],
  color: ["اللون", "لون"],
  size: ["المقاس", "مقاس", "الحجم", "حجم"],
  condition: ["الحالة", "حالة"],
  year: ["سنة الصنع", "السنة", "سنة", "الموديل", "موديل"],
  mileage: ["الممشى", "ممشى", "عداد", "كيلومتر", "كم", "ماشية"],
  bedrooms: ["غرف النوم", "غرف نوم", "غرف", "غرفة"],
  bathrooms: ["الحمامات", "حمامات", "حمام"],
  areaSize: ["المساحة", "مساحة"],
  weight: ["الوزن", "وزن", "وزنها", "كيلو", "كغم"],
  height: ["الارتفاع", "ارتفاع", "طول"],
  width: ["العرض", "عرض"],
  transactionType: ["نوع المعاملة", "للايجار", "ايجار", "للبيع"],
  propertyType: ["نوع العقار", "شقة", "شقق", "منزل", "بيت"],
  make: ["الشركة المصنعة", "الشركة", "المصنع"],
  model: ["الطراز", "الموديل"],
};

const FIELD_VALUE_ALIASES: {
  fields: RegExp;
  value: string;
  phrases: string[];
}[] = [
  { fields: /^(?:color|colour|لون)$/i, value: "أسود", phrases: ["أسود", "اسود", "black"] },
  { fields: /^(?:color|colour|لون)$/i, value: "أبيض", phrases: ["أبيض", "ابيض", "white"] },
  { fields: /^(?:color|colour|لون)$/i, value: "أحمر", phrases: ["أحمر", "احمر", "red"] },
  { fields: /^(?:color|colour|لون)$/i, value: "أزرق", phrases: ["أزرق", "ازرق", "blue"] },
  { fields: /^(?:color|colour|لون)$/i, value: "أخضر", phrases: ["أخضر", "اخضر", "green"] },
  { fields: /^(?:condition|الحالة)$/i, value: "مستعمل", phrases: ["مستعمل", "مستعملة", "used"] },
  { fields: /^(?:condition|الحالة)$/i, value: "جديد", phrases: ["جديد", "جديدة", "new"] },
  { fields: /^(?:make|manufacturer|الشركة المصنعة)$/i, value: "مرسيدس", phrases: ["مرسيدس", "بنز", "mercedes"] },
  { fields: /^(?:make|manufacturer|الشركة المصنعة)$/i, value: "تويوتا", phrases: ["تويوتا", "toyota", "كامري", "camry", "كورولا", "corolla", "برادو", "prado", "هايلكس", "hilux"] },
  { fields: /^(?:model|الطراز)$/i, value: "كامري", phrases: ["كامري", "camry"] },
  { fields: /^(?:model|الطراز)$/i, value: "كورولا", phrases: ["كورولا", "corolla"] },
  { fields: /^(?:model|الطراز)$/i, value: "برادو", phrases: ["برادو", "prado"] },
  { fields: /^(?:model|الطراز)$/i, value: "هايلكس", phrases: ["هايلكس", "hilux"] },
  { fields: /^(?:transactionType|نوع المعاملة)$/i, value: "إيجار", phrases: ["إيجار", "ايجار", "للايجار", "rent"] },
  { fields: /^(?:propertyType|نوع العقار)$/i, value: "شقة", phrases: ["شقة", "شقق", "apartment"] },
];

const CATEGORY_NEUTRAL_HINT_FIELDS = new Set(["color", "colour", "condition"]);

const SORT_ALIASES: { sort: SearchSort; phrases: string[] }[] = [
  { sort: "PRICE_ASC", phrases: ["الارخص", "ارخص", "اقل سعر", "من الاقل سعرا", "حسب السعر تصاعديا", "السعر من الاقل", "من الارخص", "من الرخيص"] },
  { sort: "PRICE_DESC", phrases: ["الاغلى", "اغلى", "اعلى سعر", "من الاعلى سعرا", "حسب السعر تنازليا", "من الغالي"] },
  { sort: "NEWEST", phrases: ["الاحدث", "احدث العروض", "الاضافة حديثا", "ترتيب حسب التاريخ"] },
  { sort: "YEAR_DESC", phrases: ["موديل احدث", "احدث موديل", "سنة الصنع تنازليا"] },
  { sort: "YEAR_ASC", phrases: ["موديل اقدم", "اقدم موديل", "سنة الصنع تصاعديا"] },
  { sort: "MILEAGE_ASC", phrases: ["اقل ممشى", "ممشى اقل", "عداد اقل"] },
  { sort: "MILEAGE_DESC", phrases: ["اعلى ممشى", "ممشى اعلى", "عداد اعلى"] },
  { sort: "PROPERTY_SIZE_DESC", phrases: ["اكبر مساحة", "المساحة الاكبر", "اوسع مساحة"] },
  { sort: "PROPERTY_SIZE_ASC", phrases: ["اقل مساحة", "المساحة الاصغر", "اصغر مساحة"] },
  { sort: "RELEVANCE", phrases: ["الاكثر صلة", "الاقرب للمواصفات", "الانسب"] },
];

const SORT_FILLER_TERMS = ["رتبهم", "رتبهن", "رتبها", "نظم", "نظمها", "حسب السعر", "السعر", "من", "اولا", "اول", "للاغلى", "للاعلى", "الى الاغلى", "الى الاعلى"];

function hasPhrase(message: string, phrase: string): boolean {
  const normalized = normalizeSearch(phrase);
  return normalized.length > 0 && ` ${message} `.includes(` ${normalized} `);
}

function sortIntent(message: string): SearchSort | undefined {
  return SORT_ALIASES.find(({ phrases }) =>
    phrases.some((phrase) => hasPhrase(message, phrase)),
  )?.sort;
}

function searchCategory(
  message: string,
  categories: readonly MarketplaceCategorySchema[],
): MarketplaceCategorySchema | undefined {
  const normalized = normalizeSearch(message);
  const explicit = categories
    .flatMap((category) =>
      [category.label, category.labelEn, category.id, ...category.aliases]
        .filter((alias): alias is string => Boolean(alias))
        .map((alias) => ({ category, alias: normalizeSearch(alias) })),
    )
    .filter(({ alias }) => alias.length >= 2 && hasCategoryAlias(normalized, alias))
    .sort((a, b) => b.alias.length - a.alias.length)[0];
  if (explicit) return explicit.category;

  const inferred = categories.flatMap((category) =>
    Object.entries(category.attributes).flatMap(([field, definition]) => {
      if (
        definition.searchable === false ||
        CATEGORY_NEUTRAL_HINT_FIELDS.has(field.toLowerCase())
      )
        return [];
      // An audience, material or automatic feature applies across product families. It may
      // filter a category the buyer named, but cannot independently choose that category.
      // Identity hints (brand/model/property kind) retain their existing inference behavior;
      // other attributes require an explicit field label before they can imply a category.
      const identityHint = /^(?:make|manufacturer|brand|model|propertyType)$/iu.test(field);
      const namedField = [field, definition.label, ...(FIELD_TERMS[field] ?? [])].some((label) => hasPhrase(normalized, label));
      if (!identityHint && !namedField) return [];
      const knownPhrases = FIELD_VALUE_ALIASES
        .filter((entry) => entry.fields.test(field))
        .flatMap((entry) => entry.phrases);
      const optionMatch = (definition.options ?? []).some((option) =>
        hasPhrase(normalized, option),
      );
      return optionMatch || knownPhrases.some((phrase) => hasPhrase(normalized, phrase))
        ? [category]
        : [];
    }),
  );
  const inferredIds = new Set(inferred.map((category) => category.id));
  return inferredIds.size === 1
    ? categories.find((category) => category.id === inferredIds.values().next().value)
    : undefined;
}

function allDefinitions(schema: MarketplaceCategorySchema) {
  return [
    ...Object.entries(schema.attributes),
    ...Object.entries(schema.searchFilters ?? {}),
  ];
}

function termsFor(field: string, label: string): string[] {
  const common = Object.entries(FIELD_TERMS)
    .filter(([key]) => key.toLowerCase() === field.toLowerCase())
    .flatMap(([, terms]) => terms);
  return [...new Set([field, label, ...common])].filter((value) => value.length > 0);
}

/** Registry numeric fields whose meaning the typed number parser recognises. */
function numericKindFor(field: string): NumericKind | undefined {
  const key = field.toLowerCase();
  if (key === "price") return "PRICE";
  if (key === "year") return "YEAR";
  if (key === "mileage") return "MILEAGE";
  if (key === "bedrooms" || key === "rooms") return "ROOMS";
  if (key === "bathrooms") return "BATHROOMS";
  if (key === "area" || key === "areasize" || key === "size") return "AREA_SIZE";
  return undefined;
}

function mentionFilters(field: string, mention: NumericMention): SearchFilter[] {
  if (mention.rangeTo !== undefined)
    return [
      { field, operator: "gte", value: mention.value },
      { field, operator: "lte", value: mention.rangeTo },
    ];
  if (mention.comparator === "approx")
    return [
      { field, operator: "gte", value: Math.round(mention.value * 0.9) },
      { field, operator: "lte", value: Math.round(mention.value * 1.1) },
    ];
  return [{ field, operator: mention.comparator, value: mention.value }];
}

function numericFieldFilters(
  message: string,
  field: string,
  label: string,
  mentions: readonly NumericMention[],
  claimed: Set<NumericMention>,
): SearchFilter[] {
  const kind = numericKindFor(field);
  if (kind) {
    const mention = mentions.find(
      (candidate) =>
        !claimed.has(candidate) &&
        (candidate.kind === kind ||
          // An unlabeled bounded number ("أقل من 9000") is a price.
          (kind === "PRICE" &&
            candidate.kind === "GENERAL" &&
            (candidate.comparator !== "eq" || candidate.rangeTo !== undefined))),
    );
    if (!mention) return [];
    claimed.add(mention);
    return mentionFilters(field, mention);
  }
  const vocabulary = termsFor(field, label)
    .map((term) => normalizeSearch(term))
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean)
    .join("|");
  const match = vocabulary ? numericFilter(message, field, vocabulary, true) : undefined;
  if (!match) return [];
  const used = mentions.find(
    (candidate) => !claimed.has(candidate) && candidate.value === match.value,
  );
  if (used) claimed.add(used);
  return [match];
}

function stringFieldFilter(
  message: string,
  field: string,
  definition: MarketplaceCategorySchema["attributes"][string],
): SearchFilter | undefined {
  const matchedOption = (definition.options ?? [])
    .filter((option) => hasPhrase(message, option))
    .sort(
      (a, b) =>
        Number(isNegated(message, normalizeSearch(a))) -
        Number(isNegated(message, normalizeSearch(b))),
    )[0];
  if (matchedOption)
    return {
      field,
      operator: isNegated(message, normalizeSearch(matchedOption))
        ? "ne"
        : "contains",
      value: matchedOption,
    };
  const knownValue = FIELD_VALUE_ALIASES
    .filter((entry) => entry.fields.test(field))
    .flatMap((entry) =>
      entry.phrases.map((phrase) => ({ entry, phrase })),
    )
    .find(({ phrase }) => hasPhrase(message, phrase));
  if (knownValue)
    return {
      field,
      operator: isNegated(message, normalizeSearch(knownValue.phrase)) ? "ne" : "contains",
      value: knownValue.entry.value,
    };

  if (/^model$/i.test(field)) {
    const model = message.match(/(?:^|\s)([a-z]{1,8}[- ]?\d{2,4}[a-z]{0,3})(?=\s|$)/i);
    if (model) return { field, operator: "contains", value: model[1].replace(/\s+/g, "") };
  }

  if (/^(?:city|المدينة)$/i.test(field)) {
    const match = normalizeSearch(message).match(/(?:^|\s)(?:في|بمدينة|مدينة)\s+([\p{L}]+(?:\s+[\p{L}]+){0,2})/u);
    if (match) {
      const place = match[1]
        .split(
          /\s+(?=ثلاث غرف(?: نوم)?|ثلاث حمامات|غرف|حمام|اقل|اكثر|فوق|تحت|السعر|بسعر|سعر|بميزانية|ميزانية|اسود|ابيض|فقط|حصرا)/u,
          1,
        )[0]
        ?.trim();
      if (place) return { field, operator: "contains", value: place };
    }
  }
  return undefined;
}

function filterDefinitions(
  schema: MarketplaceCategorySchema | undefined,
): [string, CategoryAttributeDefinition][] {
  const configured = schema ? allDefinitions(schema) : [];
  const fields = new Set(configured.map(([field]) => field));
  return [
    ...configured,
    ...Object.entries(CORE_SEARCH_FILTERS).filter(([field]) => !fields.has(field)),
  ];
}

function extractFilters(
  message: string,
  schema: MarketplaceCategorySchema | undefined,
): SearchFilter[] {
  const filters: SearchFilter[] = [];
  const mentions = parseNumericMentions(message);
  const claimed = new Set<NumericMention>();
  const definitions = filterDefinitions(schema);
  // Typed numeric fields claim their mentions first, so a later price fallback cannot reuse them.
  const ordered = [
    ...definitions.filter(([field, definition]) => definition.type === "number" && numericKindFor(field) && numericKindFor(field) !== "PRICE"),
    ...definitions.filter(([field, definition]) => !(definition.type === "number" && numericKindFor(field) && numericKindFor(field) !== "PRICE")),
  ];
  const byField = new Map<string, SearchFilter[]>();
  for (const [field, definition] of ordered) {
    if (definition.searchable === false || definition.filterable === false)
      continue;
    const candidates = definition.type === "number"
      ? numericFieldFilters(message, field, definition.label, mentions, claimed)
      : [stringFieldFilter(message, field, definition)].filter(
          (filter): filter is SearchFilter => Boolean(filter),
        );
    if (candidates.length) byField.set(field, candidates);
  }
  for (const [field] of definitions) filters.push(...(byField.get(field) ?? []));
  return filters.slice(0, 12);
}

function mergeFilters(
  previous: readonly SearchFilter[],
  next: SearchFilter[],
): SearchFilter[] {
  const fields = new Set(next.map((filter) => filter.field));
  return [...previous.filter((filter) => !fields.has(filter.field)), ...next];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NUMERIC_CONTEXT_TERMS = [
  // With an attached «ب» and the negated «exceed» forms (W04): «بأقل من 5000», «لا يتعدى 450».
  "باقل من", "باكثر من", "باعلي من", "ما يزيد عن", "لا يزيد عن", "لا يتعدي", "ما يتعدي", "لا يتجاوز", "ما يتجاوز",
  "اقل من", "دون", "تحت", "حد اقصي", "اقصي", "بحد اقصي", "اكثر من", "اعلي من",
  "فوق", "علي الاقل", "الى", "الي", "يساوي", "بالضبط", "من", "بين", "و",
  "بحدود", "حدود", "حوالي", "تقريبا", "وفوق", "وما فوق", "فما فوق", "او اكثر",
  "واكثر", "وطالع", "وتحت", "او اقل", "واقل", "ونازل", "او احدث", "واحدث",
  "بسعر", "بميزانية", "ميزانية", "ميزانيتي", "دينار", "دنانير", "ريال", "ريالات",
  "دولار", "دولارات", "درهم", "فلس", "الف", "الاف", "مليون", "كم", "كيلو",
  "كيلومتر", "متر", "غرف", "غرفة", "غرف نوم", "حمام", "حمامات",
];
const NEGATION_TERMS = [
  "لا اريد", "لا ابغي", "لا ابي", "لا بدي", "ما بدي", "مابدي", "مش بدي", "ما ابي",
  "ما ابغي", "ما اريد", "بدون", "من غير", "مو", "مش", "ليس", "ليست",
];
const LOCATION_TERMS = ["في", "بمدينة", "مدينة", "فقط", "حصرا"];
/**
 * «… وقارن الخيارات», «… وقارن الموجود عندك»: asking to compare what is found — the options, or
 * whatever the market has — shapes the answer, not the product.
 */
const COMPARE_REQUEST =
  /(^|\s)و?قارن(?:ها|هم|لي)?(?:\s+(?:بين|بينها|بينهم))?(?:\s+(?:ال)?(?:خيارات|عروض|نتائج|اسعار|موجود|متوفر|متاح)(?:ها|هم)?(?:\s+(?:عندك|عندكم|لديك|لديكم|عندهم|بالسوق|في السوق|حاليا))?)?(?=\s|$)/gu;
/**
 * «اقتصادية», «موفرة»: a quality the user wants that no listing field records. Like «مميز» or
 * «فخم» (buyer-turn.ts), it never becomes a text every listing must contain.
 */
const UNRECORDED_QUALITY = /(^|\s)(?:اقتصادي|اقتصاديه|اقتصادية|اقتصاديات|موفر|موفره|موفرة)(?=\s|$)/gu;

function stripStructuredTerms(
  normalized: string,
  schema: MarketplaceCategorySchema | undefined,
  filters: readonly SearchFilter[],
  sort?: SearchSort,
): string {
  let text = searchTerms(normalized)
    // Sentence punctuation ends a request; it is never part of a product term («مستعملة.»).
    .replace(/[.!؟?،,]+(?=\s|$)/gu, " ")
    .replace(COMPARE_REQUEST, " ")
    .replace(UNRECORDED_QUALITY, " ");
  const removable = [
    ...(schema
      ? [
          schema.label,
          schema.labelEn,
          schema.id,
          ...schema.aliases.filter((alias) => isCategoryNameAlias(schema, alias)),
        ]
      : []),
    ...filterDefinitions(schema).flatMap(([field, definition]) => [
      ...termsFor(field, definition.label),
      ...(definition.options ?? []),
    ]),
    ...filters.flatMap((filter) =>
      typeof filter.value === "string" ? [filter.value] : [],
    ),
    ...(sort
      ? [
          ...(SORT_ALIASES.find((entry) => entry.sort === sort)?.phrases ?? []),
          // Words that only shape a sort request («رتبها من الأرخص أولا», «حسب السعر من الأقل»).
          ...SORT_FILLER_TERMS,
        ]
      : []),
    ...(filters.some((filter) => typeof filter.value === "number")
      ? NUMERIC_CONTEXT_TERMS
      : []),
    ...(filters.some((filter) => filter.operator === "ne") ? NEGATION_TERMS : []),
    ...(filters.some((filter) => filter.field === "city") ? LOCATION_TERMS : []),
    "وريني", "ورني", "ورينا", "راويني", "ارني", "فرجني", "ورجيني", "اعرض", "اعرضلي", "رتب", "رتبها", "حسب",
  ]
    .filter((term): term is string => Boolean(term))
    .map(normalizeSearch)
    .sort((a, b) => b.length - a.length);
  for (const term of removable) {
    text = text.replace(
      new RegExp(`(^|\\s)${escapeRegExp(term)}(?=\\s|$)`, "g"),
      " ",
    );
  }
  if (filters.some((filter) => typeof filter.value === "number"))
    // Whole numbers only: «256GB» must not backtrack into a stripped «25» and a stray «6gb»,
    // and a segment of a hyphenated code («174f6878-7754-4335») stays with its code.
    text = text
      // An extracted «500-700» / «500 - 700» range goes as one unit.
      .replace(/(?<![\p{L}\p{N}\-–])[0-9][0-9,.]*\s*[-–]\s*[0-9][0-9,.]*(?![\p{L}\p{N}\-–])/gu, " ")
      .replace(/(?<![\p{L}\p{N}\-–])[0-9,.]+(?![\p{L}\p{N}\-–])/gu, " ");
  return text.replace(/\s+/g, " ").trim();
}

function supportedSort(
  sort: SearchSort | undefined,
  schema: MarketplaceCategorySchema | undefined,
): SearchSort | undefined {
  if (!sort || sort === "RELEVANCE") return sort;
  const allowed = schema
    ? schema.rules.sorting.options.map((option) => option.id)
    : GLOBAL_SEARCH_SORTS;
  return (allowed as readonly string[]).includes(sort) ? sort : undefined;
}

/** City values present in real inventory make an uncategorized "في X" a location, not prose. */
function uncategorizedCityFilter(
  filters: SearchFilter[],
  knownCities: readonly string[] | undefined,
): SearchFilter[] {
  const known = new Set((knownCities ?? []).map(normalizeSearch));
  return filters.filter(
    (filter) =>
      filter.field !== "city" ||
      (typeof filter.value === "string" &&
        [...known].some((city) => normalizeSearch(String(filter.value)).startsWith(city))),
  ).map((filter) => {
    if (filter.field !== "city" || typeof filter.value !== "string") return filter;
    const city = [...known].find((candidate) =>
      normalizeSearch(String(filter.value)).startsWith(candidate),
    );
    return city ? { ...filter, value: city } : filter;
  });
}

export function parseStructuredSearch(
  message: string,
  previous?: Partial<SearchQuery>,
  configured?: readonly MarketplaceCategorySchema[],
  options: { knownCities?: readonly string[] } = {},
): SearchQuery | undefined {
  const normalized = normalizeNumberWords(
    normalizeSearch(normalizeDigits(stripCorrectionPrefix(message))),
  )
    // «شو في سيارات …», «في عندكم طاولة؟»: the question frame is not a city («في …») or an item.
    .replace(/^(?:(?:شو|وش|ايش|شنو)\s+(?:في|فيه)|(?:في|فيه|هل)\s+(?:عندكم|لديكم|عندك)|عندكم|لديكم)\s+/u, "")
    // «أرخص من 100», «أوطى من 50»: a comparative before an amount is a ceiling, not a sort
    // («أرخص من الثاني» names a position and is left to the result-set rules).
    .replace(/(?:^|\s)(?:في\s+)?(?:ال)?(?:ارخص|اوطي|انزل)(?:\s+سعر)?\s+من\s+(?=\d)/gu, " اقل من ")
    .replace(/\s+/g, " ")
    .trim();
  const categories = configured ?? [];
  const mentionedCategory = searchCategory(normalized, categories);
  const categoryId = mentionedCategory?.id ?? previous?.categoryId;
  const schema = categoryId
    ? categories.find((category) => category.id === categoryId)
    : undefined;
  if (categoryId && !schema) return undefined;
  const extracted = extractFilters(normalized, schema);
  const nextFilters = schema
    ? extracted
    : uncategorizedCityFilter(extracted, options.knownCities);
  const sort = supportedSort(sortIntent(normalized), schema);
  const clearFilters =
    /(?:امسح|احذف|الغ|الغاء).*(?:الفلاتر|المرشحات|الشروط)|(?:بدون|من غير).*(?:فلاتر|مرشحات)/.test(
      normalized,
    );
  if (
    !mentionedCategory &&
    nextFilters.length === 0 &&
    sort === undefined &&
    !clearFilters
  )
    return undefined;
  const extractedSearch = stripStructuredTerms(
    normalized,
    schema,
    nextFilters,
    sort,
  );
  // Without a category, new product words start a new search; bare constraints refine the last one.
  const attributeWords=nextFilters.filter(filter=>!["price"].includes(filter.field)).flatMap(filter=>normalizeSearch(String(filter.value)).split(/\s+/u));
  const attributeOnly=Boolean(extractedSearch) && extractedSearch.split(/\s+/u).every(word=>attributeWords.some(value=>tokenVariants(word).some(form=>tokenVariants(value).includes(form))));
  const refinesPrevious = schema
    ? previous?.categoryId === categoryId && (!extractedSearch || attributeOnly || normalizeSearch(extractedSearch) === normalizeSearch(previous?.search ?? ""))
    : previous !== undefined && !previous.categoryId && !extractedSearch;
  const previousFilters = refinesPrevious ? previous?.filters ?? [] : [];
  const filters = clearFilters
    ? []
    : mergeFilters(previousFilters, nextFilters);
  const search = schema
    ? refinesPrevious && !mentionedCategory
      ? previous?.search ?? ""
      : extractedSearch || (refinesPrevious ? previous?.search : "") || ""
    : extractedSearch || (refinesPrevious ? previous?.search ?? "" : "");
  const effectiveSort =
    sort ?? (clearFilters ? "RELEVANCE" : refinesPrevious ? previous?.sort : undefined);
  return {
    search,
    ...(categoryId ? { categoryId } : {}),
    filters,
    ...(effectiveSort ? { sort: effectiveSort } : {}),
  };
}
