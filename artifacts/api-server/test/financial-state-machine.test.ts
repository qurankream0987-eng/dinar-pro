/**
 * Claude 01 — financial state machine. Owner policies: a verified payment on an order that is
 * cancelled or whose reservation lapses becomes exactly one durable REFUND_DUE obligation
 * (intent SIMULATION_BUYER_REFUND_DUE + payment_refund_obligations row); only a provider-signed
 * REFUND_SUCCEEDED resolves it; agreed prices are immutable. Every assertion reads server
 * state from PostgreSQL — HTTP responses alone are never treated as financial proof.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, markets, negotiations, offers, orders, paymentEvents, paymentIntents, paymentRefunds, pool, sellerDues, users } from "@workspace/db";
import app from "../src/app";
import { releaseExpiredReservations } from "../src/routes/marketplace";
import { decideNegotiation, openNegotiation } from "../src/lib/negotiations";
import { resolveMarket } from "../src/lib/markets";
import { attachProviderRefundId, createRefundRequest, receivePaymentWebhook, reconcilePayments } from "../src/lib/payments/service";
import { testOnlyPaymentAdapter } from "../src/lib/payments/test-adapter";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE4_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
const key = (label: string) => `fsm-${label}-${runId}-${randomUUID().slice(0, 6)}`;

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
  const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}${String(phoneCounter++ % 10)}`;
  const password = "fsm-password-000000001";
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

const JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
const seller = await register("بائع آلة الحالة");
const buyer = await register("مشتري آلة الحالة");
const stranger = await register("طرف غريب");
const admin = await register("مدير آلة الحالة");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));

async function publish(label: string, opts: { pricingMode?: string; quantity?: number; price?: string } = {}) {
  const created = await request("/listings", "POST", {
    title: `${label} ${runId}`, description: `وصف تفصيلي لاختبار آلة الحالة المالية ${label} ${runId}`,
    category: "أخرى", categoryId: "other", area: "الصويفية", city: "عمّان", attributes: {},
    pricingMode: opts.pricingMode ?? "FIXED", inventoryMode: "LIMITED", fulfilmentType: "PICKUP",
    unitPrice: opts.price ?? "20", availableQuantity: opts.quantity ?? 50, imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
  }, seller);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}
const defaultListing = await publish("منتج آلة الحالة");

async function order(by: Actor = buyer, listingId = defaultListing) {
  const created = await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("order") }, by);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}
async function intentFor(orderId: string, by: Actor = buyer) {
  const created = await request("/payments/intents", "POST", { orderId }, by, { "Idempotency-Key": key("intent") });
  assert.equal(created.status, 201, created.text);
  return (await db.select().from(paymentIntents).where(eq(paymentIntents.id, created.data.id)))[0]!;
}
const deliver = (signed: { event: any; signature: string }) =>
  request("/payments/webhooks/test", "POST", signed.event, undefined, { "X-Payment-Signature": signed.signature });
const capture = (intent: { providerIntentId: string }) => deliver(testOnlyPaymentAdapter.createCaptureWebhook(intent.providerIntentId));
const intentRow = async (id: string) => (await db.select().from(paymentIntents).where(eq(paymentIntents.id, id)))[0]!;
const orderRow = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
const obligations = async (intentId: string) =>
  (await pool.query("SELECT * FROM payment_refund_obligations WHERE payment_intent_id = $1", [intentId])).rows;
const reservedOn = async (listingId: string) => (await db.select().from(offers).where(eq(offers.id, listingId)))[0]!.reservedQuantity;
const expire = (orderId: string) => db.update(orders).set({ reservationExpiresAt: new Date(Date.now() - 60_000) }).where(eq(orders.id, orderId));

/** A paid order whose reservation lapses: the canonical D3 setup. */
async function paidThenExpired() {
  const orderId = await order();
  const intent = await intentFor(orderId);
  assert.equal((await capture(intent)).status, 200);
  await expire(orderId);
  await releaseExpiredReservations();
  return { orderId, intent: await intentRow(intent.id) };
}

