/**
 * Seller listing promotion inside the shared DINAR conversation runtime (Block E).
 *
 * Like employment and delivery, this is an intent adapter, not a second runtime: every
 * surface is an ordinary SURFACE block and every step an `ai_result_sets` row of kind
 * PROMOTION whose resourceIds are the server-issued ids the seller can refer to by
 * ordinal. Purchases are pending actions that only the same seller's explicit
 * confirmation applies, through the promotion authority in lib/promotions with the
 * simulated (TEST_NO_TRANSFER) payment adapter. The payload is rebuilt from live server
 * state on every read; the client only renders it.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, aiUiBlocks, conversations, db } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import {
  changePromotion,
  getSellerPromotion,
  listSellerPromotions,
  planView,
  promotableListings,
  promotionPlansForListing,
  purchasePromotion,
  reviewPromotion,
  SPONSORED_LABEL,
  type PromotionChange,
} from "../lib/promotions";
import { isPromotionFeatureEnabled } from "../lib/promotion-policy";
import { storedSponsoredIds } from "../lib/recommendations";
import { searchMarketplaceListings } from "../lib/marketplace-listings";
import { normalizeSearch } from "./search-context";
import { listMarketplaceCategories } from "../lib/marketplace-categories";
import { promotionProducts } from "@workspace/db";
import {
  findOrdinalMention,
  foldArabicLetters,
  normalizeDigits,
  parseResultReference,
} from "./arabic-normalization";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };
type StoredSet = typeof aiResultSets.$inferSelect;

export const PROMOTION_SURFACES = CONVERSATION_SURFACE_FAMILIES.promotion;
type PromotionSurface = (typeof PROMOTION_SURFACES)[number];

/** A review must be confirmed promptly and while it is still the latest card. */
export const PROMOTION_PENDING_TTL_MS = 10 * 60 * 1000;

const ActionStatus = z.enum(["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED", "REJECTED"]);
const PendingAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PURCHASE"), listingId: z.string().min(1), productId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("CANCEL"), promotionId: z.string().min(1) }).strict(),
]);
type PendingAction = z.infer<typeof PendingAction>;

const PromotionQuery = z
  .object({
    kind: z.literal("PROMOTION"),
    ownerId: z.string().min(1),
    view: z.enum(PROMOTION_SURFACES),
    step: z.enum(["LISTING", "PLAN", "INFO"]).optional(),
    listingId: z.string().min(1).optional(),
    promotionId: z.string().min(1).optional(),
    durationDays: z.number().int().min(1).max(365).optional(),
    action: PendingAction.optional(),
    status: ActionStatus.optional(),
    notice: z.string().max(600).optional(),
  })
  .strict();
type PromotionQuery = z.infer<typeof PromotionQuery>;

export function isPromotionQuery(query: unknown): boolean {
  return (query as { kind?: unknown } | null)?.kind === "PROMOTION";
}

export function promotionStateExpiry(query: unknown, now = Date.now()): Date | undefined {
  const parsed = PromotionQuery.safeParse(query);
  if (!parsed.success) return undefined;
  return new Date(now + (parsed.data.action ? PROMOTION_PENDING_TTL_MS : 30 * 24 * 60 * 60 * 1000));
}

// ─── Phrases ─────────────────────────────────────────────────────────────────

export function normalizePromotionText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;:.()«»"'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WANT = String.raw`(?:(?:انا\s+)?(?:اريد|ابي|ابغي|بدي|اود|ودي|حاب)\s+(?:ان\s+)?)?`;
const CAMPAIGN = String.raw`(?:ال)?(?:ترويج|حمله|اعلان المروج|اعلان الممول)`;
const PROMOTE = new RegExp(
  String.raw`^${WANT}(?:(?:روج|روجه|روجها|اروج|اروجه|ترويج|رقي|ميز|تمييز)(?:\s|$)|(?:اعلان|عرض)\s+(?:مميز|ممول|مروج)$)`,
  "u",
);
const PRICE = /(?:^|\s)(?:كم|ما|شو|ايش)\s+(?:هو\s+|هي\s+)?(?:سعر|اسعار|تكلفه|كلفه|خطط|باقات)\s+(?:ال)?ترويج|^(?:اسعار|خطط|باقات)\s+(?:ال)?ترويج$/u;
const MY = /^(?:(?:اعرض|افتح|شوف|وريني|ارني|اظهر)\s+)?(?:حملاتي|حملاتي الترويجيه|حملات الترويج|ترويجاتي|(?:اعلاناتي|عروضي) المروجه)$|^ما (?:هي )?(?:اعلاناتي|عروضي) المروجه$|^ما الذي يعمل الان$/u;
const PAUSE = new RegExp(String.raw`^(?:اوقف|وقف|ايقاف|اوقفي|علق)\s+${CAMPAIGN}(?:\s+(.*))?$`, "u");
const RESUME = new RegExp(String.raw`^(?:استانف|استئناف|كمل|شغل|اعد تشغيل|رجع)\s+${CAMPAIGN}(?:\s+(.*))?$`, "u");
const CANCEL_CAMPAIGN = new RegExp(String.raw`^(?:الغ|الغي|الغاء|احذف)\s+${CAMPAIGN}(?:\s+(.*))?$`, "u");
const DETAILS = new RegExp(String.raw`^(?:تفاصيل|افتح|اعرض)\s+${CAMPAIGN}(?:\s+(.*))?$`, "u");
const CONFIRM = /^(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نفذ|نعم اكد|اكد الترويج|تاكيد الترويج|ادفع|اكد الدفع|نعم ادفع)$/u;
const CANCEL = /^(?:لا|كلا|الغاء|الغ|الغي|تراجع|لا شكرا|الغاء الترويج)$/u;

