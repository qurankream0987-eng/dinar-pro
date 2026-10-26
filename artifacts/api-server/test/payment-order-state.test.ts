/**
 * Payment ↔ order state integrity (Claude 00, defects D1/D2). The simulation-only capture must not
 * record money against an order that is no longer payable, and a buyer must not be able to cancel
 * (releasing the reserved stock) an order whose payment was already captured. Both are fail-closed
 * guards; no refund or settlement policy is introduced here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, offers, orders, paymentIntents, pool } from "@workspace/db";
import app from "../src/app";
import { releaseExpiredReservations } from "../src/routes/marketplace";
import { testOnlyPaymentAdapter } from "../src/lib/payments/test-adapter";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE4_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
const key = (label: string) => `payment-state-${label}-${runId}`;

type Actor = { id: string; cookie: string };
async function request(path: string, method = "GET", body?: unknown, actor?: Actor, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(actor ? { cookie: actor.cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text };
}
let phoneCounter = 0;
async function register(name: string): Promise<Actor> {
  const number = `77${(Date.now() % 10_000_000).toString().padStart(7, "0")}`.slice(0, 8) + String(phoneCounter++ % 10);
  const password = "payment-state-password-01";
  const response = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!.split(";")[0]!;
  return { id: JSON.parse(text).user.id, cookie };
}

const seller = await register("بائع حالة الدفع");
const buyer = await register("مشتري حالة الدفع");
const listing = await request("/listings", "POST", {
  title: `ساعة جدارية حالة الدفع ${runId}`, description: `وصف تفصيلي لاختبار حالة الدفع والطلب ${runId}`,
  category: "أخرى", categoryId: "other", area: "الصويفية", city: "عمّان", attributes: {},
  pricingMode: "FIXED", inventoryMode: "LIMITED", fulfilmentType: "PICKUP", unitPrice: "20", availableQuantity: 5,
  imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
}, seller);
assert.equal(listing.status, 201, listing.text);

async function orderWithIntent(label: string) {
  const order = await request("/orders", "POST", { listingId: listing.data.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key(`order-${label}`) }, buyer);
  assert.equal(order.status, 201, order.text);
  const intent = await request("/payments/intents", "POST", { orderId: order.data.id }, buyer, { "Idempotency-Key": key(`intent-${label}`) });
  assert.equal(intent.status, 201, intent.text);
  const [row] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.data.id));
  return { orderId: order.data.id as string, intent: row! };
}
const deliver = (signed: ReturnType<typeof testOnlyPaymentAdapter.createCaptureWebhook>) =>
  request("/payments/webhooks/test", "POST", signed.event, undefined, { "X-Payment-Signature": signed.signature });
const capture = (providerIntentId: string) => deliver(testOnlyPaymentAdapter.createCaptureWebhook(providerIntentId));
const reserved = async () => (await db.select().from(offers).where(eq(offers.id, listing.data.id)))[0]!.reservedQuantity;

await test("D1: a capture arriving after the buyer cancelled the order is refused and records nothing", async () => {
  const { orderId, intent } = await orderWithIntent("cancelled");
  const cancelled = await request(`/orders/${orderId}/cancel`, "POST", { reason: "غيّرت رأيي" }, buyer);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.data.status, "CANCELLED");
  const late = await capture(intent.providerIntentId);
  assert.equal(late.status, 409, late.text);
  const [after] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
  assert.equal(after!.status, "SIMULATION_PENDING");
  assert.equal(after!.capturedAmountMinor, 0, "no money is recorded against a cancelled order");
});

await test("D1: a capture arriving after the reservation expired is refused, before and after the sweep", async () => {
  const { orderId, intent } = await orderWithIntent("expired");
  await db.update(orders).set({ reservationExpiresAt: new Date(Date.now() - 60_000) }).where(eq(orders.id, orderId));
  const signed = testOnlyPaymentAdapter.createCaptureWebhook(intent.providerIntentId);
  const beforeSweep = await deliver(signed);
  assert.equal(beforeSweep.status, 409, `expired but not yet swept: ${beforeSweep.text}`);
  await releaseExpiredReservations();
  assert.equal((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.status, "CANCELLED");
  // The provider retries the same signed event after the sweep.
  const afterSweep = await deliver(signed);
  assert.equal(afterSweep.status, 409, afterSweep.text);
  const [row] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
  assert.equal(row!.capturedAmountMinor, 0);
});

await test("D2: a buyer cannot cancel (and release stock for) an order whose payment was captured", async () => {
  const { orderId, intent } = await orderWithIntent("captured");
  const captured = await capture(intent.providerIntentId);
  assert.equal(captured.status, 200, captured.text);
  assert.equal(captured.data.paymentIntent.status, "SIMULATION_CAPTURED", "capture on a live order still works");
  const reservedBefore = await reserved();
  const cancel = await request(`/orders/${orderId}/cancel`, "POST", { reason: "غيّرت رأيي" }, buyer);
  assert.equal(cancel.status, 409, cancel.text);
  assert.equal((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.status, "CREATED");
  assert.equal(await reserved(), reservedBefore, "the reservation is not released");
  // The normal path continues: the seller can still accept the paid order.
  const accepted = await request(`/orders/${orderId}/accept`, "POST", {}, seller);
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.data.status, "ACCEPTED");
});

after(async () => {
  server.close();
  await pool.end();
});
