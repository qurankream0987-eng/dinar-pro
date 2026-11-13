/**
 * Whop billing readiness (PURE MOCK — not Whop sandbox evidence). A deterministic Whop double:
 * an in-process REST transport holding payments and memberships, and webhooks signed exactly as
 * Whop's official verifier expects (Standard Webhooks; HMAC-SHA256 keyed by the literal `ws_…`
 * secret). Real: the API, the raw-body route, the one subscription lifecycle machine, the
 * billing_webhook_events ledger, entitlements and the disposable database. No network, no money.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { billingWebhookEvents, businessSubscriptions, db, pool, promotionProducts, users } from "@workspace/db";
import app from "../src/app";
import { installWhopBilling, signWhopPayload, moneyToMinor, verifyWhopSignature, type WhopTransport } from "../src/lib/billing/whop";
import { aiPlanFor } from "../src/lib/business";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WHOP_BILLING");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const SECRET = `ws_${"ab12".repeat(16)}`;
const ACCOUNT = "biz_JassimTest";

// ── Whop double ────────────────────────────────────────────────────────────────────────────────
type Money = { amount: string; currency: string; decimals: number };
const payments = new Map<string, Record<string, unknown>>();
const memberships = new Map<string, Record<string, unknown>>();
const checkouts: { body: any; idempotencyKey?: string }[] = [];
let whopDown = false;
let apiCalls = 0;
const transport: WhopTransport = async ({ method, path, body, idempotencyKey }) => {
  apiCalls++;
  if (whopDown) throw new Error("ECONNRESET");
  if (method === "POST" && path === "/checkout_configurations") {
    checkouts.push({ body, idempotencyKey });
    return { status: 201, json: { id: `ch_${checkouts.length}`, purchase_url: `https://whop.com/checkout/ch_${checkouts.length}`, metadata: (body as any).metadata } };
  }
  const [, kind, id] = path.split("/");
  const store = kind === "payments" ? payments : kind === "memberships" ? memberships : undefined;
  const found = store?.get(decodeURIComponent(id ?? ""));
  return found ? { status: 200, json: found } : { status: 404, json: { error: "not found" } };
};

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const uninstall = installWhopBilling({ environment: "sandbox", apiKey: "test-key-not-real", webhookSecret: SECRET, accountId: ACCOUNT, plans: { DINAR_GO: "plan_Go1", DINAR_PRO: "plan_Pro1" } }, transport);

let ip = 1;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.60.1.${ip++ % 250}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_440_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Wp-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `Whop ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, c.cookie)).status, 200);
  return { id: c.data.user.id as string, cookie: c.cookie };
}

let seq = 0;
async function deliver(type: string, data: Record<string, unknown>, opts: { id?: string; secret?: string; at?: number; account?: string; tamper?: boolean } = {}) {
  const id = opts.id ?? `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}${++seq}`;
  const timestamp = String(opts.at ?? Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ id, type, api_version: "v1", api_version_date: "2026-08-14", timestamp: new Date().toISOString(), account_id: opts.account ?? ACCOUNT, data });
  const signature = signWhopPayload(opts.secret ?? SECRET, id, timestamp, raw);
  const r = await fetch(`${base}/billing/whop/webhook`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, body: opts.tamper ? raw.replace(ACCOUNT, `${ACCOUNT} `) : raw });
  return { id, status: r.status, body: await r.json() };
}
const kwd = (amount: string): Money => ({ amount, currency: "kwd", decimals: 3 });
const day = 86_400_000;
function paid(subscriptionId: string, userId: string, membershipId: string, opts: { reason?: string; total?: Money; status?: string; start?: number } = {}) {
  const pay = `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const start = opts.start ?? Date.now();
  memberships.set(membershipId, { id: membershipId, status: "active", cancel_at_period_end: false, current_period_start: new Date(start).toISOString(), current_period_end: new Date(start + 30 * day).toISOString(), metadata: { jassim_subscription_id: subscriptionId, jassim_user_id: userId } });
  payments.set(pay, { id: pay, status: opts.status ?? "paid", billing_reason: opts.reason ?? "subscription_create", membership_id: membershipId, total: opts.total ?? kwd("3.000"), metadata: { jassim_subscription_id: subscriptionId, jassim_user_id: userId } });
  return pay;
}
const sub = async (id: string) => (await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.id, id)))[0]!;
const ledger = async (eventId: string) => db.select().from(billingWebhookEvents).where(and(eq(billingWebhookEvents.providerKey, "whop"), eq(billingWebhookEvents.providerEventId, eventId)));

let goPlan = "";
let proPlan = "";
async function checkout(user: { cookie: string }, planId = goPlan) {
  const r = await request("/business/subscription-checkout", "POST", { planId, idempotencyKey: `wh-${randomUUID()}` }, user.cookie);
  assert.equal(r.status, 201, r.raw);
  return r.data.subscriptionId as string;
}

await test("setup: Jassim Go / Pro catalog products in KW (test configuration, not approved prices)", async () => {
  const admin = await account("admin");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await db.update(promotionProducts).set({ enabled: false }).where(and(eq(promotionProducts.marketId, "KW"), eq(promotionProducts.productType, "DINAR_BUSINESS")));
  const create = async (name: string, planCode: string, priceMinor: number, entitlements: string[]) => {
    const r = await request("/admin/markets/KW/commercial-products", "POST", { name: `${name} ${seq++}${randomUUID().slice(0, 4)}`, productType: "DINAR_BUSINESS", planCode, priceMinor, durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: entitlements, enabled: true }, admin.cookie);
    assert.equal(r.status, 201, r.raw);
    return r.data.id as string;
  };
  goPlan = await create("Jassim Go", "DINAR_GO", 3_000, ["AI_USAGE_BUSINESS_GO"]);
  proPlan = await create("Jassim Pro", "DINAR_PRO", 6_000, ["AI_USAGE_BUSINESS_PRO"]);
});

await test("WH-00 verifier matches Whop's documented scheme; money parsing is exact", () => {
  const raw = Buffer.from('{"a":1}');
  const now = 1_786_381_404;
  const sig = signWhopPayload(SECRET, "msg_1", String(now), raw);
  assert.deepEqual(verifyWhopSignature(raw, { "webhook-id": "msg_1", "webhook-timestamp": String(now), "webhook-signature": `v1,AAAA v1,${sig}` }, SECRET, now), { ok: true, id: "msg_1" });
  assert.equal(verifyWhopSignature(raw, { "webhook-id": "msg_1", "webhook-timestamp": String(now), "webhook-signature": `v1,${sig}` }, SECRET, now + 301).ok, false, "older than 5 minutes");
  assert.equal(verifyWhopSignature(Buffer.from('{"a":2}'), { "webhook-id": "msg_1", "webhook-timestamp": String(now), "webhook-signature": `v1,${sig}` }, SECRET, now).ok, false, "body changed");
  assert.equal(moneyToMinor({ amount: "3.000", currency: "kwd" }, 3), 3000);
  assert.equal(moneyToMinor({ amount: "3.5", currency: "kwd" }, 3), 3500);
  assert.equal(moneyToMinor({ amount: "3.0001", currency: "kwd" }, 3), undefined, "finer than the market scale");
  assert.equal(moneyToMinor({ amount: "-3", currency: "kwd" }, 3), undefined);
});

await test("WH-01 checkout: a Whop checkout with our reference in metadata; PENDING grants nothing; browser return grants nothing", async () => {
  const user = await account("buyer1");
  const id = await checkout(user);
  const last = checkouts.at(-1)!;
  assert.equal(last.body.variant_id, "plan_Go1");
  assert.deepEqual(last.body.metadata.jassim_subscription_id, id);
  assert.match(last.idempotencyKey ?? "", /^jassim-wh-/);
  assert.equal((await sub(id)).status, "PENDING");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "FREE", "no entitlement before a verified, paid event");
  // A client claiming success (no signature, any body) changes nothing.
  const forged = await fetch(`${base}/billing/whop/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "payment.succeeded", data: { id: "pay_x" } }) });
  assert.equal(forged.status, 401);
  assert.equal((await request("/billing/webhooks/whop", "POST", { event: { id: "e", type: "SUBSCRIPTION_ACTIVATED", subscriptionId: id, providerSubscriptionId: "m", periodStart: new Date().toISOString(), periodEnd: new Date(Date.now() + day).toISOString(), amountMinor: 3000, currencyCode: "KWD" }, signature: "x".repeat(64) })).status, 401, "the canonical JSON intake never accepts Whop events");
  assert.equal((await sub(id)).status, "PENDING");
});

await test("WH-02 success, duplicate, concurrent duplicate, entitlement change", async () => {
  const user = await account("buyer2");
  const id = await checkout(user);
  const pay = paid(id, user.id, "mem_A2");
  const first = await deliver("payment.succeeded", { id: pay });
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, "APPLIED", JSON.stringify(first.body));
  assert.equal((await sub(id)).status, "ACTIVE");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "BUSINESS_GO");
  // Retries carry the same webhook-id: answered from the ledger, never re-applied.
  const again = await deliver("payment.succeeded", { id: pay }, { id: first.id });
  assert.equal(again.body.duplicate, true);
  // Concurrent identical deliveries of a fresh event: exactly one ledger row.
  const user2 = await account("buyer2b");
  const id2 = await checkout(user2);
  const pay2 = paid(id2, user2.id, "mem_A2b");
  const msg = `msg_conc${randomUUID().slice(0, 8)}`;
  const results = await Promise.all([1, 2, 3, 4].map(() => deliver("payment.succeeded", { id: pay2 }, { id: msg })));
  assert.equal(results.filter((r) => r.body.outcome === "APPLIED" && !r.body.duplicate).length, 1, JSON.stringify(results.map((r) => r.body)));
  assert.equal((await ledger(msg)).length, 1);
  assert.equal((await sub(id2)).status, "ACTIVE");
});

await test("WH-03 failed, pending, renewal, cancellation scheduled, expiry", async () => {
  const user = await account("buyer3");
  const id = await checkout(user);
  const pending = paid(id, user.id, "mem_A3", { status: "pending" });
  assert.equal((await deliver("payment.succeeded", { id: pending })).body.failureCode, "PROVIDER_STATE_NOT_PAID", "the body alone is never believed");
  assert.equal((await sub(id)).status, "PENDING");
  const failed = paid(id, user.id, "mem_A3", { status: "open" });
  assert.equal((await deliver("payment.failed", { id: failed })).body.outcome, "APPLIED");
  assert.equal((await sub(id)).status, "PAYMENT_FAILED");
  // A paid event for the failed row is recorded, never revives it (PAYMENT_FAILED is final in the DB).
  assert.equal((await deliver("payment.succeeded", { id: paid(id, user.id, "mem_A3") })).body.failureCode, "TERMINAL_STATUS");
  assert.equal((await sub(id)).status, "PAYMENT_FAILED");
  // Retry recovery is a new checkout, which a failed one does not block.
  const retryId = await checkout(user);
  const ok = paid(retryId, user.id, "mem_A3");
  assert.equal((await deliver("payment.succeeded", { id: ok })).body.outcome, "APPLIED");
  assert.equal((await sub(retryId)).status, "ACTIVE");
  const periodEnd = (await sub(retryId)).currentPeriodEnd!;
  const renewal = paid(retryId, user.id, "mem_A3", { reason: "subscription_cycle", start: periodEnd.getTime() });
  assert.equal((await deliver("payment.succeeded", { id: renewal })).body.outcome, "APPLIED");
  assert.ok((await sub(retryId)).currentPeriodEnd! > periodEnd, "renewal extends the period");
  memberships.set("mem_A3", { ...memberships.get("mem_A3")!, cancel_at_period_end: true, status: "canceling" });
  assert.equal((await deliver("membership.updated", { id: "mem_A3" })).body.outcome, "APPLIED");
  assert.equal((await sub(retryId)).status, "CANCEL_AT_PERIOD_END");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "BUSINESS_GO", "access continues to the end of the paid period");
  memberships.set("mem_A3", { ...memberships.get("mem_A3")!, status: "expired" });
  assert.equal((await deliver("membership.updated", { id: "mem_A3" })).body.outcome, "APPLIED");
  assert.equal((await sub(retryId)).status, "EXPIRED");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "FREE");
});

await test("WH-04 refund ends access; partial refund is recorded for review; dispute changes nothing", async () => {
  const user = await account("buyer4");
  const id = await checkout(user);
  const pay = paid(id, user.id, "mem_A4");
  await deliver("payment.succeeded", { id: pay });
  assert.equal((await deliver("dispute.created", { id: "dp_1", payment: { id: pay } })).body.failureCode, "DISPUTE_RECORDED_FOR_REVIEW");
  assert.equal((await sub(id)).status, "ACTIVE");
  assert.equal((await deliver("refund.updated", { id: "rf_p", status: "succeeded", payment_id: pay, amount: kwd("1.000") })).body.failureCode, "AMOUNT_MISMATCH");
  assert.equal((await sub(id)).status, "ACTIVE");
  assert.equal((await deliver("refund.updated", { id: "rf_q", status: "pending", payment_id: pay, amount: kwd("3.000") })).body.failureCode, "REFUND_NOT_SUCCEEDED");
  assert.equal((await deliver("refund.updated", { id: "rf_1", status: "succeeded", payment_id: pay, amount: kwd("3.000") })).body.outcome, "APPLIED");
  assert.equal((await sub(id)).status, "CANCELLED");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "FREE");
});

await test("WH-05 invalid signature, wrong secret, replayed (stale) event, other Whop account", async () => {
  const user = await account("buyer5");
  const id = await checkout(user);
  const pay = paid(id, user.id, "mem_A5");
  assert.equal((await deliver("payment.succeeded", { id: pay }, { secret: `ws_${"ff".repeat(32)}` })).status, 401);
  assert.equal((await deliver("payment.succeeded", { id: pay }, { tamper: true })).status, 401);
  const stale = await deliver("payment.succeeded", { id: pay }, { at: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.failureCode, "STALE_TIMESTAMP");
  assert.equal((await deliver("payment.succeeded", { id: pay }, { account: "biz_Other" })).body.failureCode, "ACCOUNT_MISMATCH");
  assert.equal((await sub(id)).status, "PENDING");
});

await test("WH-06 amount, currency and account-owner mismatches are refused", async () => {
  const user = await account("buyer6");
  const other = await account("other6");
  const id = await checkout(user);
  assert.equal((await deliver("payment.succeeded", { id: paid(id, user.id, "mem_A6", { total: kwd("2.500") }) })).body.failureCode, "AMOUNT_MISMATCH");
  assert.equal((await deliver("payment.succeeded", { id: paid(id, user.id, "mem_A6", { total: { amount: "3.000", currency: "usd", decimals: 2 } }) })).body.failureCode, "AMOUNT_MISMATCH");
  assert.equal((await deliver("payment.succeeded", { id: paid(id, other.id, "mem_A6") })).body.failureCode, "ACCOUNT_MISMATCH");
  assert.equal((await sub(id)).status, "PENDING");
  assert.equal((await aiPlanFor(other.id, { id: "KW" })).tier, "FREE");
});

await test("WH-07 network interruption: nothing recorded, Whop's retry applies it later", async () => {
  const user = await account("buyer7");
  const id = await checkout(user);
  const pay = paid(id, user.id, "mem_A7");
  whopDown = true;
  const down = await deliver("payment.succeeded", { id: pay }, { id: "msg_net7" });
  whopDown = false;
  assert.equal(down.status, 503);
  assert.equal((await ledger("msg_net7")).length, 0, "no record, so the retry is not mistaken for a duplicate");
  assert.equal((await deliver("payment.succeeded", { id: pay }, { id: "msg_net7" })).body.outcome, "APPLIED");
  assert.equal((await sub(id)).status, "ACTIVE");
});

await test("WH-08 out of order: cancellation before activation is reconciled from Whop's state", async () => {
  const user = await account("buyer8");
  const id = await checkout(user);
  const pay = paid(id, user.id, "mem_A8");
  memberships.set("mem_A8", { ...memberships.get("mem_A8")!, cancel_at_period_end: true, status: "canceling" });
  assert.equal((await deliver("membership.updated", { id: "mem_A8" })).body.outcome, "IGNORED", "nothing to cancel yet");
  assert.equal((await deliver("payment.succeeded", { id: pay })).body.outcome, "APPLIED");
  assert.equal((await sub(id)).status, "CANCEL_AT_PERIOD_END", "the earlier cancellation is not lost");
  // A renewal that arrives after the subscription ended is never re-activation.
  memberships.set("mem_A8", { ...memberships.get("mem_A8")!, status: "expired" });
  await deliver("membership.updated", { id: "mem_A8" });
  const late = paid(id, user.id, "mem_A8", { reason: "subscription_cycle" });
  memberships.set("mem_A8", { ...memberships.get("mem_A8")!, status: "expired" });
  assert.notEqual((await deliver("payment.succeeded", { id: late })).body.outcome, "APPLIED");
  assert.equal((await sub(id)).status, "EXPIRED");
});

await test("WH-09 upgrade Go → Pro: a new paid subscription, no access before payment; unknown ids refused", async () => {
  const user = await account("buyer9");
  const id = await checkout(user);
  await deliver("payment.succeeded", { id: paid(id, user.id, "mem_A9") });
  const preview = await request(`/business/plan-change-preview?planId=${proPlan}`, "GET", undefined, user.cookie);
  if (preview.status === 200) assert.equal(preview.data.change.effective, "AFTER_PAYMENT_CONFIRMATION");
  const upgrade = await request("/business/subscription-checkout", "POST", { planId: proPlan, idempotencyKey: `wh-${randomUUID()}` }, user.cookie);
  assert.equal(upgrade.status, 409, "one live subscription per market: the upgrade path is cancel-at-period-end then subscribe (no unapproved proration)");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "BUSINESS_GO");
  const unknown = await deliver("payment.succeeded", { id: "pay_doesnotexist" });
  assert.equal(unknown.status, 503, "an id Whop does not know is never applied");
  const foreign = paid(randomUUID(), user.id, "mem_X");
  assert.equal((await deliver("payment.succeeded", { id: foreign })).body.failureCode, "UNKNOWN_SUBSCRIPTION");
});

after(async () => { uninstall(); server.close(); await pool.end(); });