const DAY_WORDS: Record<string, number> = {
  واحد: 1, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5, ست: 6, سته: 6,
  سبع: 7, سبعه: 7, عشر: 10, عشره: 10, اربعتعش: 14, اربعطعش: 14,
};

/**
 * Duration requested in a promotion command, and the text without it, so a number
 * of days is never read as a listing ordinal ("الإعلان الثاني لمدة 7 أيام").
 */
export function parsePromotionDuration(text: string): { days: number; rest: string } | undefined {
  const patterns: [RegExp, (match: RegExpMatchArray) => number][] = [
    [/(?:لمده\s+|مده\s+)?(\d{1,3})\s*(?:يوم|ايام|يوما)(?=\s|$)/u, (m) => Number(m[1])],
    [/(?:لمده\s+|مده\s+)?(\S+)\s+(?:ايام|يوما)(?=\s|$)/u, (m) => DAY_WORDS[m[1]!] ?? NaN],
    [/(?:لمده\s+|مده\s+)?يومين(?=\s|$)/u, () => 2],
    [/(?:لمده\s+|مده\s+)?(\d{1,2})\s*(?:اسبوع|اسابيع)(?=\s|$)/u, (m) => 7 * Number(m[1])],
    [/(?:لمده\s+|مده\s+)?اسبوعين(?=\s|$)/u, () => 14],
    [/(?:لمده\s+|مده\s+)?(?:ال)?اسبوع(?:\s+واحد)?(?=\s|$)/u, () => 7],
    [/(?:لمده\s+|مده\s+)?(\d{1,2})\s*(?:شهر|اشهر|شهور)(?=\s|$)/u, (m) => 30 * Number(m[1])],
    [/(?:لمده\s+|مده\s+)?شهرين(?=\s|$)/u, () => 60],
    [/(?:لمده\s+|مده\s+)?(?:ال)?شهر(?:\s+واحد)?(?=\s|$)/u, () => 30],
    [/(?:لمده\s+|مده\s+)يوم(?:\s+واحد)?(?=\s|$)|(?:^|\s)يوم واحد(?=\s|$)|^يوم$/u, () => 1],
  ];
  for (const [pattern, value] of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const days = value(match);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) continue;
    return { days, rest: text.replace(match[0], " ").replace(/\s+/g, " ").trim() };
  }
  return undefined;
}

/** Zero-based ordinal ("الثاني", "رقم 2", "الإعلان 2"); bare numbers need a noun. */
function ordinalIn(text: string): number | undefined {
  const whole = parseResultReference(text);
  if (whole?.kind === "INDEX") return whole.index;
  const numbered = text.match(/(?:^|\s)(?:رقم|الحمله|حمله|الترويج|الاعلان|العرض|المنتج|الخيار|الخطه)\s*(?:رقم\s*)?(\d{1,2})(?=\s|$)/u);
  if (numbered) {
    const value = Number(numbered[1]);
    return value >= 1 && value <= 24 ? value - 1 : undefined;
  }
  const mention = findOrdinalMention(text);
  return mention?.kind === "INDEX" ? mention.index : undefined;
}

// ─── State ───────────────────────────────────────────────────────────────────

function parseState(set: StoredSet | undefined, actorId: string): PromotionQuery | undefined {
  if (!set) return undefined;
  const parsed = PromotionQuery.safeParse(set.query);
  return parsed.success && parsed.data.ownerId === actorId ? parsed.data : undefined;
}

async function conversationSets(conversationId: string, marketId: string) {
  return db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(10);
}

const SellerContext = z.object({ kind: z.literal("SELLER_CONTEXT"), ownerId: z.string() }).strict();

