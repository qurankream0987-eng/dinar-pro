import { normalizeDigits, normalizeMarketplaceText } from "./arabic-normalization";
import { isBareShowNumber, priceProposal } from "./price-proposal";
import { contextText, statusQuestion } from "./context-intent";

const CART_NAVIGATION_ACTION =
  /(?:^|\s)(?:افتح(?:لي)?|اعرض(?:لي)?|ارني|ورني|وريني|اظهر|اذهب|روح|انتقل|خذني|وديني|حولني)(?:\s|$)/u;
const CART_SURFACE_REFERENCE =
  /(?:^|\s)(?:السله|للسله|سله\s+(?:مشترياتي|المشتريات|التسوق|الشراء)|عربه\s+(?:التسوق|المشتريات|الشراء))(?:\s|$)/u;

function cartNavigationGoverns(text: string): boolean {
  const words = text.split(" ");
  for (let index = 0; index < words.length; index += 1) {
    if (!CART_NAVIGATION_ACTION.test(` ${words[index]} `)) continue;
    const window = ` ${words.slice(index + 1, index + 4).join(" ")} `;
    if (CART_SURFACE_REFERENCE.test(window)) return true;
  }
  return false;
}

/** Explicit navigation intents do not require a model or imply successful writes. */
const CHECKOUT_REQUEST =
  /(?:^|\s)(?:كمل|اكمل|اتمم|تمم|كملي|اكملي)\s+(?:لي\s+)?(?:ال)?(?:طلب|طلبي|شراء|دفع)(?:\s|$)|(?:^|\s)(?:اكمال|اتمام)\s+(?:ال)?(?:طلب|شراء|دفع)(?:\s|$)|(?:^|\s)متابعه\s+(?:ال)?(?:شراء|دفع)(?:\s|$)|^(?:ال)?دفع$|(?:^|\s)(?:صفحه|شاشه)\s+(?:ال)?دفع(?:\s|$)|(?:^|\s)(?:روح|ودني|خذني|افتح|افتحلي)\s+(?:لي\s+)?(?:على\s+|علي\s+|ل)?(?:ال)?(?:دفع|checkout)(?:\s|$)|(?:^|\s)(?:ابدا|ابدأ)\s+(?:ال)?دفع(?:\s|$)/u;

