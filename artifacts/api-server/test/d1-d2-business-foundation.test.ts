/**
 * D1 + D2 acceptance — three-tier subscription foundation and DINAR Business identity.
 * Disposable loopback database, loopback S3-compatible storage, no network, no model calls.
 * The billing provider and the document scanner used here are MOCKED in-process adapters
 * (HMAC signatures; a byte-pattern "scanner"): they prove the contracts, not any live provider.
 *
 *  D1-01..12  subscription acceptance (free core, eligibility, escalation, prices, snapshots,
 *             pending, forged / duplicate webhooks, isolation, AI guardrails, organic ranking)
 *  D2-01..15  business acceptance (dialect intent, drafts, ownership, masquerade, review authority,
 *             private documents, isolation, market scope, retries, suspension, fake checkout,
 *             no self-granted plan, card rehydration)
 *  J-01       the shared 13-step journey
 */
import { localObjectStorage } from "./local-object-storage";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  billingWebhookEvents,
  businessMemberships,
  businessProfiles,
  businessSubscriptions,
  businessVerificationDocuments,
  businessVerificationEvents,
  commercialPolicies,
  db,
  marketAudit,
  offers,
  pool,
  promotionProducts,
  users,
} from "@workspace/db";
import app from "../src/app";
import { aiPlanFor, businessEntitlements } from "../src/lib/business";
import {
  registerSubscriptionBillingProvider,
  unregisterSubscriptionBillingProvider,
  type BillingWebhookEvent,
  type SubscriptionBillingProvider,
} from "../src/lib/subscription-billing";
import { registerBusinessDocumentScanner, unregisterBusinessDocumentScanner, validateIntegrationEndpoint } from "../src/lib/business-profiles";
import { businessIntent, businessNameFrom, isPossibleBusinessMessage } from "../src/ai/business-intent";
import { authorizeBusinessAction, BUSINESS_CATALOG_CONTRACT_VERSION, BUSINESS_LIFECYCLE, businessIdentity, businessListingAssociation, businessPermission, businessPlanStatus, publicationEligibility } from "../src/lib/business-catalog-contract";
import { searchMarketplaceListings } from "../src/lib/marketplace-listings";
import { marketFor } from "../src/lib/markets";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_D1D2_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const origin = base.replace(/\/api$/, "");
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
  return { status: response.status, data, raw, headers: response.headers };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_690_000 + ((Date.now() + process.pid) % 9_000);
let phoneOffset = 0;
async function register(label: string, marketId = "KW"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `D1d2-${randomUUID().slice(0, 12)}!`;
  const response = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.53.0.${phoneOffset}` },
    body: JSON.stringify({ displayName: `DINAR d12 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken }),
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal((await request("/account/market", "PATCH", { marketId }, cookie)).status, 200);
  return { id: data.user.id, cookie };
}
async function conversation(actor: Actor) {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.ok([200, 201].includes(created.status), created.raw);
  return (created.data.conversation?.id ?? created.data.id) as string;
}
async function turn(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie, "X-Forwarded-For": `198.54.0.${(ipSequence++ % 250) + 1}` },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const events = raw.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  const complete = events.find((event) => event.type === "complete");
  assert.ok(complete, raw);
  const blocks = (complete.assistantMessage.blocks ?? []) as any[];
  const body = String(complete.assistantMessage.body ?? "");
  const block = blocks.find((item) => item.payload?.surface) ?? blocks[0];
  return { payload: { ...(block?.payload ?? {}), prompt: body }, blocks, raw, text: body };
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n% DINAR test commercial registration\n"), Buffer.alloc(512, 0x20), Buffer.from("\n%%EOF\n")]);
const INFECTED_PDF = Buffer.concat([PDF, Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");

async function uploadDocument(actor: Actor, businessId: string, bytes: Buffer, contentType = "application/pdf", kind = "COMMERCIAL_REGISTRATION", declaredSize = bytes.length) {
  const ticket = await request(`/business/profiles/${businessId}/documents/upload-url`, "POST", { kind, contentType, size: declaredSize, idempotencyKey: `doc-${randomUUID()}` }, actor.cookie);
  if (ticket.status !== 200) return { ticket, complete: undefined };
  const put = await fetch(ticket.data.uploadURL, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  assert.ok(put.ok, `upload PUT ${put.status}`);
  const complete = await request(`/business/profiles/${businessId}/documents/${ticket.data.documentId}/complete`, "POST", {}, actor.cookie);
  return { ticket, complete };
}

// Mocked billing provider (HMAC over the canonical event).
const billingSecret = randomUUID();
const sign = (event: BillingWebhookEvent) => createHmac("sha256", billingSecret).update(JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
const mockBilling: SubscriptionBillingProvider = {
  providerKey: "mock-d12",
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
const webhook = (event: BillingWebhookEvent, signature = sign(event)) => request("/billing/webhooks/mock-d12", "POST", { event, signature });
const period = (offsetDays = 0) => ({ periodStart: new Date(Date.now() + offsetDays * 86_400_000).toISOString(), periodEnd: new Date(Date.now() + (offsetDays + 30) * 86_400_000).toISOString() });
let eventSeq = 0;
const eventId = () => `ev-${runId}-${++eventSeq}`;

// Mocked scanner: EICAR marker → INFECTED, anything else CLEAN.
const mockScanner = { scannerKey: "mock-scanner", async scan({ bytes }: { bytes: Buffer }) { return bytes.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) ? ("INFECTED" as const) : ("CLEAN" as const); } };

let owner: Actor;
let other: Actor;
let reviewer: Actor;
let catalogAdmin: Actor;
let joUser: Actor;
const plan: Record<"GO" | "PRO" | "BUSINESS", string> = { GO: "", PRO: "", BUSINESS: "" };
const kw = { id: "KW" };

async function newBusiness(actor: Actor, name: string, extra: Record<string, unknown> = {}) {
  const created = await request("/business/profiles", "POST", { displayName: name, categoryKey: "GRILL_RESTAURANT", idempotencyKey: `biz-${randomUUID()}`, ...extra }, actor.cookie);
  assert.ok([200, 201].includes(created.status), created.raw);
  return created.data.business;
}
async function readyForReview(actor: Actor, name: string, registrationNumber = `${Math.floor(Math.random() * 1e9)}`) {
  let business = await newBusiness(actor, name);
  business = (await request(`/business/profiles/${business.id}`, "PATCH", { expectedRevision: business.revision, legalName: `${name} للتجارة`, legalForm: "SOLE_PROPRIETORSHIP", registrationNumber, address: { city: "الكويت" } }, actor.cookie)).data;
  assert.equal((await request(`/business/profiles/${business.id}/start-verification`, "POST", {}, actor.cookie)).status, 200);
  const upload = await uploadDocument(actor, business.id, PDF, "application/pdf", "COMMERCIAL_LICENSE");
  assert.equal(upload.complete?.status, 200, upload.complete?.raw);
  const submitted = await request(`/business/profiles/${business.id}/submit`, "POST", {}, actor.cookie);
  assert.equal(submitted.status, 200, submitted.raw);
  return submitted.data;
}
async function decide(businessId: string, decision: string, reason?: string, actor = reviewer) {
  const current = await request(`/admin/business-verification/${businessId}`, "GET", undefined, actor.cookie);
  return request(`/admin/business-verification/${businessId}/decision`, "POST", { decision, expectedRevision: current.data?.revision ?? 1, ...(reason ? { reason } : {}) }, actor.cookie);
}

await test("setup: accounts, two admins, Go / Pro / Business catalog products in KW (test configuration, not approval)", async () => {
  owner = await register("owner");
  other = await register("other");
  reviewer = await register("reviewer");
  catalogAdmin = await register("catalog");
  joUser = await register("jo", "JO");
  for (const actor of [reviewer, catalogAdmin]) await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, actor.id));
  await db.update(promotionProducts).set({ enabled: false }).where(and(eq(promotionProducts.marketId, "KW"), eq(promotionProducts.productType, "DINAR_BUSINESS")));
  const create = async (name: string, planCode: string, priceMinor: number, entitlements: string[]) => {
    const created = await request("/admin/markets/KW/commercial-products", "POST", { name: `${name} ${runId}`, productType: "DINAR_BUSINESS", planCode, priceMinor, durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: entitlements, enabled: true }, catalogAdmin.cookie);
    assert.equal(created.status, 201, created.raw);
    return created.data.id as string;
  };
  plan.GO = await create("DINAR Go", "DINAR_GO", 3_000, ["AI_USAGE_BUSINESS_GO"]);
  plan.PRO = await create("DINAR Pro", "DINAR_PRO", 6_000, ["AI_USAGE_BUSINESS_PRO", "MARKET_PULSE_ADVANCED"]);
  plan.BUSINESS = await create("DINAR Business", "DINAR_BUSINESS", 15_000, ["BUSINESS_PROFILE_TOOLS", "BUSINESS_REPORTING", "INVENTORY_INSIGHTS"]);
});

// ─── D1 ──────────────────────────────────────────────────────────────────────

await test("D1-01 a free account keeps its core capabilities and sees the three plans with server prices", async () => {
  const overview = await request("/subscriptions/plans", "GET", undefined, owner.cookie);
  assert.equal(overview.status, 200, overview.raw);
  assert.equal(overview.data.currentPlan, "FREE");
  assert.ok(overview.data.free.allowances.find((item: any) => item.key === "TEXT_REQUEST").value > 0, "free keeps assistant usage");
  assert.deepEqual(overview.data.plans.map((item: any) => item.planCode), ["DINAR_GO", "DINAR_PRO", "DINAR_BUSINESS"]);
  assert.deepEqual(overview.data.plans.map((item: any) => item.referencePriceLabel.split(" ")[0]), ["10", "20", "49"]);
  assert.ok(overview.data.plans.every((item: any) => item.marketPrice && /KWD|د\.ك|دينار/u.test(item.marketPrice.label)), "market prices are the KW catalog's own");
  assert.equal(overview.data.billing.status, "NOT_CONNECTED");
  assert.equal(overview.data.approvals.plansApproved, false);
  // Marketplace participation never needs a plan: a free account searches and publishes as before.
  const id = await conversation(owner);
  const search = await turn(owner, id, "ابحث عن هاتف");
  assert.ok(!/اشترك|subscription required/u.test(search.text ?? ""), "search is not gated");
});

await test("D1-02 Go and Pro need no business and no documents", async () => {
  const overview = (await request("/subscriptions/plans", "GET", undefined, other.cookie)).data;
  const go = overview.plans.find((item: any) => item.planCode === "DINAR_GO");
  const pro = overview.plans.find((item: any) => item.planCode === "DINAR_PRO");
  assert.equal(go.requiresDocuments, false);
  assert.equal(pro.requiresVerifiedBusiness, false);
  assert.equal(go.eligible && pro.eligible, true);
  const review = await request("/business/subscription-review", "POST", { planId: plan.PRO }, other.cookie);
  assert.equal(review.status, 200, review.raw);
  assert.equal((await db.select().from(businessProfiles).where(eq(businessProfiles.ownerUserId, other.id))).length, 0);
});

await test("D1-03 business-only entitlements cannot be self-granted or mis-configured", async () => {
  const goWithBusiness = await request("/admin/markets/KW/commercial-products", "POST", { name: `bad ${runId}`, productType: "DINAR_BUSINESS", planCode: "DINAR_GO", priceMinor: 1_000, durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: ["AI_USAGE_BUSINESS_GO", "BUSINESS_PROFILE_TOOLS"], enabled: false }, catalogAdmin.cookie);
  assert.equal(goWithBusiness.status, 400);
  assert.equal(goWithBusiness.data.code, "PLAN_ENTITLEMENTS_INVALID");
  const legacyWithBusiness = await request("/admin/markets/KW/commercial-products", "POST", { name: `bad2 ${runId}`, productType: "DINAR_BUSINESS", priceMinor: 1_000, durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: ["BUSINESS_PROFILE_TOOLS"], enabled: false }, catalogAdmin.cookie);
  assert.equal(legacyWithBusiness.status, 400);
  // Without a verified business, every Business purchase path refuses.
  const review = await request("/business/subscription-review", "POST", { planId: plan.BUSINESS }, other.cookie);
  assert.equal(review.status, 409);
  assert.equal(review.data.code, "BUSINESS_REQUIRED");
  const simulated = await request("/business/subscriptions", "POST", { planId: plan.BUSINESS, idempotencyKey: `sub-${randomUUID()}` }, other.cookie);
  assert.equal(simulated.status, 409);
  registerSubscriptionBillingProvider(mockBilling);
  try {
    const checkout = await request("/business/subscription-checkout", "POST", { planId: plan.BUSINESS, idempotencyKey: `chk-${randomUUID()}` }, other.cookie);
    assert.equal(checkout.status, 409);
    const draft = await newBusiness(other, `مطبخ ${runId}`);
    const withDraft = await request("/business/subscription-checkout", "POST", { planId: plan.BUSINESS, idempotencyKey: `chk-${randomUUID()}`, businessId: draft.id }, other.cookie);
    assert.equal(withDraft.status, 409);
    assert.equal(withDraft.data.code, "BUSINESS_NOT_VERIFIED");
  } finally {
    unregisterSubscriptionBillingProvider("mock-d12");
  }
  assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, other.id))).length, 0);
  // Even a row written behind the server's back (as if a provider activated it) grants nothing
  // while its business is not verified.
  const [draft] = await db.select().from(businessProfiles).where(eq(businessProfiles.ownerUserId, other.id));
  const now = new Date();
  await db.insert(businessSubscriptions).values({ id: randomUUID(), userId: other.id, marketId: "KW", planId: plan.BUSINESS, planNameSnapshot: "x", priceMinorSnapshot: 15_000, currencyCodeSnapshot: "KWD", periodDaysSnapshot: 30, pricingVersionSnapshot: 1, entitlementsSnapshot: ["BUSINESS_PROFILE_TOOLS", "BUSINESS_REPORTING"], planCodeSnapshot: "DINAR_BUSINESS", businessProfileId: draft!.id, status: "ACTIVE", idempotencyKey: `forced-${randomUUID()}`, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 86_400_000) });
  assert.equal((await businessEntitlements(other.id, kw)).size, 0, "an unverified business's subscription grants nothing");
  await db.delete(businessSubscriptions).where(eq(businessSubscriptions.userId, other.id));
  // A Go subscription that somehow carries a business-only key never grants it.
  await assert.rejects(() => db.insert(businessSubscriptions).values({ id: randomUUID(), userId: other.id, marketId: "KW", planId: plan.GO, planNameSnapshot: "x", priceMinorSnapshot: 3_000, currencyCodeSnapshot: "KWD", periodDaysSnapshot: 30, pricingVersionSnapshot: 1, entitlementsSnapshot: [], planCodeSnapshot: "DINAR_GO", businessProfileId: draft!.id, status: "PENDING", idempotencyKey: `forced-${randomUUID()}` }), "a Go subscription cannot name a business (DB CHECK)");
  const goRow = { id: randomUUID(), userId: other.id, marketId: "KW", planId: plan.GO, planNameSnapshot: "x", priceMinorSnapshot: 3_000, currencyCodeSnapshot: "KWD", periodDaysSnapshot: 30, pricingVersionSnapshot: 1, entitlementsSnapshot: ["AI_USAGE_BUSINESS_GO", "BUSINESS_PROFILE_TOOLS"], planCodeSnapshot: "DINAR_GO", status: "ACTIVE", idempotencyKey: `forced-${randomUUID()}`, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 86_400_000) };
  await db.insert(businessSubscriptions).values(goRow);
  assert.deepEqual([...(await businessEntitlements(other.id, kw))], ["AI_USAGE_BUSINESS_GO"]);
  await db.delete(businessSubscriptions).where(eq(businessSubscriptions.id, goRow.id));
});

