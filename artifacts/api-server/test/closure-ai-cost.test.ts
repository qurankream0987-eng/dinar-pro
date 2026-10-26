/**
 * DINAR NEXT pre-integration closure — Phase 3: monetary AI cost accounting.
 * Real ledger on a disposable loopback database; prices are TEST_PLACEHOLDER rows written by
 * this suite (never real provider prices). No provider is contacted: model calls go through
 * scripted gateways that behave like providers (usage, request ids, failures).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { aiCostEvents, aiModelPrices, aiSpendCounters, aiSpendHolds, aiUsageReservations, commercialPolicies, db, users } from "@workspace/db";
import app from "../src/app";
import { reserveAiUsage, settleAiUsage, reconcileAbandonedAiReservations, ownerKeyOf, type AiUsageOwner } from "../src/lib/ai-usage";
import { DEFAULT_AI_USAGE_POLICY, usagePeriod, type AiUsagePolicy } from "../src/lib/ai-usage-policy";
import { aiSpendSummary, applicablePrice, callCostMicros, holdAiSpend, meteredPlatformGateway, GLOBAL_SPEND_SCOPE, reconcileFromBillingSource, reconcileProviderBilling, spendRequired, type AiBillingSource } from "../src/lib/ai-spend";
import { AIProviderError, describeAIModelReadiness, resolveAIModelRuntimeConfiguration, safeProviderBaseUrl, type ConversationModelGateway, type ProposedToolCall } from "../src/ai/model-gateway";
import { interpretWithModel } from "../src/ai/model-turn";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_CLOSURE_ACCEPTANCE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ipSequence = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "", headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Forwarded-For": `198.31.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}`,
      ...headers,
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : typeof body === "string" || Buffer.isBuffer(body) ? (body as any) : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_520_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string) {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Closure-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR closure ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id as string, cookie: registered.cookie, password };
}

// ─── Test policy and placeholder prices ──────────────────────────────────────
const req = (n: number) => ({ TEXT_REQUEST: n, MARKETING_GENERATION: n, BUSINESS_ANALYTICS: n, IMAGE_UNDERSTANDING: n, AGENT_MULTI_STEP: n, AUDIO_TRANSCRIPTION: n });
const HOLD = 10_000; // 0.01 USD per operation
function policyWith(spend: Partial<AiUsagePolicy["spend"]>): AiUsagePolicy {
  return {
    ...DEFAULT_AI_USAGE_POLICY,
    tiers: {
      GUEST: { requests: req(50), tokens: 10_000_000 },
      FREE: { requests: req(100), tokens: 10_000_000 },
      BUSINESS_GO: { requests: req(100), tokens: 10_000_000 },
      BUSINESS_PRO: { requests: req(100), tokens: 10_000_000 },
    },
    tokenEstimates: req(1_000),
    spend: { ...DEFAULT_AI_USAGE_POLICY.spend, holdMicros: req(HOLD), ...spend },
  };
}
let policyVersion = 9_000;
async function setPolicy(policy: AiUsagePolicy) {
  await db.insert(commercialPolicies).values({ id: randomUUID(), marketId: "JO", version: ++policyVersion, effectiveFrom: new Date(Date.now() - 1_000), policy: { aiUsage: policy } });
}
const PROVIDER = "REPLIT_OPENAI";
const MODEL = `closure-model-${randomUUID().slice(0, 6)}`;
const FALLBACK_MODEL = `closure-fallback-${randomUUID().slice(0, 6)}`;
const priceIds: string[] = [];
async function price(model: string, values: Partial<typeof aiModelPrices.$inferInsert> = {}) {
  const id = randomUUID();
  priceIds.push(id);
  await db.insert(aiModelPrices).values({
    id,
    provider: PROVIDER,
    model,
    version: 1,
    currencyCode: "USD",
    inputPerMillionMicros: 2_000_000, // $2 / 1M input tokens (placeholder)
    outputPerMillionMicros: 8_000_000, // $8 / 1M output tokens (placeholder)
    cachedInputPerMillionMicros: 500_000,
    source: "TEST_PLACEHOLDER",
    effectiveFrom: new Date(Date.now() - 86_400_000),
    ...values,
  });
}

async function spendCounter(scopeKey: string, periodStart: Date) {
  const [row] = await db.select().from(aiSpendCounters).where(and(eq(aiSpendCounters.scopeKey, scopeKey), eq(aiSpendCounters.periodStart, periodStart), eq(aiSpendCounters.currencyCode, "USD")));
  return row;
}
const globalStart = () => usagePeriod(DEFAULT_AI_USAGE_POLICY.spend.global.period, new Date()).start;
const eventsOf = (reservationId: string) => db.select().from(aiCostEvents).where(eq(aiCostEvents.usageReservationId, reservationId)).orderBy(aiCostEvents.callIndex);

let user: Awaited<ReturnType<typeof register>>;
let owner: AiUsageOwner;
await test("setup: users, placeholder prices, uncapped policy", async () => {
  user = await register("cost");
  owner = { kind: "USER", userId: user.id, market: { id: "JO" } };
  await price(MODEL, { cacheWriteInputPerMillionMicros: 2_500_000, cacheWrite12hInputPerMillionMicros: 5_000_000 });
  await price(FALLBACK_MODEL, { inputPerMillionMicros: 1_000_000, outputPerMillionMicros: 4_000_000, cacheWriteInputPerMillionMicros: 1_250_000, cacheWrite12hInputPerMillionMicros: 2_500_000 });
  await setPolicy(policyWith({}));
});

await test("C3-01 price math: cached tokens, ceiling rounding, unpriced units and foreign currency are never zero", async () => {
  const [row] = await db.select().from(aiModelPrices).where(eq(aiModelPrices.id, priceIds[0]!));
  // 1000 input of which 400 cached, 200 output: 600×$2/M + 400×$0.5/M + 200×$8/M = 1200 + 200 + 1600 µ$
  assert.equal(callCostMicros(row, { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200, imageUnits: 0, audioSeconds: 0 }, "USD"), 3_000);
  // Input is partitioned, never double-charged: 4000×$2/M + 2000×$0.5/M + 3000×$2.5/M + 1000×$5/M.
  assert.equal(callCostMicros(row, { inputTokens: 10_000, cachedInputTokens: 2_000, cacheWriteInputTokens: 4_000, cacheWrite12hInputTokens: 1_000, outputTokens: 0, imageUnits: 0, audioSeconds: 0 }, "USD"), 21_500);
  assert.equal(callCostMicros({ ...row!, cacheWriteInputPerMillionMicros: null, cacheWrite12hInputPerMillionMicros: null }, { inputTokens: 10_000, cachedInputTokens: 0, cacheWriteInputTokens: 1_000, outputTokens: 0, imageUnits: 0, audioSeconds: 0 }, "USD"), undefined, "a cache write without a registered rate is unpriced, never undercharged");
  assert.equal(callCostMicros(row, { inputTokens: 1, cachedInputTokens: 1, outputTokens: 0, imageUnits: 0, audioSeconds: 0 }, "USD"), 1, "half a micro rounds up, never down to zero");
  assert.equal(callCostMicros(row, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, imageUnits: 2, audioSeconds: 0 }, "USD"), undefined, "image units without an image price are unpriced");
  assert.equal(callCostMicros(row, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, imageUnits: 0, audioSeconds: 0 }, "JOD"), undefined, "no silent currency conversion");
  assert.equal(callCostMicros(undefined, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, imageUnits: 0, audioSeconds: 0 }, "USD"), undefined);
});

await test("C3-02 a reported call is priced per call; counters move from held to spent exactly", async () => {
  const before = (await spendCounter(GLOBAL_SPEND_SCOPE, globalStart()))?.spentMicros ?? 0;
  const reserved = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c302-${randomUUID()}` });
  assert.ok(reserved.ok);
  const [hold] = await db.select().from(aiSpendHolds).where(eq(aiSpendHolds.usageReservationId, reserved.reservation.id));
  assert.equal(hold!.status, "HELD");
  assert.equal(hold!.reservedMicros, HOLD);
  assert.equal(hold!.enforced, false, "no cap configured → recorded, not enforced (development)");
  await settleAiUsage(reserved.reservation.id, {
    outcome: "SUCCESS",
    providerCalls: 1,
    calls: [{ kind: "PRIMARY", outcome: "SUCCESS", provider: PROVIDER, model: MODEL, inputTokens: 250_000, cachedInputTokens: 50_000, cacheWriteInputTokens: 100_000, cacheWrite12hInputTokens: 20_000, outputTokens: 10_000, providerRequestId: `req-${randomUUID()}` }],
  });
  const [event] = await eventsOf(reserved.reservation.id);
  // 100k×$2/M + 50k×$0.5/M + 80k×$2.5/M + 20k×$5/M + 10k×$8/M = $0.605.
  assert.equal(event!.cacheWriteInputTokens, 100_000);
  assert.equal(event!.cacheWrite12hInputTokens, 20_000);
  assert.equal(event!.estimatedCostMicros, 605_000);
  assert.equal(event!.costStatus, "ESTIMATED");
  assert.equal(event!.usageSource, "PROVIDER_REPORTED");
  assert.equal(event!.finalCostMicros, null, "estimated until the provider bill confirms it");
  const after = await spendCounter(GLOBAL_SPEND_SCOPE, globalStart());
  assert.equal(after!.spentMicros - before, 605_000);
  const [settledHold] = await db.select().from(aiSpendHolds).where(eq(aiSpendHolds.id, hold!.id));
  assert.equal(settledHold!.status, "SETTLED");
  assert.equal(settledHold!.chargedMicros, 605_000);
  // Settling twice changes nothing.
  await settleAiUsage(reserved.reservation.id, { outcome: "SUCCESS", providerCalls: 1 });
  assert.equal((await spendCounter(GLOBAL_SPEND_SCOPE, globalStart()))!.spentMicros - before, 605_000);
});

await test("C3-03 an unknown model is UNPRICED and charged its full hold, counted as unpriced", async () => {
  const before = await spendCounter(GLOBAL_SPEND_SCOPE, globalStart());
  const reserved = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c303-${randomUUID()}` });
  assert.ok(reserved.ok);
  await settleAiUsage(reserved.reservation.id, {
    outcome: "SUCCESS",
    providerCalls: 1,
    calls: [{ kind: "PRIMARY", outcome: "SUCCESS", provider: PROVIDER, model: "model-without-price", inputTokens: 10, outputTokens: 10 }],
  });
  const [event] = await eventsOf(reserved.reservation.id);
  assert.equal(event!.costStatus, "UNPRICED");
  assert.equal(event!.estimatedCostMicros, null);
  assert.equal(event!.budgetChargedMicros, HOLD, "unknown cost is never treated as zero");
  const after = await spendCounter(GLOBAL_SPEND_SCOPE, globalStart());
  assert.equal(after!.spentMicros - (before?.spentMicros ?? 0), HOLD);
  assert.equal(after!.unpricedCalls - (before?.unpricedCalls ?? 0), 1);
});

await test("C3-04 retries and a fallback are separate cost events of one operation", async () => {
  let primaryCalls = 0;
  const answer = (model: string): ProposedToolCall => ({
    id: "t",
    name: "dinarConversationTurn",
    arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "مرحبًا" }),
    provider: PROVIDER,
    requestedModel: model,
    actualModel: model,
    usage: { inputTokens: 1_000, cachedInputTokens: 100, cacheWriteInputTokens: 300, cacheWrite12hInputTokens: 50, outputTokens: 100 },
    providerRequestId: `req-${randomUUID()}`,
  });
  const fallback: ConversationModelGateway = { providerInfo: { provider: PROVIDER, requestedModel: FALLBACK_MODEL }, async proposeToolCall() { return answer(FALLBACK_MODEL); } };
  const primary: ConversationModelGateway = {
    providerInfo: { provider: PROVIDER, requestedModel: MODEL },
    fallback,
    async proposeToolCall() {
      primaryCalls += 1;
      throw new AIProviderError(PROVIDER, "UNAVAILABLE", MODEL, 3, 503);
    },
  };
  const result = await interpretWithModel(primary, "سؤال عام", {}, 20_000);
  assert.equal(result.ok, true);
  assert.equal(primaryCalls, 2, "one retry of a transient outage on the primary");
  assert.deepEqual(result.modelCall.calls!.map((call) => `${call.kind}:${call.outcome}`), ["PRIMARY:FAILED", "RETRY:FAILED", "FALLBACK:SUCCESS"]);
  const reserved = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c304-${randomUUID()}` });
  assert.ok(reserved.ok);
  await settleAiUsage(reserved.reservation.id, { outcome: "SUCCESS", providerCalls: 3, calls: result.modelCall.calls });
  const events = await eventsOf(reserved.reservation.id);
  assert.deepEqual(events.map((event) => event.callKind), ["PRIMARY", "RETRY", "FALLBACK"]);
  assert.equal(result.modelCall.calls![2]!.cacheWriteInputTokens, 300, "the model turn carries provider cache-write usage into production accounting");
  assert.equal(result.modelCall.calls![2]!.cacheWrite12hInputTokens, 50);
  // Failed calls have no usage and are priced conservatively as output estimates. The fallback
  // reports mixed input/cache-write/output: total 1,487.5 µ$ rounds up to 1,488.
  assert.deepEqual(events.map((event) => [event.usageSource, event.estimatedCostMicros]), [["MISSING", 8_000], ["MISSING", 8_000], ["PROVIDER_REPORTED", 1_488]]);
  // A non-transient failure (quota) is not retried, but the fallback still answers.
  primaryCalls = 0;
  const quota: ConversationModelGateway = { providerInfo: primary.providerInfo, fallback, async proposeToolCall() { primaryCalls += 1; throw new AIProviderError(PROVIDER, "QUOTA_LIMITED", MODEL, 2, 429); } };
  const second = await interpretWithModel(quota, "سؤال", {}, 20_000);
  assert.equal(second.ok, true);
  assert.equal(primaryCalls, 1);
  // No fallback configured: the same failure stays honest.
  const alone = await interpretWithModel({ providerInfo: primary.providerInfo, async proposeToolCall() { throw new AIProviderError(PROVIDER, "QUOTA_LIMITED", MODEL); } }, "سؤال", {}, 20_000);
  assert.equal(alone.ok, false);
});

await test("C3-05 a real monetary global cap holds under concurrency (no overspend)", async () => {
  // Fresh global period scope: the cap counts what is already spent today, so set it relative to that.
  const spent = (await spendCounter(GLOBAL_SPEND_SCOPE, globalStart()))?.spentMicros ?? 0;
  await setPolicy(policyWith({ global: { period: DEFAULT_AI_USAGE_POLICY.spend.global.period, limitMicros: spent + 3 * HOLD } }));
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c305-${index}-${randomUUID()}` })));
  const granted = results.filter((item) => item.ok);
  assert.equal(granted.length, 3);
  assert.ok(results.filter((item) => !item.ok).every((item) => !item.ok && item.reason === "GLOBAL_SPEND_EXHAUSTED"));
  const row = await spendCounter(GLOBAL_SPEND_SCOPE, globalStart());
  assert.ok(row!.reservedMicros + row!.spentMicros <= spent + 3 * HOLD);
  // Refused requests consumed no allowance either (one transaction).
  const refusedKeys = results.filter((item) => !item.ok).length;
  assert.equal(refusedKeys, 7);
  // Releasing (no provider call) returns the money.
  for (const item of granted) if (item.ok) await settleAiUsage(item.reservation.id, { outcome: "CANCELLED", providerCalls: 0 });
  const released = await spendCounter(GLOBAL_SPEND_SCOPE, globalStart());
  assert.equal(released!.spentMicros, row!.spentMicros);
  assert.equal(released!.reservedMicros, row!.reservedMicros - 3 * HOLD);
});

await test("C3-06 account-level and plan-level money caps refuse with their own reasons", async () => {
  const other = await register("cost-account");
  const otherOwner: AiUsageOwner = { kind: "USER", userId: other.id, market: { id: "JO" } };
  await setPolicy(policyWith({ perAccount: { GUEST: null, FREE: 2 * HOLD, BUSINESS_GO: null, BUSINESS_PRO: null } }));
  const a = await reserveAiUsage({ owner: otherOwner, resource: "TEXT_REQUEST", idempotencyKey: `c306a-${randomUUID()}` });
  const b = await reserveAiUsage({ owner: otherOwner, resource: "TEXT_REQUEST", idempotencyKey: `c306b-${randomUUID()}` });
  const c = await reserveAiUsage({ owner: otherOwner, resource: "TEXT_REQUEST", idempotencyKey: `c306c-${randomUUID()}` });
  assert.ok(a.ok && b.ok);
  assert.equal(!c.ok && c.reason, "ACCOUNT_SPEND_EXHAUSTED");
  if (a.ok) await settleAiUsage(a.reservation.id, { outcome: "CANCELLED", providerCalls: 0 });
  if (b.ok) await settleAiUsage(b.reservation.id, { outcome: "CANCELLED", providerCalls: 0 });
  const planSpent = (await spendCounter("spend:plan:FREE", globalStart()));
  await setPolicy(policyWith({ perPlan: { GUEST: null, FREE: (planSpent?.spentMicros ?? 0) + (planSpent?.reservedMicros ?? 0), BUSINESS_GO: null, BUSINESS_PRO: null } }));
  const d = await reserveAiUsage({ owner: otherOwner, resource: "TEXT_REQUEST", idempotencyKey: `c306d-${randomUUID()}` });
  assert.equal(!d.ok && d.reason, "PLAN_SPEND_EXHAUSTED");
  await setPolicy(policyWith({}));
});

await test("C3-07 where spend is required, no configured budget means no paid call; placeholder prices are ignored", async () => {
  process.env.DINAR_AI_SPEND_REQUIRED = "true";
  try {
    assert.equal(spendRequired(), true);
    const refused = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c307-${randomUUID()}` });
    assert.equal(!refused.ok && refused.reason, "SPEND_BUDGET_UNCONFIGURED");
    const [none] = await db.select().from(aiUsageReservations).where(eq(aiUsageReservations.ownerKey, ownerKeyOf(owner))).limit(1);
    assert.ok(none, "earlier reservations exist");
    // With a budget, a TEST_PLACEHOLDER price is not applied: the call is UNPRICED.
    await setPolicy(policyWith({ global: { period: DEFAULT_AI_USAGE_POLICY.spend.global.period, limitMicros: 1_000_000_000 } }));
    const reserved = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c307b-${randomUUID()}` });
    assert.ok(reserved.ok, JSON.stringify(reserved));
    await settleAiUsage(reserved.reservation.id, { outcome: "SUCCESS", providerCalls: 1, calls: [{ kind: "PRIMARY", outcome: "SUCCESS", provider: PROVIDER, model: MODEL, inputTokens: 100, outputTokens: 10 }] });
    const [event] = await eventsOf(reserved.reservation.id);
    assert.equal(event!.costStatus, "UNPRICED");
    assert.equal(event!.budgetChargedMicros, HOLD);
  } finally {
    delete process.env.DINAR_AI_SPEND_REQUIRED;
    await setPolicy(policyWith({}));
  }
});

await test("C3-08 unpricedModel=REFUSE refuses an unpriced model before any call or allowance is used", async () => {
  await setPolicy(policyWith({ unpricedModel: "REFUSE" }));
  const refused = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c308-${randomUUID()}`, expectedModel: { provider: PROVIDER, model: "unpriced-model" } });
  assert.equal(!refused.ok && refused.reason, "MODEL_UNPRICED");
  const allowed = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c308b-${randomUUID()}`, expectedModel: { provider: PROVIDER, model: MODEL } });
  assert.ok(allowed.ok);
  if (allowed.ok) await settleAiUsage(allowed.reservation.id, { outcome: "CANCELLED", providerCalls: 0 });
  await setPolicy(policyWith({}));
});

await test("C3-08b enforced OpenAI spend refuses missing cache-write rates even when unpriced calls are otherwise held", async () => {
  const models = ["OPENAI", "OPENAI_COMPATIBLE"].map((provider) => ({
    provider,
    model: `closure-openai-unpriced-${randomUUID().slice(0, 6)}`,
  }));
  for (const item of models)
    await price(item.model, { provider: item.provider, cacheWriteInputPerMillionMicros: null, cacheWrite12hInputPerMillionMicros: null });
  const previous = process.env.DINAR_AI_SPEND_REQUIRED;
  process.env.DINAR_AI_SPEND_REQUIRED = "true";
  try {
    await setPolicy(policyWith({
      global: { period: DEFAULT_AI_USAGE_POLICY.spend.global.period, limitMicros: 1_000_000 },
      unpricedModel: "CHARGE_HOLD",
    }));
    for (const item of models) {
      const result = await reserveAiUsage({
        owner,
        resource: "TEXT_REQUEST",
        idempotencyKey: `c308c-${randomUUID()}`,
        expectedModel: item,
      });
      assert.equal(!result.ok && result.reason, "MODEL_UNPRICED", item.provider);
    }
  } finally {
    if (previous === undefined) delete process.env.DINAR_AI_SPEND_REQUIRED;
    else process.env.DINAR_AI_SPEND_REQUIRED = previous;
    await setPolicy(policyWith({}));
  }
});

await test("C3-09 versioned prices: a newer version applies from its effective date only", async () => {
  const model = `closure-versioned-${randomUUID().slice(0, 6)}`;
  await price(model, { version: 1, inputPerMillionMicros: 1_000_000, outputPerMillionMicros: 1_000_000, effectiveFrom: new Date(Date.now() - 86_400_000) });
  await price(model, { version: 2, inputPerMillionMicros: 3_000_000, outputPerMillionMicros: 3_000_000, effectiveFrom: new Date(Date.now() + 3_600_000) });
  const reserved = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c309-${randomUUID()}` });
  assert.ok(reserved.ok);
  await settleAiUsage(reserved.reservation.id, { outcome: "SUCCESS", providerCalls: 1, calls: [{ kind: "PRIMARY", outcome: "SUCCESS", provider: PROVIDER, model, inputTokens: 500_000, outputTokens: 500_000 }] });
  const [event] = await eventsOf(reserved.reservation.id);
  assert.equal(event!.estimatedCostMicros, 1_000_000, "version 1 ($1/M) applies now, not the future version 2");
});

await test("C3-10 reconciliation: billed calls become FINAL and correct the counters; gaps are reported, never invented", async () => {
  const requestId = `bill-${randomUUID()}`;
  const missingId = `bill-missing-${randomUUID()}`;
  const start = new Date(Date.now() - 60_000);
  const reserved = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c310-${randomUUID()}` });
  assert.ok(reserved.ok);
  await settleAiUsage(reserved.reservation.id, {
    outcome: "SUCCESS",
    providerCalls: 2,
    calls: [
      { kind: "PRIMARY", outcome: "SUCCESS", provider: "CLOSURE_BILLING", model: "m", inputTokens: 10, outputTokens: 10, providerRequestId: requestId },
      { kind: "RETRY", outcome: "FAILED", provider: "CLOSURE_BILLING", model: "m" },
    ],
  });
  const events = await eventsOf(reserved.reservation.id);
  const charged = events.reduce((sum, event) => sum + event.budgetChargedMicros, 0);
  const before = (await spendCounter(GLOBAL_SPEND_SCOPE, globalStart()))!.spentMicros;
  const end = new Date(Date.now() + 60_000);
  const run = await reconcileProviderBilling({ provider: "CLOSURE_BILLING", periodStart: start, periodEnd: end, currencyCode: "USD", items: [{ providerRequestId: requestId, costMicros: 4_321 }, { providerRequestId: missingId, costMicros: 99 }], source: "test-export" });
  assert.equal(run.matchedEvents, 1);
  assert.equal(run.unmatchedProviderItems, 1, "a billed item DINAR never recorded is a discrepancy");
  assert.equal(run.unreportedLocalEvents, 1, "a recorded call the bill does not cover stays open");
  assert.equal(run.status, "DISCREPANCY");
  const [final] = await db.select().from(aiCostEvents).where(eq(aiCostEvents.providerRequestId, requestId));
  assert.equal(final!.costStatus, "FINAL");
  assert.equal(final!.finalCostMicros, 4_321);
  const after = (await spendCounter(GLOBAL_SPEND_SCOPE, globalStart()))!.spentMicros;
  assert.equal(after - before, 4_321 - events[0]!.budgetChargedMicros, "counters corrected by the difference only");
  assert.ok(charged >= HOLD, "the unpriced retry was charged its hold");
  // Re-running is idempotent for FINAL rows.
  const again = await reconcileProviderBilling({ provider: "CLOSURE_BILLING", periodStart: start, periodEnd: end, currencyCode: "USD", items: [{ providerRequestId: requestId, costMicros: 4_321 }], source: "test-export" });
  assert.equal(again.status, "INCOMPLETE");
  assert.equal((await spendCounter(GLOBAL_SPEND_SCOPE, globalStart()))!.spentMicros, after);
  // A provider without a billing export is reported as unavailable, not reconciled.
  const unavailable: AiBillingSource = { provider: "CLOSURE_BILLING", async fetchBilledItems() { return { available: false }; } };
  assert.deepEqual(await reconcileFromBillingSource(unavailable, { start, end }), { available: false });
});

await test("C3-11 an abandoned reservation is charged one unknown call at its hold (conservative)", async () => {
  const now = new Date();
  const reserved = await reserveAiUsage({ owner, resource: "TEXT_REQUEST", idempotencyKey: `c311-${randomUUID()}`, now });
  assert.ok(reserved.ok);
  await reconcileAbandonedAiReservations({ ownerKey: ownerKeyOf(owner), now: new Date(now.getTime() + 3_600_000) });
  const [hold] = await db.select().from(aiSpendHolds).where(eq(aiSpendHolds.usageReservationId, reserved.reservation.id));
  assert.equal(hold!.status, "EXPIRED");
  assert.equal(hold!.chargedMicros, HOLD);
  const [event] = await eventsOf(reserved.reservation.id);
  assert.equal(event!.callOutcome, "ABANDONED");
  assert.equal(event!.costStatus, "UNPRICED");
});

await test("C3-12 voice transcription is metered: refused without allowance; an unconfigured provider charges nothing", async () => {
  const zeroAudio = policyWith({});
  zeroAudio.tiers.FREE.requests.AUDIO_TRANSCRIPTION = 0;
  await setPolicy(zeroAudio);
  const voice = () => fetch(`${base}/ai/voice-transcription`, { method: "POST", headers: { "Content-Type": "audio/webm", Cookie: user.cookie, "X-Forwarded-For": `198.31.251.${ipSequence++ % 250}` }, body: Buffer.from([1, 2, 3, 4]) });
  const refused = await voice();
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).code, "NOT_INCLUDED");
  await setPolicy(policyWith({}));
  const before = (await spendCounter(GLOBAL_SPEND_SCOPE, globalStart()))!;
  const unconfigured = await voice();
  assert.equal(unconfigured.status, 503, "no transcription provider credential in tests");
  const [latest] = await db.select().from(aiUsageReservations).where(and(eq(aiUsageReservations.ownerKey, ownerKeyOf(owner)), eq(aiUsageReservations.resource, "AUDIO_TRANSCRIPTION")));
  assert.equal(latest!.status, "RELEASED");
  assert.equal(latest!.chargedRequests, 0);
  const after = (await spendCounter(GLOBAL_SPEND_SCOPE, globalStart()))!;
  assert.equal(after.spentMicros, before.spentMicros, "no provider was reached: nothing spent");
  assert.equal(after.reservedMicros, before.reservedMicros);
});

await test("C3-13 the spend summary reports recorded money honestly (configured flag, unpriced count)", async () => {
  const summary = await aiSpendSummary(policyWith({}));
  assert.equal(summary.configured, false);
  assert.equal(summary.currencyCode, "USD");
  assert.ok(summary.global.spentMicros > 0);
  assert.ok(summary.global.unpricedCalls >= 1);
  assert.ok(summary.costStatuses.some((row) => row.status === "UNPRICED"));
});

await test("C3-14 background model calls (memory extraction) are held, recorded per call and capped; refused → no gateway", async () => {
  const scripted: ConversationModelGateway = {
    providerInfo: { provider: PROVIDER, requestedModel: MODEL },
    async proposeToolCall() {
      return { id: "m", name: "personalMemoryCandidates", arguments: "{\"candidates\":[]}", provider: PROVIDER, requestedModel: MODEL, actualModel: MODEL, usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
  const policy = policyWith({});
  const metered = await meteredPlatformGateway(scripted, { purpose: "PLATFORM_MEMORY_EXTRACTION", resource: "TEXT_REQUEST", policy });
  assert.ok(metered.gateway);
  await metered.gateway!.proposeToolCall([], []);
  await metered.settle();
  await metered.settle();
  const [hold] = await db.select().from(aiSpendHolds).where(eq(aiSpendHolds.ownerKey, "platform:PLATFORM_MEMORY_EXTRACTION"));
  assert.equal(hold!.status, "SETTLED");
  const events = await db.select().from(aiCostEvents).where(eq(aiCostEvents.holdId, hold!.id));
  assert.equal(events.length, 1, "settled once even when settle is called twice");
  // 100 in × $2/M + 10 out × $8/M = 200 + 80 µ$
  assert.equal(events[0]!.estimatedCostMicros, 280);
  const unused = await meteredPlatformGateway(scripted, { purpose: "PLATFORM_MEMORY_EXTRACTION", resource: "TEXT_REQUEST", policy });
  await unused.settle();
  const holds = await db.select().from(aiSpendHolds).where(eq(aiSpendHolds.ownerKey, "platform:PLATFORM_MEMORY_EXTRACTION"));
  assert.ok(holds.some((row) => row.status === "RELEASED"), "no call made → hold released, nothing spent");
  process.env.DINAR_AI_SPEND_REQUIRED = "true";
  try {
    const refused = await meteredPlatformGateway(scripted, { purpose: "PLATFORM_MEMORY_EXTRACTION", resource: "TEXT_REQUEST", policy });
    assert.equal(refused.gateway, undefined, "without an approved budget the background call is not made");
  } finally {
    delete process.env.DINAR_AI_SPEND_REQUIRED;
  }
});

await test("C5-01 model runtime configuration: provider-neutral slot, fallback, retries, safe endpoints, secret-free readiness", () => {
  const env = {
    NODE_ENV: "development",
    DINAR_AI_PROVIDER: "OPENAI_COMPATIBLE",
    DINAR_AI_MODEL: "owner-approved-model",
    DINAR_AI_BASE_URL: "https://models.example.test/v1",
    DINAR_AI_API_KEY: "sk-closure-secret-value",
    DINAR_AI_FALLBACK_PROVIDER: "OPENAI_COMPATIBLE",
    DINAR_AI_FALLBACK_MODEL: "owner-fallback-model",
    DINAR_AI_FALLBACK_BASE_URL: "http://evil.example.test/v1",
    DINAR_AI_FALLBACK_API_KEY: "sk-closure-fallback",
    DINAR_AI_MAX_RETRIES: "9",
    DINAR_MODEL_TIMEOUT_MS: "40000",
  } as NodeJS.ProcessEnv;
  const runtime = resolveAIModelRuntimeConfiguration(env);
  assert.equal(runtime.primary.provider, "OPENAI_COMPATIBLE");
  assert.equal(runtime.primary.requestedModel, "owner-approved-model");
  assert.equal(runtime.maxRetries, 2, "retries are bounded");
  assert.equal(runtime.maxOutputTokens, 8192, "the output ceiling defaults to the gateway maximum");
  for (const [value, expected] of [["1024", 1024], ["10", 256], ["99999", 8192], ["many", 8192]] as const)
    assert.equal(resolveAIModelRuntimeConfiguration({ ...env, DINAR_AI_MAX_OUTPUT_TOKENS: value }).maxOutputTokens, expected, `output ceiling ${value}`);
  assert.equal(runtime.timeoutMs, 40_000);
  assert.equal(runtime.fallback?.baseURL, undefined, "credentials never go to a plain-HTTP remote endpoint");
  const readiness = describeAIModelReadiness(env);
  assert.ok(readiness.valid);
  assert.equal(readiness.primary.configured, true);
  assert.equal(readiness.fallback?.configured, false);
  assert.ok(!JSON.stringify(readiness).includes("sk-closure"), "readiness never prints a secret");
  assert.equal(safeProviderBaseUrl("https://user:pw@x.test/v1"), undefined);
  assert.equal(safeProviderBaseUrl("http://127.0.0.1:8080/v1", { NODE_ENV: "development" } as NodeJS.ProcessEnv), "http://127.0.0.1:8080/v1");
  assert.equal(safeProviderBaseUrl("http://127.0.0.1:8080/v1", { NODE_ENV: "production" } as NodeJS.ProcessEnv), undefined);
  // Default Groq development setup is preserved.
  assert.equal(resolveAIModelRuntimeConfiguration({ DINAR_AI_PROVIDER: "GROQ", DINAR_AI_MODEL: "qwen/qwen3.8-27b" } as NodeJS.ProcessEnv).primary.requestedModel, "qwen/qwen3.8-27b");
  assert.equal(resolveAIModelRuntimeConfiguration({ DINAR_AI_PROVIDER: "GROQ", DINAR_AI_FALLBACK_PROVIDER: "GROQ" } as NodeJS.ProcessEnv).fallback, undefined, "a fallback identical to the primary is ignored");
});

await test("C3-15 an admin enters dated official prices through the API; versions are append-only, attributed and never backdated", async () => {
  const admin = await register("price-admin");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  const model = `priced-model-${randomUUID().slice(0, 6)}`;
  const body = { provider: PROVIDER, model, currencyCode: "USD", inputPerMillionMicros: 3_000_000, outputPerMillionMicros: 12_000_000, cachedInputPerMillionMicros: 750_000, cacheWriteInputPerMillionMicros: 3_750_000, cacheWrite12hInputPerMillionMicros: 7_500_000, source: "PROVIDER_PUBLISHED", sourceReference: "provider price page, retrieved 2026-10-22" };
  assert.equal((await request("/admin/ai/model-prices", "POST", body, user.cookie)).status, 403, "only an admin sets prices");
  assert.equal((await request("/admin/ai/model-prices", "GET", undefined, user.cookie)).status, 403);
  assert.equal((await request("/admin/ai/model-prices", "POST", { ...body, source: "TEST_PLACEHOLDER" }, admin.cookie)).status, 400, "placeholders never enter through the API");
  assert.equal((await request("/admin/ai/model-prices", "POST", { ...body, sourceReference: "" }, admin.cookie)).status, 400, "a price needs its source");
  assert.equal((await request("/admin/ai/model-prices", "POST", { ...body, inputPerMillionMicros: -1 }, admin.cookie)).status, 400);
  assert.equal((await request("/admin/ai/model-prices", "POST", { ...body, currencyCode: "usd" }, admin.cookie)).status, 400);
  const backdated = await request("/admin/ai/model-prices", "POST", { ...body, effectiveFrom: new Date(Date.now() - 86_400_000).toISOString() }, admin.cookie);
  assert.equal(backdated.status, 400, "no retroactive price");
  assert.equal(backdated.data.code, "INVALID_PRICE");

  const first = await request("/admin/ai/model-prices", "POST", body, admin.cookie);
  assert.equal(first.status, 201, first.raw);
  assert.equal(first.data.version, 1);
  assert.equal(first.data.createdBy, admin.id, "every price version names who entered it");
  const later = new Date(Date.now() + 3_600_000);
  const second = await request("/admin/ai/model-prices", "POST", { ...body, inputPerMillionMicros: 2_000_000, effectiveFrom: later.toISOString() }, admin.cookie);
  assert.equal(second.status, 201, second.raw);
  assert.equal(second.data.version, 2);

  // The live lookup prices a call made now with v1 and a call after `later` with v2.
  const now = await applicablePrice(PROVIDER, [model], new Date());
  const future = await applicablePrice(PROVIDER, [model], new Date(later.getTime() + 1_000));
  assert.equal(now?.version, 1);
  assert.equal(future?.version, 2);
  assert.equal(first.data.cacheWriteInputPerMillionMicros, 3_750_000);
  assert.equal(first.data.cacheWrite12hInputPerMillionMicros, 7_500_000);
  // 1000 input partitions to 300 uncached, 400 cached, 200 short writes, 100 long writes.
  assert.equal(callCostMicros(now, { inputTokens: 1_000, cachedInputTokens: 400, cacheWriteInputTokens: 300, cacheWrite12hInputTokens: 100, outputTokens: 200, imageUnits: 0, audioSeconds: 0 }, "USD"), 5_100);
  assert.equal(callCostMicros(now, { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 0, imageUnits: 1, audioSeconds: 0 }, "USD"), undefined, "no image price entered → unpriced, never zero");

  const listed = await request("/admin/ai/model-prices", "GET", undefined, admin.cookie);
  assert.equal(listed.status, 200, listed.raw);
  const versions = listed.data.prices.filter((row: any) => row.model === model);
  assert.deepEqual(versions.map((row: any) => [row.version, row.current]), [[2, false], [1, true]]);
  assert.ok(versions.every((row: any) => row.sourceReference.includes("price page")));

  // Concurrent entries for one model get distinct consecutive versions.
  const racing = await Promise.all([0, 1, 2].map(() => request("/admin/ai/model-prices", "POST", { ...body, effectiveFrom: new Date(Date.now() + 7_200_000).toISOString() }, admin.cookie)));
  assert.deepEqual(racing.map((item) => item.status), [201, 201, 201]);
  assert.deepEqual(racing.map((item) => item.data.version).sort(), [3, 4, 5]);
});

await test("cleanup: placeholder prices are left only in this disposable database", async () => {
  const rows = await db.select().from(aiModelPrices).where(inArray(aiModelPrices.id, priceIds));
  assert.ok(rows.every((row) => row.source === "TEST_PLACEHOLDER"));
  server.close();
});
