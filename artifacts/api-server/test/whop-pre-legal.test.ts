/**
 * PRE_LEGAL / legal gate for electronic payment of marketplace orders (Whop card payment).
 *   PL-01 a market in pre-legal operation: the server refuses card payment (direct API call, no UI)
 *         before any provider call — no checkout row, no outbound request;
 *   PL-02 in the same market cash orders still work (TRANSACTIONS / CASH_PAYMENT stay open);
 *   PL-03 the market reports PRE_LEGAL to the client (what the UI-09 panel reads);
 *   PL-04 once the market's ELECTRONIC_PAYMENT capability is legally enabled, the legal gate passes
 *         and the checkout proceeds to its next own check (no provider is called: no seller account).
 * The legal gate is enforced as in a deployment (DINAR_DEPLOYMENT_ENV=staging) only around the
 * payment calls. No Whop, no network, no money.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, marketLegalCapabilityApprovals, marketLegalIntakes, marketTechnicalReadiness, markets, pool, users, whopAccounts, whopCheckouts } from "@workspace/db";
import app from "../src/app";
import { verifyMarketTechnicalReadiness } from "../src/lib/market-technical-readiness";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.WHOP_ENABLED = "true";
process.env.WHOP_ENVIRONMENT = "sandbox";
process.env.WHOP_API_KEY = "test_key_not_real";
process.env.WHOP_WEBHOOK_SECRET = "ws_pre_legal_not_real";
process.env.WHOP_COMPANY_ID = "biz_pre_legal_test";
process.env.WHOP_USD_PER_JOD = "1.41";
process.env.DINAR_PRE_LEGAL_OPERATION = "true";

// Every outbound request is counted: a provider call would be a non-loopback fetch.
const realFetch = globalThis.fetch;
const outbound: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) outbound.push(url);
  return realFetch(input, init);
}) as typeof fetch;

const run = randomUUID().slice(0, 8);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
type Actor = { id: string; cookie: string };
async function request(path: string, method = "GET", body?: unknown, actor?: Actor) {
  const response = await realFetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(actor ? { cookie: actor.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch {}
  return { status: response.status, data, text };
}
let counter = 0;
async function register(name: string): Promise<Actor> {
  const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}${String(counter++ % 10)}`;
  const password = "pre-legal-password-0001";
  const response = await realFetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return { id: JSON.parse(text).user.id, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))!.split(";")[0]! };
}

await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
const seller = await register("بائع ما قبل الاعتماد");
const unboardedSeller = await register("بائع بلا حساب تحصيل");
const buyer = await register("مشتري ما قبل الاعتماد");
const counsel = await register("مستشار");
const owner = await register("مالك");
await db.insert(whopAccounts).values({ id: randomUUID(), sellerUserId: seller.id, whopAccountId: `biz_pl_${run}`, contactEmail: `pl-${run}@example.test`, countryCode: "JO", status: "VERIFIED", identityStatus: "approved", verificationStatus: "approved", data: {} });

async function publish(actor: Actor, price: string) {
  const created = await request("/listings", "POST", {
    title: `سلعة اختبار الاعتماد ${run} ${randomUUID().slice(0, 4)}`, description: `وصف تفصيلي لاختبار الدفع قبل الاعتماد ${run}`, category: "أخرى", categoryId: "other",
    area: "الصويفية", city: "عمّان", attributes: {}, pricingMode: "FIXED", inventoryMode: "LIMITED", fulfilmentType: "PICKUP", unitPrice: price, availableQuantity: 20, imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
  }, actor);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}
async function order(listingId: string) {
  const created = await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `pl-${randomUUID()}` }, buyer);
  return created;
}
const listing = await publish(seller, "20");
const unboardedListing = await publish(unboardedSeller, "20");
const paidCandidate = await order(listing);
assert.equal(paidCandidate.status, 201, paidCandidate.text);
const unboardedOrder = await order(unboardedListing);
assert.equal(unboardedOrder.status, 201, unboardedOrder.text);

// Legal state snapshots, restored at the end.
const [intakeBefore] = await db.select().from(marketLegalIntakes).where(eq(marketLegalIntakes.marketId, "JO"));
const [readinessBefore] = await db.select().from(marketTechnicalReadiness).where(eq(marketTechnicalReadiness.marketId, "JO"));
// The technical check is the system's own (it records who verified and when).
async function setTechnicalReady() {
  const result = await verifyMarketTechnicalReadiness(["JO"], counsel.id);
  const [row] = await db.select().from(marketTechnicalReadiness).where(eq(marketTechnicalReadiness.marketId, "JO"));
  assert.equal(row?.status, "READY", JSON.stringify(result).slice(0, 300));
}
async function deployedGate<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.DINAR_DEPLOYMENT_ENV;
  process.env.DINAR_DEPLOYMENT_ENV = "staging";
  try { return await fn(); } finally { if (before === undefined) delete process.env.DINAR_DEPLOYMENT_ENV; else process.env.DINAR_DEPLOYMENT_ENV = before; }
}
after(async () => {
  await db.delete(marketLegalCapabilityApprovals).where(and(eq(marketLegalCapabilityApprovals.marketId, "JO"), eq(marketLegalCapabilityApprovals.capability, "ELECTRONIC_PAYMENT")));
  if (intakeBefore) await db.update(marketLegalIntakes).set(intakeBefore).where(eq(marketLegalIntakes.marketId, "JO"));
  if (readinessBefore) await db.update(marketTechnicalReadiness).set(readinessBefore).where(eq(marketTechnicalReadiness.marketId, "JO"));
  else await db.delete(marketTechnicalReadiness).where(eq(marketTechnicalReadiness.marketId, "JO"));
  globalThis.fetch = realFetch;
  server.close();
  await pool.end();
});

test("PL-01 pre-legal market: a direct API call for card payment is refused before any provider call", async () => {
  await setTechnicalReady();
  if (intakeBefore) await db.update(marketLegalIntakes).set({ activationStatus: intakeBefore.activationStatus === "ACTIVE" ? "PENDING" : intakeBefore.activationStatus } as any).where(eq(marketLegalIntakes.marketId, "JO"));
  const sent = outbound.length;
  const refused = await deployedGate(() => request("/whop/checkout", "POST", { orderId: paidCandidate.data.id }, buyer));
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.data.code, "MARKET_ELECTRONIC_PAYMENT_UNAVAILABLE");
  assert.match(refused.data.error, /الدفع الإلكتروني غير متاح في دولتك حاليًا/);
  assert.equal(outbound.length, sent, `no provider call: ${outbound.slice(sent).join(", ")}`);
  assert.equal((await db.select().from(whopCheckouts).where(eq(whopCheckouts.orderId, paidCandidate.data.id))).length, 0, "no checkout recorded");
  // A stranger still learns nothing (404 before the legal answer).
  const stranger = await register("غريب");
  const hidden = await deployedGate(() => request("/whop/checkout", "POST", { orderId: paidCandidate.data.id }, stranger));
  assert.equal(hidden.status, 404, hidden.text);
});

test("PL-02 pre-legal market: cash orders still work", async () => {
  const cash = await deployedGate(async () => order(listing));
  assert.equal(cash.status, 201, cash.text);
  assert.equal(cash.data.status, "CREATED");
});

test("PL-03 the client sees the market as PRE_LEGAL (what the UI-09 panel reads)", async () => {
  const listed = await deployedGate(() => request("/markets", "GET"));
  const jo = (Array.isArray(listed.data) ? listed.data : listed.data?.markets ?? []).find((m: any) => m.id === "JO");
  assert.equal(jo?.operationMode, "PRE_LEGAL", listed.text.slice(0, 400));
});

test("PL-04 an approved market: the legal gate passes and the checkout continues to its own checks", async () => {
  const now = new Date();
  if (intakeBefore)
    await db.update(marketLegalIntakes).set({ counselApprovalStatus: "APPROVED", counselReviewedBy: counsel.id, counselReviewedAt: now, counselApprovalReference: `PL-C-${run}`, counselApprovedBy: counsel.id, counselApprovedAt: now, technicalVerificationStatus: "PASSED", ownerApprovalStatus: "APPROVED", ownerApprovalReference: `PL-O-${run}`, ownerApprovedBy: owner.id, ownerApprovedAt: now, activationStatus: "ACTIVE", activatedBy: owner.id, activatedAt: now } as any).where(eq(marketLegalIntakes.marketId, "JO"));
  await db.insert(marketLegalCapabilityApprovals).values({ id: randomUUID(), marketId: "JO", capability: "ELECTRONIC_PAYMENT", status: "ENABLED", counselReference: `PL-C-${run}`, counselReviewedBy: counsel.id, counselReviewedAt: now, ownerApprovalReference: `PL-O-${run}`, ownerApprovedBy: owner.id, ownerApprovedAt: now } as any)
    .onConflictDoUpdate({ target: [marketLegalCapabilityApprovals.marketId, marketLegalCapabilityApprovals.capability], set: { status: "ENABLED", counselReference: `PL-C-${run}`, counselReviewedBy: counsel.id, counselReviewedAt: now, ownerApprovalReference: `PL-O-${run}`, ownerApprovedBy: owner.id, ownerApprovedAt: now } as any });
  const sent = outbound.length;
  const next = await deployedGate(() => request("/whop/checkout", "POST", { orderId: unboardedOrder.data.id }, buyer));
  assert.equal(next.status, 409, next.text);
  assert.equal(next.data.code, "WHOP_SELLER_NOT_ONBOARDED", "the legal gate passed; the next own check answered");
  assert.equal(outbound.length, sent, "still no provider call");
  void users;
});
