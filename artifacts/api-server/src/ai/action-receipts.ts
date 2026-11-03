/**
 * Trusted action receipts (R3 closure).
 *
 * A commercial action has happened only when the action ledger says so: the ACTION rows of
 * aiResultSets that createPendingAction opens and confirmPendingAction settles under the
 * owner's lock. Nothing a model writes is evidence. This module reads that ledger into one
 * lifecycle, records which ledger rows each turn moved, verifies a receipt against its owner and
 * conversation, and keeps model-authored text from speaking for an action.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { aiResultSets, db, markets, negotiations, offers, orders, paymentIntents } from "@workspace/db";
import { pendingActionLapsed } from "./action-foundation";

/** PROPOSED: suggested, nothing opened. The rest are read from the ledger, never from a claim. */
export const ACTION_LIFECYCLES = ["PROPOSED", "REQUIRES_CONFIRMATION", "EXECUTING", "SUCCEEDED", "FAILED", "UNKNOWN"] as const;
export type ActionLifecycle = (typeof ACTION_LIFECYCLES)[number];

export type ActionReceipt = { actionId: string; action: string; lifecycle: ActionLifecycle };

const LEDGER_LIFECYCLE: Record<string, ActionLifecycle> = {
  PENDING: "REQUIRES_CONFIRMATION",
  EXECUTING: "EXECUTING",
  CONFIRMED: "SUCCEEDED",
  REJECTED: "FAILED",
  CANCELLED: "FAILED",
  EXPIRED: "FAILED",
  SUPERSEDED: "FAILED",
  UNKNOWN: "UNKNOWN",
};

export function lifecycleOfLedgerStatus(status: unknown): ActionLifecycle {
  return (typeof status === "string" && Object.hasOwn(LEDGER_LIFECYCLE, status) ? LEDGER_LIFECYCLE[status] : undefined) ?? "UNKNOWN";
}

type LedgerQuery = { kind?: unknown; ownerId?: unknown; action?: unknown; status?: unknown };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Bounds the per-turn ledger read; a conversation's live actions are far fewer. */
const LEDGER_SCAN = 200;

async function ledgerRows(conversationId: string, actorId: string) {
  const rows = await db
    .select({ id: aiResultSets.id, query: aiResultSets.query })
    .from(aiResultSets)
    .where(eq(aiResultSets.conversationId, conversationId))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(LEDGER_SCAN);
  return rows.filter((row) => {
    const query = row.query as LedgerQuery;
    return query?.kind === "ACTION" && query.ownerId === actorId && typeof query.action === "string";
  });
}

/**
 * The ledger rows this turn opened or settled, oldest first: the turn stamps them itself
 * (turn-context.ts), so a concurrent request's outcome is never credited to this turn.
 */
export async function receiptsForTurn(conversationId: string, actorId: string, turnId: string): Promise<ActionReceipt[]> {
  return (await ledgerRows(conversationId, actorId))
    .filter((row) => {
      const query = row.query as LedgerQuery & { openedByTurn?: unknown; settledByTurn?: unknown };
      return query.openedByTurn === turnId || query.settledByTurn === turnId;
    })
    .reverse()
    .map((row) => {
      const query = row.query as LedgerQuery;
      return { actionId: row.id, action: String(query.action), lifecycle: lifecycleOfLedgerStatus(query.status) };
    });
}

/** The latest state of the actor's recent actions, for the model: action and lifecycle only. */
export async function recentActionReceipts(conversationId: string, actorId: string, limit = 6): Promise<Omit<ActionReceipt, "actionId">[]> {
  return (await ledgerRows(conversationId, actorId))
    .slice(0, limit)
    .reverse()
    .map((row) => ({ action: String((row.query as LedgerQuery).action), lifecycle: lifecycleOfLedgerStatus((row.query as LedgerQuery).status) }));
}

/**
 * A receipt is whatever the ledger holds for that id, for that owner, in that conversation.
 * Anything else the claim states (a status, a lifecycle, an action) is ignored.
 */
