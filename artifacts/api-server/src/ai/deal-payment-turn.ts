/**
 * Conversation side of Payment Preferences & Agreement. Deterministic: the phrases below are the
 * user's own words; the model never decides a method, an agreement or a payment state. Every write
 * goes through lib/deal-payments/service.ts, which checks both parties' consent server-side.
 *
 * It claims a turn only when the words are about paying AND (for order actions) the actor is the
 * buyer or seller of an order in view, and never while the actor has an open purchase/payment
 * review (those keep their own «كاش»/«فيزا»/«نعم»).
 */
import { and, desc, eq, or } from "drizzle-orm";
import { aiResultSets, aiUiBlocks, db, orders } from "@workspace/db";
import type { ToolResult } from "./tool-registry";
import { normalizeBuyerText } from "./buyer-turn";
import { methodLabel, methodsInText, offerableMethods, resolveCountry } from "../lib/deal-payments/catalog";
import { dealPaymentsEnabled } from "../lib/deal-payments/flag";
import { applyDealAction, dealCard, DealPaymentError, sellerMethodsView, setSellerMethods, type DealAction } from "../lib/deal-payments/service";

type Turn = { tool: string; version: number; result: ToolResult };
type MarketRef = { id: string; countryCode: string; currencyCode: string; minorUnitScale: number };

const notice = (prompt: string): Turn => ({ tool: "dealPayment", version: 1, result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], prompt } });
const cardTurn = (card: Awaited<ReturnType<typeof dealCard>>, prompt: string): Turn => ({
  tool: "dealPayment",
  version: 1,
  result: { kind: "SURFACE", surface: "DEAL_CARD" as never, resourceId: card.orderId, resourceIds: [card.orderId], query: {}, listings: [], dealCard: card, prompt },
});

const PAYMENT_WORDS = /(?:دفع|الدفع|ادفع|بدفع|ندفع|تدفع|دفعت|حولت|حوالت|حواله|تحويل|المبلغ|كاش|نقد|كليك|cliq|محفظ|طرق الدفع|طريقه الدفع|عند الاستلام)/u;
const SELLER_ACCEPTS = /(?:^|\s)(?:اقبل|بقبل|نقبل|اقبله|استقبل|بستقبل|استلم المبلغ|استلم الدفع)(?:\s|$)|طرق الدفع (?:التي|اللي|الي) (?:اقبلها|بقبلها|اقبل)/u;
const SELLER_METHODS_QUERY = /^(?:شو|ما|ايش|وش|ماهي|ما هي)?\s*(?:طرق|وسائل) الدفع(?: التي| اللي)? (?:اقبلها|عندي|المقبوله|تبعي)$/u;
const ASK_ACCEPT = /(?:هل|بيقبل|يقبل|يقبل البائع|بقبل البائع|ممكن)\s.*(?:يقبل|اقدر|ممكن|مسموح)|^(?:هل|ممكن)\s/u;
const BUYER_PREFERS = /(?:افضل|بفضل|ابي|ابغي|بدي|اريد|حابب|حاب|راح|رح|بدفع|ادفع|سادفع|اقدر)/u;
const AGREE = /^(?:موافق|اوافق|وافقت|تمام موافق|قبلت|اقبل الاقتراح|موافق علي .*)$/u;
const DISAGREE = /^(?:ارفض|رفضت|لا اوافق|مش موافق|غير موافق|لا اقبل|ما بقبل|ما اقبل)(?:\s.*)?$/u;
const REPORT_PAID = /^(?:(?:انا\s+)?(?:دفعت|حولت|حولتلك|حولت المبلغ|تم الدفع|تم التحويل|ارسلت المبلغ|بعثت المبلغ|خلصت الدفع))(?:\s.*)?$/u;
const NOT_RECEIVED = /(?:ما وصلني|لم يصلني|ما وصل|لم يصل|ما استلمت|لم استلم|مش واصل)(?:\s|$).*(?:مبلغ|المبلغ|التحويل|الفلوس|المصاري|الدفع)?/u;
const RECEIVED = /^(?:(?:انا\s+)?(?:استلمت|وصلني|وصل|قبضت|حصلت))\s+(?:المبلغ|التحويل|الفلوس|المصاري|الدفع|الكاش|الحواله)(?:\s.*)?$/u;
const SHARE = /(?:شارك|ارسل|اعرض|ابعث)\s+(?:بيانات|تفاصيل|معلومات)\s+(?:الدفع|التحويل|الحساب)/u;
const CANCEL = /(?:الغ|الغي|إلغاء|الغاء)\s+(?:اتفاق الدفع|الاتفاق علي الدفع|طريقه الدفع)/u;
const SHOW = /^(?:كيف (?:ادفع|بدفع|ندفع|الدفع)|كيف تفضل الدفع|طرق الدفع|طريقه الدفع|بطاقه الصفقه|تفاصيل الصفقه|شو طرق الدفع|ما طرق الدفع)(?:\s.*)?$/u;
const PRIVACY = /(?:ما بدي|لا اريد|ما ابي|مش حابب|لا ابغي)\s+(?:اشارك|مشاركه|اعطي|ارسل)\s+(?:رقم|بيانات|معلومات)/u;
const PAY_AFTER = /(?:بعد|عند)\s+(?:وصول|استلام)\s+(?:المنتج|الطلب|الغرض|القطعه)/u;

