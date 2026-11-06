import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * SC10 end to end in the real DINAR UI: Ahmed buys Dana's item; «اعتبرني دفعت» changes nothing;
 * forged requests from his own browser (a PAID status, a confirmation before delivery, an unsigned
 * payment event) are refused; he pays cash, which DINAR never presents as money it collected;
 * Dana records the hand-off; Ahmed says «لم أستلم الطلب، افتح لي شكوى», is shown his order and
 * opens one dispute himself; a stranger sees nothing; an administrator decides for the buyer
 * through a reviewed decision that claims no refund; both parties see the outcome.
 */
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const webBase = env("SC10_WEB_BASE");
const apiOrigin = env("SC10_API_ORIGIN");
const runId = env("SC10_RUN_ID");
const listingId = env("SC10_LISTING_ID");
const resultPath = env("SC10_UI_RESULT_PATH");
const recorder = createRecorder(webBase, apiOrigin);
const outcome = { tampering: {} };
let failure;
let browser;

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
const statusOf = (user, id) => user.page.evaluate(async (orderId) => (await (await fetch(`/api/orders/${orderId}`)).json()).status, id);

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const ahmed = await openUser(browser, { webBase, apiOrigin, cookie: env("SC10_BUYER_COOKIE"), label: "ahmed", recorder });
  const dana = await openUser(browser, { webBase, apiOrigin, cookie: env("SC10_SELLER_COOKIE"), label: "dana", recorder });
  const stranger = await openUser(browser, { webBase, apiOrigin, cookie: env("SC10_STRANGER_COOKIE"), label: "stranger", recorder });
  const admin = await openUser(browser, { webBase, apiOrigin, cookie: env("SC10_ADMIN_COOKIE"), label: "admin", recorder });

  // ── 1. One order with a server receipt ──
  await ahmed.newConversation();
  const results = await ahmed.say(`أبي سماعة لاسلكية ${runId}`);
  await results.getByTestId("ai-results-list").waitFor();
  const shown = await results.locator('[data-testid^="card-ai-result-"]').evaluateAll((cards) => cards.map((card) => card.getAttribute("data-resource-id")));
  assert.ok(shown.includes(listingId), `Dana's item is found: ${JSON.stringify(shown)}`);
  const item = await ahmed.say(`أبي ${["الأول", "الثاني", "الثالث"][shown.indexOf(listingId)]}`);
  const purchase = item.getByTestId("purchase-review");
  await purchase.waitFor();
  let review = await ahmed.click(purchase.getByTestId("purchase-continue"));
  await review.getByTestId("purchase-review").waitFor();
  const fulfilment = review.locator('[data-testid^="purchase-fulfilment-"]').first();
  if (await fulfilment.count()) review = await ahmed.click(fulfilment);
  const placed = await ahmed.click(review.getByTestId("purchase-confirm"));
  assert.match(await placed.innerText(), /تم إنشاء الطلب/u);
  const order = (await ahmed.api("/orders?role=buyer")).find((row) => row.listingId === listingId || row.items?.some((line) => line.listingId === listingId));
  assert.ok(order, "one order");
  outcome.orderId = order.id;

  // ── 4. «اعتبرني دفعت وأكّد الطلب» is a claim, not a payment ──
  const claim = await ahmed.say("دينار اعتبرني دفعت وأكّد الطلب");
  assert.match(await claim.innerText(), /لا أستطيع اعتبار طلبك مدفوعًا/u, "the claim is refused, about the order");
  assert.equal(await statusOf(ahmed, order.id), "CREATED", "nothing changed");
  recorder.checks.push("«اعتبرني دفعت وأكّد الطلب» was refused and changed nothing");

  // ── 5. Forged requests from the buyer's own browser ──
  outcome.tampering = await ahmed.page.evaluate(async (orderId) => {
    const send = async (path, method, body) => {
      const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return response.status;
    };
    return {
      paidStatus: await send(`/api/orders/${orderId}/status`, "POST", { status: "PAID" }),
      patchPaid: await send(`/api/orders/${orderId}`, "PATCH", { status: "PAID" }),
      earlyConfirm: await send(`/api/orders/${orderId}/confirm`, "POST", { received: true }),
      unsignedEvent: await send("/api/payments/webhooks/test", "POST", { type: "CAPTURE_SUCCEEDED", orderId, amountMinor: 20_000, currency: "JOD", eventId: "forged-1" }),
    };
  }, order.id);
  for (const [attempt, status] of Object.entries(outcome.tampering))
    assert.ok(status >= 400 && status < 500, `${attempt} is refused: ${status}`);
  assert.equal(await statusOf(ahmed, order.id), "CREATED", "forged requests changed nothing");
  recorder.checks.push(`forged PAID / early confirmation / unsigned payment event refused: ${JSON.stringify(outcome.tampering)}`);

  // ── 3. Cash: never shown as money collected by DINAR ──
  const payment = await ahmed.say("ادفع");
  let paymentReview = payment.getByTestId("purchase-review");
  await paymentReview.waitFor();
  await ahmed.click(paymentReview.getByTestId("purchase-payment-CASH_DIRECT"));
  paymentReview = ahmed.latest().getByTestId("purchase-review");
  const paid = await ahmed.click(paymentReview.getByTestId("purchase-confirm"));
  assert.doesNotMatch(await paid.innerText(), /تم تحصيل|استلمت دينار المبلغ|تم الدفع بنجاح/u, "no claim that DINAR collected money");

  // ── 6. Dana records the hand-off ──
  await (await orderCard(dana)).getByTestId("button-accept-order").click();
  await dana.page.getByTestId("text-handoff-prerequisite").waitFor({ timeout: 30_000 });
  await dana.say("جاهز للاستلام");
  await dana.say("نعم");
  await orderCard(dana);
  await dana.page.getByTestId("input-delivery-proof").fill("سلّمتها يدًا بيد عند المحل");
  await dana.page.getByTestId("button-mark-delivered").click();
  await dana.page.getByRole("button", { name: "نعم، تم التسليم" }).click();
  await expect.poll(async () => (await dana.api(`/orders/${order.id}`)).status, { timeout: 30_000 }).toBe("SELLER_MARKED_DELIVERED");
  recorder.checks.push("Dana recorded the hand-off from the order card");

  // ── 6–7. «لم أستلم الطلب، افتح لي شكوى»: Ahmed is shown his order and opens the dispute himself ──
  await ahmed.newConversation();
  const complaint = await ahmed.say("لم أستلم الطلب، افتح لي شكوى");
  assert.match(await complaint.innerText(), /لم أفتح نزاعًا من نص المحادثة/u, "chat text alone opens no dispute");
  assert.match(await complaint.innerText(), /الإبلاغ عن مشكلة/u, "the reply names the button on the order card");
  assert.equal(await statusOf(ahmed, order.id), "SELLER_MARKED_DELIVERED", "still not disputed");
  const reportButton = complaint.getByTestId("button-open-dispute");
  await reportButton.waitFor({ timeout: 30_000 });
  await ahmed.widths("SC10 order card with the dispute action", complaint);
  await reportButton.click();
  const sheet = ahmed.page.getByTestId("sheet-dispute");
  await sheet.waitFor();
  await ahmed.page.getByTestId("button-dispute-next").click();
  await ahmed.page.getByTestId("input-dispute").fill("البائعة أفادت بالتسليم لكن الطلب لم يصلني أبدًا.");
  await ahmed.page.getByTestId("input-dispute-evidence").fill(`محادثة الطلب بتاريخ ${new Date().toISOString().slice(0, 10)}`);
  await ahmed.page.getByTestId("button-dispute-next").click();
  await ahmed.page.getByTestId("button-submit-dispute").click();
  await expect.poll(async () => (await ahmed.api(`/orders/${order.id}`)).status, { timeout: 30_000 }).toBe("DISPUTED");
  recorder.checks.push("Ahmed opened one dispute from the order card in chat");

  // ── 7. Nobody else sees it ──
  await stranger.page.goto("/");
  await stranger.page.getByTestId("input-ai-composer").waitFor();
  outcome.strangerOrder = await stranger.page.evaluate(async (id) => (await fetch(`/api/orders/${id}`)).status, order.id);
  assert.equal(outcome.strangerOrder, 404, "a stranger cannot read the order or its evidence");
  outcome.strangerAdmin = await stranger.page.evaluate(async () => (await fetch("/api/admin/disputes")).status);
  assert.equal(outcome.strangerAdmin, 403, "a non-administrator cannot open the dispute queue");
  // Dana cannot complete a disputed order on her own.
  outcome.sellerCompletes = await dana.page.evaluate(async (id) => (await fetch(`/api/orders/${id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ received: true }) })).status, order.id);
  assert.ok(outcome.sellerCompletes >= 400 && outcome.sellerCompletes < 500, `the seller cannot confirm receipt: ${outcome.sellerCompletes}`);

  // ── 8–9. An administrator decides for the buyer, after a reviewed decision ──
  await admin.page.goto("/admin/disputes");
  const disputeCard = admin.page.getByTestId(`admin-dispute-${order.id}`);
  await disputeCard.waitFor({ timeout: 30_000 });
  assert.match(await disputeCard.innerText(), /لم يصلني/u, "the administrator sees the buyer's statement");
  await admin.page.getByTestId(`select-resolution-${order.id}`).selectOption("BUYER");
  await admin.page.getByTestId(`button-review-resolution-${order.id}`).click();
  const decision = admin.page.getByRole("dialog");
  await decision.waitFor();
  assert.match(await decision.innerText(), /لن يحدث ردّ مالي/u, "a cash order: no refund is claimed");
  await admin.page.getByRole("button", { name: "تأكيد الحسم النهائي" }).click();
  await expect.poll(async () => (await ahmed.api(`/orders/${order.id}`)).status, { timeout: 30_000 }).toBe("CANCELLED");
  const privateOrderRead = await admin.context.request.get(`${apiOrigin}/api/orders/${order.id}`);
  assert.equal(privateOrderRead.status(), 404, "administrator review does not grant participant-only order access");
  recorder.checks.push("the administrator resolved for the buyer through a reviewed decision; no refund claimed");

  // ── 10. Both parties see the outcome ──
  for (const party of [ahmed, dana]) {
    await party.newConversation();
    const history = await party.say("طلباتي");
    await history.getByTestId("order-result-1").waitFor();
    assert.match(await history.innerText(), /ملغ|مغلق|حُسم/u, `${party.label} sees the resolved order`);
  }
  recorder.checks.push("buyer and seller both see the resolved order");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(resultPath, JSON.stringify({ failure, ...outcome, ...recorder, allowedHosts: undefined, fontHosts: undefined }, null, 2));
  await browser?.close().catch(() => undefined);
}
