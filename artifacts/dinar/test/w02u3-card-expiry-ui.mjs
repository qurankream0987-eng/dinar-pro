import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder } from "./sc-ui-session.mjs";
import { openPage, purchaseCard, settleToasts, signIn, sleep, waitForCardLifecycle } from "./w02u3-ui-session.mjs";

/**
 * W02U-3 — CR-11 real-browser expiry.
 *
 * A fixture creates a pending review with the normal server rules, then the harness (after the
 * card is visible) asks the wrapper's loopback control endpoint to shorten that review's expiry
 * to a few seconds. The server-issued expiresAt is read back through the browser session; the
 * client re-reads only when its timer passes, the card becomes EXPIRED, its action disappears, a
 * late confirm is refused, and the identity never changes. The wrapper checks afterwards that the
 * expiry value in PostgreSQL was never extended by the client.
 */
const webBase = process.env.W02U3_WEB_BASE;
const apiOrigin = process.env.W02U3_API_ORIGIN;
const conversationId = process.env.W02U3_EXPIRY_CONVERSATION;
const title = process.env.W02U3_EXPIRY_TITLE;
const surfaceId = process.env.W02U3_EXPIRY_SURFACE;
const controlUrl = process.env.W02U3_CONTROL_URL;
const controlToken = process.env.W02U3_CONTROL_TOKEN;
const buyer = {
  id: process.env.W02U3_BUYER_ID,
  cookie: process.env.W02U3_BUYER_COOKIE,
  phone: process.env.W02U3_BUYER_PHONE,
  password: process.env.W02U3_PASSWORD,
};
const resultPath = process.env.W02U3_EXPIRY_RESULT_PATH;
if (!webBase || !apiOrigin || !conversationId || !title || !surfaceId || !controlUrl || !controlToken || !buyer.id || !buyer.cookie || !buyer.phone || !buyer.password || !resultPath)
  throw new Error("Missing W02U-3 expiry journey configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const expiry = {};
let failure;
let browser;
let page;

const cardOf = () => page.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();

async function serverCard() {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/ai/conversations/${id}`);
    const view = await response.json();
    for (const message of view.messages ?? [])
      for (const block of message.blocks ?? [])
        if (block?.payload?.purchaseReview) return block.payload.card;
    return null;
  }, conversationId);
}

async function control(path, method = "GET") {
  const response = await fetch(`${controlUrl}${path}`, { method, headers: { "x-w02u3-control": controlToken } });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  assert.equal(response.status, 200, `${path}: ${response.status} ${text.slice(0, 200)}`);
  return data;
}

async function openConversationFromHistory() {
  await settleToasts(page);
  const toggle = page.getByTestId("button-toggle-conversation-history");
  if ((await toggle.getAttribute("aria-expanded").catch(() => null)) !== "true") await toggle.click();
  const item = page.getByTestId(`conversation-${conversationId}`);
  await item.waitFor({ state: "visible", timeout: 45_000 });
  await item.click();
  await cardOf().waitFor({ state: "visible", timeout: 45_000 });
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  ({ page } = await openPage(browser, { webBase, label: "expiry", recorder }));

  await signIn(page, buyer);
  await openConversationFromHistory();

  // Every execution attempt is a turn POST; expiry must never produce one by itself.
  let turnPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/ai/conversations/${conversationId}/turns`) turnPosts++;
  });

  // ── the review starts pending with the server identity ──────────────────────
  const started = await purchaseCard(page);
  assert.equal(started.lifecycle, "PENDING_REVIEW");
  assert.equal(started.surfaceId, surfaceId, "the fixture review is the one on screen");
  assert.ok(started.buttons.includes("purchase-confirm"), "the confirmation is offered while pending");
  const initialServer = await serverCard();
  assert.equal(initialServer?.status?.lifecycle, "PENDING_REVIEW");
  assert.ok(Date.parse(initialServer?.expiresAt) > Date.now(), "the server issued a real expiry");
  expiry.initialExpiresAt = initialServer.expiresAt;
  checks.push("CR-11: the review starts PENDING_REVIEW with a server-issued expiry and an offered action");

  // ── shorten the fixture to a controlled short TTL ───────────────────────────
  const shortened = await control("/shorten", "POST");
  expiry.shortenedExpiresAt = shortened.expiresAt;
  const shortenedServer = await serverCard();
  assert.equal(shortenedServer?.status?.lifecycle, "PENDING_REVIEW", "the shortened review is still pending");
  assert.equal(shortenedServer?.expiresAt, shortened.expiresAt, "the server-issued expiry is the shortened one");
  assert.equal(shortenedServer?.surfaceId, started.surfaceId, "the identity does not change with the expiry");
  // A focus re-read adopts the shortened card without executing anything.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const startedAt = Date.now();
  await sleep(2000);
  const stillPending = await purchaseCard(page);
  assert.equal(stillPending.lifecycle, "PENDING_REVIEW", "the card is still pending before its expiry");
  checks.push("CR-11: the browser re-reads the server-issued short expiry without extending or executing it");

  // ── the browser refreshes by itself when the expiry passes ──────────────────
  await waitForCardLifecycle(page, "EXPIRED", 30_000);
  expiry.elapsedMs = Date.now() - startedAt;
  assert.ok(expiry.elapsedMs >= 5_000, `the expiry was not jumped: ${expiry.elapsedMs}ms`);
  const expired = await purchaseCard(page);
  assert.equal(expired.surfaceId, surfaceId, "the review identity survives expiry");
  assert.deepEqual(expired.buttons, [], "an expired review offers no action");
  assert.equal(await page.getByTestId("purchase-confirm").count(), 0, "the confirm button is gone");
  const expiredServer = await serverCard();
  assert.equal(expiredServer?.status?.lifecycle, "EXPIRED", "the server reports EXPIRED");
  assert.deepEqual(expiredServer?.allowedActions, [], "the server allows no action");
  checks.push("CR-11: the client refreshes after expiry and the server returns EXPIRED with no action");
  assert.equal(turnPosts, 0, "the expiry refresh sent no turn");
  checks.push("CR-11: the automatic expiry refresh is a re-read, never an execution");

  // ── a late confirmation cannot revive or execute the review ─────────────────
  const late = await page.evaluate(
    async ({ id, clientMessageId }) => {
      const response = await fetch(`/api/ai/conversations/${id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "نعم", clientMessageId }),
      });
      return { status: response.status, text: await response.text() };
    },
    { id: conversationId, clientMessageId: randomUUID() },
  );
  assert.equal(late.status, 200, late.text.slice(0, 300));
  assert.match(late.text, /انتهت صلاحية/u, late.text.slice(0, 400));
  assert.equal(turnPosts, 1, "only the deliberate late attempt ever sent a turn");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(1500);
  const afterLate = await purchaseCard(page);
  assert.equal(afterLate.lifecycle, "EXPIRED", "a late confirmation does not revive the card");
  assert.equal(afterLate.surfaceId, surfaceId, "the identity is stable after the late attempt");
  assert.deepEqual(afterLate.buttons, []);
  const afterLateServer = await serverCard();
  assert.equal(afterLateServer?.status?.lifecycle, "EXPIRED");
  expiry.afterLateExpiresAt = afterLateServer?.expiresAt ?? null;
  checks.push("CR-11: a late confirm is refused, revives nothing and keeps the identity");

  assert.deepEqual(recorder.modelFallbacks, [], "the deterministic expiry path never reaches the model");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        failure,
        expiry,
        pageErrors: recorder.pageErrors,
        consoleErrors: recorder.consoleErrors,
        externalRequests: recorder.externalRequests,
        steps: recorder.steps,
        modelFallbacks: recorder.modelFallbacks,
      },
      null,
      2,
    ),
  );
  await browser?.close().catch(() => undefined);
}
