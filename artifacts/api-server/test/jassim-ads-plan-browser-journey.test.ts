/**
 * Jassim Ads plan — browser journey (real Chromium, the Vite web app, the real API, a disposable DB).
 * A fake collection provider is registered: no Whop, no network, no money. The browser never opens
 * the provider page; it checks the handoff link, then the test applies one signed-event stand-in.
 *   phase PLAN    — plan card, options + server prices, suggested option, copy, interested buyers
 *                   (above / below the privacy threshold), review, confirmation, payment handoff
 *   phase RESULTS — the campaign-results card after the payment
 * Mobile (390) and desktop (1280), Arabic RTL, no horizontal overflow, screenshots kept.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { businessProfiles, db, markets, offers, pool, promotionCampaigns, users } from "@workspace/db";
import app from "../src/app";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { resolveMarket } from "../src/lib/markets";
import { saveDemandRequest } from "../src/lib/demand-requests";
import { registerPromotionBillingProvider, unregisterPromotionBillingProvider } from "../src/lib/promotion-billing";
import { applyPromotionProviderEvent } from "../src/lib/promotion-payments";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
process.env.DINAR_JASSIM_ADS = "true";
process.env.DINAR_JASSIM_ADS_PAYMENTS = "true";
const run = randomUUID().slice(0, 5);
registerPromotionBillingProvider({
  key: "test-gateway",
  displayName: "بوابة الاختبار",
  currencies: new Set(["JOD"]),
  async createCheckout(input) {
    return { checkoutId: `tg_${input.promotionId}`, checkoutUrl: `https://pay.test-gateway.example/tg_${input.promotionId}` };
  },
  async checkoutUrl(id) {
    return `https://pay.test-gateway.example/${id}`;
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  unregisterPromotionBillingProvider("test-gateway");
  for (const key of ["DINAR_JASSIM_ADS", "DINAR_JASSIM_ADS_PAYMENTS"]) delete process.env[key];
  server.close();
  await pool.end();
});
let ip = 0;
async function req(path: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(`${origin}/api${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), "X-Forwarded-For": `198.71.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
let offset = 0;
async function register(label: string) {
  const phoneNumber = String(51_230_000 + ((Date.now() + process.pid + 7 * offset++) % 60_000));
  const s = await req("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await req("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const pw = `Apb-${randomUUID().slice(0, 10)}!`;
  const u = await req("/auth/register", "POST", { displayName: `مستخدم ${label}`, phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password: pw, confirmPassword: pw, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(u.status, 201, u.raw);
  await req("/account/market", "PATCH", { marketId: "JO" }, u.cookie);
  const id = u.data.user.id as string;
  return { cookie: u.cookie, id, conv: (await req("/ai/conversations", "POST", {}, u.cookie)).data.id as string };
}
async function publish(seller: { cookie: string }, title: string) {
  const r = await req("/listings", "POST", {
    title, description: `${title} — جديدة بالكرتونة`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
    attributes: { condition: "جديد" }, unitPrice: "40.000", inventoryMode: "LIMITED", availableQuantity: 100, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
  }, seller.cookie);
  assert.equal(r.status, 201, r.raw);
  const id = r.data.id as string;
  // Hero and sidebar show the product photo: the journey's listings have one.
  const [row] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, id));
  await db.update(offers).set({ data: { ...(row!.data as Record<string, unknown>), imageUrl: PHOTO, imageUrls: [PHOTO] } }).where(eq(offers.id, id));
  return id;
}
const PHOTO = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI4MCI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjNDQ0Ii8+PGNpcmNsZSBjeD0iNDAiIGN5PSI0MCIgcj0iMjQiIGZpbGw9IiNmYTAiLz48L3N2Zz4=";

async function browser(phase: string, fixture: unknown, web: { baseUrl: string }) {
  const reportPath = `/tmp/dinar-ads-plan-${phase}-${randomUUID()}.json`;
  let runError: unknown;
  try {
    await promisify(execFile)(process.execPath, [`${process.cwd()}/../dinar/test/jassim-ads-plan-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: { ...process.env, AP_PHASE: phase, AP_WEB: web.baseUrl, AP_API: origin, AP_REPORT: reportPath, AP_SHOTS: `${process.env.DINAR_BROWSER_EVIDENCE_DIR ?? `${process.cwd()}/.test-build/browser-evidence`}/jassim-ads-plan`, AP_FIXTURE: JSON.stringify(fixture) },
      timeout: 600_000, maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) { runError = error; }
  let report: any;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); await unlink(reportPath); } catch {}
  console.log(`ADS_PLAN_BROWSER_${phase}`, JSON.stringify(report));
  if (!report) throw runError ?? new Error("no browser report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, [], "the provider page is never opened");
  return report;
}

test("ADS-PLAN browser: Go Sell for Me plan, placement builder (multi-select, days, copy, server total), payment handoff, per-placement results, store card — mobile and desktop, RTL", async () => {
  await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
  const admin = await register("admin");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await appendCommercialPolicy({ marketId: "JO", policy: { advertisingBillingActivation: "PROVIDER_DIRECT", advertisingBillingProvider: "test-gateway", minCohortSize: 3 }, actorId: admin.id });
  const product = async (body: Record<string, unknown>) => {
    const r = await req("/admin/markets/JO/commercial-products", "POST", { chargingMode: "FIXED", ...body, name: `${body.name} ${run}` }, admin.cookie);
    assert.equal(r.status, 201, r.raw);
    return r.data.id as string;
  };
  await product({ name: "الشريط الجانبي", productType: "SIDEBAR_AD", priceMinor: 2_000, durationDays: 7, pricingUnit: "DAY", minDays: 1, maxDays: 30, subjectKinds: ["LISTING", "STORE"] });
  await product({ name: "الشريط الرئيسي", productType: "HERO_BANNER", priceMinor: 25_000, durationDays: 7, subjectKinds: ["LISTING", "STORE"] });
  await product({ name: "إبراز في البحث", productType: "SPONSORED_SEARCH", categoryId: "electronics", priceMinor: 6_000, durationDays: 7 });
  const sellerAbove = await register("بائع-أ");
  const sellerBelow = await register("بائع-ب");
  const storeOwner = await register("صاحب-متجر");
  const viewer = await register("زائر");
  const titleAbove = `سماعة سوني ${run}`;
  const titleBelow = `مكواة فيليبس ${run}`;
  const listingAbove = await publish(sellerAbove, titleAbove);
  await publish(sellerBelow, titleBelow);
  await publish(storeOwner, `منتج متجر ${run}`);
  const storeId = randomUUID();
  const storeName = `متجر الأمل ${run}`;
  await db.insert(businessProfiles).values({ id: storeId, ownerUserId: storeOwner.id, marketId: "JO", displayName: storeName, normalizedName: `store-${storeId}`, categoryKey: "OTHER", legalName: "Synthetic Store", legalForm: "COMPANY", verificationStatus: "VERIFIED", verifiedAt: new Date(), verifiedBy: admin.id, publicationStatus: "PUBLISHED", idempotencyKey: randomUUID() });
  const JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
  const buyers = [await register("مشتري1"), await register("مشتري2"), await register("مشتري3")];
  for (const b of buyers) await saveDemandRequest({ buyerId: b.id, market: JO, needText: titleAbove, consent: true });
  for (const b of buyers.slice(0, 2)) await saveDemandRequest({ buyerId: b.id, market: JO, needText: titleBelow, consent: true });

  const web = await startDinarBrowserTestWeb(origin);
  try {
    const plan = await browser("PLAN", { sellerAbove, sellerBelow, storeOwner, titleAbove, titleBelow, storeName }, web);
    assert.ok(plan.checks.length >= 40, JSON.stringify(plan.checks));
    for (const [campaignId, owner, total] of [[plan.campaignId, sellerAbove, "14.000"], [plan.storeCampaignId, storeOwner, "6.000"]] as const) {
      const [campaign] = await db.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, campaignId));
      assert.equal(campaign?.status, "PENDING_PAYMENT", "nothing starts from the browser confirmation");
      assert.equal((campaign!.totalMinor / 1000).toFixed(3), total, "the browser showed exactly the server total");
      const paid = await applyPromotionProviderEvent({ providerKey: "test-gateway", eventId: `b_${campaignId}`, type: "PAID", eventType: "payment", digest: `b_${campaignId}`, promotionId: campaignId, expectedAccountId: "acct", facts: { status: "paid", ownerUserId: owner.id, subtotal: { amount: total, currency: "JOD" } } });
      assert.equal(paid.outcome, "APPLIED");
    }
    const [aboveCampaign] = await db.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, plan.campaignId));
    assert.equal(aboveCampaign?.listingId, listingAbove);
    assert.equal(aboveCampaign?.adCopy, plan.editedCopy, "the edited ad text is what was saved");
    const results = await browser("RESULTS", { sellerAbove, storeOwner, viewer, titleAbove, storeName, run }, web);
    assert.ok(results.checks.length >= 22, JSON.stringify(results.checks));
  } finally {
    await web.stop();
  }
});
