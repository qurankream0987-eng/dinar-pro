/**
 * DINAR NEXT G2 inside the conversation: «اسأل البائع هل عنده 50 قطعة», «ماذا رد البائع؟»,
 * «اسأل المشتري كم قطعة يريد», «وضح للمشتري أن التجهيز يحتاج يومين», a reply typed under an
 * incoming message, and «رسائلي». An intent adapter over the inquiry authority
 * (lib/inquiries.ts) and the F0 action foundation: every outgoing message is a review that only
 * its author's confirmation sends. No model is needed, so it keeps working when the AI
 * allowance is exhausted. Replies are shown verbatim with their author; nothing is invented.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, aiUiBlocks, db, marketplaceInquiries, messages, offers } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import {
  containsPriceOffer,
  inquiryBodyProblem,
  inquiryForParty,
  inquiryPreconditions,
  inquiryView,
  listInquiries,
  markInquiryRead,
  closeInquiry,
  PROVENANCE_LABELS,
  ROLE_LABELS,
  parseTargetKey,
  sellerRelationships,
  targetKey,
  type InquiryProvenance,
  type InquiryTarget,
} from "../lib/inquiries";
import {
  confirmPendingAction,
  createPendingAction,
  type ActionReview,
  type DelegatedActionAuthority,
} from "./action-foundation";
import {
  requireSellerEmployeeCapability,
  type SellerEmployeeSessionContext,
} from "../lib/business-delegations";
import { focusedListing, isBestPriceRequest } from "./negotiation-turn";
import { latestListingSet } from "./buyer-turn";
import { searchMarketplaceListings } from "../lib/marketplace-listings";
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import { isGeneralRequest } from "./listing-draft";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };
type Input = {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
  employeeSession?: SellerEmployeeSessionContext;
  employeeReply?: string;
};

export const INQUIRY_SURFACES = CONVERSATION_SURFACE_FAMILIES.inquiry;
const ACTION = "SEND_INQUIRY_MESSAGE";

export function normalizeInquiryText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;.()«»"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Phrases (normalized: أ→ا, ة→ه, digits ASCII) ───────────────────────────
const LEAD = String.raw`^(?:(?:يا\s+)?دينار\s+)?(?:(?:لو\s+سمحت|من\s+فضلك|ممكن|طيب|تكفي)\s+)?`;
const ASK_VERB = String.raw`(?:اسال|اساله|اسالها|سال|سله|استفسر\s+من|استفسر\s+عند|اسالي)`;
const SELLER_NOUN = String.raw`(?:ال)?(?:بائع|بايع|بياع|تاجر|صاحب\s+(?:ال)?(?:اعلان|عرض|محل|منتج|بضاعه|سلعه))`;
const BUYER_NOUN = String.raw`(?:ال)?(?:مشتري|زبون|عميل)`;
const TELL_VERB = String.raw`(?:وضح|وضحي|بلغ|ابلغ|خبر|اخبر|قل|قول|قولي|ارسل|اكتب)`;
/**
 * «اسأل صاحب الأرخص عن البطارية», «اسأل بائع الأغلى إذا …»: the seller is chosen by the listings'
 * recorded live prices among the results in view (§09), never by the model or a guess.
 */
const ASK_BY_PRICE = new RegExp(String.raw`${LEAD}${ASK_VERB}\s+(?:لي\s+)?(?:ال)?(?:بائع|بايع|بياع|تاجر|صاحب)\s+(?:ال)?(ارخص|اغلي)(?:\s+(?:واحد|فيهم|منهم|عرض))?\s*(?:عن|اذا|إذا|ان|لو)?\s*(.*)$`, "u");
/** «لكن لا ترسل السؤال حتى أوافق»: every draft already waits for «أرسل»; the clause is not for the seller. */
const HOLD_CLAUSE = /[\s،,]*(?:لكن|بس|و)?\s*(?:لا|ما)\s+(?:ترسل|ترسله|ترسلها|تبعث|تبعثه)(?:\s+[^\s]+){0,3}?\s+(?:حتى|حتي|لين|الين|قبل\s+ما|الا\s+بعد\s+ما|إلا\s+بعد\s+ما)\s+[^\s]+[\s.!؟?]*$/u;
const ASK_SELLER = new RegExp(String.raw`${LEAD}${ASK_VERB}\s+(?:لي\s+)?${SELLER_NOUN}\s*(?:اذا|إذا|عن|عما|ان|لو)?\s*(.*)$`, "u");
const ASK_BUYER = new RegExp(String.raw`${LEAD}${ASK_VERB}\s+${BUYER_NOUN}\s*(?:اذا|عن|عما|ان|لو)?\s*(.*)$`, "u");
const TELL_BUYER = new RegExp(String.raw`${LEAD}${TELL_VERB}\s+(?:لل|ل)?${BUYER_NOUN.replace("(?:ال)?", "")}\s*(?:ان|بان|انه|انها)?\s*(.+)$`, "u");
const TELL_SELLER = new RegExp(String.raw`${LEAD}${TELL_VERB}\s+(?:لل|ل)?${SELLER_NOUN.replace("(?:ال)?", "")}\s*(?:ان|بان|انه|انها)?\s*(.+)$`, "u");
// «اسأله …» / «رد عليه: …» / «أرسل له هذا السؤال: …» — the counterpart of the thread in view.
const ASK_HIM = new RegExp(String.raw`${LEAD}(?:اساله|اسالها|اسال(?:ه|ها)?\s+(?:هو|هي))\s*(?:اذا|عن|ان|لو)?\s*(.+)$`, "u");
const REPLY_EXPLICIT = new RegExp(String.raw`${LEAD}(?:رد|ردي|جاوب|اجب)\s+(?:عليه|عليها|علي\s+(?:${SELLER_NOUN}|${BUYER_NOUN}))\s*(?:ب|بان|ان)?\s*:?\s*(.+)$`, "u");
const SEND_THIS = new RegExp(String.raw`${LEAD}(?:ارسل|ابعث)\s+(?:له|لها|للبائع|للمشتري)\s+(?:هذا|هذه|ها)\s*(?:ال)?(?:سؤال|رساله|كلام)\s*:?\s*(.*)$`, "u");
const STATUS = /(?:^|\s)(?:ماذا|وش|شو|ايش|ما\s+ذا|ماذ|ما)\s+(?:رد|قال|جاوب|كتب|ردت|قالت)\s*(?:عليه|علي)?\s*(?:ال)?(?:بائع|بايع|مشتري|زبون|تاجر)?|(?:هل|ها)\s+(?:رد|جاوب|ردت)\s+(?:ال)?(?:بائع|بايع|مشتري|زبون)|(?:^|\s)رد\s+(?:ال)?(?:بائع|بايع|مشتري)\s*$|وصل\s+رد/u;
const LIST = /(?:^|\s)(?:استفساراتي|رسائلي|رسايلي|رسائل\s+(?:ال)?(?:بيع|مشترين|زبائن|بائعين)|استفسارات\s+(?:ال)?(?:مشترين|زبائن|بائعين)|اسئله\s+(?:ال)?(?:مشترين|زبائن))(?:\s|$)|هل\s+(?:عندي|وصلني|وصلتني|في|فيه)\s+(?:اي\s+)?(?:استفسار|استفسارات|رساله|رسائل|سؤال|اسئله)/u;
const CLOSE = /(?:^|\s)(?:اغلق|سكر|انهي|انه)\s+(?:هذا\s+)?(?:ال)?(?:استفسار|محادثه\s+مع\s+(?:ال)?(?:بائع|مشتري))/u;
const BLOCK = /(?:^|\s)(?:احظر|امنع|اوقف\s+رسائل|اوقف\s+مراسله)\s+(?:هذا\s+)?(?:ال)?(?:مشتري|بائع|زبون)/u;
const CONFIRM = /^(?:نعم|اي|ايوه|اكيد|ارسل|ارسله|ارسلها|ارسل\s+الرساله|ارسل\s+الرد|ارسل\s+السؤال|نعم\s+ارسل|تمام|موافق|اوكي|ok|yes)$/u;
const CANCEL = /^(?:لا|كلا|الغ|الغي|الغاء|لا\s+ترسل|تراجع|لا\s+شكرا)$/u;
const EDIT = /^(?:عدل(?:ها|ه)?|غير(?:ها|ه)?|خلها|اجعلها)\s*(?:الي|إلى|ل)?\s*:?\s*(.+)$/u;
/**
 * «زيد عليه سؤال إذا عليها حوادث», «واسأله كمان عن البطارية», «لا، اسأله عن الفاتورة أيضًا»:
 * adds a question to the open draft instead of replacing it (W04). Still a draft: nothing is sent.
 */
