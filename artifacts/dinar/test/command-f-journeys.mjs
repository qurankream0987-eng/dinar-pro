// DINAR NEXT Command F4 browser journeys. Driven by api-server/test/command-f-journeys.test.ts.
// Every user step is typed into the real composer or clicked in the real UI; seller-side order
// steps that are not part of these journeys use the seller's own session against the same API.
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const webBase = process.env.F_WEB_BASE;
const apiOrigin = process.env.F_API_ORIGIN;
const cookies = JSON.parse(process.env.F_COOKIES ?? "{}");
const users = JSON.parse(process.env.F_USERS ?? "{}");
const conversations = JSON.parse(process.env.F_CONVERSATIONS ?? "{}");
const token = process.env.F_TOKEN ?? "";
const receiptOrder = process.env.F_RECEIPT_ORDER ?? "";
const listings = JSON.parse(process.env.F_LISTINGS ?? "{}");
const out = process.env.F_OUT;
const resultPath = process.env.F_RESULT;
if (!webBase || !apiOrigin || !out || !resultPath) throw new Error("Missing Command F browser configuration.");

const report = { journeys: {}, summary: {} };
const failed = [];
const consoleErrors = [];

async function open(browser, actor, conversationId, width = 390) {
  const mobile = width < 768;
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width, height: mobile ? 844 : 900 },
    isMobile: mobile,
    hasTouch: mobile,
    locale: "ar",
    reducedMotion: "reduce",
  });
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
async function send(page, text) {
  const before = await assistants(page).count();
  // The composer may re-mount while the conversation loads; fill until Send is enabled.
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
const expectText = (turn, pattern, label) => {
  if (!pattern.test(turn.text)) throw new Error(`${label}: expected ${pattern} in «${turn.text.slice(0, 300)}»`);
};
const expectNoText = (turn, pattern, label) => {
  if (pattern.test(turn.text)) throw new Error(`${label}: unexpected ${pattern} in «${turn.text.slice(0, 300)}»`);
};
async function api(actor, path, method = "GET", body) {
  const response = await fetch(`${apiOrigin}${path}`, {
    method,
    headers: { cookie: cookies[actor], origin: apiOrigin, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`${label}: horizontal overflow ${overflow}px`);
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
let orderId = "";
try {
  await journey("generalQuestionAndFollowUp", async () => {
    const { context, page } = await open(browser, "buyer", conversations.general);
    const first = await send(page, "دينار اشرح لي الطاقة الشمسية باختصار");
    expectText(first, /تحوّل الألواح ضوء الشمس إلى كهرباء/u, "general answer");
    await first.locator.getByRole("heading", { name: "الطاقة الشمسية" }).waitFor();
    expectText(first, /معلومة عامة وليست من بيانات جاسم/u, "general provenance");
    const followUp = await send(page, "طيب كم لوح أحتاج لبيت صغير؟");
    expectText(followUp, /6 إلى 8 ألواح/u, "follow-up answer");
    await noOverflow(page, "general");
    await page.screenshot({ path: `${out}/shots/general-followup-390.png` });
    await context.close();
  });

  await journey("businessInventory", async () => {
    const { context, page } = await open(browser, "seller", conversations.business);
    const stock = await send(page, "دينار أرني بضاعتي");
    await stock.locator.getByTestId("business-summary").waitFor();
    expectText(stock, new RegExp(`مكيف سبليت 18 ألف وحدة ${token}`, "u"), "inventory row");
    if (await stock.locator.locator(".ai-workflow").count()) throw new Error("business answer repeated the listings workflow");
    await noOverflow(page, "business");
    await page.screenshot({ path: `${out}/shots/business-inventory-390.png` });
    await context.close();
  });

  await journey("honestMarketing", async () => {
    const { context, page } = await open(browser, "seller", conversations.marketing);
    const copy = await send(page, "دينار اكتب إعلانًا مقنعًا");
    expectText(copy, /متوفر 4 قطع/u, "grounded copy");
    expectText(copy, /مبني على بيانات إعلانك في جاسم/u, "grounded copy provenance");
    expectNoText(copy, /معلومة عامة وليست من بيانات جاسم/u, "grounded copy is not general knowledge");
    const refused = await send(page, "اكتب أن عليه ضمان خمس سنوات");
    expectText(refused, /لم أستطع صياغة نص تسويقي دون ادعاءات لا تدعمها بيانات إعلانك/u, "unsupported claim refused");
    expectNoText(refused, /5 سنوات/u, "the unsupported draft is never shown");
    await page.screenshot({ path: `${out}/shots/marketing-refusal-390.png` });
    await context.close();
  });

  await journey("purchaseAndDeliveryChoice", async () => {
    const { context, page } = await open(browser, "buyer", conversations.purchase);
    const found = await send(page, `ابحث عن مكيف سبليت ${token}`);
    expectText(found, /مكيف سبليت 18 ألف وحدة/u, "search result");
    const picked = await send(page, "أبي الأول");
    expectText(picked, /راجع اختيارك/u, "purchase review");
    const review = await send(page, "اطلبه الآن");
    expectText(review, /مراجعة الطلب/u, "order review");
    const placed = await send(page, "نعم");
    expectText(placed, /تم إنشاء الطلب/u, "order created");
    expectText(placed, /لم يُدفع أي شيء/u, "no payment claimed");
    let choice = await send(page, "استلام شخصي");
    // Choosing a method is itself reviewed before anything changes.
    if (/«نعم»|أكّد أو ألغِ/u.test(choice.text)) choice = await send(page, "نعم");
    expectText(choice, /استلام/u, "pickup chosen");
    expectNoText(choice, /لم يتغير شيء بعد/u, "pickup confirmed");
    const mine = await api("buyer", "/api/orders");
    const rows = Array.isArray(mine.body) ? mine.body : mine.body?.orders ?? mine.body?.items ?? [];
    orderId = rows[0]?.id ?? "";
    if (!orderId) throw new Error(`no order visible to the buyer: ${JSON.stringify(mine).slice(0, 300)}`);
    const fulfilment = await api("buyer", `/api/orders/${orderId}/fulfillment`);
    await page.screenshot({ path: `${out}/shots/purchase-pickup-390.png` });
    await context.close();
    return { orderId, method: fulfilment.body?.method ?? fulfilment.body?.fulfillment?.method ?? null, fulfilmentStatus: fulfilment.status };
  });

  await journey("unauthorized", async () => {
    const { context, page } = await open(browser, "stranger", conversations.unauthorized);
    const confirm = await send(page, "أكد استلام الطلب");
    expectNoText(confirm, /تم تأكيد الاستلام|اكتمل الطلب/u, "stranger chat confirmation");
    // The stranger's own signed-in session, sent from the browser context.
    const forged = (await context.request.post(`${apiOrigin}/api/orders/${receiptOrder}/confirm`, {
      headers: { origin: apiOrigin, "content-type": "application/json" },
      data: { received: true, issue: null },
    })).status();
    if (![403, 404].includes(forged)) throw new Error(`a stranger's receipt call returned ${forged}`);
    const status = (await api("receiver", `/api/orders/${receiptOrder}`)).body?.status;
    await context.close();
    return { forgedStatus: forged, orderStatusAfter: status };
  });

  await journey("buyerReceipt", async () => {
    const { context, page } = await open(browser, "receiver", conversations.receipt);
    const status = await send(page, "حالة طلبي");
    const button = status.locator.getByTestId("button-confirm-receipt");
    await button.waitFor({ timeout: 30_000 });
    await button.click();
    await page.getByRole("button", { name: "نعم، استلمته" }).click();
    await status.locator.getByText("أكدت الاستلام", { exact: false }).waitFor({ timeout: 30_000 });
    await page.screenshot({ path: `${out}/shots/receipt-confirmed-390.png` });
    await context.close();
    return { orderStatus: (await api("receiver", `/api/orders/${receiptOrder}`)).body?.status };
  });

  await journey("reloadKeepsTypedState", async () => {
    const { context, page } = await open(browser, "buyer", conversations.purchase);
    await assistants(page).first().waitFor();
    const count = await assistants(page).count();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("input-ai-composer").waitFor();
    await assistants(page).nth(count - 1).waitFor({ timeout: 30_000 });
    if ((await assistants(page).count()) !== count) throw new Error("message count changed across reload");
    // Executed reviews must not come back as live confirm buttons after a reload.
    const liveConfirms = await page.locator('[data-testid^="message-assistant-"] button:has-text("تأكيد الطلب"):enabled').count();
    if (liveConfirms) throw new Error(`${liveConfirms} executed reviews are confirmable again after reload`);
    await page.screenshot({ path: `${out}/shots/reload-390.png` });
    await context.close();
    return { messages: count };
  });

  await journey("negotiableListingAndCart", async () => {
    const { context, page } = await open(browser, "negotiator", conversations.negotiate);
    await send(page, `ابحث عن مكتب خشب ${token}`);
    const opened = await send(page, "الأول");
    await opened.locator.getByTestId("status-requires-agreement").waitFor({ timeout: 30_000 });
    if (await opened.locator.getByTestId("button-add-to-cart").count()) throw new Error("a negotiable listing offers add-to-cart");
    await page.screenshot({ path: `${out}/shots/negotiable-listing-390.png` });
    const before = await assistants(page).count();
    await opened.locator.getByTestId("button-request-best-price").click();
    await page.waitForFunction((count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > count, before, { timeout: 60_000 });
    await page.waitForTimeout(250);
    const review = { locator: assistants(page).last(), text: (await assistants(page).last().innerText()).replace(/\s+/g, " ") };
    expectText(review, /أفضل سعر/, "best-price request is a review for this listing");
    expectText(review, /مكتب خشب/, "the review names the listing in focus");
    await send(page, "إلغاء");
    const cart = await send(page, "اعرض السلة");
    const agreed = cart.locator.getByTestId(`status-cart-agreed-${listings.desk}`);
    await agreed.waitFor({ timeout: 30_000 });
    const unit = await cart.locator.getByTestId(`text-cart-unit-price-${listings.desk}`).innerText();
    if (!/35/.test(unit)) throw new Error(`the agreed line shows ${unit}, not the agreed 35`);
    await cart.locator.getByTestId(`status-cart-needs-agreement-${listings.chair}`).waitFor();
    const total = await cart.locator.getByTestId("text-cart-total").innerText();
    if (!/35\.000/.test(total)) throw new Error(`the total ${total} counts the unagreed line`);
    await cart.locator.getByTestId("text-cart-unpriced").waitFor();
    const checkout = cart.locator.getByTestId("button-cart-checkout");
    if (!(await checkout.isDisabled())) throw new Error("checkout is enabled with an unagreed negotiable line");
    await noOverflow(page, "negotiable cart@390");
    await page.screenshot({ path: `${out}/shots/negotiable-cart-390.png` });
    await cart.locator.getByTestId(`button-remove-${listings.chair}`).click();
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="button-cart-checkout"]')].at(-1)?.disabled === false,
      null,
      { timeout: 15_000 },
    );
    await context.close();
    const stored = (await api("negotiator", "/api/cart")).body ?? [];
    return { agreedUnit: unit.replace(/\s+/g, " "), cartAfter: stored.map((line) => [line.listingId === listings.desk ? "desk" : "other", line.unitPrice, line.agreedPrice === true]) };
  });

  await journey("mobileLayout", async () => {
    const result = {};
    for (const width of [320, 390, 768]) {
      const { context, page } = await open(browser, "buyer", conversations.purchase, width);
      await assistants(page).first().waitFor();
      await noOverflow(page, `purchase@${width}`);
      const composer = await page.getByTestId("input-ai-composer").boundingBox();
      if (!composer || composer.y + composer.height > (width < 768 ? 844 : 900)) throw new Error(`composer hidden at ${width}`);
      result[width] = "ok";
      await context.close();
    }
    return result;
  });
} finally {
  await browser.close();
}

report.summary = { journeys: Object.keys(report.journeys).length, failed, consoleErrors: [...new Set(consoleErrors)].slice(0, 20) };
await writeFile(resultPath, JSON.stringify(report, null, 2));
