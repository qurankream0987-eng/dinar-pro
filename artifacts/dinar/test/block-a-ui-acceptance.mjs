import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const webBase = process.env.BLOCKA_WEB_BASE;
const apiOrigin = process.env.BLOCKA_API_ORIGIN;
const cookie = process.env.BLOCKA_COOKIE;
const expectedSortedIds = JSON.parse(process.env.BLOCKA_EXPECTED_SORTED_IDS ?? "[]");
const resultPath = process.env.BLOCKA_UI_RESULT_PATH;
if (!webBase || !apiOrigin || !cookie || !resultPath || expectedSortedIds.length < 2)
  throw new Error("Missing Block A browser acceptance configuration.");

const checks = [];
const pageErrors = [];
const consoleErrors = [];
const marketplaceExternalRequests = [];
let staticFontRequests = 0;
let a09UploadRequests = 0;
let a09ObjectPaths = [];
let a09UploadRequestsAfterReload = 0;
let a09StorageRequests = 0;
let a09UploadLoadingObserved = false;
let horizontalOverflow = 0;
let failure;
let browser;
let context;
let page;
let activeConversationId;

const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
const fontHosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

async function settle() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function sendTurn(text) {
  const composer = page.getByTestId("input-ai-composer");
  await composer.fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="button-send-ai-message"]')
        ?.getAttribute("aria-label") === "إرسال الرسالة",
    null,
    { timeout: 60_000 },
  );
  await page.locator('[data-testid^="message-user-"]').filter({ hasText: text }).last().waitFor();
  await page.locator('[data-testid^="message-assistant-"]').last().waitFor();
  await settle();
}

const latestAssistant = () => page.locator('[data-testid^="message-assistant-"]').last();

async function latestResultIds() {
  return latestAssistant()
    .locator('[data-testid^="card-ai-result-"]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-resource-id")));
}

async function measure(label, width, visible, interactive) {
  await page.setViewportSize({ width, height: 844 });
  await settle();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    direction: getComputedStyle(
      document.querySelector(".dinar-chatgpt") ?? document.documentElement,
    ).direction,
  }));
  if (Math.max(dimensions.scrollWidth, dimensions.bodyScrollWidth) > dimensions.width) {
    horizontalOverflow += 1;
    throw new Error(`${label} ${width}px: horizontal overflow ${JSON.stringify(dimensions)}`);
  }
  assert.equal(dimensions.direction, "rtl", `${label} ${width}px must stay RTL`);
  const composer = await page.getByTestId("input-ai-composer").boundingBox();
  assert.ok(
    composer && composer.y >= 0 && composer.y + composer.height <= dimensions.height,
    `${label} ${width}px: composer obscured ${JSON.stringify({ composer, dimensions })}`,
  );
  const send = await page.getByTestId("button-send-ai-message").boundingBox();
  assert.ok(send && send.width >= 32 && send.height >= 32, `${label} ${width}px: send target too small`);
  if (visible) {
    await visible.scrollIntoViewIfNeeded();
    const box = await visible.boundingBox();
    assert.ok(
      box && box.x >= -0.5 && box.x + box.width <= dimensions.width + 0.5 && box.width > 0,
      `${label} ${width}px: control clipped ${JSON.stringify({ box, dimensions })}`,
    );
    if (interactive) {
      const target = await visible.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      assert.ok(target.height >= 32, `${label} ${width}px: touch target ${JSON.stringify(target)}`);
    }
  }
  checks.push(`${label} ${width}px: RTL, no horizontal overflow, composer and control visible`);
}

async function mobile(label, visible, interactive = true) {
  for (const width of [320, 360, 390, 414]) await measure(label, width, visible, interactive);
}