// ─── Rendering ───────────────────────────────────────────────────────────────

const ACTION_MESSAGES: Record<string, string> = {
  PENDING: "بانتظار تأكيدك",
  CONFIRMED: "تم التنفيذ بعد تأكيدك",
  CANCELLED: "أُلغي دون أي تغيير",
  EXPIRED: "انتهت صلاحيته دون أي تغيير",
  REJECTED: "لم يُنفذ؛ لم يتغير شيء",
};

async function composePayload(
  state: PromotionQuery,
  resourceIds: string[],
  resultSetId: string,
  actorId: string,
  market: Market,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    view: state.view,
    ...(state.step ? { step: state.step } : {}),
    sponsoredLabel: SPONSORED_LABEL,
    paymentMode: "TEST_NO_TRANSFER",
    autoRenew: false,
  };
  if (state.notice) payload.notice = state.notice;
  if (state.action)
    payload.action = {
      actionId: resultSetId,
      type: state.action.type,
      status: state.status ?? "PENDING",
      statusLabel: ACTION_MESSAGES[state.status ?? "PENDING"],
    };
  try {
    if (state.view === "PROMOTION_OPTIONS" && state.step === "LISTING") {
      const live = await promotableListings(actorId, market);
      const byId = new Map(live.map((item) => [item.id, item]));
      payload.listings = resourceIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    } else if (state.view === "PROMOTION_OPTIONS" && state.step === "PLAN" && state.listingId) {
      const { listing, plans } = await promotionPlansForListing(actorId, market, state.listingId);
      const byId = new Map(plans.map((plan) => [plan.id, plan]));
      payload.listing = listing;
      payload.plans = resourceIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    } else if (state.view === "PROMOTION_OPTIONS" && state.step === "INFO") {
      payload.planGroups = await planGroups(market);
    } else if (state.view === "PROMOTION_REVIEW" && state.action?.type === "PURCHASE") {
      try {
        payload.review = await reviewPromotion({
          actorId,
          market,
          listingId: state.action.listingId,
          productId: state.action.productId,
        });
      } catch (error) {
        if ((state.status ?? "PENDING") === "PENDING") throw error;
        payload.notice = state.notice ?? ACTION_MESSAGES[state.status ?? "PENDING"];
      }
      if (state.promotionId)
        payload.promotion = await getSellerPromotion(actorId, market, state.promotionId);
    } else if (state.view === "MY_PROMOTIONS") {
      const all = await listSellerPromotions(actorId, market);
      const byId = new Map(all.map((item) => [item.id, item]));
      payload.promotions = resourceIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    } else if ((state.view === "PROMOTION_DETAILS" || state.view === "PROMOTION_STATUS") && state.promotionId) {
      payload.promotion = await getSellerPromotion(actorId, market, state.promotionId);
    }
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (!(typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)) throw error;
    payload.notice = `${error.message}.`;
    if (state.action && (state.status ?? "PENDING") === "PENDING")
      payload.action = { ...(payload.action as object), status: "REJECTED", statusLabel: ACTION_MESSAGES.REJECTED };
  }
  return payload;
}

async function planGroups(market: Market) {
  const [rows, categories] = await Promise.all([
    db
      .select()
      .from(promotionProducts)
      .where(and(eq(promotionProducts.marketId, market.id), eq(promotionProducts.enabled, true))),
    listMarketplaceCategories(),
  ]);
  const labels = new Map(categories.map((category) => [category.id, category.label]));
  const groups = new Map<string, ReturnType<typeof planView>[]>();
  for (const row of rows
    .filter((plan): plan is typeof plan & { categoryId: string } => plan.productType === "STANDARD_PROMOTION" && plan.categoryId !== null && plan.currencyCode === market.currencyCode && labels.has(plan.categoryId))
    .sort((a, b) => a.durationDays - b.durationDays || a.priceMinor - b.priceMinor || a.id.localeCompare(b.id))) {
    groups.set(row.categoryId, [...(groups.get(row.categoryId) ?? []), planView(row, market)]);
  }
  return [...groups.entries()].map(([categoryId, plans]) => ({
    categoryId,
    categoryLabel: labels.get(categoryId)!,
    plans,
  }));
}

async function turnFor(
  state: PromotionQuery,
  resourceIds: string[],
  prompt: string,
  actorId: string,
  market: Market,
): Promise<Turn> {
  const resultSetId = randomUUID();
  return {
    tool: "promotion",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: state.view,
      resultSetId,
      resourceIds,
      ...(state.listingId ? { resourceId: state.listingId } : {}),
      prompt,
      query: state,
      listings: [],
      promotion: await composePayload(state, resourceIds, resultSetId, actorId, market),
    },
  };
}

