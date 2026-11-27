/**
 * Pre-legal technical operation of all 22 Arab markets (disposable DB only).
 *
 * Proves, per market:
 *   - migration 0078 gave every Arab market an EMPTY legal file (16 unreviewed topics, nothing
 *     approved) and recorded no legal approval of any kind;
 *   - the technical check marks the market READY and writes nothing to the legal tables or
 *     markets.status;
 *   - with DINAR_PRE_LEGAL_OPERATION=true the market runs: local registration lands in it, a seller
 *     publishes, a buyer finds the listing and places a cash-direct order; the market reports
 *     technicalStatus READY and legalApprovalStatus PENDING (never APPROVED);
 *   - under the enforced (deployed) legal gate, non-regulated capabilities pass on technical
 *     readiness while ELECTRONIC_PAYMENT stays refused; without the flag everything stays refused;
 *     a suspended market stays closed.
 * No SMS, payment provider or model is called.
 */
process.env.DINAR_PRE_LEGAL_OPERATION = "true";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getExampleNumber, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import examples from "libphonenumber-js/mobile/examples";
import {
  db,
  marketLegalCapabilityApprovals,
  marketLegalIntakeTopics,
  marketLegalIntakes,
  marketTechnicalReadiness,
  markets,
  pool,
  users,
} from "@workspace/db";
import app from "../src/app";
import { assertMarketLegalCapability } from "../src/lib/d16-readiness";
import { ARAB_MARKET_IDS, verifyMarketTechnicalReadiness } from "../src/lib/market-technical-readiness";
import { isMarketAvailable, resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const ARAB = [...ARAB_MARKET_IDS];
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
function localNumber(country: string) {
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
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data?.challengeId, code: s.data?.developmentCode });
  const password = `Ar-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `${label} ${country}`, accountCountry: country, phoneCountryCode: callingCode, phoneNumber: national, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data?.verificationToken });
  assert.equal(c.status, 201, `${country}: register (${c.raw.slice(0, 160)})`);
  return { id: c.data.user.id as string, cookie: c.cookie, activeMarketId: c.data.user.activeMarketId as string };
}
const priceFor = (scale: number) => (scale === 0 ? "1500" : scale === 2 ? "12.50" : "12.500");

/** Snapshot of everything legal: must be byte-identical before and after the technical check. */
async function legalSnapshot() {
  const intakes = await db.select().from(marketLegalIntakes).where(inArray(marketLegalIntakes.marketId, ARAB));
  const topics = await db.select().from(marketLegalIntakeTopics).where(inArray(marketLegalIntakeTopics.intakeId, intakes.map((i) => i.id)));
  const caps = await db.select().from(marketLegalCapabilityApprovals).where(inArray(marketLegalCapabilityApprovals.marketId, ARAB));
  const statuses = await db.select({ id: markets.id, status: markets.status, isActive: markets.isActive }).from(markets).where(inArray(markets.id, ARAB));
  const sort = (rows: any[]) => JSON.stringify(rows.map((r) => ({ ...r, updatedAt: undefined })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
  return { intakes: sort(intakes), topics: sort(topics), caps: sort(caps), statuses: sort(statuses) };
}

const admin = await account("KW", "مدير");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
const matrix: Record<string, unknown>[] = [];
after(async () => {
  if (process.env.DINAR_JOURNEY_OUT) writeFileSync(process.env.DINAR_JOURNEY_OUT, JSON.stringify(matrix, null, 1));
  server.close();
  await pool.end();
});

test("migration: every Arab market has an empty legal file and no approval", async () => {
  const intakes = await db.select().from(marketLegalIntakes).where(inArray(marketLegalIntakes.marketId, ARAB));
  assert.equal(intakes.length, 22, "22 legal files");
  for (const intake of intakes) {
    assert.notEqual(intake.activationStatus, "ACTIVE", `${intake.marketId}: not legally active`);
    assert.notEqual(intake.counselApprovalStatus, "APPROVED", `${intake.marketId}: no counsel approval`);
    assert.notEqual(intake.ownerApprovalStatus, "APPROVED", `${intake.marketId}: no owner approval`);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(marketLegalIntakeTopics).where(eq(marketLegalIntakeTopics.intakeId, intake.id));
    assert.equal(n, 16, `${intake.marketId}: 16 topics`);
  }
  const reviewed = await db.select({ n: sql<number>`count(*)::int` }).from(marketLegalIntakeTopics).where(and(inArray(marketLegalIntakeTopics.intakeId, intakes.map((i) => i.id)), ne(marketLegalIntakeTopics.reviewStatus, "NOT_REVIEWED")));
  assert.equal(reviewed[0].n, 0, "no topic is marked reviewed");
  const [ps] = await db.select().from(markets).where(eq(markets.id, "PS"));
  assert.equal(ps!.currencyCode, "ILS", "Palestine uses ILS");
});

test("before the technical check every Arab market is closed and the gate refuses", async () => {
  for (const code of ARAB) {
    const [row] = await db.select().from(markets).where(eq(markets.id, code));
    const view = await resolveMarket(row!);
    assert.equal(view.technicalStatus, "NOT_VERIFIED", code);
    if (!row!.isActive) assert.equal(isMarketAvailable(view), false, `${code}: closed before verification`);
    await assert.rejects(assertMarketLegalCapability(code, "BROWSING", db, { DINAR_DEPLOYMENT_ENV: "production", DINAR_PRE_LEGAL_OPERATION: "true" }), /COUNTRY_INTAKE_NOT_ACTIVE|محجوب/);
  }
});

test("non-admin cannot run the technical check", async () => {
  const user = await account("JO", "مستخدم");
  const r = await request("/admin/markets/arab-readiness/verify", "POST", {}, user.cookie);
  assert.equal(r.status, 403);
});

test("technical check marks all 22 READY and touches no legal record", async () => {
  const before = await legalSnapshot();
  const r = await request("/admin/markets/arab-readiness/verify", "POST", {}, admin.cookie);
  assert.equal(r.status, 200, r.raw.slice(0, 300));
  const failed = r.data.results.filter((x: any) => x.status !== "READY");
  assert.deepEqual(failed.map((x: any) => [x.marketId, x.checks.filter((c: any) => !c.passed)]), [], "all READY");
  assert.deepEqual(await legalSnapshot(), before, "legal tables and markets.status unchanged");
  const rows = await db.select().from(marketTechnicalReadiness).where(inArray(marketTechnicalReadiness.marketId, ARAB));
  assert.equal(rows.filter((x) => x.status === "READY" && x.verifiedBy === admin.id).length, 22);
  const report = await request("/admin/markets/arab-readiness", "GET", undefined, admin.cookie);
  assert.equal(report.data.markets.length, 22);
  for (const m of report.data.markets) {
    assert.equal(m.technicalStatus, "READY", m.marketId);
    assert.equal(m.legalStatus, "PENDING", `${m.marketId}: legal stays PENDING`);
    assert.equal(m.operationMode, "PRE_LEGAL", m.marketId);
    assert.ok(m.remaining.length > 0, `${m.marketId}: remaining legal steps listed`);
  }
});

test("deployed gate: technical readiness opens non-regulated capabilities only", async () => {
  const deployed = { DINAR_DEPLOYMENT_ENV: "production", DINAR_PRE_LEGAL_OPERATION: "true" };
  const flagOff = { DINAR_DEPLOYMENT_ENV: "production" };
  for (const code of ARAB) {
    for (const cap of ["BROWSING", "LISTING_PUBLICATION", "TRANSACTIONS", "CASH_PAYMENT", "DELIVERY_OPERATIONS", "BUSINESS_ONBOARDING", "RESTRICTED_CATEGORIES"] as const) {
      const ok = await assertMarketLegalCapability(code, cap, db, deployed);
      assert.equal((ok as any).mode, "PRE_LEGAL", `${code} ${cap}`);
      await assert.rejects(assertMarketLegalCapability(code, cap, db, flagOff), /COUNTRY_INTAKE_NOT_ACTIVE|محجوب/, `${code} ${cap}: flag off keeps today's behaviour`);
    }
    await assert.rejects(assertMarketLegalCapability(code, "ELECTRONIC_PAYMENT", db, deployed), /COUNTRY_INTAKE_NOT_ACTIVE|محجوب/, `${code}: electronic payment needs legal approval`);
  }
});

