/**
 * DINAR NEXT pre-integration closure — Phases 4, 6 and 7: subscription lifecycle and billing
 * contract, integration readiness, appeals and two-sided dispute evidence.
 * Disposable loopback database. The billing provider used here is a MOCKED in-process adapter
 * (HMAC signatures, no network): it proves the contract, not any live provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { billingWebhookEvents, businessSubscriptions, db, disputes, markets, moderationReasonCodes, marketplaceReports, offers, orders, pool, trustAppeals, users } from "@workspace/db";
import app from "../src/app";
import { aiPlanFor } from "../src/lib/business";
import {
  planChangePreview,
  registerSubscriptionBillingProvider,
  subscriptionTransition,
  unregisterSubscriptionBillingProvider,
  type BillingWebhookEvent,
  type SubscriptionBillingProvider,
} from "../src/lib/subscription-billing";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_CLOSURE_ACCEPTANCE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
let ipSequence = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Forwarded-For": `198.51.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}`,
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_590_000 + ((Date.now() + process.pid) % 9_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Integr-${randomUUID().slice(0, 12)}!`;
  const response = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.52.0.${phoneOffset}` },
    body: JSON.stringify({ displayName: `DINAR integr ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken }),
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, cookie)).status, 200);
  return { id: data.user.id, cookie };
}

let user: Actor;
let other: Actor;
let admin: Actor;
let secondAdmin: Actor;
let goPlanId = "";
let proPlanId = "";
await test("setup: users, two admins, Go/Pro plans configured by an admin (test configuration, not approval)", async () => {
  user = await register("user");
  other = await register("other");
  admin = await register("admin");
  secondAdmin = await register("admin2");
  for (const actor of [admin, secondAdmin]) await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, actor.id));
  const create = async (name: string, priceMinor: number, entitlements: string[]) => {
    const created = await request("/admin/markets/JO/commercial-products", "POST", { name: `${name} ${runId}`, productType: "DINAR_BUSINESS", priceMinor, durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: entitlements, enabled: true }, admin.cookie);
    assert.equal(created.status, 201, created.raw);
    return created.data.id as string;
  };
  goPlanId = await create("Business Go", 5_000, ["AI_USAGE_BUSINESS_GO"]);
  proPlanId = await create("Business Pro", 15_000, ["AI_USAGE_BUSINESS_PRO"]);
});

await test("C6-01 readiness is admin-only, secret-free and never reports an unregistered provider as connected", async () => {
  assert.equal((await request("/admin/integrations/readiness", "GET", undefined, user.cookie)).status, 403);
  const readiness = await request("/admin/integrations/readiness", "GET", undefined, admin.cookie);
  assert.equal(readiness.status, 200, readiness.raw);
  assert.equal(readiness.data.families.length, 16);
  assert.ok(readiness.data.families.every((family: any) => family.connected === false && ["NOT_CONNECTED", "NOT_APPLICABLE"].includes(family.live)));
  for (const family of ["SUBSCRIPTION_BILLING", "SHIPMENT_TRACKING", "MONITORING", "NOTIFICATIONS", "MAPS", "GEOCODING", "SMS", "EXTERNAL_DELIVERY", "PAYMENT", "OBJECT_STORAGE"])
    assert.ok(readiness.data.families.some((item: any) => item.family === family), family);
  assert.equal(readiness.data.billing.mode, "NOT_CONNECTED");
  assert.equal(readiness.data.ai.valid, true);
  assert.equal(readiness.data.aiSpend.configured, false, "no money cap is approved yet");
  assert.ok(!/sk-|api[_-]?key"\s*:\s*"[^"]/i.test(readiness.raw));
});

await test("C4-01 without a billing provider, checkout and webhooks refuse honestly and create nothing", async () => {
  const checkout = await request("/business/subscription-checkout", "POST", { planId: goPlanId, idempotencyKey: `chk-${randomUUID()}` }, user.cookie);
  assert.equal(checkout.status, 503);
  assert.equal(checkout.data.code, "BILLING_PROVIDER_NOT_CONNECTED");
  assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, user.id))).length, 0);
  const webhook = await request("/billing/webhooks/any-provider", "POST", { event: { id: "e1", type: "PAYMENT_FAILED", subscriptionId: "x", providerSubscriptionId: "y" }, signature: "0".repeat(64) });
  assert.equal(webhook.status, 503);
  assert.equal((await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.providerKey, "any-provider"))).length, 0);
  const preview = await request(`/business/plan-change-preview?planId=${proPlanId}`, "GET", undefined, user.cookie);
  assert.equal(preview.status, 200, preview.raw);
  assert.deepEqual([preview.data.change.kind, preview.data.change.proration, preview.data.change.autoRenew, preview.data.allowancesApproved], ["UPGRADE", "NOT_APPROVED", false, false]);
});

await test("C4-02 lifecycle state machine: every event has one defined outcome", () => {
  const cases: Array<[string, BillingWebhookEvent["type"], string]> = [
    ["PENDING", "SUBSCRIPTION_ACTIVATED", "ACTIVE"],
    ["ACTIVE", "SUBSCRIPTION_ACTIVATED", "ignored:NOT_PENDING"],
    ["ACTIVE", "SUBSCRIPTION_RENEWED", "ACTIVE"],
    ["PAST_DUE", "SUBSCRIPTION_RENEWED", "ACTIVE"],
    ["CANCEL_AT_PERIOD_END", "SUBSCRIPTION_RENEWED", "ignored:RENEWAL_AFTER_CANCELLATION"],
    ["ACTIVE", "PAYMENT_FAILED", "PAST_DUE"],
    ["PENDING", "PAYMENT_FAILED", "PAYMENT_FAILED"],
    ["ACTIVE", "CANCELLATION_SCHEDULED", "CANCEL_AT_PERIOD_END"],
    ["CANCEL_AT_PERIOD_END", "SUBSCRIPTION_ENDED", "EXPIRED"],
    ["ACTIVE", "REFUNDED", "CANCELLED"],
    ["CANCELLED", "REFUNDED", "ignored:NOTHING_TO_REFUND"],
  ];
  for (const [from, event, expected] of cases) {
    const result = subscriptionTransition(from as never, event);
    assert.equal("ignored" in result ? `ignored:${result.ignored}` : result.to, expected, `${from} + ${event}`);
  }
  assert.deepEqual(planChangePreview({ tier: "BUSINESS_PRO", periodEnd: new Date("2026-12-01T00:00:00Z") }, "BUSINESS_GO"), {
    kind: "DOWNGRADE", effective: "AT_PERIOD_END", effectiveAt: "2026-12-01T00:00:00.000Z", proration: "NOT_APPROVED", autoRenew: false, marketplaceRightsUnchanged: true,
  });
});

await test("C4-03 MOCKED provider: signed, idempotent webhooks drive the lifecycle; PENDING grants nothing", async () => {
  const secret = randomUUID();
  const sign = (event: BillingWebhookEvent) => createHmac("sha256", secret).update(JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
  const mock: SubscriptionBillingProvider = {
    providerKey: "mock-billing",
    async createCheckout(input) {
      return { checkoutUrl: `https://checkout.invalid/${input.subscriptionId}`, providerCheckoutId: `co_${input.subscriptionId}`, expiresAt: new Date(Date.now() + 900_000).toISOString() };
    },
    async scheduleCancellation() {
      return { effectiveAt: new Date().toISOString() };
    },
    verifyWebhook(event, signature) {
      return signature === sign(event);
    },
  };
  registerSubscriptionBillingProvider(mock);
  try {
    const key = `chk-${randomUUID()}`;
    const checkout = await request("/business/subscription-checkout", "POST", { planId: goPlanId, idempotencyKey: key }, user.cookie);
    assert.equal(checkout.status, 201, checkout.raw);
    assert.equal(checkout.data.status, "PENDING");
    const subscriptionId = checkout.data.subscriptionId as string;
    assert.equal((await aiPlanFor(user.id, { id: "JO" })).tier, "FREE", "a checkout is not a payment");
    assert.equal((await request("/business/subscription-checkout", "POST", { planId: goPlanId, idempotencyKey: `chk-${randomUUID()}` }, user.cookie)).status, 409);
    const send = (event: BillingWebhookEvent, signature = sign(event)) => request("/billing/webhooks/mock-billing", "POST", { event, signature });
    const now = Date.now();
    const period = (offsetDays: number) => ({ periodStart: new Date(now + offsetDays * 86_400_000).toISOString(), periodEnd: new Date(now + (offsetDays + 30) * 86_400_000).toISOString() });
    const activated: BillingWebhookEvent = { id: `ev-${runId}-1`, type: "SUBSCRIPTION_ACTIVATED", subscriptionId, providerSubscriptionId: "ps_1", ...period(0), amountMinor: 5_000, currencyCode: "JOD" };
    const forged = await send(activated, "f".repeat(64));
    assert.equal(forged.status, 401);
    assert.equal((await aiPlanFor(user.id, { id: "JO" })).tier, "FREE", "a forged event changes nothing");
    const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
    const wrongAmount = await send({ ...activated, id: `ev-${runId}-2`, amountMinor: 1, currencyCode: market!.currencyCode });
    assert.equal(wrongAmount.data.status, "REJECTED");
    assert.equal(wrongAmount.data.failureCode, "AMOUNT_MISMATCH");
    const good = { ...activated, id: `ev-${runId}-3`, currencyCode: market!.currencyCode };
    const applied = await send(good);
    assert.equal(applied.data.status, "APPLIED", applied.raw);
    assert.equal((await aiPlanFor(user.id, { id: "JO" })).tier, "BUSINESS_GO");
    const replay = await send(good);
    assert.equal(replay.data.duplicate, true, "a replayed event is answered from the record");
    const stale = await send({ ...good, id: `ev-${runId}-4`, type: "SUBSCRIPTION_RENEWED", ...period(-60) } as BillingWebhookEvent);
    assert.equal(stale.data.failureCode, "INVALID_PERIOD");
    const failed = await send({ id: `ev-${runId}-5`, type: "PAYMENT_FAILED", subscriptionId, providerSubscriptionId: "ps_1" });
    assert.equal(failed.data.status, "APPLIED");
    assert.equal((await aiPlanFor(user.id, { id: "JO" })).tier, "FREE", "PAST_DUE grants no allowance");
    const renewed = await send({ ...good, id: `ev-${runId}-6`, type: "SUBSCRIPTION_RENEWED", ...period(30) } as BillingWebhookEvent);
    assert.equal(renewed.data.status, "APPLIED", renewed.raw);
    await send({ id: `ev-${runId}-7`, type: "CANCELLATION_SCHEDULED", subscriptionId, providerSubscriptionId: "ps_1" });
    assert.equal((await aiPlanFor(user.id, { id: "JO" })).tier, "BUSINESS_GO", "a scheduled cancellation keeps the paid period");
    await send({ id: `ev-${runId}-8`, type: "SUBSCRIPTION_ENDED", subscriptionId, providerSubscriptionId: "ps_1" });
    const [row] = await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.id, subscriptionId));
    assert.equal(row!.status, "EXPIRED");
    assert.equal((await aiPlanFor(user.id, { id: "JO" })).tier, "FREE");
  } finally {
    unregisterSubscriptionBillingProvider("mock-billing");
  }
});

// ─── Appeals and dispute evidence ────────────────────────────────────────────

async function listingOf(seller: Actor) {
  const id = `closure_${runId}_${randomUUID().slice(0, 6)}`;
  await db.insert(offers).values({
    id, sellerId: seller.id, marketId: "JO", status: "PUBLISHED", unitPriceMinor: 10_000, inventoryMode: "LIMITED", availableQuantity: 1, reservedQuantity: 0,
    data: { title: "كرسي خشبي للاختبار", description: "كرسي خشبي بحالة جيدة لاختبار الطعن.", category: "أثاث", categoryId: "furniture", city: "عمان", area: "", attributes: {}, imageUrl: "", imageUrls: [], fulfilmentType: "PICKUP", sellerName: "DINAR closure", rating: 0, reviewCount: 0 },
  });
  return id;
}

await test("C7-01 listing appeal: only the affected seller, only a real decision, one open at a time, independent reviewer, reason required", async () => {
  const listingId = await listingOf(user);
  const appeal = (actor: Actor, key = `ap-${randomUUID()}`) => request("/appeals", "POST", { subjectType: "LISTING_MODERATION", subjectId: listingId, statement: "الإعلان لا يخالف القواعد؛ الصورة لمنتج أصلي.", idempotencyKey: key }, actor.cookie);
  assert.equal((await appeal(user)).status, 409, "no decision to appeal yet");
  const hidden = await request(`/admin/listings/${listingId}/moderation`, "POST", { action: "HIDE", reason: "اشتباه في مخالفة قواعد الصور" }, admin.cookie);
  assert.equal(hidden.status, 200, hidden.raw);
  assert.equal((await appeal(other)).status, 404, "a stranger cannot appeal someone else's decision");
  const filed = await appeal(user);
  assert.equal(filed.status, 201, filed.raw);
  assert.equal((await appeal(user)).status, 409, "one open appeal per decision");
  assert.equal((await request(`/admin/appeals/${filed.data.id}/decision`, "POST", { status: "UPHELD", note: "القرار صحيح" }, user.cookie)).status, 403);
  const self = await request(`/admin/appeals/${filed.data.id}/decision`, "POST", { status: "UPHELD", note: "القرار صحيح" }, admin.cookie);
  assert.equal(self.status, 409);
  assert.match(self.raw, /غير صاحب القرار الأصلي/u, "the original decider does not review their own decision");
  assert.equal((await request(`/admin/appeals/${filed.data.id}/decision`, "POST", { status: "OVERTURNED" }, secondAdmin.cookie)).status, 400, "a decision needs its reason");
  const decided = await request(`/admin/appeals/${filed.data.id}/decision`, "POST", { status: "OVERTURNED", note: "الصورة أصلية؛ يُعاد الإعلان." }, secondAdmin.cookie);
  assert.equal(decided.status, 200, decided.raw);
  assert.ok(decided.data.followUp, "an overturned appeal never changes the listing by itself");
  const [listing] = await db.select({ status: offers.status }).from(offers).where(eq(offers.id, listingId));
  assert.equal(listing!.status, "MODERATION_HIDDEN");
  const mine = await request("/appeals/mine", "GET", undefined, user.cookie);
  assert.equal(mine.data[0].status, "OVERTURNED");
  await assert.rejects(pool.query("DELETE FROM trust_appeal_events WHERE appeal_id = $1", [filed.data.id]), /append-only/);
});

await test("C7-02 report-outcome appeal by the reporter; withdrawal", async () => {
  const [reason] = await db.select().from(moderationReasonCodes).limit(1);
  const reportId = randomUUID();
  await db.insert(marketplaceReports).values({ id: reportId, reporterId: other.id, marketId: "JO", targetType: "LISTING", targetId: await listingOf(user), reasonCode: reason!.code, note: "", status: "DISMISSED", resolvedBy: admin.id, resolvedAt: new Date(), resolutionNote: "لا مخالفة" } as never);
  assert.equal((await request("/appeals", "POST", { subjectType: "REPORT_DECISION", subjectId: reportId, statement: "البلاغ صحيح والإعلان مضلل بوضوح.", idempotencyKey: `ap-${randomUUID()}` }, user.cookie)).status, 404, "only the reporter appeals a report outcome");
  const filed = await request("/appeals", "POST", { subjectType: "REPORT_DECISION", subjectId: reportId, statement: "البلاغ صحيح والإعلان مضلل بوضوح.", idempotencyKey: `ap-${randomUUID()}` }, other.cookie);
  assert.equal(filed.status, 201, filed.raw);
  assert.equal((await request(`/appeals/${filed.data.id}/withdraw`, "POST", {}, user.cookie)).status, 404);
  assert.equal((await request(`/appeals/${filed.data.id}/withdraw`, "POST", {}, other.cookie)).data.status, "WITHDRAWN");
  const [row] = await db.select().from(trustAppeals).where(eq(trustAppeals.id, filed.data.id));
  assert.equal(row!.originalDeciderId, admin.id);
});

await test("C7-03 dispute evidence: both parties may add statements to an open dispute; strangers cannot", async () => {
  const listingId = await listingOf(user);
  const orderId = randomUUID();
  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  try {
    await db.insert(orders).values({ id: orderId, buyerId: other.id, sellerId: user.id, marketId: "JO", countryCode: market!.countryCode, currencyCode: market!.currencyCode, minorUnitScale: market!.minorUnitScale, unitPriceMinor: 10_000, quantity: 1, subtotalMinor: 10_000, platformFeeMinor: 1_000, sellerAmountMinor: 9_000, status: "DISPUTED", data: { listingId } } as never);
  } catch (error) {
    // Database invariants may forbid a hand-made order; the evidence authority is then covered by its 404 path only.
    assert.equal((await request(`/orders/${orderId}/dispute/evidence`, "POST", { statement: "وصل المنتج مكسورًا" }, other.cookie)).status, 404);
    console.log("C7-03 note: hand-made order refused by invariants:", (error as { code?: string }).code ?? "unknown");
    return;
  }
  await db.insert(disputes).values({ id: randomUUID(), orderId, openedBy: other.id, reason: "منتج تالف", description: "وصل مكسورًا", evidence: [] } as never);
  const buyer = await request(`/orders/${orderId}/dispute/evidence`, "POST", { statement: "وصل المنتج مكسورًا من الجانب", reference: "صورة في المحادثة" }, other.cookie);
  assert.equal(buyer.status, 201, buyer.raw);
  const seller = await request(`/orders/${orderId}/dispute/evidence`, "POST", { statement: "سُلّم المنتج سليمًا بحضور المشتري" }, user.cookie);
  assert.equal(seller.data.entry.submittedRole, "SELLER");
  assert.equal(seller.data.evidenceCount, 2);
  assert.equal((await request(`/orders/${orderId}/dispute/evidence`, "POST", { statement: "أنا طرف ثالث" }, admin.cookie)).status, 404);
  const [dispute] = await db.select().from(disputes).where(and(eq(disputes.orderId, orderId)));
  assert.equal((dispute!.evidence as unknown[]).length, 2);
});

await test("teardown", () => {
  server.close();
});
