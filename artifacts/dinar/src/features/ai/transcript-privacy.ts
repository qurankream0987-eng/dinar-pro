/** Presentation-only redaction. The original message and all server authority remain untouched. */
export function privateTranscript(body: string): string {
  return body
    .replace(/(?:api[ _-]?key|access[ _-]?token|authorization|bearer|cookie|password|otp|cvv|iban|كلمة المرور|رمز التحقق|مفتاح الربط)\s*[:=]?\s*(?:(?:هي|هو|is)\s+)?\S+/giu, "[بيانات خاصة محجوبة]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|dnr_[A-Za-z0-9_-]+)\b/g, "[بيانات دخول محجوبة]")
    .replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[بيانات دخول محجوبة]")
    .replace(/[-+]?\d{1,3}\.\d{4,}/g, "[موقع خاص محجوب]")
    .replace(/(?:\d[ -]?){13,19}/g, "[بيانات مالية محجوبة]");
}