/** History reload: rebuild from the stored row and live server state. */
export async function refreshPromotionPayload(
  payload: Record<string, unknown>,
  context: { actorId: string; market: Market; query: unknown; resourceIds?: string[]; expiresAt?: Date | null },
): Promise<Record<string, unknown>> {
  const parsed = PromotionQuery.safeParse(context.query);
  if (!parsed.success || parsed.data.ownerId !== context.actorId) {
    const promotion = (payload.promotion ?? {}) as Record<string, unknown>;
    return { view: promotion.view ?? "PROMOTION_STATUS", notice: "انتهت صلاحية هذه البطاقة." };
  }
  let state = parsed.data;
  if (state.action && (state.status ?? "PENDING") === "PENDING" && context.expiresAt && context.expiresAt.getTime() <= Date.now())
    state = { ...state, status: "EXPIRED" };
  return composePayload(state, context.resourceIds ?? [], String(payload.resultSetId), context.actorId, context.market);
}

// ─── Applying pending actions ────────────────────────────────────────────────

export type PromotionActionOutcome = {
  status: "CONFIRMED" | "CANCELLED" | "EXPIRED" | "REJECTED";
  message: string;
  promotionId?: string;
};

/**
 * The single authority for confirming or cancelling a promotion action, from «نعم» or
 * the card button. Only the conversation owner, only while it is the latest card and
 * unexpired. A purchase uses the action id as its idempotency key, so repeated or
 * concurrent confirmations settle one campaign and one simulated payment.
 */
export async function applyPromotionAction(input: {
  actionId: string;
  actorId: string;
  market: Market;
  decision: "CONFIRM" | "CANCEL";
}): Promise<PromotionActionOutcome> {
  const checked = await db.transaction(async (tx) => {
    const [set] = await tx
      .select()
      .from(aiResultSets)
      .where(and(eq(aiResultSets.id, input.actionId), eq(aiResultSets.marketId, input.market.id)))
      .for("update")
      .limit(1);
    if (!set) throw Object.assign(new Error("الإجراء غير موجود"), { status: 404 });
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, set.conversationId), eq(conversations.ownerUserId, input.actorId), eq(conversations.kind, "AI")))
      .limit(1);
    const state = parseState(set, input.actorId);
    if (!conversation || !state?.action) throw Object.assign(new Error("الإجراء غير موجود"), { status: 404 });
    const settle = async (status: PromotionActionOutcome["status"], message: string, promotionId?: string) => {
      await tx
        .update(aiResultSets)
        .set({ query: { ...state, status, notice: message, ...(promotionId ? { promotionId } : {}) } })
        .where(eq(aiResultSets.id, set.id));
      return { done: { status, message, promotionId } as PromotionActionOutcome };
    };
    if (state.status && state.status !== "PENDING") {
      // A repeated confirmation of a purchase replays the same idempotent purchase below.
      if (state.status === "CONFIRMED" && input.decision === "CONFIRM")
        return { done: { status: "CONFIRMED" as const, message: state.notice ?? ACTION_MESSAGES.CONFIRMED, promotionId: state.promotionId } };
      return {
        done: {
          status: state.status as PromotionActionOutcome["status"],
          message: state.status === "EXPIRED" ? "انتهت صلاحية هذا الإجراء. لم يتغير شيء؛ اطلبه من جديد." : "تمت معالجة هذا الإجراء من قبل؛ لم يتغير شيء.",
          promotionId: state.promotionId,
        },
      };
    }
    const [newer] = await tx
      .select({ id: aiUiBlocks.id })
      .from(aiUiBlocks)
      .where(
        and(
          eq(aiUiBlocks.conversationId, set.conversationId),
          gt(aiUiBlocks.createdAt, sql`(select ${aiResultSets.createdAt} from ${aiResultSets} where ${aiResultSets.id} = ${set.id})`),
        ),
      )
      .limit(1);
    if ((set.expiresAt && set.expiresAt.getTime() <= Date.now()) || newer)
      return settle("EXPIRED", "انتهت صلاحية هذه المراجعة لأن المحادثة تابعت بعدها أو مضى وقتها. لم يتغير شيء؛ اطلبها من جديد.");
    if (input.decision === "CANCEL")
      return settle("CANCELLED", state.action.type === "PURCHASE" ? "أُلغي طلب الترويج. لم يُنشأ أي دفع أو حملة." : "تراجعت عن إلغاء الحملة. لم يتغير شيء.");
    return { state, setId: set.id };
  });
  if ("done" in checked) return checked.done!;
  const { state } = checked;
  const action = state.action!;
  let outcome: PromotionActionOutcome;
  try {
    if (action.type === "PURCHASE") {
      const purchase = await purchasePromotion({
        actorId: input.actorId,
        market: input.market,
        listingId: action.listingId,
        productId: action.productId,
        idempotencyKey: `promotion-action:${input.actionId}`,
      });
      const promotion = purchase.promotion;
      outcome =
        promotion.status === "ACTIVE"
          ? {
              status: "CONFIRMED",
              promotionId: promotion.id,
              message: `تم الدفع التجريبي (دون تحويل أموال حقيقية) وتفعيل ترويج «${promotion.listingTitle}» حتى ${new Date(promotion.expiresAt).toISOString().slice(0, 10)}. يظهر مع شارة «${SPONSORED_LABEL}» فقط عندما يطابق بحث المشتري.`,
            }
          : promotion.status === "PAYMENT_FAILED"
            ? { status: "REJECTED", promotionId: promotion.id, message: "فشل الدفع التجريبي، ولم يُفعّل الترويج." }
            : { status: "REJECTED", promotionId: promotion.id, message: "لم يُفعّل الترويج لأن العرض لم يعد مؤهلًا. لم تُحوّل أي أموال حقيقية." };
    } else {
      const result = await changePromotion({ actorId: input.actorId, market: input.market, promotionId: action.promotionId, action: "CANCEL" });
      outcome = {
        status: "CONFIRMED",
        promotionId: result.promotion.id,
        message: result.changed
          ? "أُلغيت الحملة. توقف ظهورها الممول فورًا، وبقي سجلها. لا استرداد حقيقي لأن الدفع تجريبي."
          : "الحملة ملغاة بالفعل؛ لم يتغير شيء.",
      };
    }
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (!(typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)) throw error;
    outcome = { status: "REJECTED", message: `${error.message}. لم يتغير شيء.` };
  }
  await db
    .update(aiResultSets)
    .set({
      query: {
        ...state,
        status: outcome.status,
        notice: outcome.message,
        ...(outcome.promotionId ? { promotionId: outcome.promotionId } : {}),
      },
    })
    .where(and(eq(aiResultSets.id, input.actionId), sql`${aiResultSets.query} ->> 'status' is distinct from 'CONFIRMED'`));
  return outcome;
}

