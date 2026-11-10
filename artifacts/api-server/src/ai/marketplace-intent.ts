import type {
  MarketplaceCategorySchema,
  SearchQuery,
} from "@workspace/api-zod/marketplace-schemas";
import {
  hasNegation,
  findOrdinalMention,
  normalizeMarketplaceText,
  parseNumericMentions,
  parseResultReference,
  type NumericMention,
  type ResultReference,
} from "./arabic-normalization";
import { backIntent, stripCorrectionPrefix, marketplaceComparisonSearchTerms } from "./intent";
import { parseStructuredSearch } from "./search-query";

/**
 * Typed buyer-side marketplace intent. Seller drafting, seller listing management,
 * orders and navigation surfaces keep their existing authorities upstream.
 */
export type MarketplaceIntentKind =
  | "SEARCH"
  | "REFINE_SEARCH"
  | "SORT_RESULTS"
  | "OPEN_RESULT"
  | "BACK_TO_RESULTS"
  | "CLARIFY"
  | "UNKNOWN";

export type MarketplaceAmbiguity =
  | "NO_CURRENT_RESULTS"
  | "RESULT_OUT_OF_RANGE"
  | "VAGUE_REQUEST"
  | "NEGATION_WITHOUT_CONTEXT";

export type MarketplaceTurnIntent = {
  intent: MarketplaceIntentKind;
  query?: SearchQuery;
  resultReference?: ResultReference;
  /** Zero-based position resolved against the current result set, when one exists. */
  selectedIndex?: number;
  numbers: NumericMention[];
  ambiguities: MarketplaceAmbiguity[];
  confidence: "HIGH" | "LOW";
};

export type MarketplaceTurnContext = {
  /** Structured state of the latest live buyer result set in this conversation. */
  previous?: SearchQuery;
  /** Number of results in that set; undefined when there is no current set. */
  currentResultCount?: number;
  categories: readonly MarketplaceCategorySchema[];
  knownCities?: readonly string[];
};

// Words that carry no product meaning on their own ("أريد شيء رخيص").
const VAGUE_WORDS = new Set([
  "شي", "شيء", "شيئ", "اشي", "حاجة", "حاجه", "غرض", "اغراض", "منتج", "منتجات",
  "اي", "اشياء", "رخيص", "رخيصة", "رخيصه", "حلو", "حلوة", "منيح", "منيحة",
  "جيد", "جيدة", "كويس", "كويسة", "مناسب", "مناسبة", "اريد", "بدي", "ابي", "ابغي",
  "ابحث", "عن", "اشتري", "شراء", "خدمة", "خدمه", "ممكن", "لو", "سمحت", "من", "فضلك",
  "لا", "مو", "مش", "هذا", "هاذا", "هاد", "هذه", "هذي", "ذلك", "not", "that", "this",
  "عندكم", "عندك", "في", "هل", "يوجد", "بس",
]);

export function isVagueRequest(message: string): boolean {
  const words = normalizeMarketplaceText(message)
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 && words.every((word) => VAGUE_WORDS.has(word));
}

export const EXPLICIT_SEARCH_ACTION =
  /(?:^|\s)(?:ابحث(?:\s+لي)?|ابحثلي|ادور|دور(?:\s+لي)?|دورلي|دورولي|فتش|فتشلي|شوف\s+الموجود|شوفلي|شوف\s+لي|شوفي\s+لي|شوف\s+(?:اذا|ان\s+كان|لو)\s+(?:في|فيه|يوجد)|جيبلي|جيب\s+لي|هاتلي|هات\s+لي|لقيلي|لاقيلي|طالعلي|فرجني|وريني|ورني|ورينا|راويني|ارني|اعرض|search|find|look\s+for|show\s+me)(?=\s|$)/u;
const MARKETPLACE_REQUEST_ACTION =
  /(?:^|\s)(?:اريد|ابي|ابغي|ابغا|ابا|احتاج|بدي|ودي|حاب|نفسي|ابغى|عايز|عاوز|محتاج|محتاجه|نبي|نبغى|نبغي|بدنا)\s/u;
/**
 * «في عندكم طاولة؟», «عندكم خدمة تنظيف؟», «شو في سيارات تويوتا»، «مين يصمم شعارات»: asking
 * whether the market has something is a search. Each form needs an item word after it.
 */
