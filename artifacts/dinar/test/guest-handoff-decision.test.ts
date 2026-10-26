/**
 * Guest → account handoff: the decision taken once when an identity appears on a page, and
 * which server refusals end a handoff. Deterministic, no browser, no server.
 * Run: pnpm --filter @workspace/dinar run test:handoff
 *
 * The cases are the races seen in the registered-user browser journey (four stale 409s) and
 * the multi-account sequences around them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGuestHandoff, isFinalHandoffRejection } from "../src/features/ai/conversation-storage";
import type { AiMessage } from "../src/features/ai/ai-api";

const A = "user-a";
const B = "user-b";
const message = (id: string, role: "USER" | "ASSISTANT", body: string) => ({ id, role, body, createdAt: "2026-10-23T00:00:00.000Z" }) as unknown as AiMessage;
const guest = [message("g1", "USER", "ابحث عن لابتوب"), message("g2", "ASSISTANT", "وجدت عرضين")];
const own = [message("s1", "USER", "اشرح لي الطاقة الشمسية"), message("s2", "ASSISTANT", "الطاقة الشمسية…")];
const record = (fields: Record<string, unknown>) =>
  JSON.stringify({ marketId: "JO", handoffId: "8f0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d", context: {}, ...fields });

test("an empty guest marker is not a handoff and is removed", () => {
  const decision = decideGuestHandoff({ userId: A, marketId: "JO", raw: record({ messages: [] }), cameFromGuest: true, localMessages: [] });
  assert.deepEqual(decision, { kind: "NONE", clearStored: true });
});

test("the guest transcript on screen at sign-in is captured once", () => {
  const decision = decideGuestHandoff({ userId: A, marketId: "JO", raw: record({ messages: guest }), cameFromGuest: true, localMessages: guest });
  assert.equal(decision.kind, "CAPTURE");
  assert.deepEqual(decision.kind === "CAPTURE" && decision.messages.map((item) => item.id), ["g1", "g2"]);
});

test("an account's own messages are never a guest transcript (the original 409s)", () => {
  // A signed-in page that did not come from a guest session, with the account's own turn on screen.
  const decision = decideGuestHandoff({ userId: A, marketId: "JO", raw: null, cameFromGuest: false, localMessages: own });
  assert.deepEqual(decision, { kind: "NONE", clearStored: false });
  // Even with a leftover empty marker in the tab.
  assert.deepEqual(decideGuestHandoff({ userId: A, marketId: "JO", raw: record({ messages: [] }), cameFromGuest: false, localMessages: own }), { kind: "NONE", clearStored: true });
});

test("reload during a pending handoff resumes it for the same account", () => {
  const decision = decideGuestHandoff({ userId: A, marketId: "JO", raw: record({ messages: guest, targetUserId: A }), cameFromGuest: false, localMessages: null });
  assert.equal(decision.kind, "CAPTURE");
});

test("user A logs out and user B logs in: A's pending handoff is discarded, not sent as B", () => {
  const decision = decideGuestHandoff({ userId: B, marketId: "JO", raw: record({ messages: guest, targetUserId: A }), cameFromGuest: false, localMessages: null });
  assert.deepEqual(decision, { kind: "NONE", clearStored: true });
});

test("B arriving after A on the same page does not inherit A's messages on screen", () => {
  // The page showed A (not a guest) just before B appeared: what is on screen is A's.
  const decision = decideGuestHandoff({ userId: B, marketId: "JO", raw: null, cameFromGuest: false, localMessages: own });
  assert.deepEqual(decision, { kind: "NONE", clearStored: false });
});

test("a guest transcript from another market is reported once and dropped", () => {
  const decision = decideGuestHandoff({ userId: A, marketId: "KW", raw: record({ messages: guest }), cameFromGuest: false, localMessages: null });
  assert.deepEqual(decision, { kind: "MARKET_CHANGED" });
});

test("unreadable storage is cleared, never trusted", () => {
  assert.deepEqual(decideGuestHandoff({ userId: A, marketId: "JO", raw: "{not json", cameFromGuest: false, localMessages: null }), { kind: "NONE", clearStored: true });
});

test("final server refusals end a handoff; transient failures stay retryable", () => {
  for (const status of [400, 403, 404, 409, 422]) assert.equal(isFinalHandoffRejection({ status }), true, String(status));
  for (const status of [401, 408, 429, 500, 502, 503]) assert.equal(isFinalHandoffRejection({ status }), false, String(status));
  assert.equal(isFinalHandoffRejection(new TypeError("Failed to fetch")), false, "offline is retryable");
});
