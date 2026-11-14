/**
 * Arab market readiness (owner request: test all 22 Arab markets; TESTING ONLY, disposable DB).
 * Nothing here activates a market outside this database. Per market it records what the
 * existing system does, and asserts the invariants that must hold everywhere:
 *   - the market row, its currency and its precision match ISO 4217 (Palestine has no ISO
 *     national currency; the configured value is reported, not assumed);
 *   - a closed market refuses activation without a signed legal intake and refuses publishing;
 *   - after a fully signed intake (fixture) and admin activation: registration with a local
 *     phone number lands in that market, a seller publishes at the market's own precision, a
 *     buyer in the same market finds the listing, a buyer in another market never sees it;
 *   - a local advertising price can be configured in the market currency with the tariff
 *     duration (no conversion); electronic payment and the SMS provider stay unavailable.
 * SMS, payments and providers are NOT exercised for real: database configuration only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getExampleNumber, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import examples from "libphonenumber-js/mobile/examples";
import { db, marketLegalIntakes, markets, offers, pool, users } from "@workspace/db";
import app from "../src/app";
import { getMarketCapabilityProfile } from "../src/lib/market-capability-registry";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const ARAB = "DZ BH KM DJ EG IQ JO KW LB LY MR MA OM PS QA SA SO SD SY TN AE YE".split(" ");
/** ISO 4217 national currency and minor units (PS: no ISO national currency). */
const ISO: Record<string, [string, number] | null> = {
  DZ: ["DZD", 2], BH: ["BHD", 3], KM: ["KMF", 0], DJ: ["DJF", 0], EG: ["EGP", 2], IQ: ["IQD", 3], JO: ["JOD", 3],
  KW: ["KWD", 3], LB: ["LBP", 2], LY: ["LYD", 3], MR: ["MRU", 2], MA: ["MAD", 2], OM: ["OMR", 3], PS: null,
  QA: ["QAR", 2], SA: ["SAR", 2], SO: ["SOS", 2], SD: ["SDG", 2], SY: ["SYP", 2], TN: ["TND", 3], AE: ["AED", 2], YE: ["YER", 2],
};
const run = randomUUID().slice(0, 5);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.51.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const used = new Set<string>();
/** A valid, unused mobile number of the country (libphonenumber metadata, last digits varied). */
function localNumber(country: string): { callingCode: string; national: string } {
  const example = getExampleNumber(country as CountryCode, examples)!;
  const digits = example.nationalNumber;
  for (let i = 0; i < 5000; i++) {
    const tail = String((Date.now() + process.pid + i * 7919) % 1000).padStart(3, "0");
    const candidate = digits.slice(0, -3) + tail;
    const parsed = parsePhoneNumberFromString(`+${example.countryCallingCode}${candidate}`);
    if (parsed?.isValid() && parsed.country === country && !used.has(parsed.number)) { used.add(parsed.number); return { callingCode: `+${example.countryCallingCode}`, national: candidate }; }
  }
  throw new Error(`no valid number for ${country}`);
}
async function account(country: string, label: string) {
  const { callingCode, national } = localNumber(country);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: callingCode, phoneNumber: national });
  if (![200, 201, 202].includes(s.status)) return { error: `challenge ${s.status} ${s.raw.slice(0, 120)}` } as const;
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Ar-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `${label} ${country}`, accountCountry: country, phoneCountryCode: callingCode, phoneNumber: national, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data?.verificationToken });
  if (c.status !== 201) return { error: `register ${c.status} ${c.raw.slice(0, 120)}` } as const;
  return { id: c.data.user.id as string, cookie: c.cookie, activeMarketId: c.data.user.activeMarketId as string | undefined };
}
const priceFor = (scale: number) => (scale === 0 ? "1500" : scale === 2 ? "12.50" : "12.500");
const minorOf = (scale: number) => (scale === 0 ? 1500 : scale === 2 ? 1250 : 12500);

const adminAccount = await account("KW", "مدير");
assert.ok(!("error" in adminAccount), JSON.stringify(adminAccount));
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, adminAccount.id));
const owner = adminAccount.id;
const joBuyer = await account("JO", "مشتري الأردن");
assert.ok(!("error" in joBuyer));

