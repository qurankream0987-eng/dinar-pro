import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} for the Wave 3 browser run.`);
  return value;
};
const webBase = env("WAVE3_WEB_BASE");
const apiOrigin = env("WAVE3_API_ORIGIN");
const reporterCookie = env("WAVE3_REPORTER_COOKIE");
const adminCookie = env("WAVE3_ADMIN_COOKIE");
const buyerCookie = env("WAVE3_BUYER_COOKIE");
const deleterCookie = env("WAVE3_DELETER_COOKIE");
const deleterPassword = env("WAVE3_DELETER_PASSWORD");
const reportListingId = env("WAVE3_REPORT_LISTING_ID");
const sponsoredTerm = env("WAVE3_SPONSORED_TERM");
const sponsoredListingId = env("WAVE3_SPONSORED_LISTING_ID");

const checks = [];
const pageErrors = [];
const contexts = [];
let browser;
let currentPage;

async function openContext(cookie, { fullRoutes = false } = {}) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 1280, height: 900 },
  });
  if (cookie) {
    const index = cookie.indexOf("=");
    await context.addCookies([
      {
        name: cookie.slice(0, index),
        value: cookie.slice(index + 1),
        domain: new URL(webBase).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
      },
    ]);
  }
  if (fullRoutes) {
    // Same isolated override as the Wave 2 XSS run: expose the frozen
    // standalone pages that the chat embeds, without changing shipped code.
    await context.route("**/src/App.tsx*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const patched = source.replace("const CHAT_ONLY_MODE = true;", "const CHAT_ONLY_MODE = false;");
      assert.notEqual(patched, source);
      await route.fulfill({ response, body: patched });
    });
  }
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const name of ["host", "origin", "referer", "content-length", "sec-fetch-site"])
      delete headers[name];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    const response = await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers });
    await route.fulfill({ response });
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  currentPage = page;
  return page;
}

async function api(page, path, init = {}) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(`/api${path}`, {
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    { path, init },
  );
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });

  // 1. Policy surfaces in the shipped chat-only routing.
  const visitor = await openContext("");
  await visitor.goto("/policies");
  await visitor.getByTestId("list-policies").waitFor({ timeout: 30_000 });
  for (const key of ["terms", "privacy", "marketplace-rules", "prohibited-items", "fees", "sponsored-listings", "disputes-refunds", "account-deletion"])
    await visitor.getByTestId(`link-policy-${key}`).waitFor();
  await visitor.getByTestId("link-policy-fees").click();
  await visitor.getByTestId("policy-fees").waitFor();
  assert.match(await visitor.getByTestId("policy-fees").innerText(), /10%/); // approved commission (PLATFORM_FEE_BASIS_POINTS = 1000)
  await visitor.getByTestId("badge-legal-review").waitFor();
  await visitor.goto("/terms");
  await visitor.getByTestId("list-policies").waitFor();
  assert.equal(new URL(visitor.url()).pathname, "/terms", "chat-only mode keeps policy routes");
  checks.push("policy surfaces navigable in chat-only mode with legal-review marker");

  // 2. Reporter files a listing report through the UI.
  const reporter = await openContext(reporterCookie, { fullRoutes: true });
  await reporter.goto(`/listings/${reportListingId}`);
  await reporter.getByTestId("button-report-listing").click();
  await reporter.getByTestId("dialog-report").waitFor();
  await reporter.getByTestId("select-report-reason").selectOption("MISLEADING_LISTING");
  await reporter.getByTestId("input-report-note").fill("الصور لا تطابق الوصف");
  await reporter.getByTestId("button-submit-report").click();
  await reporter.getByText("وصل بلاغك وسيراجعه فريق السوق.").waitFor();
  const mine = await api(reporter, "/reports/mine");
  const report = mine.body.find((row) => row.targetId === reportListingId && row.status === "OPEN");
  assert.ok(report, "browser report persisted");
  checks.push("user reports listing from the listing surface");

  // 3. Admin hides the listing from the trust & safety surface (shipped routing).
  const admin = await openContext(adminCookie);
  await admin.goto("/admin/trust-safety");
  await admin.getByTestId("page-admin-trust-safety").waitFor({ timeout: 30_000 });
  await admin.getByTestId(`admin-report-${report.id}`).waitFor();
  await admin.getByTestId(`input-report-decision-${report.id}`).fill("مراجعة الصور أثبتت التضليل");
  await admin.getByTestId(`select-report-action-${report.id}`).selectOption("HIDE_LISTING");
  await admin.getByTestId(`button-report-action-${report.id}`).click();
  await admin.getByTestId(`admin-report-${report.id}`).waitFor({ state: "detached" });
  const hidden = await api(reporter, `/listings/${reportListingId}`);
  assert.equal(hidden.status, 404, "hidden listing leaves buyer view");
  checks.push("admin hides reported listing from the admin surface");

  // 4. Sponsored results carry a visible disclosure.
  const buyer = await openContext(buyerCookie, { fullRoutes: true });
  await buyer.goto(`/search?q=${encodeURIComponent(sponsoredTerm)}`);
  const label = buyer.getByTestId(`label-sponsored-${sponsoredListingId}`);
  await label.waitFor({ timeout: 30_000 });
  assert.equal((await label.innerText()).trim(), "إعلان ممول");
  checks.push("promoted result shows the sponsored label");

  // 5. Account deletion from settings.
  const deleter = await openContext(deleterCookie, { fullRoutes: true });
  await deleter.goto("/settings");
  await deleter.getByTestId("section-delete-account").waitFor({ timeout: 30_000 });
  await deleter.getByTestId("button-delete-account").click();
  await deleter.getByTestId("input-delete-account-password").fill(deleterPassword);
  await deleter.getByTestId("button-confirm-action").click();
  await deleter.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  const me = await api(deleter, "/auth/me");
  assert.equal(me.body.user, null, "deleted account session no longer resolves");
  checks.push("user deletes account from settings and the session ends");

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  console.log(`WAVE3_UI_CHECKS ${JSON.stringify(checks)}`);
} catch (error) {
  if (currentPage && process.env.WAVE3_DEBUG_DIR) {
    await currentPage.screenshot({ path: `${process.env.WAVE3_DEBUG_DIR}/wave3-failure.png`, fullPage: true }).catch(() => {});
    console.error(`WAVE3_UI_FAILURE_URL ${currentPage.url()}`);
    console.error(`WAVE3_UI_FAILURE_TEXT ${(await currentPage.locator("body").innerText().catch(() => "")).slice(0, 1500)}`);
  }
  throw error;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
}
