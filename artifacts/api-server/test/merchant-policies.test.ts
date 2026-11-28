/**
 * M1 merchant policies: permissions, confirmation tiers, conflicts, versions, audit and the
 * conversation. Real API and runtime, disposable loopback database, no network, no money.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { businessProfiles, db, markets, merchantPolicies, merchantPolicyEvents, pool, sessions } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

const { default: app } = await import("../src/app");
const { confirmPolicy, effectivePolicy } = await import("../src/lib/merchant-policies/engine");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
after(async () => {
  server.close();
  await pool.end();
});
let ip = Math.floor(Math.random() * 20_000);
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), "X-Forwarded-For": `198.52.${(ip >> 8) & 255}.${ip++ & 255}` },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_100_000 + ((Date.now() + process.pid + 3) % 140_000);
let offset = 0;
type Actor = { id: string; cookie: string };
async function register(name: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Pol-${randomUUID().slice(0, 10)}!`;
  const registered = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id as string, cookie: registered.cookie };
}
await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
async function business(owner: Actor, name: string) {
  const id = randomUUID();
  await db.insert(businessProfiles).values({ id, ownerUserId: owner.id, marketId: "JO", displayName: name, normalizedName: `${name}-${id.slice(0, 4)}`.toLowerCase(), categoryKey: "RETAIL", idempotencyKey: `bp-${id}` } as any);
  return id;
}
const owner = await register("صاحب المتجر");
const staff = await register("موظف المتجر");
const stranger = await register("غريب");
const shop = await business(owner, "متجر الإلكترونيات");
const propose = (who: Actor, body: Record<string, unknown>, biz = shop) => request(`/businesses/${biz}/merchant-policies/proposals`, "POST", body, who.cookie);
const confirm = (who: Actor, policy: { id: string; version: number }) => request(`/merchant-policies/${policy.id}/confirm`, "POST", { expectedVersion: policy.version }, who.cookie);
const grant = (who: Actor, userId: string, scopes: string[]) => request(`/businesses/${shop}/merchant-policy-grants/${userId}`, "PUT", { scopes }, who.cookie);

test("MP-01 owner: a normal policy is proposed, confirmed, versioned and audited", async () => {
  const p = await propose(owner, { kind: "MIN_ORDER", rule: { minQuantity: 3 } });
  assert.equal(p.status, 201, p.raw);
  assert.deepEqual([p.data.policy.status, p.data.policy.version, p.data.policy.sensitivity, p.data.confirmation], ["PROPOSED", 1, "NORMAL", "CHAT_CONFIRM"]);
  assert.equal((await effectivePolicy(shop, "MIN_ORDER")), null, "a proposal is never enforced");
  const c = await confirm(owner, p.data.policy);
  assert.equal(c.status, 200, c.raw);
  assert.equal(c.data.status, "ACTIVE");
  const effective = await effectivePolicy(shop, "MIN_ORDER");
  assert.deepEqual([effective?.rule, effective?.provenance, effective?.version], [{ minQuantity: 3 }, "MERCHANT_POLICY", 1]);
  // A replacement keeps history; the same values twice is no change.
  assert.equal((await propose(owner, { kind: "MIN_ORDER", rule: { minQuantity: 3 } })).data.code, "NO_CHANGE");
  const p2 = await propose(owner, { kind: "MIN_ORDER", rule: { minQuantity: 5 } });
  assert.equal(p2.data.before.rule.minQuantity, 3);
  assert.equal(p2.data.policy.version, 2);
  await confirm(owner, p2.data.policy);
  const rows = await db.select().from(merchantPolicies).where(and(eq(merchantPolicies.businessId, shop), eq(merchantPolicies.kind, "MIN_ORDER")));
  assert.deepEqual(rows.map((r) => r.status).sort(), ["ACTIVE", "REPLACED"]);
  const history = await request(`/businesses/${shop}/merchant-policies/history`, "GET", undefined, owner.cookie);
  const events = history.data.events.filter((e: any) => rows.some((r) => r.id === e.policyId)).map((e: any) => e.event);
  assert.deepEqual(events, ["PROPOSED", "CONFIRMED", "PROPOSED", "REPLACED", "CONFIRMED"]);
  assert.ok(history.data.events.every((e: any) => e.actorId === owner.id));
  await assert.rejects(db.execute(sql`UPDATE merchant_policy_events SET event = 'x' WHERE business_id = ${shop}`), (e: any) => /append-only/.test(String(e?.cause?.message ?? e?.message)));
  await assert.rejects(db.insert(merchantPolicies).values({ ...rows.find((r) => r.status === "ACTIVE")!, id: randomUUID() }), "only one ACTIVE per kind and scope");
});

test("MP-02 permissions: explicit scopes only; financial scopes never implied; only the owner grants", async () => {
  assert.equal((await propose(stranger, { kind: "MIN_ORDER", rule: { minQuantity: 2 } })).status, 404, "a stranger learns nothing");
  assert.equal((await grant(staff, staff.id, ["policy.inventory"])).status, 404, "a non-member cannot grant");
  const g = await grant(owner, staff.id, ["policy.inventory", "policy.shipping", "policy.orders", "policy.products", "policy.discounts", "policy.negotiation", "policy.store_pause"]);
  assert.equal(g.status, 200, g.raw);
  const oos = await propose(staff, { kind: "OUT_OF_STOCK", rule: { action: "TELL_AND_CAPTURE_INTEREST", message: "سيعود قريبًا", promiseDate: null } });
  assert.equal(oos.status, 201, oos.raw);
  for (const kind of ["PAYMENT_METHODS", "PAYMENT_GATEWAY", "PAYOUT_DETAILS"]) {
    const rule = kind === "PAYMENT_METHODS" ? { methods: [{ code: "CLIQ" }], keepStoreGateway: true } : kind === "PAYMENT_GATEWAY" ? { enabled: true } : { method: "CLIQ", alias: "SHOP" };
    const refused = await propose(staff, { kind, rule });
    assert.deepEqual([refused.status, refused.data.code], [403, "PERMISSION_REQUIRED"], `${kind} needs its own explicit scope`);
  }
  assert.equal((await grant(staff, stranger.id, ["policy.inventory"])).data.code, "OWNER_ONLY", "a delegate cannot delegate");
  assert.equal((await request(`/businesses/${shop}/merchant-policies/history`, "GET", undefined, staff.cookie)).status, 403, "history needs owner or financial-data scope");
  assert.equal((await request(`/businesses/${shop}/merchant-policy-grants/${staff.id}`, "PUT", { scopes: ["policy.admin"] }, owner.cookie)).status, 400, "no invented scopes");
  assert.equal((await grant(owner, randomUUID(), ["policy.inventory"])).data.code, "USER_NOT_FOUND");
  const ownerProposal = await propose(owner, { kind: "PAYMENT_GATEWAY", rule: { enabled: false } });
  assert.equal((await request(`/merchant-policies/${ownerProposal.data.policy.id}/cancel`, "POST", {}, staff.cookie)).data.code, "PERMISSION_REQUIRED", "cancelling needs the kind's scope too");
  await request(`/merchant-policies/${ownerProposal.data.policy.id}/cancel`, "POST", {}, owner.cookie);
  // Revoking the grant removes access at once.
  assert.equal((await grant(owner, staff.id, [])).data.status, "REVOKED");
  assert.equal((await propose(staff, { kind: "MIN_ORDER", rule: { minQuantity: 9 } })).status, 404);
  await grant(owner, staff.id, ["policy.inventory", "policy.discounts", "policy.negotiation"]);
});

test("MP-03 sensitive: review card only, explicit version; stale confirmations refused", async () => {
  const p = await propose(staff, { kind: "DISCOUNT", rule: { percentBps: 1000 } });
  assert.equal(p.status, 201, p.raw);
  assert.equal(p.data.confirmation, "EXPLICIT_REVIEW");
  assert.ok(p.data.effects.some((e: string) => /الطلبات السابقة لا تتغير/.test(e)));
  await assert.rejects(confirmPolicy({ actorId: staff.id, policyId: p.data.policy.id, expectedVersion: p.data.policy.version, channel: "CHAT" }), (e: any) => e.code === "REVIEW_CONFIRMATION_REQUIRED");
  assert.equal((await confirm(staff, { id: p.data.policy.id, version: 99 })).data.code, "VERSION_CHANGED");
  assert.equal((await confirm(staff, p.data.policy)).data.status, "ACTIVE");
  assert.equal((await confirm(staff, p.data.policy)).data.code, "NOT_PROPOSED", "a confirmation runs once");
});

test("MP-04 high risk: payout details need a fresh sign-in; values are masked in the audit and for others", async () => {
  const p = await propose(owner, { kind: "PAYOUT_DETAILS", rule: { method: "BANK_TRANSFER", beneficiaryName: "متجر", iban: "JO71CBJO0000000000001234567890" } });
  assert.equal(p.data.confirmation, "EXPLICIT_REVIEW_AND_FRESH_SIGN_IN");
  assert.ok(!p.raw.includes("1234567890"), "the review card masks the IBAN");
  await db.update(sessions).set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(sessions.userId, owner.id));
  const stale = await confirm(owner, p.data.policy);
  assert.deepEqual([stale.status, stale.data.code], [401, "FRESH_SIGN_IN_REQUIRED"]);
  assert.doesNotMatch(stale.data.error, /كلمه المرور:|أدخل كلمة/);
  await db.update(sessions).set({ createdAt: new Date() }).where(eq(sessions.userId, owner.id));
  assert.equal((await confirm(owner, p.data.policy)).data.status, "ACTIVE");
  const events = await db.select().from(merchantPolicyEvents).where(eq(merchantPolicyEvents.policyId, p.data.policy.id));
  assert.ok(!JSON.stringify(events).includes("1234567890"), "audit never holds the IBAN in clear");
  const forOwner = await request(`/businesses/${shop}/merchant-policies`, "GET", undefined, owner.cookie);
  assert.equal(forOwner.data.policies.find((x: any) => x.kind === "PAYOUT_DETAILS").rule.iban, "JO71CBJO0000000000001234567890");
  const forStaff = await request(`/businesses/${shop}/merchant-policies`, "GET", undefined, staff.cookie);
  assert.match(forStaff.data.policies.find((x: any) => x.kind === "PAYOUT_DETAILS").rule.iban, /^•••/);
  const gateway = await propose(owner, { kind: "PAYMENT_GATEWAY", rule: { enabled: true, providerLabel: "بوابة المتجر" } });
  assert.ok(gateway.data.effects.some((e: string) => /لا يوجد تكامل بوابة مفعّل/.test(e)), "no gateway is switched on");
  await request(`/merchant-policies/${gateway.data.policy.id}/cancel`, "POST", {}, owner.cookie);
});

test("MP-05 conflicts are detected and block activation until clarified", async () => {
  const pre = await propose(owner, { kind: "PRE_ORDER", rule: { enabled: true } });
  await confirm(owner, pre.data.policy);
  const oos = await propose(owner, { kind: "OUT_OF_STOCK", rule: { action: "NOT_SOLD", message: "لا نبيعه", promiseDate: null } });
  assert.equal(oos.data.canConfirm, false);
  assert.equal(oos.data.conflicts[0].code, "NOT_SOLD_VS_PREORDER");
  const refused = await confirm(owner, oos.data.policy);
  assert.deepEqual([refused.status, refused.data.code], [409, "POLICY_CONFLICT"]);
  assert.equal(refused.data.detail.conflicts[0].code, "NOT_SOLD_VS_PREORDER");
  const neg = await propose(owner, { kind: "PRICE_NEGOTIATION", rule: { allowed: true, maxDiscountBps: 500 } });
  assert.equal(neg.data.conflicts[0].code, "NEGOTIATION_BELOW_ACTIVE_DISCOUNT", "an active 10% discount exceeds a 5% negotiation limit");
  const methods = await propose(owner, { kind: "PAYMENT_METHODS", rule: { methods: [{ code: "CLIQ" }], keepStoreGateway: true } });
  await confirm(owner, methods.data.policy);
  const cod = await propose(owner, { kind: "COD_AREAS", rule: { areas: ["عمان"] } });
  assert.equal(cod.data.conflicts[0].code, "COD_NOT_ACCEPTED");
});

test("MP-06 scopes and validation: specific overrides general; invalid rules ask for clarification", async () => {
  const store = await propose(owner, { kind: "SHIPPING", rule: { feeMinor: 3000 } });
  await confirm(owner, store.data.policy);
  const product = await propose(owner, { kind: "SHIPPING", scope: { kind: "PRODUCT", ref: "ext-phone-1" }, rule: { feeMinor: 0 } });
  await confirm(owner, product.data.policy);
  const region = await propose(owner, { kind: "SHIPPING", scope: { kind: "REGION", ref: "إربد" }, rule: { feeMinor: 5000 } });
  await confirm(owner, region.data.policy);
  assert.equal((await effectivePolicy(shop, "SHIPPING", { productId: "ext-phone-1" }))?.rule.feeMinor, 0);
  assert.equal((await effectivePolicy(shop, "SHIPPING", { region: "إربد" }))?.rule.feeMinor, 5000);
  assert.equal((await effectivePolicy(shop, "SHIPPING", { productId: "other" }))?.rule.feeMinor, 3000);
  assert.equal((await propose(owner, { kind: "PAYMENT_METHODS", scope: { kind: "PRODUCT", ref: "x" }, rule: { methods: [{ code: "CLIQ" }], keepStoreGateway: true } })).data.code, "SCOPE_NOT_ALLOWED");
  const invalid = await propose(owner, { kind: "PRICE_NEGOTIATION", rule: { allowed: true } });
  assert.deepEqual([invalid.status, invalid.data.code], [400, "RULE_INVALID"]);
  assert.ok(invalid.data.detail.issues.length);
  assert.equal((await propose(owner, { kind: "DISCOUNT", rule: { percentBps: 500, amountMinor: 1000 } })).data.code, "RULE_INVALID");
  assert.equal((await propose(owner, { kind: "NOT_A_KIND", rule: {} })).data.code, "UNKNOWN_POLICY_KIND");
  const revoke = await request(`/merchant-policies/${region.data.policy.id}/revoke`, "POST", { reason: "انتهى العرض" }, owner.cookie);
  assert.equal(revoke.data.status, "REVOKED");
  assert.equal((await effectivePolicy(shop, "SHIPPING", { region: "إربد" }))?.rule.feeMinor, 3000);
});

async function conversation(who: Actor) {
  const created = await request("/ai/conversations", "POST", {}, who.cookie);
  const conversationId = (created.data.conversation?.id ?? created.data.id) as string;
  return async (message: string) => {
    const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: who.cookie }, body: JSON.stringify({ message }) });
    const raw = await r.text();
    const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
    assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
    const payload = complete.assistantMessage.blocks[0]?.payload ?? {};
    return { body: complete.assistantMessage.body as string, review: payload.merchantPolicy, surface: payload.surface };
  };
}

test("MP-07 conversation: natural language becomes a typed proposal; confirmation follows its tier", async () => {
  const solo = await register("صاحب متجر صغير");
  await business(solo, "متجر صغير");
  const turn = await conversation(solo);
  const min = await turn("لا تقبل طلبات أقل من 3 قطع");
  assert.equal(min.surface, "MERCHANT_POLICY_REVIEW", min.body);
  assert.deepEqual([min.review.policy.kind, min.review.policy.rule], ["MIN_ORDER", { minQuantity: 3 }]);
  assert.match(min.body, /اكتب «نعم»/);
  const yes = await turn("نعم");
  assert.match(yes.body, /تم تفعيل سياسة «الحد الأدنى للطلب»/);
  const oos = await turn("إذا نفد الهاتف أخبرهم أنه سيعود قريبًا وخذ أرقامهم");
  assert.deepEqual(oos.review.policy.rule, { action: "TELL_AND_CAPTURE_INTEREST", message: "غير متوفر حاليًا، ومن المتوقع أن يعود لاحقًا.", promiseDate: null });
  assert.match(oos.body, /لن يَعِد جاسم بموعد/);
  await turn("نعم");
  const discount = await turn("خصم 10% على كل المنتجات");
  assert.equal(discount.review.confirmation, "EXPLICIT_REVIEW");
  const chatYes = await turn("نعم");
  assert.match(chatYes.body, /أكّده من زر «تأكيد» في بطاقة المراجعة/);
  const unclear = await turn("التفاوض مسموح");
  assert.match(unclear.body, /ما أقصى خصم/);
  const pause = await turn("أوقف استقبال الطلبات");
  assert.equal(pause.review.policy.kind, "ORDERING_PAUSED");
  assert.equal(pause.review.policy.sensitivity, "SENSITIVE");
  const cancelled = await turn("إلغاء");
  assert.match(cancelled.body, /ألغيت الاقتراح/);
  // Someone with no business is not claimed by this turn.
  const plain = await conversation(stranger);
  const other = await plain("لا تقبل طلبات أقل من 3 قطع");
  assert.notEqual(other.surface, "MERCHANT_POLICY_REVIEW");
});
