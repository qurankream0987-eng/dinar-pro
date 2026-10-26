import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const webBase = process.env.PHASE2_WEB_BASE;
const apiOrigin = process.env.PHASE2_API_ORIGIN;
const adminCookie = process.env.PHASE2_ADMIN_COOKIE;
const orderId = process.env.PHASE2_ORDER_ID;
const resolution = process.env.PHASE2_RESOLUTION;
const note = process.env.PHASE2_NOTE ?? "";
const resultPath = process.env.PHASE2_UI_RESULT_PATH;

if (
  !webBase ||
  !apiOrigin ||
  !adminCookie ||
  !orderId ||
  !["BUYER", "SELLER"].includes(resolution ?? "") ||
  !resultPath
)
  throw new Error("Missing admin dispute browser acceptance configuration.");

let browser;
let failure;
let result;
const pageErrors = [];

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
  });
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 1440, height: 900 },
  });
  const equalsIndex = adminCookie.indexOf("=");
  assert.ok(equalsIndex > 0, "expected a named admin session cookie");
  await context.addCookies([
    {
      name: adminCookie.slice(0, equalsIndex),
      value: adminCookie.slice(equalsIndex + 1),
      domain: new URL(webBase).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of [
      "host",
      "origin",
      "referer",
      "content-length",
      "sec-fetch-site",
    ])
      delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    const response = await route.fetch({
      url: `${apiOrigin}${requestUrl.pathname}${requestUrl.search}`,
      headers,
    });
    await route.fulfill({ response });
  });

  const identity = await context.request.get(`${apiOrigin}/api/auth/me`);
  assert.equal(identity.status(), 200, await identity.text());
  assert.equal((await identity.json()).user?.role, "ADMIN");
  await page.goto("/admin/disputes");
  await page
    .getByRole("heading", { name: "إدارة النزاعات", exact: true })
    .waitFor();

  const disputeCard = page.getByTestId(`admin-dispute-${orderId}`);
  await disputeCard.waitFor();
  await disputeCard
    .getByTestId(`select-resolution-${orderId}`)
    .selectOption(resolution);
  await disputeCard.locator("textarea").fill(note);
  await disputeCard
    .getByTestId(`button-review-resolution-${orderId}`)
    .click();
  await page
    .getByRole("heading", { name: "تأكيد حسم النزاع؟", exact: true })
    .waitFor();

  const resolutionResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/admin/disputes/${encodeURIComponent(orderId)}/resolve` &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "تأكيد الحسم النهائي", exact: true })
    .click();
  const response = await resolutionResponse;
  assert.equal(response.status(), 200, await response.text());
  const resolutionData = await response.json();
  assert.equal(resolutionData.disputeStatus, "RESOLVED");
  assert.equal(resolutionData.resolution, resolution);
  await disputeCard.getByText("تم الحسم", { exact: true }).waitFor();
  await disputeCard.getByText(note, { exact: true }).waitFor();

  await page.reload();
  await page
    .getByRole("heading", { name: "إدارة النزاعات", exact: true })
    .waitFor();
  const reloadedCard = page.getByTestId(`admin-dispute-${orderId}`);
  await reloadedCard.getByText("تم الحسم", { exact: true }).waitFor();
  await reloadedCard.getByText(note, { exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  result = { status: response.status(), data: resolutionData };
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify({ result, pageErrors, failure }, null, 2),
  );
  await browser?.close();
}

if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ result, pageErrors }));
}