/**
 * W12.1 — isolated hardening suite for the wave 07–12 surface. It closes the four
 * coverage gaps found in the wave reports: anonymous access on every new route,
 * idempotency-key replay across orders, concurrent cash refunds against one payment,
 * and a market that disables cash after the order exists.
 *
 * It is additive: no existing suite, route, migration or generated client is changed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  cashPaymentClaims,
  cashRefundCases,
  db,
  markets,
  orders,
  pool,
  users,
} from "@workspace/db";
import app from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W12C_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
const key = (label: string) => `w12c-${label}-${runId}-${randomUUID().slice(0, 6)}`;

type Actor = { id: string; cookie: string };
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  actor?: Actor,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined
        ? { "content-type": "application/json", origin }
        : {}),
      ...(actor ? { cookie: actor.cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

let phoneCounter = 0;
async function register(name: string): Promise<Actor> {
  const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}${String(phoneCounter++ % 10)}`;
  const password = "w12c-password-00000001";
  const response = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      displayName: name,
      phoneCountryCode: "+962",
      phoneNumber: number,
      accountCountry: "JO",
      password,
      confirmPassword: password,
      acceptTerms: true,
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("bdinar_session="))!
    .split(";")[0]!;
  return { id: JSON.parse(text).user.id, cookie };
}

const seller = await register("بائع تحقق W12C");
const buyer = await register("مشتري تحقق W12C");

async function publish(label: string): Promise<string> {
  const created = await request(
    "/listings",
    "POST",
    {
      title: `${label} ${runId}`,
      description: `وصف تفصيلي لاختبار التحقق قبل التكامل ${label} ${runId}`,
      category: "أخرى",
      categoryId: "other",
      area: "الصويفية",
      city: "عمّان",
      attributes: {},
      pricingMode: "FIXED",
      inventoryMode: "LIMITED",
      fulfilmentType: "PICKUP",
      unitPrice: "20",
      availableQuantity: 50,
      imageUrl: "",
      imageUrls: [],
      clientRequestId: randomUUID(),
    },
    seller,
  );
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

async function placeOrder(listingId: string) {
  const created = await request(
    "/orders",
    "POST",
    { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("order") },
    buyer,
  );
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

async function acceptedOrder(label: string) {
  const orderId = await placeOrder(await publish(label));
  const accepted = await request(`/orders/${orderId}/accept`, "POST", {}, seller);
  assert.equal(accepted.status, 200, accepted.text);
  return orderId;
}

const claimCash = (orderId: string, idempotencyKey = key("claim")) =>
  request(
    `/orders/${orderId}/cash-payment/claim`,
    "POST",
    { note: "دفعت المبلغ نقدًا عند التسليم" },
    buyer,
    { "Idempotency-Key": idempotencyKey },
  );

const confirmCash = (orderId: string) =>
  request(`/orders/${orderId}/cash-payment/confirm`, "POST", { note: "استلمت المبلغ نقدًا" }, seller);

async function confirmedCashOrder(label: string) {
  const orderId = await acceptedOrder(label);
  assert.equal((await claimCash(orderId)).status, 201);
  assert.equal((await confirmCash(orderId)).status, 200);
  return orderId;
}

const openRefund = (orderId: string, amountMinor: number, idempotencyKey = key("refund")) =>
  request(
    `/orders/${orderId}/cash-refunds`,
    "POST",
    { amountMinor, reason: "سداد جزئي بعد اتفاق", evidence: [] },
    buyer,
    { "Idempotency-Key": idempotencyKey },
  );

async function orderRow(orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.ok(row, `order ${orderId} exists`);
  return row;
}

// ─── 1. Anonymous callers never reach a wave 07–12 handler ───────────────────

await test("every wave 07–12 authenticated route answers 401 before doing any work", async () => {
  const routes: Array<[string, string]> = [
    ["POST", "/orders/any/cash-payment/claim"],
    ["POST", "/orders/any/cash-payment/confirm"],
    ["POST", "/orders/any/cash-payment/deny"],
    ["POST", "/orders/any/cash-payment/dispute"],
    ["GET", "/orders/any/cash"],
    ["POST", "/orders/any/cash-refunds"],
    ["POST", "/cash-refunds/any/repayment-claim"],
    ["POST", "/cash-refunds/any/confirm"],
    ["POST", "/cash-refunds/any/dispute"],
    ["POST", "/cash-refunds/any/withdraw"],
    ["GET", "/account/policy-consents"],
    ["POST", "/account/policy-decisions"],
    ["GET", "/account/policy-acceptances"],
    ["POST", "/account/policy-acceptances"],
    ["GET", "/account/compliance"],
    ["POST", "/account/age-declaration"],
    ["POST", "/account/guardian-consent"],
    ["GET", "/account/seller-verification"],
    ["POST", "/account/seller-verification"],
    ["GET", "/account/support/cases"],
    ["POST", "/account/support/cases"],
    ["GET", "/account/whatsapp/consent"],
    ["POST", "/account/whatsapp/consent"],
    ["POST", "/reports"],
    ["GET", "/reports/mine"],
    ["GET", "/admin/compliance/policies"],
    ["POST", "/admin/compliance/policies"],
    ["GET", "/admin/compliance/markets"],
    ["GET", "/admin/compliance/legal-entities"],
    ["GET", "/admin/compliance/seller-verifications"],
    ["GET", "/admin/support/cases"],
    ["GET", "/admin/fraud/signals"],
    ["GET", "/admin/whatsapp/templates"],
    ["GET", "/admin/reports"],
  ];
  for (const [method, path] of routes) {
    const response = await request(
      path,
      method,
      method === "GET" ? undefined : {},
    );
    assert.equal(response.status, 401, `${method} ${path}: ${response.status} ${response.text}`);
  }
});

// ─── 2. An idempotency key is bound to one order, not just one actor ──────────
// A replay of the same buyer's key on a second order must be refused, never
// answered with the first order's claim or refund case.

await test("a cash claim key replayed on another order is refused, not silently re-scoped", async () => {
  const firstOrder = await acceptedOrder("تكرار المفتاح أ");
  const secondOrder = await acceptedOrder("تكرار المفتاح ب");
  const idempotencyKey = key("shared-claim");

  const first = await claimCash(firstOrder, idempotencyKey);
  assert.equal(first.status, 201, first.text);

  const replay = await claimCash(secondOrder, idempotencyKey);
  assert.equal(replay.status, 409, replay.text);
  assert.equal(replay.data.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(
    (await db.select().from(cashPaymentClaims).where(eq(cashPaymentClaims.orderId, secondOrder))).length,
    0,
    "the second order keeps no claim from the replayed key",
  );
});

await test("a cash refund key replayed on another order is refused", async () => {
  const firstOrder = await confirmedCashOrder("استرداد مفتاح أ");
  const secondOrder = await confirmedCashOrder("استرداد مفتاح ب");
  const idempotencyKey = key("shared-refund");

  const first = await openRefund(firstOrder, 1_000, idempotencyKey);
  assert.equal(first.status, 201, first.text);

  const replay = await openRefund(secondOrder, 1_000, idempotencyKey);
  assert.equal(replay.status, 409, replay.text);
  assert.equal(replay.data.code, "IDEMPOTENCY_KEY_REUSED");
});

// ─── 3. Concurrent refunds cannot overshoot the confirmed cash ───────────────

await test("two concurrent refund openings never exceed the confirmed cash", async () => {
  const orderId = await confirmedCashOrder("تزامن الاسترداد");
  const paid = (await orderRow(orderId)).subtotalMinor;
  const overHalf = Math.floor(paid / 2) + 1;
  assert.ok(overHalf * 2 > paid);

  const [left, right] = await Promise.all([
    openRefund(orderId, overHalf, key("race-left")),
    openRefund(orderId, overHalf, key("race-right")),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.deepEqual(statuses, [201, 409], `${left.text} | ${right.text}`);

  const rows = await db.select().from(cashRefundCases).where(eq(cashRefundCases.orderId, orderId));
  const held = rows
    .filter((row) => ["OPEN", "REPAYMENT_CLAIMED", "CONFIRMED", "DISPUTED"].includes(row.status))
    .reduce((sum, row) => sum + row.amountMinor, 0);
  assert.ok(held <= paid, `refunds held ${held} exceed paid ${paid}`);
});

// ─── 4. Cash capability follows the order's market, including a later change ─

await test("a market that turns cash off refuses new claims and refunds on existing orders", async () => {
  const orderId = await confirmedCashOrder("سوق أوقف النقد");
  const openOrderId = await acceptedOrder("سوق أوقف النقد ٢");
  const marketId = (await orderRow(orderId)).marketId;
  const [market] = await db.select().from(markets).where(eq(markets.id, marketId));
  assert.ok(market);
  const originalMethods = market.paymentMethods;

  try {
    await db
      .update(markets)
      .set({ paymentMethods: ["CARD"] })
      .where(eq(markets.id, marketId));

    const claim = await claimCash(openOrderId);
    assert.equal(claim.status, 409, claim.text);
    assert.equal(claim.data.code, "CASH_NOT_SUPPORTED");

    const refund = await openRefund(orderId, 1_000, key("disabled-market"));
    assert.equal(refund.status, 409, refund.text);
    assert.equal(refund.data.code, "CASH_NOT_SUPPORTED");

    const view = await request(`/orders/${orderId}/cash`, "GET", undefined, buyer);
    assert.equal(view.status, 200, "the recorded cash payment stays readable");
    assert.equal(view.data.claim.status, "CONFIRMED");
  } finally {
    await db
      .update(markets)
      .set({ paymentMethods: originalMethods })
      .where(eq(markets.id, marketId));
  }

  const afterRestore = await openRefund(orderId, 1_000, key("restored-market"));
  assert.equal(afterRestore.status, 201, afterRestore.text);
});

await test("a party in another market still settles their own order; the order's market governs cash", async () => {
  const orderId = await acceptedOrder("سوق مختلف");
  const claimed = await claimCash(orderId);
  assert.equal(claimed.status, 201, claimed.text);

  const otherMarketId = `market-w12c-${runId}`;
  await db.insert(markets).values({
    id: otherMarketId,
    countryCode: `W${runId.slice(0, 3).toUpperCase()}`,
    countryNameAr: "سوق اختبار W12C",
    countryNameEn: "W12C test market",
    currencyCode: "USD",
    currencySymbolAr: "$",
    minorUnitScale: 2,
    unitPriceMinor: 100,
    isActive: true,
    status: "ACTIVE",
    fulfilmentMethods: ["PICKUP"],
    paymentMethods: ["CARD"],
  });
  const [before] = await db
    .select({ marketId: users.activeMarketId })
    .from(users)
    .where(eq(users.id, seller.id));
  try {
    await db
      .update(users)
      .set({ activeMarketId: otherMarketId })
      .where(eq(users.id, seller.id));

    const view = await request(`/orders/${orderId}/cash`, "GET", undefined, seller);
    assert.equal(view.status, 200, view.text);
    assert.equal(view.data.claim.status, "CLAIMED");

    // The order lives in the cash market, so the seller in the card-only market can
    // still attest it. The capability is the order's market, not the cookie's.
    const confirmed = await confirmCash(orderId);
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.data.claim.status, "CONFIRMED");
  } finally {
    await db
      .update(users)
      .set({ activeMarketId: before!.marketId })
      .where(eq(users.id, seller.id));
  }
});

after(async () => {
  server.close();
  await pool.end();
});
