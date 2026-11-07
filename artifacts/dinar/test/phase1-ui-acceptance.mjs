import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const webBase = process.env.PHASE1_WEB_BASE;
const apiOrigin = process.env.PHASE1_API_ORIGIN;
const sessionCookie = process.env.PHASE1_COOKIE;
const goldenBuyerCookie = process.env.PHASE1_GOLDEN_BUYER_COOKIE;
const goldenContactPhone = process.env.PHASE1_GOLDEN_CONTACT_PHONE;
const initialConversationIds = new Set(
  JSON.parse(process.env.PHASE1_INITIAL_CONVERSATION_IDS ?? "[]"),
);
const expectedInitialCarIds = JSON.parse(
  process.env.PHASE1_EXPECTED_INITIAL_CAR_IDS ?? "[]",
);
const expectedCarIds = JSON.parse(process.env.PHASE1_EXPECTED_CAR_IDS ?? "[]");
const expectedPropertyId = process.env.PHASE1_EXPECTED_PROPERTY_ID;
const expectedGenericTableId = process.env.PHASE1_EXPECTED_GENERIC_TABLE_ID;
const expectedGenericServiceId = process.env.PHASE1_EXPECTED_GENERIC_SERVICE_ID;
const expectedAgriculturalId = process.env.PHASE1_EXPECTED_AGRICULTURAL_ID;
const resultPath = process.env.PHASE1_UI_RESULT_PATH;

if (
  !webBase ||
  !apiOrigin ||
  !sessionCookie ||
  !goldenBuyerCookie ||
  !goldenContactPhone ||
  !resultPath
)
  throw new Error("Missing phase-one browser acceptance configuration.");

const checks = [];
const pageErrors = [];
const consoleErrors = [];
/** Diagnostics only: which response produced a «Failed to load resource» console error. */
const failedResponses = [];
const expectedMarketConversationConflicts = [];
let browser;
let context;
let page;
const browserContexts = [];
let publishedOfferId;
let photoOfferId;
const publishedOfferIds = [];
const uploadedPhotoPaths = [];
let goldenOrderId;
let failure;

