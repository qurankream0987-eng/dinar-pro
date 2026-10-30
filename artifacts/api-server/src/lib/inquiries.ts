/**
 * DINAR NEXT G2: the inquiry authority — non-price questions between a buyer and a seller,
 * mediated by DINAR inside their own conversations.
 *
 * - A buyer may open a thread on a published listing in their market. A seller may write
 *   only inside an existing relationship: a thread the buyer opened, a negotiation or an order.
 * - Messages are stored verbatim in `messages` (thread conversation of kind INQUIRY) with the
 *   author, role and provenance; DINAR never rewrites them and never writes on anyone's behalf.
 * - Events keep SUBMITTED (stored), DELIVERED (placed in the recipient's DINAR conversation,
 *   in-app only), READ (the recipient opened it) and REPLIED (the other party answered) apart.
 *   No external notification transport exists; that is stated, never implied.
 * - Nothing here changes stock, prices, orders or negotiations.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import {
  aiResultSets,
  aiUiBlocks,
  conversations,
  db,
  marketplaceInquiries,
  marketplaceInquiryEvents,
  messages,
  negotiations,
  offers,
  orders,
  users,
} from "@workspace/db";
import { AUTH_RATE_LIMIT_SCOPE, consumeRateLimit } from "./auth-rate-limiter";
import { logger } from "./logger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type MarketRef = { id: string; minorUnitScale: number; currencyCode: string };
export type InquiryRow = typeof marketplaceInquiries.$inferSelect;
export type InquiryRole = "BUYER" | "SELLER";
export type InquiryProvenance = "BUYER_AUTHORED" | "SELLER_AUTHORED" | "DINAR_DRAFT_APPROVED";
export type InquiryTarget =
  | { kind: "LISTING"; listingId: string }
  | { kind: "INQUIRY"; inquiryId: string }
  | { kind: "NEGOTIATION"; negotiationId: string }
  | { kind: "ORDER"; orderId: string };

export const INQUIRY_INBOX_TITLE = "رسائل البيع والشراء في DINAR";
export const MAX_UNANSWERED_MESSAGES = 3;
const INQUIRIES_PER_HOUR = 12;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NOTIFICATION_STATUS = "NOT_CONFIGURED" as const;

export const PROVENANCE_LABELS: Record<InquiryProvenance, string> = {
  BUYER_AUTHORED: "كتبه المشتري",
  SELLER_AUTHORED: "كتبه البائع",
  DINAR_DRAFT_APPROVED: "صاغه DINAR ووافق عليه المرسل قبل الإرسال",
};
export const ROLE_LABELS: Record<InquiryRole, string> = { BUYER: "المشتري", SELLER: "البائع" };

function fail(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

// Contact details and links never travel through an inquiry; contact release stays order-bound.
const CONTACT_PATTERN = /(?:\+?\d[\d\s-]{6,}\d)|[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/|www\.|wa\.me|t\.me/iu;
// «هل تعطيني 50 قطعة بمبلغ 100؟» is a price offer; offers go through negotiation.
const PRICE_OFFER_PATTERN =
  /(?:بمبلغ|بسعر|ب\s*سعر|اعطيك|أعطيك|اعطيه|أعطيه|ادفع|أدفع|ادفعلك|بـ?\s*\d+(?:[.,]\d+)?\s*(?:دينار|دنانير|jod|kwd|ريال|sar)|\d+(?:[.,]\d+)?\s*(?:دينار|دنانير|jod|kwd|ريال|sar)\s*(?:لل|لـ|ل)?(?:قطعه|قطعة|الكل|حبه|حبة)?|خصم|تخفيض|اخر\s+سعر|آخر\s+سعر)/iu;

/**
 * `quoted` is server data DINAR places in a drafted message (the listing's own title, e.g.
 * «لاندكروزر 2021 150000»): it is not the author's words, so it is left out of the contact
 * check only. Everything the author typed is still checked; lengths count the whole message.
 */
