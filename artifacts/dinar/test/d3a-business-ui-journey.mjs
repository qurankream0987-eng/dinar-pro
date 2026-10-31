import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * D3-A in the real DINAR UI: the owner continues the conversation the API suite started and runs
 * the whole INTERNAL_DINAR business from it — setup answers, the activation review, typed drafts,
 * one publish review per draft, the catalog, orders and insights — then opens the DINAR-hosted
 * public page. A buyer opens the same page and reaches the listing through the canonical search.
 * Every figure is rendered from the server payload; the browser is only the presenter.
 */
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const webBase = env("D3A_WEB_BASE");
const apiOrigin = env("D3A_API_ORIGIN");
const runId = env("D3A_RUN_ID");
const userId = env("D3A_USER_ID");
const conversationId = env("D3A_CONVERSATION_ID");
const businessId = env("D3A_BUSINESS_ID");
const businessName = env("D3A_BUSINESS_NAME");
const ownerName = env("D3A_OWNER_NAME");
const ownerPhone = env("D3A_OWNER_PHONE");
const resultPath = env("D3A_UI_RESULT_PATH");
const recorder = createRecorder(webBase, apiOrigin);
const outcome = { surfaces: [] };
const surfaces = new Set();
let failure;
let browser;

const see = async (locator, surface) => {
  await locator.waitFor({ timeout: 30_000 });
  surfaces.add(surface);
  return locator;
};

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const owner = await openUser(browser, { webBase, apiOrigin, cookie: env("D3A_OWNER_COOKIE"), label: "owner", recorder });
  const buyer = await openUser(browser, { webBase, apiOrigin, cookie: env("D3A_BUYER_COOKIE"), label: "buyer", recorder });

  // The conversation the API suite started is the open one on this account and market.
  await owner.page.goto("/");
  await owner.page.getByTestId("input-ai-composer").waitFor();
  await owner.page.evaluate(
    ([key, id]) => localStorage.setItem(key, id),
    [`dinar-conversation:${userId}:JO`, conversationId],
  );
  await owner.page.reload();
  await owner.page.getByTestId("input-ai-composer").waitFor();
  await see(owner.page.getByTestId("business-setup").last(), "business-setup");
  recorder.checks.push("the restored conversation shows the saved setup card rebuilt from the server payload");

  // ── Owner onboarding through the conversation ──
  const described = await owner.say("أطباق شعبية طازجة");
  await see(described.getByTestId("business-setup"), "business-setup");
  assert.match(await described.innerText(), /منطقة|مدينة/u, "DINAR asks for the area next");
  const located = await owner.say("في عمان");
  await see(located.getByTestId("business-setup"), "business-setup");
  const fulfilled = await owner.say("استلام وتوصيل");
  const reviewCard = await see(fulfilled.getByTestId("business-profile-review"), "business-profile-review");
  assert.match(await reviewCard.innerText(), /التشغيل داخل DINAR/u, "the review states DINAR-only operation");
  recorder.checks.push("three answered questions build the activation review, nothing activated yet");

  const activated = await owner.click(reviewCard.getByTestId("business-activate"));
  const profile = await see(activated.getByTestId("business-profile"), "business-profile");
  assert.match(await profile.innerText(), /نشط/u, `the profile shows the activated status: ${await profile.innerText()}`);
  recorder.checks.push("activation happened on the owner's explicit «تشغيل النشاط»");

  // ── Typed drafts and one publish review per draft ──
  const drafts = await owner.say("جهز لي ثلاث عروض: شاورما 2.500، برجر 3.250، عصير 1.000");
  const draftCard = await see(drafts.getByTestId("business-catalog-draft"), "business-catalog-draft");
  assert.equal(await draftCard.locator('[data-testid="business-draft"]').count(), 3, "three typed drafts");
  recorder.checks.push("the drafts card shows the three typed offers as drafts, not listings");

  for (const number of [1, 2, 3]) {
    const review = await owner.say(`انشر المسودة ${number}`);
    const listingReview = await see(review.getByTestId("business-listing-review"), "business-listing-review");
    assert.match(await listingReview.innerText(), /بانتظار تأكيدك/u, "publishing needs the owner's confirmation");
    const confirmed = await owner.click(listingReview.getByTestId("business-confirm"));
    assert.match(await confirmed.innerText(), /نُشر/u, `publish reply names the listing: ${await confirmed.innerText()}`);
    await see(confirmed.getByTestId("business-profile"), "business-profile");
  }
  recorder.checks.push("each of the three drafts published only after its own review confirmation");

  const catalog = await owner.say("منتجاتي");
  const catalogCard = await see(catalog.getByTestId("business-catalog"), "business-catalog");
  assert.equal(await catalogCard.locator('[data-testid="business-catalog-listing"]').count(), 3, "the catalog lists the published catalog");
  await owner.widths("D3A owner catalog", catalogCard);
  recorder.checks.push("the catalog card lists the same three published listings");

  const orders = await owner.say("طلبات النشاط");
  const ordersCard = await see(orders.getByTestId("business-orders"), "business-orders");
  assert.match(await ordersCard.innerText(), /لا توجد/u, "no order is invented");
  recorder.checks.push("the orders card is an honest empty state in the UI");

  const insights = await owner.say("أداء النشاط");
  const insightsCard = await see(insights.getByTestId("business-insights"), "business-insights");
  const insightsText = await insightsCard.innerText();
  assert.match(insightsText, /3/u, `the insights count the catalog: ${insightsText}`);
  assert.match(insightsText, /إيراد مكتمل/u, "completed revenue is named as such");
  recorder.checks.push("the insights card shows the live catalog rows");

  // ── The DINAR-hosted public page ──
  await owner.page.getByTestId("business-public-link").last().click();
  await owner.page.getByTestId(`page-business-${businessId}`).waitFor({ timeout: 30_000 });
  assert.equal(await owner.page.getByTestId("badge-business-verified").count(), 1, "only a genuinely verified business shows the verified badge");
  const listingCards = owner.page.locator('[data-testid^="card-listing-"]');
  await listingCards.first().waitFor({ timeout: 30_000 });
  const listingIds = await listingCards.evaluateAll((nodes) =>
    nodes.map((node) => (node.getAttribute("data-testid") ?? "").replace("card-listing-", "")).filter(Boolean),
  );
  assert.equal(listingIds.length, 3, "the storefront lists the published catalog");
  // The public payload is the contract: no owner account, contact, audit or staff field.
  const publicPayload = await owner.api(`/businesses/${businessId}`);
  const publicJson = JSON.stringify(publicPayload);
  assert.equal(publicPayload.name, businessName, "the payload names the business");
  assert.ok(!publicJson.includes(ownerName), "the public payload never carries the owner's account name");
  assert.ok(!publicJson.includes(ownerPhone), "the public payload never carries the owner's private phone");
  assert.ok(!/ownerUserId|owner_user_id|audit|staff|registration|document|credential/i.test(publicJson), "no private record key reaches the payload");
  await owner.widths("D3A public business page", owner.page.getByTestId("card-business-profile"));
  outcome.publicPath = `/business/${businessId}`;
  outcome.listingIds = listingIds;
  recorder.checks.push("the owner opens the DINAR-hosted page with the verified badge and the live catalog, without private fields");

  // ── The buyer's view: the storefront and the canonical search ──
  await buyer.page.goto(`/business/${businessId}`);
  await buyer.page.getByTestId(`page-business-${businessId}`).waitFor({ timeout: 30_000 });
  const buyerView = await buyer.page.locator("body").innerText();
  assert.ok(buyerView.includes(businessName), "the storefront shows the business identity");
  assert.ok(!buyerView.includes(ownerName), "another account's view never shows the owner's account name");
  assert.ok(!buyerView.includes(ownerPhone), "another account's view never shows the owner's phone");
  assert.ok(!buyerView.includes("ownerUserId"), "the storefront exposes no owner account field");
  await buyer.widths("D3A buyer storefront", buyer.page.getByTestId("card-business-profile"));
  await buyer.page.locator(`[data-testid="card-listing-${listingIds[0]}"]`).first().click();
  await buyer.page.getByTestId("input-ai-composer").waitFor({ timeout: 30_000 });
  await buyer.page.waitForFunction(
    () => (document.querySelector('[data-testid="input-ai-composer"]')?.value ?? "").includes("أبي"),
    null,
    { timeout: 30_000 },
  );
  const prefill = await buyer.page.getByTestId("input-ai-composer").inputValue();
  assert.match(prefill, /أبي/u, `opening a storefront listing pre-types the request: ${prefill}`);
  recorder.checks.push("the buyer opens a storefront listing and DINAR pre-types the request instead of a dead page");

  await buyer.newConversation();
  const found = await buyer.say("دينار، ورني شاورما");
  await found.getByTestId("ai-results-list").waitFor({ timeout: 30_000 });
  const shown = await found.locator('[data-testid^="card-ai-result-"]').evaluateAll((cards) => cards.map((card) => card.getAttribute("data-resource-id")));
  assert.ok(shown.some((id) => listingIds.includes(id)), `the canonical search finds the business listing: ${JSON.stringify(shown)}`);
  outcome.searchResults = shown;
  recorder.checks.push("the buyer finds the business listing only through the canonical search");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  outcome.surfaces = [...surfaces];
  writeFileSync(resultPath, JSON.stringify({ failure, ...outcome, ...recorder, allowedHosts: undefined, fontHosts: undefined }, null, 2));
  await browser?.close().catch(() => undefined);
}
