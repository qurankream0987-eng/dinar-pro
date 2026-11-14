/**
 * Jassim Connect Mode A acceptance: an owner moves an offer that Connect already read from their
 * store into a normal DINAR listing. Partner review / business verification / site proof have
 * their own suites (connect-partners, connect-domain); here those canonical states are set
 * directly on a disposable DB so this suite measures the import rules only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { buyerDemandRequests, businessProfiles, commercialLedger, connectIntegrations, connectOffers, connectPartners, connectSites, db, demandMatchNotices, listingPromotions, marketAudit, markets, offers, pool, users } from "@workspace/db";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { resolveMarket } from "../src/lib/markets";
import { changePromotion } from "../src/lib/promotions";
import { saveDemandRequest } from "../src/lib/demand-requests";
import app from "../src/app";
import { connectImportListingId } from "../src/connect/catalog-import";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.18.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_660_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Cn-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `Connect ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id, cookie: c.cookie };
}

const owner = await account("مالك");
const stranger = await account("غريب");
const reviewer = await account("مراجع");
const business = await request("/business/profiles", "POST", { displayName: `متجر ربط ${randomUUID().slice(0, 6)}`, categoryKey: "OTHER", idempotencyKey: randomUUID() }, owner.cookie);
assert.equal(business.status, 201, business.raw);
const businessId = business.data.business.id as string;
const created = await request("/connect/partners", "POST", { businessId }, owner.cookie);
assert.equal(created.status, 201, created.raw);
const partnerId = created.data.id as string;
const now = new Date();
await db.update(businessProfiles).set({ verificationStatus: "VERIFIED", verifiedAt: now, verifiedBy: reviewer.id }).where(eq(businessProfiles.id, businessId));
const setPartner = (values: Partial<typeof connectPartners.$inferInsert>) => db.update(connectPartners).set(values).where(eq(connectPartners.id, partnerId));
await setPartner({ status: "APPROVED", participationMode: "SELL_INSIDE_DINAR" });
const siteId = randomUUID();
await db.insert(connectSites).values({ id: siteId, partnerId, hostname: `shop-${randomUUID().slice(0, 6)}.example`, status: "VERIFIED", challengeDigest: "0".repeat(64), challengeExpiresAt: now, verifiedAt: now, validUntil: new Date(now.getTime() + 30 * 86_400_000) });
const integrationId = randomUUID();
await db.insert(connectIntegrations).values({ id: integrationId, partnerId, siteId, name: "كتالوج", kind: "FEED", status: "APPROVED", mode: "SIMULATION_ONLY", capabilities: ["CATALOG_READ"] });
async function offer(values: Partial<typeof connectOffers.$inferInsert>) {
  const id = randomUUID();
  await db.insert(connectOffers).values({
    id, partnerId, integrationId, externalId: `ext-${id.slice(0, 8)}`, kind: "PRODUCT", title: "سماعة لاسلكية من المتجر",
    description: "سماعة لاسلكية أصلية بعلبتها من متجري الإلكتروني", categoryId: "electronics", priceMinor: 25_500, currencyCode: "JOD", minorUnitScale: 3,
    availability: "AVAILABLE", targetPath: "/p/1", sourceVersion: 1, sourceCheckedAt: new Date(), payloadDigest: "f".repeat(64), ...values,
  });
  return id;
}
const fresh = await offer({});
const stale = await offer({ sourceCheckedAt: new Date(Date.now() - 25 * 3_600_000) });
const usd = await offer({ currencyCode: "USD", minorUnitScale: 2, priceMinor: 3_500 });
const unpriced = await offer({ priceMinor: null, currencyCode: null, minorUnitScale: null });
const hidden = await offer({ status: "HIDDEN" });
const path = (offerId: string) => `/connect/partners/${partnerId}/offers/${offerId}/import`;
const ownerInput = { confirm: true, expectedSourceVersion: 1, expectedPriceMinor: 25_500, area: "خلدا", city: "عمان", inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", paymentMethods: ["CASH_DIRECT"], attributes: { condition: "جديد" } };


test("CI-01 preview: verified store price in market currency, free, owner provides stock/location", async () => {
  const preview = await request(path(fresh), "GET", undefined, owner.cookie);
  assert.equal(preview.status, 200, preview.raw);
  assert.equal(preview.data.canImport, true, preview.raw);
  assert.deepEqual(preview.data.blockers, []);
  assert.equal(preview.data.price, "25.500");
  assert.equal(preview.data.currency, "JOD");
  assert.equal(preview.data.fee.amountMinor, 0);
  assert.ok(preview.data.ownerMustProvide.includes("inventoryMode"));
  assert.match(preview.data.disclosure, /لا يُفعَّل الدفع في موقعك/);
});

test("CI-02 strangers get 404 for preview and import; a hidden offer does not exist", async () => {
  assert.equal((await request(path(fresh), "GET", undefined, stranger.cookie)).status, 404);
  assert.equal((await request(path(fresh), "POST", ownerInput, stranger.cookie)).status, 404);
  assert.equal((await request(path(hidden), "GET", undefined, owner.cookie)).status, 404);
  assert.equal((await request(path(fresh), "GET")).status, 401);
});

test("CI-03 refusals: stale data, foreign currency, unknown price — no conversion, nothing created", async () => {
  for (const [id, code] of [[stale, "STALE_OFFER"], [usd, "CURRENCY_MISMATCH"], [unpriced, "PRICE_UNKNOWN"]] as const) {
    const preview = await request(path(id), "GET", undefined, owner.cookie);
    assert.equal(preview.data.canImport, false);
    assert.equal(preview.data.blockers[0].code, code);
    const r = await request(path(id), "POST", { ...ownerInput, expectedPriceMinor: preview.data.priceMinor }, owner.cookie);
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.data.code ?? r.data.error?.code, code, r.raw);
    assert.equal((await db.select({ n: count() }).from(offers).where(eq(offers.id, connectImportListingId(partnerId, id))))[0]!.n, 0);
  }
});

test("CI-04 mode and capability: website-only mode and an unapproved partner cannot import", async () => {
  await setPartner({ participationMode: "BUY_ON_MERCHANT_WEBSITE" });
  let r = await request(path(fresh), "POST", ownerInput, owner.cookie);
  assert.equal(r.status, 409); assert.match(r.raw, /MODE_EXCLUDES_INTERNAL_SALE/);
  await setPartner({ participationMode: "SELL_INSIDE_DINAR", status: "PENDING_REVIEW" });
  r = await request(path(fresh), "POST", ownerInput, owner.cookie);
  assert.equal(r.status, 409); assert.match(r.raw, /INTERNAL_SALE_NOT_ENABLED/);
  await setPartner({ status: "APPROVED" });
});

test("CI-05 explicit confirmation, unchanged source, and owner-stated stock are required", async () => {
  assert.equal((await request(path(fresh), "POST", { ...ownerInput, confirm: false }, owner.cookie)).status, 400);
  assert.equal((await request(path(fresh), "POST", { ...ownerInput, priceMinor: 1 }, owner.cookie)).status, 400, "no client price field is accepted");
  const changed = await request(path(fresh), "POST", { ...ownerInput, expectedPriceMinor: 20_000 }, owner.cookie);
  assert.equal(changed.status, 409); assert.match(changed.raw, /OFFER_CHANGED/);
  const noQty = await request(path(fresh), "POST", { ...ownerInput, availableQuantity: undefined }, owner.cookie);
  assert.equal(noQty.status, 400); assert.match(noQty.raw, /QUANTITY_REQUIRED/);
  assert.equal((await db.select({ n: count() }).from(offers).where(eq(offers.id, connectImportListingId(partnerId, fresh))))[0]!.n, 0);
});

test("CI-06 import creates one normal listing at the verified price; retries and parallel clicks do not duplicate", async () => {
  const [a, b] = await Promise.all([request(path(fresh), "POST", ownerInput, owner.cookie), request(path(fresh), "POST", ownerInput, owner.cookie)]);
  for (const r of [a, b]) assert.equal(r.status, 200, r.raw);
  const id = connectImportListingId(partnerId, fresh);
  assert.deepEqual(new Set([a.data.listingId, b.data.listingId]), new Set([id]));
  const [row] = await db.select().from(offers).where(eq(offers.id, id));
  assert.equal(row!.sellerId, owner.id);
  assert.equal(row!.unitPriceMinor, 25_500, "price is the store's verified price, in JOD minor units");
  assert.equal(row!.availableQuantity, 4, "stock is the owner's statement");
  const again = await request(path(fresh), "POST", ownerInput, owner.cookie);
  assert.equal(again.data.result, "ALREADY_IMPORTED");
  assert.equal((await db.select({ n: count() }).from(offers).where(eq(offers.id, id)))[0]!.n, 1);
  const preview = await request(path(fresh), "GET", undefined, owner.cookie);
  assert.equal(preview.data.alreadyImportedListingId, id);
  assert.equal(preview.data.canImport, false);
  const publicView = await request(`/listings/${id}`, "GET", undefined, stranger.cookie);
  assert.equal(publicView.status, 200, publicView.raw);
  assert.equal(publicView.data.title, "سماعة لاسلكية من المتجر");
  assert.equal((await db.select({ n: count() }).from(marketAudit).where(and(eq(marketAudit.action, "CONNECT_OFFER_IMPORTED"), eq(marketAudit.actorId, owner.id))))[0]!.n, 1);
});

test("CI-07 importing is free and leaves website checkout off; HYBRID imports the same way", async () => {
  assert.equal((await db.select({ n: count() }).from(commercialLedger).where(eq(commercialLedger.userId, owner.id)))[0]!.n, 0, "no fee, balance or commission entry");
  await setPartner({ participationMode: "HYBRID" });
  const second = await offer({ title: "شاحن سريع من المتجر", description: "شاحن سريع أصلي بعلبته من متجري الإلكتروني", priceMinor: 9_000 });
  const r = await request(path(second), "POST", { ...ownerInput, expectedPriceMinor: 9_000 }, owner.cookie);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.result, "CREATED");
  const view = await request(`/connect/partners/${partnerId}`, "GET", undefined, owner.cookie);
  assert.equal(view.data.participation.nativeCatalogCheckout.enabled, false);
  assert.equal(view.data.participation.internalSale.enabled, true);
  assert.equal(view.data.registrationFeeMinor, 0);
});

test("CI-08 Connect + «جاسم روح بيع لي»: an imported product matches saved demand for exactly 10 days — exact, partial, none, opted-out, expired, wrong market, cancellation", async () => {
  process.env.BDINAR_PROMOTIONS_ENABLED = "true";
  const marketRow = async (id: string) => resolveMarket((await db.select().from(markets).where(eq(markets.id, id)))[0]!);
  const JO = await marketRow("JO");
  const KW = await marketRow("KW");
  const admin = await account("admin");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await appendCommercialPolicy({ marketId: "JO", policy: { advertisingProducts: ["SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE", "SPONSORED_SEARCH"] }, actorId: null });
  const product = await request("/admin/markets/JO/commercial-products", "POST", { name: `جاسم روح بيع لي ${randomUUID().slice(0, 4)}`, productType: "DEMAND_CAPTURE", categoryId: "electronics", priceMinor: 3_550, durationDays: 10, chargingMode: "FIXED" }, admin.cookie);
  assert.equal(product.status, 201, product.raw);

  // Buyers' authorised requests saved BEFORE the merchant's product exists in DINAR.
  const exact = await account("exact"), partial = await account("partial"), none = await account("none"), opted = await account("opted"), expired = await account("expired"), foreign = await account("foreign");
  const save = (who: Actor, needText: string) => request("/demand-requests", "POST", { needText, consent: true }, who.cookie);
  assert.equal((await request("/demand-requests", "POST", { needText: "ساعة ذكية" }, exact.cookie)).status, 400, "no request is stored without explicit consent");
  const rExact = await save(exact, "ساعة ذكية");
  assert.equal(rExact.status, 201, rExact.raw);
  await save(partial, "ساعة ذكية رياضية أصلية");
  await save(none, "ثلاجة كبيرة");
  const rOpted = await save(opted, "ساعة ذكية");
  assert.equal((await request(`/demand-requests/${rOpted.data.request?.id ?? rOpted.data.id}/opt-out`, "POST", {}, opted.cookie)).status, 200);
  const rExpired = await save(expired, "ساعة ذكية");
  await db.update(buyerDemandRequests).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(buyerDemandRequests.id, rExpired.data.request?.id ?? rExpired.data.id));
  await saveDemandRequest({ buyerId: foreign.id, market: KW, needText: "ساعة ذكية", consent: true });

  // The merchant imports the product from the connected store, then buys the 10-day campaign.
  await setPartner({ participationMode: "SELL_INSIDE_DINAR" });
  const watch = await offer({ title: "ساعة ذكية أصلية", description: "ساعة ذكية أصلية بعلبتها من متجري الإلكتروني", priceMinor: 60_000 });
  const imported = await request(path(watch), "POST", { ...ownerInput, expectedPriceMinor: 60_000 }, owner.cookie);
  assert.equal(imported.status, 200, imported.raw);
  const topup = await request("/commercial/topups", "POST", { amountMajor: 40, idempotencyKey: `top-${randomUUID()}` }, owner.cookie);
  assert.equal(topup.status, 201, topup.raw);
  assert.equal((await request(`/commercial/topups/${topup.data.id ?? topup.data.topup?.id}/simulate-capture`, "POST", {}, owner.cookie)).status, 200);
  const review = await request("/commercial/purchase-review", "POST", { productId: product.data.id, listingId: imported.data.listingId }, owner.cookie);
  assert.equal(review.status, 200, review.raw);
  assert.match(JSON.stringify(review.data), /10 أيام/u);
  assert.match(JSON.stringify(review.data), /دون تجديد تلقائي/u);
  const bought = await request("/commercial/purchases", "POST", { productId: product.data.id, listingId: imported.data.listingId, idempotencyKey: `buy-${randomUUID()}` }, owner.cookie);
  assert.ok([200, 201].includes(bought.status), bought.raw);
  const [campaign] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, bought.data.promotion.id));
  assert.equal(campaign!.expiresAt.getTime() - campaign!.startsAt.getTime(), 10 * 86_400_000, "exactly 10 days");

  const notices = async (who: Actor) => (await db.select().from(demandMatchNotices).where(eq(demandMatchNotices.buyerId, who.id))).filter((n) => n.listingId === imported.data.listingId).length;
  assert.equal(await notices(exact), 1, "exact match");
  assert.equal(await notices(partial), 1, "partial match above the policy's coverage threshold");
  assert.equal(await notices(none), 0, "no match");
  assert.equal(await notices(opted), 0, "opted out");
  assert.equal(await notices(expired), 0, "expired request");
  assert.equal(await notices(foreign), 0, "another market");
  const matches = await request("/demand-requests/matches", "GET", undefined, exact.cookie);
  assert.match(matches.raw, /إعلان ممول — جاسم روح بيع لي/u);
  const reach = await request(`/promotions/${campaign!.id}/demand-reach`, "GET", undefined, owner.cookie);
  assert.equal(reach.data.buyersNotified, 2);
  assert.doesNotMatch(reach.raw, new RegExp(`${exact.id}|${partial.id}|Connect exact|Connect partial`), "the seller sees a count, never who");

  // Seller cancellation: later requests are no longer matched by this campaign.
  await changePromotion({ actorId: owner.id, market: JO, promotionId: campaign!.id, action: "CANCEL" });
  const late = await account("late");
  assert.equal((await saveDemandRequest({ buyerId: late.id, market: JO, needText: "ساعة ذكية", consent: true })).notified, 0, "a cancelled campaign matches nothing");
});

after(async () => { server.close(); await pool.end(); });
