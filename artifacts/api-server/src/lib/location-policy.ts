/**
 * Public listing location contract.
 *
 * Three location authorities exist and are never shared:
 *  - PUBLIC LISTING LOCATION   offers.data.city / offers.data.area — shown to everyone.
 *  - PRIVATE ACCOUNT LOCATION  users.city / users.area — visible only to the account owner.
 *  - DELIVERY/HANDOFF LOCATION orders.data.deliveryInstructions — visible only to the
 *                              order's buyer and seller (and admins resolving disputes).
 *
 * Public listing location must stay at marketplace level (city, district/area).
 * These checks reject obvious accidental precise-address leakage; they are a
 * guard rail, not a guarantee, and reporting covers what they miss.
 */

const fail = (message: string) =>
  Object.assign(new Error(message), { status: 400 });

export const PUBLIC_LOCATION_MAX_LENGTH = 100;

const PRECISE_ADDRESS_MESSAGE =
  "اكتب الموقع العام فقط (المدينة أو المنطقة) دون رقم منزل أو شارع أو شقة أو رابط خريطة أو رقم هاتف.";

function asciiDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

const URL_PATTERN =
  /(?:https?:\/\/|www\.|maps\.app|goo\.gl|maps\.google|google\.[a-z.]+\/maps|waze\.com|\.com\b|\.net\b)/i;
const COORDINATE_PATTERN = /-?\d{1,3}\.\d{3,}\s*[,،]\s*-?\d{1,3}\.\d{3,}/;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_PATTERN = /\d[\d\s\-()]{6,}\d/;
// A dwelling/street keyword followed by a number pinpoints a residence.
const PRECISE_KEYWORD_NUMBER = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])(?:منزل|بيت|شقة|شقه|عمارة|عماره|بناية|بنايه|مبنى|مبني|الدور|دور|طابق|جادة|جاده|شارع|زقاق|فيلا|فيلّا|house|home|building|bldg|apartment|apt|flat|floor|street|st\.|avenue|ave\.?|road|rd\.?|villa|unit)\s*(?:رقم|no\.?|number|#|:)?\s*\d`,
  "iu",
);

export function findPreciseLocationLeak(value: string): string | undefined {
  const text = asciiDigits(value);
  if (URL_PATTERN.test(text)) return "URL";
  if (COORDINATE_PATTERN.test(text)) return "COORDINATES";
  if (EMAIL_PATTERN.test(text)) return "EMAIL";
  if (PHONE_PATTERN.test(text)) return "PHONE";
  if (PRECISE_KEYWORD_NUMBER.test(text)) return "PRECISE_ADDRESS";
  return undefined;
}

export function assertPublicListingLocation(fields: {
  city?: unknown;
  area?: unknown;
}) {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string")
      throw fail(name === "city" ? "المدينة غير صالحة" : "المنطقة غير صالحة");
    if (value.length > PUBLIC_LOCATION_MAX_LENGTH)
      throw fail(
        `الموقع العام يجب ألا يتجاوز ${PUBLIC_LOCATION_MAX_LENGTH} حرفًا`,
      );
    if (findPreciseLocationLeak(value)) throw fail(PRECISE_ADDRESS_MESSAGE);
  }
}
