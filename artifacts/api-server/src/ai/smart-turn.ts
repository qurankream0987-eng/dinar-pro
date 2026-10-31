/**
 * G2 — smart conversation inside the one shared DINAR runtime.
 *
 * CONVERSATION → UNDERSTAND → DISCUSS → ADVISE → (CLARIFY only when needed) →
 * SEARCH / COMPARE / EXPLAIN → PROPOSE → USER DECIDES → DINAR AUTHORITY EXECUTES.
 *
 * Not an agent and not a mode: one adapter that claims only discussion turns —
 * a buyer consultation, advice on the current results or on a pending action, an
 * explanation, an interruption or a resume — and otherwise passes. Every number it
 * states is computed here from DINAR rows (count, min, max, median); every listing it
 * names comes from a persisted result set; it never mutates anything. The optional
 * model fallback (model-turn.ts) is reached only for genuinely open turns.
 */
import { aiRoutingMode, canonicalRequestProblem } from "./routing-mode";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { CONVERSATION_SURFACE_FAMILIES, capabilityUtterance, type ProductCapabilityId } from "@workspace/api-zod/conversation-runtime";
import { countryByCode } from "@workspace/global";
import { aiResultSets, aiUiBlocks, candidateProfiles, db, messages, offers } from "@workspace/db";
import { isMarketAvailable, type marketFor } from "../lib/markets";
import type { ListingRecord } from "../lib/dinar-data";
import { categorySchema, listMarketplaceCategories } from "../lib/marketplace-categories";
import { publishedListingCities, searchMarketplaceListings } from "../lib/marketplace-listings";
import { comparablePrices } from "../lib/recommendations";
import { servingCampaignsFor } from "../lib/promotions";
import {
  hasExplicitMarketplaceSearchIntent,
  interpretMarketplaceTurn,
  NEED_QUESTION,
} from "./marketplace-intent";
import {
  type BuyerState,
  latestListingSet,
  normalizeBuyerText,
  rankListings,
  runBuyerSearch,
  stateOf,
} from "./buyer-turn";
import { executeSellerAdviceTurn, makeSellerContextResult } from "./seller-management";
import { resumeNamedDraft } from "./draft-actions";
import { ConversationDraft, buildDraftReview, isGeneralRequest } from "./listing-draft";
import { conversationGuidance } from "./conversation-guidance";
import { AIProviderError, type ConversationModelGateway, type ReasoningEffort } from "./model-gateway";
import {
  interpretWithModel,
  modelGatewayFor,
  HISTORY_SCAN_ROWS,
  type ModelResult,
  type ModelTurn,
  type ClaimKind,
  type ModelContext,
  type ModelFailure,
} from "./model-turn";
import { claimsCompletedAction, enforceModelAuthority, recentActionReceipts } from "./action-receipts";
import { AUTH_RATE_LIMIT_SCOPE, consumeRateLimit } from "../lib/auth-rate-limiter";
import { escalatesAfterLight, gatewayForTier, heavyTurnLimit, modelTieringEnabled, selectModelTier, type ModelTier, type TierDecision, type TierReason, type TierRoute } from "./model-tier";
import { aiUsagePolicyFor, aiUsageSummary, reserveAiUsage, settleAiUsage, type AiUsageOutcome, type AiUsageOwner, type AiUsageRefusal } from "../lib/ai-usage";
import { modelPricingAcceptable } from "../lib/ai-spend";
import { businessPlans, planAiTier } from "../lib/business";
import { nearLimitNote, PLAN_HINT_MARKER, usageLimitMessage, usageResourceFor } from "./usage-turn";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger";
import type { AiCallRecord } from "../lib/ai-spend";
import { normalizeSearch } from "./search-context";
import { isMarketingRequest, sellerListingFacts, unsupportedCopyClaims } from "./seller-management";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };
type Input = { conversationId: string; message: string; market: Market; actorId?: string; requestKey?: string; reasoningEffort?: ReasoningEffort };

export const SMART_SURFACES = CONVERSATION_SURFACE_FAMILIES.smart;
/** Conversation state rows written by this layer; never a listing result set. */
export const SMART_STATE_KINDS = ["CONSULTATION", "CONVERSATION", "NEGOTIATIONS"];
const CONSULTATION_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Phrases ─────────────────────────────────────────────────────────────────

const WANT = "(?:ابي|ابغي|ابغا|ابا|اريد|ودي|بدي|حاب|نفسي)";
const UNSURE = /(?:^|\s)(?:محتار|محتاره|متردد|متردده|ما ادري|مادري|ما اعرف|مش عارف|مو عارف|مش متاكد|مو متاكد|ما اعرف وش)(?:\s|$)/u;
const CONSULT_ITEM = new RegExp(`(?:${WANT}\\s+)?(?:اشتري|اخذ|اختار)\\s+(\\S+(?:\\s+\\S+)?)|${WANT}\\s+(\\S+(?:\\s+\\S+)?)`, "u");
/** Everyday names for a product resolved to the word DINAR's catalogue uses. */
const ITEM_SYNONYMS: Record<string, string> = { تلفون: "جوال", تليفون: "جوال", موبايل: "جوال", فون: "جوال", هاتف: "جوال" };
const ITEM_STOP = /^(?:اشتري|اخذ|اختار|بس|لكن|وش|شو|شي|شيء|حاجه|اعرف|ادري|منتج)$/u;
const SHOW = /(?:^|\s)(?:شوف|وريني|ورني|اعرض|اعرضلي|طلع|طلعلي|دور|دورلي|ابحث)(?:\s+(?:لي|الموجود|اللي عندك|عندك|الموجود عندك|الخيارات))*$|(?:وش|شو|ايش|شنو) (?:عندك|الموجود|فيه|في)(?:\s|$)|الموجود عندك/u;
const IMPORTANT = /(?:^|\s)(?:يهمني|تهمني|مهمه لي|مهم لي|اهم شي)(?:\s|$)/u;
const SELLING = /(?:^|\s)(?:ابيع|بيع|اعرض للبيع|انشر)(?:\s|$)/u;
const BUDGET = /(?:حدي|ميزانيتي|ميزانيه|بحدود|حدود|اقل من|تحت|لحد|ما يتعدي|ما يزيد عن|اقصي|الحد)\s*(?:هو\s+)?(\d+(?:\.\d+)?)/u;
const PREFERENCES: [RegExp, string, string][] = [
  [/(?:^|\s)(?:ال)?سعر(?:ه|ها)?(?:\s|$)|(?:^|\s)رخيص|(?:^|\s)ارخص/u, "PRICE", "السعر"],
  [/بطاري/u, "BATTERY", "البطارية"],
  [/(?:^|\s)(?:ال)?حال(?:ه|ته|تها)(?:\s|$)|نظيف|جديد/u, "CONDITION", "الحالة"],
  [/كامير|تصوير/u, "CAMERA", "الكاميرا"],
  [/(?:^|\s)(?:ال)?(?:مساحه|تخزين|ذاكره|جيجا|gb)(?:\s|$)/u, "STORAGE", "المساحة"],
  [/(?:^|\s)(?:ال)?(?:لون|اللون)(?:\s|$)/u, "COLOR", "اللون"],
  [/(?:^|\s)(?:ال)?(?:مقاس|قياس|سايز)(?:\s|$)/u, "SIZE", "المقاس"],
  [/(?:^|\s)(?:قريب|قريبه|توصيل)(?:\s|$)/u, "NEARBY", "القرب"],
];
const PREFERENCE_LABEL = Object.fromEntries(PREFERENCES.map(([, key, label]) => [key, label]));
const ADVISE_RESULTS =
  /^(?:طيب\s+|و\s*)?(?:و?ش|شو|ايش|شنو|ماذا|بماذا|بشو)\s+(?:تنصحني|تنصح|تقترح|تختار|ترشح|رايك|راي?ك فيها)(?:\s+(?:انت|فيهم|منهم|فيها|منها))*$|(?:^|\s)انصحني(?:\s|$)|(?:^|\s)(?:وش|شو|ايش) تختار انت|ايهم (?:احسن|تنصح|تختار)|(?:وش|شو|ايش|شنو) (?:الافضل|الاحسن) (?:لي|لك|فيهم)/u;
const NOT_ADVICE = /بدائل|مشابه|شبيه|ارخص/u;
const QUESTION = /[؟?]|(?:^|\s)(?:تشوف|تحس|رايك|راي|تنصح|تنصحني|مناسب|معقول|ينفع|يستاهل|هل)(?:\s|$)/u;
const BARE_DECISION = /^(?:(?:تمام|طيب|اوكي|خلاص)\s+)?(?:نعم|لا|اكيد|اكد|تاكيد|موافق|تمام|اوكي|نفذ|الغاء|الغ|الغي|تراجع|ارسل|ارسال العرض|قدم العرض|ابعث العرض|رفض|قبول|اقبل)$/u;
// The object ends a word: «قابل للتفاوض، عندي جهاز» is a pricing statement, not «فاوض عني».
const AUTONOMOUS = /فاوض(?:ه|ها|هم)?\s+(?:عني|بدالي|بدلي|عن)(?=\s|$)|(?:خلك|خليك)\s+تفاوض|تفاوض (?:عني|بدالي)(?=\s|$)|ساوم(?:ه|ها)?\s+(?:عني|بدالي)(?=\s|$)|(?:ساوم|فاوض)\s+لين|حتي يوصل|لين يوصل/u;
const OFFER_ADVICE = /(?:كم|بكم)\s+(?:اعرض|اعطيه|اعطيها|ادفع)(?:\s+(?:عليه|عليها|فيه|فيها))?|(?:وش|شو|ايش) (?:رايك|تقترح|تنصح) (?:اعرض|اعطيه|ادفع)/u;
const PROVIDER_EXPLAIN =
  /(?:وش|شو|ايش|شنو|ما|ماهو|ما هو)\s+(?:هو\s+)?الفرق.*(?:اربط|ربط|متجري|نظامي|api)|(?:كيف|ليش|شلون|متي)\s+(?:اربط|ربط)\s+(?:متجري|نظامي|متجر)\s*[؟?]|(?:تدعمون|تدعم|مربوطين|مربوط|تشتغلون مع|متكاملين مع)\s+(?:مع\s+)?(?:شوبيفاي|shopify|ووكومرس|woocommerce|طلبات|talabat|كريم|careem)/iu;