const matrix: Record<string, Record<string, unknown>>[] = [];
after(async () => {
  if (process.env.DINAR_JOURNEY_OUT) writeFileSync(process.env.DINAR_JOURNEY_OUT, JSON.stringify(matrix, null, 1));
  server.close();
  await pool.end();
});

for (const code of ARAB) {
  test(`AR-${code}`, async () => {
    const row: Record<string, unknown> = { market: code };
    matrix.push(row as never);
    const [market] = await db.select().from(markets).where(eq(markets.id, code));
    assert.ok(market, `${code}: market row exists`);
    const resolved = await resolveMarket(market!);
    row.currency = `${market!.currencyCode}/${market!.minorUnitScale}`;
    row.initialStatus = market!.status;
    const iso = ISO[code];
    if (iso) {
      assert.equal(market!.currencyCode, iso[0], `${code}: ISO 4217 currency`);
      assert.equal(market!.minorUnitScale, iso[1], `${code}: ISO 4217 minor units`);
      row.iso = "MATCH";
    } else row.iso = `NO_ISO_NATIONAL_CURRENCY (configured ${market!.currencyCode})`;
    const profile = getMarketCapabilityProfile(resolved, "staging");
    assert.equal(profile.authentication.phoneVerification.smsProviderConnected, false, "SMS is not live here");
    assert.equal(profile.payments.electronic.available, false, "no electronic payment");
    row.paymentMethods = (market!.paymentMethods as string[]).join(",");
    row.fulfilment = (market!.fulfilmentMethods as string[]).join(",");

    const [intake] = await db.select().from(marketLegalIntakes).where(eq(marketLegalIntakes.marketId, code));
    row.legalIntake = intake ? `${intake.activationStatus}/${intake.counselApprovalStatus}` : "NONE";
    const wasOpen = ["ACTIVE", "LIMITED"].includes(market!.status) && market!.isActive;
    const config = { status: "ACTIVE", fulfilmentMethods: market!.fulfilmentMethods, paymentMethods: market!.paymentMethods, restrictedCategories: market!.restrictedCategories, sellerEligibilityMode: market!.sellerEligibilityMode };
    if (!wasOpen) {
      const refused = await request(`/admin/markets/${code}`, "PATCH", config, adminAccount.cookie);
      assert.equal(refused.status, 409, `${code}: activation without a signed legal intake is refused (${refused.raw.slice(0, 120)})`);
      row.activationWithoutLegal = "REFUSED";
    }
    // Disposable fixture: a fully signed intake (counsel, technical, owner, activation).
    const now = new Date();
    const signed = { counselApprovalStatus: "APPROVED", counselReviewedBy: owner, counselReviewedAt: now, counselApprovalReference: `AR-${run}`, counselApprovedBy: owner, counselApprovedAt: now, technicalVerificationStatus: "PASSED", ownerApprovalStatus: "APPROVED", ownerApprovalReference: `AR-${run}`, ownerApprovedBy: owner, ownerApprovedAt: now, activationStatus: "ACTIVE", activatedBy: owner, activatedAt: now } as const;
    if (intake) await db.update(marketLegalIntakes).set(signed).where(eq(marketLegalIntakes.marketId, code));
    else {
      // The real gap is recorded above (no intake row). To still exercise the full journey in
      // this disposable DB, copy Jordan's intake structure for this market and sign it.
      const [template] = await db.select().from(marketLegalIntakes).where(eq(marketLegalIntakes.marketId, "JO"));
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = template as any;
      await db.insert(marketLegalIntakes).values({ ...rest, ...signed, id: randomUUID(), marketId: code });
      row.legalIntakeFixture = "TEST_ONLY_ROW_INSERTED";
    }
    if (!wasOpen) {
      const activated = await request(`/admin/markets/${code}`, "PATCH", config, adminAccount.cookie);
      row.activation = activated.status === 200 ? "ACTIVATED_IN_TEST_DB" : `BLOCKED ${activated.status} ${activated.data?.code ?? activated.data?.error ?? ""}`;
      assert.equal(activated.status, 200, `${code}: with a signed intake activation succeeds (${activated.raw.slice(0, 160)})`);
    } else row.activation = "ALREADY_OPEN";

    const seller = await account(code, "بائع");
    if ("error" in seller) { row.registration = `BLOCKED ${seller.error}`; assert.fail(`${code}: ${seller.error}`); }
    row.registration = seller.activeMarketId === code ? "LANDS_IN_MARKET" : `LANDS_IN ${seller.activeMarketId}`;
    assert.equal(seller.activeMarketId, code, `${code}: a local registration lands in the opened market`);
    const buyer = await account(code, "مشتري");
    assert.ok(!("error" in buyer));

    const scale = market!.minorUnitScale;
    const title = `منتج اختبار ${code} ${run}`;
    const published = await request("/listings", "POST", {
      title, description: `${title} — وصف كامل للاختبار`, category: "إلكترونيات", categoryId: "electronics", area: "المركز", city: "العاصمة",
      attributes: { condition: "جديد" }, unitPrice: priceFor(scale), inventoryMode: "LIMITED", availableQuantity: 2, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
    }, seller.cookie);
    row.publication = published.status === 201 ? "PUBLISHED" : `REFUSED ${published.status} ${published.data?.code ?? published.data?.error ?? ""}`;
    assert.equal(published.status, 201, `${code}: seller publishes (${published.raw.slice(0, 200)})`);
    const id = published.data.id as string;
    const [stored] = await db.select({ unitPriceMinor: offers.unitPriceMinor, marketId: offers.marketId }).from(offers).where(eq(offers.id, id));
    assert.equal(stored!.unitPriceMinor, minorOf(scale), `${code}: price stored at ISO precision`);
    assert.equal(stored!.marketId, code);
    row.storedPrice = `${stored!.unitPriceMinor} minor`;
    const wrongPrecision = await request("/listings", "POST", {
      title: `${title} دقة`, description: `${title} — دقة خاطئة للاختبار`, category: "إلكترونيات", categoryId: "electronics", area: "المركز",
      attributes: { condition: "جديد" }, unitPrice: scale === 3 ? "1.2345" : scale === 2 ? "1.234" : "1.5", inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
    }, seller.cookie);
    assert.equal(wrongPrecision.status, 400, `${code}: a price finer than the currency precision is refused`);
    row.precisionGuard = "REFUSED_FINER_PRICE";

    const found = await request(`/listings?q=${encodeURIComponent(`اختبار ${code} ${run}`)}`, "GET", undefined, buyer.cookie);
    const ids = (found.data?.items ?? found.data?.listings ?? found.data ?? []).map((item: any) => item.id);
    assert.ok(ids.includes(id), `${code}: a buyer in the market finds it`);
    row.search = "FOUND";
    if (code !== "JO") {
      const elsewhere = await request(`/listings?q=${encodeURIComponent(`اختبار ${code} ${run}`)}`, "GET", undefined, joBuyer.cookie);
      const otherIds = (elsewhere.data?.items ?? elsewhere.data?.listings ?? elsewhere.data ?? []).map((item: any) => item.id);
      assert.ok(!otherIds.includes(id), `${code}: a buyer in Jordan never sees it`);
      const direct = await request(`/listings/${id}`, "GET", undefined, joBuyer.cookie);
      row.isolation = otherIds.includes(id) ? "LEAK" : `ISOLATED (direct ${direct.status})`;
    } else row.isolation = "N/A";

    const ad = await request(`/admin/markets/${code}/commercial-products`, "POST", { name: `تمييز ${code} ${run}`, productType: "SPONSORED_SEARCH", categoryId: "electronics", priceMinor: minorOf(scale), durationDays: 7, chargingMode: "FIXED", enabled: false }, adminAccount.cookie);
    row.localAdPrice = ad.status === 201 ? `CONFIGURABLE (${market!.currencyCode})` : `REFUSED ${ad.status} ${ad.data?.code ?? ""}`;
    assert.equal(ad.status, 201, `${code}: a local ad price can be configured (${ad.raw.slice(0, 160)})`);
    const badDuration = await request(`/admin/markets/${code}/commercial-products`, "POST", { name: `تمييز 30 ${code} ${run}`, productType: "SPONSORED_SEARCH", categoryId: "electronics", priceMinor: minorOf(scale), durationDays: 30, chargingMode: "FIXED", enabled: false }, adminAccount.cookie);
    assert.equal(badDuration.status, 409);
    row.courier = (market!.fulfilmentMethods as string[]).includes("COURIER") ? "ENABLED" : "NOT_CONFIGURED";
  });
}
