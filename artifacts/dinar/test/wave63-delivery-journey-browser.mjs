import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const env = process.env;
const webBase = env.W63_WEB_BASE;
const apiOrigin = env.W63_API_ORIGIN;
const orderId = env.W63_ORDER_ID;
const orderTitle = env.W63_ORDER_TITLE;
for (const name of ["BUYER", "COURIER"]) {
  if (!env[`W63_${name}_COOKIE`] || !env[`W63_${name}_USER_ID`] || !env[`W63_${name}_CONVERSATION_ID`])
    throw new Error(`Missing generated browser session for ${name}`);
}
const browser = await chromium.launch({
  headless: true,
  executablePath: env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
  args: ["--no-sandbox"],
});
const contexts = [];
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
const fontHosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const widths = [320, 375, 430, 768, 1024, 1440, 1600];

async function open(role) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 375, height: 900 },
    locale: "ar",
  });
  contexts.push(context);
  const cookie = env[`W63_${role}_COOKIE`];
  const split = cookie.indexOf("=");
  await context.addCookies([{
    name: cookie.slice(0, split),
    value: cookie.slice(split + 1),
    domain: new URL(webBase).hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: false,
  }]);
  await context.addInitScript(({ userId, conversationId }) => {
    localStorage.setItem(`dinar-conversation:${userId}:JO`, conversationId);
  }, {
    userId: env[`W63_${role}_USER_ID`],
    conversationId: env[`W63_${role}_CONVERSATION_ID`],
  });
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"]) delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!allowedHosts.has(url.host) && !fontHosts.has(url.hostname)) externalRequests.push(`${url.hostname}${url.pathname}`);
  });
  const conversationPath = `/api/ai/conversations/${env[`W63_${role}_CONVERSATION_ID`]}`;
  const conversationLoaded = page.waitForResponse((response) =>
    new URL(response.url()).pathname === conversationPath && response.status() === 200,
  );
  await page.goto("/");
  await conversationLoaded;
  await page.getByTestId("input-ai-composer").waitFor();
  await page.locator('.ai-state-region[aria-busy="true"]').waitFor({ state: "hidden", timeout: 30_000 });
  return page;
}

const assistantMessages = (page) => page.locator('[data-testid^="message-assistant-"]');
async function send(page, text) {
  const before = await assistantMessages(page).count();
  const composer = page.getByTestId("input-ai-composer");
  const sendButton = page.getByTestId("button-send-ai-message");
  await composer.fill(text);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="button-send-ai-message"]');
    return button?.getAttribute("data-ready") === "true";
  }, undefined, { timeout: 10_000 }).catch(async () => {
    const state = await page.evaluate(() => ({
      value: document.querySelector('[data-testid="input-ai-composer"]')?.value,
      ready: document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("data-ready"),
      busy: document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-busy"),
      online: navigator.onLine,
    }));
    throw new Error(`Composer did not become ready: ${JSON.stringify(state)}`);
  });
  await sendButton.click();
  await page.waitForFunction((count) =>
    document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
    document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
  before, { timeout: 60_000 });
  return assistantMessages(page).last();
}
async function clickTurn(page, button) {
  const before = await assistantMessages(page).count();
  await button.click();
  await page.waitForFunction((count) =>
    document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
    document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
  before, { timeout: 60_000 });
}
async function api(page, path, method = "GET", body) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      credentials: "include",
    });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}
async function fitAtRequiredWidths(page, surface, name) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await surface.scrollIntoViewIfNeeded();
    const geometry = await surface.evaluate((node) => ({
      direction: getComputedStyle(document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
    }));
    assert.equal(geometry.direction, "rtl", `${name} at ${width}px`);
    assert.ok(geometry.document <= geometry.viewport, `${name} horizontally overflows at ${width}px`);
    assert.ok(geometry.left >= 0 && geometry.right <= width + 1, `${name} clips at ${width}px`);
  }
}