export function inquiryBodyProblem(body: string, quoted?: string): string | undefined {
  const text = body.trim();
  if (text.length < 2) return "الرسالة قصيرة جدًا";
  if (text.length > 1000) return "الرسالة أطول من 1000 حرف";
  const authored = quoted && quoted.trim().length >= 2 ? text.split(quoted.trim()).join(" ") : text;
  if (CONTACT_PATTERN.test(authored)) return "لا تُرسل أرقام الهواتف أو البريد أو الروابط عبر الاستفسار؛ بيانات التواصل تُتاح فقط عبر الطلب المؤكد";
  return undefined;
}

export function containsPriceOffer(body: string): boolean {
  return PRICE_OFFER_PATTERN.test(body);
}

const normalizedBody = (body: string) => body.replace(/[\s؟?!.,،]+/gu, " ").trim().toLowerCase();

type Relationship = {
  listingId: string;
  marketId: string;
  buyerId: string;
  sellerId: string;
  actorRole: InquiryRole;
  relationship: InquiryRow["relationship"];
  negotiationId?: string;
  orderId?: string;
  inquiry?: InquiryRow;
};

/** Resolves who the actor may write to, and in which scope, from server rows only. */
export async function resolveRelationship(actorId: string, market: { id: string }, target: InquiryTarget, tx: Tx | typeof db = db): Promise<Relationship> {
  if (target.kind === "LISTING") {
    const [listing] = await tx.select().from(offers).where(eq(offers.id, target.listingId));
    if (!listing || listing.marketId !== market.id) throw fail(404, "الإعلان غير موجود في سوقك الحالي", "WRONG_LISTING");
    if (listing.sellerId === actorId) throw fail(409, "هذا إعلانك؛ لا يمكنك مراسلة نفسك", "OWN_LISTING");
    if (listing.status !== "PUBLISHED") throw fail(409, "الإعلان غير منشور حاليًا، فلا يمكن مراسلة بائعه عبره", "LISTING_UNAVAILABLE");
    const [open] = await tx
      .select()
      .from(marketplaceInquiries)
      .where(and(eq(marketplaceInquiries.listingId, listing.id), eq(marketplaceInquiries.buyerId, actorId), notInArray(marketplaceInquiries.status, ["CLOSED", "BLOCKED"])));
    return { listingId: listing.id, marketId: listing.marketId, buyerId: actorId, sellerId: listing.sellerId, actorRole: "BUYER", relationship: open?.relationship ?? "LISTING_INQUIRY", ...(open ? { inquiry: open } : {}) };
  }
  if (target.kind === "INQUIRY") {
    const [inquiry] = await tx.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, target.inquiryId));
    if (!inquiry || (inquiry.buyerId !== actorId && inquiry.sellerId !== actorId)) throw fail(404, "الاستفسار غير موجود", "UNAUTHORIZED_INQUIRY");
    if (inquiry.marketId !== market.id) throw fail(409, "هذا الاستفسار في سوق آخر؛ انتقل إلى سوقه للمتابعة", "CROSS_MARKET");
    return {
      listingId: inquiry.listingId, marketId: inquiry.marketId, buyerId: inquiry.buyerId, sellerId: inquiry.sellerId,
      actorRole: inquiry.sellerId === actorId ? "SELLER" : "BUYER", relationship: inquiry.relationship,
      ...(inquiry.negotiationId ? { negotiationId: inquiry.negotiationId } : {}), ...(inquiry.orderId ? { orderId: inquiry.orderId } : {}), inquiry,
    };
  }
  const [row] =
    target.kind === "NEGOTIATION"
      ? await tx.select({ id: negotiations.id, listingId: negotiations.listingId, marketId: negotiations.marketId, buyerId: negotiations.buyerId, sellerId: negotiations.sellerId }).from(negotiations).where(eq(negotiations.id, target.negotiationId))
      : await tx.select({ id: orders.id, listingId: sql<string>`${orders.data} -> 'items' -> 0 ->> 'listingId'`, marketId: orders.marketId, buyerId: orders.buyerId, sellerId: orders.sellerId }).from(orders).where(eq(orders.id, target.orderId));
  if (!row || (row.buyerId !== actorId && row.sellerId !== actorId) || !row.listingId) throw fail(404, "لا توجد علاقة تجارية بينك وبين هذا الطرف", "NO_RELATIONSHIP");
  if (row.marketId !== market.id) throw fail(409, "هذه العلاقة في سوق آخر", "CROSS_MARKET");
  const [open] = await tx
    .select()
    .from(marketplaceInquiries)
    .where(and(eq(marketplaceInquiries.listingId, row.listingId), eq(marketplaceInquiries.buyerId, row.buyerId), notInArray(marketplaceInquiries.status, ["CLOSED", "BLOCKED"])));
  return {
    listingId: row.listingId, marketId: row.marketId, buyerId: row.buyerId, sellerId: row.sellerId,
    actorRole: row.sellerId === actorId ? "SELLER" : "BUYER",
    relationship: target.kind,
    ...(target.kind === "NEGOTIATION" ? { negotiationId: row.id } : { orderId: row.id }),
    ...(open ? { inquiry: open } : {}),
  };
}

