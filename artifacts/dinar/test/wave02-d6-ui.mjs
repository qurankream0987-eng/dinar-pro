import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, MODEL_FALLBACK_REPLY, openUser } from "./sc-ui-session.mjs";

/**
 * WAVE 02 / D6 in the real browser: three real offers, a grounded comparison, one selection, a
 * reload on the review, and one confirmation through DINAR's canonical checkout.
 */
const webBase = process.env.W02D6_WEB_BASE;
const apiOrigin = process.env.W02D6_API_ORIGIN;
const buyerCookie = process.env.W02D6_BUYER_COOKIE;
const title = process.env.W02D6_TITLE;
const listingIds = (process.env.W02D6_LISTING_IDS ?? "").split(",").filter(Boolean);
const resultPath = process.env.W02D6_UI_RESULT_PATH;
if (!webBase || !apiOrigin || !buyerCookie || !title || listingIds.length !== 3 || !resultPath)
  throw new Error("Missing WAVE 02 D6 browser journey configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
let failure;
let browser;
let order = {};

const cardOf = (page) => page.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();
const latestAssistant = (page) => page.locator('[data-testid^="message-assistant-"]').last();

async function cardInfo(page) {
  const card = cardOf(page);
  await card.waitFor({ state: "visible", timeout: 45_000 });
  return card.evaluate((node) => ({
    surfaceId: node.getAttribute("data-card-surface-id"),
    lifecycle: node.getAttribute("data-card-lifecycle"),
    buttons: [...node.querySelectorAll("button")].map((button) => button.getAttribute("data-testid")),
  }));
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const buyer = await openUser(browser, { webBase, apiOrigin, cookie: buyerCookie, label: "buyer", recorder });
  const page = buyer.page;

  await buyer.newConversation();
  await buyer.say(`ابحث عن ${title}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="card-ai-result-"]').length >= 3, undefined, { timeout: 45_000 });
  assert.equal(await page.locator('[data-testid^="card-ai-result-"]').count(), 3, "the search returns the three real offers");
  checks.push("search returns the three real offers published through DINAR");

  const compared = await buyer.say("قارن بينهم");
  const comparison = compared.getByTestId("comparison");
  await comparison.waitFor({ timeout: 45_000 });
  await buyer.widths("D6 comparison", comparison);
  checks.push("the comparison is RTL, overflow-free and named at 320/390/1280");
  const comparisonText = await comparison.innerText();
  for (const price of ["21", "19", "17"])
    assert.match(comparisonText, new RegExp(`${price}\\.000\\s*JOD`, "u"), `the recorded price ${price} appears`);
  assert.match(comparisonText, /السعر/u);
  checks.push("the comparison shows each recorded price from DINAR, side by side");

  const selected = await buyer.say("أبي الأول");
  const review = await cardInfo(page);
  assert.equal(review.lifecycle, "PENDING_REVIEW");
  assert.ok(review.surfaceId);
  assert.match(await selected.innerText(), /(\d+\.\d{3})\s*JOD/u);
  checks.push("the selection opens a purchase review priced from the listing, not the message");

  const selectedId = await cardOf(page).evaluate((node) => node.getAttribute("data-card-surface-id"));
  await page.reload();
  const afterReload = await cardInfo(page);
  assert.equal(afterReload.surfaceId, selectedId, "the review keeps its server identity across a reload");
  assert.equal(afterReload.lifecycle, "PENDING_REVIEW", "the review is still pending, with nothing ordered");
  assert.deepEqual(await buyer.api("/orders?role=buyer"), [], "a reload orders nothing");
  checks.push("reload restores the same pending review and orders nothing");

  const orderReview = await buyer.click(cardOf(page).getByTestId("purchase-continue"));
  const orderCard = orderReview.getByTestId("purchase-review");
  await orderCard.waitFor({ timeout: 45_000 });
  assert.match(await orderReview.innerText(), /مراجعة الطلب/u);
  const fulfilment = orderCard.locator('[data-testid^="purchase-fulfilment-"]').first();
  if (await fulfilment.isVisible()) await buyer.click(fulfilment);
  const confirm = latestAssistant(page).getByTestId("purchase-confirm");
  await confirm.waitFor({ timeout: 45_000 });
  const receipt = await buyer.click(confirm);
  assert.match(await receipt.innerText(), /تم إنشاء الطلب/u);
  checks.push("the order review is confirmed once through the canonical checkout");

  const created = await buyer.api("/orders?role=buyer");
  assert.equal(created.length, 1, "exactly one order exists");
  assert.ok(listingIds.includes(created[0].listingId), "the order is for the selected real listing");
  order = { listingId: created[0].listingId, quantity: created[0].quantity };

  await page.reload();
  await latestAssistant(page).waitFor({ timeout: 45_000 });
  await page.getByText("تم إنشاء الطلب").last().waitFor({ timeout: 45_000 });
  assert.equal(await page.locator('[data-testid="purchase-confirm"]:visible').count(), 0, "a settled order offers no second confirmation");
  assert.equal((await buyer.api("/orders?role=buyer")).length, 1, "the reload does not order again");
  checks.push("a reload keeps the created order and offers no second confirmation");

  assert.deepEqual(recorder.modelFallbacks, [], "no buyer turn fell back to the model");
  assert.ok(recorder.steps.every((step) => !MODEL_FALLBACK_REPLY.test(step.reply)));
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks: [...checks, ...recorder.checks],
        order,
        failure,
        pageErrors: recorder.pageErrors,
        consoleErrors: recorder.consoleErrors,
        externalRequests: recorder.externalRequests,
        horizontalOverflow: recorder.horizontalOverflow,
        steps: recorder.steps,
        modelFallbacks: recorder.modelFallbacks,
      },
      null,
      2,
    ),
  );
  await browser?.close().catch(() => undefined);
}
