/**
 * D2.8 — deterministic reading of business-onboarding requests in Arabic (MSA and Gulf/Levant
 * colloquial). It only reads: every value it extracts is a proposal shown on the DINAR Business
 * card and written by lib/business-profiles under the session's account. It never decides a
 * verification status, a plan or a payment.
 */
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import type { DocumentKind } from "../lib/business-profiles";

export function normalizeBusinessText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .toLowerCase()
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[؟?!،,؛;:.()«»"'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOUN = String.raw`(?:مطعم|مقهي|كافيه|كوفي\s+شوب|كوفي|مخبز|محل|متجر|بقاله|سوبر\s*ماركت|صالون|ورشه|كراج|شركه|مؤسسه|مشروع|نشاط(?:\s+تجاري)?)`;
const SELF = String.raw`(?:انا|احنا|نحن|اني)`;
const OWN = String.raw`(?:صاحب|صاحبه|مالك|مالكه|امتلك|املك|عندي|لدي|عندنا|لدينا)`;
const MY_BUSINESS = String.raw`(?:مطعمي|محلي|متجري|نشاطي(?:\s+التجاري)?|شركتي|مؤسستي|مقهاي|صالوني|ورشتي|مخبزي|مشروعي|بزنسي)`;

const INTRODUCE = new RegExp(
  String.raw`(?:^|\s)${SELF}\s+${OWN}\s+(?:ال)?${NOUN}(?:\s|$)` +
    String.raw`|(?:^|\s)(?:عندي|لدي|عندنا|لدينا|املك)\s+(?:ال)?${NOUN}\s+(?:اسمه|اسمها|يسمي|باسم)(?:\s|$)` +
    String.raw`|(?:^|\s)(?:اضيف|اضافه|اسجل|تسجيل|ضيف|سجل|ادخل|انضم)\s+(?:لي\s+)?${MY_BUSINESS}(?:\s|$)` +
    String.raw`|(?:^|\s)(?:اضيف|اسجل|سجل|ضيف)\s+(?:ال)?(?:نشاط|بزنس)\s*(?:التجاري|الخاص\s+بي|حقي|تبعي)?(?:\s|$)`,
  "u",
);
const UPLOAD = /(?:^|\s)(?:ارفع|ارسل|ابعث|ابعت|اعطيك|احمل|حمل|ارفق|اطرش|نزل)\s+(?:لك\s+)?(?:ال)?(?:سجل|رخصه|مستند|مستندات|وثيقه|وثائق|اوراق|ورق)|(?:^|\s)(?:السجل\s+التجاري|الرخصه\s+التجاريه)(?:\s|$).*(?:ارفع|ارسل|ابعث|وين|كيف)|(?:وين|كيف)\s+(?:ارفع|ارسل)\s+(?:ال)?(?:سجل|رخصه|مستندات)/u;
const STATUS_EXPLICIT = new RegExp(
  String.raw`(?:وين|وش|ايش|شو|ماذا|كيف|ما)\s+(?:وصل|صار(?:\s+علي)?|حال|حاله|وضع)\s+(?:طلب\s+(?:التوثيق|التسجيل|التحقق)|توثيق|التوثيق|التحقق|${MY_BUSINESS})` +
    String.raw`|(?:حاله|وضع)\s+(?:توثيق|تحقق|طلب\s+توثيق)\s*${MY_BUSINESS}?` +
    String.raw`|هل\s+(?:تم\s+)?(?:توثيق|توثق|اعتماد|اعتمد|قبول|انقبل)\s+${MY_BUSINESS}`,
  "u",
);
// Only the whole short question («وين وصل طلبي؟»): «وين وصل طلبي رقم 12» stays an order.
const STATUS_IN_CONTEXT = /^(?:دينار\s+)?(?:وين|وش|ايش|شو|ماذا|ما)\s+(?:وصل|صار(?:\s+علي)?|حال|حاله|وضع)\s+(?:طلبي|الطلب)(?:\s+(?:يا\s+)?دينار)?$|^(?:حاله|وضع)\s+(?:طلبي|الطلب)$/u;
const SUBMIT_IN_CONTEXT = /(?:^|\s)(?:ارسل|قدم|اعتمد)\s+(?:ال)?طلب(?:ي)?(?:\s+(?:ال)?(?:توثيق|تحقق|مراجعه))?(?:\s|$)|(?:^|\s)(?:خلصت|انتهيت|رفعت)\s+(?:كل\s+)?(?:ال)?(?:مستندات|سجل|اوراق)/u;
const CONNECT = new RegExp(String.raw`(?:اربط|ربط|وصل|اوصل)\s+${MY_BUSINESS}\s+(?:ب|مع)?\s*(?:نظامي|نظام|الكاشير|كاشير|برنامج|متجري\s+الالكتروني|موقعي)`, "u");
const SHOW = new RegExp(String.raw`^(?:دينار\s+)?(?:اعرض|وريني|افتح|شوف)\s+(?:بطاقه\s+)?(?:${MY_BUSINESS}|دينار\s+بزنس\s+كارد|بطاقه\s+دينار\s+بزنس)$|^${MY_BUSINESS}$`, "u");

export type BusinessIntent =
  | { kind: "INTRODUCE"; displayName?: string; categoryKey: string; marketId?: string }
  | { kind: "UPLOAD_DOCUMENT"; documentKind: DocumentKind }
  | { kind: "STATUS" }
  | { kind: "SUBMIT" }
  | { kind: "INFO"; legalName?: string; registrationNumber?: string; city?: string }
  | { kind: "CONNECT_SYSTEM" }
  | { kind: "SHOW" };

const COUNTRY: Array<[RegExp, string]> = [
  [/(?:^|\s|ب)(?:ال)?كويت(?:\s|$)/u, "KW"],
  [/(?:^|\s|ب)(?:ال)?اردن(?:\s|$)/u, "JO"],
  [/(?:^|\s|ب)(?:ال)?سعوديه(?:\s|$)|(?:^|\s)(?:ال)?رياض(?:\s|$)|(?:^|\s)جده(?:\s|$)/u, "SA"],
];

function categoryOf(text: string): string {
  if (/(?:مطعم|مطاعم)/u.test(text) && /(?:مشاوي|مشويات|مشوي|شوايه|كباب|grill)/u.test(text)) return "GRILL_RESTAURANT";
  if (/مطعم/u.test(text)) return "RESTAURANT";
  if (/(?:مقهي|كافيه|كوفي)/u.test(text)) return "CAFE";
  if (/(?:مخبز|حلويات)/u.test(text)) return "BAKERY";
  if (/(?:بقاله|سوبر\s*ماركت|تموينات)/u.test(text)) return "GROCERY";
  if (/صالون/u.test(text)) return "BEAUTY";
  if (/(?:ورشه|كراج)/u.test(text)) return "AUTOMOTIVE";
  if (/(?:محل|متجر)/u.test(text)) return "RETAIL";
  return "OTHER";
}

const NAME_STOP = new RegExp(
  String.raw`\s+(?:في|فى|داخل)\s+|\s+ب(?=ال?(?:كويت|اردن|أردن|سعودي))|\s*[،,.؟?!]|\s+و\s*(?:أ|ا)?(?:ريد|بي|بغى|بغي|ودي|بدي|حاب)|\s+(?:وأ|وا)(?:ريد|بي|بغى|بغي)|\s+(?:وودي|وبدي|وحاب)|\s+(?:أريد|اريد|ابي|أبي|ابغى|أبغى|ودي|بدي)\s|$`,
  "u",
);
const NAME_NOUN = /(?:مطعم|مقهى|مقهي|كافيه|كوفي\s+شوب|كوفي|مخبز|محل|متجر|بقالة|بقاله|سوبر\s*ماركت|صالون|ورشة|ورشه|كراج|شركة|شركه|مؤسسة|مؤسسه|مشروع)\s+(?:(?:اسمه|اسمها|يسمى|يسمّى|باسم)\s+)?/u;

/** The business name as the user typed it (letters kept), or undefined when none was given. */
export function businessNameFrom(message: string): string | undefined {
  const raw = message.replace(/^(?:\s*(?:يا\s+)?دينار[،,\s]+)/u, "").trim();
  const match = NAME_NOUN.exec(raw);
  if (!match) return undefined;
  const rest = raw.slice(match.index + match[0].length);
  const stop = NAME_STOP.exec(rest);
  const name = (stop ? rest.slice(0, stop.index) : rest).replace(/^[«"']|[»"']$/gu, "").trim();
  const folded = normalizeBusinessText(name);
  if (name.length < 2 || name.length > 60 || /^(?:صغير|كبير|جديد|خاص|تجاري|عائلي)$/u.test(folded) || /^(?:في|ب|و)\s/u.test(folded)) return undefined;
  return name;
}

function documentKindOf(text: string): DocumentKind {
  if (/رخصه\s+(?:ال)?بلديه|بلديه/u.test(text)) return "MUNICIPALITY_LICENSE";
  if (/رخصه/u.test(text)) return "COMMERCIAL_LICENSE";
  if (/تفويض/u.test(text)) return "AUTHORIZATION_LETTER";
  return "COMMERCIAL_REGISTRATION";
}

function infoFrom(message: string, text: string): Extract<BusinessIntent, { kind: "INFO" }> | undefined {
  const number = text.match(/رقم\s+(?:ال)?(?:سجل|رخصه)(?:\s+(?:ال)?تجاري(?:ه)?)?\s*(?:هو|=)?\s*([0-9a-z][0-9a-z/-]{3,39})(?:\s|$)/u)?.[1];
  const legal = message.match(/(?:الاسم|اسم)\s+(?:القانوني|الرسمي|في\s+السجل)\s*(?:هو|:)?\s*(.+?)(?=\s*(?:[،,.]|\s+و\s*رقم|\s+رقم|$))/u)?.[1]?.trim();
  const city = message.match(/(?:المدينة|المدينه|المنطقة|المنطقه|المحافظة|المحافظه)\s*(?:هي|:)?\s*([\p{L}]{2,30}(?:\s+[\p{L}]{2,30})?)/u)?.[1]?.trim();
  if (!number && !legal && !city) return undefined;
  return { kind: "INFO", ...(legal && legal.length >= 2 && legal.length <= 200 ? { legalName: legal } : {}), ...(number ? { registrationNumber: number } : {}), ...(city ? { city } : {}) };
}

/**
 * `inContext`: the latest card in this conversation is the actor's DINAR Business card, so short
 * follow-ups («وين وصل طلبي؟», «أرسل الطلب», «رقم السجل 12345») belong to it.
 */
export function businessIntent(message: string, inContext: boolean): BusinessIntent | undefined {
  const text = normalizeBusinessText(message);
  if (!text) return undefined;
  if (CONNECT.test(text)) return { kind: "CONNECT_SYSTEM" };
  if (INTRODUCE.test(text)) {
    const marketId = COUNTRY.find(([pattern]) => pattern.test(text))?.[1];
    const displayName = businessNameFrom(message);
    return { kind: "INTRODUCE", categoryKey: categoryOf(text), ...(displayName ? { displayName } : {}), ...(marketId ? { marketId } : {}) };
  }
  if (STATUS_EXPLICIT.test(text) || (inContext && STATUS_IN_CONTEXT.test(text))) return { kind: "STATUS" };
  if (UPLOAD.test(text) && (inContext || /(?:سجل|رخصه)/u.test(text))) return { kind: "UPLOAD_DOCUMENT", documentKind: documentKindOf(text) };
  if (inContext) {
    const info = infoFrom(message, text);
    if (info) return info;
    if (SUBMIT_IN_CONTEXT.test(text)) return { kind: "SUBMIT" };
  }
  if (SHOW.test(text)) return { kind: "SHOW" };
  return undefined;
}

/**
 * Cheap pre-gate for the runtime (no I/O): could this message be a business request in ANY
 * conversation context? Only these messages pay for the context lookup; everything else goes on to
 * the other adapters untouched.
 */
export function isPossibleBusinessMessage(message: string): boolean {
  return businessIntent(message, true) !== undefined;
}