async function latestIsDealCard(conversationId: string) {
  const [latest] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  return Boolean((latest?.payload as { dealCard?: unknown } | undefined)?.dealCard);
}

async function hasOpenOwnReview(conversationId: string, marketId: string, actorId: string) {
  const [latest] = await db
    .select({ query: aiResultSets.query, expiresAt: aiResultSets.expiresAt })
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const query = latest?.query as { ownerId?: unknown; status?: unknown } | undefined;
  return Boolean(query && query.ownerId === actorId && query.status === "PENDING" && (!latest!.expiresAt || latest!.expiresAt.getTime() > Date.now()));
}

/** The order in view: an 8-character reference in the message, else the latest order/deal card shown here. */
async function orderInView(conversationId: string, actorId: string, marketId: string, text: string): Promise<string | undefined> {
  const party = (orderId: string) =>
    db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.marketId, marketId), or(eq(orders.buyerId, actorId), eq(orders.sellerId, actorId))))
      .then((rows) => rows[0]?.id);
  const reference = text.match(/(?:^|\s)#?([0-9a-f]{8})(?=\s|$)/iu)?.[1]?.toUpperCase();
  if (reference) {
    const mine = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.marketId, marketId), or(eq(orders.buyerId, actorId), eq(orders.sellerId, actorId))))
      .orderBy(desc(orders.createdAt))
      .limit(200);
    const found = mine.find((row) => row.id.replace(/-/g, "").slice(0, 8).toUpperCase() === reference);
    if (found) return found.id;
  }
  const blocks = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(20);
  for (const block of blocks) {
    const payload = (block.payload ?? {}) as { surface?: unknown; resourceId?: unknown; delivery?: unknown; dealCard?: unknown };
    if (typeof payload.resourceId === "string" && (payload.surface === "ORDER" || payload.surface === "DEAL_CARD" || payload.surface === "PAYMENT_REVIEW" || payload.delivery || payload.dealCard)) {
      const id = await party(payload.resourceId);
      if (id) return id;
    }
  }
  return undefined;
}

export async function executeDealPaymentTurn(input: { conversationId: string; message: string; market: MarketRef; actorId?: string }): Promise<Turn | null> {
  if (!input.actorId || !dealPaymentsEnabled()) return null;
  const text = normalizeBuyerText(input.message);
  if (![PAYMENT_WORDS, AGREE, DISAGREE, RECEIVED, SHOW, PRIVACY, PAY_AFTER].some((pattern) => pattern.test(text))) return null;
  // A bare «موافق»/«أرفض» belongs to the deal card only when the deal card is the latest thing shown.
  if (!PAYMENT_WORDS.test(text) && (AGREE.test(text) || DISAGREE.test(text)) && !(await latestIsDealCard(input.conversationId))) return null;
  if (await hasOpenOwnReview(input.conversationId, input.market.id, input.actorId)) return null;
  const actorId = input.actorId;
  try {
    return await route(input, actorId, text);
  } catch (error) {
    if (error instanceof DealPaymentError) return notice(`${error.message} لم يتغير شيء.`);
    throw error;
  }
}

