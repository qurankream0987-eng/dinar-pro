/**
 * Block F5 — publishing and resuming conversational listing drafts.
 *
 * Drafts stay conversation data (SELL blocks keyed by draftId). This adapter only adds
 * the two steps the shared runtime lacked: «انشره» opens an F0 PUBLISH_LISTING review
 * and «نعم» publishes through the Block B create authority (createListingForActor)
 * after re-reading the draft from server rows; «كمل الإعلان» brings an unfinished
 * draft back, and asks which one when there are several. Nothing is published without
 * the seller's explicit confirmation of the reviewed draft.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { aiResultSets, aiUiBlocks, conversations, db, users } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import { categorySchema, listMarketplaceCategories } from "../lib/marketplace-categories";
import { createListingForActor } from "../routes/marketplace";
import { confirmPendingAction, createPendingAction, proposeAction } from "./action-foundation";
import { findOrdinalMention, parseResultReference } from "./arabic-normalization";
import { ConversationDraft, buildDraftReview, promptForDraftStep } from "./listing-draft";
import { normalizeSearch } from "./search-context";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Draft = ReturnType<typeof ConversationDraft.parse>;

const PUBLISH = /^(?:نعم\s+)?(?:انشره|انشرها|انشر|انشر الاعلان|انشر العرض|نشر|نشر الاعلان|انشر المسوده)$/u;
// «كمل إعلاني / مسودتي», «نرجع للإعلان السابق», «خلينا نكمل المسودة» are the same request as
// «كمل الإعلان». Anchored on both ends: a sentence that merely mentions an ad passes on.
const RESUME =
  /^(?:(?:طيب|خلينا|خلنا|يلا|هيا|ممكن)\s+)?(?:كمل|اكمل|كملي|نكمل|لنكمل|تابع|نتابع|ارجع|نرجع|رجعنا|رجعني|نعود|عد|عودة|رجوع)\s*(?:لل|ل|الي|علي|في|بال|ب)?\s*(?:ال)?(?:اعلاني|اعلان|مسودتي|مسوده|عرضي|عرض|بيع)(?:\s+(?:السابق|القديم|الاول|الاخير)|\s+(?:اللي|الي|الذي)\s+(?:قبل|قبله|بديته|بداته|كان|بدات فيه))?$/u;
// «اعرض الإعلان قبل النشر», «راجع المسودة»: show the stored draft; it never publishes.
const REVIEW =
  /^(?:(?:اعرض|افتح|راجع|وريني|ورني|ارني|شوف)\s+(?:لي\s+)?)(?:ال)?(?:اعلان|اعلاني|مسوده|مسودة|مسودتي)(?:\s+قبل\s+(?:ال)?نشر(?:ه)?)?$/u;
/** «كمل الإعلان / كمل إعلاني» — for classifying a queued compound-request step. */
export const isDraftResumeRequest = (message: string) => RESUME.test(text(message));
const CONFIRM = /^(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نفذ|انشره|نعم انشر|تاكيد النشر)$/u;
const CANCEL = /^(?:لا|كلا|الغاء|الغ|الغي|تراجع|لا تنشر)$/u;
const CLOSED_STEPS = ["published", "cancelled", "choose_draft"];
const ORDINAL_WORDS = ["الأول", "الثاني", "الثالث", "الرابع"];

/** The draft choice as 2–4 quick replies; each sends the ordinal a user would type. */
function draftChoices(drafts: { draft: Draft }[]) {
  return drafts.length >= 2 && drafts.length <= 4
    ? { advice: { kind: "CLARIFICATION_REQUIRED", options: drafts.map((item, index) => ({ label: item.draft.title ?? `مسودة ${index + 1}`, message: ORDINAL_WORDS[index]! })) } }
    : {};
}

const text = (message: string) => normalizeSearch(message).replace(/[؟?!،,.]+/g, " ").replace(/\s+/g, " ").trim();

async function configured() {
  return (await listMarketplaceCategories()).map(categorySchema);
}

/** The newest stored block of each draft in this conversation, newest draft first. */
async function conversationDrafts(conversationId: string) {
  const rows = await db
    .select({ id: aiUiBlocks.id, payload: aiUiBlocks.payload, createdAt: aiUiBlocks.createdAt })
    .from(aiUiBlocks)
    .where(and(eq(aiUiBlocks.conversationId, conversationId), sql`${aiUiBlocks.payload}->'draft'->>'draftId' is not null`))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(200);
  const latest = new Map<string, { blockId: string; draft: Draft; step: string }>();
  for (const row of rows) {
    const parsed = ConversationDraft.safeParse(row.payload.draft);
    if (!parsed.success || !parsed.data.draftId || latest.has(parsed.data.draftId)) continue;
    latest.set(parsed.data.draftId, { blockId: row.id, draft: parsed.data, step: String(row.payload.draftStep ?? "") });
  }
  return [...latest.values()];
}

