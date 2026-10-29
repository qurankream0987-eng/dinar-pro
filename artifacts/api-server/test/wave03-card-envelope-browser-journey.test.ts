/**
 * Wave 03 — real browser acceptance for the card envelope.
 *
 * Prepares two accounts and one published listing, then runs the UI journey
 * (artifacts/dinar/test/wave03-card-envelope-ui.mjs): listing result → purchase review →
 * decline → reload; negotiation review → decline → reload, at 320px, 390px and desktop.
 * The model gateway is blocked; any model call fails the run.
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
  const password = "wave03-envelope-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return created.cookie;
}

await test("W03 real browser: an envelope-driven card keeps its identity, lifecycle and actions at 320/390/desktop", async () => {
  const seller = await register(`موجة البائع ${runId}`);
  const buyer = await register(`موجة المشتري ${runId}`);
  const title = `أكواب موجة ${runId}`;
  const published = await request("/listings", "POST", {
    title, description: `${title} — وصف للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: CITY,
    attributes: {}, unitPrice: "3", inventoryMode: "LIMITED", availableQuantity: 20, fulfilmentType: "PICKUP", pricingMode: "NEGOTIABLE", imageUrl: "", imageUrls: [],
  }, seller);
  assert.equal(published.status, 201, published.text);
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-wave03-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/wave03-card-envelope-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W03_WEB_BASE: web.baseUrl,
        W03_API_ORIGIN: origin,
        W03_BUYER_COOKIE: buyer,
        W03_TITLE: title,
        W03_UI_RESULT_PATH: resultPath,
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
  console.log("W03_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.equal(report.surfaces?.purchase?.lifecycle, "PENDING_REVIEW");
  assert.equal(report.surfaces?.negotiation?.lifecycle, "PENDING_REVIEW");
  assert.ok(report.surfaces?.purchase?.surfaceId, "the purchase card has a server identity");
  assert.ok(report.surfaces?.negotiation?.surfaceId, "the negotiation card has a server identity");
  assert.ok(report.checks.length >= 14, `expected the full journey, got ${report.checks.length} checks`);
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "no model call in any deterministic turn");
});

// The app keeps the server open for the whole file; close it so the isolated runner can exit.
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
