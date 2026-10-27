/**
 * Block F2 — buyer search, refinement, ranking, comparison and selection inside the shared
 * DINAR conversation runtime. Not a new search engine: every list comes from the Block A
 * search authority (market, moderation, seller, policy, hard filters, availability), and
 * this adapter only keeps the buyer's stated constraints in the persisted result set,
 * re-ranks with transparent signals, and hands a chosen listing to the F0 action layer.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { aiResultSets, aiUiBlocks, db, orderFulfillments, orders } from "@workspace/db";
import type { SearchFilter, SearchSort } from "@workspace/api-zod/marketplace-schemas";
import type { marketFor } from "../lib/markets";
import type { ListingRecord } from "../lib/dinar-data";
import { categorySchema, listMarketplaceCategories } from "../lib/marketplace-categories";
import { publishedListingCities, searchMarketplaceListings } from "../lib/marketplace-listings";
import { storedSponsoredIds } from "../lib/recommendations";
import { normalizeSearch } from "./search-context";
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import { interpretMarketplaceTurn } from "./marketplace-intent";
import { SearchFilterInput } from "./search-state";
import {
  commandFacts,
  confirmPendingAction,
  createPendingAction,
  parseCommandNumbers,
  proposeAction,
  listingFulfilmentOptions,
  NEGOTIABLE_NEEDS_AGREEMENT,
  readListingForBuyer,
  readServerSnapshot,
  resolveReference,
  type ActionReview,
} from "./action-foundation";
import { METHOD_LABELS, deliveryOptions, orderReference, type DeliveryMethod } from "../lib/delivery";
import { hasEligibleCourierSupply } from "../lib/courier-supply";
import { paymentSimulationEnabled } from "../routes/payments";
import { deliveryIntent, normalizeDeliveryText } from "./delivery-turn";
import type { ToolResult } from "./tool-registry";
import { getAuthorizedSellerContacts } from "../lib/contact-release";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };
type StoredSet = typeof aiResultSets.$inferSelect;

export type BuyerRanking = "DEFAULT" | "CHEAPEST" | "BEST_VALUE" | "CONDITION_FIRST";

const BuyerState = z
  .object({
    search: z.string().max(200),
    categoryId: z.string().max(80).optional(),
    filters: z.array(SearchFilterInput).max(12),
    targetPrice: z.number().positive().optional(),
    maxPrice: z.number().positive().optional(),
    color: z.string().max(40).optional(),
    size: z.string().max(20).optional(),
    /** «مستعمل» or «جديد»: matched on the listing's own condition, like colour and size. */
    condition: z.enum(["مستعمل", "جديد"]).optional(),
    quality: z.boolean().optional(),
    ranking: z.enum(["DEFAULT", "CHEAPEST", "BEST_VALUE", "CONDITION_FIRST"]).default("DEFAULT"),
    message: z.string().max(600).optional(),
    reasons: z.record(z.string(), z.array(z.string().max(120)).max(6)).optional(),
  })
  .passthrough();
export type BuyerState = z.infer<typeof BuyerState>;

// ─── Phrases ─────────────────────────────────────────────────────────────────

export function normalizeBuyerText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;:.()«»"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const COLORS = ["اسود", "ابيض", "احمر", "ازرق", "اخضر", "اصفر", "رمادي", "بني", "وردي", "كحلي", "بيج", "برتقالي", "بنفسجي", "سوداء", "بيضاء", "حمراء", "زرقاء", "خضراء", "صفراء"];
const COLOR = new RegExp(`^(?:(?:خله|خليه|خليها|خلها|بدي|ابي|اريد|ابغي)\\s+)?(?:(?:اللون|لون|باللون)\\s+)?(${COLORS.join("|")})$`, "u");
const SIZE = /^(?:(?:بدي|ابي|اريد|خله|خليه)\s+)?(?:مقاس|قياس|سايز|size)\s*([a-z]{1,4}|\d{2,3}|صغير|وسط|كبير)$/u;
const MAX_PRICE = /(?:عادي|ما عندي مشكله|ما في مشكله|لحد|حدي|ميزانيتي|اقصي|بحدود)/u;
const QUALITY_WORDS = /(?:^|\s)(?:مميز|مميزه|ممتاز|ممتازه|فخم|فخمه|اصلي)(?=\s|$)/gu;
const CHEAPEST = /^(?:(?:انا\s+)?(?:ابي|اريد|بدي|ابغي)\s+)?(?:ال)?ارخص(?:\s+(?:واحد|شي|شيء|فقط|بس|منهم))*$|(?:^|\s)(?:اهم شي|اهم شيء|المهم|يهمني)\s+(?:ال)?سعر(?:\s|$)|(?:^|\s)السعر\s+فقط(?:\s|$)/u;
/** «رتب الأرخص», «رتبها من الأرخص», «الأرخص أولا», «رتب حسب السعر من الأقل»: the same ranking, so the current filters stay. */
const CHEAPEST_SORT = /^(?:(?:رتب|رتبها|رتبهم|رتبلي|نظم|نظمها|نظمهم|خلها|خليها)\s+)?(?:(?:حسب|ب)\s*(?:ال)?سعر\s+)?(?:(?:من\s+)?(?:ال)?ارخص|(?:من\s+)?(?:ال)?اقل\s+سعرا?|من\s+(?:ال)?اقل)(?:\s+(?:اولا|اول|الي\s+الاغلي|للاغلي|فالاغلي))?$/u;
const CONDITION_FIRST = /(?:^|\s)(?:اهم شي|اهم شيء|المهم|يهمني|اهتم)\s+(?:ب)?(?:ال)?حاله(?:\s|$)|ما يهمني السعر/u;
const BEST = /^(?:(?:انا\s+)?(?:ابي|اريد|بدي|ابغي|اعطني|وريني|ارني)\s+)?(?:ال)?افضل(?:\s+(?:واحد|شي|شيء|قيمه|منهم))?(?:\s+مقابل\s+(?:ال)?سعر)?(?:\s+حتي\s+لو\s+(?:اغلي|ازيد)(?:\s+\S+){0,2})?$|^افضل\s+قيمه(?:\s+مقابل\s+(?:ال)?سعر)?$|^(?:اي\s+واحد|ايهم|مين|شو|وش|ايش)\s+(?:ال)?افضل(?:\s+(?:فيهم|منهم))?$/u;
/**
 * «فقط المستعملة», «المستعمل فقط», «الحالة جديد»: a condition filter on the current list. The
 * whole message must be the refinement; product words make it a new search instead.
 */
const CONDITION_REFINE = /^(?:(?:فقط|بس|اعرض|اعرضلي|وريني|ابي|اريد|بدي|ابغي|خليها|خلها)\s+)*(?:(?:ال)?حاله\s+)?(?:ال)?(مستعمل|مستعمله|مستخدم|مستخدمه|جديد|جديده)(?:\s+(?:فقط|بس))?$/u;
/** «حتى لو أغلى ألف»: the buyer raises their own ceiling by an amount. */
const RAISE = /حتي\s+لو\s+(?:اغلي|ازيد)\s+(?:ب\s*)?(الف|الفين|\d+(?:\.\d+)?)/u;
/** «رخيص» in a new search orders by price; it is never a word to match. */
const CHEAP = /(?:^|\s)(?:رخيص|رخيصه|بسعر رخيص|رخيص السعر)(?=\s|$)/u;
/** A need without a product («أنا جائع»): ask what, rather than search the feeling. */
const NEED_ONLY = /^(?:انا\s+)?(?:جوعان|جوعانه|جائع|جائعه|جعان|جعانه|عطشان|عطشانه)$/u;
// «أريد أن أشتري شيئًا» names no item: searching DINAR for the word «شيء» finds nothing useful.
const VAGUE_PURCHASE = /^(?:(?:انا|دينار)\s+)?(?:ابي|ابغي|بدي|اريد|احتاج|حاب|ودي)\s+(?:ان\s+)?(?:اشتري|شراء|اشتري لي|اشوف|ادور علي|ابحث عن)\s+(?:شي|شيء|شيئا|شيا|شيئ|حاجه|حاجات|اغراض|اشياء|منتج|غرض)$/u;
const COMPARE = /^(?:قارن|قارنلي|قارن لي|مقارنه|قارن بين)\s+(.+)$/u;
const SELECT = /^(?:انا\s+)?(?:ابي|ابغي|بدي|اريد|اشتري|بشتري|اخذ|باخذ|حاب اخذ|خذ)\s+(?:اشتري\s+|اخذ\s+)?(.+)$/u;
const CONFIRM = /^(?:(?:تمام|طيب|اوكي|خلاص)\s+)?(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نفذ|اضف|اضفه|اضيفه|اكد الشراء)$/u;
const CANCEL = /^(?:لا|كلا|الغاء|الغ|الغي|تراجع|لا شكرا)$/u;
const WANT_FOCUSED_LISTING = /^(?:ابيه|ابيها|ابغاه|ابغاها|ابغيه|ابغيها|بديه|بديها|اريده|اريدها)$/u;

