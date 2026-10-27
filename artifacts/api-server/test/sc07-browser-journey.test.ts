/**
 * SC07 REAL_E2E (docs/dinar-next/DINAR_TEN_END_TO_END_ACCEPTANCE_SCENARIOS.md): the seller's
 * stock reading, quantity change and pause in chat, and two buyers racing for the last unit in
 * independent browser sessions (artifacts/dinar/test/sc07-ui-journey.mjs). This suite publishes the
 * fixtures and then checks the database: one order for the last unit, stock never negative,
 * reservation equal to the winning order, the paused listing paused, Reem's other data intact.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, offers, orders, pool } from "@workspace/db";
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
  const password = "sc07-journey-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return created.cookie;
}
async function publish(cookie: string, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", {
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", clientRequestId: randomUUID(), attributes: { condition: "جديد" },
    category: "منزل", categoryId: "home", paymentMethods: ["CASH_DIRECT"], ...body,
  }, cookie);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

await test("SC07 REAL_E2E: seller stock in chat, confirmed changes, and one winner for the last unit", async () => {
  const reem = await register(`ريم ${runId}`);
  const other = await register(`بائع آخر ${runId}`);
  const buyer1 = await register(`مشتري أول ${runId}`);
  const buyer2 = await register(`مشتري ثان ${runId}`);
  const ids = {
    cups: await publish(reem, { title: `أكواب قهوة سيراميك ${runId}`, description: "أكواب قهوة سيراميك جديدة", unitPrice: "3", availableQuantity: 5 }),
    table: await publish(reem, { title: `طاولة ${runId}`, description: "طاولة خشب بحالة جيدة", unitPrice: "60" }),
    last: await publish(reem, { title: `فنجان أخير ${runId}`, description: "آخر فنجان من المجموعة", unitPrice: "4", availableQuantity: 1 }),
    foreign: await publish(other, { title: `ماكينة ${runId}`, description: "ماكينة قهوة لبائع آخر", unitPrice: "90" }),
  };
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-sc07-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/sc07-ui-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        SC07_WEB_BASE: web.baseUrl,
        SC07_API_ORIGIN: origin,
        SC07_RUN_ID: runId,
        SC07_SELLER_COOKIE: reem,
        SC07_OTHER_COOKIE: other,
        SC07_BUYER1_COOKIE: buyer1,
        SC07_BUYER2_COOKIE: buyer2,
        SC07_LISTING_IDS: JSON.stringify(ids),
        SC07_UI_RESULT_PATH: resultPath,
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
  console.log("SC07_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.equal(getModelGatewayCallCount() - modelCallsBefore, 0, "every SC07 step is handled by DINAR, not the model");
  // With no provider configured a fallback never reaches the counter; the replies are checked too.
  assert.deepEqual(report.modelFallbacks.filter((item: any) => !item.allowed), [], "no commercial step fell through to the model");

  // ── Database proof ──
  const row = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
  const [cups, table, last, foreign] = [await row(ids.cups), await row(ids.table), await row(ids.last), await row(ids.foreign)];
  assert.equal(cups.availableQuantity, 10, "the confirmed quantity change");
  assert.equal(table.status, "PAUSED", "the confirmed pause");
  assert.equal(foreign.availableQuantity, 1, "another seller's listing untouched");
  const lastOrders = await db.select().from(orders).where(eq(orders.sellerId, last.sellerId));
  const forLast = lastOrders.filter((order) => order.id === report.orderId);
  assert.equal(forLast.length, 1, "the winning order exists");
  assert.equal(lastOrders.filter((order) => order.status !== "CANCELLED").length, 1, "no second order on Reem's listings");
  // An open order reserves stock (reserved rises; available falls only when the sale completes).
  assert.deepEqual([last.availableQuantity, last.reservedQuantity], [1, 1], "the single unit is reserved once, by the winner");
  assert.ok(last.reservedQuantity <= (last.availableQuantity ?? 0), "never oversold");
  console.log("SC07_SUMMARY", JSON.stringify({ result: "PASS", scope: "REAL_E2E", checks: report.checks.length, steps: report.steps.length, replies: report.replies }));
});

after(async () => {
  server.close();
  await pool.end();
});
