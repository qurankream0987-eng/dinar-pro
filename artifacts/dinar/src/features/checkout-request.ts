/**
 * One checkout submission keeps one request key for the lifetime of its intent —
 * across double taps, retries after a timeout, a page reload and a second tab —
 * so the server can replay the first order instead of creating a second one.
 * A different cart or instructions is a different intent and gets a new key.
 */
const STORAGE_KEY = "dinar.checkout.request.v1";

type StoredRequest = { fingerprint: string; key: string };

function read(): StoredRequest | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRequest>;
    return typeof parsed.key === "string" && typeof parsed.fingerprint === "string"
      ? { fingerprint: parsed.fingerprint, key: parsed.key }
      : null;
  } catch {
    return null;
  }
}

export function checkoutFingerprint(
  items: readonly { listingId: string; quantity: number; fulfilmentType: string }[],
  instructions: string,
): string {
  const lines = items
    .map((item) => `${item.listingId}:${item.quantity}:${item.fulfilmentType}`)
    .sort()
    .join("|");
  return `${lines}#${instructions}`;
}

export function checkoutRequestKey(fingerprint: string): string {
  const stored = read();
  if (stored?.fingerprint === fingerprint) return stored.key;
  const key = window.crypto.randomUUID();
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ fingerprint, key } satisfies StoredRequest),
    );
  } catch {
    // Storage unavailable (private mode/quota): the key still guards this page's retries.
  }
  return key;
}

export function clearCheckoutRequestKey(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
