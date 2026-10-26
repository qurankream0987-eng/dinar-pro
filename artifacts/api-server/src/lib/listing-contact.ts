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