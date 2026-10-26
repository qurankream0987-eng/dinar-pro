// DINAR NEXT G3 browser acceptance, driven by api-server/test/next-g3-acceptance.test.ts.
// Every user step is typed into the real composer or clicked in the real UI of the production
// build, signed in, against the real API and a disposable database.
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const webBase = process.env.G3_WEB_BASE;
const apiOrigin = process.env.G3_API_ORIGIN;
const cookies = JSON.parse(process.env.G3_COOKIES ?? "{}");
const users = JSON.parse(process.env.G3_USERS ?? "{}");
const conversations = JSON.parse(process.env.G3_CONVERSATIONS ?? "{}");
const token = process.env.G3_TOKEN ?? "";
const out = process.env.G3_OUT;
const resultPath = process.env.G3_RESULT;
if (!webBase || !apiOrigin || !out || !resultPath) throw new Error("Missing G3 browser configuration.");

const report = { journeys: {}, summary: {} };
const failed = [];
const consoleErrors = [];

async function open(browser, actor, conversationId, width = 390, colorScheme = "light") {
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
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${actor}: ${message.text().slice(0, 200)}`); });
  page.on("pageerror", (error) => consoleErrors.push(`${actor}: ${String(error).slice(0, 200)}`));
  await page.addInitScript(([key, id]) => { try { localStorage.setItem(key, id); } catch {} }, [`dinar-conversation:${users[actor]}:JO`, conversationId]);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 30_000 });
  return { context, page };
}

const assistants = (page) => page.locator('[data-testid^="message-assistant-"]');
async function settle(page, before) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
      document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    before,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(250);
  const latest = assistants(page).last();
  return { locator: latest, text: (await latest.innerText()).replace(/\s+/g, " ") };
}
async function send(page, text) {
  const before = await assistants(page).count();
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
async function click(page, locator) {
  const before = await assistants(page).count();
  await locator.click();
  return settle(page, before);
}
const expectText = (turn, pattern, label) => {
  if (!pattern.test(turn.text)) throw new Error(`${label}: expected ${pattern} in «${turn.text.slice(0, 300)}»`);
};
async function api(actor, path) {
  const response = await fetch(`${apiOrigin}${path}`, { headers: { cookie: cookies[actor], origin: apiOrigin } });
  return response.json();
}
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
async function journey(name, run) {
  try {
    report.journeys[name] = { status: "PASS", ...(await run()) };
  } catch (error) {
    report.journeys[name] = { status: "FAIL", error: String(error).slice(0, 600) };
    failed.push(name);
  }
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
try {
  await journey("usageAndPlans", async () => {
    const widths = [];
    for (const [width, scheme] of [[320, "light"], [390, "dark"], [1280, "light"]]) {
      const { context, page } = await open(browser, "free", conversations.usage, width, scheme);
      const usage = await send(page, "دينار كم نسبة استهلاكي؟");
      await usage.locator.getByTestId("ai-usage").waitFor();
      const meters = await usage.locator.getByRole("progressbar").count();
      if (meters < 2) throw new Error(`usage meters: ${meters}`);
      expectText(usage, /باقتك: المجاني/u, "tier");
      expectText(usage, /تتجدد/u, "renewal");
      const plans = await send(page, "دينار اعرض الباقات");
      await plans.locator.getByTestId("ai-plans").waitFor();
      const tiers = await plans.locator.getByTestId("ai-plan").count();
      if (tiers !== 3) throw new Error(`plan tiers: ${tiers}`);
      await plans.locator.getByTestId("ai-plans-billing").waitFor();
      const facts = await layout(page, `usage-${width}`);
      await page.screenshot({ path: `${out}/shots/g3-usage-plans-${width}-${scheme}.png`, fullPage: false });
      widths.push({ width, scheme, meters, tiers, ...facts });
      await context.close();
    }
    return { widths };
  });

  await journey("twoPartyInquiry", async () => {
    const buyerSide = await open(browser, "buyer", conversations.inquiry, 390);
    await send(buyerSide.page, `ابحث عن قوارير عطر ${token}`);
    const draft = await send(buyerSide.page, "دينار اسأل البائع هل عنده 50 قطعة");
    await draft.locator.getByTestId("inquiry-draft").waitFor();
    expectText(draft, /لا أستطيع وعدك بـ50/u, "no promise beyond stock");
    const sent = await click(buyerSide.page, draft.locator.getByTestId("inquiry-send"));
    expectText(sent, /أُرسلت رسالتك ووصلت إلى محادثة البائع/u, "sent status");
    await layout(buyerSide.page, "buyer-inquiry");
    await buyerSide.page.screenshot({ path: `${out}/shots/g3-inquiry-buyer-sent-390.png` });

    const inbox = (await api("seller", "/api/ai/conversations")).find((row) => row.title === "رسائل البيع والشراء في DINAR");
    if (!inbox) throw new Error("seller inbox not created");
    const sellerSide = await open(browser, "seller", inbox.id, 390);
    await sellerSide.page.getByTestId("inquiry-surface").last().waitFor();
    const incoming = sellerSide.page.locator('[data-testid="inquiry-surface"][data-view="INCOMING"]').last();
    await incoming.getByText(/هل يمكن توفير 50 قطعة/u).waitFor();
    const replyDraft = await send(sellerSide.page, "عندي 60 قطعة، ويمكن توفيرها خلال يومين.");
    await replyDraft.locator.getByTestId("inquiry-draft").waitFor();
    const replied = await click(sellerSide.page, replyDraft.locator.getByTestId("inquiry-send"));
    expectText(replied, /أُرسلت رسالتك ووصلت إلى محادثة المشتري/u, "reply sent");
    await layout(sellerSide.page, "seller-inquiry");
    await sellerSide.page.screenshot({ path: `${out}/shots/g3-inquiry-seller-reply-390.png` });
    await sellerSide.context.close();

    await buyerSide.page.reload({ waitUntil: "domcontentloaded" });
    await buyerSide.page.getByTestId("input-ai-composer").waitFor({ timeout: 30_000 });
    await buyerSide.page.getByText(/ردّ البائع على رسالتك/u).last().waitFor();
    const answer = await send(buyerSide.page, "دينار ماذا قال البائع؟");
    const sellerMessage = answer.locator.locator('[data-testid="inquiry-message"][data-author="SELLER"]');
    await sellerMessage.waitFor();
    const provenance = await sellerMessage.getAttribute("data-provenance");
    if (provenance !== "SELLER_AUTHORED") throw new Error(`provenance ${provenance}`);
    expectText(answer, /عندي 60 قطعة، ويمكن توفيرها خلال يومين/u, "verbatim reply");
    await buyerSide.page.screenshot({ path: `${out}/shots/g3-inquiry-buyer-reply-390.png` });
    await buyerSide.context.close();
    return { provenance };
  });

  await journey("sellerSales", async () => {
    const { context, page } = await open(browser, "seller", conversations.sales, 390);
    const stats = await send(page, "دينار أعطني إحصائيات مبيعاتي");
    await stats.locator.getByTestId("sales-summary").waitFor();
    await stats.locator.getByTestId("sales-metric-paid").waitFor();
    const compare = await send(page, "قارن مبيعات الشهر الحالي بالشهر السابق");
    await compare.locator.getByTestId("sales-period").getByText(/مقابل/u).waitFor();
    await layout(page, "sales");
    await page.screenshot({ path: `${out}/shots/g3-sales-390.png` });
    await context.close();
  });
} finally {
  await browser.close();
  report.summary = { failed, consoleErrors };
  await writeFile(resultPath, JSON.stringify(report, null, 2));
}