export async function verifyActionReceipt(claim: unknown, scope: { actorId: string; conversationId: string }): Promise<ActionReceipt | null> {
  const actionId = (claim as { actionId?: unknown } | null)?.actionId;
  if (typeof actionId !== "string" || !UUID.test(actionId)) return null;
  const [row] = await db
    .select({ id: aiResultSets.id, query: aiResultSets.query })
    .from(aiResultSets)
    .where(and(eq(aiResultSets.id, actionId), eq(aiResultSets.conversationId, scope.conversationId)));
  const query = row?.query as LedgerQuery | undefined;
  if (!row || query?.kind !== "ACTION" || query.ownerId !== scope.actorId || typeof query.action !== "string") return null;
  return { actionId: row.id, action: query.action, lifecycle: lifecycleOfLedgerStatus(query.status) };
}

// ─── Receipt views ───────────────────────────────────────────────────────────

/**
 * What the chat shows for one ledger action (the AiActionReceipt API contract): display values
 * the server derives from the ledger row and the records it names, re-read on every response.
 * No ledger id, owner, target or raw fact leaves the server.
 */
export type ActionReceiptView = {
  action: string;
  lifecycle: ActionLifecycle;
  outcome?: "REJECTED" | "CANCELLED" | "EXPIRED" | "SUPERSEDED";
  title: string;
  resource?: string;
  amount?: { value: string; currency: string; kind: "PROPOSED" | "SUBMITTED" | "AGREED" | "PAYMENT" };
  orderId?: string;
  paymentState?: "AWAITING_CONFIRMATION" | "SIMULATED_CAPTURED" | "CAPTURED";
  nextStep?: string;
  requiresConfirmation: boolean;
  failure?: string;
};

/** The action as a noun, for states other than done (one per ACTION_REGISTRY name). */
const ACTION_NOUNS: Record<string, string> = {
  SWITCH_MARKET: "تغيير السوق",
  UPDATE_DISPLAY_NAME: "تغيير الاسم الظاهر",
  SEND_INQUIRY_MESSAGE: "الرسالة",
  UPDATE_LISTING_PRICE: "تغيير سعر الإعلان",
  ADD_TO_CART: "الإضافة إلى السلة",
  PLACE_ORDER: "الطلب",
  PUBLISH_LISTING: "نشر الإعلان",
  SUBMIT_DRIVER_PROFILE: "ملف السائق",
  ACCEPT_DELIVERY: "قبول مهمة التوصيل",
  CREATE_PAYMENT_INTENT: "الدفع",
  SEND_NEGOTIATION_OFFER: "عرض السعر",
  REQUEST_BEST_PRICE: "طلب التسعيرة",
  COUNTER_NEGOTIATION: "العرض المضاد",
  ACCEPT_NEGOTIATION: "قبول العرض",
  REJECT_NEGOTIATION: "رفض العرض",
  WITHDRAW_NEGOTIATION: "سحب العرض",
  CREATE_PROVIDER_CONNECTION: "ربط المزود",
  ROTATE_PROVIDER_CREDENTIAL: "تجديد مفتاح المزود",
  REVOKE_PROVIDER_CONNECTION: "إلغاء ربط المزود",
};
const FAILED_OUTCOMES: Record<string, NonNullable<ActionReceiptView["outcome"]>> = { REJECTED: "REJECTED", CANCELLED: "CANCELLED", EXPIRED: "EXPIRED", SUPERSEDED: "SUPERSEDED" };
const AWAITS_OTHER_PARTY = new Set(["SEND_NEGOTIATION_OFFER", "REQUEST_BEST_PRICE", "COUNTER_NEGOTIATION"]);
const MAX_FAILURE = 240;

export type ReceiptFacts = {
  action: string;
  /** The ledger row's status (aiResultSets ACTION query.status). */
  status: unknown;
  expiresAt?: Date | null;
  /** A pending review the conversation moved past (pendingActionLapsed): it can no longer be confirmed. */
  lapsed?: boolean;
  notice?: unknown;
  amountMinor?: number;
  agreedAmountMinor?: number | null;
  paymentStatus?: string;
  paymentAmountMinor?: number;
  orderId?: string;
  resource?: string;
  currency?: { code: string; scale: number };
  now: Date;
};

