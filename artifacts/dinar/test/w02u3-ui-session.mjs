import assert from "node:assert/strict";
import { MODEL_FALLBACK_REPLY } from "./sc-ui-session.mjs";

/**
 * Shared plumbing for the W02U-3 browser journeys that use the application's real authentication
 * flow (sign in with the login form, sign out from the account screen) instead of an injected
 * cookie. Every helper takes the page explicitly so a journey can keep one page across accounts,
 * which is exactly the switch these suites must prove.
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Toasts are hosted above the phone viewport's top bar, where they can cover the sidebar
 * trigger and the drawer header. Hovering pauses a toast's dismissal, and a Playwright click
 * attempt keeps the pointer on it, so park the pointer first and let them clear.
 */
export async function settleToasts(page) {
  await page.mouse.move(4, 4);
  await page
    .waitForFunction(() => document.querySelectorAll("[data-sonner-toast]").length === 0, null, { timeout: 12_000 })
    .catch(() => undefined);
}

export async function openPage(browser, { webBase, label = "tab", recorder }) {
  const context = await browser.newContext({ baseURL: webBase, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ar" });
  const page = await context.newPage();
  page.on("pageerror", (error) => recorder.pageErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") recorder.consoleErrors.push(`${label}: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || recorder.allowedHosts.has(url.host) || recorder.fontHosts.has(url.hostname)) return;
    recorder.externalRequests.push(`${label}: ${url.hostname}${url.pathname}`);
  });
  return { context, page };
}

export async function identityOf(page) {
  try {
    return await page.evaluate(async () => {
      const response = await fetch("/api/auth/me");
      const body = await response.json();
      return body?.user?.id ?? null;
    });
  } catch {
    return undefined;
  }
}

export async function waitForIdentity(page, expected, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await identityOf(page);
    if (current === expected) return;
    if (Date.now() > deadline) throw new Error(`the browser session did not become ${expected} (last ${String(current)})`);
    await sleep(200);
  }
}

/** Sign in through the real login form: dial code sheet, phone, password, submit. */
export async function signIn(page, { id, phone, password }) {
  await page.goto("/login");
  await page.getByTestId("select-dial-code").click();
  await page.getByTestId("button-country-JO").click();
  await page.locator('input[name="phoneNumber"]').fill(phone);
  await page.locator('input[name="password"]').fill(password);
  const login = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/login" && response.request().method() === "POST");
  await page.getByTestId("button-auth-submit").click();
  const response = await login;
  assert.equal(response.status(), 200, `login for ${id}: ${response.status()} ${(await response.text()).slice(0, 300)}`);
  await waitForIdentity(page, id);
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await settleToasts(page);
}

/** Sign out through the account screen and its confirmation dialog. */
export async function signOut(page) {
  await page.goto("/settings");
  const button = page.getByTestId("button-settings-logout");
  await button.waitFor({ timeout: 45_000 });
  await button.click();
  await page.getByTestId("button-confirm-action").click();
  await waitForIdentity(page, null);
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await settleToasts(page);
}

export async function startConversation(page) {
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await settleToasts(page);
  const button = page.locator('[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible').first();
  if (!(await button.isVisible())) await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await button.waitFor({ state: "visible" });
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ai/conversations" && response.request().method() === "POST");
  await button.click();
  const response = await created;
  assert.equal(response.status(), 201);
  const body = await response.json();
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor({ timeout: 45_000 });
  return body.id;
}

export async function sendTurn(page, recorder, text) {
  const before = await page.locator('[data-testid^="message-assistant-"]').count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
      document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    before,
    { timeout: 60_000 },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const shown = (await page.locator('[data-testid^="message-assistant-"]').last().innerText()).replace(/\s+/g, " ");
  recorder.steps.push({ said: text, reply: shown.slice(0, 240) });
  if (MODEL_FALLBACK_REPLY.test(shown)) recorder.modelFallbacks.push({ said: text });
  return shown;
}

export async function purchaseCard(page) {
  const card = page.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();
  await card.waitFor({ state: "visible", timeout: 45_000 });
  return card.evaluate((node) => ({
    surfaceId: node.getAttribute("data-card-surface-id"),
    lifecycle: node.getAttribute("data-card-lifecycle"),
    label: node.getAttribute("aria-label"),
    buttons: [...node.querySelectorAll("button")].map((button) => button.getAttribute("data-testid") || button.getAttribute("aria-label") || button.textContent?.trim() || ""),
  }));
}

export async function waitForCardLifecycle(page, lifecycle, timeout = 30_000) {
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll('[data-testid="purchase-review"][data-card-lifecycle]')].some((node) => node.getAttribute("data-card-lifecycle") === expected),
    lifecycle,
    { timeout },
  );
}

export async function backend(apiOrigin, cookie, path, method = "GET", body) {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin: apiOrigin } : {}), cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

export async function cartQuantity(apiOrigin, cookie, listingId) {
  const cart = await backend(apiOrigin, cookie, "/cart");
  assert.equal(cart.status, 200, cart.text);
  const line = (Array.isArray(cart.data) ? cart.data : []).find((item) => item.listingId === listingId);
  return line?.quantity ?? 0;
}

export function purchaseReviewIn(view) {
  for (const message of view.messages ?? [])
    for (const block of message.blocks ?? [])
      if (block?.payload?.purchaseReview) return { message, block, card: block.payload.card, review: block.payload.purchaseReview };
  return undefined;
}

export async function conversationReview(apiOrigin, cookie, conversationId) {
  const view = await backend(apiOrigin, cookie, `/ai/conversations/${conversationId}`);
  assert.equal(view.status, 200, view.text);
  return purchaseReviewIn(view.data ?? {});
}