const ORDINAL_TOKENS: Record<string, number> = {
  الاول: 1, اول: 1, الاولي: 1, الثاني: 2, ثاني: 2, الثانيه: 2, الثالث: 3, ثالث: 3, الثالثه: 3, الرابع: 4, الرابعه: 4,
  الخامس: 5, الخامسه: 5, السادس: 6, السادسه: 6,
};

/** Every position named in "قارن الأول والثالث" / "قارن 1 و 3", in order. */
function positionsIn(text: string): number[] {
  const positions: number[] = [];
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/^و(?=ال|\d)/u, "");
    const value = ORDINAL_TOKENS[word] ?? (/^\d{1,2}$/.test(word) ? Number(word) : undefined);
    if (value && !positions.includes(value)) positions.push(value);
  }
  return positions;
}

const ORDINAL_REFERENCE_ACTIONS = new Set(["افتح", "اعرض", "وريني", "ارني", "شوف", "شوفي", "تفاصيل", "معلومات", "مواصفات"]);
function isOrdinalReference(text: string): boolean {
  const words = text.split(/\s+/u);
  if (positionsIn(text).length !== 1) return false;
  const isPosition = (word: string) => ORDINAL_TOKENS[word] !== undefined || /^\d{1,2}$/u.test(word);
  return words.length === 1 ||
    (words.length === 2 && (
      (ORDINAL_REFERENCE_ACTIONS.has(words[0]!) && isPosition(words[1]!)) ||
      (words[0] === "رقم" && isPosition(words[1]!))
    )) ||
    (words.length === 3 && ORDINAL_REFERENCE_ACTIONS.has(words[0]!) && words[1] === "رقم" && isPosition(words[2]!));
}

// ─── State ───────────────────────────────────────────────────────────────────

const isListingQuery = (query: unknown) => {
  const kind = (query as { kind?: unknown } | null)?.kind;
  return kind === undefined;
};

export async function latestListingSet(conversationId: string, marketId: string): Promise<StoredSet | undefined> {
  const sets = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(12);
  return sets.find((set) => (!set.expiresAt || set.expiresAt.getTime() > Date.now()) && isListingQuery(set.query));
}