const APPEND = /^(?:(?:لا|و|طيب|كمان)\s+)*(?:(?:زيد|زود|اضف|ضيف|حط)\s+(?:عليه|عليها|عليهم|لها|له|فيها|فيه)?\s*(?:سؤال|سوال)?|(?:و)?(?:اساله|اسالها|اسال)\s+(?:كمان|ايضا|بعد))\s*(?:عن|اذا|ان|لو)?\s*(.+?)\s*$|^(?:(?:لا|و|طيب)\s+)*(?:و)?(?:اساله|اسالها)\s+(?:عن|اذا|ان|لو)?\s*(.+?)\s+(?:كمان|ايضا|بعد)$/u;
const CONFIRM_WANTED = /(?:للتاكيد|يتاكد|يؤكد|يأكد|تاكيد\s+منه|تاكيد\s+من\s+(?:ال)?بائع|علي\s+اي\s+حال|مع\s+ذلك|حتي\s+لو)/u;
const QUANTITY = /(?<!\d)(\d{1,6})(?!\d)\s*(?:قطعه|قطع|حبه|حبات|حبة|وحده|وحدات|كرتون|كراتين|صندوق|علبه|علب|كيس|اكياس|كيلو|متر|pcs|pieces|units)?/u;
// A request addressed to DINAR itself («اشرح لي…»), never a reply to the other party.
const DINAR_DIRECTED = /^(?:(?:يا\s+)?دينار\s+)?(?:اشرح|علمني|ترجم|لخص|خطط|احسب|قارن|اقترح|حلل|اكتب\s+لي|ساعدني)(?:\s|$)/u;
// Words that mean the message is another request to DINAR, not a reply under an incoming card.
const COMMAND_LIKE = /^(?:اعرض|ابحث|دور|وريني|افتح|اظهر|ارني|اريد|ابي|ابغي|كم\s+(?:نسبه|باقي\s+من\s+حصتي)|طلباتي|اعلاناتي|مخزوني|سلتي|رصيدي|اشحن|روج|انشر)(?:\s|$)/u;

// ─── Rendering ───────────────────────────────────────────────────────────────

function surfaceTurn(surface: (typeof INQUIRY_SURFACES)[number], inquiry: Record<string, unknown>, prompt: string, options: { resultSetId?: string; query?: Record<string, unknown>; listingId?: string } = {}): Turn {
  const listingId = options.listingId ?? (inquiry.listing as { id?: unknown } | undefined)?.id;
  return {
    tool: "inquiry",
    version: 1,
    result: {
      kind: "SURFACE",
      surface,
      resultSetId: options.resultSetId ?? randomUUID(),
      resourceIds: typeof inquiry.inquiryId === "string" ? [inquiry.inquiryId] : [],
      // The listing stays in focus for «اسأله للتأكيد …» and negotiation follow-ups.
      ...(typeof listingId === "string" ? { resourceId: listingId } : {}),
      query: options.query ?? {},
      listings: [],
      inquiry,
      prompt,
    },
  };
}

function notice(prompt: string, extra: Record<string, unknown> = {}, listingId?: string): Turn {
  return surfaceTurn("INQUIRY_NOTICE", { view: "NOTICE", notice: prompt, ...extra }, prompt, listingId ? { listingId } : {});
}

async function stateTurn(actorId: string, market: Market, view: "STATUS" | "LIST", inquiryId: string | undefined, prompt: string): Promise<Turn> {
  const query = { kind: "INQUIRY", ownerId: actorId, view, ...(inquiryId ? { inquiryId } : {}) };
  const payload = await composeInquiryPayload({ view, ...(inquiryId ? { inquiryId } : {}) }, actorId, market);
  return surfaceTurn(view === "LIST" ? "INQUIRY_LIST" : "INQUIRY_STATUS", payload, prompt, { query });
}

export function reviewTurn(review: ActionReview, body: string, provenance: InquiryProvenance, prompt: string, extra: Record<string, unknown> = {}): Turn {
  const listingId = review.targetResource.startsWith("listing:") ? review.targetResource.slice(8) : undefined;
  return surfaceTurn(
    "INQUIRY_DRAFT",
    { view: "DRAFT", actionId: review.actionId, body, provenance, provenanceLabel: PROVENANCE_LABELS[provenance], lines: review.lines, status: "PENDING", expiresAt: review.expiresAt, ...extra },
    prompt,
    // The review card carries the action id so it never expires its own pending action.
    { resultSetId: review.actionId, ...(listingId ? { listingId } : {}) },
  );
}

// ─── State ───────────────────────────────────────────────────────────────────

async function recentSets(conversationId: string, marketId: string) {
  return db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(12);
}

type Pending = { kind?: unknown; ownerId?: unknown; status?: unknown; action?: unknown; targetResource?: unknown; structuredInput?: Record<string, { value?: unknown }> };

/** The inquiry thread this conversation is about: the latest card, draft or confirmed send. */
function threadInView(sets: Awaited<ReturnType<typeof recentSets>>, actorId: string): string | undefined {
  for (const set of sets) {
    const query = set.query as Pending & { inquiryId?: unknown; result?: { inquiryId?: unknown } };
    if (query.ownerId !== actorId) continue;
    if (query.kind === "INQUIRY" && typeof query.inquiryId === "string") return query.inquiryId;
    if (query.kind === "ACTION" && query.action === ACTION) {
      if (typeof query.result?.inquiryId === "string") return query.result.inquiryId;
      const key = String(query.targetResource ?? "");
      if (key.startsWith("inquiry:")) return key.slice(8);
    }
  }
  return undefined;
}

