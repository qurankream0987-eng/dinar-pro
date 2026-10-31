/**
 * W02U-3 — accessibility acceptance in real Chromium (keyboard + small screen).
 *
 * Prepares two pending reviews (one for the keyboard pass at 390, one for the 320 pass), then runs
 * artifacts/dinar/test/w02u3-card-accessibility-ui.mjs. The journey drives the drawer, the
 * composer and the card confirmation through the keyboard, checks busy/disabled and live-region
 * announcements, RTL, focus restoration and the absence of traps, and repeats the card checks at
 * 320px. No screen reader is available in CI, so the report classifies spoken-output coverage as
 * AT_MANUAL_BLOCKED with a manual checklist; the suite does not claim a screen-reader pass.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { aiResultSets, db, messages, pool } from "@workspace/db";
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
const password = "w02u3-a11y-password-1";

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
  const number = `79${((Date.now() + 613470 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
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

const seller = await register(`بائع الوصول ${runId}`);
const buyer = await register(`مشتري الوصول ${runId}`);
const title = `مراجعة الوصول ${runId}`;
const listingId = await publish(title);
const deskConversation = await conversation();
await say(deskConversation, `ابحث عن ${title}`);
const deskCard = reviewBlock(await say(deskConversation, "ابي الأول")).payload.card as { surfaceId: string; pendingReviewId: string; status: { lifecycle: string } };
assert.equal(deskCard.status.lifecycle, "PENDING_REVIEW");
const smallConversation = await conversation();
await say(smallConversation, `ابحث عن ${title}`);
const smallCard = reviewBlock(await say(smallConversation, "ابي الأول")).payload.card as { surfaceId: string; pendingReviewId: string; status: { lifecycle: string } };
assert.equal(smallCard.status.lifecycle, "PENDING_REVIEW");

await test("W02U3 accessibility real browser: keyboard, announcements, focus and 320px card", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-w02u3-accessibility-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/w02u3-card-accessibility-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02U3_WEB_BASE: web.baseUrl,
        W02U3_API_ORIGIN: origin,
        W02U3_BUYER_ID: buyer.id,
        W02U3_BUYER_COOKIE: buyer.cookie,
        W02U3_BUYER_PHONE: buyer.phone,
        W02U3_PASSWORD: password,
        W02U3_A11Y_DESK_CONVERSATION: deskConversation,
        W02U3_A11Y_SMALL_CONVERSATION: smallConversation,
        W02U3_A11Y_DESK_SURFACE: deskCard.surfaceId,
        W02U3_A11Y_SMALL_SURFACE: smallCard.surfaceId,
        W02U3_A11Y_RESULT_PATH: resultPath,
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
  console.log("W02U3_A11Y", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the accessibility journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.at?.screenReader, "AT_MANUAL_BLOCKED", "no screen-reader pass is claimed");
  assert.ok(Array.isArray(report.at?.manualChecklist) && report.at.manualChecklist.length >= 3, "the manual AT checklist is present");
  assert.equal(report.observations?.keyboard?.escapeRestoresFocus, true);
  assert.equal(report.observations?.keyboard?.selectionRestoresFocus, true);
  assert.equal(report.observations?.card?.busyLabel, "دينار يعمل الآن");
  assert.equal(report.observations?.small?.documentOverflow, 0);
  assert.equal(report.observations?.small?.cardInside, true);
  assert.ok(report.checks.length >= 5, `expected the full accessibility journey, got ${report.checks.length} checks`);

  assert.equal(await cartQuantity(listingId), 2, "each pending review was confirmed exactly once");
  for (const [card, conversationId] of [[deskCard, deskConversation], [smallCard, smallConversation]] as const) {
    const stored = await readCard(conversationId);
    assert.equal(stored.surfaceId, card.surfaceId);
    assert.equal(stored.status.lifecycle, "CONFIRMED", "the review settled once");
    assert.deepEqual(stored.allowedActions, []);
    const [row] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, card.pendingReviewId));
    assert.equal((row.query as { status?: string }).status, "CONFIRMED");
  }
  const deskUserRows = await db.select().from(messages).where(eq(messages.conversationId, deskConversation));
  assert.equal(deskUserRows.filter((row) => row.actor === "USER").length, 3, "the keyboard pass recorded one turn");
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "the accessibility journey never reaches the model");
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
