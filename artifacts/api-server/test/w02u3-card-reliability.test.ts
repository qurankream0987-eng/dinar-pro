/**
 * W02U-3 — canonical conversational card reliability (server authority over real HTTP/PostgreSQL).
 *
 * CR-01: two signed-in sessions of one account read one pending review as the same card.
 * CR-02: a confirmation in one session is visible to the other on its next server read.
 * CR-03: two sessions confirming at the same moment have one effect.
 * CR-06: a listing changed after the review is refused with a new review, never executed.
 * CR-09: replaying a completed turn with its original client message id changes nothing.
 * CR-10: reading the conversation again restores the same card identity and message record.
 * CR-11: an expired review is terminal and cannot execute.
 * CR-12: another account, and the same account in another market, cannot read the cards.
 *
 * The model gateway is scripted and must never be called on these deterministic paths.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { aiResultSets, db, orders, pool } from "@workspace/db";
import * as Surfaces from "@workspace/api-zod/surface-composition";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W02U3_TEST_DATABASE");
const parseCardEnvelope = (Surfaces as any).parseCardEnvelope as (value: unknown) => any;
let modelCalls = 0;
const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    modelCalls++;
    return {
      id: "stub",
      name: "dinarConversationTurn",
      arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "MODEL_FALLBACK" }),
    };
  },
};
app.locals.conversationModelGateway = gateway;

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const run = `ب${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string; phone: string; password: string };
let phone = 0;
async function register(name: string): Promise<Actor> {
  const number = `77${((Date.now() + 7919 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "w02u3-password-1";
  const created = await request("/auth/register", "POST", {
    displayName: name,
    phoneCountryCode: "+962",
    phoneNumber: number,
    accountCountry: "JO",
    password,
    confirmPassword: password,
    acceptTerms: true,
  });
  assert.equal(created.status, 201, created.text);
  return { id: created.data.user.id, cookie: created.cookie, phone: number, password };
}
async function login(actor: Actor) {
  const response = await request("/auth/login", "POST", {
    phoneCountryCode: "+962",
    phoneNumber: actor.phone,
    password: actor.password,
  });
  assert.equal(response.status, 200, response.text);
  assert.ok(response.cookie, "login returns a session cookie");
  return response.cookie;
}

const seller = await register("بائع W02U3");
const buyer = await register("مشتري W02U3");
const stranger = await register("غريب W02U3");
const secondSession = await login(buyer);

const bodies: Record<string, Record<string, unknown>> = {};
async function publish(key: string, title: string, price: string, quantity = 5) {
  bodies[key] = {
    title: `${title} ${run}`,
    description: `${title} — وصف للاختبار ${run}`,
    category: "أخرى",
    categoryId: "other",
    area: "خلدا",
    city: "عمان",
    attributes: {},
    unitPrice: price,
    inventoryMode: "LIMITED",
    availableQuantity: quantity,
    fulfilmentType: "PICKUP",
    pricingMode: "FIXED",
    imageUrl: "",
    imageUrls: [],
  };
  const created = await request("/listings", "POST", bodies[key], seller.cookie);
  assert.equal(created.status, 201, `${key}: ${created.text}`);
  return created.data.id as string;
}
const firstListing = await publish("first", "لوحة", "12");
const secondListing = await publish("second", "ساعة", "15");
const thirdListing = await publish("third", "كرسي", "20");
const fourthListing = await publish("fourth", "مصباح", "30");

async function conversation(cookie = buyer.cookie) {
  const created = await request("/ai/conversations", "POST", {}, cookie);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

type Turn = { status: number; body: string; blocks: any[]; complete: any };
async function say(conversationId: string, message: string, cookie = buyer.cookie, clientMessageId?: string): Promise<Turn> {
  const response = await fetch(`${origin}/api/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ message, clientMessageId }),
  });
  const raw = await response.text();
  if (response.status !== 200) {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      data = undefined;
    }
    return { status: response.status, body: String(data?.message ?? raw), blocks: [], complete: undefined };
  }
  const complete = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5));
      } catch {
        return {};
      }
    })
    .find((event: any) => event.type === "complete");
  assert.ok(complete, `${message}: no complete event in ${raw.slice(0, 400)}`);
  return {
    status: response.status,
    body: String(complete.assistantMessage?.body ?? ""),
    blocks: (complete.assistantMessage?.blocks ?? []) as any[],
    complete,
  };
}

async function readConversation(conversationId: string, cookie = buyer.cookie) {
  const response = await request(`/ai/conversations/${conversationId}`, "GET", undefined, cookie);
  assert.equal(response.status, 200, response.text);
  return response.data;
}
const messagesOf = (view: any): any[] => view.messages ?? view.data?.messages ?? [];
function reviewIn(view: any) {
  const messages = messagesOf(view);
  for (let index = messages.length - 1; index >= 0; index--)
    for (const block of messages[index].blocks ?? [])
      if (block?.payload?.purchaseReview) return { message: messages[index], block };
  assert.fail("no purchase review block in the conversation");
}
function reviewInTurn(turn: Turn) {
  const block = turn.blocks.find((candidate) => candidate?.payload?.purchaseReview);
  assert.ok(block, `no purchase review block in turn: ${JSON.stringify(turn.blocks.map((candidate) => candidate?.payload?.surface))}`);
  return block as any;
}
function cardOf(block: any) {
  const card = parseCardEnvelope(block.payload?.card);
  assert.ok(card, `the block carries a valid envelope: ${JSON.stringify(block.payload?.card)}`);
  return card;
}
async function cartQuantity(listingId: string, cookie = buyer.cookie) {
  const cart = await request("/cart", "GET", undefined, cookie);
  assert.equal(cart.status, 200, cart.text);
  return (cart.data as any[]).find((item) => item.listingId === listingId)?.quantity ?? 0;
}
async function openReview(listingTitle: string) {
  const conversationId = await conversation();
  const found = await say(conversationId, `ابحث عن ${listingTitle} ${run}`);
  assert.ok(found.blocks.some((block) => block?.type === "LISTING_RESULTS"), `the search returns results: ${found.body}`);
  const review = await say(conversationId, "ابي الأول");
  const block = reviewInTurn(review);
  return { conversationId, review, block, card: cardOf(block) };
}

await test("CR-01 two sessions read one pending review as the same card", async () => {
  const { conversationId, card } = await openReview(`لوحة`);
  assert.equal(card.status.lifecycle, "PENDING_REVIEW");
  assert.ok(card.pendingReviewId, "the review names its pending action");
  assert.deepEqual(card.allowedActions, ["CONFIRM", "CONTINUE", "CANCEL"]);
  const fromFirst = cardOf(reviewIn(await readConversation(conversationId)).block);
  const fromSecond = cardOf(reviewIn(await readConversation(conversationId, secondSession)).block);
  assert.deepEqual(fromSecond, fromFirst, "both sessions read the same server-built card");
  assert.equal(fromSecond.surfaceId, card.surfaceId, "the identity does not depend on the reader");
  assert.equal(fromSecond.pendingReviewId, card.pendingReviewId);
  assert.equal(fromSecond.refresh.strategy, "SSE");
  assert.equal(modelCalls, 0, "the deterministic review never reaches the model");
});

let confirmedSurface = "";

await test("CR-02 a confirmation in one session is the other session's next server read", async () => {
  const { conversationId, card } = await openReview(`ساعة`);
  confirmedSurface = card.surfaceId;
  assert.equal(await cartQuantity(secondListing), 0);
  const clientMessageId = randomUUID();
  const confirmed = await say(conversationId, "نعم", buyer.cookie, clientMessageId);
  assert.match(confirmed.body, /أُضيف العرض إلى سلتك/u);
  assert.equal(await cartQuantity(secondListing), 1, "one unit enters the cart exactly once");
  assert.equal(await cartQuantity(secondListing, secondSession), 1, "the cart is the account's, not the session's");

  const otherView = await readConversation(conversationId, secondSession);
  const other = cardOf(reviewIn(otherView).block);
  assert.equal(other.surfaceId, confirmedSurface, "the historical card keeps its identity");
  assert.equal(other.status.lifecycle, "CONFIRMED");
  assert.deepEqual(other.allowedActions, []);
  assert.equal(other.pendingReviewId, undefined);
  assert.equal(other.refresh.strategy, "REFETCH");
  const before = messagesOf(otherView).length;
  const again = await readConversation(conversationId, secondSession);
  assert.equal(messagesOf(again).length, before, "reading the conversation creates no extra message");
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, buyer.id))).length, 0, "no order is created by an add-to-cart confirmation");
  assert.equal(modelCalls, 0);
});

let thirdConversation = "";

await test("CR-03 two sessions confirming at the same moment have one effect", async () => {
  const opened = await openReview(`كرسي`);
  thirdConversation = opened.conversationId;
  assert.equal(await cartQuantity(thirdListing), 0);
  const [left, right] = await Promise.all([
    say(thirdConversation, "نعم", buyer.cookie),
    say(thirdConversation, "نعم", secondSession),
  ]);
  assert.equal(left.status, 200, left.body);
  assert.equal(right.status, 200, right.body);
  assert.equal(await cartQuantity(thirdListing), 1, `two confirmations add one unit: ${left.body} | ${right.body}`);
  const claims = [left.body, right.body].filter((body) => /أُضيف العرض إلى سلتك/u.test(body)).length;
  assert.equal(claims, 1, "only the confirmation that executed says so");
  const card = cardOf(reviewIn(await readConversation(thirdConversation, secondSession)).block);
  assert.equal(card.status.lifecycle, "CONFIRMED");
  assert.equal(card.surfaceId, opened.card.surfaceId);
});

await test("CR-06 a price changed after the review is refused and reviewed again, never executed", async () => {
  const opened = await openReview(`مصباح`);
  assert.equal(await cartQuantity(fourthListing), 0);
  const changed = await request(`/listings/${fourthListing}`, "PATCH", { ...bodies.fourth, unitPrice: "28" }, seller.cookie);
  assert.equal(changed.status, 200, changed.text);
  const late = await say(opened.conversationId, "نعم");
  assert.match(late.body, /تغيّرت بيانات العرض/u, late.body);
  assert.equal(await cartQuantity(fourthListing), 0, "the stale confirmation executes nothing");
  const reopened = reviewInTurn(late);
  const freshCard = cardOf(reopened);
  assert.equal(freshCard.status.lifecycle, "PENDING_REVIEW", "a new review is offered instead of executing stale facts");
  assert.notEqual(freshCard.surfaceId, opened.card.surfaceId, "the new review has its own identity");
  assert.notEqual(freshCard.pendingReviewId, opened.card.pendingReviewId);

  const view = await readConversation(opened.conversationId, secondSession);
  const messages = messagesOf(view);
  let staleCard: any;
  let freshStored: any;
  for (const message of messages)
    for (const block of message.blocks ?? []) {
      if (!block?.payload?.purchaseReview) continue;
      const card = cardOf(block);
      if (card.surfaceId === opened.card.surfaceId) staleCard = card;
      if (card.surfaceId === freshCard.surfaceId) freshStored = card;
    }
  assert.equal(staleCard?.status.lifecycle, "EXPIRED", "the superseded review is terminal on reload");
  assert.deepEqual(staleCard?.allowedActions, [], "a superseded review cannot execute");
  assert.equal(freshStored?.status.lifecycle, "PENDING_REVIEW");
  assert.equal(await cartQuantity(fourthListing, secondSession), 0);
});

await test("CR-09 replaying a completed turn with its original id changes nothing", async () => {
  const original = messagesOf(await readConversation(thirdConversation)).find((message) => message.role === "USER" && message.body === "نعم");
  assert.ok(original?.id, "the confirmed turn is stored under its client message id");
  const replay = await request(`/ai/conversations/${thirdConversation}/turns`, "POST", {
    message: "نعم",
    clientMessageId: original.id,
  }, buyer.cookie);
  assert.equal(replay.status, 409, replay.text);
  assert.match(replay.data?.message ?? "", /اكتملت|قيد المعالجة/u);
  assert.equal(await cartQuantity(thirdListing), 1, "the replay adds no unit");
  const card = cardOf(reviewIn(await readConversation(thirdConversation)).block);
  assert.equal(card.status.lifecycle, "CONFIRMED");
  assert.equal(modelCalls, 0);
});

await test("CR-10 reading again restores the same card identity and the stored transcript", async () => {
  const conversationId = await conversation();
  await say(conversationId, `ابحث عن لوحة ${run}`);
  const review = await say(conversationId, "ابي الأول");
  const card = cardOf(reviewInTurn(review));
  const first = await readConversation(conversationId);
  const second = await readConversation(conversationId, secondSession);
  const firstCard = cardOf(reviewIn(first).block);
  const secondCard = cardOf(reviewIn(second).block);
  assert.deepEqual(secondCard, firstCard);
  assert.equal(secondCard.surfaceId, card.surfaceId);
  assert.deepEqual(messagesOf(second).map((message) => message.id), messagesOf(first).map((message) => message.id), "the stored transcript is stable");
  const top = reviewIn(second).message;
  assert.equal(top.id, review.complete.assistantMessage.id, "the review is the stored assistant message, not a rebuilt duplicate");
});

await test("CR-11 an expired review is terminal in the envelope and cannot execute", async () => {
  const opened = await openReview(`لوحة`);
  await db.update(aiResultSets).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(aiResultSets.id, opened.card.pendingReviewId));
  const expired = cardOf(reviewIn(await readConversation(opened.conversationId)).block);
  assert.equal(expired.status.lifecycle, "EXPIRED");
  assert.deepEqual(expired.allowedActions, []);
  assert.equal(expired.pendingReviewId, undefined);
  assert.equal(await cartQuantity(firstListing), 0);
  const late = await say(opened.conversationId, "نعم");
  assert.match(late.body, /انتهت صلاحية/u, late.body);
  assert.equal(await cartQuantity(firstListing), 0, "an expired confirmation has no effect");
  const again = cardOf(reviewIn(await readConversation(opened.conversationId, secondSession)).block);
  assert.equal(again.surfaceId, expired.surfaceId);
  assert.equal(again.status.lifecycle, "EXPIRED");
  assert.deepEqual(again.allowedActions, []);
});

await test("CR-12 another account and another market cannot read or drive the cards", async () => {
  const conversationId = await conversation();
  await say(conversationId, `ابحث عن ساعة ${run}`);
  await say(conversationId, "ابي الأول");
  assert.equal((await request(`/ai/conversations/${conversationId}`, "GET", undefined, stranger.cookie)).status, 404);
  const forged = await say(conversationId, "نعم", stranger.cookie);
  assert.equal(forged.status, 404);
  assert.equal(await cartQuantity(secondListing, stranger.cookie), 0);

  const switched = await request("/account/market", "PATCH", { marketId: "SA" }, buyer.cookie);
  assert.equal(switched.status, 200, switched.text);
  try {
    assert.equal((await request(`/ai/conversations/${conversationId}`, "GET", undefined, buyer.cookie)).status, 404, "a conversation is scoped to its market");
  } finally {
    assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, buyer.cookie)).status, 200);
  }
  assert.equal((await request(`/ai/conversations/${conversationId}`, "GET", undefined, buyer.cookie)).status, 200);
});

after(async () => {
  server.close();
  await pool.end();
});
