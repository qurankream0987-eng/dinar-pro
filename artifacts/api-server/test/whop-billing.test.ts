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
import { billingWebhookEvents, businessSubscriptions, conversations, db, messages, pool, promotionProducts, users } from "@workspace/db";
import { sweepRenewalReminders, renewalReminderText } from "../src/lib/subscription-reminders";
import app from "../src/app";
import { installWhopBilling, signWhopPayload, moneyToMinor, verifyWhopSignature, type WhopTransport } from "../src/lib/billing/whop";
import { aiPlanFor } from "../src/lib/business";
import { unwrapWebhook } from "@whop/sdk/helpers";
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
const cancels: { id: string; body: any; idempotencyKey?: string }[] = [];
let whopDown = false;
let apiCalls = 0;
const transport: WhopTransport = async ({ method, path, body, idempotencyKey }) => {
  apiCalls++;
  if (whopDown) throw new Error("ECONNRESET");
  if (method === "POST" && path === "/checkout_configurations") {
    checkouts.push({ body, idempotencyKey });
    return { status: 201, json: { id: `ch_${checkouts.length}`, purchase_url: `https://whop.com/checkout/ch_${checkouts.length}`, metadata: (body as any).metadata } };
  }
  if (method === "POST" && /^\/memberships\/[^/]+\/cancel$/.test(path)) {
    const mid = decodeURIComponent(path.split("/")[2]!);
    cancels.push({ id: mid, body, idempotencyKey });
    const m = memberships.get(mid);
    if (!m) return { status: 404, json: { error: "not found" } };
    // Whop keeps a cancel-at-period-end membership active until the period ends.
    memberships.set(mid, (body as any)?.cancel_at_period_end ? { ...m, cancel_at_period_end: true } : { ...m, status: "canceled" });
    return { status: 200, json: memberships.get(mid) };
  }
  const [, kind, id] = path.split("/");
  const store = kind === "payments" ? payments : kind === "memberships" ? memberships : undefined;
  const found = store?.get(decodeURIComponent(id ?? ""));
  return found ? { status: 200, json: found } : { status: 404, json: { error: "not found" } };
};

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const uninstall = installWhopBilling({ environment: "sandbox", apiKey: "test-key-not-real", webhookSecret: SECRET, accountId: ACCOUNT, plans: { DINAR_GO: "plan_Go1", "DINAR_GO:365": "plan_GoYear", DINAR_PRO: "plan_Pro1", "DINAR_PRO:365": "plan_ProYear" } }, transport);

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
/** Whop 2026-10-24 payment amounts: the plan price as `subtotal`, tax on top in `total`. */
function amounts(subtotal: Money, tax = "0") {
  const scale = subtotal.decimals ?? 2;
  const add = (a: string, b: string) => ((Math.round(Number(a) * 10 ** scale) + Math.round(Number(b) * 10 ** scale)) / 10 ** scale).toFixed(scale);
  return { subtotal, total: { ...subtotal, amount: add(subtotal.amount, tax) }, refunded_amount: { ...subtotal, amount: (0).toFixed(scale) } };
}
function refundOn(pay: string, amount: string) {
  const p = payments.get(pay)!;
  payments.set(pay, { ...p, refunded_amount: { ...(p.total as Money), amount } });
}
const day = 86_400_000;
function paid(subscriptionId: string, userId: string, membershipId: string, opts: { reason?: string; total?: Money; tax?: string; status?: string; start?: number; periodDays?: number } = {}) {
  const pay = `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const start = opts.start ?? Date.now();
  memberships.set(membershipId, { id: membershipId, status: "active", cancel_at_period_end: false, current_period_start: new Date(start).toISOString(), current_period_end: new Date(start + (opts.periodDays ?? 30) * day).toISOString(), metadata: { jassim_subscription_id: subscriptionId, jassim_user_id: userId } });
  payments.set(pay, { id: pay, status: opts.status ?? "paid", billing_reason: opts.reason ?? "subscription_create", membership_id: membershipId, account_id: ACCOUNT, ...amounts(opts.total ?? kwd("3.000"), opts.tax), metadata: { jassim_subscription_id: subscriptionId, jassim_user_id: userId } });
  return pay;
}
const sub = async (id: string) => (await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.id, id)))[0]!;
const ledger = async (eventId: string) => db.select().from(billingWebhookEvents).where(and(eq(billingWebhookEvents.providerKey, "whop"), eq(billingWebhookEvents.providerEventId, eventId)));

let goPlan = "";
let proPlan = "";
let goYearPlan = "";
async function checkout(user: { cookie: string }, planId = goPlan) {
  const r = await request("/business/subscription-checkout", "POST", { planId, idempotencyKey: `wh-${randomUUID()}` }, user.cookie);
  assert.equal(r.status, 201, r.raw);
  return r.data.subscriptionId as string;
}

await test("setup: Jassim Go / Pro catalog products in KW (test configuration, not approved prices)", async () => {
  const admin = await account("admin");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await db.update(promotionProducts).set({ enabled: false }).where(and(eq(promotionProducts.marketId, "KW"), eq(promotionProducts.productType, "DINAR_BUSINESS")));
  const create = async (name: string, planCode: string, priceMinor: number, entitlements: string[], durationDays = 30) => {
    const r = await request("/admin/markets/KW/commercial-products", "POST", { name: `${name} ${seq++}${randomUUID().slice(0, 4)}`, productType: "DINAR_BUSINESS", planCode, priceMinor, durationDays, chargingMode: "SUBSCRIPTION", businessEntitlements: entitlements, enabled: true }, admin.cookie);
    assert.equal(r.status, 201, r.raw);
    return r.data.id as string;
  };
  goPlan = await create("Jassim Go", "DINAR_GO", 3_000, ["AI_USAGE_BUSINESS_GO"]);
  proPlan = await create("Jassim Pro", "DINAR_PRO", 6_000, ["AI_USAGE_BUSINESS_PRO"]);
  goYearPlan = await create("Jassim Go annual", "DINAR_GO", 30_000, ["AI_USAGE_BUSINESS_GO"], 365);
});

await test("WH-00 verifier matches Whop's documented scheme; money parsing is exact", () => {
  const raw = Buffer.from('{"a":1}');
  const now = 1_786_381_404;
  const sig = signWhopPayload(SECRET, "msg_1", String(now), raw);
  assert.deepEqual(verifyWhopSignature(raw, { "webhook-id": "msg_1", "webhook-timestamp": String(now), "webhook-signature": `v1,AAAA v1,${sig}` }, SECRET, now), { ok: true, id: "msg_1" });
  assert.equal(verifyWhopSignature(raw, { "webhook-id": "msg_1", "webhook-timestamp": String(now), "webhook-signature": `v1,${sig}` }, SECRET, now + 301).ok, false, "older than 5 minutes");
  assert.equal(verifyWhopSignature(Buffer.from('{"a":2}'), { "webhook-id": "msg_1", "webhook-timestamp": String(now), "webhook-signature": `v1,${sig}` }, SECRET, now).ok, false, "body changed");
  // Parity with the official @whop/sdk verifier (unwrapWebhook) on the same bytes and headers.
  const fresh = Math.floor(Date.now() / 1000);
  const body = '{"type":"payment.succeeded","data":{"id":"pay_x"}}';
  const headers = { "webhook-id": "msg_sdk", "webhook-timestamp": String(fresh), "webhook-signature": `v1,${signWhopPayload(SECRET, "msg_sdk", String(fresh), body)}` };
  assert.deepEqual(unwrapWebhook(body, { headers, key: SECRET }), JSON.parse(body), "the SDK accepts our signature");
  assert.equal(verifyWhopSignature(Buffer.from(body), headers, SECRET).ok, true);
  assert.throws(() => unwrapWebhook(body.replace("pay_x", "pay_y"), { headers, key: SECRET }), "the SDK refuses a changed body too");
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
  // Sandbox-observed: a declined first card leaves the Whop checkout open for another card.
  assert.equal((await deliver("payment.failed", { id: failed })).body.failureCode, "INITIAL_ATTEMPT_FAILED_RETRY_ALLOWED");
  assert.equal((await sub(id)).status, "PENDING", "a declined first attempt does not close the subscription");
  const retryId = id;
  const ok = paid(retryId, user.id, "mem_A3");
  assert.equal((await deliver("payment.succeeded", { id: ok })).body.outcome, "APPLIED");
  assert.equal((await sub(retryId)).status, "ACTIVE");
  const periodEnd = (await sub(retryId)).currentPeriodEnd!;
  const renewal = paid(retryId, user.id, "mem_A3", { reason: "subscription_cycle", start: periodEnd.getTime() });
  assert.equal((await deliver("payment.succeeded", { id: renewal })).body.outcome, "APPLIED");
  assert.ok((await sub(retryId)).currentPeriodEnd! > periodEnd, "renewal extends the period");
  // A failed renewal (card 4000…0341 in the sandbox) is PAST_DUE: no access until Whop collects.
  const renewedEnd = (await sub(retryId)).currentPeriodEnd!;
  const failedRenewal = paid(retryId, user.id, "mem_A3", { reason: "subscription_cycle", status: "open", start: renewedEnd.getTime() });
  assert.equal((await deliver("payment.failed", { id: failedRenewal })).body.outcome, "APPLIED");
  assert.equal((await sub(retryId)).status, "PAST_DUE");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "FREE", "past due grants nothing");
  const recovered = paid(retryId, user.id, "mem_A3", { reason: "subscription_cycle", start: renewedEnd.getTime() });
  assert.equal((await deliver("payment.succeeded", { id: recovered })).body.outcome, "APPLIED");
  assert.equal((await sub(retryId)).status, "ACTIVE", "the recovered renewal restores access");
  memberships.set("mem_A3", { ...memberships.get("mem_A3")!, cancel_at_period_end: true, status: "canceling" });
  assert.equal((await deliver("membership.updated", { id: "mem_A3" })).body.outcome, "APPLIED");
  assert.equal((await sub(retryId)).status, "CANCEL_AT_PERIOD_END");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "BUSINESS_GO", "access continues to the end of the paid period");
  memberships.set("mem_A3", { ...memberships.get("mem_A3")!, status: "expired" });
  assert.equal((await deliver("membership.updated", { id: "mem_A3" })).body.outcome, "APPLIED");
  assert.equal((await sub(retryId)).status, "EXPIRED");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "FREE");
});

await test("WH-03b an abandoned checkout does not lock the buyer out: the same plan reuses it, another plan is refused", async () => {
  const user = await account("buyer3b");
  const first = await checkout(user);
  const again = await request("/business/subscription-checkout", "POST", { planId: goPlan, idempotencyKey: `wh-${randomUUID()}` }, user.cookie);
  assert.equal(again.status, 201, again.raw);
  assert.equal(again.data.subscriptionId, first, "the open PENDING subscription is reused, not duplicated");
  const other = await request("/business/subscription-checkout", "POST", { planId: proPlan, idempotencyKey: `wh-${randomUUID()}` }, user.cookie);
  assert.equal(other.status, 409);
});

await test("WH-04 refund ends access; partial refund is recorded for review; dispute changes nothing", async () => {
  const user = await account("buyer4");
  const id = await checkout(user);
  const pay = paid(id, user.id, "mem_A4");
  await deliver("payment.succeeded", { id: pay });
  assert.equal((await deliver("dispute.created", { id: "dp_1", payment: { id: pay } })).body.failureCode, "DISPUTE_RECORDED_FOR_REVIEW");
  assert.equal((await sub(id)).status, "ACTIVE");
  assert.equal((await deliver("resolution_center_case.created", { id: "rcc_1", payment: { id: pay } })).body.failureCode, "DISPUTE_RECORDED_FOR_REVIEW");
  assert.equal((await sub(id)).status, "ACTIVE");
  // The body's amount is never believed: a refund of 1.000 claimed as "everything" is read from Whop.
  refundOn(pay, "1.000");
  assert.equal((await deliver("refund.updated", { id: "rf_p", status: "succeeded", payment: { id: pay }, amount: 3 })).body.failureCode, "PARTIAL_REFUND_FOR_REVIEW");
  assert.equal((await sub(id)).status, "ACTIVE");
  refundOn(pay, "3.000");
  assert.equal((await deliver("refund.updated", { id: "rf_q", status: "pending", payment: { id: pay } })).body.failureCode, "REFUND_NOT_SUCCEEDED");
  whopDown = true;
  assert.equal((await deliver("refund.updated", { id: "rf_1", status: "succeeded", payment: { id: pay } }, { id: "msg_refund_full" })).status, 503, "Whop unreachable: nothing recorded, Whop redelivers");
  whopDown = false;
  assert.equal((await sub(id)).status, "ACTIVE");
  assert.equal((await deliver("refund.updated", { id: "rf_1", status: "succeeded", payment: { id: pay } }, { id: "msg_refund_full" })).body.outcome, "APPLIED");
  assert.deepEqual(cancels.at(-1), { id: "mem_A4", body: { cancel_at_period_end: false }, idempotencyKey: "jassim-refund-cancel-mem_A4" }, "a full refund ends the Whop membership so it never renews");
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

await test("WH-10 sandbox-verified shapes: tax on top is accepted on the pre-tax price; annual plan uses its own Whop plan; deactivation ends access", async () => {
  const user = await account("buyer10");
  const id = await checkout(user);
  const taxed = paid(id, user.id, "mem_A10", { tax: "0.248" });
  assert.equal((await deliver("payment.succeeded", { id: taxed })).body.outcome, "APPLIED", "Whop adds sales tax as merchant of record; our snapshot is the pre-tax price");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "BUSINESS_GO");
  assert.equal((await deliver("membership.deactivated", { id: "mem_A10" })).body.outcome, "IGNORED", "Whop still reports the membership active: the body is not believed");
  memberships.set("mem_A10", { ...memberships.get("mem_A10")!, status: "canceled" });
  assert.equal((await deliver("membership.deactivated", { id: "mem_A10" })).body.outcome, "APPLIED");
  assert.equal((await sub(id)).status, "EXPIRED");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "FREE");

  const yearly = await account("buyer10y");
  const yid = await checkout(yearly, goYearPlan);
  assert.equal(checkouts.at(-1)!.body.variant_id, "plan_GoYear", "the 365-day product maps to the annual Whop plan");
  assert.equal((await deliver("payment.succeeded", { id: paid(yid, yearly.id, "mem_A10y", { total: kwd("30.000"), periodDays: 365 }) })).body.outcome, "APPLIED");
  const row = await sub(yid);
  assert.equal(row.status, "ACTIVE");
  assert.equal(Math.round((row.currentPeriodEnd!.getTime() - row.currentPeriodStart!.getTime()) / day), 365);
  assert.equal((await deliver("payment.succeeded", { id: paid(randomUUID(), yearly.id, "mem_Z", { total: kwd("3.000") }) })).body.failureCode, "UNKNOWN_SUBSCRIPTION");
});

await test("WH-11 plan map without an annual Whop plan refuses the annual checkout (no wrong-price fallback)", async () => {
  const { whopPlanFor, whopConfigFromEnv } = await import("../src/lib/billing/whop");
  assert.equal(whopPlanFor({ DINAR_GO: "plan_A" }, "DINAR_GO", 365), undefined);
  assert.equal(whopPlanFor({ DINAR_GO: "plan_A" }, "DINAR_GO", 30), "plan_A");
  const env = { DINAR_WHOP_BILLING_ENABLED: "true", WHOP_API_KEY: "k", WHOP_BILLING_WEBHOOK_SECRET: SECRET, WHOP_ACCOUNT_ID: ACCOUNT };
  // The orders webhook secret never stands in for the subscription webhook's own secret.
  assert.equal(whopConfigFromEnv({ DINAR_WHOP_BILLING_ENABLED: "true", WHOP_API_KEY: "k", WHOP_WEBHOOK_SECRET: SECRET, WHOP_ACCOUNT_ID: ACCOUNT, DINAR_WHOP_PLAN_MAP: '{"DINAR_GO":"plan_A"}' }), undefined);
  assert.equal(whopConfigFromEnv({ DINAR_WHOP_BILLING_ENABLED: "true", WHOP_API_KEY: "k", WHOP_BILLING_WEBHOOK_SECRET: SECRET, WHOP_COMPANY_ID: ACCOUNT, DINAR_WHOP_PLAN_MAP: '{"DINAR_GO":"plan_A"}' })?.accountId, ACCOUNT);
  assert.ok(whopConfigFromEnv({ ...env, DINAR_WHOP_PLAN_MAP: '{"DINAR_GO:365":"plan_A"}' }));
  assert.equal(whopConfigFromEnv({ ...env, DINAR_WHOP_PLAN_MAP: '{"FREE":"plan_A"}' }), undefined);
  assert.equal(whopConfigFromEnv({ ...env, DINAR_WHOP_ENVIRONMENT: "production", DINAR_WHOP_PLAN_MAP: "{}" }), undefined, "production needs DINAR_LIVE_PROVIDERS_ENABLED");
});

await test("WH-12 owner-approved USD prices in a KWD market: Pro annual $200 via Whop; never payable from the wallet", async () => {
  const admin = await account("admin12");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  const created = await request("/admin/markets/KW/commercial-products", "POST", { name: `JassimAI Pro annual ${randomUUID().slice(0, 4)}`, productType: "DINAR_BUSINESS", planCode: "DINAR_PRO", currencyCode: "USD", priceMinor: 20_000, durationDays: 365, chargingMode: "SUBSCRIPTION", businessEntitlements: ["AI_USAGE_BUSINESS_PRO"], enabled: true }, admin.cookie);
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.data.priceLabel, "200.00 USD", "USD uses 2 decimals even in a 3-decimal market");
  const badCurrency = await request("/admin/markets/KW/commercial-products", "POST", { name: `Featured ${randomUUID().slice(0, 4)}`, productType: "FEATURED_LISTING", currencyCode: "USD", priceMinor: 500, durationDays: 7, categoryId: "electronics" }, admin.cookie);
  assert.equal(badCurrency.status, 400, "only subscription plans may leave the market currency");
  const user = await account("buyer12");
  const wallet = await request("/business/subscriptions", "POST", { planId: created.data.id, idempotencyKey: `wh-${randomUUID()}` }, user.cookie);
  assert.notEqual(wallet.status, 201, "a USD plan is never charged to the simulated KWD wallet");
  const id = await checkout(user, created.data.id);
  assert.equal(checkouts.at(-1)!.body.variant_id, "plan_ProYear");
  const usd = (amount: string): Money => ({ amount, currency: "usd", decimals: 2 });
  assert.equal((await deliver("payment.succeeded", { id: paid(id, user.id, "mem_A12", { total: usd("199.99"), periodDays: 365 }) })).body.failureCode, "AMOUNT_MISMATCH");
  assert.equal((await deliver("payment.succeeded", { id: paid(id, user.id, "mem_A12", { total: usd("200.00"), tax: "16.50", periodDays: 365 }) })).body.outcome, "APPLIED");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "BUSINESS_PRO");
});

// ── Whop phase 2 ─────────────────────────────────────────────────────────────────────────────────
async function aiConversation(userId: string) {
  const id = randomUUID();
  await db.insert(conversations).values({ id, ownerUserId: userId, marketId: "KW", kind: "AI", title: "اشتراك" });
  return id;
}

await test("WH-13 checkout from a conversation: owner-only conversation, return URL to the same conversation, tax note, membership linked from the verified payment", async () => {
  const user = await account("buyer13");
  const stranger = await account("stranger13");
  const conversationId = await aiConversation(user.id);
  const foreign = await request("/business/subscription-checkout", "POST", { planId: goPlan, idempotencyKey: `wh-${randomUUID()}`, conversationId }, stranger.cookie);
  assert.equal(foreign.status, 404, "another user's conversation is never accepted");
  process.env.APP_ORIGIN = "https://app.example.test";
  const r = await request("/business/subscription-checkout", "POST", { planId: goPlan, idempotencyKey: `wh-${randomUUID()}`, conversationId }, user.cookie);
  delete process.env.APP_ORIGIN;
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.data.status, "PENDING");
  assert.match(r.data.taxNote, /Whop/);
  assert.equal(r.data.returnPath, `/?checkout=${r.data.subscriptionId}&conversation=${conversationId}`);
  assert.equal(checkouts.at(-1)!.body.redirect_url, `https://app.example.test/?checkout=${r.data.subscriptionId}&conversation=${conversationId}`);
  const id = r.data.subscriptionId as string;
  let row = await sub(id);
  assert.equal(row.conversationId, conversationId);
  assert.equal(row.providerKey, "whop");
  assert.match(row.providerCheckoutId ?? "", /^ch_/);
  assert.equal(row.providerSubscriptionId, null, "no membership before Whop confirms payment");
  // The return page reads the server, never the URL: unpaid until the signed webhook; 404 for strangers.
  assert.equal((await request(`/business/subscription-checkout/${id}`, "GET", undefined, stranger.cookie)).status, 404);
  assert.equal((await request(`/business/subscription-checkout/${id}`, "GET", undefined, user.cookie)).data.paid, false);
  assert.equal((await deliver("payment.succeeded", { id: paid(id, user.id, "mem_P13") })).body.outcome, "APPLIED");
  const back = await request(`/business/subscription-checkout/${id}`, "GET", undefined, user.cookie);
  assert.equal(back.data.paid, true);
  assert.equal(back.data.conversationId, conversationId);
  row = await sub(id);
  assert.equal(row.providerSubscriptionId, "mem_P13");
});

