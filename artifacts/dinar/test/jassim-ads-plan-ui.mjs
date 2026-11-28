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
const VIEWPORTS = [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]];

try {
  if (PHASE === "PLAN") {
    for (const [label, viewport] of VIEWPORTS) {
      // Above the privacy threshold: the interested-buyer count is shown, never who they are.
      const { context, page } = await open(F.sellerAbove, await newConversation(F.sellerAbove), viewport);
      const planMsg = await send(page, "روّج لهذا المنتج");
      const surface = planMsg.getByTestId("commercial-surface");
      check(`${label}: plan card shown`, await surface.getAttribute("data-view") === "PROMOTION_TYPE_OPTIONS");
      check(`${label}: plan names the listing`, (await planMsg.innerText()).includes(F.titleAbove));
      check(`${label}: no "simulation only" claim in a live-provider market`, await surface.getByTestId("commercial-simulation").count() === 0);
      check(`${label}: card is RTL`, await rtl(surface) === "rtl");
      const plan = surface.getByTestId("promotion-plan");
      const planText = await plan.innerText();
      check(`${label}: interested buyers above threshold`, planText.includes(`${F.expectedInterested} مشترٍ`), planText);
      check(`${label}: no buyer identity revealed`, !/مشتري1|مشتري2|مشتري3/.test(await planMsg.innerText()));
      const copy = plan.locator("li");
      check(`${label}: three copy drafts`, await copy.count() === 3);
      check(`${label}: copy from listing facts`, (await copy.first().innerText()).length > 5);
      check(`${label}: nothing paid note`, planText.includes("لا يُدفع شيء"), planText);
      const options = surface.getByTestId("promotion-option");
      check(`${label}: two options`, await options.count() === 2);
      const optionsText = await surface.locator("ol").first().innerText();
      check(`${label}: server prices shown`, /5[.,٫]000|٥/.test(optionsText) && /8[.,٫]000|٨/.test(optionsText), optionsText);
      const suggested = surface.locator('[data-testid="promotion-option"][data-suggested="true"]');
      check(`${label}: one suggested option`, await suggested.count() === 1);
      check(`${label}: suggested is the cheaper`, (await suggested.innerText()).includes("إبراز في البحث"), await suggested.innerText());
      check(`${label}: no overflow (plan)`, await noOverflow(page));
      await planMsg.scrollIntoViewIfNeeded();
      await shot(page, `${label}-1-plan`);

      const review = await click(page, suggested.getByRole("button"));
      const reviewText = await review.innerText();
      check(`${label}: review names provider`, reviewText.includes("بوابة الاختبار"), reviewText.slice(0, 400));
      check(`${label}: review shows amount`, /5[.,٫]000|٥/.test(reviewText), reviewText.slice(0, 400));
      const confirm = review.getByTestId("commercial-confirm");
      const confirmLabel = await confirm.innerText();
      check(`${label}: confirm button names provider, not Whop`, confirmLabel.includes("بوابة الاختبار") && !confirmLabel.includes("Whop"), confirmLabel);
      check(`${label}: no overflow (review)`, await noOverflow(page));
      await review.scrollIntoViewIfNeeded();
      await shot(page, `${label}-2-review`);

      if (label === "mobile") {
        // Cancel path: nothing is opened.
        const cancelled = await click(page, review.getByTestId("commercial-cancel"));
        await cancelled.getByTestId("commercial-surface").waitFor({ timeout: 15_000 }).catch(() => {});
        check(`${label}: cancel leaves no checkout`, await cancelled.getByTestId("promotion-checkout").count() === 0, (await cancelled.innerText()).slice(0, 300));
        await context.close();
        continue;
      }
      const handoff = await click(page, confirm);
      const checkout = handoff.getByTestId("promotion-checkout");
      await checkout.waitFor({ timeout: 15_000 }).catch(() => {});
      check(`${label}: checkout card shown`, await checkout.count() === 1);
      const link = checkout.getByTestId("promotion-checkout-link");
      const href = await link.getAttribute("href");
      check(`${label}: handoff link to provider`, /^https:\/\/pay\.test-gateway\.example\/tg_/.test(href ?? ""), href);
      check(`${label}: link names provider`, (await link.innerText()).includes("بوابة الاختبار"), await link.innerText());
      check(`${label}: link is noopener`, (await link.getAttribute("rel"))?.includes("noopener"));
      check(`${label}: no wallet balance shown (wallet deferred)`, await handoff.getByTestId("commercial-balance").count() === 0);
      check(`${label}: nothing charged yet`, (await handoff.innerText()).includes("لم يُخصم شيء بعد"));
      check(`${label}: no overflow (handoff)`, await noOverflow(page));
      await handoff.scrollIntoViewIfNeeded();
      await shot(page, `${label}-3-handoff`);
      report.promotionId = href.split("/tg_")[1];
      await context.close();
    }
    // Below the privacy threshold: no count at all.
    for (const [label, viewport] of VIEWPORTS) {
      const { context, page } = await open(F.sellerBelow, await newConversation(F.sellerBelow), viewport);
      const planMsg = await send(page, "روّج لهذا المنتج");
      const plan = planMsg.getByTestId("promotion-plan");
      await plan.waitFor({ timeout: 15_000 }).catch(() => {});
      check(`${label}: below-threshold plan shown`, await plan.count() === 1, (await planMsg.innerText()).slice(0, 500));
      check(`${label}: no interested count below threshold`, !/مشترٍ يبحثون/.test(await plan.innerText()), await plan.innerText());
      await planMsg.scrollIntoViewIfNeeded();
      await shot(page, `${label}-4-below-threshold`);
      await context.close();
    }
    // Mobile handoff too (the other seller: the first listing already has a pending checkout).
    {
      const { context, page } = await open(F.sellerBelow, await newConversation(F.sellerBelow), VIEWPORTS[0][1]);
      const planMsg = await send(page, "روّج لهذا المنتج");
      const review = await click(page, planMsg.locator('[data-testid="promotion-option"][data-suggested="true"]').getByRole("button"));
      check("mobile: confirm names provider", (await review.getByTestId("commercial-confirm").innerText()).includes("بوابة الاختبار"));
      const handoff = await click(page, review.getByTestId("commercial-confirm"));
      check("mobile: handoff link", /^https:\/\/pay\.test-gateway\.example\//.test(await handoff.getByTestId("promotion-checkout-link").getAttribute("href") ?? ""));
      check("mobile: no overflow (handoff)", await noOverflow(page));
      await handoff.scrollIntoViewIfNeeded();
      await shot(page, "mobile-3-handoff");
      await context.close();
    }
    // A second plan for a listing whose payment is already pending: shown honestly, nothing doubled.
    {
      const { context, page } = await open(F.sellerAbove, await newConversation(F.sellerAbove), VIEWPORTS[0][1]);
      const planMsg = await send(page, "روّج لهذا المنتج");
      const review = await click(page, planMsg.locator('[data-testid="promotion-option"][data-suggested="true"]').getByRole("button"));
      await review.getByTestId("commercial-surface").waitFor({ timeout: 15_000 }).catch(() => {});
      report.pendingRepeat = (await review.innerText()).slice(0, 600);
      check("mobile: repeat on pending listing does not offer a second confirm", await review.getByTestId("commercial-confirm").count() === 0, report.pendingRepeat);
      await review.scrollIntoViewIfNeeded();
      await shot(page, "mobile-3b-pending-repeat");
      await context.close();
    }
  } else {
    for (const [label, viewport] of VIEWPORTS) {
      const { context, page } = await open(F.sellerAbove, await newConversation(F.sellerAbove), viewport);
      const msg = await send(page, "كيف تسير حملاتي");
      const surface = msg.getByTestId("commercial-surface");
      check(`${label}: results card`, await surface.getAttribute("data-view") === "CAMPAIGN_ANALYTICS");
      const campaigns = surface.getByTestId("commercial-campaign");
      await campaigns.first().waitFor({ timeout: 15_000 }).catch(() => {});
      check(`${label}: at least one campaign`, await campaigns.count() >= 1);
      const text = await surface.innerText();
      check(`${label}: active campaign for the listing`, text.includes(F.titleAbove) && text.includes("نشط"), text.slice(0, 400));
      check(`${label}: no wallet balance in results`, await surface.getByTestId("commercial-balance").count() === 0);
      check(`${label}: results RTL`, await rtl(surface) === "rtl");
      check(`${label}: no overflow (results)`, await noOverflow(page));
      await msg.scrollIntoViewIfNeeded();
      await shot(page, `${label}-5-results`);
      await context.close();
    }
  }
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 1500);
} finally {
  await browser.close();
  await writeFile(env.AP_REPORT, JSON.stringify(report));
}
