/**
 * G2 — price negotiation inside the shared DINAR conversation runtime.
 *
 * An adapter, not an agent: every price the user names becomes an F0 review first
 * (SEND_NEGOTIATION_OFFER, COUNTER_NEGOTIATION, ACCEPT_NEGOTIATION, REJECT_NEGOTIATION)
 * and only the user's explicit confirmation runs the negotiation authority after it
 * re-reads current state. Listings are resolved from server rows (the opened result,
 * an ordinal of the persisted result set, the negotiation in view), never from text
 * IDs. Parties see only their own negotiations; DINAR never bargains on its own.
 */
import { and, desc, eq } from "drizzle-orm";
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, aiUiBlocks, db, offers } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import { parseListingPriceMinor } from "../lib/listing-management";
import {
  effectiveStatus,
  listingNegotiable,
  negotiationForParty,
  negotiationView,
  negotiationsFor,
  offerPreconditions,
  roleOf,
} from "../lib/negotiations";
import { priceRepresentationOf } from "@workspace/api-zod/listing-pricing";
import { confirmPendingAction, createPendingAction, parseCommandNumbers, proposeAction, resolveReference, type ActionReview } from "./action-foundation";
import { normalizeBuyerText, notice, purchaseReviewTurn } from "./buyer-turn";
import { hasActiveListingDraft } from "./listing-draft";
import { isBareShowNumber, priceProposal } from "./price-proposal";
import { namesPrice, priceEdit, quoteRequest, statusQuestion } from "./context-intent";
import { reviewListingPriceChange } from "./seller-management";
import { findOrdinalMention, normalizeNumberWords } from "./arabic-normalization";
import type { ToolResult } from "./tool-registry";
import { randomUUID } from "node:crypto";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

export const NEGOTIATION_SURFACES = CONVERSATION_SURFACE_FAMILIES.negotiation;
const NEGOTIATION_ACTIONS = ["SEND_NEGOTIATION_OFFER", "REQUEST_BEST_PRICE", "COUNTER_NEGOTIATION", "ACCEPT_NEGOTIATION", "REJECT_NEGOTIATION", "WITHDRAW_NEGOTIATION"] as const;
type NegotiationAction = (typeof NEGOTIATION_ACTIONS)[number];

const NUMBER = "(\\d+(?:\\.\\d+)?)";
/** A buyer naming a price for a listing: «أعطيه 7», «تسويها بـ15؟», «غالي، أعطيه 7». */
// «اخذه 2» or «ادفع 50» alone are a quantity or a payment, so those verbs need «بـ».
const BUYER_OFFER = new RegExp(
  `(?:^|\\s)(?:(?:قدم عرض سعر|قدم عرضا|قدم عرض|اعطيه|اعطيها|عطيه|عطيها|اعطه|عطه|اعرض عليه|اعرض عليها|اعرض علي البائع|اعرض علي البايع|اعرض للبائع|اعرض للبايع|ادفع فيه|تسويه|تسويها|تسويهم|تبيعه|تبيعها|تبيعني|تبيعنيه|تبيعنيها|تخليه|تخليها|يبيعه|يبيعها|يسويها|ينزل|تنزل|بعرض)(?:\\s+(?:لي|له|لها|علي|عليه))?\\s*(?:ب\\s*)?|(?:اخذه|اخذها|اشتريه|اشتريها|ادفع|ادفعله|ادفعلها)(?:\\s+(?:لي|له|لها))?\\s*ب\\s*)${NUMBER}(?=\\s|$)`,
  "u",
);
/** «اسأل البائع إذا يوافق على 17»: a proposal phrased as a question to the seller. */
const BUYER_ASK_AT = new RegExp(
  `(?:^|\\s)(?:اسال|اساله|اسالي)(?:\\s+(?:البائع|البايع))?\\s+(?:اذا|لو|هل)\\s+(?:يوافق|يقبل|يرضي|يبيعه|يبيعها|يبيع)\\s+(?:علي|ب)\\s*(?:ب\\s*)?${NUMBER}(?=\\s|$)`,
  "u",
);
/** «قل له أوافق على 85»: the party names the amount it agrees to; equal to the one on the table it is an acceptance. */
const AGREE_AT = new RegExp(
  `(?:^|\\s)(?:قله|قل له|قوله|قولي له|قولله|بلغه|اخبره)\\s+(?:اني\\s+|انا\\s+)?(?:اوافق|موافق|اقبل|ارضي)\\s+(?:علي|ب)\\s*(?:ب\\s*)?${NUMBER}(?=\\s|$)`,
  "u",
);
/** «وافق على عرض المشتري بـ80»: an acceptance that names its amount, which must be the one on the table. */
const ACCEPT_AT = new RegExp(
  `^(?:نعم\\s+)?(?:اقبل|وافق|موافق|اوافق)\\s+(?:علي\\s+)?(?:العرض|عرض|عرضه|عرضها)(?:\\s+(?:المشتري|البائع|البايع))?\\s*(?:ب\\s*)?${NUMBER}$`,
  "u",
);
/** «هذا السعر لا يناسبني»: dissatisfaction, which is neither a rejection nor a counter on its own. */
const PRICE_UNSUITABLE = /(?:^|\s)(?:السعر|العرض|المبلغ)\s+(?:لا|ما|مو|مش)\s+(?:يناسبني|يناسب|ينفعني|ينفع)(?:\s|$)|(?:^|\s)(?:السعر|العرض)\s+غير\s+مناسب(?:\s|$)/u;
/** «عرض مقابل» without an amount (the status-card button): ask for the amount, change nothing. */
const COUNTER_PROMPT = /^(?:(?:اريد|ابي|بدي|ابغي)\s+)?(?:ارسال|ارسل|اعطي|اعطه)?\s*(?:عرض|عرضا)\s+(?:مقابل|مقابلا|مضاد|مضادا)$/u;
/** «أريد أتفاوض على …», «قدّم عرض سعر», «تفاوض مع البائع»: an intent to negotiate without an amount. */
const NEGOTIATE_INTENT = /(?:^|\s)(?:اريد|ابي|ابغي|بدي|حاب|ودي)\s+(?:ا|ن)?تفاوض(?:\s|$)|^(?:قدم|قدم لي)\s+عرض\s+سعر(?:\s+علي\s+(?:ال)?(?:اعلان|عرض)\s+رقم\s+\d{1,2})?$|^تفاوض\s+مع\s+(?:البائع|البايع)$/u;
const PRICE_COMPLAINT = new RegExp(`(?:^|\\s)(?:غالي|غاليه|كثير|مبالغ)(?:\\s|$).*?(?:ب\\s*)?${NUMBER}(?=\\s|$)`, "u");
/** The seller's counter: «قله 8 آخر سعر», «عرض مضاد 8», «8 آخر سعر». */
const SELLER_COUNTER = new RegExp(
  `(?:^|\\s)(?:قله|قل له|قوله|قولي له|قولله|رد عليه|رد عليها|عرض مضاد|عرض مقابل|عرضا مقابلا|اعرض عليه|اعرض عليها|اعطيه|عطيه|اعطه|عطه|خله|خليه)\\s*(?:ب\\s*)?${NUMBER}(?=\\s|$)|(?:^|\\s)(?:اعطه|اعطيه|عطه|عطيه|ارسل له|ارسل)\\s+(?:عرضا|عرض)\\s+(?:مقابلا|مقابل|مضادا|مضاد)\\s*(?:ب\\s*)?${NUMBER}(?=\\s|$)|(?:^|\\s)${NUMBER}\\s+(?:اخر سعر|نهائي|اخر شي)(?=\\s|$)`,
  "u",
);
const ACCEPT = /^(?:نعم\s+)?(?:اقبل|اقبله|اقبلها|قبول|موافق|اوافق|قبلت|وافق)(?:\s+(?:علي|على|العرض|عرضه|عرضها|السعر))*(?:\s+\S+)?$/u;
const REJECT = /^(?:ارفض|ارفضه|ارفضها|رفض|لا اقبل|ما اقبل|ما ابي اقبل)(?:\s+(?:العرض|عرضه|عرضها))*(?:\s+\S+)?$/u;
const SELLER_LIST = /(?:^|\s)(?:هل\s+)?(?:عندي|وصلني|وصلتني|جاني|جاتني)\s+(?:اي\s+)?عروض(?:\s+(?:اسعار|سعر|جديده|علي اعلاناتي|على اعلاناتي))?(?:\s|$)|(?:^|\s)عروض (?:الاسعار|اسعار) (?:اللي|الي) (?:وصلت|جات|جاتني)|^(?:اعرض|وريني|شوف)\s+عروض\s+(?:السعر|الاسعار|المشترين)$/u;
const BUYER_LIST = /^(?:اعرض|وريني|شوف)\s+(?:عروضي|عروض اسعاري)$|(?:وش|شو|ايش|شنو|ماذا) صار (?:علي|على|ب|في|مع) (?:عرضي|عروضي)|(?:^|\s)رد البائع(?:\s|$)|حاله عرضي|(?:^|\s)عروضي على الاسعار|(?:^|\s)عروض اسعاري|(?:^|\s)(?:البائع|البايع) (?:رد|وافق|رفض)/u;
const CONFIRM = /^(?:نعم|اكيد|اكد|تاكيد|ارسل|ارسله|ارسلها|ارسل العرض|ارسال العرض|موافق|اوافق|تمام|اوكي|نفذ|اقبل|قبول|ok|yes)(?:\s+(?:علي|على)\s*\d+(?:\.\d+)?)?$/u;
const CANCEL = /^(?:لا|كلا|الغاء|الغ|الغي|تراجع|لا ترسل|الغاء العرض)$/u;
const WITHDRAW_REQUEST = /^(?:اسحب عرضي|اسحب العرض|اسحب عرضي المقابل|اسحب العرض المقابل|سحب العرض|الغي عرضي|الغ عرضي|تراجع عن عرضي)$/u;
const EDIT = /^(?:تعديل|عدل|عدله|غير المبلغ|عدل المبلغ)$/u;
const AMOUNT_ONLY = new RegExp(`^(?:(?:خله|خليه|خليها|خلها|خل|اجعله|خلي العرض|العرض|عرض مضاد)\\s+)?(?:ب\\s*)?${NUMBER}$`, "u");
const ORDER_NOW = /^(?:اطلبه|اطلبها|اطلب|اشتريه|اشتريها|خذه|خذها|اطلبه الان|اطلبه الحين|كمل الطلب|اكمل الطلب)$/u;
const BEST_PRICE_REQUEST =
  /(?:اساله|اسال البائع|قله|قل له).{0,24}(?:اخر(?:\s+سعر)?|السعر النهائي|سعره النهائي|كم\s+طالب(?:\s+فيه)?|كم\s+يطلب)|^(?:وش|كم)\s+(?:اخر(?:ه|\s+سعر)?|السعر النهائي|طالب(?:\s+فيه)?)|^(?:(?:يا\s+)?دينار\s+)?(?:اطلب|اطلب لي|اسال عن|ابي|ابغي|بدي|شو|ايش)\s+(?:اخر|افضل|احسن)\s+سعر|(?:^|\s)(?:اطلب|اطلب لي|ابي|ابغي|بدي|اريد)\s+تسعيره(?:\s|$)/u;
