import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * CONNECT-01 in the real browser: the owner picks one of the three participation modes while
 * registering, sees it persisted after a reload with what it really enables, changes it through
 * the owner panel, and the page stays RTL and overflow-free on phones and desktop.
 */
const env = process.env;
const webBase = env.CM_WEB_BASE;
const apiOrigin = env.CM_API_ORIGIN;
const cookie = env.CM_COOKIE;
const resultPath = env.CM_RESULT_PATH;
if (!webBase || !apiOrigin || !cookie || !resultPath) throw new Error("Missing Connect modes browser configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
let failure;
let browser;

try {
  browser = await chromium.launch({ headless: true, executablePath: env.CHROMIUM_PATH ?? env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const owner = await openUser(browser, { webBase, apiOrigin, cookie, label: "connect-modes", recorder });
  const page = owner.page;
  await page.goto("/connect");
  await page.getByTestId("connect-portal").waitFor({ timeout: 45_000 });

  const choice = page.getByTestId("connect-mode-choice-register");
  await choice.waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await choice.locator('input[type="radio"]').count(), 3);
  const text = await choice.innerText();
  for (const label of ["بيع منتجات موقعي داخل دينار", "عرض منتجاتي في دينار والشراء من موقعي", "البيع داخل دينار ومن موقعي معًا"])
    assert.ok(text.includes(label), label);
  assert.equal(await page.getByTestId("connect-mode-BUY_ON_MERCHANT_WEBSITE").first().isChecked(), true, "default keeps the existing referral mode");
  checks.push("registration offers exactly the three modes with Arabic labels and explanations");

  await owner.widths("connect mode choice", choice, [320, 390, 1280]);
  checks.push("the mode choice is RTL and overflow-free at 320/390/1280");

  // Keyboard: the radio group is operable without a mouse.
  await page.getByTestId("connect-mode-SELL_INSIDE_DINAR").first().focus();
  await page.keyboard.press("Space");
  assert.equal(await page.getByTestId("connect-mode-SELL_INSIDE_DINAR").first().isChecked(), true);
  checks.push("a mode is selectable by keyboard");

  await page.getByTestId("connect-register").first().click();
  const current = page.getByTestId("connect-mode-current");
  await current.waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await current.getAttribute("data-mode"), "SELL_INSIDE_DINAR");
  assert.equal(await page.getByTestId("connect-cap-native").getAttribute("data-enabled"), "false", "native checkout is never enabled by a mode");
  assert.equal(await page.getByTestId("connect-cap-internal").getAttribute("data-enabled"), "false", "chosen but not yet eligible");
  checks.push("registration stores the chosen mode; the panel shows what is and is not enabled");

  await page.reload();
  await page.getByTestId("connect-mode-current").waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await page.getByTestId("connect-mode-current").getAttribute("data-mode"), "SELL_INSIDE_DINAR");
  checks.push("the mode persists after a reload (read from the server)");

  const panel = page.getByTestId("connect-mode-panel");
  await panel.locator('[data-testid="connect-mode-HYBRID"]').check();
  await page.getByTestId("connect-mode-save").click();
  await page.getByText("حُفظ وضع المشاركة").waitFor({ timeout: 45_000 });
  assert.equal(await page.getByTestId("connect-mode-current").getAttribute("data-mode"), "HYBRID");
  await page.reload();
  await page.getByTestId("connect-mode-current").waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await page.getByTestId("connect-mode-current").getAttribute("data-mode"), "HYBRID");
  checks.push("the owner changes the mode in the panel and it persists");

  await owner.widths("connect mode panel", panel, [320, 390, 1280]);
  checks.push("the mode panel is RTL and overflow-free at 320/390/1280");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(resultPath, JSON.stringify({
    checks: [...checks, ...recorder.checks],
    failure,
    pageErrors: recorder.pageErrors,
    consoleErrors: recorder.consoleErrors,
    externalRequests: recorder.externalRequests,
    horizontalOverflow: recorder.horizontalOverflow,
  }, null, 2));
  await browser?.close().catch(() => undefined);
}