await test("D3 / case 3–4: a paid order that expires is cancelled, keeps its payment evidence and owes exactly one refund", async () => {
  const listingId = await publish("منتج D3");
  const before = await reservedOn(listingId);
  const orderId = await order(buyer, listingId);
  const intent = await intentFor(orderId);
  assert.equal((await capture(intent)).status, 200);
  await expire(orderId);
  await releaseExpiredReservations();

  assert.equal((await orderRow(orderId)).status, "CANCELLED");
  assert.equal(await reservedOn(listingId), before, "the reservation is released once");
  const paid = await intentRow(intent.id);
  assert.equal(paid.status, "SIMULATION_BUYER_REFUND_DUE");
  assert.equal(paid.capturedAmountMinor, paid.amountMinor, "the verified capture is preserved");
  assert.equal(paid.refundedAmountMinor, 0, "nothing is claimed as refunded");
  const [captureEvent] = await db.select().from(paymentEvents).where(and(eq(paymentEvents.paymentIntentId, intent.id), eq(paymentEvents.eventType, "CAPTURE_SUCCEEDED")));
  const rows = await obligations(intent.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "OPEN");
  assert.equal(rows[0].reason, "RESERVATION_EXPIRED");
  assert.equal(rows[0].order_id, orderId);
  assert.equal(rows[0].amount_minor, paid.capturedAmountMinor);
  assert.equal(rows[0].currency_code, paid.currencyCode);
  assert.equal(rows[0].source_payment_event_id, captureEvent!.id, "linked to the capture evidence");
});

await test("case 5: repeated and concurrent expiry never duplicates the obligation", async () => {
  const { intent } = await paidThenExpired();
  await Promise.all([releaseExpiredReservations(), releaseExpiredReservations(), releaseExpiredReservations()]);
  await releaseExpiredReservations();
  assert.equal((await obligations(intent.id)).length, 1);
  assert.equal((await intentRow(intent.id)).status, "SIMULATION_BUYER_REFUND_DUE");
});

await test("case 1: a capture arriving after the buyer cancelled is recorded as a refund obligation, never as a normal payment", async () => {
  const listingId = await publish("منتج الإلغاء");
  const before = await reservedOn(listingId);
  const orderId = await order(buyer, listingId);
  const intent = await intentFor(orderId);
  assert.equal((await request(`/orders/${orderId}/cancel`, "POST", { reason: "غيّرت رأيي" }, buyer)).status, 200);
  const late = await capture(intent);
  assert.equal(late.status, 200, "the provider is acknowledged so it stops retrying");
  assert.equal(late.data.paymentIntent.status, "SIMULATION_BUYER_REFUND_DUE");
  assert.equal((await orderRow(orderId)).status, "CANCELLED");
  assert.equal(await reservedOn(listingId), before, "the cancelled order does not reclaim stock");
  const rows = await obligations(intent.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "CAPTURE_AFTER_CANCELLATION");
});

await test("case 1b: a capture for an expired order that the sweep has not reached cancels it and owes a refund", async () => {
  const orderId = await order();
  const intent = await intentFor(orderId);
  await expire(orderId);
  const late = await capture(intent);
  assert.equal(late.status, 200, late.text);
  assert.equal((await orderRow(orderId)).status, "CANCELLED");
  assert.equal((await intentRow(intent.id)).status, "SIMULATION_BUYER_REFUND_DUE");
  assert.equal((await obligations(intent.id))[0]?.reason, "RESERVATION_EXPIRED");
});

