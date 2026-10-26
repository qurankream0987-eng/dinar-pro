import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const webBase = process.env.CONTACT_WEB_BASE;
const apiOrigin = process.env.CONTACT_API_ORIGIN;
const cookie = process.env.CONTACT_BUYER_COOKIE;
const conversationId = process.env.CONTACT_CONVERSATION_ID;
const buyerUserId = process.env.CONTACT_BUYER_USER_ID;
const expectedNumber = process.env.CONTACT_EXPECTED_NUMBER;
const resultPath = process.env.CONTACT_RESULT_PATH;
if (![webBase, apiOrigin, cookie, conversationId, buyerUserId, expectedNumber, resultPath].every(Boolean))
  throw new Error("Missing signed-in buyer contact browser configuration.");

const consoleErrors = [];
const providerRequests = [];
const contactCacheHeaders = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
});
try {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ar",
  });
  await context.addInitScript(({ id, userId }) => {
    localStorage.setItem(`dinar-conversation:${userId}:JO`, id);
  }, { id: conversationId, userId: buyerUserId });
  const separator = cookie.indexOf("=");
  await context.addCookies([{
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1),
    domain: new URL(webBase).hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: false,
  }]);
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = await req.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"])
      delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (/(openai|anthropic|groq|openrouter|stripe|paypal|twilio|vonage|checkout)/i.test(request.url()))
      providerRequests.push(new URL(request.url()).hostname);
  });
  page.on("response", (response) => {
    if (/\/orders\/[^/]+\/contact$/.test(new URL(response.url()).pathname))
      contactCacheHeaders.push(response.headers()["cache-control"] ?? "");
  });
  await page.goto("/ai");
  await page.getByText("بيانات التواصل المعتمدة لهذا الطلب").waitFor({ state: "visible", timeout: 45_000 });
  await page.getByRole("link", { name: expectedNumber, exact: true }).waitFor({ state: "visible" });
  await page.reload();
  await page.getByText("بيانات التواصل المعتمدة لهذا الطلب").waitFor({ state: "visible", timeout: 45_000 });
  await page.getByRole("link", { name: expectedNumber, exact: true }).waitFor({ state: "visible" });
  assert.ok(contactCacheHeaders.length >= 2, "reload performs a new authorized retrieval");
  assert.ok(contactCacheHeaders.every((value) => value.includes("no-store")), "contact retrieval is never cached by the browser");
  const history = await page.evaluate(async (id) => {
    const response = await fetch(`/api/ai/conversations/${id}`, { credentials: "include" });
    return response.text();
  }, conversationId);
  assert.equal(history.includes(expectedNumber), false, "conversation history stores only the request marker");
  await writeFile(resultPath, JSON.stringify({
    contactRendered: true,
    consoleErrors,
    providerRequests,
    contactCacheHeaders,
  }));
  await context.close();
} finally {
  await browser.close();
}