async function userStatuses(ids: string[], tx: Tx | typeof db = db) {
  const rows = await tx.select({ id: users.id, status: users.status }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((row) => [row.id, row.status]));
}

/** A party blocked the other on any thread between them: no new messages either way. */
async function pairBlocked(buyerId: string, sellerId: string, tx: Tx | typeof db = db) {
  const [row] = await tx
    .select({ id: marketplaceInquiries.id })
    .from(marketplaceInquiries)
    .where(and(eq(marketplaceInquiries.buyerId, buyerId), eq(marketplaceInquiries.sellerId, sellerId), eq(marketplaceInquiries.status, "BLOCKED")))
    .limit(1);
  return Boolean(row);
}

/** Pre-checks shared by the review and the send (the send re-checks inside its transaction). */
export async function inquiryPreconditions(actorId: string, market: { id: string }, target: InquiryTarget) {
  const relationship = await resolveRelationship(actorId, market, target);
  const statuses = await userStatuses([relationship.buyerId, relationship.sellerId]);
  if (statuses.get(actorId) !== "ACTIVE") throw fail(403, "حسابك غير نشط حاليًا", "ACTOR_INACTIVE");
  const counterpart = relationship.actorRole === "BUYER" ? relationship.sellerId : relationship.buyerId;
  if (statuses.get(counterpart) !== "ACTIVE") throw fail(409, `${relationship.actorRole === "BUYER" ? "البائع" : "المشتري"} غير متاح للمراسلة حاليًا`, "COUNTERPART_INACTIVE");
  if (await pairBlocked(relationship.buyerId, relationship.sellerId)) throw fail(403, "المراسلة بينكما موقوفة بطلب أحد الطرفين", "BLOCKED");
  if (relationship.actorRole === "SELLER" && !relationship.inquiry && relationship.relationship === "LISTING_INQUIRY")
    throw fail(403, "لا يمكن للبائع بدء مراسلة إلا ضمن استفسار أو عرض سعر أو طلب قائم", "NO_RELATIONSHIP");
  return relationship;
}

/** The recipient's DINAR conversation for this thread: the one they used, else their inbox. */
async function deliveryConversation(tx: Tx, userId: string, marketId: string, preferred: string | null) {
  if (preferred) {
    const [owned] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, preferred), eq(conversations.ownerUserId, userId), eq(conversations.kind, "AI"), eq(conversations.marketId, marketId)));
    if (owned) return owned.id;
  }
  const [inbox] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.ownerUserId, userId), eq(conversations.kind, "AI"), eq(conversations.marketId, marketId), eq(conversations.title, INQUIRY_INBOX_TITLE)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  if (inbox) return inbox.id;
  const id = randomUUID();
  await tx.insert(conversations).values({ id, ownerUserId: userId, marketId, kind: "AI", title: INQUIRY_INBOX_TITLE });
  return id;
}

