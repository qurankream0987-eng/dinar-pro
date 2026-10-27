import assert from "node:assert/strict";

/**
 * Shared browser plumbing for the SC acceptance journeys: one object per signed-in user, so two
 * users can act in the same run (and at the same moment) without sharing a page. The API is
 * reached through the web origin exactly as the app does; only the session cookie differs.
 */
export function createRecorder(webBase, apiOrigin) {
  const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
  const fontHosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
  return { allowedHosts, fontHosts, checks: [], steps: [], modelFallbacks: [], pageErrors: [], consoleErrors: [], externalRequests: [], horizontalOverflow: 0 };
}

/**
 * The replies the runtime gives when a message fell through to the model (smart-turn.ts
 * modelFailureMessage). With no provider configured these never pass the call counter, so the
 * journeys detect them by text: a commercial step that reaches them is a DINAR gap.
 */
export const MODEL_FALLBACK_REPLY = /الدردشة الذكية غير متاحة|وصل مزود المساعد الذكي|تعذر عليّ التفكير في هذا الآن|لم أفهم طلبك بدقة|MODEL_FALLBACK/u;

export async function openUser(browser, { webBase, apiOrigin, cookie, label, recorder }) {
  const context = await browser.newContext({ baseURL: webBase, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ar" });
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
  const page = await context.newPage();
  page.on("pageerror", (error) => recorder.pageErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") recorder.consoleErrors.push(`${label}: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || recorder.allowedHosts.has(url.host) || recorder.fontHosts.has(url.hostname)) return;
    recorder.externalRequests.push(`${url.hostname}${url.pathname}`);
  });

  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const assistantMessages = () => page.locator('[data-testid^="message-assistant-"]');
  const latest = () => assistantMessages().last();
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
  /** `allowFallback`: a step where reaching the model is acceptable (it is then listed, not hidden). */
  async function say(text, { allowFallback = false } = {}) {
    const before = await assistantMessages().count();
    await page.getByTestId("input-ai-composer").fill(text);
    await page.getByTestId("button-send-ai-message").click();
    await waitForTurn(before);
    const reply = latest();
    const shown = (await reply.innerText()).replace(/\s+/g, " ");
    recorder.steps.push({ user: label, said: text, reply: shown.slice(0, 240) });
    if (MODEL_FALLBACK_REPLY.test(shown)) recorder.modelFallbacks.push({ user: label, said: text, allowed: allowFallback });
    return reply;
  }
  async function click(locator) {
    const before = await assistantMessages().count();
    await locator.click();
    await waitForTurn(before);
    return latest();
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
  async function measure(name, width, visible) {
    await page.setViewportSize({ width, height: 844 });
    await settle();
    const dimensions = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      direction: getComputedStyle(document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
    }));
    if (Math.max(dimensions.scrollWidth, dimensions.bodyScrollWidth) > dimensions.width) {
      recorder.horizontalOverflow += 1;
      throw new Error(`${name} ${width}px: horizontal overflow ${JSON.stringify(dimensions)}`);
    }
    assert.equal(dimensions.direction, "rtl", `${name} ${width}px must stay RTL`);
    await visible.scrollIntoViewIfNeeded();
    const box = await visible.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= dimensions.width + 0.5 && box.width > 0, `${name} ${width}px: content clipped ${JSON.stringify({ box, dimensions })}`);
    const buttons = await visible.locator("button:visible").evaluateAll((nodes) =>
      nodes
        .filter((node) => !node.closest('[role="region"][data-testid^="ai-results-carousel-"]'))
        .map((node) => ({ height: node.getBoundingClientRect().height, name: node.getAttribute("aria-label") || node.textContent?.trim() })),
    );
    assert.ok(buttons.every((button) => button.height >= 32), `${name} ${width}px: touch targets ${JSON.stringify(buttons)}`);
    assert.ok(buttons.every((button) => button.name), `${name} ${width}px: every button has an accessible name`);
    recorder.checks.push(`${name} ${width}px: RTL, no overflow, content and named buttons inside the viewport`);
  }
  /** The scenario widths: 320 and 390 phones and a desktop window. */
  async function widths(name, visible) {
    for (const width of [320, 390, 1280]) await measure(name, width, visible);
    await page.setViewportSize({ width: 390, height: 844 });
    await settle();
  }
  async function api(path) {
    const response = await fetch(`${apiOrigin}/api${path}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, `${path}: ${response.status}`);
    return response.json();
  }
  return { page, context, say, click, latest, newConversation, widths, api, label };
}
