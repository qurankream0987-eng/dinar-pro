/**
 * Jassim Ads is provider-neutral: a second, fake collection provider (registered only here) runs a
 * full promotion cycle — checkout, signed event, activation, expiry, refund — with no change to the
 * ads flow. Whop is not installed in this test. No network, no money.
 */
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { billingWebhookEvents, db, listingPromotions, markets, pool, users } from "@workspace/db";
import app from "../src/app";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { resolveMarket } from "../src/lib/markets";
import { registerPromotionBillingProvider, unregisterPromotionBillingProvider, type PromotionPaymentFacts } from "../src/lib/promotion-billing";
import { applyPromotionProviderEvent, promotionPaymentAvailability } from "../src/lib/promotion-payments";
import { expireStalePromotions } from "../src/lib/promotions";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
process.env.DINAR_JASSIM_ADS_PAYMENTS = "true";
const run = randomUUID().slice(0, 5);
const JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);

// ── A fake local gateway: its own checkout, its own signed events, its own payment records ──────
const SECRET = "local-gateway-test-secret";
const ACCOUNT = "merchant-jassimai";
const gatewayPayments = new Map<string, { promotionId: string; userId: string; amount: string; currency: string; status: string; refunded: string }>();
const checkouts = new Map<string, { promotionId: string; userId: string; amount: string; currency: string }>();
registerPromotionBillingProvider({
  key: "local-gateway",
  displayName: "البوابة المحلية",
  currencies: new Set(["JOD"]),
  async createCheckout(input) {
    const id = `lg_chk_${checkouts.size + 1}`;
    checkouts.set(id, { promotionId: input.promotionId, userId: input.userId, amount: (input.priceMinor / 10 ** input.scale).toFixed(input.scale), currency: input.currencyCode });
    return { checkoutId: id, checkoutUrl: `https://pay.local-gateway.example/c/${id}` };
  },
  async checkoutUrl(id) {
    return `https://pay.local-gateway.example/c/${id}`;
  },
});
/** The gateway's webhook handler: verify its signature, re-read its own payment, hand facts over. */
async function gatewayWebhook(raw: string, signature: string) {
  const expected = createHmac("sha256", SECRET).update(raw).digest("hex");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return { status: 401, outcome: "REJECTED" };
  const body = JSON.parse(raw) as { id: string; type: "PAID" | "REFUNDED"; paymentId: string };
  const payment = gatewayPayments.get(body.paymentId)!;
  const facts: PromotionPaymentFacts = {
    status: payment.status,
    accountId: ACCOUNT,
    ownerUserId: payment.userId,
    subtotal: { amount: payment.amount, currency: payment.currency },
    total: { amount: payment.amount, currency: payment.currency },
    refunded: { amount: payment.refunded, currency: payment.currency },
  };
  return applyPromotionProviderEvent({ providerKey: "local-gateway", eventId: body.id, type: body.type, eventType: `gateway.${body.type.toLowerCase()}`, digest: expected, promotionId: payment.promotionId, facts, expectedAccountId: ACCOUNT });
}
const sign = (raw: string) => createHmac("sha256", SECRET).update(raw).digest("hex");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => {
  unregisterPromotionBillingProvider("local-gateway");
  delete process.env.DINAR_JASSIM_ADS_PAYMENTS;
  server.close();
  await pool.end();
});
let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.61.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let data: any;
  try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_200_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Pn-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `PN ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id as string, cookie: c.cookie };
}
const admin = await account("admin");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
const seller = await account("seller");
const product = await request("/admin/markets/JO/commercial-products", "POST", { name: `VIP ${run}`, productType: "VIP_LISTING", categoryId: "electronics", priceMinor: 4_000, durationDays: 3, chargingMode: "FIXED" }, admin.cookie);
assert.equal(product.status, 201, product.raw);
const listing = await request("/listings", "POST", {
  title: `سماعة ${run}`, description: "سماعة بحالة ممتازة مع العلبة", category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
  attributes: { condition: "مستعمل" }, unitPrice: "30.000", inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
}, seller.cookie);
assert.equal(listing.status, 201, listing.raw);
const row = async (id: string) => (await db.select().from(listingPromotions).where(eq(listingPromotions.id, id)))[0]!;

test("PN-01 the market chooses its provider by policy; the ads flow asks the registry, not Whop", async () => {
  await appendCommercialPolicy({ marketId: "JO", policy: { advertisingBillingActivation: "PROVIDER_DIRECT", advertisingBillingProvider: "local-gateway" }, actorId: admin.id });
  assert.deepEqual(await promotionPaymentAvailability(JO), { available: true, providerKey: "local-gateway", displayName: "البوابة المحلية" });
  assert.equal(((await promotionPaymentAvailability({ ...JO, currencyCode: "KWD" })) as any).code, "CURRENCY_UNSUPPORTED", "currencies come from the provider");
  await appendCommercialPolicy({ marketId: "JO", policy: { advertisingBillingActivation: "PROVIDER_DIRECT", advertisingBillingProvider: "not-registered" }, actorId: admin.id });
  assert.equal(((await promotionPaymentAvailability(JO)) as any).code, "PROVIDER_NOT_CONNECTED");
  await appendCommercialPolicy({ marketId: "JO", policy: { advertisingBillingActivation: "PROVIDER_DIRECT", advertisingBillingProvider: "local-gateway" }, actorId: admin.id });
});

let promotionId = "";
let paymentId = "";
test("PN-02 full cycle through the fake provider: checkout → signed payment → active → expiry → refund", async () => {
  const started = await request("/commercial/promotion-payments/checkouts", "POST", { productId: product.data.id, listingId: listing.data.id, idempotencyKey: `pn-${randomUUID()}` }, seller.cookie);
  assert.equal(started.status, 201, started.raw);
  assert.equal(started.data.providerKey, "local-gateway");
  assert.match(started.data.checkoutUrl, /^https:\/\/pay\.local-gateway\.example\/c\//);
  assert.match(started.data.note, /البوابة المحلية/);
  promotionId = started.data.promotion.id;
  let campaign = await row(promotionId);
  assert.deepEqual([campaign.status, campaign.paymentMode, campaign.paymentSource, campaign.paymentProviderKey, campaign.paymentStatus], ["PENDING_PAYMENT", "PROVIDER_LIVE", "PROVIDER_DIRECT", "local-gateway", "PROVIDER_PENDING"]);
  const checkout = checkouts.get(campaign.paymentReference!)!;
  assert.deepEqual([checkout.amount, checkout.currency], ["4.000", "JOD"], "the server's price snapshot, nothing from the client");

  // A forged event is refused by the gateway itself; nothing changes.
  paymentId = `lg_pay_${run}`;
  gatewayPayments.set(paymentId, { promotionId, userId: seller.id, amount: "4.000", currency: "JOD", status: "paid", refunded: "0.000" });
  const paidEvent = JSON.stringify({ id: `evt_paid_${run}`, type: "PAID", paymentId });
  assert.equal((await gatewayWebhook(paidEvent, "f".repeat(64))).status, 401);
  assert.equal((await row(promotionId)).status, "PENDING_PAYMENT");

  const paid = await gatewayWebhook(paidEvent, sign(paidEvent));
  assert.equal(paid.outcome, "APPLIED", JSON.stringify(paid));
  campaign = await row(promotionId);
  assert.deepEqual([campaign.status, campaign.paymentStatus], ["ACTIVE", "PROVIDER_PAID"], "payment status and campaign status are separate fields");
  assert.equal((await gatewayWebhook(paidEvent, sign(paidEvent))).duplicate, true, "the same provider event changes nothing twice");
  const recorded = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.providerEventId, `evt_paid_${run}`));
  assert.deepEqual(recorded.map((r) => r.providerKey), ["local-gateway"], "the record names the provider that collected");

  // Expiry ends the campaign; the payment stays PAID (paying is not serving).
  // The window is immutable after activation (DB trigger), so time moves instead: four days later.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 4 * 86_400_000 });
  try {
    await expireStalePromotions({ listingId: listing.data.id });
  } finally {
    mock.timers.reset();
  }
  campaign = await row(promotionId);
  assert.equal(campaign.paymentStatus, "PROVIDER_PAID");
  assert.notEqual(campaign.status, "ACTIVE", "an expired campaign no longer runs");

  // A full refund reported by the provider is recorded; nothing here issued it.
  gatewayPayments.set(paymentId, { ...gatewayPayments.get(paymentId)!, refunded: "4.000" });
  const refundEvent = JSON.stringify({ id: `evt_refund_${run}`, type: "REFUNDED", paymentId });
  assert.equal((await gatewayWebhook(refundEvent, sign(refundEvent))).outcome, "APPLIED");
  assert.equal((await row(promotionId)).paymentStatus, "PROVIDER_REFUNDED");
});

test("PN-03 a provider can only settle campaigns opened through it", async () => {
  const other = await applyPromotionProviderEvent({ providerKey: "someone-else", eventId: `evt_x_${run}`, type: "PAID", eventType: "x", digest: "d", promotionId, facts: { status: "paid", ownerUserId: seller.id }, expectedAccountId: "a" });
  assert.equal(other.failureCode, "PROVIDER_MISMATCH");
});

test("PN-04 the ads flow names no provider: no Whop reference in the provider-neutral modules", () => {
  for (const file of ["../src/lib/promotion-payments.ts", "../src/lib/promotion-billing.ts", "../src/lib/promotion-policy.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url.replace("/.test-build/", "/test/")), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/whop/i.test(code.replace(/isWhopAdsPaymentsEnabled/g, "")), `${file} must not depend on Whop`);
  }
  for (const file of ["../src/lib/deal-payments/service.ts", "../src/lib/merchant-policies/engine.ts", "../src/lib/seller-classification.ts", "../src/lib/commission-policy.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url.replace("/.test-build/", "/test/")), "utf8");
    assert.ok(!/whop/i.test(source), `${file} must not reference Whop`);
  }
});