const ESTIMATE = /(?:كم|بكم)\s+(?:تتوقع|تتوقعين|يسوي|يسوا|يسوى|تقدر|تقيم|تثمن)\s+(?:سعر\s+)?(.{2,60})$|(?:وش|شو|ايش|شنو)\s+(?:تحس|تشوف|رايك|راي)\s+(?:ب)?(?:ال)?سعر\s+(?:ال)?مناسب/u;
const URGENT =
  new RegExp(`${WANT}\\s+(?:ابيعه|ابيعها|ابيع|بيعه|بيعها|اصرفه|اصرفها)\\s+(?:بسرعه|اليوم|باسرع وقت|عاجل|ضروري|سريع)|(?:كيف|شلون)\\s+(?:ابيعه|ابيعها|ابيع)\\s+(?:بسرعه|اسرع)|متي\\s+(?:ينباع|يتباع|راح ينباع|بينباع)|(?:راح|بي|بـ?)\\s*ينباع\\s+(?:اليوم|بسرعه)`, "u");
const PROMOTION_ADVICE = /(?:تنصحني|تنصح|رايك|راي|يستاهل|ينفع|يفيد)\s*(?:اني\s+|ان\s+)?(?:اروج|ترويج|اسوي ترويج|اعلن عن|امول)/u;
const INTERRUPT_SEARCH = /^((?:(?:لحظه|لحظة|طيب|بس|خلني|قبل|اسمع|استنى|استني|ثانيه|الحين|الان|هلا|هسا|هسه|والحين)\s+)*)(?:دور(?:\s*لي)?(?:\s+على|\s+علي)?|ابحث(?:\s+لي)?(?:\s+عن)?|شوف(?:\s+لي)?|ابي اشتري|ابغي اشتري|اريد اشتري)\s+(.+)$/u;
const RESUME_NAMED = /^(?:رجعنا|رجعني|ارجع|ارجعني|نرجع|خلنا نرجع|خلينا نرجع|ارجع لي)\s+(?:لل|ل|الى|الي|على|علي|عل)\s*(.{2,60})$/u;
const NOT_RESUMABLE = /^(?:ال)?(?:نتائج|قائمه|قائمة|بحث|خلف|سابق|السابقه|البدايه)$/u;
const DRIVER_JOB_CORRECTION = /^(?:لا\s+)?(?:مو|مش|ما|لا)\s*(?:اقصد|قصدي)\s+.*(?:اشتغل|اعمل|اسوق)\s+(?:سايق|سائق|مندوب|كابتن)\s+(?:مع|داخل|في|عند|ب)\s*دينار/u;

const DESCRIPTION_REQUEST = /(?:اكتب|صيغ|صغ|رتب|جهز)(?:\s+لي)?\s+(?:ال)?وصف|وصف\s+(?:حلو|احترافي|مرتب)/u;
const CANDIDATE_WORDING = /(?:حسن|اكتب|صيغ|صغ|رتب)(?:\s+لي)?\s+(?:نبذتي|نبذه عني|النبذه|سيرتي|ملخصي|وصفي المهني)/u;

const formatMinor = (minor: number, market: Market) => (minor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale).replace(/\.?0+$/, "") || "0";

// ─── Deterministic statistics ────────────────────────────────────────────────

export type InternalStats = { count: number; minMinor: number | null; maxMinor: number | null; medianMinor: number | null };

/** count/min/max/median over integer minor units; the median needs at least three values. */
/** Statistics as the client shows them: minor units plus the market's scale. */
const statsView = (stats: InternalStats, market: Market) => ({ ...stats, minorUnitScale: market.minorUnitScale });

export function priceStats(pricesMinor: number[]): InternalStats {
  const values = pricesMinor.filter((value) => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    count: values.length,
    minMinor: values[0] ?? null,
    maxMinor: values.at(-1) ?? null,
    medianMinor: values.length >= 3 ? (values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2) : null,
  };
}

const minorOf = (listing: ListingRecord, market: Market) =>
  listing.unitPrice === null || listing.pricingMode !== "FIXED" ? null : Math.round(Number(listing.unitPrice) * 10 ** market.minorUnitScale);

/** Comparable published listings found by the canonical search for the words the user named. */
async function textComparables(market: Market, item: string, excludeSellerId?: string): Promise<InternalStats & { item: string }> {
  const [categories, knownCities] = await Promise.all([listMarketplaceCategories(), publishedListingCities(market.id)]);
  const run = async (words: string) => {
    const interpreted = interpretMarketplaceTurn(words, { categories: categories.map(categorySchema), knownCities });
    const query = interpreted.intent === "SEARCH" && interpreted.query ? interpreted.query : { search: words, filters: [], categoryId: undefined };
    return searchMarketplaceListings(market, {
      search: query.search,
      conversational: true,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      sponsoredPlacement: false,
      limit: 200,
    });
  };
  let found = await run(item);
  // «آيفوني»: a possessive ending is not part of the product name.
  if (!found.length && /ي$/u.test(item)) found = await run(item.replace(/ي$/u, ""));
  const prices = found
    .filter((listing) => listing.sellerId !== excludeSellerId)
    .map((listing) => minorOf(listing, market))
    .filter((value): value is number => value !== null);
  return { ...priceStats(prices), item };
}

function statsSentence(stats: InternalStats, market: Market, subject = "إعلانات مشابهة"): string {
  if (!stats.count) return `لا توجد ${subject} كافية داخل DINAR للمقارنة.`;
  const range = stats.count > 1 ? `بين ${formatMinor(stats.minMinor!, market)} و${formatMinor(stats.maxMinor!, market)} ${market.currencyCode}` : `بسعر ${formatMinor(stats.minMinor!, market)} ${market.currencyCode}`;
  const median = stats.medianMinor !== null ? `، الوسيط ${formatMinor(stats.medianMinor, market)}` : "";
  return `بناءً على ${stats.count} ${stats.count === 1 ? "إعلان مشابه" : subject} داخل DINAR: ${range}${median}.`;
}

function relation(valueMinor: number, stats: InternalStats, market: Market): string {
  if (!stats.count) return "";
  if (valueMinor < stats.minMinor!) return ` ${formatMinor(valueMinor, market)} أقل من كل الإعلانات المشابهة الحالية.`;
  if (valueMinor > stats.maxMinor!) return ` ${formatMinor(valueMinor, market)} أعلى من كل الإعلانات المشابهة الحالية.`;
  if (stats.medianMinor !== null)
    return valueMinor <= stats.medianMinor
      ? ` ${formatMinor(valueMinor, market)} ضمن النطاق وعند الوسيط أو أقل منه.`
      : ` ${formatMinor(valueMinor, market)} ضمن النطاق وأعلى من الوسيط.`;
  return ` ${formatMinor(valueMinor, market)} ضمن النطاق الحالي.`;
}

// ─── Turns ───────────────────────────────────────────────────────────────────

/** An ADVICE answer. Unrelated answers are stored as a CONVERSATION step; related ones are not. */
function adviceTurn(
  prompt: string,
  advice: Record<string, unknown>,
  extra: Partial<ToolResult> & { relatesToAction?: string; ownerId?: string } = {},
): Turn {
  const { ownerId, ...rest } = extra;
  return {
    tool: "smartConversation",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "ADVICE",
      resultSetId: randomUUID(),
      query: extra.relatesToAction ? {} : { kind: "CONVERSATION", ownerId: ownerId ?? null },
      listings: [],
      advice,
      prompt,
      ...rest,
    },
  };
}

async function recentSets(conversationId: string, marketId: string) {
  return db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(12);
}

const live = (set: { expiresAt: Date | null }) => !set.expiresAt || set.expiresAt.getTime() > Date.now();

type Consultation = { kind: "CONSULTATION"; ownerId: string; goal: "BUY"; item: string; budget?: number; preferences: string[] };

function preferencesIn(text: string): string[] {
  return PREFERENCES.filter(([pattern]) => pattern.test(text)).map(([, key]) => key);
}

function consultationItem(text: string): string | undefined {
  const match = text.match(CONSULT_ITEM);
  const words = (match?.[1] ?? match?.[2] ?? "").split(" ").filter((word) => word && !ITEM_STOP.test(word));
  const item = words
    .slice(0, 2)
    .map((word) => ITEM_SYNONYMS[word] ?? word)
    .join(" ")
    .replace(/\s+(?:بس|لكن|و)$/u, "")
    .trim();
  return item.length >= 2 ? item : undefined;
}

function consultationTurn(state: Consultation, prompt: string): Turn {
  return {
    tool: "smartConversation",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "ADVICE",
      resultSetId: randomUUID(),
      query: state,
      listings: [],
      advice: {
        kind: "CONVERSATIONAL_RESPONSE",
        goal: "BUY",
        item: state.item,
        ...(state.budget ? { budget: state.budget } : {}),
        preferences: state.preferences.map((key) => PREFERENCE_LABEL[key] ?? key),
        scope: "CONVERSATION",
      },
      prompt,
    },
  };
}

async function consultationSearch(market: Market, state: Consultation): Promise<Turn> {
  const [categories, knownCities] = await Promise.all([listMarketplaceCategories(), publishedListingCities(market.id)]);
  const interpreted = interpretMarketplaceTurn(state.item, { categories: categories.map(categorySchema), knownCities });
  const query = interpreted.intent === "SEARCH" && interpreted.query ? interpreted.query : { search: state.item, filters: [], categoryId: undefined };
  const ranking: BuyerState["ranking"] = state.preferences.includes("CONDITION") ? "CONDITION_FIRST" : state.preferences.includes("PRICE") ? "CHEAPEST" : "DEFAULT";
  const result = await runBuyerSearch(market, {
    search: query.search,
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    filters: query.filters.filter((filter) => filter.field !== "price"),
    ...(state.budget ? { maxPrice: state.budget } : {}),
    ranking,
    preferences: state.preferences,
    goal: "BUY",
  } as BuyerState);
  const buyer = result.query.buyer as { message?: string };
  buyer.message = `بحثت داخل DINAR فقط${state.budget ? ` بحد ${state.budget} ${market.currencyCode}` : ""}. ${buyer.message ?? ""}${result.listings.length ? " اسألني «وش تنصحني؟» وأشرح لك أي واحد يناسب ما يهمك." : ""}`.trim();
  return { tool: "buyerSearch", version: 1, result };
}