/** The constraints of the current list: the buyer layer's own, or Block A's stored search. */
export function stateOf(set: StoredSet | undefined): BuyerState | undefined {
  if (!set) return undefined;
  const query = set.query as Record<string, unknown>;
  const own = BuyerState.safeParse(query.buyer);
  if (own.success) return own.data;
  if (query.recommendation) return undefined;
  const filters = z.array(SearchFilterInput).safeParse(query.filters ?? []);
  return {
    search: typeof query.search === "string" ? query.search : "",
    ...(typeof query.categoryId === "string" ? { categoryId: query.categoryId } : {}),
    filters: filters.success ? filters.data : [],
    ranking: "DEFAULT",
  };
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

const priceOf = (listing: ListingRecord) => {
  const value = listing.unitPrice === null ? NaN : Number(listing.unitPrice);
  return Number.isFinite(value) ? value : null;
};
const textOf = (listing: ListingRecord) =>
  normalizeBuyerText([listing.title, listing.description, ...Object.values(listing.attributes ?? {})].join(" "));
const conditionOf = (listing: ListingRecord) => {
  const value = listing.attributes?.condition;
  return typeof value === "string" ? normalizeSearch(value) : undefined;
};

/**
 * Transparent, deterministic signals only: relevance to the words asked for, condition,
 * price (closeness to a stated target, else cheapness within the list), completeness,
 * availability, freshness and an existing seller rating. Payment is not a signal.
 */
export function rankListings(listings: ListingRecord[], state: BuyerState): { ordered: ListingRecord[]; reasons: Record<string, string[]> } {
  const reasons: Record<string, string[]> = {};
  const prices = listings.map(priceOf).filter((value): value is number => value !== null);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const words = normalizeBuyerText(state.search).split(" ").filter((word) => word.length >= 2);
  const weights =
    state.ranking === "CONDITION_FIRST"
      ? { relevance: 0.15, condition: 0.55, price: 0.1, quality: 0.15, fresh: 0.05 }
      : { relevance: 0.25, condition: 0.2, price: 0.3, quality: 0.2, fresh: 0.05 };
  const scored = listings.map((listing) => {
    const why: string[] = [];
    const title = normalizeBuyerText(listing.title);
    const relevance = words.length ? words.filter((word) => title.includes(word)).length / words.length : 0;
    if (words.length && relevance === 1) why.push("يطابق كل ما طلبته في العنوان");
    const condition = conditionOf(listing);
    const conditionScore = condition === "جديد" ? 1 : condition === "مستعمل" ? 0.5 : 0.25;
    why.push(condition ? `الحالة: ${listing.attributes!.condition}` : "الحالة غير مذكورة");
    const price = priceOf(listing);
    let priceScore = 0;
    if (price !== null && state.targetPrice) {
      priceScore = Math.max(0, 1 - Math.abs(price - state.targetPrice) / state.targetPrice);
      if (Math.abs(price - state.targetPrice) / state.targetPrice <= 0.2) why.push(`قريب من سعرك ${state.targetPrice}`);
    } else if (price !== null && prices.length > 1 && max > min) {
      priceScore = (max - price) / (max - min);
      if (price === min) why.push("الأرخص في هذه النتائج");
    }
    const images = (listing.imageUrls?.length ?? 0) + (listing.imageUrl ? 1 : 0);
    const complete = Number(images > 0) * 0.5 + Number((listing.description ?? "").length >= 40) * 0.5;
    if (complete === 1) why.push("إعلان مكتمل بالصور والوصف");
    const fresh = Date.now() - new Date(listing.createdAt).getTime() <= 30 * 86_400_000 ? 1 : 0;
    const rating = listing.reviewCount > 0 ? Math.min(listing.rating, 5) / 5 : 0;
    if (listing.reviewCount > 0) why.push(`تقييم البائع ${listing.rating}/5`);
    const score =
      weights.relevance * relevance +
      weights.condition * conditionScore +
      weights.price * priceScore +
      weights.quality * complete +
      weights.fresh * fresh +
      0.05 * rating;
    reasons[listing.id] = why.slice(0, 4);
    return { listing, score, price };
  });
  scored.sort((a, b) => {
    if (state.ranking === "CHEAPEST") {
      if (a.price !== b.price) return a.price === null ? 1 : b.price === null ? -1 : a.price - b.price;
    } else if (b.score !== a.score) return b.score - a.score;
    return new Date(b.listing.createdAt).getTime() - new Date(a.listing.createdAt).getTime() || a.listing.id.localeCompare(b.listing.id);
  });
  if (state.ranking === "CHEAPEST")
    for (const { listing, price } of scored) reasons[listing.id] = [price === null ? "السعر بالاتفاق" : `السعر ${listing.unitPrice} ${listing.currency}`, ...(reasons[listing.id] ?? []).filter((reason) => !reason.startsWith("الأرخص"))].slice(0, 3);
  return { ordered: scored.map((item) => item.listing), reasons };
}

const RANKING_TEXT: Record<BuyerRanking, string> = {
  DEFAULT: "",
  CHEAPEST: "رتّبتها من الأرخص إلى الأغلى.",
  BEST_VALUE:
    "رتّبتها حسب «أفضل قيمة مقابل السعر» تقديريًا: مطابقة طلبك، الحالة، السعر، اكتمال الإعلان، والحداثة. هذا ترتيب تقديري وليس حكمًا قاطعًا.",
  CONDITION_FIRST: "رتّبتها بحسب الحالة أولًا كما طلبت، ثم مطابقة طلبك والسعر. هذا ترتيب تقديري.",
};

/** Re-runs Block A search with the buyer's constraints and orders the result. */
export async function runBuyerSearch(market: Market, state: BuyerState): Promise<ToolResult> {
  const filters: SearchFilter[] = [
    ...state.filters.filter((filter) => !(filter.field === "price" && ["eq", "lte", "lt"].includes(filter.operator) && state.maxPrice)),
    ...(state.maxPrice ? [{ field: "price", operator: "lte", value: state.maxPrice } as SearchFilter] : []),
  ];
  const sponsoredView = state.ranking === "DEFAULT";
  const found = await searchMarketplaceListings(market, {
    search: state.search,
    conversational: true,
    ...(state.categoryId ? { categoryId: state.categoryId } : {}),
    filters,
    ...(sponsoredView ? {} : { sponsoredPlacement: false as const }),
    limit: 200,
  });
  // Colour and size are matched as whole words in the listing's own text when the
  // category has no such attribute; nothing is assumed about listings that omit them.
  const matching = found.filter((listing) => {
    const text = ` ${textOf(listing)} `;
    if (state.color && !text.includes(` ${normalizeSearch(state.color)} `)) return false;
    if (state.size && !new RegExp(`(?:\\s|مقاس|قياس|سايز)${state.size}(?:\\s)`, "u").test(text)) return false;
    if (state.condition) {
      // The listing's own condition decides; without one, only its own words can.
      const own = listing.attributes?.condition;
      const wanted = state.condition === "مستعمل" ? /(?:^|\s)(?:ال)?(?:مستعمل|مستعمله|مستخدم|مستخدمه)(?:\s|$)/u : /(?:^|\s)(?:ال)?(?:جديد|جديده)(?:\s|$)/u;
      if (own != null ? !wanted.test(` ${normalizeBuyerText(String(own))} `) : !wanted.test(text)) return false;
    }
    return true;
  });
  let listings: ListingRecord[];
  let reasons: Record<string, string[]> = {};
  if (sponsoredView) {
    // Default view keeps Block A's capped, labelled paid slots; the organic rest is
    // ordered by closeness to a stated target price.
    const paid = matching.filter((listing) => listing.isSponsored);
    const organic = matching.filter((listing) => !listing.isSponsored);
    const ranked = state.targetPrice ? rankListings(organic, state) : { ordered: organic, reasons: {} };
    if (state.targetPrice)
      ranked.ordered.sort((a, b) => Math.abs((priceOf(a) ?? Infinity) - state.targetPrice!) - Math.abs((priceOf(b) ?? Infinity) - state.targetPrice!));
    listings = [...paid, ...ranked.ordered];
    reasons = ranked.reasons;
  } else {
    const ranked = rankListings(matching, state);
    listings = ranked.ordered;
    reasons = ranked.reasons;
  }
  listings = listings.slice(0, 24).map((listing) => (reasons[listing.id] ? { ...listing, recommendationReasons: reasons[listing.id] } : listing));
  const kept = Object.fromEntries(listings.filter((listing) => reasons[listing.id]).map((listing) => [listing.id, reasons[listing.id]!]));
  const notes = [
    state.color ? `اللون ${state.color}` : "",
    state.size ? `المقاس ${state.size.toUpperCase()}` : "",
    state.condition ? `الحالة ${state.condition}` : "",
    state.maxPrice ? `حتى ${state.maxPrice} ${market.currencyCode}` : "",
    state.targetPrice && !state.maxPrice ? `حول ${state.targetPrice} ${market.currencyCode}` : "",
  ].filter(Boolean);
  const message = [
    listings.length
      ? `وجدت ${listings.length} ${listings.length === 1 ? "عرضًا" : "عروض"} داخل DINAR${notes.length ? ` (${notes.join("، ")})` : ""}.`
      : `لم أجد عروضًا مطابقة داخل DINAR${notes.length ? ` (${notes.join("، ")})` : ""}. جرّب إزالة أحد الشروط.`,
    RANKING_TEXT[state.ranking],
    state.ranking !== "DEFAULT" ? "العروض الممولة لا تحصل على أي أفضلية في هذا الترتيب." : "",
    state.quality ? "«مميز» تفضيل شخصي لا أستطيع التحقق منه؛ اعتمدت على الحالة والسعر واكتمال الإعلان." : "",
    state.color || state.size ? "اللون والمقاس ليسا خاصيتين مسجلتين في هذه الفئة، فبحثت عنهما في نص الإعلان." : "",
  ].filter(Boolean).join(" ");
  const sponsoredIds = listings.filter((listing) => listing.isSponsored).map((listing) => listing.id);
  return {
    kind: "SEARCH",
    query: {
      search: state.search,
      category: null,
      categoryId: state.categoryId ?? null,
      filters,
      ...(state.ranking === "CHEAPEST" ? { sort: "PRICE_ASC" as SearchSort } : {}),
      ...(sponsoredIds.length ? { sponsoredIds } : {}),
      buyer: { ...state, message, reasons: kept },
    },
    listings,
  };
}

// ─── Comparison and selection ────────────────────────────────────────────────

async function comparison(set: StoredSet, positions: number[], market: Market): Promise<Turn> {
  const ids = positions.map((position) => set.resourceIds[position - 1]);
  if (positions.length < 2 || ids.some((id) => !id))
    return notice(`اختر رقمين ظاهرين في النتائج الحالية للمقارنة (لديك ${set.resourceIds.length}).`);
  const live = await searchMarketplaceListings(market, { search: "", allowedIds: ids as string[], sponsoredIds: storedSponsoredIds(set.query), limit: 6 });
  const byId = new Map(live.map((listing) => [listing.id, listing]));
  const listings = (ids as string[]).map((id) => byId.get(id));
  if (listings.some((listing) => !listing)) return notice("أحد العروض لم يعد متاحًا؛ لم أقارن بيانات قديمة.");
  const categories = new Map((await listMarketplaceCategories()).map((row) => [row.id, categorySchema(row)]));
  const attributeKeys = new Set<string>();
  for (const listing of listings) {
    for (const key of Object.keys(categories.get(listing!.categoryId ?? "")?.attributes ?? {})) attributeKeys.add(key);
    for (const key of Object.keys(listing!.attributes ?? {})) attributeKeys.add(key);
  }
  const unknown = null;
  const row = (label: string, value: (listing: ListingRecord) => string | number | null) => ({
    label,
    values: listings.map((listing) => value(listing!) ?? unknown),
  });
  const rows = [
    row("السعر", (listing) => (listing.unitPrice === null ? "بالاتفاق" : `${listing.unitPrice} ${listing.currency}`)),
    ...[...attributeKeys].map((key) =>
      row(categories.get(listings[0]!.categoryId ?? "")?.attributes[key]?.label ?? key, (listing) => listing.attributes?.[key] ?? null),
    ),
    row("المدينة", (listing) => listing.city || null),
    row("التوفر", (listing) =>
      listing.inventoryMode === "UNLIMITED" ? "متاح" : `${(listing.availableQuantity ?? 0) - listing.reservedQuantity} قطعة`),
    row("الاستلام", (listing) => ({ PICKUP: "استلام", DELIVERY: "توصيل", SERVICE: "خدمة", DIGITAL: "رقمي" })[listing.fulfilmentType] ?? null),
    row("الصور", (listing) => (listing.imageUrls?.length ?? 0) + (listing.imageUrl ? 1 : 0)),
    row("تقييم البائع", (listing) => (listing.reviewCount > 0 ? `${listing.rating}/5 (${listing.reviewCount})` : null)),
  ];
  return {
    tool: "buyerCompare",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "COMPARISON",
      resourceIds: ids as string[],
      query: {},
      listings: [],
      comparison: {
        positions,
        resultSetId: set.id,
        listings: listings.map((listing) => ({ id: listing!.id, title: listing!.title, isSponsored: Boolean(listing!.isSponsored) })),
        rows,
        unknownLabel: "غير معروف",
      },
      prompt: "قارنت البيانات الحالية من DINAR فقط. ما لم يذكره البائع يظهر «غير معروف» ولم أفترض قيمته.",
    },
  };
}

export function notice(prompt: string): Turn {
  return { tool: "buyer", version: 1, result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], prompt } };
}

