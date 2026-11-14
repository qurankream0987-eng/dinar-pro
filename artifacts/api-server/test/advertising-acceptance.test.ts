/**
 * Advertising acceptance (owner decision «Final advertising UX update»): exactly three paid
 * products, welcome-screen sponsored cards, and «جاسم روح بيع لي» matching for exactly 10 days
 * against buyer-authorised saved requests. Development simulation only (no money, no provider):
 * campaigns are paid from a simulated commercial balance. Deterministic clock for every window.
 *
 * Prices in this file are TEST CONFIGURATION in the JO market's currency (JOD), standing in for
 * the owner's proposed USD prices (5 / 5 / 2) until a currency and conversion are approved.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { buyerDemandRequests, commercialLedger, db, markets, demandMatchNotices, listingPromotions, messages, pool, promotionAttributions, users, welcomeAdExposures } from "@workspace/db";
import app from "../src/app";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { resolveMarket } from "../src/lib/markets";
import { changePromotion } from "../src/lib/promotions";
import { demandMatch, matchDemandCampaign, saveDemandRequest } from "../src/lib/demand-requests";
import { welcomeSponsoredCards } from "../src/lib/welcome-ads";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const DAY = 86_400_000;
const run = randomUUID().slice(0, 5);
const marketRow = async (id: string) => resolveMarket((await db.select().from(markets).where(eq(markets.id, id)))[0]!);
const JO = await marketRow("JO");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.19.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_770_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Ad-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `Ads ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id, cookie: c.cookie };
}
async function publish(seller: Actor, title: string, price: string, city = "عمان") {
  const created = await request("/listings", "POST", {
    title, description: `${title} — بحالة ممتازة مع العلبة`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city,
    attributes: { condition: "مستعمل" }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 2, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
async function fund(seller: Actor, amountMajor = 40) {
  const topup = await request("/commercial/topups", "POST", { amountMajor, idempotencyKey: `top-${randomUUID()}` }, seller.cookie);
  assert.equal(topup.status, 201, topup.raw);
  const captured = await request(`/commercial/topups/${topup.data.id ?? topup.data.topup?.id}/simulate-capture`, "POST", {}, seller.cookie);
  assert.equal(captured.status, 200, captured.raw);
}
async function buy(seller: Actor, productId: string, listingId: string) {
  const review = await request("/commercial/purchase-review", "POST", { productId, listingId }, seller.cookie);
  assert.equal(review.status, 200, review.raw);
  const bought = await request("/commercial/purchases", "POST", { productId, listingId, idempotencyKey: `buy-${randomUUID()}` }, seller.cookie);
  assert.ok([200, 201].includes(bought.status), bought.raw);
  return { review: review.data, promotion: bought.data.promotion };
}

const admin = await account("admin");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
const sellerA = await account("sellerA");
const sellerB = await account("sellerB");
const buyer = await account("buyer");
const product: Record<string, string> = {};

await test("AD-01 the policy sells exactly three ad products; a retired type cannot be created", async () => {
  await appendCommercialPolicy({ marketId: "JO", policy: { advertisingProducts: ["SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE", "SPONSORED_SEARCH"], welcomeSponsoredSlots: 2, welcomeSponsoredDailyConversations: 3 }, actorId: null });
  const create = (name: string, productType: string, priceMinor: number, durationDays: number) =>
    request("/admin/markets/JO/commercial-products", "POST", { name: `${name} ${run}`, productType, categoryId: "electronics", priceMinor, durationDays, chargingMode: "FIXED" }, admin.cookie);
  for (const [key, name, type, price, days] of [
    ["A", "إعلان داخل المحادثة", "SPONSORED_RECOMMENDATION", 3_550, 7],
    ["B", "جاسم روح بيع لي", "DEMAND_CAPTURE", 3_550, 10],
    ["C", "تمييز في نتائج البحث", "SPONSORED_SEARCH", 1_420, 7],
  ] as const) {
    const created = await create(name, type, price, days);
    assert.equal(created.status, 201, created.raw);
    product[key] = created.data.id;
  }
  const vip = await create("VIP", "VIP_LISTING", 1_000, 7);
  assert.equal(vip.status, 409, vip.raw);
  assert.equal(vip.data.code, "AD_PRODUCT_NOT_IN_POLICY");
  const listed = await request("/commercial/products", "GET", undefined, sellerA.cookie);
  assert.ok(listed.data.every((item: any) => ["SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE", "SPONSORED_SEARCH", "DINAR_BUSINESS"].includes(item.productType)), JSON.stringify(listed.data.map((i: any) => i.productType)));
});

const listings: Record<string, string> = {};
await test("AD-02 purchases: fee and duration shown before payment; campaigns run exactly 7 / 10 / 7 days, no renewal", async () => {
  await fund(sellerA);
  await fund(sellerB);
  listings.chatA = await publish(sellerA, `سماعة ممولة ${run} أ`, "60");
  listings.chatB = await publish(sellerB, `ساعة ذكية ممولة ${run} ب`, "80");
  listings.demand = await publish(sellerA, `آيفون 13 برو ${run}`, "350");
  listings.search = await publish(sellerB, `لابتوب ممول ${run}`, "500");
  const a = await buy(sellerA, product.A!, listings.chatA);
  const a2 = await buy(sellerB, product.A!, listings.chatB);
  const b = await buy(sellerA, product.B!, listings.demand);
  const c = await buy(sellerB, product.C!, listings.search);
  assert.match(JSON.stringify(b.review), /10 أيام/u, "the 10-day duration is shown before payment");
  assert.match(JSON.stringify(b.review), /دون تجديد تلقائي/u);
  for (const [bought, days] of [[a, 7], [a2, 7], [b, 10], [c, 7]] as const) {
    const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, bought.promotion.id));
    assert.equal(row!.expiresAt.getTime() - row!.startsAt.getTime(), days * DAY, `${row!.productTypeSnapshot} lasts ${days} days`);
  }
});

await test("WS-01..08 welcome cards: ≤2, labelled, real data, stable per screen, gone once a message exists, capped, dismissible", async () => {
  const key = randomUUID();
  const first = await request(`/ai/welcome-sponsored?key=${key}`, "GET", undefined, buyer.cookie);
  assert.equal(first.status, 200, first.raw);
  assert.ok(first.data.cards.length >= 1 && first.data.cards.length <= 2, JSON.stringify(first.data));
  for (const card of first.data.cards) {
    assert.equal(card.label, "إعلان ممول");
    assert.ok([listings.chatA, listings.chatB].includes(card.listingId), "only Sponsored Conversation campaigns, from real listings");
    assert.ok(card.title.includes(run) && card.price && card.currency === "JOD");
  }
  const again = await request(`/ai/welcome-sponsored?key=${key}`, "GET", undefined, buyer.cookie);
  assert.deepEqual(again.data.cards.map((c: any) => c.listingId), first.data.cards.map((c: any) => c.listingId), "refresh/typing never rotates the cards");
  const impressions = await db.select().from(promotionAttributions).where(and(eq(promotionAttributions.placement, "WELCOME"), eq(promotionAttributions.resultSetId, `welcome:${key}`)));
  assert.equal(impressions.length, first.data.cards.length, "one WELCOME impression per card");
  assert.ok(impressions.every((row) => row.chargeStatus === "NOT_BILLABLE"));
  // A seller never sees its own campaign on its welcome screen.
  const own = await request(`/ai/welcome-sponsored?key=${randomUUID()}`, "GET", undefined, sellerA.cookie);
  assert.ok(own.data.cards.every((c: any) => c.listingId !== listings.chatA));
  // Started conversation: never again (a conversation with a message, and the key that became it).
  const conv = (await request("/ai/conversations", "POST", {}, buyer.cookie)).data.id as string;
  await db.insert(messages).values({ id: randomUUID(), conversationId: conv, senderId: buyer.id, body: "مرحبا", actor: "USER" } as never);
  const started = await request(`/ai/welcome-sponsored?key=${conv}&conversationId=${conv}`, "GET", undefined, buyer.cookie);
  assert.deepEqual(started.data, { cards: [], reason: "NOT_EMPTY" });
  // Another user's conversation id is not this user's screen.
  const foreign = await request(`/ai/welcome-sponsored?key=${conv}&conversationId=${conv}`, "GET", undefined, sellerB.cookie);
  assert.equal(foreign.data.cards.length, 0);
  // Daily cap: 3 welcome screens per 24 h (the first key counted already).
  await request(`/ai/welcome-sponsored?key=${randomUUID()}`, "GET", undefined, buyer.cookie);
  await request(`/ai/welcome-sponsored?key=${randomUUID()}`, "GET", undefined, buyer.cookie);
  const capped = await request(`/ai/welcome-sponsored?key=${randomUUID()}`, "GET", undefined, buyer.cookie);
  assert.equal(capped.data.reason, "DAILY_CAP");
  // Dismissal hides that screen's cards for good.
  assert.equal((await request("/ai/welcome-sponsored/dismiss", "POST", { key }, buyer.cookie)).data.dismissed, first.data.cards.length);
  assert.deepEqual((await request(`/ai/welcome-sponsored?key=${key}`, "GET", undefined, buyer.cookie)).data, { cards: [], reason: "DISMISSED" });
  // Exposure rows never become messages.
  const [msgs] = await db.select({ n: count() }).from(messages).where(eq(messages.senderId, buyer.id));
  assert.equal(msgs!.n, 1);
  // No eligible campaigns (a market without them) → no section at all, no filler.
  const kw = await marketRow("KW");
  const none = await welcomeSponsoredCards({ actorId: buyer.id, welcomeKey: randomUUID(), market: kw });
  assert.equal(none.cards.length, 0);
  assert.ok(["NO_ELIGIBLE", "DAILY_CAP"].includes(String(none.reason)));
});

await test("DC-01..12 «جاسم روح بيع لي»: consented requests only, matched inside exactly 10 days, never twice, no identity, no renewal", async () => {
  const [campaign] = await db.select().from(listingPromotions).where(and(eq(listingPromotions.listingId, listings.demand!), eq(listingPromotions.placementSnapshot, "DEMAND")));
  const t0 = campaign!.startsAt.getTime();
  // Consent is mandatory and explicit.
  const refused = await request("/demand-requests", "POST", { needText: "ايفون 13 برو", consent: false }, buyer.cookie);
  assert.equal(refused.status, 400);
  // Day 1: a new matching request during the campaign is matched at once.
  const day1 = await saveDemandRequest({ buyerId: buyer.id, market: JO, needText: "آيفون 13 برو", city: "عمان", priceMaxMinor: 400_000, consent: true, now: new Date(t0 + 1 * DAY) });
  assert.equal(day1.notified, 1, "match on day 1");
  // Duplicate suppression: re-running the campaign match never notifies the same request twice.
  assert.equal((await matchDemandCampaign(campaign!.id, JO, new Date(t0 + 2 * DAY))).notified, 0);
  // Day 9: another buyer's new request still matches.
  const buyer2 = await account("buyer2");
  const day9 = await saveDemandRequest({ buyerId: buyer2.id, market: JO, needText: "ايفون 13 برو مستعمل", consent: true, now: new Date(t0 + 9 * DAY) });
  assert.equal(day9.notified, 1, "match on day 9");
  // After day 10: the campaign no longer matches anything.
  const buyer3 = await account("buyer3");
  const day11 = await saveDemandRequest({ buyerId: buyer3.id, market: JO, needText: "ايفون 13 برو", consent: true, now: new Date(t0 + 10 * DAY + 60_000) });
  assert.equal(day11.notified, 0, "expired after exactly 10 days");
  assert.equal((await matchDemandCampaign(campaign!.id, JO, new Date(t0 + 10 * DAY + 60_000))).serving, false);
  // No matching buyer: other models, other cities, over budget.
  assert.equal(demandMatch({ needText: "آيفون 14 برو", categoryId: null, city: null, priceMaxMinor: null }, { title: `آيفون 13 برو ${run}`, description: "", attributes: {}, categoryId: "electronics", city: "عمان", priceMinor: 350_000 }, 0.5), undefined, "model numbers must match");
  assert.equal(demandMatch({ needText: "آيفون 13 برو", categoryId: null, city: "الزرقاء", priceMaxMinor: null }, { title: `آيفون 13 برو`, description: "", attributes: {}, categoryId: "electronics", city: "عمان", priceMinor: 350_000 }, 0.5), undefined);
  assert.equal(demandMatch({ needText: "آيفون 13 برو", categoryId: null, city: null, priceMaxMinor: 300_000 }, { title: `آيفون 13 برو`, description: "", attributes: {}, categoryId: "electronics", city: "عمان", priceMinor: 350_000 }, 0.5), undefined);
  const partial = demandMatch({ needText: "آيفون 13 برو ماكس", categoryId: null, city: null, priceMaxMinor: null }, { title: `آيفون 13 برو`, description: "", attributes: {}, categoryId: "electronics", city: "عمان", priceMinor: 350_000 }, 0.5);
  assert.equal(partial?.exact, false, "partial match is labelled as partial");
  // Buyer sees the notice; the seller sees only a count and can never read the request.
  const matches = await request("/demand-requests/matches", "GET", undefined, buyer.cookie);
  assert.equal(matches.data.matches.length, 1);
  assert.equal(matches.data.matches[0].listingId, listings.demand);
  const reach = await request(`/promotions/${campaign!.id}/demand-reach`, "GET", undefined, sellerA.cookie);
  assert.equal(reach.data.buyersNotified, 2);
  assert.doesNotMatch(reach.raw, new RegExp(buyer.id), "no buyer identity reaches the seller");
  assert.equal((await request(`/promotions/${campaign!.id}/demand-reach`, "GET", undefined, sellerB.cookie)).status, 404, "another seller cannot read the reach");
  const requestId = day1.request.id;
  assert.equal((await request(`/demand-requests/${requestId}/opt-out`, "POST", {}, sellerA.cookie)).status, 404, "nobody else can touch the request");
  // Opt-out: later campaigns do not match; deletion removes text and notices.
  assert.equal((await request(`/demand-requests/${requestId}/opt-out`, "POST", {}, buyer.cookie)).data.status, "OPTED_OUT");
  const listed = (await request("/demand-requests", "GET", undefined, buyer2.cookie)).data.requests[0];
  const removed = await request(`/demand-requests/${listed.id}`, "DELETE", {}, buyer2.cookie);
  assert.equal(removed.data?.deleted, true, `${removed.status} ${removed.raw}`);
  const [deleted] = await db.select().from(buyerDemandRequests).where(eq(buyerDemandRequests.id, listed.id));
  assert.equal(deleted!.needText, "--");
  assert.equal((await db.select().from(demandMatchNotices).where(eq(demandMatchNotices.requestId, listed.id))).length, 0);
  // Seller cancellation: a cancelled campaign matches nothing more.
  const fresh = await publish(sellerB, `آيفون 12 برو ${run}`, "260");
  const second = await buy(sellerB, product.B!, fresh);
  await changePromotion({ actorId: sellerB.id, market: JO, promotionId: second.promotion.id, action: "CANCEL" });
  const buyer4 = await account("buyer4");
  assert.equal((await saveDemandRequest({ buyerId: buyer4.id, market: JO, needText: "ايفون 12 برو", consent: true })).notified, 0, "cancelled campaign never matches");
  // No unintended renewal: no ledger entry for the expired campaign after its window.
  const before = await db.select({ n: count() }).from(commercialLedger).where(eq(commercialLedger.promotionId, campaign!.id));
  await matchDemandCampaign(campaign!.id, JO, new Date(t0 + 15 * DAY));
  const afterRows = await db.select({ n: count() }).from(commercialLedger).where(eq(commercialLedger.promotionId, campaign!.id));
  assert.equal(afterRows[0]!.n, before[0]!.n);
  assert.equal((await db.select().from(listingPromotions).where(eq(listingPromotions.id, campaign!.id)))[0]!.autoRenew ?? false, false);
});

await test("DC-13 in the conversation: «نبّهني إذا توفر» shows what is stored and saves only after explicit consent", async () => {
  const shopper = await account("shopper");
  const conv = (await request("/ai/conversations", "POST", {}, shopper.cookie)).data.id as string;
  const say = async (message: string) => {
    const r = await fetch(`${base}/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: shopper.cookie }, body: JSON.stringify({ message }) });
    const raw = await r.text();
    const done = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
    return { body: String(done?.assistantMessage?.body ?? raw), payload: done?.assistantMessage?.blocks?.[0]?.payload ?? {} };
  };
  await say(`ابحث عن مكنسة روبوت ${run}`);
  const asked = await say("نبهني اذا توفر");
  assert.match(asked.body, /لن يعرف أي بائع هويتك/u);
  assert.equal(asked.payload.advice?.options?.[0]?.message, "أوافق على حفظ طلب التنبيه");
  assert.equal((await db.select().from(buyerDemandRequests).where(eq(buyerDemandRequests.buyerId, shopper.id))).length, 0, "nothing stored before consent");
  const saved = await say("أوافق على حفظ طلب التنبيه");
  assert.match(saved.body, /حفظت طلبك/u, saved.body);
  const [row] = await db.select().from(buyerDemandRequests).where(eq(buyerDemandRequests.buyerId, shopper.id));
  assert.ok(row && row.needText.includes(run) && row.consentVersion);
  assert.equal(row!.expiresAt.getTime() - row!.createdAt.getTime(), 30 * DAY, "policy retention: 30 days");
});

after(async () => { server.close(); await pool.end(); });
