import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const webBase = process.env.BLOCKE_WEB_BASE;
const apiOrigin = process.env.BLOCKE_API_ORIGIN;
const sellerCookie = process.env.BLOCKE_SELLER_COOKIE;
const buyerCookie = process.env.BLOCKE_BUYER_COOKIE;
const runId = process.env.BLOCKE_RUN_ID;
const listingTitle = process.env.BLOCKE_LISTING_TITLE;
const resultPath = process.env.BLOCKE_UI_RESULT_PATH;
if (!webBase || !apiOrigin || !sellerCookie || !buyerCookie || !runId || !listingTitle || !resultPath)
  throw new Error("Missing Block E browser acceptance configuration.");

const checks = [];
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
let staticFontRequests = 0;
let horizontalOverflow = 0;
let unlabeledSponsored = 0;
// Server truth: listing ids the API itself marked as paid placements in turn responses.
const serverSponsored = new Set();
let failure;
let browser;
const contexts = [];
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
}

async function clickTurn(locator) {
  const before = await assistantMessages().count();
  await locator.click();
  await waitForTurn(before);
}

async function measure(label, width, visible) {
  await page.setViewportSize({ width, height: 844 });
  await settle();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    direction: getComputedStyle(document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
  }));
  if (Math.max(dimensions.scrollWidth, dimensions.bodyScrollWidth) > dimensions.width) {
    horizontalOverflow += 1;
    throw new Error(`${label} ${width}px: horizontal overflow ${JSON.stringify(dimensions)}`);
  }
  assert.equal(dimensions.direction, "rtl", `${label} ${width}px must stay RTL`);
  const composer = await page.getByTestId("input-ai-composer").boundingBox();
  assert.ok(composer && composer.y >= 0 && composer.y + composer.height <= dimensions.height, `${label} ${width}px: composer obscured`);
  await visible.scrollIntoViewIfNeeded();
  const box = await visible.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= dimensions.width + 0.5 && box.width > 0, `${label} ${width}px: content clipped ${JSON.stringify({ box, dimensions })}`);
  // Result carousels scroll horizontally by design; everything else must fit.
  const overflowing = await visible.evaluate((element) =>
    [element, ...element.querySelectorAll("*")].filter((node) => {
      if (node.closest('[role="region"][data-testid^="ai-results-carousel-"]')) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.right > window.innerWidth + 0.5 || rect.left < -0.5);
    }).length,
  );
  assert.equal(overflowing, 0, `${label} ${width}px: ${overflowing} descendants outside the viewport`);
  const buttons = await visible.locator("button:visible").evaluateAll((nodes) =>
    nodes
      .filter((node) => !node.closest('[role="region"][data-testid^="ai-results-carousel-"]'))
      .map((node) => ({ height: node.getBoundingClientRect().height, name: node.getAttribute("aria-label") || node.textContent?.trim() })),
  );
  assert.ok(buttons.every((button) => button.height >= 32), `${label} ${width}px: touch targets ${JSON.stringify(buttons)}`);
  assert.ok(buttons.every((button) => button.name), `${label} ${width}px: every button has an accessible name`);
  checks.push(`${label} ${width}px: RTL, no horizontal overflow, composer visible, content and named buttons inside the viewport`);
}

async function mobile(label, visible) {
  for (const width of [320, 360, 390, 414]) await measure(label, width, visible);
  await page.setViewportSize({ width: 390, height: 844 });
}

async function newConversation() {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const button = page.locator('[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible').first();
  if (!(await button.isVisible())) await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await button.waitFor({ state: "visible" });
  const created = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/ai/conversations" && response.request().method() === "POST",
  );
  await button.click();
  assert.equal((await created).status(), 201);
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
}