const MARKETPLACE_QUESTION =
  /^(?:(?:في|فيه|هل|شو|وش|ايش|شنو)\s+)?(?:عندكم|لديكم|عندك)\s+(?:من\s+)?(?!وقت|مشكله|سؤال|فكره|علم)\S{2,}|^(?:شو|وش|ايش|شنو)\s+(?:في|فيه)\s+\S{3,}|^مين\s+(?!(?:ب|بي)?(?:يقدر|يعرف|يساعد|يفهم|يحكي|يقول|قدر|عرف|ساعد))(?:ي|ب|بي)\S{3,}(?:\s+\S+)?/u;
/**
 * «ابي اتعلم …», «بدي افهم …», «حاب اسافر …»: wanting to do an activity (learn, understand,
 * write, plan, travel, talk) is not wanting an item. Acquisition verbs (اشتري، اطلب) stay searches.
 */
const WANT_ACTIVITY =
  /(?:^|\s)(?:اريد|ابي|ابغي|احتاج|بدي|ودي|حاب|نفسي|ابغى)\s+(?:ان\s+)?(?:اتعلم|نتعلم|افهم|اعرف|ادرس|اقرا|اكتب|اسافر|اتكلم|اتحدث|اسال|احسب|اخطط|اطور|احسن|اتدرب|اتمرن|افكر|اشرح|اترجم|انام|اتعرف)(?:\s|$)/u;
/**
 * «كم لوح احتاج لبيت صغير؟», «كيف احتاج اتعلم؟»: a how-many/how/why/when question about a
 * need asks for an answer, it is not a request to buy. Expects normalized text.
 */
export const NEED_QUESTION = /^(?:(?:طيب|طب|اوكي|و)\s+)?(?:كم|كيف|ليش|لماذا|متى)\s/u;
/** A bare topic is not a search, but a concrete want/need request is. */
/**
 * «جيبلي فكرة مشروع», «شوفلي حل لمشكلتي», «دورلي على طريقة …»: the object of the fetch/search
 * verb is something to think or write, not an item; the request is general help.
 */
const ABSTRACT_OBJECT =
  /(?:^|\s)(?:ابحث|ابحثلي|دور|دورلي|دورولي|شوفلي|شوف|شوفي|جيبلي|جيب|هاتلي|هات|لقيلي|لاقيلي|طالعلي|فتشلي)(?:\s+لي)?(?:\s+(?:عن|على|علي))?\s+(?:ال)?(?:فكره|افكار|حل|حلول|طريقه|طرق|نصيحه|نصائح|معلومه|معلومات|جواب|اجابه|شرح|خطه|اسم|اسماء|موضوع|مواضيع|سبب|اسباب|راي|رايك|معني|تفسير|ترجمه|ملخص|مقال|قصه|نكته|شعر)(?:\s|$)/u;

export function hasExplicitMarketplaceSearchIntent(message: string): boolean {
  const normalized = normalizeMarketplaceText(stripCorrectionPrefix(message));
  if (ABSTRACT_OBJECT.test(normalized.replace(/ة/g, "ه")) || /^(?:ابي|اريد)\s+(?:على\s+)?(?:فكره|فكرة|حل|طريقه|طريقة)(?:\s|$)/u.test(normalized)) return false;
  if (EXPLICIT_SEARCH_ACTION.test(normalized)) return true;
  const correction = normalizeMarketplaceText(stripCorrectionPrefix(message));
  if (correction !== normalizeMarketplaceText(message))
    return correction.length > 0 && !isVagueRequest(correction);
  if (marketplaceComparisonSearchTerms(normalized) !== undefined && !isVagueRequest(normalized))
    return true;
  if (MARKETPLACE_QUESTION.test(normalized) && !isVagueRequest(normalized)) return true;
  return (
    MARKETPLACE_REQUEST_ACTION.test(normalized) &&
    !WANT_ACTIVITY.test(normalized) &&
    !NEED_QUESTION.test(normalized) &&
    !isVagueRequest(normalized) &&
    !/(?:^|\s)(?:ابيع|بيع|اعرض\s+خدمتي|انشر\s+اعلاني)(?:\s|$)/u.test(normalized)
  );
}

/** Catalog data is needed only for explicit searches and marketplace-result refinements. */
export function needsMarketplaceCategoryContext(
  message: string,
  intent: MarketplaceIntentKind,
  previous?: Pick<SearchQuery, "categoryId">,
): boolean {
  return (
    hasExplicitMarketplaceSearchIntent(message) ||
    intent === "SEARCH" ||
    intent === "REFINE_SEARCH" ||
    intent === "SORT_RESULTS" ||
    // A categorized result set can only be refined with its category schema, which the
    // catalog-free first pass lacks: «من 2020 وفوق» or «أرخص» read as UNKNOWN there.
    (intent === "UNKNOWN" && Boolean(previous?.categoryId))
  );
}

