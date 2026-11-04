import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, inArray } from "drizzle-orm";
import {
  cashPaymentClaims,
  db,
  markets,
  orderFinancialEvents,
  orders,
  paymentIntents,
  pool,
  sellerDues,
} from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W08_ACCEPTANCE");

const origin = process.env.BDINAR_TEST_API_BASE;
assert.equal(
  origin,
  "http://127.0.0.1:3000",
  "G33 must exercise the isolated Docker API over loopback",
);
assert.equal(process.env.NODE_ENV, "development");
assert.equal(process.env.BDINAR_W08_ACCEPTANCE, "development");
const handshakeDir = process.env.BDINAR_G33_HANDSHAKE_DIR;
assert.equal(handshakeDir, "/g33", "G33 restart handshake must use its mounted temp directory");

type Actor = { id: string; cookie: string };
type Result = { status: number; data: any; text: string };

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  actor?: Actor,
  headers: Record<string, string> = {},
): Promise<Result> {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined
        ? { origin: origin!, "content-type": "application/json" }
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
const password = "g33-acceptance-password-0001";
async function register(displayName: string): Promise<Actor> {
  const number = `79${((Date.now() + 7919 * phoneCounter) % 1_000_000)
    .toString()
    .padStart(6, "0")}${phoneCounter++ % 10}`;
  const response = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { origin: origin!, "content-type": "application/json" },
    body: JSON.stringify({
      displayName,
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
    .find((value) => value.startsWith("bdinar_session="))
    ?.split(";")[0];
  assert.ok(cookie, "registration must establish a session");
  return { id: JSON.parse(text).user.id, cookie };
}

const waitForFile = async (path: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`timed out waiting for the isolated Docker app restart handshake`);
};

const tag = randomUUID()
  .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)))
  .replace(/-/g, "");
const idempotencyKey = `g33-checkout-${tag}`;
const listingTitle = (item: string) => `اختبار G33 ${item} ${tag}`;
let orderIds: string[] = [];
let buyer!: Actor;
let seller!: Actor;