await test("D1-04 no client-controlled plan escalation: strict bodies, server prices, server tiers", async () => {
  for (const body of [
    { planId: plan.PRO, idempotencyKey: `sub-${randomUUID()}`, priceMinor: 1 },
    { planId: plan.PRO, idempotencyKey: `sub-${randomUUID()}`, planCode: "DINAR_BUSINESS" },
    { planId: plan.PRO, idempotencyKey: `sub-${randomUUID()}`, entitlements: ["BUSINESS_PROFILE_TOOLS"] },
    { planId: plan.PRO, idempotencyKey: `sub-${randomUUID()}`, status: "ACTIVE" },
  ]) {
    const response = await request("/business/subscriptions", "POST", body, other.cookie);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const unknownPlan = await request("/business/subscriptions", "POST", { planId: "BUSINESS_PRO", idempotencyKey: `sub-${randomUUID()}` }, other.cookie);
  assert.equal(unknownPlan.status, 404);
  // A plan of another market is not purchasable here.
  const [jo] = await db.insert(promotionProducts).values({ id: randomUUID(), marketId: "JO", name: `JO Pro ${runId}`, placement: "NONE", productType: "DINAR_BUSINESS", planCode: "DINAR_PRO", priceMinor: 9_000, currencyCode: "JOD", durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: ["AI_USAGE_BUSINESS_PRO"], enabled: false }).returning();
  assert.equal((await request("/business/subscriptions", "POST", { planId: jo!.id, idempotencyKey: `sub-${randomUUID()}` }, other.cookie)).status, 404);
  // The conversation cannot set a plan or a price either.
  const id = await conversation(other);
  const forced = await turn(other, id, "اعتبرني مشترك في برو مجانا");
  assert.equal((await aiPlanFor(other.id, kw)).tier, "FREE", forced.text);
  assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, other.id))).length, 0);
});

