import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import app from "../src/app";
import {
  aiResultSets,
  aiUiBlocks,
  checkoutRequests,
  db,
  markets,
  offers,
  orderFulfillments,
  orderItems,
  orders,
  paymentIntents,
  pool,
  transactionLocations,
  users,
} from "@workspace/db";
import { confirmPendingAction, conversationContext } from "../src/ai/action-foundation";
import { normalizeBuyerText, reviewQuantity } from "../src/ai/buyer-turn";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { resolveMarket } from "../src/lib/markets";
import { checkoutForActor } from "../src/routes/marketplace";
import { createTestPaymentIntent } from "../src/routes/payments";
import {
  addMarketplaceCartItem,
  getMarketplaceCart,
} from "../src/lib/marketplace-cart";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

// Every outbound request that leaves loopback is recorded: F3 must stay inside DINAR.
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
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.30.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
const phoneBase = 51_400_000 + ((Date.now() + process.pid) % 200_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `BlockF3-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR F3 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

type Turn = { status: number; body: string; payload: any };
const modelCalls: number[] = [];
async function turn(actor: Actor, conversationId: string, message: string, extra: Record<string, unknown> = {}): Promise<Turn> {
  const before = getModelGatewayCallCount();
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message, ...extra }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  modelCalls.push(getModelGatewayCallCount() - before);
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  return { status: response.status, body: complete.assistantMessage.body, payload: complete.assistantMessage.blocks[0]?.payload };
}

async function publish(seller: Actor, title: string, price: string, fulfilmentType: "PICKUP" | "DELIVERY", quantity = 3) {
  const created = await request("/listings", "POST", {
    title,
    description: `${title} — قطن مريح وخياطة متينة للاختبار`,
    category: "أزياء", categoryId: "fashion", area: "خلدا", city: "عمان",
    attributes: { condition: "جديد" },
    unitPrice: price, inventoryMode: "LIMITED", availableQuantity: quantity, fulfilmentType, imageUrl: "", imageUrls: [],
    paymentMethods: ["CASH_DIRECT", "CARD"],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

async function publishSingleVehicle(seller: Actor) {
  const created = await request("/listings", "POST", {
    title: "تويوتا برادو سيارة وحدة للاختبار",
    description: "سيارة مستعملة بحالة جيدة — عرض اختبار المخزون الفردي",
    category: "سيارات", categoryId: "cars", area: "خلدا", city: "عمان",
    attributes: { make: "Toyota", model: "Corolla", year: 2020, condition: "مستعمل" },
    unitPrice: "5000", inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const results: Record<string, "PASS" | "FAIL"> = {};
async function focused(id: string, name: string, body: () => Promise<void>) {
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

// False-success accounting: a success phrase must always be backed by a new authoritative row.
let falseOrderSuccess = 0;
let falsePaymentSuccess = 0;
const ORDER_SUCCESS = /تم إنشاء الطلب|تم الشراء/;
const PAYMENT_SUCCESS = /تم الدفع|طلب دفع تجريبي لطلب/;
const buyerOrders = async (actor: Actor) => db.select().from(orders).where(eq(orders.buyerId, actor.id));
const intentsFor = async (orderId: string) => db.select().from(paymentIntents).where(eq(paymentIntents.orderId, orderId));
/** Runs a decision turn and checks every success claim against the authorities' rows. */
async function decide(actor: Actor, conversationId: string, message: string, extra: Record<string, unknown> = {}) {
  const ordersBefore = (await buyerOrders(actor)).length;
  const intentsBefore = (await db.select().from(paymentIntents).where(eq(paymentIntents.buyerId, actor.id))).length;
  const result = await turn(actor, conversationId, message, extra);
  const ordersAfter = (await buyerOrders(actor)).length;
  const intentsAfter = (await db.select().from(paymentIntents).where(eq(paymentIntents.buyerId, actor.id))).length;
  if (ORDER_SUCCESS.test(result.body) && ordersAfter !== ordersBefore + 1) falseOrderSuccess++;
  if (PAYMENT_SUCCESS.test(result.body) && intentsAfter !== intentsBefore + 1) falsePaymentSuccess++;
  if (/تم الدفع/.test(result.body)) falsePaymentSuccess++; // nothing here is ever captured
  return { ...result, newOrders: ordersAfter - ordersBefore, newIntents: intentsAfter - intentsBefore };
}

let seller: Actor;
let otherSeller: Actor;
let buyer: Actor;
let cartBuyer: Actor;
let singleBuyer: Actor;
const T: Record<string, string> = {};
let JO: Awaited<ReturnType<typeof resolveMarket>>;
const newConversation = async (actor = buyer) => (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id as string;
const setRow = async (id: string) => (await db.select().from(aiResultSets).where(eq(aiResultSets.id, id)))[0]!;
const offerRow = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const reset = async (id: string, values: Partial<typeof offers.$inferInsert>) => db.update(offers).set({ ...values, updatedAt: new Date() }).where(eq(offers.id, id));

/** A fresh conversation with the Nike list; returns the stable ids by position. */
async function listed(): Promise<{ conv: string; ids: string[] }> {
  const conv = await newConversation();
  const found = await turn(buyer, conv, "أريد تيشرت نايكي بسعر 5");
  const ids = (await setRow(found.payload.resultSetId)).resourceIds;
  assert.ok(ids.length >= 3, found.body);
  return { conv, ids };
}
const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
/** The words for a listing's position in the persisted list (no assumption about other rows). */
const positionOf = (ids: string[], id: string) => {
  const index = ids.indexOf(id);
  assert.ok(index >= 0, "fixture listing is in the result set");
  return index < ORDINALS.length ? ORDINALS[index]! : `رقم ${index + 1}`;
};
/** Opens an ORDER-stage review for one fixture listing, selected by its position. */
async function orderReview(key: keyof typeof T & string, extra?: string) {
  const { conv, ids } = await listed();
  const item = await turn(buyer, conv, `أبي ${positionOf(ids, T[key]!)}`);
  assert.equal(item.payload.surface, "PURCHASE_REVIEW", item.body);
  const review = await turn(buyer, conv, extra ?? "اطلبه الآن");
  assert.equal(review.payload.purchaseReview.stage, "ORDER", review.body);
  return { conv, ids, review };
}

await test("setup: fresh sellers, buyer and DINAR fashion listings", async () => {
  [seller, otherSeller, buyer, cartBuyer, singleBuyer] = await Promise.all(["Seller", "Other Seller", "Buyer", "Cart Buyer", "Single Cart Buyer"].map(register));
  T.del5 = await publish(seller, "تيشيرت نايكي أسود", "5", "DELIVERY", 20);
  T.pick6 = await publish(seller, "تيشيرت نايكي أبيض", "6", "PICKUP");
  T.del8 = await publish(otherSeller, "تيشيرت نايكي رمادي", "8", "DELIVERY");
  T.single = await publishSingleVehicle(seller);
  const [row] = await db.select().from(markets).where(eq(markets.id, "JO"));
  JO = await resolveMarket(row!);
});

await focused("B2/B4/B5", "chat adds one result, updates its quantity and removes it through the canonical cart", async () => {
  const conv = await newConversation(cartBuyer);
  const found = await turn(cartBuyer, conv, "أريد تيشرت نايكي بسعر 5");
  const ids = (await setRow(found.payload.resultSetId)).resourceIds;
  assert.ok(ids.length >= 1, found.body);
  const added = await turn(cartBuyer, conv, "أضف الأول إلى السلة");
  assert.equal(added.payload.surface, "CART");
  let cart = await getMarketplaceCart(cartBuyer.id, JO);
  assert.equal(cart.length, 1);
  assert.equal(cart[0]!.listingId, ids[0]);

  const changed = await turn(cartBuyer, conv, "غير كمية الأول إلى 2");
  assert.equal(changed.payload.surface, "CART");
  cart = await getMarketplaceCart(cartBuyer.id, JO);
  assert.equal(cart[0]!.quantity, 2);

  const removed = await turn(cartBuyer, conv, "شيله");
  assert.equal(removed.payload.surface, "CART");
  assert.equal((await getMarketplaceCart(cartBuyer.id, JO)).length, 0);
});

await focused("B3/B6", "multi-item chat add is all-or-nothing when one selected result is out of stock", async () => {
  const conv = await newConversation(cartBuyer);
  const found = await turn(cartBuyer, conv, "أريد تيشرت نايكي بسعر 5");
  const ids = (await setRow(found.payload.resultSetId)).resourceIds;
  assert.ok(ids.length >= 3, found.body);
  const unavailable = await offerRow(ids[2]!);
  await reset(ids[2]!, {
    availableQuantity: unavailable.availableQuantity,
    reservedQuantity: unavailable.availableQuantity,
  });
  try {
    const result = await turn(cartBuyer, conv, "أضف الأول والثالث للسلة");
    assert.equal(result.payload.surface, "CART");
    assert.match(result.body, /لم تُضف أي عناصر/);
    assert.equal((await getMarketplaceCart(cartBuyer.id, JO)).length, 0);
  } finally {
    await reset(ids[2]!, {
      availableQuantity: unavailable.availableQuantity,
      reservedQuantity: unavailable.reservedQuantity,
    });
  }
  const added = await turn(cartBuyer, conv, "أضف الأول والثاني للسلة");
  assert.equal(added.payload.surface, "CART");
  const cartIds = (await getMarketplaceCart(cartBuyer.id, JO))
    .map((item) => item.listingId)
    .sort();
  assert.deepEqual(cartIds, ids.slice(0, 2).sort());
});

await focused("B7", "a SINGLE-semantics listing cannot be raised above one cart item", async () => {
  const conv = await newConversation(singleBuyer);
  await addMarketplaceCartItem({
    userId: singleBuyer.id,
    expectedMarketId: "JO",
    listingId: T.single!,
    quantity: 1,
  });
  const opened = await turn(singleBuyer, conv, "افتح السلة");
  assert.equal(opened.payload.surface, "CART");
  const changed = await turn(singleBuyer, conv, "غير كمية الأول إلى 2");
  assert.match(changed.body, /مخصص لوحدة واحدة/);
  const cart = await getMarketplaceCart(singleBuyer.id, JO);
  assert.equal(cart.length, 1);
  assert.equal(cart[0]!.quantity, 1);
});

await focused("F3-01", "stable result selection → purchase review; nothing is created", async () => {
  const { conv, ids } = await listed();
  const review = await turn(buyer, conv, "أبي الثاني");
  assert.equal(review.payload.surface, "PURCHASE_REVIEW");
  assert.equal(review.payload.purchaseReview.listingId, ids[1], "the persisted result set decides the target");
  assert.equal(review.payload.purchaseReview.stage, "ITEM");
  assert.deepEqual(review.payload.purchaseReview.actions, ["CONTINUE", "CHANGE_QUANTITY", "BACK", "CANCEL"]);
  const order = await turn(buyer, conv, "اطلبه الآن");
  assert.equal(order.payload.surface, "PURCHASE_REVIEW");
  assert.equal(order.payload.purchaseReview.stage, "ORDER");
  assert.equal(order.payload.purchaseReview.listingId, ids[1]);
  const listing = await offerRow(ids[1]!);
  assert.equal(order.payload.purchaseReview.unitPrice, (listing.unitPriceMinor! / 1000).toFixed(3), "price re-read from the listing");
  assert.equal((await buyerOrders(buyer)).length, 0, "no order before confirmation");
  // «خذ هذا»/«أبي الثالث» resolve the same way; an invented position does not.
  const missing = await turn(buyer, conv, "أبي العاشر");
  assert.notEqual(missing.payload?.surface, "PURCHASE_REVIEW");
});

await focused("F3-02", "quantity binds to the open review; ordinals are never quantities", async () => {
  const { conv } = await orderReview("del5");
  const two = await turn(buyer, conv, "أبي اثنين");
  assert.equal(two.payload.purchaseReview.quantity, 2);
  assert.equal(two.payload.purchaseReview.total, "10.000");
  assert.equal(two.payload.purchaseReview.stage, "ORDER", "the stage is kept");
  assert.equal((await turn(buyer, conv, "خله 3")).payload.purchaseReview.quantity, 3);
  assert.equal((await turn(buyer, conv, "قطعة واحدة فقط")).payload.purchaseReview.quantity, 1);
  const tooMany = await turn(buyer, conv, "غير الكمية إلى 50");
  assert.match(tooMany.body, /المتوفر الآن 20 فقط/);
  assert.equal(tooMany.payload.purchaseReview.quantity, 1, "server inventory bounds the quantity");
  for (const [phrase, expected] of [["أبي اثنين", 2], ["خله 3", 3], ["قطعة واحدة فقط", 1], ["قطعتين", 2], ["الثاني", undefined], ["أبي الثالث", undefined], ["بسعر 5", undefined]] as const)
    assert.equal(reviewQuantity(normalizeBuyerText(phrase)), expected, phrase);
  assert.equal((await buyerOrders(buyer)).length, 0);
});

await focused("F3-03", "a price change after review voids the old «نعم» and shows the new price", async () => {
  const { conv } = await orderReview("del5");
  const target = T.del5!;
  const actionId = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conv))).find((set) => (set.query as any).action === "PLACE_ORDER" && (set.query as any).status === "PENDING")!.id;
  await reset(target, { unitPriceMinor: 7_000 });
  const refreshed = await decide(buyer, conv, "نعم");
  assert.equal(refreshed.newOrders, 0, "no order at the stale price");
  assert.equal(refreshed.payload.surface, "PURCHASE_REVIEW");
  assert.match(refreshed.body, /تغير السعر من 5\.000 JOD إلى 7\.000 JOD/);
  assert.equal(refreshed.payload.purchaseReview.unitPrice, "7.000");
  assert.equal((await setRow(actionId)).query.status, "SUPERSEDED");
  try {
    const placed = await decide(buyer, conv, "نعم");
    assert.equal(placed.newOrders, 1, placed.body);
    const [order] = (await buyerOrders(buyer)).filter((row) => row.data.listingId === target);
    assert.equal(order!.unitPriceMinor, 7_000, "ordered at the freshly confirmed price");
  } finally {
    await reset(target, { unitPriceMinor: 5_000 });
  }
});

await focused("F3-04", "stock that disappears or shrinks never becomes an order", async () => {
  const { conv } = await orderReview("del8");
  const target = T.del8!;
  await turn(buyer, conv, "أبي اثنين");
  const row = await offerRow(target);
  try {
    await reset(target, { availableQuantity: row.reservedQuantity });
    const gone = await decide(buyer, conv, "نعم");
    assert.equal(gone.newOrders, 0);
    assert.match(gone.body, /المنتج لم يعد متوفرًا/);
    // Fewer than asked: the current valid quantity is shown and needs a new decision.
    await reset(target, { availableQuantity: row.availableQuantity });
    const again = await orderReview("del8");
    await turn(buyer, again.conv, "أبي اثنين");
    await reset(target, { availableQuantity: row.reservedQuantity + 1 });
    const fewer = await decide(buyer, again.conv, "نعم");
    assert.equal(fewer.newOrders, 0);
    assert.match(fewer.body, /المتوفر الآن 1 فقط/);
    assert.equal(fewer.payload.purchaseReview.quantity, 1);
    assert.equal(fewer.payload.purchaseReview.status, "PENDING", "a fresh review, not an execution");
    await turn(buyer, again.conv, "إلغاء");
  } finally {
    await reset(target, { availableQuantity: row.availableQuantity });
  }
});

await focused("F3-05", "a listing that becomes unavailable cannot be ordered from an old review", async () => {
  for (const status of ["PAUSED", "ARCHIVED", "SOLD_OUT", "MODERATION_HIDDEN", "MODERATION_REMOVED"]) {
    const { conv } = await orderReview("del5");
    try {
      await reset(T.del5!, { status });
      const blocked = await decide(buyer, conv, "نعم");
      assert.equal(blocked.newOrders, 0, status);
      assert.match(blocked.body, /غير متاح|موقوف|لم يتغير شيء/, status);
    } finally {
      await reset(T.del5!, { status: "PUBLISHED" });
    }
  }
  // A seller account that can no longer sell is caught by the checkout authority itself.
  const { conv } = await orderReview("del5");
  try {
    await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, seller.id));
    const injected = await decide(buyer, conv, "نعم");
    assert.equal(injected.newOrders, 0);
    assert.doesNotMatch(injected.body, ORDER_SUCCESS);
    assert.match(injected.body, /البائع غير متاح/);
  } finally {
    await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, seller.id));
  }
});

await focused("F3-06", "repeated and concurrent confirmation creates one canonical order", async () => {
  const { conv } = await orderReview("del5");
  const actionId = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conv))).find((set) => (set.query as any).action === "PLACE_ORDER" && (set.query as any).status === "PENDING")!.id;
  const before = (await buyerOrders(buyer)).length;
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => confirmPendingAction({ actionId, actorId: buyer.id, market: JO, decision: "CONFIRM" })));
  assert.equal(outcomes.filter((outcome) => outcome.status === "CONFIRMED").length, 1, JSON.stringify(outcomes.map((o) => o.status)));
  const orderId = String((outcomes.find((outcome) => outcome.status === "CONFIRMED") as any).result.orderId);
  assert.equal((await confirmPendingAction({ actionId, actorId: buyer.id, market: JO, decision: "CONFIRM" })).status, "CONFIRMED", "a retry reports the settled state");
  // A network retry of the same checkout key returns the same order.
  const retried = await checkoutForActor(buyer.id, [{ listingId: T.del5!, quantity: 1, fulfilmentType: "DELIVERY" }], `dinar-f3-order-${actionId}`);
  assert.equal(retried.orders[0]!.id, orderId);
  assert.equal((await buyerOrders(buyer)).length, before + 1, "exactly one business order");
  // Indistinguishable from the canonical path: same rows, same economics.
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.equal(order!.status, "CREATED");
  assert.equal(order!.buyerId, buyer.id);
  assert.equal(order!.sellerId, seller.id);
  assert.equal(order!.data.commissionRateBps, 1000);
  assert.equal(order!.platformFeeMinor, Math.round(order!.subtotalMinor * 0.1));
  assert.equal(order!.data.paymentMode, "TEST_NO_TRANSFER");
  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  assert.equal(lines.length, 1);
  await assert.rejects(db.insert(orders).values({ ...order!, id: randomUUID() }));
  await assert.rejects(
    db.insert(orders).values({
      ...order!,
      id: randomUUID(),
      orderLineIntegrityVersion: 0,
    }),
    "new orders cannot opt out of line integrity",
  );
  await assert.rejects(db.insert(orderItems).values({ ...lines[0]!, id: randomUUID() }));
  await assert.rejects(
    db.update(orderItems)
      .set({ data: { ...lines[0]!.data, listingTitle: "تغيير غير مسموح" } })
      .where(eq(orderItems.id, lines[0]!.id)),
  );
  await assert.rejects(
    db.update(orders)
      .set({ data: { ...order!.data, items: [] } })
      .where(eq(orders.id, orderId)),
  );
  assert.equal((await db.select().from(checkoutRequests).where(and(eq(checkoutRequests.userId, buyer.id), eq(checkoutRequests.idempotencyKey, `dinar-f3-order-${actionId}`)))).length, 1);
});

let deliveryConv = "";
let deliveryOrderId = "";
await focused("F3-07", "fulfilment comes from Block D: only real methods, selection is server-backed", async () => {
  // PICKUP-only listing: delivery is refused with the real option, never invented.
  const pick = await orderReview("pick6");
  assert.equal(pick.review.payload.purchaseReview.listingId, T.pick6);
  const refused = await turn(buyer, pick.conv, "وصله لي");
  assert.match(refused.body, /البائع لا يوصل هذا العرض/);
  assert.equal(refused.payload.purchaseReview.fulfilment, null);
  assert.deepEqual(refused.payload.purchaseReview.fulfilmentOptions.map((option: any) => option.method), ["PICKUP"]);
  const pickup = await turn(buyer, pick.conv, "أستلمه بنفسي");
  assert.equal(pickup.payload.purchaseReview.fulfilment, "PICKUP");
  await turn(buyer, pick.conv, "إلغاء");
  // Delivery listing: the journey from search to a delivery order.
  const { conv, ids } = await listed();
  deliveryConv = conv;
  assert.equal((await turn(buyer, conv, `أبي ${positionOf(ids, T.del5!)}`)).payload.purchaseReview.listingId, T.del5);
  assert.equal((await turn(buyer, conv, "أبي اثنين")).payload.purchaseReview.quantity, 2);
  const delivery = await turn(buyer, conv, "وصله لي");
  assert.equal(delivery.payload.purchaseReview.stage, "ORDER");
  assert.equal(delivery.payload.purchaseReview.fulfilment, "SELLER_DELIVERY");
  assert.ok(delivery.payload.purchaseReview.fulfilmentOptions.every((option: any) => ["PICKUP", "SELLER_DELIVERY"].includes(option.method)), "no courier or DINAR driver");
  assert.equal(delivery.payload.purchaseReview.quantity, 2, "quantity is not asked again");
  const early = await turn(buyer, conv, "أرسل موقعي");
  assert.match(early.body, /أكّد الطلب أولًا/);
  assert.equal((await buyerOrders(buyer)).filter((row) => row.data.listingId === T.del5 && row.quantity === 2).length, 0);
  const placed = await decide(buyer, conv, "نعم");
  assert.equal(placed.newOrders, 1, placed.body);
  assert.equal(placed.payload.surface, "ORDER");
  deliveryOrderId = placed.payload.resourceId;
  const [fulfilment] = await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, deliveryOrderId));
  assert.equal(fulfilment!.method, "SELLER_DELIVERY");
  assert.equal(fulfilment!.status, "REQUESTED");
  assert.equal(fulfilment!.selectedBy, buyer.id);
  assert.match(placed.body, /توصيل من البائع/);
});

await focused("F3-08", "«أرسل موقعي» uses the Block D one-time location flow", async () => {
  const requested = await turn(buyer, deliveryConv, "أرسل موقعي");
  assert.equal(requested.payload.surface, "LOCATION_PERMISSION_REQUEST", requested.body);
  assert.equal(requested.payload.resourceId, deliveryOrderId);
  const reading = { latitude: 31.951234, longitude: 35.912345, accuracyMeters: 15 };
  const preview = await turn(buyer, deliveryConv, "مشاركة موقعي الحالي", { location: { source: "DEVICE", ...reading }, locationRequestId: requested.payload.resultSetId });
  assert.equal(preview.payload.surface, "LOCATION_PREVIEW", preview.body);
  assert.equal((await db.select().from(transactionLocations).where(eq(transactionLocations.orderId, deliveryOrderId))).length, 0, "nothing stored before confirmation");
  const confirmed = await turn(buyer, deliveryConv, "نعم");
  assert.equal(confirmed.payload.surface, "LOCATION_CONFIRMED", confirmed.body);
  const stored = await db.select().from(transactionLocations).where(eq(transactionLocations.orderId, deliveryOrderId));
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.purpose, "DELIVERY_DESTINATION");
  // Privacy: the reading lives only on the order; never in conversation rows or listing views.
  const blocks = await db.select().from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, deliveryConv));
  const sets = await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, deliveryConv));
  assert.equal(JSON.stringify([blocks, sets]).includes(String(reading.latitude)), false);
  assert.equal((await request(`/listings/${T.del5}`)).raw.includes(String(reading.latitude)), false);
  // No live tracking anywhere in the F3 code.
  for (const file of ["src/ai/buyer-turn.ts", "src/ai/action-foundation.ts", "../dinar/src/features/ai/BuyerPanels.tsx"])
    assert.doesNotMatch(readFileSync(file, "utf8"), /watchPosition|getCurrentPosition|BackgroundGeolocation/);
});

await focused("F3-09", "«ادفع» → PAYMENT_REVIEW → Wave 4 TEST_NO_TRANSFER intent; never «paid»", async () => {
  const review = await decide(buyer, deliveryConv, "ادفع");
  assert.equal(review.payload.surface, "PAYMENT_REVIEW", review.body);
  assert.equal(review.newIntents, 0, "a review creates nothing");
  const [order] = await db.select().from(orders).where(eq(orders.id, deliveryOrderId));
  const pay = review.payload.purchaseReview;
  assert.equal(pay.stage, "PAYMENT");
  assert.equal(pay.total, (order!.subtotalMinor / 1000).toFixed(3), "total from the order, not the client");
  assert.equal(pay.quantity, 2);
  assert.equal(pay.fulfilment, "توصيل من البائع");
  assert.equal(pay.paymentMode, "SIMULATION_ONLY");
  const cardChoice = await decide(buyer, deliveryConv, "فيزا");
  assert.equal(cardChoice.newIntents, 0, "choosing a method is not payment");
  assert.equal(cardChoice.payload.purchaseReview.selectedPaymentMethod, "CARD");
  const created = await decide(buyer, deliveryConv, "نعم");
  assert.equal(created.newIntents, 1, created.body);
  assert.match(created.body, /SIMULATION_ONLY/);
  assert.match(created.body, /لم تُحوَّل أي أموال/);
  const [intent] = await intentsFor(deliveryOrderId);
  assert.equal(intent!.status, "SIMULATION_PENDING");
  assert.equal(intent!.mode, "SIMULATION_ONLY");
  assert.equal(intent!.providerKey, "TEST_ADAPTER");
  assert.equal(intent!.amountMinor, order!.subtotalMinor);
  assert.equal(intent!.capturedAmountMinor, 0, "nothing captured by the conversation");
  assert.equal((await db.select().from(orders).where(eq(orders.id, deliveryOrderId)))[0]!.status, "CREATED", "the order is not marked paid");
  const twice = await decide(buyer, deliveryConv, "ادفع");
  assert.match(twice.body, /بدأ دفع هذا الطلب من قبل/);
  assert.equal((await intentsFor(deliveryOrderId)).length, 1);

  // Stale payment review: the order changes validly before «نعم».
  const fresh = await orderReview("del5");
  const placed = await decide(buyer, fresh.conv, "نعم");
  const orderId = placed.payload.resourceId as string;
  await turn(buyer, fresh.conv, "ادفع");
  const staleCardChoice = await turn(buyer, fresh.conv, "فيزا");
  assert.equal(staleCardChoice.payload.purchaseReview.selectedPaymentMethod, "CARD");
  await db.update(orders).set({ reservationExpiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() }).where(eq(orders.id, orderId));
  const stale = await decide(buyer, fresh.conv, "نعم");
  assert.equal(stale.newIntents, 0);
  assert.equal(stale.payload.surface, "PAYMENT_REVIEW");
  assert.match(stale.body, /لم يُنفذ التأكيد القديم/);
  // The payment state changes elsewhere before «نعم»: the old instruction does not run.
  await createTestPaymentIntent({ buyerId: buyer.id, orderId, idempotencyKey: `elsewhere-${randomUUID()}` });
  const elsewhere = await decide(buyer, fresh.conv, "نعم");
  assert.equal(elsewhere.newIntents, 0);
  assert.match(elsewhere.body, /تعذر إتمام الدفع/);
  assert.equal((await intentsFor(orderId)).length, 1);

  // Injected failure: the payment authority is unavailable.
  const third = await orderReview("del5");
  await decide(buyer, third.conv, "نعم");
  const saved = process.env.BDINAR_WAVE4_ACCEPTANCE;
  process.env.BDINAR_WAVE4_ACCEPTANCE = "off";
  const unavailable = await decide(buyer, third.conv, "ادفع");
  process.env.BDINAR_WAVE4_ACCEPTANCE = saved;
  assert.match(unavailable.body, /تعذر إتمام الدفع/);
  assert.equal(unavailable.newIntents, 0);
});

await focused("F3-10", "client claims of payment, price, total, parties or commission are ignored", async () => {
  const { conv } = await orderReview("del5");
  const tampered = await decide(buyer, conv, "نعم", {
    paid: true, paymentSucceeded: true, total: 1, price: 1, sellerId: otherSeller.id, buyerId: otherSeller.id, commissionBps: 0, paymentStatus: "SUCCESS",
  });
  assert.equal(tampered.newOrders, 1, tampered.body);
  const orderId = tampered.payload.resourceId as string;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  const listing = await offerRow(T.del5!);
  assert.equal(order!.buyerId, buyer.id);
  assert.equal(order!.sellerId, listing.sellerId);
  assert.equal(order!.unitPriceMinor, listing.unitPriceMinor);
  assert.equal(order!.data.commissionRateBps, 1000);
  assert.equal(order!.status, "CREATED");
  // The payment authority accepts only the order id; amount and status come from the order.
  const forged = await request("/payments/intents", "POST", { orderId, amountMinor: 1, status: "CAPTURED", paid: true }, buyer.cookie);
  assert.equal(forged.status, 400);
  const review = await decide(buyer, conv, "ادفع", { total: 1, amountMinor: 1, paymentStatus: "SUCCESS" });
  assert.equal(review.payload.purchaseReview.total, (order!.subtotalMinor / 1000).toFixed(3));
  const cardChoice = await decide(buyer, conv, "فيزا");
  assert.equal(cardChoice.newIntents, 0, "choosing a method is not payment");
  assert.equal(cardChoice.payload.purchaseReview.selectedPaymentMethod, "CARD");
  const created = await decide(buyer, conv, "نعم", { paid: true, captured: true, paymentStatus: "SUCCESS", amountMinor: 1 });
  const [intent] = await intentsFor(orderId);
  assert.equal(created.newIntents, 1);
  assert.equal(intent!.amountMinor, order!.subtotalMinor);
  assert.equal(intent!.status, "SIMULATION_PENDING");
  assert.equal(intent!.capturedAmountMinor, 0);
  // Another buyer can never confirm this buyer's staged actions.
  const staged = await orderReview("del5");
  const actionId = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, staged.conv))).find((set) => (set.query as any).action === "PLACE_ORDER" && (set.query as any).status === "PENDING")!.id;
  const foreign = await confirmPendingAction({ actionId, actorId: otherSeller.id, market: JO, decision: "CONFIRM" }).catch((error) => error);
  assert.equal(foreign.status, 404);
  await turn(buyer, staged.conv, "إلغاء");
});

await focused("F3-11", "cancelled, backed-out or abandoned steps never execute from a later «نعم»", async () => {
  for (const exit of ["ألغ", "رجوع", "غيرت رأيي"]) {
    const { conv } = await orderReview("del5");
    const left = await turn(buyer, conv, exit);
    assert.match(left.body, /لم يُنشأ طلب/, exit);
    const late = await decide(buyer, conv, "نعم");
    assert.equal(late.newOrders, 0, exit);
    assert.doesNotMatch(late.body, ORDER_SUCCESS);
  }
  // Changing topic expires the review (F0 stale-confirmation authority).
  const { conv } = await orderReview("del5");
  const actionId = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conv))).find((set) => (set.query as any).action === "PLACE_ORDER" && (set.query as any).status === "PENDING")!.id;
  await turn(buyer, conv, "أريد تيشرت نايكي بسعر 8");
  const late = await decide(buyer, conv, "نعم");
  assert.equal(late.newOrders, 0);
  assert.equal((await confirmPendingAction({ actionId, actorId: buyer.id, market: JO, decision: "CONFIRM" })).status, "EXPIRED");
  // Cancelling a payment review cancels only the staged payment, not the order.
  const fresh = await orderReview("del5");
  const placed = await decide(buyer, fresh.conv, "نعم");
  await turn(buyer, fresh.conv, "ادفع");
  const cancelled = await turn(buyer, fresh.conv, "ألغ");
  assert.match(cancelled.body, /الطلب نفسه باقٍ/);
  const after = await decide(buyer, fresh.conv, "نعم");
  assert.equal(after.newIntents, 0);
  assert.equal((await db.select().from(orders).where(eq(orders.id, placed.payload.resourceId)))[0]!.status, "CREATED");
});

await focused("F3-12", "reload restores purchase, fulfilment and payment state from server rows", async () => {
  const history = await request(`/ai/conversations/${deliveryConv}`, "GET", undefined, buyer.cookie);
  assert.equal(history.status, 200);
  const blocks = history.data.messages.flatMap((message: any) => message.blocks);
  const reviews = blocks.filter((block: any) => block.payload.purchaseReview);
  assert.ok(reviews.some((block: any) => block.payload.purchaseReview.stage === "ORDER" && block.payload.purchaseReview.status === "CONFIRMED"), "confirmed order review");
  assert.ok(reviews.some((block: any) => block.payload.surface === "PAYMENT_REVIEW" && block.payload.purchaseReview.status === "CONFIRMED"), "confirmed payment review");
  assert.ok(reviews.some((block: any) => block.payload.purchaseReview.status === "EXPIRED"), "superseded reviews show as expired");
  assert.ok(blocks.some((block: any) => block.payload.surface === "LOCATION_CONFIRMED"));
  // An open review survives a reload and still confirms from server state alone.
  const { conv } = await orderReview("del5", "وصله لي");
  const reloaded = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
  const open = reloaded.data.messages.flatMap((message: any) => message.blocks).find((block: any) => block.payload.purchaseReview?.status === "PENDING");
  assert.equal(open.payload.purchaseReview.fulfilment, "SELLER_DELIVERY");
  const context = await conversationContext({ conversationId: conv, actorId: buyer.id, market: JO });
  assert.equal(context.pendingAction?.action, "PLACE_ORDER");
  assert.equal(context.knownFacts.fulfilment?.value, "SELLER_DELIVERY");
  const placed = await decide(buyer, conv, "نعم");
  assert.equal(placed.newOrders, 1);
  const payment = await turn(buyer, conv, "ادفع");
  const paymentReload = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
  const pendingPay = paymentReload.data.messages.flatMap((message: any) => message.blocks).find((block: any) => block.payload.surface === "PAYMENT_REVIEW");
  assert.equal(pendingPay.payload.purchaseReview.actionId, payment.payload.purchaseReview.actionId);
  assert.equal(pendingPay.payload.purchaseReview.status, "PENDING");
});

await test("summary", async () => {
  const keys = Object.keys(results).sort();
  const summary = {
    passed: keys.filter((id) => results[id] === "PASS").length,
    total: keys.length,
    results,
    modelCalls: modelCalls.reduce((sum, value) => sum + value, 0),
    externalCalls: external.length,
    falseOrderSuccess,
    falsePaymentSuccess,
  };
  console.log("BLOCKF3_SUMMARY", JSON.stringify(summary));
  assert.equal(summary.modelCalls, 0);
  assert.equal(summary.externalCalls, 0);
  assert.equal(falseOrderSuccess, 0);
  assert.equal(falsePaymentSuccess, 0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
