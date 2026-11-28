/**
 * Jassim Ads Phase 2 acceptance — real Whop direct payment per promotion, built switched off.
 * PURE MOCK of Whop (in-process REST double + webhooks signed exactly like Whop's verifier).
 * Real: the API, the raw-body webhook route, billing_webhook_events dedup, the serving rule and a
 * disposable database. No network, no money.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { billingWebhookEvents, db, listingPromotions, markets, pool, users } from "@workspace/db";
import app from "../src/app";
import { appendCommercialPolicy } from "../src/lib/commercial-policy-append";
import { resolveMarket } from "../src/lib/markets";
import { installWhopBilling, signWhopPayload, type WhopTransport } from "../src/lib/billing/whop";
import { whopPromotionAvailability } from "../src/lib/promotion-whop";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
delete process.env.DINAR_JASSIM_ADS_PAYMENTS;
const SECRET = `ws_${"cd34".repeat(16)}`;
const ACCOUNT = "biz_JassimAdsTest";
const run = randomUUID().slice(0, 5);
const marketRow = async (id: string) => resolveMarket((await db.select().from(markets).where(eq(markets.id, id)))[0]!);
const JO = await marketRow("JO");

// ── Whop double ────────────────────────────────────────────────────────────────────────────────
const payments = new Map<string, Record<string, unknown>>();
const checkouts = new Map<string, { body: any; idempotencyKey?: string }>();
let posts = 0;
const transport: WhopTransport = async ({ method, path, body, idempotencyKey }) => {
  if (method === "POST" && path === "/checkout_configurations") {
    posts++;
    const id = `ch_p${posts}`;
    checkouts.set(id, { body, idempotencyKey });
    return { status: 201, json: { id, purchase_url: `https://whop.com/checkout/${id}`, metadata: (body as any).metadata } };
  }
  const [, kind, id] = path.split("/");
  if (kind === "checkout_configurations" && checkouts.has(id!)) return { status: 200, json: { id, purchase_url: `https://whop.com/checkout/${id}` } };
  const found = kind === "payments" ? payments.get(decodeURIComponent(id ?? "")) : undefined;
  return found ? { status: 200, json: found } : { status: 404, json: { error: "not found" } };
};

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
let ipn = Math.floor(Math.random() * 30_000);
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.21.${(ipn >> 8) & 255}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const password = `Wa-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `Ads2 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id, cookie: c.cookie };
}
async function publish(seller: Actor, title: string, price: string) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — بحالة ممتازة مع العلبة`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
    attributes: { condition: "مستعمل" }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 2, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
let seq = 0;
async function deliver(type: string, data: Record<string, unknown>, opts: { id?: string; secret?: string } = {}) {
  const id = opts.id ?? `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}${++seq}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ id, type, api_version: "v1", timestamp: new Date().toISOString(), account_id: ACCOUNT, data });
  const signature = signWhopPayload(opts.secret ?? SECRET, id, timestamp, raw);
  const r = await fetch(`${base}/billing/whop/webhook`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, body: raw });
  return { id, status: r.status, body: await r.json() };
}
const jod = (amount: string) => ({ amount, currency: "jod", decimals: 3 });
function pay(promotionId: string, userId: string, opts: { amount?: string; status?: string; currency?: string; kind?: string } = {}) {
  const id = `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const amount = opts.amount ?? "5.000";
  payments.set(id, {
    id, status: opts.status ?? "paid", billing_reason: "one_time", membership_id: null, account_id: ACCOUNT,
    subtotal: { ...jod(amount), currency: opts.currency ?? "jod" }, total: { ...jod(amount), currency: opts.currency ?? "jod" }, refunded_amount: jod("0.000"),
    metadata: { kind: opts.kind ?? "JASSIM_PROMOTION", jassim_promotion_id: promotionId, jassim_user_id: userId },
  });
  return id;
}
const row = async (id: string) => (await db.select().from(listingPromotions).where(eq(listingPromotions.id, id)))[0]!;
const heroIds = async () => ((await request("/ads/placements?slot=HERO", "GET", undefined, "bdinar_guest_market=JO")).data.cards ?? []).map((c: any) => c.listingId);

const admin = await account("admin");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
const seller = await account("seller");
const stranger = await account("stranger");
const createProduct = async (name: string, productType: string, priceMinor: number) => {
  const created = await request("/admin/markets/JO/commercial-products", "POST", { name: `${name} ${run}`, productType, categoryId: "electronics", priceMinor, durationDays: 7, chargingMode: "FIXED" }, admin.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
};
const vip = await createProduct("VIP", "VIP_LISTING", 5_000);
const featured = await createProduct("تمييز", "FEATURED_LISTING", 3_000);
const phone = await publish(seller, `آيفون 15 برو ${run}`, "650.000");
const laptop = await publish(seller, `ماك بوك إير ${run}`, "900.000");
const foreign = await publish(stranger, `آيفون 14 ${run}`, "450.000");
let uninstall: (() => void) | undefined;
after(async () => { uninstall?.(); delete process.env.DINAR_JASSIM_ADS_PAYMENTS; delete process.env.DINAR_JASSIM_ADS; server.close(); await pool.end(); });

test("AP-01 switched off by default: no real promotion payment, nothing opened at Whop", async () => {
  assert.deepEqual(await whopPromotionAvailability(JO), { available: false, code: "PAYMENTS_OFF", reason: "الدفع الحقيقي للترويج غير مفعّل بعد" });
  const r = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId: phone, idempotencyKey: `k-${randomUUID()}` }, seller.cookie);
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.data.code, "PROMOTION_PAYMENT_PAYMENTS_OFF");
  assert.equal(posts, 0);
});

test("AP-02 every gate must be open: provider, market policy, currency, legal approval", async () => {
  process.env.DINAR_JASSIM_ADS_PAYMENTS = "true";
  assert.equal(((await whopPromotionAvailability(JO)) as any).code, "PROVIDER_NOT_CONNECTED");
  uninstall = installWhopBilling({ environment: "sandbox", apiKey: "test-key-not-real", webhookSecret: SECRET, accountId: ACCOUNT, plans: {} }, transport);
  assert.equal(((await whopPromotionAvailability(JO)) as any).code, "POLICY_DISABLED", "default policy is DISABLED");
  await appendCommercialPolicy({ marketId: "JO", policy: { advertisingBillingActivation: "PROVIDER_DIRECT" }, actorId: admin.id });
  assert.deepEqual(await whopPromotionAvailability(JO), { available: true, providerKey: "whop", displayName: "Whop" });
  for (const unsupported of ["IQD", "SYP", "LBP", "YER"])
    assert.equal(((await whopPromotionAvailability({ ...JO, currencyCode: unsupported })) as any).code, "CURRENCY_UNSUPPORTED", unsupported);
  // A deployed environment enforces the legal gate: without an approved legal file, payments stay closed.
  const previous = process.env.DINAR_DEPLOYMENT_ENV;
  process.env.DINAR_DEPLOYMENT_ENV = "production";
  try {
    assert.equal(((await whopPromotionAvailability(JO)) as any).code, "MARKET_NOT_APPROVED");
  } finally {
    if (previous === undefined) delete process.env.DINAR_DEPLOYMENT_ENV; else process.env.DINAR_DEPLOYMENT_ENV = previous;
  }
  await assert.rejects(appendCommercialPolicy({ marketId: "JO", policy: { advertisingBillingActivation: "ON" as any }, actorId: admin.id }));
});

let pending = "";
let checkoutId = "";
test("AP-03 checkout: server price snapshot, inline one-time plan, idempotent, owner-only, nothing serves before payment", async () => {
  const forged = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId: phone, idempotencyKey: `k-${randomUUID()}`, priceMinor: 1 }, seller.cookie);
  assert.equal(forged.status, 400, "a client price is refused");
  const notMine = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId: foreign, idempotencyKey: `k-${randomUUID()}` }, seller.cookie);
  assert.equal(notMine.status, 404, notMine.raw);
  const key = `k-${randomUUID()}`;
  const first = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId: phone, idempotencyKey: key }, seller.cookie);
  assert.equal(first.status, 201, first.raw);
  pending = first.data.promotion.id;
  assert.match(first.data.checkoutUrl, /^https:\/\/whop\.com\/checkout\//);
  assert.equal(first.data.promotion.paymentMode, "PROVIDER_LIVE");
  assert.equal(first.data.promotion.effectiveStatus, "PENDING_PAYMENT");
  assert.equal(first.data.promotion.serving, false);
  const sent = [...checkouts.values()].at(-1)!;
  assert.equal(sent.idempotencyKey, `jassim-promotion-${pending}`);
  assert.deepEqual(sent.body.metadata, { kind: "JASSIM_PROMOTION", jassim_promotion_id: pending, jassim_user_id: seller.id });
  assert.equal(sent.body.plan.company_id, ACCOUNT);
  assert.equal(sent.body.plan.currency, "jod");
  assert.equal(sent.body.plan.plan_type, "one_time");
  assert.equal(sent.body.plan.initial_price, 5, "5.000 JOD from the server snapshot");
  checkoutId = (await row(pending)).paymentReference!;
  const stored = await row(pending);
  assert.deepEqual([stored.status, stored.paymentMode, stored.paymentStatus, stored.paymentSource, stored.priceMinorSnapshot, stored.currencyCodeSnapshot], ["PENDING_PAYMENT", "PROVIDER_LIVE", "PROVIDER_PENDING", "PROVIDER_DIRECT", 5_000, "JOD"]);
  const again = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId: phone, idempotencyKey: key }, seller.cookie);
  assert.equal(again.status, 200);
  assert.equal(again.data.promotion.id, pending);
  assert.equal(again.data.checkoutUrl, first.data.checkoutUrl, "the same Whop page");
  const otherKey = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId: phone, idempotencyKey: `k-${randomUUID()}` }, seller.cookie);
  assert.equal(otherKey.data.promotion.id, pending, "a second request reuses the open checkout, never a second campaign");
  assert.equal(posts, 1, "one Whop checkout only");
  assert.ok(!(await heroIds()).includes(phone), "unpaid: never served");
});

test("AP-04 a signed payment activates only after Whop's own state matches; forged, mismatched and duplicate events change nothing", async () => {
  const forged = await deliver("payment.succeeded", { id: pay(pending, seller.id) }, { secret: `ws_${"ee".repeat(32)}` });
  assert.equal(forged.status, 401);
  const wrongAmount = await deliver("payment.succeeded", { id: pay(pending, seller.id, { amount: "1.000" }) });
  assert.equal(wrongAmount.body.failureCode, "AMOUNT_MISMATCH_REVIEW");
  const wrongCurrency = await deliver("payment.succeeded", { id: pay(pending, seller.id, { currency: "usd" }) });
  assert.equal(wrongCurrency.body.failureCode, "AMOUNT_MISMATCH_REVIEW");
  const wrongOwner = await deliver("payment.succeeded", { id: pay(pending, stranger.id) });
  assert.equal(wrongOwner.body.failureCode, "OWNER_MISMATCH");
  const notPaid = await deliver("payment.succeeded", { id: pay(pending, seller.id, { status: "open" }) });
  assert.equal(notPaid.body.failureCode, "PROVIDER_STATE_NOT_PAID");
  const failed = await deliver("payment.failed", { id: pay(pending, seller.id, { status: "open" }) });
  assert.equal(failed.body.failureCode, "ATTEMPT_FAILED_RETRY_ALLOWED");
  assert.equal((await row(pending)).status, "PENDING_PAYMENT", "nothing above activated the campaign");
  const good = pay(pending, seller.id);
  const ok = await deliver("payment.succeeded", { id: good });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.outcome, "APPLIED");
  const active = await row(pending);
  assert.deepEqual([active.status, active.paymentStatus], ["ACTIVE", "PROVIDER_PAID"]);
  assert.ok(Math.abs(active.expiresAt.getTime() - active.startsAt.getTime() - 7 * 86_400_000) < 1000, "window starts at the verified payment");
  const replay = await deliver("payment.succeeded", { id: good }, { id: ok.id });
  assert.equal(replay.body.duplicate, true);
  const second = await deliver("payment.succeeded", { id: pay(pending, seller.id) });
  assert.equal(second.body.failureCode, "ALREADY_PAID_SECOND_PAYMENT_REVIEW", "a second payment is flagged for the owner, never double-applied");
  assert.equal((await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.providerEventId, ok.id))).length, 1);
  // Served only while the real-payment switch is on.
  process.env.DINAR_JASSIM_ADS = "true";
  try {
    assert.ok((await heroIds()).includes(phone), "paid VIP serves in the hero placement");
    process.env.DINAR_JASSIM_ADS_PAYMENTS = "false";
    assert.ok(!(await heroIds()).includes(phone), "switch off: real-paid campaigns stop serving at once");
  } finally {
    process.env.DINAR_JASSIM_ADS_PAYMENTS = "true";
  }
  (globalThis as any).paidPayment = good;
});

test("AP-05 dispute pauses, a partial refund changes nothing, a full refund ends the campaign; nothing here issues refunds", async () => {
  const good = (globalThis as any).paidPayment as string;
  const disputed = await deliver("dispute.created", { id: `dsp_${run}`, payment: { id: good } });
  assert.equal(disputed.body.outcome, "APPLIED");
  assert.deepEqual([(await row(pending)).status, (await row(pending)).paymentStatus], ["PAUSED", "PROVIDER_DISPUTED"]);
  assert.ok(!(await heroIds()).includes(phone), "disputed money never serves");
  payments.set(good, { ...payments.get(good)!, refunded_amount: jod("2.000") });
  const partial = await deliver("refund.updated", { id: `rfd_a${run}`, status: "succeeded", payment: { id: good } });
  assert.equal(partial.body.failureCode, "PARTIAL_REFUND_FOR_REVIEW");
  payments.set(good, { ...payments.get(good)!, refunded_amount: jod("5.000") });
  const full = await deliver("refund.updated", { id: `rfd_b${run}`, status: "succeeded", payment: { id: good } });
  assert.equal(full.body.outcome, "APPLIED");
  const ended = await row(pending);
  assert.deepEqual([ended.status, ended.paymentStatus], ["CANCELLED", "PROVIDER_REFUNDED"]);
});

test("AP-06 a payment for a cancelled checkout is never served and is flagged for refund review", async () => {
  const started = await request("/commercial/promotion-payments/checkouts", "POST", { productId: featured, listingId: laptop, idempotencyKey: `k-${randomUUID()}` }, seller.cookie);
  assert.equal(started.status, 201, started.raw);
  const id = started.data.promotion.id;
  const cancelled = await request(`/promotions/${id}/actions`, "POST", { action: "CANCEL" }, seller.cookie);
  assert.ok([200, 409].includes(cancelled.status), cancelled.raw);
  if (cancelled.status !== 200) await db.update(listingPromotions).set({ status: "CANCELLED", endedAt: new Date() }).where(eq(listingPromotions.id, id));
  const late = await deliver("payment.succeeded", { id: pay(id, seller.id, { amount: "3.000" }) });
  assert.equal(late.body.failureCode, "PAID_AFTER_CANCEL_REFUND_REVIEW");
  assert.equal((await row(id)).status, "CANCELLED");
  const unrelated = await deliver("payment.succeeded", { id: pay(randomUUID(), seller.id, { kind: "OTHER" }) });
  assert.equal(unrelated.body.failureCode, "NOT_A_JASSIM_SUBSCRIPTION", "only explicitly tagged promotion payments reach campaigns");
  // Out of order: dispute (then refund) before the delayed payment.succeeded — never activated.
  const early = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId: laptop, idempotencyKey: `k-${randomUUID()}` }, seller.cookie);
  assert.equal(early.status, 201, early.raw);
  const earlyId = early.data.promotion.id;
  const earlyPay = pay(earlyId, seller.id);
  const disputedFirst = await deliver("dispute.created", { id: `dsp_early${run}`, payment: { id: earlyPay } });
  assert.equal(disputedFirst.body.outcome, "APPLIED");
  assert.deepEqual([(await row(earlyId)).status, (await row(earlyId)).paymentStatus], ["CANCELLED", "PROVIDER_DISPUTED"]);
  const delayed = await deliver("payment.succeeded", { id: earlyPay });
  assert.equal(delayed.body.failureCode, "ALREADY_SETTLED_PAYMENT_REVIEW");
  assert.equal((await row(earlyId)).status, "CANCELLED", "a disputed payment never starts a campaign");
  const early2 = await request("/commercial/promotion-payments/checkouts", "POST", { productId: vip, listingId: laptop, idempotencyKey: `k-${randomUUID()}` }, seller.cookie);
  const early2Id = early2.data.promotion.id;
  const early2Pay = pay(early2Id, seller.id);
  payments.set(early2Pay, { ...payments.get(early2Pay)!, refunded_amount: jod("5.000") });
  const refundedFirst = await deliver("refund.updated", { id: `rfd_early${run}`, status: "succeeded", payment: { id: early2Pay } });
  assert.equal(refundedFirst.body.outcome, "APPLIED");
  const delayed2 = await deliver("payment.succeeded", { id: early2Pay });
  assert.equal(delayed2.body.failureCode, "ALREADY_SETTLED_PAYMENT_REVIEW");
  assert.deepEqual([(await row(early2Id)).status, (await row(early2Id)).paymentStatus], ["CANCELLED", "PROVIDER_REFUNDED"]);
  const unknownDispute = await deliver("dispute.created", { id: `dsp_unknown${run}`, payment: { id: "pay_doesnotexist" } });
  assert.deepEqual([unknownDispute.status, unknownDispute.body.failureCode], [200, "DISPUTE_RECORDED_FOR_REVIEW"], "a dispute on a payment Whop no longer finds is recorded, not retried for days");
});

test("AP-07 conversation: the review says real payment via Whop and «نعم» returns the Whop page, not a test charge", async () => {
  const conversation = await request("/ai/conversations", "POST", {}, seller.cookie);
  assert.equal(conversation.status, 201, conversation.raw);
  const conversationId = conversation.data.conversation?.id ?? conversation.data.id;
  const turn = async (message: string) => {
    const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: seller.cookie }, body: JSON.stringify({ message }) });
    const raw = await r.text();
    const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
    assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
    return { body: complete.assistantMessage.body as string, commerce: complete.assistantMessage.blocks[0]?.payload?.commerce ?? {} };
  };
  let t = await turn("أريد إعلان مميز");
  const trail: string[] = [`${t.commerce.view}/${t.commerce.step ?? ""}`];
  for (let i = 0; i < 4 && !t.commerce.review; i++) {
    const titles = (t.commerce.listings ?? []).map((l: any) => l.title as string);
    if (t.commerce.step === "LISTING" || titles.length) {
      const index = titles.findIndex((title: string) => title.includes("ماك بوك"));
      t = await turn(`الإعلان رقم ${index >= 0 ? index + 1 : 1}`);
    } else t = await turn("الخيار 1");
    trail.push(`${t.commerce.view}/${t.commerce.step ?? ""} [${t.commerce.notice ?? ""}] keys=${Object.keys(t.commerce).join(",")}`);
  }
  assert.ok(t.commerce.review, `reached a review: ${trail.join(" → ")} — ${t.body}`);
  assert.ok(t.commerce.providerPayment?.providerKey === "whop", "the review is marked as a real payment through the registered provider (Whop)");
  assert.equal(t.commerce.review.sufficient, true, "no test balance is needed");
  const confirmed = await turn("نعم");
  assert.ok(confirmed.commerce.promotionCheckout, `${confirmed.body}`);
  assert.match(confirmed.commerce.promotionCheckout.url, /^https:\/\/whop\.com\/checkout\//);
  assert.match(confirmed.body, /لم يُخصم شيء بعد/);
  const created = await row(confirmed.commerce.promotionCheckout.promotionId);
  assert.deepEqual([created.status, created.paymentSource, created.listingId], ["PENDING_PAYMENT", "PROVIDER_DIRECT", laptop]);
  const balance = await request("/commercial/balance", "GET", undefined, seller.cookie);
  assert.equal(balance.data.spentMinor ?? 0, 0, "the test balance is never charged for a Whop promotion");
});

test("AP-08 fail-closed configuration: missing or malformed variables keep every real-payment gate shut", async () => {
  const { isWhopAdsPaymentsEnabled } = await import("../src/lib/promotion-policy");
  const { whopConfigFromEnv } = await import("../src/lib/billing/whop");
  const { marketLegalGateEnforced } = await import("../src/lib/d16-readiness");
  const { DEFAULT_COMMERCIAL_POLICY } = await import("../src/lib/commercial-policy");
  // Gate 1: only the exact pair BDINAR_PROMOTIONS_ENABLED=true + DINAR_JASSIM_ADS_PAYMENTS=true opens it.
  assert.equal(isWhopAdsPaymentsEnabled({}), false, "both missing");
  assert.equal(isWhopAdsPaymentsEnabled({ DINAR_JASSIM_ADS_PAYMENTS: "true" }), false, "promotions flag missing");
  assert.equal(isWhopAdsPaymentsEnabled({ BDINAR_PROMOTIONS_ENABLED: "true" }), false, "payments flag missing");
  for (const value of ["", "1", "yes", "on", "enabled", "false", "ture"])
    assert.equal(isWhopAdsPaymentsEnabled({ BDINAR_PROMOTIONS_ENABLED: "true", DINAR_JASSIM_ADS_PAYMENTS: value }), false, `"${value}"`);
  assert.equal(isWhopAdsPaymentsEnabled({ BDINAR_PROMOTIONS_ENABLED: "TRUE", DINAR_JASSIM_ADS_PAYMENTS: "true" }), false, "promotions flag is exact");
  // Gate 2: Whop is installed only with the full, well-formed configuration.
  const full = { DINAR_WHOP_BILLING_ENABLED: "true", DINAR_WHOP_ENVIRONMENT: "production", DINAR_LIVE_PROVIDERS_ENABLED: "true", WHOP_API_KEY: "k", WHOP_BILLING_WEBHOOK_SECRET: "ws_x", WHOP_COMPANY_ID: "biz_A1" } as NodeJS.ProcessEnv;
  assert.ok(whopConfigFromEnv(full), "the complete configuration connects");
  assert.equal(whopConfigFromEnv({}), undefined, "nothing set");
  for (const missing of Object.keys(full)) {
    const env = { ...full };
    delete env[missing];
    if (missing === "DINAR_WHOP_ENVIRONMENT") continue; // falls back to sandbox, never production
    assert.equal(whopConfigFromEnv(env), undefined, `missing ${missing}`);
  }
  assert.equal(whopConfigFromEnv({ ...full, DINAR_WHOP_BILLING_ENABLED: "false" }), undefined);
  assert.equal(whopConfigFromEnv({ ...full, WHOP_BILLING_WEBHOOK_SECRET: "not-ws" }), undefined, "malformed secret");
  assert.equal(whopConfigFromEnv({ ...full, WHOP_COMPANY_ID: "acme" }), undefined, "malformed company id");
  assert.equal(whopConfigFromEnv({ ...full, DINAR_WHOP_PLAN_MAP: "{not json" }), undefined, "malformed plan map");
  assert.equal(whopConfigFromEnv({ ...full, DINAR_WHOP_ENVIRONMENT: undefined })?.environment, "sandbox", "an unset environment is never production");
  // Gate 3: the policy default is DISABLED.
  assert.equal(DEFAULT_COMMERCIAL_POLICY.advertisingBillingActivation, "DISABLED");
  // Gate 4: with no deployment marker and no NODE_ENV the legal gate is enforced (fail closed).
  assert.equal(marketLegalGateEnforced({}), true);
  assert.equal(marketLegalGateEnforced({ DINAR_DEPLOYMENT_ENV: "production", NODE_ENV: "development" }), true, "the deploy marker wins over NODE_ENV");
});