/** Advice on the persisted results only: real listing facts, the buyer's stated preferences, unknowns named. */
async function adviseOnResults(input: Input & { actorId: string }): Promise<Turn | null> {
  const set = await latestListingSet(input.conversationId, input.market.id);
  if (!set?.resourceIds.length) return null;
  const state = stateOf(set);
  const stored = (state as Record<string, unknown> | undefined)?.preferences;
  const preferences = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
  const live = await searchMarketplaceListings(input.market, { search: "", allowedIds: set.resourceIds, limit: 24 });
  const byId = new Map(live.map((listing) => [listing.id, listing]));
  // Paid placement never earns a recommendation.
  const candidates = set.resourceIds.map((id) => byId.get(id)).filter((listing): listing is ListingRecord => Boolean(listing) && !listing!.isSponsored);
  if (!candidates.length) return adviceTurn("العروض في نتائجك الحالية لم تعد متاحة؛ لا أستطيع النصح بناءً على بيانات قديمة.", { kind: "GROUNDED_ADVICE", scope: "DINAR_INTERNAL", resultSetId: set.id }, { ownerId: input.actorId });
  const ranking: BuyerState["ranking"] = preferences.includes("CONDITION") ? "CONDITION_FIRST" : "BEST_VALUE";
  const { ordered, reasons } = rankListings(candidates, { ...(state ?? { search: "", filters: [] }), ranking } as BuyerState);
  const best = ordered[0]!;
  const position = set.resourceIds.indexOf(best.id) + 1;
  const why = [...(reasons[best.id] ?? [])];
  const budget = (state as { maxPrice?: number } | undefined)?.maxPrice;
  if (budget && best.unitPrice !== null) why.push(`ضمن حدك ${budget} ${input.market.currencyCode}`);
  const available = best.inventoryMode === "UNLIMITED" ? null : (best.availableQuantity ?? 0) - best.reservedQuantity;
  if (available !== null) why.push(available > 0 ? `متوفر (${available})` : "غير متوفر حاليًا");
  const attributeText = normalizeBuyerText([best.title, best.description, ...Object.values(best.attributes ?? {})].join(" "));
  const unknowns = preferences
    .filter((key) => ["BATTERY", "CAMERA", "STORAGE", "SIZE", "COLOR"].includes(key))
    .filter((key) => !preferencesIn(attributeText).includes(key))
    .map((key) => PREFERENCE_LABEL[key]!);
  const prompt = [
    `من نتائجك الحالية داخل DINAR أنصحك بالعرض رقم ${position}: «${best.title}» بسعر ${best.unitPrice ?? "بالاتفاق"} ${best.currency}.`,
    why.length ? `السبب: ${why.join("، ")}.` : "",
    unknowns.length ? `${unknowns.join(" و")} غير مذكورة في الإعلان، فلم أفترض قيمتها؛ اسأل البائع عنها.` : "",
    "هذا ترتيب تقديري من بيانات الإعلانات نفسها، وليس ضمانًا.",
    `إذا أعجبك قل «خذ ${["", "الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"][position] ?? `رقم ${position}`}».`,
  ].filter(Boolean).join(" ");
  return adviceTurn(prompt, {
    kind: "GROUNDED_ADVICE",
    scope: "DINAR_INTERNAL",
    resultSetId: set.id,
    recommendation: { position, listingId: best.id, title: best.title },
    reasons: why,
    unknowns,
    preferences: preferences.map((key) => PREFERENCE_LABEL[key] ?? key),
  }, { ownerId: input.actorId, resourceIds: set.resourceIds });
}

/** The live pending action this actor is looking at, if the latest step is one. */
async function pendingInView(input: Input & { actorId: string }) {
  const [latest] = await recentSets(input.conversationId, input.market.id);
  if (!latest || !live(latest)) return undefined;
  const query = latest.query as Record<string, unknown>;
  if (query.ownerId !== input.actorId || query.status !== "PENDING") return undefined;
  if (query.kind === "LISTING_PREVIEW" || query.kind === "ACTION") return { set: latest, query };
  return undefined;
}

const ABOUT_DECISION =
  /(?:^|\s)(?:قبل\s+(?:ما\s+)?(?:اوافق|اكد|انفذ|اشتري|ارسل|اطلب)|هذا السعر|السعر|سعره|سعرها|المبلغ|التعديل|التغيير|مناسب|معقول|يستاهل|اوافق|اكد|عرضي|الكميه)(?:\s|$)/u;

/** Whether a question is about the pending action: its decision, its value or its item. */
async function aboutPending(text: string, pending: { query: Record<string, unknown> }): Promise<boolean> {
  if (ABOUT_DECISION.test(text)) return true;
  const { query } = pending;
  const values = [query.afterValue, (query.structuredInput as Record<string, { value?: unknown }> | undefined)?.amountMinor?.value]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(Number(value)));
  if ((text.match(/\d+(?:\.\d+)?/gu) ?? []).some((number) => values.includes(String(Number(number))))) return true;
  const listingId = query.kind === "LISTING_PREVIEW" ? query.listingId : query.targetResource;
  const [row] = typeof listingId === "string" ? await db.select({ data: offers.data }).from(offers).where(eq(offers.id, listingId)) : [];
  const titleWords = normalizeBuyerText(String(row?.data?.title ?? "")).split(" ").map((word) => word.replace(/^ال/u, "")).filter((word) => word.length >= 3);
  return titleWords.some((word) => text.split(" ").some((token) => token.replace(/^(?:ب|و|ل)?ال/u, "") === word));
}

/** «قبل أوافق، تشوف 8 مناسب؟»: discusses the pending action without executing or voiding it. */
async function adviseOnPending(input: Input & { actorId: string }, pending: NonNullable<Awaited<ReturnType<typeof pendingInView>>>): Promise<Turn> {
  const { set, query } = pending;
  const listingId = query.kind === "LISTING_PREVIEW" ? String(query.listingId) : String(query.targetResource);
  const [row] = await db.select().from(offers).where(eq(offers.id, listingId));
  let line = "";
  let stats: InternalStats | undefined;
  if (row && row.marketId === input.market.id) {
    const compared = await comparablePrices(input.market, {
      categoryId: typeof row.data.categoryId === "string" ? row.data.categoryId : undefined,
      title: String(row.data.title ?? ""),
      attributes: row.data.attributes,
      excludeIds: [row.id],
      sellerId: row.sellerId,
    });
    const scale = 10 ** input.market.minorUnitScale;
    stats = {
      count: compared.count,
      minMinor: compared.min === null ? null : Math.round(compared.min * scale),
      maxMinor: compared.max === null ? null : Math.round(compared.max * scale),
      medianMinor: compared.median === null ? null : Math.round(compared.median * scale),
    };
    const proposedMinor =
      query.kind === "LISTING_PREVIEW" && query.fieldLabel === "السعر"
        ? Math.round(Number(query.afterValue) * scale)
        : typeof (query.structuredInput as Record<string, { value?: unknown }> | undefined)?.amountMinor?.value === "number"
          ? Number((query.structuredInput as Record<string, { value: number }>).amountMinor.value)
          : ((query.expected as { unitPriceMinor?: number } | undefined)?.unitPriceMinor ?? null);
    line = `${statsSentence(stats, input.market)}${proposedMinor ? relation(proposedMinor, stats, input.market) : ""}`;
  }
  const prompt = [
    line || "لا توجد بيانات داخل DINAR كافية لتقييم هذا الإجراء.",
    "هذه مقارنة بالإعلانات الحالية فقط ولا تضمن البيع أو توقيته.",
    "الإجراء ما زال بانتظار تأكيدك ولم يُنفذ شيء؛ اكتب «نفذ» للتأكيد أو «إلغاء».",
  ].join(" ");
  return adviceTurn(prompt, { kind: "GROUNDED_ADVICE", scope: "DINAR_INTERNAL", aboutAction: String(query.kind === "ACTION" ? query.action : query.operation), ...(stats ? { stats: statsView(stats, input.market) } : {}) }, { relatesToAction: set.id, resourceId: listingId });
}

const PROVIDER_EXPLANATION = [
  "في DINAR طريقتان، وكلتاهما تنتج إعلانات DINAR عادية في السجل نفسه:",
  "• الإضافة هنا (SELF_SERVICE): تنشئ الإعلان بالمحادثة أو بالنموذج وتديره أنت مباشرة.",
  "• ربط متجرك (PROVIDER): نظامك يرسل المنتجات أو الخدمات بأسعارها ومخزونها عبر واجهة DINAR بمفتاح ربط خاص بك؛ السعر والمخزون المتزامنان يُعدّلان من نظامك وليس من المحادثة.",
  "في الحالتين يبقى البحث والطلبات والدفع والترويج والتوصيل عند DINAR نفسه، ويمكنك إيقاف الربط أو تبديل المفتاح في أي وقت.",
  "لا توجد حاليًا تكاملات جاهزة مفعّلة مع منصات بعينها؛ الربط عام عبر واجهة DINAR. لإنشاء ربط قل «اربط متجري».",
].join("\n");

/** The seller's draft in focus, if the latest block is one. */
async function draftInFocus(conversationId: string) {
  const [block] = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, conversationId)).orderBy(desc(aiUiBlocks.createdAt)).limit(1);
  const payload = block?.payload as Record<string, unknown> | undefined;
  if (payload?.surface !== "SELL" || ["published", "cancelled", "choose_draft"].includes(String(payload.draftStep ?? ""))) return undefined;
  const parsed = ConversationDraft.safeParse(payload.draft);
  return parsed.success ? parsed.data : undefined;
}

async function draftStepInFocus(conversationId: string): Promise<string | undefined> {
  const [block] = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, conversationId)).orderBy(desc(aiUiBlocks.createdAt)).limit(1);
  const step = (block?.payload as { draftStep?: unknown } | undefined)?.draftStep;
  return typeof step === "string" ? step : undefined;
}

async function sellerListingInFocus(input: Input & { actorId: string }) {
  const [block] = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, input.conversationId)).orderBy(desc(aiUiBlocks.createdAt)).limit(1);
  const id = (block?.payload as { resourceId?: unknown } | undefined)?.resourceId;
  const candidates = typeof id === "string" ? [id] : [];
  const own = await searchMarketplaceListings(input.market, { ownSellerId: input.actorId, limit: 24 });
  const active = own.filter((listing) => ["PUBLISHED", "PAUSED"].includes(String(listing.status)));
  return active.find((listing) => candidates.includes(listing.id)) ?? (active.length === 1 ? active[0] : undefined);
}