for (const code of ARAB) {
  test(`PRE-LEGAL-${code}`, async () => {
    const row: Record<string, unknown> = { market: code };
    matrix.push(row);
    const [market] = await db.select().from(markets).where(eq(markets.id, code));
    const view = await resolveMarket(market!);
    row.currency = `${view.currencyCode}/${view.minorUnitScale}`;
    row.technicalStatus = view.technicalStatus;
    row.legalApprovalStatus = view.legalApprovalStatus;
    row.operationMode = view.operationMode;
    assert.equal(view.technicalStatus, "READY");
    assert.equal(view.legalApprovalStatus, "PENDING", `${code}: never reported as legally approved`);
    assert.ok(isMarketAvailable(view), `${code}: open on technical readiness`);

    const seller = await account(code, "بائع");
    assert.equal(seller.activeMarketId, code, `${code}: local registration lands in the market`);
    const buyer = await account(code, "مشتري");
    const title = `منتج تقني ${code} ${run}`;
    const published = await request("/listings", "POST", {
      title, description: `${title} — وصف كامل للاختبار`, category: "إلكترونيات", categoryId: "electronics", area: "المركز", city: "العاصمة",
      attributes: { condition: "جديد" }, unitPrice: priceFor(view.minorUnitScale), inventoryMode: "LIMITED", availableQuantity: 3, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
    }, seller.cookie);
    assert.equal(published.status, 201, `${code}: publish (${published.raw.slice(0, 200)})`);
    row.publication = "PUBLISHED";
    const found = await request(`/listings?q=${encodeURIComponent(`تقني ${code} ${run}`)}`, "GET", undefined, buyer.cookie);
    const ids = (found.data?.items ?? found.data?.listings ?? found.data ?? []).map((item: any) => item.id);
    assert.ok(ids.includes(published.data.id), `${code}: buyer finds the listing`);
    row.search = "FOUND";
    const order = await request("/orders", "POST", { listingId: published.data.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `prelegal-order-${code}-${run}-${randomUUID().slice(0, 8)}` }, buyer.cookie);
    row.cashOrder = order.status === 201 ? "CREATED" : `REFUSED ${order.status} ${order.data?.code ?? order.data?.error ?? ""}`;
    assert.equal(order.status, 201, `${code}: cash-direct order (${order.raw.slice(0, 200)})`);
  });
}