const open = (drafts: Awaited<ReturnType<typeof conversationDrafts>>) => drafts.filter((item) => !CLOSED_STEPS.includes(item.step));

/** The canonical create body for a draft: the same fields the seller form sends. */
export function draftCreateBody(draft: Draft, accountPhone?: string) {
  const inventoryMode = draft.inventoryMode ?? (draft.availableQuantity ? "LIMITED" : "UNLIMITED");
  return {
    title: draft.title ?? "",
    category: draft.category ?? "",
    ...(draft.categoryId ? { categoryId: draft.categoryId } : {}),
    description: draft.description ?? "",
    unitPrice: draft.unitPrice ?? null,
    pricingMode: draft.pricingMode === "FIXED" && draft.priceRepresentation === "STARTING_FROM"
      ? "OPEN_TO_OFFERS"
      : draft.pricingMode ?? "FIXED",
    ...(draft.priceRepresentation ? { priceRepresentation: draft.priceRepresentation } : {}),
    imageUrl: draft.imageUrl ?? "",
    imageUrls: draft.imageUrls ?? [],
    inventoryMode,
    availableQuantity: inventoryMode === "LIMITED" ? Number(draft.availableQuantity) : null,
    fulfilmentType: draft.fulfilmentType ?? "PICKUP",
    city: draft.city ?? "",
    area: draft.area ?? "",
    contactPhone:
      draft.contactPreference === "ACCOUNT_PHONE"
        ? (accountPhone ?? null)
        : draft.contactPreference === "LISTING_PHONE"
          ? (draft.contactPhone ?? null)
          : null,
    attributes: draft.attributes ?? {},
    ...(draft.paymentMethods?.length
      ? { paymentMethods: draft.paymentMethods }
      : {}),
    ...(draft.negotiable !== undefined ? { negotiable: draft.negotiable } : {}),
  };
}

/**
 * Re-reads a draft for its owner from server rows: the newest stored block of that draft
 * in one of the actor's own conversations. Version is the draft's content, so any later
 * edit voids a review while the review's own card does not.
 */
export async function readDraftSnapshot(actorId: string, draftId: string, tx: any = db) {
  const [[actor], [row]] = await Promise.all([
    tx.select({ status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actorId)),
    tx
      .select({ id: aiUiBlocks.id, payload: aiUiBlocks.payload, marketId: conversations.marketId, ownerId: conversations.ownerUserId })
      .from(aiUiBlocks)
      .innerJoin(conversations, eq(conversations.id, aiUiBlocks.conversationId))
      .where(and(eq(conversations.ownerUserId, actorId), sql`${aiUiBlocks.payload}->'draft'->>'draftId' = ${draftId}`))
      .orderBy(desc(aiUiBlocks.createdAt))
      .limit(1),
  ]);
  if (!actor || !row) return undefined;
  const parsed = ConversationDraft.safeParse(row.payload.draft);
  const step = String(row.payload.draftStep ?? "");
  const missing = parsed.success ? buildDraftReview(parsed.data, await configured()).missingFields.length : 1;
  return {
    snapshot: {
      actorStatus: actor.status,
      actorMarketId: actor.activeMarketId,
      resourceMarketId: row.marketId,
      resourceStatus: step === "published" ? "PUBLISHED" : step === "cancelled" ? "CANCELLED" : missing ? "INCOMPLETE" : "COMPLETE",
      ownerId: row.ownerId ?? "",
      unitPriceMinor: null,
      available: null,
      version: createHash("sha256").update(JSON.stringify(parsed.success ? parsed.data : row.payload.draft ?? null)).digest("hex"),
    },
    draft: parsed.success ? parsed.data : undefined,
  };
}

/** PUBLISH_LISTING execution: the reviewed draft, re-read, through the Block B authority. */
export async function publishDraft(input: { actionId: string; actorId: string; draftId: string }) {
  const read = await readDraftSnapshot(input.actorId, input.draftId);
  if (!read?.draft) throw Object.assign(new Error("المسودة غير موجودة"), { status: 404 });
  const [actor] = await db.select().from(users).where(eq(users.id, input.actorId));
  if (!actor) throw Object.assign(new Error("الحساب غير موجود"), { status: 404 });
  if (
    read.draft.contactPreference === "ACCOUNT_PHONE" &&
    (!actor.phoneVerified || !actor.normalizedPhone)
  )
    throw Object.assign(
      new Error("لا يمكن استخدام رقم الحساب قبل التحقق منه. أرسل رقمًا آخر أو اختر محادثة DINAR فقط."),
      { status: 409 },
    );
  // The reviewed action id is the publish idempotency key: a retry returns the same listing.
  const created = await createListingForActor(
    actor,
    draftCreateBody(read.draft, actor.normalizedPhone),
    input.actionId,
  );
  return { listingId: created.listing.id, title: created.listing.title };
}