/**
 * The G2 discussion layer. Returns null for anything it does not own, so every
 * deterministic command keeps its existing handler and makes no model call.
 */
export async function executeSmartTurn(input: Input): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actor = { ...input, actorId: input.actorId };
  const text = normalizeBuyerText(input.message);
  if (!text) return null;

  if (AUTONOMOUS.test(text))
    return adviceTurn(
      "لا أفاوض نيابةً عنك ولا أرسل أسعارًا تلقائيًا. أستطيع أن أشرح لك الأسعار المشابهة داخل DINAR وأجهّز لك عرضًا، لكن كل مبلغ يُرسل فقط بعد مراجعتك وتأكيدك. اكتب مثلًا «أعطيه 7» لأجهّز المراجعة.",
      { kind: "CONVERSATIONAL_RESPONSE", scope: "POLICY", autonomousNegotiation: false },
      { ownerId: actor.actorId },
    );

  if (PROVIDER_EXPLAIN.test(text))
    return adviceTurn(PROVIDER_EXPLANATION, { kind: "CONVERSATIONAL_RESPONSE", scope: "DINAR_CAPABILITY", sources: ["SELF_SERVICE", "PROVIDER"], activeNamedIntegrations: [] }, { ownerId: actor.actorId });

  if (DRIVER_JOB_CORRECTION.test(text)) return null; // the driver adapter owns «أشتغل سائق مع دينار».

  // «اكتب لي وصف حلو»: a draft description from the facts the seller gave, nothing else.
  if (DESCRIPTION_REQUEST.test(text)) {
    const draft = await draftInFocus(input.conversationId);
    if (draft) {
      const categories = (await listMarketplaceCategories()).map(categorySchema);
      const schema = categories.find((category) => category.id === draft.categoryId);
      const facts = Object.entries(draft.attributes ?? {})
        .filter(([, value]) => value !== "" && value !== null && value !== undefined)
        .map(([key, value]) => `${schema?.attributes[key]?.label ?? (key === "condition" ? "الحالة" : key)}: ${value}`);
      const lines = [
        draft.title ? `${draft.title}${draft.attributes?.condition ? ` بحالة ${draft.attributes.condition}` : ""}.` : "",
        facts.filter((fact) => !fact.startsWith("الحالة")).join("، "),
        draft.inventoryMode === "LIMITED" && draft.availableQuantity && draft.availableQuantity !== "1" ? `الكمية المتوفرة: ${draft.availableQuantity}.` : "",
        draft.area ? `الاستلام في ${draft.area}.` : "",
        draft.negotiable === true ? "السعر قابل للتفاوض." : "",
      ].filter(Boolean);
      const description = lines.join(" ").replace(/\s+/g, " ").trim().slice(0, 1000);
      const thin = description.length < 10;
      const next = thin ? draft : { ...draft, description, sources: { ...(draft.sources ?? {}), description: "DINAR_DERIVED" as const } };
      return {
        tool: "smartConversation",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "SELL",
          query: {},
          listings: [],
          draft: next,
          // The draft stays in focus: same draft, same step.
          draftStep: (await draftStepInFocus(input.conversationId)) ?? "review",
          draftReview: buildDraftReview(next, categories) as unknown as Record<string, unknown>,
          prompt: thin
            ? "لا أملك معلومات كافية عن المنتج لأكتب وصفًا دون اختراع تفاصيل. أخبرني باسمه وحالته ومواصفاته."
            : `اقترحت هذا الوصف من المعلومات التي ذكرتها فقط، دون إضافة مواصفات أو ضمان أو حالة لم تذكرها: «${description}». عدّله إذا أردت.`,
        },
      };
    }
  }

  // «حسّن نبذتي»: wording from the candidate's own stored facts; no experience, education,
  // certificate or skill is added, and the profile itself is not changed.
  if (CANDIDATE_WORDING.test(text)) {
    const [profile] = await db.select().from(candidateProfiles).where(and(eq(candidateProfiles.userId, actor.actorId), eq(candidateProfiles.marketId, input.market.id)));
    if (profile) {
      const parts = [
        profile.professionalTitle ? `${profile.professionalTitle}` : "",
        profile.experienceYears !== null ? `بخبرة ${profile.experienceYears} ${profile.experienceYears === 1 ? "سنة" : "سنوات"}` : "",
        profile.skills.length ? `في ${profile.skills.slice(0, 8).join("، ")}` : "",
        profile.city ? `مقيم في ${profile.city}` : "",
      ].filter(Boolean);
      const suggestion = parts.length ? `${parts.join(" ")}.` : "";
      return adviceTurn(
        suggestion
          ? `اقتراح صياغة من بيانات ملفك فقط: «${suggestion}» لم أضف خبرة أو تعليمًا أو شهادات أو مهارات لم تذكرها، ولم أغيّر ملفك.`
          : "ملفك لا يحتوي معلومات كافية بعد؛ أخبرني بمسمّاك ومهاراتك وسنوات خبرتك ولن أضيف شيئًا لم تذكره.",
        { kind: "CONVERSATIONAL_RESPONSE", scope: "DINAR_INTERNAL", suggestion, inventedCredentials: 0 },
        { ownerId: actor.actorId },
      );
    }
  }

  // Discussion about the action awaiting confirmation keeps it pending; any other topic
  // is a newer conversation step and voids it.
  const pending = await pendingInView(actor);
  if (pending && QUESTION.test(text) && !BARE_DECISION.test(text) && (await aboutPending(text, pending))) return adviseOnPending(actor, pending);

  if (OFFER_ADVICE.test(text)) {
    const set = await latestListingSet(input.conversationId, input.market.id);
    const [block] = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, input.conversationId)).orderBy(desc(aiUiBlocks.createdAt)).limit(1);
    const ids = (block?.payload as { resourceIds?: unknown; presentation?: unknown } | undefined);
    const focused = ids?.presentation === "DETAILS" && Array.isArray(ids.resourceIds) ? String(ids.resourceIds[0]) : set?.resourceIds.length === 1 ? set.resourceIds[0] : undefined;
    const [row] = focused ? await db.select().from(offers).where(eq(offers.id, focused)) : [];
    const stats = row ? await textComparables(input.market, String(row.data.title ?? ""), row.sellerId) : undefined;
    return adviceTurn(
      [
        row ? `«${String(row.data.title ?? "")}» معروض بـ${formatMinor(row.unitPriceMinor ?? 0, input.market)} ${input.market.currencyCode}.` : "افتح الإعلان أولًا لأقارن سعره.",
        stats ? statsSentence(stats, input.market) : "",
        "القرار لك: لن أرسل أي عرض إلا بعد أن تكتب المبلغ وتؤكد المراجعة.",
      ].filter(Boolean).join(" "),
      { kind: "GROUNDED_ADVICE", scope: "DINAR_INTERNAL", ...(stats ? { stats: statsView(stats, input.market) } : {}) },
      { ownerId: actor.actorId, ...(row ? { resourceId: row.id } : {}) },
    );
  }

  if (PROMOTION_ADVICE.test(text)) {
    const listing = await sellerListingInFocus(actor);
    const promoted = listing ? (await servingCampaignsFor(input.market.id, [listing.id])).length > 0 : false;
    return adviceTurn(
      [
        listing ? `«${listing.title}»${promoted ? " عليه ترويج نشط حاليًا." : " ليس عليه ترويج حاليًا."}` : "",
        "الترويج يعرض إعلانك في أماكن ممولة تحمل شارة «إعلان ممول»؛ يزيد الظهور لكنه لا يضمن البيع، ولا تتوفر لدي بيانات طلب أو مشاهدات تؤكد أثره على هذا الإعلان.",
        "لم أروّج شيئًا. إذا أردت قل «روّجه» وسأعرض الخطط والمراجعة قبل أي دفع أو تفعيل.",
      ].filter(Boolean).join(" "),
      { kind: "GROUNDED_ADVICE", scope: "DINAR_INTERNAL", promotionActivated: false },
      { ownerId: actor.actorId, ...(listing ? { resourceId: listing.id, resourceIds: [listing.id] } : {}) },
    );
  }

  if (URGENT.test(text)) {
    const draft = await draftInFocus(input.conversationId);
    const listing = draft ? undefined : await sellerListingInFocus(actor);
    const title = draft?.title ?? listing?.title;
    const priceMinor = draft?.unitPrice ? Math.round(Number(draft.unitPrice) * 10 ** input.market.minorUnitScale) : listing ? minorOf(listing, input.market) : null;
    const stats = title ? await textComparables(input.market, title, actor.actorId) : undefined;
    return adviceTurn(
      [
        "لا أستطيع ضمان البيع أو توقيته.",
        stats ? `${statsSentence(stats, input.market)}${priceMinor ? relation(priceMinor, stats, input.market) : ""}` : "",
        "ما قد يساعد: سعر قريب من الإعلانات المشابهة، صور واضحة، ووصف يذكر الحالة بدقة. ويمكنك الترويج اختياريًا؛ لا يُفعّل إلا بعد مراجعتك.",
      ].filter(Boolean).join(" "),
      { kind: "GROUNDED_ADVICE", scope: "DINAR_INTERNAL", guaranteedSale: false, ...(stats ? { stats: statsView(stats, input.market) } : {}) },
      { ownerId: actor.actorId, ...(listing ? { resourceId: listing.id } : {}) },
    );
  }

  const estimate = text.match(ESTIMATE);
  if (estimate) {
    // A draft or the seller's own listing in view uses the Block F1 comparables answer as is.
    const draft = await draftInFocus(input.conversationId);
    const item = estimate[1]?.replace(/[؟?]+$/u, "").trim();
    if (draft || !item) return executeSellerAdviceTurn({ ...input, message: "كم أحط سعر" });
    const stats = await textComparables(input.market, item, actor.actorId);
    return adviceTurn(
      `${statsSentence(stats, input.market)} هذه أسعار معروضة داخل DINAR فقط، لا تمثل الأسعار خارجه ولا تعني ضمان البيع بها.`,
      { kind: "GROUNDED_ADVICE", scope: "DINAR_INTERNAL", stats: statsView(stats, input.market), subject: stats.item },
      { ownerId: actor.actorId },
    );
  }

  // «رجعنا للجاكيت»: the open draft by name, else the seller's own listing by name.
  const resume = text.match(RESUME_NAMED);
  const named = resume?.[1]?.trim();
  if (named && !NOT_RESUMABLE.test(named)) {
    const draft = await resumeNamedDraft(input.conversationId, named);
    if (draft) return draft;
    const words = normalizeBuyerText(named).split(" ").map((word) => word.replace(/^ال/u, "")).filter((word) => word.length >= 2);
    const own = (await searchMarketplaceListings(input.market, { ownSellerId: actor.actorId, limit: 24 })).filter((listing) => ["PUBLISHED", "PAUSED"].includes(String(listing.status)));
    const matches = own.filter((listing) => {
      const title = normalizeBuyerText(listing.title);
      return words.length > 0 && words.every((word) => title.includes(word));
    });
    if (matches.length === 1)
      return makeSellerContextResult(actor, matches, `رجعنا إلى إعلانك «${matches[0]!.title}». يمكنك تعديل السعر أو الكمية أو إيقافه.`, matches[0]!.id);
    if (matches.length > 1) return makeSellerContextResult(actor, matches, "لديك أكثر من إعلان بهذا الاسم؛ أي واحد تقصد؟ اختر رقمه.");
  }

  // «لحظة دور لي على آيفون أقل من 300» while selling: a buyer search; the draft stays saved.
  const interrupt = text.match(INTERRUPT_SEARCH);
  const interruptDraft = interrupt ? await draftInFocus(input.conversationId) : undefined;
  // Claimed when it interrupts something (a draft in focus or «لحظة …»); a plain search
  // keeps its existing handler.
  if (interrupt && (interruptDraft || interrupt[1])) {
    const draft = interruptDraft;
    const [categories, knownCities] = await Promise.all([listMarketplaceCategories(), publishedListingCities(input.market.id)]);
    const interpreted = interpretMarketplaceTurn(interrupt[2]!, { categories: categories.map(categorySchema), knownCities });
    // Words the interpreter does not classify are still the words to search for.
    const query = interpreted.intent === "SEARCH" && interpreted.query ? interpreted.query : { search: interrupt[2]!.trim(), filters: [], categoryId: undefined };
    const result = await runBuyerSearch(input.market, {
      search: query.search,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      filters: query.filters,
      ranking: "DEFAULT",
    });
    const name = draft?.title?.split(" ").find((word) => !/^(?:هذا|هذه|هذي|هاد|ذا)$/u.test(word))?.replace(/^ال/u, "");
    if (name) {
      const buyer = result.query.buyer as { message?: string };
      buyer.message = `${buyer.message ?? ""} مسودة «${draft!.title}» محفوظة كما هي ولم تُنشر؛ قل «رجعنا لل${name}» للعودة إليها.`.trim();
    }
    return { tool: "buyerSearch", version: 1, result };
  }

  // Buyer consultation: a goal without enough to search yet.
  const sets = await recentSets(input.conversationId, input.market.id);
  const latest = sets[0];
  const current = latest && live(latest) && (latest.query as { kind?: unknown; ownerId?: unknown }).kind === "CONSULTATION" && (latest.query as { ownerId?: unknown }).ownerId === actor.actorId
    ? (latest.query as Consultation)
    : undefined;
  if (current) {
    const preferences = [...new Set([...current.preferences, ...preferencesIn(text)])];
    const budgetMatch = text.match(BUDGET);
    const budget = budgetMatch ? Number(budgetMatch[1]) : current.budget;
    const next: Consultation = { ...current, preferences, ...(budget ? { budget } : {}) };
    const gavePreferenceAndBudget = preferencesIn(text).length > 0 && budgetMatch !== null;
    if (SHOW.test(text) || gavePreferenceAndBudget) return consultationSearch(input.market, next);
    if (budgetMatch || preferencesIn(text).length) {
      const understood = [
        `فهمت: تبحث عن ${next.item}`,
        next.preferences.length ? `ويهمك ${next.preferences.map((key) => PREFERENCE_LABEL[key] ?? key).join(" و")}` : "",
        next.budget ? `وحدك ${next.budget} ${input.market.currencyCode}` : "",
      ].filter(Boolean).join(" ");
      const question = next.budget ? "أعرض لك الموجود داخل DINAR؟ قل «شوف الموجود»." : "كم ميزانيتك تقريبًا؟";
      return consultationTurn(next, `${understood}. ${question}`);
    }
  }
  // «أبي تلفون بحدود 300 والبطارية تهمني»: item, budget and what matters in one message is
  // already a complete consultation, so it searches now with the budget as a ceiling.
  if (!current && IMPORTANT.test(text) && !SELLING.test(text)) {
    const budgetMatch = text.match(BUDGET);
    const preferences = preferencesIn(text);
    const core = text
      .replace(BUDGET, " ")
      .split(" ")
      .filter((word) => !IMPORTANT.test(word) && !PREFERENCES.some(([pattern]) => pattern.test(` ${word.replace(/^و/u, "")} `)))
      .join(" ");
    const item = consultationItem(core);
    if (item && budgetMatch && preferences.length)
      return consultationSearch(input.market, { kind: "CONSULTATION", ownerId: actor.actorId, goal: "BUY", item, preferences, budget: Number(budgetMatch[1]) });
  }
  if (UNSURE.test(text)) {
    const item = consultationItem(text);
    if (item) {
      const state: Consultation = { kind: "CONSULTATION", ownerId: actor.actorId, goal: "BUY", item, preferences: preferencesIn(text) };
      const budgetMatch = text.match(BUDGET);
      if (budgetMatch) state.budget = Number(budgetMatch[1]);
      return consultationTurn(state, `أكيد أساعدك تختار ${item}. وش أهم شيء عندك: السعر، الحالة، أو مواصفة معينة${item.match(/تلفون|جوال|موبايل|ايفون|هاتف/u) ? " مثل البطارية أو الكاميرا" : ""}؟${state.budget ? "" : " وكم ميزانيتك تقريبًا؟"}`);
    }
  }

  if (ADVISE_RESULTS.test(text) && !NOT_ADVICE.test(text)) return adviseOnResults(actor);
  return null;
}

