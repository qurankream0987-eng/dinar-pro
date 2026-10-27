import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { MODEL_FALLBACK_REPLY } from "./sc-ui-session.mjs";

/**
 * SC01 end to end in the real DINAR UI, against the real API and a disposable database
 * (docs/dinar-next/DINAR_TEN_END_TO_END_ACCEPTANCE_SCENARIOS.md): a seller describes a used
 * phone in their own words, corrects one fact, reviews and publishes it from the chat; a second
 * user finds it, orders and chooses an allowed payment method; the seller accepts and records
 * the hand-off; the buyer confirms receipt; both reopen the app and see the same order.
 * Every phrase is the scenario's own wording; nothing is driven through the API that the UI
 * offers. The calling suite checks the database afterwards.
 */
const webBase = process.env.SC01_WEB_BASE;
const apiOrigin = process.env.SC01_API_ORIGIN;
const sellerCookie = process.env.SC01_SELLER_COOKIE;
const buyerCookie = process.env.SC01_BUYER_COOKIE;
const city = process.env.SC01_CITY;
const resultPath = process.env.SC01_UI_RESULT_PATH;
if (!webBase || !apiOrigin || !sellerCookie || !buyerCookie || !city || !resultPath)
  throw new Error("Missing SC01 browser journey configuration.");

const checks = [];
const steps = [];
const modelFallbacks = [];
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
let horizontalOverflow = 0;
let failure;
let browser;
let page;
let listingId;
let orderId;
const contexts = [];
const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
const fontHosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

async function settle() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const assistantMessages = () => page.locator('[data-testid^="message-assistant-"]');
const latestAssistant = () => assistantMessages().last();
async function waitForTurn(before) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
      document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    before,
    { timeout: 60_000 },
  );
  await settle();
}
async function sendTurn(text) {
  const before = await assistantMessages().count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await waitForTurn(before);
  const reply = latestAssistant();
  const shown = (await reply.innerText()).replace(/\s+/g, " ");
  steps.push({ said: text, reply: shown.slice(0, 240) });
  if (MODEL_FALLBACK_REPLY.test(shown)) modelFallbacks.push({ said: text, allowed: false });
  return reply;
}
async function clickTurn(locator) {
  const before = await assistantMessages().count();
  await locator.click();
  await waitForTurn(before);
  return latestAssistant();
}

async function measure(label, width, visible) {
  await page.setViewportSize({ width, height: 844 });
  await settle();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    direction: getComputedStyle(document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
  }));
  if (Math.max(dimensions.scrollWidth, dimensions.bodyScrollWidth) > dimensions.width) {
    horizontalOverflow += 1;
    throw new Error(`${label} ${width}px: horizontal overflow ${JSON.stringify(dimensions)}`);
  }
  assert.equal(dimensions.direction, "rtl", `${label} ${width}px must stay RTL`);
  await visible.scrollIntoViewIfNeeded();
  const box = await visible.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= dimensions.width + 0.5 && box.width > 0, `${label} ${width}px: content clipped ${JSON.stringify({ box, dimensions })}`);
  const buttons = await visible.locator("button:visible").evaluateAll((nodes) =>
    nodes
      .filter((node) => !node.closest('[role="region"][data-testid^="ai-results-carousel-"]'))
      .map((node) => ({ height: node.getBoundingClientRect().height, name: node.getAttribute("aria-label") || node.textContent?.trim() })),
  );
  assert.ok(buttons.every((button) => button.height >= 32), `${label} ${width}px: touch targets ${JSON.stringify(buttons)}`);
  assert.ok(buttons.every((button) => button.name), `${label} ${width}px: every button has an accessible name`);
  checks.push(`${label} ${width}px: RTL, no overflow, content and named buttons inside the viewport`);
}
/** The scenario's widths: 320 and 390 phones and a desktop window. */
async function widths(label, visible) {
  for (const width of [320, 390, 1280]) await measure(label, width, visible);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
}

async function newConversation() {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const button = page.locator('[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible').first();
  if (!(await button.isVisible())) await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await button.waitFor({ state: "visible" });
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ai/conversations" && response.request().method() === "POST");
  await button.click();
  assert.equal((await created).status(), 201);
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
}

