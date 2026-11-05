/**
 * W02U-3 — delivered-but-unanswered recovery and an absent-turn retry, in real Chromium.
 *
 * A fixture creates a pending review with the normal server rules. A loopback control endpoint
 * records the user row of a turn whose response the browser never receives (delivered but
 * unanswered), then completes that record so verification adopts the answer. The next turn is
 * dropped before it reaches the server, and the retried request must reuse the original client
 * message id so the confirmation executes exactly once. The control endpoint touches fixture rows
 * only; no production route or expiry rule changes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { db, messages, pool } from "@workspace/db";import app from "../src/app";
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
const password = "w02u3-recovery-password-1";

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
  const number = `79${((Date.now() + 324528 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
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

const seller = await register(`بائع الاسترداد ${runId}`);
const buyer = await register(`مشتري الاسترداد ${runId}`);
const title = `مراجعة الاسترداد ${runId}`;
const listingId = await publish(title);
const conversationId = await conversation();
await say(conversationId, `ابحث عن ${title}`);
const opened = reviewBlock(await say(conversationId, "ابي الأول"));
const openedCard = opened.payload.card as { pendingReviewId: string; surfaceId: string; status: { lifecycle: string } };
assert.equal(openedCard.status.lifecycle, "PENDING_REVIEW");

const controlToken = randomUUID();
const control = createServer(async (request_, response) => {
  if (request_.headers["x-w02u3-control"] !== controlToken) {
    response.statusCode = 403;
    response.end("forbidden");
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request_) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (request_.method === "POST" && request_.url === "/record") {
      await db
        .insert(messages)
        .values({
          id: String(body.clientMessageId),
          conversationId: String(body.conversationId),
          senderId: buyer.id,
          actor: "USER",
          body: String(body.message),
          contentType: "TEXT",
          metadata: { turnStatus: "pending" },
        })
        .onConflictDoNothing();
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    if (request_.method === "POST" && request_.url === "/complete") {
      await db.insert(messages).values({
        id: randomUUID(),
        conversationId: String(body.conversationId),
        actor: "ASSISTANT",
        body: String(body.body),
        contentType: "TEXT",
        // The real turn writer correlates every answer to its user turn (routes/ai.ts).
        metadata: { replyToMessageId: String(body.clientMessageId) },
      });
      await db
        .update(messages)
        .set({ metadata: { turnStatus: "completed" } })
        .where(and(eq(messages.id, String(body.clientMessageId)), eq(messages.conversationId, String(body.conversationId))));
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlPort = (control.address() as { port: number }).port;

await test("W02U3 recovery real browser: delivered-but-unanswered and an absent-turn retry", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-w02u3-recovery-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/w02u3-card-recovery-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02U3_WEB_BASE: web.baseUrl,
        W02U3_API_ORIGIN: origin,
        W02U3_BUYER_ID: buyer.id,
        W02U3_BUYER_COOKIE: buyer.cookie,
        W02U3_BUYER_PHONE: buyer.phone,
        W02U3_PASSWORD: password,
        W02U3_RECOVERY_CONVERSATION: conversationId,
        W02U3_LISTING_ID: listingId,
        W02U3_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
        W02U3_CONTROL_TOKEN: controlToken,
        W02U3_RECOVERY_RESULT_PATH: resultPath,
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
  console.log("W02U3_RECOVERY", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the recovery journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.recovery?.deliberateResets, 2, "only the two deliberate transport drops reached the console");
  assert.ok(report.recovery?.delivered?.clientMessageId, "the delivered turn had a client identity");
  assert.equal(report.recovery.delivered.posts, 1, "the delivered turn was posted once");
  assert.equal(report.recovery.delivered.pendingWhileUnanswered, true);
  assert.equal(report.recovery.delivered.adoptedText?.startsWith("W02U3-RECORD-"), true);
  assert.equal(report.recovery.delivered.cartAfterDelivered, 0);
  assert.ok(report.recovery?.absent?.clientMessageId, "the absent turn had a client identity");
  assert.equal(report.recovery.absent.retriedClientMessageId, report.recovery.absent.clientMessageId, "the retry reused the original id");
  assert.equal(report.recovery.absent.posts, 3);
  assert.equal(report.recovery.absent.serverUserRows, 1);
  assert.ok(report.checks.length >= 5, `expected the full recovery journey, got ${report.checks.length} checks`);

  const rows = await db
    .select()
    .from(messages)
    .where(inArray(messages.id, [report.recovery.delivered.clientMessageId, report.recovery.absent.clientMessageId]));
  assert.equal(rows.length, 2, "one user row per attempt, no duplicates");
  for (const row of rows) {
    assert.equal(row.actor, "USER");
    assert.equal(row.senderId, buyer.id);
    assert.equal(row.metadata.turnStatus, "completed");
  }
  assert.equal(await cartQuantity(listingId), 1, "the retried confirmation executed exactly once");
  const stored = await readCard(conversationId);
  assert.equal(stored.status.lifecycle, "CONFIRMED", "the stored review settled once");
  assert.deepEqual(stored.allowedActions, []);
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "no model call on the recovery paths");
});

after(async () => {
  await new Promise<void>((resolve) => control.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
