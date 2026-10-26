/**
 * Claude 00, acceptance scenario H: a seller edits price and quantity after an order exists. The
 * order's price, fee and seller amount are snapshots — the edit must not change them, and the
 * completed sale's seller due is the snapshot fee. What an accepted-but-unordered agreement does
 * after a price edit is a policy question; it is recorded (H_AGREEMENT_AFTER_EDIT), not asserted.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, markets, offers, orders, pool, sellerDues } from "@workspace/db";
import app from "../src/app";
import { decideNegotiation, openNegotiation } from "../src/lib/negotiations";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);

type Actor = { id: string; cookie: string };
async function request(path: string, method = "GET", body?: unknown, actor?: Actor) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(actor ? { cookie: actor.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text };
}
let phoneCounter = 0;
async function register(name: string): Promise<Actor> {
  const number = `78${(Date.now() % 10_000_000).toString().padStart(7, "0")}`.slice(0, 8) + String(phoneCounter++ % 10);
  const password = "snapshot-password-0001";
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
const seller = await register("بائع اللقطة");
const buyer = await register("مشتري اللقطة");
const negotiator = await register("مفاوض اللقطة");
async function publish(label: string, pricingMode: "FIXED" | "NEGOTIABLE") {
  const created = await request("/listings", "POST", {
    title: `سجادة يدوية ${label} ${runId}`, description: `وصف تفصيلي لاختبار ثبات لقطة الطلب ${label} ${runId}`,
    category: "أخرى", categoryId: "other", area: "الصويفية", city: "عمّان", attributes: {},
    pricingMode, inventoryMode: "LIMITED", fulfilmentType: "PICKUP", unitPrice: "50", availableQuantity: 5,
    imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
  }, seller);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}
async function edit(listingId: string, pricingMode: string, unitPrice: string) {
  // A listing edit takes the full update body; only price and quantity change.
  const [offer] = await db.select().from(offers).where(eq(offers.id, listingId));
  return request(`/listings/${listingId}`, "PATCH", {
    title: offer!.data.title, description: offer!.data.description, category: "أخرى", categoryId: "other",
    area: "الصويفية", city: "عمّان", attributes: {}, pricingMode, inventoryMode: "LIMITED",
    fulfilmentType: "PICKUP", unitPrice, availableQuantity: 3, imageUrl: "", imageUrls: [],
  }, seller);
}

await test("H: editing price and quantity leaves an existing order's snapshot and the seller due unchanged", async () => {
  const listingId = await publish("ثابتة", "FIXED");
  const order = await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `snapshot-order-${runId}` }, buyer);
  assert.equal(order.status, 201, order.text);
  const before = { subtotalMinor: order.data.subtotalMinor, platformFeeMinor: order.data.platformFeeMinor, sellerAmountMinor: order.data.sellerAmountMinor };
  assert.equal(before.subtotalMinor, 50_000);

  const edited = await edit(listingId, "FIXED", "80");
  assert.equal(edited.status, 200, edited.text);
  assert.equal(Number(edited.data.unitPrice), 80);

  const view = await request(`/orders/${order.data.id}`, "GET", undefined, buyer);
  assert.deepEqual(
    { subtotalMinor: view.data.subtotalMinor, platformFeeMinor: view.data.platformFeeMinor, sellerAmountMinor: view.data.sellerAmountMinor },
    before,
    "the order keeps the price it was created at",
  );

  assert.equal((await request(`/orders/${order.data.id}/accept`, "POST", {}, seller)).status, 200);
  const delivered = await request(`/orders/${order.data.id}/delivery`, "POST", { proofType: "CODE", proofToken: `SNAPSHOT-${runId}` }, seller);
  assert.equal(delivered.status, 200, delivered.text);
  const confirmed = await request(`/orders/${order.data.id}/confirm`, "POST", { received: true, issue: null }, buyer);
  assert.equal(confirmed.data.status, "COMPLETED", confirmed.text);
  const [due] = await db.select().from(sellerDues).where(eq(sellerDues.orderId, order.data.id));
  assert.equal(due!.amountMinor, before.platformFeeMinor, "the due is the snapshot fee, not one recomputed from 80");
  const [stored] = await db.select().from(orders).where(eq(orders.id, order.data.id));
  assert.equal(stored!.subtotalMinor, before.subtotalMinor);
});

await test("H (recorded): an accepted agreement followed by a price edit", async () => {
  const listingId = await publish("قابلة للتفاوض", "NEGOTIABLE");
  const opened = await openNegotiation({ buyerId: negotiator.id, listingId, amountMinor: 45_000, quantity: 1, market: JO });
  const accepted = await decideNegotiation({ actorId: seller.id, negotiationId: opened.id, decision: "ACCEPT", market: JO, expectedVersion: opened.version });
  assert.equal(accepted.status, "ACCEPTED");
  const edited = await edit(listingId, "NEGOTIABLE", "80");
  assert.equal(edited.status, 200, edited.text);
  const order = await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `snapshot-agreed-${runId}` }, negotiator);
  console.log("H_AGREEMENT_AFTER_EDIT", JSON.stringify({ status: order.status, subtotalMinor: order.data?.subtotalMinor ?? null, error: order.data?.error ?? null }));
  if (order.status === 201) assert.ok([45_000, 80_000].includes(order.data.subtotalMinor), "either the agreed or the current price, never anything else");
});

after(async () => {
  server.close();
  await pool.end();
});