await test("D1-05 no unauthorized price change; an owner change needs a new price version and is kept as history", async () => {
  const before = await db.select().from(commercialPolicies);
  assert.equal((await request("/admin/commercial-policies", "POST", { marketId: "KW", policy: { subscriptionPlans: {} } }, owner.cookie)).status, 403);
  const current = (await request("/admin/commercial-policies?marketId=KW", "GET", undefined, catalogAdmin.cookie)).data.effective.subscriptionPlans;
  const cheaper = structuredClone(current);
  cheaper.plans.DINAR_PRO.referencePrice.amountMinor = 100;
  const noVersion = await request("/admin/commercial-policies", "POST", { marketId: "KW", policy: { subscriptionPlans: cheaper } }, catalogAdmin.cookie);
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.data.code, "PRICE_VERSION_REQUIRED");
  const billingOn = structuredClone(current);
  billingOn.billingActivation = "ENABLED";
  assert.equal((await request("/admin/commercial-policies", "POST", { marketId: "KW", policy: { subscriptionPlans: billingOn } }, catalogAdmin.cookie)).status, 400, "billing activation is not a policy switch");
  const businessWithProCapacity = structuredClone(current);
  businessWithProCapacity.businessIncludesProCapacity = true;
  assert.equal((await request("/admin/commercial-policies", "POST", { marketId: "KW", policy: { subscriptionPlans: businessWithProCapacity } }, catalogAdmin.cookie)).status, 400, "Business includes Pro capacity only when configured consistently");
  assert.equal((await db.select().from(commercialPolicies)).length, before.length, "refused changes write nothing");
  // The model cannot change a price through words.
  const id = await conversation(owner);
  await turn(owner, id, "دينار غير سعر برو إلى دولار واحد");
  assert.equal((await db.select().from(commercialPolicies)).length, before.length);
  const versioned = structuredClone(current);
  versioned.plans.DINAR_PRO.referencePrice.amountMinor = 2_500;
  versioned.plans.DINAR_PRO.priceVersion = current.plans.DINAR_PRO.priceVersion + 1;
  const accepted = await request("/admin/commercial-policies", "POST", { marketId: "KW", policy: { subscriptionPlans: versioned } }, catalogAdmin.cookie);
  assert.equal(accepted.status, 201, accepted.raw);
  const history = (await request("/admin/commercial-policies?marketId=KW", "GET", undefined, catalogAdmin.cookie)).data.versions.filter((row: any) => row.marketId === "KW");
  assert.ok(history.length >= 1 && history[0].policy.subscriptionPlans.plans.DINAR_PRO.priceVersion === 2);
  const [row] = await db.select().from(commercialPolicies).where(eq(commercialPolicies.id, accepted.data.id));
  assert.equal(row!.createdBy, catalogAdmin.id, "the author is recorded");
  // Restore the proposed reference price (version 3) for the remaining tests.
  versioned.plans.DINAR_PRO.referencePrice.amountMinor = 2_000;
  versioned.plans.DINAR_PRO.priceVersion = 3;
  assert.equal((await request("/admin/commercial-policies", "POST", { marketId: "KW", policy: { subscriptionPlans: versioned } }, catalogAdmin.cookie)).status, 201);
});

let goSubscriptionId = "";
await test("D1-06..09 pending grants nothing, forged and duplicate webhooks change nothing, a plan change keeps the snapshot", async () => {
  registerSubscriptionBillingProvider(mockBilling);
  try {
    const key = `chk-${randomUUID()}`;
    const checkout = await request("/business/subscription-checkout", "POST", { planId: plan.GO, idempotencyKey: key }, owner.cookie);
    assert.equal(checkout.status, 201, checkout.raw);
    goSubscriptionId = checkout.data.subscriptionId;
    // D1-07: PENDING grants nothing.
    assert.equal((await aiPlanFor(owner.id, kw)).tier, "FREE");
    assert.equal((await request("/subscriptions/plans", "GET", undefined, owner.cookie)).data.currentPlan, "FREE");
    const retry = await request("/business/subscription-checkout", "POST", { planId: plan.GO, idempotencyKey: key }, owner.cookie);
    assert.equal(retry.data.subscriptionId, goSubscriptionId, "a retried checkout is the same subscription");
    const activated: BillingWebhookEvent = { id: eventId(), type: "SUBSCRIPTION_ACTIVATED", subscriptionId: goSubscriptionId, providerSubscriptionId: "ps_go", ...period(0), amountMinor: 3_000, currencyCode: "KWD" };
    // D1-08: forged signature, unknown provider, wrong amount, someone else's subscription id.
    assert.equal((await webhook(activated, "0".repeat(64))).status, 401);
    assert.equal((await request("/billing/webhooks/unknown-provider", "POST", { event: activated, signature: sign(activated) })).status, 503);
    const wrongAmount = await webhook({ ...activated, id: eventId(), amountMinor: 1 });
    assert.equal(wrongAmount.data.failureCode, "AMOUNT_MISMATCH");
    const unknownSub = await webhook({ ...activated, id: eventId(), subscriptionId: randomUUID() });
    assert.equal(unknownSub.data.failureCode, "UNKNOWN_SUBSCRIPTION");
    assert.equal((await aiPlanFor(owner.id, kw)).tier, "FREE", "nothing above grants anything");
    // D1-09: one activation, replays answered from the record, a changed body under the same id refused.
    const good = { ...activated, id: eventId() };
    assert.equal((await webhook(good)).data.status, "APPLIED");
    assert.equal((await webhook(good)).data.duplicate, true);
    assert.equal((await webhook({ ...good, providerSubscriptionId: "ps_other" })).status, 409);
    const again = await webhook({ ...good, id: eventId() });
    assert.equal(again.data.status, "IGNORED", "a second activation of an active subscription is ignored");
    const applied = await db.select().from(billingWebhookEvents).where(and(eq(billingWebhookEvents.subscriptionId, goSubscriptionId), eq(billingWebhookEvents.status, "APPLIED")));
    assert.equal(applied.length, 1);
    assert.equal((await aiPlanFor(owner.id, kw)).tier, "BUSINESS_GO");
    assert.equal((await request("/subscriptions/plans", "GET", undefined, owner.cookie)).data.currentPlan, "DINAR_GO");
    // D1-06: the owner disables Go and publishes a new price version; the live subscription keeps its snapshot.
    assert.equal((await request(`/admin/commercial-products/${plan.GO}`, "PATCH", { enabled: false }, catalogAdmin.cookie)).status, 200);
    const newer = await request("/admin/markets/KW/commercial-products", "POST", { name: `DINAR Go v2 ${runId}`, productType: "DINAR_BUSINESS", planCode: "DINAR_GO", priceMinor: 3_500, pricingVersion: 2, durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: ["AI_USAGE_BUSINESS_GO"], enabled: true }, catalogAdmin.cookie);
    assert.equal(newer.status, 201, newer.raw);
    const duplicateEnabled = await request("/admin/markets/KW/commercial-products", "POST", { name: `DINAR Go dup ${runId}`, productType: "DINAR_BUSINESS", planCode: "DINAR_GO", priceMinor: 3_600, durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: ["AI_USAGE_BUSINESS_GO"], enabled: true }, catalogAdmin.cookie);
    assert.equal(duplicateEnabled.status, 409, "one enabled product per plan and market");
    const [row] = await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.id, goSubscriptionId));
    assert.deepEqual([row!.priceMinorSnapshot, row!.pricingVersionSnapshot, row!.planCodeSnapshot, row!.entitlementsSnapshot], [3_000, 1, "DINAR_GO", ["AI_USAGE_BUSINESS_GO"]]);
    assert.equal((await aiPlanFor(owner.id, kw)).tier, "BUSINESS_GO", "the paid period keeps what was bought");
    const audit = await db.select().from(marketAudit).where(and(eq(marketAudit.marketId, "KW"), sql`${marketAudit.action} LIKE 'COMMERCIAL_PRODUCT_%'`));
    assert.ok(audit.some((item) => item.action === "COMMERCIAL_PRODUCT_DISABLED" && (item.data as any).productId === plan.GO));
    assert.ok(audit.some((item) => item.action === "COMMERCIAL_PRODUCT_CREATED" && (item.data as any).pricingVersion === 2));
    plan.GO = newer.data.id;
    // Plan change preview: Go → Pro is an upgrade after payment confirmation; no proration is invented.
    const preview = await request(`/business/plan-change-preview?planId=${plan.PRO}`, "GET", undefined, owner.cookie);
    assert.deepEqual([preview.data.planChange.kind, preview.data.planChange.effective, preview.data.planChange.proration], ["UPGRADE", "AFTER_PAYMENT_CONFIRMATION", "NOT_APPROVED"]);
    assert.equal((await request("/business/subscription-checkout", "POST", { planId: plan.PRO, idempotencyKey: `chk-${randomUUID()}` }, owner.cookie)).status, 409, "no second live subscription");
    // Cancellation: renewal stops, the paid period stays; refund ends entitlements at once.
    assert.equal((await webhook({ id: eventId(), type: "CANCELLATION_SCHEDULED", subscriptionId: goSubscriptionId, providerSubscriptionId: "ps_go" })).data.status, "APPLIED");
    assert.equal((await aiPlanFor(owner.id, kw)).tier, "BUSINESS_GO");
    assert.equal((await webhook({ id: eventId(), type: "REFUNDED", subscriptionId: goSubscriptionId, providerSubscriptionId: "ps_go", amountMinor: 3_000, currencyCode: "KWD" })).data.status, "APPLIED");
    assert.equal((await aiPlanFor(owner.id, kw)).tier, "FREE");
  } finally {
    unregisterSubscriptionBillingProvider("mock-d12");
  }
});