export function interpretMarketplaceTurn(
  message: string,
  context: MarketplaceTurnContext,
): MarketplaceTurnIntent {
  const normalized = normalizeMarketplaceText(stripCorrectionPrefix(message));
  const numbers = parseNumericMentions(normalized);
  const asksForDetails =
    /(?:تفاصيل|معلومات|مواصفات|(?:وش|شو|ايش|شنو|ماذا|ما)\s+(?:يقدم|تقدم|فيه|فيها|يشمل|تشمل|يحتوي|تحتوي))/u.test(normalized);
  // Detail questions may include an ordinal plus a natural-language suffix:
  // «الأول وش يقدم؟». Resolve that ordinal against the same persisted result set.
  const reference =
    parseResultReference(message) ??
    (asksForDetails ? findOrdinalMention(message) : undefined);
  if (reference) {
    if (context.currentResultCount === undefined || context.currentResultCount === 0)
      return {
        intent: "CLARIFY",
        resultReference: reference,
        numbers,
        ambiguities: ["NO_CURRENT_RESULTS"],
        confidence: "HIGH",
      };
    const index =
      reference.kind === "LAST" ? context.currentResultCount - 1 : reference.index;
    if (index >= context.currentResultCount)
      return {
        intent: "CLARIFY",
        resultReference: reference,
        numbers,
        ambiguities: ["RESULT_OUT_OF_RANGE"],
        confidence: "HIGH",
      };
    return {
      intent: "OPEN_RESULT",
      resultReference: reference,
      selectedIndex: index,
      numbers,
      ambiguities: [],
      confidence: "HIGH",
    };
  }

  if (backIntent(message))
    return context.currentResultCount === undefined
      ? { intent: "CLARIFY", numbers, ambiguities: ["NO_CURRENT_RESULTS"], confidence: "HIGH" }
      : { intent: "BACK_TO_RESULTS", numbers, ambiguities: [], confidence: "HIGH" };

  const correctionValue = normalizeMarketplaceText(
    stripCorrectionPrefix(message),
  );
  if (
    correctionValue !== normalized &&
    (!correctionValue || isVagueRequest(correctionValue))
  )
    return {
      intent: "CLARIFY",
      numbers,
      ambiguities: ["VAGUE_REQUEST"],
      confidence: "HIGH",
    };

  const query = parseStructuredSearch(stripCorrectionPrefix(message), context.previous, context.categories, {
    knownCities: context.knownCities,
  });
  if (query) {
    const previous = context.previous;
    const sameScope =
      previous !== undefined &&
      previous.categoryId === query.categoryId &&
      previous.search === query.search;
    const sortOnly =
      sameScope &&
      query.sort !== previous.sort &&
      JSON.stringify(query.filters) === JSON.stringify(previous.filters);
    return {
      intent: sortOnly ? "SORT_RESULTS" : sameScope ? "REFINE_SEARCH" : "SEARCH",
      query,
      numbers,
      ambiguities: [],
      confidence: "HIGH",
    };
  }

  if (isVagueRequest(message))
    return { intent: "CLARIFY", numbers, ambiguities: ["VAGUE_REQUEST"], confidence: "HIGH" };
  if (hasNegation(normalized) && !context.previous?.categoryId)
    return {
      intent: "CLARIFY",
      numbers,
      ambiguities: ["NEGATION_WITHOUT_CONTEXT"],
      confidence: "HIGH",
    };
  // Free-text product search; the caller applies the existing contextual query rules.
  return { intent: "UNKNOWN", numbers, ambiguities: [], confidence: "LOW" };
}

export function clarificationPrompt(
  ambiguities: readonly MarketplaceAmbiguity[],
  currentResultCount?: number,
): string {
  if (ambiguities.includes("RESULT_OUT_OF_RANGE"))
    return `النتائج الحالية فيها ${currentResultCount ?? 0} فقط. اختر رقمًا ظاهرًا في القائمة.`;
  if (ambiguities.includes("NO_CURRENT_RESULTS"))
    return "لا توجد نتائج حالية في هذه المحادثة لأختار منها. اكتب ما تبحث عنه أولًا.";
  if (ambiguities.includes("NEGATION_WITHOUT_CONTEXT"))
    return "ما نوع المنتج أو الخدمة الذي تبحث عنه؟ بعدها أستبعد ما لا تريده.";
  return "ما نوع المنتج أو الخدمة الذي تبحث عنه؟ اذكر النوع وسأعرض لك المتاح في سوقك، ويمكنك بعدها طلب الأرخص.";
}
