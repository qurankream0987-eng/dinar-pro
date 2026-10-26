export { countries, type Country } from './countries';
export { currencies } from './currencies';
import { countries, type Country } from './countries';
import { currencies } from './currencies';
export const countryByCode = new Map(countries.map(country => [country.countryCode, country]));
export const DEFAULT_MARKET = 'KW'; // Product default for guests, not a country allowlist.
export const UI_LOCALE = 'ar';
export function searchCountries(query: string, list: Country[] = countries) {
  const normalize = (s: string) => s.normalize('NFKD').replace(/[\u064b-\u065f]/g, '').replace(/[أإآ]/g, 'ا').toLocaleLowerCase().trim();
  const needle = normalize(query);
  return list.filter(c => normalize(`${c.countryCode} ${c.countryNameAr} ${c.countryNameEn} ${c.callingCode ?? ''}`).includes(needle));
}
export function currencyScale(currency: string) {
  const metadata = currencies[currency];
  if (!metadata) throw new RangeError('Unsupported currency');
  return metadata.minorUnitScale;
}
export function decimalToMinor(amount: string | number, currency: string): number {
  const scale = currencyScale(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!match || (match[2]?.length ?? 0) > scale) throw new RangeError('Invalid money amount');
  const result = Number(match[1]) * 10 ** scale + Number((match[2] ?? '').padEnd(scale, '0'));
  if (!Number.isSafeInteger(result)) throw new RangeError('Money exceeds safe range');
  return result;
}
export function minorToDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError('Invalid minor units');
  const scale = currencyScale(currency), base = 10 ** scale;
  return scale === 0 ? String(minor) : `${Math.floor(minor / base)}.${String(minor % base).padStart(scale, '0')}`;
}
export function formatMoney(minor: number, currency: string, locale = UI_LOCALE): string {
  const amount = minorToDecimal(minor, currency);
  const scale = currencyScale(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code', numberingSystem: 'latn', minimumFractionDigits: scale, maximumFractionDigits: scale }).format(Number(amount));
}
export function currencyName(currency: string, locale = UI_LOCALE) {
  return new Intl.DisplayNames([locale], { type: 'currency' }).of(currency) ?? currency;
}
