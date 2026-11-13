/**
 * Google OAuth branding readiness: the home page, the privacy policy and the terms are public,
 * readable without JavaScript, linked to each other, and the existing sign-in routes are unchanged.
 * Real app + built web app (DINAR_WEB_DIST) + disposable loopback database; real Chromium for the
 * rendered pages. This does not prove the public DNS/HTTPS of jassimai.com (see the report).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const here = path.dirname(fileURLToPath(import.meta.url.replace("/.test-build/", "/test/")));
const dist = path.resolve(here, "../../dinar/dist/public");
assert.ok(existsSync(path.join(dist, "index.html")), "build the web app first (pnpm --filter @workspace/dinar run build)");
process.env.DINAR_WEB_DIST = dist;
const { default: app } = await import("../src/app");
const { pool } = await import("@workspace/db");
const { currentPolicy } = await import("../src/lib/policies");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => { server.close(); await pool.end(); });

const get = async (pathname: string) => {
  const response = await fetch(`${origin}${pathname}`, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), html: await response.text() };
};
const SECRET = /(?:sk-[A-Za-z0-9]{10}|GOOGLE_CLIENT_SECRET|DATABASE_URL|postgres:\/\/|BEGIN PRIVATE KEY|AIza[0-9A-Za-z_-]{20})/u;

test("G1-G5 home, privacy and terms answer 200 without login and carry their text without JavaScript", async () => {
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.equal(home.location, null, "no redirect to an authenticated page");
  assert.match(home.html, /<title>JassimAI — جاسم، مساعدك الذكي<\/title>/u);
  assert.match(home.html, /جاسم مساعد ذكي بالعربية/u);
  for (const link of ['href="/privacy"', 'href="/terms"', 'href="/login"']) assert.ok(home.html.includes(link), link);
  assert.match(home.html, /لا يجمع JassimAI المدفوعات/u, "no claim of active payments");
  assert.doesNotMatch(home.html, /Shopify|اشتراك مدفوع/u, "no claim of inactive integrations");

  const privacy = await get("/privacy");
  assert.equal(privacy.status, 200);
  const policy = currentPolicy("privacy")!;
  assert.equal(policy.version, "2026-11-13");
  assert.match(privacy.html, /سياسة الخصوصية — JassimAI/u);
  assert.match(privacy.html, /تسجيل الدخول بحساب Google/u);
  assert.match(privacy.html, /لا نرسل بريدك أو معرّفك في Google إلى مزودي نماذج الذكاء الاصطناعي/u);
  assert.match(privacy.html, /محادثات الذكاء الاصطناعي/u);
  assert.match(privacy.html, /href="\/terms"/u);

  const terms = await get("/terms");
  assert.equal(terms.status, 200);
  assert.match(terms.html, new RegExp(currentPolicy("terms")!.titleAr, "u"));
  assert.match(terms.html, /href="\/privacy"/u);

  for (const page of [home, privacy, terms]) assert.doesNotMatch(page.html, SECRET, "no secret in public HTML");
});

test("G6/G15 the published policy API and the sign-in routes are unchanged", async () => {
  const policies = await fetch(`${origin}/api/policies`);
  assert.equal(policies.status, 200);
  const privacy = await (await fetch(`${origin}/api/policies/privacy`)).json() as { version: string };
  assert.equal(privacy.version, "2026-11-13", "the app shows the same version as the public page");
  const old = await fetch(`${origin}/api/policies/privacy`);
  assert.equal(old.status, 200);
  for (const pathname of ["/login", "/register", "/policies", "/policies/privacy"]) {
    const page = await get(pathname);
    assert.equal(page.status, 200, pathname);
    assert.match(page.html, /<div id="root"><\/div>/u, `${pathname} is the unchanged app shell`);
  }
  // Google sign-in endpoint stays the existing identity-token route; without a client id it refuses honestly.
  const google = await fetch(`${origin}/api/auth/google`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ idToken: "x".repeat(30) }) });
  assert.ok([400, 401, 403, 503].includes(google.status), `status ${google.status}`);
  const missing = await get("/assets/does-not-exist.js");
  assert.equal(missing.status, 404, "a missing asset is not the app");
});

test("G7-G12 browser: links on the home page, policy pages render, RTL, no horizontal overflow at 320/390/1440", async () => {
  const chromiumPath = process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  // The web app's Playwright, loaded at run time (as other browser suites do).
  const { pathToFileURL } = await import("node:url");
  const { chromium } = await import(pathToFileURL(path.resolve(here, "../../dinar/node_modules/@playwright/test/index.mjs")).href);
  const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route) => route.fulfill({ status: 200, body: "" }));
      await page.goto(`${origin}/`, { waitUntil: "networkidle" });
      const legal = page.locator("[data-testid=welcome-legal-links]");
      await legal.waitFor({ timeout: 15_000 });
      assert.equal(await legal.locator('a[href="/privacy"]').count(), 1, `${width}: privacy link on the home page`);
      assert.equal(await legal.locator('a[href="/terms"]').count(), 1, `${width}: terms link on the home page`);
      assert.equal(await page.evaluate(() => document.documentElement.dir), "rtl");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${width}: no horizontal overflow`);
      await legal.locator('a[href="/privacy"]').click();
      await page.waitForURL(`${origin}/privacy`);
      await page.getByRole("heading", { name: /سياسة الخصوصية — JassimAI/u }).waitFor({ timeout: 15_000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${width}: privacy has no horizontal overflow`);
      await page.goto(`${origin}/terms`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: new RegExp(currentPolicy("terms")!.titleAr, "u") }).waitFor({ timeout: 15_000 });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("SEO robots.txt and sitemap.xml: only the canonical host is indexable, and only its public pages", async () => {
  const as = async (pathname: string, host: string) => {
    const response = await fetch(`${origin}${pathname}`, { headers: { "x-forwarded-host": host } });
    return { status: response.status, type: response.headers.get("content-type") ?? "", text: await response.text() };
  };
  const robots = await as("/robots.txt", "jassimai.com");
  assert.equal(robots.status, 200);
  assert.match(robots.type, /text\/plain/u);
  for (const line of ["Allow: /$", "Allow: /privacy$", "Allow: /terms$", "Allow: /assets/", "Disallow: /", "Sitemap: https://jassimai.com/sitemap.xml"]) assert.ok(robots.text.includes(line), line);
  const sitemap = await as("/sitemap.xml", "jassimai.com");
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.type, /application\/xml/u);
  const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]);
  assert.deepEqual(locs, ["https://jassimai.com/", "https://jassimai.com/privacy", "https://jassimai.com/terms", "https://jassimai.com/policies"]);
  assert.doesNotMatch(sitemap.text, /listings|business|account|\/api/u, "no test data or private page is listed");
  // Staging and the Railway default domain never compete with the real site.
  for (const host of ["staging.jassimai.com", "dinar-staging-app-staging.up.railway.app"]) {
    const blocked = await as("/robots.txt", host);
    assert.equal(blocked.text, "User-agent: *\nDisallow: /\n", host);
    assert.equal((await as("/sitemap.xml", host)).status, 404, host);
  }
});