// ─── Model fallback ──────────────────────────────────────────────────────────

const DISCUSSION = /[؟?]|^(?:وش|شو|ايش|شنو|ليش|ليه|لماذا|كيف|شلون|هل|متي|وين|اشرح|احكيلي|قلي|قل لي|عطني رايك|ابي رايك)(?:\s|$)|(?:^|\s)(?:رايك|راي|تنصحني|انصحني)(?:\s|$)/u;

export function isDiscussionTurn(message: string): boolean {
  return DISCUSSION.test(normalizeBuyerText(message));
}

const PRONOUN_SUFFIX =/(?:كما|كم|كن|هما|هم|هن|ها|نا|ه|ك|ي)$/u;
/** A word as written and without the article and/or an attached pronoun; never under two letters. */
function itemWordForms(word: string): Set<string> {
  const forms = new Set<string>();
  for (const stem of [word, word.replace(/^ال/u, "")])
    for (const form of [stem, stem.replace(PRONOUN_SUFFIX, "")]) if (form.length >= 2) forms.add(form);
  return forms;
}
/**
 * The forms a message word may take for an item the user named: also without one leading
 * particle (و ف ب ل ك), and with a possessive «ت» read back as «ه» («سيارتي» → «سياره»). Particles
 * are stripped from the message only, so an item never matches a different word («كرسي»/«فرسي»).
 */
function messageWordForms(word: string): Set<string> {
  const forms = new Set<string>();
  for (const base of [word, word.replace(/^[وفبلك]/u, "")])
    for (const form of itemWordForms(base)) {
      forms.add(form);
      if (PRONOUN_SUFFIX.test(form) && form.replace(PRONOUN_SUFFIX, "").endsWith("ت"))
        forms.add(`${form.replace(PRONOUN_SUFFIX, "").slice(0, -1)}ه`);
    }
  return forms;
}

/**
 * The model named an item the user actually wrote, as a sale request: every word of the item
 * appears in the message in one of its forms, so «تلفون مستعمل» is grounded in «بدي أبيع
 * تلفوني المستعمل» while «ايفون 13» or «تلفون ذهبي» are not. Missing details are the canonical
 * draft flow's to collect; nothing is created from a word the user did not write.
 */
export function isGroundedSellerDraftRequest(
  message: string,
  turn: ModelTurn,
): boolean {
  const normalizedMessage = normalizeBuyerText(message);
  const messageForms = new Set(normalizedMessage.split(" ").flatMap((word) => [...messageWordForms(word)]));
  const itemWords = normalizeBuyerText(turn.entities?.item?.trim() ?? "").split(" ").filter((word) => itemWordForms(word).size > 0);
  return (
    turn.goal === "SELL" &&
    /(?:\b(?:sell|selling|list|listing|post|advertise)\b|للبيع|ابيع|بيع|اعرض|انشر)/iu.test(
      normalizedMessage,
    ) &&
    itemWords.length > 0 &&
    itemWords.every((word) => [...itemWordForms(word)].some((form) => messageForms.has(form))) &&
    turn.confidence >= 0.75
  );
}

