/**
 * SC03 REAL_E2E (docs/dinar-next/DINAR_TEN_END_TO_END_ACCEPTANCE_SCENARIOS.md): a multi-round
 * negotiation on a used table driven through the real web UI by the buyer, the seller and a
 * stranger (artifacts/dinar/test/sc03-ui-journey.mjs). The database must show one negotiation
 * agreed at 90, never an 80 offer, one completed order at 90 that kept its snapshot after the
 * seller raised the listing to 110, and no change by the stranger.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, negotiations, offers, orders, pool } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 6);

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
  const password = "sc03-journey-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return created.cookie;
}

await test("SC03 REAL_E2E: 80 → 85 → counter 90 → agreement → one order at 90 that survives a price change", async () => {
  const heba = await register(`هبة ${runId}`);
  const rashed = await register(`راشد ${runId}`);
  const stranger = await register(`غريب ${runId}`);
  const created = await request("/listings", "POST", {
    title: `طاولة سنديان مستعملة ${runId}`, description: "طاولة طعام مستعملة بحالة ممتازة", category: "منزل", categoryId: "home",
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP",
    pricingMode: "NEGOTIABLE", unitPrice: "100", attributes: { condition: "مستعمل" }, paymentMethods: ["CASH_DIRECT"], clientRequestId: randomUUID(),
  }, heba);
  assert.equal(created.status, 201, created.text);
  const tableId = created.data.id as string;

  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-sc03-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/sc03-ui-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        SC03_WEB_BASE: web.baseUrl,
        SC03_API_ORIGIN: origin,
        SC03_RUN_ID: runId,
        SC03_TABLE_ID: tableId,
        SC03_BUYER_COOKIE: rashed,
        SC03_SELLER_COOKIE: heba,
        SC03_STRANGER_COOKIE: stranger,
        SC03_UI_RESULT_PATH: resultPath,
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
  console.log("SC03_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.equal(getModelGatewayCallCount() - modelCallsBefore, 0);
  assert.deepEqual(report.modelFallbacks.filter((item: any) => !item.allowed), [], "no negotiation step fell through to the model");

  // ── Database proof ──
  const rows = await db.select().from(negotiations).where(eq(negotiations.listingId, tableId));
  assert.equal(rows.length, 1, "one negotiation; the uncorrected 80 never became an offer");
  const [deal] = rows;
  assert.equal(deal!.status, "ACCEPTED");
  assert.equal(deal!.offerAmountMinor, 85_000, "the buyer's sent offer was 85");
  assert.equal(deal!.agreedAmountMinor, 90_000, "agreed at the seller's 90");
  const [order] = await db.select().from(orders).where(eq(orders.id, report.orderId));
  assert.equal(order!.status, "COMPLETED");
  assert.equal(order!.unitPriceMinor, 90_000, "the order uses the agreed 90");
  const [table] = await db.select().from(offers).where(eq(offers.id, tableId));
  assert.equal(table!.unitPriceMinor, 110_000, "the seller raised the listing to 110 afterwards");
  assert.equal((await db.select().from(orders).where(eq(orders.sellerId, table!.sellerId))).length, 1, "no second order");
  console.log("SC03_SUMMARY", JSON.stringify({ result: "PASS", scope: "REAL_E2E", checks: report.checks.length, steps: report.steps.length, counter: report.counterReply, latest: report.latestReply }));
});

after(async () => {
  server.close();
  await pool.end();
});
