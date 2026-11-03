/**
 * WAVE 05 / D15 — CRITICAL MONEY MODEL GATE.
 *
 * Two isolated branches propose two different order-money strategies and neither is on canonical:
 *  - wave01 (`qoder/wave01-d1-d3-closure`) splits one seller's differently priced lines into
 *    several orders so the database invariant subtotal = quantity x unit_price keeps holding;
 *  - wave02 (`qoder/wave02-d4-d6-closure`) adds migration `0051_order_multi_item_money.sql`, which
 *    drops that clause so one order may carry several differently priced lines.
 * Canonical (`replit/dinar-next-complete-development`) has neither: the checkout route groups by
 * seller only and the strict CHECK is still live, so a mixed-price cart is a database error.
 *
 * This suite measures the behaviour of the actual integration candidate instead of trusting either
 * strategy. MM-1x are the requirements a unified model must satisfy; MM-2x replays the relaxed
 * constraint on this disposable database to show what that strategy costs the order row.
 * Nothing here touches a real payment, a production database or a paid provider.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { businessProfiles, checkoutRequests, db, orderItems, orders, pool, users } from "@workspace/db";
import { assignListingToBusiness } from "../src/lib/business-catalog-contract";
import { calculateCommissionMinor } from "../src/lib/commission-policy";
import { checkoutForActor } from "../src/routes/marketplace";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE05_MONEY_GATE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const report: Record<string, unknown> = {};
// The invariant drizzle/0001_invariants.sql installed and no canonical migration replaced.
const STRICT_CHECK =
  "CHECK (quantity > 0 AND unit_price_minor > 0 AND subtotal_minor = quantity::bigint * unit_price_minor AND platform_fee_minor >= 0 AND seller_amount_minor = subtotal_minor - platform_fee_minor)";
const isStrictInvariant = (definition: string) =>
  /subtotal_minor\s*=\s*\(?\s*quantity\s*\)?::bigint\s*\*\s*unit_price_minor/.test(definition);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;

let ipSequence = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.51.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
// Jordanian mobiles are 7[789] + 7 digits and normalizePhone() validates them with libphonenumber,
// so a generated 51-prefixed number is refused at registration. The seed is a 7-digit run-unique
// base and the counter keeps every number inside that width.
let phoneOffset = 0;
const phoneSeed = 1_000_000 + (Date.now() % 6_000_000);
const nextPhone = () => `79${phoneSeed + phoneOffset++}`;
async function register(label: string): Promise<Actor> {
  const phoneNumber = nextPhone();
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+962", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", {
    challengeId: started.data.challengeId,
    code: started.data.developmentCode,
  });
  const password = `Wave05Money-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR MM ${label}`,
    accountCountry: "JO",
    phoneCountryCode: "+962",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function publish(seller: Actor, title: string, unitPrice: string): Promise<string> {
  const created = await request(
    "/listings",
    "POST",
    {
      title,
      description: `${title} — فحص بوابة نموذج المال لموجة 05 على سوق الأردن`,
      category: "أزياء",
      categoryId: "fashion",
      area: "الاباء",
      city: "عمان",
      attributes: { condition: "جديد" },
      unitPrice,
      inventoryMode: "LIMITED",
      availableQuantity: 20,
      fulfilmentType: "PICKUP",
      imageUrl: "",
      imageUrls: [],
      paymentMethods: ["CASH_DIRECT"],
    },
    seller.cookie,
  );
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const line = (listingId: string, quantity: number) => ({ listingId, quantity, fulfilmentType: "PICKUP" });
const rowsFor = async (buyerId: string) =>
  (await db.select().from(orders).where(eq(orders.buyerId, buyerId))).sort((a, b) => a.subtotalMinor - b.subtotalMinor);
const itemsOf = async (orderId: string) =>
  (await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))).sort((a, b) => a.unitPriceMinor - b.unitPriceMinor);
const requestCount = async (userId: string) =>
  (await db.select().from(checkoutRequests).where(eq(checkoutRequests.userId, userId))).length;
const moneyConstraint = async () =>
  (
    await pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'orders'::regclass AND conname = 'order_money_valid'",
    )
  ).rows[0]!.definition;

const buyer = await register("buyer");
const sellerA = await register("seller-a");
const sellerB = await register("seller-b");
const L: Record<string, string> = {};
L.a1 = await publish(sellerA, "قميص قطن MM سعر أول", "12.500");
L.a2 = await publish(sellerA, "قميص قطن MM سعر مطابق", "12.500");
L.a3 = await publish(sellerA, "جاكيت صوف MM سعر مختلف", "45.000");
L.b1 = await publish(sellerB, "حذاء رياضي MM", "30.000");

await test("MM-00 record the money strategy actually present in the candidate", async () => {
  const definition = await moneyConstraint();
  report.mm00 = {
    postgres: (await pool.query("SHOW server_version")).rows[0].server_version,
    orderMoneyConstraint: definition,
    enforcesSubtotalEqualsQuantityTimesUnitPrice: isStrictInvariant(definition),
    appliedMigrations: (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n,
  };
  assert.ok(isStrictInvariant(definition), `the audited candidate carries the strict subtotal invariant: ${definition}`);
});

await test("MM-10 one seller, two listings at the SAME price: one order, exact money", async () => {
  const result = await checkoutForActor(buyer.id, [line(L.a1!, 2), line(L.a2!, 1)], `mm10-${randomUUID()}`);
  assert.equal(result.orders.length, 1, "same-priced lines of one seller share one order");
  const [row] = await rowsFor(buyer.id);
  assert.equal(row!.quantity, 3);
  assert.equal(row!.subtotalMinor, 37_500);
  const items = await itemsOf(row!.id);
  assert.equal(items.length, 2);
  assert.equal(items.reduce((sum, item) => sum + item.subtotalMinor, 0), row!.subtotalMinor, "lines sum to the order subtotal");
  report.mm10 = { orderId: row!.id, quantity: row!.quantity, subtotalMinor: row!.subtotalMinor };
});

await test("MM-11 one seller, two listings at DIFFERENT prices must checkout", async () => {
  const mixedBuyer = await register("buyer-mixed");
  let outcome: Record<string, unknown>;
  try {
    const result = await checkoutForActor(mixedBuyer.id, [line(L.a1!, 1), line(L.a3!, 2)], `mm11-${randomUUID()}`);
    outcome = { kind: "created", orders: result.orders.length, total: result.total };
  } catch (error) {
    outcome = { kind: "rejected", message: error instanceof Error ? error.message.slice(0, 400) : String(error) };
  }
  report.mm11 = outcome;
  // The requirement any accepted unified model must satisfy: a mixed-price basket the marketplace
  // itself assembled is purchasable, not refused at the database boundary.
  assert.equal(outcome.kind, "created", `a mixed-price cart must checkout: ${JSON.stringify(outcome)}`);
  const rows = await rowsFor(mixedBuyer.id);
  assert.equal(rows.reduce((sum, row) => sum + row.subtotalMinor, 0), 102_500, "12.500 + 2 x 45.000");
});

await test("MM-12 two sellers: one order each, and the cart total is their sum", async () => {
  const twoSellerBuyer = await register("buyer-two-sellers");
  const result = await checkoutForActor(twoSellerBuyer.id, [line(L.a1!, 1), line(L.b1!, 2)], `mm12-${randomUUID()}`);
  assert.equal(result.orders.length, 2, "one order per seller");
  const rows = await rowsFor(twoSellerBuyer.id);
  const bySeller = new Map(rows.map((row) => [row.sellerId, row]));
  assert.equal(bySeller.get(sellerA.id)!.subtotalMinor, 12_500);
  assert.equal(bySeller.get(sellerB.id)!.subtotalMinor, 60_000);
  assert.equal(rows.reduce((sum, row) => sum + row.subtotalMinor, 0), 72_500);
  report.mm12 = { orders: rows.map((row) => ({ sellerId: row.sellerId, subtotalMinor: row.subtotalMinor, platformFeeMinor: row.platformFeeMinor })), total: result.total };
});

await test("MM-13 commission precision: every order splits exactly and matches its own snapshot", async () => {
  const rows = await db.select().from(orders).where(eq(orders.buyerId, buyer.id));
  const perOrder = rows.map((row) => {
    const snapshot = row.data.commissionPolicy as { rateBasisPoints: number; version: number; basis: string; roundingMode: string };
    return {
      orderId: row.id,
      subtotalMinor: row.subtotalMinor,
      platformFeeMinor: row.platformFeeMinor,
      sellerAmountMinor: row.sellerAmountMinor,
      rateBasisPoints: snapshot.rateBasisPoints,
      recomputedFeeMinor: calculateCommissionMinor(row.subtotalMinor, snapshot),
      splitsExactly: row.platformFeeMinor + row.sellerAmountMinor === row.subtotalMinor,
    };
  });
  report.mm13 = { orders: perOrder };
  assert.ok(perOrder.length > 0, "MM-10 and MM-12 leave orders to audit");
  for (const order of perOrder) {
    assert.ok(order.splitsExactly, `${order.orderId}: fee + seller amount must equal the subtotal`);
    assert.equal(order.platformFeeMinor, order.recomputedFeeMinor, `${order.orderId}: fee must equal the snapshot recomputation`);
  }
});

await test("MM-14 a refused mixed-price checkout rolls back completely", async () => {
  const rollbackBuyer = await register("buyer-rollback");
  const priced = await publish(sellerA, "معطف MM سعر رابع مختلف", "77.000");
  let refused = false;
  let reason = "";
  try {
    await checkoutForActor(rollbackBuyer.id, [line(L.a2!, 1), line(priced, 1)], `mm14-${randomUUID()}`);
  } catch (error) {
    refused = true;
    reason = error instanceof Error ? error.message.slice(0, 300) : String(error);
  }
  report.mm14 = { refused, reason, orders: (await rowsFor(rollbackBuyer.id)).length, checkoutRequests: await requestCount(rollbackBuyer.id) };
  if (refused) {
    assert.equal((await rowsFor(rollbackBuyer.id)).length, 0, "no order row survives a refused checkout");
    assert.equal(await requestCount(rollbackBuyer.id), 0, "no idempotency row survives a refused checkout");
  }
});

await test("MM-15 idempotency: one key returns one order set and a reused key cannot re-price", async () => {
  const idempotentBuyer = await register("buyer-idempotent");
  const key = `mm15-${randomUUID()}`;
  const first = await checkoutForActor(idempotentBuyer.id, [line(L.a1!, 2)], key);
  const second = await checkoutForActor(idempotentBuyer.id, [line(L.a1!, 2)], key);
  const ids = (result: typeof first) => JSON.stringify(result.orders.map((order) => order.id).sort());
  assert.equal(ids(second), ids(first));
  assert.equal((await rowsFor(idempotentBuyer.id)).length, 1, "a replay never creates a second order");
  assert.equal(await requestCount(idempotentBuyer.id), 1);
  let refused = false;
  try {
    await checkoutForActor(idempotentBuyer.id, [line(L.a1!, 3)], key);
  } catch {
    refused = true;
  }
  assert.ok(refused, "a reused key with different items is refused, never silently re-priced");
  report.mm15 = { orders: ids(first), reusedKeyRefused: refused };
});

await test("MM-16 concurrent confirmation of one key produces one order set", async () => {
  const concurrentBuyer = await register("buyer-concurrent");
  const key = `mm16-${randomUUID()}`;
  const attempts = [line(L.a1!, 1), line(L.b1!, 1)];
  const settled = await Promise.allSettled([
    checkoutForActor(concurrentBuyer.id, attempts, key),
    checkoutForActor(concurrentBuyer.id, attempts, key),
    checkoutForActor(concurrentBuyer.id, attempts, key),
  ]);
  const fulfilled = settled.filter((entry) => entry.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof checkoutForActor>>>[];
  const rejected = settled.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[];
  const rows = await rowsFor(concurrentBuyer.id);
  report.mm16 = {
    fulfilled: fulfilled.length,
    rejected: rejected.length,
    orders: rows.length,
    checkoutRequests: await requestCount(concurrentBuyer.id),
    rejectionReasons: rejected.map((entry) => String(entry.reason).slice(0, 160)),
  };
  assert.equal(fulfilled.length, 3, "concurrent replays of one key must not error for the buyer");
  assert.equal(rows.length, 2, "two sellers, so exactly two orders however many confirmations race");
  assert.equal(await requestCount(concurrentBuyer.id), 1);
});

await test("MM-17 per-line invariants hold for every stored order item", async () => {
  const rows = await rowsFor(buyer.id);
  const audited: unknown[] = [];
  for (const row of rows) {
    const items = await itemsOf(row.id);
    assert.equal(items.reduce((sum, item) => sum + item.subtotalMinor, 0), row.subtotalMinor, `${row.id}: lines sum to the order`);
    for (const item of items) {
      assert.ok(item.quantity > 0 && item.unitPriceMinor > 0, `${item.id}: a line has real quantity and price`);
      assert.equal(item.subtotalMinor, item.quantity * item.unitPriceMinor, `${item.id}: line subtotal is exact`);
    }
    audited.push({ orderId: row.id, lines: items.length, subtotalMinor: row.subtotalMinor });
  }
  report.mm17 = { orders: audited };
});

await test("MM-18 two businesses under one owner settle to that owner", async () => {
  const [ownerRow] = await db.select().from(users).where(eq(users.id, sellerA.id));
  assert.ok(ownerRow);
  const createBusiness = async (name: string) => {
    const [business] = await db
      .insert(businessProfiles)
      .values({
        id: randomUUID(),
        ownerUserId: ownerRow!.id,
        marketId: "JO",
        displayName: name,
        normalizedName: name.replace(/\s+/g, "").toLowerCase(),
        categoryKey: "fashion",
        verificationStatus: "VERIFIED",
        publicationStatus: "PUBLISHED",
        verifiedAt: new Date(),
        idempotencyKey: `mm18-${randomUUID()}`,
      })
      .returning();
    return business!.id;
  };
  const shopBusiness = await createBusiness("مؤسسة MM الأولى");
  const atelierBusiness = await createBusiness("مؤسسة MM الثانية");
  const shopListing = await publish(sellerA, "عطر MM من المؤسسة الأولى", "40.000");
  const atelierListing = await publish(sellerA, "عباءة MM من المؤسسة الثانية", "40.000");
  assert.ok(
    (await assignListingToBusiness({ actorId: sellerA.id, marketId: "JO", listingId: shopListing, businessId: shopBusiness })).businessId === shopBusiness,
  );
  await assignListingToBusiness({ actorId: sellerA.id, marketId: "JO", listingId: atelierListing, businessId: atelierBusiness });
  const businessBuyer = await register("buyer-two-businesses");
  const result = await checkoutForActor(businessBuyer.id, [line(shopListing, 1), line(atelierListing, 1)], `mm18-${randomUUID()}`);
  const rows = await rowsFor(businessBuyer.id);
  report.mm18 = {
    ordersCreated: result.orders.length,
    rows: rows.map((row) => ({ sellerId: row.sellerId, quantity: row.quantity, subtotalMinor: row.subtotalMinor, unitPriceMinor: row.unitPriceMinor })),
    businesses: [shopBusiness, atelierBusiness],
  };
  assert.ok(rows.every((row) => row.sellerId === sellerA.id), "both lines settle to the owner account");
  assert.equal(rows.reduce((sum, row) => sum + row.subtotalMinor, 0), 80_000, "the two businesses' lines total exactly 80.000");
});

await test("MM-20 replay wave 02's relaxed constraint and price what it costs the order row", async () => {
  // Exactly the DDL of qoder/wave02-d4-d6-closure lib/db/drizzle/0051_order_multi_item_money.sql,
  // applied to this disposable loopback database only, to measure that strategy's consequence
  // rather than argue about it.
  await pool.query(`ALTER TABLE "orders" DROP CONSTRAINT "order_money_valid"`);
  await pool.query(
    `ALTER TABLE "orders" ADD CONSTRAINT "order_money_valid" CHECK (quantity > 0 AND unit_price_minor > 0 AND subtotal_minor > 0 AND platform_fee_minor >= 0 AND seller_amount_minor = subtotal_minor - platform_fee_minor)`,
  );
  const relaxedBuyer = await register("buyer-relaxed");
  const cheap = await publish(sellerA, "شال MM مخفض", "9.000");
  const suit = await publish(sellerA, "بدلة MM كاملة", "120.000");
  const result = await checkoutForActor(relaxedBuyer.id, [line(cheap, 3), line(suit, 1)], `mm20-${randomUUID()}`);
  const [row] = await rowsFor(relaxedBuyer.id);
  const items = await itemsOf(row!.id);
  const headerImpliesSubtotal = row!.unitPriceMinor * row!.quantity === row!.subtotalMinor;
  report.mm20 = {
    ordersCreated: result.orders.length,
    quantity: row!.quantity,
    subtotalMinor: row!.subtotalMinor,
    orderUnitPriceMinor: row!.unitPriceMinor,
    lines: items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor })),
    headerPriceTimesQuantityEqualsSubtotal: headerImpliesSubtotal,
  };
  assert.equal(result.orders.length, 1, "the relaxed constraint lets one seller's mixed prices share one order");
  assert.equal(row!.subtotalMinor, 147_000);
  assert.equal(items.length, 2);
  // The cost: the order row still stores a single unit price, so every consumer that divides the
  // header by quantity — orderView exposes it as order.unitPrice — is shown a price that never was.
  assert.ok(!headerImpliesSubtotal, "the stored header unit price cannot represent a mixed-price order");
  // Second cost: the rows that strategy writes cannot go back. Re-imposing the candidate's own
  // invariant over them is attempted inside a transaction that is always rolled back, so the
  // disposable schema stays as this suite left it.
  const client = await pool.connect();
  let reimposed: Record<string, unknown> = { rolledBack: false };
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE "orders" DROP CONSTRAINT "order_money_valid"`);
    await client.query(`ALTER TABLE "orders" ADD CONSTRAINT "order_money_valid" ${STRICT_CHECK}`);
    await client.query("ROLLBACK");
    reimposed = { rolledBack: true, accepted: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    reimposed = { rolledBack: true, accepted: false, reason: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  } finally {
    client.release();
  }
  report.mm20StrictReimposition = reimposed;
  assert.equal(reimposed.accepted, false, "wave 02's rows must violate the strict invariant — that is the finding");
  assert.match(String(reimposed.reason), /order_money_valid|check constraint/i);
});

after(async () => {
  // This suite deliberately mutates the orders constraint in MM-20; the runner drops this
  // disposable loopback database on exit, so dispatch it standalone, never inside a chain.
  console.log("WAVE05_MONEY_GATE", JSON.stringify(report));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