/** One ledger record in the user's terms. Pure: every value comes from `facts`. */
export function describeReceipt(facts: ReceiptFacts): ActionReceiptView {
  const noun = ACTION_NOUNS[facts.action] ?? "الإجراء";
  const expired = facts.status === "PENDING" && (facts.lapsed === true || (facts.expiresAt instanceof Date && facts.expiresAt.getTime() <= facts.now.getTime()));
  const lifecycle = expired ? "FAILED" : lifecycleOfLedgerStatus(facts.status);
  const outcome = expired ? "EXPIRED" : lifecycle === "FAILED" ? FAILED_OUTCOMES[String(facts.status)] : undefined;
  const money = (minor: number | null | undefined, kind: NonNullable<ActionReceiptView["amount"]>["kind"]) =>
    facts.currency && Number.isInteger(minor) && minor! > 0
      ? { amount: { value: (minor! / 10 ** facts.currency.scale).toFixed(facts.currency.scale), currency: facts.currency.code, kind } }
      : {};
  const paymentState: ActionReceiptView["paymentState"] =
    facts.action !== "CREATE_PAYMENT_INTENT" || lifecycle !== "SUCCEEDED" ? undefined
      : facts.paymentStatus === "CAPTURED" ? "CAPTURED"
        : facts.paymentStatus === "SIMULATION_CAPTURED" ? "SIMULATED_CAPTURED"
          : "AWAITING_CONFIRMATION";
  let title: string;
  let nextStep: string | undefined;
  let amount = {};
  switch (lifecycle) {
    case "REQUIRES_CONFIRMATION":
      title = `${noun} بانتظار تأكيدك`;
      nextStep = "أكّد أو ألغِ من بطاقة المراجعة؛ لن يُنفَّذ شيء قبل تأكيدك.";
      amount = money(facts.amountMinor, "PROPOSED");
      break;
    case "EXECUTING":
      title = "قيد التحقق من نتيجة التنفيذ";
      nextStep = "لا تكرر الطلب؛ تظهر النتيجة المؤكدة هنا عند تحديث المحادثة.";
      amount = money(facts.amountMinor, "PROPOSED");
      break;
    case "UNKNOWN":
      title = "تعذر التحقق من نتيجة التنفيذ";
      nextStep = "لم يُثبت أن الإجراء نُفّذ؛ راجع سجل المحادثة أو الطلبات قبل إعادة المحاولة.";
      break;
    case "SUCCEEDED":
      title =
        paymentState === "CAPTURED" ? "تم استلام الدفع"
          : paymentState === "SIMULATED_CAPTURED" ? "اكتمل الدفع في وضع المحاكاة"
            : RECEIPT_LABELS[facts.action] ?? "نُفّذ الإجراء بعد تأكيدك";
      nextStep =
        paymentState === "AWAITING_CONFIRMATION" ? "الدفع بانتظار التأكيد؛ لم يُستلم أي مبلغ بعد."
          : paymentState === "SIMULATED_CAPTURED" ? "هذه محاكاة؛ لم تُحصَّل أموال حقيقية."
            : AWAITS_OTHER_PARTY.has(facts.action) ? "القرار للطرف الآخر؛ لم يُتفق على سعر بعد."
              : facts.action === "ACCEPT_NEGOTIATION" ? "يمكن للمشتري مراجعة الطلب بالسعر المتفق عليه."
                : facts.action === "PLACE_ORDER" ? "تابع الدفع من بطاقة الطلب."
                  : undefined;
      amount =
        facts.action === "ACCEPT_NEGOTIATION" ? money(facts.agreedAmountMinor, "AGREED")
          : facts.action === "CREATE_PAYMENT_INTENT" ? money(facts.paymentAmountMinor, "PAYMENT")
            : money(facts.amountMinor, "SUBMITTED");
      break;
    case "FAILED":
      title = `لم يُنفَّذ: ${noun}`;
      nextStep = outcome === "CANCELLED" ? "أُلغي بطلبك؛ لم يتغير شيء." : "لم يتغير شيء؛ يمكنك بدء مراجعة جديدة.";
      break;
    default:
      title = "تعذر التحقق من حالة هذا الإجراء";
  }
  const failure = lifecycle === "FAILED" && outcome !== "CANCELLED" && typeof facts.notice === "string" && facts.notice.trim()
    ? [...facts.notice.trim()].slice(0, MAX_FAILURE).join("")
    : undefined;
  return {
    action: facts.action,
    lifecycle,
    ...(outcome ? { outcome } : {}),
    title,
    ...(facts.resource ? { resource: [...facts.resource].slice(0, 160).join("") } : {}),
    ...amount,
    ...(facts.orderId ? { orderId: facts.orderId } : {}),
    ...(paymentState ? { paymentState } : {}),
    ...(nextStep ? { nextStep } : {}),
    requiresConfirmation: lifecycle === "REQUIRES_CONFIRMATION",
    ...(failure ? { failure } : {}),
  };
}