import { personalContext } from "./personal-context-service";
async function modelContext(input: Input): Promise<ModelContext> {
  const marketAvailable = isMarketAvailable(input.market);
  const [set, history] = await Promise.all([
    marketAvailable
      ? latestListingSet(input.conversationId, input.market.id)
      : Promise.resolve(undefined),
    db.select({ actor: messages.actor, body: messages.body, metadata: messages.metadata }).from(messages).where(eq(messages.conversationId, input.conversationId)).orderBy(desc(messages.createdAt)).limit(HISTORY_SCAN_ROWS + 1),
  ]);
  const listings = marketAvailable && set?.resourceIds.length
    ? await searchMarketplaceListings(input.market, { search: "", allowedIds: set.resourceIds.slice(0, 5), limit: 5 })
    : [];
  const order = new Map(set?.resourceIds.map((id, index) => [id, index + 1]) ?? []);
  return {
    marketAvailable,
    serverContext: conversationGuidance(
      input.market,
      marketAvailable,
      Boolean("actorId" in input && input.actorId),
    ),
    goal: null,
    preferences: input.actorId ? (await personalContext.getRelevantContext(input.actorId, input.message, input.conversationId)).map(m => `${m.kind}: ${m.label}${m.value ? ` (${m.value})` : ""}; ${m.reason}`) : [],
    // Only coarse listing facts; never seller contact, coordinates or ids.
    results: listings.map((listing) => ({
      position: order.get(listing.id) ?? 0,
      title: listing.title,
      price: listing.unitPrice,
      currency: listing.currency,
      ...(typeof listing.attributes?.condition === "string" ? { condition: listing.attributes.condition } : {}),
      ...(listing.city ? { city: listing.city } : {}),
      negotiable: listing.negotiable === true,
    })),
    pendingAction: null,
    // The ledger, not the assistant's earlier words, is what the model may treat as done.
    ...(input.actorId ? { actionReceipts: await recentActionReceipts(input.conversationId, input.actorId) } : {}),
    // Another party's words delivered by an inquiry are never model instructions or history.
    history: history.slice(1).reverse().filter((row) => row.metadata?.inquiryDelivery !== true && row.metadata?.inquiryContent !== true).map((row) => ({ actor: row.actor, body: row.body })),
    // Marketing help is grounded in the seller's own listing or draft, with provenance.
    ...(input.actorId && marketAvailable && isMarketingRequest(input.message)
      ? { sellerListing: await sellerListingFacts({ conversationId: input.conversationId, message: input.message, market: input.market, actorId: input.actorId }) }
      : {}),
  };
}

/** Guest turns share the same model contract and server-authored locale/capability context. */
export async function executeGuestModelTurn(
  input: {
    market: Market;
    message: string;
    history?: ModelContext["history"];
    earlierUserTopics?: string[];
    reasoningEffort?: ReasoningEffort;
  },
  injected?: ConversationModelGateway,
): Promise<ModelResult | null> {
  const marketAvailable = isMarketAvailable(input.market);
  let gateway: ConversationModelGateway | undefined;
  try {
    gateway = await modelGatewayFor(injected, {
      marketId: input.market.id,
      countryCode: input.market.countryCode,
      currencyCode: input.market.currencyCode,
    });
  } catch (error) {
    if (!(error instanceof AIProviderError)) throw error;
    const reason: ModelFailure =
      error.code === "QUOTA_LIMITED"
        ? "QUOTA_LIMITED"
        : error.code === "NOT_CONFIGURED"
          ? "NOT_CONFIGURED"
          : "UNAVAILABLE";
    return {
      ok: false,
      reason,
      modelCall: {
        provider: error.provider,
        requestedModel: error.requestedModel,
        latencyMs: error.latencyMs,
      },
    };
  }
  if (!gateway) return null;
  return interpretWithModel(gateway, input.message, {
    reasoningEffort: input.reasoningEffort,
    marketAvailable,
    history: input.history ?? [],
    earlierUserTopics: input.earlierUserTopics ?? [],
    serverContext: conversationGuidance(
      input.market,
      marketAvailable,
      Boolean("actorId" in input && input.actorId),
    ),
  });
}

// The shared bucket table caps a window at 20 attempts (auth_rate_limit_attempts_valid),
// so the window is short instead: 20 model turns per 5 minutes per actor.
const MODEL_TURN_WINDOW_SECONDS = 300;
const modelTurnLimit = () => {
  const configured = Number(process.env.DINAR_MODEL_TURNS_PER_WINDOW);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 20) : 20;
};

const CLAIM_LABELS: Record<ClaimKind, string> = {
  SCARCITY: "ندرة أو كمية محدودة",
  URGENCY: "استعجال أو مهلة",
  WARRANTY: "ضمان",
  CERTIFICATION: "اعتماد أو أصالة",
  DISCOUNT: "خصم أو عرض خاص",
  SOCIAL_PROOF: "تقييمات أو أعداد زبائن",
};

/**
 * Marketing copy whose wording states a claim the seller's facts do not support gets one
 * read-only corrective retry; a second violation is refused instead of shown (Command C3).
 */
export async function draftWithClaimGuard(
  gateway: ConversationModelGateway,
  message: string,
  context: ModelContext,
  /** Dual-tier routing (model-tier.ts); absent = the single-model behaviour. */
  tiering?: { decision: TierDecision; allowEscalation: () => Promise<boolean> },
): Promise<{ outcome: Awaited<ReturnType<typeof interpretWithModel>>; blocked?: ClaimKind[]; metered: ModelMetering; tier?: TierTrace }> {
  const startedAt = Date.now();
  const deadlineLeft = () => Number(process.env.DINAR_MODEL_TIMEOUT_MS ?? 25000) - (Date.now() - startedAt);
  let chosen: TierRoute = tiering
    ? gatewayForTier(gateway, tiering.decision.tier, context.reasoningEffort)
    : { tier: "LIGHT", gateway, ...(context.reasoningEffort ? { reasoningEffort: context.reasoningEffort } : {}) };
  let reason: TierReason | undefined = chosen.degraded ?? tiering?.decision.reason;
  const outcomes: Awaited<ReturnType<typeof interpretWithModel>>[] = [];
  let outcome = await interpretWithModel(chosen.gateway, message, { ...context, reasoningEffort: chosen.reasoningEffort });
  outcomes.push(outcome);
  let escalated = false;
  if (tiering && !outcome.ok && deadlineLeft() > 1000) {
    if (chosen.tier === "LIGHT" && escalatesAfterLight(outcome.reason) && tiering.decision.reason !== "DECISION_NEVER_ESCALATES") {
      // One bounded escalation, inside the same turn deadline, with the same context. Only when
      // HEAVY can actually be served now, so a refused attempt is never spent.
      const heavyRoute = gatewayForTier(gateway, "HEAVY", context.reasoningEffort);
      if (heavyRoute.tier === "HEAVY" && (await tiering.allowEscalation())) {
        escalated = true;
        reason = "LIGHT_OUTPUT_INVALID";
        chosen = heavyRoute;
        outcome = await interpretWithModel(chosen.gateway, message, { ...context, reasoningEffort: chosen.reasoningEffort }, deadlineLeft());
        outcomes.push(outcome);
      }
    } else if (chosen.heavyKind === "SEPARATE_MODEL" && (outcome.reason === "UNAVAILABLE" || outcome.reason === "QUOTA_LIMITED" || outcome.reason === "NOT_CONFIGURED")) {
      // The separate HEAVY model could not answer (its own fallback included): LIGHT answers once.
      reason = "HEAVY_UNAVAILABLE";
      chosen = gatewayForTier(gateway, "LIGHT", context.reasoningEffort);
      outcome = await interpretWithModel(chosen.gateway, message, { ...context, reasoningEffort: chosen.reasoningEffort }, deadlineLeft());
      outcomes.push(outcome);
    }
  }
  const trace: TierTrace | undefined = tiering
    ? { tier: chosen.tier, reason: reason!, escalated, ...(chosen.heavyKind ? { heavyKind: chosen.heavyKind } : {}) }
    : undefined;
  if (trace) logger.info({ event: "dinar_ai_model_tier", ...trace, outcome: outcome.ok ? "OK" : outcome.reason, provider: outcome.modelCall.provider, model: outcome.modelCall.actualModel ?? outcome.modelCall.requestedModel }, "model tier");
  const done = (extra: { blocked?: ClaimKind[] } = {}) => ({ outcome, ...extra, metered: metering(outcomes), ...(trace ? { tier: trace } : {}) });
  if (!outcome.ok || !isMarketingRequest(message)) return done();
  const facts = context.sellerListing ?? null;
  const violations = unsupportedCopyClaims(outcome.turn.conversationalReply, facts);
  if (!violations.length) return done();
  logger.info({ event: "dinar_marketing_claims_rejected", claims: violations, attempt: 1 }, "marketing draft rejected");
  outcome = await interpretWithModel(chosen.gateway, message, {
    ...context,
    reasoningEffort: chosen.reasoningEffort,
    correction: `SERVER_CHECK: your draft stated claims the listing facts do not support (${violations.join(", ")}). Rewrite the whole answer without them: no such wording anywhere in suggested text, not even conditionally.`,
  });
  outcomes.push(outcome);
  if (!outcome.ok) return done();
  const remaining = unsupportedCopyClaims(outcome.turn.conversationalReply, facts);
  if (remaining.length) {
    logger.info({ event: "dinar_marketing_claims_rejected", claims: remaining, attempt: 2 }, "marketing draft refused");
    return done({ blocked: remaining });
  }
  return done();
}
type TierTrace = { tier: ModelTier; reason: TierReason; escalated: boolean; heavyKind?: "SEPARATE_MODEL" | "SAME_MODEL_HIGH_EFFORT" };

/**
 * The gateway with only the additional models (HEAVY, fallback) the spend policy allows. The
 * primary was already checked by the usage hold. Pricing is read once per turn; any lookup error
 * removes the extra model (fails toward fewer, priced models).
 */
async function withinSpendPolicy(gateway: ConversationModelGateway, market: AiUsageOwner["market"]): Promise<ConversationModelGateway> {
  if (!gateway.heavy && !gateway.fallback) return gateway;
  const policy = await aiUsagePolicyFor(market);
  const allowed = async (candidate?: ConversationModelGateway) => {
    if (!candidate?.providerInfo) return candidate;
    try {
      return (await modelPricingAcceptable(policy, { provider: candidate.providerInfo.provider, model: candidate.providerInfo.requestedModel })) ? candidate : undefined;
    } catch {
      return undefined;
    }
  };
  const [heavy, fallback] = await Promise.all([allowed(gateway.heavy), allowed(gateway.fallback)]);
  if (heavy === gateway.heavy && fallback === gateway.fallback) return gateway;
  const restrictedHeavy = heavy && heavy.fallback && !(await allowed(heavy.fallback)) ? stripFallback(heavy) : heavy;
  return {
    providerInfo: gateway.providerInfo,
    ...(gateway.perCallReasoningEffort !== undefined ? { perCallReasoningEffort: gateway.perCallReasoningEffort } : {}),
    ...(restrictedHeavy ? { heavy: restrictedHeavy } : {}),
    ...(fallback ? { fallback } : {}),
    proposeToolCall: (messages, tools, options) => gateway.proposeToolCall(messages, tools, options),
  };
}
const stripFallback = (gateway: ConversationModelGateway): ConversationModelGateway => ({
  providerInfo: gateway.providerInfo,
  ...(gateway.perCallReasoningEffort !== undefined ? { perCallReasoningEffort: gateway.perCallReasoningEffort } : {}),
  proposeToolCall: (messages, tools, options) => gateway.proposeToolCall(messages, tools, options),
});

