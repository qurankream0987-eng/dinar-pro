import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder } from "./sc-ui-session.mjs";
import { openPage, purchaseCard, settleToasts, signIn, sleep, waitForCardLifecycle } from "./w02u3-ui-session.mjs";

/**
 * W02-U3 — accessibility acceptance in real Chromium.
 *
 * Everything except the final small-screen pass runs through the keyboard: the history drawer is
 * opened, closed (Escape) and re-opened, the conversation is selected, the composer is reached by
 * Tab, and the confirmation is sent with Enter. The card's busy/disabled state, its status
 * announcements, RTL, focus restoration and the absence of focus traps are asserted from the live
 * DOM. The 320px pass repeats the card checks for overflow and named, adequately sized controls.
 *
 * No screen reader is available in CI, so this suite cannot claim a screen-reader PASS: the report
 * carries AT_MANUAL_BLOCKED with the manual checklist that remains.
 */
const webBase = process.env.W02U3_WEB_BASE;
const apiOrigin = process.env.W02U3_API_ORIGIN;
const deskConversation = process.env.W02U3_A11Y_DESK_CONVERSATION;
const smallConversation = process.env.W02U3_A11Y_SMALL_CONVERSATION;
const deskSurface = process.env.W02U3_A11Y_DESK_SURFACE;
const smallSurface = process.env.W02U3_A11Y_SMALL_SURFACE;
const buyer = {
  id: process.env.W02U3_BUYER_ID,
  cookie: process.env.W02U3_BUYER_COOKIE,
  phone: process.env.W02U3_BUYER_PHONE,
  password: process.env.W02U3_PASSWORD,
};
const resultPath = process.env.W02U3_A11Y_RESULT_PATH;
if (!webBase || !apiOrigin || !deskConversation || !smallConversation || !deskSurface || !smallSurface || !buyer.id || !buyer.cookie || !buyer.phone || !buyer.password || !resultPath)
  throw new Error("Missing W02U-3 accessibility journey configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const observations = { keyboard: {}, card: {}, small: {} };
const at = {
  screenReader: "AT_MANUAL_BLOCKED",
  note: "No screen reader (NVDA/JAWS/VoiceOver) runs in CI; these are DOM and keyboard assertions, not a spoken-output pass.",
  manualChecklist: [
    "NVDA + Firefox on Windows: drawer opens/closes, conversation is announced, the review card's label and lifecycle are spoken, and «تأكيد الإضافة إلى السلة» is reachable.",
    "VoiceOver + Safari on iOS: the card and its buttons are spoken in Arabic RTL order, and the success state is announced once.",
    "TalkBack + Chrome on Android: the composer, send button and card confirmation are reachable by swipe and activated by double-tap.",
    "Announcement review: the busy state («دينار يعمل الآن») and the settled card are announced without duplicate live-region chatter.",
  ],
};
let failure;
let browser;
let context;
let page;

function watch(target, label) {
  target.on("pageerror", (error) => recorder.pageErrors.push(`${label}: ${error.message}`));
  target.on("console", (message) => {
    if (message.type() === "error") recorder.consoleErrors.push(`${label}: ${message.text()}`);
  });
  target.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || recorder.allowedHosts.has(url.host) || recorder.fontHosts.has(url.hostname)) return;
    recorder.externalRequests.push(`${label}: ${url.hostname}${url.pathname}`);
  });
}

const activeTestId = (target) => target.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

async function tabUntilTestId(target, testId, max = 40) {
  for (let press = 0; press < max; press++) {
    await target.keyboard.press("Tab");
    if ((await activeTestId(target)) === testId) return press + 1;
  }
  return 0;
}

async function drawerOpen(target) {
  return (await target.getByTestId("button-toggle-conversation-history").getAttribute("aria-expanded").catch(() => null)) === "true";
}

