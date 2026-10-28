/**
 * Wave 02 — smart card reliability.
 *
 * W02.1: one lifecycle vocabulary for cards (READY, PENDING_REVIEW, CONFIRMED, CANCELLED,
 * EXPIRED, UNAVAILABLE, DENIED, FAILED) and terminal cards never carry a SEND action.
 * W02.2: expired authority is refused (expired result set, paused listing).
 * W02.3: repeated card actions have one effect — double submit, retry, reload, two sessions,
 * concurrent requests — while the server still revalidates every resource change.
 *
 * Real HTTP, conversation runtime and database on a disposable loopback database; the model
 * gateway is scripted and never called for the deterministic paths under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { aiResultSets, db, offers } from "@workspace/db";
import * as Surfaces from "@workspace/api-zod/surface-composition";
import app from "../src/app";
import { AIProviderError, type ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE02_ACCEPTANCE");

const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    throw new AIProviderError("REPLIT_OPENAI", "NOT_CONFIGURED", "scripted", 1, 401);
  },
};
app.locals.conversationModelGateway = gateway;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "", headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.23.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string; label: string; phoneNumber: string; password: string };
const phoneBase = 51_690_000 + ((Date.now() + process.pid) % 9_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Wave02-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR Wave02 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie, label, phoneNumber, password };
}
async function login(actor: Actor): Promise<string> {
  const response = await request("/auth/login", "POST", { phoneCountryCode: "+965", phoneNumber: actor.phoneNumber, password: actor.password });
  assert.equal(response.status, 200, response.raw);
  assert.ok(response.cookie, "login returns a session cookie");
  return response.cookie;
}
async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}
async function say(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: actor.cookie }, body: JSON.stringify({ message }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 500)}`);
  return { body: complete.assistantMessage.body as string, blocks: (complete.assistantMessage.blocks ?? []) as any[] };
}
function resultSetOf(turn: { blocks: any[] }, listingId: string) {
  const block = turn.blocks.find((candidate) => candidate.type === "LISTING_RESULTS");
  assert.ok(block, "search returns listing results");
  assert.ok((block.payload.resourceIds as string[]).includes(listingId), "the listing is in the results");
  return { resultSetId: block.payload.resultSetId as string, resourceIds: block.payload.resourceIds as string[] };
}
async function search(actor: Actor, conv: string, listingId: string, title: string) {
  return resultSetOf(await say(actor, conv, `ابحث عن ${title}`), listingId);
}
async function publish(actor: Actor, title: string, quantity: number, price = "3") {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: quantity, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}
async function cardAdd(actor: Actor, conv: string, resultSetId: string, listingId: string, cookie = actor.cookie) {
  return request(`/ai/conversations/${conv}/actions/add-to-cart`, "POST", { resultSetId, resourceId: listingId }, cookie);
}
async function cartLine(actor: Actor, listingId: string) {
  const cart = await request("/cart", "GET", undefined, actor.cookie);
  assert.equal(cart.status, 200, cart.raw);
  return (cart.data as any[]).find((item) => item.listingId === listingId);
}
const quantityOf = async (actor: Actor, listingId: string) => (await cartLine(actor, listingId))?.quantity ?? 0;

// ─── W02.1: one lifecycle vocabulary; terminal cards carry no SEND action ──────

await test("W02.1 card states include the review lifecycle and terminal cards refuse SEND actions", () => {
  const lifecycleState = (Surfaces as any).actionLifecycleState as undefined | ((status: string) => string);
  const allowsActions = (Surfaces as any).surfaceAllowsActions as undefined | ((state: string) => boolean);
  for (const state of ["READY", "PENDING_REVIEW", "CONFIRMED", "CANCELLED", "EXPIRED", "UNAVAILABLE", "DENIED", "FAILED"])
    assert.ok((Surfaces.SURFACE_STATES as readonly string[]).includes(state), `${state} is a surface state`);
  assert.equal(typeof lifecycleState, "function", "actionLifecycleState is exported");
  assert.equal(typeof allowsActions, "function", "surfaceAllowsActions is exported");
  if (typeof lifecycleState !== "function" || typeof allowsActions !== "function") return;

  assert.equal(lifecycleState("PENDING"), "PENDING_REVIEW");
  assert.equal(lifecycleState("EXECUTING"), "PENDING_REVIEW");
  assert.equal(lifecycleState("CONFIRMED"), "CONFIRMED");
  assert.equal(lifecycleState("CANCELLED"), "CANCELLED");
  assert.equal(lifecycleState("REJECTED"), "CANCELLED");
  assert.equal(lifecycleState("SUPERSEDED"), "CANCELLED");
  assert.equal(lifecycleState("EXPIRED"), "EXPIRED");
  assert.equal(lifecycleState("SOMETHING_ELSE"), "READY");

  for (const state of ["READY", "EMPTY", "PENDING_REVIEW", "UNAVAILABLE", "FAILED"])
    assert.equal(allowsActions(state), true, `${state} may carry actions`);
  for (const state of ["CONFIRMED", "CANCELLED", "EXPIRED", "DENIED"])
    assert.equal(allowsActions(state), false, `${state} must not carry actions`);

  const base = { version: 1 as const, label: "بطاقة", size: "COMPACT" as const };
  const send = { kind: "SEND" as const, label: "تأكيد", message: "نعم", emphasis: "PRIMARY" as const };
  const navigate = { kind: "NAVIGATE" as const, label: "عرض الطلب", path: "/orders" };
  for (const state of ["CONFIRMED", "CANCELLED", "EXPIRED", "DENIED"] as const)
    assert.equal(
      Surfaces.ComposedSurfaceSchema.safeParse({ ...base, state, sections: [{ type: "actions", items: [send] }] }).success,
      false,
      `${state} with a SEND action is invalid`,
    );
  for (const state of ["READY", "PENDING_REVIEW"] as const)
    assert.equal(
      Surfaces.ComposedSurfaceSchema.safeParse({ ...base, state, sections: [{ type: "actions", items: [send] }] }).success,
      true,
      `${state} with a SEND action is valid`,
    );
  assert.equal(
    Surfaces.ComposedSurfaceSchema.safeParse({ ...base, state: "CONFIRMED", sections: [{ type: "actions", items: [navigate] }] }).success,
    true,
    "a terminal card may still navigate to the record it names",
  );
});

// ─── Setup ─────────────────────────────────────────────────────────────────────

let buyer: Actor, buyer2: Actor, seller: Actor;
let buyerConv = "", buyer2Conv = "";
let cups = "", lamps = "";
let cupsSet = "", lampsSet = "";

await test("setup: seller lists two offers; each buyer searches once", async () => {
  [buyer, buyer2, seller] = await Promise.all(["Buyer", "Buyer2", "Seller"].map((label) => register(label)));
  cups = await publish(seller, `أكواب موجة ${TOKEN}`, 20);
  lamps = await publish(seller, `فوانيس موجة ${TOKEN}`, 10);
  buyerConv = await conversation(buyer);
  cupsSet = (await search(buyer, buyerConv, cups, `أكواب موجة ${TOKEN}`)).resultSetId;
  buyer2Conv = await conversation(buyer2);
  lampsSet = (await search(buyer2, buyer2Conv, lamps, `فوانيس موجة ${TOKEN}`)).resultSetId;
});

// ─── W02.3: one effect for repeat, reload, concurrent and cross-session adds ──

let firstCardMessage = "";

await test("W02.3 repeated card add (button tapped twice) has one effect and replays the same message", async () => {
  const first = await cardAdd(buyer, buyerConv, cupsSet, cups);
  assert.equal(first.status, 200, first.raw);
  firstCardMessage = first.data.assistantMessage.id;
  const second = await cardAdd(buyer, buyerConv, cupsSet, cups);
  assert.equal(second.status, 200, second.raw);
  assert.equal(second.data.assistantMessage.id, firstCardMessage, "the retry returns the first receipt, not a second add");
  assert.equal(await quantityOf(buyer, cups), 1, "one unit added");
});

let concurrentCardMessage = "";

await test("W02.3 concurrent card submits have one effect", async () => {
  const [left, right] = await Promise.all([
    cardAdd(buyer2, buyer2Conv, lampsSet, lamps),
    cardAdd(buyer2, buyer2Conv, lampsSet, lamps),
  ]);
  assert.equal(left.status, 200, left.raw);
  assert.equal(right.status, 200, right.raw);
  assert.equal(left.data.assistantMessage.id, right.data.assistantMessage.id, "both requests settle on one receipt");
  concurrentCardMessage = left.data.assistantMessage.id;
  assert.equal(await quantityOf(buyer2, lamps), 1, "one unit added");
});

await test("W02.3 the same card add from two sessions has one effect", async () => {
  const secondSession = await login(buyer2);
  const current = await cartLine(buyer2, lamps);
  const replay = await cardAdd(buyer2, buyer2Conv, lampsSet, lamps, secondSession);
  assert.equal(replay.status, 200, replay.raw);
  assert.equal(replay.data.assistantMessage.id, concurrentCardMessage, "the second session receives the stored receipt");
  assert.equal(await quantityOf(buyer2, lamps), current.quantity, "the cart did not grow");
});

// ─── W02.2: expired authority is refused and nothing changes ──────────────────

await test("W02.2 an expired result set can never add to the cart", async () => {
  await db.update(aiResultSets).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(aiResultSets.id, cupsSet));
  const before = await quantityOf(buyer, cups);
  const denied = await cardAdd(buyer, buyerConv, cupsSet, cups);
  assert.equal(denied.status, 409, denied.raw);
  assert.equal(await quantityOf(buyer, cups), before, "the cart is unchanged");
});

await test("W02.2 a listing paused after the card was shown is refused, not bought", async () => {
  const fresh = await conversation(buyer);
  const set = (await search(buyer, fresh, lamps, `فوانيس موجة ${TOKEN}`)).resultSetId;
  const paused = await request(`/listings/${lamps}/status`, "PATCH", { action: "PAUSE" }, seller.cookie);
  assert.equal(paused.status, 200, paused.raw);
  const before = await quantityOf(buyer, lamps);
  const denied = await cardAdd(buyer, fresh, set, lamps);
  assert.equal(denied.status, 409, denied.raw);
  assert.equal(await quantityOf(buyer, lamps), before, "the cart is unchanged");
  assert.equal((await request(`/listings/${lamps}/status`, "PATCH", { action: "RESUME" }, seller.cookie)).status, 200);
});

// ─── W02.3: idempotent publication and checkout (one record per request) ─────

await test("W02.3 listing publication with one key creates one listing; the same key with other data is refused", async () => {
  const key = randomUUID();
  const body = {
    title: `طاولة موجة ${TOKEN}`, description: `طاولة خشب ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: "7", inventoryMode: "LIMITED", availableQuantity: 2, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  };
  const first = await request("/listings", "POST", body, seller.cookie, { "Idempotency-Key": key });
  const second = await request("/listings", "POST", body, seller.cookie, { "Idempotency-Key": key });
  assert.equal(first.status, 201, first.raw);
  assert.equal(second.status, 200, second.raw);
  assert.equal(second.data.id, first.data.id, "the retry resolves to the same listing");
  const rows = await db.select().from(offers).where(eq(offers.id, first.data.id));
  assert.equal(rows.length, 1);
  const conflicting = await request("/listings", "POST", { ...body, title: `طاولة أخرى ${TOKEN}` }, seller.cookie, { "Idempotency-Key": key });
  assert.equal(conflicting.status, 409, conflicting.raw);
});

await test("W02.3 checkout replays one order for one persisted key and refuses a different payload", async () => {
  const line = { listingId: cups, quantity: 1, fulfilmentType: "PICKUP" };
  const key = `wave02-${randomUUID()}`;
  const first = await request("/checkout", "POST", { idempotencyKey: key, items: [line] }, buyer.cookie);
  assert.equal(first.status, 201, first.raw);
  const reloaded = await request("/checkout", "POST", { idempotencyKey: key, items: [line] }, buyer.cookie);
  assert.equal(reloaded.status, 201, reloaded.raw);
  assert.deepEqual(reloaded.data.orders.map((order: any) => order.id), first.data.orders.map((order: any) => order.id), "a reload resubmitting the same key gets the same order");
  const conflicting = await request("/checkout", "POST", { idempotencyKey: key, items: [{ ...line, quantity: 2 }] }, buyer.cookie);
  assert.equal(conflicting.status, 409, conflicting.raw);
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