const NEGOTIATION_TARGETS = new Set(["COUNTER_NEGOTIATION", "ACCEPT_NEGOTIATION", "REJECT_NEGOTIATION", "WITHDRAW_NEGOTIATION"]);
const LISTING_TARGETS = new Set(["SEND_NEGOTIATION_OFFER", "REQUEST_BEST_PRICE", "PLACE_ORDER", "ADD_TO_CART", "UPDATE_LISTING_PRICE"]);

/**
 * The receipts for these ledger ids, in this order, re-read now. A row shows only when it is an
 * ACTION of this actor in this conversation; every record it names (negotiation, order, payment)
 * is read only where the actor is a party. Anything else is left out, never guessed.
 */
export async function receiptViews(scope: { actorId: string; conversationId: string }, actionIds: readonly string[]): Promise<ActionReceiptView[]> {
  const ids = [...new Set(actionIds.filter((id) => typeof id === "string" && UUID.test(id)))].slice(0, 12);
  if (!ids.length) return [];
  const rows = await db.select().from(aiResultSets).where(and(inArray(aiResultSets.id, ids), eq(aiResultSets.conversationId, scope.conversationId)));
  const owned = new Map(rows.filter((row) => {
    const query = row.query as LedgerQuery;
    return query?.kind === "ACTION" && query.ownerId === scope.actorId && typeof query.action === "string";
  }).map((row) => [row.id, row]));
  const views: ActionReceiptView[] = [];
  for (const id of ids) {
    const row = owned.get(id);
    if (!row) continue;
    const query = row.query as LedgerQuery & { targetResource?: unknown; notice?: unknown; result?: Record<string, unknown>; structuredInput?: Record<string, { value?: unknown }> };
    const action = String(query.action);
    const target = typeof query.targetResource === "string" ? query.targetResource : undefined;
    const result = query.result ?? {};
    const [market] = await db.select({ currencyCode: markets.currencyCode, minorUnitScale: markets.minorUnitScale }).from(markets).where(eq(markets.id, row.marketId));
    const party = async (negotiationId: unknown) => {
      if (typeof negotiationId !== "string") return undefined;
      const [found] = await db.select().from(negotiations).where(eq(negotiations.id, negotiationId));
      return found && (found.buyerId === scope.actorId || found.sellerId === scope.actorId) ? found : undefined;
    };
    const negotiation = NEGOTIATION_TARGETS.has(action) ? await party(target) : undefined;
    const listingId = LISTING_TARGETS.has(action) ? target : negotiation?.listingId;
    const [listing] = listingId ? await db.select({ data: offers.data }).from(offers).where(eq(offers.id, listingId)) : [];
    const orderId = action === "PLACE_ORDER" ? result.orderId : action === "CREATE_PAYMENT_INTENT" ? target : undefined;
    const [order] = typeof orderId === "string" ? await db.select({ id: orders.id, buyerId: orders.buyerId, sellerId: orders.sellerId }).from(orders).where(eq(orders.id, orderId)) : [];
    const ownOrder = order && (order.buyerId === scope.actorId || order.sellerId === scope.actorId) ? order : undefined;
    const [intent] = action === "CREATE_PAYMENT_INTENT" && typeof result.paymentIntentId === "string" && ownOrder
      ? await db.select({ status: paymentIntents.status, amountMinor: paymentIntents.amountMinor, orderId: paymentIntents.orderId }).from(paymentIntents).where(eq(paymentIntents.id, result.paymentIntentId))
      : [];
    const amountMinor = Number(query.structuredInput?.amountMinor?.value);
    const accepted = action === "ACCEPT_NEGOTIATION" ? negotiation ?? (await party(result.negotiationId)) : undefined;
    views.push(describeReceipt({
      action,
      status: query.status,
      expiresAt: row.expiresAt,
      ...(query.status === "PENDING" ? { lapsed: await pendingActionLapsed(row) } : {}),
      notice: query.notice,
      ...(Number.isInteger(amountMinor) ? { amountMinor } : {}),
      ...(accepted ? { agreedAmountMinor: accepted.agreedAmountMinor } : {}),
      ...(intent && intent.orderId === ownOrder?.id ? { paymentStatus: intent.status, paymentAmountMinor: intent.amountMinor } : {}),
      ...(ownOrder ? { orderId: ownOrder.id } : {}),
      ...(typeof (listing?.data as { title?: unknown } | undefined)?.title === "string" ? { resource: (listing!.data as { title: string }).title } : {}),
      ...(market ? { currency: { code: market.currencyCode, scale: market.minorUnitScale } } : {}),
      now: new Date(),
    }));
  }
  return views;
}