await test("Docker app completes a mixed-price cash journey and survives restart", async () => {
  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(market?.isActive, "the disposable legal acceptance fixture must activate JO");

  seller = await register("بائع اختبار G33");
  buyer = await register("مشتري اختبار G33");

  async function publish(item: string, unitPrice: string) {
    const response = await request(
      "/listings",
      "POST",
      {
        title: listingTitle(item),
        description: `وصف قبول قانوني واختبار نقدي ${item} ${tag}`,
        category: "أخرى",
        categoryId: "other",
        area: "الصويفية",
        city: "عمّان",
        attributes: {},
        paymentMethods: ["CASH_DIRECT"],
        pricingMode: "FIXED",
        inventoryMode: "LIMITED",
        fulfilmentType: "PICKUP",
        unitPrice,
        availableQuantity: 3,
        imageUrl: "",
        imageUrls: [],
        clientRequestId: randomUUID(),
      },
      seller,
    );
    assert.equal(response.status, 201, response.text);
    return response.data.id as string;
  }

  const lowerPriceListing = await publish("سلعة ألف", "12.500");
  const higherPriceListing = await publish("سلعة باء", "37.500");

  const discovery = await request(
    `/listings?search=${encodeURIComponent(tag)}`,
    "GET",
    undefined,
    buyer,
  );
  assert.equal(discovery.status, 200, discovery.text);
  const discoveredIds = discovery.data.map((item: { id: string }) => item.id);
  assert.ok(discoveredIds.includes(lowerPriceListing), discovery.text);
  assert.ok(discoveredIds.includes(higherPriceListing), discovery.text);

  const cartItems = [
    { listingId: lowerPriceListing, quantity: 1 },
    { listingId: higherPriceListing, quantity: 1 },
  ];
  const savedCart = await request(
    "/cart",
    "PUT",
    { marketId: "JO", items: cartItems },
    buyer,
  );
  assert.equal(savedCart.status, 200, savedCart.text);
  const visibleCart = await request("/cart", "GET", undefined, buyer);
  assert.equal(visibleCart.status, 200, visibleCart.text);
  assert.deepEqual(
    visibleCart.data.map((item: { listingId: string }) => item.listingId).sort(),
    [lowerPriceListing, higherPriceListing].sort(),
  );

  const checkoutBody = {
    idempotencyKey,
    items: cartItems.map((item) => ({
      ...item,
      fulfilmentType: "PICKUP",
    })),
  };
  const checkout = await request("/checkout", "POST", checkoutBody, buyer);
  assert.equal(checkout.status, 201, checkout.text);
  assert.equal(checkout.data.orders.length, 2, "mixed prices are retained as separate order snapshots");
  assert.equal(checkout.data.total, "50.000");
  const firstIds = checkout.data.orders.map((order: { id: string }) => order.id).sort();
  const replay = await request("/checkout", "POST", checkoutBody, buyer);
  assert.equal(replay.status, 201, replay.text);
  assert.deepEqual(
    replay.data.orders.map((order: { id: string }) => order.id).sort(),
    firstIds,
    "retrying checkout with the same key must return the same orders",
  );
  orderIds = firstIds;

  const checkedOut = checkout.data.orders
    .slice()
    .sort((left: { subtotalMinor: number }, right: { subtotalMinor: number }) => left.subtotalMinor - right.subtotalMinor);
  assert.deepEqual(checkedOut.map((order: { subtotalMinor: number }) => order.subtotalMinor), [12_500, 37_500]);
  assert.deepEqual(checkedOut.map((order: { platformFeeMinor: number }) => order.platformFeeMinor), [1_250, 3_750]);
  assert.deepEqual(checkedOut.map((order: { sellerAmountMinor: number }) => order.sellerAmountMinor), [11_250, 33_750]);
  assert.ok(
    checkedOut.every((order: { paymentMode: string }) => order.paymentMode === "TEST_NO_TRANSFER"),
    "checkout does not claim an electronic transfer",
  );
  assert.deepEqual((await request("/cart", "GET", undefined, buyer)).data, []);

  for (const orderId of orderIds) {
    const accepted = await request(`/orders/${orderId}/accept`, "POST", {}, seller);
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.data.status, "ACCEPTED");

    const claimKey = `g33-cash-claim-${tag}-${orderId}`;
    const claimBody = { note: "دفعت المبلغ نقدًا عند التسليم" };
    const claim = await request(
      `/orders/${orderId}/cash-payment/claim`,
      "POST",
      claimBody,
      buyer,
      { "Idempotency-Key": claimKey },
    );
    assert.equal(claim.status, 201, claim.text);
    assert.equal(claim.data.claim.verification, "UNVERIFIED_BUYER_CLAIM");
    const duplicateClaim = await request(
      `/orders/${orderId}/cash-payment/claim`,
      "POST",
      claimBody,
      buyer,
      { "Idempotency-Key": claimKey },
    );
    assert.equal(duplicateClaim.status, 200, duplicateClaim.text);
    assert.equal(duplicateClaim.data.created, false);
    assert.equal(duplicateClaim.data.claim.id, claim.data.claim.id);

    const cashConfirmation = await request(
      `/orders/${orderId}/cash-payment/confirm`,
      "POST",
      { note: "استلمت المبلغ نقدًا" },
      seller,
    );
    assert.equal(cashConfirmation.status, 200, cashConfirmation.text);
    assert.equal(cashConfirmation.data.claim.verification, "SELLER_ATTESTED");
    const duplicateCashConfirmation = await request(
      `/orders/${orderId}/cash-payment/confirm`,
      "POST",
      { note: "استلمت المبلغ نقدًا" },
      seller,
    );
    assert.equal(duplicateCashConfirmation.status, 200, duplicateCashConfirmation.text);
    assert.equal(duplicateCashConfirmation.data.confirmed, false);

    const delivered = await request(
      `/orders/${orderId}/delivery`,
      "POST",
      { proofType: "CODE", proofToken: `G33-${tag}` },
      seller,
    );
    assert.equal(delivered.status, 200, delivered.text);
    assert.equal(delivered.data.status, "SELLER_MARKED_DELIVERED");
    const received = await request(
      `/orders/${orderId}/confirm`,
      "POST",
      { received: true, issue: null },
      buyer,
    );
    assert.equal(received.status, 200, received.text);
    assert.equal(received.data.status, "COMPLETED");
    const duplicateReceived = await request(
      `/orders/${orderId}/confirm`,
      "POST",
      { received: true, issue: null },
      buyer,
    );
    assert.equal(duplicateReceived.status, 200, duplicateReceived.text);
    assert.equal(duplicateReceived.data.status, "COMPLETED");
  }

  const rows = await db.select().from(orders).where(inArray(orders.id, orderIds));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "COMPLETED"));
  assert.ok(rows.every((row) => row.data.paymentMode === "CASH_DIRECT"));
  assert.ok(rows.every((row) => row.data.selectedPaymentMethod === "CASH_DIRECT"));
  assert.ok(rows.every((row) => row.data.commissionRateBps === 1_000));
  assert.equal(rows.reduce((sum, row) => sum + row.subtotalMinor, 0), 50_000);
  assert.equal(rows.reduce((sum, row) => sum + row.platformFeeMinor, 0), 5_000);
  assert.equal(rows.reduce((sum, row) => sum + row.sellerAmountMinor, 0), 45_000);

  const dues = await db.select().from(sellerDues).where(inArray(sellerDues.orderId, orderIds));
  assert.equal(dues.length, 2);
  assert.deepEqual(
    dues.map((due) => due.amountMinor).sort((a, b) => a - b),
    [1_250, 3_750],
  );
  assert.ok(dues.every((due) => due.sellerId === seller.id && due.status === "PENDING"));

  const claims = await db
    .select()
    .from(cashPaymentClaims)
    .where(inArray(cashPaymentClaims.orderId, orderIds));
  assert.equal(claims.length, 2);
  assert.ok(
    claims.every(
      (claim) =>
        claim.status === "CONFIRMED" &&
        claim.decidedBy === seller.id &&
        claim.decidedAt !== null,
    ),
  );

  const intents = await db
    .select()
    .from(paymentIntents)
    .where(inArray(paymentIntents.orderId, orderIds));
  assert.equal(intents.length, 0, "the cash journey must not call or fabricate a payment provider transfer");

  const events = await db
    .select()
    .from(orderFinancialEvents)
    .where(inArray(orderFinancialEvents.orderId, orderIds));
  for (const orderId of orderIds) {
    const orderEvents = events.filter((event) => event.orderId === orderId);
    assert.equal(orderEvents.filter((event) => event.eventType === "ORDER_CREATED").length, 1);
    const captures = orderEvents.filter((event) => event.eventType === "PAYMENT_CAPTURED");
    assert.equal(captures.length, 1, "seller cash attestation records one internal capture");
    assert.equal(captures[0]!.authorizationContext.source, "CASH_DIRECT_SELLER_CONFIRMATION");
    assert.equal(
      captures[0]!.amountMinor,
      rows.find((row) => row.id === orderId)!.subtotalMinor,
    );
    assert.equal(captures[0]!.actorType, "SELLER");
    assert.equal(captures[0]!.actorId, seller.id);
    assert.equal(captures[0]!.accountObligation, "BUYER_PAYMENT");
  }

  await mkdir(handshakeDir!, { recursive: true });
  await writeFile(join(handshakeDir!, "transaction-ready"), "complete\n", { flag: "wx" });
  await waitForFile(join(handshakeDir!, "restart-complete"), 180_000);

  for (const orderId of orderIds) {
    const persisted = await request(`/orders/${orderId}`, "GET", undefined, buyer);
    assert.equal(persisted.status, 200, persisted.text);
    assert.equal(persisted.data.status, "COMPLETED");
    assert.equal(persisted.data.paymentMode, "CASH_DIRECT");
    const retryAfterRestart = await request(
      `/orders/${orderId}/confirm`,
      "POST",
      { received: true, issue: null },
      buyer,
    );
    assert.equal(retryAfterRestart.status, 200, retryAfterRestart.text);
    assert.equal(retryAfterRestart.data.status, "COMPLETED");
  }

  const finalDues = await db.select().from(sellerDues).where(inArray(sellerDues.orderId, orderIds));
  assert.equal(finalDues.length, 2, "retries after restart must not create duplicate seller dues");
  const finalEvents = await db
    .select()
    .from(orderFinancialEvents)
    .where(and(inArray(orderFinancialEvents.orderId, orderIds), eq(orderFinancialEvents.eventType, "PAYMENT_CAPTURED")));
  assert.equal(finalEvents.length, 2, "retries after restart must not duplicate cash captures");
});

after(async () => {
  await pool.end();
});
