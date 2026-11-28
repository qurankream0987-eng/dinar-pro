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
import { declaredCode, METHODS, methodLabel, methodsInText, offerableMethods, resolveCountry } from "../lib/deal-payments/catalog";
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
  if (![PAYMENT_WORDS, AGREE, DISAGREE, RECEIVED, SHOW, PRIVACY, PAY_AFTER].some((pattern) => pattern.test(text)) && !(SELLER_ACCEPTS.test(text) && methodsInText(input.message, Object.keys(METHODS)).codes.length)) return null;
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
      const found = methodsInText(input.message, available);
      // «زين كاش» is a wallet's name, not cash: a multi-word named method wins over bare «كاش».
      const walletNames = namedMethods(input.message, "SELLER").filter(isSpecificWallet);
      const codes = walletNames.length ? found.codes.filter((c) => !GENERIC_CODES.has(c)) : found.codes;
      if (found.ambiguousCash && !walletNames.length) return notice("تقصد كاش عند التوصيل (الدفع عند الاستلام) أم كاش يدًا بيد عند الاستلام الشخصي؟ أو الاثنين؟");
      // Open choice: a method the catalog does not know is accepted under the seller's own name for it.
      const named = namedMethods(input.message, "SELLER").filter((n) => walletNames.includes(n) || !methodsInText(n, available).codes.length);
      if (!codes.length && !named.length) {
        if (!orderId) return sellerSummary(actorId, input.market, "أي طرق الدفع تقبل؟");
      } else {
        const methods = [...codes.map((code) => ({ code })), ...named.map((label) => ({ code: declaredCode(label)!, customLabel: label }))].filter((m) => m.code);
        const refused: string[] = [];
        const accepted: typeof methods = [];
        for (const m of methods) {
          try {
            await setSellerMethods({ sellerId: actorId, market: input.market, methods: [m] });
            accepted.push(m);
          } catch (error) {
            if (!(error instanceof DealPaymentError)) throw error;
            refused.push(`${methodLabel(m.code, (m as { customLabel?: string }).customLabel)} (${error.message})`);
          }
        }
        if (!accepted.length) return notice(`لم أضف شيئًا: ${refused.join("؛ ")}`);
        const labels = accepted.map((m) => methodLabel(m.code, (m as { customLabel?: string }).customLabel));
        const unverified = accepted.filter((m) => !available.includes(m.code)).map((m) => methodLabel(m.code, (m as { customLabel?: string }).customLabel));
        return sellerSummary(
          actorId,
          input.market,
          `ممتاز، سأعرض للمشتري ${labels.join(" و")}.${unverified.length ? ` (${unverified.join("، ")}: وسيلة تتفقان عليها بينكما؛ لم يتحقق جاسم من توفرها.)` : ""}${refused.length ? ` لم أضف: ${refused.join("؛ ")}.` : ""}${accepted.some((m) => m.code !== "COD" && m.code !== "CASH_IN_PERSON") ? " بيانات الدفع تُدخلها لاحقًا في نموذج محمي داخل بطاقة الصفقة، ولن تظهر لأي مشترٍ قبل الاتفاق وموافقتك." : ""}`,
        );
      }
    }
    if (!orderId) return null;
  }

  const market = input.market;
  const current = await dealCard({ actorId, orderId, market });
  const act = async (action: DealAction) => {
    const out = await applyDealAction({ actorId, orderId, market, action });
    const card = out.card;
    const next =
      card.viewerRole === "SELLER" && card.instructionsState === "SELLER_TO_PROVIDE"
        ? ` أدخل بيانات ${card.agreedMethod?.label ?? "الدفع"} في النموذج المحمي داخل البطاقة، ولا تكتبها في المحادثة.${card.agreedMethod?.requiresMerchantCheckout ? " هذه الوسيلة تحتاج رابط صفحة الدفع التجارية الخاصة بك، لا رقم بطاقة." : ""}`
        : card.viewerRole === "BUYER" && card.agreedMethod && card.instructionsState !== "NOT_APPLICABLE" && card.instructionsState !== "SHARED"
          ? " ستظهر تعليمات الدفع في المساحة المحمية بعد أن يشاركها البائع."
          : card.viewerRole === "BUYER" && card.instructionsState === "SHARED"
            ? " تعليمات الدفع جاهزة في المساحة المحمية داخل البطاقة."
            : "";
    const standing = card.agreedMethod && card.agreedMethod.standing === "USER_DECLARED_METHOD" ? " تنبيه: هذه وسيلة اتفقتما عليها، ولم يتحقق جاسم من توفرها أو أمانها." : "";
    return cardTurn(card, `${out.message}${next}${standing}`);
  };
  const role = current.viewerRole;

  if (role === "SELLER" && current.instructionsState === "SELLER_TO_PROVIDE" && /(?:[A-Z]{2}\d{2}[A-Z0-9]{10,}|\d{7,})/iu.test(input.message.replace(/\s+/g, "")))
    return cardTurn(current, "لم أحفظ هذه البيانات من المحادثة. أدخلها في النموذج المحمي داخل بطاقة الصفقة حتى تُعرض للمشتري وحده؛ ويُفضّل حذف رسالتك.");
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
  const buyerFound = methodsInText(input.message, candidates);
  const buyerWallets = namedMethods(input.message, "BUYER").filter(isSpecificWallet);
  const codes = buyerWallets.length ? buyerFound.codes.filter((c) => !GENERIC_CODES.has(c)) : buyerFound.codes;
  const ambiguousCash = buyerFound.ambiguousCash && !buyerWallets.length;
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
  if (!codes.length && role === "BUYER" && !ASK_ACCEPT.test(text)) {
    const [named] = namedMethods(input.message, "BUYER");
    const code = named ? declaredCode(named) : null;
    if (named && code) {
      const accepted = current.acceptedMethods.find((m) => m.code === code);
      return act({ type: "CHOOSE", method: code, ...(accepted ? {} : { customLabel: named }) });
    }
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

/** «زين كاش», «محفظة نجمة»: a specific product name built on a generic word is not the generic method. */
const GENERIC_CODES = new Set(["COD", "CASH_IN_PERSON", "LOCAL_WALLET"]);
const isSpecificWallet = (name: string) => /\s(?:كاش|cash)$/u.test(name) || /^(?:محفظه|المحفظه)\s+\S+/u.test(name);
const GENERIC_NAMES = /^(?:الدفع|دفع|المبلغ|التحويل|تحويل|كاش|نقدا|نقد|هذا|هذه|البطاقه|بطاقه|فيزا)$/u;
/**
 * Method names a party used that the catalog does not know: «أقبل زين كاش وأورنج موني»,
 * «أفضل الدفع عن طريق محفظة X». Order references and filler words are dropped.
 */
function namedMethods(message: string, who: "SELLER" | "BUYER"): string[] {
  const text = normalizeBuyerText(message).replace(/(?:^|\s)#?[0-9a-f]{8}(?=\s|$)/giu, " ").trim();
  const match =
    who === "SELLER"
      ? text.match(/(?:اقبل|بقبل|نقبل|استقبل|بستقبل)\s+(?:الدفع\s+)?(?:ب|عن طريق|عبر|من خلال)?\s*(.+)$/u)
      : text.match(/(?:الدفع|ادفع|بدفع|سادفع|احول|بحول)\s+(?:عن طريق|عبر|بواسطه|من خلال|ب)\s*(.+)$/u);
  if (!match) return [];
  return match[1]!
    .split(/\s+(?:او|و)\s*|،|,/u)
    .map((part) => part.replace(/^(?:ال)?(?:دفع\s+)?(?:ب|عن طريق|عبر)\s+/u, "").trim())
    .filter((part) => part.length >= 2 && part.length <= 40 && !GENERIC_NAMES.test(part));
}

async function sellerSummary(actorId: string, market: MarketRef, lead: string): Promise<Turn> {
  const view = await sellerMethodsView(actorId, market);
  const accepted = view.accepted.filter((m) => !m.paused && m.offerable).map((m) => m.label);
  const options = view.available.map((m) => m.label).join("، ");
  return notice(
    `${lead ? `${lead} ` : ""}${accepted.length ? `طرق الدفع التي تقبلها الآن: ${accepted.join("، ")}.` : "لم تحدد طرق دفع بعد."} المتاح في بلدك: ${options || "لا شيء حاليًا"}. يمكنك اختيار أكثر من طريقة، والدفع يتم مباشرة بينك وبين المشتري؛ جاسم لا يستلم الأموال.`,
  );
}
