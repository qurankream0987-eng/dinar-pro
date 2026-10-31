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
 * W02U-3 — two tabs confirm the same review at the same moment.
 *
 * Both tabs of one authenticated account show the same pending review. A synchronous tap in both
 * renderers sends both confirmations before either answer returns. Exactly one effect may reach
 * the cart; both tabs must converge on the same settled identity with no stale action, through
 * their own answers and the server re-read, and a reload must not repeat anything.
 */
const webBase = process.env.W02U3_WEB_BASE;
const apiOrigin = process.env.W02U3_API_ORIGIN;
const conversationId = process.env.W02U3_CONCURRENCY_CONVERSATION;
const listingId = process.env.W02U3_LISTING_ID;
const buyer = {
  id: process.env.W02U3_BUYER_ID,
  cookie: process.env.W02U3_BUYER_COOKIE,
  phone: process.env.W02U3_BUYER_PHONE,
  password: process.env.W02U3_PASSWORD,
};
const resultPath = process.env.W02U3_CONCURRENCY_RESULT_PATH;
if (!webBase || !apiOrigin || !conversationId || !listingId || !buyer.id || !buyer.cookie || !buyer.phone || !buyer.password || !resultPath)
  throw new Error("Missing W02U-3 concurrency journey configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const concurrency = {};
let failure;
let browser;
let context;
let tab1;
let tab2;

const cardOf = (page) => page.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();
const confirmOf = (page) => page.getByTestId("purchase-confirm");

function watchTab(page, label) {
  page.on("pageerror", (error) => recorder.pageErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") recorder.consoleErrors.push(`${label}: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || recorder.allowedHosts.has(url.host) || recorder.fontHosts.has(url.hostname)) return;
    recorder.externalRequests.push(`${label}: ${url.hostname}${url.pathname}`);
  });
}

async function openConversationFromHistory(page) {
  await settleToasts(page);
  const toggle = page.getByTestId("button-toggle-conversation-history");
  if ((await toggle.getAttribute("aria-expanded").catch(() => null)) !== "true") await toggle.click();
  const item = page.getByTestId(`conversation-${conversationId}`);
  await item.waitFor({ state: "visible", timeout: 45_000 });
  await item.click();
  await cardOf(page).waitFor({ state: "visible", timeout: 45_000 });
}

async function pendingCards(page) {
  return page.locator('[data-testid="purchase-review"][data-card-lifecycle="PENDING_REVIEW"]').count();
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  ({ context, page: tab1 } = await openPage(browser, { webBase, label: "tab-1", recorder }));
  await signIn(tab1, buyer);
  await openConversationFromHistory(tab1);

  const first = await purchaseCard(tab1);
  assert.equal(first.lifecycle, "PENDING_REVIEW");
  assert.equal(await confirmOf(tab1).count(), 1, "the first tab offers the confirmation");
  concurrency.surfaceId = first.surfaceId;

  tab2 = await context.newPage();
  watchTab(tab2, "tab-2");
  // The session cookie and the conversation key are shared by the context: the second tab
  // restores the same conversation from the server.
  await tab2.goto("/");
  await tab2.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await cardOf(tab2).waitFor({ state: "visible", timeout: 45_000 });
  const second = await purchaseCard(tab2);
  assert.equal(second.surfaceId, first.surfaceId, "both tabs show the same review identity");
  assert.equal(second.lifecycle, "PENDING_REVIEW");
  checks.push("concurrency: two tabs of one account show the same pending review");

  let posts1 = 0;
  let posts2 = 0;
  tab1.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/ai/conversations/${conversationId}/turns`) posts1++;
  });
  tab2.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/ai/conversations/${conversationId}/turns`) posts2++;
  });
  // Both confirmations are held in flight before either reaches the server, so neither renderer
  // can rely on the other's answer.
  const held = [];
  await context.route(/\/api\/ai\/conversations\/[^/]+\/turns$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    held.push(route.request().postDataJSON()?.clientMessageId);
    await sleep(400);
    await route.continue();
  });

  // Both taps are dispatched in their own renderers before either answer returns.
  const tapped = await Promise.all(
    [tab1, tab2].map((page) =>
      page.evaluate(() => {
        const button = document.querySelector('[data-testid="purchase-confirm"]');
        if (!button) return false;
        button.click();
        return true;
      }),
    ),
  );
  assert.deepEqual(tapped, [true, true], "both tabs had the confirmation at the moment of the tap");
  await waitForCardLifecycle(tab1, "CONFIRMED", 45_000);
  assert.equal(held.length, 2, "both confirmations were in flight before either answer returned");
  await waitForCardLifecycle(tab2, "CONFIRMED", 45_000);
  assert.equal(posts1, 1, "the first tab sent one confirmation");
  assert.equal(posts2, 1, "the second tab sent one confirmation");
  assert.equal(await cartQuantity(apiOrigin, buyer.cookie, listingId), 1, "two concurrent confirmations add exactly one unit");
  concurrency.posts = [posts1, posts2];
  checks.push("concurrency: both confirmations were really sent and produced one effect");

  for (const [label, page] of [["tab-1", tab1], ["tab-2", tab2]]) {
    const settled = await purchaseCard(page);
    assert.equal(settled.surfaceId, first.surfaceId, `${label} keeps the review identity`);
    assert.equal(settled.lifecycle, "CONFIRMED", `${label} converges on the settled lifecycle`);
    assert.deepEqual(settled.buttons, [], `${label} offers no stale action`);
    assert.equal(await confirmOf(page).count(), 0, `${label} removed the confirmation`);
    assert.equal(await pendingCards(page), 0, `${label} shows no pending review`);
  }
  checks.push("concurrency: both tabs converge on one settled card with no stale buttons");

  for (const page of [tab1, tab2]) {
    await page.reload();
    await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
    await waitForCardLifecycle(page, "CONFIRMED", 45_000);
    assert.equal(await confirmOf(page).count(), 0, "a reload offers no stale action");
    assert.equal(await pendingCards(page), 0);
  }
  assert.equal(await cartQuantity(apiOrigin, buyer.cookie, listingId), 1, "reloading both tabs repeats no effect");
  checks.push("concurrency: both reloads restore the settled card without a second effect");

  const stored = await backend(apiOrigin, buyer.cookie, `/ai/conversations/${conversationId}`);
  assert.equal(stored.status, 200, stored.text);
  assert.equal(stored.data.messages.filter((message) => message.actor === "USER").length, 4, "each tab recorded its own turn, without duplicates");
  assert.equal(stored.data.messages.filter((message) => message.actor === "USER" && message.body === "نعم").length, 2);
  assert.equal(stored.data.messages.filter((message) => message.actor === "ASSISTANT").length, 4, "each turn has exactly one answer");
  concurrency.userRows = 4;
  assert.deepEqual(recorder.modelFallbacks, [], "the concurrent confirmations never reach the model");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        failure,
        concurrency,
        pageErrors: recorder.pageErrors,
        consoleErrors: recorder.consoleErrors,
        externalRequests: recorder.externalRequests,
        horizontalOverflow: recorder.horizontalOverflow,
        modelFallbacks: recorder.modelFallbacks,
      },
      null,
      2,
    ),
  );
  await browser?.close().catch(() => undefined);
}
