/**
 * W02U-3 — CR-11 real Chromium expiry.
 *
 * Creates a pending review with the normal server rules, then exposes a loopback-only control
 * endpoint that shortens this one review's expiresAt to a few seconds (the same fixture the HTTP
 * suite uses). The browser journey proves the client re-reads after expiry, the server returns
 * EXPIRED, no action remains, and a late confirm is refused. Afterwards the stored expiresAt must
 * be exactly the shortened value: the client never extended it. The model gateway is blocked.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { aiResultSets, db, pool } from "@workspace/db";
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
const password = "w02u3-expiry-password-1";

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
  const number = `79${((Date.now() + 154858 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
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
  assert.ok(block, `no review block in ${JSON.stringify((turn.assistantMessage?.blocks ?? []).map((candidate: any) => candidate?.type))}`);
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

const seller = await register(`بائع الانتهاء ${runId}`);
const buyer = await register(`مشتري الانتهاء ${runId}`);
const title = `مراجعة الانتهاء ${runId}`;
const listingId = await publish(title);
const conversationId = await conversation();
await say(conversationId, `ابحث عن ${title}`);
const opened = reviewBlock(await say(conversationId, "ابي الأول"));
const openedCard = opened.payload.card as { pendingReviewId: string; surfaceId: string; expiresAt: string; status: { lifecycle: string } };
assert.equal(openedCard.status.lifecycle, "PENDING_REVIEW");
assert.ok(openedCard.pendingReviewId, "the review names its pending action");
assert.ok(Date.parse(openedCard.expiresAt) > Date.now(), "the server issued the normal expiry");

const controlToken = randomUUID();
let shortenedAt: Date | undefined;
const control = createServer(async (request_, response) => {
  if (request_.headers["x-w02u3-control"] !== controlToken) {
    response.statusCode = 403;
    response.end("forbidden");
    return;
  }
  try {
    if (request_.method === "POST" && request_.url === "/shorten") {
      const expiresAt = new Date(Date.now() + 9_000);
      await db.update(aiResultSets).set({ expiresAt }).where(eq(aiResultSets.id, openedCard.pendingReviewId));
      shortenedAt = expiresAt;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ expiresAt: expiresAt.toISOString() }));
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

await test("W02U3 CR-11 real browser: a short-TTL review expires and refuses late confirmation", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-w02u3-expiry-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/w02u3-card-expiry-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02U3_WEB_BASE: web.baseUrl,
        W02U3_API_ORIGIN: origin,
        W02U3_BUYER_ID: buyer.id,
        W02U3_BUYER_COOKIE: buyer.cookie,
        W02U3_BUYER_PHONE: buyer.phone,
        W02U3_PASSWORD: password,
        W02U3_EXPIRY_CONVERSATION: conversationId,
        W02U3_EXPIRY_TITLE: title,
        W02U3_EXPIRY_SURFACE: openedCard.surfaceId,
        W02U3_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
        W02U3_CONTROL_TOKEN: controlToken,
        W02U3_EXPIRY_RESULT_PATH: resultPath,
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
  console.log("W02U3_EXPIRY", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the expiry journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.ok(shortenedAt, "the control endpoint shortened the review");
  assert.equal(report.expiry?.initialExpiresAt, openedCard.expiresAt, "the browser saw the server's original expiry");
  assert.equal(report.expiry?.shortenedExpiresAt, shortenedAt!.toISOString(), "the browser saw the shortened expiry");
  assert.ok(report.expiry.elapsedMs >= 5_000 && report.expiry.elapsedMs <= 30_000, `expiry timing: ${report.expiry.elapsedMs}ms`);
  assert.ok(report.checks.length >= 5, `expected the full expiry journey, got ${report.checks.length} checks`);

  const [row] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, openedCard.pendingReviewId));
  assert.ok(row, "the review row still exists");
  assert.equal(row.expiresAt.toISOString(), shortenedAt!.toISOString(), "the client never extended the server expiry");
  const stored = await readCard(conversationId);
  assert.equal(stored.status.lifecycle, "EXPIRED", "the stored review is terminal");
  assert.deepEqual(stored.allowedActions, []);
  assert.equal(await cartQuantity(listingId), 0, "the expired review and the late confirm have no effect");
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "no model call on the expiry path");
});

after(async () => {
  await new Promise<void>((resolve) => control.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