export function surfaceIntent(message: string): string | undefined {
  const text = message.replace(/[أإآ]/g, "ا");
  const folded = contextText(message);
  if (/^(?:وينه|اينه)\s+طلبي(?:\s|$)|(?:غير|اغير|عدل|اعدل)\s+عنوان\s+التوصيل|(?:اعرض|وريني)\s+موقع\s+طلب\s+(?:جاري|حالي)/u.test(folded)) return "ORDERS";
  if (/^(?:سو|سوي|اعمل|جهز)\s+اعلان\s+ل\S+|^(?:عندي|لدي)\s+\d+\s+(?:قطعه|حبه|وحده)\s+.*(?:بسعر|بـ?)\s*\d/u.test(folded)) return "SELL";
  // A refused action is not a request for it («لا تدفع الحين», «ما ابي ادفع، بس …»).
  const refused = /(?:^|\s)(?:لا|ما|مو|مش|بلاش|بدون)\s+(?:\S+\s+){0,2}?(?:ت|ا|ن)?(?:دفع|ادفع|كمل|اكمل)/u.test(folded);
  if (/سجلني خروج|تسجيل الخروج/.test(text) || /(?:^|\s)(?:طلعني|اطلعني|خرجني|اخرجني)\s+(?:من\s+)?حسابي(?:\s|$)/u.test(folded)) return "LOGOUT";
  // Checkout is asked for by a proceed-verb governing the order/payment, or by naming the payment
  // page itself. A payment word elsewhere («اعتبر أني وافقت على الدفع», «غير مبلغ الدفع») is not.
  if (!refused && (CHECKOUT_REQUEST.test(folded) ||
    /(?:^|\s)(?:اريد|ابي|ابغي|ابغى|بدي|ودي|عايز|عاوز|حاب)\s+(?:ان\s+)?ادفع(?:\s|$)|(?:^|\s)(?:اكمل|كمل|اتمم)\s+(?:ال)?(?:شراء|دفع)(?:\s|$)/u.test(folded)))
    return "CHECKOUT";
  // «كم عمولة دينار؟», «رسوم دينار»: the platform's own fee terms. A refund or return word alone
  // is not routed here: «وين وصل استرجاع فلوسي» asks about the user's own refund, and a precise
  // policy question is answered from the published policy (readPolicy), not a generic page.
  if (/(?:^|\s)(?:عموله|رسوم)\s+دينار(?:\s|$)/u.test(folded)) return "POLICIES";
  if (/(?:^|\s)(?:انزل|نزل|نزلي|احط|حط)\s+(?:لي\s+)?اعلان(?:\s|$)/u.test(folded)) return "SELL";
  if (/(?:^|\s)(?:شو|وش|ايش|شنو)\s+(?:في\s+|فيه\s+)?(?:ب|في\s+)?(?:ال)?سل(?:ه|تي)(?:\s|$)|(?:^|\s)(?:اشوف|اطالع|اتفرج\s+على)\s+(?:ال)?سل(?:ه|تي)(?:\s|$)|^(?:ورني|وريني|ورجيني|فرجيني|فرجني|اعرض|افتح|افتحلي|شوفلي)\s+(?:لي\s+)?(?:ال)?سل(?:ه|تي)$/u.test(folded))
    return "CART";
  // «أبي سائق يوصل الطلب», «بدي مندوب لطلبي»: delivery of an existing order starts from the order.
  if (/(?:^|\s)(?:سائق|مندوب|دليفري|كابتن)\s+(?:ي|ب|بي|ل)?(?:وصل|يوصل|توصيل)?\s*(?:لي\s+)?(?:ال)?طلب(?:ي)?(?:\s|$)/u.test(folded)) return "ORDERS";
  if (/(?:^|\s)(?:ب|على\s+)?طلبي\s+(?:ا?ت?اخر|متاخر|تاخر)(?:\s|$)|(?:^|\s)(?:الاوردر|اوردري)(?:\s|$)|(?:شو|وش|ايش)\s+صار\s+(?:ب|على\s+|في\s+)?طلبي/u.test(folded))
    return "ORDERS";
  if (/سجلني دخول|تسجيل الدخول/.test(text)) return "AUTH";
  if (
    /الشروط|سياسة الخصوصية|سياسه الخصوصيه|قواعد السوق|المنتجات المحظورة|الممنوعات|سياسة الاسترداد|حذف حسابي|حذف الحساب|العمولة|عمولة بدينار|رسوم بدينار/.test(
      text,
    )
  )
    return "POLICIES";
  if (/اعدادات|الوضع.*داكن|موقعي/.test(text)) return "SETTINGS";
  const cartText = text
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // The navigation verb must govern the cart reference («افتح السلة», «ورني سلة مشترياتي»):
  // a cart word elsewhere in the sentence («لا تضيف شي للسلة، بس ورني الأسعار») is not a request to open it.
  if (CART_NAVIGATION_ACTION.test(cartText) && CART_SURFACE_REFERENCE.test(cartText) && cartNavigationGoverns(cartText))
    return "CART";
  if (/طلباتي|اين طلبي|وين طلبي|تتبع.*طلب/.test(text) || statusQuestion(message)?.subject === "ORDER") return "ORDERS";
  if (/عروضي|ادارة.*عروض|اعلاناتي|قوائمي|عروضي المنشورة/.test(text))
    return "MY_LISTINGS";
  if (/مستحقات|مستحقاتي/.test(text)) return "DUES";
  // A verb that governs «السوق» («غير السوق», «حولني لسوق الأردن»); «التغيرات في سوق العمل» is not.
  if (/(?:^|\s)(?:ا|ن)?(?:غير|غيّر|بدل|حول|حولني|انقلني|نقلني)\s+(?:لي\s+)?(?:على\s+|الى\s+|الي\s+|ل)?(?:ال)?سوق(?:\s|$)|(?:^|\s)(?:تغيير|تبديل)\s+(?:ال)?سوق(?:\s|$)|^(?:سوق|السوق)\s+(?:الكويت|الاردن|السعوديه|السعودية)$/u.test(folded))
    return "MARKET";
  if (/افتح حسابي|اعرض حسابي|ملفي الشخصي/.test(text) || /(?:^|\s)(?:افتح|اعرض|ورني|وريني)\s+(?:لي\s+)?(?:خيارات|اعدادات)\s+(?:ال)?حساب(?:ي)?(?:\s|$)/u.test(folded)) return "ACCOUNT";
  // «أعرض 15 بدل 20», «اعرض 2»: an amount or a position names no item, so it is not a sale;
  // negotiation, the draft in progress or the visible results give it its meaning.
  if (priceProposal(message) || isBareShowNumber(message)) return undefined;
  // «اعرض لي الماكينات» asks DINAR to show something, and «البضاعة اللي أعرضها» refers to the
  // seller's existing listings; neither offers a new item for sale.
  const offerText = text
    .replace(/(?:^|\s)اعرض\s+(?:لي|لنا)(?=\s|$)/gu, " ")
    .replace(/(?:^|\s)(?:اللي|التي|الي|الذي)\s+(?:ا|ن)?عرض\S*/gu, " ");
  // «اعرضها مع الصور», «طب اعرضهم كجدول»: a leading show verb with an attached pronoun points at
  // what is already on screen. A price, a number or «للبيع» keeps it a sale («اعرضها بـ500»), and
  // a pronoun after a named item («عندي كنبة اعرضها») is never at the start of the message.
  const showsWhatIsOnScreen =
    /^(?:(?:طب|طيب|لا|بس|و|يا\s+جاسم|جاسم)\s+)*اعرض(?:ها|هم|هن)(?:\s|$)/u.test(text) &&
    !/[0-9٠-٩]|للبيع|(?:^|\s)(?:بسعر|سعرها|سعرهم)(?:\s|$)/u.test(text);
  if (
    !showsWhatIsOnScreen &&
    // «اعرض المستعمل فقط», «اعرض الأرخص»: showing the current results, not offering something.
    /ابيع|للبيع|انشر.*عرض|اعرض(?!\s+(?:لي\s+)?(?:ال)?(?:مستعمل[ةه]?|مستخدم[ةه]?|جديد[ةه]?|ارخص|أرخص|اغلى|اغلي|أغلى|نتائج|الكل|كل\s+النتائج|موقع|طلب|طلبي|طلباتي|حال[ةه]|سل[ةه]|سلتي|تفاصيل|معلومات|فاتور[ةه]|مسار|تتبع|متابع[ةه])(?:\s|$))|(?:عندي|لدي|املك).*(?:للايجار|للاجار)|(?:^|\s)(?:اريد\s+)?(?:اقدم|اوفر)\s+(?:خدمة|خدمتي)(?=\s|$)/.test(
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
  // «بيع كتب جامعية بـ 5», «دينار بيع ساعتي بسعر 30»: an imperative sale with the seller's own price.
  if (/^(?:(?:يا\s+)?دينار\s*[،,:]?\s+)?بيع\s+(?!لي(?:\s|$))\S+.*(?:(?:^|\s)بـ?\s*[0-9٠-٩]|بسعر\s*[0-9٠-٩])/u.test(text)) return "SELL";
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
  const folded = contextText(message);
  // «لا تحطه بالسلة», «ما بدي ضيفه», «مو لازم تضيفه»: a refused add, whatever the dialect.
  if (/(?:^|\s)(?:و\s*)?(?:لا|ما|مو|مش|ليس|بدون|بلاش)\s+(?:\S+\s+){0,2}?(?:ت|ا|ن)?(?:ضيف|ضف|حط|ضع|دخل)\S*(?:\s|$)/u.test(folded)) return false;
  // «هل ينفع أضيف الأول؟», «هل أقدر أحطه بالسلة؟»: a question about what *I* may do (first
  // person) asks for information. «هل تضيفه؟» (second person) stays a request, still confirmed.
  if (/^هل\s+(?:\S+\s+){0,2}?(?:ا|ن)(?:ضيف|حط|ضع|دخل)\S*(?:\s|$)/u.test(folded)) return false;
  // «كيف أضيف منتج للسلة؟»: asking how is not asking DINAR to do it.
  if (/^(?:كيف|شلون|كيفاش|ازاي|طريقه|ممكن\s+تشرح)(?:\s|$)/u.test(folded)) return false;
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
      /(?:^|\s)(?:هذا|هذه|هذي)(?:\s|$)|(?:^|\s)(?:ال)?(?:اول|ثاني|ثالث|رابع|خامس)(?:\s|$)|(?:^|\s)(?:رقم|الاعلان|العرض)\s*\d{1,2}(?:\s|$)/u.test(text)
    )
  );
}