// ─── Turn ────────────────────────────────────────────────────────────────────

export type PromotionTurnInput = {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
};

/** Authority rejections answer as a notice; nothing changes. */
export async function executePromotionTurn(input: PromotionTurnInput): Promise<Turn | null> {
  if (!input.actorId) return null;
  if (!isPromotionFeatureEnabled()) {
    const text = normalizePromotionText(input.message);
    return [PROMOTE, MY, PRICE, PAUSE, RESUME, CANCEL_CAMPAIGN, DETAILS].some((pattern) => pattern.test(text))
      ? notice(input.actorId, "الترويج المدفوع غير مفعّل في هذه البيئة. لم يتغير شيء.", input.market)
      : null;
  }
  try {
    return await promotionTurn(input as PromotionTurnInput & { actorId: string });
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)
      return notice(input.actorId, `${error.message}. لم يتغير شيء.`, input.market);
    throw error;
  }
}

function notice(actorId: string, prompt: string, market: Market) {
  return turnFor({ kind: "PROMOTION", ownerId: actorId, view: "PROMOTION_STATUS", notice: prompt }, [], prompt, actorId, market);
}

async function promotionTurn(input: PromotionTurnInput & { actorId: string }): Promise<Turn | null> {
  const { actorId, market } = input;
  const text = normalizePromotionText(input.message);
  const sets = await conversationSets(input.conversationId, market.id);
  const latestSet = sets[0];
  const latest = parseState(latestSet, actorId);

  // Decisions apply only to this adapter's own latest pending review.
  if (latest?.action && (latest.status ?? "PENDING") === "PENDING" && (CONFIRM.test(text) || CANCEL.test(text))) {
    const outcome = await applyPromotionAction({
      actionId: latestSet!.id,
      actorId,
      market,
      decision: CONFIRM.test(text) ? "CONFIRM" : "CANCEL",
    });
    if (outcome.promotionId)
      return turnFor({ kind: "PROMOTION", ownerId: actorId, view: "PROMOTION_STATUS", promotionId: outcome.promotionId, notice: outcome.message }, [outcome.promotionId], outcome.message, actorId, market);
    return notice(actorId, outcome.message, market);
  }

  if (MY.test(text)) return myPromotions(actorId, market);
  if (PRICE.test(text)) {
    const state: PromotionQuery = { kind: "PROMOTION", ownerId: actorId, view: "PROMOTION_OPTIONS", step: "INFO" };
    return turnFor(state, [], "هذه خطط الترويج المتاحة في سوقك. السعر ثابت من إدارة السوق ويظهر قبل أي تأكيد، والدفع تجريبي دون تحويل أموال.", actorId, market);
  }
  for (const [pattern, change] of [[PAUSE, "PAUSE"], [RESUME, "RESUME"], [CANCEL_CAMPAIGN, "CANCEL"], [DETAILS, "DETAILS"]] as const) {
    const match = text.match(pattern);
    if (match) return manage(change, match[1] ?? "", latest, latestSet, actorId, market);
  }

  // Follow-ups inside this adapter's own latest step.
  if (latest?.view === "PROMOTION_OPTIONS" && latest.step === "LISTING" && latestSet) {
    const index = ordinalIn(text);
    if (index !== undefined && (PROMOTE.test(text) || parseResultReference(text)))
      return choosePlan(latestSet.resourceIds[index], actorId, market, latest.durationDays);
  }
  if (latest?.view === "PROMOTION_OPTIONS" && latest.step === "PLAN" && latest.listingId && latestSet) {
    const duration = parsePromotionDuration(text);
    const index = duration ? undefined : parseResultReference(text)?.kind === "INDEX" ? ordinalIn(text) : undefined;
    if (duration || index !== undefined)
      return selectPlan(latest.listingId, latestSet.resourceIds, { durationDays: duration?.days, index }, actorId, market);
  }
  if (latest?.view === "MY_PROMOTIONS" && latestSet) {
    const reference = parseResultReference(text);
    if (reference?.kind === "INDEX") return manage("DETAILS", text, latest, latestSet, actorId, market);
  }

  if (!PROMOTE.test(text)) return null;
  const duration = parsePromotionDuration(text);
  const rest = duration?.rest ?? text;
  const index = ordinalIn(rest);
  if (index !== undefined) {
    // Ordinals refer to the seller's latest listing list (promotion picker or «إعلاناتي»).
    const context = sets.find((set) => {
      const state = parseState(set, actorId);
      return (state?.view === "PROMOTION_OPTIONS" && state.step === "LISTING") || SellerContext.safeParse(set.query).data?.ownerId === actorId;
    });
    const listingId = context?.resourceIds[index];
    if (!listingId)
      return listingPicker(actorId, market, duration?.days, "هذا الرقم غير موجود في قائمة إعلاناتك الحالية. اختر إعلانًا من القائمة.");
    return choosePlan(listingId, actorId, market, duration?.days);
  }
  return listingPicker(actorId, market, duration?.days);
}

