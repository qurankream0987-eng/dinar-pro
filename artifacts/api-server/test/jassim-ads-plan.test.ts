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
import { db, listingPromotions, markets, offers, pool, users } from "@workspace/db";
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

test("ADP-03 paying is not serving: a listing removed while the payment is pending never starts", async () => {
  const seller = await account("seller3");
  const listingId = await publish(seller, `كاميرا ${run}`);
  const started = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId, idempotencyKey: `adp3-${randomUUID()}` }, seller.cookie);
  assert.equal(started.status, 201, started.raw);
  const id = started.data.promotion.id;
  await db.update(offers).set({ status: "ARCHIVED" }).where(eq(offers.id, listingId));
  const result = await pay(id, seller.id, `e3_${run}`, "8.000");
  assert.equal(result.failureCode, "PAID_LISTING_UNAVAILABLE_REFUND_REVIEW");
  const row = await promotion(id);
  assert.deepEqual([row.status, row.paymentStatus], ["CANCELLED", "PROVIDER_PAID"], "the payment is recorded; the campaign did not start");
  const view = await request(`/promotions/${id}`, "GET", undefined, seller.cookie);
  const note = JSON.stringify(view.data ?? {});
  assert.ok(view.status !== 200 || /وصل دفعك، لكن الإعلان لم يعد متاحًا/.test(note), note.slice(0, 300));
});