/**
 * «كم تكلفة الخدمة»: a quotation request only about the listing in view. Without one it is a
 * general cost question («كم تكلف منظومة صغيرة؟», «كم تكلفة برو؟») and is left to other handlers.
 */
const QUOTE_COST = /(?:^|\s)(?:(?:اريد|ابي|بدي|ابغي)\s+(?:ا|ن)?عرف\s+)?كم\s+(?:تكلفه|تكلف|يكلف|سعر)\s+(?:الخدمه|هذه الخدمه|هذا|هذي|هذه|العرض|الاعلان)(?:\s|$)/u;
/**
 * «ماذا لو كان السعر أقل بـ10%؟», «لو أرخص بـ5», «كم يصير بعد خصم 15%»: arithmetic on the
 * listed price, nothing more. «أقل من 10» is a budget and «ينزل 7» an offer, so «بـ» is required
 * after أقل/أرخص/أنقص.
 */
const HYPOTHETICAL = new RegExp(
  `(?:(?:^|\\s)(?:لو|اذا)\\s+(?:\\S+\\s+){0,4}?(?:(?:اقل|ارخص|انقص)\\s*ب\\s*|(?:ب)?خصم\\s+(?:ب\\s*)?)|(?:^|\\s)(?:بعد|مع)\\s+(?:ال)?خصم\\s+(?:ب\\s*)?)${NUMBER}\\s*(%|٪|بالميه|في الميه|بالمئه|في المئه)?(?=\\s|$|%|٪)`,
  "u",
);
/** «أرسل عرضًا بهذا السعر»: the amount is the calculation in view, never a guess. */
const SEND_HYPOTHETICAL = /^(?:(?:نعم|طيب|تمام|اوكي)\s+)?(?:ارسل|ارسله|قدم|اعرض)(?:\s+(?:له|لها|عليه|عليها|للبائع))?(?:\s+(?:عرضا|عرض|العرض))?\s+(?:بهذا|بهاد|بهالسعر|بنفس)(?:\s+(?:السعر|المبلغ|الرقم))?$/u;
/** «أرسل العرض» with no amount: it names whatever offer is in view, never a new one. */
const SEND_OFFER_IN_VIEW = /^(?:(?:نعم|طيب|تمام|اوكي)\s+)?(?:ارسل|ارسله|قدم)(?:\s+(?:له|لها|للبائع))?\s+(?:العرض|عرضي)(?:\s+للبائع)?$/u;
const DECIMAL_MARKER = "";

function normalizeNegotiationText(message: string): string {
  return normalizeBuyerText(
    message.replace(/([0-9٠-٩۰-۹])[.٫]([0-9٠-٩۰-۹])/gu, `$1${DECIMAL_MARKER}$2`),
  )
    .replaceAll(DECIMAL_MARKER, ".")
    // «دينار، وافق على …» addresses the assistant; the command is what follows.
    .replace(/^(?:يا\s+)?دينار\s+/u, "");
}

export function isBestPriceRequest(message: string): boolean {
  return BEST_PRICE_REQUEST.test(normalizeNegotiationText(message));
}

const money = (minor: number, market: Market) => `${(minor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale)} ${market.currencyCode}`;

async function latestSet(conversationId: string, marketId: string) {
  const [set] = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  return set;
}

// A conversational reply (an answer, a clarification) does not move the listing in focus.
const NON_FOCUS_SURFACES = new Set(["ADVICE", "CLARIFY"]);
const FOCUS_LOOKBACK = 4;

async function focusBlockPayload(conversationId: string) {
  const blocks = await db
    .select({ payload: aiUiBlocks.payload, blockType: aiUiBlocks.blockType })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(FOCUS_LOOKBACK);
  return blocks.find((block) => {
    const payload = block.payload as { surface?: unknown; resourceId?: unknown };
    // An inquiry notice that is not about a listing (e.g. «nothing to send») keeps the earlier focus.
    const listingless = String(payload.surface).startsWith("INQUIRY_") && typeof payload.resourceId !== "string";
    return !(block.blockType === "SURFACE" && (NON_FOCUS_SURFACES.has(String(payload.surface)) || listingless));
  });
}

async function latestBlockPayload(conversationId: string) {
  const [block] = await db
    .select({ payload: aiUiBlocks.payload, blockType: aiUiBlocks.blockType })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  return block;
}

/** The listing the buyer is looking at: a named position, «هذا», an opened result or a review in view. */
export async function focusedListing(input: { conversationId: string; market: Market; actorId: string; message: string }): Promise<string | undefined> {
  const reference = await resolveReference({ conversationId: input.conversationId, marketId: input.market.id, actorId: input.actorId, message: input.message });
  if (reference) return reference.resourceId;
  const block = await focusBlockPayload(input.conversationId);
  const payload = (block?.payload ?? {}) as Record<string, unknown>;
  if (block?.blockType === "LISTING_RESULTS") {
    const ids = Array.isArray(payload.resourceIds) ? (payload.resourceIds as string[]) : [];
    if (payload.presentation === "DETAILS" || ids.length === 1) return ids[0];
    return undefined;
  }
  if (payload.surface === "PURCHASE_REVIEW" && typeof payload.resourceId === "string") return payload.resourceId;
  // NEXT G2: an inquiry card about a listing keeps that listing in focus.
  if (String(payload.surface).startsWith("INQUIRY_") && typeof payload.resourceId === "string") return payload.resourceId;
  const negotiation = payload.negotiation as { listingId?: unknown; role?: unknown } | undefined;
  if (negotiation?.role === "BUYER" && typeof negotiation.listingId === "string") return negotiation.listingId;
  return undefined;
}

