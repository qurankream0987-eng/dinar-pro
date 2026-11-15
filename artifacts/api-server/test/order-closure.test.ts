/**
 * Deal closure (owner-approved 2026-11-07, answers 2026-11-15): buyer-only handover code, five-attempt
 * lock, «تم البيع بدون رمز» with a 48 h buyer window, one 24 h reminder, «لم يتم / أُلغي» (one side:
 * review; both: cancel without commission), buyer confirmation from acceptance, audit and replay safety.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, disputes, markets, messages, offers, orderClosureEvents, orderFulfillments, orderHandoverCodes, orders, pool, sellerDues } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

const { default: app } = await import("../src/app");
const { closeExpiredBuyerWindows, sendClosureReminders, deriveHandoverCode } = await import("../src/lib/order-closure");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ip = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.46.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: response.status, data, raw };
}
const phoneBase = 51_600_000 + ((Date.now() + process.pid + 41) % 90_000);
let offset = 0;
async function register(name: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Close-${randomUUID().slice(0, 10)}!`;
  const response = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Forwarded-For": `198.47.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` },
    body: JSON.stringify({ displayName: name, phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken }),
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, cookie)).status, 200);
  return { id: data.user.id as string, cookie };
}

await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
const [seller, buyer, stranger] = await Promise.all(["بائع الإغلاق", "مشتري الإغلاق", "غريب الإغلاق"].map(register));

async function acceptedOrder(available = 5) {
  const listing = await request("/listings", "POST", {
    title: `مصباح ${randomUUID().slice(0, 4)}`, description: "مصباح مكتبي للاختبار فقط", category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: "10.000", inventoryMode: "LIMITED", availableQuantity: available, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], contactPhone: "+962790000321",
  }, seller.cookie);
  assert.equal(listing.status, 201, listing.raw);
  const order = await request("/orders", "POST", { listingId: listing.data.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `close-${randomUUID()}` }, buyer.cookie);
  assert.equal(order.status, 201, order.raw);
  const accepted = await request(`/orders/${order.data.id}/accept`, "POST", {}, seller.cookie);
  assert.equal(accepted.status, 200, accepted.raw);
  return { orderId: order.data.id as string, offerId: listing.data.id as string };
}
const status = async (orderId: string) => (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
const events = async (orderId: string) => (await db.select().from(orderClosureEvents).where(eq(orderClosureEvents.orderId, orderId))).map((e) => e.type);
const dues = async (orderId: string) => db.select().from(sellerDues).where(eq(sellerDues.orderId, orderId));
const buyerCode = async (orderId: string) => (await request(`/orders/${orderId}/closure`, "GET", undefined, buyer.cookie)).data.handoverCode as string;

await test("only the buyer sees the code; strangers get 404; the seller enters it and the deal closes with commission", async () => {
  const { orderId, offerId } = await acceptedOrder();
  const forBuyer = await request(`/orders/${orderId}/closure`, "GET", undefined, buyer.cookie);
  assert.equal(forBuyer.status, 200);
  assert.match(forBuyer.data.handoverCode, /^\d{4}$/);
  assert.equal(forBuyer.data.canConfirmReceipt, true);
  const forSeller = await request(`/orders/${orderId}/closure`, "GET", undefined, seller.cookie);
  assert.equal(forSeller.data.handoverCode, null, "the seller never receives the code");
  assert.ok(!forSeller.raw.includes(`"${forBuyer.data.handoverCode}"`), "the code string never reaches the seller");
  assert.equal(forSeller.data.attemptsRemaining, 5);
  assert.equal((await request(`/orders/${orderId}/closure`, "GET", undefined, stranger.cookie)).status, 404);
  assert.equal((await request(`/orders/${orderId}/handover-code`, "POST", { code: "1234" }, stranger.cookie)).status, 404);
  assert.equal((await request(`/orders/${orderId}/handover-code`, "POST", { code: forBuyer.data.handoverCode }, buyer.cookie)).status, 403, "the buyer cannot close with their own code");
  assert.equal((await request(`/orders/${orderId}/handover-code`, "POST", { code: "12a4" }, seller.cookie)).status, 400);
  // The code is derived, never stored.
  const [row] = await db.select().from(orderHandoverCodes).where(eq(orderHandoverCodes.orderId, orderId));
  assert.ok(row && !JSON.stringify(row).includes(`"${forBuyer.data.handoverCode}"`));
  assert.equal(deriveHandoverCode(orderId, row!.nonce), forBuyer.data.handoverCode);

  const before = (await db.select().from(offers).where(eq(offers.id, offerId)))[0]!;
  const closed = await request(`/orders/${orderId}/handover-code`, "POST", { code: forBuyer.data.handoverCode }, seller.cookie);
  assert.equal(closed.status, 200, closed.raw);
  assert.equal(closed.data.status, "COMPLETED");
  const after = (await db.select().from(offers).where(eq(offers.id, offerId)))[0]!;
  assert.equal(after.availableQuantity, before.availableQuantity! - 1, "stock leaves on completion");
  assert.equal((await dues(orderId)).length, 1, "commission recorded once");
  // Replays (a second tab, a retry) are harmless.
  const replay = await request(`/orders/${orderId}/handover-code`, "POST", { code: forBuyer.data.handoverCode }, seller.cookie);
  assert.equal(replay.status, 200);
  assert.equal((await dues(orderId)).length, 1, "no double commission");
  assert.deepEqual(await events(orderId), ["CODE_ISSUED", "CODE_ACCEPTED"]);
  assert.equal((await request(`/orders/${orderId}/closure`, "GET", undefined, buyer.cookie)).data.handoverCode, null, "no code after closing");
});

await test("five wrong entries lock the code; the count survives retries; the order stays open", async () => {
  const { orderId } = await acceptedOrder();
  const right = await buyerCode(orderId);
  const wrong = right === "0000" ? "1111" : "0000";
  for (let i = 4; i >= 1; i -= 1) {
    const r = await request(`/orders/${orderId}/handover-code`, "POST", { code: wrong }, seller.cookie);
    assert.equal(r.status, 422, r.raw);
    assert.equal(r.data.attemptsRemaining, i);
  }
  assert.equal((await request(`/orders/${orderId}/handover-code`, "POST", { code: wrong }, seller.cookie)).status, 423);
  assert.equal((await request(`/orders/${orderId}/handover-code`, "POST", { code: right }, seller.cookie)).status, 423, "even the right code is refused once locked");
  assert.equal((await status(orderId)).status, "ACCEPTED");
  const view = await request(`/orders/${orderId}/closure`, "GET", undefined, buyer.cookie);
  assert.equal(view.data.codeLocked, true);
  assert.equal(view.data.handoverCode, null);
  assert.equal(view.data.canConfirmReceipt, true, "the buyer can still close by confirming");
  const types = await events(orderId);
  assert.equal(types.filter((t) => t === "CODE_REJECTED").length, 4);
  assert.equal(types.filter((t) => t === "CODE_LOCKED").length, 1);
});

await test("the buyer's «استلمت» alone closes the deal right after acceptance", async () => {
  const { orderId } = await acceptedOrder();
  const r = await request(`/orders/${orderId}/confirm`, "POST", { received: true }, buyer.cookie);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.status, "COMPLETED");
  assert.equal((await dues(orderId)).length, 1);
  assert.ok((await events(orderId)).includes("BUYER_CONFIRMED"));
  assert.equal((await request(`/orders/${orderId}/confirm`, "POST", { received: true }, seller.cookie)).status, 403, "the seller cannot confirm for the buyer");
});

await test("«تم البيع بدون رمز»: buyer confirms → closed; buyer disputes → review; 48 h of silence → closed «دون رمز»", async () => {
  const a = await acceptedOrder();
  assert.equal((await request(`/orders/${a.orderId}/sold-without-code`, "POST", {}, buyer.cookie)).status, 403);
  const sold = await request(`/orders/${a.orderId}/sold-without-code`, "POST", {}, seller.cookie);
  assert.equal(sold.status, 200, sold.raw);
  assert.equal(sold.data.status, "SELLER_MARKED_DELIVERED");
  const window = await request(`/orders/${a.orderId}/closure`, "GET", undefined, buyer.cookie);
  assert.equal(window.data.soldWithoutCode, true);
  const ends = new Date(window.data.buyerWindowEndsAt).getTime() - Date.now();
  assert.ok(ends > 47.9 * 3600_000 && ends <= 48 * 3600_000, "48-hour window");
  assert.equal((await request(`/orders/${a.orderId}/sold-without-code`, "POST", {}, seller.cookie)).status, 200, "replay is harmless");
  assert.equal((await request(`/orders/${a.orderId}/confirm`, "POST", { received: true }, buyer.cookie)).data.status, "COMPLETED");

  const b = await acceptedOrder();
  await request(`/orders/${b.orderId}/sold-without-code`, "POST", {}, seller.cookie);
  const disputed = await request(`/orders/${b.orderId}/confirm`, "POST", { received: false, issue: "لم أستلم المنتج أبدًا ولم ألتق البائع" }, buyer.cookie);
  assert.equal(disputed.data.status, "DISPUTED");
  assert.equal((await dues(b.orderId)).length, 0, "commission pending while disputed");

  const c = await acceptedOrder();
  await request(`/orders/${c.orderId}/sold-without-code`, "POST", {}, seller.cookie);
  assert.equal(await closeExpiredBuyerWindows(new Date(Date.now() + 47 * 3600_000)), 0, "not before 48 hours");
  assert.equal((await status(c.orderId)).status, "SELLER_MARKED_DELIVERED");
  assert.ok((await closeExpiredBuyerWindows(new Date(Date.now() + 49 * 3600_000))) >= 1);
  const closed = await status(c.orderId);
  assert.equal(closed.status, "COMPLETED");
  assert.equal((closed.data as any).closure.closedWithoutCode, true);
  assert.equal((await dues(c.orderId)).length, 1);
  assert.deepEqual((await events(c.orderId)).slice(-2), ["SOLD_WITHOUT_CODE", "BUYER_WINDOW_CLOSED"]);
});

await test("one reminder, 24 hours after acceptance, to both parties in the order chat", async () => {
  const { orderId } = await acceptedOrder();
  const remindedEarly = await sendClosureReminders(new Date(Date.now() + 23 * 3600_000));
  assert.ok(!(await events(orderId)).includes("REMINDER_SENT"), `not before 24 hours (${remindedEarly})`);
  await sendClosureReminders(new Date(Date.now() + 25 * 3600_000));
  await sendClosureReminders(new Date(Date.now() + 26 * 3600_000));
  assert.equal((await events(orderId)).filter((t) => t === "REMINDER_SENT").length, 1, "sent once");
  const chat = await db.select().from(messages).where(eq(messages.conversationId, orderId));
  assert.ok(chat.some((m) => m.body.includes("هل تمت الصفقة؟")));
});

await test("«لم يتم»: one side opens a review; both sides cancel, release stock and record no commission", async () => {
  const { orderId, offerId } = await acceptedOrder();
  const before = (await db.select().from(offers).where(eq(offers.id, offerId)))[0]!;
  assert.equal((await request(`/orders/${orderId}/not-completed`, "POST", { outcome: "NOT_COMPLETED" }, stranger.cookie)).status, 404);
  const first = await request(`/orders/${orderId}/not-completed`, "POST", { outcome: "NOT_COMPLETED" }, buyer.cookie);
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.data.status, "DISPUTED");
  assert.equal((await db.select().from(disputes).where(eq(disputes.orderId, orderId))).length, 1);
  assert.equal((await request(`/orders/${orderId}/not-completed`, "POST", { outcome: "NOT_COMPLETED" }, buyer.cookie)).data.status, "DISPUTED", "the same side again changes nothing");
  assert.equal((await request(`/orders/${orderId}/handover-code`, "POST", { code: "0000" }, seller.cookie)).status, 409, "no code closure under review");
  const second = await request(`/orders/${orderId}/not-completed`, "POST", { outcome: "CANCELLED" }, seller.cookie);
  assert.equal(second.status, 200, second.raw);
  assert.equal(second.data.status, "CANCELLED");
  const after = (await db.select().from(offers).where(eq(offers.id, offerId)))[0]!;
  assert.equal(after.reservedQuantity, before.reservedQuantity - 1, "reservation released");
  assert.equal(after.availableQuantity, before.availableQuantity, "stock not consumed");
  assert.equal((await dues(orderId)).length, 0, "no commission");
  const [dispute] = await db.select().from(disputes).where(eq(disputes.orderId, orderId));
  assert.equal(dispute!.status, "RESOLVED");
  assert.deepEqual((await events(orderId)).filter((t) => t !== "CODE_ISSUED"), ["NOT_COMPLETED_CLAIMED", "NOT_COMPLETED_CLAIMED", "MUTUAL_CANCELLED"]);
});

await test("the audit trail is append-only", async () => {
  const [row] = await db.select().from(orderClosureEvents).limit(1);
  assert.ok(row);
  const appendOnly = (error: any) => /append-only/.test(String(error?.cause?.message ?? error?.message));
  await assert.rejects(db.update(orderClosureEvents).set({ type: "CODE_ACCEPTED" }).where(eq(orderClosureEvents.id, row!.id)), appendOnly);
  await assert.rejects(db.delete(orderClosureEvents).where(and(eq(orderClosureEvents.id, row!.id))), appendOnly);
});

await test("two tabs entering the right code at once close the deal exactly once", async () => {
  const { orderId } = await acceptedOrder();
  const code = await buyerCode(orderId);
  const results = await Promise.all([1, 2].map(() => request(`/orders/${orderId}/handover-code`, "POST", { code }, seller.cookie)));
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal((await dues(orderId)).length, 1);
  assert.equal((await events(orderId)).filter((t) => t === "CODE_ACCEPTED").length, 1);
});

await test("courier orders: the seller is not offered code entry or «بدون رمز»; the server rule is unchanged; the buyer still closes", async () => {
  const { orderId } = await acceptedOrder();
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  await db.insert(orderFulfillments).values({ orderId, marketId: o!.marketId, method: "COURIER", status: "OUT_FOR_DELIVERY", selectedBy: buyer.id });
  const forSeller = await request(`/orders/${orderId}/closure`, "GET", undefined, seller.cookie);
  assert.equal(forSeller.data.courierHandoff, true);
  assert.equal(forSeller.data.canEnterCode, false);
  assert.equal(forSeller.data.canSellWithoutCode, false);
  assert.equal(forSeller.data.canReportNotCompleted, true, "«لم يتم» stays available");
  const forBuyer = await request(`/orders/${orderId}/closure`, "GET", undefined, buyer.cookie);
  assert.equal(forBuyer.data.canConfirmReceipt, true);
  assert.match(forBuyer.data.handoverCode, /^\d{4}$/);
  // The existing authorization is untouched: the server still refuses the seller's handoff.
  assert.equal((await request(`/orders/${orderId}/handover-code`, "POST", { code: forBuyer.data.handoverCode }, seller.cookie)).status, 403);
  assert.equal((await request(`/orders/${orderId}/sold-without-code`, "POST", {}, seller.cookie)).status, 403);
  const closed = await request(`/orders/${orderId}/confirm`, "POST", { received: true }, buyer.cookie);
  assert.equal(closed.data.status, "COMPLETED", closed.raw);
  assert.equal((await dues(orderId)).length, 1);
});

await test("teardown", async () => {
  server.close();
  await pool.end();
});
