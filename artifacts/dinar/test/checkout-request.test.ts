/**
 * Wave 02 — a checkout keeps one request key for one intent, so a reload or a retry after a
 * timeout replays the same order instead of creating a second one.
 * Run: pnpm --filter @workspace/dinar run test:surfaces
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
let uuidSequence = 0;
(globalThis as any).window = {
  sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  crypto: {
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
  },
};
const { checkoutFingerprint, checkoutRequestKey, clearCheckoutRequestKey } =
  await import("../src/features/checkout-request");

test("one cart intent keeps one key across a reload; a new cart or a finished order does not", () => {
  const apples = { listingId: "a", quantity: 2, fulfilmentType: "PICKUP" };
  const bread = { listingId: "b", quantity: 1, fulfilmentType: "PICKUP" };
  const intent = checkoutFingerprint([bread, apples], "");

  const first = checkoutRequestKey(intent);
  assert.equal(checkoutRequestKey(intent), first, "a reload reuses the persisted key");

  const reordered = checkoutFingerprint([apples, bread], "");
  assert.equal(checkoutRequestKey(reordered), first, "listing order is not a new intent");

  const changed = checkoutRequestKey(
    checkoutFingerprint([{ ...apples, quantity: 3 }], ""),
  );
  assert.notEqual(changed, first, "a changed cart is a new intent");

  clearCheckoutRequestKey();
  assert.notEqual(
    checkoutRequestKey(intent),
    first,
    "a completed order must not replay for the next one",
  );

  const withInstructions = checkoutRequestKey(
    checkoutFingerprint([apples, bread], "اتصل قبل التوصيل"),
  );
  assert.notEqual(withInstructions, first, "new delivery instructions are a new intent");
});