async function latestCard(conversationId: string) {
  const [latest] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  return latest?.payload as { surface?: unknown; inquiry?: { view?: unknown; inquiryId?: unknown } } | undefined;
}

/**
 * The newest card is an incoming message (or its thread) that this actor has not answered yet.
 * Under a freshly delivered message free text is a reply; under a status card only a statement
 * is — a question or a request to DINAR stays with DINAR. Either way a review comes first.
 */
async function awaitingReplyThread(conversationId: string, actorId: string, message: string, text: string): Promise<string | undefined> {
  const payload = await latestCard(conversationId);
  if ((payload?.surface !== "INQUIRY_INCOMING" && payload?.surface !== "INQUIRY_STATUS") || typeof payload.inquiry?.inquiryId !== "string") return undefined;
  if (COMMAND_LIKE.test(text) || DINAR_DIRECTED.test(text)) return undefined;
  if (payload.surface === "INQUIRY_STATUS" && isGeneralRequest(message)) return undefined;
  const inquiry = await inquiryForParty(actorId, payload.inquiry.inquiryId);
  if (!inquiry) return undefined;
  const awaiting = inquiry.sellerId === actorId ? "AWAITING_SELLER" : "AWAITING_BUYER";
  return inquiry.status === awaiting ? inquiry.id : undefined;
}

// ─── Drafting ────────────────────────────────────────────────────────────────

const asQuestion = (text: string) => (/[؟?]$/u.test(text.trim()) ? text.trim() : `${text.trim()}؟`);

// «كم قطعة يريد؟» → «كم قطعة تريد؟»: the seller's words addressed to the buyer. Shown before sending.
const SECOND_PERSON: [RegExp, string][] = [
  [/(^|\s)يريد(?=\s|$|؟)/gu, "$1تريد"],
  [/(^|\s)يبي(?=\s|$|؟)/gu, "$1تبي"],
  [/(^|\s)يبغى(?=\s|$|؟)/gu, "$1تبغى"],
  [/(^|\s)يفضل(?=\s|$|؟)/gu, "$1تفضل"],
  [/(^|\s)يناسبه(?=\s|$|؟)/gu, "$1يناسبك"],
  [/(^|\s)يحتاج(?=\s|$|؟)/gu, "$1تحتاج"],
  [/(^|\s)عنده(?=\s|$|؟)/gu, "$1عندك"],
  [/(^|\s)لديه(?=\s|$|؟)/gu, "$1لديك"],
];
function addressed(text: string): { body: string; rewritten: boolean } {
  let body = text.trim();
  for (const [pattern, replacement] of SECOND_PERSON) body = body.replace(pattern, replacement);
  return { body, rewritten: body !== text.trim() };
}