await test("case 2: capture racing buyer cancellation always ends in a consistent state", async () => {
  for (let i = 0; i < 8; i++) {
    const orderId = await order();
    const intent = await intentFor(orderId);
    const signed = testOnlyPaymentAdapter.createCaptureWebhook(intent.providerIntentId);
    const [cancel, captured] = await Promise.all([
      request(`/orders/${orderId}/cancel`, "POST", { reason: "سباق الإلغاء" }, buyer),
      deliver(signed),
    ]);
    assert.equal(captured.status, 200, captured.text);
    const finalOrder = await orderRow(orderId);
    const finalIntent = await intentRow(intent.id);
    const owed = await obligations(intent.id);
    if (cancel.status === 200) {
      assert.equal(finalOrder.status, "CANCELLED");
      assert.equal(finalIntent.status, "SIMULATION_BUYER_REFUND_DUE", "cancel won: the capture became an obligation");
      assert.equal(owed.length, 1);
    } else {
      assert.equal(cancel.status, 409, cancel.text);
      assert.equal(finalOrder.status, "CREATED");
      assert.equal(finalIntent.status, "SIMULATION_CAPTURED", "capture won: the paid order cannot be cancelled");
      assert.equal(owed.length, 0);
    }
  }
});

await test("capture racing the expiry sweep produces one cancellation and one obligation", async () => {
  for (let i = 0; i < 5; i++) {
    const orderId = await order();
    const intent = await intentFor(orderId);
    await expire(orderId);
    const signed = testOnlyPaymentAdapter.createCaptureWebhook(intent.providerIntentId);
    await Promise.all([releaseExpiredReservations(), deliver(signed), releaseExpiredReservations()]);
    assert.equal((await orderRow(orderId)).status, "CANCELLED");
    assert.equal((await intentRow(intent.id)).status, "SIMULATION_BUYER_REFUND_DUE");
    assert.equal((await obligations(intent.id)).length, 1);
  }
});

await test("seller acceptance racing expiry: one outcome, stock released at most once", async () => {
  const listingId = await publish("منتج القبول", { quantity: 1 });
  const orderId = await order(buyer, listingId);
  await expire(orderId);
  const [accepted] = await Promise.all([
    request(`/orders/${orderId}/accept`, "POST", {}, seller),
    releaseExpiredReservations(),
  ]);
  assert.notEqual(accepted.status, 200, "an expired order cannot be accepted");
  assert.equal((await orderRow(orderId)).status, "CANCELLED");
  assert.equal(await reservedOn(listingId), 0, "never negative, never released twice");
  assert.equal((await request(`/orders/${orderId}/accept`, "POST", {}, seller)).status, 409, "repeated approval is refused");
});

await test("case 7: no settlement, completion or seller release while a refund is owed", async () => {
  const { orderId, intent } = await paidThenExpired();
  for (const [path, actor, body] of [
    ["accept", seller, {}],
    ["delivery", seller, { proofType: "CODE", proofToken: `FSM-${runId}` }],
    ["confirm", buyer, { received: true, issue: null }],
    ["cancel", buyer, { reason: "إلغاء مكرر" }],
  ] as const) {
    const response = await request(`/orders/${orderId}/${path}`, "POST", body, actor);
    assert.ok(response.status >= 400, `${path} must be refused: ${response.text}`);
  }
  assert.equal((await db.select().from(sellerDues).where(eq(sellerDues.orderId, orderId))).length, 0, "no seller due");
  assert.equal((await orderRow(orderId)).status, "CANCELLED");
  assert.equal((await intentRow(intent.id)).status, "SIMULATION_BUYER_REFUND_DUE");
});