// ─── Model-authored text ─────────────────────────────────────────────────────

/** Commercial outcomes, as nouns after «تم» and as first-person or passive verbs. */
const OUTCOME_NOUNS = "(?:ال)?(?:شراء|تنفيذ|قبول|نشر|دفع|إنشاء|انشاء|فتح|تعديل|إلغاء|الغاء|حذف|رفض|إرسال|ارسال|حجز|تأكيد|تاكيد|استلام|توصيل|تحويل|سداد|اتفاق|شحن|تسليم|تثبيت)";
const CLAIM_FORMS = [
  `تمّ?\\s+${OUTCOME_NOUNS}`,
  "(?:اشتريت|قبلت|نشرت|دفعت|نفذت|نفّذت|ألغيت|حذفت|رفضت|عدّلت|عدلت|أكدت|أكّدت|استلمت|حوّلت|حولت)(?=\\s|$|[،.!؟]|ه|ها|لك)",
  "(?:أُرسل|أُنشئ|نُشر|دُفع|قُبل|انعمل|انقبل|اندفع|انشحن|وصلت?\\s+(?:الدفعة|الدفعه|الفلوس|المبلغ))",
];
/** A clause that only describes, asks, conditions or negates an outcome does not claim it. */
const NOT_A_CLAIM_BEFORE = "(?:يتم|سيتم|ستتم|يتمّ|إذا|اذا|لو|عندما|عند|حين|حينما|متى|بعد|بعدما|بعد\\s+ما|قبل|قبل\\s+ما|هل|لم|لا|ما|لن|ليس|مش|مو|ريثما|حتى|كي|لكي)";
/** «ما بقدر أقول تم الدفع», «لا أستطيع أن أؤكد تم التسليم»: a claim denied as reported speech. */
const DENIED_SPEECH = "(?:ما|لا|لن|مش|مو|ليس)\\s+(?:\\S+\\s+){0,2}(?:أقول|اقول|أكتب|اكتب|أدعي|ادعي|أؤكد|اؤكد|أأكد|أثبت|اثبت|أحكي|احكي)(?:\\s+(?:لك|إن|ان|أنه|انه))?\\s+";
// A conjunction glued to the claim («وتم إنشاء», «فتم الدفع», «وبتم الإلغاء») is still the
// speaker's own statement; without the optional proclitic the word boundary hides the whole claim.
// The alternatives must stay inside one group: joined bare, the `|` splits the whole expression and
// the lookbehinds guard only the first form, so a verb inside another word («استقبلت») reads as a
// claim, and so do the negations and questions («ما نشرت أي إعلان», «هل دفعت المبلغ»).
const ARABIC_CLAIM = new RegExp(
  `(?<!${NOT_A_CLAIM_BEFORE}\\s+(?:\\S+\\s+)?)(?<!${DENIED_SPEECH})(?<![\\p{L}\\p{M}])[وبف]*(?:${CLAIM_FORMS.join("|")})`,
  "u",
);
const ENGLISH_CLAIM =
  /(?<!\b(?:once|when|if|after|before|until|whether|no|not)\b[^.?!]{0,40})\b(?:i (?:bought|paid|accepted|published|placed|cancell?ed|confirmed|delivered)|(?:order|purchase|payment|listing|offer|delivery) (?:was |has been |is )?(?:placed|completed|confirmed|published|accepted|received|delivered)|payment received|(?:done|completed)[,.!]? (?:your )?(?:order|purchase|payment))\b/iu;

