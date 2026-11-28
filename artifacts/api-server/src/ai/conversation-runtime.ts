import { parseStructuredSearch } from "./search-query";
import { claimsCompletedAction } from "./action-receipts";
import { executeConnectReadTurn } from "../connect/conversation";
import type { DomainSearchProvider } from "../connect/domains";
import {
  hasResumableListingDraft,
  hasActiveListingDraft,
  hasPendingListingPhotoSuggestions,
  isListingPhotoSuggestionCommand,
  isGeneralRequest,
  isListingPhotoTitleCorrection,
  listingDraft,
} from "./listing-draft";
import { orderContext } from "./order-context";
import { contextualQuery, hasCategoryAlias } from "./search-context";
import { addToCartIntent, backIntent, statedCartQuantity, refusesCommercialAction, requestCore, searchTerms, stripCorrectionPrefix, surfaceIntent } from "./intent";
import {
  explicitReadOnlyCalculation,
  findOrdinalMention,
  findOrdinalMentions,
  foldArabicLetters,
  parseContextualReference,
  parseResultReference,
  normalizeMarketplaceText,
} from "./arabic-normalization";
import {
  clarificationPrompt,
  EXPLICIT_SEARCH_ACTION,
  hasExplicitMarketplaceSearchIntent,
  interpretMarketplaceTurn,
  needsMarketplaceCategoryContext,
} from "./marketplace-intent";
import { SearchFilterInput, SearchSortInput } from "./search-state";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { aiResultSets, aiUiBlocks, db, messages, offers } from "@workspace/db";
import { isMarketAvailable, type marketFor } from "../lib/markets";
import { publishedListingCities, searchMarketplaceListings } from "../lib/marketplace-listings";
import {
  addMarketplaceCartItems,
  getMarketplaceCart,
  updateMarketplaceCartLine,
} from "../lib/marketplace-cart";
import {
  type ConversationModelGateway, getModelGatewayCallCount } from "./model-gateway";
import {
  executeRegisteredTool,
  type ToolResult,
} from "./tool-registry";
import {
  categorySchema,
  listMarketplaceCategories,
} from "../lib/marketplace-categories";
import { normalizeSearch } from "./search-context";
import { itemTokens, textMatchesToken } from "../lib/arabic-search-terms";
import { displayInteraction } from "./display-preference";
import {
  executeSellerAdviceTurn,
  executeSellerListingManagementTurn,
  explicitMarketingTruthRefusal,
  isMarketingRequest,
  isSellerBusinessQuestion,
  isBareRemainingQuestion,
} from "./seller-management";
import { executeEmploymentTurn, isEmploymentQuery } from "./employment-turn";
import { deliveryIntent, normalizeDeliveryText, executeDeliveryTurn, isDeliveryQuery } from "./delivery-turn";
import { executePromotionTurn, explainSponsoredPlacement, isPromotionQuery } from "./promotion-turn";
import { executeAdsAssistantTurn } from "./ads-assistant-turn";
import { executeBuyerTurn, executePurchaseTurn, executeOrderContactRequest, reviewQuantity } from "./buyer-turn";
import { executeDealPaymentTurn } from "./deal-payment-turn";
import { executeListingFactQuestion } from "./listing-fact-question";
import { executeStockQuestion } from "./stock-question";
import { modelRolesForActor } from "./model-capability-tools";
import { isAiUsageQuestion } from "./usage-intent";
import { executeDriverTurn, isDriverOnboardingIntent, isDriverQuery } from "./driver-turn";
import { executeDraftActionTurn } from "./draft-actions";
import { executeProviderTurn, isExplicitProviderManagementIntent } from "./provider-turn";
import {
  SMART_STATE_KINDS,
  executeModelFallback,
  executeSellerEmployeeTurn,
  executeSmartTurn,
  isExplicitSellerEmployeeInvocation,
  sellerEmployeeFactResponse,
  type SellerEmployeeActionHandler,
} from "./smart-turn";
import { executeBusinessOnboardingTurn, executeCommerceTurn } from "./commerce-turn";
import { executeInquiryTurn } from "./inquiry-turn";
import { executePolicyTurn } from "./policy-turn";
import { aiRoutingMode, isDecisionUtterance } from "./routing-mode";
import { executeProductControlTurn } from "./product-control-turn";
import { executeBusinessTurn } from "./business-turn";
import { aiUsagePolicyFor, globalGuardOpen, hasAiAllowance } from "../lib/ai-usage";
import { meteredPlatformGateway } from "../lib/ai-spend";
import {
  executeNegotiationTurn,
  isBestPriceRequest,
  sellerEmployeeNegotiationReviewTurn,
} from "./negotiation-turn";
import { recommendationIntent } from "./intent";
import { storedSponsoredIds } from "../lib/recommendations";
import {
  delegatedSellerModelContext,
  escalateSellerEmployeeNegotiations,
  readSellerEmployeeOrders,
  requireSellerEmployeeCapability,
  sellerEmployeeDraftBinding,
  sellerEmployeeDraftBindingMatches,
} from "../lib/business-delegations";
import type { ListingPhotoSuggestionProvider } from "./listing-photo-intelligence";
import { personalContext } from "./personal-context-service";
import { executePersonalMemoryTurn, memoryAcknowledgement } from "./personal-memory-turn";
import { draftFieldEdit } from "./draft-field-edit";
import { modelGatewayFor } from "./model-turn";
import { resolveConversationRoute } from "./conversation-router";
import { isDraftResumeRequest } from "./draft-actions";
import {
  buildTaskPlan,
  cancelPending,
  completeStep,
  failStep,
  isPlanCancellation,
  isPlanContinuation,
  isPlanRetry,
  isRetryablePlanStep,
  latestTaskPlan,
  nextPendingStep,
  retryFailedStep,
  splitCompoundRequest,
  type TaskPlan,
  type TaskStep,
} from "./task-plan";
import {
  resolveConversationActionId,
  type ConversationActionId,
  type ConversationRouteDecision,
} from "@workspace/api-zod/conversation-runtime";
import { contextText, correction, namesCommercialObject, namesPrice } from "./context-intent";

type ConversationMarket = Awaited<ReturnType<typeof marketFor>>;
const OPEN_SELLER_QUESTION =
  /[؟?]|(?:^|\s)(?:شو|وش|ايش|شنو|ماذا|كيف|ليش|لماذا|هل|what|which|why|how|where|when)(?=\s|$)/iu;

// Reads only the identity of our own stored block; display fields (searchState, presentation) are ignored.
const ListingBlockReference = z.object({
  resultSetId: z.string().uuid(),
  resourceIds: z.array(z.string().min(1).max(200)).max(24),
});

async function executeCartConversationTurn(input: {
  conversationId: string;
  message: string;
  market: ConversationMarket;
  actorId?: string;
}): Promise<{ tool: string; version: number; result: ToolResult } | null> {
  const text = input.message
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[.؟?!]+$/u, "")
    .trim();
  const remove = /^(?:شيل(?:ه|ها)?|احذف(?:ه|ها)?|ازل|ازيل)(?:\s|$)/u.test(text);
  const contextualQuantity = text.match(/^(?:لا\s+)?(?:خليهم|خليهن|خليه|خليها|خلهم|خلها)\s+(.+)$/u);
  const quantityChange = text.match(
    /^(?:غير|عدل|اجعل|خله|خليها|اضبط|ضبط)\s+(?:(?:ال)?كميه\s+)?(?:(?:العنصر|المنتج)\s+)?(.+?)\s+(?:الي|ل)\s*(.+)$/u,
  ) ?? (contextualQuantity ? [contextualQuantity[0], "", contextualQuantity[1]!] : null);
  const ambiguousOrderContinuation=/^(?:كمل|اكمل)\s+(?:ال)?(?:طلب|طلبي)$/u.test(text);
  const continueCheckout=/^(?:كمل|اكمل)$/u.test(text) || ambiguousOrderContinuation;
  // «فضي السلة», «فرغ سلتي», «امسح كل شي بالسلة»: every line, and only cart lines.
  const clearCart = /^(?:فضي|فضيلي|فرغ|افرغ|امسح|نظف|صفر)\s+(?:لي\s+)?(?:كل\s+(?:شي|شيء)\s+(?:في|ب)\s*)?(?:ال)?(?:سله|سلتي|عربه)$/u.test(text);
  // An explicit «من السلة» names the cart whatever card was shown last.
  const namesCart = /(?:^|\s)(?:من|في|ب)\s*(?:ال)?(?:سله|سلتي|عربه)(?:\s|$)/u.test(text);
  if ((!remove && !quantityChange && !continueCheckout && !clearCart) || !input.actorId) return null;

  const [latestAssistant] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        eq(messages.actor, "ASSISTANT"),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!latestAssistant) return ambiguousOrderContinuation ? clarify("لا توجد مراجعة سلة حالية. افتح السلة أو طلباتك وحدد ما تريد متابعته؛ لم أنفّذ شيئًا.") : null;
  const [latestSurface] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(
      and(
        eq(aiUiBlocks.messageId, latestAssistant.id),
        eq(aiUiBlocks.blockType, "SURFACE"),
      ),
    )
    .limit(1);
  // «كمل الطلب» with items in the cart is the checkout review (a review only; nothing executes
  // before the buyer confirms). With an empty cart it can only mean an existing order: ask.
  if (ambiguousOrderContinuation && (latestSurface?.payload as {surface?:unknown} | undefined)?.surface !== "CART" &&
    ((await getMarketplaceCart(input.actorId, input.market)) as unknown[]).length) return null;
  if (ambiguousOrderContinuation && (latestSurface?.payload as {surface?:unknown} | undefined)?.surface !== "CART") return clarify("هل تقصد طلبًا قائمًا أم عناصر السلة؟ افتح طلباتك أو السلة وحدد المقصود؛ لم أنفّذ شيئًا.");
  if (ambiguousOrderContinuation) return null; // Visible cart: use the ordinary checkout review navigation.
  if (
    !clearCart && !namesCart &&
    (latestSurface?.payload as { surface?: unknown } | undefined)?.surface !==
    "CART"
  )
    return null;

  const cart = (await getMarketplaceCart(input.actorId, input.market)) as Array<{
    listingId: string;
    title: string;
    quantity: number;
  }>;
  if (clearCart) {
    if (!cart.length)
      return { tool: "openSurface", version: 1, result: { kind: "SURFACE", surface: "CART", prompt: "سلتك فارغة أصلًا.", query: {}, listings: [] } };
    for (const line of cart)
      await updateMarketplaceCartLine({ userId: input.actorId, expectedMarketId: input.market.id, listingId: line.listingId, quantity: null });
    return { tool: "openSurface", version: 1, result: { kind: "SURFACE", surface: "CART", prompt: `أفرغت السلة (${cart.length} ${cart.length === 1 ? "عنصر" : "عناصر"}). لم يُلغَ أي طلب ولم يتغير أي دفع.`, query: {}, listings: [] } };
  }
  if (remove || quantityChange) {
    const reference = findOrdinalMention(input.message);
    // «احذف العطر من السلة»: a title word that names exactly one line selects it.
    const words = text.split(" ").filter((word) => word.length >= 3 && !/^(?:احذف|احذفه|احذفها|شيل|شيله|شيلها|ازل|ازيل|من|السله|سلتي|العربه|غير|عدل|الكميه)$/u.test(word)).map((word) => word.replace(/^ال/u, ""));
    const fold = (value: string) => value.replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
    const byTitle = words.length ? cart.map((line, i) => [i, fold(line.title)] as const).filter(([, title]) => words.some((word) => title.includes(word))) : [];
    const index =
      reference?.kind === "LAST"
        ? cart.length - 1
        : reference?.kind === "INDEX"
          ? reference.index
          : byTitle.length === 1
            ? byTitle[0]![0]
            : cart.length === 1
              ? 0
              : -1;
    if (index < 0 || index >= cart.length)
      return {
        tool: "openSurface",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "CART",
          prompt: "حدّد رقم العنصر الظاهر في السلة لإزالته أو لتعديل كميته.",
          query: {},
          listings: [],
        },
      };
    const removed = cart[index]!;
    const quantity = quantityChange
      ? reviewQuantity(quantityChange[2]!)
      : undefined;
    if (quantityChange && quantity === undefined)
      return {
        tool: "openSurface",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "CART",
          prompt: "اكتب الكمية الجديدة كرقم صحيح موجب.",
          query: {},
          listings: [],
        },
      };
    try {
      await updateMarketplaceCartLine({
        userId: input.actorId,
        expectedMarketId: input.market.id,
        listingId: removed.listingId,
        quantity: remove ? null : quantity!,
      });
    } catch (error) {
      return {
        tool: "openSurface",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "CART",
          prompt: `${error instanceof Error ? error.message : "تعذر تحديث السلة"}. لم يتغير شيء؛ راجع الكمية المتاحة.`,
          query: {},
          listings: [],
        },
      };
    }
    return {
      tool: "openSurface",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "CART",
        prompt: remove
          ? `أزلت «${removed.title}» من السلة. يمكنك متابعة المراجعة هنا.`
          : `حدّثت كمية «${removed.title}» إلى ${quantity}. راجع التوفر الحالي قبل إكمال الطلب.`,
        query: {},
        listings: [],
      },
    };
  }

  if (!cart.length)
    return {
      tool: "openSurface",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "CART",
        prompt: "سلتك فارغة الآن. أضف عرضًا من نتائج المحادثة أولًا.",
        query: {},
        listings: [],
      },
    };
  return {
    tool: "openSurface",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "CHECKOUT",
      prompt: "راجع عناصر سلتك وأكمل الطلب هنا. لن يتم الدفع من هذه الخطوة.",
      query: {},
      listings: [],
    },
  };
}