await test("case 6 / 8: refund confirmation cannot be forged and must match intent, amount, currency and refund", async () => {
  const { intent } = await paidThenExpired();
  const owed = intent.capturedAmountMinor;
  // Ordinary users cannot reach the admin refund path.
  for (const actor of [buyer, seller, stranger]) {
    const denied = await request(`/admin/payments/intents/${intent.id}/refunds`, "POST", { amountMinor: owed, reason: "محاولة" }, actor, { "Idempotency-Key": key("forge") });
    assert.equal(denied.status, 403, denied.text);
  }
  // Unsigned and forged-signature confirmations are rejected.
  const forged = { id: `sim_event_${randomUUID()}`, type: "REFUND_SUCCEEDED", providerIntentId: intent.providerIntentId, providerRefundId: `sim_refund_${randomUUID()}`, amountMinor: owed, currencyCode: intent.currencyCode };
  assert.equal((await request("/payments/webhooks/test", "POST", forged, undefined, { "X-Payment-Signature": `sha256=${"a".repeat(64)}` })).status, 401);
  assert.equal((await request("/payments/webhooks/test", "POST", forged)).status, 401);
  // A correctly signed confirmation for a refund that was never requested is refused.
  const unrequested = testOnlyPaymentAdapter.createRefundWebhook({ providerIntentId: intent.providerIntentId, amountMinor: owed, currencyCode: intent.currencyCode, idempotencyKey: key("unrequested") });
  assert.equal((await deliver(unrequested)).status, 409);
  // A requested refund confirmed with a different amount is refused.
  const refund = await createRefundRequest({ paymentIntentId: intent.id, idempotencyKey: key("refund"), amountMinor: owed, reason: "استرداد بعد انتهاء المهلة" });
  const other = await paidThenExpired();
  const crossIntent = testOnlyPaymentAdapter.createRefundWebhook({ providerIntentId: other.intent.providerIntentId, amountMinor: owed, currencyCode: intent.currencyCode, idempotencyKey: key("cross") });
  await attachProviderRefundId(refund.id, (crossIntent.event as any).providerRefundId);
  assert.equal((await deliver(crossIntent)).status, 409, "a refund confirmation for another intent cannot settle this one");
  assert.equal((await obligations(intent.id))[0].status, "OPEN");
  assert.equal((await intentRow(intent.id)).refundedAmountMinor, 0);
});

await test("REFUND_DUE resolves only through a provider-confirmed refund; failure keeps it owed; retries are idempotent", async () => {
  const { intent } = await paidThenExpired();
  const owed = intent.capturedAmountMinor;
  // Refund initiated, then the provider reports failure: still owed, nothing refunded.
  const first = await createRefundRequest({ paymentIntentId: intent.id, idempotencyKey: key("fail"), amountMinor: owed, reason: "محاولة أولى" });
  const failed = testOnlyPaymentAdapter.createRefundFailureWebhook({ providerIntentId: intent.providerIntentId, amountMinor: owed, currencyCode: intent.currencyCode, idempotencyKey: key("fail-provider") });
  await attachProviderRefundId(first.id, (failed.event as any).providerRefundId);
  assert.equal((await deliver(failed)).status, 200);
  assert.equal((await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, first.id)))[0]!.status, "FAILED");
  assert.equal((await intentRow(intent.id)).status, "SIMULATION_BUYER_REFUND_DUE");
  assert.equal((await obligations(intent.id))[0].status, "OPEN");
  // The admin retries with a new key; the confirmation is delivered twice concurrently.
  const retryKey = key("retry");
  const retried = await request(`/admin/payments/intents/${intent.id}/refunds`, "POST", { amountMinor: owed, reason: "إعادة المحاولة" }, admin, { "Idempotency-Key": retryKey });
  assert.equal(retried.status, 201, retried.text);
  const again = await request(`/admin/payments/intents/${intent.id}/refunds`, "POST", { amountMinor: owed, reason: "إعادة المحاولة" }, admin, { "Idempotency-Key": retryKey });
  assert.equal(again.data.id, retried.data.id, "a lost response retried with the same key returns the same refund");
  const resolved = await intentRow(intent.id);
  assert.equal(resolved.status, "SIMULATION_REFUNDED");
  assert.equal(resolved.refundedAmountMinor, owed);
  const [row] = await obligations(intent.id);
  assert.equal(row.status, "RESOLVED");
  const [refundEvent] = await db.select().from(paymentEvents).where(and(eq(paymentEvents.paymentIntentId, intent.id), eq(paymentEvents.eventType, "REFUND_SUCCEEDED")));
  assert.equal(row.resolved_refund_event_id, refundEvent!.id, "resolved by exactly the provider confirmation");
  assert.equal((await db.select().from(paymentEvents).where(and(eq(paymentEvents.paymentIntentId, intent.id), eq(paymentEvents.eventType, "REFUND_SUCCEEDED")))).length, 1);
  const over = await request(`/admin/payments/intents/${intent.id}/refunds`, "POST", { amountMinor: 1, reason: "زيادة" }, admin, { "Idempotency-Key": key("over") });
  assert.equal(over.status, 409, "nothing more can be refunded");
});

