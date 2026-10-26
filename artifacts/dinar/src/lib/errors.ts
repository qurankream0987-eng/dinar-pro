const ARABIC = /[؀-ۿ]/;
const INTERNAL = /[{}\[\]]|\b(?:SQL|SELECT|INSERT|UPDATE|DELETE|postgres|migration|stack|provider|HTTP|Zod|OTP|token|cookie|password|cvv|iban|Error:)\b|api[ _-]?key|authorization|bearer|sk-[\w-]+|dnr_[\w-]+|[\w-]{40,}|\d{7,}|[-+]?\d{1,3}\.\d{4,}|رمز التحقق|مفتاح الربط|كلمة المرور|\n\s*at\s/i;
const readable = (value: string) => value.length <= 300 && ARABIC.test(value) && !INTERNAL.test(value);

/**
 * Turn any thrown value into a message a shopper can read.
 * Server errors are already Arabic; network/HTTP/JSON internals never reach the UI.
 */
export function friendlyError(error: unknown, fallback = "حدث خطأ غير متوقع. حاول مرة أخرى.") {
  const e = error as { data?: { error?: unknown }; message?: unknown; status?: number } | null;
  const fromData = typeof e?.data?.error === "string" ? e.data.error : "";
  if (fromData && readable(fromData)) return fromData;
  const message = typeof e?.message === "string" ? e.message : "";
  // Generated client prefixes "HTTP 409 Conflict: <server message>".
  const serverPart = message.includes(": ") ? message.slice(message.indexOf(": ") + 2) : message;
  if (serverPart && readable(serverPart)) return serverPart;
  if (e?.status === 401) return "انتهت جلستك. سجّل الدخول مرة أخرى.";
  if (e?.status === 404) return "لم نعثر على ما تبحث عنه.";
  if (/fetch|network|Failed/i.test(message)) return "تعذر الاتصال. تحقق من الإنترنت وحاول مرة أخرى.";
  return fallback;
}