async function purchaseReview(input: { conversationId: string; market: Market; actorId: string; message: string; quantity?: number }): Promise<Turn> {
  const reference = await resolveReference({ conversationId: input.conversationId, marketId: input.market.id, actorId: input.actorId, message: input.message });
  if (!reference) return notice("هذا الرقم غير موجود في النتائج الحالية. اختر عرضًا ظاهرًا في القائمة.");
  const snapshot = await readListingForBuyer(input.actorId, reference.resourceId);
  if (snapshot?.unitPriceMinor === null && snapshot.agreedQuantity === undefined)
    return notice("هذا العرض يقبل العروض وليس له سعر معلن. اتفق مع البائع على السعر أولًا؛ يمكنك طلب أفضل سعر أو تقديم عرض.");
  // Same rule as the cart and checkout: no review is offered that the cart would refuse.
  if (snapshot && !snapshot.directPurchase && snapshot.agreedQuantity === undefined)
    return notice(
      `${snapshot.priceRepresentation === "STARTING_FROM"
        ? "هذا السعر يبدأ من المبلغ المعلن وليس سعرًا نهائيًا؛ اطلب تسعيرة أو قدّم عرضًا أولًا"
        : NEGOTIABLE_NEEDS_AGREEMENT}. لم يُضف شيء إلى السلة.`,
    );
  const stated = input.quantity ?? parseCommandNumbers(input.message).quantity;
  const quantity = stated ?? 1;
  const proposal = proposeAction({
    action: "ADD_TO_CART",
    targetResource: reference.resourceId,
    facts: { ...commandFacts(input.message), quantity: [{ value: quantity, source: stated ? "USER_DECLARED" : "DINAR_DERIVED" }] },
  });
  const review = await createPendingAction({ conversationId: input.conversationId, actorId: input.actorId, market: input.market, proposal });
  return purchaseReviewTurn(input.market, input.actorId, reference.resourceId, quantity, review);
}

type PurchaseStage = "ADD_TO_CART" | "PLACE_ORDER";

/** PURCHASE_REVIEW for a stored pending action; built from current server data. */
export async function purchaseReviewTurn(
  market: Market,
  actorId: string,
  listingId: string,
  quantity: number,
  review: { actionId: string; lines: string[]; expiresAt: string },
  stage: PurchaseStage = "ADD_TO_CART",
  fulfilment?: DeliveryMethod,
): Promise<Turn> {
  const [listing] = await searchMarketplaceListings(market, { search: "", allowedIds: [listingId], limit: 1 });
  // G2: the price this buyer will actually pay — a private agreed price when one exists.
  const snapshot = await readListingForBuyer(actorId, listingId);
  const negotiated = snapshot?.agreedQuantity !== undefined && snapshot.unitPriceMinor !== null;
  const scale = market.minorUnitScale;
  const unitPrice = negotiated ? (snapshot!.unitPriceMinor! / 10 ** scale).toFixed(scale) : (listing?.unitPrice ?? null);
  const unitMinor = negotiated ? snapshot!.unitPriceMinor! : listing?.unitPrice === null || listing?.unitPrice === undefined ? null : Math.round(Number(listing.unitPrice) * 10 ** scale);
  // Only methods the listing actually offers; courier and external providers never are.
  const options = listingFulfilmentOptions(snapshot?.fulfilmentType, market);
  const prompt =
    stage === "ADD_TO_CART"
      ? `راجع اختيارك: «${listing?.title ?? ""}» × ${quantity}. لن يُضاف إلى السلة ولن يُدفع أي شيء قبل تأكيدك؛ اكتب «نعم» أو «إلغاء»، أو «اطلبه الآن» لمراجعة الطلب مباشرة.`
      : `مراجعة الطلب: «${listing?.title ?? ""}» × ${quantity}. ${
          fulfilment ? `التسليم: ${METHOD_LABELS[fulfilment]}.` : options.length ? `طرق التسليم المتاحة: ${options.map((option) => option.label).join("، ")}؛ تختارها الآن أو بعد إنشاء الطلب.` : "لا توجد طريقة تسليم داخل DINAR لهذا العرض."
        } لن يُنشأ الطلب ولن يُدفع أي شيء قبل تأكيدك؛ اكتب «نعم» أو «إلغاء».`;
  return {
    tool: "buyerSelect",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "PURCHASE_REVIEW",
      resultSetId: review.actionId,
      resourceIds: [listingId],
      resourceId: listingId,
      query: {},
      listings: [],
      purchaseReview: {
        actionId: review.actionId,
        stage: stage === "ADD_TO_CART" ? "ITEM" : "ORDER",
        status: "PENDING",
        listingId,
        title: listing?.title ?? "",
        sellerName: listing?.sellerName ?? "",
        unitPrice,
        paymentMethods: listing?.paymentMethods ?? [],
        ...(negotiated ? { negotiated: true, publicUnitPrice: listing?.unitPrice ?? null } : {}),
        currency: market.currencyCode,
        quantity,
        total: unitMinor === null ? null : ((unitMinor * quantity) / 10 ** scale).toFixed(scale),
        available: snapshot?.available ?? null,
        fulfilmentType: listing?.fulfilmentType ?? null,
        ...(stage === "PLACE_ORDER" ? { fulfilment: fulfilment ?? null, fulfilmentOptions: options } : {}),
        actions: ["CONTINUE", "CHANGE_QUANTITY", "BACK", "CANCEL"],
        lines: review.lines,
        expiresAt: review.expiresAt,
      },
      prompt,
    },
  };
}

/** History reload: a purchase review shows its current server status. */
export async function refreshPurchaseReview(review: Record<string, unknown>, query: unknown, expiresAt?: Date | null) {
  const stored = query as { kind?: unknown; status?: unknown } | undefined;
  let status = stored?.kind === "ACTION" && typeof stored.status === "string" ? stored.status : "EXPIRED";
  if (status === "PENDING" && expiresAt && expiresAt.getTime() <= Date.now()) status = "EXPIRED";
  return { ...review, status: status === "SUPERSEDED" ? "EXPIRED" : status };
}

// ─── Turn ────────────────────────────────────────────────────────────────────

