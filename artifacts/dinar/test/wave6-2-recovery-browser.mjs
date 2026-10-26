import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const env = process.env;
const webBase = env.W62_WEB_BASE;
const apiOrigin = env.W62_API_ORIGIN;
const roles = ["BUYER", "COURIER_A", "COURIER_B", "ADMIN"];
for (const role of roles) {
  if (!env[`W62_${role}_COOKIE`] || !env[`W62_${role}_USER_ID`] || !env[`W62_${role}_CONVERSATION_ID`])
    throw new Error(`Missing signed-in browser fixture for ${role}.`);
}
for (const key of ["PRIMARY_ORDER_ID", "ADMIN_ORDER_ID", "CUSTODY_ORDER_ID"])
  if (!env[`W62_${key}`]) throw new Error(`Missing browser order fixture: ${key}.`);

const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
const seenUrls = [];
const apiErrorResponses = [];
const checks = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
});
const contexts = {};
const pages = {};
const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
const fontHosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

async function open(role) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 375, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ar",
  });
  contexts[role] = context;
  await context.addInitScript(({ conversationId, userId }) => {
    localStorage.setItem(`dinar-conversation:${userId}:JO`, conversationId);
  }, {
    conversationId: env[`W62_${role}_CONVERSATION_ID`],
    userId: env[`W62_${role}_USER_ID`],
  });
  const cookie = env[`W62_${role}_COOKIE`];
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
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/") && response.status() >= 400)
      apiErrorResponses.push({ path: url.pathname, status: response.status() });
  });
  page.on("request", (request) => {
    seenUrls.push(request.url());
    const url = new URL(request.url());
    if (!allowedHosts.has(url.host) && !fontHosts.has(url.hostname)) externalRequests.push(`${url.hostname}${url.pathname}`);
  });
  page.on("framenavigated", (frame) => seenUrls.push(frame.url()));
  pages[role] = page;
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const newConversationButton = page.locator(
    '[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible',
  ).first();
  if (!(await newConversationButton.isVisible()))
    await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await newConversationButton.waitFor({ state: "visible" });
  const created = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/ai/conversations" &&
    response.request().method() === "POST",
  );
  await newConversationButton.click();
  assert.equal((await created).status(), 201);
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
  return page;
}

const assistantMessages = (page) => page.locator('[data-testid^="message-assistant-"]');
async function send(page, message) {
  const previous = await assistantMessages(page).count();
  await page.getByTestId("input-ai-composer").fill(message);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="button-send-ai-message"]');
    return button && !button.disabled;
  }, undefined, { timeout: 15_000 });
  await page.getByTestId("button-send-ai-message").click();
  await page.waitForFunction((count) =>
    document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
    document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
  previous, { timeout: 60_000 });
  return assistantMessages(page).last();
}

async function clickTurn(page, button) {
  const previous = await assistantMessages(page).count();
  await button.click();
  await page.waitForFunction((count) =>
    document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
    document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
  previous, { timeout: 60_000 });
}