/** Quoted text («…», "…", “…”) is an example or a citation, not the speaker's own statement. */
const QUOTED = /«[^»]*»|"[^"]*"|“[^”]*”/gu;
/** Each sentence on its own, quotes removed: a question is never a claim. */
function claimSentences(text: string): string[] {
  return text
    .replace(QUOTED, " ")
    .split(/(?<=[.!؟?\n])\s*/u)
    .filter((sentence) => !/[؟?]\s*$/u.test(sentence))
    .filter((sentence) => ARABIC_CLAIM.test(sentence) || ENGLISH_CLAIM.test(sentence));
}
export function claimsCompletedAction(text: string): boolean {
  return claimSentences(text).length > 0;
}
/** The user's own commercial things: «طلبك», «إعلانك», «دفعتك», «لك», "your". */
const ADDRESSES_USER = /(?:طلب|طلبيت|إعلان|اعلان|عرض|دفعت|شحنت|سلت|حجز|مبلغ|فاتورت)(?:ك|كم|كي)(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(?:لك|لكم|إليك|اليك)(?![\p{L}\p{M}])|\byour\b/iu;
/** A completion claim about the user's own order, listing, offer or payment. */
export function claimsUsersCompletedAction(text: string): boolean {
  return claimSentences(text).some((sentence) => ADDRESSES_USER.test(sentence));
}
/**
 * DINAR's own commercial objects. A passive claim that names one — «تم إنشاء الطلب», «تم الدفع» —
 * reports a marketplace action whether or not the model added «your», and the assistant has no
 * marketplace history to speak from. General text («تم نشر نظرية النسبية») names none of them.
 */
const MARKETPLACE_OBJECT =
  /(?:ال(?:طلب|طلبيه|الطلبیه|سل[هة]ه?|دف[عع]|دفعة|فاتورة|توصيل|شراء|بيع|إعلان|اعلان|عرض|حجز|مبلغ)|\b(?:order|cart|payment|invoice|delivery|purchase|listing|offer)\b)/iu;
/** A completion claim that reads as one of DINAR's own actions, addressed to the user or not. */
export function claimsMarketplaceAction(text: string): boolean {
  return claimSentences(text).some((sentence) => ADDRESSES_USER.test(sentence) || MARKETPLACE_OBJECT.test(sentence));
}

export const MODEL_CLAIM_WITHHELD =
  "لم أنفّذ هذا الإجراء ولم يتغير شيء في حسابك؛ الإجراءات تُنفَّذ بعد مراجعتك وتأكيدك فقط. حدّد العرض أو الطلب الذي تقصده لأفتح لك مراجعته.";

/** What each registered action did, in the server's words (one per ACTION_REGISTRY name). */
export const RECEIPT_LABELS: Record<string, string> = {
  SWITCH_MARKET: "تغيّر سوق التصفح",
  UPDATE_DISPLAY_NAME: "تغيّر اسمك الظاهر",
  SEND_INQUIRY_MESSAGE: "أُرسلت رسالتك",
  UPDATE_LISTING_PRICE: "تغيّر سعر إعلانك",
  ADD_TO_CART: "أُضيف المنتج إلى سلتك",
  PLACE_ORDER: "أُنشئ الطلب",
  PUBLISH_LISTING: "نُشر إعلانك",
  SUBMIT_DRIVER_PROFILE: "قُدّم ملف السائق للمراجعة",
  ACCEPT_DELIVERY: "قبلتَ مهمة التوصيل",
  CREATE_PAYMENT_INTENT: "بدأت عملية الدفع",
  SEND_NEGOTIATION_OFFER: "أُرسل عرض سعرك للبائع",
  REQUEST_BEST_PRICE: "أُرسل طلب التسعيرة",
  COUNTER_NEGOTIATION: "أُرسل عرضك المضاد",
  ACCEPT_NEGOTIATION: "تم الاتفاق على السعر",
  REJECT_NEGOTIATION: "رُفض عرض السعر",
  WITHDRAW_NEGOTIATION: "سُحب عرض السعر",
  CREATE_PROVIDER_CONNECTION: "أُنشئ ربط المزود",
  ROTATE_PROVIDER_CREDENTIAL: "تجدّد مفتاح المزود",
  REVOKE_PROVIDER_CONNECTION: "أُلغي ربط المزود",
};

type LedgerEntry = { action: string; lifecycle: string };

/**
 * The ledger in the server's words: what was executed after the user's confirmation and what
 * still awaits it. Undefined when the ledger holds neither, so nothing is said to have happened.
 */
export function ledgerStatement(ledger: readonly LedgerEntry[]): string | undefined {
  const label = (entry: LedgerEntry) => RECEIPT_LABELS[entry.action] ?? "نُفّذ إجراء";
  const done = [...new Set(ledger.filter((entry) => entry.lifecycle === "SUCCEEDED").map(label))];
  const waiting = [...new Set(ledger.filter((entry) => entry.lifecycle === "REQUIRES_CONFIRMATION").map((entry) => entry.action))];
  if (!done.length && !waiting.length) return undefined;
  return [
    done.length ? `حسب سجل دينار في هذه المحادثة، بعد تأكيدك: ${done.join("، ")}.` : "",
    waiting.length ? "وهناك إجراء ينتظر تأكيدك ولم يُنفَّذ بعد." : "",
    "لا يوجد في السجل غير ذلك.",
  ].filter(Boolean).join(" ");
}

type AuthoredResult = {
  kind?: unknown;
  prompt?: string;
  advice?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

/**
 * The integrity boundary for model-authored turns. The model cannot execute (strict schema,
 * allowlisted suggestions, server reviews), so its text never carries an execution status: the
 * turn's lifecycle is at most PROPOSED and the ledger is the evidence. A commercial turn whose
 * text reports an outcome as done is withheld — even when the outcome is real — and the server
 * states the ledger instead (authority SERVER_LEDGER), or that nothing was done. Turns written
 * by the canonical services (no MODEL authority) are returned unchanged.
 */
export function enforceModelAuthority<T extends AuthoredResult>(result: T, ledger: readonly LedgerEntry[]): T {
  const advice = result.advice;
  // A verified read may carry the model's answer inside its own query envelope, and the route
  // renders the turn from that field; without the same guard here it would reach the user filtered
  // by nothing but the model's own confidence.
  const readBuyer = result.kind === "SEARCH" || result.kind === "RESOURCE"
    ? (result.query?.buyer as { message?: unknown; authority?: unknown } | undefined)
    : undefined;
  if (readBuyer?.authority === "MODEL" && typeof readBuyer.message === "string") {
    // The turn only ever read, so any completion claim is withheld; a plain statement about how
    // the market works («يتم إنشاء الطلب بعد تأكيدك») is teaching text and stays.
    if (!claimsCompletedAction(readBuyer.message)) return result;
    const statement = ledgerStatement(ledger) ?? MODEL_CLAIM_WITHHELD;
    return { ...result, query: { ...result.query, buyer: { message: statement, authority: "SERVER_LEDGER" } } };
  }
  if (result.kind !== "SURFACE" || advice?.authority !== "MODEL") return result;
  // In a commercial turn any completion claim is withheld; in any other turn (the model's own
  // classification is not trusted for this) a claim about the user's own order, listing, offer or
  // payment still is, and so is a passive claim naming one of DINAR's own actions. Text about the
  // world is left alone.
  const withhold = typeof result.prompt === "string" &&
    (advice.commercial === true ? claimsCompletedAction(result.prompt) : claimsMarketplaceAction(result.prompt));
  if (!withhold)
    return advice.actionLifecycle === undefined || advice.actionLifecycle === "PROPOSED"
      ? result
      : { ...result, advice: { ...advice, actionLifecycle: "PROPOSED" } };
  const statement = ledgerStatement(ledger);
  return {
    ...result,
    prompt: statement ?? MODEL_CLAIM_WITHHELD,
    advice: {
      ...advice,
      claimWithheld: true,
      ...(statement
        ? { authority: "SERVER_LEDGER", scope: "DINAR_LEDGER", actionLifecycle: undefined, ledger: ledger.map(({ action, lifecycle }) => ({ action, lifecycle })) }
        : { actionLifecycle: "PROPOSED" }),
    },
  };
}