function amountIn(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  const raw = match?.slice(1).find((value) => value !== undefined);
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function reviewTurn(review: ActionReview, view: Record<string, unknown>, prompt: string, action: NegotiationAction): Turn {
  return {
    tool: "negotiation",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "NEGOTIATION_REVIEW",
      resultSetId: review.actionId,
      resourceIds: [review.targetResource],
      query: {},
      listings: [],
      negotiation: {
        // The negotiation's own facts first; the review's identity and PENDING status win.
        ...view,
        ...(typeof view.status === "string" ? { negotiationStatus: view.status } : {}),
        view: "REVIEW",
        action,
        actionId: review.actionId,
        status: "PENDING",
        lines: review.lines,
        expiresAt: review.expiresAt,
        actions: action === "SEND_NEGOTIATION_OFFER" ? ["SEND", "EDIT", "CANCEL"] : ["CONFIRM", "CANCEL"],
      },
      prompt,
    },
  };
}

async function statusTurn(negotiationId: string, actorId: string, prompt: string): Promise<Turn> {
  const row = await negotiationForParty(actorId, negotiationId);
  const view = row ? await negotiationView(row, actorId) : null;
  return {
    tool: "negotiation",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "NEGOTIATION_STATUS",
      resourceIds: [negotiationId],
      resourceId: negotiationId,
      query: {},
      listings: [],
      negotiation: { view: "STATUS", ...(view ?? { negotiationId, status: "UNAVAILABLE" }) },
      prompt,
    },
  };
}

async function guarded<T>(work: () => Promise<T>): Promise<T | Turn> {
  try {
    return await work();
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500 && error instanceof Error) return notice(`${error.message}. لم يُرسل أي عرض ولم يتغير شيء.`);
    throw error;
  }
}
const isTurn = (value: unknown): value is Turn => Boolean(value && typeof value === "object" && "result" in (value as object) && "tool" in (value as object));

/** The buyer's offer review: nothing is sent until the buyer confirms it. */
async function offerReview(input: { conversationId: string; market: Market; actorId: string }, listingId: string, amount: number, quantity: number, lead = ""): Promise<Turn> {
  const amountMinor = (() => {
    try {
      return parseListingPriceMinor(String(amount), input.market.currencyCode);
    } catch {
      return undefined;
    }
  })();
  if (amountMinor === undefined) return notice("المبلغ غير صالح. اكتب مبلغًا مثل «أعطيه 7».");
  const pre = await offerPreconditions({ buyerId: input.actorId, listingId, amountMinor, quantity, market: input.market });
  if (pre.problem) return notice(`${pre.problem}. لم يُرسل أي عرض.`);
  const review = await guarded(() =>
    createPendingAction({
      ...input,
      proposal: proposeAction({
        action: "SEND_NEGOTIATION_OFFER",
        targetResource: listingId,
        facts: { amountMinor: [{ value: amountMinor, source: "USER_DECLARED" }], quantity: [{ value: quantity, source: quantity > 1 ? "USER_DECLARED" : "DINAR_DERIVED" }] },
      }),
    }),
  );
  if (isTurn(review)) return review;
  const listing = pre.listing!;
  return reviewTurn(
    review,
    {
      listingId,
      title: String(listing.data.title ?? ""),
      listedPrice:
        listing.unitPriceMinor === null
          ? null
          : (listing.unitPriceMinor / 10 ** input.market.minorUnitScale).toFixed(input.market.minorUnitScale),
      offerAmount: (amountMinor / 10 ** input.market.minorUnitScale).toFixed(input.market.minorUnitScale),
      quantity,
      currency: input.market.currencyCode,
      role: "BUYER",
    },
    `${lead}راجع عرضك قبل إرساله: «${String(listing.data.title ?? "")}» — ${listing.unitPriceMinor === null ? "لا يوجد سعر معلن" : `السعر المطلوب ${money(listing.unitPriceMinor, input.market)}`}، عرضك ${money(amountMinor, input.market)}. لن يُرسل شيء قبل تأكيدك: «إرسال العرض» أو «تعديل» أو «إلغاء».`,
    "SEND_NEGOTIATION_OFFER",
  );
}

async function bestPriceReview(
  input: { conversationId: string; market: Market; actorId: string },
  listingId: string,
  quantity: number,
): Promise<Turn> {
  const review = await guarded(() =>
    createPendingAction({
      ...input,
      proposal: proposeAction({
        action: "REQUEST_BEST_PRICE",
        targetResource: listingId,
        facts: { quantity: [{ value: quantity, source: quantity > 1 ? "USER_DECLARED" : "DINAR_DERIVED" }] },
      }),
    }),
  );
  if (isTurn(review)) return review;
  const [listing] = await db.select({ data: offers.data, pricingMode: offers.pricingMode, unitPriceMinor: offers.unitPriceMinor }).from(offers).where(eq(offers.id, listingId));
  const title = String(listing?.data?.title ?? "");
  const representation = listing ? priceRepresentationOf(listing) : null;
  const quote = representation === "QUOTE_REQUIRED" || representation === "STARTING_FROM";
  return reviewTurn(
    review,
    { listingId, title, role: "BUYER", quantity, ...(quote ? { priceRequest: true, priceRepresentation: representation } : {}) },
    quote
      ? `راجع طلب التسعيرة من البائع على «${title}». الطلب ليس عرضًا ملزمًا؛ يرسل البائع تسعيرته فتقبلها أو تفاوض عليها. لن يُرسل إلا بعد تأكيدك.`
      : `راجع طلبك لسؤال البائع عن أفضل سعر على «${title}». لن يُرسل إلا بعد تأكيدك.`,
    "REQUEST_BEST_PRICE",
  );
}

async function decisionReview(
  input: { conversationId: string; market: Market; actorId: string },
  negotiationId: string,
  action: Exclude<NegotiationAction, "SEND_NEGOTIATION_OFFER" | "REQUEST_BEST_PRICE">,
  amount?: number,
): Promise<Turn> {
  const row = await negotiationForParty(input.actorId, negotiationId);
  if (!row) return notice("عرض السعر غير موجود.");
  const amountMinor = amount === undefined ? undefined : parseListingPriceMinor(String(amount), input.market.currencyCode);
  const review = await guarded(() =>
    createPendingAction({
      ...input,
      proposal: proposeAction({
        action,
        targetResource: negotiationId,
        ...(amountMinor !== undefined ? { facts: { amountMinor: [{ value: amountMinor, source: "USER_DECLARED" }] } } : {}),
      }),
    }),
  );
  if (isTurn(review)) return review;
  const view = (await negotiationView(row, input.actorId))!;
  const prompts: Record<typeof action, string> = {
    COUNTER_NEGOTIATION: view.role === "BUYER"
      ? `راجع عرضك المضاد: ${amountMinor !== undefined ? money(amountMinor, input.market) : ""} على «${view.title}». يصل للبائع فقط بعد تأكيدك؛ اكتب «نعم» أو «إلغاء».`
      : `راجع عرضك المضاد: ${amountMinor !== undefined ? money(amountMinor, input.market) : ""} على «${view.title}». يصل للمشتري فقط بعد تأكيدك؛ اكتب «نعم» أو «إلغاء».`,
    ACCEPT_NEGOTIATION:
      view.role === "BUYER"
        ? `البائع عرض ${view.counterAmount} ${view.currency} على «${view.title}» (السعر المعلن ${view.listedPrice}). اكتب «موافق» لقبول هذا السعر أو «رفض».`
        : `قبول عرض ${view.offerAmount} ${view.currency} على «${view.title}»؟ اكتب «نعم» للقبول أو «إلغاء».`,
    REJECT_NEGOTIATION: `رفض عرض السعر على «${view.title}»؟ اكتب «نعم» للرفض أو «إلغاء».`,
    WITHDRAW_NEGOTIATION: `سحب عرضك النشط على «${view.title}»؟ اكتب «نعم» للتأكيد أو «إلغاء».`,
  };
  return reviewTurn(review, { ...view }, prompts[action], action);
}