/** The original words after the command, from the raw message (not the normalized one). */
function rawTail(message: string, normalizedTail: string): string {
  const raw = message.trim().replace(/[«»"]/gu, "");
  const words = normalizedTail.trim().split(/\s+/u).length;
  const rawWords = raw.split(/\s+/u);
  return rawWords.slice(Math.max(0, rawWords.length - words)).join(" ").replace(/^[:،,]\s*/u, "");
}

async function listingFacts(listingId: string) {
  const [row] = await db.select().from(offers).where(eq(offers.id, listingId));
  if (!row) return undefined;
  return {
    title: typeof row.data.title === "string" ? row.data.title : "الإعلان",
    available: row.inventoryMode === "LIMITED" && typeof row.availableQuantity === "number"
      ? Math.max(0, row.availableQuantity - row.reservedQuantity)
      : null,
  };
}

type InventorySnapshot = {
  inventoryMode: "LIMITED" | "UNLIMITED";
  availableQuantity: number | null;
  recordedAvailableQuantity: number | null;
  reservedQuantity: number;
};

async function draft(
  input: Input & { actorId: string },
  target: InquiryTarget,
  body: string,
  provenance: InquiryProvenance,
  lead: string,
  extra: Record<string, unknown> = {},
  evidence?: { sourceQuestion: string; inventorySnapshot: InventorySnapshot },
): Promise<Turn> {
  const quoted = target.kind === "LISTING" ? (await listingFacts(target.listingId))?.title : undefined;
  const problem = inquiryBodyProblem(body, quoted);
  if (problem) return notice(`${problem}. لم يُرسل شيء.`);
  try {
    let delegatedAuthority: DelegatedActionAuthority | undefined;
    if (input.employeeSession) {
      const listingId = target.kind === "LISTING"
        ? target.listingId
        : target.kind === "INQUIRY"
          ? (await inquiryForParty(input.actorId, target.inquiryId))?.listingId
          : undefined;
      if (!listingId) return notice("تعذر ربط الرسالة بمنتج النشاط. لم يُرسل شيء.");
      delegatedAuthority = {
        sessionId: input.employeeSession.id,
        capabilities: evidence
          ? ["business.inquiries.reply", "business.messages.send", "business.inventory.read"]
          : ["business.inquiries.reply", "business.messages.send"],
        listingId,
        ...(evidence ? { inventorySnapshot: evidence.inventorySnapshot } : {}),
      };
    }
    const review = await createPendingAction({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: input.market,
      ...(delegatedAuthority ? { delegatedAuthority } : {}),
      proposal: {
        action: ACTION,
        targetResource: targetKey(target),
        structuredInput: {
          body: { value: body, source: "USER_DECLARED" },
          provenance: { value: provenance, source: "USER_DECLARED" },
          ...(evidence
            ? {
                sourceQuestion: { value: evidence.sourceQuestion, source: "SERVER_FACT" },
                inventorySnapshot: { value: evidence.inventorySnapshot, source: "SERVER_FACT" },
              }
            : {}),
        },
        missingFields: [],
        requiresConfirmation: true,
      },
    });
    return reviewTurn(review, body, provenance, `${lead}\n«${body}»\nهل أرسلها؟ اكتب «أرسل» أو «إلغاء». لن يُرسل شيء قبل موافقتك.`, extra);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500 && error instanceof Error) return notice(`${error.message}. لم يُرسل شيء.`);
    throw error;
  }
}

type AssignedSellerInquiry = {
  inquiry: typeof marketplaceInquiries.$inferSelect;
  question: string;
  listingTitle: string;
  inventorySnapshot: InventorySnapshot;
};

async function assignedSellerInquiry(input: {
  actorId: string;
  conversationId: string;
  market: Market;
  session: SellerEmployeeSessionContext;
  inquiryId?: string;
}): Promise<AssignedSellerInquiry | null> {
  const candidates = await db
    .select()
    .from(marketplaceInquiries)
    .where(and(
      eq(marketplaceInquiries.sellerId, input.actorId),
      eq(marketplaceInquiries.sellerConversationId, input.conversationId),
      eq(marketplaceInquiries.marketId, input.market.id),
      eq(marketplaceInquiries.status, "AWAITING_SELLER"),
    ))
    .orderBy(desc(marketplaceInquiries.lastMessageAt))
    .limit(20);
  const selectedInquiryId = input.inquiryId ??
    threadInView(await recentSets(input.conversationId, input.market.id), input.actorId);
  const inquiry = selectedInquiryId
    ? candidates.find((candidate) => candidate.id === selectedInquiryId)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!inquiry) return null;

  const [listing] = await db.select().from(offers).where(eq(offers.id, inquiry.listingId));
  if (!listing || listing.sellerId !== input.actorId || listing.marketId !== input.market.id ||
      listing.status !== "PUBLISHED")
    return null;
  // Inventory facts are sensitive to both grants and listing scope; no model-visible context
  // is constructed until all three live D5 capabilities authorize this exact listing.
  try {
    for (const capability of [
      "business.inquiries.reply",
      "business.messages.send",
      "business.inventory.read",
    ] as const) {
      await requireSellerEmployeeCapability({
        actorId: input.actorId,
        conversationId: input.conversationId,
        marketId: input.market.id,
        sessionId: input.session.id,
        capability,
        listingId: inquiry.listingId,
      });
    }
  } catch {
    return null;
  }

  const [lastMessage] = await db
    .select({ senderId: messages.senderId, body: messages.body, metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.conversationId, inquiry.threadConversationId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!lastMessage || lastMessage.senderId !== inquiry.buyerId ||
      lastMessage.metadata?.authorRole !== "BUYER" ||
      inquiryBodyProblem(lastMessage.body) ||
      containsPriceOffer(lastMessage.body))
    return null;

  const inventorySnapshot: InventorySnapshot = {
    inventoryMode: listing.inventoryMode as InventorySnapshot["inventoryMode"],
    availableQuantity: listing.inventoryMode === "LIMITED" && typeof listing.availableQuantity === "number"
      ? Math.max(0, listing.availableQuantity - listing.reservedQuantity)
      : null,
    recordedAvailableQuantity: listing.availableQuantity,
    reservedQuantity: listing.reservedQuantity,
  };
  return {
    inquiry,
    question: lastMessage.body,
    listingTitle: typeof listing.data.title === "string" ? listing.data.title : "الإعلان",
    inventorySnapshot,
  };
}

/** Only screened, currently assigned buyer text and server inventory facts reach the model. */
export async function sellerEmployeeInquiryModelContext(input: {
  actorId: string;
  conversationId: string;
  market: Market;
  session: SellerEmployeeSessionContext;
  inquiryId?: string;
}) {
  const assigned = await assignedSellerInquiry(input);
  if (!assigned) return null;
  return {
    inquiryId: assigned.inquiry.id,
    question: assigned.question,
    listingTitle: assigned.listingTitle,
    inventoryMode: assigned.inventorySnapshot.inventoryMode,
    availableQuantity: assigned.inventorySnapshot.availableQuantity,
  };
}

async function draftSellerEmployeeInquiryReply(input: Input & {
  actorId: string;
  employeeSession: SellerEmployeeSessionContext;
  employeeReply: string;
  employeeInquiryId?: string;
}): Promise<Turn> {
  const requestText = normalizeInquiryText(input.message);
  if (!/(?:جهز|حضر|اكتب|صغ|اعد|رد|جاوب)/u.test(requestText))
    return notice("لم أتعرف على طلب إعداد رد للمشتري. لم يُرسل شيء.");
  if (/(?:\b(?:كل|جميع|كافة)\s+(?:المشترين|العملاء|الزبائن)|(?:لجميع|لكل)\s+(?:المشترين|العملاء|الزبائن)|bulk|mass\s+message)/u.test(requestText))
    return notice("لا يرسل موظف D5 رسائل جماعية. اختر استفسارًا واحدًا، وسيبقى الرد للمراجعة قبل الإرسال.");
  const assigned = await assignedSellerInquiry({
    actorId: input.actorId,
    conversationId: input.conversationId,
    market: input.market,
    session: input.employeeSession,
    inquiryId: input.employeeInquiryId,
  });
  if (!assigned)
    return notice("لا يوجد استفسار بانتظار ردك ضمن نطاق التفويض، أو تعذر التحقق من صلاحياته ومحتواه. لم يُرسل شيء.");

  const body = input.employeeReply.trim();
  const bodyProblem = inquiryBodyProblem(body, assigned.listingTitle);
  if (bodyProblem || containsPriceOffer(body))
    return notice(`${bodyProblem ?? "الرد يتضمن عرضًا ماليًا، ويجب أن يمر عبر التفاوض"}. لم يُرسل شيء.`);
  const quantityAssertions = [
    ...body.matchAll(/(\d+)\s*(?:قطعة|قطع|حبة|حبات|وحدة|وحدات|pcs|pieces|units)/giu),
    ...body.matchAll(/(?:ال)?(?:متاح|متوف|موجود)\w*\s*(?:حاليًا|حاليا)?\s*(\d+)/giu),
  ].map((match) => Number(match[1]));
  if (quantityAssertions.some((quantity) => quantity !== assigned.inventorySnapshot.availableQuantity))
    return notice("الرد يتضمن كمية لا تطابق المخزون المسجل حاليًا؛ لم أعدّه للإرسال.");
  const normalizedBody = normalizeInquiryText(body);
  const claimsUnavailable = /(?:غير\s+(?:متاح|متوف\w*|موجود\w*)|لا\s+(?:يوجد|توجد)\s+(?:مخزون|كمية)|نفد(?:ت)?(?:\s+(?:المخزون|الكمية))?|out\s+of\s+stock|not\s+available)/u.test(normalizedBody);
  const positiveAvailabilityText = normalizedBody.replace(
    /(?:غير\s+(?:متاح|متوف\w*|موجود\w*)|لا\s+(?:يوجد|توجد)\s+(?:مخزون|كمية)|نفد(?:ت)?(?:\s+(?:المخزون|الكمية))?|out\s+of\s+stock|not\s+available)/gu,
    "",
  );
  const claimsAvailable = /(?:متاح|متوف|موجود|available|in\s+stock)/u.test(positiveAvailabilityText);
  const unknownQuantity = assigned.inventorySnapshot.inventoryMode === "LIMITED" &&
    assigned.inventorySnapshot.availableQuantity === null;
  if (unknownQuantity && (claimsAvailable || claimsUnavailable))
    return notice("لم تُسجل كمية محددة تكفي لتأكيد توفر المنتج أو نفاده؛ لم أعدّه للإرسال.");
  if (assigned.inventorySnapshot.inventoryMode === "LIMITED" &&
      assigned.inventorySnapshot.availableQuantity === 0 && claimsAvailable)
    return notice("المخزون المسجل صفر؛ لا يمكن تأكيد توفر المنتج في الرد. لم أعدّه للإرسال.");
  if (claimsUnavailable && (
    assigned.inventorySnapshot.inventoryMode === "UNLIMITED" ||
    (assigned.inventorySnapshot.inventoryMode === "LIMITED" &&
      typeof assigned.inventorySnapshot.availableQuantity === "number" &&
      assigned.inventorySnapshot.availableQuantity > 0)
  ))
    return notice("الرد ينفي توفرًا يخالف المخزون المسجل؛ لم أعدّه للإرسال.");
  if (/(?:سيصل|راح\s+يتوفر|رح\s+يتوفر|سيتوفر|يتوفر\s+(?:غدًا|غدا|بكرة|لاحقًا|لاحقا|خلال|بعد)|restock|back\s+in\s+stock|available\s+(?:tomorrow|next|in)\b)/u.test(normalizedBody))
    return notice("لا يوجد موعد إعادة توفير مسجل؛ لم أعدّه للإرسال.");

  const evidence = {
    sourceQuestion: assigned.question,
    inventorySnapshot: assigned.inventorySnapshot,
  };
  return draft(
    input,
    { kind: "INQUIRY", inquiryId: assigned.inquiry.id },
    body,
    "DINAR_DRAFT_APPROVED",
    `رد مقترح للمشتري بخصوص «${assigned.listingTitle}»:`,
    {
      inquiry: {
        view: "DRAFT",
        inquiryId: assigned.inquiry.id,
        status: "PENDING",
        provenance: "DINAR_DRAFT_APPROVED",
        body,
        sourceQuestion: assigned.question,
        inventory: {
          mode: assigned.inventorySnapshot.inventoryMode,
          availableQuantity: assigned.inventorySnapshot.availableQuantity,
        },
      },
    },
    evidence,
  );
}

async function guardedPreconditions(actorId: string, market: Market, target: InquiryTarget): Promise<Turn | undefined> {
  try {
    await inquiryPreconditions(actorId, market, target);
    return undefined;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500 && error instanceof Error)
      return notice(`${error.message}. لم يُرسل شيء.`, { failure: (error as { code?: string }).code ?? "REFUSED" }, target.kind === "LISTING" ? target.listingId : undefined);
    throw error;
  }
}