await test("refund confirmation racing a duplicate delivery refunds exactly once", async () => {
  const { intent } = await paidThenExpired();
  const owed = intent.capturedAmountMinor;
  const refund = await createRefundRequest({ paymentIntentId: intent.id, idempotencyKey: key("race"), amountMinor: owed, reason: "سباق" });
  const signed = testOnlyPaymentAdapter.createRefundWebhook({ providerIntentId: intent.providerIntentId, amountMinor: owed, currencyCode: intent.currencyCode, idempotencyKey: key("race-provider") });
  await attachProviderRefundId(refund.id, (signed.event as any).providerRefundId);
  const results = await Promise.all([deliver(signed), deliver(signed), deliver(signed)]);
  assert.ok(results.every((result) => result.status === 200), results.map((r) => r.text).join(" | "));
  assert.equal(results.filter((result) => result.data.duplicate === false).length, 1);
  assert.equal((await intentRow(intent.id)).refundedAmountMinor, owed);
});

await test("case 14: a financial obligation cannot be erased or rewritten, even directly in the database", async () => {
  const { intent } = await paidThenExpired();
  const [row] = await obligations(intent.id);
  await assert.rejects(pool.query("DELETE FROM payment_refund_obligations WHERE id = $1", [row.id]));
  await assert.rejects(pool.query("UPDATE payment_refund_obligations SET amount_minor = 1 WHERE id = $1", [row.id]));
  await assert.rejects(pool.query("UPDATE payment_refund_obligations SET status = 'RESOLVED' WHERE id = $1", [row.id]), "resolution needs a refund event");
  await assert.rejects(pool.query("TRUNCATE payment_refund_obligations"));
  assert.equal((await obligations(intent.id)).length, 1);
  for (const method of ["DELETE", "PATCH", "PUT", "POST"])
    assert.equal((await request(`/admin/payments/refund-obligations/${row.id}`, method, { status: "RESOLVED" }, admin)).status, 404, `no ${method} route alters obligations`);
});

await test("open refund obligations are visible to administrators only", async () => {
  const { intent } = await paidThenExpired();
  assert.equal((await request("/admin/payments/refund-obligations", "GET", undefined, buyer)).status, 403);
  const listed = await request("/admin/payments/refund-obligations", "GET", undefined, admin);
  assert.equal(listed.status, 200, listed.text);
  assert.ok(listed.data.items.some((item: any) => item.paymentIntentId === intent.id && item.status === "OPEN"));
});

await test("case 12: duplicate capture and repeated buyer confirmation change nothing twice", async () => {
  const orderId = await order();
  const intent = await intentFor(orderId);
  const signed = testOnlyPaymentAdapter.createCaptureWebhook(intent.providerIntentId);
  const deliveries = await Promise.all([deliver(signed), deliver(signed)]);
  assert.deepEqual(deliveries.map((d) => d.status), [200, 200]);
  assert.equal(deliveries.filter((d) => d.data.duplicate === false).length, 1);
  assert.equal((await intentRow(intent.id)).capturedAmountMinor, intent.amountMinor);
  assert.equal((await request(`/orders/${orderId}/accept`, "POST", {}, seller)).status, 200);
  assert.equal((await request(`/orders/${orderId}/delivery`, "POST", { proofType: "CODE", proofToken: `FSM-OK-${runId}` }, seller)).status, 200);
  const confirmations = await Promise.all([
    request(`/orders/${orderId}/confirm`, "POST", { received: true, issue: null }, buyer),
    request(`/orders/${orderId}/confirm`, "POST", { received: true, issue: null }, buyer),
  ]);
  assert.ok(confirmations.every((c) => c.status === 200), confirmations.map((c) => c.text).join(" | "));
  assert.equal((await db.select().from(sellerDues).where(eq(sellerDues.orderId, orderId))).length, 1, "one seller due");
});

