import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const webBase = process.env.BLOCKD_WEB_BASE;
const apiOrigin = process.env.BLOCKD_API_ORIGIN;
const buyerCookie = process.env.BLOCKD_BUYER_COOKIE;
const sellerCookie = process.env.BLOCKD_SELLER_COOKIE;
const pickupBuyerCookie = process.env.BLOCKD_PICKUP_BUYER_COOKIE;
const sentinels = JSON.parse(process.env.BLOCKD_SENTINELS ?? "[]");
const runId = process.env.BLOCKD_RUN_ID;
const resultPath = process.env.BLOCKD_UI_RESULT_PATH;
if (!webBase || !apiOrigin || !buyerCookie || !sellerCookie || !pickupBuyerCookie || sentinels.length < 3 || !runId || !resultPath)
  throw new Error("Missing Block D browser acceptance configuration.");

// Synthetic fixture position (not a real person's location); matches the parent's sentinels.
const FIXTURE = { latitude: Number(sentinels[0]), longitude: Number(sentinels[1]), accuracy: 20 };
const pickupAddress = sentinels[2];

const checks = [];
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
const seenUrls = [];
let staticFontRequests = 0;
let horizontalOverflow = 0;
let locationReads = 0;
let watchPositionCalls = 0;
let explicitAttempts = 0;
let unexpectedLocationReads = 0;
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

/** An explicit tap on a share/retry button: the only allowed trigger for a device read. */
async function explicitShare(locator, expectTurn) {
  const readsBefore = locationReads;
  explicitAttempts += 1;
  if (expectTurn) await clickTurn(locator);
  else {
    await locator.click();
    for (let waited = 0; locationReads === readsBefore && waited < 10_000; waited += 100)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
  }
  assert.equal(locationReads - readsBefore, 1, "exactly one device read per explicit attempt");
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
  if (visible) {
    await visible.scrollIntoViewIfNeeded();
    const box = await visible.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= dimensions.width + 0.5 && box.width > 0, `${label} ${width}px: content clipped ${JSON.stringify({ box, dimensions })}`);
    const overflowing = await visible.evaluate((element) =>
      [element, ...element.querySelectorAll("*")].filter(
        (node) => node.getBoundingClientRect().right > window.innerWidth + 0.5 || node.getBoundingClientRect().left < -0.5,
      ).length,
    );
    assert.equal(overflowing, 0, `${label} ${width}px: ${overflowing} descendants outside the viewport`);
    const buttons = await visible.locator("button:visible").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    assert.ok(buttons.every((height) => height >= 32), `${label} ${width}px: touch targets ${buttons}`);
  }
  checks.push(`${label} ${width}px: RTL, no horizontal overflow, composer visible, content and buttons inside the viewport`);
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

/**
 * Each session wraps the browser geolocation API before any page script runs, so
 * every read and any watchPosition call is counted in this process, across reloads.
 * `window.__dinarGeoMode = "deny"` simulates a user refusing permission.
 */