async function listingPicker(actorId: string, market: Market, durationDays?: number, prompt?: string): Promise<Turn> {
  const listings = await promotableListings(actorId, market);
  const available = listings.filter((item) => !item.hasLivePromotion);
  if (available.length === 1 && !prompt) return choosePlan(available[0]!.id, actorId, market, durationDays);
  const state: PromotionQuery = {
    kind: "PROMOTION",
    ownerId: actorId,
    view: "PROMOTION_OPTIONS",
    step: "LISTING",
    ...(durationDays ? { durationDays } : {}),
  };
  return turnFor(
    state,
    listings.map((item) => item.id),
    prompt ??
      (listings.length
        ? "اختر الإعلان الذي تريد ترويجه (مثل «الثاني»). تظهر هنا إعلاناتك المنشورة والمؤهلة في سوقك الحالي فقط."
        : "لا توجد لديك إعلانات منشورة مؤهلة للترويج في سوقك الحالي."),
    actorId,
    market,
  );
}

async function choosePlan(listingId: string | undefined, actorId: string, market: Market, durationDays?: number): Promise<Turn> {
  if (!listingId) return listingPicker(actorId, market, durationDays, "اختر رقمًا ظاهرًا في قائمة إعلاناتك.");
  const { listing, plans } = await promotionPlansForListing(actorId, market, listingId);
  if (durationDays !== undefined) {
    const matching = plans.filter((plan) => plan.durationDays === durationDays);
    if (matching.length === 1) return review(listing.id, matching[0]!.id, actorId, market);
  }
  const state: PromotionQuery = { kind: "PROMOTION", ownerId: actorId, view: "PROMOTION_OPTIONS", step: "PLAN", listingId: listing.id };
  const prompt = !plans.length
    ? `لا توجد خطة ترويج مفعّلة لفئة «${listing.title}» في سوقك حاليًا.`
    : durationDays !== undefined
      ? `لا توجد خطة واحدة بمدة ${durationDays} ${durationDays === 1 ? "يوم" : "أيام"} لهذا الإعلان. اختر من الخطط المتاحة.`
      : `اختر مدة ترويج «${listing.title}» (مثل «أسبوع» أو «الأول»). السعر يحدده السوق ويظهر قبل التأكيد.`;
  return turnFor(state, plans.map((plan) => plan.id), prompt, actorId, market);
}