await test("WH-14 cancel from the app goes to Whop (cancel at period end); our record changes only on Whop's signed confirmation", async () => {
  const user = await account("buyer14");
  const id = await checkout(user);
  assert.equal((await deliver("payment.succeeded", { id: paid(id, user.id, "mem_P14") })).body.outcome, "APPLIED");
  const before = cancels.length;
  const r = await request("/business/subscription/cancel", "POST", {}, user.cookie);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.status, "CANCELLATION_REQUESTED");
  assert.equal(cancels.length, before + 1);
  assert.deepEqual(cancels.at(-1)!.body, { cancel_at_period_end: true });
  assert.equal(cancels.at(-1)!.id, "mem_P14");
  assert.equal((await sub(id)).status, "ACTIVE", "no local change before Whop confirms");
  assert.equal((await deliver("membership.updated", { id: "mem_P14" })).body.outcome, "APPLIED");
  assert.equal((await sub(id)).status, "CANCEL_AT_PERIOD_END");
  assert.equal((await aiPlanFor(user.id, { id: "KW" })).tier, "BUSINESS_GO", "benefits stay until the period ends");
  const user2 = await account("buyer14b");
  const id2 = await checkout(user2);
  assert.equal((await deliver("payment.succeeded", { id: paid(id2, user2.id, "mem_P14b") })).body.outcome, "APPLIED");
  whopDown = true;
  const down = await request("/business/subscription/cancel", "POST", {}, user2.cookie);
  whopDown = false;
  assert.equal(down.status, 503, "Whop unreachable: refused truthfully");
  assert.equal((await sub(id2)).status, "ACTIVE");
});

