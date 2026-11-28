/**
 * Jassim Ads plan — browser driver (run by api-server/test/jassim-ads-plan-browser-journey.test.ts).
 * Never opens the provider's payment page: it checks the handoff link only.
 */
import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";

const env = process.env;
const WEB = env.AP_WEB;
const API = env.AP_API;
const SHOTS = env.AP_SHOTS;
const PHASE = env.AP_PHASE;
const F = JSON.parse(env.AP_FIXTURE);
const report = { phase: PHASE, checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], screenshots: [], failure: undefined };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`CHECK FAILED: ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};
const allowed = new Set([new URL(WEB).host, new URL(API).host, "fonts.googleapis.com", "fonts.gstatic.com"]);
const browser = await chromium.launch({ headless: true, executablePath: env.CHROMIUM_PATH ?? env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });

async function open(actor, conv, { width, height }) {
  const context = await browser.newContext({ baseURL: WEB, viewport: { width, height }, isMobile: width < 600, hasTouch: width < 600, locale: "ar", deviceScaleFactor: 2 });
  await context.addInitScript(({ conversationId, userId }) => localStorage.setItem(`dinar-conversation:${userId}:JO`, conversationId), { conversationId: conv, userId: actor.id });
  const split = actor.cookie.indexOf("=");
  await context.addCookies([{ name: actor.cookie.slice(0, split), value: actor.cookie.slice(split + 1), domain: new URL(WEB).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"]) delete headers[header];
    headers.origin = API;
    headers.referer = `${API}/`;
    try { await route.fulfill({ response: await route.fetch({ url: `${API}${url.pathname}${url.search}`, headers }) }); } catch { /* context closed mid-request */ }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => message.type() === "error" && report.consoleErrors.push(message.text().slice(0, 400)));
  page.on("request", (request) => {
    const host = new URL(request.url()).host;
    if (!allowed.has(host) && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) report.externalRequests.push(host);
  });
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 60_000 });
  return { context, page };
}
const assistant = (page) => page.locator('[data-testid^="message-assistant-"]');
async function settle(page) { await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function waitTurn(page, before) {
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
    document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة", before, { timeout: 60_000 });
  await settle(page);
}
async function send(page, text) {
  const before = await assistant(page).count();
  const enabled = () => page.waitForFunction(() => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("data-ready") === "true", undefined, { timeout: 5_000 }).then(() => true, () => false);
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByTestId("input-ai-composer").fill("");
    await page.getByTestId("input-ai-composer").fill(text);
    if (await enabled()) break;
  }
  await page.getByTestId("button-send-ai-message").click();
  await waitTurn(page, before);
  return assistant(page).last();
}
async function click(page, locator) {
  const before = await assistant(page).count();
  await locator.click();
  await waitTurn(page, before);
  return assistant(page).last();
}
async function newConversation(actor) {
  const r = await fetch(`${API}/api/ai/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie: actor.cookie, origin: API }, body: "{}" });
  return (await r.json()).id;
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const shot = async (page, name) => { await mkdir(SHOTS, { recursive: true }); const path = `${SHOTS}/${name}.png`; await page.screenshot({ path, fullPage: false }); report.screenshots.push(path); };
const rtl = (locator) => locator.evaluate((el) => getComputedStyle(el).direction);
const VIEWPORTS = [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1440, height: 900 }]];
const option = (builder, placement) => builder.locator(`[data-testid="campaign-option"][data-placement="${placement}"]`);
async function waitTotal(builder, expected) {
  const total = builder.getByTestId("campaign-total");
  await builder.page().waitForFunction(({ el, want }) => el?.textContent?.includes(want), { el: await total.elementHandle({ timeout: 15_000 }), want: expected }, { timeout: 15_000 }).catch(() => {});
  return (await total.textContent())?.trim() ?? "";
}
async function setOnly(builder, placements) {
  for (const row of await builder.getByTestId("campaign-option").all()) {
    const placement = await row.getAttribute("data-placement");
    const selected = (await row.getAttribute("data-selected")) === "true";
    if (selected !== placements.includes(placement)) await row.getByTestId("campaign-option-toggle").click();
  }
}