const CART_QUANTITY_WORDS: Record<string, number> = {
  واحد: 1, واحده: 1, حبه: 1, قطعه: 1, اثنين: 2, اثنتين: 2, ثنتين: 2, حبتين: 2, قطعتين: 2, ثلاث: 3, ثلاثه: 3,
  اربع: 4, اربعه: 4, خمس: 5, خمسه: 5, سته: 6, ست: 6, سبع: 7, سبعه: 7, ثمان: 8, ثمانيه: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10,
};

/**
 * The quantity a cart request states: «حط 3 منه بالسلة», «ضيف حبتين», «حط 5 بالسلة».
 * A position («رقم 3», «الإعلان 3», «الثالث») is never a quantity. Zero, a negative or a
 * fraction is INVALID: the caller refuses instead of silently adding one.
 */
export function statedCartQuantity(message: string): number | "INVALID" | undefined {
  const text = normalizeDigits(message).replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/[؟?!،,«»"]/g, " ").replace(/\s+/g, " ").trim();
  const verb = "(?:حط|حطه|حطها|حطهم|حطلي|ضيف|ضيفه|ضيفها|ضيفلي|اضف|اضيف|ضع|دخل|خلي|خليها|خليه|خليهم|خلها|خله)";
  const number = text.match(new RegExp(`(?:^|\\s)${verb}\\s+(?:لي\\s+)?(-?\\s?\\d+(?:[.,]\\d+)?)(?=\\s|$)`, "u"))
    ?? text.match(/(?:^|\s)(-?\d+(?:[.,]\d+)?)\s*(?:قطع|قطعه|حبات|حبه|وحدات|نسخ)?\s*(?:منه|منها|منهم)?\s*(?:بالسله|للسله|في السله|ع السله|على السله|بالعربه)(?=\s|$)/u);
  // «حط رقم 3», «الإعلان 3»: a number after a listing noun names a position.
  const before = number ? text.slice(0, number.index! + number[0].indexOf(number[1]!)).trim().split(" ").at(-1) ?? "" : "";
  if (number && !/^(?:رقم|الرقم|الاعلان|اعلان|العرض|عرض|المنتج|منتج|النتيجه|الخيار)$/u.test(before)) {
    const raw = number[1]!.replace(/\s/g, "").replace(",", ".");
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) return "INVALID";
    return value;
  }
  const word = text.split(" ").find((token, index, all) => CART_QUANTITY_WORDS[token] !== undefined && new RegExp(`^${verb}$`, "u").test(all[index - 1] ?? ""));
  return word ? CART_QUANTITY_WORDS[word] : undefined;
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
  /^\s*(?:(?:لا|لأ)\s*[,،]?\s*)?(?:أقصد|اقصد|قصدي|قصدت|أعني|اعني|كنت\s+أقصد|كنت\s+اقصد)(?:\s*[,،:]\s*|\s+)/iu,
  /^\s*(?:مو|مش|ليس)\s+(?:هذا|هذه|هذي|ذلك)\s*[,،]?\s*/iu,
  // «هذا مو اللي أقصده، …», «هذي مش اللي بدي ياه»: the shown item is rejected; what follows is meant.
  /^\s*(?:هذا|هذه|هذي|هاد|هادا|هيدا)\s+(?:مو|مش|ليس|مهو|ماهو)\s+(?:اللي|الي|يلي|الذي|التي)\s+[^،,]{1,20}?\s*[,،]\s*/iu,
  /^\s*not\s+(?:that|this|it)\s*[,،]?\s*(?:i\s+want\s*)?/iu,
  /^\s*بدل(?:ها|ه|هذا|هذه|هذي|ذلك)\s*(?:بـ?|ل)?\s*/iu,
  /^\s*(?:no\s*[,،]?\s*i\s+meant|actually\s+make\s+it)\s+/iu,
  /^\s*i\s+(?:mean|meant)\s+/iu,
  /^\s*(?:آسف|اسف|معذرة|عفوا|عفوًا)\s*[,،]?\s*/iu,
  /^\s*actually\s*[,،:]?\s*/iu,
  // «لا تضيف شي للسلة، بس ورني …», «ما أبي أشتري، فقط …»: a refused action followed by the real request.
  /^\s*(?:لا|ما|مو)\s+[^،,.؟?!]{1,40}?\s*[,،]?\s*(?:بس|فقط|بل|لكن)\s+/iu,
];

