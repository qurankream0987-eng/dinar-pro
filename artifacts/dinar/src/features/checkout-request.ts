/**
 * One checkout submission keeps one request key for the lifetime of its intent —
 * across double taps, retries after a timeout, a page reload and a second tab —
 * so the server can replay the first order instead of creating a second one.
 * A different cart or instructions is a different intent and gets a new key.
 */
const STORAGE_KEY = "dinar.checkout.request.v2";

type StoredRequest = { hash: string; key: string };

/**
 * Only a digest of the intent is persisted: delivery instructions may hold a phone number or an
 * address and must not be left in browser storage. A digest collision just reuses a key for a
 * different payload, which the server already refuses (409, request-hash mismatch).
 */
function digest(fingerprint: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index++) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${fingerprint.length.toString(16)}:${hash.toString(16)}`;
}

function read(): StoredRequest | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRequest>;
    return typeof parsed.key === "string" && typeof parsed.hash === "string"
      ? { hash: parsed.hash, key: parsed.key }
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
  const hash = digest(fingerprint);
  const stored = read();
  if (stored?.hash === hash) return stored.key;
  const key = window.crypto.randomUUID();
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hash, key } satisfies StoredRequest),
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
