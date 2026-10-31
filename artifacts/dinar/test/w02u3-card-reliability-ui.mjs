import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, MODEL_FALLBACK_REPLY, openUser } from "./sc-ui-session.mjs";

/**
 * W02U-3 — canonical card reliability in the real browser.
 *
 * Two tabs of one account see one pending review; confirming in the first tab reaches the second
 * without a reload. A tap while offline never reaches the server. A response dropped after the
 * server committed is reconciled from the server record, not reported as a failure and not
 * re-executed. The review card is usable at 320/390/768/1024/1280 with ≥44px named buttons and a
 * keyboard confirmation. A forged broadcast or a planted localStorage payload changes nothing.
 */
const webBase = process.env.W02U3_WEB_BASE;
const apiOrigin = process.env.W02U3_API_ORIGIN;
const buyerCookie = process.env.W02U3_BUYER_COOKIE;
const buyerId = process.env.W02U3_BUYER_ID;
const firstTitle = process.env.W02U3_FIRST_TITLE;
const secondTitle = process.env.W02U3_SECOND_TITLE;
const firstListingId = process.env.W02U3_FIRST_LISTING_ID;
const secondListingId = process.env.W02U3_SECOND_LISTING_ID;
const resultPath = process.env.W02U3_UI_RESULT_PATH;
if (!webBase || !apiOrigin || !buyerCookie || !buyerId || !firstTitle || !secondTitle || !firstListingId || !secondListingId || !resultPath)
  throw new Error("Missing W02U-3 browser journey configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const surfaces = {};
const tabErrors = [];
let failure;
let browser;

const assistantMessages = (page) => page.locator('[data-testid^="message-assistant-"]');
const cardOf = (page) => page.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();

function watch(page, label) {
  page.on("pageerror", (error) => tabErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") tabErrors.push(`${label}: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || recorder.allowedHosts.has(url.host) || recorder.fontHosts.has(url.hostname)) return;
    recorder.externalRequests.push(`${label}: ${url.hostname}${url.pathname}`);
  });
}

async function cardInfo(page) {
  const card = cardOf(page);
  await card.waitFor({ state: "visible", timeout: 45_000 });
  return card.evaluate((node) => ({
    surfaceId: node.getAttribute("data-card-surface-id"),
    lifecycle: node.getAttribute("data-card-lifecycle"),
    schemaVersion: node.getAttribute("data-card-schema-version"),
    label: node.getAttribute("aria-label"),
    buttons: [...node.querySelectorAll("button")].map((button) => ({
      height: button.getBoundingClientRect().height,
      name: button.getAttribute("aria-label") || button.textContent?.trim() || "",
      testId: button.getAttribute("data-testid"),
    })),
  }));
}

async function measure(page, label, locator, widths = [320, 390, 768, 1024, 1280]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      direction: getComputedStyle(document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
    }));
    assert.equal(geometry.direction, "rtl", `${label} ${width}px keeps RTL`);
    assert.ok(geometry.scrollWidth <= geometry.width, `${label} ${width}px has no horizontal overflow: ${JSON.stringify(geometry)}`);
    await locator.scrollIntoViewIfNeeded();
    const buttons = await locator.locator("button:visible").evaluateAll((nodes) =>
      nodes.map((node) => ({ height: node.getBoundingClientRect().height, name: node.getAttribute("aria-label") || node.textContent?.trim() || "" })),
    );
    assert.ok(buttons.every((button) => button.height >= 44), `${label} ${width}px touch targets: ${JSON.stringify(buttons)}`);
    assert.ok(buttons.every((button) => button.name.length > 0), `${label} ${width}px every button is named`);
    checks.push(`${label} ${width}px: RTL, no overflow, named buttons ≥44px`);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function cartQuantity(buyer, listingId) {
  const cart = await buyer.api("/cart");
  const line = (Array.isArray(cart) ? cart : []).find((item) => item.listingId === listingId);
  return line?.quantity ?? 0;
}

