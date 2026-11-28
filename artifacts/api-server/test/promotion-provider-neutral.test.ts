/**
 * §4E + §4C verification:
 *   1. Second fake PromotionBillingProvider runs checkout -> signed webhook -> ACTIVE -> REFUNDED
 *      with zero changes to ads-flow code (proves Whop is replaceable).
 *   2. Paid promotions stop serving when a market's ELECTRONIC_PAYMENT legal approval is withdrawn.
 *   3. Whop blocked-country list includes IQ, SY, LY, YE, SD, SO, KM, PS.
 *   4. No Whop reference appears in deal-payments/, merchant-policies/, seller-classification, or commission code.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import {
  db,
  listingPromotions,
  marketLegalCapabilityApprovals,
  markets,
  pool,
  users,
} from "@workspace/db";
import app from "../src/app";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { resolveMarket } from "../src/lib/markets";
import {
  registerPromotionBillingProvider,
  unregisterPromotionBillingProvider,
  type PromotionBillingProvider,
} from "../src/lib/promotion-billing";
import { servingCampaignsFor } from "../src/lib/promotions";
import { displayPlacementCards } from "../src/lib/welcome-ads";
import { parseBlockedCountries } from "../src/lib/whop/config";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
process.env.DINAR_JASSIM_ADS_PAYMENTS = "true";

const run = randomUUID().slice(0, 5);
const marketRow = async (id: string) =>
  resolveMarket((await db.select().from(markets).where(eq(markets.id, id)))[0]!);
const JO = await marketRow("JO");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;

let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, {
    method,
    headers: {
      "content-type": "application/json",
      "X-Forwarded-For": `198.29.${(ipn >> 8) & 255}.${ipn++ & 255}`,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await r.text();
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 51_770_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", {
    challengeId: s.data.challengeId,
    code: s.data.developmentCode,
  });
  const password = `Pn-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", {
    displayName: `PN ${label}`,
    accountCountry: "KW",
    phoneCountryCode: "+965",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: v.data.verificationToken,
  });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id, cookie: c.cookie };
}

async function publish(seller: Actor, title: string, price: string) {
  const created = await request(
    "/listings",
    "POST",
    {
      title,
      description: `${title} — بحالة ممتازة مع العلبة`,
      category: "إلكترونيات",
      categoryId: "electronics",
      area: "خلدا",
      city: "عمان",
      attributes: { condition: "مستعمل" },
      unitPrice: price,
      inventoryMode: "LIMITED",
      availableQuantity: 2,
      fulfilmentType: "PICKUP",
      imageUrl: "",
      imageUrls: [],
      paymentMethods: ["CASH_DIRECT"],
    },
    seller.cookie,
  );
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const FAKE_PROVIDER_KEY = "fake-local-gateway";
const FAKE_SECRET = "fake_local_secret_1234567890";
const fakeCheckouts = new Map<string, { promotionId: string; userId: string; amountMinor: number; currencyCode: string }>();

const fakeProvider: PromotionBillingProvider = {
  providerKey: FAKE_PROVIDER_KEY,
  displayName: "بوابة الدفع المحلية التجريبية",
  supportedCurrencies: new Set(["JOD", "SAR", "AED"]),
  blockedCountries: ["IQ", "SY", "LY", "YE", "SD", "SO", "KM", "PS"],
  async createPromotionCheckout(input) {
    const checkoutId = `fake_chk_${randomUUID().slice(0, 12)}`;
    fakeCheckouts.set(checkoutId, {
      promotionId: input.promotionId,
      userId: input.userId,
      amountMinor: input.priceMinor,
      currencyCode: input.currencyCode,
    });
    return { checkoutId, checkoutUrl: `https://local-gateway.example/pay/${checkoutId}` };
  },
  async promotionCheckoutUrl(checkoutId) {
    return `https://local-gateway.example/pay/${checkoutId}`;
  },
  async verifyAndParseWebhook(raw, headers) {
    const sig = String(headers["x-fake-signature"] ?? "");
    const expected = createHmac("sha256", FAKE_SECRET).update(raw).digest("hex");
    if (sig !== expected) {
      return { ok: false, result: { status: 401, outcome: "REJECTED", failureCode: "INVALID_SIGNATURE" } };
    }
    const body = JSON.parse(raw.toString("utf8")) as {
      eventId: string;
      type: "PAID" | "REFUNDED";
      promotionId: string;
      sellerId: string;
      amountMinor: number;
      currencyCode: string;
    };
    return {
      ok: true,
      event: {
        eventId: body.eventId,
        eventType: body.type,
        digest: createHash("sha256").update(raw).digest("hex"),
        type: body.type,
        promotionId: body.promotionId,
        sellerId: body.sellerId,
        providerPaymentStatus: body.type === "PAID" ? "paid" : "refunded",
        currencyCode: body.currencyCode,
        amountMinor: body.amountMinor,
        ...(body.type === "REFUNDED" ? { refundedMinor: body.amountMinor, totalMinor: body.amountMinor } : {}),
      },
    };
  },
};

const admin = await account("admin");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
const seller = await account("seller");
const listingId = await publish(seller, `ساعة ذكية ${run}`, "50.000");

const vipProduct = await request(
  "/admin/markets/JO/commercial-products",
  "POST",
  { name: `VIP ${run}`, productType: "VIP_LISTING", categoryId: "electronics", priceMinor: 5_000, durationDays: 7, chargingMode: "FIXED" },
  admin.cookie,
);
assert.equal(vipProduct.status, 201, vipProduct.raw);
const vipId = vipProduct.data.id as string;

after(async () => {
  unregisterPromotionBillingProvider(FAKE_PROVIDER_KEY);
  delete process.env.DINAR_JASSIM_ADS_PAYMENTS;
  delete process.env.DINAR_JASSIM_ADS;
  server.close();
  await pool.end();
});

test("PN-01 second fake provider runs full promotion lifecycle (checkout -> PAID -> serving -> REFUNDED -> stopped) with zero ads code changes", async () => {
  registerPromotionBillingProvider(fakeProvider);
  await appendCommercialPolicy({
    marketId: "JO",
    policy: { advertisingBillingActivation: "PROVIDER_DIRECT", advertisingBillingProvider: FAKE_PROVIDER_KEY },
    actorId: admin.id,
  });

  const avail = await request("/commercial/provider-promotions/availability", "GET", undefined, seller.cookie);
  assert.equal(avail.status, 200, avail.raw);
  assert.deepEqual(avail.data, {
    available: true,
    providerKey: FAKE_PROVIDER_KEY,
    displayName: "بوابة الدفع المحلية التجريبية",
  });

  const checkout = await request(
    "/commercial/provider-promotions/checkouts",
    "POST",
    { productId: vipId, listingId, idempotencyKey: `fk-${randomUUID()}` },
    seller.cookie,
  );
  assert.equal(checkout.status, 201, checkout.raw);
  assert.equal(checkout.data.providerKey, FAKE_PROVIDER_KEY);
  assert.match(checkout.data.checkoutUrl, /^https:\/\/local-gateway\.example\/pay\//);
  const promoId = checkout.data.promotion.id as string;

  const [beforePay] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promoId));
  assert.deepEqual(
    [beforePay!.status, beforePay!.paymentMode, beforePay!.paymentSource, beforePay!.paymentProviderKey],
    ["PENDING_PAYMENT", "PROVIDER_LIVE", "PROVIDER_DIRECT", FAKE_PROVIDER_KEY],
  );

  const sendWebhook = async (payload: Record<string, unknown>, badSig = false) => {
    const raw = JSON.stringify(payload);
    const sig = badSig ? "0".repeat(64) : createHmac("sha256", FAKE_SECRET).update(raw).digest("hex");
    const r = await fetch(`${base}/commercial/promotion-webhooks/${FAKE_PROVIDER_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fake-signature": sig },
      body: raw,
    });
    return { status: r.status, body: await r.json() };
  };

  // Bad signature refused
  const bad = await sendWebhook({ eventId: `ev-bad-${run}`, type: "PAID", promotionId: promoId, sellerId: seller.id, amountMinor: 5_000, currencyCode: "JOD" }, true);
  assert.equal(bad.status, 401);

  // Valid PAID webhook activates campaign
  const paid = await sendWebhook({ eventId: `ev-paid-${run}`, type: "PAID", promotionId: promoId, sellerId: seller.id, amountMinor: 5_000, currencyCode: "JOD" });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.outcome, "APPLIED");
  const [afterPay] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promoId));
  assert.deepEqual([afterPay!.status, afterPay!.paymentStatus], ["ACTIVE", "PROVIDER_PAID"]);

  // Serves in search & display placements
  process.env.DINAR_JASSIM_ADS = "true";
  assert.equal((await servingCampaignsFor("JO", [listingId])).length, 1);
  assert.equal((await displayPlacementCards({ placement: "HERO", market: JO })).cards.length, 1);

  // §4C.2: withdrawing ELECTRONIC_PAYMENT legal approval immediately stops serving paid promotions
  await db
    .insert(marketLegalCapabilityApprovals)
    .values({
      id: randomUUID(),
      marketId: "JO",
      capability: "ELECTRONIC_PAYMENT",
      status: "DISABLED",
      reason: "تم تعليق الموافقة القانونية مؤقتًا",
    } as any)
    .onConflictDoUpdate({
      target: [marketLegalCapabilityApprovals.marketId, marketLegalCapabilityApprovals.capability],
      set: { status: "DISABLED" },
    });
  assert.equal((await servingCampaignsFor("JO", [listingId])).length, 0, "paid promotion must stop serving when legal approval is withdrawn");
  assert.equal((await displayPlacementCards({ placement: "HERO", market: JO })).cards.length, 0);

  // Restore legal approval and verify serving resumes before refund
  await db
    .update(marketLegalCapabilityApprovals)
    .set({ status: "ENABLED" })
    .where(eq(marketLegalCapabilityApprovals.marketId, "JO"));
  assert.equal((await servingCampaignsFor("JO", [listingId])).length, 1);

  // Valid REFUNDED webhook cancels campaign and stops serving
  const refunded = await sendWebhook({ eventId: `ev-ref-${run}`, type: "REFUNDED", promotionId: promoId, sellerId: seller.id, amountMinor: 5_000, currencyCode: "JOD" });
  assert.equal(refunded.status, 200);
  assert.equal(refunded.body.outcome, "APPLIED");
  const [afterRefund] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promoId));
  assert.deepEqual([afterRefund!.status, afterRefund!.paymentStatus], ["CANCELLED", "PROVIDER_REFUNDED"]);
  assert.equal((await servingCampaignsFor("JO", [listingId])).length, 0);
});

test("PN-02 Whop blocked-country list includes sanctioned Arab League countries (IQ, SY, LY, YE, SD, SO, KM, PS)", () => {
  const blocked = new Set(parseBlockedCountries(undefined));
  for (const code of ["IQ", "IR", "KP", "SY", "CU", "LY", "YE", "SD", "SO", "KM", "PS"]) {
    assert.ok(blocked.has(code), `missing blocked country ${code}`);
  }
});

test("PN-03 separation invariant: zero Whop references in deal-payments, merchant-policies, seller-classification, or commission code", () => {
  const roots = [
    resolve("src/lib/deal-payments"),
    resolve("src/lib/merchant-policies"),
    resolve("src/lib/seller-classification.ts"),
    resolve("src/ai/deal-payment-turn.ts"),
    resolve("src/ai/merchant-policy-turn.ts"),
    resolve("src/ai/seller-classification-turn.ts"),
    resolve("src/connect/profit-share.ts"),
  ];
  const walk = (target: string): string[] => {
    const st = statSync(target);
    if (st.isFile()) return [target];
    return readdirSync(target).flatMap((name) => walk(join(target, name)));
  };
  for (const root of roots) {
    for (const file of walk(root)) {
      const content = readFileSync(file, "utf8");
      assert.doesNotMatch(content, /whop/i, `unexpected Whop reference in ${file}`);
    }
  }
});