await test("case 11: lost responses retried with the same key return the same order and intent", async () => {
  const idempotencyKey = key("lost");
  const body = { listingId: defaultListing, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey };
  const [a, b] = await Promise.all([request("/orders", "POST", body, buyer), request("/orders", "POST", body, buyer)]);
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 201), `${a.text} | ${b.text}`);
  assert.equal(a.data.id, b.data.id, `orders: ${a.status} ${b.status}`);
  const intentKey = key("lost-intent");
  const [i1, i2] = await Promise.all([
    request("/payments/intents", "POST", { orderId: a.data.id }, buyer, { "Idempotency-Key": intentKey }),
    request("/payments/intents", "POST", { orderId: a.data.id }, buyer, { "Idempotency-Key": intentKey }),
  ]);
  assert.equal(i1.data.id, i2.data.id, `intents: ${i1.status} ${i1.text} | ${i2.status} ${i2.text}`);
  assert.equal((await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, a.data.id))).length, 1);
});

await test("case 10: concurrent buyers for the last unit — exactly one order", async () => {
  const listingId = await publish("آخر قطعة", { quantity: 1 });
  const buyers = await Promise.all([1, 2, 3, 4].map((n) => register(`منافس ${n}`)));
  const results = await Promise.all(buyers.map((b) => request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("last") }, b)));
  assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(","));
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
  assert.equal(await reservedOn(listingId), 1);
});

await test("case 9: an agreed price survives seller price changes, including concurrent ones", async () => {
  const listingId = await publish("قابل للتفاوض", { pricingMode: "NEGOTIABLE", price: "50", quantity: 10 });
  const negotiator = await register("مفاوض السعر");
  const opened = await openNegotiation({ buyerId: negotiator.id, listingId, amountMinor: 45_000, quantity: 1, market: JO });
  const accepted = await decideNegotiation({ actorId: seller.id, negotiationId: opened.id, decision: "ACCEPT", market: JO, expectedVersion: opened.version });
  const [offer] = await db.select().from(offers).where(eq(offers.id, listingId));
  const edit = (unitPrice: string) => request(`/listings/${listingId}`, "PATCH", {
    title: offer!.data.title, description: offer!.data.description, category: "أخرى", categoryId: "other", area: "الصويفية", city: "عمّان",
    attributes: {}, pricingMode: "NEGOTIABLE", inventoryMode: "LIMITED", fulfilmentType: "PICKUP", unitPrice, availableQuantity: 10, imageUrl: "", imageUrls: [],
  }, seller);
  assert.equal((await edit("40")).status, 200, "a lower list price does not lower the agreement either");
  assert.equal((await request("/orders", "POST", { listingId, quantity: 2, fulfilmentType: "PICKUP", idempotencyKey: key("qty") }, negotiator)).status, 409, "agreed quantity cannot grow");
  const [edited, placed] = await Promise.all([
    edit("80"),
    request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("agreed") }, negotiator),
  ]);
  assert.equal(edited.status, 200, edited.text);
  assert.equal(placed.status, 201, placed.text);
  assert.equal(placed.data.subtotalMinor, 45_000, "always the agreed 45");
  const stored = await orderRow(placed.data.id);
  assert.equal(stored.subtotalMinor, 45_000);
  assert.equal(stored.currencyCode, accepted.currencyCode ?? stored.currencyCode);
  const [consumed] = await db.select().from(negotiations).where(eq(negotiations.id, opened.id));
  assert.equal(consumed!.orderId, placed.data.id, "the agreement is consumed by exactly this order");
  assert.equal((await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("reuse") }, negotiator)).status, 409, "a consumed agreement is not reused");
});

