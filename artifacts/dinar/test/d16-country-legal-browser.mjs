import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const webBase = process.env.D16_COUNTRY_WEB_BASE;
const adminCookie = process.env.D16_COUNTRY_ADMIN_COOKIE;
const nonAdminCookie = process.env.D16_COUNTRY_NON_ADMIN_COOKIE;
const resultPath = process.env.D16_COUNTRY_UI_RESULT_PATH;

if (!webBase || !adminCookie || !nonAdminCookie || !resultPath) {
  throw new Error("Missing D16 country admin browser acceptance configuration.");
}

function parseCookie(cookie) {
  const equalsIndex = cookie.indexOf("=");
  assert.ok(equalsIndex > 0, "expected a named session cookie");
  return {
    name: cookie.slice(0, equalsIndex),
    value: cookie.slice(equalsIndex + 1),
  };
}

let browser;
let failure;
let result;
const pageErrors = [];

try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ??
      process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });

  const adminContext = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 1440, height: 1000 },
  });
  const adminSession = parseCookie(adminCookie);
  await adminContext.addCookies([
    {
      ...adminSession,
      domain: new URL(webBase).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
  const adminPage = await adminContext.newPage();
  adminPage.on("pageerror", (error) => pageErrors.push(error.message));
  await adminPage.goto("/admin/legal-readiness", {
    waitUntil: "domcontentloaded",
  });
  const countryPanel = adminPage.getByTestId("country-legal-readiness");
  await countryPanel.waitFor({ state: "visible", timeout: 30_000 });
  await adminPage
    .getByRole("heading", { name: "حزم المراجعة القانونية حسب الدولة" })
    .waitFor();

  const countries = [];
  for (const marketId of ["JO", "KW", "SA"]) {
    await adminPage
      .getByTestId(`card-country-readiness-${marketId.toLowerCase()}`)
      .waitFor({ state: "visible" });
    countries.push(marketId);
  }
  const direction = await countryPanel.evaluate(
    (element) => getComputedStyle(element).direction,
  );
  assert.equal(direction, "rtl");
  const packageSelect = adminPage.getByTestId("select-country-legal-package");
  await packageSelect.selectOption("KW");
  assert.equal(await packageSelect.inputValue(), "KW");
  await adminPage.getByTestId("country-readiness-blockers").waitFor();

  const nonAdminContext = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 1280, height: 900 },
  });
  const nonAdminSession = parseCookie(nonAdminCookie);
  await nonAdminContext.addCookies([
    {
      ...nonAdminSession,
      domain: new URL(webBase).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
  const nonAdminPage = await nonAdminContext.newPage();
  nonAdminPage.on("pageerror", (error) => pageErrors.push(error.message));
  await nonAdminPage.goto("/admin/legal-readiness", {
    waitUntil: "domcontentloaded",
  });
  await nonAdminPage.getByText("الوصول مقيّد", { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });

  result = {
    countries,
    direction,
    nonAdminDenied: true,
  };
  await nonAdminContext.close();
  await adminContext.close();
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser?.close();
  writeFileSync(
    resultPath,
    JSON.stringify({ result, pageErrors, failure }, null, 2),
  );
}

if (failure) {
  throw new Error(failure);
}
