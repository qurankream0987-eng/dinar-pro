/**
 * Integration preflight — cash refund lock order (risk S11 / M1 in Qoder's merge matrix).
 *
 * openCashRefundCase locks the order, then every refund row of that order. Before this fix,
 * confirmCashRefundReceipt locked its refund row first and the order second, so the two could
 * deadlock (PostgreSQL aborts one: a 500 for that party). The fix takes the order lock first.
 *
 *  LO-01 deterministic: a second connection reproduces open's exact lock sequence (order FOR
 *        UPDATE, then the order's refund rows FOR UPDATE) around a real confirm; with the fixed
 *        order the confirm waits and both finish, with no deadlock and one refunded entry.
 *  LO-02 the pre-fix sequence (refund row, then order) against the same open sequence does
 *        deadlock: proof the test detects the hazard, not a fixed sleep.
 *  LO-03 stress: real open + real confirm on one order, 25 rounds concurrently, no 500, totals
 *        never exceed the confirmed cash, exactly one PAYMENT_REFUNDED per confirmed refund.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { cashRefundCases, db, orderFinancialEvents, pool } from "@workspace/db";
import app from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_INTEGRATION_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().replaceAll("-", "").replace(/[0-9a-f]/gi, (hex) =>
  String.fromCharCode(97 + Number.parseInt(hex, 16)),
);
const key = (label: string) => `lo-${label}-${runId}-${randomUUID().slice(0, 6)}`;
type Actor = { id: string; cookie: string };
async function request(path: string, method = "GET", body?: unknown, actor?: Actor, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(actor ? { cookie: actor.cookie } : {}), ...headers },
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
  const number = `79${((Date.now() + 7919 * phoneCounter) % 1_000_000).toString().padStart(6, "0")}${phoneCounter++ % 10}`;
  const password = "lock-order-password-001";
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
const seller = await register("بائع ترتيب الأقفال");
const buyer = await register("مشتري ترتيب الأقفال");

async function confirmedCashOrder(label: string) {
  const listing = await request("/listings", "POST", { title: `${label} ${runId}`, description: `وصف اختبار ترتيب الأقفال ${label} ${runId}`, category: "أخرى", categoryId: "other", area: "الصويفية", city: "عمّان", attributes: {}, pricingMode: "FIXED", inventoryMode: "LIMITED", fulfilmentType: "PICKUP", unitPrice: "20", availableQuantity: 50, imageUrl: "", imageUrls: [], clientRequestId: randomUUID() }, seller);
  assert.equal(listing.status, 201, listing.text);
  const order = await request("/orders", "POST", { listingId: listing.data.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: key("order") }, buyer);
  assert.equal(order.status, 201, order.text);
  const orderId = order.data.id as string;
  assert.equal((await request(`/orders/${orderId}/accept`, "POST", {}, seller)).status, 200);
  assert.equal((await request(`/orders/${orderId}/cash-payment/claim`, "POST", { note: "دفعت نقدًا" }, buyer, { "Idempotency-Key": key("claim") })).status, 201);
  assert.equal((await request(`/orders/${orderId}/cash-payment/confirm`, "POST", { note: "استلمت نقدًا" }, seller)).status, 200);
  return orderId;
}
const openRefund = (orderId: string, amountMinor: number) => request(`/orders/${orderId}/cash-refunds`, "POST", { amountMinor, reason: "استرداد نقدي جزئي متفق عليه" }, buyer, { "Idempotency-Key": key("refund") });
async function claimedRefund(orderId: string, amountMinor: number) {
  const opened = await openRefund(orderId, amountMinor);
  assert.equal(opened.status, 201, opened.text);
  const refundId = opened.data.refund.id as string;
  assert.equal((await request(`/cash-refunds/${refundId}/repayment-claim`, "POST", { note: "سلّمت المبلغ" }, seller)).status, 200);
  return refundId;
}
const confirm = (refundId: string) => request(`/cash-refunds/${refundId}/confirm`, "POST", {}, buyer);
const refunded = async (orderId: string) => (await db.select().from(orderFinancialEvents).where(and(eq(orderFinancialEvents.orderId, orderId), eq(orderFinancialEvents.eventType, "PAYMENT_REFUNDED")))).length;
type Client = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };
/** A dedicated pooled connection; `end` returns it to the pool (the pool itself closes in after()). */
const connection = async (): Promise<Client> => {
  const client = await pool.connect();
  await client.query("SET lock_timeout = '20s'");
  return { query: (sql, values) => client.query(sql, values as any[]), end: async () => client.release() };
};
/** Waits until some backend is blocked on a lock (the request under test is waiting). */
async function someoneWaits(client: Client) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no backend ever waited on a lock");
}

