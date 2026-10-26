import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const webBase = process.env.CONTACT_WEB_BASE;
const apiOrigin = process.env.CONTACT_API_ORIGIN;
const cookie = process.env.CONTACT_COOKIE;
const accountPhone = process.env.CONTACT_ACCOUNT_PHONE;
const resultPath = process.env.CONTACT_RESULT_PATH;
if (![webBase, apiOrigin, cookie, accountPhone, resultPath].every(Boolean))
  throw new Error("Missing contact browser test configuration.");

const consoleErrors = [];
const consoleTexts = [];
const providerRequests = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
});
const context = await browser.newContext({
  baseURL: webBase,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  locale: "ar",
});
const separator = cookie.indexOf("=");
await context.addCookies([{
  name: cookie.slice(0, separator),
  value: cookie.slice(separator + 1),
  domain: new URL(webBase).hostname,
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
  secure: false,
}]);
await context.route("**/api/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const headers = await req.allHeaders();
  for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"])
    delete headers[header];
  headers.origin = apiOrigin;
  headers.referer = `${apiOrigin}/`;
  await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
});
const page = await context.newPage();
page.on("pageerror", (error) => consoleErrors.push(error.message));
page.on("request", (request) => {
  if (/(openai|anthropic|groq|openrouter|stripe|paypal|twilio|vonage|checkout)/i.test(request.url()))
    providerRequests.push(new URL(request.url()).hostname);
});
page.on("console", (message) => {
  consoleTexts.push(message.text());
  if (message.type() === "error") consoleErrors.push(message.text());
});