const PRICE_SEPARATION =
  "سؤالك يتضمن سعرًا أو عرضًا ماليًا، والعروض المالية لا تُرسل كاستفسار. إن كان الإعلان يقبل التفاوض قل مثلًا «أعطيه 100» لتراجع عرض السعر قبل إرساله، أو اسأل البائع سؤالًا لا يتضمن سعرًا. لم يُرسل شيء.";

/**
 * A question DINAR prepared for the buyer («كم ماشي؟» on a listing with no recorded
 * mileage). It is the same review card «اسأل البائع» produces: nothing is sent until the
 * buyer confirms, and the authority stays the existing SEND_INQUIRY_MESSAGE action.
 */
export async function draftListingQuestion(
  input: Input & { actorId: string },
  listingId: string,
  body: string,
  lead: string,
): Promise<Turn> {
  const target: InquiryTarget = { kind: "LISTING", listingId };
  const refused = await guardedPreconditions(input.actorId, input.market, target);
  if (refused) return refused;
  return draft(input, target, body, "DINAR_DRAFT_APPROVED", lead);
}

async function askSeller(input: Input & { actorId: string }, question: string, chosen?: string): Promise<Turn> {
  const listingId = chosen ?? await focusedListing({ conversationId: input.conversationId, market: input.market, actorId: input.actorId, message: input.message });
  if (!listingId) return notice("أي إعلان تقصد؟ ابحث عن المنتج أو افتح الإعلان، ثم قل «اسأل البائع …». لم يُرسل شيء.");
  const target: InquiryTarget = { kind: "LISTING", listingId };
  const refused = await guardedPreconditions(input.actorId, input.market, target);
  if (refused) return refused;
  const facts = (await listingFacts(listingId))!;
  const normalized = normalizeInquiryText(question);
  if (!normalized) return notice(`ما سؤالك لبائع «${facts.title}»؟ مثل «اسأل البائع هل يوصل إلى إربد». لم يُرسل شيء.`, {}, listingId);
  if (containsPriceOffer(question) || containsPriceOffer(normalized)) return notice(PRICE_SEPARATION, { failure: "PRICE_OFFER" }, listingId);
  const quantity = /(?:عنده|عندكم|لديه|لديكم|يتوفر|تتوفر|متوفر|متوفره|في|فيه|يقدر|يوفر|توفير|كميه)/u.test(normalized) ? Number(normalized.match(QUANTITY)?.[1]) : NaN;
  const wantsConfirmation = CONFIRM_WANTED.test(normalized);
  if (Number.isInteger(quantity) && quantity > 0) {
    if (facts.available === null && !wantsConfirmation)
      return notice(`حسب سجل جاسم، «${facts.title}» معروض بكمية غير محدودة يحددها البائع، فطلب ${quantity} قطعة لا يتعارض مع الإعلان. هذه معلومة من سجل الإعلان وليست تأكيدًا من البائع. لم أرسل شيئًا؛ إن أردت تأكيدًا منه قل «اسأله للتأكيد هل عنده ${quantity} قطعة».`, { fact: { kind: "INVENTORY", source: "DINAR_RECORD", text: "كمية غير محدودة" } }, listingId);
    if (facts.available !== null && facts.available >= quantity && !wantsConfirmation)
      return notice(`سجل جاسم يُظهر توفر ${facts.available} قطعة الآن من «${facts.title}»، فالكمية التي تريدها (${quantity}) متاحة حسب السجل. هذه معلومة من سجل الإعلان، لا وعد من البائع. لم أرسل شيئًا للبائع؛ إن أردت تأكيدًا منه قل «اسأله للتأكيد هل عنده ${quantity} قطعة».`, { fact: { kind: "INVENTORY", source: "DINAR_RECORD", text: `${facts.available} متاح الآن` } }, listingId);
    const short = facts.available !== null && facts.available < quantity;
    const body = short
      ? `هل يمكن توفير ${quantity} قطعة من «${facts.title}»؟ المعروض حاليًا ${facts.available}. وإن أمكن، متى تكون جاهزة؟`
      : `هل تتوفر لديكم كمية ${quantity} قطعة من «${facts.title}»؟ وإذا كانت متاحة، ما موعد التجهيز أو التسليم؟`;
    return draft(input, target, body, "DINAR_DRAFT_APPROVED", short
      ? `المتاح في سجل جاسم الآن ${facts.available} فقط، فلا أستطيع وعدك بـ${quantity}. جهّزت استفسارًا لبائع «${facts.title}» عن إمكانية توفيرها:`
      : `جهّزت استفسارًا لبائع «${facts.title}» ليؤكد الكمية بنفسه:`, short ? { fact: { kind: "INVENTORY", source: "DINAR_RECORD", text: `${facts.available} متاح الآن` } } : {});
  }
  const body = asQuestion(rawTail(input.message, question) || question);
  return draft(input, target, body, "BUYER_AUTHORED", `هذا سؤالك لبائع «${facts.title}» كما كتبته:`);
}

