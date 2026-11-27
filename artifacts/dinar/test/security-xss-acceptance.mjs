import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const webBase = process.env.WAVE2_WEB_BASE;
const apiOrigin = process.env.WAVE2_API_ORIGIN;
const payload = process.env.WAVE2_XSS_PAYLOAD;
const marker = process.env.WAVE2_XSS_MARKER;
const userCookie = process.env.WAVE2_USER_COOKIE;
const buyerCookie = process.env.WAVE2_BUYER_COOKIE;
const adminCookie = process.env.WAVE2_ADMIN_COOKIE;
const duplicatePhone = process.env.WAVE2_DUPLICATE_PHONE;
const registrationPassword = process.env.WAVE2_REGISTRATION_PASSWORD;
const registrationClientIp = process.env.WAVE2_REGISTRATION_CLIENT_IP;
const userId = process.env.WAVE2_USER_ID;
const offerId = process.env.WAVE2_OFFER_ID;
const orderId = process.env.WAVE2_ORDER_ID;
const conversationId = process.env.WAVE2_CONVERSATION_ID;

if (
  !webBase ||
  !apiOrigin ||
  !payload ||
  !marker ||
  !userCookie ||
  !buyerCookie ||
  !adminCookie ||
  !duplicatePhone ||
  !registrationPassword ||
  !registrationClientIp ||
  !userId ||
  !offerId ||
  !orderId ||
  !conversationId
)
  throw new Error("Missing isolated Wave 2 browser-XSS configuration.");

const checks = [];
const pageErrors = [];
const listingsResponses = [];
const contexts = [];
let browser;

function cookieParts(value) {
  const equals = value.indexOf("=");
  assert.ok(equals > 0, "expected a named session cookie");
  return {
    name: value.slice(0, equals),
    value: value.slice(equals + 1),
  };
}

async function openContext(cookie) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 1440, height: 900 },
    // Sign-up pre-selects the country from the device time zone; the fixtures use Kuwaiti numbers.
    timezoneId: "Asia/Kuwait",
    locale: "ar-KW",
  });
  if (cookie) {
    const token = cookieParts(cookie);
    await context.addCookies([
      {
        ...token,
        domain: new URL(webBase).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
      },
    ]);
  }
  await context.addInitScript((initialMarker) => {
    window.__dinarWave2Xss = false;
    window.__dinarWave2Marker = initialMarker;
  }, marker);
  // Expose frozen product routes only in this isolated test browser. The
  // repository's CHAT_ONLY_MODE constant and the shipped application stay unchanged.
  await context.route("**/src/App.tsx*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const testSource = source.replace(
      "const CHAT_ONLY_MODE = true;",
      "const CHAT_ONLY_MODE = false;",
    );
    assert.notEqual(
      testSource,
      source,
      "the isolated browser route override must match the frozen route switch",
    );
    await route.fulfill({ response, body: testSource });
  });
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const headers = await request.allHeaders();
    for (const name of [
      "host",
      "origin",
      "referer",
      "content-length",
      "sec-fetch-site",
    ])
      delete headers[name];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    if (requestUrl.pathname === "/api/auth/register")
      headers["x-forwarded-for"] = registrationClientIp;
    const response = await route.fetch({
      url: `${apiOrigin}${requestUrl.pathname}${requestUrl.search}`,
      headers,
    });
    if (requestUrl.pathname === "/api/listings") {
      listingsResponses.push({
        method: request.method(),
        url: requestUrl.pathname + requestUrl.search,
        status: response.status(),
        body: (await response.text()).slice(0, 1_500),
      });
    }
    await route.fulfill({ response });
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { context, page };
}