async function selectPlan(
  listingId: string,
  planIds: string[],
  choice: { durationDays?: number; index?: number },
  actorId: string,
  market: Market,
): Promise<Turn> {
  const { plans } = await promotionPlansForListing(actorId, market, listingId);
  const offered = planIds.flatMap((id) => plans.filter((plan) => plan.id === id));
  const picked =
    choice.index !== undefined
      ? offered[choice.index]
      : offered.filter((plan) => plan.durationDays === choice.durationDays).length === 1
        ? offered.find((plan) => plan.durationDays === choice.durationDays)
        : undefined;
  if (!picked) return choosePlan(listingId, actorId, market, choice.durationDays);
  return review(listingId, picked.id, actorId, market);
}

async function review(listingId: string, productId: string, actorId: string, market: Market): Promise<Turn> {
  const summary = await reviewPromotion({ actorId, market, listingId, productId });
  const state: PromotionQuery = {
    kind: "PROMOTION",
    ownerId: actorId,
    view: "PROMOTION_REVIEW",
    listingId,
    action: { type: "PURCHASE", listingId, productId },
    status: "PENDING",
  };
  return turnFor(
    state,
    [listingId],
    `راجع الترويج قبل التأكيد: «${summary.listingTitle}» — ${summary.plan.durationDays} ${summary.plan.durationDays === 1 ? "يوم" : "أيام"} بسعر ${summary.plan.priceLabel}. لم يُفعّل شيء بعد؛ اكتب «تأكيد» أو «إلغاء».`,
    actorId,
    market,
  );
}

async function myPromotions(actorId: string, market: Market, prompt?: string): Promise<Turn> {
  const promotions = await listSellerPromotions(actorId, market);
  const live = promotions.filter((item) => item.serving).length;
  return turnFor(
    { kind: "PROMOTION", ownerId: actorId, view: "MY_PROMOTIONS" },
    promotions.map((item) => item.id),
    prompt ??
      (promotions.length
        ? `حملاتك في السوق الحالي (${promotions.length})، منها ${live} تظهر الآن. يمكنك قول «أوقف الترويج الأول» أو «تفاصيل الحملة الثانية».`
        : "لا توجد لديك حملات ترويج في هذا السوق. قل «روّج إعلاني» للبدء."),
    actorId,
    market,
  );
}

async function manage(
  change: PromotionChange | "DETAILS",
  tail: string,
  latest: PromotionQuery | undefined,
  latestSet: StoredSet | undefined,
  actorId: string,
  market: Market,
): Promise<Turn> {
  const index = tail ? ordinalIn(tail) : undefined;
  let promotionId: string | undefined;
  if (index !== undefined) {
    // Ordinals resolve only against the seller's latest persisted campaign list.
    if (latest?.view !== "MY_PROMOTIONS" || !latestSet)
      return myPromotions(actorId, market, "اعرض حملاتك أولًا ثم اختر رقمًا ظاهرًا فيها. لم يتغير شيء.");
    promotionId = latestSet.resourceIds[index];
    if (!promotionId)
      return myPromotions(actorId, market, "هذا الرقم غير موجود في قائمة حملاتك. اختر رقمًا ظاهرًا فيها.");
  } else if (latest?.promotionId && (latest.view === "PROMOTION_DETAILS" || latest.view === "PROMOTION_STATUS")) {
    promotionId = latest.promotionId;
  } else {
    const all = await listSellerPromotions(actorId, market);
    const candidates = all.filter((item) =>
      change === "RESUME" ? item.canResume : change === "PAUSE" ? item.canPause : change === "CANCEL" ? item.canCancel : true,
    );
    if (candidates.length !== 1)
      return myPromotions(actorId, market, candidates.length ? "لديك أكثر من حملة. حدّد رقم الحملة من القائمة." : undefined);
    promotionId = candidates[0]!.id;
  }
  if (change === "DETAILS") {
    const promotion = await getSellerPromotion(actorId, market, promotionId);
    return turnFor({ kind: "PROMOTION", ownerId: actorId, view: "PROMOTION_DETAILS", promotionId }, [promotionId], `تفاصيل حملة «${promotion.listingTitle}».`, actorId, market);
  }
  if (change === "CANCEL") {
    const promotion = await getSellerPromotion(actorId, market, promotionId);
    if (!promotion.canCancel)
      return turnFor({ kind: "PROMOTION", ownerId: actorId, view: "PROMOTION_STATUS", promotionId }, [promotionId], "لا يمكن إلغاء هذه الحملة لأنها منتهية بالفعل. لم يتغير شيء.", actorId, market);
    return turnFor(
      { kind: "PROMOTION", ownerId: actorId, view: "PROMOTION_STATUS", promotionId, action: { type: "CANCEL", promotionId }, status: "PENDING" },
      [promotionId],
      `هل تريد إلغاء حملة «${promotion.listingTitle}»؟ يتوقف الظهور الممول فورًا ولا تُجدّد. الدفع تجريبي فلا يوجد استرداد حقيقي. اكتب «تأكيد» أو «لا».`,
      actorId,
      market,
    );
  }
  const result = await changePromotion({ actorId, market, promotionId, action: change });
  const prompt =
    change === "PAUSE"
      ? result.changed
        ? "أوقفت الحملة مؤقتًا. توقف ظهورها الممول فورًا، ولا تُمدد مدتها عند الاستئناف."
        : "الحملة موقوفة بالفعل؛ لم يتغير شيء."
      : result.changed
        ? "استؤنفت الحملة ضمن مدتها الأصلية دون تمديد."
        : "الحملة نشطة بالفعل؛ لم يتغير شيء.";
  return turnFor({ kind: "PROMOTION", ownerId: actorId, view: "PROMOTION_STATUS", promotionId, notice: prompt }, [promotionId], prompt, actorId, market);
}

