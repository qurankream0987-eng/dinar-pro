const MAX_MINOR_UNITS = 2_147_483_647;
const fail = (status: number, message: string, code: string) =>
  Object.assign(new Error(message), { status, code });

function normalizeDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/٫/g, ".");
}

export function parseFareAmount(value: unknown, scale: number): number {
  if (typeof value !== "string" || value.length > 32 || scale < 0 || scale > 3)
    throw fail(400, "أدخل أجرة صحيحة بعملة السوق.", "FARE_INVALID");
  const normalized = normalizeDigits(value.trim());
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized))
    throw fail(400, "أدخل أجرة صحيحة بعملة السوق دون فواصل آلاف.", "FARE_INVALID");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > scale)
    throw fail(400, `تسمح عملة السوق بحد أقصى ${scale} منازل عشرية.`, "FARE_PRECISION");
  const minor = Number(whole) * 10 ** scale + Number(fraction.padEnd(scale, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_MINOR_UNITS)
    throw fail(400, "يجب أن تكون الأجرة أكبر من صفر وضمن الحد المسموح.", "FARE_INVALID");
  return minor;
}

/** Round 10% to the market's minor unit using integer half-up arithmetic. */
export function courierCommissionMinor(fareMinor: number): number {
  if (!Number.isSafeInteger(fareMinor) || fareMinor < 0 || fareMinor > MAX_MINOR_UNITS)
    throw new RangeError("Fare must be a non-negative minor-unit integer");
  return Number((BigInt(fareMinor) * 1000n + 5000n) / 10000n);
}

export function formatMinorUnits(amountMinor: number, scale: number): string {
  const divisor = 10 ** scale;
  return (amountMinor / divisor).toFixed(scale);
}