async function listTurn(input: { conversationId: string; market: Market; actorId: string }, role: "BUYER" | "SELLER"): Promise<Turn> {
  const rows = await negotiationsFor(input.actorId, role, input.market, role === "SELLER" ? ["OPEN"] : ["OPEN", "COUNTERED", "ACCEPTED"]);
  const views = (await Promise.all(rows.map((row) => negotiationView(row, input.actorId)))).filter((view): view is NonNullable<typeof view> => Boolean(view));
  // A single counter awaiting this buyer is shown as its acceptance review directly.
  if (role === "BUYER" && views.length === 1 && views[0]!.yourTurn) return decisionReview(input, views[0]!.negotiationId, "ACCEPT_NEGOTIATION");
  const prompt = !views.length
    ? role === "SELLER"
      ? "لا توجد عروض أسعار جديدة على إعلاناتك حاليًا."
      : "لا توجد عروض أسعار نشطة لك حاليًا."
    : role === "SELLER"
       ? `لديك ${views.length} ${views.length === 1 ? "عرض سعر" : "عروض أسعار"} بانتظار ردك. ${views.map((view, index) => `${index + 1}. «${view.title}» — ${view.offerAmount === null ? (view.priceRepresentation === "QUOTE_REQUIRED" || view.priceRepresentation === "STARTING_FROM" ? "طلب تسعيرة" : "طلب معرفة أفضل سعر") : `عرض ${view.offerAmount} ${view.currency}`} (المعلن ${view.listedPrice ?? "غير معلن"})`).join("، ")}. اكتب «قبول» أو «رفض» أو «عرض مضاد 8»${views.length > 1 ? " مع رقم العرض" : ""}.`
      : `عروض أسعارك: ${views.map((view, index) => `${index + 1}. «${view.title}» — ${view.statusLabel}${view.agreedAmount ? ` بسعر ${view.agreedAmount} ${view.currency}` : ""}`).join("، ")}.`;
  return {
    tool: "negotiation",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "NEGOTIATION_LIST",
      resultSetId: randomUUID(),
      resourceIds: views.map((view) => view.negotiationId),
      query: { kind: "NEGOTIATIONS", ownerId: input.actorId, role },
      listings: [],
      negotiation: { view: "LIST", role, items: views },
      prompt,
    },
  };
}

/** The seller's negotiation a decision is about: the one in view, a numbered one, or the only one. */
async function sellerTarget(input: { conversationId: string; market: Market; actorId: string; message: string }): Promise<string | "AMBIGUOUS" | undefined> {
  const set = await latestSet(input.conversationId, input.market.id);
  const query = (set?.query ?? {}) as { kind?: unknown; ownerId?: unknown; role?: unknown };
  if (!set || query.kind !== "NEGOTIATIONS" || query.ownerId !== input.actorId || query.role !== "SELLER") return undefined;
  if (set.expiresAt && set.expiresAt.getTime() <= Date.now()) return undefined;
  const mention = findOrdinalMention(input.message);
  const ordinal = parseCommandNumbers(input.message).ordinal ?? (mention?.kind === "INDEX" ? mention.index + 1 : undefined);
  if (ordinal !== undefined) return set.resourceIds[ordinal - 1];
  if (set.resourceIds.length === 1) return set.resourceIds[0];
  // A clarification or advice reply does not move the negotiation in focus.
  const prior = (await focusBlockPayload(input.conversationId))?.payload as { negotiation?: { negotiationId?: unknown; role?: unknown } } | undefined;
  const priorId = prior?.negotiation?.negotiationId;
  if (prior?.negotiation?.role === "SELLER" && typeof priorId === "string" && set.resourceIds.includes(priorId))
    return priorId;
  return set.resourceIds.length ? "AMBIGUOUS" : undefined;
}

/**
 * The negotiation whose status card is in view, when it belongs to the actor: decision buttons on
 * that card («قبول العرض», «رفض العرض», «عرض مقابل», «سحب العرض») name it without a list.
 */
async function negotiationInView(input: { conversationId: string; actorId: string }) {
  const payload = (await focusBlockPayload(input.conversationId))?.payload as
    | { negotiation?: { negotiationId?: unknown; view?: unknown } }
    | undefined;
  const id = payload?.negotiation?.negotiationId;
  if (payload?.negotiation?.view !== "STATUS" || typeof id !== "string") return undefined;
  const row = await negotiationForParty(input.actorId, id);
  return row && roleOf(row, input.actorId) ? row : undefined;
}

/** The amount on the table of a negotiation: the seller's counter while COUNTERED, else the buyer's offer. */
const onTableMinor = (row: NonNullable<Awaited<ReturnType<typeof negotiationForParty>>>) =>
  effectiveStatus(row) === "COUNTERED" ? row.counterAmountMinor : row.offerAmountMinor;

const minorOf = (amount: number, market: Market) => {
  try {
    return parseListingPriceMinor(String(amount), market.currencyCode);
  } catch {
    return undefined;
  }
};

const UNSUITABLE_PROMPT =
  "هل تريد رفض العرض، أم إرسال عرض مقابل بمبلغ آخر (مثل «عرض مقابل 90»)؟ لم يتغير شيء.";

// ─── Hypothetical prices ─────────────────────────────────────────────────────

type Hypothetical = { kind: "PERCENT" | "AMOUNT"; value: number };

function hypotheticalTerms(text: string): Hypothetical | undefined {
  // «أقل بعشرة بالمئة» is «أقل بـ10%».
  const match = normalizeNumberWords(text).match(HYPOTHETICAL);
  const value = match ? Number(match[1]) : NaN;
  if (!match || !Number.isFinite(value) || value <= 0) return undefined;
  return { kind: match[2] ? "PERCENT" : "AMOUNT", value };
}

async function marketListing(listingId: string, market: Market) {
  const [listing] = await db
    .select({ data: offers.data, sellerId: offers.sellerId, pricingMode: offers.pricingMode, unitPriceMinor: offers.unitPriceMinor, status: offers.status })
    .from(offers)
    .where(and(eq(offers.id, listingId), eq(offers.marketId, market.id)));
  return listing;
}

const major = (minor: number, market: Market) => (minor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale);

/**
 * The listed price with a reduction applied, as a calculation the buyer can look at. The
 * listing, its price and every negotiation stay exactly as they were; no action is created.
 */
async function hypotheticalTurn(input: { conversationId: string; market: Market; actorId: string; message: string }, terms: Hypothetical): Promise<Turn> {
  const listingId = await focusedListing(input);
  if (!listingId) return notice("على أي إعلان تريد الحساب؟ افتح الإعلان أو اذكر رقمه من النتائج، مثل «الثاني، ماذا لو كان أقل بـ10%؟».");
  const listing = await marketListing(listingId, input.market);
  if (!listing || listing.status !== "PUBLISHED") return notice("هذا الإعلان غير متاح الآن، فلا يوجد سعر أحسب عليه.");
  const title = String(listing.data.title ?? "");
  if (listing.unitPriceMinor === null) return notice(`«${title}» بلا سعر معلن، فلا يوجد سعر أحسب عليه. يمكنك أن تسأل البائع عن أفضل سعر.`);
  const listedMinor = listing.unitPriceMinor;
  const reductionMinor =
    terms.kind === "PERCENT" ? Math.round((listedMinor * terms.value) / 100) : Math.round(terms.value * 10 ** input.market.minorUnitScale);
  if ((terms.kind === "PERCENT" && terms.value >= 100) || reductionMinor >= listedMinor)
    return notice(`التخفيض أكبر من السعر المعلن (${money(listedMinor, input.market)}). اذكر نسبة أو مبلغًا أصغر.`);
  if (reductionMinor <= 0) return notice("التخفيض أصغر من أن يغيّر السعر. اذكر نسبة أو مبلغًا أكبر.");
  const resultMinor = listedMinor - reductionMinor;
  const own = listing.sellerId === input.actorId;
  const negotiable = listingNegotiable(listing);
  const basis = terms.kind === "PERCENT" ? `${terms.value}%` : money(reductionMinor, input.market);
  return {
    tool: "negotiation",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "NEGOTIATION_STATUS",
      resourceIds: [listingId],
      resourceId: listingId,
      query: {},
      listings: [],
      negotiation: {
        view: "HYPOTHETICAL",
        listingId,
        title,
        role: "BUYER",
        currency: input.market.currencyCode,
        listedPrice: major(listedMinor, input.market),
        reductionLabel: basis,
        reductionAmount: major(reductionMinor, input.market),
        hypotheticalPrice: major(resultMinor, input.market),
        // Kept so «أرسل عرضًا بهذا السعر» can prove the listed price has not moved since.
        listedPriceMinor: listedMinor,
        hypotheticalMinor: resultMinor,
        canOffer: negotiable && !own,
      },
      prompt:
        `حساب فقط: «${title}» بسعر ${money(listedMinor, input.market)}، أقل بـ${basis} يصبح ${money(resultMinor, input.market)}. ` +
        "لم يتغير سعر الإعلان ولم يُرسل أي عرض." +
        (own ? "" : negotiable ? " إن أردت، اكتب «أرسل عرضًا بهذا السعر» لمراجعته قبل الإرسال." : " تسعير هذا الإعلان غير متاح للتفاوض حاليًا."),
    },
  };
}