await test("D1-10 cross-account and cross-market isolation of subscriptions", async () => {
  registerSubscriptionBillingProvider(mockBilling);
  try {
    const checkout = await request("/business/subscription-checkout", "POST", { planId: plan.PRO, idempotencyKey: `chk-${randomUUID()}` }, other.cookie);
    assert.equal(checkout.status, 201, checkout.raw);
    assert.equal((await webhook({ id: eventId(), type: "SUBSCRIPTION_ACTIVATED", subscriptionId: checkout.data.subscriptionId, providerSubscriptionId: "ps_pro", ...period(0), amountMinor: 6_000, currencyCode: "KWD" })).data.status, "APPLIED");
  } finally {
    unregisterSubscriptionBillingProvider("mock-d12");
  }
  assert.equal((await aiPlanFor(other.id, kw)).tier, "BUSINESS_PRO");
  assert.equal((await aiPlanFor(other.id, { id: "JO" })).tier, "FREE", "a KW subscription grants nothing in JO");
  assert.equal((await aiPlanFor(owner.id, kw)).tier, "FREE", "another account's subscription grants nothing");
  const ownerView = (await request("/subscriptions/plans", "GET", undefined, owner.cookie)).data;
  assert.notEqual(ownerView.subscription.id, await checkout_id_of(other.id));
  assert.equal((await request("/business/subscription/cancel", "POST", {}, owner.cookie)).status, 404, "owner cannot cancel someone else's plan");
});
async function checkout_id_of(userId: string) {
  return (await db.select({ id: businessSubscriptions.id }).from(businessSubscriptions).where(eq(businessSubscriptions.userId, userId)))[0]?.id;
}

await test("D1-11 AI usage and spending guardrails stay enforced; economics are bounded and honest", async () => {
  const policy = (await request("/admin/commercial-policies?marketId=KW", "GET", undefined, catalogAdmin.cookie)).data.effective.aiUsage;
  const inverted = structuredClone(policy);
  inverted.tiers.BUSINESS_PRO.tokens = 1;
  assert.equal((await request("/admin/commercial-policies", "POST", { marketId: "KW", policy: { aiUsage: inverted } }, catalogAdmin.cookie)).status, 400, "Pro can never get less than Go");
  const economics = await request("/admin/subscription-plans/economics?marketId=KW", "GET", undefined, catalogAdmin.cookie);
  assert.equal(economics.status, 200, economics.raw);
  assert.equal(economics.data.unlimited, false);
  assert.equal(economics.data.plansApproved, false);
  assert.ok(["PRICED", "UNPRICED"].includes(economics.data.tiers.BUSINESS_PRO.status));
  assert.deepEqual(economics.data.plans.map((item: any) => item.planCode), ["DINAR_GO", "DINAR_PRO", "DINAR_BUSINESS"]);
  assert.equal((await request("/admin/subscription-plans/economics", "GET", undefined, owner.cookie)).status, 403);
  // Priced with a placeholder model price: full use is bounded by the tier's token budget.
  const priced = await request("/admin/ai/model-prices", "POST", { provider: "openai", model: `d12-test-${runId}`, currencyCode: "USD", inputPerMillionMicros: 3_000_000, outputPerMillionMicros: 15_000_000, imageUnitMicros: 5_000, audioSecondMicros: 100, source: "CONTRACT", sourceReference: "D1/D2 disposable test value, not a real price" }, catalogAdmin.cookie);
  assert.equal(priced.status, 201, priced.raw);
  {
    const again = (await request("/admin/subscription-plans/economics?marketId=KW", "GET", undefined, catalogAdmin.cookie)).data;
    if (again.tiers.BUSINESS_PRO.status === "PRICED") {
      assert.ok(again.tiers.BUSINESS_PRO.mostExpensive.worstCaseMicros > 0);
      assert.ok(again.tiers.BUSINESS_PRO.mostExpensive.worstCaseMicros >= again.tiers.BUSINESS_GO.mostExpensive.worstCaseMicros);
      assert.ok(again.plans.every((item: any) => ["LOSS_AT_FULL_USE", "THIN_MARGIN_AT_FULL_USE", "COVERED_AT_FULL_USE", "UNKNOWN"].includes(item.verdict)));
    }
  }
  assert.equal(getModelGatewayCallCount(), 0, "no model call anywhere in D1/D2");
});

await test("D1-12 a subscription never changes organic ranking", async () => {
  const market = await marketFor({ actor: { activeMarketId: "KW" } });
  const at = new Date("2026-09-01T00:00:00Z");
  for (const [index, seller] of [owner, other, joUser].entries())
    await db.insert(offers).values({ id: `d12-rank-${runId}-${index}`, sellerId: seller.id, marketId: "KW", status: "PUBLISHED", unitPriceMinor: 5_000 + index, pricingMode: "FIXED", inventoryMode: "LIMITED", availableQuantity: 1, reservedQuantity: 0, data: { title: `شواية فحم ${runId} ${index}`, description: "", category: "أخرى", categoryId: "other", city: "الكويت", area: "", attributes: {} }, createdAt: new Date(at.getTime() + index), updatedAt: at });
  const ids = async () => (await searchMarketplaceListings(market, { search: `شواية فحم ${runId}`, conversational: true, limit: 20, sponsoredSlots: 0 })).map((item) => item.id);
  const before = await ids();
  assert.equal(before.length, 3);
  // `other` holds an active Pro subscription since D1-10; give `owner` a verified Business plan too (simulated period).
  const now = new Date();
  await db.insert(businessSubscriptions).values({ id: randomUUID(), userId: owner.id, marketId: "KW", planId: plan.GO, planNameSnapshot: "Go", priceMinorSnapshot: 3_500, currencyCodeSnapshot: "KWD", periodDaysSnapshot: 30, pricingVersionSnapshot: 2, entitlementsSnapshot: ["AI_USAGE_BUSINESS_GO"], planCodeSnapshot: "DINAR_GO", status: "ACTIVE", idempotencyKey: `rank-${randomUUID()}`, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 86_400_000) });
  assert.deepEqual(await ids(), before, "same results, same order, with or without plans");
  await db.delete(businessSubscriptions).where(and(eq(businessSubscriptions.userId, owner.id), eq(businessSubscriptions.status, "ACTIVE")));
});

// ─── D2 ──────────────────────────────────────────────────────────────────────

await test("D2-01 Arabic and Gulf business-registration intent (and what is not one)", () => {
  const positive: Array<[string, string, string | undefined, string | undefined]> = [
    ["دينار، أنا صاحب مطعم اسمه سمراء للمشاوي في الكويت، وأريد أضيفه إلى دينار.", "GRILL_RESTAURANT", "سمراء للمشاوي", "KW"],
    ["دينار أنا صاحب مطعم سمراء للمشاوي بالكويت.", "GRILL_RESTAURANT", "سمراء للمشاوي", "KW"],
    ["انا مالك مقهى اسمه نسمة الصباح", "CAFE", "نسمة الصباح", undefined],
    ["عندي محل اسمه بيت العطور وأبي أسجله", "RETAIL", "بيت العطور", undefined],
    ["أبي أسجل مطعمي في جاسم", "RESTAURANT", undefined, undefined],
    ["احنا نملك مخبز", "OTHER", undefined, undefined],
    ["أنا صاحبة صالون اسمه لمسة", "BEAUTY", "لمسة", undefined],
    ["بدي سجل محلي عندكم", "RETAIL", undefined, undefined],
  ];
  for (const [message, category, name, marketId] of positive) {
    const intent = businessIntent(message, false);
    if (message.startsWith("احنا نملك")) {
      assert.equal(intent, undefined, "«نملك» without «انا/عندي» pattern is not claimed");
      continue;
    }
    assert.equal(intent?.kind, "INTRODUCE", message);
    if (intent?.kind !== "INTRODUCE") continue;
    if (category !== "RETAIL" || !message.startsWith("بدي")) assert.equal(intent.categoryKey, category, message);
    assert.equal(intent.displayName, name, message);
    assert.equal(intent.marketId, marketId, message);
  }
  assert.equal(businessIntent("أبي أرفع السجل التجاري", true)?.kind, "UPLOAD_DOCUMENT");
  assert.equal(businessIntent("ابي ارسل الرخصة التجارية", false)?.kind, "UPLOAD_DOCUMENT");
  assert.equal(businessIntent("وين وصل طلبي؟", true)?.kind, "STATUS");
  assert.equal(businessIntent("وين وصل طلبي؟", false), undefined, "without its card, «طلبي» stays an order");
  assert.equal(businessIntent("وش صار على توثيق مطعمي", false)?.kind, "STATUS");
  assert.equal(businessIntent("الاسم القانوني مؤسسة سمراء للمشاوي ورقم السجل 123456", true)?.kind, "INFO");
  assert.equal(businessIntent("أريد ربط مطعمي بنظامي الحالي", false)?.kind, "CONNECT_SYSTEM");
  for (const negative of ["ابحث عن مطعم مشاوي في الكويت", "صاحب المحل ما رد علي", "أبي أشتري مطعم مستعمل", "تتبع طلبي", "كم سعر الشاورما"])
    assert.notEqual(businessIntent(negative, false)?.kind, "INTRODUCE", negative);
  assert.equal(businessNameFrom("انا صاحب مطعم"), undefined);
});