/** The seller's counterpart: the thread in view, else the only live relationship, else a choice. */
async function sellerTarget(input: Input & { actorId: string }): Promise<{ target?: InquiryTarget; turn?: Turn }> {
  const inView = threadInView(await recentSets(input.conversationId, input.market.id), input.actorId);
  if (inView) {
    const inquiry = await inquiryForParty(input.actorId, inView);
    if (inquiry?.sellerId === input.actorId) return { target: { kind: "INQUIRY", inquiryId: inquiry.id } };
  }
  const candidates = await sellerRelationships(input.actorId, input.market);
  if (!candidates.length)
    return { turn: notice("لا يمكنني مراسلة مشترٍ ليس بينك وبينه استفسار أو عرض سعر أو طلب. جاسم لا يرسل رسائل لمشترين عشوائيين. لم يُرسل شيء.", { failure: "NO_RELATIONSHIP" }) };
  if (candidates.length === 1) return { target: candidates[0]!.target };
  return { turn: await stateTurn(input.actorId, input.market, "LIST", undefined, "لديك أكثر من مشترٍ تتواصل معه. افتح رسالة المشتري المقصود من القائمة ثم اطلب مني سؤاله. لم يُرسل شيء.") };
}

async function writeToBuyer(input: Input & { actorId: string }, text: string, kind: "ASK" | "TELL"): Promise<Turn> {
  const resolved = await sellerTarget(input);
  if (resolved.turn) return resolved.turn;
  const target = resolved.target!;
  const refused = await guardedPreconditions(input.actorId, input.market, target);
  if (refused) return refused;
  if (containsPriceOffer(text)) return notice("الرسالة تتضمن سعرًا أو عرضًا ماليًا؛ الأسعار تُعرض عبر التفاوض (مثل «أعطيه 100» من المشتري أو عرضك المضاد). لم يُرسل شيء.", { failure: "PRICE_OFFER" });
  // Questions about the buyer are addressed to them («كم قطعة يريد» → «تريد»); statements stay as said.
  const { body, rewritten } = kind === "ASK" ? addressed(asQuestion(text)) : { body: `${text.trim().replace(/[.。]$/u, "")}.`, rewritten: false };
  return draft(input, target, body, rewritten || kind === "TELL" ? "DINAR_DRAFT_APPROVED" : "SELLER_AUTHORED", kind === "ASK" ? "سأرسل للمشتري هذا السؤال:" : "سأرسل للمشتري هذا التوضيح:");
}

// ─── Turn ────────────────────────────────────────────────────────────────────

export function isInquiryCommand(message: string): boolean {
  const text = normalizeInquiryText(message);
  return [ASK_SELLER, ASK_BUYER, TELL_BUYER, TELL_SELLER, STATUS, LIST, REPLY_EXPLICIT, SEND_THIS].some((pattern) => pattern.test(text));
}

