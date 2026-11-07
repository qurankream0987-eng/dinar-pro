import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder } from "./sc-ui-session.mjs";
import {
  backend,
  cartQuantity,
  openPage,
  purchaseCard,
  settleToasts,
  signIn,
  sleep,
  waitForCardLifecycle,
} from "./w02u3-ui-session.mjs";

/**
 * W02U-3 — delivered-but-unanswered recovery and an absent-turn retry in the real browser.
 *
 * The first turn reaches the server (its user row is recorded by the fixture's loopback control
 * endpoint) but the browser never receives a response. The page must not claim a failure and must
 * not resend: it offers «تحقق من النتيجة», and verifying before the record is answered keeps the
 * truthful pending state. Once the fixture completes the record, the same control adopts the
 * answer from the server. The second turn never reaches the server at all: the page offers
 * «إعادة المحاولة», and the retry re-reads the conversation and resends with the original client
 * message id, so the confirmation executes exactly once.
 */
const webBase = process.env.W02U3_WEB_BASE;
const apiOrigin = process.env.W02U3_API_ORIGIN;
const conversationId = process.env.W02U3_RECOVERY_CONVERSATION;
const buyer = {
  id: process.env.W02U3_BUYER_ID,
  cookie: process.env.W02U3_BUYER_COOKIE,
  phone: process.env.W02U3_BUYER_PHONE,
  password: process.env.W02U3_PASSWORD,
};
const listingId = process.env.W02U3_LISTING_ID;
const controlUrl = process.env.W02U3_CONTROL_URL;
const controlToken = process.env.W02U3_CONTROL_TOKEN;
const resultPath = process.env.W02U3_RECOVERY_RESULT_PATH;
if (!webBase || !apiOrigin || !conversationId || !buyer.id || !buyer.cookie || !buyer.phone || !buyer.password || !listingId || !controlUrl || !controlToken || !resultPath)
  throw new Error("Missing W02U-3 recovery journey configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const recovery = { delivered: {}, absent: {} };
let failure;
let browser;
let context;
let page;

const cardOf = () => page.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();
const alertOf = () => page.locator('.dinar-chat-dock [role="alert"]').first();

async function control(path, method = "GET", body) {
  const response = await fetch(`${controlUrl}${path}`, {
    method,
    headers: { "x-w02u3-control": controlToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

async function idle() {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    null,
    { timeout: 60_000 },
  );
}

async function alertText() {
  const alert = alertOf();
  await alert.waitFor({ state: "visible", timeout: 60_000 });
  return (await alert.innerText()).replace(/\s+/g, " ");
}

async function sendExpectingAlert(text, { pending = false } = {}) {
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  const shown = await alertText();
  if (pending) {
    // A recorded, unanswered turn locks the composer until its outcome is known.
    // Waiting for idle here contradicts server-owned execution/recovery policy.
    await page.getByTestId("button-verify-ai-turn").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.getByTestId("button-send-ai-message").getAttribute("aria-busy"), "true");
    assert.equal(await page.getByTestId("button-send-ai-message").isDisabled(), true);
    assert.equal(await page.getByTestId("button-retry-ai-turn").count(), 0);
  } else {
    await idle();
  }
  return shown;
}

async function conversationFromServer() {
  const view = await backend(apiOrigin, buyer.cookie, `/ai/conversations/${conversationId}`);
  assert.equal(view.status, 200, view.text);
  return view.data;
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

let mode = "record";
const posts = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  ({ context, page } = await openPage(browser, { webBase, label: "recovery", recorder }));

  await signIn(page, buyer);
  await openConversationFromHistory();

  const started = await purchaseCard(page);
  assert.equal(started.lifecycle, "PENDING_REVIEW");
  assert.ok(started.buttons.includes("purchase-confirm"), "the review starts with its confirmation offered");

  // The first turn is recorded on the server but its response never reaches the browser.
  await context.route(/\/api\/ai\/conversations\/[^/]+\/turns$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    posts.push({ clientMessageId: body.clientMessageId, message: body.message, mode });
    if (mode === "pass") return route.fallback();
    if (mode === "record") {
      try {
        await control("/record", "POST", { conversationId, clientMessageId: body.clientMessageId, message: body.message });
      } catch (error) {
        recorder.pageErrors.push(`record: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await route.abort("connectionreset");
  });

  const delivered = await sendExpectingAlert("نعم", { pending: true });
  recovery.delivered.clientMessageId = posts[0]?.clientMessageId;
  recovery.delivered.posts = posts.length;
  assert.equal(posts.length, 1, "the delivered turn was posted once");
  assert.match(delivered, /وصل طلبك/u, "a delivered turn is not reported as missing");
  assert.doesNotMatch(delivered, /لم يصل طلبك/u);
  assert.equal(await page.getByTestId("button-retry-ai-turn").count(), 0, "a delivered turn is never offered for resending");
  assert.equal(await page.getByTestId("button-verify-ai-turn").isVisible(), true, "the page offers «تحقق من النتيجة»");
  assert.equal(
    await page.getByTestId("button-send-ai-message").getAttribute("aria-label"),
    "دينار يعمل الآن",
    "a new send in this conversation waits for verification (no duplicate)",
  );
  assert.equal(await cartQuantity(apiOrigin, buyer.cookie, listingId), 0, "a delivered turn executes nothing by itself");
  const pendingNow = await conversationFromServer();
  recovery.delivered.cartAfterDelivered = 0;
  const pendingRow = pendingNow.messages.find((message) => message.id === recovery.delivered.clientMessageId);
  assert.ok(pendingRow, "the server recorded the unconfirmed turn");
  recovery.delivered.serverHasPendingUser = true;
  assert.equal(
    pendingNow.messages.some((message) => message.actor === "ASSISTANT" && Date.parse(message.createdAt) > Date.parse(pendingRow.createdAt)),
    false,
    "no answer exists yet",
  );
  checks.push("recovery: a delivered but unanswered turn offers verification and never resends");

  // Verifying before the record is answered keeps the truthful pending state.
  const verifyRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/ai/conversations/${conversationId}` && response.request().method() === "GET");
  await page.getByTestId("button-verify-ai-turn").click();
  await verifyRead;
  await page.getByTestId("button-verify-ai-turn").waitFor({ state: "visible", timeout: 15_000 });
  const stillPendingAlert = await alertText();
  assert.match(stillPendingAlert, /وصل طلبك/u, "an unconfirmed turn still says the request arrived");
  assert.doesNotMatch(stillPendingAlert, /لم يصل طلبك/u);
  assert.equal(await page.getByTestId("button-verify-ai-turn").isVisible(), true);
  assert.equal(posts.length, 1, "verifying never resends the turn");
  recovery.delivered.pendingWhileUnanswered = true;
  checks.push("recovery: verifying an unanswered record keeps the pending state and resends nothing");

  // The fixture completes the record; the same control adopts the answer from the server.
  const marker = `W02U3-RECORD-${Date.now().toString(36)}`;
  await control("/complete", "POST", { conversationId, clientMessageId: recovery.delivered.clientMessageId, body: marker });
  const completedRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/ai/conversations/${conversationId}` && response.request().method() === "GET");
  await page.getByTestId("button-verify-ai-turn").click();
  await completedRead;
  await alertOf().waitFor({ state: "detached", timeout: 45_000 });
  await page.getByText(marker, { exact: false }).waitFor({ timeout: 45_000 });
  assert.equal(posts.length, 1, "adopting the answer never resends the turn");
  assert.equal(await page.getByTestId("button-verify-ai-turn").count(), 0);
  const afterAdopt = await purchaseCard(page);
  assert.equal(afterAdopt.lifecycle, "PENDING_REVIEW", "an adopted answer does not execute the pending review");
  assert.equal(await cartQuantity(apiOrigin, buyer.cookie, listingId), 0);
  recovery.delivered.adoptedText = marker;
  checks.push("recovery: verification adopts the answer the server recorded, without resending");

  // The second turn never reaches the server; the retry must keep its original identity.
  mode = "drop";
  const absent = await sendExpectingAlert("نعم");
  const absentId = posts[1]?.clientMessageId;
  recovery.absent.clientMessageId = absentId;
  assert.equal(posts.length, 2);
  assert.notEqual(absentId, recovery.delivered.clientMessageId, "the second turn is a new request");
  assert.match(absent, /لم يصل طلبك/u, "an absent turn is reported as missing");
  assert.equal(await page.getByTestId("button-verify-ai-turn").count(), 0, "an absent turn is not offered for verification");
  assert.equal(await page.getByTestId("button-retry-ai-turn").isVisible(), true, "the page offers «إعادة المحاولة»");
  const afterDrop = await conversationFromServer();
  assert.equal(afterDrop.messages.some((message) => message.id === absentId), false, "the absent turn left no record");
  assert.equal(await cartQuantity(apiOrigin, buyer.cookie, listingId), 0);
  checks.push("recovery: an absent turn offers a retry and left no server record");

  // Retrying re-reads the record first and resends with the same client message id.
  mode = "pass";
  const assistantsBeforeRetry = await page.locator('[data-testid^="message-assistant-"]').count();
  await page.getByTestId("button-retry-ai-turn").click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > count,
    assistantsBeforeRetry,
    { timeout: 90_000 },
  );
  await waitForCardLifecycle(page, "CONFIRMED", 60_000);
  await idle();
  const retried = posts[2];
  recovery.absent.retriedClientMessageId = retried?.clientMessageId;
  recovery.absent.posts = posts.length;
  assert.equal(posts.length, 3, "the retry posted exactly once");
  assert.equal(retried?.message, "نعم");
  assert.equal(retried?.clientMessageId, absentId, "the retry reuses the original client message id");
  assert.equal(await cartQuantity(apiOrigin, buyer.cookie, listingId), 1, "the retried confirmation executes exactly once");
  const settled = await conversationFromServer();
  const userRows = settled.messages.filter((message) => message.id === absentId);
  recovery.absent.serverUserRows = userRows.length;
  assert.equal(userRows.length, 1, "the server keeps exactly one user row for the retried turn");
  assert.equal(settled.messages.filter((message) => message.actor === "USER" && message.body === "نعم").length, 2, "one user row per attempt, and no duplicates");
  const confirmedCard = await purchaseCard(page);
  assert.equal(confirmedCard.lifecycle, "CONFIRMED");
  assert.deepEqual(confirmedCard.buttons, [], "a settled review offers no further action");
  await page.reload();
  await waitForCardLifecycle(page, "CONFIRMED", 45_000);
  assert.equal(await cartQuantity(apiOrigin, buyer.cookie, listingId), 1, "the reload repeats no effect");
  checks.push("recovery: the retry keeps the original identity and executes the confirmation once");

  assert.deepEqual(recorder.modelFallbacks, [], "the recovery paths never reach the model");
  // Only the two deliberate transport failures may appear in the console.
  const resets = recorder.consoleErrors.filter((entry) => entry.endsWith("net::ERR_CONNECTION_RESET"));
  recovery.deliberateResets = resets.length;
  assert.equal(resets.length, 2, `two deliberate drops, not ${JSON.stringify(recorder.consoleErrors)}`);
  recorder.consoleErrors = recorder.consoleErrors.filter((entry) => !entry.endsWith("net::ERR_CONNECTION_RESET"));
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        failure,
        recovery,
        posts,
        pageErrors: recorder.pageErrors,
        consoleErrors: recorder.consoleErrors,
        externalRequests: recorder.externalRequests,
        horizontalOverflow: recorder.horizontalOverflow,
        steps: recorder.steps,
        modelFallbacks: recorder.modelFallbacks,
      },
      null,
      2,
    ),
  );
  await browser?.close().catch(() => undefined);
}