async function listingTitle(listingId: string, tx: Tx | typeof db = db) {
  const [row] = await tx.select({ data: offers.data }).from(offers).where(eq(offers.id, listingId));
  return typeof row?.data.title === "string" ? row.data.title : "الإعلان";
}

export type SubmitResult = { inquiryId: string; messageId: string; duplicate: boolean; deliveredConversationId: string | null; replied: boolean };

/**
 * Stores one message verbatim and delivers it in-app to the other party's DINAR conversation,
 * atomically. Idempotent per confirmed review (`actionId`): a repeated confirmation returns
 * the stored message. Rate-limited per actor; repeated identical or unanswered messages are refused.
 */
export async function submitInquiryMessage(input: {
  actionId: string;
  actorId: string;
  market: MarketRef;
  target: InquiryTarget;
  body: string;
  provenance: InquiryProvenance;
  originConversationId: string;
}): Promise<SubmitResult> {
  const problem = inquiryBodyProblem(input.body, input.target.kind === "LISTING" ? await listingTitle(input.target.listingId) : undefined);
  if (problem) throw fail(400, problem, "INVALID_BODY");
  if (containsPriceOffer(input.body)) throw fail(409, "الرسالة تتضمن عرض سعر؛ العروض المالية تُرسل عبر التفاوض لا عبر الاستفسار", "PRICE_OFFER");
  const messageId = `inq-${input.actionId}`;
  const [already] = await db.select({ conversationId: messages.conversationId }).from(messages).where(eq(messages.id, messageId));
  if (already) {
    const [inquiry] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.threadConversationId, already.conversationId));
    return { inquiryId: inquiry!.id, messageId, duplicate: true, deliveredConversationId: null, replied: false };
  }
  const limited = await consumeRateLimit([{ scope: AUTH_RATE_LIMIT_SCOPE.inquiryActor, value: input.actorId }], 3600, INQUIRIES_PER_HOUR).catch(() => ({ retryAfterSeconds: 60 }));
  if (limited) throw fail(429, `أرسلت رسائل كثيرة خلال وقت قصير. حاول بعد ${Math.max(1, Math.ceil(limited.retryAfterSeconds / 60))} دقيقة`, "RATE_LIMITED");
  const result = await db.transaction(async (tx) => {
    const relationship = await resolveRelationship(input.actorId, input.market, input.target, tx);
    const statuses = await userStatuses([relationship.buyerId, relationship.sellerId], tx);
    if (statuses.get(input.actorId) !== "ACTIVE") throw fail(403, "حسابك غير نشط حاليًا", "ACTOR_INACTIVE");
    const counterpartId = relationship.actorRole === "BUYER" ? relationship.sellerId : relationship.buyerId;
    const counterpartRole: InquiryRole = relationship.actorRole === "BUYER" ? "SELLER" : "BUYER";
    if (statuses.get(counterpartId) !== "ACTIVE") throw fail(409, `${ROLE_LABELS[counterpartRole]} غير متاح للمراسلة حاليًا`, "COUNTERPART_INACTIVE");
    if (await pairBlocked(relationship.buyerId, relationship.sellerId, tx)) throw fail(403, "المراسلة بينكما موقوفة بطلب أحد الطرفين", "BLOCKED");
    const now = new Date();
    let inquiry = relationship.inquiry
      ? (await tx.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, relationship.inquiry.id)).for("update"))[0]
      : undefined;
    if (inquiry && ["CLOSED", "BLOCKED"].includes(inquiry.status)) {
      if (input.target.kind === "INQUIRY") throw fail(409, inquiry.status === "BLOCKED" ? "المراسلة في هذا الاستفسار موقوفة" : "هذا الاستفسار مغلق؛ ابدأ استفسارًا جديدًا من الإعلان", "INQUIRY_CLOSED");
      inquiry = undefined;
    }
    if (!inquiry) {
      if (relationship.actorRole === "SELLER" && relationship.relationship === "LISTING_INQUIRY")
        throw fail(403, "لا يمكن للبائع بدء مراسلة إلا ضمن استفسار أو عرض سعر أو طلب قائم", "NO_RELATIONSHIP");
      const threadId = randomUUID();
      await tx.insert(conversations).values({ id: threadId, kind: "INQUIRY", marketId: relationship.marketId, ownerUserId: null, title: "استفسار" });
      const [created] = await tx
        .insert(marketplaceInquiries)
        .values({
          id: randomUUID(),
          threadConversationId: threadId,
          listingId: relationship.listingId,
          marketId: relationship.marketId,
          buyerId: relationship.buyerId,
          sellerId: relationship.sellerId,
          initiatorRole: relationship.actorRole,
          relationship: relationship.relationship,
          negotiationId: relationship.negotiationId ?? null,
          orderId: relationship.orderId ?? null,
          status: relationship.actorRole === "BUYER" ? "AWAITING_SELLER" : "AWAITING_BUYER",
          lastMessageAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) throw fail(409, "أُنشئ استفسار لهذا الإعلان للتو؛ أعد المحاولة", "CONCURRENT_INQUIRY");
      inquiry = created;
    }
    const thread = await tx
      .select({ senderId: messages.senderId, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, inquiry.threadConversationId))
      .orderBy(desc(messages.createdAt))
      .limit(20);
    const sinceReply = thread.findIndex((row) => row.senderId !== input.actorId);
    const unanswered = sinceReply === -1 ? thread.length : sinceReply;
    if (thread.slice(0, unanswered).some((row) => normalizedBody(row.body) === normalizedBody(input.body) && now.getTime() - row.createdAt.getTime() < DUPLICATE_WINDOW_MS))
      throw fail(409, "أرسلت الرسالة نفسها من قبل وما زالت بانتظار الرد؛ لم أكررها", "DUPLICATE_INQUIRY");
    if (unanswered >= MAX_UNANSWERED_MESSAGES)
      throw fail(429, `أرسلت ${MAX_UNANSWERED_MESSAGES} رسائل دون رد؛ انتظر رد ${ROLE_LABELS[counterpartRole]} قبل إرسال المزيد`, "TOO_MANY_UNANSWERED");
    const replied = inquiry.status === (relationship.actorRole === "SELLER" ? "AWAITING_SELLER" : "AWAITING_BUYER") && thread.length > 0;
    await tx.insert(messages).values({
      id: messageId,
      conversationId: inquiry.threadConversationId,
      senderId: input.actorId,
      body: input.body.trim(),
      actor: "USER",
      contentType: "TEXT",
      metadata: { inquiryId: inquiry.id, authorRole: relationship.actorRole, provenance: input.provenance, kind: replied ? "REPLY" : "MESSAGE" },
    });
    const event = (eventType: string, extra: Partial<typeof marketplaceInquiryEvents.$inferInsert> = {}) =>
      tx.insert(marketplaceInquiryEvents).values({ id: randomUUID(), inquiryId: inquiry!.id, messageId, eventType, actorRole: relationship.actorRole, actorId: input.actorId, ...extra });
    await event("INQUIRY_SUBMITTED", { detail: { provenance: input.provenance } });
    if (replied) await event("INQUIRY_REPLIED");
    // In-app delivery: a system-attributed card in the recipient's DINAR conversation.
    const recipientPreferred = counterpartRole === "SELLER" ? inquiry.sellerConversationId : inquiry.buyerConversationId;
    const recipientConversation = await deliveryConversation(tx, counterpartId, relationship.marketId, recipientPreferred);
    const title = await listingTitle(relationship.listingId, tx);
    const deliveredMessageId = randomUUID();
    const resultSetId = randomUUID();
    const lead = replied
      ? `ردّ ${ROLE_LABELS[relationship.actorRole]} على رسالتك بخصوص «${title}»:`
      : `وصلتك رسالة من ${ROLE_LABELS[relationship.actorRole]} بخصوص «${title}»:`;
    await tx.insert(messages).values({
      id: deliveredMessageId,
      conversationId: recipientConversation,
      actor: "ASSISTANT",
      body: `${lead}\n«${input.body.trim()}»\n— ${PROVENANCE_LABELS[input.provenance]}؛ نُقل كما هو دون تعديل من DINAR.`,
      contentType: "TEXT",
      // Delivered text is the other party's words: never fed back to the model as history.
      metadata: { inquiryDelivery: true, inquiryId: inquiry.id },
    });
    await tx.insert(aiResultSets).values({
      id: resultSetId,
      conversationId: recipientConversation,
      marketId: relationship.marketId,
      messageId: deliveredMessageId,
      query: { kind: "INQUIRY", ownerId: counterpartId, view: "INCOMING", inquiryId: inquiry.id },
      resourceIds: [inquiry.id],
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    });
    await tx.insert(aiUiBlocks).values({
      id: randomUUID(),
      conversationId: recipientConversation,
      messageId: deliveredMessageId,
      blockType: "SURFACE",
      version: 1,
      payload: { resultSetId, resourceIds: [inquiry.id], listings: [], surface: "INQUIRY_INCOMING", inquiry: { view: "INCOMING", inquiryId: inquiry.id } },
      ordinal: 0,
    });
    await tx.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, recipientConversation));
    await event("INQUIRY_DELIVERED", { actorRole: "SYSTEM", actorId: null, detail: { channel: "IN_APP", notification: NOTIFICATION_STATUS } });
    await tx
      .update(marketplaceInquiries)
      .set({
        status: relationship.actorRole === "BUYER" ? "AWAITING_SELLER" : "AWAITING_BUYER",
        lastMessageAt: now,
        updatedAt: now,
        ...(relationship.actorRole === "BUYER" ? { buyerConversationId: input.originConversationId, sellerConversationId: recipientConversation } : { sellerConversationId: input.originConversationId, buyerConversationId: recipientConversation }),
      })
      .where(eq(marketplaceInquiries.id, inquiry.id));
    return { inquiryId: inquiry.id, messageId, duplicate: false, deliveredConversationId: recipientConversation, replied };
  });
  logger.info({ event: "dinar_inquiry_submitted", replied: result.replied }, "inquiry message submitted");
  return result;
}