export async function executeInquiryTurn(input: Input & { employeeInquiryId?: string }): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actor = { ...input, actorId: input.actorId };
  const text = normalizeInquiryText(input.message);
  if (!text) return null;
  if (input.employeeSession && input.employeeReply)
    return draftSellerEmployeeInquiryReply({
      ...actor,
      employeeSession: input.employeeSession,
      employeeReply: input.employeeReply,
      employeeInquiryId: input.employeeInquiryId,
    });
  const sets = await recentSets(input.conversationId, input.market.id);
  const latest = sets[0];
  const pending = latest?.query as Pending | undefined;
  const reviewOpen =
    pending?.kind === "ACTION" && pending.ownerId === input.actorId && pending.status === "PENDING" && pending.action === ACTION &&
    (!latest!.expiresAt || latest!.expiresAt.getTime() > Date.now());

  // ── Decisions on the actor's own message review.
  if (reviewOpen) {
    if (CANCEL.test(text)) {
      const outcome = await confirmPendingAction({ actionId: latest!.id, actorId: input.actorId, market: input.market, decision: "CANCEL" });
      return notice(outcome.status === "CANCELLED" ? "أُلغيت الرسالة؛ لم يُرسل شيء." : outcome.message);
    }
    const appended = text.match(APPEND);
    const addition = appended?.[1] ?? appended?.[2];
    const previousBody = pending?.structuredInput?.body?.value;
    if (addition && typeof previousBody === "string") {
      await db.update(aiResultSets).set({ query: { ...pending, status: "SUPERSEDED", notice: "استُبدلت بصياغة أحدث." } }).where(eq(aiResultSets.id, latest!.id));
      const provenance: InquiryProvenance = String(pending!.targetResource).startsWith("listing:") ? "BUYER_AUTHORED" : (await roleOfTarget(input.actorId, String(pending!.targetResource))) === "SELLER" ? "SELLER_AUTHORED" : "BUYER_AUTHORED";
      const target = parseTargetKey(String(pending!.targetResource));
      if (!target) return notice("تعذر تعديل الرسالة؛ ابدأها من جديد. لم يُرسل شيء.");
      // «… أيضًا/كمان» closes the second form: drop it from the raw words before taking the tail.
      const raw = appended?.[2] ? input.message.trim().replace(/[\s،,.؟?!]*(?:أيضًا|أيضا|ايضا|ايضًا|كمان|بعد)[\s.؟?!]*$/u, "") : input.message;
      return draft(actor, target, `${previousBody.trim()} ${asQuestion(rawTail(raw, addition))}`, provenance, "أضفت السؤال إلى الرسالة:");
    }
    const edited = text.match(EDIT);
    if (edited?.[1]) {
      await db.update(aiResultSets).set({ query: { ...pending, status: "SUPERSEDED", notice: "استُبدلت بصياغة أحدث." } }).where(eq(aiResultSets.id, latest!.id));
      const provenance: InquiryProvenance = String(pending!.targetResource).startsWith("listing:") ? "BUYER_AUTHORED" : (await roleOfTarget(input.actorId, String(pending!.targetResource))) === "SELLER" ? "SELLER_AUTHORED" : "BUYER_AUTHORED";
      const target = parseTargetKey(String(pending!.targetResource));
      if (!target) return notice("تعذر تعديل الرسالة؛ ابدأها من جديد. لم يُرسل شيء.");
      return draft(actor, target, asQuestion(rawTail(input.message, edited[1])), provenance, "عدّلت الرسالة إلى:");
    }
    if (CONFIRM.test(text)) {
      const outcome = await confirmPendingAction({ actionId: latest!.id, actorId: input.actorId, market: input.market, decision: "CONFIRM" });
      if (outcome.status === "REVIEW_REQUIRED") return notice(`${outcome.message} لم تُرسل الرسالة بعد.`);
      if (outcome.status !== "CONFIRMED" || typeof outcome.result?.inquiryId !== "string") return notice(outcome.message, { failure: "SEND_FAILED" });
      const inquiryId = outcome.result.inquiryId;
      const view = await inquiryForParty(input.actorId, inquiryId);
      const counterpart = view?.sellerId === input.actorId ? "المشتري" : "البائع";
      return stateTurn(input.actorId, input.market, "STATUS", inquiryId, outcome.result.duplicate
        ? "أُرسلت هذه الرسالة من قبل؛ لم أكررها."
        : `أُرسلت رسالتك ووصلت إلى محادثة ${counterpart} داخل جاسم. لا توجد إشعارات خارجية مفعّلة، فسيراها عند فتح جاسم. سيظهر الرد هنا عند كتابته، ويمكنك أن تسأل «ماذا رد ${counterpart}؟» في أي وقت.`);
    }
  }

  // «أرسل» with nothing pending right after an inquiry step: say so instead of letting any other
  // path (or the model) suggest that something was sent.
  // «نعم» typed under a freshly delivered question is an answer to it (reviewed like any reply).
  if (!reviewOpen && CONFIRM.test(text)) {
    const card = await latestCard(input.conversationId);
    if (card?.surface === "INQUIRY_INCOMING") {
      const answering = await awaitingReplyThread(input.conversationId, input.actorId, input.message, text);
      if (answering) return replyDraft(actor, answering);
    }
    if (String(card?.surface ?? "").startsWith("INQUIRY_"))
      return notice("لا توجد رسالة بانتظار الإرسال الآن؛ لم يُرسل شيء. اكتب رسالتك من جديد إن أردت.");
  }

  // ── Read-only: status and list (no model, no allowance).
  if (STATUS.test(text)) return statusTurn(actor, sets, text);
  if (LIST.test(text)) return stateTurn(input.actorId, input.market, "LIST", undefined, "رسائلك مع البائعين والمشترين في هذا السوق؛ الرسائل التي تنتظر ردك أولًا.");
  if (CLOSE.test(text) || BLOCK.test(text)) {
    const inquiryId = threadInView(sets, input.actorId);
    const inquiry = inquiryId ? await inquiryForParty(input.actorId, inquiryId) : undefined;
    if (!inquiry) return notice("أي استفسار تقصد؟ اعرض «رسائلي» ثم افتح المحادثة المقصودة.");
    const block = BLOCK.test(text);
    const changed = await closeInquiry(inquiry, input.actorId, block);
    return stateTurn(input.actorId, input.market, "STATUS", inquiry.id, changed
      ? block ? "أوقفت المراسلة مع هذا الطرف؛ لن تصلك منه رسائل جديدة عبر جاسم." : "أُغلق الاستفسار. يمكن بدء استفسار جديد من الإعلان عند الحاجة."
      : "هذا الاستفسار مغلق بالفعل.");
  }

  // ── Outgoing messages: always a review first.
  if (isBestPriceRequest(input.message)) return null; // the negotiation authority handles price requests
  // A «don't send until I approve» clause is honoured by the review itself and dropped from the text.
  const held = HOLD_CLAUSE.test(input.message) ? { ...actor, message: input.message.replace(HOLD_CLAUSE, "") } : actor;
  const heldText = normalizeInquiryText(held.message);
  const byPrice = heldText.match(ASK_BY_PRICE);
  if (byPrice) {
    const set = await latestListingSet(input.conversationId, input.market.id);
    const live = set?.resourceIds.length ? await searchMarketplaceListings(input.market, { search: "", allowedIds: set.resourceIds.slice(0, 24), limit: 24 }) : [];
    const priced = live.filter((listing) => listing.unitPrice !== null && Number.isFinite(Number(listing.unitPrice)));
    if (!priced.length) return notice("لا توجد نتائج بأسعار معلنة أختار منها. ابحث أولًا، ثم اطلب «اسأل صاحب الأرخص …». لم يُرسل شيء.");
    const prices = priced.map((listing) => Number(listing.unitPrice));
    const target = byPrice[1] === "ارخص" ? Math.min(...prices) : Math.max(...prices);
    const winners = priced.filter((listing) => Number(listing.unitPrice) === target);
    if (winners.length > 1)
      return notice(`أكثر من عرض بالسعر نفسه (${target} ${winners[0]!.currency}): ${winners.map((listing) => `«${listing.title}»`).join("، ")}. أي واحد تقصد؟ اختر بالترتيب، مثل «اسأل بائع الأول عن …». لم يُرسل شيء.`);
    const turn = await askSeller(held, byPrice[2] ?? "", winners[0]!.id);
    if (held !== actor && turn.result.prompt) turn.result.prompt = `${turn.result.prompt}\n(لن يُرسل شيء قبل أن تكتب «أرسل»، كما طلبت.)`;
    return turn;
  }
  const askSellerMatch = heldText.match(ASK_SELLER);
  if (askSellerMatch) return askSeller(held, askSellerMatch[1] ?? "");
  const tellSeller = text.match(TELL_SELLER);
  if (tellSeller?.[1]) return askSeller(actor, tellSeller[1]);
  const askBuyer = text.match(ASK_BUYER);
  if (askBuyer?.[1]) return writeToBuyer(actor, rawTail(input.message, askBuyer[1]), "ASK");
  const tellBuyer = text.match(TELL_BUYER);
  if (tellBuyer?.[1]) return writeToBuyer(actor, rawTail(input.message, tellBuyer[1]), "TELL");
  const toThread = text.match(REPLY_EXPLICIT) ?? text.match(SEND_THIS) ?? text.match(ASK_HIM);
  if (toThread?.[1] !== undefined) {
    const inquiryId = threadInView(sets, input.actorId);
    const inquiry = inquiryId ? await inquiryForParty(input.actorId, inquiryId) : undefined;
    if (!inquiry) return ASK_HIM.test(text) ? null : notice("لمن تريد إرسال الرسالة؟ افتح الإعلان أو رسالة المشتري أولًا. لم يُرسل شيء.");
    const words = rawTail(input.message, toThread[1]).trim();
    if (!words) return notice("ما نص الرسالة؟ لم يُرسل شيء.");
    const seller = inquiry.sellerId === input.actorId;
    if (seller) return writeToBuyer(actor, words, ASK_HIM.test(text) ? "ASK" : "TELL");
    return draft(actor, { kind: "INQUIRY", inquiryId: inquiry.id }, ASK_HIM.test(text) ? asQuestion(words) : words, "BUYER_AUTHORED", "سأرسل للبائع:");
  }

  // ── A reply typed directly under an incoming message (still reviewed before sending).
  const awaiting = input.message.trim().length >= 2 ? await awaitingReplyThread(input.conversationId, input.actorId, input.message, text) : undefined;
  if (awaiting) return replyDraft(actor, awaiting);
  return null;
}

async function replyDraft(input: Input & { actorId: string }, inquiryId: string): Promise<Turn> {
  const inquiry = (await inquiryForParty(input.actorId, inquiryId))!;
  const role = inquiry.sellerId === input.actorId ? "SELLER" : "BUYER";
  return draft(input, { kind: "INQUIRY", inquiryId: inquiry.id }, input.message.trim(), role === "SELLER" ? "SELLER_AUTHORED" : "BUYER_AUTHORED", `سأرسل ردك إلى ${ROLE_LABELS[role === "SELLER" ? "BUYER" : "SELLER"]} كما كتبته دون تعديل:`);
}

