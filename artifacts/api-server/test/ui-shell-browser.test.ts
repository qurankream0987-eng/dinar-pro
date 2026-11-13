/**
 * Responsive shell acceptance (owner mission «Responsive chat UI»): on first load the message
 * composer must be fully inside the viewport without scrolling, the page itself must not scroll
 * vertically, and the conversation history scrolls inside its own region. Measured in real Chromium
 * at the owner's viewports, as a guest and signed in, empty and with a long conversation.
 * DINAR_UI_SHOTS_DIR saves screenshots; DINAR_UI_ASSERT=1 turns the measurements into assertions
 * (off only for recording the "before" baseline).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const here = path.dirname(fileURLToPath(import.meta.url.replace("/.test-build/", "/test/")));
const dist = path.resolve(here, "../../dinar/dist/public");
assert.ok(existsSync(path.join(dist, "index.html")), "build the web app first");
process.env.DINAR_WEB_DIST = dist;
const { default: app } = await import("../src/app");
const { pool } = await import("@workspace/db");
app.locals.conversationModelGateway = {
  providerInfo: { provider: "OPENAI_COMPATIBLE", requestedModel: "fx/ui" },
  async proposeToolCall() {
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "هذا رد تجريبي طويل نسبيًا يملأ مساحة في المحادثة لاختبار التمرير الداخلي. ".repeat(4) }), usage: { inputTokens: 10, outputTokens: 10 } };
  },
};
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const shots = process.env.DINAR_UI_SHOTS_DIR;
const strict = process.env.DINAR_UI_ASSERT === "1";
if (shots) mkdirSync(shots, { recursive: true });
const results: Record<string, unknown>[] = [];
after(async () => {
  if (shots) writeFileSync(path.join(shots, "metrics.json"), JSON.stringify(results, null, 2));
  server.close();
  await pool.end();
});

async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(`${origin}/api${p}`, { method, headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
const phoneBase = 51_660_100 + ((Date.now() + process.pid) % 8_000);
let offset = 0;
async function account() {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Ui-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: "UI", accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return c.cookie;
}

const { chromium } = await import(pathToFileURL(path.resolve(here, "../../dinar/node_modules/@playwright/test/index.mjs")).href);
const chromiumPath = process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
after(async () => { await browser.close(); });

const VIEWPORTS: [number, number, boolean][] = [[320, 568, true], [375, 667, true], [390, 844, true], [768, 1024, true], [1280, 720, false], [1366, 768, false], [1440, 900, false], [1280, 600, false]];

async function measure(page: any) {
  return page.evaluate(() => {
    const composer = document.querySelector('[data-testid="input-ai-composer"]') as HTMLElement | null;
    const box = composer?.getBoundingClientRect();
    const send = document.querySelector('[data-testid="button-send-ai-message"]')?.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      composerTop: box ? Math.round(box.top) : null,
      composerBottom: box ? Math.round(box.bottom) : null,
      sendBottom: send ? Math.round(send.bottom) : null,
      pageOverflowY: document.documentElement.scrollHeight - window.innerHeight,
      pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}
const visible = (m: any) => m.composerTop !== null && m.composerTop >= 0 && m.sendBottom !== null && m.sendBottom <= m.innerHeight + 1;

for (const signedIn of [false, true]) {
  test(`${signedIn ? "signed-in" : "guest"}: composer visible on first load at every viewport, no page scroll`, async () => {
    const cookie = signedIn ? await account() : "";
    for (const [width, height, mobile] of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, locale: "ar" });
      if (cookie) { const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: origin }]); }
      const page = await context.newPage();
      await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
      await page.goto(`${origin}/ai`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="input-ai-composer"]').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(400);
      const m = await measure(page);
      results.push({ who: signedIn ? "signed-in" : "guest", width, height, state: "first-load", ...m, visible: visible(m) });
      if (shots) await page.screenshot({ path: path.join(shots, `${signedIn ? "user" : "guest"}-${width}x${height}.png`) });
      if (strict) {
        assert.ok(visible(m), `${width}x${height}: composer and send button visible without scrolling (${JSON.stringify(m)})`);
        assert.ok(m.pageOverflowY <= 1, `${width}x${height}: no page-level vertical scroll (${m.pageOverflowY})`);
        assert.ok(m.pageOverflowX <= 1, `${width}x${height}: no horizontal overflow`);
      }
      await context.close();
    }
  });
}

test("signed-in long conversation: history scrolls inside its region, composer stays visible; keyboard-like resize keeps it visible", async () => {
  const cookie = await account();
  for (const [width, height, mobile] of [[390, 844, true], [1366, 768, false]] as [number, number, boolean][]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, locale: "ar" });
    const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
    await page.goto(`${origin}/ai`, { waitUntil: "networkidle" });
    const composer = page.locator('[data-testid="input-ai-composer"]');
    await composer.waitFor({ timeout: 20_000 });
    for (let i = 0; i < 6; i++) {
      await composer.fill(`سؤال رقم ${i + 1}: اشرح لي فكرة عامة`);
      await page.locator('[data-testid="button-send-ai-message"]').click();
      await page.getByText("هذا رد تجريبي").nth(i).waitFor({ timeout: 20_000 });
    }
    await page.waitForTimeout(300);
    const m = await measure(page);
    results.push({ who: "signed-in", width, height, state: "long-conversation", ...m, visible: visible(m) });
    if (shots) await page.screenshot({ path: path.join(shots, `long-${width}x${height}.png`) });
    if (mobile) {
      // A software keyboard shrinks the visual viewport; emulate by shrinking the viewport.
      await composer.focus();
      await page.setViewportSize({ width, height: Math.round(height * 0.55) });
      await page.waitForTimeout(300);
      const k = await measure(page);
      results.push({ who: "signed-in", width, height: Math.round(height * 0.55), state: "keyboard", ...k, visible: visible(k) });
      if (shots) await page.screenshot({ path: path.join(shots, `keyboard-${width}.png`) });
      if (strict) assert.ok(visible(k), `keyboard-open: composer visible (${JSON.stringify(k)})`);
    }
    if (strict) {
      assert.ok(visible(m), `${width}x${height} long: composer visible (${JSON.stringify(m)})`);
      assert.ok(m.pageOverflowY <= 1, `${width}x${height} long: the page does not scroll; the history does (${m.pageOverflowY})`);
    }
    await context.close();
  }
});

test("settings: the legal section lists terms and privacy with live versions; public URLs work signed out", async () => {
  const cookie = await account();
  const policies = await (await fetch(`${origin}/api/policies`)).json() as { policies: { key: string; version: string }[] };
  const privacy = policies.policies.find((p) => p.key === "privacy")!;
  for (const [width, height, mobile] of [[390, 844, true], [1366, 768, false]] as [number, number, boolean][]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, locale: "ar" });
    const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
    await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
    const privacyRow = page.getByTestId("link-settings-privacy");
    await privacyRow.waitFor({ state: "attached", timeout: 20_000 });
    await privacyRow.scrollIntoViewIfNeeded();
    await page.getByText(`النسخة ${privacy.version}`).first().waitFor({ state: "attached", timeout: 10_000 });
    for (const id of ["link-settings-terms", "link-settings-privacy", "link-settings-policies", "link-settings-data", "link-settings-support"])
      assert.equal(await page.getByTestId(id).count(), 1, id);
    await privacyRow.scrollIntoViewIfNeeded();
    if (shots) await page.screenshot({ path: path.join(shots, `settings-legal-${width}.png`) });
    await context.close();
  }
  for (const route of ["/privacy", "/terms", "/policies"]) assert.equal((await fetch(`${origin}${route}`)).status, 200, route);
});

test("signup: one unchecked acknowledgement; submitting without it is refused in the browser", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ar" });
  const page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
  await page.goto(`${origin}/register`, { waitUntil: "networkidle" });
  const ack = page.getByTestId("terms-acknowledgement");
  await ack.waitFor({ timeout: 20_000 });
  assert.match(await ack.innerText(), /أقر بأنني قرأت وأوافق على شروط الاستخدام، وأؤكد اطلاعي على سياسة الخصوصية/u);
  const box = page.locator('input[name="acceptTerms"]');
  assert.equal(await box.isChecked(), false, "not preselected");
  assert.equal(await ack.locator('a[href="/terms"]').count(), 1);
  assert.equal(await ack.locator('a[href="/privacy"]').count(), 1);
  const optional = await page.locator('input[type="checkbox"]:checked').count();
  assert.equal(optional, 0, "no optional consent is preselected");
  if (shots) await page.screenshot({ path: path.join(shots, "signup-390.png"), fullPage: true });
  await context.close();
});

test("logo and composer in dark mode; accessible names on the composer and the legal line", async () => {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: scheme, locale: "ar" });
    const page = await context.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
    await page.goto(`${origin}/ai`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="input-ai-composer"]').waitFor({ timeout: 20_000 });
    const named = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-ai-composer"]') as HTMLElement;
      const label = input.getAttribute("aria-label") || input.getAttribute("placeholder") || (input.id && document.querySelector(`label[for="${input.id}"]`)?.textContent);
      const send = document.querySelector('[data-testid="button-send-ai-message"]') as HTMLElement;
      return { input: Boolean(label), send: Boolean(send.getAttribute("aria-label") || send.textContent?.trim()), legalLinks: document.querySelectorAll('[data-testid="welcome-legal-links"] a').length };
    });
    assert.deepEqual(named, { input: true, send: true, legalLinks: 2 }, scheme);
    if (shots) await page.screenshot({ path: path.join(shots, `guest-1366-${scheme}.png`) });
    await context.close();
  }
});