export type { PromotionSurface };

// ─── «ليش هذا ممول؟» (Command C4) ────────────────────────────────────────────
const WHY_SPONSORED =
  /(?:^|\s)(?:ليش|لماذا|ليه|لم|شو\s+سبب|ما\s+سبب|وش\s+سبب|سبب)\s+(?:\S+\s+){0,4}(?:ممول|الممول|ممولة|الممولة|ممولين|ممولا)(?:\s|$)|(?:^|\s)(?:ليش|لماذا|ليه)\s+(?:يظهر|ظهر|طلع|يطلع)(?:\s+لي)?\s+(?:هذا|هذي|هالـ?)?\s*(?:الاعلان|اعلان)/u;

export function isSponsoredExplanationRequest(message: string): boolean {
  return WHY_SPONSORED.test(normalizeSearch(message).replace(/[؟?!.,،]/gu, " ").replace(/\s+/gu, " "));
}

/**
 * Explains a paid placement in the buyer's current results from the stored result set and
 * the placement rules searchMarketplaceListings enforces. It never names a buyer profile,
 * because placement does not use one.
 */
export async function explainSponsoredPlacement(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  if (!input.actorId || !isSponsoredExplanationRequest(input.message)) return null;
  const sets = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, input.conversationId), eq(aiResultSets.marketId, input.market.id)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(10);
  const latest = sets.find((set) => typeof (set.query as { search?: unknown }).search === "string");
  const sponsored = latest ? storedSponsoredIds(latest.query) : [];
  const titles = sponsored.length
    ? (await searchMarketplaceListings(input.market, { search: "", allowedIds: sponsored, limit: sponsored.length, sponsoredPlacement: false })).map((listing) => listing.title)
    : [];
  const search = latest ? String((latest.query as { search?: unknown }).search ?? "").trim() : "";
  const prompt = !latest
    ? "لا توجد نتائج بحث في هذه المحادثة لأشرح سبب ظهورها."
    : !titles.length
      ? "لا يوجد عرض ممول في نتائجك الحالية؛ كل ما تراه نتائج عادية مرتبة حسب طلبك."
      : [
          `${titles.map((title) => `«${title}»`).join("، ")} ${titles.length === 1 ? "يظهر" : "تظهر"} بشارة «ممول» لأن البائع دفع لإبرازه، وذلك فقط لأنه يطابق طلبك${search ? ` «${search}»` : ""} في هذا السوق (التصنيف والشروط والتوفر).`,
          "• عدد الخانات الممولة محدود، والنتائج العادية بعدها بترتيبها الطبيعي.",
          "• الدفع لا يجعل العرض «الأفضل» ولا يدخل في توصياتي.",
          "• عند ترتيب تختاره أنت، مثل الأرخص أولًا، لا يُرفع أي عرض ممول.",
          "• الإبراز لا يستخدم ملفك الشخصي أو ذكرياتك المحفوظة؛ يعتمد على طلبك الحالي فقط.",
        ].join("\n");
  return {
    tool: "smartConversation",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "ADVICE",
      resultSetId: randomUUID(),
      query: { kind: "CONVERSATION", ownerId: input.actorId },
      listings: [],
      advice: { kind: "GROUNDED_ADVICE", scope: "DINAR_INTERNAL", topic: "SPONSORED_PLACEMENT", sponsoredCount: titles.length },
      prompt,
    },
  };
}
