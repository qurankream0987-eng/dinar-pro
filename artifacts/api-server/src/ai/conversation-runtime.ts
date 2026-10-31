import {
  hasActiveListingDraft,
  hasPendingListingPhotoSuggestions,
  isListingPhotoSuggestionCommand,
  isGeneralRequest,
  isListingPhotoTitleCorrection,
  listingDraft,
} from "./listing-draft";
import { orderContext } from "./order-context";
import { contextualQuery, hasCategoryAlias } from "./search-context";
import { addToCartIntent, backIntent, searchTerms, stripCorrectionPrefix, surfaceIntent } from "./intent";
import {
  findOrdinalMention,
  findOrdinalMentions,
  foldArabicLetters,
  parseResultReference,
} from "./arabic-normalization";
import {
  clarificationPrompt,
  hasExplicitMarketplaceSearchIntent,
  interpretMarketplaceTurn,
  needsMarketplaceCategoryContext,
} from "./marketplace-intent";
import { SearchFilterInput, SearchSortInput } from "./search-state";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { aiResultSets, aiUiBlocks, db, messages } from "@workspace/db";
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
import {
  executeSellerAdviceTurn,
  executeSellerListingManagementTurn,
  isMarketingRequest,
  isSellerBusinessQuestion,
} from "./seller-management";
import { executeEmploymentTurn, isEmploymentQuery } from "./employment-turn";
import { executeDeliveryTurn, isDeliveryQuery } from "./delivery-turn";
import { executePromotionTurn, explainSponsoredPlacement, isPromotionQuery } from "./promotion-turn";
import { executeBuyerTurn, executePurchaseTurn, executeOrderContactRequest, reviewQuantity } from "./buyer-turn";
import { executeListingFactQuestion } from "./listing-fact-question";
import { executeStockQuestion } from "./stock-question";
import { isAiUsageQuestion } from "./usage-intent";
import { executeDriverTurn, isDriverOnboardingIntent, isDriverQuery } from "./driver-turn";
import { executeDraftActionTurn } from "./draft-actions";
import { executeProviderTurn, isExplicitProviderManagementIntent } from "./provider-turn";
import { SMART_STATE_KINDS, executeModelFallback, executeSmartTurn } from "./smart-turn";
import { executeCommerceTurn } from "./commerce-turn";
import { executeInquiryTurn } from "./inquiry-turn";
import { executePolicyTurn } from "./policy-turn";
import { aiRoutingMode, isDecisionUtterance } from "./routing-mode";
import { executeProductControlTurn } from "./product-control-turn";
import { aiUsagePolicyFor, globalGuardOpen, hasAiAllowance } from "../lib/ai-usage";
import { meteredPlatformGateway } from "../lib/ai-spend";
import { executeNegotiationTurn, isBestPriceRequest } from "./negotiation-turn";
import { recommendationIntent } from "./intent";
import { storedSponsoredIds } from "../lib/recommendations";
import type { ListingPhotoSuggestionProvider } from "./listing-photo-intelligence";
import { personalContext } from "./personal-context-service";
import { executePersonalMemoryTurn, memoryAcknowledgement } from "./personal-memory-turn";
import { modelGatewayFor } from "./model-turn";
import { resolveConversationRoute } from "./conversation-router";
import { isDraftResumeRequest } from "./draft-actions";
import {
  buildTaskPlan,
  cancelPending,
  completeStep,
  isPlanCancellation,
  isPlanContinuation,
  latestTaskPlan,
  nextPendingStep,
  splitCompoundRequest,
  type TaskPlan,
  type TaskStep,
} from "./task-plan";
import {
  resolveConversationActionId,
  type ConversationActionId,
  type ConversationRouteDecision,
} from "@workspace/api-zod/conversation-runtime";
import { correction, namesCommercialObject, namesPrice } from "./context-intent";

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
    .trim();
  const remove = /^(?:شيل(?:ه|ها)?|احذف(?:ه|ها)?|ازل|ازيل)(?:\s|$)/u.test(text);
  const quantityChange = text.match(
    /^(?:غير|عدل|اجعل|خله|خليها|اضبط|ضبط)\s+(?:(?:ال)?كميه\s+)?(?:(?:العنصر|المنتج)\s+)?(.+?)\s+(?:الي|ل)\s*(.+)$/u,
  );
  const continueCheckout =
    /^(?:كمل|اكمل|كمل\s+(?:ال)?(?:شراء|الدفع)|اكمل\s+(?:ال)?(?:شراء|الدفع))$/u.test(text);
  if ((!remove && !quantityChange && !continueCheckout) || !input.actorId) return null;

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
  if (!latestAssistant) return null;
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
  if (
    (latestSurface?.payload as { surface?: unknown } | undefined)?.surface !==
    "CART"
  )
    return null;

  const cart = (await getMarketplaceCart(input.actorId, input.market)) as Array<{
    listingId: string;
    title: string;
    quantity: number;
  }>;
  if (remove || quantityChange) {
    const reference = findOrdinalMention(input.message);
    const index =
      reference?.kind === "LAST"
        ? cart.length - 1
        : reference?.kind === "INDEX"
          ? reference.index
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
async function executeTaskPlanTurn(context: TurnContext, options: TurnOptions): Promise<TurnExecution | undefined> {
  const actorId = context.actorId!;
  const runStep = async (plan: TaskPlan, step: TaskStep): Promise<TurnExecution> => {
    const executed = await executeAiConversationTurn(
      { ...context, message: step.text },
      { ...options, planStep: true },
    );
    const result = executed.result as { kind: string; surface?: string };
    return {
      ...executed,
      taskPlan: completeStep(plan, step.index, { tool: executed.tool, surface: result.surface ?? result.kind }),
    };
  };
  if (isPlanCancellation(context.message)) {
    const live = await latestTaskPlan(context.conversationId, actorId);
    if (!live || !nextPendingStep(live.plan)) return undefined;
    return { ...planNotice("ألغيت باقي خطوات طلبك المركّب؛ لم يُنفّذ منها شيء."), taskPlan: cancelPending(live.plan) };
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
  const split = splitCompoundRequest(context.message);
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
    imageObjectPaths?: string[];
    reasoningEffort?: "low" | "medium" | "high";
    /** Explicit one-time location submission against a delivery request (Block D). */
    location?: unknown;
    locationRequestId?: string;
  },
  options: {
    modelGateway?: ConversationModelGateway;
    onToolSelected?: (name: string) => void;
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
  return executeWithRoutingMode(context, options);
}

type RuntimeContext = Parameters<typeof executeAiConversationTurn>[0];
type RuntimeOptions = NonNullable<Parameters<typeof executeAiConversationTurn>[1]>;
type RuntimeTurn = Awaited<ReturnType<typeof executeAiConversationTurn>>;

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

/**
 * The routing modes of routing-mode.ts around the one runtime. Re-entries (plan steps, model
 * canonical requests) and image/location turns always run the runtime as it is.
 */
async function executeWithRoutingMode(context: RuntimeContext, options: RuntimeOptions): Promise<RuntimeTurn> {
  const mode = aiRoutingMode();
  const plain = mode === "LEGACY" || options.noModel || options.planStep || options.modelStage || !context.actorId || context.imageObjectPaths?.length || context.location !== undefined;
  if (plain) return executeRuntime(context, options);
  if (mode === "MODEL_FIRST") {
    // The model reads first. A canonical request it restated re-entered DINAR and wins; otherwise
    // DINAR's own path runs (model disabled: no second paid call), and the model's answer is kept
    // only when DINAR had nothing. A capability DINAR handles is never lost to model text.
    const first = await executeRuntime(context, { ...options, modelStage: "ONLY" });
    if (first !== NO_MODEL_RESULT && !isModelAnswer(first)) return first;
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
  let repair: { back?: boolean } | undefined;
  const original = context.message;
  if (context.actorId && !context.imageObjectPaths?.length && context.location === undefined) {
    const rewritten = await resultReferenceCorrection(context.conversationId, context.message);
    if (rewritten) context = { ...context, message: rewritten };
    // A draft in progress owns corrections of its own fields («لا قصدي بدون سعر»).
    else if (!(await hasActiveListingDraft(context.conversationId))) {
      const corrected = correction(context.message);
      if (corrected?.meant) {
        repair = { ...(corrected.back ? { back: true } : {}) };
        context = { ...context, message: corrected.meant };
      }
    }
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
  const modelFallback = async () => {
    if (options.noModel) return null;
    const turn = await executeModelFallback(
      { conversationId: context.conversationId, message: context.message, market: context.market, actorId: context.actorId, requestKey: `turn:${context.currentMessageId}`, reasoningEffort: context.reasoningEffort },
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
    if (turn) options.onToolSelected?.(turn.tool);
    return turn;
  };
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
          surface,
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
    if (isSellerBusinessQuestion(context.message)) {
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
  const recentResultSets = await db
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
  const [latestListingBlock] = addToCart
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
        .limit(1)
    : [];
  const listingBlockReference = ListingBlockReference.safeParse(
    latestListingBlock?.payload,
  );

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
    try {
      const added = await addMarketplaceCartItems({
        userId: context.actorId!,
        expectedMarketId: context.market.id,
        items: resourceIds.map((listingId) => ({ listingId, quantity: 1 })),
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
          prompt: `أُضيفت ${resourceIds.length} عروض إلى سلتك في عملية واحدة بعد التحقق من التوفر. راجع السلة قبل إكمال الطلب؛ لم يُدفع أي شيء.`,
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