async function conversations(forContext = context) {
  const response = await forContext.request.get(
    `${apiOrigin}/api/ai/conversations`,
  );
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

async function openAuthenticatedSession(cookie) {
  const sessionContext = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 1440, height: 900 },
    isMobile: true,
    hasTouch: true,
  });
  const equalsIndex = cookie.indexOf("=");
  assert.ok(equalsIndex > 0, "expected a named session cookie");
  await sessionContext.addCookies([
    {
      name: cookie.slice(0, equalsIndex),
      value: cookie.slice(equalsIndex + 1),
      domain: new URL(webBase).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);

  const sessionPage = await sessionContext.newPage();
  sessionPage.on("pageerror", (error) => pageErrors.push(error.message));
  sessionPage.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
      let source = message.location().url;
      try { const url = new URL(source); source = url.origin + url.pathname; } catch {}
      failedResponses.push(`CONSOLE_ERROR ${source}: ${message.text()}`);
    }
  });
  sessionPage.on("requestfailed", (request) => {
    const error = request.failure()?.errorText ?? "unknown";
    // Navigation/Stop intentionally abort in-flight reads; retain actionable transport diagnostics.
    if (error === "net::ERR_ABORTED") return;
    const url = new URL(request.url());
    failedResponses.push(`REQUEST_FAILED ${request.method()} ${url.origin}${url.pathname}: ${error}`);
  });
  sessionPage.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${response.url().slice(0, 160)}`);
    const path = new URL(response.url()).pathname;
    if (
      response.request().method() === "GET" &&
      response.status() === 409 &&
      /^\/api\/ai\/conversations\/[^/]+$/.test(path)
    )
      expectedMarketConversationConflicts.push(path);
  });
  await sessionContext.route("**/api/**", async (route) => {
    try {
      await proxyApi(route);
    } catch (error) {
      // Diagnostics only: the error is recorded and rethrown, so behaviour is unchanged.
      failedResponses.push(`ROUTE_ERROR ${route.request().method()} ${new URL(route.request().url()).pathname}: ${String(error?.message ?? error).slice(0, 200)}`);
      throw error;
    }
  });
  async function proxyApi(route) {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of [
      "host",
      "origin",
      "referer",
      "content-length",
      "sec-fetch-site",
    ])
      delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    const response = await route.fetch({
      url: `${apiOrigin}${requestUrl.pathname}${requestUrl.search}`,
      headers,
    });
    if (
      requestUrl.pathname === "/api/listings" &&
      request.method() === "POST" &&
      response.status() === 201
    ) {
      const created = JSON.parse((await response.body()).toString());
      publishedOfferId = created.id;
      publishedOfferIds.push(created.id);
    }
    if (
      requestUrl.pathname === "/api/account/listing-photos/complete" &&
      request.method() === "POST" &&
      response.ok()
    ) {
      try {
        const completionBody = (await response.body()).toString();
        let completed;
        try {
          completed = JSON.parse(completionBody);
        } catch {
          completed = completionBody.trim();
        }
        const objectPath =
          typeof completed === "string"
            ? completed
            : completed.objectPath ?? completed.path;
        if (typeof objectPath === "string")
          uploadedPhotoPaths.push(objectPath);
      } catch {
        // The published listing and saved AI draft provide a second cleanup path.
      }
    }
    await route.fulfill({ response });
  }
  browserContexts.push(sessionContext);

  const identity = await sessionContext.request.get(
    `${apiOrigin}/api/auth/me`,
  );
  assert.equal(identity.status(), 200);
  assert.ok((await identity.json()).user, "browser session must be authenticated");
  await sessionPage.goto("/");
  await sessionPage.getByTestId("input-ai-composer").waitFor();
  return { context: sessionContext, page: sessionPage };
}

async function sendTurn(text) {
  const composer = page.getByTestId("input-ai-composer");
  const send = page.getByTestId("button-send-ai-message");
  await composer.fill(text);
  await send.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="button-send-ai-message"]')
        ?.getAttribute("aria-label") === "إرسال الرسالة",
    null,
    { timeout: 60_000 },
  );
  await page
    .locator('[data-testid^="message-user-"]')
    .filter({ hasText: text })
    .last()
    .waitFor();
}

async function latestResultIds() {
  const assistant = page.locator('[data-testid^="message-assistant-"]').last();
  return assistant
    .locator('[data-testid^="card-ai-result-"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-testid").slice(15)),
    );
}

async function assertResponsive(label, width, height, visibleLocator) {
  await page.setViewportSize({ width, height });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    direction: getComputedStyle(
      document.querySelector(".dinar-chatgpt") ?? document.documentElement,
    ).direction,
  }));
  assert.ok(
    dimensions.scrollWidth <= dimensions.width,
    `${label}: horizontal overflow ${JSON.stringify(dimensions)}`,
  );
  assert.equal(
    dimensions.direction,
    "rtl",
    `${label}: chat surface must retain RTL direction`,
  );
  if (visibleLocator) {
    await visibleLocator.scrollIntoViewIfNeeded();
    // The chat thread scrolls smoothly; measure once the position has settled.
    let target = await visibleLocator.boundingBox();
    for (let frame = 0; frame < 40; frame += 1) {
      await page.waitForTimeout(50);
      const next = await visibleLocator.boundingBox();
      const settled = next && target && next.y === target.y && next.x === target.x;
      target = next;
      if (settled) break;
    }
    assert.ok(
      target &&
        target.x >= 0 &&
        target.x + target.width <= dimensions.width &&
        target.y >= 0 &&
        target.y + target.height <= dimensions.height,
      `${label}: key control is outside the viewport ${JSON.stringify({
        dimensions,
        target,
      })}`,
    );
  }
  const composer = await page.getByTestId("input-ai-composer").boundingBox();
  assert.ok(
    composer &&
      composer.y >= 0 &&
      composer.y + composer.height <= dimensions.height,
    `${label}: composer is obscured ${JSON.stringify({ dimensions, composer })}`,
  );
  checks.push(`${label}: no horizontal overflow and composer visible`);
}

async function assertMobileWidths(label, visibleLocator) {
  for (const width of [320, 360, 390, 414])
    await assertResponsive(`${label} ${width}px`, width, 844, visibleLocator);
}

async function selectMarket(marketId) {
  const sidebar = page.locator('#ai-conversation-history');
  if (!(await sidebar.isVisible()))
    await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await page.getByTestId("button-market").click();
  const marketOption = page.getByTestId(`button-market-${marketId}`);
  await marketOption.waitFor();
  if ((await marketOption.getAttribute("aria-checked")) === "true") {
    await marketOption.click();
    await page.getByTestId("sheet-market").waitFor({ state: "hidden" });
    return;
  }
  await marketOption.click();
  const changed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/account/market" &&
      response.request().method() === "PATCH",
  );
  const accountRefresh = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/me" &&
      response.status() === 200,
  );
  await page.getByTestId("button-confirm-market").click();
  const [response] = await Promise.all([changed, accountRefresh]);
  assert.equal(response.status(), 200, await response.text());
  await page.waitForLoadState("networkidle", { timeout: 10_000 });
}

async function startNewConversation() {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const newConversationButton = page.locator('[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible').first();
  if (!(await newConversationButton.isVisible())) {
    await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  }
  await newConversationButton.waitFor({ state: "visible" });
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ai/conversations" &&
      response.request().method() === "POST",
  );
  await newConversationButton.click();
  const response = await created;
  const conversation = await response.json();
  assert.equal(response.status(), 201, JSON.stringify(conversation));
  await page
    .getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true })
    .waitFor({ state: "visible" });
  return conversation.id;
}

async function ownListingIds() {
  const response = await context.request.get(`${apiOrigin}/api/listings?own=true`);
  assert.equal(response.status(), 200, await response.text());
  return (await response.json()).map((listing) => listing.id);
}

/**
 * The approved publish path: «نشر العرض» opens the conversation's publish review, nothing is
 * published until «تأكيد النشر», and the confirmed turn creates exactly one listing.
 */
async function publishThroughConversation(publishButton, { tap = false } = {}) {
  const before = new Set(await ownListingIds());
  if (tap) await publishButton.tap();
  else await publishButton.click();
  const confirm = page
    .locator('[data-testid^="message-assistant-"]')
    .last()
    .getByTestId("draft-publish-confirm");
  await confirm.waitFor({ timeout: 45_000 });
  assert.deepEqual(
    (await ownListingIds()).filter((id) => !before.has(id)),
    [],
    "the publish review alone must not publish",
  );
  if (tap) await confirm.tap();
  else await confirm.click();
  await page.waitForFunction(
    () =>
      /تم نشر الإعلان/.test(
        [...document.querySelectorAll('[data-testid^="message-assistant-"]')].at(-1)?.textContent ?? "",
      ),
    null,
    { timeout: 45_000 },
  );
  const created = (await ownListingIds()).filter((id) => !before.has(id));
  assert.equal(created.length, 1, "one confirmed publish creates exactly one listing");
  publishedOfferId = created[0];
  publishedOfferIds.push(created[0]);
  return created[0];
}

async function conversationMessages(conversationId) {
  const response = await context.request.get(
    `${apiOrigin}/api/ai/conversations/${conversationId}`,
  );
  assert.equal(response.status(), 200, await response.text());
  return (await response.json()).messages;
}

/** The stored assistant reply to the latest user turn (waits until it is persisted). */
async function latestAssistantBody(conversationId, userTurns) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const messages = await conversationMessages(conversationId);
    if (
      messages.filter((message) => message.actor === "USER").length >= userTurns &&
      messages.at(-1)?.actor === "ASSISTANT"
    )
      return messages.at(-1).body ?? "";
    assert.ok(Date.now() < deadline, "the assistant reply was not stored in time");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Answers whatever the canonical draft asks next (its step order is owned by the draft
 * authority, not by this script) until the publish button appears.
 */
async function answerDraftQuestions(conversationId, userTurns, answers, publishButton) {
  const used = new Map();
  for (let step = 0; step < 12; step += 1) {
    const question = await latestAssistantBody(conversationId, userTurns + step);
    if (await publishButton.isVisible()) break;
    const match = answers.find(([pattern]) => pattern.test(question));
    assert.ok(match, `unexpected draft question: ${question.slice(0, 300)}`);
    used.set(match[1], (used.get(match[1]) ?? 0) + 1);
    if (used.get(match[1]) > 1) {
      const transcript = (await conversationMessages(conversationId))
        .map((message) => `${message.actor}: ${String(message.body).slice(0, 160)}`)
        .join(" | ");
      assert.fail(`the draft asked again after «${match[1]}»: ${transcript}`);
    }
    await sendTurn(match[1]);
  }
  await publishButton.waitFor();
}

async function publishGenericListing(initialPrompt, answers, expectedTitle) {
  const conversationId = await startNewConversation();
  await sendTurn(initialPrompt);
  const publishButton = page.getByRole("button", {
    name: "نشر العرض",
    exact: true,
  });
  await answerDraftQuestions(conversationId, 1, answers, publishButton);
  await publishButton.scrollIntoViewIfNeeded();
  const id = await publishThroughConversation(publishButton, { tap: true });
  assert.ok(id, "generic publish should return a persisted offer id");
  const opened = await context.request.get(`${apiOrigin}/api/listings/${id}`);
  assert.equal(opened.status(), 200, await opened.text());
  const listing = await opened.json();
  assert.equal(listing.title, expectedTitle);
  assert.equal(listing.categoryId, "other");
  checks.push("unknown product reviewed and explicitly published as a generic offer");
  return id;
}

async function searchAndOpenGeneric(query, id, expectedTitle) {
  await startNewConversation();
  await sendTurn(query);
  const resultCard = page.getByTestId(`card-ai-result-${id}`);
  await resultCard.waitFor();
  assert.match(await resultCard.innerText(), new RegExp(expectedTitle));
  await page.getByTestId(`button-open-result-${id}`).click();
  await page.getByRole("button", { name: "إغلاق التفاصيل" }).last().waitFor();
  // The opened detail lives in the latest results section (the context panel may repeat the query).
  await page.locator("section[data-result-set-id]").last().getByText(expectedTitle, { exact: true }).last().waitFor();
  checks.push(`generic search and detail opened for ${expectedTitle}`);
}

async function waitForPhotoUploadCount(expectedCount) {
  const deadline = Date.now() + 60_000;
  while (uploadedPhotoPaths.length < expectedCount && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    uploadedPhotoPaths.length >= expectedCount,
    `expected ${expectedCount} completed photo uploads; got ${uploadedPhotoPaths.length}`,
  );
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const sellerSession = await openAuthenticatedSession(sessionCookie);
  context = sellerSession.context;
  page = sellerSession.page;
  await assertResponsive("desktop", 1440, 900);
  await assertMobileWidths("chat home", page.getByTestId("input-ai-composer"));
  await assertResponsive("desktop after chat home", 1440, 900);

  await sendTurn("أريد مرسيدس");
  let ids = await latestResultIds();
  assert.ok(
    expectedInitialCarIds.every((id) => ids.includes(id)),
    "car search should render every acceptance fixture alongside normal seed results",
  );
  await sendTurn("2022 وفوق");
  await sendTurn("أقل من 20 ألف");
  ids = await latestResultIds();
  const refinedCarIds = [...ids];
  assert.deepEqual(
    ids.filter((id) => expectedInitialCarIds.includes(id)).sort(),
    [...expectedCarIds].sort(),
    "car refinements should retain only the expected acceptance fixtures",
  );
  const carConversation = (await conversations()).find(
    (item) => !initialConversationIds.has(item.id),
  );
  assert.ok(carConversation, "browser car search should create a saved conversation");
  await page.reload();
  await page.getByRole("log").getByText("أقل من 20 ألف", { exact: true }).waitFor();
  assert.deepEqual(
    await latestResultIds(),
    refinedCarIds,
    "saved car results and their order should return after reload",
  );
  checks.push("car search refinements and saved results survive reload");
  await assertMobileWidths(
    "buyer car results",
    page.getByTestId(`card-ai-result-${refinedCarIds[0]}`).last(),
  );
  await assertResponsive("desktop after car results", 1440, 900);

  await sendTurn("في عمان فقط");
  assert.equal(
    (await latestResultIds()).length,
    0,
    "city refinement should render its empty state",
  );
  checks.push("car city refinement reaches the visible empty state");

  await selectMarket("JO");
  await startNewConversation();
  await sendTurn("أريد شقة للإيجار في عمان غرفتين أقل من 350");
  ids = await latestResultIds();
  assert.ok(
    ids.includes(expectedPropertyId),
    "property search should render its acceptance fixture alongside normal seed results",
  );
  const savedPropertyIds = [...ids];
  const propertyConversation = (await conversations()).find(
    (item) =>
      !initialConversationIds.has(item.id) &&
      item.id !== carConversation.id,
  );
  assert.ok(propertyConversation, "browser property search should be saved");
  await page.reload();
  await page
    .getByRole("log")
    .getByText("أريد شقة للإيجار في عمان غرفتين أقل من 350", { exact: true })
    .waitFor();
  assert.deepEqual(
    await latestResultIds(),
    savedPropertyIds,
    "saved property results should return after reload",
  );
  await assertMobileWidths(
    "buyer property results",
    page.getByTestId(`card-ai-result-${expectedPropertyId}`),
  );
  checks.push("Jordan property search and visible result survive reload");

  await assertResponsive("desktop after property search", 1440, 900);
  await selectMarket("KW");
  await startNewConversation();
  for (const text of [
    "أريد أبيع كامري 2020",
    "مستعمل",
    "8500",
    "الممشى 90 ألف",
    "سيارة مستعملة بحالة جيدة، لون أبيض، وفحصها حديث.",
    "الشويخ",
    "محادثة فقط",
    "كاش", // payment methods, a draft step added after this suite was written
  ])
    await sendTurn(text);

  const publishButton = page.getByRole("button", {
    name: "نشر العرض",
    exact: true,
  });
  await publishButton.waitFor();
  await assertResponsive("desktop review", 1440, 900);
  await assertMobileWidths("seller listing review", publishButton);
  await publishButton.scrollIntoViewIfNeeded();
  const buttonBox = await publishButton.boundingBox();
  assert.ok(buttonBox && buttonBox.y + buttonBox.height <= 844);
  await publishThroughConversation(publishButton, { tap: true });
  assert.ok(publishedOfferId, "the confirmed publish should identify the new offer");
  await page.getByText(/كامري/).last().waitFor();
  const visibleOffer = await context.request.get(
    `${apiOrigin}/api/listings/${publishedOfferId}`,
  );
  assert.equal(visibleOffer.status(), 200);
  checks.push("mobile publish-button tap creates and opens the real offer");

  const soilOfferId = await publishGenericListing(
    "أريد أبيع جهاز قياس رطوبة للتربة",
    [
      [/اختر تصنيف/u, "أخرى"],
      [/صف العرض/u, "جهاز قياس رطوبة للتربة بحالة جيدة ويعمل بشكل طبيعي."],
      [/كيف تريد التسعير/u, "سعر ثابت"],
      [/ما السعر/u, "18"],
      [/الكمية/u, "2"],
      [/المنطقة|المدينة/u, "عمان"],
      [/التسليم|الاستلام|التوصيل/u, "استلام"],
      [/تواصل/u, "محادثة فقط"],
      [/دفع/u, "كاش"],
    ],
    "جهاز قياس رطوبة للتربة",
  );
  await searchAndOpenGeneric(
    "أريد جهاز قياس رطوبة للتربة",
    soilOfferId,
    "جهاز قياس رطوبة للتربة",
  );
  assert.ok(expectedGenericTableId);
  await searchAndOpenGeneric(
    "أريد طاولة خشب",
    expectedGenericTableId,
    "طاولة خشب مستعملة",
  );
  assert.ok(expectedGenericServiceId);
  await searchAndOpenGeneric(
    "أحتاج خدمة ترجمة",
    expectedGenericServiceId,
    "خدمة ترجمة",
  );
  assert.ok(expectedAgriculturalId);
  await searchAndOpenGeneric(
    "أريد مضخة مياه",
    expectedAgriculturalId,
    "مضخة مياه زراعية",
  );

  const managementConversationId = await startNewConversation();
  const managedOfferId = expectedAgriculturalId;
  assert.ok(managedOfferId, "generic fallback listing should be available to manage");
  const assistantMessages = page.locator('[data-testid^="message-assistant-"]');
  let assistantCount = await assistantMessages.count();
  await sendTurn("إعلاناتي");
  await page.waitForFunction(
    (previousCount) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length >
      previousCount,
    assistantCount,
  );
  let latestAssistant = assistantMessages.last();
  await latestAssistant
    .getByTestId(`chat-seller-listing-${managedOfferId}`)
    .waitFor();
  await assertMobileWidths(
    "seller my listings",
    latestAssistant.getByTestId(`chat-seller-listing-${managedOfferId}`),
  );
  await assertResponsive("desktop seller my listings", 1440, 900);
  const managedListingResponse = await context.request.get(
    `${apiOrigin}/api/listings/${managedOfferId}`,
  );
  assert.equal(managedListingResponse.status(), 200);
  const managedListing = await managedListingResponse.json();
  assistantCount = await assistantMessages.count();
  await sendTurn(`افتح إعلان ${managedListing.title}`);
  await page.waitForFunction(
    (previousCount) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length >
      previousCount,
    assistantCount,
  );
  latestAssistant = assistantMessages.last();
  checks.push(`seller listing selection: ${(await latestAssistant.innerText()).slice(0, 240)}`);
  const ambiguousHistoryResponse = await context.request.get(
    `${apiOrigin}/api/ai/conversations/${managementConversationId}`,
  );
  assert.equal(ambiguousHistoryResponse.status(), 200);
  const ambiguousHistory = await ambiguousHistoryResponse.json();
  const ambiguousPayload = ambiguousHistory.messages
    .at(-1)
    .blocks.find((block) => block.type === "SURFACE").payload;
  const matchingIndex = ambiguousPayload.resourceIds.indexOf(managedOfferId);
  assert.notEqual(
    matchingIndex,
    -1,
    "the matching seller result set should include the published listing",
  );
  const selectionPhrases = ["الأولى", "الثانية", "الثالثة"];
  assert.ok(matchingIndex < selectionPhrases.length);
  assistantCount = await assistantMessages.count();
  await sendTurn(selectionPhrases[matchingIndex]);
  await page.waitForFunction(
    (previousCount) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length >
      previousCount,
    assistantCount,
  );
  latestAssistant = assistantMessages.last();
  await latestAssistant
    .getByTestId(`chat-seller-listing-${managedOfferId}`)
    .waitFor();
  const nextPrice = Number(managedListing.unitPrice) + 1;
  assistantCount = await assistantMessages.count();
  await sendTurn(`غير السعر إلى ${nextPrice}`);
  await page.waitForFunction(
    (previousCount) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length >
      previousCount,
    assistantCount,
  );
  latestAssistant = assistantMessages.last();
  checks.push(`seller listing update: ${(await latestAssistant.innerText()).slice(0, 240)}`);
  const previewCard = latestAssistant.locator(
    '[data-testid^="listing-management-preview-"]',
  );
  await previewCard.waitFor();
  const previewTestId = await previewCard.getAttribute("data-testid");
  assert.ok(previewTestId);
  const previewId = previewTestId.replace(
    "listing-management-preview-",
    "",
  );
  const confirmPreviewButton = page.getByTestId(
    `button-confirm-listing-preview-${previewId}`,
  );
  await assertMobileWidths("seller edit confirmation action", confirmPreviewButton);
  await assertResponsive("desktop seller edit confirmation action", 1440, 900);
  const preConfirmation = await context.request.get(
    `${apiOrigin}/api/listings/${managedOfferId}`,
  );
  assert.equal(preConfirmation.status(), 200);
  assert.equal(
    Number((await preConfirmation.json()).unitPrice),
    Number(managedListing.unitPrice),
    "the conversational preview must not save before confirmation",
  );
  const actionResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/ai/listing-management-previews/${previewId}/action` &&
      response.request().method() === "POST",
  );
  await confirmPreviewButton.click();
  const confirmedResponse = await actionResponse;
  assert.equal(confirmedResponse.status(), 200, await confirmedResponse.text());
  const persistedListingResponse = await context.request.get(
    `${apiOrigin}/api/listings/${managedOfferId}`,
  );
  assert.equal(persistedListingResponse.status(), 200);
  const persistedListing = await persistedListingResponse.json();
  assert.equal(Number(persistedListing.unitPrice), nextPrice);
  const previewStatus = page
    .getByTestId(`status-listing-preview-${previewId}`)
    .getByText("تم تنفيذ الإجراء.");
  await previewStatus.waitFor();
  await page.reload();
  await previewStatus.waitFor();
  await assertMobileWidths("seller edit confirmation status", previewStatus);
  await assertResponsive("desktop seller edit confirmation status", 1440, 900);
  checks.push(
    "seller list opens the owned offer; preview requires confirmation and persists after reload",
  );

  const sendTurnAndWaitForAssistant = async (text) => {
    const previousCount = await assistantMessages.count();
    await sendTurn(text);
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('[data-testid^="message-assistant-"]').length >
        count,
      previousCount,
    );
    return assistantMessages.last();
  };
  const manageGenericStatus = async (
    command,
    expectedAction,
    beforeStatus,
    afterStatus,
  ) => {
    const statusConversationId = await startNewConversation();
    let assistant = await sendTurnAndWaitForAssistant("إعلاناتي");
    await assistant.getByTestId(`chat-seller-listing-${managedOfferId}`).waitFor();
    assistant = await sendTurnAndWaitForAssistant(
      `افتح إعلان ${managedListing.title}`,
    );
    await assistant
      .getByTestId(`chat-seller-listing-${managedOfferId}`)
      .waitFor();
    assistant = await sendTurnAndWaitForAssistant(command);
    const statusPreview = assistant.locator(
      '[data-testid^="listing-management-preview-"]',
    );
    await statusPreview.waitFor();
    const previewTestId = await statusPreview.getAttribute("data-testid");
    assert.ok(previewTestId);
    const previewId = previewTestId.replace(
      "listing-management-preview-",
      "",
    );
    const historyResponse = await context.request.get(
      `${apiOrigin}/api/ai/conversations/${statusConversationId}`,
    );
    assert.equal(historyResponse.status(), 200);
    const history = await historyResponse.json();
    const lastPayload = history.messages
      .at(-1)
      .blocks.find((block) => block.type === "SURFACE").payload;
    assert.equal(lastPayload.managementPreview.action, expectedAction);
    const before = await context.request.get(
      `${apiOrigin}/api/listings/${managedOfferId}`,
    );
    assert.equal(before.status(), 200);
    assert.equal((await before.json()).status, beforeStatus);
    const confirmButton = page.getByTestId(
      `button-confirm-listing-preview-${previewId}`,
    );
    await assertMobileWidths(`${expectedAction} confirmation action`, confirmButton);
    await assertResponsive(
      `desktop ${expectedAction} confirmation action`,
      1440,
      900,
    );
    const actionResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/ai/listing-management-previews/${previewId}/action` &&
        response.request().method() === "POST",
    );
    await confirmButton.click();
    const confirmedResponse = await actionResponse;
    assert.equal(confirmedResponse.status(), 200, await confirmedResponse.text());
    const after = await context.request.get(
      `${apiOrigin}/api/listings/${managedOfferId}`,
    );
    assert.equal(after.status(), 200);
    assert.equal((await after.json()).status, afterStatus);
    const confirmation = page
      .getByTestId(`status-listing-preview-${previewId}`)
      .getByText("تم تنفيذ الإجراء.");
    await confirmation.waitFor();
    await page.reload();
    await confirmation.waitFor();
    await assertMobileWidths(`${expectedAction} confirmation status`, confirmation);
    await assertResponsive(
      `desktop ${expectedAction} confirmation status`,
      1440,
      900,
    );
    checks.push(
      `generic fallback ${expectedAction.toLowerCase()} preview is confirmed and persists as ${afterStatus}`,
    );
  };
  await manageGenericStatus("وقف الإعلان", "PAUSE", "PUBLISHED", "PAUSED");
  await manageGenericStatus("رجع الإعلان", "RESUME", "PAUSED", "PUBLISHED");

  await selectMarket("JO");
  const photoConversationId = await startNewConversation();
  const uploadsBefore = uploadedPhotoPaths.length;
  await page.locator('input[type="file"]').first().setInputFiles([
    new URL("../../../docs/visual-qa/create-390.png", import.meta.url).pathname,
    new URL("../../../docs/visual-qa/create-dark-390.png", import.meta.url)
      .pathname,
  ]);

  const photoPrompt = `آيفون 15 برو 256 جيجا مستعمل نظيف، البطارية 91%، السعر 430 دينار، الكمية 1، موجود بعمان، رقم التواصل ${goldenContactPhone}`;
  await sendTurn(photoPrompt);
  await waitForPhotoUploadCount(uploadsBefore + 2);
  const photoPaths = uploadedPhotoPaths.slice(uploadsBefore);
  assert.equal(photoPaths.length, 2);
  const photoPublishButton = page.getByRole("button", {
    name: "نشر العرض",
    exact: true,
  });
  // The phone typed in the message is the listing contact; the draft asks only what is missing.
  await answerDraftQuestions(
    photoConversationId,
    1,
    [
      [/اختر تصنيف/u, "إلكترونيات"],
      [/موافقتك الصريحة/u, "نعم"],
      [/دفع/u, "كاش"],
      [/التسليم|الاستلام|التوصيل/u, "استلام"],
    ],
    photoPublishButton,
  );
  const reviewWorkflow = page.locator('[data-testid^="message-assistant-"]').last();

  const draftResponse = await context.request.get(
    `${apiOrigin}/api/ai/conversations/${photoConversationId}`,
  );
  assert.equal(draftResponse.status(), 200, await draftResponse.text());
  const draftConversation = await draftResponse.json();
  const draftSurface = draftConversation.messages
    .at(-1)
    .blocks.find((block) => block.type === "SURFACE");
  assert.equal(draftSurface?.payload.surface, "SELL");
  const draft = draftSurface.payload.draft;
  const draftMediaPaths = [
    draft.imageUrl,
    ...(Array.isArray(draft.imageUrls) ? draft.imageUrls : []),
  ].filter((path) => typeof path === "string");
  assert.equal(new Set(draftMediaPaths).size, 2);
  assert.ok(
    photoPaths.every((path) => draftMediaPaths.includes(path)),
    "both uploaded photos must be part of the same saved listing draft",
  );
  const photoToken = photoPaths[0].split("/").at(-1);
  const reviewImageSources = await reviewWorkflow
    .locator("img")
    .evaluateAll((images) =>
      images.map((image) => image.currentSrc || image.src),
    );
  assert.ok(
    reviewImageSources.some((src) => src.includes(photoToken)),
    "the listing review must display its primary uploaded photo",
  );
  checks.push(
    "two photos and the exact natural-language phone details reach one listing review; primary photo is visible",
  );

  await photoPublishButton.scrollIntoViewIfNeeded();
  photoOfferId = await publishThroughConversation(photoPublishButton);
  assert.ok(photoOfferId, "photo-first publish must create a real listing");
  const persistedPhotoResponse = await context.request.get(
    `${apiOrigin}/api/listings/${photoOfferId}`,
  );
  assert.equal(persistedPhotoResponse.status(), 200);
  const persistedPhotoOffer = await persistedPhotoResponse.json();
  assert.ok(persistedPhotoOffer.title.includes("آيفون 15 برو"));
  assert.equal(Number(persistedPhotoOffer.unitPrice), 430);
  assert.ok(
    JSON.stringify(persistedPhotoOffer).includes("91%"),
    "battery detail must remain in the published listing",
  );
  const publishedMediaPaths = [
    persistedPhotoOffer.imageUrl,
    ...(Array.isArray(persistedPhotoOffer.imageUrls)
      ? persistedPhotoOffer.imageUrls
      : []),
  ].filter((path) => typeof path === "string");
  assert.deepEqual(
    [...new Set(publishedMediaPaths)].sort(),
    [...new Set(photoPaths)].sort(),
    "the published offer must retain both uploaded photos",
  );
  const persistedLocation = `${persistedPhotoOffer.city ?? ""} ${
    persistedPhotoOffer.area ?? ""
  }`.replace(/[\u064B-\u065F\u0670]/g, "");
  assert.ok(
    persistedLocation.includes("عمان"),
    "Amman must be preserved as the listing city or area",
  );
  checks.push(
    "photo-first listing is explicitly published and persists both photos and parsed details",
  );

  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  const reloadedPhotoOffer = await context.request.get(
    `${apiOrigin}/api/listings/${photoOfferId}`,
  );
  assert.equal(reloadedPhotoOffer.status(), 200);
  checks.push("published photo-first offer remains available after page reload");

  const buyerSession = await openAuthenticatedSession(goldenBuyerCookie);
  context = buyerSession.context;
  page = buyerSession.page;
  await selectMarket("JO");
  await startNewConversation();
  await sendTurn("أريد آيفون 15 برو 256 جيجا مستعمل نظيف");
  const buyerResult = page.getByTestId(`card-ai-result-${photoOfferId}`);
  await buyerResult.waitFor({ timeout: 60_000 });
  await page.getByTestId(`button-open-result-${photoOfferId}`).click();
  await page.getByTestId("img-offer").waitFor();
  const galleryButtons = page.locator('button[aria-label^="الصورة "]');
  assert.equal(await galleryButtons.count(), 2);
  await assertMobileWidths(
    "buyer photo gallery",
    page.getByRole("button", { name: "الصورة 2" }),
  );
  await assertResponsive("desktop buyer photo gallery", 1440, 900);
  const offerImage = page.getByTestId("img-offer");
  await offerImage.scrollIntoViewIfNeeded();
  await offerImage.evaluate((image) => image.decode());
  assert.ok(await offerImage.evaluate((image) => image.complete && image.naturalWidth > 0), "the first owned uploaded photo is genuinely decoded");
  const firstImageSrc = await offerImage.getAttribute("src");
  await page.getByRole("button", { name: "الصورة 2" }).click();
  await page.waitForFunction(
    (previous) =>
      document
        .querySelector('[data-testid="img-offer"]')
        ?.getAttribute("src") !== previous,
    firstImageSrc,
  );
  await offerImage.evaluate((image) => image.decode());
  assert.ok(await offerImage.evaluate((image) => image.complete && image.naturalWidth > 0), "the second owned uploaded photo is genuinely decoded");
  checks.push(
    "buyer conversational search finds the persisted offer and detail gallery shows both photos",
  );

  await page.getByTestId("button-add-to-cart").click();
  await page.getByRole("button", { name: "عرض السلة", exact: true }).click();
  let cartCheckoutButton = page.getByTestId("button-cart-checkout");
  await cartCheckoutButton.waitFor();
  if ((await page.locator('input[type="checkbox"]').count()) === 0) {
    await cartCheckoutButton.click();
    await page.locator('input[type="checkbox"]').waitFor();
  }
  await page.locator('input[type="checkbox"]').first().check();
  cartCheckoutButton = page.getByTestId("button-cart-checkout");
  const checkoutResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/checkout" &&
      response.request().method() === "POST",
  );
  await cartCheckoutButton.click();
  const createdOrderResponse = await checkoutResponse;
  assert.equal(
    createdOrderResponse.status(),
    201,
    await createdOrderResponse.text(),
  );
  const checkoutData = await createdOrderResponse.json();
  goldenOrderId = checkoutData.orders?.[0]?.id;
  assert.ok(goldenOrderId, "browser checkout must create a persisted order");
  await page.getByRole("heading", { name: "طلباتي", exact: true }).waitFor();
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  await startNewConversation();
  await sendTurn("اعرض طلباتي");
  await page.getByRole("heading", { name: "طلباتي", exact: true }).waitFor();
  // The conversation lists purchases and sales together (no role tabs).
  await page.getByTestId(`row-order-${goldenOrderId}`).waitFor();
  await page.getByTestId(`row-order-${goldenOrderId}`).click();
  await page.getByTestId("status-CREATED").waitFor();
  checks.push(
    "buyer cart and checkout create an order that remains visible after reload",
  );

  context = sellerSession.context;
  page = sellerSession.page;
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  await startNewConversation();
  await sendTurn("اعرض طلباتي");
  await page.getByRole("heading", { name: "طلباتي", exact: true }).waitFor();
  // The conversation lists purchases and sales together (no role tabs).
  await page.getByTestId(`row-order-${goldenOrderId}`).waitFor();
  await page.getByTestId(`row-order-${goldenOrderId}`).click();
  await page.getByTestId("button-accept-order").click();
  await page.getByTestId("input-delivery-proof").waitFor();
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  await startNewConversation();
  await sendTurn("اعرض طلباتي");
  await page.getByRole("heading", { name: "طلباتي", exact: true }).waitFor();
  // The conversation lists purchases and sales together (no role tabs).
  await page.getByTestId(`row-order-${goldenOrderId}`).waitFor();
  await page.getByTestId(`row-order-${goldenOrderId}`).click();
  await page.getByTestId("status-ACCEPTED").waitFor();
  await page
    .getByTestId("input-delivery-proof")
    .fill(`E2E-HANDOFF-${Date.now()}`);
  await page.getByTestId("button-mark-delivered").click();
  await page
    .getByRole("button", { name: "نعم، تم التسليم", exact: true })
    .click();
  await page.getByTestId("status-SELLER_MARKED_DELIVERED").waitFor();
  checks.push(
    "seller sees and accepts the real order; acceptance survives reload and delivery is recorded",
  );

  context = buyerSession.context;
  page = buyerSession.page;
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  await startNewConversation();
  await sendTurn("اعرض طلباتي");
  await page.getByRole("heading", { name: "طلباتي", exact: true }).waitFor();
  // The conversation lists purchases and sales together (no role tabs).
  await page.getByTestId(`row-order-${goldenOrderId}`).waitFor();
  await page.getByTestId(`row-order-${goldenOrderId}`).click();
  await page.getByTestId("status-SELLER_MARKED_DELIVERED").waitFor();
  await page.getByTestId("button-confirm-receipt").click();
  await page
    .getByRole("button", { name: "نعم، استلمته", exact: true })
    .click();
  await page.getByTestId("status-COMPLETED").waitFor();
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  await startNewConversation();
  await sendTurn("اعرض طلباتي");
  await page.getByRole("heading", { name: "طلباتي", exact: true }).waitFor();
  // The conversation lists purchases and sales together (no role tabs).
  await page.getByTestId(`row-order-${goldenOrderId}`).waitFor();
  await page.getByTestId(`row-order-${goldenOrderId}`).click();
  await page.getByTestId("status-COMPLETED").waitFor();
  const completedOrderResponse = await context.request.get(
    `${apiOrigin}/api/orders/${goldenOrderId}`,
  );
  assert.equal(completedOrderResponse.status(), 200);
  const completedOrder = await completedOrderResponse.json();
  assert.equal(completedOrder.status, "COMPLETED");
  assert.equal(completedOrder.commissionRateBps, 1_000, "the approved 10% commission is unchanged");
  checks.push(
    "buyer confirms delivery and the completed 1000 bps (10%) order survives reload",
  );

  context = sellerSession.context;
  page = sellerSession.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  await selectMarket("KW");
  checks.push("seller market returns to Kuwait for the remaining listing checks");

  assert.deepEqual(pageErrors, []);
  const expectedConflictConsoleErrors = consoleErrors.filter(
    (message) =>
      message ===
      "Failed to load resource: the server responded with a status of 409 (Conflict)",
  );
  assert.deepEqual(consoleErrors, expectedConflictConsoleErrors);
  assert.equal(
    expectedConflictConsoleErrors.length,
    expectedMarketConversationConflicts.length,
    "only cross-market conversation reads may produce the expected 409",
  );
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  let createdConversationIds = [];
  for (const sessionContext of browserContexts) {
    try {
      await Promise.all(
        sessionContext
          .pages()
          .map((sessionPage) =>
            sessionPage.waitForLoadState("networkidle", { timeout: 20_000 }),
          ),
      );
    } catch (error) {
      failure ??= `Browser network requests did not settle before cleanup: ${String(error)}`;
    }
    try {
      createdConversationIds.push(
        ...(await conversations(sessionContext))
          .map((conversation) => conversation.id)
          .filter((id) => !initialConversationIds.has(id)),
      );
    } catch (error) {
      failure ??= `Could not collect browser-created conversations: ${String(error)}`;
    }
    try {
      await sessionContext.unrouteAll({ behavior: "ignoreErrors" });
    } catch (error) {
      failure ??= `Could not stop browser request routing cleanly: ${String(error)}`;
    }
  }
  createdConversationIds = [...new Set(createdConversationIds)];
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        pageErrors,
        consoleErrors,
        failedResponses,
        expectedMarketConversationConflicts,
        createdConversationIds,
        publishedOfferId,
        photoOfferId,
        publishedOfferIds,
        uploadedPhotoPaths,
        goldenOrderId,
        failure,
      },
      null,
      2,
    ),
  );
  await browser?.close();
}

if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({ checks, pageErrors, consoleErrors, publishedOfferId }),
  );
}