/** A HEAVY turn spends the actor's separate heavy allowance; any doubt keeps the turn LIGHT. */
async function heavyAllowed(actorId: string): Promise<boolean> {
  const limit = heavyTurnLimit();
  if (!limit) return false;
  try {
    return !(await consumeRateLimit([{ scope: AUTH_RATE_LIMIT_SCOPE.conversationModelHeavyActor, value: actorId }], MODEL_TURN_WINDOW_SECONDS, limit));
  } catch {
    return false;
  }
}

/** Provider calls and tokens of one user-visible operation (a corrective retry included). */
type ModelMetering = { providerCalls: number; inputTokens?: number; outputTokens?: number; provider?: string; model?: string; calls?: AiCallRecord[] };
function metering(outcomes: Awaited<ReturnType<typeof interpretWithModel>>[]): ModelMetering {
  const calls = outcomes.reduce((total, item) => total + (item.modelCall.providerCalls ?? 1), 0);
  const reported = outcomes.every((item) => item.modelCall.usage);
  const last = outcomes.at(-1)!.modelCall;
  return {
    providerCalls: calls,
    ...(reported
      ? {
          inputTokens: outcomes.reduce((total, item) => total + item.modelCall.usage!.inputTokens, 0),
          outputTokens: outcomes.reduce((total, item) => total + item.modelCall.usage!.outputTokens, 0),
        }
      : {}),
    ...(last.provider ? { provider: last.provider } : {}),
    ...(last.actualModel ?? last.requestedModel ? { model: last.actualModel ?? last.requestedModel } : {}),
    ...(outcomes.every((item) => item.modelCall.calls?.length) ? { calls: outcomes.flatMap((item) => item.modelCall.calls!) } : {}),
  };
}

function usageOutcome(result: Awaited<ReturnType<typeof interpretWithModel>>): AiUsageOutcome {
  if (result.ok) return "SUCCESS";
  if (result.reason === "TIMEOUT") return "TIMEOUT";
  if (result.reason === "MALFORMED" || result.reason === "UNKNOWN_ACTION") return "INVALID_OUTPUT";
  return "PROVIDER_FAILED";
}

/** The plan comparison is offered once per conversation, and only when plans exist. */
async function planHintState(conversationId: string, market: Market) {
  const [plans, recent] = await Promise.all([
    businessPlans(market).catch((): Awaited<ReturnType<typeof businessPlans>> => []),
    db.select({ body: messages.body }).from(messages).where(eq(messages.conversationId, conversationId)).orderBy(desc(messages.createdAt)).limit(40),
  ]);
  return {
    plansConfigured: plans.some((plan) => planAiTier(plan.businessEntitlements) !== null),
    planHintAlreadyShown: recent.some((row) => row.body.includes(PLAN_HINT_MARKER)),
  };
}

export async function usageRefusalTurn(refusal: AiUsageRefusal, owner: AiUsageOwner, conversationId: string, market: Market, ownerId: string): Promise<Turn> {
  const summary = await aiUsageSummary(owner).catch(() => undefined);
  return adviceTurn(
    usageLimitMessage(refusal, summary, await planHintState(conversationId, market)),
    { kind: "CLARIFICATION_REQUIRED", scope: "CONVERSATION", modelStatus: "USAGE_LIMIT", usageLimit: { reason: refusal.reason, resource: refusal.resource, renewsAt: refusal.renewsAt.toISOString() } },
    { ownerId },
  );
}

// «أبي / عندكم / فيه …؟» asks about inventory even when phrased as a question.
const INVENTORY_WORDS =
  /(?:^|\s)(?:ابي|ابغي|ابغى|بدي|اريد|احتاج|اشتري|ادور|دورلي|عندكم|عندك|فيه|في\s+عندكم|يوجد|متوفر|متوفره|تبيعون|تبيع)(?:\s|$)/u;
const WANT_WORDS = /(?:^|\s)(?:ابي|ابغي|ابغى|بدي|اريد|احتاج)(?=\s|$)/gu;
function isGeneralQuestion(message: string): boolean {
  const text = normalizeSearch(message);
  // In «كم لوح احتاج لبيت؟» the need is the subject of the question; stock words still count.
  const inventory = INVENTORY_WORDS.test(NEED_QUESTION.test(text) ? text.replace(WANT_WORDS, " ") : text);
  return isGeneralRequest(message) && !hasExplicitMarketplaceSearchIntent(message) && !inventory;
}

