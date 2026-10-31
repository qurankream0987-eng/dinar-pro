/**
 * W02U-3 — two tabs confirm the same review concurrently, in real Chromium.
 *
 * The fixture opens one pending review. Two tabs of one authenticated account tap the confirmation
 * in their own renderers before either answer returns. The suite asserts exactly one cart effect,
 * one server record per tab, convergence on the same settled card with no stale action, and that
 * the model gateway is never called.
 */
import { test, after } from "node:test";
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
const password = "w02u3-concurrency-password-1";

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
  const number = `79${((Date.now() + 264224 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
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
async function conversation() {
  const created = await request("/ai/conversations", "POST", {}, buyer.cookie);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}
async function say(conversationId: string, message: string) {
  const response = await fetch(`${origin}/api/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: buyer.cookie, origin },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `${message}: ${raw.slice(0, 300)}`);
  const complete = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5));
      } catch {
        return {};
      }
    })
    .find((event: any) => event.type === "complete");
  assert.ok(complete, `${message}: no complete event`);
  return complete;
}
function reviewBlock(turn: any) {
  const block = (turn.assistantMessage?.blocks ?? []).find((candidate: any) => candidate?.payload?.purchaseReview);
  assert.ok(block, "no review block in the turn");
  return block;
}
async function readCard(conversationId: string) {
  const view = await request(`/ai/conversations/${conversationId}`, "GET", undefined, buyer.cookie);
  assert.equal(view.status, 200, view.text);
  for (const message of view.data?.messages ?? [])
    for (const block of message.blocks ?? [])
      if (block?.payload?.purchaseReview) return block.payload.card;
  assert.fail("no review card in the conversation");
}
async function cartQuantity(listingId: string) {
  const cart = await request("/cart", "GET", undefined, buyer.cookie);
  assert.equal(cart.status, 200, cart.text);
  return (cart.data as any[]).find((item) => item.listingId === listingId)?.quantity ?? 0;
}

const seller = await register(`بائع التزامن ${runId}`);
const buyer = await register(`مشتري التزامن ${runId}`);
const title = `مراجعة التزامن ${runId}`;
const listingId = await publish(title);
const conversationId = await conversation();
await say(conversationId, `ابحث عن ${title}`);
const opened = reviewBlock(await say(conversationId, "ابي الأول"));
const openedCard = opened.payload.card as { surfaceId: string; status: { lifecycle: string } };
assert.equal(openedCard.status.lifecycle, "PENDING_REVIEW");

await test("W02U3 concurrency real browser: two tabs, one effect, one settled card", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-w02u3-concurrency-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/w02u3-card-concurrency-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02U3_WEB_BASE: web.baseUrl,
        W02U3_API_ORIGIN: origin,
        W02U3_BUYER_ID: buyer.id,
        W02U3_BUYER_COOKIE: buyer.cookie,
        W02U3_BUYER_PHONE: buyer.phone,
        W02U3_PASSWORD: password,
        W02U3_CONCURRENCY_CONVERSATION: conversationId,
        W02U3_LISTING_ID: listingId,
        W02U3_CONCURRENCY_RESULT_PATH: resultPath,
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
  console.log("W02U3_CONCURRENCY", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the concurrency journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.concurrency?.surfaceId, openedCard.surfaceId, "both tabs kept the fixture identity");
  assert.deepEqual(report.concurrency?.posts, [1, 1], "each tab sent exactly one confirmation");
  assert.equal(report.concurrency?.userRows, 4, "each turn is recorded once");
  assert.ok(report.checks.length >= 3, `expected the full concurrency journey, got ${report.checks.length} checks`);
  assert.equal(await cartQuantity(listingId), 1, "the cart received exactly one unit");
  const stored = await readCard(conversationId);
  assert.equal(stored.surfaceId, openedCard.surfaceId);
  assert.equal(stored.status.lifecycle, "CONFIRMED", "the review settled once");
  assert.deepEqual(stored.allowedActions, []);
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "no model call on the confirmation path");
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
