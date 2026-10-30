/**
 * W02-ULTRA REAL_E2E: the buyer compares listings of two unrelated categories in the real web UI
 * (artifacts/dinar/test/w02-ultra-ui-journey.mjs) — sources, «لا ينطبق», «لم يذكر البائع» and
 * computed facts at six widths, a one-line answer as text, and an older card that stays in view
 * when the viewport changes. Model calls are blocked; the general turns may fall back (listed).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { pool } from "@workspace/db";
import app from "../src/app";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const runId = `ب${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json", origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `203.0.115.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 51_600_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `W02u-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR W02U ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password,
    confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.text);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function publish(seller: Actor, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", {
    area: "خلدا", city: "عمان", inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP",
    pricingMode: "FIXED", imageUrl: "", imageUrls: [], ...body,
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

await test("W02-ULTRA REAL_E2E: a truthful cross-category comparison card, readable at six widths and stable on resize", async () => {
  const seller = await register("seller");
  const buyer = await register("buyer");
  const cars = { category: "سيارات", categoryId: "cars" };
  await publish(seller, { ...cars, title: `سيارة كورولا 2018 ${runId}`, description: "سيارة كورولا نظيفة", attributes: { make: "تويوتا", model: "كورولا", year: 2018, condition: "مستعمل", mileage: 160000 }, unitPrice: "3900" });
  await publish(seller, { ...cars, title: `سيارة يارس 2021 ${runId}`, description: "سيارة يارس نظيفة", attributes: { make: "تويوتا", model: "يارس", year: 2021, condition: "مستعمل" }, unitPrice: "4100" });
  await publish(seller, { title: `سيارة لعبة إلكترونية ${runId}`, description: "لعبة سيارة بجهاز تحكم", category: "إلكترونيات", categoryId: "electronics", attributes: { condition: "جديد" }, unitPrice: "25" });
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-w02u-ui-${randomUUID().slice(0, 6)}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/w02-ultra-ui-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: { ...process.env, W02U_WEB_BASE: web.baseUrl, W02U_API_ORIGIN: origin, W02U_BUYER_COOKIE: buyer.cookie, W02U_RUN: runId, W02U_UI_RESULT_PATH: resultPath },
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
  console.log("W02U_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.deepEqual(report.modelFallbacks.filter((item: any) => !item.allowed), [], "only the two general turns may reach the model");
});

after(async () => {
  server.close();
  await pool.end();
});
