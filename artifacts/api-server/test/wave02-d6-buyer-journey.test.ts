/**
 * WAVE 02 / D6 — the buyer journey, end to end, in the canonical DINAR conversation.
 *
 * The buyer never gets a private runtime: every step below is the existing marketplace authority
 * reached through the authenticated conversation. Deterministic buyer turns must make zero model
 * calls, and each claim is checked against the rows the server wrote (result sets, cart lines,
 * orders, order items, checkout idempotency records and pending actions).
 *
 * Scenarios (mission list): the buyer searches several categories from their own words, narrows
 * with a follow-up, compares three actual offers, selects one, reviews the cart, checks out
 * through the server authority, reopens the conversation and sees the same state, refuses to buy
 * a stale price, and a replayed confirmation creates no second order. Model quality is not claimed
 * here: these are canonical services, not a mock of the model's understanding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  aiResultSets,
  cartItems,
  carts,
  checkoutRequests,
  db,
  markets,
  offers,
  orderItems,
  orders,
  paymentIntents,
  pool,
} from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { getMarketplaceCart } from "../src/lib/marketplace-cart";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE02_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

// Every outbound request that leaves loopback is recorded: the journey must stay inside DINAR.
const external: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) external.push(url.hostname);
  } catch {
    // Not a URL; not a network request.
  }
  return originalFetch(input, init);
}) as typeof fetch;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `203.0.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
const phoneBase = 51_695_000 + ((Date.now() + process.pid) % 4_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `W02B-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR W02 buyer ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

type Turn = { status: number; body: string; blocks: any[]; payload: any };
async function turn(actor: Actor, conversationId: string, message: string): Promise<Turn> {
  const before = getModelGatewayCallCount();
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `${message}: ${raw.slice(0, 400)}`);
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 500)}`);
  assert.equal(getModelGatewayCallCount() - before, 0, `a deterministic buyer turn never calls the model: ${message}`);
  const blocks = (complete.assistantMessage.blocks ?? []) as any[];
  return {
    status: response.status,
    body: complete.assistantMessage.body as string,
    blocks,
    payload: blocks[0]?.payload,
  };
}

async function publish(actor: Actor, spec: { title: string; price: string; quantity?: number; category: string; categoryId: string; attributes?: Record<string, unknown>; fulfilmentType?: "PICKUP" | "DELIVERY" | "SERVICE" }) {
  const created = await request("/listings", "POST", {
    title: spec.title,
    description: `${spec.title} — عرض اختبار الموجة الثانية للمشتري`,
    category: spec.category,
    categoryId: spec.categoryId,
    area: "خلدا",
    city: "عمان",
    attributes: spec.attributes ?? {},
    unitPrice: spec.price,
    inventoryMode: "LIMITED",
    availableQuantity: spec.quantity ?? 4,
    fulfilmentType: spec.fulfilmentType ?? "PICKUP",
    imageUrl: "",
    imageUrls: [],
  }, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
const ordinalOf = (ids: string[], id: string) => {
  const index = ids.indexOf(id);
  assert.ok(index >= 0 && index < ORDINALS.length, "the fixture is inside the searchable ordinal range");
  return ORDINALS[index]!;
};
const resultSetOf = async (id: string) => (await db.select().from(aiResultSets).where(eq(aiResultSets.id, id)))[0]!;
const listingOf = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const money = (minor: number, scale: number) => `${(minor / 10 ** scale).toFixed(scale)} JOD`;
const buyerOrders = async (actor: Actor) => db.select().from(orders).where(eq(orders.buyerId, actor.id));
const orderListings = async (orderId: string) =>
  (await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))).map((row) => row.offerId);

let sellers: Actor[] = [];
let JO: Awaited<ReturnType<typeof resolveMarket>>;
const T: Record<string, string> = {};

await test("setup: fresh sellers, resident buyers and one real listing in each of three categories", async () => {
  sellers = await Promise.all(["Seller A", "Seller B"].map(register));
  const [sellerA, sellerB] = sellers as [Actor, Actor];
  T.navy = await publish(sellerA, { title: `جاكيت شتوي بحري ${randomUUID().slice(0, 4)}`, price: "7", quantity: 6, category: "أزياء", categoryId: "fashion", attributes: { season: "شتوي" }, fulfilmentType: "DELIVERY" });
  T.grey = await publish(sellerA, { title: `جاكيت شتوي رمادي ${randomUUID().slice(0, 4)}`, price: "9", quantity: 5, category: "أزياء", categoryId: "fashion", attributes: { season: "شتوي" } });
  T.black = await publish(sellerB, { title: `جاكيت شتوي أسود ${randomUUID().slice(0, 4)}`, price: "11", quantity: 4, category: "أزياء", categoryId: "fashion", attributes: { season: "شتوي" } });
  T.car = await publish(sellerA, {
    title: "سيارة تويوتا كورولا 2020",
    price: "5000",
    quantity: 1,
    category: "سيارات",
    categoryId: "cars",
    // The canonical search intent maps «تويوتا»/«كورولا» to the stored Arabic make and model.
    attributes: { make: "تويوتا", model: "كورولا", year: 2020, condition: "مستعمل" },
  });
  T.lamp = await publish(sellerB, { title: "مصباح مكتبي قابل للتعديل", price: "12", quantity: 8, category: "منزل", categoryId: "home" });
  const [row] = await db.select().from(markets).where(eq(markets.id, "JO"));
  JO = await resolveMarket(row!);
});

await test("W02-D6: several categories are discovered from the buyer's own words", async () => {
  const buyer = await register("Categories");
  const fashionConversation = await conversation(buyer);
  const found = await turn(buyer, fashionConversation, "أريد جاكيت شتوي");
  const fashionIds = (await resultSetOf(found.payload.resultSetId)).resourceIds;
  assert.ok([T.navy!, T.grey!, T.black!].every((id) => fashionIds.includes(id)), found.body);
  const fashionSet = await resultSetOf(found.payload.resultSetId);
  assert.equal((fashionSet.query as any)?.categoryId ?? (fashionSet.query as any)?.buyer?.categoryId, "fashion");

  // A follow-up keeps the earlier category and narrows by what the buyer said.
  const cheapest = await turn(buyer, fashionConversation, "أرخص واحد");
  const cheapestIds = (await resultSetOf(cheapest.payload.resultSetId)).resourceIds;
  assert.equal(cheapestIds[0], T.navy, "the cheapest real jacket comes first");
  assert.equal((await listingOf(cheapestIds[0]!)).unitPriceMinor, (await listingOf(T.navy!)).unitPriceMinor);

  const carConversation = await conversation(buyer);
  const carFound = await turn(buyer, carConversation, "أريد سيارة تويوتا كورولا");
  const carIds = (await resultSetOf(carFound.payload.resultSetId)).resourceIds;
  assert.ok(carIds.includes(T.car!), carFound.body);
  const carSet = await resultSetOf(carFound.payload.resultSetId);
  assert.equal((carSet.query as any)?.categoryId ?? (carSet.query as any)?.buyer?.categoryId, "cars");
  const carListing = await listingOf(T.car!);
  assert.equal(carListing.inventoryMode, "LIMITED");
  assert.equal(carListing.availableQuantity, 1, "a vehicle stays a single-unit listing");

  const homeConversation = await conversation(buyer);
  const homeFound = await turn(buyer, homeConversation, "أريد مصباح مكتبي");
  const homeIds = (await resultSetOf(homeFound.payload.resultSetId)).resourceIds;
  assert.ok(homeIds.includes(T.lamp!), homeFound.body);
  const homeSet = await resultSetOf(homeFound.payload.resultSetId);
  assert.equal((homeSet.query as any)?.categoryId ?? (homeSet.query as any)?.buyer?.categoryId, "home");
  const homeRow = await listingOf(T.lamp!);
  assert.equal(homeRow.data.categoryId, "home");
  assert.equal(homeRow.status, "PUBLISHED");
});

await test("W02-D6: three actual offers are compared, one is selected, and history is grounded", async () => {
  const buyer = await register("Compare");
  const conv = await conversation(buyer);
  const found = await turn(buyer, conv, "أريد جاكيت شتوي");
  const firstSet = await resultSetOf(found.payload.resultSetId);
  assert.ok(firstSet.resourceIds.length >= 3, found.body);

  // A second search moves the view; «رجعني» restores the stored fashion result set.
  const carFound = await turn(buyer, conv, "أريد سيارة تويوتا كورولا");
  assert.ok((await resultSetOf(carFound.payload.resultSetId)).resourceIds.includes(T.car!));
  const restored = await turn(buyer, conv, "رجعني");
  const restoredSet = await resultSetOf(restored.payload.resultSetId);
  assert.deepEqual(restoredSet.resourceIds, firstSet.resourceIds, "the earlier result set is restored, not rebuilt");

  const [first, second, third] = restoredSet.resourceIds;
  const compared = await turn(buyer, conv, "قارن الأول والثاني والثالث");
  assert.equal(compared.payload.surface, "COMPARISON", compared.body);
  const comparison = compared.blocks.find((block) => block.payload?.comparison)?.payload.comparison;
  assert.ok(comparison, compared.body);
  assert.deepEqual(comparison.listings.map((listing: any) => listing.id), [first, second, third]);
  const priceRow = comparison.rows.find((row: any) => row.label === "السعر");
  const rows = await Promise.all([first!, second!, third!].map(listingOf));
  assert.deepEqual(priceRow.values, rows.map((row) => money(row.unitPriceMinor!, JO.minorUnitScale)), "prices come from the stored offers");
  assert.match(compared.body, /DINAR فقط/u);

  // Selection by position resolves against the stored set, never against a client claim.
  const selected = await turn(buyer, conv, "أبي الأول");
  assert.equal(selected.payload.surface, "PURCHASE_REVIEW", selected.body);
  assert.equal(selected.payload.purchaseReview.listingId, first);
  assert.equal(selected.payload.purchaseReview.stage, "ITEM");
  const firstRow = await listingOf(first!);
  assert.equal(selected.payload.purchaseReview.unitPrice, (firstRow.unitPriceMinor! / 10 ** JO.minorUnitScale).toFixed(JO.minorUnitScale));
  assert.equal((await buyerOrders(buyer)).length, 0, "selecting an offer creates nothing");

  const invented = await turn(buyer, conv, "أبي العاشر");
  assert.notEqual(invented.payload?.surface, "PURCHASE_REVIEW");
  assert.match(invented.body, /غير موجود/u);
  const inventedCompare = await turn(buyer, conv, "قارن الأول والعاشر");
  assert.notEqual(inventedCompare.payload?.surface, "COMPARISON");
  assert.equal((await buyerOrders(buyer)).length, 0);
});

await test("W02-D6: cart review, server-authoritative checkout and one replay-safe order", async () => {
  const buyer = await register("Cart");
  const conv = await conversation(buyer);
  const found = await turn(buyer, conv, "أريد جاكيت شتوي");
  const ids = (await resultSetOf(found.payload.resultSetId)).resourceIds;
  // Two real offers from the same seller: one order per seller, two line items.
  const pair = [T.navy!, T.grey!].sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
  const added = await turn(buyer, conv, `أضف ${ordinalOf(ids, pair[0]!)} و${ordinalOf(ids, pair[1]!)} للسلة`);
  assert.equal(added.payload.surface, "CART", added.body);
  const cart = await getMarketplaceCart(buyer.id, JO);
  assert.deepEqual(cart.map((line) => line.listingId).sort(), [...pair].sort());
  assert.ok(cart.every((line) => line.quantity === 1));
  assert.equal((await buyerOrders(buyer)).length, 0, "adding to the cart creates nothing");

  const checkout = await turn(buyer, conv, "أكمل");
  assert.equal(checkout.payload.surface, "CHECKOUT", checkout.body);
  assert.match(checkout.body, /راجع عناصر سلتك/u);

  // Reopening the conversation rebuilds the cart and checkout state from the server rows.
  const reloaded = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
  assert.equal(reloaded.status, 200, reloaded.raw);
  const reloadedBlocks = (reloaded.data.messages as any[]).flatMap((message) => message.blocks ?? []);
  assert.ok(reloadedBlocks.some((block) => block.payload?.surface === "CART"), "the cart card survives a reload");
  assert.ok(reloadedBlocks.some((block) => block.payload?.surface === "CHECKOUT"), "the checkout card survives a reload");
  assert.deepEqual((await getMarketplaceCart(buyer.id, JO)).map((line) => line.listingId).sort(), [...pair].sort());

  // The canonical checkout authority — the same path the web client posts to — decides the order.
  const [sellerA] = sellers as [Actor, Actor];
  const lines = await Promise.all(pair.map(async (listingId) => ({
    listingId,
    quantity: 1,
    fulfilmentType: (await listingOf(listingId)).data.fulfilmentType as "PICKUP" | "DELIVERY" | "SERVICE",
  })));
  const idempotencyKey = `w02-buyer-${randomUUID()}`;
  const placed = await request("/checkout", "POST", { items: lines, idempotencyKey }, buyer.cookie);
  assert.equal(placed.status, 201, placed.raw);
  assert.equal(placed.data.orders.length, 1, "both lines are from the same seller");
  const orderId = placed.data.orders[0].id as string;
  assert.equal(placed.data.currency, "JOD");
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.equal(order?.buyerId, buyer.id);
  assert.equal(order?.sellerId, sellerA.id);
  assert.equal(order?.status, "CREATED");
  assert.equal(order?.data.paymentMode, "TEST_NO_TRANSFER");
  assert.equal(order?.data.commissionRateBps, 1000);
  assert.equal(order?.quantity, 2, "the order carries both reviewed units");
  assert.equal(order?.subtotalMinor, (await listingOf(T.navy!)).unitPriceMinor! + (await listingOf(T.grey!)).unitPriceMinor!);
  assert.equal(order?.platformFeeMinor, Math.round(order!.subtotalMinor * 0.1));
  assert.deepEqual((await orderListings(orderId)).sort(), [...pair].sort(), "exactly the reviewed lines");
  assert.equal((await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, orderId))).length, 0, "nothing is paid");
  assert.equal((await getMarketplaceCart(buyer.id, JO)).length, 0, "the checked-out lines leave the cart");
  const firstPlaced = await buyerOrders(buyer);
  assert.equal(firstPlaced.length, 1);

  // The same reviewed action replayed returns the same order and writes nothing new.
  const replay = await request("/checkout", "POST", { items: lines, idempotencyKey }, buyer.cookie);
  assert.equal(replay.status, 201, replay.raw);
  assert.equal(replay.data.orders[0].id, orderId);
  assert.equal((await buyerOrders(buyer)).length, 1, "a replayed checkout creates no second order");
  assert.equal((await orderListings(orderId)).length, 2, "the line items are not duplicated");
  const recorded = await db.select().from(checkoutRequests).where(eq(checkoutRequests.idempotencyKey, idempotencyKey));
  assert.equal(recorded.length, 1, "one idempotency record");
  const [cartRow] = await db.select().from(carts).where(eq(carts.userId, buyer.id));
  assert.ok(cartRow, "the buyer's cart row still exists");
  assert.equal((await db.select().from(cartItems).where(eq(cartItems.cartId, cartRow.id))).length, 0);
});

await test("W02-D6: a stale price never becomes an order and the open review survives a reload", async () => {
  const buyer = await register("Stale");
  const conv = await conversation(buyer);
  const found = await turn(buyer, conv, "أريد جاكيت شتوي");
  const ids = (await resultSetOf(found.payload.resultSetId)).resourceIds;
  const target = T.black!;
  const selected = await turn(buyer, conv, `أبي ${ordinalOf(ids, target)}`);
  assert.equal(selected.payload.surface, "PURCHASE_REVIEW", selected.body);
  assert.equal(selected.payload.purchaseReview.listingId, target);
  const review = await turn(buyer, conv, "اطلبه الآن");
  assert.equal(review.payload.surface, "PURCHASE_REVIEW", review.body);
  assert.equal(review.payload.purchaseReview.stage, "ORDER");
  const pendingAction = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conv)))
    .find((set) => (set.query as any)?.action === "PLACE_ORDER" && (set.query as any)?.status === "PENDING");
  assert.ok(pendingAction, "the review is a stored pending action");

  // Reopening the conversation shows the same pending review, from the server rows.
  const reloaded = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
  assert.equal(reloaded.status, 200, reloaded.raw);
  const reloadedReviews = (reloaded.data.messages as any[])
    .flatMap((message) => message.blocks ?? [])
    .filter((block) => block.payload?.purchaseReview?.listingId === target)
    .map((block) => block.payload.purchaseReview);
  // The earlier item review stays in history with its settled server status; the open order
  // review is the one rebuilt as PENDING, both from the stored rows rather than client memory.
  assert.equal(
    reloadedReviews.find((review: any) => review.stage === "ITEM")?.status,
    "EXPIRED",
    "the replaced item review is shown with its settled status",
  );
  const reloadedReview = reloadedReviews.find((review: any) => review.stage === "ORDER");
  assert.ok(reloadedReview, "the review card survives a reload");
  assert.equal(reloadedReview.status, "PENDING");
  assert.equal(reloadedReview.stage, "ORDER");
  const restored = await db.select().from(aiResultSets).where(eq(aiResultSets.id, reloadedReview.actionId));
  assert.equal(restored.length, 1);

  // The seller changes the price before the buyer's «نعم»: the old instruction cannot buy.
  const before = await listingOf(target);
  await db.update(offers).set({ unitPriceMinor: before.unitPriceMinor! + 1_000, updatedAt: new Date() }).where(eq(offers.id, target));
  try {
    const refused = await turn(buyer, conv, "نعم");
    assert.equal((await buyerOrders(buyer)).length, 0, "no order at the stale price");
    assert.equal(refused.payload?.surface, "PURCHASE_REVIEW", refused.body);
    assert.match(refused.body, /تغير السعر/u);
    assert.equal(refused.payload.purchaseReview.unitPrice, ((before.unitPriceMinor! + 1_000) / 10 ** JO.minorUnitScale).toFixed(JO.minorUnitScale));
    const [oldAction] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, pendingAction!.id));
    assert.equal((oldAction?.query as any)?.status, "SUPERSEDED", "the stale confirmation is void");
    assert.doesNotMatch(refused.body, /تم إنشاء الطلب/u);

    // The fresh review is the one that can be confirmed, once.
    const placed = await turn(buyer, conv, "نعم");
    assert.match(placed.body, /تم إنشاء الطلب/u, placed.body);
    const created = await buyerOrders(buyer);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.unitPriceMinor, before.unitPriceMinor! + 1_000, "ordered at the freshly confirmed price");
    assert.deepEqual(await orderListings(created[0]!.id), [target]);
    const again = await turn(buyer, conv, "نعم");
    assert.equal((await buyerOrders(buyer)).length, 1, "a replayed confirmation has one effect");
    assert.doesNotMatch(again.body, /تم إنشاء الطلب/u);
  } finally {
    await db.update(offers).set({ unitPriceMinor: before.unitPriceMinor!, updatedAt: new Date() }).where(eq(offers.id, target));
  }
});

await test("summary", async () => {
  // Another buyer's actions and another market's rows are never reachable from this buyer's view.
  const outsider = await register("Outsider");
  const cart = await getMarketplaceCart(outsider.id, JO);
  assert.equal(cart.length, 0, "a fresh buyer has an empty cart");
  const outsiderOrders = await buyerOrders(outsider);
  assert.equal(outsiderOrders.length, 0);
  const foreign = (await db.select().from(checkoutRequests)).filter((row) => row.userId === outsider.id);
  assert.equal(foreign.length, 0);
  assert.equal(external.length, 0, `outbound requests: ${external.join(",")}`);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
});