export async function executeBuyerTurn(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const text = normalizeBuyerText(input.message);

  // Decisions on this actor's own latest pending purchase review.
  const [latest] = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, input.conversationId), eq(aiResultSets.marketId, input.market.id)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const pending = latest?.query as { kind?: unknown; ownerId?: unknown; status?: unknown; action?: unknown } | undefined;
  if (pending?.kind === "ACTION" && pending.ownerId === actorId && pending.status === "PENDING" && pending.action === "ADD_TO_CART" && (CONFIRM.test(text) || CANCEL.test(text))) {
    const outcome = await confirmPendingAction({ actionId: latest!.id, actorId, market: input.market, decision: CONFIRM.test(text) ? "CONFIRM" : "CANCEL" });
    if (outcome.status === "REVIEW_REQUIRED") {
      // Price or stock changed since the review: the old confirmation is void; review again.
      const quantity = Number((latest!.query as { structuredInput?: { quantity?: { value?: unknown } } }).structuredInput?.quantity?.value ?? 1);
      const turn = await purchaseReviewTurn(input.market, actorId, outcome.review.targetResource, quantity, outcome.review);
      turn.result.prompt = `${outcome.message} ${turn.result.prompt}`;
      return turn;
    }
    if (outcome.status === "CONFIRMED")
      return { tool: "buyerSelect", version: 1, result: { kind: "SURFACE", surface: "CART", query: {}, listings: [], prompt: "أُضيف العرض إلى سلتك بعد التحقق من السعر والتوفر الحاليين. راجع السلة قبل إكمال الطلب؛ لم يُدفع أي شيء." } };
    return notice(outcome.message);
  }

  const set = await latestListingSet(input.conversationId, input.market.id);
  const state = stateOf(set);

  // Resolve a bare ordinal against the active buyer result set before an open
  // message can fall through to general advice. An empty set is still the
  // current context; it must not expose or reuse an older listing result.
  const ordinalPosition = isOrdinalReference(text) ? positionsIn(text)[0] : undefined;
  if (set && state && ordinalPosition !== undefined && (set.resourceIds.length === 0 || ordinalPosition > set.resourceIds.length))
    return notice(set.resourceIds.length === 0
      ? "ما عندي نتائج أقدر أختار منها الآن. حدّث البحث أو اكتب طلبًا جديدًا."
      : `لا يوجد العرض رقم ${ordinalPosition} ضمن النتائج الحالية. اختر رقمًا ظاهرًا أو ابدأ بحثًا جديدًا.`);

  const compare = text.match(COMPARE);
  if (compare && set) return comparison(set, positionsIn(compare[1]!), input.market);

  if (NEED_ONLY.test(text))
    return notice("ماذا تريد أن تأكل أو تشرب؟ اكتب اسم الوجبة أو المنتج، مثل «بروستد» أو «برجر»، وسأبحث في عروض DINAR.");
  if (VAGUE_PURCHASE.test(text))
    return notice("ماذا تريد أن تشتري؟ اكتب اسم المنتج أو الخدمة، وإن أردت الميزانية والمدينة، مثل «هاتف سامسونج بأقل من 200» — وسأبحث في عروض DINAR المنشورة في سوقك.");

  // «الأول، أبي اثنين»: a position and a quantity in one message, each read for itself.
  const pickWithQuantity = text.match(/^(\S+)\s+(?:ابي|اريد|بدي|ابغي|خذ)\s+(.+)$/u);
  if (set && pickWithQuantity && ORDINAL_TOKENS[pickWithQuantity[1]!] !== undefined) {
    const quantity = reviewQuantity(pickWithQuantity[2]!);
    if (quantity !== undefined)
      return purchaseReview({ conversationId: input.conversationId, market: input.market, actorId, message: `أبي ${pickWithQuantity[1]}`, quantity });
  }

  const select = text.match(SELECT);
  const wantsFocusedListing = WANT_FOCUSED_LISTING.test(text);
  // «أريد تفاصيل الثاني» asks to see a result, not to buy it.
  if (set && (wantsFocusedListing || (select && !/^(?:تفاصيل|معلومات|مواصفات)(?:\s|$)/u.test(select[1]!.trim())))) {
    const target = wantsFocusedListing ? "هذا" : select![1]!.trim();
    const deictic = wantsFocusedListing || /^(?:هذا|هذه|هذي|هاد)$/u.test(target);
    if (deictic || parseCommandNumbers(input.message).ordinal !== undefined)
      return purchaseReview({
        conversationId: input.conversationId,
        market: input.market,
        actorId,
        message: wantsFocusedListing ? "أبي هذا" : input.message,
      });
  }

  // Ranking requests on the current list; a leading «لا» only corrects the previous one.
  const asked = text.replace(/^(?:لا|لأ)\s+/u, "");
  const ranking: BuyerRanking | undefined = CONDITION_FIRST.test(asked)
    ? "CONDITION_FIRST"
    : CHEAPEST.test(asked) || CHEAPEST_SORT.test(asked)
      ? "CHEAPEST"
      : BEST.test(asked)
        ? "BEST_VALUE"
        : undefined;
  if (ranking && state) {
    const raise = asked.match(RAISE);
    const ceiling = state.maxPrice ?? state.filters.find((filter) => filter.field === "price" && ["lt", "lte"].includes(filter.operator))?.value;
    const raisedBy = raise ? (raise[1] === "الف" ? 1000 : raise[1] === "الفين" ? 2000 : Number(raise[1])) : 0;
    return {
      tool: "buyerRank",
      version: 1,
      result: await runBuyerSearch(input.market, {
        ...state,
        ranking,
        ...(raisedBy && typeof ceiling === "number" ? { maxPrice: ceiling + raisedBy } : {}),
      }),
    };
  }

  // Deltas on the current list: condition, colour, size, budget ceiling.
  if (state) {
    const condition = text.match(CONDITION_REFINE);
    if (condition) {
      // Stored listings say «مستعمل» or «جديد»; one condition at a time replaces the previous one.
      const value = /^(?:مستعمل|مستخدم)/u.test(condition[1]!) ? "مستعمل" : "جديد";
      return { tool: "buyerRefine", version: 1, result: await runBuyerSearch(input.market, { ...state, condition: value }) };
    }
    const color = text.match(COLOR);
    const size = text.match(SIZE);
    // «5 آلاف» is 5,000: the thousands word multiplies the number before it.
    const amount = text.match(/(\d+(?:\.\d+)?)(?:\s*(الف|الاف|مليون)(?=\s|$))?/u);
    const number = amount && [amount[0], String(Number(amount[1]) * (amount[2] === "مليون" ? 1_000_000 : amount[2] ? 1_000 : 1))];
    if (color) return { tool: "buyerRefine", version: 1, result: await runBuyerSearch(input.market, { ...state, color: color[1]! }) };
    if (size) return { tool: "buyerRefine", version: 1, result: await runBuyerSearch(input.market, { ...state, size: size[1]!.toLowerCase() }) };
    if (number && MAX_PRICE.test(text) && /(?:الي|لحد|حتي|حدي|ميزانيتي|اقصي|بحدود|عادي)/u.test(text))
      return { tool: "buyerRefine", version: 1, result: await runBuyerSearch(input.market, { ...state, maxPrice: Number(number[1]) }) };
  }

  // A new natural search that names a target price or a subjective quality: the price is
  // a target to rank around, not an exact filter, and the quality word is a preference.
  const quality = QUALITY_WORDS.test(text);
  QUALITY_WORDS.lastIndex = 0;
  const target = text.match(/(?:بسعر|بحدود|حوالي|في حدود|ب)\s*(\d+(?:\.\d+)?)(?=\s|$)/u);
  const cheap = !target && CHEAP.test(text);
  if (target || quality || cheap) {
    const [categories, knownCities] = await Promise.all([listMarketplaceCategories(), publishedListingCities(input.market.id)]);
    // The price phrase («بـ5», «بسعر 5») and quality words are constraints, not search words.
    // The interpreter reads the seller-facing original, so the phrases are removed there.
    const stripped = input.message
      .replace(/(?:بسعر|بحدود|حوالي|في حدود|بـ*)\s*[0-9٠-٩]+(?:[.,][0-9٠-٩]+)?/u, (match) => (target ? " " : match))
      .replace(/(?:مميز[ةه]?|ممتاز[ةه]?|فخم[ةه]?|أصلي|اصلي)/gu, " ")
      .replace(/(?:بسعر رخيص|رخيص[ةه]?(?:\s+السعر)?)/u, (match) => (cheap ? " " : match));
    const interpretation = interpretMarketplaceTurn(stripped, { categories: categories.map(categorySchema), knownCities });
    // A product the category registry does not name («بروستد رخيص») is still a fresh search
    // of the stated words, never a refinement of whatever was searched before.
    const words = normalizeBuyerText(stripped).replace(/^(?:انا\s+)?(?:اريد|ابي|بدي|ابغي|ابحث عن|دور لي علي|عندكم)\s+/u, "").trim();
    const query =
      interpretation.intent === "SEARCH" && interpretation.query
        ? interpretation.query
        : words && words.split(" ").length <= 4
          ? { search: words, filters: [] as SearchFilter[], categoryId: undefined as string | undefined }
          : undefined;
    if (!query) return null;
    const targetPrice = target ? Number(target[1]) : undefined;
    return {
      tool: "buyerSearch",
      version: 1,
      result: await runBuyerSearch(input.market, {
        search: query.search,
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        filters: query.filters.filter((filter) => !(targetPrice !== undefined && filter.field === "price" && filter.operator === "eq")),
        ...(targetPrice ? { targetPrice } : {}),
        ...(quality ? { quality: true } : {}),
        ranking: cheap ? "CHEAPEST" : "DEFAULT",
      }),
    };
  }
  return null;
}

// ─── Purchase flow (Block F3) ────────────────────────────────────────────────
//
// Orchestration only. The order is created by the canonical checkout, the delivery
// method by Block D, and the payment intent by the Wave 4 test-only authority, each
// behind an F0 pending action: REVIEW → CONFIRM → RE-READ → EXECUTE.

const PURCHASE_ACTIONS = ["ADD_TO_CART", "PLACE_ORDER", "CREATE_PAYMENT_INTENT"] as const;
type PurchaseAction = (typeof PURCHASE_ACTIONS)[number];
type StoredPending = {
  kind: "ACTION";
  ownerId: string;
  action: PurchaseAction;
  targetResource: string;
  status: string;
  structuredInput: Record<string, { value?: unknown }>;
  expected: { unitPriceMinor: number | null };
};

