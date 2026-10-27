/**
 * SC01 REAL_E2E (docs/dinar-next/DINAR_TEN_END_TO_END_ACCEPTANCE_SCENARIOS.md): two independent
 * users drive the real web UI against this API and a disposable database, from the seller's
 * first sentence to a completed order (artifacts/dinar/test/sc01-ui-journey.mjs). This suite
 * prepares only the two accounts, then checks the database: one listing owned by the seller,
 * one order owned by the buyer at the published price, stock consumed once, commission
 * snapshotted, and the snapshot unchanged when the seller later edits the listing price.
 * The model gateway is blocked; any model call fails the run.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, offers, orders, orderItems, pool } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const runId = randomUUID().slice(0, 6);
const CITY = `عمان ${Date.now() % 100_000}`;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}${phone++ % 10}`;
  const password = "sc01-journey-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return created.cookie;
}

await test("SC01 REAL_E2E: seller's words → published listing → another user's completed order", async () => {
  const seller = await register(`سالم ${runId}`);
  const buyer = await register(`نورا ${runId}`);
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-sc01-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/sc01-ui-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        SC01_WEB_BASE: web.baseUrl,
        SC01_API_ORIGIN: origin,
        SC01_SELLER_COOKIE: seller,
        SC01_BUYER_COOKIE: buyer,
        SC01_CITY: CITY,
        SC01_UI_RESULT_PATH: resultPath,
      },
      timeout: 900_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
  }
  let report: any;
  try {
    report = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    report = undefined;
  }
  console.log("SC01_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.equal(getModelGatewayCallCount() - modelCallsBefore, 0, "every SC01 step is handled by DINAR, not the model");
  // With no provider configured a fallback never reaches the counter; the replies are checked too.
  assert.deepEqual(report.modelFallbacks, [], "no SC01 step fell through to the model");

  // ── Database proof ──
  const [listing] = await db.select().from(offers).where(eq(offers.id, report.listingId));
  const [order] = await db.select().from(orders).where(eq(orders.id, report.orderId));
  assert.ok(listing && order, "listing and order exist");
  assert.equal(order.sellerId, listing.sellerId, "the order belongs to the listing's seller");
  assert.notEqual(order.buyerId, listing.sellerId, "bought by another user");
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.quantity, 1);
  assert.equal(order.unitPriceMinor, 280 * 10 ** order.minorUnitScale, "the order uses the agreed price, not the asking price");
  assert.equal(order.subtotalMinor, order.unitPriceMinor);
  assert.ok(order.platformFeeMinor > 0 && order.sellerAmountMinor + order.platformFeeMinor === order.subtotalMinor, "commission is snapshotted with the order");
  assert.match(String(listing.data.description ?? ""), /89/u, "the corrected value was published");
  assert.doesNotMatch(String(listing.data.description ?? ""), /86٪/u);
  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  assert.equal(lines.reduce((sum, line) => sum + line.quantity, 0), 1, "one unit sold, once");
  assert.equal(listing.reservedQuantity, 0, "no reservation is left behind");
  assert.ok((listing.availableQuantity ?? 0) === 0 || listing.status !== "PUBLISHED", `the single phone is no longer for sale: ${listing.status}/${listing.availableQuantity}`);
  const otherOrders = await db.select({ id: orders.id }).from(orders).where(eq(orders.buyerId, order.buyerId));
  assert.equal(otherOrders.length, 1, "no duplicate order");

  // The snapshot is immutable: a later price edit by the seller changes nothing on the order.
  const before = { unit: order.unitPriceMinor, fee: order.platformFeeMinor, seller: order.sellerAmountMinor };
  await db.update(offers).set({ unitPriceMinor: 350 * 10 ** order.minorUnitScale }).where(eq(offers.id, listing.id));
  const [unchanged] = await db.select().from(orders).where(eq(orders.id, order.id));
  assert.deepEqual({ unit: unchanged!.unitPriceMinor, fee: unchanged!.platformFeeMinor, seller: unchanged!.sellerAmountMinor }, before);
  console.log("SC01_SUMMARY", JSON.stringify({ result: "PASS", scope: "REAL_E2E", checks: report.checks.length, steps: report.steps.length, listingId: listing.id, orderId: order.id }));
});

after(async () => {
  server.close();
  await pool.end();
});
