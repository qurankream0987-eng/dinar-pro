// DINAR NEXT universal conversational control — browser acceptance, driven by
// api-server/test/universal-control-acceptance.test.ts. Every step is typed into the real
// composer or clicked/pressed in the production build, signed in, against the real API and a
// disposable database.
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const webBase = process.env.UCC_WEB_BASE;
const apiOrigin = process.env.UCC_API_ORIGIN;
const cookies = JSON.parse(process.env.UCC_COOKIES ?? "{}");
const users = JSON.parse(process.env.UCC_USERS ?? "{}");
const conversations = JSON.parse(process.env.UCC_CONVERSATIONS ?? "{}");
const out = process.env.UCC_OUT;
const resultPath = process.env.UCC_RESULT;
if (!webBase || !apiOrigin || !out || !resultPath) throw new Error("Missing UCC browser configuration.");

const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1024, 1280, 1440, 1600];
const report = { journeys: {}, summary: {} };
const failed = [];
const consoleErrors = [];

async function newContext(browser, actor, width, colorScheme = "light") {
  const mobile = width < 768;
  const context = await browser.newContext({ baseURL: webBase, viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, locale: "ar", reducedMotion: "reduce", colorScheme });
  const cookie = cookies[actor];
  const separator = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: new URL(webBase).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]);
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const headers = { ...route.request().headers(), origin: apiOrigin, referer: `${apiOrigin}/` };
    try {
      await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
    } catch {
      await route.abort();
    }
  });
  return context;
}
async function openPage(context, actor, conversationId, market = "JO") {
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${actor}: ${message.text().slice(0, 200)}`); });
  page.on("pageerror", (error) => consoleErrors.push(`${actor}: ${String(error).slice(0, 200)}`));
  await page.addInitScript(([key, id]) => { try { localStorage.setItem(key, id); } catch {} }, [`dinar-conversation:${users[actor]}:${market}`, conversationId]);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 30_000 });
  currentPage = page;
  return page;
}

const assistants = (page) => page.locator('[data-testid^="message-assistant-"]');
/** Waits for a new newest assistant message (the thread shows a bounded window, so counts plateau). */
async function settle(page, before) {
  await page.waitForFunction(
    (previous) => {
      const all = document.querySelectorAll('[data-testid^="message-assistant-"]');
      const last = all[all.length - 1]?.getAttribute("data-testid");
      return last && last !== previous && !last.includes("local-") &&
        document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة";
    },
    before,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(250);
  const latest = assistants(page).last();
  return { locator: latest, text: (await latest.innerText()).replace(/\s+/g, " ") };
}
const lastAssistant = (page) => page.evaluate(() => { const all = document.querySelectorAll('[data-testid^="message-assistant-"]'); return all[all.length - 1]?.getAttribute("data-testid") ?? ""; });
async function send(page, text) {
  const before = await lastAssistant(page);
  for (let attempt = 0; ; attempt += 1) {
    await page.getByTestId("input-ai-composer").fill(text);
    try {
      await page.waitForSelector('[data-testid="button-send-ai-message"]:not([disabled])', { timeout: 5_000 });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  await page.getByTestId("button-send-ai-message").click();
  return settle(page, before);
}
const isDark = (page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
async function layout(page, label) {
  const facts = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    rtl: getComputedStyle(document.body).direction === "rtl" || document.documentElement.dir === "rtl",
    composerVisible: Boolean(document.querySelector('[data-testid="input-ai-composer"]')?.getBoundingClientRect().height),
  }));
  if (facts.overflow > 1) throw new Error(`${label}: horizontal overflow ${facts.overflow}px`);
  if (!facts.rtl) throw new Error(`${label}: page is not RTL`);
  if (!facts.composerVisible) throw new Error(`${label}: composer hidden`);
  return facts;
}
/** A compact card sizes to its content: never wider than 440px, never the whole column on wide screens. */
async function compact(locator, label) {
  const box = await locator.evaluate((node) => {
    const own = node.getBoundingClientRect();
    const column = node.closest(".ai-assistant-content")?.getBoundingClientRect() ?? own;
    const clipped = [...node.querySelectorAll("*")].some((child) => child.scrollWidth > child.clientWidth + 1 && getComputedStyle(child).overflowX === "hidden");
    return { width: Math.round(own.width), column: Math.round(column.width), clipped };
  });
  if (box.width > 441) throw new Error(`${label}: compact card ${box.width}px wide`);
  if (box.column > 600 && box.width >= box.column - 1) throw new Error(`${label}: compact card fills the ${box.column}px column`);
  if (box.clipped) throw new Error(`${label}: clipped text in card`);
  return box;
}
let currentPage;
async function journey(name, run) {
  try {
    report.journeys[name] = { status: "PASS", ...(await run()) };
  } catch (error) {
    try {
      if (currentPage) {
        await currentPage.screenshot({ path: `${out}/shots/FAIL-${name}.png` });
        report.journeys[name + "Dom"] = await currentPage.evaluate(() => [...document.querySelectorAll('[data-testid^="message-"]')].slice(-4).map((node) => `${node.getAttribute("data-testid")}: ${node.textContent?.slice(0, 160)}`));
      }
    } catch {}
    report.journeys[name] = { status: "FAIL", error: String(error).slice(0, 600) };
    failed.push(name);
  }
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium" });
try {
  await journey("themeAtEveryWidth", async () => {
    const widths = [];
    for (const width of WIDTHS) {
      const context = await newContext(browser, "theme", width, "light");
      const page = await openPage(context, "theme", conversations.theme);
      const dark = await send(page, "دينار حوّل التطبيق للوضع الداكن");
      const chip = dark.locator.getByTestId("control-theme");
      await page.waitForSelector('[data-testid="control-theme"][data-status="APPLIED"]', { timeout: 10_000 });
      if (!(await isDark(page))) throw new Error(`${width}: dark not applied`);
      const text = await chip.innerText();
      if (!/تم تفعيل الوضع الداكن/u.test(text)) throw new Error(`${width}: chip «${text}»`);
      const box = await compact(chip, `theme-${width}`);
      const facts = await layout(page, `theme-${width}`);
      await page.screenshot({ path: `${out}/shots/ucc-theme-dark-${width}.png` });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("input-ai-composer").waitFor();
      if (!(await isDark(page))) throw new Error(`${width}: dark lost after reload`);
      await page.waitForSelector('[data-testid="control-theme"][data-status="APPLIED"]', { timeout: 15_000 });
      const light = await send(page, "دينار اجعل التطبيق بالوضع الفاتح.");
      await page.waitForSelector('[data-testid="control-theme"][data-status="APPLIED"] >> text=الوضع الفاتح', { timeout: 10_000 });
      if (await isDark(page)) throw new Error(`${width}: light not applied`);
      if (!/تم تفعيل الوضع الفاتح/u.test(light.text)) throw new Error(`${width}: «${light.text.slice(0, 120)}»`);
      widths.push({ width, card: box.width, column: box.column, overflow: facts.overflow });
      await context.close();
    }
    return { widths };
  });

  await journey("systemThemeAndTabs", async () => {
    const context = await newContext(browser, "tabs", 390, "dark");
    const first = await openPage(context, "tabs", conversations.tabs);
    const second = await context.newPage();
    second.on("pageerror", (error) => consoleErrors.push(`theme-tab2: ${String(error).slice(0, 200)}`));
    await second.goto("/", { waitUntil: "domcontentloaded" });
    await second.getByTestId("input-ai-composer").waitFor();
    await send(first, "دينار خلي التطبيق لايت مود");
    await first.waitForSelector('[data-testid="control-theme"][data-status="APPLIED"] >> text=الوضع الفاتح');
    await second.waitForFunction(() => !document.documentElement.classList.contains("dark"), null, { timeout: 5_000 });
    await send(first, "دينار ارجع للوضع حسب الجهاز");
    await first.waitForSelector('[data-testid="control-theme"][data-status="APPLIED"] >> text=وضع الجهاز');
    if (!(await isDark(first))) throw new Error("system theme should follow the dark device");
    await second.waitForFunction(() => document.documentElement.classList.contains("dark"), null, { timeout: 5_000 });
    const saved = await first.evaluate(() => localStorage.getItem("dinar-theme"));
    if (saved !== null) throw new Error(`system preference stored as «${saved}»`);
    await context.close();
    return { tabsFollowed: true, systemDark: true };
  });

  await journey("marketSwitchByClick", async () => {
    const results = [];
    for (const [width, scheme] of [[320, "light"], [1280, "dark"]]) {
      const context = await newContext(browser, `market${width}`, width, scheme);
      const page = await openPage(context, `market${width}`, conversations[`market${width}`]);
      const review = await send(page, "دينار أريد أستخدم السوق السعودي");
      const card = review.locator.getByTestId("control-market");
      await card.waitFor();
      if (!/السعودية/u.test(await card.innerText())) throw new Error("review shows target market");
      const box = await compact(card, `market-${width}`);
      const before = await lastAssistant(page);
      await card.getByTestId("control-confirm").click();
      await settle(page, before);
      // The account refresh moves the page to the new market; the same conversation must stay open.
      await page.waitForTimeout(1500);
      await page.locator('[data-testid="control-market"][data-status="SUCCEEDED"]').last().waitFor({ timeout: 20_000 });
      if (!(await page.locator('[data-testid^="message-user-"]', { hasText: "أريد أستخدم السوق السعودي" }).count()))
        throw new Error("the conversation was not kept open after the switch");
      const me = await (await fetch(`${apiOrigin}/api/auth/me`, { headers: { cookie: cookies[`market${width}`], origin: apiOrigin } })).json();
      if ((me.user ?? me).activeMarketId !== "SA") throw new Error(`active market ${(me.user ?? me).activeMarketId}`);
      await layout(page, `market-${width}`);
      await page.screenshot({ path: `${out}/shots/ucc-market-${width}-${scheme}.png` });
      const unsupported = await send(page, "دينار أريد تصفح عروض الإمارات");
      const notice = unsupported.locator.getByTestId("control-notice");
      await notice.waitFor();
      await compact(notice, `notice-${width}`);
      if ((await notice.getByTestId("control-option").count()) < 1) throw new Error("no available-market options");
      results.push({ width, scheme, card: box.width, column: box.column });
      await context.close();
    }
    return { results };
  });

  await journey("profileByKeyboard", async () => {
    const context = await newContext(browser, "profile", 390, "light");
    const page = await openPage(context, "profile", conversations.profile);
    const review = await send(page, "دينار غيّر اسمي إلى ريم المتصفحة");
    const card = review.locator.getByTestId("control-profile");
    await card.waitFor();
    await compact(card, "profile");
    const confirm = card.getByTestId("control-confirm");
    await confirm.focus();
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    if (focused !== "control-confirm") throw new Error(`focus on ${focused}`);
    const before = await lastAssistant(page);
    await page.keyboard.press("Enter");
    const done = await settle(page, before);
    await done.locator.locator('[data-testid="control-profile"][data-status="SUCCEEDED"]').waitFor();
    const me = await (await fetch(`${apiOrigin}/api/auth/me`, { headers: { cookie: cookies.profile, origin: apiOrigin } })).json();
    if ((me.user ?? me).displayName !== "ريم المتصفحة") throw new Error(`name ${(me.user ?? me).displayName}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("input-ai-composer").waitFor();
    await page.locator('[data-testid="control-profile"][data-status="SUCCEEDED"]').first().waitFor({ timeout: 15_000 });
    const pending = await page.locator('[data-testid="control-profile"][data-status="AWAITING_CONFIRMATION"]').count();
    if (pending) throw new Error("reloaded review still offers confirmation");
    await layout(page, "profile");
    await page.screenshot({ path: `${out}/shots/ucc-profile-390.png` });
    await context.close();
    return { keyboard: true, reloadRestored: true };
  });
} finally {
  await browser.close();
}
report.summary = { failed, consoleErrors };
await writeFile(resultPath, JSON.stringify(report, null, 2));
