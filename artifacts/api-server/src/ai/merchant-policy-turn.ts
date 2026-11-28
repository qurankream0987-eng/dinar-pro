/**
 * Merchant policies through the conversation (M1). The merchant speaks naturally; this turn maps
 * the words to ONE typed proposal (deterministic patterns, never the model's free text), and the
 * engine validates, checks permission and conflicts, and waits for the confirmation the change's
 * sensitivity requires. Anything it cannot map with confidence becomes a clarifying question.
 *
 * Claimed only for an actor who can manage a business and whose words are clearly a store rule.
 */
import { and, desc, eq } from "drizzle-orm";
import { aiUiBlocks, db, merchantPolicies } from "@workspace/db";
import type { ToolResult } from "./tool-registry";
import { normalizeBuyerText } from "./buyer-turn";
import { methodsInText, METHODS } from "../lib/deal-payments/catalog";
import { cancelProposal, confirmPolicy, effectivePolicy, manageableBusinesses, MerchantPolicyError, proposePolicy } from "../lib/merchant-policies/engine";
import type { PolicyKind } from "../lib/merchant-policies/kinds";

type Turn = { tool: string; version: number; result: ToolResult };
type MarketRef = { id: string; countryCode: string; minorUnitScale: number };

const say = (prompt: string): Turn => ({ tool: "merchantPolicy", version: 1, result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], prompt } });
const reviewTurn = (review: Record<string, unknown>, prompt: string): Turn => ({
  tool: "merchantPolicy",
  version: 1,
  result: { kind: "SURFACE", surface: "MERCHANT_POLICY_REVIEW" as never, query: {}, listings: [], merchantPolicy: review, prompt },
});

const COUNTRY_NAMES: Record<string, string> = { الاردن: "JO", السعوديه: "SA", الامارات: "AE", الكويت: "KW", قطر: "QA", البحرين: "BH", عمان: "OM", مصر: "EG", العراق: "IQ", فلسطين: "PS", لبنان: "LB", سوريا: "SY", المغرب: "MA", تونس: "TN", الجزائر: "DZ", ليبيا: "LY", السودان: "SD", اليمن: "YE" };
const num = (s: string) => Number(s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));