try {
  const buyer = await open("BUYER");
  const courier = await open("COURIER");
  const workMessage = await send(courier, "اعرض لي طلبات توصيل");
  const driverPanel = workMessage.getByTestId("driver-panel");
  await driverPanel.waitFor();
  const target = driverPanel.locator("li").filter({ hasText: orderTitle }).first();
  await target.waitFor();
  const accept = target.locator('[data-testid^="driver-accept-"]').first();
  await clickTurn(courier, accept);
  await clickTurn(courier, assistantMessages(courier).last().getByTestId("driver-confirm"));

  const proposal = await api(buyer, `/api/orders/${orderId}/courier-fare/proposals`, "POST", {
    amount: "1.000",
    idempotencyKey: `w63-browser-fare-${Date.now()}`,
  });
  assert.equal(proposal.status, 200, JSON.stringify(proposal.body));
  const proposalId = proposal.body.proposal.id;
  assert.equal((await api(buyer, `/api/orders/${orderId}/courier-fare/confirm`, "POST", { proposalId })).status, 200);
  const courierFare = await api(courier, `/api/orders/${orderId}/courier-fare/confirm`, "POST", { proposalId });
  assert.equal(courierFare.status, 200);
  assert.equal(courierFare.body.agreed, true);

  let trackingMessage = await send(buyer, "تتبع طلبي");
  let trackingSurface = trackingMessage.getByTestId(`order-tracking-${orderId}`);
  await trackingSurface.waitFor();
  await fitAtRequiredWidths(courier, assistantMessages(courier).last().getByTestId("driver-panel"), "courier task card");
  await fitAtRequiredWidths(buyer, trackingSurface, "buyer tracking timeline");

  const pickup = courier.getByTestId(`driver-pickup-${orderId}`);
  await clickTurn(courier, pickup);
  const depart = assistantMessages(courier).last().getByTestId(`driver-progress-${orderId}`);
  await clickTurn(courier, depart);
  const arrive = assistantMessages(courier).last().getByTestId(`driver-arrival-${orderId}`);
  await clickTurn(courier, arrive);
  const handoff = assistantMessages(courier).last().getByTestId(`driver-handoff-${orderId}`);
  await clickTurn(courier, handoff);
  const handoffCopy = await assistantMessages(courier).last().innerText();
  assert.match(handoffCopy, /تم التسليم:/, `courier handoff was not accepted: ${handoffCopy}`);

  trackingMessage = await send(buyer, "تتبع طلبي");
  trackingSurface = trackingMessage.getByTestId(`order-tracking-${orderId}`);
  await trackingSurface.waitFor();
  const milestones = [
    "استلم المندوب الطلب",
    "بدأ التوصيل",
    "وصل المندوب",
    "سلّم المندوب الطلب",
  ];
  for (const label of milestones) await trackingSurface.getByText(label).waitFor();
  const trackingBody = await trackingSurface.innerText();
  assert.doesNotMatch(trackingBody, /29\\.123456|48\\.654321|دقيقة|دقائق|دقيقةً|وصول متوقع/);
  await fitAtRequiredWidths(buyer, trackingSurface, "persisted buyer milestones");

  const beforeReceipt = await api(buyer, `/api/orders/${orderId}`);
  const beforeReceiptFulfillment = await api(buyer, `/api/orders/${orderId}/fulfillment`);
  assert.equal(beforeReceipt.status, 200, `buyer order read failed: ${JSON.stringify(beforeReceipt)}`);
  assert.equal(
    beforeReceipt.body?.status,
    "SELLER_MARKED_DELIVERED",
    `handoff was not persisted: ${JSON.stringify({ order: beforeReceipt.body, fulfillment: beforeReceiptFulfillment.body })}`,
  );
  // Chat-only builds route /orders/:id back to the chat. Confirm through the
  // authenticated buyer's real application endpoint, without bypassing auth.
  const receipt = await api(buyer, `/api/orders/${orderId}/confirm`, "POST", { received: true });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  const completedOrder = await api(buyer, `/api/orders/${orderId}`);
  assert.equal(completedOrder.body?.status, "COMPLETED", JSON.stringify(completedOrder.body));
  const persistedReceipt = await api(buyer, `/api/orders/${orderId}/tracking`);
  assert.equal(persistedReceipt.status, 200);
  assert.ok(persistedReceipt.body.progress.some((event) => event.type === "BUYER_RECEIVED"));
  const buyerConversationLoaded = buyer.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/ai/conversations/${env.W63_BUYER_CONVERSATION_ID}` && response.status() === 200,
  );
  await buyer.reload();
  await buyerConversationLoaded;
  await buyer.getByTestId("input-ai-composer").waitFor();
  const receiptProgress = buyer.locator(`[data-testid="order-tracking-${orderId}"]`).last();
  await receiptProgress.waitFor();
  await receiptProgress.getByText("أكد المشتري الاستلام").waitFor();
  await fitAtRequiredWidths(buyer, receiptProgress, "completed receipt timeline");
  const invoiceMessage = await send(buyer, "أرني فاتورة طلبي");
  const invoice = invoiceMessage.getByTestId("completed-order-receipt");
  await invoice.waitFor();
  await invoice.getByText("إجمالي الطلب").waitFor();
  await fitAtRequiredWidths(buyer, invoice, "conversation-native completed order receipt");

  const account = await api(courier, "/api/courier/commission-account");
  assert.equal(account.status, 200, JSON.stringify(account.body));
  const historicalOrderId = account.body.earningsHistory[0]?.orderId;
  assert.ok(historicalOrderId, "the courier fixture must have a completed delivery in earnings history");
  await send(courier, "كم ربحت من التوصيل؟");
  const conversation = await api(
    courier,
    `/api/ai/conversations/${env.W63_COURIER_CONVERSATION_ID}`,
  );
  const recentMessages = Array.isArray(conversation.body?.messages)
    ? conversation.body.messages.slice(-3).map((message) => ({
        actor: message.actor ?? message.role,
        body: message.body,
        blocks: (message.blocks ?? []).map((block) => ({
          type: block.type,
          surface: block.payload?.surface,
          driverView: block.payload?.driver?.view,
          resultSetId: block.payload?.resultSetId,
        })),
      }))
    : [];
  assert.equal(conversation.status, 200, JSON.stringify(conversation.body));
  assert.ok(
    recentMessages.some((message) =>
      message.blocks.some((block) =>
        block.surface === "DRIVER_EARNINGS_HISTORY" &&
        block.driverView === "DRIVER_EARNINGS_HISTORY",
      ),
    ),
    "reloaded conversation must preserve its courier earnings-history surface",
  );
  const earningsPanel = courier.locator(
    '[data-testid="driver-panel"][data-view="DRIVER_EARNINGS_HISTORY"]',
  ).last();
  await earningsPanel.waitFor();
  const earnings = earningsPanel.getByTestId("courier-earnings-history");
  await earnings.waitFor();
  await earnings.getByTestId(`courier-earning-${historicalOrderId}`).waitFor();
  assert.match(await earningsPanel.innerText(), /لا تثبت تحصيل أجرة أو تحويلها|الدفع الحقيقي غير متحقق/);
  await fitAtRequiredWidths(courier, earnings, "courier earnings history");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log("W63_BROWSER_RESULT", JSON.stringify({
    status: "PASS",
    checks: ["buyer tracking", "courier work-card acceptance", "pickup", "departure", "arrival", "handoff", "buyer timeline", "explicit receipt", "conversation-native invoice", "courier earnings history", "persisted completion"],
    widths,
    pageErrors,
    consoleErrors,
    externalRequests,
  }));
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
}
