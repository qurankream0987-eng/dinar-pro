import { countries } from "@workspace/global";

/**
 * The visitor's likely country, for pre-selecting sign-up fields only (the person can always change
 * it). Nothing leaves the browser and nothing is stored: it reads the device's own time zone and
 * language, in this order:
 *   1. an explicit hint (e.g. the market the visitor already chose),
 *   2. the device time zone (Asia/Amman → JO), which follows where the phone actually is,
 *   3. the browser language region (ar-JO → JO),
 *   4. Jordan, the launch market.
 */
const TIME_ZONE_COUNTRY: Record<string, string> = {
  "Asia/Amman": "JO",
  "Asia/Kuwait": "KW",
  "Asia/Riyadh": "SA",
  "Asia/Dubai": "AE",
  "Asia/Qatar": "QA",
  "Asia/Bahrain": "BH",
  "Asia/Muscat": "OM",
  "Asia/Baghdad": "IQ",
  "Asia/Damascus": "SY",
  "Asia/Beirut": "LB",
  "Asia/Gaza": "PS",
  "Asia/Hebron": "PS",
  "Asia/Aden": "YE",
  "Africa/Cairo": "EG",
  "Africa/Casablanca": "MA",
  "Africa/El_Aaiun": "MA",
  "Africa/Algiers": "DZ",
  "Africa/Tunis": "TN",
  "Africa/Tripoli": "LY",
  "Africa/Khartoum": "SD",
  "Africa/Nouakchott": "MR",
  "Africa/Djibouti": "DJ",
  "Africa/Mogadishu": "SO",
  "Indian/Comoro": "KM",
  "Europe/Istanbul": "TR",
  "Europe/London": "GB",
  "Europe/Berlin": "DE",
  "Europe/Paris": "FR",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Los_Angeles": "US",
};

export const LAUNCH_COUNTRY = "JO";

function selectable(code: string | undefined | null) {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  return countries.find((country) => country.countryCode === upper && country.isSelectable && country.callingCode);
}

export function detectCountry(hint?: string | null) {
  const fromHint = selectable(hint);
  if (fromHint) return fromHint;
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fromZone = selectable(TIME_ZONE_COUNTRY[zone]);
    if (fromZone) return fromZone;
  } catch {
    // No Intl time zone: fall through to the language.
  }
  const languages = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const tag of languages) {
    const region = /^[a-z]{2,3}-([A-Za-z]{2})\b/.exec(tag ?? "")?.[1];
    const fromLanguage = selectable(region);
    if (fromLanguage) return fromLanguage;
  }
  return selectable(LAUNCH_COUNTRY)!;
}
