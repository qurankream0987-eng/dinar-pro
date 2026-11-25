/**
 * Wave 07 — flexible pricing, versioned commission and the append-only order financial
 * journal. Every financial assertion reads server state from PostgreSQL; HTTP responses
 * alone are never treated as proof.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  commissionPolicies,
  db,
  markets,
  orderFinancialEvents,
  orders,
  paymentIntents,
  pool,
  sellerDues,
} from "@workspace/db";
import app from "../src/app";
import { isMarketAvailable, resolveMarket } from "../src/lib/markets";
import {
  calculateCommissionMinor,
  COMMISSION_POLICY_KEY,
  commissionRateForOrder,
  commissionReversalForRefund,
  DEFAULT_COMMISSION_POLICY,
  resolveCommissionPolicy,
} from "../src/lib/commission-policy";
import {
  netCommissionDueMinor,
  recordOrderFinancialEvent,
} from "../src/lib/order-journal";
import { createRefundRequest, attachProviderRefundId } from "../src/lib/payments/service";
import { testOnlyPaymentAdapter } from "../src/lib/payments/test-adapter";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W07_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
const key = (label: string) => `w07-${label}-${runId}-${randomUUID().slice(0, 6)}`;

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
  const password = "w07-password-000000001";
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

const JO_ROW = (await db.select().from(markets).where(eq(markets.id, "JO")))[0]!;
const JO = await resolveMarket(JO_ROW);
const seller = await register("بائع دفتر W07");
const buyer = await register("مشتري دفتر W07");

async function publish(
  label: string,
  opts: { price?: string; quantity?: number } = {},
): Promise<string> {
  const created = await request(
    "/listings",
    "POST",
    {
      title: `${label} ${runId}`,
      description: `وصف تفصيلي لاختبار الدفتر المالي ${label} ${runId}`,
      category: "أخرى",
      categoryId: "other",
      area: "الصويفية",
      city: "عمّان",
      attributes: {},
      pricingMode: "FIXED",
      inventoryMode: "LIMITED",
      fulfilmentType: "PICKUP",
      unitPrice: opts.price ?? "20",
      availableQuantity: opts.quantity ?? 50,
      imageUrl: "",
      imageUrls: [],
      clientRequestId: randomUUID(),
    },
    seller,
  );
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

async function placeOrder(listingId: string, idempotencyKey = key("order")) {
  const created = await request(
    "/orders",
    "POST",
    { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey },
    buyer,
  );
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

const journal = (orderId: string) =>
  db
    .select()
    .from(orderFinancialEvents)
    .where(eq(orderFinancialEvents.orderId, orderId));
const types = (rows: Awaited<ReturnType<typeof journal>>) =>
  rows.map((row) => row.eventType).sort();

async function rolledBack<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  let outcome: T | undefined;
  try {
    await db.transaction(async (tx) => {
      outcome = await fn(tx);
      throw new Error("__W07_ROLLBACK__");
    });
  } catch (error) {
    if ((error as Error).message !== "__W07_ROLLBACK__") throw error;
  }
  return outcome as T;
}

await test("commission arithmetic is integer-only and refunds reverse cumulatively", () => {
  assert.equal(calculateCommissionMinor(20_000, DEFAULT_COMMISSION_POLICY), 1_000, "5% baseline (owner 2026-11-25)");
  assert.equal(calculateCommissionMinor(0, DEFAULT_COMMISSION_POLICY), 0);
  // 1 minor unit at 10% rounds half up to 0, never to a fraction of a unit.
  assert.equal(calculateCommissionMinor(1, DEFAULT_COMMISSION_POLICY), 0);
  assert.equal(
    commissionReversalForRefund({
      grossMinor: 20_000,
      previouslyRefundedMinor: 0,
      refundAmountMinor: 5_000,
      rateBasisPoints: 1_000,
    }),
    500,
  );
  assert.equal(
    commissionReversalForRefund({
      grossMinor: 20_000,
      previouslyRefundedMinor: 5_000,
      refundAmountMinor: 15_000,
      rateBasisPoints: 1_000,
    }),
    1_500,
    "two partial refunds give back exactly the whole commission, never more",
  );
  assert.equal(netCommissionDueMinor(2_000, 500), 1_500);
  assert.equal(netCommissionDueMinor(2_000, 5_000), 0);
  assert.throws(() =>
    commissionReversalForRefund({
      grossMinor: 100,
      previouslyRefundedMinor: 101,
      refundAmountMinor: 1,
      rateBasisPoints: 1_000,
    }),
  );
});

await test("an order without a policy snapshot keeps the rate it was charged", () => {
  assert.equal(
    commissionRateForOrder({
      data: { commissionPolicy: { rateBasisPoints: 750 } },
      platformFeeMinor: 1,
      subtotalMinor: 100,
    }),
    750,
  );
  assert.equal(
    commissionRateForOrder({
      data: { commissionRateBps: 1_200 },
      platformFeeMinor: 1,
      subtotalMinor: 100,
    }),
    1_200,
  );
  assert.equal(
    commissionRateForOrder({
      data: {},
      platformFeeMinor: 2_000,
      subtotalMinor: 20_000,
    }),
    1_000,
  );
});

await test("the published 5% market policy (0070) is in force; the 10% v1 row stays as immutable history", async () => {
  const resolved = await resolveCommissionPolicy(db, { marketId: "JO" });
  assert.equal(resolved.rateBasisPoints, 500, "owner decision 2026-11-25: 5% of the sale value");
  assert.equal(resolved.source, "PUBLISHED_MARKET");
  assert.ok(resolved.version > 1);
  assert.equal(resolved.policyKey, COMMISSION_POLICY_KEY);
  const [row] = await db
    .select()
    .from(commissionPolicies)
    .where(eq(commissionPolicies.id, "cmp_platform_commission_v1"));
  assert.equal(row?.status, "PUBLISHED");
  assert.equal(row?.rateBasisPoints, 1_000);
});

await test("a market-scoped published policy wins for that market only", async () => {
  const resolved = await rolledBack(async (tx) => {
    const marketId = `Z${randomUUID().slice(0, 8)}`;
    await tx.insert(markets).values({
      id: marketId,
      countryCode: marketId,
      countryNameAr: "سوق اختبار",
      countryNameEn: "Test market",
      currencyCode: "JOD",
      currencySymbolAr: "د.أ",
      minorUnitScale: 3,
      isActive: true,
      status: "ACTIVE",
    });
    await tx.insert(commissionPolicies).values({
      id: `cmp-test-${marketId}`,
      policyKey: COMMISSION_POLICY_KEY,
      version: 9_000,
      rateBasisPoints: 750,
      basis: "GROSS_ITEM_SUBTOTAL",
      roundingMode: "HALF_UP",
      marketId,
      status: "PUBLISHED",
      effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      contentHash: "test",
      publishedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const scoped = await resolveCommissionPolicy(tx, { marketId });
    const global = await resolveCommissionPolicy(tx, { marketId: "JO" });
    return { scoped, global };
  });
  assert.equal(resolved.scoped.rateBasisPoints, 750);
  assert.equal(resolved.scoped.version, 9_000);
  assert.equal(resolved.scoped.source, "PUBLISHED_MARKET");
  assert.equal(resolved.global.rateBasisPoints, 500, "JO resolves to its own 5% policy");
});

await test("market activation no longer depends on a historical market unit price", async () => {
  const activeWithoutPrice = await rolledBack(async (tx) => {
    const marketId = `Y${randomUUID().slice(0, 8)}`;
    await tx.insert(markets).values({
      id: marketId,
      countryCode: marketId,
      countryNameAr: "سوق بلا سعر تاريخي",
      countryNameEn: "No legacy price",
      currencyCode: "JOD",
      currencySymbolAr: "د.أ",
      minorUnitScale: 3,
      isActive: true,
      status: "ACTIVE",
      unitPriceMinor: null,
    });
    const [row] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, marketId));
    return isMarketAvailable(await resolveMarket(row!, tx));
  });
  assert.equal(activeWithoutPrice, true, "an active market without a legacy price sells listings");
  assert.equal(
    isMarketAvailable({
      ...JO,
      isActive: false,
      status: "COMING_SOON",
    } as typeof JO),
    false,
    "a closed market stays closed",
  );
});

await test("checkout journals the order under the resolved policy snapshot", async () => {
  const listingId = await publish("منتج الدخول");
  const orderId = await placeOrder(listingId);
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.ok(order);
  assert.equal(order.data.commissionRateBps, 500);
  assert.ok(order.data.commissionPolicy.version > 1, "the 0070 market policy, not v1");
  assert.equal(order.data.commissionPolicy.rateBasisPoints, 500);
  assert.equal(order.platformFeeMinor, 1_000);
  const rows = await journal(orderId);
  assert.deepEqual(types(rows), ["ORDER_CREATED"]);
  const created = rows[0]!;
  assert.equal(created.accountObligation, "BUYER_RECEIVABLE");
  assert.equal(created.amountMinor, order.subtotalMinor);
  assert.equal(created.currencyCode, order.currencyCode);
  assert.equal(created.actorType, "BUYER");
  assert.equal(created.actorId, buyer.id);
  assert.equal(created.businessRef, orderId);
});

await test("retrying checkout with the same key writes no second journal entry", async () => {
  const listingId = await publish("منتج التكرار");
  const idempotencyKey = key("retry");
  const first = await placeOrder(listingId, idempotencyKey);
  const second = await placeOrder(listingId, idempotencyKey);
  assert.equal(first, second);
  assert.equal((await journal(first)).length, 1);
});

await test("journal entries are append-only and idempotent by business key", async () => {
  const listingId = await publish("منتج الحماية");
  const orderId = await placeOrder(listingId);
  const [created] = await journal(orderId);
  await assert.rejects(
    pool.query("UPDATE order_financial_events SET amount_minor = 1 WHERE id = $1", [created.id]),
  );
  await assert.rejects(
    pool.query("DELETE FROM order_financial_events WHERE id = $1", [created.id]),
  );
  await assert.rejects(pool.query("TRUNCATE order_financial_events"));
  // A repeated business key with identical facts is the same entry.
  const repeat = await recordOrderFinancialEvent(db, {
    orderId,
    eventType: "ORDER_CREATED",
    accountObligation: "BUYER_RECEIVABLE",
    businessRef: orderId,
    actorType: "BUYER",
    actorId: buyer.id,
    currencyCode: created.currencyCode,
    amountMinor: created.amountMinor,
    idempotencyKey: created.idempotencyKey,
  });
  assert.equal(repeat.id, created.id);
  // The same key with different facts is refused.
  await assert.rejects(
    recordOrderFinancialEvent(db, {
      orderId,
      eventType: "ORDER_CREATED",
      accountObligation: "BUYER_RECEIVABLE",
      businessRef: orderId,
      actorType: "BUYER",
      actorId: buyer.id,
      currencyCode: created.currencyCode,
      amountMinor: created.amountMinor + 1,
      idempotencyKey: created.idempotencyKey,
    }),
  );
});

await test("completion accrues commission and seller payable; cancellation never accrues", async () => {
  const listingId = await publish("منتج الإتمام");
  const orderId = await placeOrder(listingId);
  const intentResponse = await request(
    "/payments/intents",
    "POST",
    { orderId },
    buyer,
    { "Idempotency-Key": key("intent") },
  );
  assert.equal(intentResponse.status, 201, intentResponse.text);
  const [intent] = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, intentResponse.data.id));
  const capture = testOnlyPaymentAdapter.createCaptureWebhook(intent!.providerIntentId);
  const captured = await request("/payments/webhooks/test", "POST", capture.event, undefined, {
    "X-Payment-Signature": capture.signature,
  });
  assert.equal(captured.status, 200, captured.text);
  assert.equal(
    (await request(`/orders/${orderId}/accept`, "POST", {}, seller)).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/orders/${orderId}/delivery`,
        "POST",
        { proofType: "CODE", proofToken: `W07-${runId}` },
        seller,
      )
    ).status,
    200,
  );
  const confirmed = await request(
    `/orders/${orderId}/confirm`,
    "POST",
    { received: true },
    buyer,
  );
  assert.equal(confirmed.status, 200, confirmed.text);
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.equal(order!.status, "COMPLETED");
  const rows = await journal(orderId);
  assert.deepEqual(types(rows), [
    "COMMISSION_ACCRUED",
    "ORDER_COMPLETED",
    "ORDER_CREATED",
    "PAYMENT_CAPTURED",
    "SELLER_PAYABLE_DUE",
  ]);
  const accrued = rows.find((row) => row.eventType === "COMMISSION_ACCRUED")!;
  const payable = rows.find((row) => row.eventType === "SELLER_PAYABLE_DUE")!;
  assert.equal(accrued.amountMinor, order!.platformFeeMinor);
  assert.equal(accrued.accountObligation, "PLATFORM_COMMISSION");
  assert.equal(accrued.amountMinor, 1_000);
  assert.equal(payable.amountMinor, order!.sellerAmountMinor);
  assert.equal(payable.amountMinor, 19_000);
  const [due] = await db
    .select()
    .from(sellerDues)
    .where(eq(sellerDues.orderId, orderId));
  assert.equal(due!.amountMinor, order!.platformFeeMinor);

  const cancelledListing = await publish("منتج الإلغاء");
  const cancelledOrder = await placeOrder(cancelledListing);
  const cancelled = await request(
    `/orders/${cancelledOrder}/cancel`,
    "POST",
    { reason: "غيّر المشتري رأيه قبل بدء التنفيذ" },
    buyer,
  );
  assert.equal(cancelled.status, 200, cancelled.text);
  const cancelledRows = await journal(cancelledOrder);
  assert.deepEqual(types(cancelledRows), ["ORDER_CANCELLED", "ORDER_CREATED"]);
  assert.equal(
    (await db.select().from(sellerDues).where(eq(sellerDues.orderId, cancelledOrder)))
      .length,
    0,
    "no commission is collected on a cancelled order",
  );
});

await test("a refund after completion reverses the commission on the refunded part", async () => {
  const listingId = await publish("منتج الاسترداد");
  const orderId = await placeOrder(listingId);
  const intentResponse = await request(
    "/payments/intents",
    "POST",
    { orderId },
    buyer,
    { "Idempotency-Key": key("intent") },
  );
  assert.equal(intentResponse.status, 201, intentResponse.text);
  const [intent] = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, intentResponse.data.id));
  const capture = testOnlyPaymentAdapter.createCaptureWebhook(intent!.providerIntentId);
  assert.equal(
    (
      await request("/payments/webhooks/test", "POST", capture.event, undefined, {
        "X-Payment-Signature": capture.signature,
      })
    ).status,
    200,
  );
  assert.equal((await request(`/orders/${orderId}/accept`, "POST", {}, seller)).status, 200);
  assert.equal(
    (
      await request(
        `/orders/${orderId}/delivery`,
        "POST",
        { proofType: "CODE", proofToken: `W07R-${runId}` },
        seller,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/orders/${orderId}/confirm`, "POST", { received: true }, buyer))
      .status,
    200,
  );
  const refundAmount = 5_000;
  const refund = await createRefundRequest({
    paymentIntentId: intent!.id,
    idempotencyKey: key("refund"),
    amountMinor: refundAmount,
    reason: "استرداد جزئي بعد الاكتمال",
  });
  const webhook = testOnlyPaymentAdapter.createRefundWebhook({
    providerIntentId: intent!.providerIntentId,
    amountMinor: refundAmount,
    currencyCode: intent!.currencyCode,
    idempotencyKey: key("refund-provider"),
  });
  await attachProviderRefundId(refund.id, (webhook.event as any).providerRefundId);
  const refunded = await request("/payments/webhooks/test", "POST", webhook.event, undefined, {
    "X-Payment-Signature": webhook.signature,
  });
  assert.equal(refunded.status, 200, refunded.text);
  const rows = await journal(orderId);
  const reversed = rows.find((row) => row.eventType === "COMMISSION_REVERSED");
  assert.ok(reversed, "a refund after completion reverses commission");
  assert.equal(reversed!.amountMinor, 250);
  assert.equal(reversed!.accountObligation, "PLATFORM_COMMISSION");
  assert.ok(
    rows.some(
      (row) =>
        row.eventType === "COMMISSION_ACCRUED" &&
        reversed!.reversesEventId === row.id,
    ),
    "the reversal links to the accrual it corrects",
  );
  assert.ok(rows.some((row) => row.eventType === "PAYMENT_REFUNDED" && row.amountMinor === refundAmount));
  const accrued = rows.find((row) => row.eventType === "COMMISSION_ACCRUED")!;
  assert.equal(netCommissionDueMinor(accrued.amountMinor, reversed!.amountMinor), 750);
});

after(async () => {
  server.close();
  await pool.end();
});