/** «أرسل عرضًا بهذا السعر» right after a calculation: the ordinary offer review, at that amount. */
async function hypotheticalOffer(input: { conversationId: string; market: Market; actorId: string }): Promise<Turn> {
  const block = await latestBlockPayload(input.conversationId);
  const view = (block?.payload as { negotiation?: Record<string, unknown> } | undefined)?.negotiation;
  if (view?.view !== "HYPOTHETICAL" || typeof view.listingId !== "string" || typeof view.hypotheticalMinor !== "number")
    return notice("أي سعر تقصد؟ اكتب المبلغ صراحة، مثل «أعطيه 7». لم يُرسل شيء.");
  const listing = await marketListing(view.listingId, input.market);
  if (!listing || listing.status !== "PUBLISHED") return notice("هذا الإعلان غير متاح الآن. لم يُرسل أي عرض.");
  // A calculation on an old price is not an offer on the new one.
  if (listing.unitPriceMinor !== view.listedPriceMinor)
    return notice(
      `تغيّر السعر المعلن منذ هذا الحساب${listing.unitPriceMinor === null ? "" : `؛ أصبح ${money(listing.unitPriceMinor, input.market)}`}. احسبه من جديد أو اكتب المبلغ صراحة. لم يُرسل أي عرض.`,
    );
  if (listing.sellerId === input.actorId) return notice("هذا إعلانك؛ لا يمكنك تقديم عرض سعر عليه.");
  if (!listingNegotiable(listing))
    return notice(`تسعير «${String(listing.data.title ?? "")}» غير متاح للتفاوض حاليًا. لم يُرسل أي عرض.`);
  return offerReview(input, view.listingId, Number(major(view.hypotheticalMinor, input.market)), 1);
}

/**
 * Claims explicit negotiation phrases and decisions on the actor's own latest
 * negotiation review; everything else passes on unchanged.
 */
/** A reply about the pending review: it carries the review's id, so the review stays confirmable. */
function discussing(actionId: string, prompt: string): Turn {
  const turn = notice(prompt);
  return { ...turn, result: { ...turn.result, relatesToAction: actionId } };
}

/** What a corrected clause names when it means «the offer», not the listing. */
const OFFER_REFERENCE = /(?:^|\s)(?:عرضي|العرض|عرض(?:\s+(?:الشراء|السعر))?|التفاوض|المفاوضه|المساومه)(?:\s|$)/u;

/**
 * The offer a status question or a correction is about, in this order: the status card in view,
 * the seller's selected or only offer, the actor's offer on the listing in focus, the previous
 * offer the conversation showed («نرجع للعرض السابق»), then the actor's active offers. Every
 * candidate is one the actor is a party to; none is guessed.
 */
async function offerInContext(
  context: { conversationId: string; market: Market; actorId: string },
  message: string,
  options: { party?: "BUYER" | "SELLER"; back: boolean },
): Promise<{ kind: "ONE"; negotiationId: string } | { kind: "MANY"; role: "BUYER" | "SELLER" } | { kind: "NONE" }> {
  if (options.back) {
    const shown = await db
      .select({ payload: aiUiBlocks.payload })
      .from(aiUiBlocks)
      .where(eq(aiUiBlocks.conversationId, context.conversationId))
      .orderBy(desc(aiUiBlocks.createdAt))
      .limit(40);
    const ids: string[] = [];
    for (const block of shown) {
      const negotiation = (block.payload as { negotiation?: { view?: unknown; negotiationId?: unknown } }).negotiation;
      if (negotiation?.view === "STATUS" && typeof negotiation.negotiationId === "string" && !ids.includes(negotiation.negotiationId)) ids.push(negotiation.negotiationId);
    }
    for (const id of ids.slice(1, 2).concat(ids.slice(0, 1)))
      if (await negotiationForParty(context.actorId, id)) return { kind: "ONE", negotiationId: id };
    return { kind: "NONE" };
  }
  const inView = await negotiationInView(context);
  if (inView) return { kind: "ONE", negotiationId: inView.id };
  const selected = await sellerTarget({ ...context, message });
  if (selected && selected !== "AMBIGUOUS") return { kind: "ONE", negotiationId: selected };
  if (selected === "AMBIGUOUS") return { kind: "MANY", role: "SELLER" };
  const listingId = await focusedListing({ ...context, message });
  if (listingId) {
    const mine = (await negotiationsFor(context.actorId, "BUYER", context.market, ["OPEN", "COUNTERED", "ACCEPTED"])).filter((row) => row.listingId === listingId);
    if (mine.length === 1) return { kind: "ONE", negotiationId: mine[0]!.id };
  }
  const roles = options.party ? [options.party] : (["BUYER", "SELLER"] as const);
  for (const role of roles) {
    const rows = await negotiationsFor(context.actorId, role, context.market, role === "SELLER" ? ["OPEN"] : ["OPEN", "COUNTERED", "ACCEPTED"]);
    if (rows.length === 1) return { kind: "ONE", negotiationId: rows[0]!.id };
    if (rows.length > 1) return { kind: "MANY", role };
  }
  return { kind: "NONE" };
}