const ORDINAL_WORDS = ["", "الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];

/**
 * The model's turn for genuinely open messages. Its structured, allowlisted suggestion is
 * mapped onto the deterministic read or review path a typed command takes; a failure of any
 * kind answers with a clarification and changes nothing.
 */
export async function executeModelFallback(
  input: Input,
  injected: ConversationModelGateway | undefined,
  review: (message: string) => Promise<Turn | null>,
  createSellerDraft?: (message: string) => Promise<Turn | null>,
  /** Re-enters the deterministic runtime with a capability's canonical utterance (no model). */
  productControl?: (message: string) => Promise<Turn | null>,
): Promise<Turn | null> {
  if (!input.actorId) return null;
  let gateway: ConversationModelGateway | undefined;
  try {
    gateway = await modelGatewayFor(injected, {
      marketId: input.market.id,
      countryCode: input.market.countryCode,
      currencyCode: input.market.currencyCode,
    });
  } catch (error) {
    if (!(error instanceof AIProviderError)) throw error;
    const reason: ModelFailure =
      error.code === "QUOTA_LIMITED"
        ? "QUOTA_LIMITED"
        : error.code === "NOT_CONFIGURED"
          ? "NOT_CONFIGURED"
          : "UNAVAILABLE";
    logger.warn(
      {
        event: "dinar_ai_model_call",
        provider: error.provider,
        requestedModel: error.requestedModel,
        latencyMs: error.latencyMs,
        status: "failed",
        structuredOutputValid: false,
        failureCode: reason,
      },
      "DINAR AI provider unavailable",
    );
    return adviceTurn(
      modelFailureMessage(reason),
      { kind: "CLARIFICATION_REQUIRED", scope: "CONVERSATION", modelStatus: reason },
      { ownerId: input.actorId },
    );
  }
  if (!gateway)
    return adviceTurn(
      modelFailureMessage("NOT_CONFIGURED"),
      { kind: "CLARIFICATION_REQUIRED", scope: "CONVERSATION", modelStatus: "NOT_CONFIGURED" },
      { ownerId: input.actorId },
    );
  // Every signed-in model turn costs provider quota: bound it per actor (fails closed).
  let limited: Awaited<ReturnType<typeof consumeRateLimit>>;
  try {
    limited = await consumeRateLimit(
      [{ scope: AUTH_RATE_LIMIT_SCOPE.conversationModelActor, value: input.actorId }],
      MODEL_TURN_WINDOW_SECONDS,
      modelTurnLimit(),
    );
  } catch (error) {
    logger.warn({ event: "dinar_model_rate_limit_unavailable", reason: error instanceof Error ? String((error as { cause?: { message?: string } }).cause?.message ?? error.message).slice(0, 200) : "unknown" }, "model turn rate limit unavailable");
    limited = { retryAfterSeconds: 30 };
  }
  if (limited)
    return adviceTurn(
      `وصلت إلى الحد المؤقت لأسئلة المساعد الذكي. حاول بعد ${Math.max(1, Math.ceil(limited.retryAfterSeconds / 60))} دقيقة تقريبًا. لم يُنفّذ أي إجراء.`,
      { kind: "CLARIFICATION_REQUIRED", scope: "CONVERSATION", modelStatus: "RATE_LIMITED" },
      { ownerId: input.actorId },
    );
  // G1: every model turn reserves its allowance first; ordinary marketplace actions never get here.
  const owner: AiUsageOwner = { kind: "USER", userId: input.actorId, market: input.market };
  const resource = usageResourceFor(input.message);
  const requestKey = input.requestKey
    ? `${input.requestKey}:${createHash("sha256").update(input.message).digest("hex").slice(0, 12)}`
    : `turn:${input.conversationId}:${randomUUID()}`;
  const reserved = await reserveAiUsage({ owner, resource, idempotencyKey: requestKey, ...(gateway.providerInfo ? { expectedModel: { provider: gateway.providerInfo.provider, model: gateway.providerInfo.requestedModel } } : {}) });
  if (!reserved.ok) return usageRefusalTurn(reserved, owner, input.conversationId, input.market, input.actorId);
  let drafted: Awaited<ReturnType<typeof draftWithClaimGuard>>;
  let context: ModelContext;
  try {
    context = await modelContext(input);
    const actorId = input.actorId;
    // Every model this turn could reach must satisfy the spend policy, not only the primary the
    // usage hold checked: an unpriced HEAVY model or fallback is removed under REFUSE.
    gateway = await withinSpendPolicy(gateway, owner.market);
    let tiering: Parameters<typeof draftWithClaimGuard>[3];
    if (modelTieringEnabled()) {
      let decision = selectModelTier(input.message, process.env, { requestedEffort: input.reasoningEffort });
      if (decision.tier === "HEAVY" && !(await heavyAllowed(actorId))) decision = { tier: "LIGHT", reason: "HEAVY_CAP_REACHED" };
      const noEscalation = decision.reason === "HEAVY_CAP_REACHED" || decision.reason === "DECISION_NEVER_ESCALATES";
      tiering = { decision, allowEscalation: () => (noEscalation ? Promise.resolve(false) : heavyAllowed(actorId)) };
    }
    drafted = await draftWithClaimGuard(gateway, input.message, {
      ...context,
      reasoningEffort: input.reasoningEffort,
      // Outside LEGACY the model may restate a DINAR request in DINAR's own words (routing-mode.ts).
      canonicalRequests: aiRoutingMode() !== "LEGACY",
    }, tiering);
  } catch (error) {
    await settleAiUsage(reserved.reservation.id, { outcome: "PROVIDER_FAILED", providerCalls: 1 }).catch(() => undefined);
    throw error;
  }
  const settled = await settleAiUsage(reserved.reservation.id, { outcome: usageOutcome(drafted.outcome), ...drafted.metered });
  const usageNote = settled.reservation.status === "SETTLED" ? await nearLimitFor(owner, resource) : undefined;
  if (drafted.blocked)
    return adviceTurn(
      `لم أستطع صياغة نص تسويقي دون ادعاءات لا تدعمها بيانات إعلانك (${drafted.blocked.map((claim) => CLAIM_LABELS[claim]).join("، ")}). لم يتغير شيء. إن كانت المعلومة صحيحة فأضفها لوصف إعلانك أولًا، أو اطلب صياغة بدونها.`,
      { kind: "GROUNDED_ADVICE", scope: "DINAR_INTERNAL", topic: "MARKETING_CLAIMS_BLOCKED", claims: drafted.blocked },
      { ownerId: input.actorId },
    );
  const outcome = drafted.outcome;
  if (!outcome.ok)
    return adviceTurn(
      modelFailureMessage(outcome.reason),
      { kind: "CLARIFICATION_REQUIRED", scope: "CONVERSATION", modelStatus: outcome.reason },
      { ownerId: input.actorId },
    );
  const turn = outcome.turn;
  // A named DINAR capability (theme, market, plans…) is resolved by the server before anything else.
  if (turn.suggestedAction === "PRODUCT_CONTROL" && turn.capability && productControl) {
    const country = turn.capability.countryCode ? countryByCode.get(turn.capability.countryCode) : undefined;
    const utterance = capabilityUtterance(turn.capability.id as ProductCapabilityId, {
      ...(turn.capability.theme ? { theme: turn.capability.theme } : {}),
      ...(country ? { countryNameAr: country.countryNameAr } : {}),
    });
    const controlled = utterance ? await productControl(utterance) : null;
    if (controlled) return controlled;
  }
  // Model-native mandate: the model's restatement of a DINAR request re-enters the same runtime
  // with the model disabled (depth one), so DINAR's own handlers, reviews and checks decide it.
  // A decision, a contact detail or an unchanged restatement never re-enters (routing-mode.ts).
  const mode = aiRoutingMode();
  if (turn.canonicalRequest && mode !== "LEGACY") {
    const problem = canonicalRequestProblem(turn.canonicalRequest, input.message, input.market.id);
    logger.info(
      { event: "dinar_ai_canonical_request", mode, accepted: !problem && mode !== "SHADOW", ...(problem ? { problem } : {}), chars: turn.canonicalRequest.length },
      "DINAR AI canonical request",
    );
    if (!problem && mode !== "SHADOW" && productControl) {
      const routed = await productControl(turn.canonicalRequest);
      if (routed) return { ...routed, result: { ...routed.result, modelRouted: { canonicalRequest: turn.canonicalRequest } } };
    }
  }
  const requestsMarketAction =
    turn.responseKind === "SEARCH_INTENT" ||
    turn.responseKind === "ACTION_PROPOSAL" ||
    (turn.suggestedAction !== undefined && turn.suggestedAction !== "NONE" && turn.suggestedAction !== "PRODUCT_CONTROL") ||
    hasExplicitMarketplaceSearchIntent(input.message);
  if (!isMarketAvailable(input.market) && requestsMarketAction) {
    const message = turn.conversationalReply.trim();
    const actionClaim =
      /(?:سأبحث|بحثت|وجدت|لقيت|سأنفذ|نفذت|سأشتري|اشتريت|أرسلت|تم\s+(?:الشراء|التنفيذ)|i(?:'ll| will) search|i searched|i found|i bought|i sent|done)/iu;
    const conversationalPart = actionClaim.test(message) || claimsCompletedAction(message) ? "" : message;
    const unavailableMessage =
      turn.responseKind === "SEARCH_INTENT" ||
      turn.suggestedAction === "SEARCH_LISTINGS" ||
      hasExplicitMarketplaceSearchIntent(input.message)
        ? "لا أستطيع البحث داخل عروض DINAR لهذا السوق الآن؛ لم أجرِ أي بحث."
        : "تنفيذ هذا الطلب السوقي غير متاح الآن؛ لم أنفّذ أي إجراء.";
    return adviceTurn(
      [conversationalPart, unavailableMessage].filter(Boolean).join(" "),
      { kind: "CONVERSATIONAL_RESPONSE", scope: "CONVERSATION", marketUnavailable: true },
      { ownerId: input.actorId },
    );
  }
  const ordinal = turn.targetReference?.kind === "ORDINAL" ? turn.targetReference.ordinal : undefined;
  const reference = ordinal ? ORDINAL_WORDS[ordinal] ?? `رقم ${ordinal}` : "";
  // A search suggestion is the canonical read-only search of the named item and budget.
  // A general question («طيب وكم تكلف؟ وهل تناسب البيت؟») keeps its answer: the model may
  // not swap it for listings the user never asked to browse.
  if ((turn.suggestedAction === "SEARCH_LISTINGS" || turn.responseKind === "SEARCH_INTENT") && turn.entities?.item && !isGeneralQuestion(input.message))
    return consultationSearch(input.market, {
      kind: "CONSULTATION",
      ownerId: input.actorId,
      goal: "BUY",
      item: turn.entities.item,
      ...(turn.entities.maxPrice ? { budget: turn.entities.maxPrice } : {}),
      preferences: [],
    });
  if (turn.suggestedAction === "CREATE_LISTING_DRAFT") {
    if (!isGroundedSellerDraftRequest(input.message, turn) || !createSellerDraft)
      return adviceTurn(
        "لم أبدأ مسودة إعلان. اذكر اسم الغرض الذي تريد عرضه بوضوح.",
        { kind: "CLARIFICATION_REQUIRED", scope: "SELLER_DRAFT" },
        { ownerId: input.actorId },
      );
    const draft = await createSellerDraft(input.message);
    if (draft) return draft;
    return adviceTurn(
      "لم أتمكن من بدء مسودة الإعلان؛ لم يُنشر أي إعلان.",
      { kind: "CLARIFICATION_REQUIRED", scope: "SELLER_DRAFT" },
      { ownerId: input.actorId },
    );
  }
  // Purchase and price-offer suggestions only open the same review a typed command opens.
  if (turn.suggestedAction === "REVIEW_PURCHASE" && reference) {
    const reviewed = await review(`أبي ${reference}`);
    if (reviewed) return reviewed;
  }
  if (turn.suggestedAction === "REVIEW_PRICE_OFFER" && turn.entities?.amount) {
    const reviewed = await review(`${reference ? `${reference} ` : ""}أعطيه ${turn.entities.amount}`);
    if (reviewed) return reviewed;
  }
  // Every action the server performs or opens has returned above, so this turn changed nothing:
  // the reply is the model's (authority MODEL) and a suggested action is at most PROPOSED. The
  // ledger, not this text, is the evidence of any action (action-receipts.ts).
  const commercialTurn = requestsMarketAction || turn.goal === "BUY" || turn.goal === "SELL" || turn.goal === "NEGOTIATE";
  const answer = outcome.replyFiltered
    ? "لا أملك بيانات داخل DINAR تؤكد حجم الطلب أو تضمن البيع. أستطيع مقارنة الأسعار المعروضة داخل DINAR إن أردت."
    : turn.conversationalReply;
  // Copy drafted from the seller's own listing record is grounded in DINAR data, not general knowledge.
  const groundedCopy = Boolean(context.sellerListing) && !outcome.replyFiltered;
  const advised = adviceTurn(
    answer,
    {
      kind: turn.responseKind === "CLARIFICATION_REQUIRED" ? "CLARIFICATION_REQUIRED" : "CONVERSATIONAL_RESPONSE",
      ...(groundedCopy
        ? { scope: "DINAR_INTERNAL", topic: "MARKETING_COPY", label: "مبني على بيانات إعلانك في DINAR" }
        : commercialTurn
          // In a commercial turn the text is narration: the status is in the ledger's cards.
          ? { scope: "ASSISTANT_TEXT", label: "ردّ المساعد — ليس تأكيدًا لأي إجراء" }
          : { scope: "GENERAL_KNOWLEDGE", label: "معلومة عامة وليست من بيانات DINAR" }),
      ...(turn.missingFacts?.length ? { missingFacts: turn.missingFacts } : {}),
      authority: "MODEL",
      commercial: commercialTurn && !groundedCopy,
      ...(turn.suggestedAction && turn.suggestedAction !== "NONE" ? { actionLifecycle: "PROPOSED" } : {}),
    },
    { ownerId: input.actorId },
  );
  const enforced = enforceModelAuthority(advised.result as typeof advised.result & { advice?: Record<string, unknown> }, context.actionReceipts ?? []);
  return { ...advised, result: { ...enforced, prompt: usageNote ? `${enforced.prompt}\n\n${usageNote}` : enforced.prompt } };
}

/** One honest line when this answer took the allowance across the near-limit share. */
async function nearLimitFor(owner: AiUsageOwner, resource: ReturnType<typeof usageResourceFor>): Promise<string | undefined> {
  try {
    const summary = await aiUsageSummary(owner);
    const item = summary.resources.find((row) => row.resource === resource);
    if (!item || item.limit <= 0) return undefined;
    const line = Math.round(summary.nearLimitRatio * 100);
    const before = Math.round(((item.used - 1) / item.limit) * 100);
    return item.percent !== null && before < line && item.percent >= line ? nearLimitNote(resource, item.percent, summary.period.renewsAt, summary.period.timeZone) : undefined;
  } catch {
    return undefined;
  }
}

export function modelFailureMessage(reason: ModelFailure): string {
  if (reason === "QUOTA_LIMITED")
    return "وصل مزود المساعد الذكي إلى حد الاستخدام المتاح مؤقتًا. لم يُنفّذ أي إجراء. يمكنك متابعة البحث يدويًا أو المحاولة لاحقًا.";
  if (reason === "NOT_CONFIGURED")
    return "الدردشة الذكية غير متاحة في هذه البيئة حاليًا. لم يُنفّذ أي إجراء.";
  if (reason === "TIMEOUT" || reason === "UNAVAILABLE")
    return "تعذر عليّ التفكير في هذا الآن، ولم يتغير شيء. حاول مرة أخرى لاحقًا.";
  return "لم أفهم طلبك بدقة، ولم أنفذ شيئًا. هل يمكنك توضيح ما تقصده؟";
}
