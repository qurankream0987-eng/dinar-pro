/**
 * D1/D2 browser acceptance (driven by artifacts/api-server/test/d1-d2-business-browser.test.ts):
 * the DINAR Business card and the Go / Pro / Business plans in the real production build, in
 * Chromium, at 360 / 390 px (mobile) and 1280 px (desktop). Google Fonts are answered locally
 * (no network); every other non-loopback request is recorded as a failure.
 */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const webBase = process.env.D12_WEB_BASE;
const apiOrigin = process.env.D12_API_ORIGIN;
const cookies = JSON.parse(process.env.D12_COOKIES ?? "{}");
const pdfPath = process.env.D12_PDF_PATH;
const resultPath = process.env.D12_RESULT_PATH;
if (!webBase || !apiOrigin || !pdfPath || !resultPath || !cookies.owner || !cookies.other) throw new Error("Missing D1/D2 browser configuration.");

const results = {};
const failures = {};
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
const counters = { horizontalOverflow: 0, notRtl: 0, clippedCards: 0, falseBusinessSuccess: 0, falseSubscriptionSuccess: 0, crossAccountLeaks: 0 };
const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
let browser;
let page;
let context;

async function record(id, body) {
  try {
    await body();
    results[id] = "PASS";
  } catch (error) {
    results[id] = "FAIL";
    const last = await latestAssistant().innerText({ timeout: 2000 }).catch(() => "");
    failures[id] = `${error instanceof Error ? error.message.split("\n")[0] : String(error)} || LAST: ${last.replace(/\s+/g, " ").slice(0, 500)}`;
  }
}
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const assistantMessages = () => page.locator('[data-testid^="message-assistant-"]');
const latestAssistant = () => assistantMessages().last();
async function waitForTurn(before) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > count && document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
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
  return latestAssistant();
}
async function clickTurn(locator) {
  const before = await assistantMessages().count();
  await locator.click();
  await waitForTurn(before);
  return latestAssistant();
}
const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, " ");

async function measure(width, visible) {
  await page.setViewportSize({ width, height: width >= 1000 ? 900 : 844 });
  await settle();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    direction: getComputedStyle(document.querySelector('[data-testid="business-card"]') ?? document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
  }));
  if (dimensions.scrollWidth > dimensions.width) counters.horizontalOverflow++;
  if (dimensions.direction !== "rtl") counters.notRtl++;
  await visible.evaluate((element) => element.scrollIntoView({ block: "nearest", behavior: "instant" }));
  await settle();
  const box = await visible.boundingBox();
  if (!box || box.x < -0.5 || box.x + box.width > dimensions.width + 0.5) counters.clippedCards++;
  return { ...dimensions, box };
}

