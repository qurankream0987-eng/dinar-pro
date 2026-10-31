/**
 * W02U-3 — real Chromium acceptance for canonical card reliability.
 *
 * Prepares a seller with two fixed-price listings and a buyer, then runs
 * artifacts/dinar/test/w02u3-card-reliability-ui.mjs: two tabs of one account, offline tap,
 * a response dropped after the server committed, keyboard confirmation, five widths, and
 * forged broadcast/storage. The model gateway is blocked; any model call fails the run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W02U3_BROWSER");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const runId = randomUUID().slice(0, 6);

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  const number = `78${((Date.now() + 104729 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "w02u3-browser-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { id: created.data.user.id, cookie: created.cookie };
}
async function publish(title: string) {
  const created = await request("/listings", "POST", {
    title,
    description: `${title} — وصف للاختبار ${runId}`,
    category: "أخرى",
    categoryId: "other",
    area: "خلدا",
    city: "عمان",
    attributes: {},
    unitPrice: "9",
    inventoryMode: "LIMITED",
    availableQuantity: 10,
    fulfilmentType: "PICKUP",
    pricingMode: "FIXED",
    imageUrl: "",
    imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, `${title}: ${created.text}`);
  return created.data.id as string;
}

const seller = await register(`بائع البطاقات ${runId}`);
const buyer = await register(`مشتري البطاقات ${runId}`);
const firstTitle = `بطاقة ${runId}`;
const secondTitle = `ساعة ${runId}`;
const firstListingId = await publish(firstTitle);
const secondListingId = await publish(secondTitle);

await test("W02U3 real browser: two tabs, offline, dropped response, keyboard and forged signals", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-w02u3-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/w02u3-card-reliability-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02U3_WEB_BASE: web.baseUrl,
        W02U3_API_ORIGIN: origin,
        W02U3_BUYER_COOKIE: buyer.cookie,
        W02U3_BUYER_ID: buyer.id,
        W02U3_FIRST_TITLE: firstTitle,
        W02U3_SECOND_TITLE: secondTitle,
        W02U3_FIRST_LISTING_ID: firstListingId,
        W02U3_SECOND_LISTING_ID: secondListingId,
        W02U3_UI_RESULT_PATH: resultPath,
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
  console.log("W02U3_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the browser journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.ok(report.surfaces?.pending?.surfaceId, "the pending review has a server identity");
  assert.ok(report.checks.length >= 10, `expected the full journey, got ${report.checks.length} checks`);
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "no model call in any deterministic turn");
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
