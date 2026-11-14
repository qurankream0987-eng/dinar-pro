/**
 * Welcome-screen sponsored cards in real Chromium (production build, disposable DB, scripted model):
 * visible on a new empty conversation, at most two, labelled «إعلان ممول», never pushing the composer
 * out of view; typing does not dismiss them; the first sent message removes them for good (refresh
 * and reopening never bring them back); dismissal works; reduced motion is honoured.
 * DINAR_UI_SHOTS_DIR saves screenshots.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const here = path.dirname(fileURLToPath(import.meta.url.replace("/.test-build/", "/test/")));
const dist = path.resolve(here, "../../dinar/dist/public");
assert.ok(existsSync(path.join(dist, "index.html")), "build the web app first");
process.env.DINAR_WEB_DIST = dist;
const { default: app } = await import("../src/app");
const { db, pool, users } = await import("@workspace/db");
const { appendCommercialPolicy } = await import("../src/lib/commercial-policy-append");
app.locals.conversationModelGateway = {
  providerInfo: { provider: "OPENAI_COMPATIBLE", requestedModel: "fx/welcome" },
  async proposeToolCall() {
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "أهلًا! كيف أساعدك؟" }), usage: { inputTokens: 10, outputTokens: 5 } };
  },
};
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const shots = process.env.DINAR_UI_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const results: Record<string, unknown>[] = [];

let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(`${origin}/api${p}`, { method, headers: { "content-type": "application/json", origin, "X-Forwarded-For": `198.20.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
const phoneBase = 51_560_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(name: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Wl-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: name, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id as string, cookie: c.cookie };
}

const run = randomUUID().slice(0, 5);
const admin = await account("مشرف");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
await appendCommercialPolicy({ marketId: "JO", policy: { advertisingProducts: ["SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE", "SPONSORED_SEARCH"], welcomeSponsoredSlots: 2, welcomeSponsoredDailyConversations: 20 }, actorId: null });
const product = await request("/admin/markets/JO/commercial-products", "POST", { name: `إعلان داخل المحادثة ${run}`, productType: "SPONSORED_RECOMMENDATION", categoryId: "electronics", priceMinor: 3_550, durationDays: 7, chargingMode: "FIXED" }, admin.cookie);
assert.equal(product.status, 201, product.raw);
for (const [name, title, price] of [["متجر النور", `سماعة لاسلكية ممتازة ${run}`, "45"], ["بيت التقنية", `ساعة ذكية رياضية ${run}`, "89"], ["متجر ثالث", `شاحن سريع ${run}`, "12"]] as const) {
  const seller = await account(name);
  const listing = await request("/listings", "POST", { title, description: `${title} — أصلية مع الضمان`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان", attributes: { condition: "جديد" }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 3, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"] }, seller.cookie);
  assert.equal(listing.status, 201, listing.raw);
  const topup = await request("/commercial/topups", "POST", { amountMajor: 20, idempotencyKey: `top-${randomUUID()}` }, seller.cookie);
  await request(`/commercial/topups/${topup.data.id ?? topup.data.topup?.id}/simulate-capture`, "POST", {}, seller.cookie);
  const bought = await request("/commercial/purchases", "POST", { productId: product.data.id, listingId: listing.data.id, idempotencyKey: `buy-${randomUUID()}` }, seller.cookie);
  assert.ok([200, 201].includes(bought.status), bought.raw);
}

const { chromium } = await import(pathToFileURL(path.resolve(here, "../../dinar/node_modules/@playwright/test/index.mjs")).href);
const chromiumPath = process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});

async function open(cookie: string, width: number, height: number, mobile: boolean, options: { reducedMotion?: boolean; theme?: string } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, locale: "ar", deviceScaleFactor: 2, reducedMotion: options.reducedMotion ? "reduce" : "no-preference" });
  await context.addInitScript((value: string) => { try { localStorage.setItem("dinar-theme", value); } catch {} }, options.theme ?? "light");
  const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e: any) => errors.push(String(e)));
  await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
  await page.goto(`${origin}/ai`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="input-ai-composer"]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(700);
  return { context, page, errors };
}
const measure = (page: any) => page.evaluate(() => {
  const composer = document.querySelector('[data-testid="input-ai-composer"]')?.getBoundingClientRect();
  const send = document.querySelector('[data-testid="button-send-ai-message"]')?.getBoundingClientRect();
  return {
    cards: document.querySelectorAll('[data-testid="welcome-sponsored-card"]').length,
    sectionVisible: (() => { const el = document.querySelector('[data-testid="welcome-sponsored"]') as HTMLElement | null; return Boolean(el && el.offsetParent !== null); })(),
    labels: [...document.querySelectorAll('[data-testid="welcome-sponsored-label"]')].map((e) => e.textContent),
    starters: document.querySelectorAll('[data-testid^="button-prompt-"]').length,
    // Every starter fully on screen and above the composer: the sponsored row must never clip them.
    startersDisplayed: [...document.querySelectorAll('[data-testid^="button-prompt-"]')].filter((el) => (el as HTMLElement).offsetParent !== null).length,
    startersHidden: [...document.querySelectorAll('[data-testid^="button-prompt-"]')].filter((el) => (el as HTMLElement).offsetParent !== null).filter((el) => {
      const r = el.getBoundingClientRect();
      return !(r.top >= 0 && r.bottom <= (composer?.top ?? window.innerHeight) + 1 && r.width > 0);
    }).length,
    // The sponsored row sits after the starters, never between the starters and the assistant.
    adsAfterStarters: (() => {
      const ad = document.querySelector('[data-testid="welcome-sponsored"]');
      const last = [...document.querySelectorAll('[data-testid^="button-prompt-"]')].pop();
      return !ad || !last || Boolean(last.compareDocumentPosition(ad) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
    composerVisible: Boolean(composer && composer.top >= 0 && send && send.bottom <= window.innerHeight + 1),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    pageOverflowY: document.documentElement.scrollHeight - window.innerHeight,
  };
});

const VIEWPORTS: [number, number, boolean][] = [[320, 568, true], [390, 844, true], [430, 932, true], [768, 1024, true], [1280, 600, false], [1366, 768, false], [1440, 900, false]];

test("WS-B1 every required viewport: ≤2 labelled cards when there is room, composer visible, six starters, no overflow", async () => {
  const buyer = await account("مشتري");
  for (const [width, height, mobile] of VIEWPORTS) {
    const { context, page, errors } = await open(buyer.cookie, width, height, mobile);
    const m = await measure(page);
    results.push({ step: "welcome", width, height, ...m, consoleErrors: errors.length });
    if (shots) await page.screenshot({ path: path.join(shots, `welcome-${width}x${height}.png`) });
    assert.ok(m.cards <= 2, `${width}x${height}: at most two cards`);
    if (height > 620) {
      assert.ok(m.sectionVisible && m.cards >= 1, `${width}x${height}: sponsored section shown (${JSON.stringify(m)})`);
      assert.ok(m.labels.every((label: string | null) => label === "إعلان ممول"));
    } else assert.equal(m.sectionVisible, false, `${width}x${height}: short screens keep the composer, not the ads`);
    assert.equal(m.composerVisible, true, `${width}x${height}: composer visible`);
    assert.equal(m.starters, 6, `${width}x${height}: six starter chips`);
    // Short screens (≤620 px) already hide the starters by design; elsewhere all six must show.
    if (height > 620) assert.equal(m.startersDisplayed, 6, `${width}x${height}: six starters displayed`);
    assert.equal(m.startersHidden, 0, `${width}x${height}: every starter fully visible above the composer (${JSON.stringify(m)})`);
    assert.equal(m.adsAfterStarters, true, `${width}x${height}: sponsored row after the starters`);
    assert.ok(m.overflowX <= 1, `${width}x${height}: no horizontal overflow`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test("WS-B2 typing keeps the cards; the first message removes them; refresh and reopening never bring them back", async () => {
  const buyer = await account("مشتري ثانٍ");
  const { context, page } = await open(buyer.cookie, 390, 844, true);
  const before = await measure(page);
  assert.ok(before.cards >= 1);
  const shown = await page.locator('[data-testid="welcome-sponsored-card"]').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("data-listing-id")));
  await page.locator('[data-testid="input-ai-composer"]').fill("أبحث عن سماعة");
  await page.waitForTimeout(800);
  const typing = await page.locator('[data-testid="welcome-sponsored-card"]').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("data-listing-id")));
  assert.deepEqual(typing, shown, "typing neither dismisses nor rotates the cards");
  if (shots) await page.screenshot({ path: path.join(shots, "welcome-before-first-message-390.png") });
  await page.locator('[data-testid="button-send-ai-message"]').click();
  await page.getByText("أهلًا! كيف أساعدك؟").first().waitFor({ timeout: 25_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const afterSend = await measure(page);
  if (shots) await page.screenshot({ path: path.join(shots, "welcome-after-first-message-390.png") });
  assert.equal(afterSend.cards, 0, "gone after the first message");
  assert.equal(afterSend.composerVisible, true);
  const transcript = await page.locator('[role="log"]').innerText().catch(() => "");
  assert.doesNotMatch(transcript, /إعلان ممول/u, "never injected into the transcript");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  assert.equal((await measure(page)).cards, 0, "a refresh of the started conversation does not resurface them");
  await context.close();
  const reopened = await open(buyer.cookie, 1366, 768, false);
  const list = await request("/ai/conversations", "GET", undefined, buyer.cookie);
  const existing = (list.data?.conversations ?? list.data ?? [])[0]?.id;
  if (existing) {
    await reopened.page.goto(`${origin}/ai?c=${existing}`, { waitUntil: "networkidle" });
    await reopened.page.waitForTimeout(600);
  }
  results.push({ step: "reopen", ...(await measure(reopened.page)) });
  await reopened.context.close();
});

test("WS-B3 dismissal, dark mode and reduced motion", async () => {
  const buyer = await account("مشتري ثالث");
  const { context, page } = await open(buyer.cookie, 1440, 900, false, { reducedMotion: true, theme: "dark" });
  assert.ok((await measure(page)).cards >= 1);
  if (shots) await page.screenshot({ path: path.join(shots, "welcome-dark-1440.png") });
  const animated = await page.evaluate(() => getComputedStyle(document.querySelector(".ai-welcome") as Element).animationDuration);
  results.push({ step: "reduced-motion", animated });
  await page.locator('[data-testid="welcome-sponsored-dismiss"]').click();
  await page.waitForTimeout(400);
  assert.equal((await measure(page)).cards, 0);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  assert.equal((await measure(page)).cards, 0, "a dismissed screen stays dismissed after refresh");
  await context.close();
});

after(async () => {
  if (shots) writeFileSync(path.join(shots, "welcome-metrics.json"), JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
  await pool.end();
});