const CONTINUE = /^(?:(?:انا\s+)?(?:ابي|اريد|بدي|ابغي)\s+)?(?:اطلب(?:ه|ها)?|اكمل|كمل|تابع|متابعه|اشتريه|اشتريها|اشتري|خذه|خذها)(?:\s+(?:الان|الحين|الطلب|الشراء))?$|^(?:اكمل|كمل|اتمام|متابعه)\s+(?:الطلب|الشراء)$/u;
const BACK = /^(?:رجوع|ارجع|رجعني|عوده|السابق|للخلف)$/u;
const CHANGED_MIND = /^(?:غيرت رايي|ما ابي|ما ابيه|ما ابغاه|ما بدي|لا ابي|الغ الطلب|الغي الطلب|الغاء الطلب|الغ الشراء|الغاء الشراء)$/u;
const PAY = /^(?:(?:انا\s+)?(?:ابي|اريد|بدي|ابغي)\s+)?(?:ادفع|الدفع|اكمل الدفع|كمل الدفع|ابدا الدفع)(?:\s+(?:الان|الحين))?$/u;
const QUANTITY_LEAD = /^(?:(?:انا\s+)?(?:ابي|ابغي|بدي|اريد|خله|خليه|خليها|خلها|خلي|اجعله|اجعلها|غير|عدل)\s+)?(?:(?:ال)?كميه\s+(?:(?:الي|ل)\s*)?)?/u;
const QUANTITY_WORD: Record<string, number> = {
  واحد: 1, واحده: 1, حبه: 1, قطعه: 1, اثنين: 2, اثنتين: 2, ثنتين: 2, قطعتين: 2, حبتين: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5,
};

/**
 * A quantity said while a purchase review is open: «أبي اثنين», «خله 3», «قطعة واحدة فقط»,
 * «غير الكمية إلى 3». Ordinals («الثاني») are positions, never quantities.
 */
export function reviewQuantity(text: string): number | undefined {
  const rest = text.replace(QUANTITY_LEAD, "").replace(/\s+(?:فقط|بس)$/u, "").trim();
  const digits = rest.match(/^(\d{1,4})(?:\s+(?:قطع|قطعه|حبات|حبه))?$/u);
  if (digits) return Number(digits[1]);
  const words = rest.split(" ");
  if (words.length > 2 || (words.length === 2 && !/^(?:قطعه|حبه)$/u.test(words[0]!))) return undefined;
  const word = words.at(-1)!;
  return QUANTITY_WORD[word];
}

const moneyOf = (minor: number | null | undefined, market: Market) =>
  minor === null || minor === undefined ? "بالاتفاق" : `${(minor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale)} ${market.currencyCode}`;

function parsePending(set: StoredSet | undefined, actorId: string): StoredPending | undefined {
  const query = set?.query as Partial<StoredPending> | undefined;
  if (!set || query?.kind !== "ACTION" || query.ownerId !== actorId || query.status !== "PENDING") return undefined;
  if (!PURCHASE_ACTIONS.includes(query.action as PurchaseAction)) return undefined;
  if (set.expiresAt && set.expiresAt.getTime() <= Date.now()) return undefined;
  return query as StoredPending;
}

const valueOf = (pending: StoredPending, key: string) => pending.structuredInput?.[key]?.value;

/** The order this conversation is about: the latest block's own order surface or delivery step. */
async function orderInContext(conversationId: string, actorId: string, marketId: string): Promise<string | undefined> {
  const [block] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  const payload = (block?.payload ?? {}) as { surface?: unknown; resourceId?: unknown; delivery?: unknown };
  if (typeof payload.resourceId !== "string" || !(payload.surface === "ORDER" || payload.delivery)) return undefined;
  const [order] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, payload.resourceId), eq(orders.buyerId, actorId), eq(orders.marketId, marketId)));
  return order?.id;
}

const CONTACT_REQUEST = /(?:رقم\s+(?:البائع|صاحب\s+العرض|المتجر)|(?:اعطني|أعطني)\s+(?:رقم|بيانات\s+التواصل)|بيانات\s+التواصل)/u;

export async function executeOrderContactRequest(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  if (!CONTACT_REQUEST.test(input.message)) return null;
  const denied = (): Turn => ({
    tool: "buyerOrder",
    version: 1,
    result: { kind: "SURFACE", surface: "CLARIFY", resourceIds: [], query: {}, listings: [], prompt: "بيانات التواصل تظهر بعد تأكيد طلب الشراء." },
  });
  if (!input.actorId) return denied();
  const orderId = await orderInContext(input.conversationId, input.actorId, input.market.id);
  if (!orderId) return denied();
  const release = await getAuthorizedSellerContacts({
    actorId: input.actorId,
    orderId,
    marketId: input.market.id,
  });
  if (!release) return denied();
  return {
    tool: "buyerOrder",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "ORDER",
      resourceId: orderId,
      resourceIds: [orderId],
      query: {},
      listings: [],
      sellerContactRequested: true,
      prompt: "تم التحقق من صلاحية التواصل لهذا الطلب. بيانات التواصل أدناه.",
    },
  };
}

/** Stages a new purchase review in place of the current one; the old one can never execute. */
async function restage(
  input: { conversationId: string; market: Market; actorId: string },
  current: { setId: string; pending: StoredPending },
  next: { action: PurchaseStage; quantity: number; fulfilment?: DeliveryMethod },
  lead = "",
): Promise<Turn> {
  const target = current.pending.targetResource;
  const facts: Record<string, { value: unknown; source: "USER_DECLARED" | "DINAR_DERIVED" }[]> = {
    quantity: [{ value: next.quantity, source: "USER_DECLARED" }],
    ...(next.fulfilment ? { fulfilment: [{ value: next.fulfilment, source: "USER_DECLARED" }] } : {}),
  };
  await db
    .update(aiResultSets)
    .set({ query: { ...current.pending, status: "SUPERSEDED", notice: "استُبدلت بمراجعة أحدث." } })
    .where(eq(aiResultSets.id, current.setId));
  let review: ActionReview;
  try {
    review = await createPendingAction({ ...input, proposal: proposeAction({ action: next.action, targetResource: target, facts }) });
  } catch (error) {
    if ((error as { status?: unknown }).status !== 409 || !(error instanceof Error)) throw error;
    return notice(`${error.message}. لم يتغير شيء؛ اختر عرضًا أو كمية متاحة.`);
  }
  const turn = await purchaseReviewTurn(input.market, input.actorId, target, next.quantity, review, next.action, next.fulfilment);
  if (lead) turn.result.prompt = `${lead} ${turn.result.prompt}`;
  return turn;
}

type PaymentActionReview = ActionReview & { selectedPaymentMethod?: "CASH_DIRECT" | "CARD" };
async function paymentReviewTurn(market: Market, orderId: string, review: PaymentActionReview, lead = ""): Promise<Turn> {
  const [[order], [fulfilment]] = await Promise.all([
    db.select().from(orders).where(eq(orders.id, orderId)),
    db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, orderId)),
  ]);
  const scale = order!.minorUnitScale;
  const items = (Array.isArray(order!.data.items) ? order!.data.items : []) as { listingTitle?: string; quantity?: number; unitPrice?: string; total?: string; paymentMethods?: string[] }[];
  const paymentMethods = items.length
    ? items.slice(1).reduce(
        (available, item) => available.filter((method) => item.paymentMethods?.includes(method)),
        [...(items[0]!.paymentMethods ?? [])],
      ).filter((method): method is "CASH_DIRECT" | "CARD" => method === "CASH_DIRECT" || method === "CARD")
    : [];
  const storedMethod = order!.data.selectedPaymentMethod === "CASH_DIRECT" || order!.data.selectedPaymentMethod === "CARD"
    ? order!.data.selectedPaymentMethod
    : null;
  const selectedPaymentMethod = review.selectedPaymentMethod ?? storedMethod;
  const paymentChoices = paymentMethods.map((method) => method === "CASH_DIRECT" ? "كاش" : "فيزا").join(" أو ");
  const method = fulfilment && !["CANCELLED", "FAILED"].includes(fulfilment.status) ? METHOD_LABELS[fulfilment.method as DeliveryMethod] : null;
  const total = (order!.subtotalMinor / 10 ** scale).toFixed(scale);
  return {
    tool: "buyerPay",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "PAYMENT_REVIEW",
      resultSetId: review.actionId,
      resourceIds: [orderId],
      resourceId: orderId,
      query: {},
      listings: [],
      purchaseReview: {
        actionId: review.actionId,
        stage: "PAYMENT",
        status: "PENDING",
        orderId,
        orderReference: orderReference(orderId),
        title: String(order!.data.listingTitle ?? ""),
        sellerName: String(order!.data.sellerName ?? ""),
        items: items.map((item) => ({ title: item.listingTitle ?? "", quantity: item.quantity ?? 0, unitPrice: item.unitPrice ?? null, total: item.total ?? null })),
        unitPrice: (order!.unitPriceMinor / 10 ** scale).toFixed(scale),
        currency: order!.currencyCode,
        quantity: order!.quantity,
        subtotal: total,
        buyerFees: "0",
        total,
        fulfilment: method,
        paymentMode: "SIMULATION_ONLY",
        paymentMethods,
        selectedPaymentMethod,
        lines: review.lines,
        expiresAt: review.expiresAt,
      },
      prompt: `${lead ? `${lead} ` : ""}مراجعة الدفع لطلب ${orderReference(orderId)}: ${moneyOf(order!.subtotalMinor, market)}${method ? `، التسليم: ${method}` : "، طريقة التسليم لم تُحدد بعد"}. ${selectedPaymentMethod ? `اخترت ${selectedPaymentMethod === "CASH_DIRECT" ? "كاش" : "فيزا"}.` : paymentChoices ? `البائع يقبل ${paymentChoices}. اختر طريقة الدفع أولًا.` : "لا توجد طريقة دفع مسجلة لهذا الطلب؛ لم يتم اختيار طريقة."} الدفع هنا تجريبي (SIMULATION_ONLY) ولا تُحوَّل أموال حقيقية.${selectedPaymentMethod === "CARD" ? " اكتب «نعم» لإنشاء طلب دفع تجريبي." : selectedPaymentMethod === "CASH_DIRECT" ? " اكتب «نعم» لتأكيد اختيار كاش؛ لا يُنشأ طلب دفع إلكتروني." : ""} أو «إلغاء».`,
    },
  };
}

