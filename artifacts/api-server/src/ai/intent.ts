import { isBareShowNumber, priceProposal } from "./price-proposal";
import { statusQuestion } from "./context-intent";

/** Explicit navigation intents do not require a model or imply successful writes. */
export function surfaceIntent(message: string): string | undefined {
  const text = message.replace(/[أإآ]/g, "ا");
  if (/سجلني خروج|تسجيل الخروج/.test(text)) return "LOGOUT";
  if (/كمل.*طلب|اكمل.*طلب|اتمام.*طلب|الدفع/.test(text)) return "CHECKOUT";
  if (/سجلني دخول|تسجيل الدخول/.test(text)) return "AUTH";
  if (
    /الشروط|سياسة الخصوصية|سياسه الخصوصيه|قواعد السوق|المنتجات المحظورة|الممنوعات|سياسة الاسترداد|حذف حسابي|حذف الحساب|العمولة|عمولة بدينار|رسوم بدينار/.test(
      text,
    )
  )
    return "POLICIES";
  if (/اعدادات|الوضع.*داكن|موقعي/.test(text)) return "SETTINGS";
  if (/سلة|للسله|السله/.test(text)) return "CART";
  if (/طلباتي|اين طلبي|وين طلبي|تتبع.*طلب/.test(text) || statusQuestion(message)?.subject === "ORDER") return "ORDERS";
  if (/عروضي|ادارة.*عروض|اعلاناتي|قوائمي|عروضي المنشورة/.test(text))
    return "MY_LISTINGS";
  if (/مستحقات|مستحقاتي/.test(text)) return "DUES";
  if (/غير.*سوق|غيّر.*سوق|حولني.*سوق|سوق الكويت|تغيير السوق/.test(text))
    return "MARKET";
  if (/افتح حسابي|اعرض حسابي|ملفي الشخصي/.test(text)) return "ACCOUNT";
  // «أعرض 15 بدل 20», «اعرض 2»: an amount or a position names no item, so it is not a sale;
  // negotiation, the draft in progress or the visible results give it its meaning.
  if (priceProposal(message) || isBareShowNumber(message)) return undefined;
  // «اعرض لي الماكينات» asks DINAR to show something, and «البضاعة اللي أعرضها» refers to the
  // seller's existing listings; neither offers a new item for sale.
  const offerText = text
    .replace(/(?:^|\s)اعرض\s+(?:لي|لنا)(?=\s|$)/gu, " ")
    .replace(/(?:^|\s)(?:اللي|التي|الي|الذي)\s+(?:ا|ن)?عرض\S*/gu, " ");
  if (
    // «اعرض المستعمل فقط», «اعرض الأرخص»: showing the current results, not offering something.
    /ابيع|للبيع|انشر.*عرض|اعرض(?!\s+(?:لي\s+)?(?:ال)?(?:مستعمل[ةه]?|مستخدم[ةه]?|جديد[ةه]?|ارخص|أرخص|اغلى|اغلي|أغلى|نتائج|الكل|كل\s+النتائج)(?:\s|$))|(?:عندي|لدي|املك).*(?:للايجار|للاجار)|(?:^|\s)(?:اريد\s+)?(?:اقدم|اوفر)\s+(?:خدمة|خدمتي)(?=\s|$)/.test(
      offerText,
    )
  )
    return "SELL";
  // «بيع لي هاتفي المستعمل» names a new item to sell. «روح بيع لي هذا / إعلاني» stays the
  // paid «دينار — روح بِع لي» promotion of an existing listing (promotionIntent).
  if (
    !/(?:^|\s)روح(?:\s|$)/.test(text) &&
    /(?:^|\s)(?:بع|بيع)\s+لي\s+(?!(?:هذا|هذي|هذه|ذا|هذاك|اعلاني|اعلانه|منتجي|عرضي|الاعلان|المنتج|العرض)(?:\s|$))\S+/.test(text)
  )
    return "SELL";
  // «عندي كنبة بدي بيعها»: the item was just named and the wish takes it as its object.
  if (/(?:^|\s)(?:عندي|لدي)\s+\S+.*(?:^|\s)(?:اريد|ابي|ابغي|ابغى|بدي|ودي|حاب)\s+(?:ا|ن)?(?:بيع|ابيع)(?:ه|ها|هم)(?:\s|$)/.test(text)) return "SELL";
  // «أريد بيع هاتفي», «بدي بيع سيارتي»: the verbal noun after a wish names a new sale.
  if (/(?:^|\s)(?:اريد|ابي|ابغي|ابغى|بدي|ودي|حاب|عايز|عاوز)\s+(?:ان\s+)?بيع\s+(?!لي(?:\s|$))\S+/.test(text)) return "SELL";
  // «عندي خدمة تنظيف»: offering a named service.
  if (/^(?:(?:يا\s+)?دينار\s*[،,:]?\s+)?(?:انا\s+)?(?:عندي|لدي)\s+خدم[ةه]\s+(?!عملاء|العملاء)\S+/.test(text)) return "SELL";
  // G2: «عندي جاكيت جلد جديد بـ10»: an item with the seller's own price is a sale statement.
  if (/^(?:انا\s+)?(?:عندي|لدي|املك)\s+(?![0-9٠-٩]|عروض|طلب|اعلان|سؤال|مشكل)\S+.*(?:(?:^|\s)بـ?\s*[0-9٠-٩]|بسعر\s*[0-9٠-٩])/.test(text)) return "SELL";
  return undefined;
}

