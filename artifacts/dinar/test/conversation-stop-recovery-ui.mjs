import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.STOP_WEB_BASE;
const cookie = process.env.STOP_COOKIE;
const report = { checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], turns: [] };
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 }, locale: "ar" });
  const split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), domain: new URL(base).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  await context.route("https://fonts.googleapis.com/**", route => route.fulfill({ status: 200, contentType: "text/css", body: "/* local font fixture */" }));
  await context.route("https://fonts.gstatic.com/**", route => route.fulfill({ status: 200, body: "" }));
  const page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
  page.on("request", request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.host !== new URL(base).host && !["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) report.externalRequests.push(url.hostname);
    if (request.method() === "POST" && /\/ai\/conversations\/[^/]+\/turns$/.test(url.pathname)) report.turns.push(request.postDataJSON().clientMessageId);
  });
  await page.goto("/");
  const input = page.getByTestId("input-ai-composer");
  await input.fill("اشرح لي مفهوم الاستدامة بشكل عام");
  await page.getByTestId("button-send-ai-message").click();
  const stop = page.getByTestId("button-stop-ai-response");
  await stop.waitFor({ timeout: 45_000 });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const shape = await stop.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    assert.ok(shape.width >= 32 && shape.height >= 32);
    assert.equal(shape.overflow, 0);
  }
  await input.fill("مسودة أخرى لا ترسل أثناء التحقق");
  await stop.click();
  await page.getByTestId("button-verify-ai-turn").waitFor();
  assert.equal(await input.inputValue(), "مسودة أخرى لا ترسل أثناء التحقق");
  assert.equal(await page.getByTestId("button-send-ai-message").isDisabled(), true);
  assert.equal(await page.getByTestId("button-retry-ai-turn").count(), 0);
  assert.equal(report.turns.length, 1);
  report.checks.push("Stop preserves the draft, blocks a second turn, and requests verification rather than transaction cancellation");
  await page.reload();
  await page.getByTestId("button-verify-ai-turn").waitFor({ timeout: 45_000 });
  await input.fill("مسودة جديدة");
  assert.equal(await page.getByTestId("button-send-ai-message").isDisabled(), true);
  report.checks.push("reload restores pending verification from the owned server record without browser-stored prompt text");
  process.send?.({ type: "release-turn" });
  await page.getByText("هذه إجابة عامة محفوظة بعد توقف استقبال الرد.", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId("button-verify-ai-turn").waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "مسودة جديدة");
  assert.equal(await page.getByTestId("button-send-ai-message").isDisabled(), false);
  assert.equal(report.turns.length, 1, "verification never resubmits the stopped request");
  await page.reload();
  await page.getByText("هذه إجابة عامة محفوظة بعد توقف استقبال الرد.", { exact: true }).waitFor();
  assert.equal(report.turns.length, 1);
  report.checks.push("the correlated completed answer is adopted and survives a second reload without duplicate effects");
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
} catch (error) {
  report.failure = error.message;
} finally {
  await browser?.close();
  writeFileSync(process.env.STOP_RESULT_PATH, JSON.stringify(report));
}