/** One typed proposal from the merchant's words, or a reason it needs clarification. */
type Parsed = { kind: PolicyKind; rule: Record<string, unknown> } | { clarify: string };
async function parse(text: string, raw: string, market: MarketRef, businessId: string): Promise<Parsed | null> {
  const minor = (value: number) => Math.round(value * 10 ** market.minorUnitScale);
  if (/(?:اوقف|اوقفي|علق|اغلق)\s+(?:استقبال\s+)?(?:الطلبات|المتجر)/u.test(text)) return { kind: "ORDERING_PAUSED", rule: { paused: true } };
  if (/(?:فعل|استانف|افتح|اعد تفعيل)\s+(?:استقبال\s+)?(?:الطلبات|المتجر)/u.test(text)) return { kind: "ORDERING_PAUSED", rule: { paused: false } };
  if (/(?:نفد|نفذ|غير متوفر|مش متوفر|خلص المخزون)/u.test(text) && /(?:اخبر|قل|بلغ|خبر)/u.test(text)) {
    if (/(?:لا نبيعه|لا نبيع|ما نبيعه|متوقف عن البيع)/u.test(text)) return { kind: "OUT_OF_STOCK", rule: { action: "NOT_SOLD", message: "هذا المنتج غير متاح للبيع حاليًا.", promiseDate: null } };
    const capture = /(?:خذ|سجل|احفظ)\s+(?:رقم|ارقام|اهتمام|رقمه|بياناته|بياناتهم|ارقامهم|رقمهم)/u.test(text);
    return { kind: "OUT_OF_STOCK", rule: { action: capture ? "TELL_AND_CAPTURE_INTEREST" : "TELL_ONLY", message: /(?:سيعود|يرجع|بيرجع|سيتوفر)/u.test(text) ? "غير متوفر حاليًا، ومن المتوقع أن يعود لاحقًا." : "غير متوفر حاليًا.", promiseDate: null } };
  }
  if (/(?:اقترح|اعرض)\s+(?:ال)?بدائل/u.test(text)) return { kind: "ALTERNATIVES", rule: { suggest: !/(?:لا|ما)\s+(?:تقترح|تعرض)/u.test(text) } };
  const minQty = text.match(/(?:لا تقبل|ارفض)\s+(?:اي\s+)?(?:طلبات?|طلب)\s+(?:باقل|اقل)\s+من\s+(\d+)\s*(?:قطع|قطعه|حبات|حبه|وحدات|وحده)/u);
  if (minQty) return { kind: "MIN_ORDER", rule: { minQuantity: num(minQty[1]!) } };
  const minAmount = text.match(/(?:لا تقبل|ارفض)\s+(?:اي\s+)?(?:طلبات?|طلب)\s+(?:باقل|اقل)\s+من\s+(\d+(?:\.\d+)?)\s*(?:دينار|دنانير|ريال|درهم|جنيه)/u);
  if (minAmount) return { kind: "MIN_ORDER", rule: { minAmountMinor: minor(num(minAmount[1]!)) } };
  const cod = text.match(/الدفع عند الاستلام\s+(?:متاح\s+)?(?:فقط\s+)?(?:في|ل)\s+(.+)$/u);
  if (cod) {
    const areas = cod[1]!.split(/\s*(?:،|,|\s+و\s*|\s+او\s+)\s*/u).map((a) => a.replace(/^(?:منطقه|مدينه)\s+/u, "").trim()).filter((a) => a.length >= 2 && a.length <= 60);
    return areas.length ? { kind: "COD_AREAS", rule: { areas } } : { clarify: "ما المناطق التي تريد الدفع عند الاستلام فيها؟" };
  }
  const fee = text.match(/(?:رسوم|سعر|اجره)\s+(?:الشحن|التوصيل)\s+(\d+(?:\.\d+)?)/u);
  if (fee) {
    const free = text.match(/مجاني\s+(?:فوق|لاكثر من|للطلبات فوق)\s+(\d+(?:\.\d+)?)/u);
    return { kind: "SHIPPING", rule: { feeMinor: minor(num(fee[1]!)), ...(free ? { freeAboveMinor: minor(num(free[1]!)) } : {}) } };
  }
  if (/(?:لا|ممنوع)\s+(?:تتفاوض|تفاوض|التفاوض)/u.test(text)) return { kind: "PRICE_NEGOTIATION", rule: { allowed: false } };
  if (/(?:التفاوض|تتفاوض|تفاوض)/u.test(text)) {
    const pct = text.match(/(\d+(?:\.\d+)?)\s*(?:%|٪|بالمئه|في المئه)/u);
    if (!pct) return { clarify: "ما أقصى خصم تسمح لجاسم أن يتفاوض عليه؟ مثلًا «يمكن التفاوض حتى 10%»." };
    return { kind: "PRICE_NEGOTIATION", rule: { allowed: true, maxDiscountBps: Math.round(num(pct[1]!) * 100) } };
  }
  const discount = text.match(/خصم\s+(\d+(?:\.\d+)?)\s*(?:%|٪|بالمئه)/u);
  if (discount) {
    if (/(?:هذا المنتج|على منتج|للمنتج)/u.test(text)) return { clarify: "الخصم لمنتج بعينه يُحدد من بطاقة المنتج حتى لا أخطئ المنتج. هل تقصد خصمًا على المتجر كله؟" };
    return { kind: "DISCOUNT", rule: { percentBps: Math.round(num(discount[1]!) * 100) } };
  }
  const bulk = text.match(/(?:كميه كبيره|كميات كبيره|اكثر من\s+(\d+)\s*(?:قطعه|قطع|حبه))/u);
  if (bulk && /(?:تواصل|سعر خاص|عرض سعر)/u.test(text)) {
    const threshold = bulk[1] ? num(bulk[1]) : null;
    return threshold ? { kind: "BULK_INQUIRY", rule: { thresholdQuantity: threshold, action: "CONTACT_FOR_QUOTE" } } : { clarify: "من كم قطعة تعتبر الطلب كمية كبيرة؟" };
  }
  if (/(?:العميل|الزبون)\s+شركه/u.test(text) && /(?:اساله|اسال|اسأل)/u.test(text)) return { kind: "B2B_QUESTIONS", rule: { askQuantity: /الكميه/u.test(text), askCompanyName: /اسم الشركه/u.test(text) } };
  const geo = text.match(/(?:لا تعرض|لا تبيع).*?(?:الا|فقط)\s+(?:للعملاء\s+)?(?:في|داخل)\s+(.+)$/u);
  if (geo) {
    const codes = geo[1]!.split(/\s*(?:،|,|\s+و\s*)\s*/u).map((n) => COUNTRY_NAMES[n.replace(/^ال(?=ال)/u, "").trim()]).filter(Boolean) as string[];
    return codes.length ? { kind: "GEO_RESTRICTION", rule: { allowedCountries: [...new Set(codes)] } } : { clarify: "في أي دول تريد البيع؟" };
  }
  if (/(?:طرق الدفع|وسائل الدفع|البوابه)/u.test(text) && /(?:اضف|ضيف|اقبل|فعل)/u.test(text)) {
    const added = methodsInText(raw, Object.keys(METHODS)).codes.filter((c) => c !== "OTHER_AGREED");
    if (!added.length) return { clarify: "أي طريقة دفع تريد إضافتها؟" };
    const current = await effectivePolicy(businessId, "PAYMENT_METHODS");
    const existing = ((current?.rule as { methods?: { code: string }[] } | undefined)?.methods ?? []).map((m) => m.code);
    const keep = !/(?:الغ|اوقف)\s+(?:ال)?بوابه/u.test(text);
    return { kind: "PAYMENT_METHODS", rule: { methods: [...new Set([...existing, ...added])].map((code) => ({ code })), keepStoreGateway: keep } };
  }
  return null;
}

