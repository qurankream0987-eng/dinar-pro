/**
 * Wave 1, section 4: one complete seller-to-buyer journey through the existing commercial runtime
 * — the canonical listing route, search, negotiation (the functions the chat tools call),
 * checkout, the simulation-only payment core, order handoff and the seller-dues ledger — with the
 * denial cases at each step. No second ledger, no new pricing, refund or settlement policy:
 * the commission is whatever checkout snapshots (currently 10%), and payment is SIMULATION_ONLY.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, markets, negotiations, offers, orderItems, orders, paymentIntents, pool, sellerDues, users } from "@workspace/db";
import app from "../src/app";
import { decideNegotiation, openNegotiation } from "../src/lib/negotiations";
import { resolveMarket } from "../src/lib/markets";
import { testOnlyPaymentAdapter } from "../src/lib/payments/test-adapter";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE4_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
// Order idempotency keys are 16–128 characters.
const key = (label: string) => `wave1-journey-${label}-${runId}`;

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
  // «79» + 7 digits is always a valid Jordanian mobile; «78» + clock digits fell outside the
  // libphonenumber ranges on some clocks and failed registration at random.
  const number = `79${((Date.now() + 7919 * phoneCounter) % 1_000_000).toString().padStart(6, "0")}${phoneCounter++ % 10}`;
  const password = "journey-password-0001";
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
const refuses = async (promise: Promise<unknown>, status: number, pattern?: RegExp) => {
  await assert.rejects(promise, (error: any) => {
    assert.equal(error?.status ?? error?.statusCode, status, String(error?.message));
    if (pattern) assert.match(String(error.message), pattern);
    return true;
  });
};

const JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
assert.ok(JO.isActive, "acceptance fixtures activate JO");
const seller = await register("بائع الرحلة");
const buyer = await register("مشتري الرحلة");
const rival = await register("مشتري منافس");
const intruder = await register("طرف ثالث");
const listingBody = (overrides: Record<string, unknown>) => ({
  description: `وصف تفصيلي لعرض رحلة الموجة الأولى ${runId}`, category: "أخرى", categoryId: "other", area: "الصويفية", city: "عمّان",
  attributes: {}, pricingMode: "NEGOTIABLE", inventoryMode: "LIMITED", fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], ...overrides,
});
let product: { id: string };
let service: { id: string };
let lastUnit: { id: string };
let orderId: string;

await test("seller publishes a product and a service; invalid prices are refused", async () => {
  for (const unitPrice of ["0", "-5", "abc", "1e9999"]) {
    const refused = await request("/listings", "POST", listingBody({ title: `سعر غير صالح ${runId}`, unitPrice, availableQuantity: 1 }), seller);
    assert.equal(refused.status, 400, `${unitPrice}: ${refused.text}`);
  }
  const p = await request("/listings", "POST", listingBody({ title: `طاولة سنديان رحلة ${runId}`, unitPrice: "50", availableQuantity: 2, clientRequestId: randomUUID() }), seller);
  assert.equal(p.status, 201, p.text);
  product = p.data;
  const s = await request("/listings", "POST", listingBody({ title: `تركيب أثاث منزلي رحلة ${runId}`, category: "خدمات", categoryId: "services", unitPrice: "15", fulfilmentType: "SERVICE", inventoryMode: "UNLIMITED", availableQuantity: null }), seller);
  assert.equal(s.status, 201, s.text);
  service = s.data;
  const l = await request("/listings", "POST", listingBody({ title: `مصباح نحاسي آخر قطعة ${runId}`, unitPrice: "20", pricingMode: "FIXED", availableQuantity: 1 }), seller);
  assert.equal(l.status, 201, l.text);
  lastUnit = l.data;
  const rows = await db.select({ id: offers.id, status: offers.status, sellerId: offers.sellerId }).from(offers).where(eq(offers.sellerId, seller.id));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.status === "PUBLISHED"), "the DRAFT row of each publish completed to PUBLISHED");
});

await test("buyer discovers both listings and refines the results", async () => {
  const found = await request(`/listings?search=${encodeURIComponent(`رحلة ${runId}`)}`, "GET", undefined, buyer);
  assert.equal(found.status, 200, found.text);
  const ids = found.data.map((item: { id: string }) => item.id);
  assert.ok(ids.includes(product.id) && ids.includes(service.id), found.text.slice(0, 400));
  const services = await request(`/listings?search=${encodeURIComponent(`رحلة ${runId}`)}&categoryId=services`, "GET", undefined, buyer);
  assert.deepEqual(services.data.map((item: { id: string }) => item.id), [service.id]);
  const cheapest = await request(`/listings?search=${encodeURIComponent(runId)}&sort=PRICE_ASC`, "GET", undefined, buyer);
  const prices = cheapest.data.map((item: { unitPrice: string }) => Number(item.unitPrice));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

await test("offer → counteroffer → acceptance, with invalid, stale, wrong-actor and own-listing refusals", async () => {
  await refuses(openNegotiation({ buyerId: buyer.id, listingId: product.id, amountMinor: 0, quantity: 1, market: JO }), 400, /المبلغ غير صالح/u);
  await refuses(openNegotiation({ buyerId: buyer.id, listingId: product.id, amountMinor: 50_001, quantity: 1, market: JO }), 409);
  await assert.rejects(openNegotiation({ buyerId: seller.id, listingId: product.id, amountMinor: 40_000, quantity: 1, market: JO }), "a seller cannot negotiate on its own listing");

  const offer = await openNegotiation({ buyerId: buyer.id, listingId: product.id, amountMinor: 40_000, quantity: 1, market: JO });
  assert.equal(offer.status, "OPEN");
  // Conflicting offer on the same listing from another buyer: a separate negotiation.
  const rivalOffer = await openNegotiation({ buyerId: rival.id, listingId: product.id, amountMinor: 42_000, quantity: 1, market: JO });
  assert.notEqual(rivalOffer.id, offer.id);

  await refuses(decideNegotiation({ actorId: intruder.id, negotiationId: offer.id, decision: "ACCEPT", market: JO }), 404);
  await refuses(decideNegotiation({ actorId: buyer.id, negotiationId: offer.id, decision: "ACCEPT", market: JO }), 409, /بانتظار رد الطرف الآخر/u);
  await refuses(decideNegotiation({ actorId: seller.id, negotiationId: offer.id, decision: "COUNTER", amountMinor: 39_000, market: JO }), 409);
  const countered = await decideNegotiation({ actorId: seller.id, negotiationId: offer.id, decision: "COUNTER", amountMinor: 45_000, market: JO, expectedVersion: offer.version });
  assert.equal(countered.status, "COUNTERED");
  // A review taken before the counter is stale.
  await refuses(decideNegotiation({ actorId: buyer.id, negotiationId: offer.id, decision: "ACCEPT", market: JO, expectedVersion: offer.version }), 409, /تغيّر/u);
  const accepted = await decideNegotiation({ actorId: buyer.id, negotiationId: offer.id, decision: "ACCEPT", market: JO, expectedVersion: countered.version });
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.agreedAmountMinor, 45_000);
});

await test("authorized order at the agreed price; duplicates, wrong actors and client amounts change nothing", async () => {
  const body = { listingId: product.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("order"), unitPrice: "1", total: "1", platformFeeMinor: 0, sellerId: intruder.id };
  const created = await request("/orders", "POST", body, buyer);
  assert.equal(created.status, 201, created.text);
  orderId = created.data.id;
  assert.equal(created.data.subtotalMinor, 45_000, "the agreed amount, never the client's");
  assert.equal(created.data.platformFeeMinor, 2_250, "5% of the agreed 45.000 JOD");
  assert.equal(created.data.sellerAmountMinor, 42_750);
  assert.equal(created.data.paymentMode, "TEST_NO_TRANSFER");

  const duplicate = await request("/orders", "POST", body, buyer);
  assert.equal(duplicate.data.id, orderId, "the same idempotency key returns the same order");
  const buyerProductOrders = await db.select({ id: orders.id }).from(orders).innerJoin(orderItems, eq(orderItems.orderId, orders.id)).where(and(eq(orders.buyerId, buyer.id), eq(orderItems.offerId, product.id)));
  assert.equal(buyerProductOrders.length, 1);
  const [consumed] = await db.select().from(negotiations).where(eq(negotiations.buyerId, buyer.id));
  assert.equal(consumed!.orderId, orderId, "the agreement is consumed by exactly this order");

  assert.equal((await request(`/orders/${orderId}`, "GET", undefined, intruder)).status, 404);
  assert.equal((await request(`/orders/${orderId}/accept`, "POST", {}, buyer)).status, 403);
  assert.equal((await request(`/orders/${orderId}/confirm`, "POST", { received: true, issue: null }, seller)).status, 403);
  assert.equal((await request(`/orders/${orderId}/confirm`, "POST", { received: true, issue: null }, buyer)).status, 409, "no confirmation before handoff");
});

await test("simulated payment: only a correctly signed capture moves the intent; fabricated success is refused", async () => {
  const intent = await request("/payments/intents", "POST", { orderId }, buyer, { "Idempotency-Key": key("intent") });
  assert.equal(intent.status, 201, intent.text);
  assert.equal(intent.data.mode, "SIMULATION_ONLY");
  assert.equal(intent.data.amountMinor, 45_000);
  assert.equal((await request("/payments/intents", "POST", { orderId }, seller, { "Idempotency-Key": key("intent-seller") })).status, 404, "only the buyer pays");
  const [row] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.data.id));

  const forged = { id: `forged-${runId}`, type: "CAPTURE_SUCCEEDED", providerIntentId: row!.providerIntentId, amountMinor: row!.amountMinor, currencyCode: row!.currencyCode };
  assert.equal((await request("/payments/webhooks/test", "POST", forged, undefined, { "X-Payment-Signature": `sha256=${"0".repeat(64)}` })).status, 401);
  assert.equal((await request("/payments/webhooks/test", "POST", forged)).status, 401, "unsigned");
  const capture = testOnlyPaymentAdapter.createCaptureWebhook(row!.providerIntentId);
  const tampered = await request("/payments/webhooks/test", "POST", { ...capture.event, amountMinor: 1 }, undefined, { "X-Payment-Signature": capture.signature });
  assert.equal(tampered.status, 401, "the signature covers the amount");
  const [still] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, row!.id));
  assert.notEqual(still!.status, "SIMULATION_CAPTURED");

  const captured = await request("/payments/webhooks/test", "POST", capture.event, undefined, { "X-Payment-Signature": capture.signature });
  assert.equal(captured.status, 200, captured.text);
  assert.equal(captured.data.paymentIntent.status, "SIMULATION_CAPTURED");
  const replay = await request("/payments/webhooks/test", "POST", capture.event, undefined, { "X-Payment-Signature": capture.signature });
  assert.equal(replay.data.duplicate, true);
});

await test("handoff and delivery confirmation complete the order and create exactly one seller due", async () => {
  assert.equal((await request(`/orders/${orderId}/accept`, "POST", {}, seller)).data.status, "ACCEPTED");
  assert.equal((await request(`/orders/${orderId}/delivery`, "POST", { proofType: "CODE", proofToken: `JOURNEY-${runId}` }, buyer)).status, 403);
  const delivered = await request(`/orders/${orderId}/delivery`, "POST", { proofType: "CODE", proofToken: `JOURNEY-${runId}` }, seller);
  assert.equal(delivered.data.status, "SELLER_MARKED_DELIVERED", delivered.text);
  assert.equal((await request(`/orders/${orderId}/confirm`, "POST", { received: true, issue: null }, buyer)).data.status, "COMPLETED");
  assert.equal((await request(`/orders/${orderId}/confirm`, "POST", { received: true, issue: null }, buyer)).data.status, "COMPLETED", "idempotent");

  const dues = await db.select().from(sellerDues).where(eq(sellerDues.orderId, orderId));
  assert.equal(dues.length, 1);
  assert.equal(dues[0]!.amountMinor, 2_250, "5% of the agreed 45.000 JOD");
  assert.equal(dues[0]!.currencyCode, "JOD");
  assert.equal(dues[0]!.status, "PENDING", "no settlement policy is invented");
  const sellerView = await request("/seller-dues", "GET", undefined, seller);
  assert.ok(sellerView.data.some((due: { orderId: string }) => due.orderId === orderId));
  const buyerView = await request("/seller-dues", "GET", undefined, buyer);
  assert.ok(!buyerView.data.some((due: { orderId: string }) => due.orderId === orderId), "dues are private to the seller");
});

await test("concurrent purchases of the last unit produce exactly one order", async () => {
  const attempt = (actor: Actor, idempotencyKey: string) => request("/orders", "POST", { listingId: lastUnit.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey }, actor);
  const results = await Promise.all([attempt(buyer, key("last-a")), attempt(rival, key("last-b")), attempt(intruder, key("last-c"))]);
  const statuses = results.map((result) => result.status).sort();
  assert.equal(statuses.filter((status) => status === 201).length, 1, JSON.stringify(results.map((r) => [r.status, r.text.slice(0, 80)])));
  assert.ok(statuses.filter((status) => status !== 201).every((status) => status === 409), JSON.stringify(statuses));
  const [listing] = await db.select().from(offers).where(eq(offers.id, lastUnit.id));
  assert.equal((await db.select().from(orderItems).where(eq(orderItems.offerId, lastUnit.id))).length, 1);
  assert.ok((listing!.availableQuantity ?? 0) - (listing!.reservedQuantity ?? 0) <= 0, "no unit remains purchasable");
});

await test("the rival's offer on the sold listing cannot become a second agreement beyond stock", async () => {
  const [rivalRow] = await db.select().from(negotiations).where(and(eq(negotiations.buyerId, rival.id), eq(negotiations.listingId, product.id)));
  const accepted = await decideNegotiation({ actorId: seller.id, negotiationId: rivalRow!.id, decision: "ACCEPT", market: JO });
  assert.equal(accepted.agreedAmountMinor, 42_000);
  // One unit remains of two: the rival can buy exactly one at the agreed price, not more.
  const tooMany = await request("/orders", "POST", { listingId: product.id, quantity: 2, fulfilmentType: "PICKUP", idempotencyKey: key("rival-2") }, rival);
  assert.equal(tooMany.status, 409, tooMany.text);
  const one = await request("/orders", "POST", { listingId: product.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("rival-1") }, rival);
  assert.equal(one.status, 201, one.text);
  assert.equal(one.data.subtotalMinor, 42_000);
  const after = await request("/orders", "POST", { listingId: product.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("intruder") }, intruder);
  assert.equal(after.status, 409, "sold out");
  const [{ count } = { count: 0 }] = (await pool.query("SELECT count(*)::int AS count FROM users WHERE id = ANY($1)", [[seller.id, buyer.id, rival.id, intruder.id]])).rows;
  assert.equal(count, 4);
  assert.equal((await db.select().from(users).where(eq(users.role, "ADMIN"))).filter((user) => [seller.id, buyer.id].includes(user.id)).length, 0);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