async function keyboardOpenConversation(target, conversationId) {
  const toggle = target.getByTestId("button-toggle-conversation-history");
  const insideDialog = () => target.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  await toggle.focus();
  await target.keyboard.press("Enter");
  await target.waitForFunction(() => document.querySelector('[data-testid="button-toggle-conversation-history"]')?.getAttribute("aria-expanded") === "true", null, { timeout: 15_000 });
  await target.waitForFunction(() => Boolean(document.activeElement?.closest('[role="dialog"]')), null, { timeout: 10_000 });
  assert.equal(await insideDialog(), true, "opening the drawer moves focus inside the dialog");
  observations.keyboard.dialogReceivesFocus = true;

  // Escape closes the drawer without a pointer and returns focus to the trigger.
  await target.keyboard.press("Escape");
  await target.waitForFunction(() => document.querySelector('[data-testid="button-toggle-conversation-history"]')?.getAttribute("aria-expanded") !== "true", null, { timeout: 15_000 });
  await target.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "button-toggle-conversation-history", null, { timeout: 10_000 });
  observations.keyboard.escapeRestoresFocus = true;

  await target.keyboard.press("Enter");
  await target.waitForFunction(() => document.querySelector('[data-testid="button-toggle-conversation-history"]')?.getAttribute("aria-expanded") === "true", null, { timeout: 15_000 });
  await target.waitForFunction(() => Boolean(document.activeElement?.closest('[role="dialog"]')), null, { timeout: 10_000 });
  const reached = await tabUntilTestId(target, `conversation-${conversationId}`, 40);
  assert.ok(reached > 0, "the conversation is reachable with Tab inside the drawer");
  await target.keyboard.press("Enter");
  await target.waitForFunction(() => document.querySelector('[data-testid="button-toggle-conversation-history"]')?.getAttribute("aria-expanded") !== "true", null, { timeout: 15_000 });
  await target.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "button-toggle-conversation-history", null, { timeout: 10_000 });
  observations.keyboard.conversationTabStops = reached;
  observations.keyboard.selectionRestoresFocus = true;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  ({ context, page } = await openPage(browser, { webBase, label: "a11y-keyboard", recorder }));
  await signIn(page, buyer);
  await settleToasts(page);

  await keyboardOpenConversation(page, deskConversation);
  const card = page.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();
  await card.waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await card.getAttribute("data-card-surface-id"), deskSurface);
  const cardLabel = (await card.getAttribute("aria-label")) ?? "";
  assert.ok(cardLabel.trim().length > 0, "the review card has an accessible name");

  // Document language, direction and the named controls.
  const doc = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
  assert.equal(doc.dir, "rtl", "the document is RTL");
  assert.equal(doc.lang, "ar", "the document is declared Arabic");
  assert.equal(await page.getByRole("textbox", { name: "رسالتك إلى DINAR AI" }).count(), 1, "the composer has its accessible name");
  assert.equal(await page.getByRole("button", { name: "إرسال الرسالة" }).count(), 1, "the send button has its accessible name");
  assert.equal(await page.getByRole("button", { name: "تأكيد الإضافة إلى السلة" }).count(), 1, "the card confirmation has its accessible name");
  assert.equal(await page.getByRole("log").count(), 1, "the thread is a log region");
  assert.equal(await page.locator('#composer-hint[role="status"]').count(), 1, "the composer exposes a status region");
  checks.push("a11y: keyboard opens, closes and reopens the drawer, selecting the conversation and restoring focus");

  // Reach the composer by Tab, type, and send with Enter while the answer is held in flight.
  const composerReached = await tabUntilTestId(page, "input-ai-composer", 80);
  assert.ok(composerReached > 0, "the composer is reachable with Tab");
  await page.keyboard.type("نعم");
  assert.equal((await page.getByTestId("input-ai-composer").inputValue()).trim(), "نعم");
  const sendReached = await tabUntilTestId(page, "button-send-ai-message", 8);
  assert.ok(sendReached > 0, "the send button is reachable with Tab from the composer");
  observations.keyboard.composerTabStops = composerReached;
  observations.keyboard.sendTabStops = sendReached;

  await context.route(/\/api\/ai\/conversations\/[^/]+\/turns$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await sleep(900);
    await route.continue();
  });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-busy") === "true", null, { timeout: 10_000 });
  const busy = await page.getByTestId("button-send-ai-message").evaluate((node) => ({ label: node.getAttribute("aria-label"), disabled: node.disabled }));
  assert.equal(busy.label, "دينار يعمل الآن", "the busy send button announces its state");
  assert.equal(busy.disabled, true, "the busy send button is disabled");
  const typing = page.locator('[data-testid="ai-typing"]');
  assert.equal(await typing.getAttribute("role"), "status", "progress is announced through a status region");
  assert.equal(await typing.isVisible(), true, "the progress region is visible while the answer is held");
  assert.equal(await card.locator("fieldset").first().getAttribute("aria-busy"), "true", "the card is marked busy while the turn runs");
  observations.card.busyLabel = busy.label;
  observations.card.progressRole = "status";
  checks.push("a11y: the busy state is disabled and announced while the answer is in flight");

  await waitForCardLifecycle(page, "CONFIRMED", 60_000);
  await page.waitForFunction(() => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة", null, { timeout: 30_000 });
  await settleToasts(page);
  const settled = await purchaseCard(page);
  assert.equal(settled.surfaceId, deskSurface);
  assert.equal(settled.lifecycle, "CONFIRMED");
  assert.deepEqual(settled.buttons, [], "the settled card offers no further action");
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName?.toLowerCase() ?? null,
      hidden: Boolean(element?.closest('[aria-hidden="true"], [inert]')),
      connected: Boolean(element?.isConnected),
      inDialog: Boolean(element?.closest('[role="dialog"]')),
    };
  });
  assert.equal(focus.connected, true, "focus never stays on a detached node");
  assert.equal(focus.hidden, false, "focus never rests inside an aria-hidden or inert subtree");
  assert.equal(focus.inDialog, false, "no dialog remains open after the confirmation");
  await page.keyboard.press("Tab");
  const next = await page.evaluate(() => {
    const element = document.activeElement;
    const rect = element?.getBoundingClientRect();
    return {
      tag: element?.tagName?.toLowerCase() ?? null,
      visible: Boolean(rect && rect.width > 0 && rect.height > 0),
      name: element?.getAttribute("aria-label") || element?.textContent?.trim().slice(0, 60) || null,
      testId: element?.getAttribute("data-testid") ?? null,
    };
  });
  assert.equal(next.visible, true, "the next Tab stop is a visible control, not a trap");
  assert.ok(next.name, "the next Tab stop has an accessible name");
  observations.card.focusAfterConfirm = focus;
  observations.card.nextTabStop = next;
  checks.push("a11y: after the confirmation focus stays live and Tab reaches a visible named control");

  // 320px pass: the card, names, tap sizes and overflow.
  const small = await browser.newContext({ baseURL: webBase, viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true, locale: "ar" });
  const smallPage = await small.newPage();
  watch(smallPage, "a11y-320");
  await signIn(smallPage, buyer);
  await settleToasts(smallPage);
  const smallToggle = smallPage.getByTestId("button-toggle-conversation-history");
  await smallToggle.click();
  await smallPage.getByTestId(`conversation-${smallConversation}`).waitFor({ state: "visible", timeout: 45_000 });
  await smallPage.getByTestId(`conversation-${smallConversation}`).click();
  const smallCard = smallPage.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();
  await smallCard.waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await smallCard.getAttribute("data-card-surface-id"), smallSurface);
  assert.equal((await smallCard.getAttribute("aria-label"))?.trim().length > 0, true);

  const layout = await smallPage.evaluate(() => {
    const thread = document.querySelector('[data-testid="conversation-thread"]');
    const card = document.querySelector('[data-testid="purchase-review"]');
    const cardRect = card?.getBoundingClientRect();
    const buttons = [...(card?.querySelectorAll("button") ?? [])].map((node) => ({
      height: node.getBoundingClientRect().height,
      name: node.getAttribute("aria-label") || node.textContent?.trim() || "",
    }));
    return {
      dir: document.documentElement.dir,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      threadOverflow: thread ? thread.scrollWidth - thread.clientWidth : 0,
      cardInside: Boolean(cardRect && cardRect.left >= -0.5 && cardRect.right <= window.innerWidth + 0.5),
      buttons,
      unnamed: [...document.querySelectorAll("button")].filter((node) => node.getClientRects().length && !(node.getAttribute("aria-label") || node.textContent?.trim())).length,
      small: [...document.querySelectorAll("button")].filter((node) => node.getClientRects().length && node.getBoundingClientRect().height < 32).length,
    };
  });
  assert.equal(layout.dir, "rtl");
  assert.equal(layout.documentOverflow, 0, "320px document has no horizontal overflow");
  assert.equal(layout.threadOverflow, 0, "320px thread has no horizontal overflow");
  assert.equal(layout.cardInside, true, "the review card stays inside the 320px viewport");
  assert.ok(layout.buttons.every((button) => button.height >= 32), `card tap targets: ${JSON.stringify(layout.buttons)}`);
  assert.ok(layout.buttons.every((button) => button.name), "every card button has an accessible name");
  assert.equal(layout.unnamed, 0, "every visible button on the screen has an accessible name");
  assert.equal(layout.small, 0, "every visible button meets the 32px tap height");
  observations.small = { ...layout, buttons: layout.buttons.length };
  checks.push("a11y: at 320px the card stays inside the viewport with named, 32px+ controls and no overflow");

  await smallPage.getByTestId("purchase-confirm").click();
  await waitForCardLifecycle(smallPage, "CONFIRMED", 60_000);
  assert.equal((await purchaseCard(smallPage)).lifecycle, "CONFIRMED");
  checks.push("a11y: the 320px card can be confirmed and settles with no remaining action");
  await small.close();
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify({ checks, failure, at, observations, pageErrors: recorder.pageErrors, consoleErrors: recorder.consoleErrors, externalRequests: recorder.externalRequests, modelFallbacks: recorder.modelFallbacks }, null, 2),
  );
  await browser?.close().catch(() => undefined);
}
