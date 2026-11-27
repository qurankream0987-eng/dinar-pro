/**
 * Jassim Ads — Phase 1 conversation entry (behind DINAR_JASSIM_ADS). Claims only explicit
 * marketing-advice requests from a signed-in seller and answers from the seller's own facts:
 *   «ساعدني أسوّق متجري» / «شو أروّج؟»      → opportunities (incl. «جاسم روح بيع لي» demand)
 *   «اكتب لي نص إعلاني للثاني»               → three copy drafts from the listing's own facts
 *   «كيف تسير حملاتي؟» / «تقرير الترويج»     → server-attributed campaign results
 * Buying, pausing or cancelling a promotion is left to the existing promotion turn (confirmation,
 * server price, receipt). Nothing here charges or changes anything.
 */
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import { makeSellerContextResult, resolveCurrentOwnedListings } from "./seller-management";
import { adCopyDrafts, adsOpportunities, jassimAdsEnabled, sellerAdsListings, sellerAdsReport } from "../lib/jassim-ads";
import type { marketFor } from "../lib/markets";

type Market = Awaited<ReturnType<typeof marketFor>>;

export function normalizeAdsText(message: string) {
  return foldArabicLetters(normalizeDigits(message)).replace(/ة/g, "ه").replace(/[؟?!،,؛;:.()«»"'\-]+/g, " ").replace(/\s+/g, " ").trim();
}

const OVERVIEW = /(?:ساعدني|كيف|علمني)\s+(?:ف[يى]\s+)?(?:ا|أ)?(?:سوق|سوّق|روج|روّج|تسويق)|(?:فرص|اقتراحات)\s+(?:ال)?(?:تسويق|ترويج)|(?:شو|ايش|وش|ماذا|ما(?:ذا)?\s+الذي)\s+(?:ا|أ)?روج|سوق(?:\s+لي)?\s+متجري|(?:دير|ادر|أدر)\s+(?:لي\s+)?(?:ال)?تسويق|جاسم\s+ادز|مدير\s+(?:ال)?تسويق/u;
const COPY = /(?:اكتب|جهز|اقترح|صغ)\s+(?:لي\s+)?(?:نص(?:ا)?\s+(?:اعلاني|ترويجي|اعلان)|نصوص\s+(?:اعلانيه|ترويجيه)|كابشن|صيغه\s+اعلان)/u;
const REPORT = /(?:كيف|شو|ما)\s+(?:تسير|اداء|نتائج|وضع)\s+(?:ال)?(?:حملات[يى]?|حملتي|ترويج[يى]?|الترويج)|تقرير\s+(?:ال)?(?:تسويق|ترويج|حملات)/u;

const ORDINALS: [RegExp, number][] = [
  [/(?:^|\s)(?:لل|ل|ال)?(?:اول|الاولى|1)(?:\s|$)/u, 0],
  [/(?:^|\s)(?:لل|ل|ال)?(?:ثاني|الثانيه|2)(?:\s|$)/u, 1],
  [/(?:^|\s)(?:لل|ل|ال)?(?:ثالث|الثالثه|3)(?:\s|$)/u, 2],
  [/(?:^|\s)(?:لل|ل|ال)?(?:رابع|الرابعه|4)(?:\s|$)/u, 3],
  [/(?:^|\s)(?:لل|ل|ال)?(?:خامس|الخامسه|5)(?:\s|$)/u, 4],
];

export function adsIntent(message: string): "OVERVIEW" | "COPY" | "REPORT" | undefined {
  const t = normalizeAdsText(message);
  if (COPY.test(t)) return "COPY";
  if (REPORT.test(t)) return "REPORT";
  if (OVERVIEW.test(t)) return "OVERVIEW";
  return undefined;
}

export async function executeAdsAssistantTurn(input: { conversationId: string; message: string; market: Market; actorId?: string }) {
  if (!jassimAdsEnabled() || !input.actorId) return null;
  const intent = adsIntent(input.message);
  if (!intent) return null;
  const context = { conversationId: input.conversationId, market: input.market, actorId: input.actorId };
  const listings = await sellerAdsListings(input.actorId, input.market);
  if (!listings.length)
    return makeSellerContextResult(context, [], "لا توجد لديك إعلانات منشورة في هذا السوق بعد. انشر منتجك أولًا (قل «أبي أبيع …»)، ثم أساعدك في تسويقه.");
  const cards = await resolveCurrentOwnedListings(input.market, input.actorId, listings.map((item) => item.id));

  if (intent === "COPY") {
    const t = normalizeAdsText(input.message);
    const index = ORDINALS.find(([pattern]) => pattern.test(t))?.[1];
    const target = listings.length === 1 ? listings[0] : index !== undefined ? listings[index] : undefined;
    if (!target)
      return makeSellerContextResult(context, cards, `لأي إعلان أكتب النص؟ قل مثلًا «اكتب لي نص إعلاني للثاني».\n${listings.map((item, i) => `${i + 1}. «${item.title}»`).join("\n")}`);
    const drafts = adCopyDrafts(target);
    const prompt = [
      `مسودات نص إعلاني لـ«${target.title}» — من بيانات إعلانك فقط، راجعها قبل استخدامها:`,
      ...drafts.map((line, i) => `${i + 1}. ${line}`),
      "",
      "لم يُنشر أو يُدفع شيء. لترويجه داخل جاسم قل «روّج الإعلان» لترى الخطط والسعر قبل أي تأكيد.",
    ].join("\n");
    return makeSellerContextResult(context, cards.filter((card) => card.id === target.id), prompt, target.id);
  }

  if (intent === "REPORT") {
    const report = await sellerAdsReport(input.actorId, input.market);
    if (!report.length)
      return makeSellerContextResult(context, cards, "لا توجد لديك حملات ترويج بنتائج مسجلة في هذا السوق بعد. قل «شو أروّج؟» لأقترح عليك من بيانات إعلاناتك.");
    const lines = report.slice(0, 8).map((row) => `• «${row.listingTitle}» (${row.productTypeLabel}، ${row.effectiveStatus}): ظهور ${row.qualifiedImpressions}، تفاعل ${row.qualifiedEngagements}، طلبات منسوبة ${row.ordersAttributed}، تحويل ${row.conversionRate}، المصروف ${row.spentLabel}`);
    return makeSellerContextResult(context, [], ["نتائج حملاتك داخل جاسم (أحداث يسجلها الخادم، دون هوية المشاهدين):", ...lines].join("\n"));
  }

  const opportunities = adsOpportunities(listings);
  const prompt = opportunities.length
    ? ["هذه فرص تسويق من بيانات إعلاناتك في هذا السوق:", ...opportunities.map((item, i) => `${i + 1}. ${item.text}`), "", "أستطيع أن أكتب لك نصًا إعلانيًا («اكتب لي نص إعلاني للأول»)، أو أعرض خطط الترويج وأسعارها قبل أي تأكيد («روّج الإعلان»)."].join("\n")
    : "راجعت إعلاناتك: لا توجد فرصة واضحة الآن (لا طلبات تنبيه كافية، ولا ترويج ينتهي قريبًا). أستطيع كتابة نص إعلاني لأي منتج أو عرض خطط الترويج.";
  return makeSellerContextResult(context, cards, prompt);
}
