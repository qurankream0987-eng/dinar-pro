import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * SC07 end to end in the real DINAR UI: the seller Reem reads her own stock in chat, raises a
 * quantity and pauses a listing through confirmed previews; two buyers in independent sessions
 * press «confirm» on the last unit at the same moment — exactly one order wins, the other gets an
 * understandable answer and no false success; Reem's «كم بقي؟» then reads the database.
 */
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const webBase = env("SC07_WEB_BASE");
const apiOrigin = env("SC07_API_ORIGIN");
const runId = env("SC07_RUN_ID");
const resultPath = env("SC07_UI_RESULT_PATH");
const ids = JSON.parse(env("SC07_LISTING_IDS"));
const recorder = createRecorder(webBase, apiOrigin);
let failure;
let browser;
const outcome = {};

async function prepareCheckout(buyer) {
  await buyer.newConversation();
  const results = await buyer.say(`أبي فنجان أخير ${runId}`);
  await results.getByTestId("ai-results-list").waitFor();
  const shown = await results.locator('[data-testid^="card-ai-result-"]').evaluateAll((cards) => cards.map((card) => card.getAttribute("data-resource-id")));
  assert.ok(shown.includes(ids.last), `${buyer.label} finds the last cup: ${JSON.stringify(shown)}`);
  const item = await buyer.say(`أبي ${["الأول", "الثاني", "الثالث"][shown.indexOf(ids.last)]}`);
  const purchase = item.getByTestId("purchase-review");
  await purchase.waitFor();
  let review = await buyer.click(purchase.getByTestId("purchase-continue"));
  await review.getByTestId("purchase-review").waitFor();
  const fulfilment = review.locator('[data-testid^="purchase-fulfilment-"]').first();
  if (await fulfilment.count()) review = await buyer.click(fulfilment);
  const confirm = review.getByTestId("purchase-confirm");
  await confirm.waitFor();
  return confirm;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const reem = await openUser(browser, { webBase, apiOrigin, cookie: env("SC07_SELLER_COOKIE"), label: "reem", recorder });
  const other = await openUser(browser, { webBase, apiOrigin, cookie: env("SC07_OTHER_COOKIE"), label: "other-seller", recorder });
  const first = await openUser(browser, { webBase, apiOrigin, cookie: env("SC07_BUYER1_COOKIE"), label: "buyer-1", recorder });
  const second = await openUser(browser, { webBase, apiOrigin, cookie: env("SC07_BUYER2_COOKIE"), label: "buyer-2", recorder });

  // ── 1–2. Reem's own stock, in her words ──
  await reem.newConversation();
  const stock = await reem.say("دينار ورّني البضاعة اللي أعرضها عندك وكم بقي منها");
  const stockText = await stock.innerText();
  assert.match(stockText, new RegExp(`أكواب قهوة سيراميك ${runId}.*5 متاح`, "su"), "cups: 5 available");
  assert.match(stockText, new RegExp(`فنجان أخير ${runId}.*1 متاح`, "su"), "last cup: 1 available");
  assert.doesNotMatch(stockText, new RegExp(`ماكينة ${runId}`, "u"), "another seller's listing never appears");
  await reem.widths("SC07 seller stock", stock);
  recorder.checks.push("Reem saw only her own listings with their available quantities");

  // ── 3. Best seller from recorded orders, with the period stated ──
  const best = await reem.say("وش الأكثر مبيعًا؟");
  assert.match(await best.innerText(), /\d{4}-\d{2}-\d{2}/u, "the sales answer states its period");

  // ── 4. Quantity change: preview first, then the change ──
  const preview = await reem.say("زد كمية أكواب القهوة إلى 10");
  assert.match(await preview.innerText(), /معاينة|لم يتغير/u, "a preview, not a change");
  assert.equal((await reem.api(`/listings/${ids.cups}`)).availableQuantity, 5, "nothing changed before «نعم»");
  assert.match(await (await reem.say("نعم")).innerText(), /تم تنفيذ التغيير/u);
  assert.equal((await reem.api(`/listings/${ids.cups}`)).availableQuantity, 10);
  recorder.checks.push("«زد كمية أكواب القهوة إلى 10» changed the quantity only after «نعم»");

  // The same words from another seller change nothing of Reem's.
  await other.newConversation();
  const refused = await other.say("زد كمية أكواب القهوة إلى 10");
  assert.equal(await refused.getByText(/الكمية 5 ← 10/u).count(), 0, "no preview of Reem's listing for another seller");
  // A bare «نعم» with nothing awaiting confirmation is ordinary conversation (the model's, when
  // one is configured); it must change nothing.
  await other.say("نعم", { allowFallback: true });
  assert.equal((await reem.api(`/listings/${ids.cups}`)).availableQuantity, 10, "another seller cannot touch Reem's listing");

  // ── 5. Pause the table: preview, «نعم», paused; no history is lost ──
  const listings = await reem.say("اعرض إعلاناتي");
  const rows = await listings.locator('[data-testid^="chat-seller-listing-"]').evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  const tableIndex = rows.findIndex((text) => text.includes(`طاولة ${runId}`));
  assert.ok(tableIndex >= 0, `the table is listed: ${JSON.stringify(rows)}`);
  const pause = await reem.say(`وقف الإعلان ${["الأول", "الثاني", "الثالث", "الرابع"][tableIndex]} مؤقتًا`);
  assert.match(await pause.innerText(), /معاينة|أكّد/u);
  await reem.say("نعم");
  assert.equal((await reem.api(`/listings/${ids.table}`)).status, "PAUSED");
  recorder.checks.push("the table was paused through a confirmed preview");

  // ── 6–8. Two buyers confirm the last unit at the same moment ──
  const [confirmA, confirmB] = await Promise.all([prepareCheckout(first), prepareCheckout(second)]);
  const [replyA, replyB] = await Promise.all([first.click(confirmA), second.click(confirmB)]);
  const texts = [await replyA.innerText(), await replyB.innerText()];
  outcome.replies = texts.map((text) => text.replace(/\s+/g, " ").slice(0, 200));
  const won = texts.filter((text) => /تم إنشاء الطلب/u.test(text)).length;
  assert.equal(won, 1, `exactly one buyer gets the last cup: ${JSON.stringify(outcome.replies)}`);
  const loser = texts.find((text) => !/تم إنشاء الطلب/u.test(text));
  assert.match(loser, /نفد|غير متاح|لم يعد|لم تعد|متوفر|الكمية|تعذر/u, "the other buyer is told plainly; no false success");
  assert.match(loser, /لم يتغير شيء/u, "and told that nothing happened");
  const orders = [...(await first.api("/orders?role=buyer")), ...(await second.api("/orders?role=buyer"))].filter((order) => order.listingId === ids.last || order.items?.some((line) => line.listingId === ids.last));
  assert.equal(orders.length, 1, "one order in the database");
  outcome.orderId = orders[0].id;
  await first.widths("SC07 race reply (buyer 1)", replyA);
  recorder.checks.push("two simultaneous confirmations on the last unit produced one order and one clear refusal");

  // ── 9. Reem asks again: the database answer ──
  const again = await reem.say("دينار ورّني البضاعة اللي أعرضها عندك وكم بقي منها");
  assert.match(await again.innerText(), new RegExp(`فنجان أخير ${runId}.*(0 متاح|محجوز|نفد)`, "su"), "the last cup is no longer available");
  const last = await reem.api(`/listings/${ids.last}`);
  assert.ok((last.availableQuantity ?? 0) >= 0, "never negative");
  recorder.checks.push("Reem's stock reading after the race matches the database");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(resultPath, JSON.stringify({ failure, ...outcome, ...recorder, allowedHosts: undefined, fontHosts: undefined }, null, 2));
  await browser?.close().catch(() => undefined);
}
