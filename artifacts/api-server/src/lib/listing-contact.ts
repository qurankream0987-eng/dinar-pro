import { findPhoneNumbersInText, type CountryCode } from "libphonenumber-js";

const contactPattern =
  /(?:رقمي|رقم(?:ي)?\s*(?:التواصل|للتواصل|الهاتف)?|للتواصل|واتساب|واتس(?:اب)?|الهاتف|هاتف|اتصال)\s*[:：]?\s*([+＋]?[0-9٠-٩۰-۹][0-9٠-٩۰-۹ ()\-]{5,22})/iu;

function asciiDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

export function normalizeListingContactPhone(
  value: string | null | undefined,
): string | null {
  if (value == null || !value.trim()) return null;
  const normalized = asciiDigits(value.trim());
  const phone = normalized.replace(/[^\d+]/g, "");
  if (!/^\+?\d{7,15}$/.test(phone))
    throw Object.assign(
      new Error("أدخل رقم تواصل صالحًا أو اترك الحقل فارغًا."),
      { status: 400 },
    );
  return phone;
}

export function extractListingContactPhone(text: string) {
  const match = contactPattern.exec(text);
  if (!match?.[1]) return { text, phone: undefined };
  try {
    const phone = normalizeListingContactPhone(match[1]);
    return {
      text: text.slice(0, match.index) + text.slice(match.index + match[0].length),
      phone: phone ?? undefined,
    };
  } catch {
    return { text, phone: undefined };
  }
}

export function redactListingContactPhone(text: string) {
  const extracted = extractListingContactPhone(text);
  if (!extracted.phone) return text;
  return `${extracted.text} [رقم التواصل محفوظ في بيانات العرض]`;
}

/**
 * Contact details written into a listing's own text (title, description). A seller's phone is
 * released only through a confirmed order (lib/contact-release.ts), so text may not carry one.
 * A phone is a number valid for the market's country (or written internationally) — a year and
 * a mileage («2021 150000»), a price or a model number are not. Email and messaging links too.
 */
const CONTACT_LINK = /[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/\S+|www\.\S+|wa\.me\/\S*|t\.me\/\S*/giu;

function phoneSpans(text: string, marketId: string): Array<[number, number]> {
  const region = /^[A-Z]{2}$/u.test(marketId) ? (marketId as CountryCode) : undefined;
  // Arabic and Persian digits are one code unit each, so positions survive the conversion.
  const ascii = asciiDigits(text);
  return findPhoneNumbersInText(ascii, region ? { defaultCountry: region } : undefined)
    .filter((found) => found.number.isValid())
    .map((found) => [found.startsAt, found.endsAt]);
}

export function findListingContactText(text: string, marketId: string): "PHONE" | "LINK" | undefined {
  if (phoneSpans(text, marketId).length) return "PHONE";
  CONTACT_LINK.lastIndex = 0;
  return CONTACT_LINK.test(text) ? "LINK" : undefined;
}

/** A user-safe refusal: its message and code reach the seller (app.ts `expose`). */
export function listingContactTextRefusal(): Error {
  return Object.assign(new Error(LISTING_CONTACT_TEXT_ERROR), { status: 400, expose: true, code: "LISTING_CONTACT_TEXT" });
}

export const LISTING_CONTACT_TEXT_ERROR =
  "لا تكتب رقم الهاتف أو البريد أو الروابط في عنوان الإعلان أو وصفه. استخدم حقل «رقم التواصل»؛ يُكشف للمشتري فقط بعد طلب مؤكد.";

/** Buyer-facing copy of stored text with any contact detail replaced. */
export function redactListingContactText(text: string, marketId: string): string {
  let out = text;
  for (const [start, end] of phoneSpans(text, marketId).reverse())
    out = `${out.slice(0, start)}[بيانات تواصل محجوبة]${out.slice(end)}`;
  return out.replace(CONTACT_LINK, "[بيانات تواصل محجوبة]");
}