export async function executeNegotiationTurn(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
  /** The message is the clause a correction meant (conversation-runtime.ts): resolve it in context. */
  repair?: { back?: boolean };
}): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const context = { conversationId: input.conversationId, market: input.market, actorId };
  const text = normalizeNegotiationText(input.message);
  // R3E: the form of the message (context-intent.ts); what it refers to is decided below.
  const edit = priceEdit(input.message);
  const status = statusQuestion(input.message);
  // A price for a draft in progress belongs to the draft (listing-draft.ts).
  if (edit && (await hasActiveListingDraft(input.conversationId))) return null;
  // «اعرض 2» alone may mean «show the second» as well as «offer 2»: it is never an amount for an
  // offer, a counter or a review edit; context decides below (draft, results, or a question).
  const bareNumber = isBareShowNumber(input.message) ? priceProposal(input.message)?.amount : undefined;
  const proposed = bareNumber === undefined ? priceProposal(input.message)?.amount : undefined;
  const set = await latestSet(input.conversationId, input.market.id);
  const pending = set?.query as { kind?: unknown; ownerId?: unknown; status?: unknown; action?: unknown; targetResource?: unknown; structuredInput?: Record<string, { value?: unknown }> } | undefined;
  const reviewOpen =
    pending?.kind === "ACTION" && pending.ownerId === actorId && pending.status === "PENDING" &&
    (NEGOTIATION_ACTIONS as readonly unknown[]).includes(pending.action) && (!set!.expiresAt || set!.expiresAt.getTime() > Date.now());

  // ── Decisions on the actor's own negotiation review.
  if (reviewOpen) {
    const action = pending!.action as NegotiationAction;
    const target = String(pending!.targetResource);
    if (CANCEL.test(text)) {
      const outcome = await confirmPendingAction({ actionId: set!.id, actorId, market: input.market, decision: "CANCEL" });
      return notice(outcome.status === "CANCELLED" ? (action === "SEND_NEGOTIATION_OFFER" ? "أُلغي العرض؛ لم يُرسل شيء للبائع." : "أُلغي الإجراء؛ لم يتغير شيء.") : outcome.message);
    }
    if (action === "ACCEPT_NEGOTIATION" && REJECT.test(text)) return decisionReview(context, target, "REJECT_NEGOTIATION");
    if (PRICE_UNSUITABLE.test(text) && action === "ACCEPT_NEGOTIATION") return notice(UNSUITABLE_PROMPT);
    // «قل له أوافق على 90» while accepting 90 is that acceptance; another amount is a counter below.
    const agreedAt = amountIn(text, AGREE_AT) ?? amountIn(text, ACCEPT_AT);
    if (agreedAt !== undefined && action === "ACCEPT_NEGOTIATION") {
      const row = await negotiationForParty(actorId, target);
      if (row && onTableMinor(row) !== null && minorOf(agreedAt, input.market) === onTableMinor(row)) {
        const outcome = await confirmPendingAction({ actionId: set!.id, actorId, market: input.market, decision: "CONFIRM" });
        if (outcome.status !== "CONFIRMED" || typeof outcome.result?.negotiationId !== "string") return notice(outcome.message);
        return statusTurn(outcome.result.negotiationId, actorId, "تم الاتفاق على السعر بعد التحقق من حالة الإعلان والتوفر. السعر المعلن لم يتغير.");
      }
    }
    // A question about this unsent review, or a change with no amount, discusses it: it stays open.
    const sendsAmount = action === "SEND_NEGOTIATION_OFFER" || action === "COUNTER_NEGOTIATION";
    if (status?.subject === "OFFER")
      return discussing(set!.id, action === "SEND_NEGOTIATION_OFFER"
        ? "لم يُرسل عرضك بعد؛ ما زال بانتظار تأكيدك. اكتب «إرسال العرض» لإرساله أو «إلغاء»."
        : "لم يُنفَّذ هذا الإجراء بعد؛ ما زال بانتظار تأكيدك («نعم» أو «إلغاء»).");
    if (sendsAmount && (EDIT.test(text) || (edit && edit.amount === undefined)))
      return discussing(set!.id, "اكتب المبلغ الجديد، مثل «خليه 15». العرض الحالي لم يُرسل.");
    const newAmount = amountIn(text, AMOUNT_ONLY) ?? amountIn(text, SELLER_COUNTER) ?? amountIn(text, AGREE_AT) ?? edit?.amount ?? proposed;
    if (newAmount !== undefined && (action === "SEND_NEGOTIATION_OFFER" || action === "COUNTER_NEGOTIATION")) {
      await db.update(aiResultSets).set({ query: { ...pending, status: "SUPERSEDED", notice: "استُبدل بمبلغ أحدث." } }).where(eq(aiResultSets.id, set!.id));
      if (action === "SEND_NEGOTIATION_OFFER") {
        const quantity = Number(pending!.structuredInput?.quantity?.value ?? 1);
        return offerReview(context, target, newAmount, quantity, `عدّلت المبلغ إلى ${newAmount}. `);
      }
      return decisionReview(context, target, "COUNTER_NEGOTIATION", newAmount);
    }
    if (newAmount !== undefined && action === "ACCEPT_NEGOTIATION") {
      const row = await negotiationForParty(actorId, target);
      if (row && roleOf(row, actorId) === "BUYER" && effectiveStatus(row) === "COUNTERED") {
        await db.update(aiResultSets).set({
          query: { ...pending, status: "SUPERSEDED", notice: "استُبدل القبول بعرض مضاد." },
        }).where(eq(aiResultSets.id, set!.id));
        return decisionReview(context, target, "COUNTER_NEGOTIATION", newAmount);
      }
    }
    if (CONFIRM.test(text)) {
      // «موافق على 8» must name the amount actually on the table.
      const named = text.match(/(?:علي|على)\s*(\d+(?:\.\d+)?)$/u)?.[1];
      if (named !== undefined && action === "ACCEPT_NEGOTIATION") {
        const row = await negotiationForParty(actorId, target);
        const onTable = row ? (effectiveStatus(row) === "COUNTERED" ? row.counterAmountMinor : row.offerAmountMinor) : null;
        if (onTable === null || parseListingPriceMinor(named, input.market.currencyCode) !== onTable)
          return notice(`المبلغ المعروض ليس ${named}. لم يتغير شيء؛ لإرسال مبلغ آخر اكتب «أعطيه …».`);
      }
      const outcome = await confirmPendingAction({ actionId: set!.id, actorId, market: input.market, decision: "CONFIRM" });
      if (outcome.status === "REVIEW_REQUIRED") return notice(`${outcome.message} لم يُنفذ التأكيد القديم.`);
      if (outcome.status !== "CONFIRMED" || typeof outcome.result?.negotiationId !== "string") return notice(outcome.message);
      const negotiationId = outcome.result.negotiationId;
      const confirmedRow = await negotiationForParty(actorId, negotiationId);
      const actorRole = confirmedRow ? roleOf(confirmedRow, actorId) : undefined;
      const prompts: Record<NegotiationAction, string> = {
        SEND_NEGOTIATION_OFFER: "أُرسل عرضك للبائع. السعر المعلن لم يتغير، وسأعرض لك رده عندما تسأل «وش صار على عرضي؟».",
        REQUEST_BEST_PRICE: "أُرسل طلب معرفة أفضل سعر للبائع. لم يحدد DINAR سعرًا نيابةً عنه.",
        COUNTER_NEGOTIATION:
          actorRole === "BUYER"
            ? "أُرسل عرضك المضاد للبائع. لم يتغير السعر المعلن للإعلان."
            : "أُرسل عرضك المضاد للمشتري. لم يتغير السعر المعلن للإعلان.",
        ACCEPT_NEGOTIATION: "تم الاتفاق على السعر بعد التحقق من حالة الإعلان والتوفر. السعر المعلن لم يتغير.",
        REJECT_NEGOTIATION: "رُفض عرض السعر. لم يُنشأ أي طلب.",
        WITHDRAW_NEGOTIATION: "سُحب عرضك النشط. بقي سجل التفاوض محفوظًا.",
      };
      const turn = await statusTurn(negotiationId, actorId, prompts[action]);
      const view = turn.result.negotiation as { role?: unknown; status?: unknown };
      if (action === "ACCEPT_NEGOTIATION" && view.role === "BUYER" && view.status === "ACCEPTED")
        turn.result.prompt += " اكتب «اطلبه» لمراجعة الطلب بالسعر المتفق عليه؛ يُعاد التحقق من المخزون عند إنشاء الطلب.";
      return turn;
    }
  }

  // ── «اطلبه» on an accepted negotiation in view: a PLACE_ORDER review at the agreed price.
  if (ORDER_NOW.test(text)) {
    const block = await latestBlockPayload(input.conversationId);
    const negotiation = (block?.payload as {
      negotiation?: { negotiationId?: unknown; role?: unknown; view?: unknown; items?: { negotiationId?: unknown; status?: unknown }[] };
    } | undefined)?.negotiation;
    // From the buyer's own offers list, «اطلبه» means the one agreed offer, when exactly one exists.
    const agreed = negotiation?.view === "LIST" && negotiation.role === "BUYER"
      ? (negotiation.items ?? []).filter((item) => item.status === "ACCEPTED")
      : [];
    const negotiationId = typeof negotiation?.negotiationId === "string"
      ? negotiation.negotiationId
      : agreed.length === 1 && typeof agreed[0]!.negotiationId === "string" ? agreed[0]!.negotiationId : undefined;
    if (negotiation?.view === "LIST" && negotiation.role === "BUYER" && agreed.length > 1)
      return notice("لديك أكثر من سعر متفق عليه. اذكر رقمه من القائمة أولًا، مثل «الأول». لم يُنشأ أي طلب.");
    if (negotiationId && negotiation?.role === "BUYER") {
      const row = await negotiationForParty(actorId, negotiationId);
      if (!row || roleOf(row, actorId) !== "BUYER") return null;
      if (effectiveStatus(row) !== "ACCEPTED" || row.orderId) return notice("لا يوجد سعر متفق عليه صالح لهذا العرض الآن. لم يُنشأ أي طلب.");
      const review = await guarded(() =>
        createPendingAction({ ...context, proposal: proposeAction({ action: "PLACE_ORDER", targetResource: row.listingId, facts: { quantity: [{ value: row.quantity, source: "SERVER_FACT" }] } }) }),
      );
      if (isTurn(review)) return review;
      return purchaseReviewTurn(input.market, actorId, row.listingId, row.quantity, review, "PLACE_ORDER");
    }
  }

  if (COUNTER_PROMPT.test(text))
    return notice("اكتب المبلغ الذي تعرضه، مثل «عرض مقابل 90». لن يُرسل شيء قبل تأكيدك.");

  if (SELLER_LIST.test(text)) return listTurn(context, "SELLER");
  if (BUYER_LIST.test(text)) return listTurn(context, "BUYER");

  // ── R3E: a question about an offer's state, or the offer a correction pointed back to: read
  // from the actor's own negotiations, never inferred and never changed.
  const offerReference = input.repair && !edit && (OFFER_REFERENCE.test(text) || input.repair.back === true);
  if (status?.subject === "OFFER" || offerReference) {
    const found = await offerInContext(context, input.message, { party: status?.party, back: input.repair?.back === true });
    if (found.kind === "ONE") {
      // As in the buyer's list: a seller counter awaiting this buyer opens its acceptance review.
      const row = await negotiationForParty(actorId, found.negotiationId);
      if (row && roleOf(row, actorId) === "BUYER" && effectiveStatus(row) === "COUNTERED") return decisionReview(context, row.id, "ACCEPT_NEGOTIATION");
      return statusTurn(found.negotiationId, actorId, "هذه حالة العرض كما يسجلها دينار الآن.");
    }
    if (found.kind === "MANY") {
      const listed = await listTurn(context, found.role);
      return { ...listed, result: { ...listed.result, prompt: `أي عرض تقصد؟ ${listed.result.prompt ?? ""}`.trim() } };
    }
    if (status) return notice("لا يوجد لك عرض سعر نشط حاليًا في سوقك. لم يُرسل أي عرض باسمك.");
    return notice("أي عرض تقصد؟ افتح العرض أو الإعلان الذي تعنيه، أو اكتب «عروضي». لم أنفّذ شيئًا.");
  }


  const buyerList = await latestSet(input.conversationId, input.market.id);
  const buyerQuery = (buyerList?.query ?? {}) as { kind?: unknown; ownerId?: unknown; role?: unknown };
  const ordinalMention = findOrdinalMention(input.message);
  const buyerOrdinal = parseCommandNumbers(input.message).ordinal ??
    (ordinalMention?.kind === "INDEX" ? ordinalMention.index + 1 : undefined);
  if (buyerList && buyerQuery.kind === "NEGOTIATIONS" && buyerQuery.ownerId === actorId &&
      buyerQuery.role === "BUYER" && buyerOrdinal !== undefined &&
      (!buyerList.expiresAt || buyerList.expiresAt.getTime() > Date.now())) {
    const selectedId = buyerList.resourceIds[buyerOrdinal - 1];
    const selected = selectedId ? await negotiationForParty(actorId, selectedId) : undefined;
    if (!selected || roleOf(selected, actorId) !== "BUYER")
      return notice("لم أجد عرض السعر بهذا الرقم في قائمتك الحالية.");
    if (effectiveStatus(selected) === "COUNTERED")
      return decisionReview(context, selected.id, "ACCEPT_NEGOTIATION");
    return statusTurn(selected.id, actorId, `هذا عرضك رقم ${buyerOrdinal} على «${String((await negotiationView(selected, actorId))?.title ?? "")}».`);
  }

  const hypothetical = hypotheticalTerms(text);
  if (hypothetical) return hypotheticalTurn({ ...context, message: input.message }, hypothetical);
  if (SEND_HYPOTHETICAL.test(text) || SEND_OFFER_IN_VIEW.test(text)) return hypotheticalOffer(context);

  if (WITHDRAW_REQUEST.test(text)) {
    const block = await latestBlockPayload(input.conversationId);
    const payload = (block?.payload ?? {}) as { negotiation?: { negotiationId?: unknown; role?: unknown } };
    let target: string | "AMBIGUOUS" | undefined;
    if (typeof payload.negotiation?.negotiationId === "string") {
      const row = await negotiationForParty(actorId, payload.negotiation.negotiationId);
      const role = row ? roleOf(row, actorId) : null;
      // A buyer withdraws any active offer; a seller only its own counter awaiting the buyer.
      if (row && role === "BUYER" && ["OPEN", "COUNTERED"].includes(effectiveStatus(row))) target = row.id;
      if (row && role === "SELLER" && effectiveStatus(row) === "COUNTERED") target = row.id;
    }
    if (!target) {
      const latest = await latestSet(input.conversationId, input.market.id);
      const query = (latest?.query ?? {}) as { kind?: unknown; ownerId?: unknown; role?: unknown };
      if (latest && query.kind === "NEGOTIATIONS" && query.ownerId === actorId && query.role === "BUYER" &&
          (!latest.expiresAt || latest.expiresAt.getTime() > Date.now())) {
        const mention = findOrdinalMention(input.message);
        const ordinal = parseCommandNumbers(input.message).ordinal ?? (mention?.kind === "INDEX" ? mention.index + 1 : undefined);
        if (ordinal !== undefined) target = latest.resourceIds[ordinal - 1];
        else if (latest.resourceIds.length === 1) target = latest.resourceIds[0];
        else if (latest.resourceIds.length > 1) target = "AMBIGUOUS";
      }
    }
    if (target === "AMBIGUOUS") return notice("أي عرض تريد سحبه؟ اذكر رقمه من قائمة عروضك.");
    if (!target) return notice("لا يظهر عرض نشط لك لسحبه. اعرض عروضك أو افتح التفاوض المقصود أولًا.");
    return decisionReview(context, target, "WITHDRAW_NEGOTIATION");
  }

  // ── Seller decisions on the negotiation list in view.
  const inView = await negotiationInView(context);
  const sellerInView = inView && roleOf(inView, actorId) === "SELLER" && effectiveStatus(inView) === "OPEN" ? inView.id : undefined;
  const sellerContext = (await sellerTarget({ ...context, message: input.message })) ?? sellerInView;
  if (sellerContext !== undefined) {
    const namedAccept = amountIn(text, ACCEPT_AT) ?? amountIn(text, AGREE_AT);
    if (namedAccept !== undefined && sellerContext !== "AMBIGUOUS") {
      // An acceptance that names an amount must name the buyer's actual offer; otherwise it is a counter.
      const row = await negotiationForParty(actorId, sellerContext);
      const onTable = row ? onTableMinor(row) : null;
      if (onTable !== null && minorOf(namedAccept, input.market) === onTable)
        return decisionReview(context, sellerContext, "ACCEPT_NEGOTIATION");
      if (ACCEPT_AT.test(text))
        return notice(`عرض المشتري المعروض ليس ${namedAccept}. لم يتغير شيء؛ لإرسال مبلغ آخر اكتب «عرض مقابل ${namedAccept}».`);
      return decisionReview(context, sellerContext, "COUNTER_NEGOTIATION", namedAccept);
    }
    if (PRICE_UNSUITABLE.test(text)) return notice(UNSUITABLE_PROMPT);
    if (edit && edit.amount === undefined && sellerContext !== "AMBIGUOUS")
      return notice("اكتب مبلغ العرض المضاد، مثل «خليه 55». لم يُرسل شيء.");
    const counter = amountIn(text, SELLER_COUNTER) ?? amountIn(text, AMOUNT_ONLY) ?? edit?.amount ?? proposed;
    const decision = counter !== undefined ? "COUNTER" : ACCEPT.test(text) ? "ACCEPT" : REJECT.test(text) ? "REJECT" : undefined;
    if (!decision && parseCommandNumbers(text).ordinal !== undefined && sellerContext !== "AMBIGUOUS") {
      const selected = await negotiationForParty(actorId, sellerContext);
      const view = selected ? await negotiationView(selected, actorId) : null;
      return statusTurn(sellerContext, actorId, `هذا العرض المحدد على «${String(view?.title ?? "")}».`);
    }
    if (decision) {
      if (sellerContext === "AMBIGUOUS") return notice("أي عرض تقصد؟ اذكر رقمه من القائمة، مثل «اقبل الأول».");
      if (decision === "COUNTER") return decisionReview(context, sellerContext, "COUNTER_NEGOTIATION", counter);
      return decisionReview(context, sellerContext, decision === "ACCEPT" ? "ACCEPT_NEGOTIATION" : "REJECT_NEGOTIATION");
    }
  }

  // ── The buyer's decision on a seller counter whose status card is in view.
  if (inView && roleOf(inView, actorId) === "BUYER" && effectiveStatus(inView) === "COUNTERED") {
    if (PRICE_UNSUITABLE.test(text)) return notice(UNSUITABLE_PROMPT);
    if (edit && edit.amount === undefined) return notice("اكتب المبلغ الذي تعرضه مقابل عرض البائع، مثل «خليه 45». لم يُرسل شيء.");
    const named = amountIn(text, AGREE_AT) ?? amountIn(text, ACCEPT_AT) ?? amountIn(text, SELLER_COUNTER) ?? amountIn(text, AMOUNT_ONLY) ?? edit?.amount ?? proposed;
    if (named !== undefined)
      return minorOf(named, input.market) === inView.counterAmountMinor
        ? decisionReview(context, inView.id, "ACCEPT_NEGOTIATION")
        : decisionReview(context, inView.id, "COUNTER_NEGOTIATION", named);
    if (ACCEPT.test(text)) return decisionReview(context, inView.id, "ACCEPT_NEGOTIATION");
    if (REJECT.test(text)) return decisionReview(context, inView.id, "REJECT_NEGOTIATION");
  }

  if (QUOTE_COST.test(text) && !BEST_PRICE_REQUEST.test(text)) {
    const listingId = await focusedListing({ ...context, message: input.message });
    if (listingId) return bestPriceReview(context, listingId, parseCommandNumbers(input.message).quantity ?? 1);
  }

  // ── R3E: a price change whose target is a listing, or nothing at all.
  if (edit) {
    // The buyer's own offer, already sent: a sent offer is not edited in place.
    if (inView && roleOf(inView, actorId) === "BUYER" && effectiveStatus(inView) === "OPEN")
      return notice("عرضك أُرسل للبائع ولا يُعدَّل بعد إرساله. إن أردت مبلغًا آخر اسحبه أولًا («اسحب عرضي») ثم قدّم عرضًا جديدًا. لم يتغير شيء.");
    const listingId = await focusedListing({ ...context, message: input.message });
    const [listing] = listingId ? await db.select({ data: offers.data, sellerId: offers.sellerId }).from(offers).where(eq(offers.id, listingId)) : [];
    const title = String(listing?.data.title ?? "");
    if (listing && listing.sellerId === actorId && (namesPrice(input.message) || edit.amount !== undefined)) {
      if (edit.amount === undefined) return notice(`ما السعر الجديد لإعلان «${title}»؟ اكتب مثل «خليه 55». لم يتغير شيء.`);
      if (edit.startingFrom && (listing.data as { priceRepresentation?: unknown }).priceRepresentation !== "STARTING_FROM")
        return notice(`تغيير معنى سعر «${title}» إلى «يبدأ من» يتم من تعديل الإعلان، وليس من المحادثة. لم يتغير شيء.`);
      return reviewListingPriceChange(context, listingId!, edit.amount);
    }
    // Another user's listing: its price is the seller's; the buyer's way is an offer, by review.
    // Only an explicit price change — «خليه 3» under a purchase review is a quantity.
    if (listing && namesPrice(input.message))
      return notice(`لا يمكنك تعديل سعر «${title}» لأنه إعلان غيرك. لتقديم عرض اكتب مثل «أعرض ${edit.amount ?? "15"}»؛ لن يُرسل شيء قبل تأكيدك.`);
    // A bare amount on another user's listing («خليه 15») may be an offer or a quantity: asked,
    // unless a purchase review is open, where it is that review's quantity (buyer-turn.ts).
    if (listing && edit.amount !== undefined && (await latestBlockPayload(input.conversationId))?.payload?.surface !== "PURCHASE_REVIEW")
      return notice(`هل تقصد تقديم عرض سعر ${edit.amount}، أم كمية ${edit.amount}؟ للعرض اكتب «أعرض ${edit.amount}»، وللكمية «أبي ${edit.amount}». لم يتغير شيء.`);
    // Nothing here: the seller's own listing context (seller-management.ts) may still own it.
  }

  if (BEST_PRICE_REQUEST.test(text) || quoteRequest(input.message)) {
    const listingId = await focusedListing({ ...context, message: input.message });
    if (!listingId)
      return notice("على أي إعلان تريد السؤال عن أفضل سعر؟ افتح الإعلان أو اذكر رقمه من النتائج.");
    return bestPriceReview(
      context,
      listingId,
      parseCommandNumbers(input.message).quantity ?? 1,
    );
  }

  // ── «أريد أتفاوض على …», «قدّم عرض سعر»: guidance, or a quotation request where the listing has no price.
  if (NEGOTIATE_INTENT.test(text) && amountIn(text, BUYER_OFFER) === undefined) {
    const listingId = await focusedListing({ ...context, message: input.message });
    if (!listingId)
      return notice("على أي إعلان تريد التفاوض؟ ابحث عن المنتج أو الخدمة ثم افتح الإعلان، واكتب «اعرض على البائع …» بالمبلغ أو «اطلب تسعيرة». لم يُرسل شيء.");
    const listing = await marketListing(listingId, input.market);
    if (!listing || listing.status !== "PUBLISHED") return notice("هذا الإعلان غير متاح الآن. لم يُرسل شيء.");
    if (listing.sellerId === actorId) return notice("هذا إعلانك؛ لا يمكنك التفاوض عليه.");
    if (priceRepresentationOf(listing) === "QUOTE_REQUIRED")
      return bestPriceReview(context, listingId, parseCommandNumbers(input.message).quantity ?? 1);
    return notice(
      `يمكنك التفاوض على «${String(listing.data.title ?? "")}»: اكتب المبلغ الذي تعرضه، مثل «اعرض على البائع 85»، أو «اطلب تسعيرة». القرار للبائع، ولن يُرسل شيء قبل تأكيدك.`,
    );
  }

  // ── A buyer naming a price on the listing in view.
  const named = amountIn(text, BUYER_OFFER) ?? amountIn(text, BUYER_ASK_AT) ?? amountIn(text, AGREE_AT) ?? amountIn(text, PRICE_COMPLAINT);
  // An amount with no target in a draft in progress is the draft's asking price (listing-draft.ts).
  if (named === undefined && (proposed !== undefined || bareNumber !== undefined) && (await hasActiveListingDraft(input.conversationId)))
    return null;
  if (named === undefined && bareNumber !== undefined) {
    const block = await latestBlockPayload(input.conversationId);
    const shown = block?.blockType === "LISTING_RESULTS" && Array.isArray((block.payload as { resourceIds?: unknown }).resourceIds)
      ? ((block.payload as { resourceIds: unknown[] }).resourceIds.length)
      : 0;
    // A position in the visible results is a request to show that result.
    if (Number.isInteger(bareNumber) && bareNumber <= shown) return null;
    return notice(`هل تقصد إظهار العرض رقم ${bareNumber}، أم تقديم سعر ${bareNumber}؟ لإظهاره اكتب «الإعلان رقم ${bareNumber}»، وللسعر اكتب «أعرض ${bareNumber} دينار» أو «أعطيه ${bareNumber}». لم يُرسل شيء ولم يتغير أي سعر.`);
  }
  const offered = named ?? proposed;
  if (offered === undefined) return null;
  const listingId = await focusedListing({ ...context, message: input.message });
  if (!listingId)
    return notice(
      named === undefined
        ? `على أي إعلان تريد عرض ${offered}؟ افتح الإعلان أو اذكر رقمه من النتائج. وإن كنت تقصد سعر إعلانك أنت، فافتحه من «إعلاناتي» أو ابدأ مسودة. لم يُرسل شيء ولم يتغير أي سعر.`
        : "على أي إعلان تريد تقديم العرض؟ افتح الإعلان أو اذكر رقمه من النتائج، مثل «الثاني، أعطيه 7». لم يُرسل شيء.",
    );
  const [listing] = await db.select({ data: offers.data, sellerId: offers.sellerId, pricingMode: offers.pricingMode, unitPriceMinor: offers.unitPriceMinor }).from(offers).where(eq(offers.id, listingId));
  // On the seller's own listing an amount is never an offer to itself; its price changes by name.
  if (listing?.sellerId === actorId && named === undefined)
    return notice(`هذا إعلانك؛ لا تُرسل عروض أسعار على إعلانك. لتغيير سعره المعلن اكتب «غيّر سعر الإعلان إلى ${offered}». لم يتغير شيء.`);
  if (listing && listing.sellerId !== actorId && !listingNegotiable(listing))
    return notice(`تسعير «${String(listing.data.title ?? "")}» غير متاح للتفاوض حاليًا. لم يُرسل أي عرض.`);
  const quantity = parseCommandNumbers(input.message).quantity ?? 1;
  return offerReview(context, listingId, offered, quantity);
}