export async function inquiryForParty(actorId: string, inquiryId: string) {
  const [row] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, inquiryId));
  return row && (row.buyerId === actorId || row.sellerId === actorId) ? row : undefined;
}

/** Read receipt for the recipient: every message of the other party is marked READ once. */
export async function markInquiryRead(inquiry: InquiryRow, actorId: string) {
  const role: InquiryRole = inquiry.sellerId === actorId ? "SELLER" : "BUYER";
  const incoming = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, inquiry.threadConversationId), sql`${messages.senderId} is distinct from ${actorId}`));
  if (!incoming.length) return;
  await db
    .insert(marketplaceInquiryEvents)
    .values(incoming.map((row) => ({ id: randomUUID(), inquiryId: inquiry.id, messageId: row.id, eventType: "INQUIRY_READ", actorRole: role, actorId })))
    .onConflictDoNothing();
}

const STATUS_LABELS: Record<string, string> = {
  AWAITING_SELLER: "بانتظار رد البائع",
  AWAITING_BUYER: "بانتظار رد المشتري",
  CLOSED: "مغلق",
  BLOCKED: "المراسلة موقوفة",
};

/** One party's view, rebuilt from the thread on every read. */
export async function inquiryView(inquiry: InquiryRow, actorId: string, market: MarketRef) {
  const role: InquiryRole = inquiry.sellerId === actorId ? "SELLER" : "BUYER";
  const awaitingMe = (role === "SELLER" && inquiry.status === "AWAITING_SELLER") || (role === "BUYER" && inquiry.status === "AWAITING_BUYER");
  const [listing] = await db.select().from(offers).where(eq(offers.id, inquiry.listingId));
  const thread = await db
    .select({ id: messages.id, senderId: messages.senderId, body: messages.body, metadata: messages.metadata, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, inquiry.threadConversationId))
    .orderBy(messages.createdAt)
    .limit(60);
  const events = await db.select().from(marketplaceInquiryEvents).where(eq(marketplaceInquiryEvents.inquiryId, inquiry.id)).orderBy(marketplaceInquiryEvents.createdAt);
  const at = (messageId: string, type: string) => events.find((event) => event.messageId === messageId && event.eventType === type)?.createdAt.toISOString() ?? null;
  const available =
    listing?.inventoryMode === "LIMITED" ? Math.max(0, (listing.availableQuantity ?? 0) - listing.reservedQuantity) : null;
  return {
    inquiryId: inquiry.id,
    role,
    counterpartLabel: ROLE_LABELS[role === "BUYER" ? "SELLER" : "BUYER"],
    status: inquiry.status,
    // Phrased for the viewer: «بانتظار ردك» or «بانتظار رد البائع».
    statusLabel: awaitingMe ? "بانتظار ردك" : STATUS_LABELS[inquiry.status] ?? inquiry.status,
    awaitingMe,
    relationship: inquiry.relationship,
    listing: {
      id: inquiry.listingId,
      title: typeof listing?.data.title === "string" ? listing.data.title : "الإعلان",
      // A structured DINAR fact, labelled as such; never a promise.
      availableLabel: !listing ? null : available === null ? "كمية غير محدودة في سجل DINAR" : `${available} متاح الآن في سجل DINAR`,
    },
    messages: thread.map((row) => {
      const authorRole = (row.metadata.authorRole === "SELLER" ? "SELLER" : "BUYER") as InquiryRole;
      const provenance = (row.metadata.provenance as InquiryProvenance | undefined) ?? (authorRole === "SELLER" ? "SELLER_AUTHORED" : "BUYER_AUTHORED");
      const mine = row.senderId === actorId;
      return {
        id: row.id,
        authorRole,
        authorLabel: mine ? "أنت" : ROLE_LABELS[authorRole],
        mine,
        provenance,
        provenanceLabel: PROVENANCE_LABELS[provenance],
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        submittedAt: at(row.id, "INQUIRY_SUBMITTED"),
        deliveredAt: at(row.id, "INQUIRY_DELIVERED"),
        readAt: at(row.id, "INQUIRY_READ"),
      };
    }),
    notification: { status: NOTIFICATION_STATUS, label: "لا توجد إشعارات خارجية (رسائل SMS أو بريد أو إشعار هاتف) مفعّلة؛ تصل الرسالة إلى محادثة الطرف الآخر داخل DINAR ويراها عند فتحه." },
    privacyNote: "لا تُشارك أرقام الهواتف أو العناوين عبر الاستفسار. الاستفسار ليس عرض سعر ولا طلب شراء ولا يغيّر المخزون.",
    currencyCode: market.currencyCode,
  };
}
export type InquiryView = Awaited<ReturnType<typeof inquiryView>>;