async function route(input: { conversationId: string; message: string; market: MarketRef }, actorId: string, text: string): Promise<Turn | null> {
  const country = await resolveCountry(input.market.countryCode);
  const available = offerableMethods(country, input.market.currencyCode).map((m) => m.code);
  const orderId = await orderInView(input.conversationId, actorId, input.market.id, text);

  // Seller preferences outside an order: «أقبل كليك وكاش», «طرق الدفع التي أقبلها».
  if (!orderId || SELLER_ACCEPTS.test(text) && !/(?:الاقتراح|التغيير)/u.test(text)) {
    if (SELLER_METHODS_QUERY.test(text)) return sellerSummary(actorId, input.market, "");
    if (SELLER_ACCEPTS.test(text)) {
      const { codes, ambiguousCash } = methodsInText(input.message, available);
      if (ambiguousCash) return notice("تقصد كاش عند التوصيل (الدفع عند الاستلام) أم كاش يدًا بيد عند الاستلام الشخصي؟ أو الاثنين؟");
      if (!codes.length) {
        if (!orderId) return sellerSummary(actorId, input.market, "أي طرق الدفع تقبل؟");
      } else {
        const unavailable = codes.filter((code) => !available.includes(code));
        const accepted = codes.filter((code) => available.includes(code));
        if (!accepted.length)
          return notice(`${unavailable.map((c) => `«${methodLabel(c)}»`).join(" و")} غير متاحة كخيار في ${country?.nameAr ?? "بلدك"} حاليًا. المتاح: ${available.map((c) => methodLabel(c)).join("، ")}.`);
        await setSellerMethods({ sellerId: actorId, market: input.market, methods: accepted.map((code) => ({ code })) });
        return sellerSummary(
          actorId,
          input.market,
          `ممتاز، سأعرض للمشتري ${accepted.map((c) => methodLabel(c)).join(" و")}.${unavailable.length ? ` (${unavailable.map((c) => methodLabel(c)).join("، ")} غير متاحة في بلدك حاليًا، فلم أضفها.)` : ""}${accepted.some((c) => c !== "COD" && c !== "CASH_IN_PERSON") ? " بيانات التحويل اختيارية الآن، ولن تظهر لأي مشترٍ إلا بعد الاتفاق وموافقتك." : ""}`,
        );
      }
    }
    if (!orderId) return null;
  }

  const market = input.market;
  const current = await dealCard({ actorId, orderId, market });
  const act = async (action: DealAction) => {
    const out = await applyDealAction({ actorId, orderId, market, action });
    return cardTurn(out.card, out.message);
  };
  const role = current.viewerRole;

  if (PRIVACY.test(text))
    return cardTurn(current, "لن تُشارك أي بيانات دفع قبل الاتفاق على الطريقة، وبيانات البائع لا تظهر إلا بموافقته وللمشتري في هذا الطلب فقط. لا يطلب جاسم رقم بطاقة أو كلمة مرور أو رمز تحقق أبدًا.");
  if (CANCEL.test(text)) return act({ type: "CANCEL" });
  if (SHARE.test(text) && role === "SELLER") return act({ type: "SHARE_INSTRUCTIONS" });
  if (role === "BUYER" && REPORT_PAID.test(text)) return act({ type: "REPORT_PAID", note: input.message.slice(0, 300) });
  if (role === "SELLER" && NOT_RECEIVED.test(text)) return act({ type: "REPORT_NOT_RECEIVED" });
  if (role === "SELLER" && RECEIVED.test(text)) return act({ type: current.status === "COD_PENDING_DELIVERY" ? "COD_COLLECTED" : "CONFIRM_RECEIPT" });
  if (current.proposal && current.proposal.awaiting === role) {
    if (AGREE.test(text)) return act({ type: "RESPOND", accept: true });
    if (DISAGREE.test(text)) return act({ type: "RESPOND", accept: false });
  }

  const candidates = current.acceptedMethods.map((m) => m.code);
  const { codes, ambiguousCash } = methodsInText(input.message, candidates);
  const acceptedLabels = current.acceptedMethods.filter((m) => m.available).map((m) => m.label).join(" أو ");

  if (PAY_AFTER.test(text) && !codes.length) {
    const cod = current.acceptedMethods.find((m) => m.code === "COD");
    return cardTurn(
      current,
      cod?.available
        ? "البائع يقبل الدفع نقدًا عند الاستلام. اكتب «أفضل الدفع عند الاستلام» لاعتماده."
        : cod
          ? `الدفع عند الاستلام غير متاح لهذا الطلب: ${(cod as { reason?: string }).reason ?? ""}`.trim()
          : `البائع لم يذكر الدفع عند الاستلام. يمكنك اقتراحه بكتابة «أقترح الدفع عند الاستلام»، وسيُسأل البائع. الطرق المقبولة الآن: ${acceptedLabels || "لا شيء بعد"}.`,
    );
  }
  if (ambiguousCash)
    return cardTurn(current, "تقصد الدفع نقدًا عند التوصيل، أم كاش يدًا بيد عند الاستلام الشخصي؟");

  if (codes.length > 1 && role === "BUYER" && !ASK_ACCEPT.test(text)) {
    const common = codes.filter((c) => candidates.includes(c));
    if (common.length === 1) return act({ type: "CHOOSE", method: common[0]! });
    return cardTurn(current, common.length ? `البائع يقبل ${common.map((c) => methodLabel(c)).join(" و")}. اختر واحدة.` : `لا توجد طريقة مشتركة بين ما ذكرته وما يقبله البائع (${acceptedLabels || "لم يحدد بعد"}). يمكنك اقتراح إحداها وسيُسأل البائع.`);
  }
  if (codes.length === 1) {
    const code = codes[0]!;
    if (ASK_ACCEPT.test(text) && !/(?:اقترح|اعتمد)/u.test(text)) {
      const entry = current.acceptedMethods.find((m) => m.code === code);
      return cardTurn(
        current,
        entry
          ? entry.available
            ? `نعم، البائع يقبل ${entry.label}. اكتب «أفضل ${entry.label}» لاعتمادها.`
            : `البائع يقبل ${entry.label}، لكنها غير متاحة لهذا الطلب: ${(entry as { reason?: string }).reason ?? ""}`.trim()
          : `البائع لم يذكر ${methodLabel(code)} ضمن طرقه (${acceptedLabels || "لم يحدد بعد"}). أستطيع أن أقترحها عليه؛ اكتب «أقترح ${methodLabel(code)}».`,
      );
    }
    if (BUYER_PREFERS.test(text) || /(?:اقترح|اعتمد|غير|غيّر|بدل)/u.test(text) || text.split(" ").length <= 3)
      return act({ type: "CHOOSE", method: code });
  }
  if (SHOW.test(text)) {
    const prompt =
      role === "BUYER"
        ? current.agreedMethod
          ? `طريقة الدفع المتفق عليها: ${current.agreedMethod.label}.`
          : acceptedLabels
            ? `كيف تفضّل الدفع؟ البائع يقبل ${acceptedLabels}. يمكنك أيضًا اقتراح وسيلة أخرى وسيُسأل البائع.`
            : "البائع لم يحدد طرق الدفع بعد؛ يمكنك اقتراح وسيلة وسيُسأل البائع."
        : current.proposal?.awaiting === "SELLER"
          ? `المشتري يقترح ${current.proposal.label}. اكتب «موافق» أو «أرفض».`
          : `حالة الدفع: ${current.statusLabel}.`;
    return cardTurn(current, prompt);
  }
  return null;
}

async function sellerSummary(actorId: string, market: MarketRef, lead: string): Promise<Turn> {
  const view = await sellerMethodsView(actorId, market);
  const accepted = view.accepted.filter((m) => !m.paused && m.offerable).map((m) => m.label);
  const options = view.available.map((m) => m.label).join("، ");
  return notice(
    `${lead ? `${lead} ` : ""}${accepted.length ? `طرق الدفع التي تقبلها الآن: ${accepted.join("، ")}.` : "لم تحدد طرق دفع بعد."} المتاح في بلدك: ${options || "لا شيء حاليًا"}. يمكنك اختيار أكثر من طريقة، والدفع يتم مباشرة بينك وبين المشتري؛ جاسم لا يستلم الأموال.`,
  );
}