let samraa: any;
await test("D2-02..04 an authenticated user creates a DRAFT on the free plan; the owner is the session", async () => {
  assert.equal((await request("/business/profiles", "POST", { displayName: "x y", categoryKey: "RESTAURANT", idempotencyKey: `biz-${randomUUID()}` })).status, 401);
  const forgedOwner = await request("/business/profiles", "POST", { displayName: `سمراء للمشاوي ${runId}`, categoryKey: "GRILL_RESTAURANT", idempotencyKey: `biz-${randomUUID()}`, ownerUserId: other.id }, owner.cookie);
  assert.equal(forgedOwner.status, 400, "no owner in the body");
  const forgedStatus = await request("/business/profiles", "POST", { displayName: `سمراء للمشاوي ${runId}`, categoryKey: "GRILL_RESTAURANT", idempotencyKey: `biz-${randomUUID()}`, verificationStatus: "VERIFIED" }, owner.cookie);
  assert.equal(forgedStatus.status, 400, "no status in the body");
  const created = await request("/business/profiles", "POST", { displayName: `سمراء للمشاوي ${runId}`, categoryKey: "GRILL_RESTAURANT", idempotencyKey: `biz-${runId}-samraa` }, owner.cookie);
  assert.equal(created.status, 201, created.raw);
  samraa = created.data.business;
  assert.equal(samraa.verificationStatus, "DRAFT");
  assert.equal(samraa.verified, false);
  const [row] = await db.select().from(businessProfiles).where(eq(businessProfiles.id, samraa.id));
  assert.equal(row!.ownerUserId, owner.id);
  assert.equal(row!.marketId, "KW");
  const [membership] = await db.select().from(businessMemberships).where(eq(businessMemberships.businessId, samraa.id));
  assert.deepEqual([membership!.userId, membership!.role], [owner.id, "APPLICANT"], "the creator is an applicant, not a verified owner");
  assert.equal((await aiPlanFor(owner.id, kw)).tier, "FREE", "no subscription needed for a business");
  assert.equal((await db.select().from(businessSubscriptions).where(and(eq(businessSubscriptions.userId, owner.id), sql`${businessSubscriptions.status} IN ('PENDING','ACTIVE')`))).length, 0);
  assert.equal(samraa.salesHistory, "NONE_IN_DINAR", "no invented sales numbers");
});

await test("D2-05 a draft cannot masquerade as verified (API and database)", async () => {
  assert.equal((await request(`/businesses/${samraa.id}`)).status, 404);
  const publish = await request(`/business/profiles/${samraa.id}/publication`, "POST", { publish: true }, owner.cookie);
  assert.equal(publish.status, 409);
  await assert.rejects(() => db.update(businessProfiles).set({ publicationStatus: "PUBLISHED" }).where(eq(businessProfiles.id, samraa.id)), "PUBLISHED requires VERIFIED (CHECK)");
  await assert.rejects(() => db.update(businessProfiles).set({ verificationStatus: "VERIFIED" }).where(eq(businessProfiles.id, samraa.id)), "VERIFIED requires a reviewer (CHECK)");
  await assert.rejects(() => db.update(businessProfiles).set({ verificationStatus: "VERIFIED", verifiedAt: new Date(), verifiedBy: owner.id }).where(eq(businessProfiles.id, samraa.id)), "the applicant can never be the reviewer (CHECK)");
  const view = (await request(`/business/profiles/${samraa.id}`, "GET", undefined, owner.cookie)).data;
  assert.equal(view.verified, false);
  assert.ok(!view.actions.includes("PUBLISH"));
});

await test("D2-06 VERIFIED requires an authorized reviewer, a clean scan and no self-review", async () => {
  const pending = await readyForReview(owner, `مشويات الديرة ${runId}`, "77001234");
  assert.equal(pending.verificationStatus, "PENDING_REVIEW");
  assert.ok([403, 404].includes((await request(`/admin/business-verification/${pending.id}/decision`, "POST", { decision: "VERIFY", expectedRevision: pending.revision }, owner.cookie)).status), "an applicant has no review route");
  assert.ok([403, 404].includes((await request(`/admin/business-verification/${pending.id}/decision`, "POST", { decision: "VERIFY", expectedRevision: pending.revision }, other.cookie)).status));
  const noScanner = await decide(pending.id, "VERIFY");
  assert.equal(noScanner.status, 409);
  assert.equal(noScanner.data.code, "SCANNER_NOT_CONNECTED", "without a scanner nothing is ever verified");
  // A reviewer's own application cannot be reviewed by them.
  const selfApp = await readyForReview(reviewer, `مطبخ المراجع ${runId}`, "88009999");
  registerBusinessDocumentScanner(mockScanner);
  try {
    // Documents uploaded before the scanner existed are still quarantined: the reviewer asks again.
    assert.equal((await decide(pending.id, "VERIFY")).data.code, "DOCUMENTS_NOT_CLEAN");
    assert.equal((await decide(pending.id, "REQUEST_DOCUMENTS")).status, 400, "a reason is required");
    assert.equal((await decide(pending.id, "REQUEST_DOCUMENTS", "أعد رفع السجل بعد تفعيل الفحص")).status, 200);
    const again = await uploadDocument(owner, pending.id, PDF, "application/pdf", "COMMERCIAL_LICENSE");
    assert.equal(again.complete?.data.documents.at(-1).scanStatus, "CLEAN");
    assert.equal((await request(`/business/profiles/${pending.id}/submit`, "POST", {}, owner.cookie)).status, 200);
    const verified = await decide(pending.id, "VERIFY");
    assert.equal(verified.status, 200, verified.raw);
    assert.equal(verified.data.verificationStatus, "VERIFIED");
    const selfReview = await decide(selfApp.id, "VERIFY");
    assert.equal(selfReview.status, 403);
    assert.equal(selfReview.data.code, "SELF_REVIEW_FORBIDDEN");
  } finally {
    unregisterBusinessDocumentScanner();
  }
  const [membership] = await db.select().from(businessMemberships).where(eq(businessMemberships.businessId, pending.id));
  assert.equal(membership!.role, "VERIFIED_OWNER");
  const events = await db.select().from(businessVerificationEvents).where(eq(businessVerificationEvents.businessId, pending.id));
  assert.ok(events.some((event) => event.action === "VERIFIED" && event.actorId === reviewer.id));
  await assert.rejects(() => db.update(businessVerificationEvents).set({ reason: "x" }).where(eq(businessVerificationEvents.businessId, pending.id)), "events are append-only");
  await assert.rejects(() => db.delete(businessVerificationEvents).where(eq(businessVerificationEvents.businessId, pending.id)));
  samraa.verifiedSibling = pending.id;
});

await test("D2-20 a rejected verification publishes nothing, keeps its reason and allows a corrected application", async () => {
  // A separate applicant: the owner already holds other open businesses, and one owner is
  // limited in how many unfinished applications it may keep.
  const rejected = await readyForReview(catalogAdmin, `مطعم مرفوض ${runId}`, "99007777");
  assert.equal(rejected.verificationStatus, "PENDING_REVIEW");
  assert.equal((await decide(rejected.id, "REJECT")).status, 400, "a rejection needs a reason");
  const decision = await decide(rejected.id, "REJECT", "رقم السجل غير مطابق للسجل التجاري");
  assert.equal(decision.status, 200, decision.raw);
  assert.equal(decision.data.verificationStatus, "REJECTED");
  assert.equal(decision.data.verified, false);
  assert.equal(
    (await db.select().from(businessMemberships).where(and(eq(businessMemberships.businessId, rejected.id), eq(businessMemberships.role, "VERIFIED_OWNER")))).length,
    0,
    "a rejection never creates a verified owner",
  );
  assert.equal((await request(`/businesses/${rejected.id}`)).status, 404, "a rejected business has no public surface");
  assert.equal((await request(`/business/profiles/${rejected.id}/publication`, "POST", { publish: true }, catalogAdmin.cookie)).status, 409);
  const events = await db.select().from(businessVerificationEvents).where(eq(businessVerificationEvents.businessId, rejected.id));
  assert.ok(events.some((event) => event.action === "REJECTED" && event.reason?.includes("غير مطابق") && event.actorId === reviewer.id));
  const retry = await newBusiness(catalogAdmin, `مطعم مرفوض ${runId}`);
  assert.notEqual(retry.id, rejected.id, "a rejected name can be applied for again");
});

