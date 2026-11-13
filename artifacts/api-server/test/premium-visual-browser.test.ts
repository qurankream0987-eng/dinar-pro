/**
 * Premium visual tour: the real app in real Chromium, every main surface at phone and desktop size,
 * light and dark. DINAR_UI_SHOTS_DIR saves screenshots (before/after evidence); DINAR_UI_ASSERT=1
 * asserts no horizontal overflow, a visible composer and no console errors on every step.
 * Scripted model gateway (no provider); disposable database; nothing leaves the machine.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const here = path.dirname(fileURLToPath(import.meta.url.replace("/.test-build/", "/test/")));
const dist = path.resolve(here, "../../dinar/dist/public");
assert.ok(existsSync(path.join(dist, "index.html")), "build the web app first");
process.env.DINAR_WEB_DIST = dist;
const { default: app } = await import("../src/app");
const { pool } = await import("@workspace/db");
app.locals.conversationModelGateway = {
  providerInfo: { provider: "OPENAI_COMPATIBLE", requestedModel: "fx/tour" },
  async proposeToolCall(messages: any[]) {
    const last = String(messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
    const illustration = /مثال/u.test(last)
      ? { illustration: { title: "تويوتا كامري 2020", subtitle: "سيدان عائلية بحالة ممتازة", fields: [{ label: "الممشى", value: "80 ألف كم" }, { label: "ناقل الحركة", value: "أوتوماتيك" }, { label: "السعر", value: "9,000 دينار" }], body: "هكذا يمكن أن تبدو بطاقة إعلان سيارة: صورة كبيرة، عنوان واضح، ثم أهم المواصفات." } }
      : {};
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: /مثال/u.test(last) ? "هذا مثال توضيحي لشكل البطاقة." : "أهلًا! أنا جاسم، أساعدك في البحث والبيع والأسئلة العامة. هذا رد تجريبي لاختبار الواجهة.", ...illustration }), usage: { inputTokens: 100, outputTokens: 20 } };
  },
};
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const shots = process.env.DINAR_UI_SHOTS_DIR;
const strict = process.env.DINAR_UI_ASSERT === "1";
if (shots) mkdirSync(shots, { recursive: true });
const results: Record<string, unknown>[] = [];

let ipn = Math.floor(Math.random() * 20_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(`${origin}/api${p}`, { method, headers: { "content-type": "application/json", origin, "X-Forwarded-For": `198.18.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
const phoneBase = 51_667_100 + ((Date.now() + process.pid) % 2_000);
let offset = 0;
async function account(name: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Tour-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: name, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return c.cookie;
}
const run = randomUUID().slice(0, 5);
const sellerCookie = await account("متجر سارة");
for (const [title, price, condition] of [[`سماعة سوني لاسلكية ${run}`, "85", "جديد"], [`سماعة جي بي ال رياضية ${run}`, "42", "مستعمل"], [`سماعة أبل إيربودز برو ${run}`, "160", "جديد"]] as const) {
  const created = await request("/listings", "POST", { title, description: `${title} — أصلية مع الضمان والعلبة`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان", attributes: { condition }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 3, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"] }, sellerCookie);
  assert.equal(created.status, 201, created.raw);
}

const { chromium } = await import(pathToFileURL(path.resolve(here, "../../dinar/node_modules/@playwright/test/index.mjs")).href);
const chromiumPath = process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});

const VIEWS: { name: string; width: number; height: number; mobile: boolean }[] = [
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1280, height: 720, mobile: false },
];
const THEMES = ["light", "dark"] as const;

async function open(view: (typeof VIEWS)[number], theme: string, cookie = "") {
  const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, isMobile: view.mobile, hasTouch: view.mobile, locale: "ar", deviceScaleFactor: 2 });
  await context.addInitScript((value: string) => { try { localStorage.setItem("dinar-theme", value); } catch {} }, theme);
  if (cookie) { const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: origin }]); }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error: any) => errors.push(String(error)));
  await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
  return { context, page, errors };
}
async function shoot(page: any, errors: string[], label: string, needsComposer = true) {
  await page.waitForTimeout(450);
  const m = await page.evaluate(() => {
    const composer = document.querySelector('[data-testid="input-ai-composer"]')?.getBoundingClientRect();
    return { overflowX: document.documentElement.scrollWidth - window.innerWidth, composerVisible: composer ? composer.top >= 0 && composer.bottom <= window.innerHeight + 1 : null };
  });
  results.push({ label, ...m, consoleErrors: errors.length });
  if (shots) await page.screenshot({ path: path.join(shots, `${label}.png`) });
  if (strict) {
    assert.ok(m.overflowX <= 1, `${label}: no horizontal overflow (${m.overflowX})`);
    if (needsComposer) assert.equal(m.composerVisible, true, `${label}: composer visible`);
    assert.deepEqual(errors, [], `${label}: no console errors`);
  }
}
const baseline = process.env.DINAR_TOUR_BASELINE === "1";
async function send(page: any, text: string, waitFor: string) {
  const composer = page.locator('[data-testid="input-ai-composer"]');
  await composer.fill(text);
  await page.locator('[data-testid="button-send-ai-message"]').click();
  // The "before" build lacks the new cards: wait for the reply instead and record what it shows.
  if (baseline) await page.waitForTimeout(3_500);
  else await page.locator(waitFor).last().waitFor({ timeout: 25_000 }).catch(async (error: unknown) => {
    if (shots) await page.screenshot({ path: path.join(shots, `FAIL-${text.slice(0, 24).replace(/\s+/gu, "_")}.png`) });
    throw error;
  });
}

for (const view of VIEWS) for (const theme of THEMES) {
  test(`${view.name}-${theme}: guest, auth, buyer, seller, plans, illustrative card, settings`, async () => {
    const tag = `${view.name}-${theme}`;
    {
      const { context, page, errors } = await open(view, theme);
      await page.goto(`${origin}/ai`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="input-ai-composer"]').waitFor({ timeout: 20_000 });
      await shoot(page, errors, `${tag}-01-welcome-guest`);
      await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
      await shoot(page, errors, `${tag}-02-login`, false);
      await page.goto(`${origin}/register`, { waitUntil: "networkidle" });
      await shoot(page, errors, `${tag}-03-register`, false);
      await context.close();
    }
    const buyer = await account("أحمد");
    {
      const { context, page, errors } = await open(view, theme, buyer);
      await page.goto(`${origin}/ai`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="input-ai-composer"]').waitFor({ timeout: 20_000 });
      await shoot(page, errors, `${tag}-04-welcome-user`);
      await send(page, `جاسم أبي سماعة ${run}`, '[data-testid^="card-ai-result-"]');
      await shoot(page, errors, `${tag}-05-results`);
      await send(page, "كبر الصورة", '[data-image="LARGE"]');
      await shoot(page, errors, `${tag}-06-results-large`);
      await send(page, "اعرضهم بجدول", "table");
      await shoot(page, errors, `${tag}-07-table`);
      await send(page, "ضيف الثاني للسلة", '[data-testid*="cart"]');
      await shoot(page, errors, `${tag}-08-cart-turn`);
      await send(page, "اعرض الباقات", '[data-testid]');
      await page.waitForTimeout(600);
      await shoot(page, errors, `${tag}-09-plans`);
      await send(page, "ورني مثال لبطاقة إعلان سيارة كيف ممكن تكون", '[data-testid="illustrative-label"]');
      await shoot(page, errors, `${tag}-10-illustrative`);
      await page.goto(`${origin}/cart`, { waitUntil: "networkidle" });
      await shoot(page, errors, `${tag}-11-cart-page`, false);
      await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
      await shoot(page, errors, `${tag}-12-settings`, false);
      await context.close();
    }
    {
      const seller = await account("بائع");
      const { context, page, errors } = await open(view, theme, seller);
      await page.goto(`${origin}/ai`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="input-ai-composer"]').waitFor({ timeout: 20_000 });
      await send(page, "جاسم أبي أبيع آيفون 13 برو مستعمل بسعر 300 دينار", '[data-testid="draft-review"]');
      await shoot(page, errors, `${tag}-13-draft`);
      await send(page, "كبر الصورة", '[data-testid="draft-review"][data-image="LARGE"]');
      await shoot(page, errors, `${tag}-14-draft-large`);
      if (!baseline) await page.locator('[data-testid="draft-preview-toggle"]').last().click();
      await shoot(page, errors, `${tag}-15-draft-preview`);
      await context.close();
    }
  });
}

after(async () => {
  if (shots) writeFileSync(path.join(shots, "metrics.json"), JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
  await pool.end();
});