function sellTurn(draft: Draft, step: string, prompt: string, extra: Partial<ToolResult> = {}): { tool: string; version: number; result: ToolResult } {
  return { tool: "openSurface", version: 1, result: { kind: "SURFACE", surface: "SELL", query: {}, listings: [], draft, draftStep: step, prompt, ...extra } };
}

/** Resume the exact seller draft interrupted by a tutorial, after rechecking its owner and market. */
export async function resumeConversationDraftById(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  draftId: string;
}) {
  const [[conversation], item] = await Promise.all([
    db.select({
      ownerUserId: conversations.ownerUserId,
      marketId: conversations.marketId,
    }).from(conversations).where(eq(conversations.id, input.conversationId)).limit(1),
    conversationDrafts(input.conversationId).then((drafts) =>
      open(drafts).find((candidate) => candidate.draft.draftId === input.draftId),
    ),
  ]);
  if (
    !conversation ||
    conversation.ownerUserId !== input.actorId ||
    conversation.marketId !== input.market.id ||
    !item
  ) return null;

  const categories = await configured();
  return sellTurn(
    item.draft,
    item.step || "review",
    `رجعنا إلى مسودة «${item.draft.title ?? "بدون عنوان"}». ${promptForDraftStep(item.step || "review", item.draft, categories)}`,
    { draftReview: buildDraftReview(item.draft, categories) },
  );
}

/**
 * Claims «انشره» on the draft in focus, decisions on the actor's own PUBLISH_LISTING
 * review, «كمل الإعلان», and the choice that follows it. Everything else passes on.
 */
export async function executeDraftActionTurn(input: { conversationId: string; message: string; market: Market; actorId?: string }) {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const said = text(input.message);
  const [latestSet] = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, input.conversationId), eq(aiResultSets.marketId, input.market.id)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const pending = latestSet?.query as { kind?: unknown; ownerId?: unknown; status?: unknown; action?: unknown; targetResource?: unknown } | undefined;
  const [latestBlock] = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, input.conversationId)).orderBy(desc(aiUiBlocks.createdAt)).limit(1);
  const reviewOpen =
    pending?.kind === "ACTION" && pending.ownerId === actorId && pending.status === "PENDING" && pending.action === "PUBLISH_LISTING" &&
    latestBlock?.payload.resultSetId === latestSet!.id;

  // ── The seller's decision on its own publish review.
  if (reviewOpen && (CONFIRM.test(said) || CANCEL.test(said))) {
    const draftId = String(pending!.targetResource);
    const read = await readDraftSnapshot(actorId, draftId);
    const outcome = await confirmPendingAction({ actionId: latestSet!.id, actorId, market: input.market, decision: CANCEL.test(said) ? "CANCEL" : "CONFIRM" });
    if (outcome.status === "CONFIRMED" && outcome.result?.listingId)
      return sellTurn(read!.draft!, "published", `تم نشر الإعلان «${String(outcome.result.title)}» عبر نموذج النشر نفسه بعد التحقق من البيانات الحالية. يظهر الآن في «إعلاناتي».`, {
        resourceId: String(outcome.result.listingId),
        resourceIds: [String(outcome.result.listingId)],
      });
    if (outcome.status === "CANCELLED")
      return sellTurn(read!.draft!, "review", "لم يُنشر الإعلان؛ بقيت المسودة كما هي. عدّلها أو قل «انشره» عندما تكون جاهزًا.");
    if (outcome.status === "REVIEW_REQUIRED") return reviewTurn(input, read!.draft!, outcome.review.actionId, "تغيّرت المسودة منذ المراجعة. ");
    return sellTurn(read?.draft ?? {}, "review", `لم يُنشر الإعلان: ${outcome.message}`);
  }

  // ── «انشره» on the draft in focus.
  const focused = latestBlock?.payload.surface === "SELL" && !CLOSED_STEPS.includes(String(latestBlock.payload.draftStep ?? "")) ? ConversationDraft.safeParse(latestBlock.payload.draft) : undefined;
  if (PUBLISH.test(said) && focused?.success && focused.data.draftId) {
    const draft = focused.data;
    const categories = await configured();
    const review = buildDraftReview(draft, categories);
    if (review.missingFields.length) {
      const step = String(latestBlock!.payload.draftStep ?? "review");
      return sellTurn(draft, step, `لا يمكن النشر بعد؛ ينقص: ${review.missingFields.map((field) => field.label).join("، ")}. ${promptForDraftStep(step, draft, categories)}`, { draftReview: review });
    }
    const action = await createPendingAction({ conversationId: input.conversationId, actorId, market: input.market, proposal: proposeAction({ action: "PUBLISH_LISTING", targetResource: draft.draftId! }) });
    return reviewTurn(input, draft, action.actionId);
  }

  // ── «كمل الإعلان»: bring back an unfinished draft; several mean a choice, never a guess.
  const reviewRequest = REVIEW.test(said);
  if (RESUME.test(said) || reviewRequest) {
    const drafts = open(await conversationDrafts(input.conversationId));
    // «اعرض الإعلان» without a draft is not about a draft; other handlers keep it.
    if (reviewRequest && !drafts.length) return null;
    if (!drafts.length) return sellTurn({}, "cancelled", "لا توجد مسودة إعلان غير مكتملة في هذه المحادثة. قل «أريد أبيع …» لبدء واحدة.");
    if (drafts.length === 1) return resumed(drafts[0]!);
    return sellTurn({}, "choose_draft", `لديك ${drafts.length} مسودات غير مكتملة: ${drafts.map((item, index) => `${index + 1}. «${item.draft.title ?? "بدون عنوان"}»`).join("، ")}. أي واحدة تكمل؟`, {
      resourceIds: drafts.map((item) => item.draft.draftId!),
      ...draftChoices(drafts),
    });
  }
  if (latestBlock?.payload.surface === "SELL" && latestBlock.payload.draftStep === "choose_draft") {
    const reference = parseResultReference(input.message) ?? findOrdinalMention(input.message);
    const ids = Array.isArray(latestBlock.payload.resourceIds) ? (latestBlock.payload.resourceIds as string[]) : [];
    if (reference?.kind === "INDEX") {
      const chosen = ids[reference.index];
      const draft = chosen ? open(await conversationDrafts(input.conversationId)).find((item) => item.draft.draftId === chosen) : undefined;
      if (!draft) return sellTurn({}, "choose_draft", `اختر رقمًا من المسودات الظاهرة (لديك ${ids.length}).`, { resourceIds: ids });
      return resumed(draft);
    }
  }
  return null;

  async function resumed(item: { draft: Draft; step: string }) {
    const categories = await configured();
    return sellTurn(item.draft, item.step || "review", `رجعنا إلى مسودة «${item.draft.title ?? "بدون عنوان"}». ${promptForDraftStep(item.step || "review", item.draft, categories)}`, {
      draftReview: buildDraftReview(item.draft, categories),
    });
  }
}