async function openSession(cookie, mobile = true) {
  context = await browser.newContext({ baseURL: webBase, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, locale: "ar" });
  if (cookie) await setCookie(cookie);
  await context.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: route.request().url().includes("googleapis") ? "text/css" : "font/woff2", body: "" }));
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"]) delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    try {
      await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    // Loopback only: the app, the API and the loopback S3-compatible test storage (signed PUT).
    if (!/^https?:$/.test(url.protocol) || allowedHosts.has(url.host) || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || /^fonts\.(?:googleapis|gstatic)\.com$/.test(url.hostname)) return;
    externalRequests.push(`${url.hostname}${url.pathname}`);
  });
}
async function setCookie(cookie) {
  const separator = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: new URL(webBase).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]);
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
}
const latestCard = () => page.getByTestId("business-card").last();
const FALSE_BUSINESS = /تم توثيق نشاطك|نشاطك موثّق الآن|تمت الموافقة على نشاطك/u;
const FALSE_SUBSCRIPTION = /اشتراكك .* نشط حتى|تم تفعيل اشتراكك|تم الاشتراك بنجاح/u;
const report = {};

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  await openSession(cookies.owner, true);

  await record("B-01", async () => {
    await newConversation();
    const reply = await sendTurn("دينار، أنا صاحب مطعم اسمه سمراء للمشاوي في الكويت، وأريد أضيفه إلى دينار.");
    const card = reply.getByTestId("business-card");
    await card.waitFor();
    const text = await textOf(card);
    assert.match(text, /DINAR BUSINESS/);
    assert.match(text, /سمراء للمشاوي/u);
    assert.match(text, /الكويت/u);
    assert.match(text, /مطعم ومشاوي/u);
    assert.equal(await card.getAttribute("data-status"), "DRAFT");
    if (FALSE_BUSINESS.test(await textOf(reply))) counters.falseBusinessSuccess++;
    for (const width of [360, 390]) report[`card-${width}`] = await measure(width, card);
  });

  await record("B-02", async () => {
    const card = latestCard();
    await card.getByTestId("business-legal-name").fill("مؤسسة سمراء للمشاوي");
    await card.getByTestId("business-registration").fill("KW-123456");
    const before = await assistantMessages().count();
    await card.getByRole("button", { name: "حفظ البيانات" }).click();
    await waitForTurn(before);
    const refreshed = latestCard();
    await refreshed.waitFor();
    assert.match(await textOf(refreshed), /••••3456/u);
  });

  await record("B-03", async () => {
    const reply = await clickTurn(latestCard().getByTestId("business-action-START_VERIFICATION"));
    const card = reply.getByTestId("business-card");
    await card.waitFor();
    assert.equal(await card.getAttribute("data-status"), "DOCUMENTS_REQUIRED");
    const before = await assistantMessages().count();
    await card.getByTestId("business-upload-input").setInputFiles(pdfPath);
    await waitForTurn(before);
    const after = latestCard();
    await after.getByTestId("business-documents").waitFor();
    assert.match(await textOf(after), /فُحص وسليم/u);
  });

  await record("B-04", async () => {
    const reply = await clickTurn(latestCard().getByTestId("business-action-SUBMIT_FOR_REVIEW"));
    const card = reply.getByTestId("business-card");
    await card.waitFor();
    assert.equal(await card.getAttribute("data-status"), "PENDING_REVIEW");
    assert.match(await textOf(reply), /بانتظار مراجع دينار/u);
    if (FALSE_BUSINESS.test(await textOf(reply))) counters.falseBusinessSuccess++;
  });

  await record("B-05", async () => {
    const reloaded = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/ai/conversations/") && response.request().method() === "GET");
    await page.reload();
    await page.getByTestId("input-ai-composer").waitFor();
    await reloaded;
    const card = latestCard();
    await card.waitFor();
    assert.equal(await card.getAttribute("data-status"), "PENDING_REVIEW", "the card is restored from the server envelope");
  });

  await record("B-06", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await settle();
    report["card-1280"] = await measure(1280, latestCard());
    const compare = await sendTurn("دينار، ما الفرق بين جو وبرو؟");
    const text = await textOf(compare);
    assert.match(text, /دينار جو/u);
    assert.match(text, /دينار برو/u);
    assert.match(text, /سعر مرجعي مقترح/u);
    const plans = compare.locator('[data-testid="dinar-plan"]');
    assert.equal(await plans.count(), 3, "Go, Pro and Business cards");
    report["plans-1280"] = await measure(1280, compare.locator('[data-testid="ai-plans"]').first());
    report["plans-390"] = await measure(390, compare.locator('[data-testid="ai-plans"]').first());
  });

  await record("B-07", async () => {
    const reply = await sendTurn("أبي أشترك في بزنس");
    const text = await textOf(reply);
    assert.match(text, /49 دولار/u);
    assert.match(text, /غير متاح الآن|غير موصولة/u);
    if (FALSE_SUBSCRIPTION.test(text)) counters.falseSubscriptionSuccess++;
  });

  await record("B-08", async () => {
    // Log out in the same tab: nothing of the business remains visible.
    await page.evaluate(async () => fetch("/api/auth/logout", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" }));
    await page.goto("/");
    await page.getByTestId("input-ai-composer").waitFor();
    await settle();
    if (/سمراء للمشاوي|KW-123456|3456/u.test(await page.locator("body").innerText())) counters.crossAccountLeaks++;
    // Switch to another account in the same browser.
    await setCookie(cookies.other);
    await page.goto("/");
    await page.getByTestId("input-ai-composer").waitFor();
    await settle();
    if (/سمراء للمشاوي/u.test(await page.locator("body").innerText())) counters.crossAccountLeaks++;
    const history = await page.evaluate(async () => (await (await fetch("/api/ai/conversations", { credentials: "include" })).json()));
    if (JSON.stringify(history).includes("سمراء")) counters.crossAccountLeaks++;
    await newConversation();
    const reply = await sendTurn("وش صار على توثيق مطعمي");
    assert.match(await textOf(reply), /لا يوجد لديك نشاط تجاري/u);
    if (/سمراء للمشاوي/u.test(await page.locator("body").innerText())) counters.crossAccountLeaks++;
  });
} catch (error) {
  failures.FATAL = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser?.close().catch(() => undefined);
  const unexpectedConsole = consoleErrors.filter((text) => !/Failed to load resource: the server responded with a status of (?:401|404|409)/.test(text));
  const failure = Object.keys(failures).length
    ? JSON.stringify(failures)
    : pageErrors.length
      ? `page errors: ${pageErrors.join(" | ")}`
      : unexpectedConsole.length
        ? `console errors: ${unexpectedConsole.join(" | ")}`
        : externalRequests.length
          ? `external requests: ${externalRequests.join(", ")}`
          : Object.entries(counters).some(([, value]) => value > 0)
            ? `counters: ${JSON.stringify(counters)}`
            : undefined;
  await writeFile(resultPath, JSON.stringify({ results, failures, counters, pageErrors, consoleErrors: unexpectedConsole, externalRequests, report, ...(failure ? { failure } : {}) }, null, 2));
}
