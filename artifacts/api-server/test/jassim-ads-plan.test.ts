/**
 * Jassim Ads in the conversation, end to end (owner examples 2026-11-28):
 *   1. «روّج لهذا المنتج» → one plan (options, copy, interested buyers) → review → pay → active → results
 *   2. «عندي 100 قطعة أريد بيعها» → the same plan, no promise to sell the quantity
 *   3. the listing is removed while the payment is pending → payment recorded, campaign never starts
 * A fake collection provider is registered (no Whop, no network, no money).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { and, eq as eq2 } from "drizzle-orm";
import { billingWebhookEvents, db, listingPromotions, markets, offers, pool, users } from "@workspace/db";
import app from "../src/app";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { registerPromotionBillingProvider, unregisterPromotionBillingProvider } from "../src/lib/promotion-billing";
import { applyPromotionProviderEvent } from "../src/lib/promotion-payments";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
process.env.DINAR_JASSIM_ADS = "true";
process.env.DINAR_JASSIM_ADS_PAYMENTS = "true";
const run = randomUUID().slice(0, 5);
const checkouts = new Map<string, string>();
registerPromotionBillingProvider({
  key: "test-gateway",
  displayName: "بوابة الاختبار",
  currencies: new Set(["JOD"]),
  async createCheckout(input) {
    const id = `tg_${checkouts.size + 1}_${run}`;
    checkouts.set(id, input.promotionId);
    return { checkoutId: id, checkoutUrl: `https://pay.test-gateway.example/${id}` };
  },
  async checkoutUrl(id) {
    return `https://pay.test-gateway.example/${id}`;
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => {
  unregisterPromotionBillingProvider("test-gateway");
  for (const key of ["DINAR_JASSIM_ADS", "DINAR_JASSIM_ADS_PAYMENTS"]) delete process.env[key];
  server.close();
  await pool.end();
});
let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.62.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let data: any;
  try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_210_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Pl-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `PL ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id as string, cookie: c.cookie };
}
const admin = await account("admin");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
await appendCommercialPolicy({ marketId: "JO", policy: { advertisingBillingActivation: "PROVIDER_DIRECT", advertisingBillingProvider: "test-gateway" }, actorId: admin.id });
const product = async (name: string, productType: string, priceMinor: number, durationDays: number) => {
  const r = await request("/admin/markets/JO/commercial-products", "POST", { name: `${name} ${run}`, productType, categoryId: "electronics", priceMinor, durationDays, chargingMode: "FIXED" }, admin.cookie);
  assert.equal(r.status, 201, r.raw);
  return r.data.id as string;
};
const vip = await product("ظهور مميز", "VIP_LISTING", 8_000, 3);
const featured = await product("إبراز في البحث", "FEATURED_LISTING", 5_000, 7);
async function publish(seller: { cookie: string }, title: string) {
  const r = await request("/listings", "POST", {
    title, description: `${title} — جديدة بالكرتونة`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
    attributes: { condition: "جديد" }, unitPrice: "40.000", inventoryMode: "LIMITED", availableQuantity: 100, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
  }, seller.cookie);
  assert.equal(r.status, 201, r.raw);
  return r.data.id as string;
}
async function conversation(who: { cookie: string }) {
  const created = await request("/ai/conversations", "POST", {}, who.cookie);
  const conversationId = created.data.conversation?.id ?? created.data.id;
  return async (message: string) => {
    const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: who.cookie }, body: JSON.stringify({ message }) });
    const raw = await r.text();
    const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
    assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
    return { body: complete.assistantMessage.body as string, commerce: complete.assistantMessage.blocks[0]?.payload?.commerce ?? {} };
  };
}
const promotion = async (id: string) => (await db.select().from(listingPromotions).where(eq(listingPromotions.id, id)))[0]!;
const pay = (promotionId: string, sellerId: string, eventId: string, amount = "5.000") =>
  applyPromotionProviderEvent({ providerKey: "test-gateway", eventId, type: "PAID", eventType: "payment", digest: eventId, promotionId, expectedAccountId: "acct", facts: { status: "paid", ownerUserId: sellerId, subtotal: { amount, currency: "JOD" }, total: { amount, currency: "JOD" } } });

test("ADP-01 «روّج لهذا المنتج»: one plan card → pick → review → pay page → paid → active → results card", async () => {
  const seller = await account("seller1");
  await publish(seller, `سماعة ${run}`);
  const turn = await conversation(seller);
  const plan = await turn("روّج لهذا المنتج");
  assert.equal(plan.commerce.view, "PROMOTION_TYPE_OPTIONS", plan.body);
  assert.match(plan.body, /خطة ترويج «سماعة/);
  assert.deepEqual(plan.commerce.products.map((p: any) => p.productType).sort(), ["FEATURED_LISTING", "VIP_LISTING"]);
  assert.equal(plan.commerce.promotionPlan.copy.length, 3, "copy drafted from the listing's own facts");
  assert.equal(plan.commerce.promotionPlan.suggestedProductId, featured, "lowest-priced option suggested");
  assert.match(plan.commerce.promotionPlan.note, /لا يُدفع شيء/);
  const featuredIndex = plan.commerce.products.findIndex((p: any) => p.productType === "FEATURED_LISTING");
  const review = await turn(`الخيار ${featuredIndex + 1}`);
  assert.equal(review.commerce.providerPayment?.providerKey, "test-gateway", review.body);
  assert.match(review.body, /بوابة الاختبار/);
  const confirmed = await turn("نعم");
  assert.match(confirmed.commerce.promotionCheckout.url, /^https:\/\/pay\.test-gateway\.example\//, confirmed.body);
  assert.equal(confirmed.commerce.promotionCheckout.providerName, "بوابة الاختبار");
  assert.match(confirmed.body, /لم يُخصم شيء بعد/);
  const promotionId = confirmed.commerce.promotionCheckout.promotionId;
  assert.equal((await promotion(promotionId)).status, "PENDING_PAYMENT", "nothing starts on «نعم»");
  assert.equal((await pay(promotionId, seller.id, `e1_${run}`)).outcome, "APPLIED");
  const active = await promotion(promotionId);
  assert.deepEqual([active.status, active.paymentStatus], ["ACTIVE", "PROVIDER_PAID"]);
  const results = await turn("كيف تسير حملاتي");
  assert.equal(results.commerce.view, "CAMPAIGN_ANALYTICS", results.body);
  assert.ok(results.commerce.campaigns?.length >= 1, "a results card, not only text");
});

test("ADP-02 «عندي 100 قطعة أريد بيعها»: the same plan, honestly framed", async () => {
  const seller = await account("seller2");
  await publish(seller, `حقيبة ${run}`);
  const turn = await conversation(seller);
  const plan = await turn("عندي 100 قطعة من هذا المنتج أريد بيعها");
  assert.equal(plan.commerce.view, "PROMOTION_TYPE_OPTIONS", plan.body);
  assert.match(plan.body, /خطة لبيع 100 قطعة/);
  assert.match(plan.body, /لا أعدك ببيع الكمية كلها/);
});

const NOTE = "وصل دفعك، لكن الإعلان لم يعد متاحًا فلم يبدأ الترويج. سُجّل الطلب لمراجعة الاسترداد.";
const webhookRow = async (eventId: string) =>
  (await db.select().from(billingWebhookEvents).where(and(eq2(billingWebhookEvents.providerKey, "test-gateway"), eq2(billingWebhookEvents.providerEventId, eventId))));

test("ADP-03 paying is not serving: a listing removed while the payment is pending never starts", async () => {
  const seller = await account("seller3");
  const listingId = await publish(seller, `كاميرا ${run}`);
  const started = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId, idempotencyKey: `adp3-${randomUUID()}` }, seller.cookie);
  assert.equal(started.status, 201, started.raw);
  const id = started.data.promotion.id;
  const pending = await promotion(id);
  assert.deepEqual([pending.status, pending.paymentStatus], ["PENDING_PAYMENT", "PROVIDER_PENDING"]);
  await db.update(offers).set({ status: "ARCHIVED" }).where(eq(offers.id, listingId));

  // 1. valid signed confirmation → recorded as paid, never started, refund review recorded
  const result = await pay(id, seller.id, `e3_${run}`, "8.000");
  assert.deepEqual([result.outcome, result.failureCode, result.duplicate], ["APPLIED", "PAID_LISTING_UNAVAILABLE_REFUND_REVIEW", false]);
  const row = await promotion(id);
  assert.deepEqual([row.status, row.paymentStatus], ["CANCELLED", "PROVIDER_PAID"]);
  assert.equal(String(row.expiresAt), String(pending.expiresAt), "no serving window was opened by the payment");
  assert.ok(row.endedAt, "ended at the moment the payment arrived");
  const [review] = await webhookRow(`e3_${run}`);
  assert.deepEqual([review?.status, review?.failureCode], ["APPLIED", "PAID_LISTING_UNAVAILABLE_REFUND_REVIEW"], "refund review recorded with the event");

  // 2. exact seller-facing message, and no claim that money was already refunded
  const view = await request(`/promotions/${id}`, "GET", undefined, seller.cookie);
  assert.equal(view.status, 200, view.raw);
  const campaign = view.data.promotion ?? view.data;
  assert.equal(campaign.servingNote, NOTE);
  assert.equal(campaign.paymentStatus, "PROVIDER_PAID");
  assert.doesNotMatch(view.raw, /تم الاسترداد|استُرد|أُعيد المبلغ|تمت إعادة/, "no false refund claim");
  const list = await request("/promotions", "GET", undefined, seller.cookie);
  assert.ok(list.raw.includes(NOTE), "the same note in the seller's campaign list");

  // 3. duplicate delivery of the same signed event → nothing changes, one record
  const again = await pay(id, seller.id, `e3_${run}`, "8.000");
  assert.equal(again.duplicate, true);
  assert.equal((await webhookRow(`e3_${run}`)).length, 1);
  const after1 = await promotion(id);
  assert.deepEqual([after1.status, after1.paymentStatus, String(after1.updatedAt)], [row.status, row.paymentStatus, String(row.updatedAt)]);

  // 4. a second, different payment event for the same campaign → flagged, never starts
  const second = await pay(id, seller.id, `e3b_${run}`, "8.000");
  assert.deepEqual([second.outcome, second.failureCode], ["IGNORED", "ALREADY_PAID_SECOND_PAYMENT_REVIEW"]);
  assert.equal((await promotion(id)).status, "CANCELLED");

  // 5. restoring the listing afterwards does not start the paid campaign by itself
  await db.update(offers).set({ status: "PUBLISHED" }).where(eq(offers.id, listingId));
  assert.equal((await promotion(id)).status, "CANCELLED");

  // 6. only a provider-signed refund marks the money refunded
  const refund = await applyPromotionProviderEvent({ providerKey: "test-gateway", eventId: `r3_${run}`, type: "REFUNDED", eventType: "refund", digest: `r3_${run}`, promotionId: id, expectedAccountId: "acct", facts: { status: "refunded", ownerUserId: seller.id, total: { amount: "8.000", currency: "JOD" }, refunded: { amount: "8.000", currency: "JOD" } } });
  assert.equal(refund.outcome, "APPLIED");
  const refunded = await promotion(id);
  assert.deepEqual([refunded.status, refunded.paymentStatus], ["CANCELLED", "PROVIDER_REFUNDED"]);
  const afterRefund = await request(`/promotions/${id}`, "GET", undefined, seller.cookie);
  assert.equal((afterRefund.data.promotion ?? afterRefund.data).servingNote, "ملغى — أكّد مزود الدفع استرداد المبلغ", "refund stated only after the provider-signed refund");
});

test("ADP-04 wrong amount, wrong owner, or another provider on a removed listing: rejected, nothing recorded as paid", async () => {
  const seller = await account("seller4");
  const listingId = await publish(seller, `ساعة ${run}`);
  const started = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId, idempotencyKey: `adp4-${randomUUID()}` }, seller.cookie);
  const id = started.data.promotion.id;
  await db.update(offers).set({ status: "ARCHIVED" }).where(eq(offers.id, listingId));
  assert.equal((await pay(id, seller.id, `e4a_${run}`, "5.000")).failureCode, "AMOUNT_MISMATCH_REVIEW");
  assert.equal((await pay(id, randomUUID(), `e4b_${run}`, "8.000")).failureCode, "OWNER_MISMATCH");
  const other = await applyPromotionProviderEvent({ providerKey: "other-gateway", eventId: `e4c_${run}`, type: "PAID", eventType: "payment", digest: "d", promotionId: id, expectedAccountId: "acct", facts: { status: "paid", ownerUserId: seller.id, subtotal: { amount: "8.000", currency: "JOD" } } });
  assert.equal(other.failureCode, "PROVIDER_MISMATCH");
  const row = await promotion(id);
  assert.deepEqual([row.status, row.paymentStatus], ["PENDING_PAYMENT", "PROVIDER_PENDING"]);
});