async function openSession(cookie) {
  const context = await browser.newContext({ baseURL: webBase, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ar" });
  contexts.push(context);
  const separator = cookie.indexOf("=");
  await context.addCookies([
    { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: new URL(webBase).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false },
  ]);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"]) delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
  });
  const opened = await context.newPage();
  opened.on("pageerror", (error) => pageErrors.push(error.message));
  opened.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  opened.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || allowedHosts.has(url.host) || fontHosts.has(url.hostname)) return;
    externalRequests.push(`${url.hostname}${url.pathname}`);
  });
  return opened;
}

async function api(path, cookie) {
  const response = await fetch(`${apiOrigin}/api${path}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
}

/** Answers only what the draft still asks for, in the seller's words. */
async function finishDraft() {
  for (let turn = 0; turn < 8; turn += 1) {
    const text = await latestAssistant().innerText();
    if (/راجع بيانات المسودة|لن يُنشر العرض إلا/u.test(text) && !/ما المدينة|كيف تحب المشتري|وبالنسبة للدفع|ما الكمية/u.test(text)) return;
    if (/ما المدينة|المنطقة العامة/u.test(text)) await sendTurn(city);
    else if (/كيف تحب المشتري يتواصل/u.test(text)) await sendTurn("محادثة فقط");
    else if (/وبالنسبة للدفع/u.test(text)) await sendTurn("كاش");
    else if (/ما الكمية|قطعة واحدة، كمية محدودة/u.test(text)) await sendTurn("قطعة واحدة");
    else if (/كيف يحصل المشتري/u.test(text)) await sendTurn("استلام");
    else return;
  }
}

/** The order inside the chat: «طلباتي» → the order row → the order card with its next action. */
async function chatOrder(cookie) {
  page = await openSession(cookie);
  await newConversation();
  const history = await sendTurn("طلباتي");
  const row = history.getByTestId("order-result-1");
  await row.waitFor();
  await row.click();
  const panel = latestAssistant().getByTestId("panel-next-action");
  try {
    await panel.waitFor({ timeout: 30_000 });
  } catch (error) {
    const shown = (await latestAssistant().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
    throw new Error(`the order card in chat has no next action: ${shown}`, { cause: error });
  }
  return panel;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });

  // ── 1–6. Seller: own words → one draft → one corrected fact → review → publish ──
  page = await openSession(sellerCookie);
  await newConversation();
  await sendTurn("دينار أبي أبيع هاتفي المستعمل");
  await sendTurn("آيفون 13، 128 جيجا، مستعمل، البطارية 86٪، ومعه الشاحن");
  await sendTurn("بدي أبيعه ب 300 وقابل للتفاوض، عندي جهاز واحد، والاستلام في منطقتي");
  const corrected = await sendTurn("لا، البطارية 89٪");
  assert.doesNotMatch(await corrected.innerText(), /MODEL_FALLBACK/u, "the correction is handled by DINAR");
  await finishDraft();
  const reviewed = await sendTurn("اعرض الإعلان قبل النشر");
  const draftCard = reviewed.getByTestId("draft-review");
  await draftCard.waitFor();
  const draftText = await draftCard.innerText();
  assert.match(draftText, /89/u, "the review shows the corrected battery value");
  assert.doesNotMatch(draftText, /86٪/u, "the old value is gone");
  assert.match(draftText, /300/u);
  await widths("SC01 draft review", draftCard);
  checks.push("seller's own words filled one draft; «لا، البطارية 89٪» changed one fact; review shows it");

  const publishReview = await sendTurn("انشره");
  assert.match(await publishReview.innerText(), /هل تريد نشر الإعلان/u, "publishing needs an explicit confirmation");
  await widths("SC01 publish confirmation", publishReview);
  const published = await sendTurn("نعم");
  assert.match(await published.innerText(), /تم نشر الإعلان/u);
  const mine = await api("/listings?mine=1", sellerCookie);
  const ours = (Array.isArray(mine) ? mine : mine.listings ?? mine.items ?? []).filter((listing) => /آيفون 13|ايفون 13/u.test(listing.title ?? "") || /89/u.test(listing.description ?? ""));
  assert.equal(ours.length, 1, `exactly one listing: ${JSON.stringify(ours.map((listing) => listing.id))}`);
  listingId = ours[0].id;
  checks.push("seller confirmed «نعم»; exactly one listing exists");

  // A second «انشره» on the same, already published draft creates nothing and says so.
  const twice = await sendTurn("انشره");
  assert.match(await twice.innerText(), /منشور بالفعل/u, "a repeated publish is answered by DINAR, not the model");
  const again = await api("/listings?mine=1", sellerCookie);
  assert.equal((Array.isArray(again) ? again : again.listings ?? again.items ?? []).filter((listing) => listing.id !== listingId && /89/u.test(listing.description ?? "")).length, 0, "publishing twice creates no second listing");
  checks.push("a repeated «انشره» created no second listing");

  // ── 7–10. Buyer in another session: find → order → allowed payment ──
  page = await openSession(buyerCookie);
  await newConversation();
  const results = await sendTurn("أبي آيفون 13 مستعمل");
  await results.getByTestId("ai-results-list").waitFor();
  const shownIds = await results.locator('[data-testid^="card-ai-result-"]').evaluateAll((cards) => cards.map((card) => card.getAttribute("data-resource-id")));
  assert.ok(shownIds.includes(listingId), `the published listing is found by another user: ${JSON.stringify(shownIds)}`);
  const resultsText = await results.innerText();
  assert.doesNotMatch(resultsText, /07\d{8}|\+962/u, "the seller's phone number is not shown");
  await widths("SC01 buyer results", results.getByTestId("ai-results-list"));
  checks.push("another user found the listing in chat; no seller phone is exposed");

  // The seller said «قابل للتفاوض»: buying needs an agreed price first (the scenario's
  // «شراء أو قدّم عرضًا بحسب النمط»). Offer → seller accepts in their chat → buy at the agreement.
  const ordinal = `${["الأول", "الثاني", "الثالث", "الرابع", "الخامس"][shownIds.indexOf(listingId)]}`;
  const direct = await sendTurn(`أبي ${ordinal}`);
  assert.match(await direct.innerText(), /قابل للتفاوض|اتفق مع البائع/u, "a negotiable listing is not bought at the asking price without an agreement");
  const offer = await sendTurn("اعرض عليه 280");
  assert.match(await offer.innerText(), /280/u);
  assert.match(await offer.innerText(), /لن يُرسل شيء قبل تأكيدك|قبل إرساله/u, "an offer is reviewed before it is sent");
  await widths("SC01 offer review", offer);
  await sendTurn("إرسال العرض");
  checks.push("buyer reviewed and sent one offer of 280");

  const buyerPage = page;
  page = await openSession(sellerCookie);
  await newConversation();
  const incoming = await sendTurn("هل عندي عروض؟");
  assert.match(await incoming.innerText(), /280/u, "the seller sees the buyer's offer");
  await sendTurn("الأول");
  const acceptReview = await sendTurn("اقبل العرض");
  assert.match(await acceptReview.innerText(), /280/u, "the acceptance review names the exact offer");
  const accepted = await sendTurn("نعم");
  assert.doesNotMatch(await accepted.innerText(), /تعذر|غير متاح/u);
  checks.push("seller accepted exactly 280 after a review");

  page = buyerPage;
  const item = await sendTurn(`أبي ${ordinal}`);
  const purchase = item.getByTestId("purchase-review");
  await purchase.waitFor();
  assert.match(await purchase.innerText(), /280/u, "the review shows the agreed price from the server");
  let orderReview = await clickTurn(purchase.getByTestId("purchase-continue"));
  await orderReview.getByTestId("purchase-review").waitFor();
  const fulfilment = orderReview.locator('[data-testid^="purchase-fulfilment-"]').first();
  if (await fulfilment.count()) {
    await clickTurn(fulfilment);
    orderReview = latestAssistant();
  }
  await widths("SC01 order review", orderReview.getByTestId("purchase-review"));
  const placed = await clickTurn(orderReview.getByTestId("purchase-confirm"));
  assert.match(await placed.innerText(), /تم إنشاء الطلب/u);
  const buyerOrders = await api("/orders?role=buyer", buyerCookie);
  const order = buyerOrders.find((row) => row.listingId === listingId || row.items?.some((line) => line.listingId === listingId));
  assert.ok(order, "the buyer's order references the published listing");
  orderId = order.id;
  assert.equal(buyerOrders.filter((row) => row.listingId === listingId || row.items?.some((line) => line.listingId === listingId)).length, 1, "one order");
  checks.push("buyer reviewed the server price and placed exactly one order");

  const payment = await sendTurn("ادفع");
  let paymentReview = payment.getByTestId("purchase-review");
  await paymentReview.waitFor();
  assert.match(await paymentReview.innerText(), /SIMULATION_ONLY|كاش/u);
  const cash = paymentReview.getByTestId("purchase-payment-CASH_DIRECT");
  assert.ok(await cash.count(), "the seller's own payment choice (cash) is offered");
  await clickTurn(cash);
  paymentReview = latestAssistant().getByTestId("purchase-review");
  const paid = await clickTurn(paymentReview.getByTestId("purchase-confirm"));
  assert.match(await paid.innerText(), /لم تُحوَّل|خارج|كاش/u, "a direct payment is never shown as money collected by DINAR");
  checks.push("buyer chose cash; DINAR did not claim to collect money");

  // ── 10. Seller accepts and records the hand-off; buyer confirms receipt ──
  let panel = await chatOrder(sellerCookie);
  assert.match(await panel.innerText(), /رسوم بدينار/u, "the commission is disclosed before the seller accepts");
  await widths("SC01 seller order card", panel);
  await panel.getByTestId("button-accept-order").click();
  await page.getByTestId("input-delivery-proof").waitFor({ timeout: 30_000 });
  // The buyer chose personal pickup: the card says what comes first and does not offer a
  // hand-off the server would refuse.
  const first = page.getByTestId("text-handoff-prerequisite");
  await first.waitFor({ timeout: 30_000 });
  assert.match(await first.innerText(), /جاهز للاستلام/u);
  await page.getByTestId("input-delivery-proof").fill(`تسليم يد بيد في ${city}`);
  assert.equal(await page.getByTestId("button-mark-delivered").isDisabled(), true, "no hand-off before the order is ready");
  checks.push("seller accepted from the order card; the card named the next step instead of offering a refused hand-off");

  const ready = await sendTurn("جاهز للاستلام");
  assert.match(await ready.innerText(), /جاهز للاستلام/u);
  const readyConfirmed = await sendTurn("نعم");
  assert.match(await readyConfirmed.innerText(), /حالة التسليم الآن: جاهز للاستلام/u, "the pickup is marked ready after «نعم»");
  panel = await chatOrder(sellerCookie);
  await page.getByTestId("input-delivery-proof").fill(`تسليم يد بيد في ${city}`);
  await page.getByTestId("button-mark-delivered").click();
  await page.getByRole("button", { name: "نعم، تم التسليم" }).click();
  await page.waitForFunction(async (id) => {
    const response = await fetch(`/api/orders/${id}`);
    return response.ok && (await response.json()).status === "SELLER_MARKED_DELIVERED";
  }, orderId, { timeout: 30_000 });
  checks.push("seller accepted the order and recorded the hand-off from the order card in chat");

  panel = await chatOrder(buyerCookie);
  assert.match(await page.getByTestId("text-delivery-proof").innerText(), new RegExp(city, "u"), "the buyer sees the seller's proof");
  await widths("SC01 buyer receipt", panel);
  await page.getByTestId("button-confirm-receipt").click();
  await page.getByRole("button", { name: "نعم، استلمته" }).click();
  await page.waitForFunction(async (id) => {
    const response = await fetch(`/api/orders/${id}`);
    return response.ok && (await response.json()).status === "COMPLETED";
  }, orderId, { timeout: 30_000 });
  checks.push("buyer confirmed receipt; the order is COMPLETED");

  // ── 11. Both come back in a fresh browser and see the same order, not a new one ──
  page = await openSession(buyerCookie);
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const history = await sendTurn("طلباتي");
  await history.getByTestId("order-result-1").waitFor();
  const buyerAfter = await api("/orders?role=buyer", buyerCookie);
  assert.equal(buyerAfter.filter((row) => row.id === orderId).length, 1);
  assert.equal(buyerAfter.find((row) => row.id === orderId).status, "COMPLETED");
  page = await openSession(sellerCookie);
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const sellerHistory = await sendTurn("طلباتي");
  await sellerHistory.getByTestId("order-result-1").waitFor();
  assert.match(await sellerHistory.innerText(), /مكتمل/u, "the seller sees the order completed");
  const sellerAfter = await api("/orders?role=seller", sellerCookie);
  assert.equal(sellerAfter.filter((row) => row.id === orderId).length, 1);
  checks.push("after reopening, buyer and seller see the same completed order");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify({ failure, listingId, orderId, checks, steps, modelFallbacks, pageErrors, consoleErrors, externalRequests, horizontalOverflow }, null, 2),
  );
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