/**
 * A trailing refusal of a commercial action («…، ولا تضيفه للسلة», «… بدون ما تشتري»): it constrains
 * what DINAR may do with the request, it is not part of what the user is pointing at.
 */
const TRAILING_REFUSAL =
  /\s*[,،]?\s*(?:و\s*|(?:بس|لكن|بشرط)\s+)?(?:لا|ما|مو|مش|بدون(?:\s+ما)?|بلاش)\s+(?:\S+\s+){0,1}?(?:ت|ا|ن|ي)?(?:ضيف|ضف|حط|ضع|دخل|شتري|اشتري|طلب|دفع|كمل|ثبت|اكد)\S*(?:\s+\S+){0,3}\s*[.!؟?]*\s*$/u;

/**
 * What the user is actually asking for once a leading correction («لا، أقصد …») and trailing
 * refusals are removed. The refusals still bind: callers use this only to resolve references,
 * never to turn a refused action into an executed one.
 */
export function requestCore(message: string): string {
  let text = stripCorrectionPrefix(message);
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(TRAILING_REFUSAL, "").trim();
    if (next === text || !next) break;
    text = next;
  }
  return text.replace(/[.!؟?،,]+\s*$/u, "").trim();
}

/** A refused commercial action anywhere in the message: nothing commercial may be prepared from it. */
export function refusesCommercialAction(message: string): boolean {
  return /(?:^|\s)(?:و\s*)?(?:لا|ما|مو|مش|بدون(?:\s+ما)?|بلاش)\s+(?:\S+\s+){0,2}?(?:ت|ا|ن|ي)?(?:ضيف|ضف|حط|ضع|دخل|شتري|اشتري|طلب|دفع)\S*(?:\s|$)/u.test(contextText(message));
}

