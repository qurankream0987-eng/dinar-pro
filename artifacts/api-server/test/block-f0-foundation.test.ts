import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { aiResultSets, cartItems, carts, db, markets, offers, pool, users } from "@workspace/db";
import { resolveMarket } from "../src/lib/markets";
import { executeRegisteredTool, ToolRejectedError } from "../src/ai/tool-registry";
import {
  confirmPendingAction,
  conversationContext,
  commandFacts,
  createPendingAction,
  parseCommandNumbers,
  proposeAction,
  readServerSnapshot,
  resolveFact,
  resolveReference,
  serverFacts,
  UnknownActionError,
  type Fact,
} from "../src/ai/action-foundation";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = `f${randomUUID().replaceAll("-", "").slice(0, 7)}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.18.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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

type Actor = { id: string; cookie: string };
// Kuwaiti numbers from 51,800,000 up are invalid: the range stays below it.
const phoneBase = 51_300_000 + ((Date.now() + process.pid) % 400_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `BlockF-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR F0 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function turn(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, raw.slice(0, 300));
  return complete.assistantMessage.blocks[0]?.payload;
}

async function publish(seller: Actor, title: string, price: string) {
  const created = await request("/listings", "POST", {
    title, description: `اختبار F0 ${runId} ${title}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const results: Record<string, "PASS" | "FAIL"> = {};
async function focused(id: string, name: string, body: () => Promise<void> | void) {
  await test(`${id} ${name}`, async () => {
    try {
      await body();
      results[id] = "PASS";
    } catch (error) {
      results[id] = "FAIL";
      throw error;
    }
  });
}

let JO: Awaited<ReturnType<typeof resolveMarket>>;
let seller: Actor;
let buyer: Actor;
let other: Actor;
const L: string[] = [];
let sellerConv = "";
let buyerConv = "";
let sellerSetIds: string[] = [];
const priceOf = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!.unitPriceMinor;
const setRow = async (id: string) => (await db.select().from(aiResultSets).where(eq(aiResultSets.id, id)))[0]!;

await test("setup: disposable loopback DB, fresh actors and listings", async () => {
  const [row] = await db.select().from(markets).where(eq(markets.id, "JO"));
  JO = await resolveMarket(row!);
  [seller, buyer, other] = await Promise.all(["Seller", "Buyer", "Other"].map(register));
  for (const [title, price] of [["مزهرية أولى", "10"], ["مزهرية ثانية", "20"], ["مزهرية ثالثة", "30"]] as const) L.push(await publish(seller, title, price));
  sellerConv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id;
  buyerConv = (await request("/ai/conversations", "POST", {}, buyer.cookie)).data.id;
});

await focused("F0-01", "ordinals and «هذا» resolve through persisted result identity", async () => {
  const mine = await turn(seller, sellerConv, "إعلاناتي");
  sellerSetIds = (await setRow(mine.resultSetId)).resourceIds;
  assert.ok(sellerSetIds.length >= 3);
  const ref = (message: string, actor = seller, conversationId = sellerConv) =>
    resolveReference({ conversationId, marketId: "JO", actorId: actor.id, message });
  assert.equal((await ref("الثاني"))?.resourceId, sellerSetIds[1]);
  assert.equal((await ref("الإعلان الأول"))?.resourceId, sellerSetIds[0]);
  assert.equal((await ref("غير سعر الإعلان الثالث إلى 9"))?.resourceId, sellerSetIds[2]);
  assert.equal(await ref("العاشر"), undefined, "out of range resolves to nothing");
  // Another actor's conversation rows are never a reference for this actor.
  assert.equal(await ref("الثاني", other, sellerConv), undefined);
  const found = await turn(buyer, buyerConv, `مزهرية ${runId}`);
  const buyerSet = (await setRow(found.resultSetId)).resourceIds;
  assert.equal(buyerSet.length, 3);
  assert.equal((await ref("السيارة الثالثة", buyer, buyerConv))?.resourceId, buyerSet[2]);
  await turn(buyer, buyerConv, "الثاني");
  assert.equal((await ref("أريد هذا", buyer, buyerConv))?.resourceId, buyerSet[1]);
  assert.equal(getModelGatewayCallCount(), 0);
});

await focused("F0-02", "numbers are read by the phrase that owns them", () => {
  assert.deepEqual(parseCommandNumbers("غير سعر الإعلان الثاني إلى 5"), { deictic: false, price: "5", ordinal: 2 });
  assert.deepEqual(parseCommandNumbers("أريد قطعتين من المنتج الثالث"), { deictic: false, quantity: 2, ordinal: 3 });
  assert.deepEqual(parseCommandNumbers("روّج الإعلان الثاني لمدة 7 أيام"), { deictic: false, durationDays: 7, ordinal: 2 });
  assert.deepEqual(parseCommandNumbers("أريد 3 قطع من الإعلان رقم 2"), { deictic: false, quantity: 3, ordinal: 2 });
  assert.deepEqual(parseCommandNumbers("ابحث لي عن تيشرت نايكي بـ5"), { deictic: false, price: "5" });
  assert.deepEqual(parseCommandNumbers("غير سعر الإعلان ٢ إلى ١٥"), { deictic: false, price: "15", ordinal: 2 });
  assert.equal(parseCommandNumbers("أريد هذا").deictic, true);
  assert.deepEqual(parseCommandNumbers("اجعل سعر هذه القطعة 5 بدل 10"), { deictic: true, price: "5" });
  assert.deepEqual(parseCommandNumbers("عندي 6 قطع بدل 2"), { deictic: false, quantity: 6 });
  assert.deepEqual(parseCommandNumbers("اجعل سعر هذه القطعة 5"), { deictic: true, price: "5" });
  assert.deepEqual(parseCommandNumbers("كم أحط سعر الإعلان رقم 2؟"), { deictic: false, ordinal: 2 });
});

await focused("F0-03", "facts carry provenance", async () => {
  const facts = commandFacts("غير سعر الإعلان الثاني إلى 5");
  assert.deepEqual(facts.price, [{ value: "5", source: "USER_DECLARED" }]);
  const server = serverFacts(await readServerSnapshot(seller.id, L[0]!));
  assert.deepEqual(server.available, { value: 4, source: "SERVER_FACT" });
  assert.equal(server.unitPriceMinor!.source, "SERVER_FACT");
  const suggestion: Fact = { value: "12", source: "DINAR_DERIVED" };
  const imageGuess: Fact = { value: "مصباح", source: "IMAGE_INFERRED" };
  const proposal = proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: L[0], facts: { price: [suggestion], title: [imageGuess] } });
  assert.deepEqual(proposal.structuredInput.price, suggestion);
  assert.deepEqual(proposal.structuredInput.title, imageGuess);
  assert.equal(resolveFact([]).source, "UNKNOWN");
});

await focused("F0-04", "an explicit user correction overrides image and DINAR inference", () => {
  const image: Fact = { value: "أزرق", source: "IMAGE_INFERRED" };
  const user: Fact = { value: "أسود", source: "USER_DECLARED" };
  assert.deepEqual(resolveFact([image, user]), user);
  assert.deepEqual(resolveFact([user, image]), user, "a later inference does not undo the user's correction");
  assert.deepEqual(resolveFact([{ value: "12", source: "DINAR_DERIVED" }, { value: "9", source: "USER_DECLARED" }]).value, "9");
  assert.deepEqual(resolveFact([{ value: "4", source: "USER_DECLARED" }, { value: "6", source: "USER_DECLARED" }]).value, "6", "latest user statement wins");
});

await focused("F0-05", "current server facts override conversational memory; unknown stays unknown", () => {
  const remembered: Fact = { value: 5, source: "USER_DECLARED" };
  const current: Fact = { value: 2, source: "SERVER_FACT" };
  assert.deepEqual(resolveFact([current, remembered]), current);
  assert.deepEqual(resolveFact([remembered, current]), current);
  assert.deepEqual(resolveFact([{ value: null, source: "IMAGE_INFERRED" }, { value: "x", source: "UNKNOWN" }, { value: "", source: "DINAR_DERIVED" }]), { value: null, source: "UNKNOWN" });
});

await focused("F0-06", "a later unrelated «نعم» cannot execute an old confirmation", async () => {
  const proposal = proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: sellerSetIds[1], facts: commandFacts("غير سعر الإعلان الثاني إلى 5") });
  const review = await createPendingAction({ conversationId: sellerConv, actorId: seller.id, market: JO, proposal });
  assert.equal((await confirmPendingAction({ actionId: review.actionId, actorId: other.id, market: JO, decision: "CONFIRM" }).catch((error) => error)).status, 404);
  const before = await priceOf(sellerSetIds[1]!);
  await turn(seller, sellerConv, "إعلاناتي"); // the conversation moved on
  const stale = await confirmPendingAction({ actionId: review.actionId, actorId: seller.id, market: JO, decision: "CONFIRM" });
  assert.equal(stale.status, "EXPIRED");
  assert.equal(await priceOf(sellerSetIds[1]!), before);
  // Expiry alone also voids it.
  const expiring = await createPendingAction({ conversationId: sellerConv, actorId: seller.id, market: JO, proposal });
  await db.update(aiResultSets).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiResultSets.id, expiring.actionId));
  assert.equal((await confirmPendingAction({ actionId: expiring.actionId, actorId: seller.id, market: JO, decision: "CONFIRM" })).status, "EXPIRED");
  assert.equal(await priceOf(sellerSetIds[1]!), before);
  // A fresh confirmation in place executes once; repeating it changes nothing.
  const fresh = await createPendingAction({ conversationId: sellerConv, actorId: seller.id, market: JO, proposal });
  assert.equal((await confirmPendingAction({ actionId: fresh.actionId, actorId: seller.id, market: JO, decision: "CONFIRM" })).status, "CONFIRMED");
  assert.equal(await priceOf(sellerSetIds[1]!), 5_000);
  const repeated = await confirmPendingAction({ actionId: fresh.actionId, actorId: seller.id, market: JO, decision: "CONFIRM" });
  assert.equal(repeated.status, "CONFIRMED");
  assert.match(repeated.message, /من قبل/);
});

await focused("F0-07", "server state is re-read before execution; changes require a new review", async () => {
  const target = sellerSetIds[0]!;
  const proposal = proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: target, facts: { price: [{ value: "7", source: "USER_DECLARED" }] } });
  const review = await createPendingAction({ conversationId: sellerConv, actorId: seller.id, market: JO, proposal });
  // The listing changes elsewhere after the review.
  await db.update(offers).set({ unitPriceMinor: 11_000, updatedAt: new Date() }).where(eq(offers.id, target));
  const outcome = await confirmPendingAction({ actionId: review.actionId, actorId: seller.id, market: JO, decision: "CONFIRM" });
  assert.equal(outcome.status, "REVIEW_REQUIRED");
  assert.equal(await priceOf(target), 11_000, "nothing executed on the old confirmation");
  assert.equal((await setRow(review.actionId)).query.status, "SUPERSEDED");
  assert.ok(outcome.status === "REVIEW_REQUIRED" && outcome.review.lines.some((line) => line.includes("11.000")));
  const confirmed = await confirmPendingAction({ actionId: (outcome as any).review.actionId, actorId: seller.id, market: JO, decision: "CONFIRM" });
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(await priceOf(target), 7_000);

  // Buyer action: moderation, account state and market are re-checked at confirmation.
  const cart = proposeAction({ action: "ADD_TO_CART", targetResource: L[2], facts: commandFacts("أريد قطعتين من المنتج الثالث") });
  const moderated = await createPendingAction({ conversationId: buyerConv, actorId: buyer.id, market: JO, proposal: cart });
  await db.update(offers).set({ status: "MODERATION_HIDDEN" }).where(eq(offers.id, L[2]!));
  const hidden = await confirmPendingAction({ actionId: moderated.actionId, actorId: buyer.id, market: JO, decision: "CONFIRM" });
  assert.equal(hidden.status, "REJECTED");
  await db.update(offers).set({ status: "PUBLISHED" }).where(eq(offers.id, L[2]!));
  const restricted = await createPendingAction({ conversationId: buyerConv, actorId: buyer.id, market: JO, proposal: cart });
  await db.update(users).set({ status: "RESTRICTED" }).where(eq(users.id, buyer.id));
  assert.equal((await confirmPendingAction({ actionId: restricted.actionId, actorId: buyer.id, market: JO, decision: "CONFIRM" })).status, "REJECTED");
  await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, buyer.id));
  const moved = await createPendingAction({ conversationId: buyerConv, actorId: buyer.id, market: JO, proposal: cart });
  await db.update(users).set({ activeMarketId: "KW" }).where(eq(users.id, buyer.id));
  assert.equal((await confirmPendingAction({ actionId: moved.actionId, actorId: buyer.id, market: JO, decision: "CONFIRM" })).status, "REJECTED");
  await db.update(users).set({ activeMarketId: "JO" }).where(eq(users.id, buyer.id));
  const [buyerCart] = await db.select().from(carts).where(eq(carts.userId, buyer.id));
  assert.equal(buyerCart ? (await db.select().from(cartItems).where(eq(cartItems.cartId, buyerCart.id))).length : 0, 0);
  // Unchanged state executes through the existing cart authority, with the parsed quantity.
  const ok = await createPendingAction({ conversationId: buyerConv, actorId: buyer.id, market: JO, proposal: cart });
  assert.equal((await confirmPendingAction({ actionId: ok.actionId, actorId: buyer.id, market: JO, decision: "CONFIRM" })).status, "CONFIRMED");
  const [after] = await db.select().from(carts).where(eq(carts.userId, buyer.id));
  const items = await db.select().from(cartItems).where(eq(cartItems.cartId, after!.id));
  assert.deepEqual(items.map((item) => [item.offerId, item.quantity]), [[L[2], 2]]);
  // Ownership is re-checked too: a seller cannot buy their own listing.
  await assert.rejects(createPendingAction({ conversationId: sellerConv, actorId: seller.id, market: JO, proposal: cart }), /لا يمكنك شراء عرضك/);
});

await focused("F0-08", "only missing required information is requested", async () => {
  const target = (await resolveReference({ conversationId: sellerConv, marketId: "JO", actorId: seller.id, message: "غير سعر الإعلان الثاني إلى 5" }))?.resourceId;
  assert.deepEqual(proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: target, facts: commandFacts("غير سعر الإعلان الثاني إلى 5") }).missingFields, []);
  assert.deepEqual(proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: target, facts: commandFacts("غير سعر الإعلان الثاني") }).missingFields, ["price"]);
  const noTarget = await resolveReference({ conversationId: sellerConv, marketId: "JO", actorId: seller.id, message: "غير السعر إلى 5" });
  assert.deepEqual(proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: noTarget?.resourceId, facts: commandFacts("غير السعر إلى 5") }).missingFields, ["targetResource"]);
  assert.deepEqual(proposeAction({ action: "ADD_TO_CART", targetResource: L[0], facts: commandFacts("أريد قطعتين من المنتج الأول") }).missingFields, []);
  const incomplete = proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: target, facts: {} });
  await assert.rejects(createPendingAction({ conversationId: sellerConv, actorId: seller.id, market: JO, proposal: incomplete }), /معلومات ناقصة: price/);
});

await focused("F0-09", "orchestration context is rebuilt from server rows after reload", async () => {
  await turn(seller, sellerConv, "إعلاناتي");
  const proposal = proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: sellerSetIds[2], facts: commandFacts("غير سعر الإعلان الثالث إلى 25") });
  const review = await createPendingAction({ conversationId: sellerConv, actorId: seller.id, market: JO, proposal });
  const first = await conversationContext({ conversationId: sellerConv, actorId: seller.id, market: JO });
  // "Reload": nothing in process memory is reused; the history endpoint still serves.
  const history = await request(`/ai/conversations/${sellerConv}`, "GET", undefined, seller.cookie);
  assert.equal(history.status, 200);
  const second = await conversationContext({ conversationId: sellerConv, actorId: seller.id, market: JO });
  assert.deepEqual(second, first);
  assert.equal(second.currentGoal, "UPDATE_LISTING_PRICE");
  assert.equal(second.pendingAction?.actionId, review.actionId);
  assert.equal(second.currentSelection, sellerSetIds[2]);
  assert.deepEqual(second.knownFacts.price, { value: "25", source: "USER_DECLARED" });
  assert.equal(second.knownFacts.available?.source, "SERVER_FACT");
  assert.ok(second.currentResultSet?.resourceIds.includes(sellerSetIds[2]!));
  // Another actor sees none of it.
  const foreign = await conversationContext({ conversationId: sellerConv, actorId: other.id, market: JO });
  assert.equal(foreign.pendingAction, null);
  await confirmPendingAction({ actionId: review.actionId, actorId: seller.id, market: JO, decision: "CANCEL" });
  assert.equal((await conversationContext({ conversationId: sellerConv, actorId: seller.id, market: JO })).pendingAction, null);
});

await focused("F0-10", "unregistered actions and tools are rejected", async () => {
  for (const name of ["DELETE_ALL_LISTINGS", "transferMoney", "__proto__", "constructor", "toString"])
    assert.throws(() => proposeAction({ action: name, targetResource: L[0] }), UnknownActionError, name);
  await assert.rejects(executeRegisteredTool("deleteListing", "{}", { conversationId: buyerConv, market: JO }), ToolRejectedError);
  // A tampered stored action name is not executable either.
  const proposal = proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: L[0], facts: { price: [{ value: "1", source: "USER_DECLARED" }] } });
  const review = await createPendingAction({ conversationId: sellerConv, actorId: seller.id, market: JO, proposal });
  const row = await setRow(review.actionId);
  await db.update(aiResultSets).set({ query: { ...row.query, action: "DROP_DATABASE" } }).where(eq(aiResultSets.id, review.actionId));
  const before = await priceOf(L[0]!);
  assert.equal((await confirmPendingAction({ actionId: review.actionId, actorId: seller.id, market: JO, decision: "CONFIRM" })).status, "REJECTED");
  assert.equal(await priceOf(L[0]!), before);
});

await test("summary", async () => {
  const ids = Object.keys(results).sort();
  console.log("BLOCKF0_SUMMARY", JSON.stringify({ passed: ids.filter((id) => results[id] === "PASS").length, total: ids.length, results, modelCalls: getModelGatewayCallCount() }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
