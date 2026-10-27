/**
 * SC10 REAL_E2E (docs/dinar-next/DINAR_TEN_END_TO_END_ACCEPTANCE_SCENARIOS.md): a fake payment
 * claim, forged requests, a dispute and an administrator's decision, driven through the real web
 * UI by the buyer, the seller, a stranger and an administrator (artifacts/dinar/test/
 * sc10-ui-journey.mjs). The administrator is promoted in this disposable database only. The
 * database must show exactly one dispute resolved for the buyer by that administrator, the order
 * cancelled with its stock released, no payment event from the forged request, no refund
 * obligation (cash was never collected by DINAR) and no completed sale for the seller.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, disputes, offers, orders, paymentEvents, paymentRefundObligations, pool, users } from "@workspace/db";
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
  const password = "sc10-journey-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.displayName, name));
  return { cookie: created.cookie, id: row!.id };
}

await test("SC10 REAL_E2E: fake payment claim and forged requests refused; one dispute decided by an administrator", async () => {
  const dana = await register(`دانا ${runId}`);
  const ahmed = await register(`أحمد ${runId}`);
  const stranger = await register(`غريب ${runId}`);
  const admin = await register(`مشرف ${runId}`);
  assert.ok(admin.id, "the administrator account id is known");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  const created = await request("/listings", "POST", {
    title: `سماعة لاسلكية ${runId}`, description: "سماعة لاسلكية جديدة بعلبتها", category: "إلكترونيات", categoryId: "electronics",
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP",
    pricingMode: "FIXED", unitPrice: "20", attributes: { condition: "جديد" }, paymentMethods: ["CASH_DIRECT"], clientRequestId: randomUUID(),
  }, dana.cookie);
  assert.equal(created.status, 201, created.text);
  const listingId = created.data.id as string;

  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-sc10-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/sc10-ui-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        SC10_WEB_BASE: web.baseUrl,
        SC10_API_ORIGIN: origin,
        SC10_RUN_ID: runId,
        SC10_LISTING_ID: listingId,
        SC10_BUYER_COOKIE: ahmed.cookie,
        SC10_SELLER_COOKIE: dana.cookie,
        SC10_STRANGER_COOKIE: stranger.cookie,
        SC10_ADMIN_COOKIE: admin.cookie,
        SC10_UI_RESULT_PATH: resultPath,
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
  console.log("SC10_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  // The forged requests are expected to be refused; their 4xx responses are the only console errors allowed.
  assert.deepEqual(report.consoleErrors.filter((line: string) => !/status of 4\d\d/u.test(line)), []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.equal(getModelGatewayCallCount() - modelCallsBefore, 0);
  assert.deepEqual(report.modelFallbacks.filter((item: any) => !item.allowed), [], "no SC10 step fell through to the model");

  // ── Database proof ──
  const [order] = await db.select().from(orders).where(eq(orders.id, report.orderId));
  assert.equal(order!.status, "CANCELLED", "resolved for the buyer: the order is cancelled");
  const rows = await db.select().from(disputes).where(eq(disputes.orderId, order!.id));
  assert.equal(rows.length, 1, "exactly one dispute");
  assert.equal(rows[0]!.openedBy, ahmed.id, "opened by the buyer");
  assert.equal(rows[0]!.resolution, "BUYER", "decided for the buyer");
  assert.ok(rows[0]!.resolvedAt, "the decision is recorded");
  assert.equal((await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, "forged-1"))).length, 0, "the forged payment event recorded nothing");
  assert.equal((await db.select().from(paymentRefundObligations).where(eq(paymentRefundObligations.orderId, order!.id))).length, 0, "cash was never collected by DINAR: no refund is owed or claimed");
  const [listing] = await db.select().from(offers).where(eq(offers.id, listingId));
  assert.deepEqual([listing!.availableQuantity, listing!.reservedQuantity], [1, 0], "the reserved unit is released, not sold");
  console.log("SC10_SUMMARY", JSON.stringify({ result: "PASS", scope: "REAL_E2E", checks: report.checks.length, steps: report.steps.length, tampering: report.tampering }));
});

after(async () => {
  server.close();
  await pool.end();
});
