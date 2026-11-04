/**
 * WAVE 02 / D6 — the buyer employee in a real browser.
 *
 * Three real offers are published through DINAR's listing authority, then Chromium searches,
 * compares them side by side, selects one, reloads on the review, and confirms once through the
 * canonical checkout. The database is checked afterwards: one order, from the selected listing,
 * created by the server's own checkout with no money moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { db, orders, pool } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE02_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const apiOrigin = base.replace(/\/api$/u, "");
const runId = randomUUID().slice(0, 6);
let ipSequence = 0;

type Actor = { id: string; cookie: string };

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `192.0.2.${(ipSequence++ % 250) + 1}` } : {}),
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

let phone = 0;
async function register(name: string): Promise<Actor> {
  const number = `79${((Date.now() + 104729 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
  const password = `W02-browser-${randomUUID().slice(0, 10)}!`;
  const created = await request("/auth/register", "POST", {
    displayName: name,
    phoneCountryCode: "+962",
    phoneNumber: number,
    accountCountry: "JO",
    password,
    confirmPassword: password,
    acceptTerms: true,
  });
  assert.equal(created.status, 201, created.raw);
  return { id: created.data.user.id, cookie: created.cookie };
}

async function publish(actor: Actor, title: string, price: string) {
  const created = await request("/listings", "POST", {
    title,
    description: `${title} — وصف اختبار المتصفح`,
    category: "أخرى",
    categoryId: "other",
    area: "خلدا",
    city: "عمان",
    attributes: {},
    unitPrice: price,
    inventoryMode: "LIMITED",
    availableQuantity: 5,
    fulfilmentType: "PICKUP",
    imageUrl: "",
    imageUrls: [],
  }, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const buyer = await register(`مشتري المتصفح ${runId}`);
const sellerA = await register(`بائع المتصفح أ ${runId}`);
const sellerB = await register(`بائع المتصفح ب ${runId}`);
const title = `ساعة متصفح ${runId}`;
const prices = ["21", "19", "17"];
const listingIds = [
  await publish(sellerA, `${title} أ`, prices[0]!),
  await publish(sellerB, `${title} ب`, prices[1]!),
  await publish(sellerA, `${title} ج`, prices[2]!),
];

await test("W02-D6 browser: search, compare, reload, and one canonical checkout", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(apiOrigin);
  const resultPath = `/tmp/dinar-w02-d6-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/wave02-d6-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02D6_WEB_BASE: web.baseUrl,
        W02D6_API_ORIGIN: apiOrigin,
        W02D6_BUYER_COOKIE: buyer.cookie,
        W02D6_TITLE: title,
        W02D6_LISTING_IDS: listingIds.join(","),
        W02D6_UI_RESULT_PATH: resultPath,
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
  console.log("W02_D6_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the browser journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.ok(report.checks.length >= 6, `expected the full journey, got ${report.checks.length}`);
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "no model call in any deterministic buyer turn");

  const rows = await db.select().from(orders).where(and(
    eq(orders.buyerId, buyer.id),
    inArray(orders.status, ["CREATED", "PENDING_PAYMENT", "PAID"]),
  ));
  assert.equal(rows.length, 1, "the browser confirmation created exactly one order");
  const [order] = rows;
  assert.ok(listingIds.includes(report.order.listingId));
  assert.equal(order!.quantity, 1);
  assert.equal(order!.status, "CREATED");
  assert.equal(order!.data.paymentMode, "TEST_NO_TRANSFER", "checkout uses the test payment mode");
  assert.equal(order!.data.commissionRateBps, 1000);
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
});
