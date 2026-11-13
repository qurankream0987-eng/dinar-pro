/** Contact after seller acceptance and the buyer's off-platform payment preference (information only). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, markets, orders, pool } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

const { default: app } = await import("../src/app");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ip = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.44.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", cache: response.headers.get("cache-control") ?? "" };
}
const phoneBase = 51_600_000 + ((Date.now() + process.pid + 29) % 150_000);
let offset = 0;
async function register(name: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Settle-${randomUUID().slice(0, 10)}!`;
  const registered = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id as string, cookie: registered.cookie, phone: `+965${phoneNumber}` };
}

await test("contact appears only after the seller accepts; payment preference is information only", async () => {
  await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
  const [seller, buyer, stranger] = await Promise.all(["بائع التسوية", "مشتري التسوية", "غريب"].map(register));
  const listing = await request("/listings", "POST", {
    title: `ساعة ${randomUUID().slice(0, 4)}`, description: "ساعة للاختبار فقط لا تباع", category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: "20.000", inventoryMode: "LIMITED", availableQuantity: 2, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], contactPhone: "+962790000123",
  }, seller.cookie);
  assert.equal(listing.status, 201, listing.raw);
  const order = await request("/orders", "POST", { listingId: listing.data.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `settle-${randomUUID()}` }, buyer.cookie);
  assert.equal(order.status, 201, order.raw);
  const orderId = order.data.id as string;
  const [before] = await db.select().from(orders).where(eq(orders.id, orderId));

  const pending = await request(`/orders/${orderId}/counterpart-contact`, "GET", undefined, buyer.cookie);
  assert.equal(pending.status, 200);
  assert.match(pending.cache, /no-store/);
  assert.equal(pending.data.available, false);
  assert.equal(pending.data.reason, "AWAITING_SELLER_ACCEPTANCE");
  assert.equal(pending.data.counterpart, null);
  assert.ok(!pending.raw.includes(seller.phone) && !pending.raw.includes("+962790000123"), "no phone before acceptance");
  assert.deepEqual(pending.data.settlementMethods.map((m: any) => m.method), ["CASH", "BANK_TRANSFER", "CLIQ"], "Jordan offers CliQ");
  assert.equal((await request(`/orders/${orderId}/counterpart-contact`, "GET", undefined, stranger.cookie)).status, 404);

  // The buyer can state a preference before acceptance; it is information only.
  assert.equal((await request(`/orders/${orderId}/settlement-preference`, "PUT", { method: "KNET" }, buyer.cookie)).status, 400, "KNET is not a Jordan method");
  assert.equal((await request(`/orders/${orderId}/settlement-preference`, "PUT", { method: "CLIQ" }, seller.cookie)).status, 404, "only the buyer states it");
  assert.equal((await request(`/orders/${orderId}/settlement-preference`, "PUT", { method: "CLIQ" }, stranger.cookie)).status, 404);
  assert.equal((await request(`/orders/${orderId}/settlement-preference`, "PUT", { method: "CLIQ", paid: true }, buyer.cookie)).status, 400, "strict body");
  const set = await request(`/orders/${orderId}/settlement-preference`, "PUT", { method: "CLIQ" }, buyer.cookie);
  assert.equal(set.status, 200, set.raw);
  assert.equal(set.data.settlementPreference.label, "كليك (CliQ)");

  assert.equal((await request(`/orders/${orderId}/accept`, "POST", {}, seller.cookie)).status, 200);
  const forBuyer = await request(`/orders/${orderId}/counterpart-contact`, "GET", undefined, buyer.cookie);
  assert.equal(forBuyer.data.available, true);
  assert.equal(forBuyer.data.counterpart.role, "SELLER");
  assert.equal(forBuyer.data.counterpart.phone, "+962790000123", "the listing's contact number wins");
  assert.equal(forBuyer.data.settlementPreference.method, "CLIQ");
  assert.match(forBuyer.data.notice, /خارج جاسم/);
  const forSeller = await request(`/orders/${orderId}/counterpart-contact`, "GET", undefined, seller.cookie);
  assert.equal(forSeller.data.counterpart.role, "BUYER");
  assert.equal(forSeller.data.counterpart.phone, buyer.phone);
  assert.equal(forSeller.data.settlementPreference.method, "CLIQ", "the seller sees how the buyer prefers to pay");
  assert.equal((await request(`/orders/${orderId}/counterpart-contact`, "GET", undefined, stranger.cookie)).status, 404);

  // Nothing financial changed: status, totals, payment fields and the fee snapshot are untouched.
  const [after] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.equal(after!.subtotalMinor, before!.subtotalMinor);
  for (const key of ["selectedPaymentMethod", "paymentStatus", "payment", "commission", "items", "paymentMode"])
    assert.deepEqual((after!.data as any)[key], (before!.data as any)[key], key);
  assert.equal(after!.status, "ACCEPTED");
});

await test("teardown", async () => {
  server.close();
  await pool.end();
});