const StoredSearchQuery = z.object({
  search: z.string().max(200).optional(),
  category: z.string().max(80).nullable().optional(),
  categoryId: z.string().max(80).nullable().optional(),
  filters: z.array(SearchFilterInput).max(12).optional(),
  sort: SearchSortInput.optional(),
}).passthrough();

const StoredRecommendation = z
  .object({
    anchorId: z.string().min(1).max(200).optional(),
    cheaper: z.boolean().optional(),
    nearby: z.boolean().optional(),
    excludeIds: z.array(z.string().min(1).max(200)).max(48),
  })
  .passthrough();

/**
 * The listing the buyer is looking at: an opened result, or the first organic result
 * of the latest list (paid positions never become the reference). Shown results are
 * excluded; only location and price constraints carry over as hard filters.
 */
async function recommendationContext(conversationId: string, marketId: string) {
  const [block] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .innerJoin(messages, eq(aiUiBlocks.messageId, messages.id))
    .where(and(eq(aiUiBlocks.conversationId, conversationId), eq(aiUiBlocks.blockType, "LISTING_RESULTS")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const reference = ListingBlockReference.safeParse(block?.payload);
  if (!reference.success) return {};
  const [set] = await db
    .select()
    .from(aiResultSets)
    .where(
      and(
        eq(aiResultSets.id, reference.data.resultSetId),
        eq(aiResultSets.conversationId, conversationId),
        eq(aiResultSets.marketId, marketId),
      ),
    )
    .limit(1);
  if (!set || (set.expiresAt && set.expiresAt.getTime() <= Date.now())) return {};
  const shown = reference.data.resourceIds.filter((id) => set.resourceIds.includes(id));
  const details = (block?.payload as { presentation?: unknown }).presentation === "DETAILS";
  const paid = new Set(storedSponsoredIds(set.query));
  const anchorId = details ? shown[0] : shown.find((id) => !paid.has(id)) ?? shown[0];
  const stored = StoredSearchQuery.safeParse(set.query);
  const filters = (stored.success ? stored.data.filters ?? [] : []).filter((filter) =>
    ["city", "area", "price"].includes(filter.field),
  );
  return {
    ...(anchorId ? { anchorId } : {}),
    ...(details ? {} : { excludeIds: shown.slice(0, 24) }),
    ...(stored.success && stored.data.categoryId ? { categoryId: stored.data.categoryId } : {}),
    ...(filters.length ? { filters } : {}),
  };
}

const ACKNOWLEDGEMENT = /^\s*(?:تمام|طيب|اوكي|أوكي|خلاص|حلو|زين|ok|okay)[\s،,.!]+(?=\S)/iu;

// «دينار، اشرح لي…» / «يا دينار أبي أبيع…»: the assistant's name is not part of the request.
// Kept where it carries meaning: «دينار بزنس», «دينار بع لي / روح بيع», and amounts.
const VOCATIVE =
  /^\s*(?:يا\s+)?دينار\s*[،,:!]?\s+(?!(?:بزنس|business|بع|بيع|روح|واحد|ونص|ونصف|اردني|أردني|كويتي|بحريني|عراقي|ليبي|تونسي|جزائري|صربي|[0-9٠-٩])(?:\s|$))(?=\S)/iu;

export function withoutAcknowledgement(message: string): string {
  const rest = message.replace(ACKNOWLEDGEMENT, "").replace(VOCATIVE, "");
  return rest.trim() ? rest : message;
}

type StoredResultSet = typeof aiResultSets.$inferSelect;

/** The latest listing result sets of this conversation (state, preview and action sets excluded). */
async function recentListingResultSets(context: TurnContext): Promise<StoredResultSet[]> {
  return db
    .select()
    .from(aiResultSets)
    .where(
      and(
        eq(aiResultSets.conversationId, context.conversationId),
        eq(aiResultSets.marketId, context.market.id),
      ),
    )
    .orderBy(desc(aiResultSets.createdAt))
    .limit(12)
    .then((sets) =>
      sets
        .filter((set) => {
          const kind = (set.query as { kind?: unknown } | null)?.kind;
          return kind !== "SELLER_CONTEXT" && kind !== "LISTING_PREVIEW" && kind !== "ACTION" && kind !== "ORDERS" && !SMART_STATE_KINDS.includes(String(kind)) && !isEmploymentQuery(set.query) && !isDeliveryQuery(set.query) && !isPromotionQuery(set.query) && !isDriverQuery(set.query);
        })
        .slice(0, 3),
    );
}

/** The listing the user last opened from this result set, when the latest card shows exactly one. */
async function focusedIndex(conversationId: string, set: StoredResultSet): Promise<number | undefined> {
  const [block] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  const payload = (block?.payload ?? {}) as { listings?: Array<{ id?: unknown }>; resourceIds?: unknown[] };
  const shown = payload.listings?.length
    ? payload.listings.map((listing) => String(listing.id ?? ""))
    : (payload.resourceIds ?? []).map(String);
  if (shown.length !== 1) return undefined;
  const index = set.resourceIds.indexOf(shown[0]!);
  return index >= 0 ? index : undefined;
}

const RETURN_TO_TOPIC =
  /^(?:(?:طيب|طب|خلص|خلاص)\s+)?(?:ارجع|رجعني|ارجعني|خلينا\s+نرجع|نرجع|رجعنا|عود)\s+(?:ل|الي|علي|عل)\s*(.+)$/u;
const TOPIC_FILLER = /(?:^|\s)(?:اللي|الي|يلي|الذي|التي|شفناها|شفناه|شفتها|شفته|شفتهم|شفناهم|قبل|شوي|السابقه|السابق|الاولي|الاول|تبع|تبعت|حقت|عن|موضوع|نتائج|بحث)(?=\s|$)/gu;
const topicStem = (word: string) =>
  word.replace(/^(?:وال|بال|لل|ال|و|ب|ل)(?=\S{3})/u, "").replace(/(?:ات|ين|ون|ه|ة)$/u, "");

/**
 * References that only the conversation can resolve, before the single-utterance interpreter:
 *  - relative to the listing in focus («واللي قبله؟»), superlatives over the results in view
 *    («أي واحد الأرخص فيهم؟»), and a corrected reference («لا، أقصد الثالث، ولا تضيفه»): each
 *    opens one listing read-only through getResource, so a refused add never becomes an action;
 *  - a return to an earlier topic («ارجع للابتوبات اللي شفناها»): the earlier stored search is run
 *    again live (fresh prices and availability), becoming the current results.
 * Every index is resolved against a persisted result set of this conversation only.
 */
async function resolveConversationReference(
  context: TurnContext,
  latest: StoredResultSet | undefined,
  recent: StoredResultSet[],
): Promise<{ tool: string; version: number; result: ToolResult } | undefined> {
  const toolContext = { conversationId: context.conversationId, market: context.market };
  const folded = contextText(context.message).replace(/ى/g, "ي");
  const back = folded.match(RETURN_TO_TOPIC);
  if (back) {
    const wanted = back[1]!.replace(TOPIC_FILLER, " ").split(/\s+/u).map(topicStem).filter((word) => word.length >= 3);
    // A search for a category alone («ابحث عن سيارة بأقل من 5000») is stored as its category with
    // no search words; its topic is then the category's own names, from the category registry.
    const categoryNames = new Map<string, string>();
    if (recent.some((set) => StoredSearchQuery.safeParse(set.query ?? {}).data?.categoryId))
      for (const category of await listMarketplaceCategories())
        categoryNames.set(category.id, [category.label, ...(category.aliases ?? [])].join(" "));
    const earlier = recent.find((set) => {
      // The topic may be the current one («خلينا نرجع للجوالات» after a side question): re-running it is still right.
      if (set.expiresAt && set.expiresAt.getTime() <= Date.now()) return false;
      const stored = StoredSearchQuery.safeParse(set.query ?? {});
      const topic = stored.success ? `${stored.data.search ?? ""} ${stored.data.categoryId ? categoryNames.get(stored.data.categoryId) ?? "" : ""}` : "";
      const words = contextText(topic).replace(/ى/g, "ي").split(/\s+/u).map(topicStem).filter((word) => word.length >= 3);
      return wanted.some((want) => words.some((word) => word.startsWith(want) || want.startsWith(word)));
    });
    if (earlier) {
      const stored = StoredSearchQuery.safeParse(earlier.query ?? {});
      if (stored.success)
        return executeRegisteredTool(
          "searchListings",
          JSON.stringify({
            query: stored.data.search ?? "",
            ...(stored.data.categoryId ? { categoryId: stored.data.categoryId } : {}),
            filters: [...(stored.data.filters ?? []), ...(parseStructuredSearch(context.message)?.filters.filter((filter) => filter.field === "price") ?? [])],
            ...(stored.data.sort ? { sort: stored.data.sort } : {}),
          }),
          toolContext,
        );
    }
  }
  if (!latest || latest.resourceIds.length === 0) return undefined;
  const open = (index: number) =>
    executeRegisteredTool("getResource", JSON.stringify({ resultSetId: latest.id, resourceId: latest.resourceIds[index] }), toolContext);
  const core = requestCore(context.message);
  const corrected = stripCorrectionPrefix(context.message) !== context.message.trim();
  const reference = parseContextualReference(core, { correction: corrected }) ?? parseContextualReference(context.message);
  if (reference?.kind === "PREVIOUS" || reference?.kind === "NEXT") {
    const focus = await focusedIndex(context.conversationId, latest);
    if (focus === undefined) return clarify("أي عرض تقصد؟ اذكر رقمه من القائمة الحالية.");
    const index = focus + (reference.kind === "PREVIOUS" ? -1 : 1);
    if (index < 0 || index >= latest.resourceIds.length)
      return clarify(reference.kind === "PREVIOUS" ? "هذا أول عرض في القائمة؛ لا يوجد عرض قبله." : "هذا آخر عرض في القائمة؛ لا يوجد عرض بعده.");
    return open(index);
  }
  if (reference?.kind === "CHEAPEST" || reference?.kind === "PRICIEST") {
    const rows = await searchMarketplaceListings(context.market, { search: "", allowedIds: latest.resourceIds, conversational: true, sponsoredPlacement: false });
    const priced = rows.filter((row) => row.unitPrice !== null);
    if (!priced.length) return clarify("لا توجد أسعار معلنة للعروض المتاحة الآن.");
    const pick = priced.reduce((best, row) =>
      (reference.kind === "CHEAPEST" ? Number(row.unitPrice) < Number(best.unitPrice) : Number(row.unitPrice) > Number(best.unitPrice)) ? row : best);
    const index = latest.resourceIds.indexOf(pick.id);
    if (index < 0) return undefined;
    const selected = await open(index);
    const current = selected.result.listings[0];
    if (current) selected.result.query = { ...selected.result.query, buyer: { authority: "DINAR", message: `${reference.kind === "CHEAPEST" ? "الأرخص" : "الأغلى"} بين العروض الظاهرة المتاحة: «${current.title}» بسعر ${current.unitPrice} ${current.currency}. من سجل جاسم الحالي، بدون التوصيل أو أي رسوم. لم يتغير شيء.` } };
    return selected;
  }
  // «لا، أقصد الثالث، ولا تضيفه للسلة»: once the correction and the refusal are set aside, what
  // remains is a plain reference. It is only opened (read-only), whatever the message refused.
  if (core !== context.message.trim() && refusesCommercialAction(context.message) || core !== stripCorrectionPrefix(context.message)) {
    const whole = parseResultReference(core);
    if (whole) {
      const index = whole.kind === "LAST" ? latest.resourceIds.length - 1 : whole.index;
      if (index < latest.resourceIds.length) return open(index);
    }
  }
  return undefined;
}

function clarify(prompt?: string): { tool: string; version: number; result: ToolResult } {
  return {
    tool: "openSurface",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "CLARIFY",
      query: {},
      listings: [],
      ...(prompt ? { prompt } : {}),
    },
  };
}

function categoryMention(
  message: string,
  categories: Awaited<ReturnType<typeof listMarketplaceCategories>>,
) {
  const normalized = normalizeSearch(message);
  return categories
    .flatMap((category) =>
      [category.label, category.id, ...category.aliases].map((alias) => ({
        category,
        alias: normalizeSearch(alias),
      })),
    )
    .filter(({ alias }) => alias.length >= 2 && hasCategoryAlias(normalized, alias))
    .sort((a, b) => b.alias.length - a.alias.length)[0]?.category;
}

const CANONICAL_ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
const REFERENCE_WANT = /^(?:انا\s+)?(?:ابي|ابغي|بدي|اريد|خذ|اخذ)$/u;

/**
 * «لا قصدي الثانية», «لا قصدي الطاولة الثالثة», «الطاولة الثانية» right after a result list or a
 * purchase review: the user names a position in the list they are looking at. Rewritten to
 * the canonical ordinal the existing open/review handlers already resolve against the stored
 * result set, so the correction re-opens the same review path (nothing is bought or added).
 * Only applies when the latest card is that list or review; draft choices are untouched.
 */
async function resultReferenceCorrection(conversationId: string, message: string): Promise<string | undefined> {
  // «ضيف الأول», «حط الثاني»: the verb is the request. Rewriting to the bare ordinal would drop it
  // and open the listing instead; the cart path resolves the position with its own checks.
  if (addToCartIntent(message)) return undefined;
  const stripped = stripCorrectionPrefix(message);
  const corrected = stripped !== message.trim();
  const reference = findOrdinalMention(stripped);
  if (reference?.kind !== "INDEX" || reference.index >= CANONICAL_ORDINALS.length) return undefined;
  const words = foldArabicLetters(stripped).replace(/[؟?!.،,؛;:()«»"']+/gu, " ").split(/\s+/u).filter(Boolean);
  const wants = words.filter((word) => REFERENCE_WANT.test(word)).length;
  const others = words.filter((word) => !REFERENCE_WANT.test(word)).length - 1;
  // Exactly the ordinal, optionally one noun («الطاولة») and a want verb; anything more is a new request.
  if (others > 1 || (!corrected && others === 0 && !wants)) return undefined;
  const [latest] = await db
    .select({ blockType: aiUiBlocks.blockType, payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  const reviewing = latest?.blockType === "SURFACE" && latest.payload.surface === "PURCHASE_REVIEW";
  const listing = latest?.blockType === "LISTING_RESULTS";
  if (!reviewing && !listing) return undefined;
  const ordinal = CANONICAL_ORDINALS[reference.index]!;
  return reviewing || wants ? `أبي ${ordinal}` : ordinal;
}

/** The model fallback could not interpret the turn (not configured, outage, quota, rate limit). */
function modelUnavailable(turn: { result: ToolResult }): boolean {
  const advice = (turn.result as { advice?: { modelStatus?: unknown } }).advice;
  return typeof advice?.modelStatus === "string";
}

const DRAFT_DESCRIPTION_REQUEST = /(?:^|\s)اكتب(?:\s+لي)?\s+(?:\S+\s+)?وصف/u;
const BARE_PHRASE_MAX_WORDS = 4;
function isBareProductPhrase(message: string): boolean {
  // «ايفون 13 مستعمل لو سمحت»: politeness does not make a product phrase a sentence.
  const words = normalizeSearch(searchTerms(message))
    .replace(/(?:^|\s)(?:لو سمحت|لو سمحتي|من فضلك|الله يخليك|رجاء|رجاءا)(?=\s|$)/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  return words.length > 0 && words.length <= BARE_PHRASE_MAX_WORDS && !isGeneralRequest(message);
}

/** The runtime's own classification of a message, before any handler runs. */
function actionHint(message: string): ConversationActionId | undefined {
  return (
    resolveConversationActionId(message) ??
    (addToCartIntent(message)
      ? "ADD_TO_CART"
      : surfaceIntent(message) === "SELL" && !OPEN_SELLER_QUESTION.test(message)
        ? "CREATE_PRODUCT_DRAFT"
        : hasExplicitMarketplaceSearchIntent(message)
          ? "SEARCH_LISTINGS"
          : undefined)
  );
}

function stepIntent(text: string): ConversationActionId {
  return actionHint(text) ?? (isDraftResumeRequest(text) ? "CREATE_PRODUCT_DRAFT" : "GENERAL_CHAT");
}

type TurnContext = Parameters<typeof executeAiConversationTurn>[0];
type TurnOptions = NonNullable<Parameters<typeof executeAiConversationTurn>[1]>;
type TurnExecution = Awaited<ReturnType<typeof executeAiConversationTurn>>;

function planNotice(prompt: string): TurnExecution {
  return { tool: "openSurface", version: 1, result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], prompt } };
}

/**
 * Compound requests, «التالي» and «ألغ باقي الطلب» (see task-plan.ts). Each step re-enters
 * this runtime as an ordinary message, so it gets the same route gates and reviews.
 */
async function executeTaskPlanTurn(
  context: TurnContext,
  options: TurnOptions,
  modelSteps?: string[],
): Promise<TurnExecution | undefined> {
  const actorId = context.actorId!;
  const runStep = async (plan: TaskPlan, step: TaskStep): Promise<TurnExecution> => {
    try {
      const executed = await executeAiConversationTurn(
        { ...context, message: step.text },
        { ...options, planStep: true },
      );
      const result = executed.result as { kind: string; surface?: string };
      return {
        ...executed,
        taskPlan: completeStep(plan, step.index, { tool: executed.tool, surface: result.surface ?? result.kind }),
      };
    } catch (error) {
      // Search is read-only and safe to retry. Do not swallow write failures or invite retries
      // where an interrupted response could conceal an already-applied mutation.
      if (step.intent !== "SEARCH_LISTINGS") throw error;
      return {
        ...planNotice("تعذّر إكمال البحث؛ لم أتابع أي خطوة لاحقة. يمكنك طلب إعادة المحاولة."),
        taskPlan: failStep(plan, step.index, "STEP_EXECUTION_FAILED"),
      };
    }
  };
  if (isPlanCancellation(context.message)) {
    const live = await latestTaskPlan(context.conversationId, actorId);
    if (!live || !live.plan.steps.some((step) =>
      step.status === "PENDING" ||
      step.status === "FAILED" ||
      (step.status === "BLOCKED" && step.reason === "CONDITIONAL_FUTURE_ACTION"),
    )) return undefined;
    return { ...planNotice("ألغيت باقي خطوات طلبك المركّب؛ لم يُنفّذ منها شيء."), taskPlan: cancelPending(live.plan) };
  }
  if (isPlanRetry(context.message)) {
    const live = await latestTaskPlan(context.conversationId, actorId);
    const failed = live?.plan.steps.find(isRetryablePlanStep);
    if (!live || !failed) return undefined;
    if (live.plan.marketId !== context.market.id)
      return { ...planNotice("بدأ هذا الطلب في سوق آخر؛ لن أعيد تنفيذه هنا. أعد كتابة طلبك في هذا السوق."), taskPlan: cancelPending(live.plan) };
    const plan = retryFailedStep(live.plan, failed.index);
    const step = plan.steps.find((candidate) => candidate.index === failed.index);
    if (!step) return undefined;
    options.onToolSelected?.("taskPlan");
    return runStep(plan, step);
  }
  if (isPlanContinuation(context.message)) {
    const live = await latestTaskPlan(context.conversationId, actorId);
    const step = live && nextPendingStep(live.plan);
    if (!live || !step) return undefined;
    // A plan never follows its actor into another market's context.
    if (live.plan.marketId !== context.market.id)
      return { ...planNotice("بدأ هذا الطلب في سوق آخر؛ لن أنفّذ خطواته هنا. أعد كتابة طلبك في هذا السوق."), taskPlan: cancelPending(live.plan) };
    options.onToolSelected?.("taskPlan");
    return runStep(live.plan, step);
  }
  const split = modelSteps ? { steps: modelSteps, truncated: false } : splitCompoundRequest(context.message);
  if (!split) return undefined;
  const plan = buildTaskPlan({ ...split, actorId, marketId: context.market.id, intentOf: stepIntent });
  // Several general questions (or «…ثم…» inside one) are one model turn, not a plan. A step
  // DINAR answers from its own records («كم بقي من حصتي؟», «كم بعت؟») is not general.
  const answeredByDinar = (text: string) => isAiUsageQuestion(text) || isSellerBusinessQuestion(text);
  if (plan.steps.every((step) => step.intent === "GENERAL_CHAT" && !answeredByDinar(step.text))) return undefined;
  const first = nextPendingStep(plan);
  if (!first) return { ...planNotice("لم أنفّذ شيئًا: التأكيد يكون برسالة مستقلة بعد أن ترى المراجعة."), taskPlan: plan };
  return runStep(plan, first);
}

export async function executeAiConversationTurn(
  context: {
    conversationId: string;
    currentMessageId: string;
    message: string;
    market: ConversationMarket;
    actorId?: string;
    modelToolContinuation?: unknown;
    imageObjectPaths?: string[];
    /** Server-only visual interpretation after private ownership, budget and provider validation. */
    imageUnderstanding?: { answer: string; status: "ANALYZED" | "UNAVAILABLE" };
    reasoningEffort?: "low" | "medium" | "high";
    modelPreference?: "DEFAULT" | "PREMIUM_TRIAL" | "AUTO" | "ECONOMY" | "CORE" | "ADVANCED";
    /** Explicit one-time location submission against a delivery request (Block D). */
    location?: unknown;
    locationRequestId?: string;
  },
  options: {
    modelGateway?: ConversationModelGateway;
    domainSearchProviders?: DomainSearchProvider[];
    onToolSelected?: (name: string) => void;
    onModelToolProgress?: (state: import("./smart-turn").ModelToolContinuation) => Promise<void>;
    onRouteDecision?: (decision: ConversationRouteDecision) => void;
    photoSuggestionProvider?: ListingPhotoSuggestionProvider;
    personalContextService?: import("./personal-context-service").PersonalContextService;
    /** Set when a compound-request step re-enters the runtime; it is never re-split. */
    planStep?: boolean;
    /** A model-named capability re-entering the runtime: never consult the model again. */
    noModel?: boolean;
    /** routing-mode.ts: ONLY runs just the model consultation (with its canonical re-entry). */
    modelStage?: "ONLY";
  } = {},
): Promise<{ tool: string; version: number; result: ToolResult; taskPlan?: TaskPlan }> {
  // The assistant's name «جاسم» (JassimAI, formerly DINAR) at the start of a message is a form of
  // address, like «دينار» before it: removed before any routing so «جاسم ابحث عن جوال» searches for
  // a phone, not for «جاسم». The stored message is unchanged.
  // Product names keep their name: «جاسم بزنس», «جاسم جو», «جاسم برو», «جاسم كونكت» are plans and
  // services, not an address followed by a request.
  const addressed = context.message.replace(/^\s*(?:يا\s+)?جاسم\s*[،,:!]?\s+(?=\S)(?!(?:بزنس|بيزنس|business|جو|go|برو|pro|كونكت|كونيكت|connect)(?:\s|[؟?!.،,]|$))/iu, "");
  if (addressed !== context.message) context = { ...context, message: addressed };
  if (context.imageUnderstanding) {
    const prompt = claimsCompletedAction(context.imageUnderstanding.answer)
      ? "أستطيع شرح محتوى الصورة فقط؛ لم أنفّذ أي إجراء أو أؤكد شراءً أو دفعًا."
      : context.imageUnderstanding.answer;
    return { tool: "imageUnderstanding", version: 1, result: {
      kind: "SURFACE", surface: "ADVICE", listings: [],
      query: { kind: "CONVERSATION", ownerId: context.actorId ?? null },
      advice: { kind: "GROUNDED_ADVICE", scope: "CONVERSATION", authority: "MODEL", modelStatus: context.imageUnderstanding.status }, prompt,
    } };
  }
  if (!context.imageObjectPaths?.length && context.location === undefined) {
    const connected = await executeConnectReadTurn({ message: context.message, actorId: context.actorId, market: context.market, providers: options.domainSearchProviders, ...(options.planStep ? { deferWithoutDomain: true } : {}) });
    if (connected) { options.onToolSelected?.(connected.tool); return connected; }
  }
  if ((!options.noModel && !options.planStep) &&
      (Boolean(context.actorId) || isExplicitSellerEmployeeInvocation(context.message))) {
    const employee = await executeSellerEmployeeTurn(
      {
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
        requestKey: `turn:${context.currentMessageId}`,
        reasoningEffort: context.reasoningEffort,
        modelPreference: context.modelPreference,
      },
      options.modelGateway,
      {
        hasImages: Boolean(context.imageObjectPaths?.length),
        hasLocation: context.location !== undefined,
      },
      sellerEmployeeActionHandler(context),
    );
    if (employee) {
      options.onToolSelected?.(employee.tool);
      return employee;
    }
  }
  return executeWithRoutingMode(context, options);
}

type RuntimeContext = Parameters<typeof executeAiConversationTurn>[0];
type RuntimeOptions = NonNullable<Parameters<typeof executeAiConversationTurn>[1]>;
type RuntimeTurn = Awaited<ReturnType<typeof executeAiConversationTurn>>;

function sellerEmployeeActionHandler(
  context: RuntimeContext,
): SellerEmployeeActionHandler {
  return async ({ action, message, session, replyText, itemHint, employeeInquiryId }) => {
    const requireCapability = (capability: Parameters<typeof requireSellerEmployeeCapability>[0]["capability"]) =>
      requireSellerEmployeeCapability({
        actorId: context.actorId!,
        conversationId: context.conversationId,
        marketId: context.market.id,
        sessionId: session.id,
        capability,
      });

    if (action === "ANSWER_CATALOG") {
      await requireCapability("business.catalog.read");
      const catalog = await delegatedSellerModelContext({
        actorId: context.actorId!,
        marketId: context.market.id,
        delegationId: session.delegationId,
      });
      if (!catalog) throw new Error("تعذر تحميل كتالوج النشاط ضمن التفويض الحالي");
      const normalize = (value: string) => normalizeSearch(value)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      const queries = [itemHint, message]
        .filter((value): value is string => typeof value === "string")
        .map(normalize)
        .filter((value) => value.length >= 2);
      const matches = catalog.listings.filter((listing) => {
        const title = normalize(listing.title);
        return title.length > 0 && queries.some((query) =>
          query === title || query.includes(title) || title.includes(query),
        );
      });
      if (!matches.length)
        return sellerEmployeeFactResponse(
          "لم أتمكن من تحديد عرض منشور ضمن نطاق التفويض. اذكر اسمه؛ لن أخمّن مواصفاته.",
          "CATALOG_ITEM_CLARIFICATION",
          context.actorId,
        );
      if (matches.length > 1)
        return sellerEmployeeFactResponse(
          `وجدت أكثر من عرض مطابق. اختر واحدًا بالاسم:\n${matches.slice(0, 8).map((listing) => `• ${listing.title}`).join("\n")}`,
          "CATALOG_ITEM_AMBIGUOUS",
          context.actorId,
        );
      const listing = matches[0]!;
      const normalizedMessage = normalize(message);
      const asksPrice = /(?:سعر|كم\s*(?:السعر|يكلف)|price|cost)/u.test(normalizedMessage);
      const asksCategory = /(?:تصنيف|فئة|category|نوع\s*المنتج)/u.test(normalizedMessage);
      const asksUnrecordedSpec = /(?:بطاري|ضمان|مقاس|قياس|لون|كامير|ذاكر|مساح|موديل|أصلي|اصلي|مواصفات)/u.test(normalizedMessage);
      if (asksUnrecordedSpec)
        return sellerEmployeeFactResponse(
          `لا تسجل بيانات العرض الحالية هذه المواصفة لـ«${listing.title}». لم أخمّنها.`,
          "CATALOG_SPEC_NOT_RECORDED",
          context.actorId,
        );
      if (asksPrice) {
        const price = listing.priceMinor === null || typeof listing.priceMinor !== "number"
          ? "لا يوجد سعر ثابت مسجل."
          : `السعر المسجل ${(
              listing.priceMinor / 10 ** context.market.minorUnitScale
            ).toFixed(context.market.minorUnitScale)} ${context.market.currencyCode}.`;
        return sellerEmployeeFactResponse(`«${listing.title}»: ${price}`, "CATALOG_PRICE_READ", context.actorId);
      }
      const category = listing.category ? `التصنيف المسجل: ${listing.category}.` : "لا يوجد تصنيف مسجل.";
      return sellerEmployeeFactResponse(
        `العرض المنشور ضمن التفويض هو «${listing.title}». ${asksCategory ? category : `${category} لم أضف مواصفات غير موجودة في سجل الكتالوج.`}`,
        "CATALOG_FACT_READ",
        context.actorId,
      );
    }
    if (action === "READ_INVENTORY") {
      await requireCapability("business.inventory.read");
      const catalog = await delegatedSellerModelContext({
        actorId: context.actorId!,
        marketId: context.market.id,
        delegationId: session.delegationId,
      });
      if (!catalog) throw new Error("تعذر التحقق من المخزون الحالي للنشاط");
      const available = catalog.listings.filter(
        (listing) => Object.prototype.hasOwnProperty.call(listing, "availableQuantity"),
      );
      if (!available.length)
        return sellerEmployeeFactResponse(
          "لا توجد عروض منشورة ضمن نطاق التفويض.",
          "INVENTORY_EMPTY",
          context.actorId,
        );
      const normalize = (value: string) => normalizeSearch(value)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      const queries = [itemHint, message]
        .filter((value): value is string => typeof value === "string")
        .map(normalize)
        .filter((value) => value.length >= 2);
      const matches = available.filter((listing) => {
        const title = normalize(listing.title);
        return title.length > 0 && queries.some((query) =>
          query === title || query.includes(title) || title.includes(query),
        );
      });
      if (!matches.length)
        return sellerEmployeeFactResponse(
          "لم أتمكن من تحديد عرض واحد منشور ضمن نطاق التفويض. اذكر اسم المنتج؛ لم أذكر مخزونًا غير متحقق.",
          "INVENTORY_ITEM_CLARIFICATION",
          context.actorId,
        );
      if (matches.length > 1)
        return sellerEmployeeFactResponse(
          `وجدت أكثر من عرض مطابق. اختر واحدًا بالاسم:\n${matches.slice(0, 8).map((listing) => `• ${listing.title}`).join("\n")}`,
          "INVENTORY_AMBIGUOUS",
          context.actorId,
        );
      const [listing] = matches;
      const quantity = listing!.availableQuantity;
      const detail = listing!.inventoryMode !== "LIMITED" || typeof quantity !== "number"
        ? `«${listing!.title}»: الكمية غير محددة في سجل المخزون`
        : `«${listing!.title}»: ${quantity > 0 ? `${quantity} متاح` : "غير متاح حاليًا"}`;
      return sellerEmployeeFactResponse(
        `المخزون المسجل: ${detail}.`,
        "INVENTORY_READ",
        context.actorId,
      );
    }
    if (action === "READ_ORDERS") {
      const rows = await readSellerEmployeeOrders({
        actorId: context.actorId!,
        conversationId: context.conversationId,
        marketId: context.market.id,
        sessionId: session.id,
      });
      if (!rows.length)
        return sellerEmployeeFactResponse(
          "لا توجد طلبات ضمن نشاطك ونطاق التفويض الحالي.",
          "ORDERS_EMPTY",
          context.actorId,
        );
      const details = rows.map((row) => {
        const amount = (row.scopedSubtotalMinor / 10 ** context.market.minorUnitScale)
          .toFixed(context.market.minorUnitScale);
        return `• طلب ${row.orderId.slice(-8)} — ${row.status} — ${row.scopedItemCount} منتج ضمن الصلاحية — ${amount} ${row.currencyCode}`;
      });
      return sellerEmployeeFactResponse(
        `طلبات النشاط ضمن نطاق التفويض:\n${details.join("\n")}\nلم أعرض بيانات المشتري أو منتجات خارج النطاق.`,
        "ORDERS_READ",
        context.actorId,
      );
    }
    if (action === "REQUEST_PUBLICATION_REVIEW") {
      await requireCapability("business.catalog.draft");
      if (!/(?:مراجعه|راجع|للمراجعه|قبل\s+النشر)/u.test(normalizeSearch(message)))
        throw new Error("لا يمكن للموظف طلب النشر مباشرة؛ اكتب صراحةً أنك تريد مراجعة المسودة");
      const [latest] = await db.select({ payload: aiUiBlocks.payload })
        .from(aiUiBlocks)
        .where(eq(aiUiBlocks.conversationId, context.conversationId))
        .orderBy(desc(aiUiBlocks.createdAt))
        .limit(1);
      const latestPayload = latest?.payload as Record<string, any> | undefined;
      if (
        latestPayload?.surface !== "SELL" ||
        !latestPayload.draft?.draftId ||
        ["published", "cancelled", "choose_draft"].includes(String(latestPayload.draftStep ?? ""))
      )
        return sellerEmployeeFactResponse(
          "لا توجد مسودة نشطة في هذه المحادثة لإرسالها للمراجعة. لم يُنشأ إعلان ولم يتغير شيء.",
          "PUBLICATION_DRAFT_NOT_FOUND",
          context.actorId,
        );
      const draftBinding = await sellerEmployeeDraftBinding({
        actorId: context.actorId!,
        draftId: String(latestPayload.draft.draftId),
      });
      if (!sellerEmployeeDraftBindingMatches(draftBinding, {
        businessId: session.businessId,
        conversationId: context.conversationId,
        marketId: context.market.id,
        sessionId: session.id,
      }))
        return sellerEmployeeFactResponse(
          "هذه المسودة غير مرتبطة بالنشاط المفوّض الحالي؛ لم أفتح مراجعة ولم أكشف بيانات نشاط آخر.",
          "PUBLICATION_DRAFT_OUT_OF_SCOPE",
          context.actorId,
        );
      const review = await executeDraftActionTurn({
        conversationId: context.conversationId,
        message: "انشره",
        market: context.market,
        actorId: context.actorId,
        delegatedAuthority: {
          sessionId: session.id,
          capabilities: ["business.catalog.draft"],
        },
      });
      if (!review)
        return sellerEmployeeFactResponse(
          "تعذر تحديد مسودة حالية صالحة للمراجعة؛ لم يُنشر شيء.",
          "PUBLICATION_REVIEW_NOT_CREATED",
          context.actorId,
        );
      return review;
    }
    if (action === "DRAFT_LISTING") {
      await requireCapability("business.catalog.draft");
      const includesPublish =
        /(?:انشر|نشر|اعتمد|أكد|اكد|تأكيد|موافق|نعم|publish|confirm)/iu.test(message);
      if (includesPublish)
        throw new Error("يمكن للموظف إعداد مسودة نشاط مدعومة فقط؛ النشر يحتاج مراجعة المالك");
      if (/(?:سعر|السعر|بسعر|بمبلغ|مبلغ|price)/iu.test(message))
        await requireCapability("business.catalog.draft.price");
      const [latest] = await db.select({ payload: aiUiBlocks.payload })
        .from(aiUiBlocks)
        .where(eq(aiUiBlocks.conversationId, context.conversationId))
        .orderBy(desc(aiUiBlocks.createdAt))
        .limit(1);
      const latestPayload = latest?.payload as Record<string, any> | undefined;
      const existingDraftId = typeof latestPayload?.draft?.draftId === "string"
        ? latestPayload.draft.draftId as string
        : undefined;
      const existingDraftActive = latestPayload?.surface === "SELL" &&
        existingDraftId &&
        !["published", "cancelled", "choose_draft"].includes(String(latestPayload.draftStep ?? ""));
      const existingBinding = existingDraftActive
        ? await sellerEmployeeDraftBinding({ actorId: context.actorId!, draftId: existingDraftId })
        : undefined;
      if (existingDraftActive && !sellerEmployeeDraftBindingMatches(existingBinding, {
        businessId: session.businessId,
        conversationId: context.conversationId,
        marketId: context.market.id,
        sessionId: session.id,
      }))
        return sellerEmployeeFactResponse(
          "هذه المسودة غير مرتبطة بالنشاط المفوّض الحالي. لم أعدّلها أو أستخدم بيانات نشاط آخر.",
          "SELLER_DRAFT_OUT_OF_SCOPE",
          context.actorId,
        );
      const draft = await listingDraft(context.conversationId, message, "SELL", [], undefined, context.actorId);
      if (draft?.kind === "SURFACE" && draft.surface === "SELL" && draft.draft?.draftId) {
        const boundDraft = Object.assign({}, draft, {
          d5DraftBinding: {
            sessionId: session.id,
            businessId: session.businessId,
            draftId: draft.draft.draftId,
          },
        }) as ToolResult & { d5DraftBinding: { sessionId: string; businessId: string; draftId: string } };
        return { tool: "openSurface", version: 1, result: boundDraft };
      }
      return draft
        ? { tool: "openSurface", version: 1, result: draft }
        : sellerEmployeeFactResponse(
            "اذكر اسم المنتج والتفاصيل التي تريد إدخالها في المسودة. لم يُنشر شيء.",
            "SELLER_DRAFT_CLARIFICATION",
            context.actorId,
          );
    }
    if (action === "DRAFT_INQUIRY_REPLY") {
      if (replyText && /(?:تم(?:ت)?\s+(?:الدفع|السداد|استلام\s+(?:المبلغ|الدفعة))|استلم(?:نا|ت)\s+(?:المبلغ|الدفع)|وصل(?:نا|ت)\s+(?:المبلغ|الدفعة)|payment\s+(?:received|confirmed)|\bpaid\b)/iu.test(replyText))
        return sellerEmployeeFactResponse(
          "لا يوجد في جلسة الموظف سجل مالي يؤكد الدفع أو استلام المبلغ؛ لم أعدّ هذا الرد.",
          "PAYMENT_CLAIM_UNVERIFIED",
          context.actorId,
        );
      await requireCapability("business.inquiries.reply");
      await requireCapability("business.messages.send");
      return executeInquiryTurn({
        conversationId: context.conversationId,
        message,
        market: context.market,
        actorId: context.actorId,
        employeeSession: session,
        employeeReply: replyText,
        employeeInquiryId,
      });
    }
    if (action === "ESCALATE_NEGOTIATION") {
      const rows = await escalateSellerEmployeeNegotiations({
        actorId: context.actorId!,
        conversationId: context.conversationId,
        marketId: context.market.id,
        sessionId: session.id,
      });
      if (!rows.length)
        return sellerEmployeeFactResponse(
          "لا توجد عروض تفاوض مفتوحة ضمن نشاطك ونطاق التفويض.",
          "NEGOTIATION_ESCALATION_EMPTY",
          context.actorId,
        );
      const awaitingOwner = rows.filter((row) => row.awaitingSeller);
      if (!awaitingOwner.length)
        return sellerEmployeeFactResponse(
          "لا يوجد عرض بانتظار قرار المالك الآن. لم أقبل عرضًا أو أرسل مقابلاً.",
          "NEGOTIATION_ESCALATED_NO_OWNER_DECISION",
          context.actorId,
        );
      return sellerEmployeeNegotiationReviewTurn({
        conversationId: context.conversationId,
        market: context.market,
        actorId: context.actorId!,
      }, awaitingOwner.map((row) => row.negotiationId));
    }
    return null;
  };
}

/** A review this actor has not decided yet (purchase, inquiry, offer, policy): its reply is a decision. */
async function hasOpenReview(conversationId: string, marketId: string, actorId: string | undefined): Promise<boolean> {
  if (!actorId) return false;
  const [latest] = await db
    .select({ query: aiResultSets.query, expiresAt: aiResultSets.expiresAt })
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const query = latest?.query as { ownerId?: unknown; status?: unknown } | undefined;
  return Boolean(query && query.ownerId === actorId && query.status === "PENDING" && (!latest!.expiresAt || latest!.expiresAt.getTime() > Date.now()));
}

const NO_MODEL_RESULT: RuntimeTurn = { tool: "__noModelResult", version: 1, result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [] } };

/** An empty reading: DINAR searched and found nothing, or could only ask what was meant. */
function isSoftMiss(turn: RuntimeTurn): boolean {
  if (turn.result.kind === "SEARCH") return turn.result.listings.length === 0;
  return turn.tool === "openSurface" && turn.result.kind === "SURFACE" && turn.result.surface === "CLARIFY" && !turn.result.policyReview;
}
const isModelAnswer = (turn: RuntimeTurn) => turn.tool === "smartConversation";
/** Phase 2: a server-composed display of a verified read is DINAR's own data, not model text. */
const hasGroundedDisplay = (turn: RuntimeTurn) => Boolean((turn.result as { displaySurface?: unknown } | undefined)?.displaySurface);

/**
 * The routing modes of routing-mode.ts around the one runtime. Re-entries (plan steps, model
 * canonical requests) and image/location turns always run the runtime as it is.
 */
async function executeWithRoutingMode(context: RuntimeContext, options: RuntimeOptions): Promise<RuntimeTurn> {
  const mode = aiRoutingMode();
  // A step of a running plan («ساعدني أختار اسمًا», «ابحث عن دومين») that DINAR's own path only
  // soft-misses (an empty product search) is interpreted once by the model, in every mode: an
  // empty search is no answer to a step the user asked for. Bounded: one model stage per step.
  if (options.planStep && !options.noModel && !options.modelStage && context.actorId && !context.imageObjectPaths?.length && context.location === undefined) {
    const before = getModelGatewayCallCount();
    const own = await executeRuntime(context, options);
    if (getModelGatewayCallCount() > before || !isSoftMiss(own)) return own;
    const interpreted = await executeRuntime(context, { ...options, modelStage: "ONLY" });
    return interpreted !== NO_MODEL_RESULT && !isSoftMiss(interpreted) ? interpreted : own;
  }
  const plain = mode === "LEGACY" || options.noModel || options.planStep || options.modelStage || !context.actorId || context.imageObjectPaths?.length || context.location !== undefined;
  if (plain && !options.noModel && !options.planStep && !options.modelStage && context.actorId && !context.imageObjectPaths?.length && context.location === undefined) {
    // A goal sentence («أبي أفتح مشروع، ساعدني من البداية», «أبي سائق ينقل الغسالة») that DINAR's own
    // path could only read as a product search, and that matched nothing, is no answer: the model
    // interprets it once. A short product phrase keeps the honest empty result, and without a
    // model the empty result is returned as it is.
    const before = getModelGatewayCallCount();
    const own = await executeRuntime(context, options);
    if (getModelGatewayCallCount() > before || own.result.kind !== "SEARCH" || own.result.listings.length) return own;
    if (searchTerms(context.message).split(/\s+/u).filter(Boolean).length < 3) return own;
    // An explicit search («ابحث عن …», «دوّر لي …», «ورني …») that found nothing is answered by
    // that honest empty result: the model is never asked to stand in for missing listings.
    // The guard covers a search of the marketplace: the search verb leads the request and the request
    // is not about the user's own catalogue («اعرض لي منتجات متجري وحسّن وصفها» is a seller task).
    const asked = normalizeMarketplaceText(context.message).replace(/^(?:(?:يا\s+)?دينار\s*)/u, "");
    const ownCatalogue = /(?:^|\s)(?:متجري|منتجاتي|اعلاناتي|إعلاناتي|عروضي|نشاطي|محلي|بضاعتي)(?=\s|$)/u.test(asked);
    if (!ownCatalogue && EXPLICIT_SEARCH_ACTION.test(asked.split(/\s+/u).slice(0, 2).join(" "))) return own;
    const interpreted = await executeRuntime(context, { ...options, modelStage: "ONLY" });
    return interpreted !== NO_MODEL_RESULT && !isSoftMiss(interpreted) ? interpreted : own;
  }
  if (plain) return executeRuntime(context, options);
  if (mode === "MODEL_FIRST") {
    // The model reads first. A canonical request it restated re-entered DINAR and wins; otherwise
    // DINAR's own path runs (model disabled: no second paid call), and the model's answer is kept
    // only when DINAR had nothing. A capability DINAR handles is never lost to model text.
    const first = await executeRuntime(context, { ...options, modelStage: "ONLY" });
    if (first !== NO_MODEL_RESULT && (!isModelAnswer(first) || hasGroundedDisplay(first))) return first;
    const own = await executeRuntime(context, first === NO_MODEL_RESULT ? options : { ...options, noModel: true });
    return first !== NO_MODEL_RESULT && isSoftMiss(own) ? first : own;
  }
  const before = getModelGatewayCallCount();
  const legacy = await executeRuntime(context, options);
  const consulted = getModelGatewayCallCount() > before;
  if (mode === "HYBRID" && !consulted && isSoftMiss(legacy)) {
    // One model consultation; only a DINAR re-entry that found something replaces the empty reading.
    const second = await executeRuntime(context, { ...options, modelStage: "ONLY" });
    if (second !== NO_MODEL_RESULT && !isModelAnswer(second) && !isSoftMiss(second)) return second;
  }
  return legacy;
}

async function executeRuntime(context: RuntimeContext, incoming: RuntimeOptions): Promise<RuntimeTurn> {
  // The model stage belongs to this call only: plan steps and canonical re-entries never inherit it.
  const { modelStage, ...options } = incoming;
  // «تمام روجه», «طيب نفذ»: a leading acknowledgement is not part of the command.
  context = { ...context, message: withoutAcknowledgement(context.message) };
  const modelFallback = async () => {
    if (options.noModel) return null;
    const turn = await executeModelFallback(
      {
        conversationId: context.conversationId,
        currentMessageId: context.currentMessageId,
        modelToolContinuation: context.modelToolContinuation,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
        onToolSelected: options.onToolSelected,
        onModelToolProgress: options.onModelToolProgress,
        requestKey: `turn:${context.currentMessageId}`,
        reasoningEffort: context.reasoningEffort,
        modelPreference: context.modelPreference,
        allowTaskPlanning: !options.planStep && aiRoutingMode() !== "SHADOW",
      },
      options.modelGateway,
      // Suggestions re-enter the same deterministic review a typed command opens.
      async (message) =>
        (await executeNegotiationTurn({ conversationId: context.conversationId, message, market: context.market, actorId: context.actorId })) ??
        executeBuyerTurn({ conversationId: context.conversationId, message, market: context.market, actorId: context.actorId }),
      async (message) => {
        const result = await listingDraft(
          context.conversationId,
          message,
          "SELL",
          context.imageObjectPaths,
          options.photoSuggestionProvider,
          context.actorId,
        );
        return result ? { tool: "openSurface", version: 1, result } : null;
      },
      // A capability the model named re-enters the whole deterministic runtime, model disabled.
      async (message) => {
        const routed = await executeAiConversationTurn({ ...context, message }, { ...options, planStep: true, noModel: true });
        return routed.result.kind === "SURFACE" && routed.result.surface === "CLARIFY" ? null : routed;
      },
    );
    if (turn?.taskPlanProposal) {
      const planned = await executeTaskPlanTurn(context, options, turn.taskPlanProposal);
      if (planned) return planned;
      const { taskPlanProposal: _discardedProposal, ...modelReply } = turn;
      options.onToolSelected?.(modelReply.tool);
      return modelReply;
    }
    if (turn) options.onToolSelected?.(turn.tool);
    return turn;
  };
  if (!context.imageObjectPaths?.length && context.location===undefined) {
    const explicitReply=explicitReadOnlyCalculation(context.message) ?? explicitMarketingTruthRefusal(context.message);
    if(explicitReply){options.onToolSelected?.("dinarConversationTurn");return {tool:"dinarConversationTurn",version:1,result:{kind:"SURFACE",surface:"ADVICE",query:{},listings:[],advice:{kind:"GROUNDED_ADVICE",scope:"CONVERSATION",authority:"DINAR"},prompt:explicitReply}};}
  }
  // A turn that died mid read resumes the same bounded model loop: its signatures and
  // verified feedback belong to that loop, not to a fresh deterministic reading.
  if (!options.noModel && !options.planStep && context.modelToolContinuation) {
    const resumed = await modelFallback();
    if (resumed) return resumed;
  }
  // Phase 2/3: a short request to work with what is on screen («اعرضها كجدول», «رتبهم من الأغلى»,
  // «خلني أشوف المتوفر بس», «أي شهر الأعلى؟», «خلها أعمدة») is neither a sale nor a purchase. It is
  // applied to the conversation's latest display, re-read under the actor's authority, without a
  // model call. Comparisons keep the existing compare handlers; other phrasings reach the model.
  if (!options.planStep && context.actorId && !context.imageObjectPaths?.length && context.location === undefined) {
    // «نبّهني إذا توفر»: save the latest search as a buyer-authorised request (two explicit steps).
    {
      const { executeDemandAlertTurn } = await import("./demand-alert-turn");
      const alert = await executeDemandAlertTurn({ conversationId: context.conversationId, actorId: context.actorId, market: context.market, message: context.message });
      if (alert) return alert as never;
    }
    // Jassim Connect: a merchant's own-store requests («استورد منتجات موقعي», «خل الشراء من موقعي»).
    {
      const { executeConnectMerchantTurn } = await import("./connect-merchant-turn");
      const connect = await executeConnectMerchantTurn({ actorId: context.actorId, market: context.market, message: context.message });
      if (connect) return connect as never;
    }
    const interaction = displayInteraction(context.message);
    if (interaction) {
      const { applyDisplayInteraction } = await import("./display-interaction");
      const ctx = { conversationId: context.conversationId, currentMessageId: context.currentMessageId, message: context.message, market: context.market, actorId: context.actorId };
      let own: unknown = await applyDisplayInteraction(ctx as Parameters<typeof applyDisplayInteraction>[0], interaction);
      if (!own && interaction.kind === "FORMAT") {
        const { redisplayLatestResults } = await import("./smart-turn");
        own = await redisplayLatestResults(ctx as Parameters<typeof redisplayLatestResults>[0], interaction.directive, "", false);
      }
      if (own) {
        options.onToolSelected?.((own as RuntimeTurn).tool);
        return own as RuntimeTurn;
      }
    }
    // «ضيف الأرخص للسلة»: the superlative is resolved over the active display, then the ordinary
    // open/add path (with its own review) runs on that position.
    const { superlativeAsOrdinal } = await import("./display-interaction");
    const rewritten = await superlativeAsOrdinal(
      { conversationId: context.conversationId, currentMessageId: context.currentMessageId, message: context.message, market: context.market, actorId: context.actorId } as Parameters<typeof superlativeAsOrdinal>[0],
      normalizeSearch(context.message).replace(/[؟?!.،,]/gu, " ").replace(/\s+/gu, " ").trim(),
    );
    if (rewritten) context = { ...context, message: rewritten };
  }
  if (
    !options.planStep &&
    context.actorId &&
    !context.imageObjectPaths?.length &&
    context.location === undefined
  ) {
    const planned = await executeTaskPlanTurn(context, options);
    if (planned) return planned;
  }
  // R3E: a correction («أقصد عرض الشراء», «مو الإعلان، العرض», «نرجع للعرض السابق») repairs the
  // reading in context. A position in a visible list keeps the existing rewrite; any other
  // corrected clause is resolved against the conversation, never sent to search.
  let repair: { back?: boolean; meant?: string } | undefined;
  const original = context.message;
  if (context.actorId && !context.imageObjectPaths?.length && context.location === undefined) {
    const rewritten = await resultReferenceCorrection(context.conversationId, context.message);
    if (rewritten) context = { ...context, message: rewritten };
    // A draft in progress owns corrections of its own fields («لا قصدي بدون سعر»).
    else if (!(await hasActiveListingDraft(context.conversationId))) {
      const corrected = correction(context.message);
      if (corrected?.meant) {
        repair = { ...(corrected.back ? { back: true } : {}), ...(corrected.meant ? { meant: corrected.meant } : {}) };
        context = { ...context, message: corrected.meant };
      }
    }
  }
  // «اعرض (لي) مكتبة كتب بسعر 55», «اعرض خدمة تصوير بـ 150»: offering one's own item at one exact
  // price is a sale (frozen lab contract G06-006, H-SELL-001/008). It is read as the sale phrase
  // the draft path already handles; a comparison («أقل من 55», «حتى 55») stays a search.
  if (!context.imageObjectPaths?.length && context.location === undefined) {
    const offer = contextText(context.message).replace(/^(?:(?:يا\s+)?دينار\s*[،,:]?\s+)/u, "")
      .match(/^اعرض\s+(?:لي\s+)?((?:\S+\s+){0,5}?\S+)\s+(?:ب|بسعر|بـ|سعره|سعرها)\s*([0-9]+(?:\.[0-9]+)?)(?:\s+(?:دينار|دنانير|ريال|درهم|جنيه))?$/u);
    if (offer && !/(?:^|\s)(?:اقل|ارخص|اغلي|حتي|تحت|فوق|اكثر|حدود|من)(?:\s|$)/u.test(offer[1]!))
      context = { ...context, message: `بيع ${offer[1]} بسعر ${offer[2]}` };
  }
  const hintedAction = actionHint(context.message);
  const routeDecision = resolveConversationRoute({
    message: context.message,
    actorId: context.actorId,
    marketId: context.market.id,
    marketActive: isMarketAvailable(context.market),
    actionId: hintedAction,
  });
  options.onRouteDecision?.(routeDecision);
  if (routeDecision.kind === "AUTH_REQUIRED") {
    options.onToolSelected?.("openSurface");
    return {
      tool: "openSurface",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "AUTH",
        query: {},
        listings: [],
        prompt: "سجّل الدخول أولًا للمتابعة؛ لن أنفّذ هذا الإجراء قبل التحقق من حسابك.",
      },
    };
  }
  if (routeDecision.kind === "MARKET_REQUIRED") {
    options.onToolSelected?.("openSurface");
    return {
      tool: "openSurface",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "MARKET_SELECTOR",
        query: {},
        listings: [],
        prompt: "اختر السوق أولًا لمتابعة هذا الطلب.",
      },
    };
  }
  // Universal product control (theme, browsing market, profile, recipient-addressed location):
  // before order, inquiry and commerce adapters, which would read «أرسل موقعي للسائق» or
  // «حوّل سوقي للكويت» as their own. It claims only what it can resolve.
  if (!context.imageObjectPaths?.length && context.location === undefined) {
    const control = await executeProductControlTurn({
      conversationId: context.conversationId,
      message: context.message,
      market: context.market,
      actorId: context.actorId,
    });
    if (control) {
      options.onToolSelected?.(control.tool);
      return control;
    }
  }
  // D3-A: the owner's operating profile and catalog. It runs before the legacy D2 onboarding
  // adapter so an introduction creates one linked D2 identity and D3 operating profile instead
  // of a competing verification-only profile. Unhandled D2 document/status intents still fall
  // through to that adapter below.
  if (context.actorId && !context.imageObjectPaths?.length && context.location === undefined) {
    const business = await executeBusinessTurn({
      conversationId: context.conversationId,
      message: context.message,
      market: context.market,
      actorId: context.actorId,
    });
    if (business) {
      options.onToolSelected?.(business.tool);
      return business;
    }
  }
  // D2: canonical identity verification, document intake and submission. Kept after D3 so it
  // handles only D2-specific intents or follow-ups that the operating-profile adapter declines.
  if (!context.imageObjectPaths?.length && context.location === undefined) {
    const business = await executeBusinessOnboardingTurn({ conversationId: context.conversationId, message: context.message, market: context.market, actorId: context.actorId });
    if (business) {
      options.onToolSelected?.(business.tool);
      return business;
    }
  }
  if (
    context.actorId &&
    !context.imageObjectPaths?.length &&
    (isListingPhotoSuggestionCommand(context.message) ||
      isListingPhotoTitleCorrection(context.message)) &&
    await hasPendingListingPhotoSuggestions(context.conversationId)
  ) {
    const result = await listingDraft(
      context.conversationId,
      context.message,
      "SELL",
      [],
      options.photoSuggestionProvider,
      context.actorId,
    );
    if (result) return { tool: "openSurface", version: 1, result };
  }
  // An explicit edit of a draft field («الكمية 2», «غيّر العنوان إلى …», «احذف … من الوصف») belongs
  // to the seller's draft in progress before memory, search, cart or order handlers read the words.
  if (
    context.actorId &&
    !context.imageObjectPaths?.length &&
    context.location === undefined &&
    draftFieldEdit(context.message) &&
    (await hasResumableListingDraft(context.conversationId))
  ) {
    const result = await listingDraft(context.conversationId, context.message, "SELL", [], options.photoSuggestionProvider, context.actorId);
    if (result) return { tool: "openSurface", version: 1, result };
  }
  const addToCart = addToCartIntent(context.message);
  const hasListingPhotos = Boolean(context.imageObjectPaths?.length);
  // Let explicit employment intents and their active conversation state route
  // before broad commerce, memory, order, and cart handlers can claim the same words.
  const employment =
    context.actorId &&
    context.location === undefined &&
    !hasListingPhotos &&
    !isDriverOnboardingIntent(context.message) &&
    !isExplicitProviderManagementIntent(context.message) &&
    isMarketAvailable(context.market)
      ? await executeEmploymentTurn({
          conversationId: context.conversationId,
          message: context.message,
          market: context.market,
          actorId: context.actorId,
        })
      : null;
  if (employment) {
    options.onToolSelected?.(employment.tool);
    return employment;
  }
  const memoryService = options.personalContextService ?? personalContext;
  let interactionToProcess:
    | { userId: string; eventId: string; conversationId: string; text: string; source: "SEARCH" | "CONVERSATION" }
    | undefined;
  if (context.actorId && context.location === undefined && !context.imageObjectPaths?.length &&
      await memoryService.ownsInteraction(context.actorId, context.conversationId, context.currentMessageId)) {
    const source = /^(?:ابحث|اريد|أريد|ابي|أبي|search|find|looking for)\s/iu.test(context.message.trim()) ? "SEARCH" as const : "CONVERSATION" as const;
    const interaction = { userId: context.actorId, eventId: context.currentMessageId, conversationId: context.conversationId, text: context.message, source };
    const control = await executePersonalMemoryTurn(interaction, memoryService);
    if (control) return control;
    interactionToProcess = interaction;
  }
  // routing-mode.ts: only the model is consulted (MODEL_FIRST's first read, HYBRID's second look).
  // A decision turn never goes to the model; an unavailable model yields no result.
  if (modelStage === "ONLY" && !options.noModel) {
    const decision = isDecisionUtterance(context.message) || (await hasOpenReview(context.conversationId, context.market.id, context.actorId));
    if (!decision) {
      const first = await modelFallback();
      if (first && !modelUnavailable(first)) return first;
    }
    return NO_MODEL_RESULT;
  }
  // «راجع الشروط المحدثة», «أوافق على الشروط المحدثة»: deterministic, before any commerce flow.
  const policy = await executePolicyTurn({ conversationId: context.conversationId, message: context.message, market: context.market, actorId: context.actorId });
  if (policy) {
    options.onToolSelected?.(policy.tool);
    return policy;
  }
  const contactRequest = await executeOrderContactRequest({
    conversationId: context.conversationId,
    message: context.message,
    market: context.market,
    actorId: context.actorId,
  });
  if (contactRequest) {
    options.onToolSelected?.(contactRequest.tool);
    return contactRequest;
  }
  // Payment Preferences & Agreement: how buyer and seller settle directly (no money through DINAR).
  const dealPayment = isMarketAvailable(context.market)
    ? await executeDealPaymentTurn({ conversationId: context.conversationId, message: context.message, market: context.market, actorId: context.actorId })
    : null;
  if (dealPayment) {
    options.onToolSelected?.(dealPayment.tool);
    return dealPayment;
  }
  // NEXT G2: buyer–seller messages through DINAR (reviews, sends, replies, status). Before the
  // order, listing-management and commerce adapters, so «عندي 60 قطعة» typed under an incoming
  // question becomes a reply review instead of a stock change. Deterministic, no AI allowance.
  const inquiry = !context.imageObjectPaths?.length && context.location === undefined && isMarketAvailable(context.market)
    ? await executeInquiryTurn({ conversationId: context.conversationId, message: context.message, market: context.market, actorId: context.actorId })
    : null;
  if (inquiry) {
    options.onToolSelected?.(inquiry.tool);
    return inquiry;
  }
  const isBack = backIntent(context.message);
  const surface = addToCart ? undefined : surfaceIntent(context.message);
  // Photos without other text intent continue an active draft (seller-confirmed values are kept)
  // or start one when none exists; only an explicit sale request restarts the draft.
  const effectiveSurface =
    hasListingPhotos && surface !== undefined && surface !== "SELL" ? "SELL" : surface;
  const orderResult =
    hasListingPhotos || context.location !== undefined
      ? undefined
      : await orderContext(
          context.conversationId,
          context.market.id,
          context.message,
          deliveryIntent(normalizeDeliveryText(context.message)) === "CHOOSE_COURIER" ? undefined : surface,
          context.actorId,
        );
  if (orderResult) {
    options.onToolSelected?.("openSurface");
    return { tool: "openSurface", version: 1, result: orderResult };
  }
  // Owner-checked order history and provider-independent tracking context take
  // precedence over the live-location provider gate. The order card can safely
  // explain that live coordinates are unavailable without hiding the order.
  if (routeDecision.kind === "PROVIDER_REQUIRED") {
    options.onToolSelected?.("openSurface");
    return clarify(
      "أستطيع عرض حالة الطلب، لكن مزوّد الموقع المباشر غير مهيّأ؛ لذلك لا يمكنني إظهار موقع المندوب على الخريطة.",
    );
  }
  // Existing participant-owned order history and tracking are not new commerce.
  // Resolve them through the canonical owner-checked order context before applying
  // the inactive-market gate; every other marketplace action remains behind it.
  if (!isMarketAvailable(context.market))
    return (await modelFallback()) ?? clarify();
  // An explicit ceiling increase while a search is in view is a search refinement,
  // not a counter-offer/quantity edit on one of the search rows.
  if (/^(?:طيب\s+)?(?:ارفعها|ارفعه|زيدها)\s+/u.test(normalizeSearch(context.message))) {
    const [last] = await db.select().from(aiResultSets).where(and(eq(aiResultSets.conversationId,context.conversationId),eq(aiResultSets.marketId,context.market.id))).orderBy(desc(aiResultSets.createdAt)).limit(1);
    if (last && !(last.query as {kind?:unknown}).kind) { const refined = await executeBuyerTurn(context); if (refined) return refined; }
  }
  // Best-price requests are explicit negotiation actions; do not let generic
  // commerce routing reinterpret them as a search or discussion.
  if (!addToCart && !hasListingPhotos && isBestPriceRequest(context.message)) {
    const bestPrice = await executeNegotiationTurn({
      conversationId: context.conversationId,
      message: context.message,
      market: context.market,
      actorId: context.actorId,
    });
    if (bestPrice) {
      options.onToolSelected?.(bestPrice.tool);
      return bestPrice;
    }
  }
  // Driver delivery and availability commands are explicit, consequential flows.
  // Resolve them before generic commerce, purchase, and discussion handlers can claim
  // a phrase such as «استلمت الطلب» as a buyer action or conversational follow-up.
  const driver = addToCart || hasListingPhotos || context.location !== undefined
    ? null
    : await executeDriverTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
  if (driver) {
    options.onToolSelected?.(driver.tool);
    return driver;
  }
  // G2 price negotiation must see explicit offer/counter/best-price requests before
  // generic commerce intent routing can reinterpret them as a search or promotion.
  const negotiation = addToCart || hasListingPhotos || context.location !== undefined
    ? null
    : await executeNegotiationTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
        ...(repair ? { repair } : {}),
      });
  if (negotiation) {
    options.onToolSelected?.(negotiation.tool);
    return negotiation;
  }
  // A correction nothing in context resolves gets one question; a draft in progress may still
  // take a corrected price («لا، العرض 15 مو 20»).
  // A corrected clause that names an offer, listing, order, price or position nothing in context
  // resolves gets one question, never a search. Any other correction («أقصد الأرخص») goes on
  // through the ordinary routing in the user's own words.
  if (repair && namesCommercialObject(context.message)) {
    // «لا، أقصد الثالث، ولا تضيفه للسلة»: a correction that names a position in the results in view
    // is resolved against them (read-only) before asking what the user means.
    const recent = await recentListingResultSets(context);
    const live = recent.find((set) => !set.expiresAt || set.expiresAt.getTime() > Date.now());
    const resolved = await resolveConversationReference(context, live, recent);
    if (resolved) {
      options.onToolSelected?.(resolved.tool);
      return resolved;
    }
    options.onToolSelected?.("openSurface");
    return clarify("ما الذي تقصده تحديدًا؟ اذكر العرض أو الإعلان أو رقمه من القائمة. لم أنفّذ شيئًا.");
  }
  if (repair) {
    repair = undefined;
    context = { ...context, message: original };
  }
  // Command C: the seller's own stock, orders, performance and improvement questions, and
  // marketing copy, come before commercial routing, which would read «كيف أعرض مميزات…» or
  // «اقترح كيف أحسن…» as a promotion tutorial. Copy is drafted by the model from the
  // seller's facts (seller-management.ts sellerListingFacts) and changes nothing.
  if (!addToCart && !hasListingPhotos && context.location === undefined && context.actorId) {
    // «كم باقي منه؟» right after a result is the stock of that listing; and a bare «كم باقي؟»
    // from someone who sells nothing is never a seller-inventory question.
    let sellerQuestion = isSellerBusinessQuestion(context.message);
    if (sellerQuestion && isBareRemainingQuestion(context.message)) {
      const stock = await executeStockQuestion({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
      if (stock) {
        options.onToolSelected?.(stock.tool);
        return stock;
      }
      sellerQuestion = (await modelRolesForActor(context.actorId, context.market.id)).includes("SELLER");
    }
    if (sellerQuestion) {
      const business = await executeSellerAdviceTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
      if (business) {
        options.onToolSelected?.(business.tool);
        return business;
      }
    }
    // An active draft writes its own description from confirmed facts (listing-draft.ts);
    // other copy (ads, versions, customer replies) is drafted by the guarded model.
    if (
      isMarketingRequest(context.message) &&
      !(DRAFT_DESCRIPTION_REQUEST.test(normalizeSearch(context.message)) && (await hasActiveListingDraft(context.conversationId)))
    ) {
      const copy = await modelFallback();
      if (copy) return copy;
    }
    const whySponsored = await explainSponsoredPlacement({
      conversationId: context.conversationId,
      message: context.message,
      market: context.market,
      actorId: context.actorId,
    });
    if (whySponsored) {
      options.onToolSelected?.(whySponsored.tool);
      return whySponsored;
    }
  }
  // Monetization V3: explicit commercial phrases (balance, top-up, featured/VIP/refresh,
  // bundles, «روح بع لي», campaign results, Market Pulse, DINAR Business), decisions on its
  // own pending review, and «ما عجبني شيء» after organic results. Deterministic, no model.
  const commerce = addToCart || hasListingPhotos || context.location !== undefined
    ? null
    : await executeCommerceTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
  // «بع لهذا الطلب» continues as the ordinary SELL flow with a suggested title.
  if (commerce?.redirectMessage) context = { ...context, message: commerce.redirectMessage };
  else if (commerce) {
    options.onToolSelected?.(commerce.tool);
    return commerce;
  }
  if (interactionToProcess) {
    // Optional background topic extraction: skipped when the user's AI allowance or the global
    // guard has no room (G1); the deterministic memory path above still runs.
    const memoryOwner = { kind: "USER" as const, userId: context.actorId!, market: context.market };
    const memoryModelAllowed = await hasAiAllowance(memoryOwner, "TEXT_REQUEST").catch(() => false) && await globalGuardOpen(context.market).catch(() => false);
    // The extraction call is a platform cost: money is held and every call recorded (ai-spend).
    const memoryModel = memoryModelAllowed ? await modelGatewayFor(undefined, { marketId: context.market.id, countryCode: context.market.countryCode, currencyCode: context.market.currencyCode }) : undefined;
    const memoryGateway = memoryModel
      ? await meteredPlatformGateway(memoryModel, { purpose: "PLATFORM_MEMORY_EXTRACTION", resource: "TEXT_REQUEST", policy: await aiUsagePolicyFor(context.market) })
      : { gateway: undefined, settle: async () => undefined };
    try {
      await memoryService.processInteraction(interactionToProcess, memoryGateway.gateway);
    } finally {
      await memoryGateway.settle();
    }
    const acknowledgement = memoryAcknowledgement(context.message);
    if (acknowledgement) return acknowledgement;
  }
  const cartTurn = await executeCartConversationTurn({
    conversationId: context.conversationId,
    message: context.message,
    market: context.market,
    actorId: context.actorId,
  });
  if (cartTurn) {
    options.onToolSelected?.(cartTurn.tool);
    return cartTurn;
  }
  // G2 discussion: consultation, advice on results or on a pending action, explanations,
  // interruptions and resumes. It claims only those and never changes anything.
  const smart = addToCart || hasListingPhotos || context.location !== undefined
    ? null
    : await executeSmartTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
  if (smart) {
    options.onToolSelected?.(smart.tool);
    return smart;
  }
  // Provider connections (G1): only explicit «اربط متجري / مفتاح الربط / أوقف الربط»
  // phrases and decisions on the actor's own provider review; deterministic, no model.
  const providerTurn = addToCart || hasListingPhotos || context.location !== undefined
    ? null
    : await executeProviderTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
  if (providerTurn) {
    options.onToolSelected?.(providerTurn.tool);
    return providerTurn;
  }
  // The buyer's own open purchase step (Block F3) answers quantity, fulfilment, back,
  // cancel and «ادفع» before delivery reads them as order-scoped phrases.
  const purchase = addToCart || hasListingPhotos || context.location !== undefined
    ? null
    : await executePurchaseTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
  if (purchase) {
    options.onToolSelected?.(purchase.tool);
    return purchase;
  }
  // Publishing and resuming listing drafts (Block F5): «انشره», «كمل الإعلان», the
  // draft choice, and decisions on the seller's own publish review.
  const draftAction = addToCart || hasListingPhotos || context.location !== undefined
    ? null
    : await executeDraftActionTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
  if (draftAction) {
    options.onToolSelected?.(draftAction.tool);
    return draftAction;
  }
  // Delivery claims explicit delivery/location phrases, decisions on its own latest
  // pending step, and structured location submissions; everything else passes on.
  const delivery = addToCart || hasListingPhotos
    ? null
    : await executeDeliveryTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
        location: context.location,
        locationRequestId: context.locationRequestId,
      });
  if (delivery) {
    options.onToolSelected?.(delivery.tool);
    return delivery;
  }
  // Jassim Ads (Phase 1, DINAR_JASSIM_ADS): marketing advice from the seller's own facts. Read-only;
  // buying a promotion stays in the promotion turn below.
  const adsAssistant = addToCart || hasListingPhotos
    ? null
    : await executeAdsAssistantTurn({ conversationId: context.conversationId, message: context.message, market: context.market, actorId: context.actorId });
  if (adsAssistant) {
    options.onToolSelected?.(adsAssistant.tool);
    return adsAssistant;
  }
  // Seller promotions claim explicit promotion phrases and follow-ups on their own
  // latest step. Employment above never reaches this path: payment never ranks people.
  const promotion = addToCart || hasListingPhotos
    ? null
    : await executePromotionTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
  if (promotion) {
    options.onToolSelected?.(promotion.tool);
    return promotion;
  }
  // Seller advice ("كم أحط سعر؟", "ليش إعلاني ما ينباع؟") reads facts and changes nothing.
  const advice = hasListingPhotos
    ? null
    : await executeSellerAdviceTurn({
        conversationId: context.conversationId,
        message: context.message,
        market: context.market,
        actorId: context.actorId,
      });
  if (advice) {
    options.onToolSelected?.(advice.tool);
    return advice;
  }
  if (
    effectiveSurface === "SELL" &&
    !hasListingPhotos &&
    OPEN_SELLER_QUESTION.test(context.message) &&
    !(await hasActiveListingDraft(context.conversationId))
  ) {
    const conversational = await modelFallback();
    if (conversational) return conversational;
  }
  const draftResult = isBack && !hasListingPhotos
    ? undefined
    : await listingDraft(
        context.conversationId,
        context.message,
        effectiveSurface,
        context.imageObjectPaths,
        options.photoSuggestionProvider,
        context.actorId,
      );
  if (draftResult) return { tool: "openSurface", version: 1, result: draftResult };
  const sellerManagement = await executeSellerListingManagementTurn({
    conversationId: context.conversationId,
    currentMessageId: context.currentMessageId,
    message: context.message,
    market: context.market,
    actorId: context.actorId,
  });
  if (sellerManagement) {
    options.onToolSelected?.(sellerManagement.tool);
    return sellerManagement;
  }
  // A price change nothing in context could take: one question, never a search or a guess.
  if (!hasListingPhotos && namesPrice(context.message)) {
    options.onToolSelected?.("openSurface");
    return clarify("أي سعر تقصد تعديله؟ افتح إعلانك أو المسودة أو العرض الذي تعنيه أولًا. لم يتغير شيء.");
  }
  if (surface)
    return executeRegisteredTool("openSurface", JSON.stringify({ surface }), {
      conversationId: context.conversationId,
      market: context.market,
    });
  const recentResultSets = await recentListingResultSets(context);
  const latest = recentResultSets.find(
    (set) => !set.expiresAt || set.expiresAt.getTime() > Date.now(),
  );
  let categoryRegistry: Awaited<ReturnType<typeof listMarketplaceCategories>> = [];
  let configuredCategories: ReturnType<typeof categorySchema>[] = [];
  let knownCities: string[] = [];
  let marketplaceContextLoaded = false;
  const loadMarketplaceContext = async () => {
    if (marketplaceContextLoaded) return;
    const [categories, cities] = await Promise.all([
      listMarketplaceCategories(),
      publishedListingCities(context.market.id),
    ]);
    categoryRegistry = categories;
    configuredCategories = categories.map(categorySchema);
    knownCities = cities;
    marketplaceContextLoaded = true;
  };
  const recentListingBlocks = addToCart
    ? await db
        .select({ payload: aiUiBlocks.payload })
        .from(aiUiBlocks)
        .innerJoin(messages, eq(aiUiBlocks.messageId, messages.id))
        .where(
          and(
            eq(aiUiBlocks.conversationId, context.conversationId),
            eq(aiUiBlocks.blockType, "LISTING_RESULTS"),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(4)
    : [];
  // «ورني تفاصيل الثاني» then «ضيف الثاني للسلة»: an ordinal is never resolved against a one-item
  // details view; it means the list the user was looking at just before (never older than that).
  const wantedIndex = Math.max(-1, ...findOrdinalMentions(context.message).map((reference) => (reference.kind === "LAST" ? -1 : reference.index)));
  const parsedBlocks = recentListingBlocks.map((block) => ListingBlockReference.safeParse(block.payload));
  const skipDetail = wantedIndex >= 1 && parsedBlocks[0]?.success && parsedBlocks[0].data.resourceIds.length === 1;
  const listingBlockReference = (skipDetail ? parsedBlocks.find((parsed) => parsed.success && parsed.data.resourceIds.length > wantedIndex) : undefined) ?? parsedBlocks[0] ?? ListingBlockReference.safeParse(undefined);

  if (addToCart) {
    const reference_ = listingBlockReference.success
      ? listingBlockReference.data
      : undefined;
    const actionSet = reference_
      ? recentResultSets.find((set) => set.id === reference_.resultSetId)
      : undefined;
    const actionResourceIds = reference_ && actionSet
      ? reference_.resourceIds.filter((id) => actionSet.resourceIds.includes(id))
      : [];
    const references = findOrdinalMentions(context.message);
    const positions = references.map((reference) =>
      reference.kind === "LAST"
        ? actionResourceIds.length - 1
        : reference.index,
    );
    const resourceIds = positions.length
      ? [
          ...new Set(
            positions
              .map((position) => actionResourceIds[position])
              .filter((id): id is string => Boolean(id)),
          ),
        ]
      : actionResourceIds.length === 1
        ? [actionResourceIds[0]!]
        : [];
    if (
      !actionSet ||
      (actionSet.expiresAt && actionSet.expiresAt.getTime() <= Date.now()) ||
      !resourceIds.length ||
      (positions.length > 0 && resourceIds.length !== positions.length)
    ) {
      return clarify("حدّد عرضًا أو أكثر بأرقام ظاهرة في آخر النتائج، أو أضف العرض الوحيد الظاهر.");
    }
    // «حط الكنب بالسلة»: when the request names the item, the listing it resolves to must be that
    // item. A stale or different card in view («مكيف») is never added in its place.
    const named = cartRequestItemWords(context.message);
    if (named.length) {
      const rows = await db.select({ id: offers.id, data: offers.data }).from(offers).where(inArray(offers.id, resourceIds));
      const mismatch = rows.find((row) => {
        const title = normalizeSearch(String((row.data as { title?: unknown }).title ?? ""));
        return !named.some((word) => textMatchesToken(title, word));
      });
      if (mismatch)
        return clarify(`العرض الظاهر الآن هو «${String((mismatch.data as { title?: unknown }).title ?? "")}»، وليس «${named.join(" ")}». ابحث عن «${named.join(" ")}» أولًا أو اختر من النتائج. لم يُضف شيء إلى السلة.`);
    }
    const stated = statedCartQuantity(context.message);
    if (stated === "INVALID") return clarify("الكمية يجب أن تكون عددًا صحيحًا من 1 فأكثر. لم يُضف شيء إلى السلة.");
    if (stated !== undefined && resourceIds.length > 1)
      return clarify(`ذكرت الكمية ${stated} لأكثر من عرض. حدّد عرضًا واحدًا، مثل «حط ${stated} من الأول». لم يُضف شيء.`);
    try {
      const added = await addMarketplaceCartItems({
        userId: context.actorId!,
        expectedMarketId: context.market.id,
        items: resourceIds.map((listingId) => ({ listingId, quantity: stated ?? 1 })),
      });
      return {
        tool: "openSurface",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "CART",
          query: {},
          listings: [],
          resourceIds: added.items.map((item: { listingId: string }) => item.listingId),
          prompt: stated !== undefined
            ? `أُضيف العرض إلى سلتك بكمية ${stated} بعد التحقق من التوفر. راجع السلة قبل إكمال الطلب؛ لم يُدفع أي شيء.`
            : `أُضيفت ${resourceIds.length} عروض إلى سلتك في عملية واحدة بعد التحقق من التوفر. راجع السلة قبل إكمال الطلب؛ لم يُدفع أي شيء.`,
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "تعذر إضافة العروض المحددة.";
      return {
        tool: "openSurface",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "CART",
          query: {},
          listings: [],
          prompt: `${message}. لم تُضف أي عناصر.`,
        },
      };
    }
  }
  // Internal recommendations: one generic recommender over the current listing or
  // results, persisted as an ordinary result set so ordinals and back keep working.
  const recommendation = recommendationIntent(context.message);
  if (recommendation) {
    const anchor = await recommendationContext(context.conversationId, context.market.id);
    options.onToolSelected?.("recommendListings");
    return executeRegisteredTool(
      "recommendListings",
      JSON.stringify({
        ...anchor,
        ...(recommendation.cheaper ? { cheaper: true } : {}),
        ...(recommendation.nearby ? { nearby: true } : {}),
      }),
      { conversationId: context.conversationId, market: context.market },
    );
  }
  // References only the conversation resolves (focus, superlatives, corrections, earlier topics).
  const contextual = await resolveConversationReference(context, latest, recentResultSets);
  if (contextual) {
    options.onToolSelected?.(contextual.tool);
    return contextual;
  }
  // Buyer refinements, ranking, comparison and selection on the current list (Block F2).
  const buyer = await executeBuyerTurn({
    conversationId: context.conversationId,
    message: context.message,
    market: context.market,
    actorId: context.actorId,
  });
  if (buyer) {
    options.onToolSelected?.(buyer.tool === "buyerSearch" || buyer.tool === "buyerRefine" || buyer.tool === "buyerRank" ? "searchListings" : buyer.tool);
    return buyer;
  }
  // «كم المتبقي؟» about the listing in view: the inventory record answers, never the model.
  // Asking is read-only, so it runs after the buyer's own selections and before fact flows.
  const stock =
    !context.imageObjectPaths?.length && context.location === undefined && isMarketAvailable(context.market)
      ? await executeStockQuestion({
          conversationId: context.conversationId,
          message: context.message,
          market: context.market,
          actorId: context.actorId,
        })
      : null;
  if (stock) {
    options.onToolSelected?.(stock.tool);
    return stock;
  }
  // «هذا الأول كم ماشي؟» asks about a fact the listing itself records; when the seller recorded
  // nothing, the answer says so and offers the ordinary inquiry review. Never the model.
  const listingFact =
    !context.imageObjectPaths?.length && context.location === undefined && isMarketAvailable(context.market)
      ? await executeListingFactQuestion({
          conversationId: context.conversationId,
          message: context.message,
          market: context.market,
          actorId: context.actorId,
        })
      : null;
  if (listingFact) {
    options.onToolSelected?.(listingFact.tool);
    return listingFact;
  }
  const storedSearch = StoredSearchQuery.safeParse(latest?.query ?? {});
  const previousStructured = latest && storedSearch.success
    ? {
        search: storedSearch.data.search ?? "",
        ...(storedSearch.data.categoryId
          ? { categoryId: storedSearch.data.categoryId }
          : {}),
        filters: storedSearch.data.filters ?? [],
        ...(storedSearch.data.sort ? { sort: storedSearch.data.sort } : {}),
      }
    : undefined;
  const interpretationContext = {
    previous: previousStructured,
    currentResultCount: latest?.resourceIds.length,
  };
  let interpretation = interpretMarketplaceTurn(context.message, {
    ...interpretationContext,
    categories: [],
    knownCities: [],
  });
  if (needsMarketplaceCategoryContext(context.message, interpretation.intent, previousStructured)) {
    await loadMarketplaceContext();
    interpretation = interpretMarketplaceTurn(context.message, {
      ...interpretationContext,
      categories: configuredCategories,
      knownCities,
    });
  }
  const toolContext = { conversationId: context.conversationId, market: context.market };
  // Refining recommendations ("أرخص", "في عمان") re-runs the same recommender with the
  // same listing and the new supported filters; it never becomes an unrelated search.
  const storedRecommendation = StoredRecommendation.safeParse(latest?.query.recommendation);
  if (
    storedRecommendation.success &&
    (interpretation.intent === "SORT_RESULTS" || interpretation.intent === "REFINE_SEARCH")
  ) {
    const refinedQuery = interpretation.query!;
    const stored = storedRecommendation.data;
    options.onToolSelected?.("recommendListings");
    return executeRegisteredTool(
      "recommendListings",
      JSON.stringify({
        ...(stored.anchorId ? { anchorId: stored.anchorId } : {}),
        excludeIds: stored.excludeIds.slice(0, 24),
        ...(refinedQuery.categoryId ? { categoryId: refinedQuery.categoryId } : {}),
        filters: refinedQuery.filters,
        ...(refinedQuery.sort ? { sort: refinedQuery.sort } : {}),
        ...(stored.cheaper || (stored.anchorId && refinedQuery.sort === "PRICE_ASC") ? { cheaper: true } : {}),
        ...(stored.nearby ? { nearby: true } : {}),
      }),
      toolContext,
    );
  }
  switch (interpretation.intent) {
    case "OPEN_RESULT":
      options.onToolSelected?.("getResource");
      // The index is resolved only against the persisted result set; never a model or client ID.
      return executeRegisteredTool(
        "getResource",
        JSON.stringify({
          resultSetId: latest!.id,
          resourceId: latest!.resourceIds[interpretation.selectedIndex!],
        }),
        toolContext,
      );
    case "BACK_TO_RESULTS":
      options.onToolSelected?.("restoreResults");
      return executeRegisteredTool(
        "restoreResults",
        JSON.stringify({ resultSetId: latest!.id }),
        toolContext,
      );
    case "CLARIFY": {
      // The model decides whether an ambiguous ordinary utterance is conversation or a tool request.
      const interpreted = await modelFallback();
      if (interpreted) return interpreted;
      return clarify(
        clarificationPrompt(interpretation.ambiguities, latest?.resourceIds.length),
      );
    }
    case "SEARCH":
      if (!hasExplicitMarketplaceSearchIntent(context.message)) {
        const interpreted = await modelFallback();
        if (interpreted) return interpreted;
        return clarify();
      }
      // Only an explicit search command reaches the deterministic marketplace search here.
      options.onToolSelected?.("searchListings");
      return executeRegisteredTool(
        "searchListings",
        JSON.stringify({
          query: interpretation.query!.search,
          ...(interpretation.query!.categoryId ? { categoryId: interpretation.query!.categoryId } : {}),
          filters: interpretation.query!.filters,
          ...(interpretation.query!.sort ? { sort: interpretation.query!.sort } : {}),
        }),
        toolContext,
      );
    case "REFINE_SEARCH":
    case "SORT_RESULTS": {
      const structured = interpretation.query!;
      options.onToolSelected?.("searchListings");
      return executeRegisteredTool(
        "searchListings",
        JSON.stringify({
          query: structured.search,
          ...(structured.categoryId ? { categoryId: structured.categoryId } : {}),
          filters: structured.filters,
          ...(structured.sort ? { sort: structured.sort } : {}),
        }),
        toolContext,
      );
    }
    case "UNKNOWN":
      break;
  }
  // Never turn an unclaimed ordinary message into a marketplace search by default.
  // The model may answer it or explicitly suggest the canonical search path.
  // When no model can read it, a short product phrase («مزهرية») that matches real listings
  // gets the read-only search an explicit command would; anything else keeps the honest
  // "assistant unavailable" reply. Questions and general requests are never searched.
  let modelDown: TurnExecution | undefined;
  if (!hasExplicitMarketplaceSearchIntent(context.message)) {
    const interpreted = await modelFallback();
    if (!interpreted) return clarify();
    if (!modelUnavailable(interpreted) || !isBareProductPhrase(context.message)) return interpreted;
    modelDown = interpreted;
  }
  if (modelDown) await loadMarketplaceContext();
  const previousQuery =
    typeof latest?.query.search === "string" ? latest.query.search : "";
  const previousCategoryId =
    typeof latest?.query.categoryId === "string"
      ? latest.query.categoryId
      : undefined;
  const previousCategory = previousCategoryId
    ? categoryRegistry.find((category) => category.id === previousCategoryId)
    : undefined;
  const mentionedCategory = categoryMention(context.message, categoryRegistry);
  const refined = contextualQuery(context.message, previousQuery);
  if (
    !refined ||
    /^(شيء|خدمة|شراء|اشتري|ابحث|اريد)$/.test(normalizeSearch(refined))
  )
    return modelDown ?? clarify();
  if (modelDown && !(await searchMarketplaceListings(context.market, { search: refined, conversational: true, limit: 1 })).length)
    return modelDown;
  const category = mentionedCategory ?? previousCategory;
  options.onToolSelected?.("searchListings");
  const search = (scope: typeof category | undefined) =>
    executeRegisteredTool(
      "searchListings",
      JSON.stringify({
        query: refined,
        ...(scope ? { category: scope.label, categoryId: scope.id } : {}),
        ...(scope && !mentionedCategory && Array.isArray(latest?.query.filters)
          ? { filters: latest.query.filters }
          : {}),
        ...(scope && !mentionedCategory && typeof latest?.query.sort === "string"
          ? { sort: latest.query.sort }
          : {}),
      }),
      toolContext,
    );
  const scoped = await search(category);
  // New product words («شاورما» after a phone search) are not a refinement of the last
  // search: when its inherited category finds nothing, they search the whole market.
  const freshWords = refined === normalizeSearch(searchTerms(context.message));
  if (category && !mentionedCategory && freshWords && scoped.result.listings.length === 0)
    return search(undefined);
  return scoped;
}


const CART_REQUEST_WORDS = new Set([
  "حط", "حطه", "حطها", "حطهم", "حطلي", "ضيف", "ضيفه", "ضيفها", "ضيفهم", "ضيفلي", "اضف", "اضفه", "اضيف", "اضيفه", "ضع", "ضعه", "دخل", "دخله",
  "بالسله", "للسله", "السله", "سلتي", "بالعربه", "العربه", "في", "على", "ع", "الى", "الي", "ل", "من", "منه", "منها", "منهم", "لي", "كمان", "ايضا", "بس",
  "هذا", "هذه", "هذي", "هاد", "هاي", "اياه", "اياها", "رقم", "الاعلان", "العرض", "المنتج", "اللي", "الي", "ظاهر", "الظاهر", "و", "يا", "دينار",
  "الاول", "الثاني", "الثالث", "الرابع", "الخامس", "الاخير", "اول", "ثاني", "ثالث", "قطعه", "قطع", "حبه", "حبات", "حبتين", "قطعتين", "واحد", "واحده",
  "اثنين", "ثلاث", "ثلاثه", "اربع", "خمس", "لو", "سمحت", "من فضلك", "طيب", "تمام", "خلاص", "اوكي",
]);

/** The item words a cart request names («حط الكنب بالسلة» → ["الكنب"]); empty when it names none. */
export function cartRequestItemWords(message: string): string[] {
  const words = normalizeSearch(message.replace(/ة/g, "ه").replace(/[؟?!،,.«»"0-9٠-٩-]+/g, " ")).split(/\s+/).filter(Boolean);
  const left = words.filter((word) => !CART_REQUEST_WORDS.has(word) && !CART_REQUEST_WORDS.has(word.replace(/^و/u, "")) && word.length >= 2);
  return left.length ? itemTokens(left) : [];
}