/** History reload: negotiation views are rebuilt for this party; reviews show their action's status. */
export async function refreshNegotiationPayload(payload: Record<string, unknown>, actorId: string): Promise<Record<string, unknown>> {
  if (payload.view === "REVIEW" && typeof payload.actionId === "string") {
    const [set] = await db.select({ query: aiResultSets.query, expiresAt: aiResultSets.expiresAt }).from(aiResultSets).where(eq(aiResultSets.id, payload.actionId));
    const query = set?.query as { ownerId?: unknown; status?: unknown } | undefined;
    if (!set || query?.ownerId !== actorId) return { view: "REVIEW", status: "EXPIRED" };
    let status = typeof query.status === "string" ? query.status : "EXPIRED";
    if (status === "PENDING" && set.expiresAt && set.expiresAt.getTime() <= Date.now()) status = "EXPIRED";
    return { ...payload, status: status === "SUPERSEDED" ? "EXPIRED" : status };
  }
  if (payload.view === "HYPOTHETICAL") {
    // A calculation on public figures; reload shows it as it was, marked if the price moved since.
    const keys = ["listingId", "title", "role", "currency", "listedPrice", "reductionLabel", "reductionAmount", "hypotheticalPrice", "canOffer"] as const;
    const kept = Object.fromEntries(keys.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
    const [listing] = typeof payload.listingId === "string"
      ? await db.select({ unitPriceMinor: offers.unitPriceMinor }).from(offers).where(eq(offers.id, payload.listingId))
      : [];
    return { view: "HYPOTHETICAL", ...kept, listedPriceMinor: payload.listedPriceMinor, hypotheticalMinor: payload.hypotheticalMinor, stale: !listing || listing.unitPriceMinor !== payload.listedPriceMinor };
  }
  if (payload.view === "STATUS" && typeof payload.negotiationId === "string") {
    const row = await negotiationForParty(actorId, payload.negotiationId);
    const view = row ? await negotiationView(row, actorId) : null;
    return view ? { view: "STATUS", ...view } : { view: "STATUS", status: "UNAVAILABLE" };
  }
  if (payload.view === "LIST" && Array.isArray(payload.items)) {
    const items = [];
    for (const item of payload.items as { negotiationId?: unknown }[]) {
      if (typeof item?.negotiationId !== "string") continue;
      const row = await negotiationForParty(actorId, item.negotiationId);
      const view = row ? await negotiationView(row, actorId) : null;
      if (view) items.push(view);
    }
    return { view: "LIST", role: payload.role, items };
  }
  return { view: "UNAVAILABLE" };
}
