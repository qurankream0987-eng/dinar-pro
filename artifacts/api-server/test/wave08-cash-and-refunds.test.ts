/**
 * Wave 08 — direct cash and the separate cash refund engine. A buyer click is a claim;
 * only the seller attests cash receipt, and only the buyer attests receiving a repayment.
 * Every assertion reads PostgreSQL, never just an HTTP response.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  cashPaymentClaims,
  cashRefundCases,
  db,
  orderFinancialEvents,
  orders,
  pool,
  sellerDues,
} from "@workspace/db";
import app from "../src/app";
import {
  getMarketCapabilityProfile,
  marketAllowsCashDirect,
} from "../src/lib/market-capability-registry";
import { cashEngineEnabled } from "../src/lib/payments/cash";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W08_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
// Digit-free on purpose: this token is interpolated into the listing title and description (publish
// below), and findListingContactText scans those fields for phone numbers against the market's
// default country. A raw hex slice can be all digits (~2% of runs) and then reads as a Jordanian
// number, failing every publish with LISTING_CONTACT_TEXT. Sibling suites that put a run token into
// contact-scanned text strip digits the same way; ASCII is kept because runId also builds idempotency
// keys and a delivery proof CODE.
const runId = randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 8);
const key = (label: string) => `w08-${label}-${runId}-${randomUUID().slice(0, 6)}`;

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
  const password = "w08-password-000000001";
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

const seller = await register("بائع نقد W08");
const buyer = await register("مشتري نقد W08");
const stranger = await register("غريب نقد W08");

async function publish(label: string): Promise<string> {
  const created = await request(
    "/listings",
    "POST",
    {
      title: `${label} ${runId}`,
      description: `وصف تفصيلي لاختبار الدفع النقدي ${label} ${runId}`,
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

async function acceptedOrder(label: string): Promise<string> {
  const listingId = await publish(label);
  const orderId = await placeOrder(listingId);
  const accepted = await request(`/orders/${orderId}/accept`, "POST", {}, seller);
  assert.equal(accepted.status, 200, accepted.text);
  return orderId;
}

async function claimCash(orderId: string, idempotencyKey = key("claim")) {
  return request(
    `/orders/${orderId}/cash-payment/claim`,
    "POST",
    { note: "دفعت المبلغ نقدًا عند التسليم" },
    buyer,
    { "Idempotency-Key": idempotencyKey },
  );
}

async function confirmCash(orderId: string) {
  return request(
    `/orders/${orderId}/cash-payment/confirm`,
    "POST",
    { note: "استلمت المبلغ نقدًا" },
    seller,
  );
}

async function confirmedCashOrder(label: string): Promise<string> {
  const orderId = await acceptedOrder(label);
  assert.equal((await claimCash(orderId)).status, 201);
  assert.equal((await confirmCash(orderId)).status, 200);
  return orderId;
}

async function openRefund(
  orderId: string,
  amountMinor: number,
  idempotencyKey = key("refund"),
) {
  return request(
    `/orders/${orderId}/cash-refunds`,
    "POST",
    { amountMinor, reason: "اتفاق على استرداد نقدي جزئي" },
    buyer,
    { "Idempotency-Key": idempotencyKey },
  );
}

async function claimRepayment(refundId: string) {
  return request(
    `/cash-refunds/${refundId}/repayment-claim`,
    "POST",
    { note: "سلّمت المبلغ نقدًا للمشتري" },
    seller,
  );
}

async function confirmRepayment(refundId: string) {
  return request(`/cash-refunds/${refundId}/confirm`, "POST", {}, buyer);
}

const journal = (orderId: string) =>
  db
    .select()
    .from(orderFinancialEvents)
    .where(eq(orderFinancialEvents.orderId, orderId));
const types = (rows: Awaited<ReturnType<typeof journal>>) =>
  rows.map((row) => row.eventType).sort();
const orderRow = async (orderId: string) =>
  (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;

await test("cash is implemented but available only in a development environment", () => {
  assert.equal(cashEngineEnabled(), true);
  const market = {
    id: "market-xx",
    countryCode: "XX",
    currencyCode: "JOD",
    minorUnitScale: 3,
    paymentMethods: ["CASH_DIRECT"],
    fulfilmentMethods: ["PICKUP"],
  };
  const development = getMarketCapabilityProfile(market, "development");
  assert.equal(development.payments.cashDirect.marketPolicyEnabled, true);
  assert.equal(development.payments.cashDirect.engineImplemented, true);
  assert.equal(development.payments.cashDirect.available, true);
  assert.equal(development.payments.cashDirect.environment, "DEVELOPMENT_ONLY");
  const production = getMarketCapabilityProfile(market, "production");
  assert.equal(production.payments.cashDirect.available, false);
  assert.equal(production.payments.cashDirect.environment, "UNAVAILABLE");
  assert.equal(
    getMarketCapabilityProfile(
      { ...market, paymentMethods: [] },
      "development",
    ).payments.cashDirect.available,
    false,
  );
  assert.equal(marketAllowsCashDirect({ paymentMethods: ["CARD"] }), false);
});

await test("a buyer cash claim is an unverified claim, not a payment entry", async () => {
  const orderId = await acceptedOrder("ادعاء غير مؤكد");
  const claimed = await claimCash(orderId);
  assert.equal(claimed.status, 201, claimed.text);
  assert.equal(claimed.data.claim.status, "CLAIMED");
  assert.equal(claimed.data.claim.verification, "UNVERIFIED_BUYER_CLAIM");
  const order = await orderRow(orderId);
  assert.equal(claimed.data.claim.amountMinor, order.subtotalMinor);
  assert.equal(claimed.data.claim.currencyCode, order.currencyCode);
  assert.deepEqual(types(await journal(orderId)), ["ORDER_CREATED"]);
  assert.equal(
    (await db.select().from(sellerDues).where(eq(sellerDues.orderId, orderId)))
      .length,
    0,
  );
  const [row] = await db
    .select()
    .from(cashPaymentClaims)
    .where(eq(cashPaymentClaims.orderId, orderId));
  assert.equal(row!.decidedAt, null);
  assert.equal(row!.decidedBy, null);
});

await test("only the seller decides a claim and only the buyer may dispute it", async () => {
  const orderId = await acceptedOrder("فصل الأدوار");
  const claimed = await claimCash(orderId);
  assert.equal(claimed.status, 201, claimed.text);

  assert.equal(
    (await request(
      `/orders/${orderId}/cash-payment/claim`,
      "POST",
      {},
      seller,
      { "Idempotency-Key": key("seller-claim") },
    )).status,
    404,
    "the seller cannot claim the buyer paid",
  );
  assert.equal(
    (await request(
      `/orders/${orderId}/cash-payment/confirm`,
      "POST",
      {},
      buyer,
    )).status,
    404,
    "the buyer cannot attest their own cash",
  );
  assert.equal(
    (await request(
      `/orders/${orderId}/cash-payment/confirm`,
      "POST",
      {},
      stranger,
    )).status,
    404,
  );

  const denied = await request(
    `/orders/${orderId}/cash-payment/deny`,
    "POST",
    { reason: "لم أستلم أي مبلغ نقدي" },
    seller,
  );
  assert.equal(denied.status, 200, denied.text);
  assert.equal(denied.data.claim.status, "DENIED");
  assert.equal(denied.data.claim.verification, "SELLER_DENIED");

  const disputed = await request(
    `/orders/${orderId}/cash-payment/dispute`,
    "POST",
    { reason: "المبلغ سُلّم فعليًا وأطلب التحقق" },
    buyer,
  );
  assert.equal(disputed.status, 200, disputed.text);
  assert.equal(disputed.data.claim.status, "DISPUTED");
  assert.equal(
    (await request(
      `/orders/${orderId}/cash-payment/confirm`,
      "POST",
      {},
      seller,
    )).status,
    409,
    "a disputed claim cannot be confirmed",
  );
  assert.deepEqual(types(await journal(orderId)), ["ORDER_CREATED"]);
});

await test("seller confirmation is the only cash payment attestation and is idempotent", async () => {
  const orderId = await acceptedOrder("تأكيد البائع");
  const claimed = await claimCash(orderId);
  assert.equal(claimed.status, 201, claimed.text);

  const confirmed = await confirmCash(orderId);
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.data.claim.status, "CONFIRMED");
  assert.equal(confirmed.data.claim.verification, "SELLER_ATTESTED");

  const order = await orderRow(orderId);
  assert.equal(order.data.paymentMode, "CASH_DIRECT");
  assert.equal(order.data.selectedPaymentMethod, "CASH_DIRECT");
  assert.equal(order.data.cashPayment.claimId, claimed.data.claim.id);
  assert.equal(order.data.cashPayment.verification, "SELLER_ATTESTED");

  const rows = await journal(orderId);
  assert.deepEqual(types(rows), ["ORDER_CREATED", "PAYMENT_CAPTURED"]);
  const captured = rows.find((row) => row.eventType === "PAYMENT_CAPTURED")!;
  assert.equal(captured.amountMinor, order.subtotalMinor);
  assert.equal(captured.actorType, "SELLER");
  assert.equal(captured.actorId, seller.id);
  assert.equal(captured.accountObligation, "BUYER_PAYMENT");
  assert.equal(
    captured.authorizationContext.source,
    "CASH_DIRECT_SELLER_CONFIRMATION",
  );

  const repeat = await confirmCash(orderId);
  assert.equal(repeat.status, 200, repeat.text);
  assert.equal(repeat.data.confirmed, false);
  assert.equal((await journal(orderId)).length, 2, "no duplicate capture entry");
  assert.equal(
    (await db.select().from(sellerDues).where(eq(sellerDues.orderId, orderId)))
      .length,
    0,
    "cash receipt alone does not accrue a completed-sale due",
  );
});

await test("cash claims are idempotent, order-scoped and refuse an electronic conflict", async () => {
  const orderId = await acceptedOrder("تكرار الادعاء");
  const idempotencyKey = key("same-claim");
  const first = await claimCash(orderId, idempotencyKey);
  assert.equal(first.status, 201, first.text);
  const second = await claimCash(orderId, idempotencyKey);
  assert.equal(second.status, 200, second.text);
  assert.equal(second.data.created, false);
  assert.equal(second.data.claim.id, first.data.claim.id);
  assert.equal(
    (await claimCash(orderId, key("other-claim"))).status,
    409,
    "one claim per order",
  );

  const createdOrder = await placeOrder(await publish("ادعاء قبل القبول"));
  assert.equal(
    (await claimCash(createdOrder)).status,
    409,
    "cash cannot be claimed before the seller accepts",
  );

  const electronicOrder = await placeOrder(await publish("تعارض إلكتروني"));
  const intent = await request(
    "/payments/intents",
    "POST",
    { orderId: electronicOrder },
    buyer,
    { "Idempotency-Key": key("intent") },
  );
  assert.equal(intent.status, 201, intent.text);
  assert.equal(
    (await request(`/orders/${electronicOrder}/accept`, "POST", {}, seller))
      .status,
    200,
  );
  assert.equal(
    (await claimCash(electronicOrder)).status,
    409,
    "a pending electronic intent blocks cash claims",
  );
});

await test("cash claim facts are immutable and rows cannot be deleted", async () => {
  const orderId = await acceptedOrder("حماية الادعاء");
  const claimed = await claimCash(orderId);
  const claimId = claimed.data.claim.id as string;
  await assert.rejects(
    pool.query(
      "UPDATE cash_payment_claims SET amount_minor = amount_minor + 1 WHERE id = $1",
      [claimId],
    ),
  );
  await assert.rejects(
    pool.query("DELETE FROM cash_payment_claims WHERE id = $1", [claimId]),
  );
  await assert.rejects(pool.query("TRUNCATE cash_payment_claims"));
  const order = await orderRow(orderId);
  await assert.rejects(
    pool.query(
      `INSERT INTO cash_payment_claims
        (id, order_id, buyer_id, seller_id, amount_minor, currency_code, status, evidence, idempotency_key, mode)
       VALUES ($1, $2, $3, $4, $5, 'USD', 'CLAIMED', '[]'::jsonb, $6, 'CASH_DIRECT')`,
      [
        randomUUID(),
        orderId,
        buyer.id,
        seller.id,
        order.subtotalMinor,
        key("raw-claim"),
      ],
    ),
    "a claim in another currency is refused by the guard",
  );
});

await test("a cash refund case can exist before any repayment is claimed", async () => {
  const orderId = await confirmedCashOrder("استرداد قبل السداد");
  const opened = await openRefund(orderId, 5_000);
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.data.refund.status, "OPEN");
  assert.equal(opened.data.refund.verification, "OPEN");
  assert.equal(opened.data.refund.repaymentClaimedAt, null);
  assert.equal(opened.data.refund.buyerConfirmedAt, null);
  const rows = await journal(orderId);
  assert.deepEqual(types(rows), ["ORDER_CREATED", "PAYMENT_CAPTURED"]);
  assert.equal(
    rows.some((row) => row.eventType === "PAYMENT_REFUNDED"),
    false,
    "opening a case is not a refund",
  );
  const view = await request(`/orders/${orderId}/cash`, "GET", undefined, buyer);
  assert.equal(view.status, 200, view.text);
  assert.equal(view.data.claim.status, "CONFIRMED");
  assert.equal(view.data.refundCases.length, 1);
  assert.equal(
    (await request(`/orders/${orderId}/cash`, "GET", undefined, stranger)).status,
    404,
  );
});

await test("cash refunds are idempotent and cannot exceed the confirmed cash", async () => {
  const orderId = await confirmedCashOrder("سقف الاسترداد");
  const idempotencyKey = key("refund-key");
  const first = await openRefund(orderId, 15_000, idempotencyKey);
  assert.equal(first.status, 201, first.text);
  const repeat = await openRefund(orderId, 15_000, idempotencyKey);
  assert.equal(repeat.status, 200, repeat.text);
  assert.equal(repeat.data.created, false);
  assert.equal(repeat.data.refund.id, first.data.refund.id);
  assert.equal(
    (await openRefund(orderId, 14_999, idempotencyKey)).status,
    409,
    "the same key with a new amount is refused",
  );
  assert.equal(
    (await openRefund(orderId, 10_000, key("second-refund"))).status,
    409,
    "reserved refunds count against the paid cash",
  );
  assert.equal(
    (await openRefund(orderId, 20_001, key("over-refund"))).status,
    409,
  );
  const withdrawn = await request(
    `/cash-refunds/${first.data.refund.id}/withdraw`,
    "POST",
    {},
    buyer,
  );
  assert.equal(withdrawn.status, 200, withdrawn.text);
  assert.equal(withdrawn.data.refund.status, "WITHDRAWN");
  assert.equal(
    (await openRefund(orderId, 20_000, key("after-withdraw"))).status,
    201,
    "withdrawing frees the reserved amount",
  );
});

await test("a seller repayment claim stays unverified until the buyer confirms receipt", async () => {
  const orderId = await confirmedCashOrder("سداد غير مؤكد");
  const opened = await openRefund(orderId, 5_000);
  const refundId = opened.data.refund.id as string;

  assert.equal(
    (await confirmRepayment(refundId)).status,
    409,
    "there is nothing to confirm before a repayment claim",
  );
  const claimed = await claimRepayment(refundId);
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.data.refund.status, "REPAYMENT_CLAIMED");
  assert.equal(
    claimed.data.refund.verification,
    "UNVERIFIED_SELLER_REPAYMENT_CLAIM",
  );
  assert.equal(
    (await journal(orderId)).some((row) => row.eventType === "PAYMENT_REFUNDED"),
    false,
    "a seller claim is not a refund",
  );
  assert.equal(
    (await request(`/cash-refunds/${refundId}/confirm`, "POST", {}, seller)).status,
    404,
    "the seller cannot confirm their own repayment",
  );
  assert.equal(
    (await request(
      `/cash-refunds/${refundId}/repayment-claim`,
      "POST",
      { note: "محاولة من المشتري" },
      buyer,
    )).status,
    404,
  );

  const confirmed = await confirmRepayment(refundId);
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.data.refund.status, "CONFIRMED");
  assert.equal(confirmed.data.refund.verification, "BUYER_ATTESTED_REPAYMENT");
  const rows = await journal(orderId);
  const refunded = rows.find((row) => row.eventType === "PAYMENT_REFUNDED")!;
  assert.equal(refunded.amountMinor, 5_000);
  assert.equal(refunded.actorType, "BUYER");
  assert.equal(
    refunded.authorizationContext.source,
    "CASH_REFUND_BUYER_CONFIRMATION",
  );
  const repeat = await confirmRepayment(refundId);
  assert.equal(repeat.status, 200, repeat.text);
  assert.equal(repeat.data.confirmed, false);
  assert.equal(
    (await journal(orderId)).filter((row) => row.eventType === "PAYMENT_REFUNDED")
      .length,
    1,
  );
});

await test("a disputed repayment never records a refund", async () => {
  const orderId = await confirmedCashOrder("نزاع السداد");
  const opened = await openRefund(orderId, 5_000);
  const refundId = opened.data.refund.id as string;
  assert.equal((await claimRepayment(refundId)).status, 200);
  const disputed = await request(
    `/cash-refunds/${refundId}/dispute`,
    "POST",
    { reason: "لم أستلم أي مبلغ نقدي حتى الآن" },
    buyer,
  );
  assert.equal(disputed.status, 200, disputed.text);
  assert.equal(disputed.data.refund.status, "DISPUTED");
  assert.equal(
    (await journal(orderId)).some((row) => row.eventType === "PAYMENT_REFUNDED"),
    false,
  );
  assert.equal(
    (await openRefund(orderId, 20_000, key("full-while-disputed"))).status,
    409,
    "a disputed repayment still reserves the paid cash",
  );
  assert.equal(
    (await openRefund(orderId, 15_000, key("remaining-while-disputed"))).status,
    201,
  );
  assert.equal((await confirmRepayment(refundId)).status, 409);
  assert.equal((await claimRepayment(refundId)).status, 409);
});

await test("completion reverses commission for cash refunds before and after it", async () => {
  const orderId = await confirmedCashOrder("استرداد مع الإتمام");
  const before = await openRefund(orderId, 5_000);
  assert.equal(before.status, 201, before.text);
  assert.equal((await claimRepayment(before.data.refund.id)).status, 200);
  assert.equal((await confirmRepayment(before.data.refund.id)).status, 200);

  const delivered = await request(
    `/orders/${orderId}/delivery`,
    "POST",
    { proofType: "CODE", proofToken: `W08-${runId}` },
    seller,
  );
  assert.equal(delivered.status, 200, delivered.text);
  const completed = await request(
    `/orders/${orderId}/confirm`,
    "POST",
    { received: true },
    buyer,
  );
  assert.equal(completed.status, 200, completed.text);
  const order = await orderRow(orderId);
  assert.equal(order.status, "COMPLETED");

  const rows = await journal(orderId);
  assert.deepEqual(types(rows), [
    "COMMISSION_ACCRUED",
    "COMMISSION_REVERSED",
    "ORDER_COMPLETED",
    "ORDER_CREATED",
    "PAYMENT_CAPTURED",
    "PAYMENT_REFUNDED",
    "SELLER_PAYABLE_DUE",
  ]);
  const firstReversal = rows.find((row) => row.eventType === "COMMISSION_REVERSED")!;
  assert.equal(firstReversal.amountMinor, 500, "10% of the 5,000 refunded");
  assert.equal(firstReversal.businessRef, `cash-refunds:${orderId}`);

  const after = await openRefund(orderId, 5_000);
  assert.equal(after.status, 201, after.text);
  assert.equal((await claimRepayment(after.data.refund.id)).status, 200);
  assert.equal((await confirmRepayment(after.data.refund.id)).status, 200);
  const later = await journal(orderId);
  const reversals = later.filter((row) => row.eventType === "COMMISSION_REVERSED");
  assert.equal(reversals.length, 2);
  assert.equal(
    reversals.reduce((sum, row) => sum + row.amountMinor, 0),
    1_000,
    "two 5,000 refunds reverse exactly 10% of 10,000",
  );
  assert.equal(
    later.filter((row) => row.eventType === "PAYMENT_REFUNDED").length,
    2,
  );
});

await test("cash refund database transitions and facts cannot be forged", async () => {
  const orderId = await confirmedCashOrder("حماية الاسترداد");
  const opened = await openRefund(orderId, 5_000);
  const refundId = opened.data.refund.id as string;
  await assert.rejects(
    pool.query(
      "UPDATE cash_refund_cases SET status = 'CONFIRMED' WHERE id = $1",
      [refundId],
    ),
    "a repayment cannot jump to confirmed without the buyer",
  );
  await assert.rejects(
    pool.query(
      "UPDATE cash_refund_cases SET amount_minor = amount_minor + 1 WHERE id = $1",
      [refundId],
    ),
  );
  await assert.rejects(
    pool.query("DELETE FROM cash_refund_cases WHERE id = $1", [refundId]),
  );
  const [caseRow] = await db
    .select()
    .from(cashRefundCases)
    .where(eq(cashRefundCases.id, refundId));
  const order = await orderRow(orderId);
  await assert.rejects(
    pool.query(
      `INSERT INTO cash_refund_cases
        (id, order_id, payment_claim_id, opened_by, buyer_id, seller_id, amount_minor, currency_code, reason, status, idempotency_key, mode)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, 'تجاوز', 'OPEN', $8, 'CASH_DIRECT')`,
      [
        randomUUID(),
        orderId,
        caseRow!.paymentClaimId,
        buyer.id,
        seller.id,
        order.subtotalMinor + 1,
        order.currencyCode,
        key("raw-refund"),
      ],
    ),
    "the guard refuses a refund above the confirmed payment",
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO cash_refund_cases
        (id, order_id, payment_claim_id, opened_by, buyer_id, seller_id, amount_minor, currency_code, reason, status, idempotency_key, mode)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, 'تجاوز تراكمي', 'OPEN', $8, 'CASH_DIRECT')`,
      [
        randomUUID(),
        orderId,
        caseRow!.paymentClaimId,
        buyer.id,
        seller.id,
        order.subtotalMinor,
        order.currencyCode,
        key("raw-cumulative"),
      ],
    ),
    "the guard refuses a case that pushes the cumulative refund past the payment",
  );
});

after(async () => {
  server.close();
  await pool.end();
});
