/**
 * Whop SANDBOX end-to-end check (owner-approved 2026-11-16; Sandbox only, no real money).
 *
 * Black-box: a running JassimAI API server (disposable loopback database, Whop billing enabled with
 * DINAR_WHOP_ENVIRONMENT=sandbox) is driven over HTTP; real Whop Sandbox checkouts are paid in a
 * headless browser with Whop's documented test cards; Whop's own objects (payments, memberships,
 * refunds) are then announced to the server as signed webhooks, and the server must decide only from
 * what it reads back from the Whop Sandbox API.
 *
 * Whop cannot deliver webhooks to a loopback server, so the envelope is signed here with the
 * server's local test secret; everything the server believes comes from Whop's Sandbox API.
 *
 * Refuses to run unless the Whop API host is the sandbox and the database is a disposable test DB.
 * Usage: E2E_API=http://127.0.0.1:PORT/api E2E_DATABASE_URL=… WHOP_WEBHOOK_SECRET=ws_… node test/whop-sandbox-e2e.mjs
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("../../../lib/db/node_modules/pg");
const { chromium } = require(process.env.E2E_PLAYWRIGHT ?? "playwright");

const API = process.env.E2E_API;
const SANDBOX = "https://sandbox-api.whop.com/api/v1";
const ACCOUNT = process.env.WHOP_ACCOUNT_ID;
const SECRET = process.env.WHOP_WEBHOOK_SECRET;
const DB_URL = process.env.E2E_DATABASE_URL;
if (!API?.startsWith("http://127.0.0.1:") || !SECRET?.startsWith("ws_") || !/^biz_/.test(ACCOUNT ?? "")) throw new Error("E2E_API (loopback), WHOP_WEBHOOK_SECRET and WHOP_ACCOUNT_ID are required");
if (!/^postgres(ql)?:\/\/[^@]+@127\.0\.0\.1:\d+\/dinar_test_/.test(DB_URL ?? "")) throw new Error("refusing: E2E_DATABASE_URL must be a loopback dinar_test_* database");
const db = new pg.Client({ connectionString: DB_URL });
await db.connect();

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", ms: Date.now() - started, detail });
    console.log(`PASS ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  } catch (error) {
    results.push({ name, status: "FAIL", ms: Date.now() - started, detail: String(error?.message ?? error).slice(0, 400) });
    console.log(`FAIL ${name} — ${String(error?.message ?? error).slice(0, 400)}`);
  }
}

// ─── Whop Sandbox REST (the proxy injects the sandbox key; this script never holds it) ───────────
async function whop(method, path, body, idempotencyKey) {
  const response = await fetch(SANDBOX + path, {
    method,
    headers: { Authorization: "Bearer proxy-injected", "Api-Version-Date": "2026-10-24", ...(body ? { "Content-Type": "application/json" } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Whop ${method} ${path} → ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// ─── JassimAI API ────────────────────────────────────────────────────────────────────────────────
let ip = 10;
async function api(path, method = "GET", body, cookie = "") {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `198.61.${ip++ % 250}.7`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_700_000 + (Date.now() % 80_000);
let n = 0;
async function account(label) {
  const phoneNumber = String(phoneBase + 7 * n++);
  const s = await api("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await api("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Wx-${randomUUID().slice(0, 12)}!`;
  const c = await api("/auth/register", "POST", { displayName: `Whop E2E ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await api("/account/market", "PATCH", { marketId: "KW" }, c.cookie)).status, 200);
  return { id: c.data.user.id, cookie: c.cookie };
}

// ─── Signed delivery of a Whop event naming a real Sandbox object ───────────────────────────────
async function deliver(type, data) {
  const id = `msg_e2e${randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ id, type, api_version: "v1", api_version_date: "2026-10-24", timestamp: new Date().toISOString(), account_id: ACCOUNT, data });
  const signature = createHmac("sha256", Buffer.from(SECRET, "utf8")).update(`${id}.${timestamp}.`).update(raw).digest("base64");
  const r = await fetch(`${API}/billing/whop/webhook`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, body: raw });
  return { id, status: r.status, body: await r.json() };
}

// ─── Pay a Whop Sandbox checkout in a headless browser ──────────────────────────────────────────
const proxy = new URL(process.env.HTTPS_PROXY);
const browser = await chromium.launch({ proxy: { server: `${proxy.protocol}//${proxy.host}`, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password), bypass: "127.0.0.1,localhost" } });
async function pay(purchaseUrl, card, tag) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  try {
    await page.goto(purchaseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByPlaceholder("you@example.com").fill(`jassim-sbx-${tag}@mailinator.com`, { timeout: 30_000 });
    await page.waitForTimeout(8_000);
    for (const frame of page.frames()) {
      const url = frame.url();
      const value = url.includes("card-number") ? card : url.includes("expiration") ? "1234" : url.includes("verification-code") ? "123" : null;
      if (value) { await frame.locator("input").first().click(); await frame.locator("input").first().pressSequentially(value, { delay: 40 }); }
    }
    await page.getByPlaceholder("Full name").first().fill("Jassim Sandbox Test");
    const address = page.getByPlaceholder("Address", { exact: true }).first();
    await address.click();
    await address.pressSequentially("1 Test St", { delay: 60 });
    await page.waitForTimeout(2_500);
    await page.locator(".whop-AddressSuggestion").filter({ hasText: "El Paso" }).first().click({ timeout: 5_000 }).catch(() => page.locator(".whop-AddressSuggestion").first().click().catch(() => {}));
    await page.waitForTimeout(1_500);
    await page.keyboard.press("Escape");
    await page.getByPlaceholder("City", { exact: true }).first().fill("Austin").catch(() => {});
    await page.locator('input[data-address-field="postalCode"], input[autocomplete="billing postal-code"]').first().fill("78701").catch(() => {});
    const state = page.locator('select[data-address-field="state"], select[autocomplete="billing address-level1"]').first();
    if (await state.count()) await state.selectOption({ label: "Texas" }).catch(() => {});
    await page.screenshot({ path: `${process.env.E2E_SHOTS ?? "/tmp"}/whop-${tag}-filled.png` }).catch(() => {});
    const summary = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const due = (summary.match(/Total due today \$[\d,.]+/) ?? [""])[0];
    await page.getByRole("button", { name: /Subscribe|Pay|Join/ }).click();
    await page.waitForTimeout(20_000);
    await page.screenshot({ path: `${process.env.E2E_SHOTS ?? "/tmp"}/whop-${tag}-after.png` }).catch(() => {});
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    // Completion: Whop's own page, or Whop's redirect back to our return URL (the server never trusts it).
    const complete = /Payment complete/i.test(text) || page.url().startsWith("http://127.0.0.1:");
    return { due: due.replace(/\s+/g, " ").trim(), complete, returnUrl: page.url().slice(0, 120), declined: /declin|failed|could not|unable/i.test(text), text: text.slice(0, 200) };
  } finally {
    await page.close();
  }
}
async function paymentFor(checkoutId, { wantStatus, tries = 12 } = {}) {
  for (let i = 0; i < tries; i++) {
    const list = await whop("GET", `/payments?account_id=${ACCOUNT}&first=25`);
    const found = (list.data ?? []).filter((p) => p.checkout_configuration_id === checkoutId);
    const match = wantStatus ? found.find((p) => p.status === wantStatus) : found[0];
    if (match) return await whop("GET", `/payments/${match.id}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return undefined;
}
const subscription = async (id) => (await db.query("select status, price_minor_snapshot, currency_code_snapshot, period_days_snapshot, current_period_start, current_period_end from business_subscriptions where id = $1", [id])).rows[0];
const tierOf = async (cookie) => (await api("/business/subscription", "GET", undefined, cookie)).data;

// ─── Setup: the owner-approved USD prices as catalog products in the KW market ──────────────────
const PRICES = { "DINAR_GO:30": 1_000, "DINAR_GO:365": 10_000, "DINAR_PRO:30": 2_000, "DINAR_PRO:365": 20_000 };
const ENT = { DINAR_GO: ["AI_USAGE_BUSINESS_GO"], DINAR_PRO: ["AI_USAGE_BUSINESS_PRO"] };
const products = {};
await step("setup: owner-approved USD plans (Go/Pro, monthly/annual) in the KW catalog", async () => {
  const admin = await account("admin");
  await db.query("update users set role = 'ADMIN' where id = $1", [admin.id]);
  await db.query("update promotion_products set enabled = false where market_id = 'KW' and product_type = 'DINAR_BUSINESS'");
  for (const [key, priceMinor] of Object.entries(PRICES)) {
    const [planCode, days] = key.split(":");
    const r = await api("/admin/markets/KW/commercial-products", "POST", { name: `JassimAI ${planCode} ${days}d ${randomUUID().slice(0, 4)}`, productType: "DINAR_BUSINESS", planCode, currencyCode: "USD", priceMinor, durationDays: Number(days), chargingMode: "SUBSCRIPTION", businessEntitlements: ENT[planCode], enabled: true }, admin.cookie);
    assert.equal(r.status, 201, r.raw);
    products[key] = r.data.id;
  }
  return Object.fromEntries(Object.entries(products).map(([k]) => [k, `${PRICES[k] / 100} USD`]));
});

async function startCheckout(user, key) {
  const r = await api("/business/subscription-checkout", "POST", { planId: products[key], idempotencyKey: `e2e-${randomUUID()}` }, user.cookie);
  assert.equal(r.status, 201, r.raw);
  assert.match(r.data.checkout.checkoutUrl, /^https:\/\/sandbox\.whop\.com\/checkout\//);
  const row = await subscription(r.data.subscriptionId);
  assert.equal(row.status, "PENDING");
  return { subscriptionId: r.data.subscriptionId, checkoutId: r.data.checkout.providerCheckoutId, url: r.data.checkout.checkoutUrl };
}

const live = {};
for (const [key, expectedDue, days] of [["DINAR_GO:30", "$10.00", 30], ["DINAR_GO:365", "$100.00", 365], ["DINAR_PRO:30", "$20.00", 30]]) {
  await step(`E2E-pay ${key}: checkout from our API, test card 4242, activation only from Whop's payment`, async () => {
    const user = await account(key.replace(":", "-"));
    const c = await startCheckout(user, key);
    const paid = await pay(c.url, "4242424242424242", `${key.replace(":", "-").toLowerCase()}-${Date.now() % 100000}`);
    assert.ok(paid.due.includes(expectedDue), `Whop shows due today: "${paid.due}" (expected ${expectedDue})`);
    assert.ok(paid.complete, `checkout result: ${paid.text}`);
    assert.equal((await subscription(c.subscriptionId)).status, "PENDING", "the browser return grants nothing");
    const payment = await paymentFor(c.checkoutId, { wantStatus: "paid" });
    assert.ok(payment, "Whop has the paid payment");
    assert.equal(payment.metadata?.jassim_subscription_id, c.subscriptionId);
    const first = await deliver("payment.succeeded", { id: payment.id });
    assert.equal(first.body.outcome, "APPLIED", JSON.stringify(first.body));
    const again = await deliver("payment.succeeded", { id: payment.id });
    assert.equal(again.body.outcome, "IGNORED", "a second announcement of the same payment changes nothing");
    assert.equal(again.body.failureCode, "NOT_PENDING");
    const row = await subscription(c.subscriptionId);
    assert.equal(row.status, "ACTIVE");
    const length = Math.round((row.current_period_end - row.current_period_start) / 86_400_000);
    assert.equal(length, days, `period from Whop's membership: ${length} days`);
    live[key] = { ...c, user, payment: payment.id, membership: payment.membership_id };
    return { pay: payment.id, subtotal: payment.subtotal.amount, tax: payment.tax_amount?.amount, total: payment.total.amount, afterFees: payment.amount_after_fees?.amount, periodDays: length };
  });
}

await step("E2E-entitlement: Go monthly → BUSINESS_GO tier; Pro monthly → BUSINESS_PRO tier", async () => {
  const go = await tierOf(live["DINAR_GO:30"].user.cookie);
  const pro = await tierOf(live["DINAR_PRO:30"].user.cookie);
  const text = JSON.stringify({ go, pro });
  assert.match(JSON.stringify(go), /BUSINESS_GO|DINAR_GO/);
  assert.match(JSON.stringify(pro), /BUSINESS_PRO|DINAR_PRO/);
  return text.slice(0, 200);
});

await step("E2E-decline then retry: card 4000…0002 declined → stays PENDING; the buyer retries with 4242 → ACTIVE", async () => {
  const user = await account("declined");
  const c = await startCheckout(user, "DINAR_GO:30");
  const result = await pay(c.url, "4000000000000002", `declined-${Date.now() % 100000}`);
  assert.ok(!result.complete, `checkout must not complete: ${result.text}`);
  const failed = await paymentFor(c.checkoutId, { tries: 4 });
  const d = failed ? await deliver("payment.failed", { id: failed.id }) : undefined;
  assert.equal((await subscription(c.subscriptionId)).status, "PENDING", "a declined first attempt keeps the subscription open");
  // The buyer comes back: our API resumes the same subscription and Whop checkout.
  const resumed = await api("/business/subscription-checkout", "POST", { planId: products["DINAR_GO:30"], idempotencyKey: `e2e-${randomUUID()}` }, user.cookie);
  assert.equal(resumed.status, 201, resumed.raw);
  assert.equal(resumed.data.subscriptionId, c.subscriptionId);
  const retry = await pay(resumed.data.checkout.checkoutUrl, "4242424242424242", `retry-${Date.now() % 100000}`);
  assert.ok(retry.complete, retry.text);
  const paid = await paymentFor(resumed.data.checkout.providerCheckoutId, { wantStatus: "paid" });
  assert.ok(paid);
  assert.equal((await deliver("payment.succeeded", { id: paid.id })).body.outcome, "APPLIED");
  assert.equal((await subscription(c.subscriptionId)).status, "ACTIVE");
  return { declinedPayment: failed?.id ?? "none", declinedWhopStatus: failed?.status, declineOutcome: d?.body.failureCode, sameCheckout: resumed.data.checkout.providerCheckoutId === c.checkoutId, retryPayment: paid.id };
});

await step("E2E-cancel at period end (Go monthly): Whop membership canceling → CANCEL_AT_PERIOD_END, access kept", async () => {
  const s = live["DINAR_GO:30"];
  const forged = await deliver("membership.updated", { id: s.membership, status: "canceled" });
  assert.notEqual((await subscription(s.subscriptionId)).status, "EXPIRED", `a body claiming cancellation is not believed: ${JSON.stringify(forged.body)}`);
  await whop("POST", `/memberships/${s.membership}/cancel`, { cancel_at_period_end: true }, `e2e-cancel-${s.membership}`);
  const m = await whop("GET", `/memberships/${s.membership}`);
  const d = await deliver("membership.updated", { id: s.membership });
  assert.equal(d.body.outcome, "APPLIED", JSON.stringify(d.body));
  assert.equal((await subscription(s.subscriptionId)).status, "CANCEL_AT_PERIOD_END");
  assert.match(JSON.stringify(await tierOf(s.user.cookie)), /BUSINESS_GO|DINAR_GO/, "paid period still grants Go");
  return { whopStatus: m.status, cancelAtPeriodEnd: m.cancel_at_period_end, periodEnd: m.current_period_end };
});

await step("E2E-refund (Go annual): full refund through Whop → CANCELLED, entitlement removed", async () => {
  const s = live["DINAR_GO:365"];
  const refunded = await whop("POST", `/payments/${s.payment}/refund`, { metadata: { jassim_test: "e2e" } }, `e2e-refund-${s.payment}`);
  let payment;
  for (let i = 0; i < 12; i++) {
    payment = await whop("GET", `/payments/${s.payment}`);
    if (Number(payment.refunded_amount?.amount ?? 0) >= Number(payment.total.amount)) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const d = await deliver("refund.updated", { id: `rf_${s.payment}`, status: "succeeded", payment: { id: s.payment } });
  assert.equal(d.body.outcome, "APPLIED", JSON.stringify(d.body));
  assert.equal((await subscription(s.subscriptionId)).status, "CANCELLED");
  const after = JSON.stringify(await tierOf(s.user.cookie));
  assert.doesNotMatch(after, /"status":"ACTIVE"/);
  const m = await whop("GET", `/memberships/${s.membership}`);
  assert.ok(["canceled", "expired", "completed"].includes(m.status), `the refunded Whop membership must not renew (Whop says ${m.status})`);
  return { paymentStatus: payment.status, refunded: payment.refunded_amount?.amount, total: payment.total.amount, membershipAfter: m.status, renews: m.cancel_at_period_end === false && m.status === "active" };
});

await step("E2E-immediate cancellation (Pro monthly): Whop membership ends → membership.deactivated → EXPIRED", async () => {
  const s = live["DINAR_PRO:30"];
  await whop("POST", `/memberships/${s.membership}/cancel`, { cancel_at_period_end: false }, `e2e-cancel-now-${s.membership}`);
  let m;
  for (let i = 0; i < 12; i++) {
    m = await whop("GET", `/memberships/${s.membership}`);
    if (["canceled", "expired", "completed"].includes(m.status)) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const d = await deliver("membership.deactivated", { id: s.membership });
  assert.equal(d.body.outcome, "APPLIED", `${JSON.stringify(d.body)} whop=${m.status}`);
  assert.equal((await subscription(s.subscriptionId)).status, "EXPIRED");
  return { whopStatus: m.status };
});

await step("E2E-forgery: a valid-looking event for a payment Whop does not have, and a wrong signature, change nothing", async () => {
  const s = live["DINAR_GO:30"];
  const unknown = await deliver("payment.succeeded", { id: "pay_doesnotexist000" });
  assert.notEqual(unknown.body.outcome, "APPLIED");
  const raw = JSON.stringify({ id: "msg_bad", type: "payment.succeeded", account_id: ACCOUNT, data: { id: s.payment } });
  const bad = await fetch(`${API}/billing/whop/webhook`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "msg_bad", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" }, body: raw });
  assert.equal(bad.status, 401);
  return { unknown: `${unknown.status} ${unknown.body.failureCode ?? unknown.body.code}`, badSignature: bad.status };
});

await browser.close();
await db.end();
console.log(`E2E_SUMMARY pass=${results.filter((r) => r.status === "PASS").length} fail=${results.filter((r) => r.status === "FAIL").length}`);
console.log(`E2E_JSON ${JSON.stringify(results)}`);
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