async function roleOfTarget(actorId: string, key: string): Promise<"BUYER" | "SELLER" | undefined> {
  const target = parseTargetKey(key);
  if (target?.kind !== "INQUIRY") return undefined;
  const inquiry = await inquiryForParty(actorId, target.inquiryId);
  return inquiry ? (inquiry.sellerId === actorId ? "SELLER" : "BUYER") : undefined;
}

/** «ماذا رد البائع؟»: the real messages with their authors, or an honest pending state. */
async function statusTurn(input: Input & { actorId: string }, sets: Awaited<ReturnType<typeof recentSets>>, text: string): Promise<Turn> {
  const asksSeller = /(?:بائع|بايع|تاجر)/u.test(text);
  const asksBuyer = /(?:مشتري|زبون)/u.test(text);
  let inquiryId = threadInView(sets, input.actorId);
  let inquiry = inquiryId ? await inquiryForParty(input.actorId, inquiryId) : undefined;
  const wrongSide = inquiry && ((asksSeller && inquiry.sellerId === input.actorId) || (asksBuyer && inquiry.buyerId === input.actorId));
  if (!inquiry || wrongSide) {
    const mine = (await listInquiries(input.actorId, input.market, 10)).filter((row) => (asksSeller ? row.buyerId === input.actorId : asksBuyer ? row.sellerId === input.actorId : true));
    inquiry = mine[0];
    inquiryId = inquiry?.id;
  }
  if (!inquiry) return notice(asksBuyer ? "لا توجد رسائل بينك وبين مشترين في هذا السوق." : "لم ترسل أي استفسار لبائع في هذا السوق بعد. افتح إعلانًا وقل «اسأل البائع …».");
  await markInquiryRead(inquiry, input.actorId);
  const view = await inquiryView(inquiry, input.actorId, input.market);
  const lastMine = view.messages.map((message) => message.mine).lastIndexOf(true);
  const answers = view.messages.filter((message, index) => !message.mine && index > lastMine);
  const counterpart = view.counterpartLabel;
  let prompt: string;
  if (answers.length) {
    prompt = [`ردّ ${counterpart} بخصوص «${view.listing.title}» (${answers.length === 1 ? "رسالة واحدة" : `${answers.length} رسائل`}):`, ...answers.map((message) => `«${message.body}» — ${message.provenanceLabel}`), "هذا كلامه كما كتبه؛ لم يغيّره جاسم، ولا يعني تغييرًا في المخزون أو طلب شراء."].join("\n");
  } else if (lastMine >= 0) {
    const sent = view.messages[lastMine]!;
    prompt = [
      `لم يرد ${counterpart} بعد على رسالتك بخصوص «${view.listing.title}».`,
      `أُرسلت ${sent.submittedAt ? "ووصلت إلى محادثته داخل جاسم" : ""}${sent.readAt ? "، وقد فتحها" : "، ولم يفتحها بعد"}.`,
      view.notification.label,
    ].join("\n");
  } else prompt = `لا توجد رسائل جديدة من ${counterpart}.`;
  return stateTurn(input.actorId, input.market, "STATUS", inquiry.id, prompt);
}

// ─── Payloads, rebuilt from the authority on every read ──────────────────────

export async function composeInquiryPayload(payload: Record<string, unknown>, actorId: string, market: Market, options: { markRead?: boolean } = {}): Promise<Record<string, unknown>> {
  const view = String(payload.view ?? "");
  if (view === "LIST") {
    const rows = await listInquiries(actorId, market, 10);
    const items = await Promise.all(rows.map(async (row) => {
      const detail = await inquiryView(row, actorId, market);
      const last = detail.messages.at(-1);
      return { inquiryId: row.id, listingTitle: detail.listing.title, counterpartLabel: detail.counterpartLabel, statusLabel: detail.statusLabel, awaitingMe: detail.awaitingMe, lastMessage: last ? { authorLabel: last.authorLabel, body: last.body.slice(0, 160) } : null };
    }));
    return { view: "LIST", items };
  }
  if ((view === "STATUS" || view === "INCOMING") && typeof payload.inquiryId === "string") {
    const inquiry = await inquiryForParty(actorId, payload.inquiryId);
    if (!inquiry || inquiry.marketId !== market.id) return { view: "NOTICE", notice: "هذا الاستفسار غير متاح لك في السوق الحالي." };
    if (options.markRead) await markInquiryRead(inquiry, actorId);
    return { view, ...(await inquiryView(inquiry, actorId, market)) };
  }
  if (view === "DRAFT" && typeof payload.actionId === "string") {
    const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, payload.actionId));
    const query = set?.query as Pending & { notice?: unknown } | undefined;
    const ownDraft = query?.ownerId === actorId;
    const status = !ownDraft ? "EXPIRED" : query?.status === "PENDING" && set?.expiresAt && set.expiresAt.getTime() <= Date.now() ? "EXPIRED" : String(query?.status ?? "EXPIRED");
    return {
      view: "DRAFT",
      actionId: payload.actionId,
      body: ownDraft ? payload.body : "",
      provenance: payload.provenance,
      provenanceLabel: payload.provenanceLabel,
      lines: ownDraft ? payload.lines : [],
      ...(payload.fact ? { fact: payload.fact } : {}),
      status: status === "SUPERSEDED" ? "EXPIRED" : status,
    };
  }
  return { view: "NOTICE", notice: typeof payload.notice === "string" ? payload.notice : "", ...(payload.fact ? { fact: payload.fact } : {}), ...(payload.failure ? { failure: payload.failure } : {}) };
}

export const refreshInquiryPayload = (payload: Record<string, unknown>, actorId: string, market: Market) =>
  composeInquiryPayload(payload, actorId, market, { markRead: payload.view === "INCOMING" || payload.view === "STATUS" });

/**
 * «أرسل موقع مطعمي للعميل» without a pickup order: the listing's PUBLIC area (city, district —
 * what the listing already shows everyone) as a reviewed message inside an existing relationship.
 * A precise address never travels through an inquiry; it is shared only within a confirmed order.
 */
export async function draftPublicBusinessLocation(input: Input & { actorId: string }): Promise<Turn> {
  const resolved = await sellerTarget(input);
  if (resolved.turn) return resolved.turn;
  const target = resolved.target!;
  const refused = await guardedPreconditions(input.actorId, input.market, target);
  if (refused) return refused;
  const relationship = await inquiryPreconditions(input.actorId, input.market, target);
  const [listing] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, relationship.listingId));
  const place = [listing?.data.area, listing?.data.city].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!place.length)
    return notice("لا يوجد موقع عام مسجل في إعلانك لأشاركه. أضف المدينة والمنطقة إلى الإعلان، أو شارك نقطة الاستلام ضمن طلب مؤكد. لم يُرسل شيء.", { failure: "NO_PUBLIC_LOCATION" });
  const body = `موقعنا العام: ${place.join("، ")}. العنوان الدقيق يُشارك داخل جاسم ضمن طلب استلام مؤكد فقط.`;
  return draft(input, target, body, "DINAR_DRAFT_APPROVED", "سأرسل للعميل الموقع العام لنشاطك كما يظهر في إعلانك (المنطقة والمدينة فقط، دون عنوان دقيق):");
}