async function openSession(cookie, { geolocation } = {}) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ar",
    ...(geolocation ? { geolocation, permissions: ["geolocation"] } : {}),
  });
  contexts.push(context);
  await context.exposeBinding("__dinarGeoEvent", (_source, kind) => {
    if (kind === "read") locationReads += 1;
    if (kind === "watch") watchPositionCalls += 1;
  });
  await context.addInitScript(() => {
    const geo = navigator.geolocation;
    if (!geo) return;
    const read = geo.getCurrentPosition.bind(geo);
    const watch = geo.watchPosition.bind(geo);
    geo.getCurrentPosition = (success, error, options) => {
      window.__dinarGeoEvent("read");
      if (window.__dinarGeoMode === "deny") {
        setTimeout(() => error?.({ code: 1, message: "User denied Geolocation", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }), 30);
        return;
      }
      read(success, error, options);
    };
    geo.watchPosition = (...args) => {
      window.__dinarGeoEvent("watch");
      return watch(...args);
    };
  });
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
  opened.on("request", (request) => {
    seenUrls.push(request.url());
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || allowedHosts.has(url.host)) return;
    if (fontHosts.has(url.hostname)) staticFontRequests += 1;
    else externalRequests.push(`${url.hostname}${url.pathname}`);
  });
  opened.on("framenavigated", (frame) => seenUrls.push(frame.url()));
  return opened;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium" });

  // ── Buyer: seller delivery with a one-time device location ──
  page = await openSession(buyerCookie, { geolocation: FIXTURE });
  await newConversation();
  assert.equal(locationReads, 0, "no location read on app load");
  await sendTurn("أريد توصيل");
  let options = latestAssistant().getByTestId("delivery-delivery_options");
  await options.waitFor();
  assert.equal(await options.getByTestId("delivery-option-courier").innerText(), "اختيار");
  assert.equal(await options.getByTestId("delivery-option-external_provider-state").innerText(), "غير متاح");
  await mobile("DELIVERY_OPTIONS", options);
  checks.push("DELIVERY_OPTIONS shows eligible courier and seller delivery while external provider remains unavailable");

  await clickTurn(options.getByTestId("delivery-option-courier"));
  const courierSummary = latestAssistant().getByTestId("delivery-delivery_summary");
  await courierSummary.waitFor();
  assert.equal(await courierSummary.getByTestId("delivery-confirm").innerText(), "تأكيد الطريقة");
  await mobile("COURIER_DELIVERY_SUMMARY", courierSummary);
  await clickTurn(courierSummary.getByTestId("delivery-cancel"));
  await sendTurn("أريد توصيل");
  options = latestAssistant().getByTestId("delivery-delivery_options");
  await options.waitFor();
  assert.equal(await options.getByTestId("delivery-option-courier").innerText(), "اختيار");

  await clickTurn(options.getByTestId("delivery-option-seller_delivery"));
  const summary = latestAssistant().getByTestId("delivery-delivery_summary");
  await summary.waitFor();
  assert.match(await summary.innerText(), /رسوم التوصيل/);
  await mobile("DELIVERY_SUMMARY", summary);
  await clickTurn(summary.getByTestId("delivery-confirm"));
  const permission = latestAssistant().getByTestId("delivery-location_permission_request");
  await permission.waitFor();
  assert.equal(locationReads, 0, "asking for permission does not read the device");
  await mobile("LOCATION_PERMISSION_REQUEST", permission);
  checks.push("location permission request explains the purpose before any read");

  // D01: the user refuses permission → understandable fallback, nothing sent, no repeated prompt.
  await page.evaluate(() => (window.__dinarGeoMode = "deny"));
  const assistantsBefore = await assistantMessages().count();
  await explicitShare(permission.getByTestId("delivery-share-location"), false);
  const problem = permission.getByTestId("delivery-location-problem");
  await problem.waitFor();
  assert.match(await problem.innerText(), /لم يُسمح بالوصول إلى الموقع/);
  assert.equal((await problem.innerText()).includes("User denied"), false, "no raw browser error");
  await page.waitForTimeout(1500);
  assert.equal(await assistantMessages().count(), assistantsBefore, "denial sends nothing");
  assert.equal(locationReads, 1, "no automatic re-prompt after denial");
  await mobile("permission denied fallback", permission);
  checks.push("permission denial: plain message, manual fallback and explicit retry; no request sent, no re-prompt");

  await clickTurn(permission.getByTestId("delivery-manual-address"));
  const manualForm = latestAssistant().getByTestId("delivery-manual_address");
  await manualForm.waitFor();
  await mobile("MANUAL_ADDRESS", manualForm);
  await clickTurn(manualForm.getByRole("button", { name: "إلغاء" }));

  // D02: explicit share with permission granted → preview → confirm.
  await page.evaluate(() => (window.__dinarGeoMode = "allow"));
  await sendTurn("أرسل موقعي");
  const request2 = latestAssistant().getByTestId("delivery-location_permission_request");
  await request2.waitFor();
  await explicitShare(request2.getByTestId("delivery-share-location"), true);
  const preview = latestAssistant().getByTestId("delivery-location_preview");
  await preview.waitFor();
  const previewText = await preview.getByTestId("delivery-location-preview").innerText();
  assert.ok(previewText.includes("من موقع جهازك"), "preview identifies the device as the location source");
  assert.ok(previewText.includes("لا تُعرض الإحداثيات"), "preview explains that precise coordinates stay private");
  assert.ok(!previewText.includes(FIXTURE.latitude.toFixed(5)), "preview does not display precise coordinates in the conversation");
  await mobile("LOCATION_PREVIEW", preview);
  checks.push("one tap → one device read → LOCATION_PREVIEW before anything is attached");
  await clickTurn(preview.getByTestId("delivery-confirm-location"));
  const confirmed = latestAssistant().getByTestId("delivery-location_confirmed");
  await confirmed.waitFor();
  await confirmed.getByTestId("delivery-destination").waitFor();
  await mobile("LOCATION_CONFIRMED", confirmed);
  checks.push("confirmation attaches the destination; the confirmed card comes from server state");

  // D22: reload restores server state with no new device read.
  const readsBeforeReload = locationReads;
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  const restored = latestAssistant().getByTestId("delivery-location_confirmed");
  await restored.waitFor();
  await restored.getByTestId("delivery-destination").waitFor();
  await page.waitForTimeout(1000);
  if (locationReads !== readsBeforeReload) unexpectedLocationReads += locationReads - readsBeforeReload;
  assert.equal(locationReads, readsBeforeReload, "reload performs no device read");
  const settledPreview = page.getByTestId("delivery-location_preview").last();
  assert.equal(await settledPreview.getByTestId("delivery-confirm-location").count(), 0, "settled preview offers no action after reload");
  checks.push("reload restores the confirmed destination from the server without reading the device");

  // ── Seller: sees the authorized destination and advances delivery state ──
  page = await openSession(sellerCookie);
  await newConversation();
  await sendTurn("حالة التوصيل");
  const sellerStatus = latestAssistant().getByTestId("delivery-delivery_status");
  await sellerStatus.waitFor();
  const sellerDestination = await sellerStatus.getByTestId("delivery-destination").innerText();
  assert.ok(sellerDestination.includes("تم استلام الموقع لهذا الطلب؛ لا تُعرض الإحداثيات في المحادثة."));
  assert.ok(!sellerDestination.includes(FIXTURE.latitude.toFixed(5)), "seller view keeps precise coordinates out of the conversation");
  await mobile("DELIVERY_STATUS (seller)", sellerStatus);
  await clickTurn(sellerStatus.getByTestId("delivery-next-accepted"));
  const acceptAction = latestAssistant().getByTestId("delivery-delivery_action");
  await acceptAction.waitFor();
  await mobile("DELIVERY_ACTION", acceptAction);
  await clickTurn(acceptAction.getByTestId("delivery-confirm"));
  const accepted = latestAssistant().getByTestId("delivery-delivery_status");
  await accepted.waitFor();
  await clickTurn(accepted.getByTestId("delivery-next-out_for_delivery"));
  await clickTurn(latestAssistant().getByTestId("delivery-delivery_action").getByTestId("delivery-confirm"));
  const outStatus = latestAssistant().getByTestId("delivery-delivery_status");
  await outStatus.waitFor();
  assert.match(await outStatus.innerText(), /خرج للتوصيل/);
  await outStatus.getByTestId("delivery-handoff").waitFor();
  checks.push("seller sees the destination, accepts and marks out for delivery; handoff stays with the order card");

  // ── Pickup buyer: chooses pickup ──
  page = await openSession(pickupBuyerCookie);
  await newConversation();
  await sendTurn("استلام شخصي");
  const pickupSummary = latestAssistant().getByTestId("delivery-delivery_summary");
  await pickupSummary.waitFor();
  await clickTurn(pickupSummary.getByTestId("delivery-confirm"));
  const pickupDetails = latestAssistant().getByTestId("delivery-pickup_details");
  await pickupDetails.waitFor();
  await mobile("PICKUP_DETAILS (buyer)", pickupDetails);
  const pickupBuyerPage = page;

  // ── Seller: shares an order-scoped pickup point by manual address ──
  page = contexts[1].pages()[0];
  await sendTurn("هذا موقع الاستلام");
  const pickupRequest = latestAssistant().getByTestId("delivery-location_permission_request");
  await pickupRequest.waitFor();
  await clickTurn(pickupRequest.getByTestId("delivery-manual-address"));
  const form = latestAssistant().getByTestId("delivery-manual_address");
  await form.waitFor();
  await form.getByTestId("delivery-manual-city").fill("عمان");
  await form.getByTestId("delivery-manual-area").fill("خلدا");
  await form.getByTestId("delivery-manual-address-text").fill(pickupAddress);
  await clickTurn(form.getByTestId("delivery-manual-submit"));
  const manualPreview = latestAssistant().getByTestId("delivery-location_preview");
  await manualPreview.waitFor();
  assert.ok((await manualPreview.innerText()).includes(pickupAddress));
  await clickTurn(manualPreview.getByTestId("delivery-confirm-location"));
  await latestAssistant().getByTestId("delivery-location_confirmed").waitFor();
  checks.push("seller shares a pickup point by manual address without device permission");

  page = pickupBuyerPage;
  await sendTurn("حالة الاستلام");
  const pickupView = latestAssistant().getByTestId("delivery-pickup_details");
  await pickupView.waitFor();
  assert.ok((await pickupView.getByTestId("delivery-pickup-point").innerText()).includes(pickupAddress));
  await mobile("PICKUP_DETAILS with pickup point", pickupView);
  checks.push("buyer sees the seller's order-scoped pickup point");
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  for (const context of contexts) {
    try {
      for (const opened of context.pages()) await opened.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      // Reported through the check list; cleanup continues.
    }
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  }
  const urlLeaks = seenUrls.filter((url) => {
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      // Keep the raw URL.
    }
    return sentinels.some((value) => decoded.includes(value) || decoded.includes(String(Number(value).toFixed(5))));
  }).length;
  unexpectedLocationReads += Math.max(0, locationReads - explicitAttempts);
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
        urlLeaks,
        urlsInspected: seenUrls.length,
        locationReads,
        explicitAttempts,
        unexpectedLocationReads,
        watchPositionCalls,
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