try {
  if (PHASE === "PLAN") {
    for (const [label, viewport] of VIEWPORTS) {
      const { context, page } = await open(F.sellerAbove, await newConversation(F.sellerAbove), viewport);
      const planMsg = await send(page, "عندي 100 قطعة من هذا المنتج وأريد بيعها");
      const surface = planMsg.getByTestId("commercial-surface");
      check(`${label}: plan card`, (await surface.getAttribute("data-view", { timeout: 15_000 })) === "PROMOTION_TYPE_OPTIONS");
      const text = await planMsg.innerText();
      check(`${label}: honest about the quantity`, text.includes("لا أعدك ببيع الكمية كلها"));
      check(`${label}: RTL`, (await rtl(surface)) === "rtl");
      check(`${label}: no simulation claim`, (await surface.getByTestId("commercial-simulation").count()) === 0);
      const insights = surface.getByTestId("selling-insights");
      await insights.waitFor({ timeout: 15_000 });
      check(`${label}: real interest labelled «فعلي»`, (await insights.locator('[data-kind="REAL"]').first().innerText()).includes("فعلي"));
      check(`${label}: interest count above threshold, no identity`, (await insights.innerText()).includes("3 مشترين") && !/مشتري1|مشتري2|مشتري3/.test(text));
      check(`${label}: listing tip`, (await insights.locator('[data-kind="TIP"]').count()) >= 1);
      check(`${label}: no promise on 100 pieces`, (await insights.innerText()).includes("لا أستطيع أن أعدك ببيع 100 قطعة"));
      const builder = surface.getByTestId("campaign-builder");
      await builder.waitFor({ timeout: 15_000 });
      check(`${label}: «أين تريد ظهور إعلانك؟»`, (await builder.innerText()).includes("أين تريد ظهور إعلانك؟"));
      check(`${label}: three placements offered`, (await builder.getByTestId("campaign-option").count()) === 3);
      const suggestions = await builder.getByTestId("campaign-suggestions").locator("> div").count();
      check(`${label}: one to three suggestions with reasons`, suggestions >= 1 && suggestions <= 3);
      check(`${label}: no older one-at-a-time list`, (await surface.getByTestId("promotion-option").count()) === 0);
      // One placement, per-day, days changed → server total.
      await setOnly(builder, ["SIDEBAR"]);
      check(`${label}: one placement total`, (await waitTotal(builder, "14.000")).includes("14.000"), await builder.getByTestId("campaign-total").textContent());
      await option(builder, "SIDEBAR").getByTestId("campaign-option-days").fill("4");
      check(`${label}: days change recomputes`, (await waitTotal(builder, "8.000")).includes("8.000"));
      // Several placements, then all, then remove one.
      await option(builder, "HERO").getByTestId("campaign-option-toggle").click();
      check(`${label}: two placements`, (await waitTotal(builder, "33.000")).includes("33.000"));
      await option(builder, "SPONSORED_SEARCH").getByTestId("campaign-option-toggle").click();
      check(`${label}: all placements`, (await waitTotal(builder, "39.000")).includes("39.000"));
      check(`${label}: a review line per placement`, (await builder.getByTestId("campaign-review-line").count()) === 3);
      await option(builder, "HERO").getByTestId("campaign-option-toggle").click();
      check(`${label}: removing recomputes`, (await waitTotal(builder, "14.000")).includes("14.000"));
      check(`${label}: no overflow (builder)`, await noOverflow(page));
      await builder.scrollIntoViewIfNeeded();
      await shot(page, `${label}-1-builder`);
      const copy = builder.getByTestId("campaign-copy");
      const edited = `سماعة سوني أصلية بالضمان — اطلبها الآن ${label}`;
      await copy.fill(edited);
      const confirm = builder.getByTestId("campaign-confirm");
      check(`${label}: confirm names the provider`, (await confirm.innerText()).includes("بوابة الاختبار"));
      await builder.getByTestId("campaign-review").scrollIntoViewIfNeeded();
      await shot(page, `${label}-2-review`);
      if (label === "desktop") {
        await confirm.click();
        const handoff = builder.getByTestId("campaign-checkout");
        await handoff.waitFor({ timeout: 15_000 });
        const link = handoff.getByTestId("campaign-checkout-link");
        const href = await link.getAttribute("href");
        check(`${label}: one payment page for the campaign`, /^https:\/\/pay\.test-gateway\.example\/tg_/.test(href ?? ""), href);
        check(`${label}: amount = reviewed total`, (await handoff.innerText()).includes("14.000"));
        check(`${label}: nothing charged yet`, (await handoff.innerText()).includes("لم يُخصم شيء بعد"));
        check(`${label}: link is noopener`, (await link.getAttribute("rel"))?.includes("noopener"));
        check(`${label}: inputs locked after confirmation`, await copy.isDisabled());
        check(`${label}: no overflow (handoff)`, await noOverflow(page));
        await handoff.scrollIntoViewIfNeeded();
        await shot(page, `${label}-3-handoff`);
        report.campaignId = href.split("/tg_")[1];
        report.editedCopy = edited;
      }
      await context.close();
    }
    // Below the privacy threshold (mobile): no count; honest limit; mobile handoff.
    {
      const { context, page } = await open(F.sellerBelow, await newConversation(F.sellerBelow), VIEWPORTS[0][1]);
      const planMsg = await send(page, "روّج لهذا المنتج");
      const insights = planMsg.getByTestId("selling-insights");
      await insights.waitFor({ timeout: 15_000 });
      const text = await planMsg.innerText();
      check("mobile: no interest count below threshold", !/مشترين طلبوا|مشترٍ يبحثون/.test(text), text.slice(0, 500));
      check("mobile: honest limit below threshold", (await insights.innerText()).includes("لا توجد بيانات اهتمام كافية"));
      const builder = planMsg.getByTestId("campaign-builder");
      await setOnly(builder, ["SPONSORED_SEARCH"]);
      check("mobile: search-only total", (await waitTotal(builder, "6.000")).includes("6.000"));
      await builder.getByTestId("campaign-confirm").click();
      await builder.getByTestId("campaign-checkout").waitFor({ timeout: 15_000 });
      check("mobile: handoff", /^https:\/\/pay\.test-gateway\.example\//.test((await builder.getByTestId("campaign-checkout-link").getAttribute("href")) ?? ""));
      check("mobile: no overflow (handoff)", await noOverflow(page));
      await builder.getByTestId("campaign-checkout").scrollIntoViewIfNeeded();
      await shot(page, "mobile-3-handoff");
      await context.close();
    }
    // Store promotion (mobile): display placements only.
    {
      const { context, page } = await open(F.storeOwner, await newConversation(F.storeOwner), VIEWPORTS[0][1]);
      const msg = await send(page, "أريد ترويج متجري");
      check("store: plan opened", (await msg.innerText()).includes(`خطة ترويج متجر «${F.storeName}»`));
      const builder = msg.getByTestId("campaign-builder");
      await builder.waitFor({ timeout: 15_000 });
      const placements = await builder.getByTestId("campaign-option").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-placement")).sort());
      check("store: hero and sidebar only", JSON.stringify(placements) === JSON.stringify(["HERO", "SIDEBAR"]), placements);
      await setOnly(builder, ["SIDEBAR"]);
      await option(builder, "SIDEBAR").getByTestId("campaign-option-days").fill("3");
      check("store: total", (await waitTotal(builder, "6.000")).includes("6.000"));
      await builder.getByTestId("campaign-confirm").click();
      await builder.getByTestId("campaign-checkout").waitFor({ timeout: 15_000 });
      report.storeCampaignId = ((await builder.getByTestId("campaign-checkout-link").getAttribute("href")) ?? "").split("/tg_")[1];
      check("store: handoff", Boolean(report.storeCampaignId));
      await builder.scrollIntoViewIfNeeded();
      await shot(page, "mobile-4-store");
      await context.close();
    }
  } else {
    for (const [label, viewport] of VIEWPORTS) {
      const { context, page } = await open(F.sellerAbove, await newConversation(F.sellerAbove), viewport);
      const msg = await send(page, "كيف تسير حملاتي");
      const surface = msg.getByTestId("commercial-surface");
      check(`${label}: results card`, (await surface.getAttribute("data-view", { timeout: 15_000 })) === "CAMPAIGN_ANALYTICS");
      const campaign = surface.getByTestId("placement-campaign").first();
      await campaign.waitFor({ timeout: 15_000 });
      check(`${label}: campaign active`, (await campaign.getAttribute("data-status")) === "ACTIVE");
      const rows = campaign.getByTestId("placement-result");
      check(`${label}: one row per placement`, (await rows.count()) === 2);
      const text = await campaign.innerText();
      check(`${label}: per-placement counts and remaining days`, text.includes("ظهور:") && text.includes("نقرات:") && text.includes("طلبات منسوبة:") && text.includes("متبقٍ:"));
      check(`${label}: campaign totals`, (await campaign.getByTestId("placement-campaign-totals").innerText()).includes("الإجمالي"));
      check(`${label}: payment confirmed note`, (await campaign.getByTestId("placement-campaign-payment").innerText()).includes("وصل الدفع"));
      check(`${label}: results RTL`, (await rtl(surface)) === "rtl");
      check(`${label}: no overflow (results)`, await noOverflow(page));
      await campaign.scrollIntoViewIfNeeded();
      await shot(page, `${label}-5-results`);
      await context.close();
    }
    // A visitor on desktop sees the paid store in the sidebar, labelled; clicking is recorded.
    {
      const { context, page } = await open(F.viewer, await newConversation(F.viewer), VIEWPORTS[1][1]);
      const card = page.getByTestId("sidebar-sponsored-card");
      await card.waitFor({ timeout: 20_000 });
      check("visitor: the sidebar shows a labelled paid card", (await card.innerText()).includes("إعلان ممول"));
      const STORE_NAME = F.storeName;
      const served = await page.evaluate(async () => (await (await fetch("/api/ads/placements?slot=SIDEBAR", { credentials: "include" })).json()).cards);
      const store = served.find((item) => item.kind === "STORE");
      check("visitor: the paid store is served in the sidebar placement", store?.title === STORE_NAME && store.label === "إعلان ممول" && store.path.startsWith("/business/"), served.map((c) => [c.kind, c.title]));
      const hero = page.getByTestId("hero-sponsored");
      check("visitor: hero carries only labelled paid cards", (await hero.count()) === 0 || (await hero.getByTestId("hero-sponsored-label").first().innerText()).includes("إعلان ممول"));
      await shot(page, "desktop-6-sidebar-store");
      await context.close();
    }
  }
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 1500);
} finally {
  await browser.close();
  await writeFile(env.AP_REPORT, JSON.stringify(report));
}
