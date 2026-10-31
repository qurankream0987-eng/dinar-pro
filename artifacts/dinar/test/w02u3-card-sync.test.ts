/**
 * W02U-3 — cross-tab card invalidation is metadata only and scope-checked.
 *
 * A tab may tell sibling tabs of the same signed-in account in the same market that a card may
 * have changed. It carries no card content, no identifiers beyond the conversation route and no
 * authority: the receiving tab only re-reads the conversation from the server. Anything else —
 * another account, another market, an unknown field, a malformed id — is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardSyncChannelName, cardSyncEvent, parseCardSyncEvent } from "../src/features/ai/card-sync";

const userId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const marketId = "JO";
const conversationId = "6f1c1c61-1f6f-4c61-9f6f-3f0c6f0e2222";

test("W02U3.1 a card sync event carries only its scope, its conversation and a timestamp", () => {
  const event = cardSyncEvent(userId, marketId, conversationId, 1_700_000_000_000);
  assert.deepEqual(Object.keys(event).sort(), ["conversationId", "issuedAt", "marketId", "type", "userId"]);
  assert.equal(JSON.stringify(event).includes("card"), false, "no card payload is broadcast");
  assert.equal(JSON.stringify(event).includes("price"), false, "no listing facts are broadcast");
  assert.deepEqual(parseCardSyncEvent(JSON.parse(JSON.stringify(event)), userId, marketId), event);
});

test("W02U3.1 the channel is scoped to one account in one market", () => {
  const jo = cardSyncChannelName(userId, "JO");
  assert.notEqual(jo, cardSyncChannelName(userId, "SA"), "another market is another channel");
  assert.notEqual(jo, cardSyncChannelName("1f8fad5b-d9cb-469f-a165-70867728950e", "JO"), "another account is another channel");
  assert.equal(jo.includes("+"), false, "no phone number or contact identifier enters a channel name");
});

test("W02U3.2 a forged or out-of-scope event is refused", () => {
  const event = cardSyncEvent(userId, marketId, conversationId);
  assert.equal(parseCardSyncEvent(event, "1f8fad5b-d9cb-469f-a165-70867728950e", marketId), null, "another account is not addressed");
  assert.equal(parseCardSyncEvent(event, userId, "SA"), null, "another market is not addressed");
  assert.equal(parseCardSyncEvent({ ...event, type: "execute" }, userId, marketId), null, "only invalidation is understood");
  assert.equal(parseCardSyncEvent({ ...event, conversationId: "not-a-conversation" }, userId, marketId), null);
  assert.equal(parseCardSyncEvent({ ...event, issuedAt: "now" }, userId, marketId), null);
  assert.equal(parseCardSyncEvent({ ...event, card: { status: "CONFIRMED" } }, userId, marketId), null, "extra content is refused, not ignored");
  assert.equal(parseCardSyncEvent({ ...event, userId: "someone" }, userId, marketId), null);
  assert.equal(parseCardSyncEvent(null, userId, marketId), null);
  assert.equal(parseCardSyncEvent("cards", userId, marketId), null);
});