await test("D2-07/08 documents are private, owner-scoped, type-checked and never in public or owner responses", async () => {
  let business = await newBusiness(owner, `مطعم الفريج ${runId}`);
  assert.equal((await request(`/business/profiles/${business.id}/documents/upload-url`, "POST", { kind: "COMMERCIAL_REGISTRATION", contentType: "application/pdf", size: PDF.length, idempotencyKey: `doc-${randomUUID()}` }, owner.cookie)).status, 409, "uploads open only when verification asks for them");
  await request(`/business/profiles/${business.id}/start-verification`, "POST", {}, owner.cookie);
  assert.equal((await request(`/business/profiles/${business.id}/documents/upload-url`, "POST", { kind: "COMMERCIAL_REGISTRATION", contentType: "application/pdf", size: PDF.length, idempotencyKey: `doc-${randomUUID()}` }, other.cookie)).status, 404, "a stranger cannot upload to it");
  assert.equal((await request(`/business/profiles/${business.id}/documents/upload-url`, "POST", { kind: "COMMERCIAL_REGISTRATION", contentType: "text/html", size: 10, idempotencyKey: `doc-${randomUUID()}` }, owner.cookie)).status, 400);
  assert.equal((await request(`/business/profiles/${business.id}/documents/upload-url`, "POST", { kind: "COMMERCIAL_REGISTRATION", contentType: "application/pdf", size: 11 * 1024 * 1024, idempotencyKey: `doc-${randomUUID()}` }, owner.cookie)).status, 400);
  const disguised = await uploadDocument(owner, business.id, PNG, "application/pdf");
  assert.equal(disguised.complete?.status, 400, "a PNG declared as PDF is refused by its bytes");
  const wrongSize = await uploadDocument(owner, business.id, PDF, "application/pdf", "COMMERCIAL_REGISTRATION", PDF.length + 5);
  assert.equal(wrongSize.complete?.status, 409);
  const good = await uploadDocument(owner, business.id, PDF);
  assert.equal(good.complete?.status, 200, good.complete?.raw);
  assert.equal(good.complete?.data.documents.at(-1).scanStatus, "NOT_SCANNED", "quarantined while no scanner is connected");
  const [doc] = await db.select().from(businessVerificationDocuments).where(and(eq(businessVerificationDocuments.businessId, business.id), eq(businessVerificationDocuments.status, "UPLOADED")));
  assert.ok(doc!.objectPath.startsWith(`/objects/business-documents/${owner.id}/`));
  const key = doc!.objectPath.slice("/objects/".length);
  for (const cookie of ["", owner.cookie, other.cookie, reviewer.cookie]) {
    const served = await fetch(`${base}/storage/objects/${key}`, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(served.status, 404, "no public route serves business documents");
  }
  assert.equal((await request(`/business/profiles/${business.id}/documents/${doc!.id}/complete`, "POST", {}, other.cookie)).status, 404);
  // Owner, reviewer queue and conversation payloads never carry a storage path or the full number.
  business = (await request(`/business/profiles/${business.id}`, "PATCH", { expectedRevision: (await request(`/business/profiles/${business.id}`, "GET", undefined, owner.cookie)).data.revision, registrationNumber: "KW-55667788" }, owner.cookie)).data;
  const ownerRaw = (await request(`/business/profiles/${business.id}`, "GET", undefined, owner.cookie)).raw;
  assert.ok(!ownerRaw.includes("business-documents/") && !ownerRaw.includes("55667788") && ownerRaw.includes("7788"));
  const queueRaw = (await request("/admin/business-verification?status=DOCUMENTS_REQUIRED", "GET", undefined, reviewer.cookie)).raw;
  assert.ok(!queueRaw.includes("business-documents/") && !queueRaw.includes("55667788"));
  // Reviewer bytes: only a CLEAN document, never to a non-reviewer.
  assert.ok([403, 404].includes((await request(`/admin/business-verification/documents/${doc!.id}/content`, "GET", undefined, owner.cookie)).status));
  assert.equal((await request(`/admin/business-verification/documents/${doc!.id}/content`, "GET", undefined, reviewer.cookie)).status, 409, "quarantined documents are not served");
  registerBusinessDocumentScanner(mockScanner);
  try {
    const infected = await uploadDocument(owner, business.id, INFECTED_PDF);
    assert.equal(infected.complete?.data.documents.at(-1).scanStatus, "INFECTED");
    const clean = await uploadDocument(owner, business.id, PDF, "application/pdf", "COMMERCIAL_LICENSE");
    const cleanId = clean.complete?.data.documents.at(-1).id;
    const content = await fetch(`${base}/admin/business-verification/documents/${cleanId}/content`, { headers: { Cookie: reviewer.cookie } });
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("cache-control"), "no-store");
    assert.ok(Buffer.from(await content.arrayBuffer()).equals(PDF));
    const access = await db.select().from(businessVerificationEvents).where(and(eq(businessVerificationEvents.businessId, business.id), eq(businessVerificationEvents.action, "DOCUMENT_ACCESSED")));
    assert.equal(access.length, 1, "every reviewer read is recorded");
  } finally {
    unregisterBusinessDocumentScanner();
  }
  // Published, verified business: the public view has no legal or document data.
  const verifiedId = samraa.verifiedSibling;
  assert.equal((await request(`/business/profiles/${verifiedId}/publication`, "POST", { publish: true }, owner.cookie)).status, 200);
  const publicView = await request(`/businesses/${verifiedId}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.data.verified, true);
  for (const secret of ["legalName", "registrationNumberLast4", "documents", "ownerUserId", "business-documents", "77001234"]) assert.ok(!publicView.raw.includes(secret), secret);
});

await test("D2-09/10 cross-account, cross-business and cross-market access are 404", async () => {
  const id = samraa.id;
  for (const [path, method, body] of [
    [`/business/profiles/${id}`, "GET", undefined],
    [`/business/profiles/${id}`, "PATCH", { expectedRevision: 1, description: "x" }],
    [`/business/profiles/${id}/start-verification`, "POST", {}],
    [`/business/profiles/${id}/submit`, "POST", {}],
    [`/business/profiles/${id}/publication`, "POST", { publish: false }],
    [`/business/profiles/${id}/integration-requests`, "POST", { kind: "POS", systemName: "Foodics", scopes: ["CATALOG_READ"] }],
  ] as const)
    assert.equal((await request(path, method, body, other.cookie)).status, 404, `${method} ${path}`);
  assert.ok((await request("/business/profiles", "GET", undefined, other.cookie)).data.every((item: any) => item.id !== id));
  // The owner in another active market does not see the KW business.
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, owner.cookie)).status, 200);
  try {
    assert.equal((await request(`/business/profiles/${id}`, "GET", undefined, owner.cookie)).status, 404);
    assert.equal((await request("/business/profiles", "GET", undefined, owner.cookie)).data.length, 0);
    const conv = await conversation(owner);
    const mismatch = await turn(owner, conv, "أنا صاحب مطعم اسمه شاورما الجهراء في الكويت");
    assert.match(mismatch.text ?? mismatch.payload.prompt, /سوقك الحالي/u);
    assert.equal((await db.select().from(businessProfiles).where(eq(businessProfiles.marketId, "JO"))).filter((row) => row.ownerUserId === owner.id).length, 0, "nothing created in the wrong market");
  } finally {
    assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, owner.cookie)).status, 200);
  }
});

await test("D2-11 duplicate registration and retries are safe", async () => {
  const key = `biz-${randomUUID()}`;
  const name = `كباب الخليج ${runId}`;
  const first = await request("/business/profiles", "POST", { displayName: name, categoryKey: "GRILL_RESTAURANT", idempotencyKey: key }, other.cookie);
  const replay = await request("/business/profiles", "POST", { displayName: name, categoryKey: "GRILL_RESTAURANT", idempotencyKey: key }, other.cookie);
  assert.deepEqual([first.status, replay.status, replay.data.created], [201, 200, false]);
  assert.equal(replay.data.business.id, first.data.business.id);
  const sameName = await request("/business/profiles", "POST", { displayName: `  ${name}!`, categoryKey: "GRILL_RESTAURANT", idempotencyKey: `biz-${randomUUID()}` }, other.cookie);
  assert.equal(sameName.data.business.id, first.data.business.id, "a repeated introduction finds the same record");
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => request("/business/profiles", "POST", { displayName: `مشاوي التوازي ${runId}`, categoryKey: "GRILL_RESTAURANT", idempotencyKey: `biz-${randomUUID()}` }, other.cookie)));
  assert.equal(new Set(concurrent.map((item) => item.data?.business?.id)).size, 1, concurrent.map((item) => item.raw).join("\n"));
  // A registration number already under review or verified in the market cannot be claimed again.
  let claimer = await newBusiness(other, `مشويات الديرة المقلدة ${runId}`);
  claimer = (await request(`/business/profiles/${claimer.id}`, "PATCH", { expectedRevision: claimer.revision, legalName: "منتحل", registrationNumber: "77001234" }, other.cookie)).data;
  await request(`/business/profiles/${claimer.id}/start-verification`, "POST", {}, other.cookie);
  await uploadDocument(other, claimer.id, PDF);
  const claimed = await request(`/business/profiles/${claimer.id}/submit`, "POST", {}, other.cookie);
  assert.equal(claimed.status, 409);
  assert.equal(claimed.data.code, "REGISTRATION_ALREADY_CLAIMED");
  const conv = await conversation(other);
  const once = await turn(other, conv, `أنا صاحب مطعم اسمه كباب الخليج ${runId}`);
  assert.match(once.payload.prompt, /لم أنشئ نسخة ثانية/u);
});

let businessSubId = "";
await test("D2-12..14 a verified business: no self-granted plan, fake checkout activates nothing, suspension removes privileges", async () => {
  const verifiedId = samraa.verifiedSibling;
  // D2-14: verification created no subscription and no entitlement.
  assert.equal((await db.select().from(businessSubscriptions).where(and(eq(businessSubscriptions.userId, owner.id), sql`${businessSubscriptions.status} IN ('PENDING','ACTIVE','PAST_DUE','CANCEL_AT_PERIOD_END')`))).length, 0);
  assert.equal((await businessEntitlements(owner.id, kw)).size, 0);
  assert.equal((await request("/subscriptions/plans", "GET", undefined, owner.cookie)).data.currentPlan, "FREE");
  // Without a provider: the Business checkout refuses and creates nothing.
  const offline = await request("/business/subscription-checkout", "POST", { planId: plan.BUSINESS, idempotencyKey: `chk-${randomUUID()}`, businessId: verifiedId }, owner.cookie);
  assert.equal(offline.status, 503);
  registerSubscriptionBillingProvider(mockBilling);
  try {
    // Another account cannot attach its subscription to this business.
    assert.equal((await request("/business/subscription-checkout", "POST", { planId: plan.BUSINESS, idempotencyKey: `chk-${randomUUID()}`, businessId: verifiedId }, other.cookie)).status, 404);
    const checkout = await request("/business/subscription-checkout", "POST", { planId: plan.BUSINESS, idempotencyKey: `chk-${randomUUID()}`, businessId: verifiedId }, owner.cookie);
    assert.equal(checkout.status, 201, checkout.raw);
    businessSubId = checkout.data.subscriptionId;
    // D2-13: a fake (forged) activation does nothing, to the subscription or the business.
    const activated: BillingWebhookEvent = { id: eventId(), type: "SUBSCRIPTION_ACTIVATED", subscriptionId: businessSubId, providerSubscriptionId: "ps_biz", ...period(0), amountMinor: 15_000, currencyCode: "KWD" };
    assert.equal((await webhook(activated, "a".repeat(64))).status, 401);
    assert.equal((await businessEntitlements(owner.id, kw)).size, 0);
    // A fake checkout for an UNVERIFIED business never even reaches the provider.
    const unverified = await newBusiness(owner, `مطعم غير موثق ${runId}`);
    assert.equal((await request("/business/subscription-checkout", "POST", { planId: plan.BUSINESS, idempotencyKey: `chk-${randomUUID()}`, businessId: unverified.id }, owner.cookie)).status, 409);
    assert.equal((await request(`/business/profiles/${unverified.id}`, "GET", undefined, owner.cookie)).data.verificationStatus, "DRAFT", "a checkout never verifies a business");
    // Signed activation of the verified business's subscription: privileges start.
    assert.equal((await webhook({ ...activated, id: eventId() })).data.status, "APPLIED");
  } finally {
    unregisterSubscriptionBillingProvider("mock-d12");
  }
  assert.deepEqual([...(await businessEntitlements(owner.id, kw))].sort(), ["BUSINESS_PROFILE_TOOLS", "BUSINESS_REPORTING", "INVENTORY_INSIGHTS"]);
  assert.equal((await request("/subscriptions/plans", "GET", undefined, owner.cookie)).data.currentPlan, "DINAR_BUSINESS");
  // D2-12: suspension removes business privileges and publication at once; reinstatement restores them.
  assert.equal((await decide(verifiedId, "SUSPEND")).status, 400, "suspension needs a reason");
  const suspended = await decide(verifiedId, "SUSPEND", "شكوى انتحال قيد المراجعة");
  assert.equal(suspended.status, 200, suspended.raw);
  assert.equal((await businessEntitlements(owner.id, kw)).size, 0);
  assert.equal((await request(`/businesses/${verifiedId}`)).status, 404);
  assert.equal((await request(`/business/profiles/${verifiedId}/publication`, "POST", { publish: true }, owner.cookie)).status, 409);
  const [subscription] = await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.id, businessSubId));
  assert.equal(subscription!.status, "ACTIVE", "suspension pauses privileges; it does not rewrite the billing record");
  assert.equal((await decide(verifiedId, "REINSTATE", "انتهت المراجعة")).status, 200);
  assert.equal((await businessEntitlements(owner.id, kw)).size, 3);
});

await test("D2-15 the DINAR Business card persists and rehydrates from the server; another account sees nothing", async () => {
  const conv = await conversation(other);
  const intro = await turn(other, conv, `دينار أنا صاحب مطعم فلافل الحارة ${runId} بالكويت`);
  assert.equal(intro.payload.surface, "BUSINESS_PROFILE", intro.raw);
  const card = intro.payload.commerce.business;
  assert.equal(card.brand, "DINAR BUSINESS");
  assert.equal(card.marketLabel, "الكويت");
  assert.equal(card.status, "DRAFT");
  assert.ok(card.actions.some((action: any) => action.key === "START_VERIFICATION"));
  assert.ok(card.actions.some((action: any) => action.key === "REVIEW_PLANS"));
  assert.match(intro.raw, /DINAR_BUSINESS_CARD/u, "the canonical envelope type");
  const upload = await turn(other, conv, "أبي أرفع السجل التجاري");
  assert.equal(upload.payload.commerce.business.status, "DOCUMENTS_REQUIRED");
  assert.ok(upload.payload.commerce.business.actions.some((action: any) => action.key === "UPLOAD_DOCUMENTS"));
  // The server state moves; the restored conversation shows the new state, not the stored card.
  await db.update(businessProfiles).set({ description: "تحديث", revision: sql`${businessProfiles.revision} + 1` }).where(eq(businessProfiles.id, card.id));
  await request(`/business/profiles/${card.id}`, "PATCH", { expectedRevision: (await request(`/business/profiles/${card.id}`, "GET", undefined, other.cookie)).data.revision, legalName: "فلافل الحارة للتجارة", registrationNumber: "99887766" }, other.cookie);
  const restored = await request(`/ai/conversations/${conv}`, "GET", undefined, other.cookie);
  assert.equal(restored.status, 200);
  assert.match(restored.raw, /BUSINESS_PROFILE/u);
  assert.match(restored.raw, /7766/u, "the restored card is rebuilt with current data");
  assert.equal((await request(`/ai/conversations/${conv}`, "GET", undefined, owner.cookie)).status, 404, "another account cannot open the conversation");
  const status = await turn(other, conv, "وين وصل طلبي؟");
  assert.equal(status.payload.surface, "BUSINESS_PROFILE", "«طلبي» right after the card is the business request");
  assert.match(status.payload.prompt, /بانتظار مستنداتك/u);
});

await test("D2-17 the typed catalog contract keeps verification, publication, membership and paid plan apart", async () => {
  const verifiedId = samraa.verifiedSibling;
  const identity = (await businessIdentity(verifiedId))!;
  assert.deepEqual([identity.contractVersion, identity.verification, identity.verified, identity.suspended], [BUSINESS_CATALOG_CONTRACT_VERSION, "VERIFIED", true, false]);
  const draftIdentity = (await businessIdentity(samraa.id))!;
  assert.equal(draftIdentity.verification, "DRAFT");
  // Permissions: owner of the verified business may publish; the stranger may not even read.
  assert.deepEqual((await authorizeBusinessAction(owner.id, verifiedId, "PUBLISH_CATALOG_AS_BUSINESS")).decision, { allowed: true, reason: "OK" });
  assert.equal((await authorizeBusinessAction(other.id, verifiedId, "VIEW_PRIVATE")).decision.reason, "NOT_A_MEMBER");
  assert.equal((await authorizeBusinessAction(owner.id, samraa.id, "PUBLISH_PROFILE")).decision.reason, "NOT_VERIFIED", "a draft is never shown as a business");
  assert.equal((await authorizeBusinessAction(owner.id, samraa.id, "PREPARE_CATALOG")).decision.allowed, true, "a draft may prepare ordinary listings");
  const member = { businessId: verifiedId, userId: owner.id, role: "VERIFIED_OWNER" as const, active: true };
  assert.equal(businessPermission({ ...identity, verification: "SUSPENDED", verified: false, suspended: true }, member, "PUBLISH_PROFILE").reason, "SUSPENDED");
  assert.equal(businessPermission(identity, { ...member, role: "STAFF" }, "VIEW_PRIVATE").reason, "ROLE_NOT_GRANTABLE");
  assert.equal(businessPermission(identity, { ...member, active: false }, "VIEW_PRIVATE").reason, "MEMBERSHIP_REVOKED");
  assert.equal(businessPermission(identity, { ...member, role: "APPLICANT" }, "SUBSCRIBE_BUSINESS_PLAN").reason, "NOT_VERIFIED_OWNER");
  // Publication eligibility never needs (nor is satisfied by) a paid plan.
  assert.deepEqual(publicationEligibility(draftIdentity), { profile: false, catalogAsBusiness: false, reasons: ["NOT_VERIFIED"], paidPlanRequired: false });
  assert.equal(publicationEligibility(identity).profile, true);
  // The paid plan is its own fact: the verified business has one (D2-12), the draft none.
  assert.equal((await businessPlanStatus(verifiedId)).paid, true);
  assert.deepEqual(await businessPlanStatus(samraa.id), { paid: false, status: "NONE", grantsOnlyWhileVerified: true });
  // Business ↔ listing association (v1): the owner's own listings in the business's market.
  const association = (await businessListingAssociation(verifiedId))!;
  assert.equal(association.mode, "EXPLICIT");
  assert.equal(association.implicitUnlinked, false, "an owner with several businesses gets explicit links only");
  assert.ok(!association.listingIds.includes(`d12-rank-${runId}-0`), "an unlinked listing is not silently assigned to one of several businesses");
  assert.ok(!association.listingIds.includes(`d12-rank-${runId}-1`), "another seller's listing never does");
  assert.ok(BUSINESS_LIFECYCLE.every((step) => step.to !== "VERIFIED" || step.actor === "REVIEWER"), "only a reviewer ever moves to VERIFIED");
});

await test("D2-18 the business pre-gate costs no query for ordinary messages and never swallows other follow-ups", async () => {
  for (const message of ["ابحث عن هاتف", "تتبع طلبي", "نعم", "اعرض إعلاناتي", "كم سعر برو", "أريد أن أبيع", "رصيدي", "شكرا", "وين وصل طلبي رقم 12345", "ما الفرق بين جو وبرو", "كم بقي من استخدامي؟", "أبي أشترك في بزنس"])
    assert.equal(isPossibleBusinessMessage(message), false, message);
  for (const message of ["وين وصل طلبي؟", "أنا صاحب مطعم اسمه زاد", "أبي أرفع السجل التجاري", "أرسل طلب التوثيق"]) assert.equal(isPossibleBusinessMessage(message), true, message);
  const router = await register("router");
  await newBusiness(router, `مطعم التوجيه ${runId}`);
  const conv = await conversation(router);
  const fresh = await turn(router, conv, "وين وصل طلبي؟");
  assert.notEqual(fresh.payload.surface, "BUSINESS_PROFILE", "without its card, «طلبي» stays an order question");
  const card = await turn(router, conv, "اعرض نشاطي");
  assert.equal(card.payload.surface, "BUSINESS_PROFILE", card.raw);
  for (const message of ["تتبع طلبي", "وين وصل طلبي رقم 12345", "ابحث عن هاتف"]) {
    const reply = await turn(router, conv, message);
    assert.notEqual(reply.payload.surface, "BUSINESS_PROFILE", message);
    assert.equal((await turn(router, conv, "اعرض نشاطي")).payload.commerce.business.status, "DRAFT");
  }
  const status = await turn(router, conv, "وين وصل طلبي؟");
  assert.equal(status.payload.surface, "BUSINESS_PROFILE");
  assert.match(status.text, /مسودة لم تُرسل للتحقق/u);
});

await test("D2-19 every D1/D2 route has an OpenAPI contract", () => {
  const spec = readFileSync(new URL("../../../lib/api-spec/openapi.yaml", import.meta.url.replace("/.test-build/", "/test/")), "utf8");
  const routes = ["../src/routes/business-profiles.ts", "../src/routes/businesses.ts", "../src/routes/business-delegations.ts", "../src/routes/integrations.ts", "../src/routes/commercial.ts"].flatMap((file) =>
    [...readFileSync(new URL(file, import.meta.url.replace("/.test-build/", "/test/")), "utf8").matchAll(/router\.(get|post|patch|put|delete)\("([^"]+)"/g)].map((match) => ({ method: match[1]!, path: match[2]!.replace(/:([A-Za-z]+)/g, "{$1}") })),
  );
  const d1d2 = routes.filter((route) => /^\/(?:business|businesses|subscriptions|billing|admin\/business-verification|admin\/subscription-plans)/.test(route.path));
  assert.ok(d1d2.length >= 20, `${d1d2.length} D1/D2 routes`);
  const operation = (path: string, method: string) => {
    const at = spec.indexOf(`\n  ${path}:\n`);
    if (at < 0) return false;
    const next = spec.slice(at + 1).search(/\n  \/|\ncomponents:/);
    return spec.slice(at, next < 0 ? undefined : at + 1 + next).includes(`\n    ${method}:`);
  };
  const missing = d1d2.filter((route) => !operation(route.path, route.method));
  assert.deepEqual(missing, [], "routes without an OpenAPI operation");
});

// ─── Shared journey ──────────────────────────────────────────────────────────

await test("J-01 the shared D1+D2 journey (13 steps) through the unified conversation", async () => {
  const journey = await register("journey");                                                       // 1
  const plans = await request("/subscriptions/plans", "GET", undefined, journey.cookie);               // 2
  assert.ok(plans.data.plans.filter((item: any) => item.planCode !== "DINAR_BUSINESS").every((item: any) => item.eligible && !item.requiresDocuments));
  const conv = await conversation(journey);
  const intro = await turn(journey, conv, "دينار، أنا صاحب مطعم اسمه سمراء للمشاوي في الكويت، وأريد أضيفه إلى دينار.");   // 3
  assert.equal(intro.payload.surface, "BUSINESS_PROFILE", intro.raw);
  const card = intro.payload.commerce.business;                                                     // 4–5
  assert.deepEqual([card.displayName, card.categoryLabel, card.marketLabel, card.status], ["سمراء للمشاوي", "مطعم ومشاوي", "الكويت", "DRAFT"]);
  assert.match(intro.payload.prompt, /غير موثّقة/u);
  assert.doesNotMatch(intro.payload.prompt, /تم توثيق|نشاطك موثّق|تم تفعيل/u);
  const info = await turn(journey, conv, "الاسم القانوني مؤسسة سمراء للمشاوي ورقم السجل 445566");                      // 6
  assert.equal(info.payload.commerce.business.registrationNumberLast4, "5566");
  const upload = await turn(journey, conv, "أبي أرفع السجل التجاري");
  assert.ok(upload.payload.commerce.business.actions.some((action: any) => action.key === "UPLOAD_DOCUMENTS"));
  registerBusinessDocumentScanner(mockScanner);
  try {
    const uploaded = await uploadDocument(journey, card.id, PDF);                                    // 7
    assert.equal(uploaded.complete?.status, 200, uploaded.complete?.raw);
    const submitted = await turn(journey, conv, "أرسل طلب التوثيق");
    assert.equal(submitted.payload.commerce.business.status, "PENDING_REVIEW", submitted.raw);
    const waiting = await turn(journey, conv, "وين وصل طلبي؟");
    assert.match(waiting.payload.prompt, /بانتظار مراجع جاسم/u);
    const decision = await decide(card.id, "VERIFY");                                                // 8–9
    assert.equal(decision.status, 200, decision.raw);
  } finally {
    unregisterBusinessDocumentScanner();
  }
  const verified = await turn(journey, conv, "وين وصل طلبي؟");
  assert.match(verified.payload.prompt, /موثّق من مراجع جاسم/u);
  const business = await turn(journey, conv, "أبي أشترك في بزنس");                                     // 10–12
  assert.match(business.payload.prompt, /49 دولار/u);
  assert.match(business.payload.prompt, /غير متاح الآن|الفوترة غير موصولة/u);
  assert.match(business.payload.prompt, /موثّق/u);
  assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, journey.id))).length, 0, "no subscription row, no charge");
  assert.equal((await aiPlanFor(journey.id, kw)).tier, "FREE");
  const compare = await turn(journey, conv, "دينار، ما الفرق بين جو وبرو؟");
  assert.equal(compare.payload.surface, "AI_PLANS");
  assert.match(compare.payload.prompt, /جاسم جو/u);
  assert.match(compare.payload.prompt, /جاسم برو/u);
  assert.match(compare.payload.prompt, /لا يحتاج سجلًا تجاريًا/u);
  const usage = await turn(journey, conv, "كم بقي من استخدامي؟");
  assert.equal(usage.payload.surface, "AI_USAGE", usage.raw);
  // 13: log out; another account never sees this business, its card or its documents.
  assert.equal((await request("/auth/logout", "POST", {}, journey.cookie)).status < 400, true);
  assert.equal((await request(`/business/profiles/${card.id}`, "GET", undefined, journey.cookie)).status, 401);
  const stranger = await register("stranger");
  assert.equal((await request(`/business/profiles/${card.id}`, "GET", undefined, stranger.cookie)).status, 404);
  assert.equal((await request(`/ai/conversations/${conv}`, "GET", undefined, stranger.cookie)).status, 404);
  const strangerConv = await conversation(stranger);
  const strangerStatus = await turn(stranger, strangerConv, "وش صار على توثيق مطعمي");
  assert.ok(!strangerStatus.raw.includes(card.id) && !strangerStatus.raw.includes("5566"), "nothing of the other account's business");
  assert.match(strangerStatus.text, /لا يوجد لديك نشاط تجاري/u);
  assert.equal(getModelGatewayCallCount(), 0);
});

await test("D2-06b integration requests: SSRF guard, no credentials, verified business only, nothing connected", async () => {
  for (const refused of ["http://pos.example.com", "https://127.0.0.1/api", "https://10.0.0.5", "https://localhost/x", "https://user:pw@pos.example.com", "https://pos.example.com:8443", "https://metadata.google.internal", "https://[::1]/", "https://2130706433/"])
    assert.throws(() => validateIntegrationEndpoint(refused), refused);
  assert.equal(validateIntegrationEndpoint("https://api.pos.example.com/v1"), "https://api.pos.example.com/v1");
  const verifiedId = samraa.verifiedSibling;
  const withSecret = await request(`/business/profiles/${verifiedId}/integration-requests`, "POST", { kind: "POS", systemName: "Foodics", scopes: ["CATALOG_READ"], apiKey: "sk-test" }, owner.cookie);
  assert.equal(withSecret.status, 400, "no credential is accepted");
  const writeScope = await request(`/business/profiles/${verifiedId}/integration-requests`, "POST", { kind: "POS", systemName: "Foodics", scopes: ["CATALOG_WRITE"] }, owner.cookie);
  assert.equal(writeScope.status, 400, "read-only scopes first");
  const requested = await request(`/business/profiles/${verifiedId}/integration-requests`, "POST", { kind: "POS", systemName: "Foodics", endpointUrl: "https://api.pos.example.com/v1", scopes: ["CATALOG_READ", "ORDERS_READ"] }, owner.cookie);
  assert.equal(requested.status, 201, requested.raw);
  assert.equal(requested.data.integrations.requests.at(-1).status, "ADAPTER_UNAVAILABLE");
  assert.deepEqual(requested.data.integrations.adaptersAvailable, []);
  const draft = await newBusiness(owner, `محل جديد ${runId}`);
  assert.equal((await request(`/business/profiles/${draft.id}/integration-requests`, "POST", { kind: "POS", systemName: "x y", scopes: ["CATALOG_READ"] }, owner.cookie)).status, 409);
});

after(async () => {
  server.close();
  await localObjectStorage?.close();
  await pool.end();
});
