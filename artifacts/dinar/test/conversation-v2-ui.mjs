import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const base = process.env.V2_WEB_BASE;
const listings = JSON.parse(process.env.V2_LISTINGS);
const report = { checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], comparisonWidths: [] };
let browser;
let releaseResponse = () => {};
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 }, locale: "ar", reducedMotion: "no-preference" });
  const cookie = process.env.V2_COOKIE; const split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), domain: new URL(base).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  await context.route("https://fonts.googleapis.com/**", route => route.fulfill({ status: 200, contentType: "text/css", body: "/* local font fixture */" }));
  await context.route("https://fonts.gstatic.com/**", route => route.fulfill({ status: 200, body: "" }));
  await context.addInitScript(() => {
    globalThis.__flights = [];
    for (const name of ["dinar:cart-flight-start", "dinar:cart-flight-end", "dinar:cart-flight-skipped"])
      document.addEventListener(name, event => globalThis.__flights.push({ name, ...event.detail }));
  });
  const page = await context.newPage();
  let turnRequests = 0;
  let rejectingForgedCart = false;
  const expectedRejectionErrors = [];
  page.on("pageerror", error => report.pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (rejectingForgedCart && message.text().includes("409 (Conflict)") && /\/actions\/add-to-cart$/.test(message.location().url)) expectedRejectionErrors.push(message.text());
    else report.consoleErrors.push(message.text());
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.host !== new URL(base).host && !["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) report.externalRequests.push(url.hostname);
    if (request.method() === "POST" && /\/conversations\/[^/]+\/turns$/.test(url.pathname)) turnRequests++;
  });
  await page.goto("/");
  const input = page.getByTestId("input-ai-composer");
  await input.fill(`ابحث عن ${process.env.V2_SEARCH}`);
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, which: 229, bubbles: true, cancelable: true, isComposing: false })));
  await page.waitForTimeout(200);
  assert.equal(turnRequests, 0, "the IME keyCode 229 finalization event must not send the draft");
  report.checks.push("IME finalization never submits an Arabic draft, including legacy keyCode 229");
  async function say(text) {
    const count = await page.locator('[data-testid^="message-assistant-"]').count();
    await input.fill(text); await page.getByTestId("button-send-ai-message").click();
    await page.waitForFunction(before => document.querySelectorAll('[data-testid^="message-assistant-"]').length > before && document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة", count);
    return page.locator('[data-testid^="message-assistant-"]').last();
  }
  await say(`ابحث عن ${process.env.V2_SEARCH}`);
  const compared = await say("قارنهم");
  const comparison = compared.getByTestId("comparison");
  await comparison.waitFor();
  assert.equal(await comparison.locator(".ai-comparison-card").count(), 4);
  await page.setViewportSize({ width: 390, height: 900 });
  for (const listing of listings) assert.equal(await comparison.getByRole("heading", { name: listing.title, exact: true }).count(), 1);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    report.comparisonWidths.push(width);
  }
  report.checks.push("four persisted products compare by their recorded facts at 320/390/1280 with no document overflow");
  await say(`ابحث عن ${process.env.V2_SEARCH}`);
  async function ready(id) {
    const card = page.getByTestId(`card-ai-result-${id}`).last();
    const button = page.getByTestId(`button-add-to-cart-${id}`);
    await button.scrollIntoViewIfNeeded();
    const image = card.locator("img").first(); await image.waitFor();
    assert.equal(await image.evaluate(async element => { await element.decode(); return element.complete && element.naturalWidth > 0; }), true);
    return button;
  }
  const first = await ready(listings[0].id);
  let received;
  const hasResponse = new Promise(resolve => { received = resolve; });
  const held = new Promise(resolve => { releaseResponse = resolve; });
  await page.route("**/actions/add-to-cart", async route => {
    try {
      const response = await route.fetch(); received(response.status());
      await held; await route.fulfill({ response });
    } catch { received(-1); await route.abort().catch(() => undefined); }
  }, { times: 1 });
  await first.click();
  assert.equal(await hasResponse, 200);
  assert.equal(await page.evaluate(() => globalThis.__flights.length), 0, "no animation before the real server receipt is delivered");
  releaseResponse();
  await page.waitForFunction(() => globalThis.__flights.some(event => event.name === "dinar:cart-flight-start"));
  await page.waitForSelector('[data-testid="cart-flight"]', { state: "detached" });
  report.checks.push("the owned product image flies only after the canonical server cart receipt, then cleans up");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await (await ready(listings[1].id)).click();
  await page.waitForFunction(() => globalThis.__flights.some(event => event.reason === "reduced-motion"));
  assert.equal(await page.evaluate(() => globalThis.__flights.filter(event => event.name === "dinar:cart-flight-start").length), 1);
  report.checks.push("reduced motion keeps the server-confirmed cart addition without a flight");
  await page.route("**/actions/add-to-cart", route => route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), resourceId: "00000000-0000-4000-8000-000000000000" }) }), { times: 1 });
  rejectingForgedCart = true;
  const denied = page.waitForResponse(response => /\/actions\/add-to-cart$/.test(new URL(response.url()).pathname));
  await (await ready(listings[2].id)).click();
  assert.equal((await denied).status(), 409);
  await page.waitForFunction(() => !document.querySelector('[data-testid^="button-add-to-cart-"][aria-busy="true"]'));
  assert.equal(await page.evaluate(() => globalThis.__flights.filter(event => event.name === "dinar:cart-flight-start").length), 1);
  report.checks.push("a real rejected forged cart action has no success animation or additional cart row");
  assert.equal(expectedRejectionErrors.length, 1, "only the deliberately rejected cart response may log an HTTP conflict");
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
} catch (error) { report.failure = error.stack ?? error.message; }
finally { releaseResponse(); await browser?.close(); writeFileSync(process.env.V2_RESULT, JSON.stringify(report)); }