const assistant = () => page.locator('[data-testid^="message-assistant-"]');
const latest = () => assistant().last();
async function sendTurn(text) {
  const before = await assistant().count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
      document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    before,
    { timeout: 45_000 },
  );
  return latest();
}
async function clickHelperChoice(message) {
  const before = await assistant().count();
  await page.getByTestId(`seller-helper-${message}`).click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > count,
    before,
    { timeout: 45_000 },
  );
  return latest();
}
async function startConversation() {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const newButton = page.locator(
    '[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible',
  ).first();
  if (!(await newButton.isVisible()))
    await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === "/api/ai/conversations" && item.request().method() === "POST",
  );
  await newButton.click();
  const body = await (await response).json();
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
  return body.id;
}
async function history(conversationId) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/ai/conversations/${id}`, { credentials: "include" });
    return { status: response.status, body: await response.json() };
  }, conversationId);
}
function blocksOf(data) {
  return data.messages.flatMap((message) => message.blocks ?? []);
}
function draftBlocks(data) {
  return blocksOf(data).filter((block) => block.payload?.draft?.draftId);
}
async function clickPublishReview() {
  const publish = latest().getByTestId("draft-publish");
  await publish.waitFor({ timeout: 20_000 });
  await publish.click();
  const review = latest();
  await review.getByTestId("pending-notice").waitFor();
  assert.match(await review.innerText(), /هل تريد نشر الإعلان/);
  return review;
}
async function publishConfirmed(review) {
  await review.getByTestId("draft-publish-confirm").click();
  await page.waitForFunction(
    () => /تم نشر الإعلان/.test(document.querySelectorAll('[data-testid^="message-assistant-"]')?.[document.querySelectorAll('[data-testid^="message-assistant-"]').length - 1]?.textContent ?? ""),
    null,
    { timeout: 45_000 },
  );
}

let report;
try {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const firstConversationId = await startConversation();
  await sendTurn("أبي أبيع آيفون 16 مستعمل نظيف بـ500 في عمان");
  await sendTurn("قطعة واحدة");
  assert.match(await latest().innerText(), /رقم حسابي المسجل/);
  const beforeContact = await history(firstConversationId);
  const initialDraft = draftBlocks(beforeContact.body).at(-1)?.payload.draft;
  assert.ok(initialDraft);
  await sendTurn("على رقمي");
  assert.match(await latest().innerText(), /موافقتك الصريحة/);
  const collisionHistory = await history(firstConversationId);
  const collisionDraft = draftBlocks(collisionHistory.body).at(-1)?.payload.draft;
  assert.deepEqual(
    [collisionDraft?.categoryId, collisionDraft?.title, collisionDraft?.unitPrice, collisionDraft?.availableQuantity],
    [initialDraft.categoryId, initialDraft.title, initialDraft.unitPrice, initialDraft.availableQuantity],
    "contact/category word collision did not alter existing listing facts",
  );
  await sendTurn("نعم");
  assert.match(await latest().innerText(), /طرق الدفع/);
  const sellerHelper = page.getByTestId("seller-manual-helper");
  assert.equal(await sellerHelper.getAttribute("open"), null, "the optional helper starts collapsed");
  await sellerHelper.locator("summary").click();
  await page.screenshot({ path: "/tmp/dinar-seller-payment-helper.png", fullPage: true });
  await clickHelperChoice("كاش");
  const paymentDraft = draftBlocks((await history(firstConversationId)).body).at(-1)?.payload.draft;
  assert.deepEqual(paymentDraft?.paymentMethods, ["CASH_DIRECT"]);
  let firstHistory = await history(firstConversationId);
  assert.equal(firstHistory.status, 200);
  let firstDrafts = draftBlocks(firstHistory.body);
  assert.ok(firstDrafts.length > 0);
  const accountDraftIds = [...new Set(firstDrafts.map((block) => block.payload.draft.draftId))];
  const approval = firstDrafts.find((block) => block.payload.draft.contactPreference === "ACCOUNT_PHONE");
  assert.ok(approval, "canonical account-phone approval persisted");
  const approvedDraft = approval.payload.draft;
  assert.equal(approvedDraft.contactPhone, undefined);
  const approvalText = JSON.stringify(approval.payload);
  assert.ok(!approvalText.includes(accountPhone), "account phone absent from persisted draft/review text");
  assert.equal(approvedDraft.contactPreference, "ACCOUNT_PHONE");
  const firstOfferBeforePublish = await page.evaluate(async () => {
    const response = await fetch("/api/listings?own=true", { credentials: "include" });
    return (await response.json()).length;
  });
  assert.equal(firstOfferBeforePublish, 0, "contact approval did not publish");

  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  await latest().getByTestId("draft-review").waitFor({ timeout: 20_000 });
  await sendTurn("كمل الإعلان");
  firstHistory = await history(firstConversationId);
  firstDrafts = draftBlocks(firstHistory.body);
  const afterReloadIds = [...new Set(firstDrafts.map((block) => block.payload.draft.draftId))];
  assert.deepEqual(afterReloadIds, accountDraftIds, "same draft resumes; no duplicate draft");
  assert.ok(firstDrafts.some((block) => block.payload.draft.contactPreference === "ACCOUNT_PHONE"));
  assert.ok(!JSON.stringify(firstHistory.body).includes(accountPhone));
  await sendTurn("محادثة فقط");
  firstHistory = await history(firstConversationId);
  const conversationOnlyDraft = draftBlocks(firstHistory.body).at(-1)?.payload.draft;
  assert.equal(conversationOnlyDraft.contactPreference, "CHAT_ONLY");
  assert.equal(conversationOnlyDraft.contactPhone, undefined);
  assert.ok(!JSON.stringify(firstHistory.body).includes(accountPhone));

  const secondConversationId = await startConversation();
  await sendTurn("أبي أبيع سماعة جديدة بـ30 في عمان");
  await sendTurn("قطعة واحدة");
  assert.match(await latest().innerText(), /رقم حسابي المسجل/);
  await sendTurn("التواصل على رقمي");
  assert.match(await latest().innerText(), /موافقتك الصريحة/);
  await sendTurn("لا، استخدم هذا الرقم 60000001");
  let alternateHistory = await history(secondConversationId);
  assert.equal(alternateHistory.status, 200);
  let alternateDraft = draftBlocks(alternateHistory.body).at(-1)?.payload.draft;
  assert.ok(alternateDraft, "alternate-phone draft remains active");
  assert.equal(alternateDraft.contactPreference, "LISTING_PHONE");
  assert.equal(alternateDraft.contactPhone, "60000001");
  assert.notEqual(alternateDraft.contactPhone, accountPhone);
  assert.equal(alternateDraft.draftId, draftBlocks(alternateHistory.body)[0].payload.draft.draftId);
  await sendTurn("كاش");
  const sellerPublishSummary = await latest().innerText();
  assert.match(sellerPublishSummary, /كاش/);
  assert.match(sellerPublishSummary, /عمان/);
  await page.screenshot({ path: "/tmp/dinar-seller-publish-summary.png", fullPage: true });
  const review = await clickPublishReview();
  await page.screenshot({ path: "/tmp/dinar-seller-publish-confirmation.png", fullPage: true });
  const myBeforeConfirm = await page.evaluate(async () => {
    const response = await fetch("/api/listings?own=true", { credentials: "include" });
    return (await response.json()).length;
  });
  assert.equal(myBeforeConfirm, 0, "alternate contact review did not publish");
  await publishConfirmed(review);
  const myListings = await page.evaluate(async () => {
    const response = await fetch("/api/listings?own=true", { credentials: "include" });
    return response.json();
  });
  assert.equal(myListings.length, 1);
  assert.equal(myListings[0].contactPhone, "60000001");
  assert.deepEqual(myListings[0].paymentMethods, ["CASH_DIRECT"]);
  assert.ok(!String(myListings[0].description).includes(accountPhone));

  const categoryConversationId = await startConversation();
  await sendTurn("أبي أبيع منتج رقمي بـ20 في عمان");
  const categoryHistory = await history(categoryConversationId);
  let categoryDraft = draftBlocks(categoryHistory.body).at(-1)?.payload.draft;
  assert.equal(categoryDraft?.categoryId, "digital-services", "seller intent still recognizes the digital category");
  await sendTurn("هذا منتج رقمي");
  const categoryAfterPhrase = await history(categoryConversationId);
  categoryDraft = draftBlocks(categoryAfterPhrase.body).at(-1)?.payload.draft;
  assert.equal(categoryDraft?.categoryId, "digital-services", "ordinary digital-product wording remains category intent");
  assert.equal(categoryDraft?.draftId, draftBlocks(categoryHistory.body).at(-1)?.payload.draft.draftId);
  assert.deepEqual(
    [categoryDraft?.title, categoryDraft?.unitPrice],
    [draftBlocks(categoryHistory.body).at(-1)?.payload.draft.title, draftBlocks(categoryHistory.body).at(-1)?.payload.draft.unitPrice],
  );

  const openToOffersConversationId = await startConversation();
  await sendTurn("أبي أبيع طاولة مستعملة في عمان بدون سعر");
  const openToOffersHistory = await history(openToOffersConversationId);
  const openToOffersDraft = draftBlocks(openToOffersHistory.body).at(-1)?.payload.draft;
  assert.equal(openToOffersDraft?.pricingMode, "OPEN_TO_OFFERS");
  assert.equal(openToOffersDraft?.unitPrice ?? null, null);
  assert.doesNotMatch(await latest().innerText(), /0\.000\s*JOD|0\.000\s*د\.أ/);
  await page.screenshot({ path: "/tmp/dinar-seller-open-to-offers.png", fullPage: true });

  const authPhoneInConsole = consoleTexts.some((text) => text.includes(accountPhone));
  assert.equal(authPhoneInConsole, false, "auth phone absent from browser console");
  assert.equal(consoleTexts.some((text) => text.includes("60000001")), false, "alternate phone absent from browser console");
  assert.deepEqual(providerRequests, [], "no live AI/payment/SMS provider requests");
  assert.deepEqual(consoleErrors, [], "browser console and page errors");
  report = {
    approvalSurvivedReload: true,
    draftSurvivedReload: true,
    accountDraftIds,
    firstConversationId,
    alternateNumber: "60000001",
    alternatePublishedCorrectly: true,
    accountPhonePublishedDescription: false,
    accountPhoneCopiedToDraftText: false,
    accountPhoneInConsole: authPhoneInConsole,
    conversationOnly: true,
    categoryCollision: true,
    paymentPreference: true,
    helperSecondary: true,
    openToOffers: true,
    autoPublished: false,
    providerRequests,
    consoleErrors,
  };
} catch (error) {
  report = { failure: error instanceof Error ? error.message : String(error), consoleErrors };
} finally {
  await writeFile(resultPath, JSON.stringify(report));
  await context.close();
  await browser.close();
}
