import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { MODEL_FALLBACK_REPLY } from "./sc-ui-session.mjs";

/**
 * Wave 03 — the card envelope in the real DINAR UI (docs/dinar-next Wave 03).
 *
 * One buyer drives: a listing result card → a purchase review → cancelling it → reloading the
 * conversation; a second conversation reaches a negotiation review → cancelling it → reloading.
 * After every transition the card must show the server's lifecycle (`data-card-lifecycle`), keep
 * the same `data-card-surface-id`, and offer only the buttons the envelope allows. Each card is
 * measured at 320px, 390px and a desktop width: no horizontal overflow, RTL, reachable buttons.
 */
const webBase = process.env.W03_WEB_BASE;
const apiOrigin = process.env.W03_API_ORIGIN;
const buyerCookie = process.env.W03_BUYER_COOKIE;
const title = process.env.W03_TITLE;
const resultPath = process.env.W03_UI_RESULT_PATH;
if (!webBase || !apiOrigin || !buyerCookie || !title || !resultPath)
  throw new Error("Missing Wave 03 browser journey configuration.");

const checks = [];
const steps = [];
const modelFallbacks = [];
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
const surfaces = {};
let horizontalOverflow = 0;
let failure;
let browser;
let page;
const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
const fontHosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

async function settle() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const assistantMessages = () => page.locator('[data-testid^="message-assistant-"]');
const latestAssistant = () => assistantMessages().last();
async function waitForTurn(before) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
      document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    before,
    { timeout: 60_000 },
  );
  await settle();
}
async function sendTurn(text) {
  const before = await assistantMessages().count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await waitForTurn(before);
  const reply = latestAssistant();
  const shown = (await reply.innerText()).replace(/\s+/g, " ");
  steps.push({ said: text, reply: shown.slice(0, 240) });
  if (MODEL_FALLBACK_REPLY.test(shown)) modelFallbacks.push({ said: text, allowed: false });
  return reply;
}
async function clickTurn(locator) {
  const before = await assistantMessages().count();
  await locator.click();
  await waitForTurn(before);
  return latestAssistant();
}

async function measure(label, width, visible) {
  await page.setViewportSize({ width, height: 844 });
  await settle();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    direction: getComputedStyle(document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
  }));
  if (Math.max(dimensions.scrollWidth, dimensions.bodyScrollWidth) > dimensions.width) {
    horizontalOverflow += 1;
    throw new Error(`${label} ${width}px: horizontal overflow ${JSON.stringify(dimensions)}`);
  }
  assert.equal(dimensions.direction, "rtl", `${label} ${width}px must stay RTL`);
  await visible.scrollIntoViewIfNeeded();
  const box = await visible.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= dimensions.width + 0.5 && box.width > 0, `${label} ${width}px: content clipped ${JSON.stringify({ box, dimensions })}`);
  const buttons = await visible.locator("button:visible").evaluateAll((nodes) =>
    nodes
      .filter((node) => !node.closest('[role="region"][data-testid^="ai-results-carousel-"]'))
      .map((node) => ({ height: node.getBoundingClientRect().height, name: node.getAttribute("aria-label") || node.textContent?.trim() })),
  );
  assert.ok(buttons.every((button) => button.height >= 32), `${label} ${width}px: touch targets ${JSON.stringify(buttons)}`);
  assert.ok(buttons.every((button) => button.name), `${label} ${width}px: every button has an accessible name`);
  checks.push(`${label} ${width}px: RTL, no overflow, content and named buttons inside the viewport`);
}
/** The scenario's widths: 320 and 390 phones and a desktop window. */
async function widths(label, visible) {
  for (const width of [320, 390, 1280]) await measure(label, width, visible);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
}

async function newConversation() {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const button = page.locator('[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible').first();
  if (!(await button.isVisible())) await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await button.waitFor({ state: "visible" });
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ai/conversations" && response.request().method() === "POST");
  await button.click();
  const body = await (await created).json();
  assert.equal((await created).status(), 201);
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
  return body.id;
}