await test("WH-15 renewal reminder: once per period, three days before the end, written into the conversation", async () => {
  const user = await account("buyer15");
  const conversationId = await aiConversation(user.id);
  const r = await request("/business/subscription-checkout", "POST", { planId: goPlan, idempotencyKey: `wh-${randomUUID()}`, conversationId }, user.cookie);
  const id = r.data.subscriptionId as string;
  assert.equal((await deliver("payment.succeeded", { id: paid(id, user.id, "mem_P15") })).body.outcome, "APPLIED");
  const end = (await sub(id)).currentPeriodEnd!;
  const sent: any[] = [];
  const notify = async (input: any) => { sent.push(input); return { status: "NOT_CONNECTED" as const }; };
  assert.ok(!(await sweepRenewalReminders(new Date(end.getTime() - 4 * day), { notify })).includes(id), "not before three days");
  assert.ok((await sweepRenewalReminders(new Date(end.getTime() - 3 * day + 60_000), { notify })).includes(id));
  assert.ok(!(await sweepRenewalReminders(new Date(end.getTime() - 2 * day), { notify })).includes(id), "one reminder per period");
  const mine = sent.filter((item) => item.data.subscriptionId === id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].templateKey, "SUBSCRIPTION_RENEWAL_REMINDER");
  assert.equal(mine[0].data.status, "RENEWS");
  const notes = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.body, /يتجدد/);
  assert.equal(renewalReminderText({ planName: "Go", periodEnd: end, renews: false }).includes("لن يتجدد"), true);
  // A renewal moves the period end: the next period gets its own reminder.
  const next = paid(id, user.id, "mem_P15", { reason: "subscription_cycle", start: end.getTime() });
  assert.equal((await deliver("payment.succeeded", { id: next })).body.outcome, "APPLIED");
  const end2 = (await sub(id)).currentPeriodEnd!;
  assert.ok((await sweepRenewalReminders(new Date(end2.getTime() - 2 * day), { notify })).includes(id));
});

after(async () => { uninstall(); server.close(); await pool.end(); });
