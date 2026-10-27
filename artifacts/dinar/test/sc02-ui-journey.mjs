import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * SC02 end to end in the real DINAR UI (docs/dinar-next/HANDOFF_FOR_NEXT_AGENT.md T1): a buyer
 * narrows three used Prado listings, sorts them, caps the price, goes back, re-sorts, compares
 * the first two, and asks «كم ماشي؟» about the cheapest car — whose seller recorded no mileage.
 * DINAR answers «لم يذكر البائع الممشى» and opens an inquiry review; nothing is sent. The buyer
 * then offers on the second car, the seller accepts in their own session, and the buyer orders
 * at the agreed amount. The calling suite checks the database afterwards.
 *
 * The fixtures are created by the suite through the API; every user action below is the UI's.
 */
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const webBase = env("SC02_WEB_BASE");
const apiOrigin = env("SC02_API_ORIGIN");
const noMileageId = env("SC02_NO_MILEAGE_ID");
const offerListingId = env("SC02_OFFER_ID");
const offerAmount = Number(env("SC02_OFFER_AMOUNT"));
const resultPath = env("SC02_UI_RESULT_PATH");
const recorder = createRecorder(webBase, apiOrigin);
const outcome = {};
const sessions = [];
let failure;
let browser;

const cardIds = (reply) =>
  reply.locator('[data-testid^="card-ai-result-"]').evaluateAll((cards) => cards.map((card) => card.getAttribute("data-resource-id")));

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const buyer = await openUser(browser, { webBase, apiOrigin, cookie: env("SC02_BUYER_COOKIE"), label: "buyer", recorder });
  const seller = await openUser(browser, { webBase, apiOrigin, cookie: env("SC02_SELLER_COOKIE"), label: "seller", recorder });
  sessions.push(buyer, seller);
  // Presentation fonts never leave the machine: answering them locally keeps the run self-contained.
  for (const session of sessions)
    await session.context.route(/fonts\.(googleapis|gstatic)\.com/u, (route) => route.fulfill({ status: 204, contentType: "text/css", body: "" }));

  // ── 1–6. Narrow, sort, cap, go back, re-sort ──
  await buyer.newConversation();
  const found = await buyer.say("دينار أبي برادو مستعملة");
  await found.getByTestId("ai-results-list").waitFor();
  assert.equal((await cardIds(found)).length, 3, "the three Prado fixtures are found");
  const narrowed = await buyer.say("من 2020 وفوق");
  assert.match(await narrowed.innerText(), /2020|ثلاث|3/u, `the model-year floor keeps the list: ${await narrowed.innerText()}`);
  const sorted = await buyer.say("رتبهم من الأرخص");
  const sortedIds = await cardIds(sorted);
  assert.equal(sortedIds[0], noMileageId, "the cheapest car is the one whose seller recorded no mileage");
  assert.equal(sortedIds[1], offerListingId, "the next car is the one the buyer will offer on");
  outcome.sortedIds = sortedIds;
  const capped = await buyer.say("خلها بحد أقصى 5 آلاف");
  assert.equal((await cardIds(capped)).length, 3, "a 5,000 cap keeps every car (it is not read as 5 dinars)");
  await buyer.say("رجعني للنتائج");
  const cheapest = await buyer.say("أرخص");
  assert.deepEqual((await cardIds(cheapest))[0], noMileageId, "the cheapest car is the one whose seller recorded no mileage");
  await buyer.widths("SC02 buyer results", cheapest.getByTestId("ai-results-list"));
  recorder.checks.push("three listings narrowed by year, sorted by price, capped at 5,000, and re-sorted");

  // ── 7. Compare the first two: the unrecorded mileage is labelled, not invented ──
  const compared = await buyer.say("قارن أول إعلان بالثاني");
  const comparison = compared.getByTestId("comparison");
  await comparison.waitFor();
  const comparisonText = await comparison.innerText();
  assert.match(comparisonText, /لم يذكر البائع/u, `the comparison labels the missing value: ${comparisonText.slice(0, 300)}`);
  assert.match(comparisonText, /ممشى|ماشي|mileage/iu, "the comparison carries the mileage row");
  await buyer.widths("SC02 comparison", comparison);
  recorder.checks.push("the comparison shows both cars and labels the unrecorded mileage «لم يذكر البائع»");

  // ── 8. «هذا الأول كم ماشي؟» — a deterministic answer and an inquiry review, nothing sent ──
  const question = await buyer.say("هذا الأول كم ماشي؟");
  const replyText = await question.innerText();
  assert.match(replyText, /لم يذكر البائع الممشى/u, `a deterministic answer, not the model: ${replyText.slice(0, 300)}`);
  const inquiry = question.getByTestId("inquiry-surface");
  await inquiry.waitFor();
  assert.equal(await inquiry.getAttribute("data-view"), "DRAFT", "the answer opens a draft review");
  const draftText = await inquiry.getByTestId("inquiry-draft").innerText();
  assert.match(draftText, /ممشى/u, `the drafted question asks about the mileage: ${draftText.slice(0, 200)}`);
  assert.match(await inquiry.getByTestId("inquiry-draft-status").innerText(), /بانتظار|مراجعة|لم يُرسل/u);
  assert.equal(await question.getByTestId("inquiry-message").count(), 0, "nothing was sent to the seller");
  await buyer.widths("SC02 mileage review", inquiry);
  outcome.draftText = draftText.replace(/\s+/g, " ").slice(0, 300);
  recorder.checks.push("«كم ماشي؟» answered from the record («لم يذكر البائع الممشى») and left the question unsent");

  // ── 9–10. An offer on the second car, reviewed then sent ──
  const offer = await buyer.say(`اعرض عليه ${offerAmount} على الثاني`);
  const offerText = await offer.innerText();
  assert.match(offerText, new RegExp(String(offerAmount), "u"), `the review names the amount: ${offerText.slice(0, 300)}`);
  assert.match(offerText, /لن يُرسل شيء قبل تأكيدك/u, "an offer is a review, not a send");
  await buyer.widths("SC02 offer review", buyer.latest());
  const sentOffer = await buyer.say("قدّم العرض");
  assert.match(await sentOffer.innerText(), /أُرسل عرضك|بانتظار رد البائع/u, `the offer was sent after the review: ${await sentOffer.innerText()}`);
  recorder.checks.push(`the offer of ${offerAmount} was reviewed and sent once`);

  // ── 11. The seller accepts the offer in their own session ──
  await seller.newConversation();
  const incoming = await seller.say("هل عندي عروض؟");
  assert.match(await incoming.innerText(), new RegExp(String(offerAmount), "u"), "the seller sees the offer");
  await seller.say("الأول");
  const acceptReview = await seller.say("اقبل العرض");
  assert.match(await acceptReview.innerText(), new RegExp(String(offerAmount), "u"), `the acceptance review names the amount: ${await acceptReview.innerText()}`);
  const accepted = await seller.say("نعم");
  assert.doesNotMatch(await accepted.innerText(), /تعذر|غير متاح/u, `the offer was accepted: ${await accepted.innerText()}`);
  recorder.checks.push("the seller accepted exactly the reviewed offer");

  // ── 12. The buyer orders at the agreed amount ──
  const item = await buyer.say("أبي الثاني");
  const purchase = item.getByTestId("purchase-review");
  await purchase.waitFor();
  assert.match(await purchase.innerText(), new RegExp(String(offerAmount), "u"), "the purchase review uses the agreement, not the asking price");
  let review = await buyer.click(purchase.getByTestId("purchase-continue"));
  await review.getByTestId("purchase-review").waitFor();
  const fulfilment = review.locator('[data-testid^="purchase-fulfilment-"]').first();
  if (await fulfilment.count()) review = await buyer.click(fulfilment);
  await buyer.widths("SC02 order review", review.getByTestId("purchase-review"));
  const placed = await buyer.click(review.getByTestId("purchase-confirm"));
  assert.match(await placed.innerText(), /تم إنشاء الطلب/u);
  const orders = (await buyer.api("/orders?role=buyer")).filter((order) => order.listingId === offerListingId || order.items?.some((line) => line.listingId === offerListingId));
  assert.equal(orders.length, 1, "exactly one order for the agreed car");
  outcome.orderId = orders[0].id;
  recorder.checks.push("the buyer placed exactly one order at the agreed amount");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify({ failure, ...outcome, checks: recorder.checks, steps: recorder.steps, modelFallbacks: recorder.modelFallbacks, pageErrors: recorder.pageErrors, consoleErrors: recorder.consoleErrors, externalRequests: recorder.externalRequests, horizontalOverflow: recorder.horizontalOverflow }, null, 2),
  );
  for (const session of sessions) await session.context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