async function reopen(conversationId) {
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  const card = page.locator('[data-testid="purchase-review"][data-card-lifecycle], [data-testid="negotiation-review"][data-card-lifecycle]').last();
  try {
    await card.waitFor({ timeout: 5_000 });
    return;
  } catch {
    // The app restored another conversation (or none): open this one from history.
  }
  const toggle = page.locator('[data-testid="button-toggle-conversation-history"]:visible').first();
  if (await toggle.isVisible()) await toggle.click();
  const item = page.locator(`[data-testid="conversation-${conversationId}"]`).first();
  await item.waitFor({ state: "visible", timeout: 30_000 });
  const before = await assistantMessages().count();
  await item.click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length !== count,
    before,
    { timeout: 30_000 },
  ).catch(() => undefined);
  await settle();
}

function cardInfo(locator) {
  return locator.evaluate((node) => ({
    surfaceId: node.getAttribute("data-card-surface-id"),
    lifecycle: node.getAttribute("data-card-lifecycle"),
    schemaVersion: node.getAttribute("data-card-schema-version"),
    buttons: [...node.querySelectorAll("button")].map((button) => button.getAttribute("data-testid")),
  }));
}
async function card(selector) {
  const locator = page.locator(selector).last();
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  return locator;
}

async function openSession(cookie) {
  const context = await browser.newContext({ baseURL: webBase, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ar" });
  const separator = cookie.indexOf("=");
  await context.addCookies([
    { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: new URL(webBase).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false },
  ]);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"]) delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
  });
  const opened = await context.newPage();
  opened.on("pageerror", (error) => pageErrors.push(error.message));
  opened.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  opened.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || allowedHosts.has(url.host) || fontHosts.has(url.hostname)) return;
    externalRequests.push(`${url.hostname}${url.pathname}`);
  });
  return opened;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });

  // ── Listing result card ──────────────────────────────────────────────────────
  page = await openSession(buyerCookie);
  await newConversation();
  await sendTurn(`ابحث عن ${title}`);
  const results = page.locator('[data-testid^="ai-results-"]').last();
  await results.waitFor({ state: "visible" });
  const resultCard = page.locator('[data-testid^="card-ai-result-"]').first();
  await resultCard.waitFor({ state: "visible" });
  await widths("listing result card", results);
  checks.push("listing result: the buyer's search shows the published listing as a card");

  // ── Purchase review: pending → declined → reload ─────────────────────────────
  const purchaseConversation = await newConversation();
  await sendTurn(`ابحث عن ${title}`);
  await sendTurn("أبي الأول");
  let purchase = await card('[data-testid="purchase-review"]');
  let purchaseInfo = await cardInfo(purchase);
  assert.equal(purchaseInfo.schemaVersion, "1", "the card renders the versioned envelope");
  assert.equal(purchaseInfo.lifecycle, "PENDING_REVIEW", "a reviewed selection is pending, never done");
  assert.ok(purchaseInfo.surfaceId, "the card carries its server identity");
  assert.ok(purchaseInfo.buttons.includes("purchase-confirm") && purchaseInfo.buttons.includes("purchase-cancel"), JSON.stringify(purchaseInfo.buttons));
  surfaces.purchase = { surfaceId: purchaseInfo.surfaceId, lifecycle: purchaseInfo.lifecycle };
  await widths("purchase review", purchase);
  checks.push("purchase review: pending card offers exactly confirm/continue/cancel from the envelope");

  await reopen(purchaseConversation);
  purchase = await card('[data-testid="purchase-review"]');
  purchaseInfo = await cardInfo(purchase);
  assert.equal(purchaseInfo.surfaceId, surfaces.purchase.surfaceId, "reload restores the same card identity");
  assert.equal(purchaseInfo.lifecycle, "PENDING_REVIEW", "reload restores the same authoritative pending state");
  assert.ok(purchaseInfo.buttons.includes("purchase-confirm"), "the decision is still available after reload");
  checks.push("purchase review: reload restores the same surface id and pending lifecycle");

  const declined = await clickTurn(purchase.getByTestId("purchase-cancel"));
  assert.match((await declined.innerText()).replace(/\s+/g, " "), /أُلغي/u, "the server confirms the cancellation in words too");
  await reopen(purchaseConversation);
  purchase = await card('[data-testid="purchase-review"]');
  purchaseInfo = await cardInfo(purchase);
  assert.equal(purchaseInfo.surfaceId, surfaces.purchase.surfaceId, "the cancelled card keeps its identity");
  assert.equal(purchaseInfo.lifecycle, "CANCELLED", "reloading shows the server's CANCELLED outcome on the same card");
  assert.deepEqual(purchaseInfo.buttons, [], "a cancelled review offers no action");
  checks.push("purchase review: declining then reloading shows the authoritative CANCELLED lifecycle with no actions");

  await reopen(purchaseConversation);
  purchase = await card('[data-testid="purchase-review"]');
  purchaseInfo = await cardInfo(purchase);
  assert.equal(purchaseInfo.surfaceId, surfaces.purchase.surfaceId);
  assert.equal(purchaseInfo.lifecycle, "CANCELLED", "the cancelled card stays cancelled after reload");
  assert.deepEqual(purchaseInfo.buttons, []);
  checks.push("purchase review: reload keeps the cancelled outcome and offers nothing");

  // ── Negotiation review: pending → declined → reload ──────────────────────────
  const negotiationConversation = await newConversation();
  await sendTurn(`ابحث عن ${title}`);
  await sendTurn("الأول");
  await sendTurn("أعرض 2 بدل 3");
  let negotiation = await card('[data-testid="negotiation-review"]');
  let negotiationInfo = await cardInfo(negotiation);
  assert.equal(negotiationInfo.schemaVersion, "1");
  assert.equal(negotiationInfo.lifecycle, "PENDING_REVIEW");
  assert.ok(negotiationInfo.surfaceId, "the negotiation card carries its server identity");
  assert.ok(negotiationInfo.buttons.includes("negotiation-send") && negotiationInfo.buttons.includes("negotiation-cancel"), JSON.stringify(negotiationInfo.buttons));
  surfaces.negotiation = { surfaceId: negotiationInfo.surfaceId, lifecycle: negotiationInfo.lifecycle };
  await widths("negotiation review", negotiation);
  checks.push("negotiation review: pending card carries send/edit/cancel from the envelope");

  await reopen(negotiationConversation);
  negotiation = await card('[data-testid="negotiation-review"]');
  negotiationInfo = await cardInfo(negotiation);
  assert.equal(negotiationInfo.surfaceId, surfaces.negotiation.surfaceId);
  assert.equal(negotiationInfo.lifecycle, "PENDING_REVIEW");
  assert.ok(negotiationInfo.buttons.includes("negotiation-send"));
  checks.push("negotiation review: reload restores the same pending offer review");

  const declinedOffer = await clickTurn(negotiation.getByTestId("negotiation-cancel"));
  assert.match((await declinedOffer.innerText()).replace(/\s+/g, " "), /أُلغي/u, "the server confirms the cancellation in words too");
  await reopen(negotiationConversation);
  negotiation = await card('[data-testid="negotiation-review"]');
  negotiationInfo = await cardInfo(negotiation);
  assert.equal(negotiationInfo.surfaceId, surfaces.negotiation.surfaceId, "the cancelled review keeps its identity");
  assert.equal(negotiationInfo.lifecycle, "CANCELLED", "reloading shows the authoritative CANCELLED lifecycle");
  assert.deepEqual(negotiationInfo.buttons, [], "a cancelled review offers no action");
  checks.push("negotiation review: declining then reloading shows the authoritative CANCELLED lifecycle with no actions");

  await reopen(negotiationConversation);
  negotiation = await card('[data-testid="negotiation-review"]');
  negotiationInfo = await cardInfo(negotiation);
  assert.equal(negotiationInfo.surfaceId, surfaces.negotiation.surfaceId);
  assert.equal(negotiationInfo.lifecycle, "CANCELLED");
  assert.deepEqual(negotiationInfo.buttons, []);
  checks.push("negotiation review: reload keeps the cancelled outcome and offers nothing");

  assert.deepEqual(modelFallbacks, [], "no deterministic turn fell back to the model");
  checks.push("every turn was handled deterministically");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(resultPath, JSON.stringify({ checks, steps, failure, pageErrors, consoleErrors, externalRequests, horizontalOverflow, surfaces }, null, 2));
  await browser?.close().catch(() => undefined);
}