/** Remove only a leading correction marker; keep the corrected value and its constraints. */
export function stripCorrectionPrefix(message: string): string {
  let text = message.replace(/[ً-ٰٟ]/gu, "")
    .replace(/^شوف\s+(?:إذا|اذا|لو)\s+(?:في|فيه)\s+/u,"ابحث عن ")
    .replace(/^abi\s+/iu,"ابي ").replace(/\bmosta3mal\b/giu,"مستعمل")
    .replace(/^([a-z][a-z0-9-]*(?:\s+[a-z0-9-]+){0,4})\s+b\s+(\d+(?:\.\d+)?)$/iu,"ابي $1 بسعر $2")
    .replace(/\blel\s+([a-z]+)\b/giu,"ل$1")
    .replace(/^(?:طيب\s+)?(?:اي|أي)\s+(?:شي|شيء|اشي|إشي)\s+/u, "ابي ")
    .replace(/^و(?=بدي|ابي|اريد|ابحث)/u, "")
    .replace(/^(?:طيب|طب)\s+و?(?=بدي|ابي|اريد|ابحث)/u, "")
    .replace(/^(?:ترى\s+)?(?:[اأ]نا\s+)?(?:اقصد|أقصد)\s+الخدم[ةه]\s+(?:مو|مش)\s+المنتج\s*[:،,]\s*/u, "")
    .replace(/^(?:مش|مو)\s+هيك\s*[،,]\s*/u, "")
    .replace(/^لا\s+(?:خلص|خلاص)\s+ما\s+(?:بدي|ابي|اريد)\s+[^،,]+[،,]\s*/u, "")
    .replace(/^(شلون|كيف)\s+(?:[اأ]حصل|[اأ]لاقي)\s+(?:على\s+)?/u, "ابي ");
  if (/^(?:قصدي|اقصد|أقصد)/u.test(text)) text = text.replace(/\s+(?:مش|مو|وليس)\s+\d+\s*$/u, "");
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

const MARKETPLACE_COMPARISON_SEARCH =
  /^(?:قارن(?:\s+(?:لي|لنا))?|قارنلي|اعمل\s+مقارن[هة](?:\s+(?:لي|لنا))?)\s+(?:بين\s+)?(\S.+?)\s+(?:الموجود[هة]?|المتوفر[هة]?|المتاح[هة]?)(?:\s+(?:عند\s+البائعين|في\s+(?:السوق|المتاجر|دينار)))?$/u;
/** Replit's available-product comparison grammar, shared by routing and query extraction. */
export function marketplaceComparisonSearchTerms(message: string): string | undefined {
  return MARKETPLACE_COMPARISON_SEARCH.exec(normalizeMarketplaceText(stripCorrectionPrefix(message)))?.[1];
}

export function searchTerms(message: string): string {
  // Codex: comparison-aware request extraction; Claude: a leading correction is set aside first.
  const request = stripCorrectionPrefix(message)
    .replace(/^(?:\S+\s+)?[اأ]نا\s+(?:جوعان|جائع|عطشان)\s+(?=[اأ]بي|بدي|[اأ]ريد)/u, "")
    // «دينار ابحث لي عن …», «يا دينار دورلي على …»: the address and the search verb with its
    // «لي» and preposition are the request, not the product.
    .replace(/^\s*(?:يا\s+)?(?:دينار|dinar)(?:\s*[،,:]\s*|\s+)/iu, "");
  const terms = (marketplaceComparisonSearchTerms(request) ?? request)
    .replace(/(^|\s)(?:[أا]بحث|دو[ّ]?ر|فتش)(?:\s*لي)?\s+(?:عن|على|علي)(?=\s|$)|(^|\s)دو[ّ]?رلي(?:\s+(?:عن|على|علي))?(?=\s|$)/gu, " ")
    .replace(
      /(?:أريد|اريد|أبحث عن|ابحث عن|أحتاج|احتاج|أشتري|اشتري|أبغى|ابغى|من فضلك|فقط|بدينار)/g,
      " ",
    )
    // «ورني أسعار …», «اعرض لي سعر …»: a show verb and the price noun describe the request, not the product.
    .replace(/(^|\s)(?:ورني|وريني|ورّني|ارني|أرني|اعرض(?:\s*لي)?|شوف(?:\s*لي)?)(?=\s|$)/gu, " ")
    // Only a leading price noun («ورني أسعار جوال» → «جوال»); inside a name («قطعة سعر …») it stays.
    .replace(/^\s*(?:أسعار|اسعار|سعر)\s+(?=\S)/u, " ")
    // Short colloquial "I want" verbs only as whole words, so «ابيض» keeps its letters.
    .replace(/(^|\s)(?:أبي|ابي|أبغي|ابغي|بدي|ودي|عايز|عاوز|عايزه|عاوزه)(?=\s|$)/g, " ")
    // «شو عندكم ساعات», «في عندكم دراجة؟», «هل يوجد …»: asking for stock, not part of the product.
    .replace(/^\s*(?:(?:شو|وش|ايش|شنو|هل|في|فيه)\s+)?(?:عندكم|عندك|يوجد|تبيعون|تبيعوا)(?=\s|$)/u, " ")
    .replace(/[؟?]+\s*$/u, "")
    .trim();
  return stripCorrectionPrefix(terms)
    .replace(/^(?:إذا|اذا|لو)\s+(?:في|فيه|يوجد)\s+/u, "")
    .replace(/[.!؟?]+\s*$/u, "")
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
  // Generic «offer/product/listing» words belong to buyer discovery too; they are not proof
  // that a question concerns paid seller promotion.
  const hasAd = /اعلان|اعلاني|اعلانات|ممول|ترويج|تسويق|featured|vip|sponsor|promot|boost|(?:^|\s)ads?(?=\s|$)/u.test(text);
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
    asksHow &&
    /(?:^|\s)(?:اسوق|سوق|روج|روّج|اعلن|اعلاني|منتجي|منتجاتي)(?=\s|$)/u.test(text);
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
  // «اقترح لي أسماء لقطة», «اقترح عنوان لمقالي», «رشح لي كتب»: the object is content to write or
  // read, not goods in the market. Those are answered as general help, never with listings.
  const contentObject = /^(?:(?:ممكن|لو سمحت)\s+)?(?:اقترح|اقترحلي|رشح|رشحلي)\s+(?:لي\s+|علي\s+|علينا\s+)?(?:\d+\s+)?(?:اسم|اسماء|فكره|افكار|عنوان|عناوين|طريقه|طرق|خطه|خطط|نشاط|انشطه|كلمه|كلمات|جمله|جمل|شعار|سلوغان|هاشتاغ|هاشتاغات|نصيحه|نصائح|نكته|نكت|رد|ردود|كتاب|كتب|فيلم|افلام|مسلسل|مسلسلات|موضوع|مواضيع|سؤال|اسئله|تمرين|تمارين|وصفه|وصفات|اكله|اكلات|برنامج|جدول|روتين|هوايه|هوايات|مكان|اماكن|رحله|سؤالا|هديه|هدايا)(?:\s|$)/u.test(text);
  if (contentObject && !similar && !cheaperAlternatives && !nearby) return undefined;
  if (!similar && !advise && !cheaperAlternatives && !nearby) return undefined;
  return { cheaper: /(?:^|\s)(?:ارخص|اقل سعر|اقل سعرا)(?:\s|$)/.test(text), nearby };
}
