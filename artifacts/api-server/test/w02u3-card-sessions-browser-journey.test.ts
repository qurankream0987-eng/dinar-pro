/**
 * W02U-3 — real Chromium acceptance for CR-04 (account switch) and CR-05 (logout/re-login).
 *
 * Prepares a seller with two fixed-price listings and two buyers, then runs
 * artifacts/dinar/test/w02u3-card-sessions-ui.mjs. Both buyers sign in through the real login form.
 * A's conversation re-read is delayed across the switch; B must inherit nothing, the backend must
 * refuse B on A's conversation, and A's settled review must come back from the server on return.
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

requireSafeReplitDevelopmentDatabase("BDINAR_W02U3_BROWSER");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const runId = randomUUID().slice(0, 6);
const password = "w02u3-session-password-1";

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
  // Jordanian mobiles are 9 digits starting 79 (the format the other suites register with).
  const number = `79${((Date.now() + 130363 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { id: created.data.user.id as string, cookie: created.cookie, phone: number };
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

const seller = await register(`بائع الجلسات ${runId}`);
const buyerA = await register(`مشتري أ ${runId}`);
const buyerB = await register(`مشتري ب ${runId}`);
const firstTitle = `بطاقة الجلسات ${runId}`;
const secondTitle = `ساعة الجلسات ${runId}`;
const firstListingId = await publish(firstTitle);
const secondListingId = await publish(secondTitle);

await test("W02U3 CR-04/CR-05 real browser: account switch and logout/re-login stay isolated", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-w02u3-sessions-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/w02u3-card-sessions-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02U3_WEB_BASE: web.baseUrl,
        W02U3_API_ORIGIN: origin,
        W02U3_A_COOKIE: buyerA.cookie,
        W02U3_A_ID: buyerA.id,
        W02U3_A_PHONE: buyerA.phone,
        W02U3_B_COOKIE: buyerB.cookie,
        W02U3_B_ID: buyerB.id,
        W02U3_B_PHONE: buyerB.phone,
        W02U3_PASSWORD: password,
        W02U3_FIRST_TITLE: firstTitle,
        W02U3_SECOND_TITLE: secondTitle,
        W02U3_FIRST_LISTING_ID: firstListingId,
        W02U3_SECOND_LISTING_ID: secondListingId,
        W02U3_SESSIONS_RESULT_PATH: resultPath,
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
  console.log("W02U3_SESSIONS", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the sessions journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.ok(report.surfaces?.aPending?.surfaceId, "A opened a review with a server identity");
  assert.equal(report.surfaces.aPending.lifecycle, "PENDING_REVIEW");
  assert.ok(report.surfaces?.bPending?.surfaceId, "B opened a review of their own");
  assert.notEqual(report.surfaces.bPending.conversationId, report.surfaces.aPending.conversationId);
  assert.equal(report.surfaces?.aRestored?.surfaceId, report.surfaces.aPending.surfaceId, "A's card keeps its identity across the switch");
  assert.equal(report.surfaces.aRestored.lifecycle, "CONFIRMED", "A's restored card carries the settled lifecycle");
  assert.equal(report.sessions?.delayedResponseHeld, true, "the delayed re-read was really held");
  assert.equal(report.sessions?.staleResponseLeak, false);
  assert.ok(report.checks.length >= 10, `expected the full journey, got ${report.checks.length} checks`);
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "no model call in any deterministic turn");
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
