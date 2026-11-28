/**
 * Jassim Ads Phase 1 acceptance (disposable DB; simulated payment only; DINAR_JASSIM_ADS toggled per test).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { db, demandMatchNotices, markets, offers, pool, users } from "@workspace/db";
import app from "../src/app";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { resolveMarket } from "../src/lib/markets";
import { saveDemandRequest, waitingBuyersForListing } from "../src/lib/demand-requests";
import { displayPlacementCards } from "../src/lib/welcome-ads";
import { adCopyDrafts, adsOpportunities, sellerAdsListings } from "../src/lib/jassim-ads";
import { adsIntent, executeAdsAssistantTurn } from "../src/ai/ads-assistant-turn";
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
  // Hero and sidebar show the product photo (owner decision 2026-11-28): these listings have one.
  const [photoRow] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, created.data.id));
  await db.update(offers).set({ data: { ...(photoRow!.data as Record<string, unknown>), imageUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxyZWN0IHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9IiNmYTAiLz48L3N2Zz4=", imageUrls: ["data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxyZWN0IHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9IiNmYTAiLz48L3N2Zz4="] } }).where(eq(offers.id, created.data.id));
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
const seller = await account("seller");
const other = await account("other");
const buyers = [await account("b1"), await account("b2"), await account("b3"), await account("b4")];
after(async () => { server.close(); await pool.end(); });

const createProduct = async (name: string, productType: string, priceMinor: number) => {
  const created = await request("/admin/markets/JO/commercial-products", "POST", { name: `${name} ${run}`, productType, categoryId: "electronics", priceMinor, durationDays: 7, chargingMode: "FIXED" }, admin.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
};

const phone = await publish(seller, `سامسونج جالاكسي S23 ${run}`, "250.000");
const laptop = await publish(seller, `لابتوب ديل ${run}`, "400.000");
const foreign = await publish(other, `سامسونج جالاكسي S23 مستعمل ${run}`, "240.000");

test("JA-01 intent: claims only explicit marketing advice; selling and buying promotion stay with their own turns", () => {
  for (const m of ["ساعدني أسوّق متجري", "شو أروّج؟", "فرص التسويق", "جاسم أدز", "اكتب لي نص إعلاني للثاني", "اكتب لي نصا اعلانيا", "كيف تسير حملاتي", "تقرير الترويج"]) assert.ok(adsIntent(m), m);
  for (const m of ["أبي أبيع جوالي", "روّج الإعلان", "روج الثاني لمدة 7 أيام", "اعمل لي إعلان", "إعلاناتي", "أريد شراء هاتف"]) assert.equal(adsIntent(m), undefined, m);
});

test("JA-02 flag off: no assistant turn and no display placements", async () => {
  delete process.env.DINAR_JASSIM_ADS;
  assert.equal(await executeAdsAssistantTurn({ conversationId: randomUUID(), message: "شو أروّج؟", market: JO, actorId: seller.id }), null);
  assert.deepEqual((await request("/ads/placements?slot=HERO")).data.cards, []);
});

test("JA-03 «جاسم روح بيع لي»: waiting buyers only at or above the cohort size, never the seller's own, never another seller's listing", async () => {
  await appendCommercialPolicy({ marketId: "JO", policy: { minCohortSize: 3 }, actorId: admin.id });
  for (const b of buyers.slice(0, 2)) await saveDemandRequest({ buyerId: b.id, market: JO, needText: "سامسونج جالاكسي S23", consent: true });
  await saveDemandRequest({ buyerId: seller.id, market: JO, needText: "سامسونج جالاكسي S23", consent: true });
  assert.deepEqual(await waitingBuyersForListing(phone, seller.id, JO), { status: "NOT_ENOUGH_DATA" }, "2 buyers (+ the seller himself) is below 3: nothing is revealed");
  await saveDemandRequest({ buyerId: buyers[2]!.id, market: JO, needText: "سامسونج جالاكسي S23", consent: true });
  assert.deepEqual(await waitingBuyersForListing(phone, seller.id, JO), { status: "COUNT", buyers: 3 });
  assert.deepEqual(await waitingBuyersForListing(laptop, seller.id, JO), { status: "NOT_ENOUGH_DATA" }, "no match for another product");
  assert.deepEqual(await waitingBuyersForListing(foreign, seller.id, JO), { status: "NOT_ENOUGH_DATA" }, "a seller never probes someone else's listing");
  const [{ n }] = await db.select({ n: count() }).from(demandMatchNotices);
  assert.equal(n, 0, "reading demand notifies nobody");
});

test("JA-04 assistant (flag on): opportunities from facts, demand first; copy drafts only from listing facts; report honest when empty", async () => {
  process.env.DINAR_JASSIM_ADS = "true";
  try {
    const listings = await sellerAdsListings(seller.id, JO);
    assert.deepEqual(listings.map((l) => l.id).sort(), [phone, laptop].sort(), "only the seller's own published listings");
    const ops = adsOpportunities(listings);
    assert.equal(ops[0]?.kind, "DEMAND_CAPTURE");
    assert.match(ops[0]!.text, /^3 مشترين/);
    assert.doesNotMatch(ops.map((o) => o.text).join(" "), new RegExp(buyers.map((b) => b.id).join("|")), "no buyer identity");
    const overview = await executeAdsAssistantTurn({ conversationId: randomUUID(), message: "شو أروّج؟", market: JO, actorId: seller.id });
    assert.ok(overview);
    assert.match(overview!.result.prompt, /جاسم روح بيع لي/);
    const target = listings.find((l) => l.id === phone)!;
    const drafts = adCopyDrafts(target);
    assert.equal(drafts.length, 3);
    for (const d of drafts) {
      assert.ok(d.includes(target.title), d);
      assert.ok(d.includes(target.priceLabel!), d);
      assert.doesNotMatch(d, /خصم|مجان|ضمان|الأفضل|الأرخص/, "no invented claims");
    }
    const copy = await executeAdsAssistantTurn({ conversationId: randomUUID(), message: "اكتب لي نص إعلاني للأول", market: JO, actorId: seller.id });
    assert.match(copy!.result.prompt, /مسودات نص إعلاني/);
    assert.match(copy!.result.prompt, /لم يُنشر أو يُدفع شيء/);
    const report = await executeAdsAssistantTurn({ conversationId: randomUUID(), message: "كيف تسير حملاتي", market: JO, actorId: seller.id });
    assert.match(report!.result.prompt, /لا توجد لديك حملات/);
    const none = await executeAdsAssistantTurn({ conversationId: randomUUID(), message: "شو أروّج؟", market: JO, actorId: buyers[3]!.id });
    assert.match(none!.result.prompt, /لا توجد لديك إعلانات منشورة/);
  } finally {
    delete process.env.DINAR_JASSIM_ADS;
  }
});

test("JA-05 display placements: hero = paid VIP only, sidebar = FEATURED/VIP, labelled, visible to guests, never the viewer's own; welcome policy accepts 3", async () => {
  const vip = await createProduct("VIP", "VIP_LISTING", 5_000);
  const featured = await createProduct("تمييز", "FEATURED_LISTING", 3_000);
  await fund(seller, 40);
  await buy(seller, vip, phone);
  await buy(seller, featured, laptop);
  process.env.DINAR_JASSIM_ADS = "true";
  try {
    const hero = await request("/ads/placements?slot=HERO", "GET", undefined, "bdinar_guest_market=JO");
    assert.equal(hero.status, 200, hero.raw);
    const rows = (await pool.query("select listing_id, placement_snapshot, status, payment_status, starts_at, expires_at from listing_promotions")).rows;
    assert.deepEqual(hero.data.cards.map((c: any) => c.listingId), [phone], `hero shows only the VIP campaign; reason=${hero.data.reason}; rows=${JSON.stringify(rows)}`);
    assert.ok(hero.data.cards.every((c: any) => c.label && c.label.length > 0), "every card is labelled");
    const side = await request("/ads/placements?slot=SIDEBAR", "GET", undefined, buyers[0]!.cookie);
    assert.deepEqual(side.data.cards.map((c: any) => c.listingId).sort(), [phone, laptop].sort());
    const own = await displayPlacementCards({ placement: "SIDEBAR", market: JO, viewerId: seller.id });
    assert.equal(own.cards.length, 0, "a seller never sees his own paid card");
    assert.equal((await request("/ads/placements?slot=OTHER")).status, 400);
    await appendCommercialPolicy({ marketId: "JO", policy: { welcomeSponsoredSlots: 3 }, actorId: admin.id });
    await assert.rejects(appendCommercialPolicy({ marketId: "JO", policy: { welcomeSponsoredSlots: 4 }, actorId: admin.id }));
  } finally {
    delete process.env.DINAR_JASSIM_ADS;
  }
});