test("a suspended market stays closed even when technically READY", async () => {
  await db.transaction(async (tx) => {
    await tx.update(marketLegalIntakes).set({ activationStatus: "SUSPENDED", suspendedBy: admin.id, suspendedAt: new Date(), suspensionReference: `test-${run}` }).where(eq(marketLegalIntakes.marketId, "YE"));
    const [row] = await tx.select().from(markets).where(eq(markets.id, "YE"));
    const view = await resolveMarket(row!, tx);
    assert.equal(view.operationMode, "CLOSED");
    assert.equal(isMarketAvailable(view), false);
    await assert.rejects(assertMarketLegalCapability("YE", "BROWSING", tx, { DINAR_DEPLOYMENT_ENV: "production", DINAR_PRE_LEGAL_OPERATION: "true" }));
    tx.rollback();
  }).catch((e) => { if (!/rollback/i.test(String(e?.message ?? e))) throw e; });
});

test("without the flag the markets are closed again (production today)", async () => {
  process.env.DINAR_PRE_LEGAL_OPERATION = "false";
  try {
    const [row] = await db.select().from(markets).where(eq(markets.id, "EG"));
    const view = await resolveMarket(row!);
    assert.equal(view.operationMode, "CLOSED");
    assert.equal(isMarketAvailable(view), false);
  } finally {
    process.env.DINAR_PRE_LEGAL_OPERATION = "true";
  }
});