function paymentMethodIntent(text: string): "CASH_DIRECT" | "CARD" | "AMBIGUOUS" | undefined {
  const cash = /(?:^|\s)(?:كاش|الكاش|نقد|نقدا)(?=\s|$)/u.test(text);
  const card = /(?:^|\s)(?:فيزا|بالفيزا|بطاقه|بالبطاقه|البطاقه|card)(?=\s|$)/iu.test(text);
  if (cash && card) return "AMBIGUOUS";
  if (cash) return "CASH_DIRECT";
  if (card) return "CARD";
  return undefined;
}

async function selectPaymentMethod(actionId: string, actorId: string, method: "CASH_DIRECT" | "CARD") {
  return db.transaction(async (tx) => {
    const [set] = await tx.select().from(aiResultSets).where(eq(aiResultSets.id, actionId)).for("update");
    const pending = set?.query as { kind?: unknown; ownerId?: unknown; action?: unknown; status?: unknown; targetResource?: unknown } | undefined;
    if (!set || pending?.kind !== "ACTION" || pending.ownerId !== actorId || pending.action !== "CREATE_PAYMENT_INTENT" || pending.status !== "PENDING")
      return { selected: false, supported: false };
    const orderId = typeof pending.targetResource === "string" ? pending.targetResource : "";
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order || order.buyerId !== actorId || order.status !== "CREATED")
      return { selected: false, supported: false };
    const items = Array.isArray(order.data.items) ? order.data.items as { paymentMethods?: string[] }[] : [];
    const supported = items.length > 0 && items.every((item) => item.paymentMethods?.includes(method));
    if (!supported) return { selected: false, supported: false };
    const query = set.query as Record<string, unknown>;
    const structuredInput = (query.structuredInput && typeof query.structuredInput === "object"
      ? query.structuredInput
      : {}) as Record<string, unknown>;
    await tx.update(aiResultSets).set({
      query: {
        ...query,
        structuredInput: {
          ...structuredInput,
          paymentMethod: { value: method, source: "USER_DECLARED" },
        },
      } as typeof aiResultSets.$inferInsert.query,
    }).where(eq(aiResultSets.id, actionId));
    return { selected: true, supported: true };
  });
}

async function persistPaymentMethod(actorId: string, orderId: string, method: "CASH_DIRECT" | "CARD") {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || order.buyerId !== actorId) return;
  await db.update(orders).set({
    data: { ...order.data, selectedPaymentMethod: method },
    updatedAt: new Date(),
  }).where(eq(orders.id, orderId));
}

async function startPayment(input: { conversationId: string; market: Market; actorId: string }, orderId: string, lead = ""): Promise<Turn> {
  if (!paymentSimulationEnabled()) return notice("تعذر إتمام الدفع: الدفع غير متاح في هذه البيئة. لم يتغير شيء.");
  try {
    const review = await createPendingAction({
      ...input,
      proposal: proposeAction({ action: "CREATE_PAYMENT_INTENT", targetResource: orderId }),
    });
    return paymentReviewTurn(input.market, orderId, review, lead);
  } catch (error) {
    if ((error as { status?: unknown }).status !== 409 || !(error instanceof Error)) throw error;
    return notice(`تعذر بدء الدفع: ${error.message}. لم يتغير شيء.`);
  }
}

function orderTurn(orderId: string, prompt: string): Turn {
  return { tool: "buyerOrder", version: 1, result: { kind: "SURFACE", surface: "ORDER", resourceIds: [orderId], resourceId: orderId, query: {}, listings: [], prompt } };
}

async function placedOrderTurn(input: { market: Market; actorId: string }, result: Record<string, unknown>): Promise<Turn> {
  const orderId = String(result.orderId);
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  const options = order
    ? deliveryOptions(order, input.market, await hasEligibleCourierSupply(order)).filter((option) => option.available)
    : [];
  const fulfilment = typeof result.fulfilment === "string" ? (result.fulfilment as DeliveryMethod) : undefined;
  const next = fulfilment
    ? `اخترت «${METHOD_LABELS[fulfilment]}».${fulfilment === "SELLER_DELIVERY" ? " اكتب «أرسل موقعي» لمشاركة موقع التسليم مرة واحدة بعد مراجعته." : ""}`
    : typeof result.fulfilmentError === "string"
      ? `لم تُحدد طريقة التسليم: ${result.fulfilmentError}`
      : options.length
        ? `اختر طريقة التسليم: ${options.map((option) => option.label).join("، ")}.`
        : "لا توجد طريقة تسليم داخل DINAR لهذا الطلب؛ تواصل مع البائع داخل الطلب.";
  return orderTurn(
    orderId,
    `تم إنشاء الطلب ${orderReference(orderId)} وحجز الكمية بعد التحقق من السعر والتوفر الحاليين${order ? ` (${moneyOf(order.subtotalMinor, input.market)})` : ""}. لم يُدفع أي شيء. ${next} اكتب «ادفع» لمراجعة الدفع التجريبي.`,
  );
}

/**
 * Claims a turn only when this actor's own purchase step is the latest one in the
 * conversation, or when «ادفع» is said about the order in context. Everything else
 * passes on unchanged.
 */