export function addToCartIntent(message: string): boolean {
  const text = message.replace(/[أإآ]/g, "ا");
  if (
    /(?:^|\s)(?:لا|ما|مو|ليس|بدون)(?:\s+(?:اريد|ابي|ابغى|ان)){0,2}\s*(?:اضف|اضيف|اضافة|ضيف|تضيف|تضيفه|تضف|تضفه|حط|حطه|ضع|تضع|ادخل|دخل|تدخل)/.test(
      text,
    )
  )
    return false;
  return (
    /اضف|اضيف|اضافة|ضيف|حط|ضع|ادخل|دخل/.test(text) &&
    (
      /سلة|سله|عربة/.test(text) ||
      /(?:^|\s)(?:ال)?(?:اول|ثاني|ثالث|رابع|خامس)(?:\s|$)|(?:^|\s)(?:رقم|الاعلان|العرض)\s*\d{1,2}(?:\s|$)/u.test(text)
    )
  );
}

export function backIntent(message: string): boolean {
  const text = message.replace(/[أإآ]/g, "ا").trim();
  return /^(?:رجوع|ارجع|عودة|عد|للنتائج|رجعني|ارجعني)(?:\s+(?:الى\s+)?(?:النتائج|للنتائج|للقائمة|للبحث)(?:\s+السابقة)?)?$/.test(text);
}

const CORRECTION_PREFIXES = [
  // «لا لا غلطت، …», «لا سوري، …»: the buyer corrects what they just asked (W04).
  /^\s*(?:(?:لا|لأ)\s*[,،]?\s*){1,2}(?:غلطت|عفوا|عفوًا|سوري)\s*[,،]?\s*/iu,
  // «لا خليها، أريد …», «بلاها، …»: drop the previous request; what follows is a new one.
  /^\s*(?:(?:لا|لأ)\s*[,،]?\s*)?(?:خليها|خلها|خليه|خله|بلاها|بلاش|انسى|انساها|انسي)\s*[,،]\s*/iu,
  /^\s*(?:لا|لأ)\s*[,،]?\s*(?:مو|مش)\s+(?:هذا|هذه|هذي|ذلك)\s*[,،]?\s*/iu,
  /^\s*(?:(?:لا|لأ)\s*[,،]?\s*)?(?:أقصد|اقصد|قصدي|أعني|اعني|كنت\s+أقصد|كنت\s+اقصد)(?:\s*[,،:]\s*|\s+)/iu,
  /^\s*(?:مو|مش|ليس)\s+(?:هذا|هذه|هذي|ذلك)\s*[,،]?\s*/iu,
  /^\s*not\s+(?:that|this|it)\s*[,،]?\s*(?:i\s+want\s*)?/iu,
  /^\s*بدل(?:ها|ه|هذا|هذه|هذي|ذلك)\s*(?:بـ?|ل)?\s*/iu,
  /^\s*(?:no\s*[,،]?\s*i\s+meant|actually\s+make\s+it)\s+/iu,
  /^\s*i\s+(?:mean|meant)\s+/iu,
  /^\s*(?:آسف|اسف|معذرة)\s*[,،]?\s*/iu,
  /^\s*actually\s*[,،:]?\s*/iu,
];