async function newConversation() {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const button = page
    .locator('[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible')
    .first();
  if (!(await button.isVisible()))
    await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await button.waitFor({ state: "visible" });
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ai/conversations" &&
      response.request().method() === "POST",
  );
  await button.click();
  const response = await created;
  assert.equal(response.status(), 201);
  const payload = await response.json();
  activeConversationId = payload.id ?? payload.conversation?.id;
  assert.equal(typeof activeConversationId, "string");
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ar",
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
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || allowedHosts.has(url.host)) return;
    if (fontHosts.has(url.hostname)) staticFontRequests += 1;
    else if (url.hostname === "storage.googleapis.com" && request.method() === "PUT")
      a09StorageRequests += 1;
    else marketplaceExternalRequests.push(`${url.hostname}${url.pathname}`);
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/account/listing-photos/upload-url")
      a09UploadRequests += 1;
  });
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.request().method() === "POST" &&
      ["/api/account/listing-photos/upload-url", "/api/account/listing-photos/complete"].includes(path)
    ) {
      try {
        const body = await response.json();
        if (typeof body.objectPath === "string") {
          a09ObjectPaths.push(body.objectPath);
          if (path.endsWith("/upload-url"))
            a09ObjectPaths.push(
              body.objectPath.replace("/acceptance-A09-", "/sealed-acceptance-A09-"),
            );
        }
      } catch {
        // The acceptance assertions report missing upload records.
      }
    }
  });
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"])
      delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    await route.fulfill({
      response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }),
    });
  });

  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  await mobile("composer", page.getByTestId("input-ai-composer"), false);

  // A02 in the connected UI: refinements, sort and the exact second listing.
  await newConversation();
  for (const phrase of ["أريد مرسيدس", "من 2020 وفوق", "أقل من 9000", "في عمان فقط", "وريني الأرخص"])
    await sendTurn(phrase);
  assert.deepEqual(await latestResultIds(), expectedSortedIds);
  const chips = latestAssistant().getByLabel("تفاصيل البحث المطبقة");
  await chips.waitFor();
  const chipText = await chips.innerText();
  for (const expected of ["مرسيدس", "2020", "9000", "عمان"])
    assert.ok(chipText.includes(expected), `filter summary shows ${expected}: ${chipText}`);
  checks.push("connected UI renders server results in the expected sorted order with a filter summary");
  await mobile(
    "search results",
    latestAssistant().getByTestId(`button-open-result-${expectedSortedIds[0]}`),
  );

  await sendTurn("الثانية");
  const details = latestAssistant().getByTestId("ai-results-details");
  await details.waitFor();
  assert.deepEqual(await latestResultIds(), [expectedSortedIds[1]]);
  await latestAssistant().getByTestId("status-listing-inventory").waitFor();
  checks.push("ordinal opens the exact second listing with details expanded");
  await mobile("listing details", latestAssistant().getByTestId("status-listing-inventory"), false);
  await mobile("listing details action", latestAssistant().getByTestId("button-add-to-cart"));

  // A07 back to the same ordered set.
  await sendTurn("رجعني");
  assert.deepEqual(await latestResultIds(), expectedSortedIds);
  checks.push("back restores the same result set order in the UI");
  await mobile(
    "back to results",
    latestAssistant().getByTestId(`button-open-result-${expectedSortedIds[1]}`),
  );

  // A08 reload: the active conversation and its live result cards come back from the server.
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  await latestAssistant().locator('[data-testid^="card-ai-result-"]').first().waitFor();
  assert.deepEqual(await latestResultIds(), expectedSortedIds);
  await sendTurn("الثانية");
  assert.deepEqual(await latestResultIds(), [expectedSortedIds[1]]);
  checks.push("reload restores the conversation and result context; ordinal still resolves");

  // A05 empty state is a typed surface, not fake cards.
  await sendTurn("أريد مرسيدس أقل من 5");
  await latestAssistant().getByTestId("ai-results-empty").waitFor();
  assert.deepEqual(await latestResultIds(), []);
  checks.push("empty results render the real empty state without cards");
  await mobile("empty results", latestAssistant().getByTestId("ai-results-empty"), false);

  // A01 generic search in the UI.
  await newConversation();
  await sendTurn("أريد سماعة آيفون سوداء");
  const headsets = await latestResultIds();
  assert.ok(headsets.length >= 1);
  const firstTitle = await latestAssistant()
    .getByTestId(`card-ai-result-${headsets[0]}`)
    .innerText();
  assert.match(firstTitle, /سماعة/);
  checks.push("generic electronics search shows persisted headset cards");

  const sellerCookie = process.env.BLOCKA_SELLER_COOKIE;
  const imageBase64 = process.env.BLOCKA_A09_IMAGE_BASE64;
  if (sellerCookie && imageBase64) {
    await page.evaluate(() => localStorage.clear());
    await context.clearCookies();
    const separator = sellerCookie.indexOf("=");
    await context.addCookies([{
      name: sellerCookie.slice(0, separator),
      value: sellerCookie.slice(separator + 1),
      domain: new URL(webBase).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    }]);
    await newConversation();
    await sendTurn("أبي أبيع هذا");
    await page.locator('input[type="file"]').setInputFiles({
      name: "a09-synthetic-product.png",
      mimeType: "image/png",
      buffer: Buffer.from(imageBase64, "base64"),
    });
    await page.getByAltText("معاينة صورة الإعلان 1").waitFor();
    await context.route("https://storage.googleapis.com/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      a09UploadLoadingObserved = await page
        .getByTestId("button-send-ai-message")
        .isDisabled()
        .catch(() => false);
      await route.continue();
    });
    await sendTurn("صورة الإعلان");
    await context.unroute("https://storage.googleapis.com/**");
    assert.equal(a09UploadRequests, 1, "one selected image produces one upload");
    assert.equal(a09StorageRequests, 1, "the image is uploaded to development App Storage");
    assert.equal(a09UploadLoadingObserved, true, "the composer stays busy while the upload is in progress");
    assert.ok(a09ObjectPaths.some((path) => path.includes("acceptance-A09-")));
    await page.reload();
    await page.getByTestId("input-ai-composer").waitFor();
    await page.waitForTimeout(800);
    a09UploadRequestsAfterReload = a09UploadRequests;
    assert.equal(a09UploadRequestsAfterReload, 1, "reload restores the attachment without re-upload");
    await page
      .locator('[data-testid^="message-user-"]')
      .filter({ hasText: "صورة الإعلان" })
      .waitFor();
    await page.getByRole("region", { name: "مراجعة اقتراحات الصور" }).waitFor();
    const restoredConversation = await page.evaluate(async (conversationId) => {
      const response = await fetch(`/api/ai/conversations/${conversationId}`);
      return { status: response.status, body: await response.json() };
    }, activeConversationId);
    assert.equal(restoredConversation.status, 200);
    const restoredPhotoPath = a09ObjectPaths.find((path) =>
      path.includes("/sealed-acceptance-A09-"),
    );
    assert.ok(
      restoredPhotoPath &&
        JSON.stringify(restoredConversation.body).includes(restoredPhotoPath),
      "the restored seller conversation retains the attached photo path",
    );
    await sendTurn("لا، جديد");
    checks.push("A09 authenticated seller upload, draft photo restore, and seller correction pass");
  }
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  try {
    await page?.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch {
    // Reported through the check list; cleanup continues.
  }
  await context?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        pageErrors,
        consoleErrors,
        horizontalOverflow,
        marketplaceExternalRequests,
        staticFontRequests,
        a09: {
          uploadRequests: a09UploadRequests,
          uploadRequestsAfterReload: a09UploadRequestsAfterReload,
          storageRequests: a09StorageRequests,
          uploadLoadingObserved: a09UploadLoadingObserved,
          objectPaths: a09ObjectPaths,
        },
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
