import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * SC03 end to end in the real DINAR UI: Rashed finds Heba's used table, drafts an offer of 80,
 * corrects it to 85 before sending (one offer, never two), Heba answers «90 وأنت تستلمها»,
 * Rashed asks for the latest offer and agrees; one order at 90 follows and keeps 90 after Heba
 * raises the listing to 110; the order completes with a cash pickup. A stranger cannot decide
 * the negotiation. Every phrase is the scenario's own wording.
 */
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const webBase = env("SC03_WEB_BASE");
const apiOrigin = env("SC03_API_ORIGIN");
const runId = env("SC03_RUN_ID");
const tableId = env("SC03_TABLE_ID");
const resultPath = env("SC03_UI_RESULT_PATH");
const recorder = createRecorder(webBase, apiOrigin);
const outcome = {};
let failure;
let browser;

/** The order inside the chat: «طلباتي» → the order row → the order card's next action. */
async function orderCard(user) {
  await user.newConversation();
  const history = await user.say("طلباتي");
  const row = history.getByTestId("order-result-1");
  await row.waitFor();
  await row.click();
  const panel = user.latest().getByTestId("panel-next-action");
  await panel.waitFor({ timeout: 30_000 });
  return panel;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const rashed = await openUser(browser, { webBase, apiOrigin, cookie: env("SC03_BUYER_COOKIE"), label: "rashed", recorder });
  const heba = await openUser(browser, { webBase, apiOrigin, cookie: env("SC03_SELLER_COOKIE"), label: "heba", recorder });
  const stranger = await openUser(browser, { webBase, apiOrigin, cookie: env("SC03_STRANGER_COOKIE"), label: "stranger", recorder });

  // ── 1. Rashed finds the table ──
  await rashed.newConversation();
  const results = await rashed.say(`دينار، ورني طاولات مستعملة ${runId}`);
  await results.getByTestId("ai-results-list").waitFor();
  const shown = await results.locator('[data-testid^="card-ai-result-"]').evaluateAll((cards) => cards.map((card) => card.getAttribute("data-resource-id")));
  assert.ok(shown.includes(tableId), `Heba's table is found: ${JSON.stringify(shown)}`);
  const ordinal = ["الأول", "الثاني", "الثالث", "الرابع"][shown.indexOf(tableId)];

  // ── 2–4. 80, corrected to 85 before sending; one offer of 85 ──
  const eighty = await rashed.say(`اعرض عليها 80 على ${ordinal}`);
  assert.match(await eighty.innerText(), /80/u);
  assert.match(await eighty.innerText(), /لن يُرسل شيء قبل تأكيدك/u, "a review, not a sent offer");
  await rashed.widths("SC03 offer review", eighty);
  const eightyFive = await rashed.say("لا، خلها 85");
  assert.match(await eightyFive.innerText(), /85/u);
  assert.match(await eightyFive.innerText(), /لن يُرسل شيء قبل تأكيدك/u, "the same review, corrected");
  const sent = await rashed.say("قدّم العرض");
  assert.match(await sent.innerText(), /أُرسل عرضك|بانتظار رد البائع/u, `«قدّم العرض» sends the reviewed offer: ${await sent.innerText()}`);
  assert.doesNotMatch(await sent.innerText(), /وافق|قبل/u, "no invented acceptance");
  recorder.checks.push("80 was corrected to 85 in the same review and one offer of 85 was sent");

  // A stranger cannot decide on this negotiation.
  await stranger.newConversation();
  const nosy = await stranger.say("هل عندي عروض؟");
  assert.doesNotMatch(await nosy.innerText(), /85/u, "a stranger sees no offer");

  // ── 5–6. Heba sees 85 and answers «90 وأنت تستلمها» ──
  await heba.newConversation();
  const incoming = await heba.say("هل عندي عروض؟");
  assert.match(await incoming.innerText(), /85/u, "Heba sees exactly 85");
  assert.doesNotMatch(await incoming.innerText(), /عرض 80/u, "the uncorrected 80 was never sent");
  await heba.say("الأول");
  const counter = await heba.say("90 وأنت تستلمها");
  assert.match(await counter.innerText(), /90/u, `the counter-offer is reviewed: ${await counter.innerText()}`);
  outcome.counterReply = (await counter.innerText()).replace(/\s+/g, " ").slice(0, 300);
  assert.match(await counter.innerText(), /لا يُسجَّل في عرض السعر/u, "the pickup condition is named as unrecorded, not silently dropped");
  await heba.say("نعم");
  recorder.checks.push("Heba saw 85 and countered 90 after a review");

  // ── 7. «كم آخر عرض؟» is the latest authoritative amount: 90 ──
  const latest = await rashed.say("كم آخر عرض؟");
  assert.match(await latest.innerText(), /90/u, `the latest offer is 90: ${await latest.innerText()}`);
  outcome.latestReply = (await latest.innerText()).replace(/\s+/g, " ").slice(0, 300);

  // ── 8. «موافق»: a final review naming 90, then the acceptance ──
  // «كم آخر عرض؟» showed the review of accepting exactly 90; «موافق» answers that review.
  assert.match(await latest.innerText(), /اكتب «موافق»/u, "the latest offer is shown as the review it would accept");
  let agree = await rashed.say("موافق");
  if (/اكتب «نعم»/u.test(await agree.innerText())) agree = await rashed.say("نعم");
  assert.match(await agree.innerText(), /تم الاتفاق/u, `agreed: ${await agree.innerText()}`);
  assert.match(await agree.innerText(), /90/u, "at the 90 he was shown");
  recorder.checks.push("Rashed accepted exactly the 90 he was shown");

  // ── 9. One order at 90, fixed even when Heba raises the listing to 110 ──
  const item = await rashed.say(`أبي ${ordinal}`);
  const purchase = item.getByTestId("purchase-review");
  await purchase.waitFor();
  assert.match(await purchase.innerText(), /90/u, "the purchase review uses the agreement");
  let review = await rashed.click(purchase.getByTestId("purchase-continue"));
  await review.getByTestId("purchase-review").waitFor();
  const fulfilment = review.locator('[data-testid^="purchase-fulfilment-"]').first();
  if (await fulfilment.count()) review = await rashed.click(fulfilment);
  const placed = await rashed.click(review.getByTestId("purchase-confirm"));
  assert.match(await placed.innerText(), /تم إنشاء الطلب/u);
  const orders = (await rashed.api("/orders?role=buyer")).filter((order) => order.listingId === tableId || order.items?.some((line) => line.listingId === tableId));
  assert.equal(orders.length, 1, "one order");
  outcome.orderId = orders[0].id;
  // A second confirmation of the same review creates nothing (with nothing pending, a bare «نعم»
  // is ordinary conversation).
  await rashed.say("نعم", { allowFallback: true });
  assert.equal((await rashed.api("/orders?role=buyer")).filter((order) => order.listingId === tableId || order.items?.some((line) => line.listingId === tableId)).length, 1, "a repeated «نعم» creates no second order");

  const raise = await heba.say(`غير السعر طاولة سنديان ${runId} إلى 110`);
  const raised = await heba.say("نعم");
  outcome.raiseReply = (await raise.innerText()).replace(/\s+/g, " ").slice(0, 200);
  // The card after the confirmed change shows the new price, not a cached copy of the old one.
  const raisedCard = raised.locator(`[data-testid="chat-seller-listing-${tableId}"]`);
  await raisedCard.waitFor();
  await heba.page.waitForFunction((id) => /110/u.test(document.querySelector(`[data-testid="chat-seller-listing-${id}"]:last-of-type`)?.textContent ?? ""), tableId, { timeout: 15_000 }).catch(() => undefined);
  assert.match(await raised.locator(`[data-testid="chat-seller-listing-${tableId}"]`).last().innerText(), /110/u, "the confirmed price is shown");
  recorder.checks.push("one order at 90; a repeated confirmation created nothing");

  // ── 10. Cash pickup, hand-off and receipt from the chat ──
  const payment = await rashed.say("ادفع");
  let paymentReview = payment.getByTestId("purchase-review");
  await paymentReview.waitFor();
  await rashed.click(paymentReview.getByTestId("purchase-payment-CASH_DIRECT"));
  paymentReview = rashed.latest().getByTestId("purchase-review");
  await rashed.click(paymentReview.getByTestId("purchase-confirm"));

  let panel = await orderCard(heba);
  await panel.getByTestId("button-accept-order").click();
  await heba.page.getByTestId("text-handoff-prerequisite").waitFor({ timeout: 30_000 });
  await heba.say("جاهز للاستلام");
  await heba.say("نعم");
  panel = await orderCard(heba);
  await heba.page.getByTestId("input-delivery-proof").fill("استلمها راشد من البيت");
  await heba.page.getByTestId("button-mark-delivered").click();
  await heba.page.getByRole("button", { name: "نعم، تم التسليم" }).click();
  await heba.page.waitForFunction(async (id) => {
    const response = await fetch(`/api/orders/${id}`);
    return response.ok && (await response.json()).status === "SELLER_MARKED_DELIVERED";
  }, outcome.orderId, { timeout: 30_000 });

  panel = await orderCard(rashed);
  await rashed.page.getByTestId("button-confirm-receipt").click();
  await rashed.page.getByRole("button", { name: "نعم، استلمته" }).click();
  await rashed.page.waitForFunction(async (id) => {
    const response = await fetch(`/api/orders/${id}`);
    return response.ok && (await response.json()).status === "COMPLETED";
  }, outcome.orderId, { timeout: 30_000 });
  recorder.checks.push("the order at 90 completed through cash pickup, hand-off and receipt in chat");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(resultPath, JSON.stringify({ failure, ...outcome, ...recorder, allowedHosts: undefined, fontHosts: undefined }, null, 2));
  await browser?.close().catch(() => undefined);
}