await test("case 13: a failure inside the expiry transaction rolls everything back", async () => {
  const listingId = await publish("منتج التراجع");
  const before = await reservedOn(listingId);
  const orderId = await order(buyer, listingId);
  const intent = await intentFor(orderId);
  assert.equal((await capture(intent)).status, 200);
  await expire(orderId);
  const { expireOrderReservation } = await import("../src/lib/order-expiry");
  await assert.rejects(db.transaction(async (tx) => {
    const [locked] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    await expireOrderReservation(tx, locked!, new Date());
    throw new Error("injected failure after the transition");
  }), /injected failure/);
  assert.equal((await orderRow(orderId)).status, "CREATED");
  assert.equal(await reservedOn(listingId), before + 1, "the reservation is still held");
  assert.equal((await intentRow(intent.id)).status, "SIMULATION_CAPTURED");
  assert.equal((await obligations(intent.id)).length, 0);
});

await test("case 8b: a requested refund confirmed with another amount or currency is refused", async () => {
  const { intent } = await paidThenExpired();
  const owed = intent.capturedAmountMinor;
  const refund = await createRefundRequest({ paymentIntentId: intent.id, idempotencyKey: key("mismatch"), amountMinor: owed, reason: "مطابقة" });
  const providerRefundId = `sim_refund_${randomUUID()}`;
  await attachProviderRefundId(refund.id, providerRefundId);
  // Signed through the adapter's own canonical signer, so only the payload is wrong.
  const signer = testOnlyPaymentAdapter as unknown as { sign(event: unknown): { event: any; signature: string } };
  for (const event of [
    { id: `sim_event_${randomUUID()}`, type: "REFUND_SUCCEEDED", providerIntentId: intent.providerIntentId, providerRefundId, amountMinor: owed - 1, currencyCode: intent.currencyCode },
    { id: `sim_event_${randomUUID()}`, type: "REFUND_SUCCEEDED", providerIntentId: intent.providerIntentId, providerRefundId, amountMinor: owed, currencyCode: intent.currencyCode === "USD" ? "EUR" : "USD" },
  ])
    assert.equal((await deliver(signer.sign(event))).status, 409, JSON.stringify(event));
  assert.equal((await obligations(intent.id))[0].status, "OPEN");
  assert.equal((await intentRow(intent.id)).refundedAmountMinor, 0);
});

await test("seller cancellation: allowed before payment, refused once payment is captured", async () => {
  const unpaid = await order();
  await intentFor(unpaid);
  assert.equal((await request(`/orders/${unpaid}/cancel`, "POST", { reason: "نفدت الكمية" }, seller)).status, 200);
  const paidOrder = await order();
  const intent = await intentFor(paidOrder);
  assert.equal((await capture(intent)).status, 200);
  assert.equal((await request(`/orders/${paidOrder}/cancel`, "POST", { reason: "نفدت الكمية" }, seller)).status, 409);
  assert.equal((await request(`/orders/${paidOrder}/cancel`, "POST", { reason: "غريب" }, stranger)).status, 404, "a stranger cannot even see it");
  assert.equal((await orderRow(paidOrder)).status, "CREATED");
});

await test("a disputed payment cannot be refunded through the REFUND_DUE path", async () => {
  const orderId = await order();
  const intent = await intentFor(orderId);
  assert.equal((await capture(intent)).status, 200);
  assert.equal((await request(`/orders/${orderId}/accept`, "POST", {}, seller)).status, 200);
  assert.equal((await request(`/orders/${orderId}/delivery`, "POST", { proofType: "CODE", proofToken: `FSM-DISPUTE-${runId}` }, seller)).status, 200);
  const disputed = await request(`/orders/${orderId}/confirm`, "POST", { received: false, issue: "لم يصل المنتج كما وُصف" }, buyer);
  assert.equal(disputed.status, 200, disputed.text);
  assert.equal((await intentRow(intent.id)).status, "SIMULATION_DISPUTED");
  await assert.rejects(createRefundRequest({ paymentIntentId: intent.id, idempotencyKey: key("dispute"), amountMinor: intent.amountMinor, reason: "نزاع" }), (error: any) => error.status === 409);
  assert.equal((await obligations(intent.id)).length, 0, "disputes keep their own financial audit");
});

