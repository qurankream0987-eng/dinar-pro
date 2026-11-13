/**
 * Whop for Platforms acceptance. Every assertion reads PostgreSQL or an HTTP status, never a
 * provider response: the sandbox network call is the only thing this suite cannot perform on a
 * loopback runner, so the boundary it tests is "the provider told us X" → "the database shows X".
 *
 * The webhook tests sign payloads exactly the way Whop does (Standard Webhooks over the literal
 * secret bytes) and drive the real endpoint, so signature verification, deduplication and money
 * effects are proven against the same code production runs.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  messages,
  orders,
  pool,
  whopAccounts,
  whopCheckouts,
  whopDisputes,
  whopEvents,
  whopRefunds,
  users,
} from "@workspace/db";
import app from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

if (process.env.BDINAR_DISPOSABLE_TEST_DATABASE !== "1") {
  throw new Error(
    "Whop acceptance writes append-only ledger rows and requires a disposable database",
  );
}
requireSafeReplitDevelopmentDatabase("BDINAR_WHOP_ACCEPTANCE");

const WEBHOOK_SECRET = "ws_whop_acceptance_secret_not_real";
// Configured before any module reads the memoized config: the sandbox is the only target.
process.env.WHOP_ENABLED = "true";
process.env.WHOP_ENVIRONMENT = "sandbox";
process.env.WHOP_API_KEY = "test_key_not_real";
process.env.WHOP_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.WHOP_COMPANY_ID = "biz_platform_test";
process.env.WHOP_USD_PER_JOD = "1.41";

const runId = randomUUID().replaceAll("-", "").slice(0, 10);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const key = (label: string) => `whop-${label}-${runId}-${randomUUID().slice(0, 6)}`;

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
  const number = `78${(Date.now() % 1_000_000).toString().padStart(6, "0")}${String(phoneCounter++ % 10)}`;
  const password = "whop-password-00000001";
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

const seller = await register("بائع Whop");
const buyer = await register("مشتري Whop");
const stranger = await register("غريب Whop");
const offboardedSeller = await register("بائع بلا حساب Whop");
const admin = await register("مدير Whop");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));

async function publish(price: string): Promise<string> {
  const created = await request(
    "/listings",
    "POST",
    {
      title: `سلعة Whop ${runId} ${randomUUID().slice(0, 6)}`,
      description: `وصف تفصيلي لاختبار الدفع عبر Whop ${runId}`,
      category: "أخرى",
      categoryId: "other",
      area: "الصويفية",
      city: "عمّان",
      attributes: {},
      pricingMode: "FIXED",
      inventoryMode: "LIMITED",
      fulfilmentType: "PICKUP",
      unitPrice: price,
      availableQuantity: 20,
      imageUrl: "",
      imageUrls: [],
      clientRequestId: randomUUID(),
    },
    seller,
  );
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

async function placeOrder(
  listingId: string,
  actor: Actor = buyer,
  idempotencyKey = key("order"),
): Promise<string> {
  const created = await request(
    "/orders",
    "POST",
    { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey },
    actor,
  );
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  return row!;
}

const sellerWhopAccountId = `biz_seller_${runId}`;
await db.insert(whopAccounts).values({
  id: randomUUID(),
  sellerUserId: seller.id,
  whopAccountId: sellerWhopAccountId,
  contactEmail: `seller-${runId}@example.test`,
  countryCode: "JO",
  status: "VERIFIED",
  identityStatus: "approved",
  verificationStatus: "approved",
  data: {},
});

// 20 JOD at 1.41 = 28.20 USD = 2,820 minor; the 10% baseline is 282.
const paidOrderId = await placeOrder(await publish("20"));
const paidCheckoutId = `ch_paid_${runId}`;
await db.insert(whopCheckouts).values({
  id: randomUUID(),
  orderId: paidOrderId,
  sellerUserId: seller.id,
  whopCheckoutId: paidCheckoutId,
  purchaseUrl: `https://sandbox.whop.com/checkout/${paidCheckoutId}`,
  redirectUrl: `${origin}/orders/${paidOrderId}?whop=return`,
  amountUsdMinor: 2_820,
  feeUsdMinor: 282,
  sellerUsdMinor: 2_538,
  feeBasisPoints: 1_000,
  status: "CREATED",
  data: {},
});

const cancelledOrderId = await placeOrder(await publish("20"));
const cancelledCheckoutId = `ch_cancelled_${runId}`;
await db.insert(whopCheckouts).values({
  id: randomUUID(),
  orderId: cancelledOrderId,
  sellerUserId: seller.id,
  whopCheckoutId: cancelledCheckoutId,
  purchaseUrl: `https://sandbox.whop.com/checkout/${cancelledCheckoutId}`,
  redirectUrl: `${origin}/orders/${cancelledOrderId}?whop=return`,
  amountUsdMinor: 2_820,
  feeUsdMinor: 282,
  sellerUsdMinor: 2_538,
  feeBasisPoints: 1_000,
  status: "CREATED",
  data: {},
});
await db
  .update(orders)
  .set({ status: "CANCELLED" })
  .where(eq(orders.id, cancelledOrderId));

const mismatchOrderId = await placeOrder(await publish("20"));
const mismatchCheckoutId = `ch_mismatch_${runId}`;
await db.insert(whopCheckouts).values({
  id: randomUUID(),
  orderId: mismatchOrderId,
  sellerUserId: seller.id,
  whopCheckoutId: mismatchCheckoutId,
  purchaseUrl: `https://sandbox.whop.com/checkout/${mismatchCheckoutId}`,
  redirectUrl: `${origin}/orders/${mismatchOrderId}?whop=return`,
  amountUsdMinor: 2_800,
  feeUsdMinor: 280,
  sellerUsdMinor: 2_520,
  feeBasisPoints: 1_000,
  status: "CREATED",
  data: {},
});

const largeOrderId = await placeOrder(await publish("500"));

const offboardedListingId = await (async () => {
  const created = await request(
    "/listings",
    "POST",
    {
      title: `سلعة Whop غير مهيأة ${runId}`,
      description: `وصف تفصيلي لبائع بلا حساب تحصيل ${runId}`,
      category: "أخرى",
      categoryId: "other",
      area: "الصويفية",
      city: "عمّان",
      attributes: {},
      pricingMode: "FIXED",
      inventoryMode: "LIMITED",
      fulfilmentType: "PICKUP",
      unitPrice: "20",
      availableQuantity: 5,
      imageUrl: "",
      imageUrls: [],
      clientRequestId: randomUUID(),
    },
    offboardedSeller,
  );
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
})();
const offboardedOrderId = await placeOrder(offboardedListingId);

const unsweptOrderId = await placeOrder(await publish("20"));

const paidPaymentId = `pay_paid_${runId}`;
const cancelledPaymentId = `pay_cancelled_${runId}`;

function usd(amount: string) {
  return { amount, currency: "usd", decimals: 2, display_decimals: 2 };
}

function sign(body: unknown, options: { secret?: string; eventId?: string } = {}) {
  const payload = JSON.stringify(body);
  const eventId =
    options.eventId ??
    (typeof (body as { id?: unknown })?.id === "string"
      ? ((body as { id: string }).id)
      : `evt_${randomUUID().slice(0, 12)}`);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", options.secret ?? WEBHOOK_SECRET)
    .update(`${eventId}.${timestamp}.${payload}`)
    .digest("base64");
  return {
    payload,
    eventId,
    headers: {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  };
}

async function deliver(
  body: unknown,
  options: { secret?: string; eventId?: string } = {},
) {
  const signed = sign(body, options);
  const response = await fetch(`${origin}/api/whop/webhooks`, {
    method: "POST",
    headers: signed.headers,
    body: signed.payload,
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text, eventId: signed.eventId };
}

const ledger = async (eventId: string) =>
  (await db.select().from(whopEvents).where(eq(whopEvents.eventId, eventId)))[0];
const checkout = async (orderId: string) =>
  (await db.select().from(whopCheckouts).where(eq(whopCheckouts.orderId, orderId)))[0]!;
const systemMessages = (orderId: string) =>
  db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, orderId), eq(messages.actor, "SYSTEM")));

function paymentBody(input: {
  eventId?: string;
  paymentId: string;
  checkoutId: string;
  orderId: string;
  amount?: string;
  accountId?: string;
}) {
  return {
    id: input.eventId ?? `evt_${randomUUID().slice(0, 12)}`,
    type: "payment.succeeded",
    data: {
      payment: {
        id: input.paymentId,
        status: "paid",
        currency: "usd",
        total: usd(input.amount ?? "28.20"),
        account_id: input.accountId ?? sellerWhopAccountId,
        checkout_configuration_id: input.checkoutId,
        paid_at: new Date().toISOString(),
        metadata: { dinar_order_id: input.orderId },
      },
    },
  };
}

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

await test("status reports a configured sandbox and hides problems from non-admins", async () => {
  const view = await request("/whop/status", "GET", undefined, seller);
  assert.equal(view.status, 200, view.text);
  assert.equal(view.data.enabled, true);
  assert.equal(view.data.configured, true);
  assert.equal(view.data.environment, "sandbox");
  assert.equal("problems" in view.data, false);
  const anonymous = await request("/whop/status");
  assert.equal(anonymous.status, 401);
});

await test("the seller surface reads the persisted account without calling Whop", async () => {
  const account = await request("/whop/seller/account", "GET", undefined, seller);
  assert.equal(account.status, 200, account.text);
  assert.equal(account.data.enabled, true);
  assert.equal(account.data.account.whopAccountId, sellerWhopAccountId);
  assert.equal(account.data.account.status, "VERIFIED");
  assert.equal(account.data.account.verified, true);

  const missing = await request("/whop/seller/account", "GET", undefined, offboardedSeller);
  assert.equal(missing.status, 200, missing.text);
  assert.equal(missing.data.account, null);
});

await test("a stranger never learns whether an order exists", async () => {
  const response = await request("/whop/checkout", "POST", { orderId: paidOrderId }, stranger);
  assert.equal(response.status, 404, response.text);
  const view = await request(`/whop/orders/${paidOrderId}/payment`, "GET", undefined, stranger);
  assert.equal(view.status, 404, view.text);
});

await test("a seller without a Whop account is refused before any provider call", async () => {
  const response = await request(
    "/whop/checkout",
    "POST",
    { orderId: offboardedOrderId },
    buyer,
  );
  assert.equal(response.status, 409, response.text);
  assert.equal(response.data.code, "WHOP_SELLER_NOT_ONBOARDED");
  assert.equal(await checkout(offboardedOrderId), undefined);
});

await test("a large order whose stored commission is the low tier's opposite is refused", async () => {
  const order = await orderRow(largeOrderId);
  assert.equal(order.data.commissionPolicy.rateBasisPoints, 1_000);
  const response = await request("/whop/checkout", "POST", { orderId: largeOrderId }, buyer);
  assert.equal(response.status, 409, response.text);
  assert.equal(response.data.code, "WHOP_COMMISSION_TIER_UNAVAILABLE");
  assert.equal(await checkout(largeOrderId), undefined);
});

await test("an admin refund needs an idempotency key and a settled payment", async () => {
  const noKey = await request(
    "/whop/admin/refunds",
    "POST",
    { orderId: paidOrderId },
    admin,
  );
  assert.equal(noKey.status, 400, noKey.text);

  const notSettled = await request(
    "/whop/admin/refunds",
    "POST",
    { orderId: unsweptOrderId, reason: "اختبار" },
    admin,
    { "Idempotency-Key": key("refund") },
  );
  assert.equal(notSettled.status, 409, notSettled.text);
  assert.equal(notSettled.data.code, "WHOP_PAYMENT_NOT_SETTLED");

  const forbidden = await request(
    "/whop/admin/refunds",
    "POST",
    { orderId: paidOrderId },
    seller,
    { "Idempotency-Key": key("refund") },
  );
  assert.equal(forbidden.status, 403, forbidden.text);
});

await test("an invalid signature is rejected and never reaches the ledger", async () => {
  const body = paymentBody({
    paymentId: paidPaymentId,
    checkoutId: paidCheckoutId,
    orderId: paidOrderId,
  });
  const result = await deliver(body, { secret: "ws_wrong_secret" });
  assert.equal(result.status, 401, result.text);
  assert.equal(result.data.code, "WHOP_WEBHOOK_INVALID");
  assert.equal(await ledger(body.id), undefined);
});

await test("a paid webhook settles exactly one checkout and writes the receipt", async () => {
  const body = paymentBody({
    paymentId: paidPaymentId,
    checkoutId: paidCheckoutId,
    orderId: paidOrderId,
  });
  const result = await deliver(body);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.result, "payment_recorded");

  const row = await checkout(paidOrderId);
  assert.equal(row.status, "SUCCEEDED");
  assert.equal(row.whopPaymentId, paidPaymentId);
  const order = await orderRow(paidOrderId);
  assert.equal(order.data.whopPayment.paymentId, paidPaymentId);
  assert.equal(order.data.whopPayment.checkoutId, paidCheckoutId);
  assert.equal(order.data.whopPayment.amountUsdMinor, 2_820);
  assert.equal(order.data.whopPayment.feeUsdMinor, 282);
  assert.equal(order.data.whopPayment.environment, "sandbox");
  assert.equal((await ledger(body.id))?.processingStatus, "PROCESSED");
  assert.equal((await systemMessages(paidOrderId)).length, 1);
});

await test("a replayed event answers from the ledger and moves nothing again", async () => {
  const body = paymentBody({
    paymentId: paidPaymentId,
    checkoutId: paidCheckoutId,
    orderId: paidOrderId,
  });
  const first = await deliver(body);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.duplicate, true);
  assert.equal((await systemMessages(paidOrderId)).length, 1);
});

await test("a second event for the same settled payment is idempotent, not a second sale", async () => {
  const body = paymentBody({
    paymentId: paidPaymentId,
    checkoutId: paidCheckoutId,
    orderId: paidOrderId,
  });
  const result = await deliver(body);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.result, "already_succeeded");
  assert.equal((await systemMessages(paidOrderId)).length, 1);
});

await test("an amount that disagrees with the checkout is recorded and refused", async () => {
  const body = paymentBody({
    paymentId: `pay_mismatch_${runId}`,
    checkoutId: mismatchCheckoutId,
    orderId: mismatchOrderId,
    amount: "27.00",
  });
  const result = await deliver(body);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.result, "payment_amount_mismatch");
  assert.equal((await ledger(body.id))?.processingStatus, "FAILED");
  const row = await checkout(mismatchOrderId);
  assert.equal(row.status, "CREATED");
  assert.equal(row.whopPaymentId, null);
  assert.equal((await orderRow(mismatchOrderId)).data.whopPayment, undefined);
});

await test("a payment on a cancelled order becomes one refund obligation, never a sale", async () => {
  const body = paymentBody({
    paymentId: cancelledPaymentId,
    checkoutId: cancelledCheckoutId,
    orderId: cancelledOrderId,
  });
  const result = await deliver(body);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.result, "refund_due_recorded");

  const row = await checkout(cancelledOrderId);
  assert.equal(row.status, "REFUND_DUE");
  assert.equal(row.whopPaymentId, cancelledPaymentId);
  assert.equal((await orderRow(cancelledOrderId)).data.whopPayment, undefined);

  const refunds = await db
    .select()
    .from(whopRefunds)
    .where(eq(whopRefunds.orderId, cancelledOrderId));
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].status, "REFUND_DUE");
  assert.equal(refunds[0].amountUsdMinor, 2_820);
  assert.equal(refunds[0].reason, "ORDER_CANCELLED");
  assert.equal(refunds[0].requestedBy, null);
  assert.equal(refunds[0].idempotencyKey, `whop-refund-due:${cancelledPaymentId}`);
  assert.equal((await systemMessages(cancelledOrderId)).length, 1);

  const replay = await deliver(body);
  assert.equal(replay.data.duplicate, true);
  assert.equal(
    (
      await db
        .select()
        .from(whopRefunds)
        .where(eq(whopRefunds.orderId, cancelledOrderId))
    ).length,
    1,
  );
});

await test("a succeeded refund webhook closes the obligation", async () => {
  const refundId = `rfnd_${runId}`;
  const result = await deliver({
    id: `evt_refund_${runId}`,
    type: "refund.updated",
    data: {
      refund: {
        id: refundId,
        status: "succeeded",
        payment_id: cancelledPaymentId,
        original_amount: usd("28.20"),
        amount: usd("28.20"),
      },
    },
  });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.result, "refund_succeeded");
  const [row] = await db
    .select()
    .from(whopRefunds)
    .where(eq(whopRefunds.orderId, cancelledOrderId));
  assert.equal(row.status, "SUCCEEDED");
  assert.equal(row.whopRefundId, refundId);
  const adminView = await request(
    `/whop/admin/refunds?orderId=${cancelledOrderId}`,
    "GET",
    undefined,
    admin,
  );
  assert.equal(adminView.status, 200, adminView.text);
  assert.equal(adminView.data.refunds[0].status, "SUCCEEDED");
});

await test("a dispute is linked to its order through the settled payment", async () => {
  const result = await deliver({
    id: `evt_dispute_${runId}`,
    type: "resolution_center_case.created",
    data: {
      case: {
        id: `case_${runId}`,
        status: "open",
        payment_id: paidPaymentId,
        amount: usd("28.20"),
      },
    },
  });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.result, "dispute_recorded");
  const [row] = await db
    .select()
    .from(whopDisputes)
    .where(eq(whopDisputes.whopCaseId, `case_${runId}`));
  assert.equal(row.orderId, paidOrderId);
  assert.equal(row.whopPaymentId, paidPaymentId);
  assert.equal(row.amountUsdMinor, 2_820);
});

await test("verification and money movement events are observed without inventing money", async () => {
  await db
    .update(whopAccounts)
    .set({ status: "ONBOARDING" })
    .where(eq(whopAccounts.sellerUserId, seller.id));
  const verified = await deliver({
    id: `evt_verify_${runId}`,
    type: "verification.succeeded",
    data: { account_id: sellerWhopAccountId },
  });
  assert.equal(verified.status, 200, verified.text);
  assert.equal(verified.data.result, "account_verified");
  const [account] = await db
    .select()
    .from(whopAccounts)
    .where(eq(whopAccounts.sellerUserId, seller.id));
  assert.equal(account.status, "VERIFIED");

  const transfer = await deliver({
    id: `evt_transfer_${runId}`,
    type: "transfer.created",
    data: { id: `tr_${runId}`, amount: usd("25.38") },
  });
  assert.equal(transfer.status, 200, transfer.text);
  assert.equal(transfer.data.result, "money_movement_observed");
  assert.equal((await ledger(`evt_transfer_${runId}`))?.processingStatus, "PROCESSED");

  const unknown = await deliver({
    id: `evt_unknown_${runId}`,
    type: "invoice.created",
    data: { id: `inv_${runId}` },
  });
  assert.equal(unknown.status, 200, unknown.text);
  assert.equal(unknown.data.result, "ignored_event_type");
  assert.equal((await ledger(`evt_unknown_${runId}`))?.processingStatus, "IGNORED");
});