async function assertRtlAt(page, surface, label) {
  for (const width of [375, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await surface.evaluate((node) => ({
      direction: getComputedStyle(document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
    }));
    assert.equal(geometry.direction, "rtl", `${label} at ${width}px`);
    assert.ok(geometry.document <= geometry.viewport, `${label} overflows at ${width}px`);
    assert.ok(geometry.left >= 0 && geometry.right <= width + 1, `${label} clipped at ${width}px`);
    checks.push(`${label}:${width}`);
  }
  await page.setViewportSize({ width: 375, height: 844 });
}

async function authorizedRead(role, path) {
  return pages[role].evaluate(async (url) => {
    const response = await fetch(url, { credentials: "include" });
    const body = await response.json().catch(() => null);
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control") ?? "",
      fulfillmentStatus: body?.fulfillment?.status ?? null,
    };
  }, path);
}

try {
  const buyer = await open("BUYER");
  const original = await send(buyer, "حالة التوصيل");
  const originalStatus = original.getByTestId("delivery-delivery_status");
  await originalStatus.waitFor();
  assert.match(await originalStatus.innerText(), /التوصيل|المندوب|رسوم التوصيل/);
  assert.equal((await authorizedRead("BUYER", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/fulfillment`)).fulfillmentStatus, "REQUESTED");
  checks.push("buyer sees the correct order before courier acceptance");

  const courierA = await open("COURIER_A");
  const workA = await send(courierA, "اعرض لي طلبات توصيل");
  const panelA = workA.getByTestId("driver-panel");
  await panelA.waitFor();
  assert.equal(await panelA.getAttribute("data-view"), "DELIVERY_WORK_RESULTS");
  await clickTurn(courierA, panelA.getByTestId("driver-accept-1"));
  const reviewA = assistantMessages(courierA).last().getByTestId("driver-panel");
  await reviewA.waitFor();
  await clickTurn(courierA, reviewA.getByTestId("driver-confirm"));
  const assignedA = assistantMessages(courierA).last().getByTestId("driver-panel");
  await assignedA.waitFor();
  assert.equal(await assignedA.getAttribute("data-view"), "DRIVER_ASSIGNMENT_STATUS");
  assert.equal((await authorizedRead("BUYER", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/fulfillment`)).fulfillmentStatus, "ACCEPTED");
  await send(courierA, "لا أستطيع التوصيل");
  assert.equal((await authorizedRead("BUYER", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/fulfillment`)).fulfillmentStatus, "FAILED");
  assert.equal((await courierA.locator("body").innerText()).includes("عنوان اختبار خاص"), false);
  checks.push("courier A accepts the real work card, then withdraws before pickup");

  const recovery = await send(buyer, "دينار المندوب اعتذر، أبي مندوب ثاني.");
  const summary = recovery.getByTestId("delivery-delivery_summary");
  await summary.waitFor();
  await assertRtlAt(buyer, summary, "recovery-confirmation");
  checks.push("buyer gets the typed recovery summary, not an automatic reassignment");
  await clickTurn(buyer, summary.getByTestId("delivery-confirm"));
  const locationRequest = assistantMessages(buyer).last().getByTestId("delivery-location_permission_request");
  await locationRequest.waitFor();
  await clickTurn(buyer, locationRequest.getByTestId("delivery-manual-address"));
  const addressForm = assistantMessages(buyer).last().getByTestId("delivery-manual_address");
  await addressForm.waitFor();
  await addressForm.getByTestId("delivery-manual-city").fill("مدينة الاختبار");
  await addressForm.getByTestId("delivery-manual-area").fill("حي الاختبار");
  await addressForm.getByTestId("delivery-manual-address-text").fill("عنوان اختبار خاص");
  await clickTurn(buyer, addressForm.getByTestId("delivery-manual-submit"));
  const locationPreview = assistantMessages(buyer).last().getByTestId("delivery-location_preview");
  await locationPreview.waitFor();
  await clickTurn(buyer, locationPreview.getByTestId("delivery-confirm-location"));
  await assistantMessages(buyer).last().getByTestId("delivery-location_confirmed").waitFor();
  assert.equal((await authorizedRead("BUYER", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/fulfillment`)).fulfillmentStatus, "REQUESTED");
  checks.push("buyer explicitly confirms the new courier choice and fresh destination");

  const courierB = await open("COURIER_B");
  const workB = await send(courierB, "اعرض لي طلبات توصيل");
  const panelB = workB.getByTestId("driver-panel");
  await panelB.waitFor();
  assert.equal(await panelB.getAttribute("data-view"), "DELIVERY_WORK_RESULTS");
  assert.equal((await panelB.innerText()).includes("عنوان اختبار خاص"), false);
  await clickTurn(courierB, panelB.getByTestId("driver-accept-1"));
  const reviewB = assistantMessages(courierB).last().getByTestId("driver-panel");
  await reviewB.waitFor();
  await clickTurn(courierB, reviewB.getByTestId("driver-confirm"));
  const assignedB = assistantMessages(courierB).last().getByTestId("driver-panel");
  await assignedB.waitFor();
  assert.equal(await assignedB.getAttribute("data-view"), "DRIVER_ASSIGNMENT_STATUS");
  const newFare = await authorizedRead("COURIER_B", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/courier-fare`);
  assert.equal(newFare.status, 200);
  const fareBody = await pages.COURIER_B.evaluate(
    async (url) => (await (await fetch(url, { credentials: "include" })).json()),
    `/api/orders/${env.W62_PRIMARY_ORDER_ID}/courier-fare`,
  );
  assert.equal(fareBody.agreement, null);
  assert.equal(fareBody.proposal, null);
  assert.equal((await authorizedRead("BUYER", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/fulfillment`)).fulfillmentStatus, "ACCEPTED");
  const staleRestore = await send(courierA, "نعم");
  assert.doesNotMatch(await staleRestore.innerText(), /تم قبول مهمة التوصيل/);
  assert.equal(
    (await authorizedRead("BUYER", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/fulfillment`)).fulfillmentStatus,
    "ACCEPTED",
  );
  checks.push("courier A's stale confirmation cannot restore its assignment after courier B accepts");
  const formerFulfillment = await authorizedRead("COURIER_A", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/fulfillment`);
  const formerFare = await authorizedRead("COURIER_A", `/api/orders/${env.W62_PRIMARY_ORDER_ID}/courier-fare`);
  assert.equal(formerFulfillment.status, 404);
  assert.equal(formerFare.status, 404);
  assert.ok(formerFulfillment.cacheControl.includes("no-store"));
  await send(buyer, "حالة التوصيل");
  checks.push("courier B receives a fresh assignment; courier A's session loses fulfillment and fare access");

  const admin = await open("ADMIN");
  const adminRevoke = await admin.evaluate(async ({ orderId, key }) => {
    const response = await fetch(`/api/admin/orders/${orderId}/courier-assignment/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "اختبار إلغاء إداري قبل الاستلام", idempotencyKey: key }),
    });
    return { status: response.status, body: await response.json() };
  }, { orderId: env.W62_ADMIN_ORDER_ID, key: `browser-admin-${Date.now()}-key` });
  assert.equal(adminRevoke.status, 200);
  const custodyRevoke = await admin.evaluate(async ({ orderId, key }) => {
    const response = await fetch(`/api/admin/orders/${orderId}/courier-assignment/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "اختبار إلغاء إداري بعد بدء التوصيل", idempotencyKey: key }),
    });
    return { status: response.status, body: await response.json() };
  }, { orderId: env.W62_CUSTODY_ORDER_ID, key: `browser-custody-${Date.now()}-key` });
  assert.equal(custodyRevoke.status, 409);
  assert.match(custodyRevoke.body.error, /حيازة المندوب/);
  checks.push("admin browser session revokes a pre-pickup assignment and is refused for in-custody order");

  const mobileSurface = assistantMessages(buyer).last().getByTestId("delivery-delivery_status");
  await mobileSurface.waitFor();
  await assertRtlAt(buyer, mobileSurface, "updated-order-status");
  const expectedApiErrors = apiErrorResponses.filter(({ path, status }) =>
    (status === 404 &&
      (path === `/api/orders/${env.W62_PRIMARY_ORDER_ID}/fulfillment` ||
        path === `/api/orders/${env.W62_PRIMARY_ORDER_ID}/courier-fare`)) ||
    (status === 409 && path === `/api/admin/orders/${env.W62_CUSTODY_ORDER_ID}/courier-assignment/revoke`),
  );
  assert.equal(expectedApiErrors.length, apiErrorResponses.length, "only the intentionally denied former-courier reads and custody revoke may fail");
  assert.ok(expectedApiErrors.filter(({ status }) => status === 404).length >= 2);
  assert.equal(expectedApiErrors.filter(({ status }) => status === 409).length, 1);
  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) => !/Failed to load resource: the server responded with a status of (?:404|409) \(.*\)/.test(message),
  );
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedConsoleErrors, []);
  assert.deepEqual(externalRequests, []);
  const urlLeaks = seenUrls.filter((url) => {
    try {
      return decodeURIComponent(url).includes("عنوان اختبار خاص");
    } catch {
      return url.includes("عنوان اختبار خاص");
    }
  });
  assert.deepEqual(urlLeaks, []);
  console.log("W62_BROWSER_RESULT", JSON.stringify({
    checks,
    pageErrors,
    consoleErrors: unexpectedConsoleErrors,
    expectedApiErrors,
    externalRequests,
    urlLeaks,
  }));
} finally {
  for (const context of Object.values(contexts)) await context.close().catch(() => undefined);
  await browser.close();
}
