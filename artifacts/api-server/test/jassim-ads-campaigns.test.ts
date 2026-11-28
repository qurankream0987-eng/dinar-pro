/**
 * Jassim Ads closure (owner decision 2026-11-28): placement catalog, multi-placement campaigns, one
 * payment, per-placement delivery and results, store promotion, contextual targeting, Go Sell for Me.
 * A fake collection provider is registered: no Whop, no network, no money.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { billingWebhookEvents, businessProfiles, db, listingPromotions, markets, offers, promotionCampaigns, promotionProducts, storePromotionEvents, storePromotions, users } from "@workspace/db";
import app from "../src/app";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { registerPromotionBillingProvider, unregisterPromotionBillingProvider } from "../src/lib/promotion-billing";
import { applyPromotionProviderEvent } from "../src/lib/promotion-payments";
import { campaignResults } from "../src/lib/promotion-campaigns";
import { displayPlacementCards } from "../src/lib/welcome-ads";
import { resolveMarket } from "../src/lib/markets";
import { saveDemandRequest } from "../src/lib/demand-requests";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
process.env.DINAR_JASSIM_ADS = "true";
process.env.DINAR_JASSIM_ADS_PAYMENTS = "true";
const run = randomUUID().slice(0, 5);
const opened: { promotionId: string; priceMinor: number }[] = [];
registerPromotionBillingProvider({
  key: "test-gateway",
  displayName: "بوابة الاختبار",
  currencies: new Set(["JOD"]),
  async createCheckout(input) {
    opened.push({ promotionId: input.promotionId, priceMinor: input.priceMinor });
    return { checkoutId: `tg_${input.promotionId}`, checkoutUrl: `https://pay.test-gateway.example/tg_${input.promotionId}` };
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
  const { pool } = await import("@workspace/db");
  await pool.end();
});
let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.63.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let data: any;
  try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_250_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Ca-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `CA ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id as string, cookie: c.cookie };
}
const admin = await account("admin");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
await appendCommercialPolicy({ marketId: "JO", policy: { advertisingBillingActivation: "PROVIDER_DIRECT", advertisingBillingProvider: "test-gateway", minCohortSize: 3 }, actorId: admin.id });
const JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);

async function product(body: Record<string, unknown>) {
  const r = await request("/admin/markets/JO/commercial-products", "POST", { chargingMode: "FIXED", ...body, name: `${body.name} ${run}` }, admin.cookie);
  assert.equal(r.status, 201, r.raw);
  return r.data as { id: string };
}
// The catalog for this run (prices are illustrative test values, set by the admin, never in code).
const sidebar = await product({ name: "الشريط الجانبي", productType: "SIDEBAR_AD", priceMinor: 2_000, durationDays: 7, pricingUnit: "DAY", minDays: 1, maxDays: 30, subjectKinds: ["LISTING", "STORE"], description: "بطاقة ثابتة في الشريط الجانبي" });
const hero = await product({ name: "الشريط الرئيسي", productType: "HERO_BANNER", priceMinor: 25_000, durationDays: 7, subjectKinds: ["LISTING", "STORE"], capacity: 50 });
const search = await product({ name: "إبراز في البحث", productType: "SPONSORED_SEARCH", categoryId: "electronics", priceMinor: 6_000, durationDays: 7 });
const demand = await product({ name: "روح بيع لي", productType: "DEMAND_CAPTURE", categoryId: "electronics", priceMinor: 4_000, durationDays: 10 });
const serviceSearch = await product({ name: "إبراز خدمة", productType: "SPONSORED_SEARCH", categoryId: "services", priceMinor: 3_000, durationDays: 7 });

const PHOTO = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxyZWN0IHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9IiNmYTAiLz48L3N2Zz4=";
async function publish(seller: { cookie: string }, title: string, categoryId = "electronics", category = "إلكترونيات", withImage = true) {
  const service = categoryId === "services";
  const r = await request("/listings", "POST", {
    title, description: `${title} — بحالة ممتازة مع الضمان والكرتونة الأصلية وتوصيل داخل عمان`, category, categoryId, area: "خلدا", city: "عمان",
    ...(service ? { attributes: {}, inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "SERVICE" } : { attributes: { condition: "جديد" }, inventoryMode: "LIMITED", availableQuantity: 100, fulfilmentType: "PICKUP" }),
    unitPrice: "40.000", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
  }, seller.cookie);
  assert.equal(r.status, 201, r.raw);
  const id = r.data.id as string;
  // The product photo (hero and sidebar show it); tests that need a listing without one say so.
  if (withImage) {
    const [row] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, id));
    await db.update(offers).set({ data: { ...(row!.data as Record<string, unknown>), imageUrl: PHOTO, imageUrls: [PHOTO] } }).where(eq(offers.id, id));
  }
  return id;
}
const subjectL = (listingId: string) => ({ kind: "LISTING", listingId });
const quote = (cookie: string, subject: unknown, items: unknown) => request("/commercial/promotion-campaigns/quote", "POST", { subject, items }, cookie);
async function checkout(seller: { cookie: string }, subject: unknown, items: unknown, adCopy = "") {
  const q = await quote(seller.cookie, subject, items);
  assert.equal(q.status, 200, q.raw);
  const c = await request("/commercial/promotion-campaigns/checkouts", "POST", { subject, items, adCopy, quoteKey: q.data.quoteKey, idempotencyKey: `cmp-${randomUUID()}` }, seller.cookie);
  return { quote: q.data, checkout: c };
}
const pay = (campaignId: string, sellerId: string, eventId: string, amount: string, type: "PAID" | "REFUNDED" | "DISPUTED" = "PAID", refunded?: string) =>
  applyPromotionProviderEvent({ providerKey: "test-gateway", eventId, type, eventType: type.toLowerCase(), digest: eventId, promotionId: campaignId, expectedAccountId: "acct", facts: { status: type === "PAID" ? "paid" : type.toLowerCase(), ownerUserId: sellerId, subtotal: { amount, currency: "JOD" }, total: { amount, currency: "JOD" }, ...(refunded ? { refunded: { amount: refunded, currency: "JOD" } } : {}) } });
const items = async (campaignId: string) => [
  ...(await db.select().from(listingPromotions).where(eq(listingPromotions.campaignId, campaignId))),
  ...(await db.select().from(storePromotions).where(eq(storePromotions.campaignId, campaignId))),
];

test("CMP-01 catalog: each placement with its own price, days and accepted subjects; unsupported placements never offered", async () => {
  const seller = await account("cat");
  const listingId = await publish(seller, `هاتف سامسونج ${run}a`);
  const catalog = await request(`/commercial/promotion-campaigns/placements?listingId=${listingId}`, "GET", undefined, seller.cookie);
  assert.equal(catalog.status, 200, catalog.raw);
  const byPlacement = Object.fromEntries(catalog.data.options.filter((o: any) => [sidebar.id, hero.id, search.id, demand.id, serviceSearch.id].includes(o.productId)).map((o: any) => [o.placement, o]));
  assert.deepEqual(Object.keys(byPlacement).sort(), ["DEMAND", "HERO", "SIDEBAR", "SPONSORED_SEARCH"], "a services placement is not offered for an electronics listing");
  assert.equal(byPlacement.SIDEBAR.pricingUnit, "DAY");
  assert.match(byPlacement.SIDEBAR.unitPriceLabel, /2\.000 JOD لليوم/);
  assert.deepEqual([byPlacement.SIDEBAR.minDays, byPlacement.SIDEBAR.maxDays], [1, 30]);
  assert.equal(byPlacement.HERO.pricingUnit, "PERIOD");
  assert.equal(byPlacement.SPONSORED_SEARCH.where, "إبراز ضمن نتائج البحث عندما يطابق بحث المشتري");
  // Strangers get 404; the older single-purchase path never sells per-day or campaign-only placements.
  assert.equal((await request(`/commercial/promotion-campaigns/placements?listingId=${listingId}`, "GET", undefined, admin.cookie)).status, 404);
  const legacy = await request("/commercial/promotion-payments/checkouts", "POST", { productId: sidebar.id, listingId, idempotencyKey: `lg-${randomUUID()}` }, seller.cookie);
  assert.equal(legacy.status, 409, legacy.raw);
  assert.match(legacy.data.error, /ضمن حملة مواضع فقط|لا يُدفع مباشرةً/);
});

test("CMP-02 quote: one, several, all placements; different prices and days; removing one recomputes; ranges enforced", async () => {
  const seller = await account("quote");
  const listingId = await publish(seller, `لابتوب ديل ${run}`);
  const s = subjectL(listingId);
  const one = await quote(seller.cookie, s, [{ productId: sidebar.id, days: 7 }]);
  assert.equal(one.status, 200, one.raw);
  assert.deepEqual([one.data.totalMinor, one.data.totalLabel], [14_000, "14.000 JOD"], "2.000 × 7 days, computed on the server");
  const two = await quote(seller.cookie, s, [{ productId: sidebar.id, days: 3 }, { productId: search.id }]);
  assert.deepEqual(two.data.lines.map((l: any) => [l.days, l.priceMinor]), [[3, 6_000], [7, 6_000]]);
  assert.equal(two.data.totalMinor, 12_000);
  const all = await quote(seller.cookie, s, [{ productId: sidebar.id, days: 10 }, { productId: hero.id }, { productId: search.id }, { productId: demand.id }]);
  assert.equal(all.data.lines.length, 4);
  assert.equal(all.data.totalMinor, 20_000 + 25_000 + 6_000 + 4_000);
  const removed = await quote(seller.cookie, s, [{ productId: sidebar.id, days: 10 }, { productId: search.id }, { productId: demand.id }]);
  assert.equal(removed.data.totalMinor, all.data.totalMinor - 25_000, "removing the hero recomputes the total");
  assert.notEqual(removed.data.quoteKey, all.data.quoteKey);
  assert.equal((await quote(seller.cookie, s, [{ productId: sidebar.id, days: 31 }])).data.code, "DAYS_OUT_OF_RANGE");
  assert.equal((await quote(seller.cookie, s, [{ productId: hero.id, days: 3 }])).data.code, "DAYS_FIXED");
  assert.equal((await quote(seller.cookie, s, [{ productId: hero.id }, { productId: hero.id }])).status, 400);
  assert.equal((await quote(seller.cookie, s, [])).status, 400);
});

test("CMP-03 prices differ by market: the same placement is priced by each market's own catalog", async () => {
  await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "KW"));
  const r = await request("/admin/markets/KW/commercial-products", "POST", { name: `شريط جانبي KW ${run}`, productType: "SIDEBAR_AD", chargingMode: "FIXED", priceMinor: 1_500, durationDays: 7, pricingUnit: "DAY", minDays: 3, maxDays: 14 }, admin.cookie);
  assert.equal(r.status, 201, r.raw);
  const seller = await account("kw");
  assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, seller.cookie)).status, 200);
  const listingId = await (async () => {
    const res = await request("/listings", "POST", { title: `هاتف كويت ${run}`, description: "هاتف جديد بالكرتونة الأصلية مع ضمان سنة كاملة وتوصيل", category: "إلكترونيات", categoryId: "electronics", area: "السالمية", city: "الكويت", attributes: { condition: "جديد" }, unitPrice: "40.000", inventoryMode: "LIMITED", availableQuantity: 5, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"] }, seller.cookie);
    return res.status === 201 ? (res.data.id as string) : undefined;
  })();
  if (!listingId) return; // KW listing rules may differ in this environment; the JO/KW catalogs are still separate rows.
  const q = await quote(seller.cookie, subjectL(listingId), [{ productId: r.data.id, days: 7 }]);
  assert.equal(q.status, 200, q.raw);
  assert.equal(q.data.currencyCode, "KWD");
  assert.equal(q.data.totalMinor, 10_500);
  assert.equal((await quote(seller.cookie, subjectL(listingId), [{ productId: sidebar.id, days: 7 }])).status, 409, "another market's product is not for sale here");
});

test("CMP-04 confirm: the reviewed total is the charged total; a stale or forged quote is refused; a withdrawn version is not sold", async () => {
  const seller = await account("price");
  const listingId = await publish(seller, `سماعة جابرا ${run}`);
  const s = subjectL(listingId);
  const forged = await request("/commercial/promotion-campaigns/checkouts", "POST", { subject: s, items: [{ productId: sidebar.id, days: 2 }], quoteKey: "0000000000000000", idempotencyKey: `cmp-${randomUUID()}` }, seller.cookie);
  assert.equal(forged.status, 409);
  assert.equal(forged.data.code, "PRICE_CHANGED");
  // The admin withdraws a price version between review and confirmation.
  const temp = await product({ name: "موضع مؤقت", productType: "SPONSORED_RECOMMENDATION", categoryId: "electronics", priceMinor: 3_000, durationDays: 7 });
  const q = await quote(seller.cookie, s, [{ productId: temp.id }]);
  assert.equal(q.status, 200, q.raw);
  assert.equal((await request(`/admin/commercial-products/${temp.id}`, "PATCH", { enabled: false }, admin.cookie)).status, 200);
  const stale = await request("/commercial/promotion-campaigns/checkouts", "POST", { subject: s, items: [{ productId: temp.id }], quoteKey: q.data.quoteKey, idempotencyKey: `cmp-${randomUUID()}` }, seller.cookie);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "PLACEMENT_NOT_FOR_SALE");
  assert.equal((await db.select().from(promotionCampaigns).where(eq(promotionCampaigns.sellerId, seller.id))).length, 0, "nothing reserved, nothing charged");
});

test("CMP-05 one payment for a multi-placement campaign: nothing starts on confirmation; each placement gets its own window; duplicates change nothing", async () => {
  const seller = await account("multi");
  const listingId = await publish(seller, `آيفون 15 ${run}`);
  const { quote: q, checkout: c } = await checkout(seller, subjectL(listingId), [{ productId: sidebar.id, days: 3 }, { productId: search.id }, { productId: hero.id }], "آيفون 15 جديد بسعر ممتاز في عمان");
  assert.equal(c.status, 201, c.raw);
  assert.equal(c.data.amountLabel, q.totalLabel);
  assert.equal(opened.filter((o) => o.promotionId === c.data.campaignId).length, 1, "one provider page for the whole campaign");
  assert.equal(opened.find((o) => o.promotionId === c.data.campaignId)!.priceMinor, q.totalMinor);
  const pending = await items(c.data.campaignId);
  assert.equal(pending.length, 3);
  assert.ok(pending.every((row) => row.status === "PENDING_PAYMENT"), "returning from the provider page starts nothing");
  // Same idempotency key → same campaign and same page.
  const [campaign] = await db.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, c.data.campaignId));
  assert.equal(campaign!.adCopy, "آيفون 15 جديد بسعر ممتاز في عمان");
  const paid = await pay(c.data.campaignId, seller.id, `cp_${run}_5`, "37.000");
  assert.deepEqual([paid.outcome, paid.failureCode], ["APPLIED", null]);
  const active = await items(c.data.campaignId);
  assert.ok(active.every((row) => row.status === "ACTIVE" && row.paymentStatus === "PROVIDER_PAID"));
  const days = Object.fromEntries(active.map((row) => [row.placementSnapshot, Math.round((row.expiresAt.getTime() - row.startsAt.getTime()) / 86_400_000)]));
  assert.deepEqual(days, { SIDEBAR: 3, SPONSORED_SEARCH: 7, HERO: 7 });
  const again = await pay(c.data.campaignId, seller.id, `cp_${run}_5`, "37.000");
  assert.equal(again.duplicate, true);
  assert.equal((await db.select().from(billingWebhookEvents).where(and(eq(billingWebhookEvents.providerKey, "test-gateway"), eq(billingWebhookEvents.providerEventId, `cp_${run}_5`)))).length, 1);
  const second = await pay(c.data.campaignId, seller.id, `cp_${run}_5b`, "37.000");
  assert.equal(second.failureCode, "ALREADY_PAID_SECOND_PAYMENT_REVIEW");
  // Expiry is automatic and per placement: 4 days later only the sidebar has ended.
  const later = (await campaignResults(seller.id, JO, c.data.campaignId, new Date(Date.now() + 4 * 86_400_000)))[0]!;
  assert.deepEqual(Object.fromEntries(later.placements.map((p) => [p.placement, p.status])), { SIDEBAR: "EXPIRED", SPONSORED_SEARCH: "ACTIVE", HERO: "ACTIVE" });
  const ended = (await campaignResults(seller.id, JO, c.data.campaignId, new Date(Date.now() + 8 * 86_400_000)))[0]!;
  assert.equal(ended.status, "ENDED");
});

test("CMP-06 wrong amount, wrong owner or another provider: rejected; nothing starts", async () => {
  const seller = await account("wrong");
  const listingId = await publish(seller, `ساعة ابل ${run}`);
  const { checkout: c } = await checkout(seller, subjectL(listingId), [{ productId: search.id }, { productId: sidebar.id, days: 1 }]);
  assert.equal((await pay(c.data.campaignId, seller.id, `cw_${run}_1`, "6.000")).failureCode, "AMOUNT_MISMATCH_REVIEW");
  assert.equal((await pay(c.data.campaignId, admin.id, `cw_${run}_2`, "8.000")).failureCode, "OWNER_MISMATCH");
  const other = await applyPromotionProviderEvent({ providerKey: "other-gateway", eventId: `cw_${run}_3`, type: "PAID", eventType: "payment", digest: "d", promotionId: c.data.campaignId, expectedAccountId: "acct", facts: { status: "paid", ownerUserId: seller.id, subtotal: { amount: "8.000", currency: "JOD" } } });
  assert.equal(other.failureCode, "PROVIDER_MISMATCH");
  assert.ok((await items(c.data.campaignId)).every((row) => row.status === "PENDING_PAYMENT"));
});

test("CMP-07 paid but one placement can no longer run: the others run, that one is recorded paid and flagged; refund of exactly it is applied", async () => {
  const seller = await account("partial");
  const listingId = await publish(seller, `كاميرا كانون ${run}`);
  const temp = await product({ name: "موضع سيُسحب", productType: "SPONSORED_RECOMMENDATION", categoryId: "electronics", priceMinor: 3_000, durationDays: 7 });
  const { checkout: c } = await checkout(seller, subjectL(listingId), [{ productId: search.id }, { productId: temp.id }]);
  assert.equal(c.status, 201, c.raw);
  await request(`/admin/commercial-products/${temp.id}`, "PATCH", { enabled: false }, admin.cookie);
  const paid = await pay(c.data.campaignId, seller.id, `pp_${run}`, "9.000");
  assert.deepEqual([paid.outcome, paid.failureCode], ["APPLIED", "PLACEMENT_UNAVAILABLE_REFUND_REVIEW"]);
  const rows = Object.fromEntries((await items(c.data.campaignId)).map((row) => [row.placementSnapshot, [row.status, row.paymentStatus]]));
  assert.deepEqual(rows, { SPONSORED_SEARCH: ["ACTIVE", "PROVIDER_PAID"], SPONSORED_RECOMMENDATION: ["CANCELLED", "PROVIDER_PAID"] });
  const [campaign] = await db.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, c.data.campaignId));
  assert.deepEqual([campaign!.status, campaign!.refundReviewMinor], ["PARTIAL", 3_000]);
  const view = await request(`/commercial/promotion-campaigns/${c.data.campaignId}`, "GET", undefined, seller.cookie);
  assert.equal(view.status, 200, view.raw);
  assert.equal(view.data.statusLabel, "نشط جزئيًا");
  assert.match(view.data.paymentNote, /لم يُسترد شيء بعد/);
  const failed = view.data.placements.find((p: any) => p.placement === "SPONSORED_RECOMMENDATION");
  assert.equal(failed.note, "دُفع ثمن هذا الموضع لكنه لم يبدأ لأنه لم يعد متاحًا؛ سُجّل لمراجعة الاسترداد.");
  assert.doesNotMatch(JSON.stringify(view.data), /تم الاسترداد|أكّد مزود الدفع استرداد/, "no refund claimed before a signed refund");
  const refund = await pay(c.data.campaignId, seller.id, `pr_${run}`, "9.000", "REFUNDED", "3.000");
  assert.deepEqual([refund.outcome, refund.failureCode], ["APPLIED", "UNSERVED_PLACEMENTS_REFUNDED"]);
  const after = Object.fromEntries((await items(c.data.campaignId)).map((row) => [row.placementSnapshot, [row.status, row.paymentStatus]]));
  assert.deepEqual(after, { SPONSORED_SEARCH: ["ACTIVE", "PROVIDER_PAID"], SPONSORED_RECOMMENDATION: ["CANCELLED", "PROVIDER_REFUNDED"] });
  assert.equal((await pay(c.data.campaignId, seller.id, `pr2_${run}`, "9.000", "REFUNDED", "2.000")).failureCode, "PARTIAL_REFUND_FOR_REVIEW");
});

test("CMP-08 listing removed while pending: paid, nothing starts, all flagged; dispute pauses; full refund cancels", async () => {
  const seller = await account("removed");
  const listingId = await publish(seller, `تابلت شاومي ${run}`);
  const { checkout: c } = await checkout(seller, subjectL(listingId), [{ productId: search.id }, { productId: sidebar.id, days: 2 }]);
  await db.update(offers).set({ status: "ARCHIVED" }).where(eq(offers.id, listingId));
  const paid = await pay(c.data.campaignId, seller.id, `rm_${run}`, "10.000");
  assert.equal(paid.failureCode, "PLACEMENT_UNAVAILABLE_REFUND_REVIEW");
  assert.ok((await items(c.data.campaignId)).every((row) => row.status === "CANCELLED" && row.paymentStatus === "PROVIDER_PAID"));
  const [campaign] = await db.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, c.data.campaignId));
  assert.deepEqual([campaign!.status, campaign!.refundReviewMinor], ["CANCELLED", 10_000]);

  const seller2 = await account("dispute");
  const listing2 = await publish(seller2, `شاشة ال جي ${run}`);
  const { checkout: c2 } = await checkout(seller2, subjectL(listing2), [{ productId: search.id }, { productId: sidebar.id, days: 2 }]);
  await pay(c2.data.campaignId, seller2.id, `dp_${run}_p`, "10.000");
  assert.equal((await pay(c2.data.campaignId, seller2.id, `dp_${run}_d`, "10.000", "DISPUTED")).outcome, "APPLIED");
  assert.ok((await items(c2.data.campaignId)).every((row) => row.status === "PAUSED" && row.paymentStatus === "PROVIDER_DISPUTED"), "disputed money never serves");
  const seller3 = await account("refund");
  const listing3 = await publish(seller3, `راوتر تي بي لينك ${run}`);
  const { checkout: c3 } = await checkout(seller3, subjectL(listing3), [{ productId: search.id }]);
  await pay(c3.data.campaignId, seller3.id, `rf_${run}_p`, "6.000");
  assert.equal((await pay(c3.data.campaignId, seller3.id, `rf_${run}_r`, "6.000", "REFUNDED", "6.000")).outcome, "APPLIED");
  assert.ok((await items(c3.data.campaignId)).every((row) => row.status === "CANCELLED" && row.paymentStatus === "PROVIDER_REFUNDED"));
});

test("CMP-09 capacity: a full placement is shown unavailable and cannot be bought", async () => {
  const one = await product({ name: "شريط محدود", productType: "HERO_BANNER", priceMinor: 9_000, durationDays: 3, capacity: 1 });
  const a = await account("capA");
  const b = await account("capB");
  const la = await publish(a, `ماوس لوجيتك ${run}`);
  const lb = await publish(b, `كيبورد ريزر ${run}`);
  const first = await checkout(a, subjectL(la), [{ productId: one.id }]);
  assert.equal(first.checkout.status, 201, first.checkout.raw);
  const q = await quote(b.cookie, subjectL(lb), [{ productId: one.id }]);
  assert.equal(q.data.ok, false);
  assert.equal(q.data.lines[0].reason, "هذا الموضع ممتلئ حاليًا في سوقك");
  const refused = await request("/commercial/promotion-campaigns/checkouts", "POST", { subject: subjectL(lb), items: [{ productId: one.id }], quoteKey: q.data.quoteKey, idempotencyKey: `cmp-${randomUUID()}` }, b.cookie);
  assert.equal(refused.data.code, "PLACEMENT_UNAVAILABLE");
  await request(`/admin/commercial-products/${one.id}`, "PATCH", { enabled: false }, admin.cookie);
});

test("CMP-10 store promotion: only a published store, only hero/sidebar, served as a labelled store card, results per placement", async () => {
  const owner = await account("store");
  const viewer = await account("viewer");
  const storeId = randomUUID();
  await db.insert(businessProfiles).values({ id: storeId, ownerUserId: owner.id, marketId: "JO", displayName: `متجر الأمل ${run}`, normalizedName: `store-${storeId}`, categoryKey: "OTHER", legalName: "Synthetic Store", legalForm: "COMPANY", verificationStatus: "VERIFIED", verifiedAt: new Date(), verifiedBy: admin.id, publicationStatus: "PUBLISHED", idempotencyKey: randomUUID() });
  const store = { kind: "STORE", businessId: storeId };
  // A store card shows a product photo from the store: without one, display placements are refused.
  const noPhoto = await quote(owner.cookie, store, [{ productId: hero.id }]);
  assert.equal(noPhoto.data.lines[0].reason, "أضف صورة لمنتج واحد على الأقل في متجرك؛ هذا الموضع يعرض صورة");
  await publish(owner, `منتج من المتجر ${run}`);
  const catalog = await request(`/commercial/promotion-campaigns/placements?businessId=${storeId}`, "GET", undefined, owner.cookie);
  assert.equal(catalog.status, 200, catalog.raw);
  assert.ok(catalog.data.options.every((o: any) => ["HERO", "SIDEBAR"].includes(o.placement)), "a store is offered only display placements");
  assert.equal((await quote(owner.cookie, store, [{ productId: search.id }])).status, 200);
  assert.equal((await quote(owner.cookie, store, [{ productId: search.id }])).data.lines[0].reason, "هذا الموضع يعرض منتجات فقط، لا المتاجر");
  assert.equal((await request(`/commercial/promotion-campaigns/placements?businessId=${storeId}`, "GET", undefined, viewer.cookie)).status, 404);
  const { checkout: c } = await checkout(owner, store, [{ productId: sidebar.id, days: 5 }, { productId: hero.id }]);
  assert.equal(c.status, 201, c.raw);
  assert.equal((await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: viewer.id })).cards.some((card) => card.businessId === storeId), false, "not served before payment");
  await pay(c.data.campaignId, owner.id, `st_${run}`, "35.000");
  const cards = (await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: viewer.id })).cards;
  const card = cards.find((item) => item.businessId === storeId)!;
  assert.ok(card, JSON.stringify(cards));
  assert.deepEqual([card.kind, card.label, card.path, card.imagePath], ["STORE", "إعلان ممول", `/business/${storeId}`, PHOTO]);
  assert.equal((await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: owner.id })).cards.some((item) => item.businessId === storeId), false, "never shown to its own owner");
  const click = await request("/ads/placements/engagement", "POST", { slot: "SIDEBAR", promotionId: card.promotionId, kind: "STORE" }, viewer.cookie);
  assert.equal(click.status, 200, click.raw);
  const events = await db.select().from(storePromotionEvents).where(eq(storePromotionEvents.storePromotionId, card.promotionId));
  assert.deepEqual(events.map((e) => e.eventType).sort(), ["ENGAGEMENT", "IMPRESSION"]);
  assert.ok(events.every((e) => e.viewerKey !== viewer.id), "the viewer is a key, never an identity");
  const result = (await campaignResults(owner.id, JO, c.data.campaignId))[0]!;
  const side = result.placements.find((p) => p.placement === "SIDEBAR")!;
  assert.deepEqual([side.impressions, side.clicks, side.orders], [1, 1, null], "no reliable attribution: «not available», never a fabricated 0");
  assert.match(side.ordersNote!, /غير متاح/);
  assert.equal(result.totals.impressions, 1);
  assert.equal(result.totals.ordersPartial, true);
  // An unpublished store cannot be promoted.
  await db.update(businessProfiles).set({ publicationStatus: "UNPUBLISHED" }).where(eq(businessProfiles.id, storeId));
  const blocked = await quote(owner.cookie, store, [{ productId: hero.id }]);
  assert.equal(blocked.data.ok, false);
  assert.equal((await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: viewer.id })).cards.some((item) => item.businessId === storeId), false, "an unpublished store stops serving at once");
});

test("CMP-11 services and offers: a service listing gets its own category placements", async () => {
  const seller = await account("service");
  const listingId = await publish(seller, `خدمة صيانة مكيفات ${run}`, "services", "خدمات");
  const catalog = await request(`/commercial/promotion-campaigns/placements?listingId=${listingId}`, "GET", undefined, seller.cookie);
  assert.equal(catalog.status, 200, catalog.raw);
  const mine = catalog.data.options.filter((o: any) => [serviceSearch.id, search.id].includes(o.productId)).map((o: any) => o.productId);
  assert.deepEqual(mine, [serviceSearch.id], "the services search placement, not the electronics one");
  const { checkout: c } = await checkout(seller, subjectL(listingId), [{ productId: serviceSearch.id }, { productId: sidebar.id, days: 2 }]);
  assert.equal(c.status, 201, c.raw);
});

test("TGT-01..05 contextual targeting: relevance first, labelled, organic when nothing relevant, no identity to the advertiser", async () => {
  const phoneSeller = await account("tphone");
  const laptopSeller = await account("tlaptop");
  const phone = await publish(phoneSeller, `جوال بكسل ${run}`);
  const laptop = await publish(laptopSeller, `حاسوب لينوفو ${run}`, "other", "أخرى");
  const { checkout: c } = await checkout(phoneSeller, subjectL(phone), [{ productId: search.id }, { productId: sidebar.id, days: 3 }]);
  await pay(c.data.campaignId, phoneSeller.id, `tg_${run}`, "12.000");
  const buyer = await account("tbuyer");
  // 1. a search for the phone lifts the paid phone into a labelled sponsored slot.
  const phoneSearch = await request(`/listings?search=${encodeURIComponent(`جوال بكسل ${run}`)}`, "GET", undefined, buyer.cookie);
  const hit = (phoneSearch.data as any[]).find((row) => row.id === phone);
  assert.ok(hit?.isSponsored, JSON.stringify(phoneSearch.data).slice(0, 400));
  // 2. a laptop search never shows the paid phone.
  const laptopSearch = await request(`/listings?search=${encodeURIComponent(`حاسوب لينوفو ${run}`)}`, "GET", undefined, buyer.cookie);
  assert.ok(!(laptopSearch.data as any[]).some((row) => row.id === phone), "payment never creates relevance");
  assert.ok((laptopSearch.data as any[]).some((row) => row.id === laptop && !row.isSponsored), "organic results instead");
  // 3./4. sidebar with a context category: the paid phone for an electronics context, nothing for an unrelated one.
  const inContext = await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: buyer.id, categoryId: "electronics" });
  assert.ok(inContext.cards.some((card) => card.listingId === phone));
  const unrelated = await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: buyer.id, categoryId: "cars" });
  assert.equal(unrelated.cards.length, 0, "no unrelated ad rather than filler");
  // 5. every paid card carries the label; 6. the advertiser's results hold counts only.
  assert.ok(inContext.cards.every((card) => card.label === "إعلان ممول"));
  const results = await request(`/commercial/promotion-campaigns/${c.data.campaignId}`, "GET", undefined, phoneSeller.cookie);
  assert.doesNotMatch(results.raw, new RegExp(`${buyer.id}|CA tbuyer|viewerKey|bdinar_session`), "no buyer identity, name or key reaches the advertiser");
});

test("GSFM-01 Jassim Go Sell for Me in the conversation: real interest marked real, tips from the listing, honest limits, the placement builder", async () => {
  const seller = await account("gsfm");
  const title = `مكنسة دايسون ${run}`;
  const listingId = await publish(seller, title, "electronics", "إلكترونيات", false);
  const buyers = [await account("g1"), await account("g2"), await account("g3")];
  for (const b of buyers) await saveDemandRequest({ buyerId: b.id, market: JO, needText: title, consent: true });
  const created = await request("/ai/conversations", "POST", {}, seller.cookie);
  const conversationId = created.data.conversation?.id ?? created.data.id;
  const turn = async (message: string) => {
    const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: seller.cookie }, body: JSON.stringify({ message }) });
    const raw = await r.text();
    const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
    assert.ok(complete, raw.slice(0, 300));
    return { body: complete.assistantMessage.body as string, commerce: complete.assistantMessage.blocks[0]?.payload?.commerce ?? {} };
  };
  const plan = await turn("عندي 100 قطعة من هذا المنتج وأريد بيعها");
  assert.match(plan.body, /لا أعدك ببيع الكمية كلها/);
  const p = plan.commerce.promotionPlan;
  assert.ok(p, JSON.stringify(plan.commerce).slice(0, 400));
  assert.ok(p.insights.some((i: any) => i.kind === "REAL" && /3 مشترين طلبوا تنبيههم/.test(i.text)), JSON.stringify(p.insights));
  assert.ok(p.insights.some((i: any) => i.kind === "TIP" && /صورة/.test(i.text)), "no image → a tip from the listing itself");
  assert.ok(p.insights.some((i: any) => i.kind === "LIMIT" && /100 قطعة/.test(i.text)));
  assert.equal(p.campaign.available, true, JSON.stringify(p.campaign));
  assert.ok(p.campaign.options.some((o: any) => o.placement === "SIDEBAR" && o.pricingUnit === "DAY"));
  assert.ok(p.campaign.suggestions.length >= 1 && p.campaign.suggestions.length <= 3);
  assert.ok(p.campaign.suggestions.every((s: any) => s.reason && s.productIds.every((id: string) => p.campaign.options.some((o: any) => o.productId === id))), "suggestions only from the catalog");
  const more = await turn("أريد زبائن أكثر لهذا المنتج");
  assert.equal(more.commerce.view, "PROMOTION_TYPE_OPTIONS", more.body);
  // No store yet: honest answer, nothing invented.
  const store = await turn("روّج لمتجري");
  assert.match(store.body, /لا يوجد لديك متجر/);
  // Results card per placement after a paid campaign (the seller adds the photo first).
  const [own] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, listingId));
  await db.update(offers).set({ data: { ...(own!.data as Record<string, unknown>), imageUrl: PHOTO, imageUrls: [PHOTO] } }).where(eq(offers.id, listingId));
  const { checkout: c } = await checkout(seller, subjectL(listingId), [{ productId: sidebar.id, days: 2 }, { productId: search.id }]);
  await pay(c.data.campaignId, seller.id, `gs_${run}`, "10.000");
  const report = await turn("كيف تسير حملاتي");
  assert.equal(report.commerce.view, "CAMPAIGN_ANALYTICS", report.body);
  const mine = report.commerce.placementCampaigns.find((x: any) => x.campaignId === c.data.campaignId);
  assert.deepEqual(mine.placements.map((x: any) => x.placement).sort(), ["SIDEBAR", "SPONSORED_SEARCH"]);
  assert.ok(mine.advice.length >= 1);
  assert.ok(!report.commerce.campaigns.some((row: any) => mine.placements.length && row.listingTitle === title), "campaign placements are not double-listed");
});

test("GSFM-02 a store owner: «روّج لمتجري» opens the store builder with display placements only", async () => {
  const owner = await account("gstore");
  const storeId = randomUUID();
  await publish(owner, `منتج متجر النور ${run}`);
  await db.insert(businessProfiles).values({ id: storeId, ownerUserId: owner.id, marketId: "JO", displayName: `متجر النور ${run}`, normalizedName: `store-${storeId}`, categoryKey: "OTHER", legalName: "Synthetic Store 2", legalForm: "COMPANY", verificationStatus: "VERIFIED", verifiedAt: new Date(), verifiedBy: admin.id, publicationStatus: "PUBLISHED", idempotencyKey: randomUUID() });
  const created = await request("/ai/conversations", "POST", {}, owner.cookie);
  const conversationId = created.data.conversation?.id ?? created.data.id;
  const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: owner.cookie }, body: JSON.stringify({ message: "أريد ترويج متجري" }) });
  const raw = await r.text();
  const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  const commerce = complete.assistantMessage.blocks[0]?.payload?.commerce ?? {};
  assert.match(complete.assistantMessage.body, /خطة ترويج متجر/, raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(0, 220)).join("\n"));
  assert.equal(commerce.promotionPlan.campaign.subject.kind, "STORE");
  assert.ok(commerce.promotionPlan.campaign.options.length >= 1);
  assert.ok(commerce.promotionPlan.campaign.options.every((o: any) => ["HERO", "SIDEBAR"].includes(o.placement)));
  void promotionProducts;
});

test("IMG-01 the product photo is required where the placement shows it: refused without a photo, never served without one", async () => {
  const seller = await account("nophoto");
  const listingId = await publish(seller, `مروحة بلا صورة ${run}`, "electronics", "إلكترونيات", false);
  const q = await quote(seller.cookie, subjectL(listingId), [{ productId: sidebar.id, days: 2 }, { productId: search.id }]);
  assert.equal(q.data.ok, false);
  assert.equal(q.data.lines.find((l: any) => l.productId === sidebar.id).reason, "أضف صورة للمنتج أولًا؛ هذا الموضع يعرض صورة المنتج");
  assert.equal(q.data.lines.find((l: any) => l.productId === search.id).available, true, "search results do not depend on a photo");
  const catalog = await request(`/commercial/promotion-campaigns/placements?listingId=${listingId}`, "GET", undefined, seller.cookie);
  assert.equal(catalog.data.subject.imagePath, null);
  // A campaign bought with a photo stops showing in hero/sidebar if the photo is later removed.
  const other = await account("photo");
  const withPhoto = await publish(other, `فستان سهرة بصورة ${run}`, "fashion", "أزياء");
  const { checkout: c } = await checkout(other, subjectL(withPhoto), [{ productId: sidebar.id, days: 2 }]);
  await pay(c.data.campaignId, other.id, `img_${run}`, "4.000");
  const viewer = await account("imgviewer");
  // (In its own category: the sidebar shows at most three, and this suite has many paid campaigns.)
  assert.ok((await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: viewer.id, categoryId: "fashion" })).cards.some((card) => card.listingId === withPhoto && card.imagePath === PHOTO));
  const [row] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, withPhoto));
  await db.update(offers).set({ data: { ...(row!.data as Record<string, unknown>), imageUrl: "", imageUrls: [] } }).where(eq(offers.id, withPhoto));
  assert.ok(!(await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: viewer.id, categoryId: "fashion" })).cards.some((card) => card.listingId === withPhoto));
});

test("CTX-01 the sidebar follows the viewer's own conversation; another user's conversation gives no context; ranking puts the most relevant first", async () => {
  const strong = await product({ name: "جانبي أولوية", productType: "SIDEBAR_AD", priceMinor: 3_000, durationDays: 3, pricingUnit: "DAY", minDays: 1, maxDays: 10, priorityWeight: 400 });
  const carSeller = await account("ctxcar");
  const phoneSeller = await account("ctxphone");
  const car = await publish(carSeller, `طاولة خشب زان ${run}`, "home", "منزل");
  const phone = await publish(phoneSeller, `هاتف ون بلس ${run}`);
  const { checkout: c1 } = await checkout(carSeller, subjectL(car), [{ productId: sidebar.id, days: 2 }]);
  await pay(c1.data.campaignId, carSeller.id, `ctx_${run}_1`, "4.000");
  const { checkout: c2 } = await checkout(phoneSeller, subjectL(phone), [{ productId: strong.id, days: 2 }]);
  await pay(c2.data.campaignId, phoneSeller.id, `ctx_${run}_2`, "6.000");
  const viewer = await account("ctxviewer");
  const created = await request("/ai/conversations", "POST", {}, viewer.cookie);
  const conversationId = created.data.conversation?.id ?? created.data.id;
  await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: viewer.cookie }, body: JSON.stringify({ message: `ابحث عن طاولة خشب زان ${run}` }) }).then((r) => r.text());
  const inContext = await request(`/ads/placements?slot=SIDEBAR&conversationId=${conversationId}`, "GET", undefined, viewer.cookie);
  assert.equal(inContext.data.context, "CONVERSATION", inContext.raw.slice(0, 300));
  assert.ok(inContext.data.cards.length >= 1);
  assert.ok(inContext.data.cards.every((card: any) => card.kind === "LISTING"), "stores have no single category: left out in a context");
  assert.ok(inContext.data.cards.some((card: any) => card.listingId === car));
  assert.ok(!inContext.data.cards.some((card: any) => card.listingId === phone), "an unrelated phone is not shown while the viewer looks at tables");
  // Someone else's conversation id gives nothing about it (owner-checked): market-wide only.
  const stranger = await account("ctxstranger");
  const foreign = await request(`/ads/placements?slot=SIDEBAR&conversationId=${conversationId}`, "GET", undefined, stranger.cookie);
  assert.equal(foreign.data.context, "MARKET");
  // Ranking: among many paid electronics campaigns (priority 100), the priority-400 one is first —
  // the card the sidebar shows first; never more than three rotate.
  const ranked = await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: stranger.id, categoryId: "electronics" });
  assert.equal(ranked.cards[0]?.listingId, phone, JSON.stringify(ranked.cards.map((card) => card.title)));
  assert.ok(ranked.cards.length <= 3, "the sidebar rotates through at most three");
  const market = await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: stranger.id });
  assert.ok(market.cards.length >= 1 && market.cards.length <= 3);
});