async function checkSafe(page, label, path, selector) {
  await page.goto(path);
  if (selector) {
    try {
      await page.getByTestId(selector).waitFor({
        state: "visible",
        timeout: 10_000,
      });
    } catch (error) {
      const body = (await page.locator("body").innerText()).slice(0, 1_000);
      throw new Error(
        `${label}: missing selector ${selector}; listing API=${JSON.stringify(listingsResponses)}; body=${body}`,
        { cause: error },
      );
    }
  }
  await page.waitForFunction(
    (expected) => document.body.textContent?.includes(expected),
    payload,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(300);
  const result = await page.evaluate((uniqueMarker) => ({
    text: document.body.textContent ?? "",
    injectedNode: Boolean(
      document.querySelector(`[data-wave2="${uniqueMarker}"]`),
    ),
    executed: window.__dinarWave2Xss === true,
  }), marker);
  assert.ok(result.text.includes(payload), `${label}: content was not visible`);
  assert.equal(result.injectedNode, false, `${label}: payload became an HTML node`);
  assert.equal(result.executed, false, `${label}: payload executed`);
  checks.push(label);
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const userSession = await openContext(userCookie);
  const conversationKey = `dinar-conversation:${userId}:SA`;
  await userSession.context.addInitScript(
    ({ key, id }) => localStorage.setItem(key, id),
    { key: conversationKey, id: conversationId },
  );
  await checkSafe(
    userSession.page,
    "search result card",
    "/search?q=Wave2",
    `card-listing-${offerId}`,
  );
  await checkSafe(
    userSession.page,
    "listing detail",
    `/listings/${offerId}`,
  );
  await checkSafe(
    userSession.page,
    "seller management",
    "/seller/offers",
    `row-seller-offer-${offerId}`,
  );
  await userSession.page.goto("/");
  await userSession.page.getByTestId("conversation-thread").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await userSession.page.waitForFunction(
    (expected) => document.body.textContent?.includes(expected),
    payload,
    { timeout: 20_000 },
  );
  const aiResult = await userSession.page.evaluate((uniqueMarker) => ({
    text: document.body.textContent ?? "",
    injectedNode: Boolean(
      document.querySelector(`[data-wave2="${uniqueMarker}"]`),
    ),
    executed: window.__dinarWave2Xss === true,
  }), marker);
  assert.ok(aiResult.text.includes(payload), "AI conversation body is visible");
  assert.equal(aiResult.injectedNode, false, "AI body must stay text");
  assert.equal(aiResult.executed, false, "AI body must not execute");
  checks.push("AI conversation");

  const buyerSession = await openContext(buyerCookie);
  await checkSafe(
    buyerSession.page,
    "order conversation",
    `/orders/${orderId}`,
  );

  const adminSession = await openContext(adminCookie);
  await checkSafe(
    adminSession.page,
    "admin dispute record",
    "/admin/disputes",
  );

  const anonymous = await openContext();
  await anonymous.page.goto("/register");
  let registrationPayload;
  anonymous.page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/register")
      registrationPayload = request.postDataJSON();
  });
  await anonymous.page.locator('input[name="displayName"]').fill("Registration probe");
  await anonymous.page.locator('input[name="phoneNumber"]').fill(duplicatePhone);
  await anonymous.page.locator('input[name="password"]').fill(registrationPassword);
  await anonymous.page
    .locator('input[name="confirmPassword"]')
    .fill(registrationPassword);
  await anonymous.page
    .locator('input[name="acceptTerms"]')
    .check({ force: true });
  await anonymous.page.getByTestId("button-auth-submit").click();
  const neutralRegistrationError =
    "تعذر إكمال التسجيل بهذه البيانات. تحقق من البيانات أو استخدم تسجيل الدخول.";
  await anonymous.page.getByText(neutralRegistrationError, { exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  assert.ok(registrationPayload, "development registration request should be sent");
  assert.equal(
    Object.hasOwn(registrationPayload, "verificationToken"),
    false,
    "development registration should omit the phone verification token",
  );
  assert.equal(
    await anonymous.page.getByTestId("status-phone-verification").count(),
    0,
    "development registration should not show the phone verification step",
  );
  const registrationPageText = await anonymous.page.locator("body").innerText();
  assert.doesNotMatch(
    registrationPageText,
    /الهاتف مسجل|رقم الهاتف مسجل|already registered|phone exists/i,
  );
  checks.push("anonymous duplicate-registration message");

  assert.deepEqual(pageErrors, [], "browser surfaces must not raise page errors");
  console.log(
    "WAVE2_XSS_CHECKS " + JSON.stringify({ checks, pageErrors }),
  );
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  if (browser) await browser.close();
}