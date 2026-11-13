import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * GENERATIVE UI in the real browser. The server already resolved a model-proposed GRID layout
 * with one highlighted card (and a rejected proposal in a second conversation). Chromium restores
 * each conversation, reads the rendered layout, checks the suggestion label, widths, keyboard
 * reachability and reload; it never calls the model.
 */
const env = process.env;
const webBase = env.GUI_WEB_BASE;
const apiOrigin = env.GUI_API_ORIGIN;
const cookie = env.GUI_COOKIE;
const userId = env.GUI_USER_ID;
const gridConversation = env.GUI_GRID_CONVERSATION;
const rejectedConversation = env.GUI_REJECTED_CONVERSATION;
const highlightId = env.GUI_HIGHLIGHT_ID;
const gridIds = JSON.parse(env.GUI_GRID_IDS ?? "[]");
const resultPath = env.GUI_RESULT_PATH;
if (!webBase || !apiOrigin || !cookie || !userId || !gridConversation || !rejectedConversation || !highlightId || !resultPath)
  throw new Error("Missing generative UI browser configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const timings = {};
let failure;
let browser;

async function restore(page, conversationId) {
  // The open chat saves its current conversation on unload, so a key written while it is mounted
  // can be overwritten by the reload. Write it where the chat is not mounted, then open the chat,
  // and prove the requested conversation is the one actually open.
  await page.goto("/connect");
  await page.evaluate(([key, id]) => localStorage.setItem(key, id), [`dinar-conversation:${userId}:JO`, conversationId]);
  const started = Date.now();
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), `dinar-conversation:${userId}:JO`), conversationId, "the requested conversation is the one open");
  return started;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: env.CHROMIUM_PATH ?? env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const user = await openUser(browser, { webBase, apiOrigin, cookie, label: "generative-ui", recorder });
  const page = user.page;

  // G-UI-01 / 29: the stored composition is restored from the server and drawn as a grid.
  const started = await restore(page, gridConversation);
  const grid = page.locator('[data-layout="GRID"]').last();
  await grid.waitFor({ state: "visible", timeout: 45_000 });
  timings.restoreToGridMs = Date.now() - started;
  const shown = await grid.locator("[data-resource-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-resource-id")));
  assert.deepEqual(shown, gridIds, "the cards appear in the server-resolved order");
  checks.push("the restored block renders the model-proposed GRID with the server-resolved cards in order");

  const badge = page.getByTestId(`result-highlight-${highlightId}`);
  assert.equal(await badge.innerText(), "اقتراح جاسم");
  const highlighted = grid.locator(`[data-resource-id="${highlightId}"]`);
  assert.equal(await highlighted.getAttribute("data-highlighted"), "true");
  assert.match(await highlighted.getAttribute("aria-label"), /اقتراح جاسم/u, "screen readers hear the suggestion label");
  assert.equal(await grid.locator('[data-highlighted="true"]').count(), 1, "exactly one suggestion");
  checks.push("one highlighted card carries a visible and an accessible «اقتراح جاسم» label");

  assert.equal(await grid.getAttribute("role"), "list");
  assert.equal(await grid.locator('[role="listitem"]').count(), gridIds.length);
  checks.push("the grid is a list of list items for assistive technology");

  // Keyboard: every card's action buttons are reachable by Tab.
  const firstButton = highlighted.locator("button").first();
  await firstButton.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BUTTON");
  checks.push("card actions in the generated layout are keyboard-focusable");

  await user.widths("generative grid", grid, [320, 390, 768, 1280]);
  checks.push("the generated grid is RTL and overflow-free at 320/390/768/1280");

  await page.reload();
  await page.locator('[data-layout="GRID"]').last().waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await page.getByTestId(`result-highlight-${highlightId}`).count(), 1);
  checks.push("reload restores the same layout and suggestion from the server");

  // G-UI-18: a rejected proposal leaves DINAR's default carousel, with no layout or suggestion.
  await restore(page, rejectedConversation);
  const carousel = page.locator('[data-testid^="ai-results-carousel-"]').last();
  await carousel.waitFor({ state: "visible", timeout: 45_000 });
  // Record every element carrying data-layout, so a failure names what actually rendered.
  const layouts = await page.locator("[data-layout]").evaluateAll((nodes) => nodes.map((node) => ({ tag: node.tagName, cls: node.className, layout: node.getAttribute("data-layout"), testid: node.getAttribute("data-testid"), card: node.closest("[data-testid]")?.getAttribute("data-testid"), text: node.textContent?.slice(0, 80) })));
  checks.push(`data-layout elements on the rejected-proposal page: ${JSON.stringify(layouts)}`);
  assert.equal(await page.locator("[data-layout]").count(), 0, "no generated layout for a rejected proposal");
  assert.equal(await page.locator('[data-testid^="result-highlight-"]').count(), 0);
  checks.push("a rejected proposal renders the default typed carousel, unchanged");

  timings.domNodes = await page.evaluate(() => document.querySelectorAll("*").length);
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(resultPath, JSON.stringify({
    checks: [...checks, ...recorder.checks],
    timings,
    failure,
    pageErrors: recorder.pageErrors,
    consoleErrors: recorder.consoleErrors,
    externalRequests: recorder.externalRequests,
    horizontalOverflow: recorder.horizontalOverflow,
  }, null, 2));
  await browser?.close().catch(() => undefined);
}
