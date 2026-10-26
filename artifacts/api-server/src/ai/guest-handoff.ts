export type GuestHandoffMessage = {
  id: string;
  actor: "USER" | "ASSISTANT";
  body: string;
};

const PRIVATE_CONTENT = [
  /\b(?:password|passcode|api[_ -]?key|secret|token|bearer|authorization|private key)\b|كلمة(?: المرور| السر)|رمز(?: التحقق| الدخول)|مفتاح(?: خاص| API)/iu,
  /\b[A-Za-z0-9_-]{32,}\b/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?<!\d)(?:\+?\d[\s().-]*){10,15}(?!\d)/u,
  /(?:private|uploads?|objects?|bucket)\/[A-Za-z0-9._/-]{8,}/iu,
  /-?\d{1,2}\.\d{4,}\s*[,/]\s*-?\d{1,3}\.\d{4,}/u,
];

// A complete general answer (up to 6000 chars plus a status line) must survive restore and handoff.
const GUEST_MESSAGE_MAX = 7000;

export function isSafeGuestHandoffText(body: string): boolean {
  return (
    body.trim().length > 0 &&
    body.length <= GUEST_MESSAGE_MAX &&
    !PRIVATE_CONTENT.some((pattern) => pattern.test(body))
  );
}

export function sanitizeGuestHandoffMessages(
  items: readonly GuestHandoffMessage[],
): GuestHandoffMessage[] {
  return items.flatMap((item) =>
    isSafeGuestHandoffText(item.body)
      ? [{ ...item, body: item.body.trim() }]
      : [],
  );
}