/** The actor's threads in this market, the ones awaiting them first. */
export async function listInquiries(actorId: string, market: { id: string }, limit = 10) {
  const rows = await db
    .select()
    .from(marketplaceInquiries)
    .where(and(eq(marketplaceInquiries.marketId, market.id), or(eq(marketplaceInquiries.buyerId, actorId), eq(marketplaceInquiries.sellerId, actorId))))
    .orderBy(desc(marketplaceInquiries.lastMessageAt))
    .limit(30);
  const awaiting = (row: InquiryRow) => (row.sellerId === actorId ? row.status === "AWAITING_SELLER" : row.status === "AWAITING_BUYER");
  return rows.sort((a, b) => Number(awaiting(b)) - Number(awaiting(a))).slice(0, limit);
}

export async function closeInquiry(inquiry: InquiryRow, actorId: string, block = false) {
  const role: InquiryRole = inquiry.sellerId === actorId ? "SELLER" : "BUYER";
  const [row] = await db
    .update(marketplaceInquiries)
    .set({ status: block ? "BLOCKED" : "CLOSED", blockedByRole: block ? role : null, updatedAt: new Date() })
    .where(and(eq(marketplaceInquiries.id, inquiry.id), notInArray(marketplaceInquiries.status, ["CLOSED", "BLOCKED"])))
    .returning();
  if (!row) return false;
  await db.insert(marketplaceInquiryEvents).values({ id: randomUUID(), inquiryId: inquiry.id, eventType: block ? "INQUIRY_BLOCKED" : "INQUIRY_CLOSED", actorRole: role, actorId });
  return true;
}