/** Remove only a leading correction marker; keep the corrected value and its constraints. */
export function stripCorrectionPrefix(message: string): string {
  let text = message;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = CORRECTION_PREFIXES.reduce(
      (value, prefix) => value.replace(prefix, ""),
      text,
    );
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

export function searchTerms(message: string): string {
  const terms = message
    // «دينار ابحث لي عن …», «يا دينار دورلي على …»: the address and the search verb with its
    // «لي» and preposition are the request, not the product.
    .replace(/^\s*(?:يا\s+)?(?:دينار|dinar)(?:\s*[،,:]\s*|\s+)/iu, "")
    .replace(/(^|\s)(?:[أا]بحث|دو[ّ]?ر|فتش)(?:\s*لي)?\s+(?:عن|على|علي)(?=\s|$)|(^|\s)دو[ّ]?رلي(?:\s+(?:عن|على|علي))?(?=\s|$)/gu, " ")
    .replace(
      /(?:أريد|اريد|أبحث عن|ابحث عن|أحتاج|احتاج|أشتري|اشتري|أبغى|ابغى|من فضلك|فقط|بدينار)/g,
      " ",
    )
    // Short colloquial "I want" verbs only as whole words, so «ابيض» keeps its letters.
    .replace(/(^|\s)(?:أبي|ابي|أبغي|ابغي|بدي|ودي)(?=\s|$)/g, " ")
    .trim();
  return stripCorrectionPrefix(terms)
    .replace(/\s+/g, " ");
}

export type PromotionIntent =
  | { kind: "EXPLAIN"; productType?: string }
  | { kind: "ACTION"; productType?: string }
  | { kind: "ADVICE" };

/**
 * Shared semantic routing for advertising language. Resolve the speech act before
 * the product: questions/advice must never become a purchase, while an actionable
 * paraphrase enters the same canonical commerce flow as a button or exact phrase.
 */
export function promotionIntent(message: string): PromotionIntent | undefined {
  const text = message
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[؟?!،,.«»"'():;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasAd = /اعلان|اعلاني|اعلانات|عرض|منتج|listing|ad\b/u.test(text);
  const productType =
    // Whole words: «مديري يبيع لي فكرة» is not DINAR selling for the user.
    /روح\s+بيع|(?:ساعدني|يساعدني).{0,24}(?:(?:^|\s)(?:ابيع|بيع|البيع)(?:\s|$)|مشتري)|(?:^|\s)(?:بيع|بع)\s+لي(?:\s|$)|sell\s+for\s+me/u.test(text)
      ? "DEMAND_CAPTURE"
      : // Search wording is an ad request only with visibility or the seller's own listing;
        // a buyer's «ابحث لي عن كرسي» is never a sponsored-search purchase.
        /بحث|الباحثين|نتائج\s+البحث|search/u.test(text) &&
          /ظهور|يظهر|يطلع|ابراز|ممول|sponsor|اعلاني|اعلاناتي|منتجي|عرضي/u.test(text)
        ? "SPONSORED_SEARCH"
        : /اقترح|يقترح|تقترح|اقتراح|يوصي|توصي|recommend/u.test(text) && hasAd
          ? "SPONSORED_RECOMMENDATION"
          : /(?:^|\s)vip(?:\s|$)|في\s+اي\s+بي/u.test(text)
            ? "VIP_LISTING"
            : /featured/u.test(text) ||
                (/مميز/u.test(text) && /اعلان|اعلاني|اعلانات|listing/u.test(text))
              ? "FEATURED_LISTING"
              : /(?:^|\s)(?:تحديث|حدث|جدد|refresh)(?=\s|$)/u.test(text)
                ? "REFRESH_LISTING"
                : undefined;
  const asksMeaning =
    /(?:وش|شو|ايش|ما|ماذا)\s+(?:يعني|معنى|المقصود)|اشرح|ما\s+هو|ما\s+هي|what\s+(?:does|is)\b/u.test(text);
  const adviceQuestion =
    /تنصحني|ما\s+رأيك|وش\s+رايك|شو\s+رايك|هل\s+تنصح|should\s+i/u.test(text);
  const asksHow =
    /^(?:كيف|شلون|طريقة|طريقه)(?:\s|$)|^how(?:\s|$)/u.test(text);
  if (adviceQuestion && (productType || hasAd)) return { kind: "ADVICE" };
  const marketingAdvice =
    asksHow && /(?:اسوق|سوق|روج|روّج|اعلن|اعلاني|منتجي|اعلاني)/u.test(text);
  if (asksMeaning && (productType || hasAd)) return { kind: "EXPLAIN", ...(productType ? { productType } : {}) };
  if (marketingAdvice) return { kind: "ADVICE" };

  const actionable =
    /(?:ابي|اريد|ارغب|ابغي|بدي|ودي|عايز|خل|خلي|اجعل|روج|روّج|(?:^|\s)(?:حدث|جدد)(?=\s|$)|ساعدني|روح\s+بيع|فعل|make|promote|boost|sell\s+for\s+me)/u.test(text);
  if (
    !asksHow &&
    /خيارات.{0,16}(?:ترويج|اعلان)|(?:ترويج|اعلان).{0,16}خيارات/u.test(text) &&
    hasAd
  )
    return { kind: "ACTION", productType: "PROMOTION_ENTRY" };
  if (actionable && productType) return { kind: "ACTION", productType };
  if (actionable && /(?:روج|روّج|ترويج|promot)/u.test(text) && hasAd)
    return { kind: "ACTION", productType: "PROMOTION_ENTRY" };
  if (asksHow && (productType || hasAd)) return { kind: "EXPLAIN", ...(productType ? { productType } : {}) };
  return undefined;
}

/**
 * Buyer requests for internal recommendations ("أرني أشياء مشابهة", "اقترح لي بدائل",
 * "أعطني خيارات أرخص", "أريد منتجات قريبة"). A bare "أرخص" stays a Block A sort.
 */
export function recommendationIntent(
  message: string,
): { cheaper: boolean; nearby: boolean } | undefined {
  const text = message
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[؟?!،,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/(?:^|\s)(?:لا|مش|ما|بدون)\s+(?:اريد\s+|بدي\s+)?(?:شي|شيء|اشياء)?\s*(?:مشابه|شبيه|بدائل)/.test(text))
    return undefined;
  const similar =
    /(?:^|\s)(?:مشابه|مشابهه|مشابهة|مشابهين|شبيه|شبيهه|يشبه|يشبهه|تشبه|بدائل|بديل)(?:\s|$)/.test(text) ||
    /(?:^|\s)من نفس (?:النوع|الفئه|الصنف)(?:\s|$)/.test(text) ||
    /(?:^|\s)قريب(?:ه)? من (?:هذا|هذه|هاد|هذي)(?:\s|$)/.test(text);
  const advise =
    /^(?:(?:ممكن|لو سمحت)\s+)?(?:اقترح|اقترحلي|رشح|رشحلي)(?:\s|$)/.test(text) ||
    /^(?:ما|شو|ايش|ماذا|بماذا|بشو)\s+(?:الذي\s+|اللي\s+)?(?:تنصحني|تقترح|تنصح|ترشح)(?:\s|$)/.test(text);
  const cheaperAlternatives =
    /(?:^|\s)(?:خيارات|اشياء|اشي|شي|شيء|بدائل|منتجات|عروض)\s+(?:اخري\s+)?ارخص(?:\s|$)/.test(text);
  const nearby =
    /(?:^|\s)(?:منتجات|اشياء|عروض|خيارات)\s+قريبه(?:\s|$)/.test(text) ||
    /(?:^|\s)(?:قريب|قريبه) مني(?:\s|$)/.test(text);
  if (!similar && !advise && !cheaperAlternatives && !nearby) return undefined;
  return { cheaper: /(?:^|\s)(?:ارخص|اقل سعر|اقل سعرا)(?:\s|$)/.test(text), nearby };
}