async function openSession(cookie) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ar",
  });
  contexts.push(context);
  const separator = cookie.indexOf("=");
  await context.addCookies([
    {
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      domain: new URL(webBase).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
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
  opened.on("response", async (response) => {
    if (!/\/api\/ai\/conversations\/[^/]+(?:\/turns)?$/.test(new URL(response.url()).pathname)) return;
    try {
      const text = await response.text();
      const payloads = text.trim().startsWith("{")
        ? [JSON.parse(text)]
        : text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
      const walk = (value) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") {
          if (value.isSponsored === true && typeof value.id === "string") serverSponsored.add(value.id);
          Object.values(value).forEach(walk);
        }
      };
      payloads.forEach(walk);
    } catch {
      // Streaming bodies that closed early are covered by the DOM checks.
    }
  });
  opened.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || allowedHosts.has(url.host)) return;
    if (fontHosts.has(url.hostname)) staticFontRequests += 1;
    else externalRequests.push(`${url.hostname}${url.pathname}`);
  });
  return opened;
}

/** Sponsored placements come from the server; every one must carry the visible text label. */
async function sponsoredLabelsAccurate(results, label) {
  const cards = results.locator('[data-testid^="card-ai-result-"]');
  const count = await cards.count();
  let labelled = 0;
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const tag = card.locator('[data-testid^="label-sponsored-"]');
    const id = await card.getAttribute("data-resource-id");
    if (serverSponsored.has(id) && !(await tag.count())) unlabeledSponsored += 1;
    if (await tag.count()) {
      labelled += 1;
      assert.equal((await tag.innerText()).trim(), "إعلان ممول", `${label}: label text`);
      assert.ok(await tag.isVisible(), `${label}: label visible`);
    }
  }
  return { count, labelled };
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium" });

  // ── Seller: promote through the conversation, simulated payment, see the campaign ──
  page = await openSession(sellerCookie);
  await newConversation();
  await sendTurn("روّج إعلاني");
  const options = latestAssistant().getByTestId("promotion-surface-promotion_options");
  await options.waitFor();
  const target = options.locator('[data-testid^="promotion-listing-"]').filter({ hasText: listingTitle });
  await target.waitFor();
  await mobile("PROMOTION_OPTIONS (listings, long title)", options);
  await clickTurn(target.getByRole("button", { name: `ترويج ${listingTitle}` }));
  const plans = latestAssistant().getByTestId("promotion-surface-promotion_options");
  await plans.getByTestId("promotion-plans").waitFor();
  await mobile("PROMOTION_OPTIONS (plans)", plans);
  checks.push("seller picked their own listing from server-issued options");
  await clickTurn(plans.getByTestId("promotion-plan-1").getByRole("button"));
  const review = latestAssistant().getByTestId("promotion-surface-promotion_review");
  await review.getByTestId("promotion-review").waitFor();
  const reviewText = await review.innerText();
  assert.match(reviewText, /JOD/);
  assert.match(reviewText, /إعلان ممول/);
  assert.match(reviewText, /لا تجديد تلقائي/);
  assert.match(reviewText, /TEST_NO_TRANSFER/);
  await mobile("PROMOTION_REVIEW", review);
  checks.push("review shows listing, placement, duration, price, currency, label and no auto-renew before confirmation");
  await clickTurn(review.getByTestId("promotion-confirm"));
  const status = latestAssistant().getByTestId("promotion-surface-promotion_status");
  await status.getByTestId("promotion-status").waitFor();
  assert.equal(await status.getByTestId("promotion-status").getAttribute("data-status"), "ACTIVE");
  await mobile("PROMOTION_STATUS (simulated payment captured)", status);
  checks.push("confirmation paid through the simulation and activated the campaign");

  // Reload: the active campaign is restored from the server.
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  const restored = latestAssistant().getByTestId("promotion-surface-promotion_status");
  await restored.getByTestId("promotion-status").waitFor();
  assert.equal(await restored.getByTestId("promotion-status").getAttribute("data-status"), "ACTIVE");
  const settledReview = page.getByTestId("promotion-surface-promotion_review").last();
  assert.equal(await settledReview.getByTestId("promotion-confirm").count(), 0, "a settled review offers no action after reload");
  checks.push("reload restored the active campaign and the settled review from the server");

  await sendTurn("اعرض حملاتي");
  const mine = latestAssistant().getByTestId("promotion-surface-my_promotions");
  await mine.getByTestId("my-promotion-1").waitFor();
  assert.equal(await mine.getByTestId("my-promotion-1").getAttribute("data-status"), "ACTIVE");
  await mobile("MY_PROMOTIONS", mine);
  await clickTurn(mine.getByTestId("promotion-details-1"));
  const details = latestAssistant().getByTestId("promotion-surface-promotion_details");
  await details.getByTestId("promotion-campaign").waitFor();
  await mobile("PROMOTION_DETAILS", details);
  await clickTurn(details.getByTestId("promotion-pause"));
  const paused = latestAssistant().getByTestId("promotion-surface-promotion_status");
  assert.equal(await paused.getByTestId("promotion-status").getAttribute("data-status"), "PAUSED");
  await clickTurn(paused.getByTestId("promotion-resume"));
  const resumed = latestAssistant().getByTestId("promotion-surface-promotion_status");
  assert.equal(await resumed.getByTestId("promotion-status").getAttribute("data-status"), "ACTIVE");
  checks.push("seller viewed, paused and resumed only their own campaign");

  // ── Buyer: relevant sponsored result is labelled; recommendations from real listings ──
  page = await openSession(buyerCookie);
  await newConversation();
  await sendTurn(`ابحث عن ثريا ${runId}`);
  const results = latestAssistant().getByTestId("ai-results-list");
  await results.waitFor();
  const promotedCard = results.locator('[data-testid^="card-ai-result-"]').filter({ hasText: listingTitle });
  await promotedCard.locator('[data-testid^="label-sponsored-"]').waitFor();
  await page.waitForTimeout(300);
  const labels = await sponsoredLabelsAccurate(results, "search");
  assert.ok(serverSponsored.size >= 1, "the server marked the paid placement");
  assert.equal(labels.labelled, 1, "exactly the one relevant campaign is labelled");
  assert.ok(labels.count >= 3, "organic results remain");
  await mobile("SEARCH with sponsored result", results);
  checks.push("buyer search shows the relevant sponsored listing once, with a visible text label");

  await sendTurn("الأول");
  await latestAssistant().getByTestId("ai-results-details").waitFor();
  await sendTurn("أرني أشياء مشابهة");
  const recommendations = latestAssistant().getByTestId("ai-results-list");
  await recommendations.locator('[data-testid^="recommendation-reasons-"]').first().waitFor();
  const recommendedIds = await recommendations
    .locator('[data-testid^="card-ai-result-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-resource-id")));
  assert.ok(recommendedIds.length >= 2, "recommendations come from real listings");
  const recommendationLabels = await sponsoredLabelsAccurate(recommendations, "recommendations");
  assert.ok(recommendationLabels.labelled <= 1);
  await mobile("RECOMMENDATION_RESULTS", recommendations);
  await sendTurn("الثاني");
  const opened = latestAssistant().getByTestId("ai-results-details");
  await opened.waitFor();
  const openedId = await opened.locator('[data-testid^="card-ai-result-"]').first().getAttribute("data-resource-id");
  assert.equal(openedId, recommendedIds[1], "«الثاني» opened the exact second recommendation");
  checks.push("recommendations rendered with reasons and «الثاني» opened the exact second one");

  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  await page.getByTestId("ai-results-details").last().waitFor();
  const restoredRecommendations = page.locator(`[data-testid="ai-results-list"]`).last();
  await restoredRecommendations.locator('[data-testid^="recommendation-reasons-"]').first().waitFor();
  checks.push("reload restored the recommendation result set with its reasons");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  for (const context of contexts) {
    for (const opened of context.pages()) await opened.waitForLoadState("networkidle").catch(() => undefined);
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  }
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        pageErrors,
        consoleErrors,
        horizontalOverflow,
        externalRequests,
        staticFontRequests,
        unlabeledSponsored,
        failure,
      },
      null,
      2,
    ),
  );
  await browser?.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