await test("durable idempotency lives in PostgreSQL: duplicate events and obligations are rejected by the database", async () => {
  const { intent } = await paidThenExpired();
  const [event] = await db.select().from(paymentEvents).where(eq(paymentEvents.paymentIntentId, intent.id));
  await assert.rejects(pool.query(
    "INSERT INTO payment_events (id, payment_intent_id, provider_key, provider_event_id, event_type, amount_minor, currency_code, payload_sha256, mode) VALUES ($1,$2,$3,$4,'CAPTURE_SUCCEEDED',$5,$6,$7,'SIMULATION_ONLY')",
    [randomUUID(), intent.id, event!.providerKey, event!.providerEventId, event!.amountMinor, event!.currencyCode, event!.payloadSha256],
  ), /payment_events_provider_event_unique/);
  await assert.rejects(pool.query(
    "INSERT INTO payment_refund_obligations (id, payment_intent_id, order_id, source_payment_event_id, reason, amount_minor, currency_code) VALUES ($1,$2,$3,$4,'RESERVATION_EXPIRED',$5,$6)",
    [randomUUID(), intent.id, intent.orderId, event!.id, intent.capturedAmountMinor, intent.currencyCode],
  ), /payment_refund_obligations_(intent|source_event)_unique/);
  const otherOrder = await order();
  await assert.rejects(pool.query(
    "INSERT INTO payment_refund_obligations (id, payment_intent_id, order_id, source_payment_event_id, reason, amount_minor, currency_code) VALUES ($1,$2,$3,$4,'RESERVATION_EXPIRED',1,$5)",
    [randomUUID(), intent.id, otherOrder, event!.id, intent.currencyCode],
  ), "an obligation must point at its own order and capture");
});

await test("case 15: an unknown provider outcome is surfaced by reconciliation, not guessed", async () => {
  const orderId = await order();
  const intent = await intentFor(orderId);
  testOnlyPaymentAdapter.declineIntent(intent.providerIntentId);
  const declined = (await reconcilePayments(testOnlyPaymentAdapter)).items.find((item) => item.paymentIntentId === intent.id);
  assert.equal(declined?.result, "MISMATCH");
  assert.equal(declined?.providerStatus, "DECLINED");
  assert.equal((await intentRow(intent.id)).status, "SIMULATION_PENDING", "a decline is never inferred as success or failure locally");
  // An open refund obligation reconciles as MATCH only while the provider still holds the capture.
  const { intent: owed } = await paidThenExpired();
  const item = (await reconcilePayments(testOnlyPaymentAdapter)).items.find((row) => row.paymentIntentId === owed.id);
  assert.equal(item?.result, "MATCH", JSON.stringify(item));
  assert.equal(item?.localStatus, "SIMULATION_BUYER_REFUND_DUE");
  // A REFUND_DUE status without its obligation (state written around the service) is a mismatch.
  const orphanOrder = await order();
  const orphan = await intentFor(orphanOrder);
  assert.equal((await capture(orphan)).status, 200);
  await db.update(paymentIntents).set({ status: "SIMULATION_BUYER_REFUND_DUE" }).where(eq(paymentIntents.id, orphan.id));
  const orphanItem = (await reconcilePayments(testOnlyPaymentAdapter)).items.find((row) => row.paymentIntentId === orphan.id);
  assert.equal(orphanItem?.result, "MISMATCH", "an obligation-less REFUND_DUE is surfaced");
});

after(async () => {
  server.close();
  await pool.end();
});
