import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

/**
 * Block F5 connected journeys in the real DINAR chat UI, against the real API and a
 * disposable database: seller draft → publish → listings; buyer search → comparison →
 * purchase review → order → payment review; promotion review; driver onboarding, work
 * cards and assignment; employment profile; one user switching roles in one chat.
 */
const webBase = process.env.F5_WEB_BASE;
const apiOrigin = process.env.F5_API_ORIGIN;
const cookies = {
  buyer: process.env.F5_BUYER_COOKIE,
  seller: process.env.F5_SELLER_COOKIE,
  driver: process.env.F5_DRIVER_COOKIE,
  candidate: process.env.F5_CANDIDATE_COOKIE,
};
const sellerCookies = JSON.parse(process.env.F5_SELLER_COOKIES ?? "{}");
const runId = process.env.F5_RUN_ID;
const city = process.env.F5_CITY;
const resultPath = process.env.F5_UI_RESULT_PATH;
const uiListingIds = JSON.parse(process.env.F5_UI_LISTING_IDS ?? "[]");
if (!webBase || !apiOrigin || Object.values(cookies).some((value) => !value) || !runId || !city || !resultPath || !uiListingIds.length)
  throw new Error("Missing Block F5 browser acceptance configuration.");

const checks = [];
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
let horizontalOverflow = 0;
let failure;
let trackingDebug;
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
async function openHistorySidebar() {
  await page.locator(
    '[data-testid="button-toggle-conversation-history"]:visible, [data-testid="button-expand-conversation-sidebar"]:visible',
  ).first().click();
}
async function sendTurn(text) {
  const before = await assistantMessages().count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await waitForTurn(before);
  return latestAssistant();
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
  const composerLocator = page.getByTestId("input-ai-composer");
  if (await composerLocator.count()) {
    const composer = await composerLocator.boundingBox();
    assert.ok(composer && composer.y >= 0 && composer.y + composer.height <= dimensions.height, `${label} ${width}px: composer obscured`);
  }
  await visible.scrollIntoViewIfNeeded();
  const box = await visible.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= dimensions.width + 0.5 && box.width > 0, `${label} ${width}px: content clipped ${JSON.stringify({ box, dimensions })}`);
  const outside = await visible.evaluate((element) =>
    [element, ...element.querySelectorAll("*")].filter((node) => {
      if (node.closest('[role="region"][data-testid^="ai-results-carousel-"]')) return false;
      // Any other intentional swipe row (the narrow-screen comparison cards) scrolls inside itself.
      const region = node.parentElement?.closest('[role="region"]');
      if (region && ["auto", "scroll"].includes(getComputedStyle(region).overflowX)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.right > window.innerWidth + 0.5 || rect.left < -0.5);
    }).length,
  );
  assert.equal(outside, 0, `${label} ${width}px: ${outside} descendants outside the viewport`);
  const buttons = await visible.locator("button:visible").evaluateAll((nodes) =>
    nodes
      .filter((node) => !node.closest('[role="region"][data-testid^="ai-results-carousel-"]'))
      .map((node) => ({ height: node.getBoundingClientRect().height, name: node.getAttribute("aria-label") || node.textContent?.trim() })),
  );
  assert.ok(buttons.every((button) => button.height >= 32), `${label} ${width}px: touch targets ${JSON.stringify(buttons)}`);
  assert.ok(buttons.every((button) => button.name), `${label} ${width}px: every button has an accessible name`);
  checks.push(`${label} ${width}px: RTL, no overflow, composer visible, content and named buttons inside the viewport`);
}
async function mobile(label, visible) {
  for (const width of [320, 360, 390, 414]) await measure(label, width, visible);
  await page.setViewportSize({ width: 390, height: 844 });
}
async function requestedViewports(label, visible, prepare) {
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await settle();
    await prepare?.(width);
    await measure(label, width, visible);
  }
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
  assert.equal((await created).status(), 201);
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
}