async function waitForCardLifecycle(page, lifecycle, timeout = 20_000) {
  await page.waitForFunction(
    (expected) => {
      const cards = [...document.querySelectorAll('[data-testid="purchase-review"][data-card-lifecycle]')];
      return cards.some((card) => card.getAttribute("data-card-lifecycle") === expected);
    },
    lifecycle,
    { timeout },
  );
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const buyer = await openUser(browser, { webBase, apiOrigin, cookie: buyerCookie, label: "buyer", recorder });
  const page = buyer.page;
  watch(page, "tab-1");

  // ── CR-01/02: two tabs, one pending review, one confirming side ──────────────
  await buyer.newConversation();
  await buyer.say(`ابحث عن ${firstTitle}`);
  await buyer.say("ابي الأول");
  const first = await cardInfo(page);
  assert.equal(first.schemaVersion, "1");
  assert.equal(first.lifecycle, "PENDING_REVIEW", "the review is pending, never done");
  assert.ok(first.surfaceId, "the card has a server identity");
  assert.ok(first.label, "the card has an accessible name");
  surfaces.pending = { surfaceId: first.surfaceId, lifecycle: first.lifecycle };
  await measure(page, "purchase review", cardOf(page));
  checks.push("CR-13: the review is RTL, overflow-free and keyboard-reachable at 320/390/768/1024/1280");

  const second = await buyer.context.newPage();
  watch(second, "tab-2");
  await second.setViewportSize({ width: 390, height: 900 });
  await second.goto("/");
  await second.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await cardOf(second).waitFor({ state: "visible", timeout: 45_000 });
  const restored = await cardInfo(second);
  assert.equal(restored.surfaceId, first.surfaceId, "the second tab restores the same card identity");
  assert.equal(restored.lifecycle, "PENDING_REVIEW", "and the same server lifecycle");
  checks.push("CR-01: two tabs of one account show one pending review with one identity");

  await buyer.click(cardOf(page).getByTestId("purchase-confirm"));
  assert.equal(await cartQuantity(buyer, firstListingId), 1, "the confirmation adds exactly one unit");
  await waitForCardLifecycle(second, "CONFIRMED", 20_000);
  const propagated = await cardInfo(second);
  assert.equal(propagated.surfaceId, first.surfaceId, "the second tab keeps the identity");
  assert.deepEqual(propagated.buttons, [], "the second tab offers no stale action");
  checks.push("CR-02: the confirmation propagates to the second tab without a reload");

  await second.reload();
  await cardOf(second).waitFor({ state: "visible", timeout: 45_000 });
  const afterReload = await cardInfo(second);
  assert.equal(afterReload.lifecycle, "CONFIRMED", "a reload re-reads the settled server state");
  assert.deepEqual(afterReload.buttons, []);
  assert.equal(await cartQuantity(buyer, firstListingId), 1, "the reload does not repeat the effect");
  checks.push("CR-10: reload restores the confirmed card with no second effect");

  // ── CR-07: a tap while offline never reaches the server ─────────────────────
  let turnPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/turns")) turnPosts++;
  });
  await buyer.newConversation();
  await buyer.say(`ابحث عن ${secondTitle}`);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await buyer.context.setOffline(true);
  await page.getByText("أنت غير متصل").waitFor({ timeout: 15_000 });
  const beforeOffline = turnPosts;
  await page.getByTestId("input-ai-composer").fill(`ابحث عن ${secondTitle}`);
  assert.equal(await page.getByTestId("button-send-ai-message").isDisabled(), true, "the send button is disabled offline");
  await page.getByTestId("input-ai-composer").press("Enter");
  await page.waitForTimeout(600);
  assert.equal(turnPosts, beforeOffline, "no turn request leaves the tab while offline");
  assert.equal(
    (await page.getByTestId("input-ai-composer").inputValue()).replace(/\s+$/u, ""),
    `ابحث عن ${secondTitle}`,
    "the draft is kept",
  );
  checks.push("CR-07: offline keeps the draft and sends nothing");

  await buyer.context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("أنت غير متصل").waitFor({ state: "hidden", timeout: 15_000 });
  await buyer.say(`ابحث عن ${secondTitle}`);
  assert.ok(turnPosts > beforeOffline, "the draft becomes a real turn once online");
  checks.push("CR-07: the held draft is sent once online, and only then");

  // ── CR-08/CR-09: a response dropped after the server committed ───────────────
  let dropNextTurn = false;
  await page.route("**/api/ai/conversations/*/turns", async (route) => {
    if (!dropNextTurn) return route.fallback();
    dropNextTurn = false;
    try {
      await route.fetch({ timeout: 90_000 });
    } catch {
      // The server write is what matters; the client still receives no response.
    }
    await route.abort("connectionreset");
  });
  const assistantsBefore = await assistantMessages(page).count();
  dropNextTurn = true;
  await page.getByTestId("input-ai-composer").fill("ابي الأول");
  await page.getByTestId("button-send-ai-message").click();
  const reconciled = await cardInfo(page);
  assert.equal(reconciled.lifecycle, "PENDING_REVIEW", "the delivered turn is reconciled from the server record");
  assert.equal(reconciled.buttons.some((button) => button.testId === "purchase-confirm"), true);
  assert.equal(await assistantMessages(page).count(), assistantsBefore + 1, "the dropped turn appears once, not twice");
  const bodyText = await page.locator(".dinar-chatgpt").innerText();
  assert.doesNotMatch(bodyText, /تعذر إكمال الرد الآن/u, "a delivered turn is not reported as a failed reply");
  assert.equal(await cartQuantity(buyer, secondListingId), 0, "reconciliation executes nothing");
  checks.push("CR-08: a dropped response is reconciled from the server, not claimed as failure");
  // The simulated transport failure is the only network error the browser may report; anything
  // else in the console is a real defect and stays in the report.
  const droppedConsole = recorder.consoleErrors.filter((entry) => entry.endsWith("net::ERR_CONNECTION_RESET"));
  assert.equal(droppedConsole.length, 1, `one deliberate drop, not ${JSON.stringify(recorder.consoleErrors)}`);
  recorder.consoleErrors = recorder.consoleErrors.filter((entry) => !entry.endsWith("net::ERR_CONNECTION_RESET"));

  // ── CR-13/CR-14: widths, touch targets, keyboard confirmation ───────────────
  await measure(page, "reconciled review", cardOf(page));
  const confirm = cardOf(page).getByTestId("purchase-confirm");
  await confirm.focus();
  assert.equal(await confirm.evaluate((node) => node === document.activeElement), true, "the confirm button is keyboard-focusable");
  const beforeKeyboard = await assistantMessages(page).count();
  await page.keyboard.press("Enter");
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > count, beforeKeyboard, { timeout: 60_000 });
  assert.equal(await cartQuantity(buyer, secondListingId), 1, "Enter on the focused confirm executes once");
  checks.push("CR-14: Enter on the focused confirmation executes the same server action");

  // ── CR-12: forged broadcast and planted storage change nothing ──────────────
  const forged = await second.evaluate(
    ({ userId }) => {
      const channel = new BroadcastChannel(`dinar:card-sync:v1:${userId}:JO`);
      channel.postMessage({ type: "dinar.cards.invalidate", userId, marketId: "JO", conversationId: "6f1c1c61-1f6f-4c61-9f6f-3f0c6f0e2222", issuedAt: Date.now(), card: { status: "CONFIRMED", allowedActions: ["CONFIRM"] } });
      channel.postMessage({ type: "execute", action: "ADD_TO_CART", listingId: "forged" });
      channel.close();
      localStorage.setItem(`dinar-card:${userId}:JO`, JSON.stringify({ surface: "PURCHASE_REVIEW", lifecycle: "PENDING_REVIEW", price: "0.000" }));
      return localStorage.getItem(`dinar-card:${userId}:JO`) !== null;
    },
    { userId: buyerId },
  );
  assert.equal(forged, true, "the forged storage entry was written for the test");
  await second.waitForTimeout(1500);
  const afterForgery = await cardInfo(second);
  assert.equal(afterForgery.lifecycle, "CONFIRMED", "a forged broadcast cannot revive a card");
  assert.equal(await cartQuantity(buyer, firstListingId), 1, "a forged broadcast executes nothing");
  checks.push("CR-12: forged broadcast and planted storage are ignored; the server record still wins");

  assert.deepEqual(recorder.modelFallbacks, [], "no deterministic turn fell back to the model");
  assert.ok(recorder.steps.every((step) => !MODEL_FALLBACK_REPLY.test(step.reply)), "no model fallback reply was accepted");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        failure,
        surfaces,
        tabErrors: [...tabErrors, ...recorder.pageErrors, ...recorder.consoleErrors],
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