export async function executePurchaseTurn(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const context = { conversationId: input.conversationId, market: input.market, actorId };
  const text = normalizeBuyerText(input.message);
  const [latest] = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, input.conversationId), eq(aiResultSets.marketId, input.market.id)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const pending = parsePending(latest, actorId);

  if (!pending) {
    if (!PAY.test(text)) return null;
    const orderId = await orderInContext(input.conversationId, actorId, input.market.id);
    return orderId ? startPayment(context, orderId) : null;
  }

  const setId = latest!.id;
  const stage = pending.action;
  const isConfirm = CONFIRM.test(text);
  const isCancel = CANCEL.test(text) || CHANGED_MIND.test(text) || BACK.test(text);
  // F2 keeps its own «نعم»/«إلغاء» on the item review: confirming adds to the cart.
  if (stage === "ADD_TO_CART" && (isConfirm || CANCEL.test(text))) return null;

  if (stage === "CREATE_PAYMENT_INTENT") {
    const intent = paymentMethodIntent(text);
    if (intent) {
      const methodFromPending = valueOf(pending, "paymentMethod");
      const review: PaymentActionReview = {
        actionId: setId,
        action: stage,
        targetResource: pending.targetResource,
        lines: ((latest!.query as { review?: string[] }).review ?? []),
        expiresAt: latest!.expiresAt?.toISOString() ?? new Date(Date.now() + 60_000).toISOString(),
        ...(methodFromPending === "CARD" || methodFromPending === "CASH_DIRECT" ? { selectedPaymentMethod: methodFromPending } : {}),
      };
      if (intent === "AMBIGUOUS")
        return paymentReviewTurn(input.market, pending.targetResource, review, "اختر طريقة واحدة فقط: كاش أو فيزا.");
      const result = await selectPaymentMethod(setId, actorId, intent);
      if (!result.selected) {
        const label = intent === "CARD" ? "فيزا/البطاقة" : "كاش";
        return paymentReviewTurn(input.market, pending.targetResource, review, `هذا الطلب لا يدعم ${label}؛ لم يتغير اختيار الدفع.`);
      }
      return paymentReviewTurn(input.market, pending.targetResource, { ...review, selectedPaymentMethod: intent }, `تم اختيار ${intent === "CARD" ? "فيزا" : "كاش"}.`);
    }
  }

  if (isCancel) {
    const outcome = await confirmPendingAction({ actionId: setId, actorId, market: input.market, decision: "CANCEL" });
    if (outcome.status !== "CANCELLED") return notice(outcome.message);
    return notice(
      stage === "CREATE_PAYMENT_INTENT"
        ? "أُلغيت مراجعة الدفع؛ لم يُنشأ أي دفع. الطلب نفسه باقٍ كما هو."
        : `${BACK.test(text) ? "رجعنا خطوة. " : ""}أُلغيت مراجعة الشراء؛ لم يُنشأ طلب ولم يُدفع شيء. نتائجك السابقة ما زالت متاحة.`,
    );
  }

  if (stage === "CREATE_PAYMENT_INTENT") {
    if (!isConfirm) return null;
    const [paymentOrder] = await db.select().from(orders).where(eq(orders.id, pending.targetResource));
    const pendingMethod = valueOf(pending, "paymentMethod");
    const selectedMethod = pendingMethod === "CARD" || pendingMethod === "CASH_DIRECT" ? pendingMethod : paymentOrder?.data.selectedPaymentMethod;
    if (selectedMethod !== "CARD" && selectedMethod !== "CASH_DIRECT") {
      const review: ActionReview = {
        actionId: setId,
        action: stage,
        targetResource: pending.targetResource,
        lines: ((latest!.query as { review?: string[] }).review ?? []),
        expiresAt: latest!.expiresAt?.toISOString() ?? new Date(Date.now() + 60_000).toISOString(),
      };
      return paymentReviewTurn(input.market, pending.targetResource, review, "اختر كاش أو فيزا قبل التأكيد.");
    }
    if (selectedMethod === "CASH_DIRECT") {
      const outcome = await confirmPendingAction({ actionId: setId, actorId, market: input.market, decision: "CANCEL" });
      if (outcome.status === "CANCELLED") {
        await persistPaymentMethod(actorId, pending.targetResource, "CASH_DIRECT");
        return orderTurn(pending.targetResource, `تم حفظ اختيار كاش للطلب ${orderReference(pending.targetResource)}. لم يُنشأ طلب دفع إلكتروني ولم تُحوَّل أموال؛ نسّق الدفع مباشرة مع البائع.`);
      }
      return notice(outcome.message);
    }
    const outcome = await confirmPendingAction({ actionId: setId, actorId, market: input.market, decision: "CONFIRM" });
    if (outcome.status === "REVIEW_REQUIRED")
      return paymentReviewTurn(input.market, pending.targetResource, outcome.review, "تغيّرت بيانات الطلب أو الدفع منذ المراجعة؛ لم يُنفذ التأكيد القديم. راجع المبلغ الحالي ثم أكّد.");
    if (outcome.status === "CONFIRMED" && outcome.result?.paymentIntentId) {
      await persistPaymentMethod(actorId, pending.targetResource, "CARD");
      return orderTurn(
        pending.targetResource,
        `أُنشئ طلب دفع تجريبي لطلب ${orderReference(pending.targetResource)} بقيمة ${moneyOf(Number(outcome.result.amountMinor), input.market)} (SIMULATION_ONLY، TEST_NO_TRANSFER). لم تُحوَّل أي أموال حقيقية، ولا يُعتبر الطلب مدفوعًا إلا بعد تأكيد مزوّد الدفع التجريبي.`,
      );
    }
    return notice(outcome.status === "REJECTED" ? `تعذر إتمام الدفع: ${outcome.message}` : outcome.message);
  }

  const quantity = Number(valueOf(pending, "quantity") ?? 1);
  const chosen = valueOf(pending, "fulfilment") as DeliveryMethod | undefined;

  if (stage === "PLACE_ORDER" && isConfirm) {
    const outcome = await confirmPendingAction({ actionId: setId, actorId, market: input.market, decision: "CONFIRM" });
    if (outcome.status === "REVIEW_REQUIRED") {
      const now = await readServerSnapshot(actorId, pending.targetResource);
      const before = pending.expected?.unitPriceMinor;
      const lead =
        now && before !== now.unitPriceMinor
          ? `تغير السعر من ${moneyOf(before, input.market)} إلى ${moneyOf(now.unitPriceMinor, input.market)}، راجع السعر الجديد.`
          : "تغيّرت بيانات العرض منذ المراجعة؛ راجعها من جديد.";
      const turn = await purchaseReviewTurn(input.market, actorId, pending.targetResource, quantity, outcome.review, "PLACE_ORDER", chosen);
      turn.result.prompt = `${lead} لم يُنشأ أي طلب بالتأكيد القديم. ${turn.result.prompt}`;
      return turn;
    }
    if (outcome.status === "CONFIRMED" && outcome.result?.orderId) return placedOrderTurn(context, outcome.result);
    const fewer = outcome.message.match(/المتوفر الآن (\d+) فقط/u);
    if (outcome.status === "REJECTED" && fewer && Number(fewer[1]) > 0) {
      // Less stock than asked: the current valid quantity is shown and needs a new decision.
      const current = { setId, pending: { ...pending, status: "PENDING" } };
      return restage(context, current, { action: "PLACE_ORDER", quantity: Number(fewer[1]), fulfilment: chosen }, `المتوفر الآن ${fewer[1]} فقط؛ لم يُنشأ أي طلب.`);
    }
    return notice(outcome.message);
  }

  const asked = reviewQuantity(text);
  if (asked !== undefined) {
    if (asked < 1) return notice("الكمية يجب أن تكون قطعة واحدة على الأقل. لم يتغير شيء.");
    const now = await readServerSnapshot(actorId, pending.targetResource);
    if (now && now.available !== null && asked > now.available)
      return restage(context, { setId, pending }, { action: stage, quantity, fulfilment: chosen }, now.available > 0 ? `المتوفر الآن ${now.available} فقط؛ أبقيت الكمية ${quantity}.` : "المنتج لم يعد متوفرًا.");
    return restage(context, { setId, pending }, { action: stage, quantity: asked, fulfilment: chosen }, `عدّلت الكمية إلى ${asked}.`);
  }

  if (CONTINUE.test(text)) return restage(context, { setId, pending }, { action: "PLACE_ORDER", quantity, fulfilment: chosen });

  const deliveryText = normalizeDeliveryText(input.message);
  const delivery = deliveryIntent(deliveryText);
  if (delivery === "CHOOSE_PICKUP" || delivery === "CHOOSE_SELLER_DELIVERY" || delivery === "DELIVERY_OPTIONS" || delivery === "ASK_SELLER_DELIVERS") {
    const wanted: DeliveryMethod | undefined =
      delivery === "CHOOSE_PICKUP" ? "PICKUP" : delivery === "CHOOSE_SELLER_DELIVERY" || /وصل/u.test(deliveryText) ? "SELLER_DELIVERY" : undefined;
    const now = await readServerSnapshot(actorId, pending.targetResource);
    const options = listingFulfilmentOptions(now?.fulfilmentType, input.market);
    if (wanted && options.some((option) => option.method === wanted))
      return restage(context, { setId, pending }, { action: "PLACE_ORDER", quantity, fulfilment: wanted });
    const offered = options.length ? `المتاح لهذا العرض: ${options.map((option) => option.label).join("، ")}.` : "لا توجد طريقة تسليم داخل DINAR لهذا العرض.";
    const lead = wanted ? `${wanted === "PICKUP" ? "البائع لا يعرض الاستلام الشخصي لهذا العرض." : "البائع لا يوصل هذا العرض."} ${offered}` : offered;
    return restage(context, { setId, pending }, { action: "PLACE_ORDER", quantity, fulfilment: chosen }, lead);
  }
  if (delivery === "SHARE_LOCATION" || delivery === "LOCATION_MENTION" || delivery === "MANUAL_ADDRESS" || PAY.test(text))
    return restage(
      context,
      { setId, pending },
      { action: "PLACE_ORDER", quantity, fulfilment: chosen },
      PAY.test(text)
        ? "الدفع يأتي بعد إنشاء الطلب؛ أكّد الطلب أولًا."
        : "لا يُطلب موقعك إلا داخل طلب قائم؛ أكّد الطلب أولًا ثم شارك موقعك مرة واحدة بعد مراجعته.",
    );
  return null;
}
