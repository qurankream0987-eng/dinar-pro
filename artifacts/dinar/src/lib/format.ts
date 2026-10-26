import { formatMoney, decimalToMinor, currencyScale } from '@workspace/global';
export const currencySymbol = (currency: string) => currency;
export function formatAmount(value: string | number | undefined, currency: string) {
  if (value === undefined) throw new Error("لا توجد قيمة لعرض المبلغ.");
  const scale = currencyScale(currency);
  return new Intl.NumberFormat('ar', { numberingSystem: 'latn', minimumFractionDigits: scale, maximumFractionDigits: scale }).format(Number(value));
}
export function money(value: string | number, currency?: string) {
  if (!currency) throw new Error("لا توجد عملة لعرض المبلغ.");
  return formatMoney(decimalToMinor(value, currency), currency);
}

const dayMonth = new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" });
const fullDate = new Intl.DateTimeFormat("ar", { day: "numeric", month: "long", year: "numeric" });
const timeOnly = new Intl.DateTimeFormat("ar", { hour: "numeric", minute: "2-digit" });

export const shortDate = (value?: string) => (value ? dayMonth.format(new Date(value)) : "—");
export const longDate = (value?: string) => (value ? fullDate.format(new Date(value)) : "—");
export const clock = (value?: string) => (value ? timeOnly.format(new Date(value)) : "");

export function relativeTime(value?: string) {
  if (!value) return "";
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });
  if (diff < 60) return "الآن";
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), "hour");
  if (diff < 86400 * 7) return rtf.format(-Math.round(diff / 86400), "day");
  return shortDate(value);
}

/** Arabic plural for counted units: وحدة / وحدتان / وحدات. */
export function unitsLabel(n: number) {
  if (n === 1) return "وحدة واحدة";
  if (n === 2) return "وحدتان";
  if (n >= 3 && n <= 10) return `${n} وحدات`;
  return `${n} وحدة`;
}

/** Short order reference, LTR-isolated so "#" stays in front inside Arabic text. */
export const orderRef = (id: string) => `\u2066#${id.replace(/-/g, "").slice(-6).toUpperCase()}\u2069`;

export const initials = (name?: string) => (name ?? "").trim().slice(0, 1) || "؟";