async function openSession(cookie) {
  const context = await browser.newContext({ baseURL: webBase, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ar" });
  contexts.push(context);
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
  await opened.addInitScript(() => {
    const events = [];
    window.addEventListener("error", (event) => events.push({
      type: "error",
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error instanceof Error ? `${event.error.name}: ${event.error.message}\n${event.error.stack ?? ""}` : String(event.error),
    }));
    window.addEventListener("error", (event) => {
      if (event.message === "ResizeObserver loop completed with undelivered notifications.") {
        event.stopImmediatePropagation();
      }
    });
    window.addEventListener("unhandledrejection", (event) => events.push({
      type: "unhandledrejection",
      reason: event.reason instanceof Error ? `${event.reason.name}: ${event.reason.message}\n${event.reason.stack ?? ""}` : String(event.reason),
    }));
    Object.defineProperty(window, "__dinarRuntimeEvents", { value: events });
  });
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

  // ── Seller: conversational draft → publish review → published → my listings ──
  page = await openSession(cookies.seller);
  await newConversation();
  await sendTurn(`أريد أبيع آيفون 13 نظيف بـ200`);
  for (const answer of ["قطعة واحدة", city, "محادثة فقط", "كاش"]) await sendTurn(answer);
  const draft = latestAssistant().getByTestId("draft-review");
  await draft.waitFor();
  await mobile("SELL draft review (provenance, missing fields)", latestAssistant());
  const review = await sendTurn("انشره");
  assert.match(await review.innerText(), /هل تريد نشر الإعلان/);
  await mobile("SELL publish review", review);
  const published = await sendTurn("نعم");
  assert.match(await published.innerText(), /تم نشر الإعلان/);
  checks.push("seller published a conversational draft through the Block B authority after a review");
  const listingsNav = page.getByTestId("nav-my-listings");
  if (!(await listingsNav.isVisible()))
    await openHistorySidebar();
  await listingsNav.waitFor({ state: "visible" });
  await listingsNav.click();
  const listings = latestAssistant();
  await listings.locator('[data-testid^="chat-seller-listing-"]').first().waitFor();
  await mobile("MY_LISTINGS", listings);
  await requestedViewports("SIGNED_IN_MY_LISTINGS", listings);
  // Promotion from the same chat: options → week → review → cancel.
  await sendTurn("روّج إعلاني");
  const options = latestAssistant().getByTestId("promotion-surface-promotion_options");
  await options.waitFor();
  const chandelier = options.locator('[data-testid^="promotion-listing-"]').filter({ hasText: "ثريا" });
  await chandelier.first().waitFor();
  await clickTurn(chandelier.first().getByRole("button").first());
  const plans = latestAssistant().getByTestId("promotion-surface-promotion_options");
  await plans.getByTestId("promotion-plans").waitFor();
  await clickTurn(plans.getByTestId("promotion-plan-1").getByRole("button"));
  const promotionReview = latestAssistant().getByTestId("promotion-surface-promotion_review");
  await promotionReview.getByTestId("promotion-review").waitFor();
  assert.match(await promotionReview.innerText(), /JOD/);
  await mobile("PROMOTION_REVIEW", promotionReview);
  await sendTurn("إلغاء");
  checks.push("seller reached the real promotion review from the chat and cancelled it");

  const historyToggle = page.locator(
    '[data-testid="button-toggle-conversation-history"]:visible, [data-testid="button-expand-conversation-sidebar"]:visible',
  ).first();
  if (await historyToggle.isVisible()) await historyToggle.click();
  const historyRow = page.locator('#conversation-history-list [data-testid^="conversation-"]').first();
  await historyRow.waitFor();
  await requestedViewports("RECENT_CONVERSATIONS", historyRow, async (width) => {
    if (width < 1024) {
      const drawer = page.locator('#ai-conversation-history[role="dialog"]');
      if (!(await drawer.isVisible())) {
        await openHistorySidebar();
        await drawer.waitFor({ state: "visible" });
      }
    }
  });
  const closeHistory = page.getByTestId("button-close-conversation-drawer");
  if (await closeHistory.isVisible()) await closeHistory.click();
  const accountButton = page.locator(
    '[data-testid="link-history-account"]:visible, [data-testid="button-rail-account"]:visible',
  ).first();
  if (!(await accountButton.isVisible())) await openHistorySidebar();
  await accountButton.click();
  const accountHeading = latestAssistant().getByRole("heading", { name: "DINAR F5 UI Seller", exact: true });
  await accountHeading.waitFor();
  await requestedViewports("SIGNED_IN_ACCOUNT", accountHeading);
  checks.push("signed-in seller opened recent conversations and account across requested widths");

  // ── Buyer: search → comparison → purchase review → order review → order → payment review ──
  page = await openSession(cookies.buyer);
  await newConversation();
  const results = await sendTurn(`أريد ثريا ${runId}`);
  await results.getByTestId("ai-results-list").waitFor();
  await mobile("SEARCH results", results.getByTestId("ai-results-list"));
  const comparison = await sendTurn("قارن الأول والثاني");
  await comparison.getByTestId("comparison").waitFor();
  await mobile("COMPARISON", comparison.getByTestId("comparison"));
  const item = await sendTurn("أبي الأول");
  const purchase = item.getByTestId("purchase-review");
  await purchase.waitFor();
  await mobile("PURCHASE_REVIEW (item)", purchase);
  let orderReview = await clickTurn(purchase.getByTestId("purchase-continue"));
  await orderReview.getByTestId("purchase-review").waitFor();
  assert.match(await orderReview.innerText(), /مراجعة الطلب/);
  await mobile("PURCHASE_REVIEW (order)", orderReview.getByTestId("purchase-review"));
  const fulfilmentChoice = orderReview.locator('[data-testid^="purchase-fulfilment-"]').first();
  await clickTurn(fulfilmentChoice);
  orderReview = latestAssistant();
  const placed = await clickTurn(orderReview.getByTestId("purchase-confirm"));
  assert.match(await placed.innerText(), /تم إنشاء الطلب/);
  const buyerOrdersResponse = await fetch(`${apiOrigin}/api/orders?role=buyer`, {
    headers: { Cookie: cookies.buyer },
  });
  assert.equal(buyerOrdersResponse.status, 200);
  const buyerOrders = await buyerOrdersResponse.json();
  const createdOrder = buyerOrders.find((order) =>
    uiListingIds.includes(order.listingId) ||
    order.items?.some((line) => uiListingIds.includes(line.listingId)),
  ) ?? buyerOrders[0];
  assert.ok(createdOrder, "buyer can see the newly created order");
  const sellerCookie = sellerCookies[createdOrder.sellerId];
  assert.ok(sellerCookie, `test has the authenticated seller for order ${createdOrder.id}`);
  const sellerOrdersResponse = await fetch(`${apiOrigin}/api/orders?role=seller`, {
    headers: { Cookie: sellerCookie },
  });
  assert.equal(sellerOrdersResponse.status, 200);
  const sellerOrders = await sellerOrdersResponse.json();
  assert.ok(sellerOrders.some((order) => order.id === createdOrder.id), "the order's seller can see the buyer's order");
  const payment = await sendTurn("ادفع");
  let paymentReview = payment.getByTestId("purchase-review");
  await paymentReview.waitFor();
  assert.match(await paymentReview.innerText(), /SIMULATION_ONLY/);
  await mobile("PAYMENT_REVIEW", paymentReview);
  const cardChoice = paymentReview.getByTestId("purchase-payment-CARD");
  const paymentChoice = (await cardChoice.count())
    ? cardChoice
    : paymentReview.getByTestId("purchase-payment-CASH_DIRECT");
  await clickTurn(paymentChoice);
  paymentReview = latestAssistant().getByTestId("purchase-review");
  const paid = await clickTurn(paymentReview.getByTestId("purchase-confirm"));
  assert.match(await paid.innerText(), /لم تُحوَّل/);
  checks.push("buyer selected an allowed payment method; no money moved");
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  const restored = page.getByTestId("purchase-review").last();
  await restored.waitFor();
  assert.match(await page.getByTestId("purchase-selected-payment-method").last().innerText(), /كاش|فيزا/);
  checks.push("reload restored the selected payment method from the server");
  const orderHistory = await sendTurn("طلباتي");
  const orderRow = orderHistory.getByTestId("order-result-1");
  await orderRow.waitFor();
  await mobile("ORDERS_LIST", orderRow);
  await requestedViewports("SIGNED_IN_ORDERS_LIST", orderRow);
  checks.push("buyer opened the typed order history in chat with its first result visible");

  const statusQuestion = await sendTurn("أين طلبي؟");
  await statusQuestion.locator('[data-testid^="status-"]').waitFor();
  const statusQuestionAgain = await sendTurn("وين طلبي؟");
  await statusQuestionAgain.locator('[data-testid^="status-"]').waitFor();

  const trackingTurn = await sendTurn("تتبع طلبي");
  const trackingPanel = trackingTurn.locator('section[data-testid^="order-tracking-"]');
  try {
    await trackingPanel.waitFor();
  } catch (error) {
    trackingDebug = {
      assistantText: await trackingTurn.innerText().catch(() => ""),
      testIds: await trackingTurn.locator("[data-testid]").evaluateAll((nodes) =>
        nodes.map((node) => ({
          id: node.getAttribute("data-testid"),
          text: node.textContent?.slice(0, 120),
        })),
      ).catch(() => []),
    };
    throw error;
  }
  await trackingPanel.getByText("هذا الطلب لا يستخدم توصيل المندوب.").waitFor();
  await mobile("ORDER_TRACKING", trackingPanel);
  await requestedViewports("ORDER_TRACKING", trackingPanel);
  const driverTurn = await sendTurn("وين السائق؟");
  const driverPanel = driverTurn.locator('section[data-testid^="order-tracking-"]');
  await driverPanel.waitFor();
  await driverPanel.getByText("هذا الطلب لا يستخدم توصيل المندوب.").waitFor();
  const shownTurn = await sendTurn("افتح الخريطة");
  const shownPanel = shownTurn.locator('section[data-testid^="order-tracking-"]');
  await shownPanel.waitFor();
  assert.equal(await shownPanel.getByTestId("button-toggle-order-map").count(), 0);
  assert.equal(await shownPanel.getByTestId("order-tracking-map-placeholder").count(), 0);
  const hiddenTurn = await sendTurn("أخفِ الخريطة");
  const hiddenPanel = hiddenTurn.locator('section[data-testid^="order-tracking-"]');
  await hiddenPanel.waitFor();
  assert.equal(await hiddenPanel.getByTestId("button-toggle-order-map").count(), 0);
  assert.equal(await hiddenPanel.getByTestId("order-tracking-map-placeholder").count(), 0);
  checks.push("tracking remains unavailable without a provider; map commands do not create map or location placeholders");

  const previousAssistantIds = await assistantMessages().evaluateAll((messages) =>
    messages.map((message) => message.getAttribute("data-testid")),
  );
  await page.goto("/orders");
  try {
    await page.waitForFunction(
      (previousIds) =>
        [...document.querySelectorAll('[data-testid^="message-assistant-"]')].some(
          (message) =>
            !previousIds.includes(message.getAttribute("data-testid")) &&
            message.querySelector('[data-testid="order-result-1"]'),
        ),
      previousAssistantIds,
      { timeout: 20_000 },
    );
  } catch (error) {
    const routeState = await page.evaluate((previousIds) => {
      const messages = [...document.querySelectorAll('[data-testid^="message-assistant-"]')];
      return {
        path: `${window.location.pathname}${window.location.search}`,
        assistantCount: messages.length,
        newAssistants: messages
          .filter((message) => !previousIds.includes(message.getAttribute("data-testid")))
          .map((message) => ({
            id: message.getAttribute("data-testid"),
            orderRows: message.querySelectorAll('[data-testid^="order-result-"]').length,
          })),
        visibleOrderRows: document.querySelectorAll('[data-testid^="order-result-"]').length,
      };
    }, previousAssistantIds);
    throw new Error(`Orders route did not render a new order card: ${String(error)}; state=${JSON.stringify(routeState)}`);
  }
  const routedOrderRow = latestAssistant().getByTestId("order-result-1");
  await routedOrderRow.waitFor({ timeout: 60_000 });
  await mobile("ORDERS_SIDEBAR_ENTRY", routedOrderRow);
  checks.push("/orders redirected into a new chat order list");

  // ── Driver: available work cards → accept → assignment (approved before the browser) ──
  page = await openSession(cookies.driver);
  await newConversation();
  const work = await sendTurn("اعرض لي توصيلات");
  const workPanel = work.getByTestId("driver-panel");
  await workPanel.getByTestId("delivery-work").waitFor();
  assert.doesNotMatch(await workPanel.innerText(), /شارع خاص|\+965/, "coarse areas only");
  await mobile("DELIVERY_WORK_RESULTS", workPanel);
  const assignment = await clickTurn(workPanel.getByTestId("driver-accept-1"));
  await assignment.getByTestId("driver-confirm").waitFor();
  await mobile("DRIVER_ASSIGNMENT_REVIEW", assignment.getByTestId("driver-panel"));
  const accepted = await clickTurn(assignment.getByTestId("driver-confirm"));
  assert.match(await accepted.innerText(), /تم قبول مهمة التوصيل/);
  checks.push("driver accepted a work card through the atomic assignment review");

  // ── One user, several roles, one chat: employment profile then driver onboarding ──
  page = await openSession(cookies.candidate);
  await newConversation();
  const cv = await sendTurn("دينار وظفني");
  await cv.getByTestId("employment-cv_profile").waitFor();
  await mobile("CV_PROFILE (employment)", cv.getByTestId("employment-cv_profile"));
  const search = await sendTurn("ابحث لي عن تيشرت نايكي بـ5");
  await search.getByTestId("ai-results-list").waitFor();
  const onboarding = await sendTurn("أريد أشتغل سائق");
  await onboarding.getByTestId("driver-panel").waitFor();
  const onboardingReview = await sendTurn("سيارة");
  await onboardingReview.getByTestId("driver-confirm").waitFor();
  await mobile("DRIVER_ONBOARDING_REVIEW", onboardingReview.getByTestId("driver-panel"));
  await sendTurn("إلغاء");
  checks.push("one account moved between employment, buying and driver onboarding in one chat");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  for (const context of contexts) {
    for (const opened of context.pages()) await opened.waitForLoadState("networkidle").catch(() => undefined);
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  }
  const runtimeEvents = page
    ? await page.evaluate(() => window.__dinarRuntimeEvents ?? []).catch(() => [])
    : [];
  const viteOverlayText = page
    ? await page.evaluate(() => {
        const overlay = document.querySelector("vite-error-overlay");
        return overlay?.shadowRoot?.textContent?.trim() || overlay?.textContent?.trim() || undefined;
      }).catch(() => undefined)
    : undefined;
  writeFileSync(resultPath, JSON.stringify({ checks, pageErrors, consoleErrors, runtimeEvents, horizontalOverflow, externalRequests, trackingDebug, viteOverlayText, failure }, null, 2));
  await browser?.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