/**
 * G2 «رجعنا للجاكيت»: the open draft whose title names it, unchanged (same draftId, same
 * step). Several matches are a choice, never a guess; none passes on.
 */
export async function resumeNamedDraft(conversationId: string, name: string) {
  // «ساعة»/«ساعه»: the taa marbuta is folded on both sides before comparing.
  const fold = (value: string) => text(value).replace(/ة/g, "ه");
  const words = fold(name).split(" ").map((word) => word.replace(/^ال/u, "")).filter((word) => word.length >= 2);
  if (!words.length) return null;
  const drafts = open(await conversationDrafts(conversationId)).filter((item) => {
    const title = fold(item.draft.title ?? "");
    return words.every((word) => title.includes(word));
  });
  if (!drafts.length) return null;
  if (drafts.length > 1)
    return sellTurn({}, "choose_draft", `لديك ${drafts.length} مسودات بهذا الاسم: ${drafts.map((item, index) => `${index + 1}. «${item.draft.title ?? "بدون عنوان"}»`).join("، ")}. أي واحدة تقصد؟`, {
      resourceIds: drafts.map((item) => item.draft.draftId!),
      ...draftChoices(drafts),
    });
  const item = drafts[0]!;
  const categories = await configured();
  const step = item.step || "review";
  return sellTurn(item.draft, step, `رجعنا إلى مسودة «${item.draft.title ?? "بدون عنوان"}»؛ لم يُنشر شيء ولم يتغير فيها شيء. ${promptForDraftStep(step, item.draft, categories)}`, {
    draftReview: buildDraftReview(item.draft, categories),
  });
}

async function reviewTurn(input: { market: Market }, draft: Draft, actionId: string, lead = "") {
  const review = buildDraftReview(draft, await configured());
  const price = draft.unitPrice ? `${draft.unitPrice} ${input.market.currencyCode}` : "بالاتفاق";
  return sellTurn(
    draft,
    "publish_review",
    `${lead}هل تريد نشر الإعلان «${draft.title}» بسعر ${price}؟ سأتحقق من البيانات الحالية ثم أنشره عبر نموذج النشر نفسه. اكتب «نعم» للنشر أو «لا».`,
    { resultSetId: actionId, draftReview: review },
  );
}