const POLICY_CUE = /(?:اذا|إذا|عندما|لو)\s+(?:طلب|سال|نفد|نفذ|كان)|(?:اوقف|استانف|فعل)\s+(?:استقبال|المتجر|الطلبات)|لا تقبل طلبات|الدفع عند الاستلام\s+(?:متاح\s+)?(?:فقط\s+)?(?:في|ل)|رسوم (?:الشحن|التوصيل)|التفاوض|تتفاوض|خصم\s+\d|اقترح البدائل|اعرض البدائل|لا تعرض|طرق الدفع|البوابه/u;

async function latestReview(conversationId: string) {
  const [block] = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, conversationId)).orderBy(desc(aiUiBlocks.createdAt)).limit(1);
  const review = (block?.payload as { merchantPolicy?: { policy?: { id?: string } } } | undefined)?.merchantPolicy;
  return typeof review?.policy?.id === "string" ? review.policy.id : null;
}

export async function executeMerchantPolicyTurn(input: { conversationId: string; message: string; market: MarketRef; actorId?: string }): Promise<Turn | null> {
  if (!input.actorId) return null;
  const text = normalizeBuyerText(input.message);
  const confirm = /^(?:نعم|اكد|أكد|تمام|موافق|اعتمد|نعم اعتمد)$/u.test(text);
  const cancel = /^(?:الغ|إلغاء|الغاء|لا|تراجع)$/u.test(text);
  if (confirm || cancel) {
    const policyId = await latestReview(input.conversationId);
    if (!policyId) return null;
    const [policy] = await db.select().from(merchantPolicies).where(eq(merchantPolicies.id, policyId));
    if (!policy || policy.status !== "PROPOSED") return null;
    try {
      if (cancel) {
        await cancelProposal({ actorId: input.actorId, policyId });
        return say("ألغيت الاقتراح؛ لم يتغير شيء في سياسات متجرك.");
      }
      if (policy.sensitivity !== "NORMAL")
        return say("هذا تغيير حساس، فأكّده من زر «تأكيد» في بطاقة المراجعة بعد قراءة آثاره." + (policy.sensitivity === "HIGH_RISK" ? " وقد يُطلب منك تسجيل دخول جديد عبر صفحة الدخول الرسمية." : ""));
      const view = await confirmPolicy({ actorId: input.actorId, policyId, expectedVersion: policy.version, channel: "CHAT" });
      return say(`تم تفعيل سياسة «${view.kindLabel}» (النسخة ${view.version}). سأطبقها من الإعدادات المحفوظة، لا من نص المحادثة.`);
    } catch (error) {
      if (error instanceof MerchantPolicyError) return say(`${error.message} لم يتغير شيء.`);
      throw error;
    }
  }
  if (!POLICY_CUE.test(text)) return null;
  const businesses = await manageableBusinesses(input.actorId);
  if (!businesses.length) return null;
  const named = businesses.filter((b) => text.includes(normalizeBuyerText(b.name)));
  const business = businesses.length === 1 ? businesses[0] : named.length === 1 ? named[0] : null;
  if (!business) return say(`لأي نشاط هذه السياسة؟ ${businesses.map((b) => `«${b.name}»`).join("، ")}.`);
  const parsed = await parse(text, input.message, input.market, business.id);
  if (!parsed) return say("فهمت أنك تريد ضبط سياسة لمتجرك، لكني لم أستطع تحويلها إلى إعداد واضح. صِغها بمثال، مثل «لا تقبل طلبات أقل من 3 قطع» أو «إذا نفد المنتج أخبرهم أنه سيعود قريبًا وخذ أرقامهم».");
  if ("clarify" in parsed) return say(parsed.clarify);
  try {
    const review = await proposePolicy({ actorId: input.actorId, businessId: business.id, kind: parsed.kind, rule: parsed.rule, source: "CHAT", sourceText: input.message });
    const lead = `فهمت: ${review.policy.kindLabel}. ${review.effects.join(" ")}`;
    if (!review.canConfirm) return reviewTurn(review, `${lead} لكن يوجد تعارض: ${review.conflicts.map((c) => c.messageAr).join(" ")} كيف تريد حله؟`);
    const how =
      review.confirmation === "CHAT_CONFIRM"
        ? "اكتب «نعم» لتفعيلها أو «إلغاء»."
        : review.confirmation === "EXPLICIT_REVIEW"
          ? "تغيير حساس: راجع البطاقة ثم اضغط «تأكيد»."
          : "تغيير مالي عالي الخطورة: راجع البطاقة، وسجّل الدخول من جديد إن طُلب، ثم اضغط «تأكيد».";
    return reviewTurn(review, `${lead} ${how}`);
  } catch (error) {
    if (error instanceof MerchantPolicyError) return say(`${error.message} لم يتغير شيء.`);
    throw error;
  }
}

/** The review card shows the proposal as it is now (confirmed, cancelled or still pending). */
export async function refreshMerchantPolicyPayload(payload: Record<string, unknown>, actorId: string | undefined) {
  const review = payload as { policy?: { id?: string } };
  const policyId = review.policy?.id;
  if (!policyId || !actorId) return payload;
  const [row] = await db.select({ status: merchantPolicies.status, version: merchantPolicies.version }).from(merchantPolicies).where(and(eq(merchantPolicies.id, policyId)));
  return row ? { ...payload, policy: { ...(review.policy as object), status: row.status, version: row.version } } : payload;
}