/** The seller's recent relationships with buyers (for «اسأل المشتري …»), newest first. */
export async function sellerRelationships(sellerId: string, market: { id: string }) {
  const [threads, negotiationRows, orderRows] = await Promise.all([
    db.select().from(marketplaceInquiries).where(and(eq(marketplaceInquiries.sellerId, sellerId), eq(marketplaceInquiries.marketId, market.id), notInArray(marketplaceInquiries.status, ["CLOSED", "BLOCKED"]))).orderBy(desc(marketplaceInquiries.lastMessageAt)).limit(10),
    db.select({ id: negotiations.id, listingId: negotiations.listingId, buyerId: negotiations.buyerId, updatedAt: negotiations.updatedAt }).from(negotiations).where(and(eq(negotiations.sellerId, sellerId), eq(negotiations.marketId, market.id))).orderBy(desc(negotiations.updatedAt)).limit(10),
    db.select({ id: orders.id, buyerId: orders.buyerId, listingId: sql<string>`${orders.data} -> 'items' -> 0 ->> 'listingId'`, updatedAt: orders.updatedAt }).from(orders).where(and(eq(orders.sellerId, sellerId), eq(orders.marketId, market.id))).orderBy(desc(orders.updatedAt)).limit(10),
  ]);
  const covered = new Set(threads.map((row) => `${row.listingId}:${row.buyerId}`));
  return [
    ...threads.map((row) => ({ target: { kind: "INQUIRY" as const, inquiryId: row.id }, listingId: row.listingId, at: row.lastMessageAt })),
    ...negotiationRows.filter((row) => !covered.has(`${row.listingId}:${row.buyerId}`)).map((row) => ({ target: { kind: "NEGOTIATION" as const, negotiationId: row.id }, listingId: row.listingId, at: row.updatedAt })),
    ...orderRows.filter((row) => row.listingId && !covered.has(`${row.listingId}:${row.buyerId}`)).map((row) => ({ target: { kind: "ORDER" as const, orderId: row.id }, listingId: row.listingId, at: row.updatedAt })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
}

export function targetKey(target: InquiryTarget): string {
  return target.kind === "LISTING" ? `listing:${target.listingId}` : target.kind === "INQUIRY" ? `inquiry:${target.inquiryId}` : target.kind === "NEGOTIATION" ? `negotiation:${target.negotiationId}` : `order:${target.orderId}`;
}
export function parseTargetKey(key: string): InquiryTarget | undefined {
  const [kind, id] = key.split(/:(.+)/u);
  if (!id) return undefined;
  if (kind === "listing") return { kind: "LISTING", listingId: id };
  if (kind === "inquiry") return { kind: "INQUIRY", inquiryId: id };
  if (kind === "negotiation") return { kind: "NEGOTIATION", negotiationId: id };
  if (kind === "order") return { kind: "ORDER", orderId: id };
  return undefined;
}

export function bodyDigest(body: string) {
  return createHash("sha256").update(normalizedBody(body)).digest("hex").slice(0, 16);
}