await test("LO-01 a confirm racing open's lock sequence waits on the order and never deadlocks", async () => {
  const orderId = await confirmedCashOrder("قفل حتمي");
  const refundId = await claimedRefund(orderId, 1_000);
  const opener = await connection();
  const observer = await connection();
  try {
    await opener.query("BEGIN");
    await opener.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [orderId]); // open: step 1
    const confirming = confirm(refundId); // the real route, in its own transaction
    await someoneWaits(observer); // fixed order: it waits on the order lock, holding nothing
    // open: step 2 — every refund row of the order. With the pre-fix order this is the deadlock.
    await opener.query("SELECT id FROM cash_refund_cases WHERE order_id = $1 FOR UPDATE", [orderId]);
    await opener.query("COMMIT");
    const confirmed = await confirming;
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.data.confirmed, true);
    assert.equal(await refunded(orderId), 1);
  } finally {
    await opener.query("ROLLBACK").catch(() => undefined);
    await opener.end();
    await observer.end();
  }
});

await test("LO-02 the pre-fix sequence (refund row, then order) does deadlock against open's sequence", async () => {
  const orderId = await confirmedCashOrder("قفل قديم");
  const refundId = await claimedRefund(orderId, 1_000);
  const opener = await connection();
  const legacy = await connection();
  try {
    await opener.query("BEGIN");
    await legacy.query("BEGIN");
    await opener.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    await legacy.query("SELECT id FROM cash_refund_cases WHERE id = $1 FOR UPDATE", [refundId]); // old confirm step 1
    const legacyOrder = legacy.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [orderId]).then(() => "ok", (error) => error.code as string); // old confirm step 2
    const openerRows = opener.query("SELECT id FROM cash_refund_cases WHERE order_id = $1 FOR UPDATE", [orderId]).then(() => "ok", (error) => error.code as string);
    const outcomes = await Promise.all([legacyOrder, openerRows]);
    assert.ok(outcomes.includes("40P01"), `PostgreSQL detected a deadlock: ${outcomes}`);
  } finally {
    await opener.query("ROLLBACK").catch(() => undefined);
    await legacy.query("ROLLBACK").catch(() => undefined);
    await opener.end();
    await legacy.end();
  }
});

await test("LO-03 real open and real confirm on one order, concurrently, many rounds: no 500, no over-refund", async () => {
  const orderId = await confirmedCashOrder("قفل تحت الضغط");
  const statuses: number[] = [];
  for (let round = 0; round < 25; round++) {
    const refundId = await claimedRefund(orderId, 100);
    const [opened, confirmed] = await Promise.all([openRefund(orderId, 100), confirm(refundId)]);
    statuses.push(opened.status, confirmed.status);
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.ok([201, 409].includes(opened.status), opened.text);
    if (opened.status === 201) {
      // Keep the open case from consuming the cap: withdraw it.
      assert.equal((await request(`/cash-refunds/${opened.data.refund.id}/withdraw`, "POST", {}, buyer)).status, 200);
    }
  }
  assert.ok(!statuses.includes(500), `no deadlock surfaced as 500: ${statuses.join(",")}`);
  const rows = await db.select().from(cashRefundCases).where(eq(cashRefundCases.orderId, orderId));
  const confirmedRows = rows.filter((row) => row.status === "CONFIRMED");
  assert.equal(confirmedRows.length, 25);
  assert.equal(await refunded(orderId), 25, "one refund entry per confirmed case");
  assert.ok(confirmedRows.reduce((sum, row) => sum + row.amountMinor, 0) <= 20_000);
});

after(async () => {
  server.close();
  await pool.end();
});
