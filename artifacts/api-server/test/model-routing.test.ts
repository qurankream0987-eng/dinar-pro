/**
 * Owner policy 2026-11-13: multi-tier routing (FREE → ECONOMY → CORE, CORE/ADVANCED directly).
 * Part 1 is the pure planner; part 2 runs the real API, usage reservation and spend ledger against
 * scripted catalog gateways (no provider, no key, no real money). «Paid» below means a catalog model
 * with a non-zero approved price row — a deterministic fixture, never a live call.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { aiModelPrices, aiCostEvents, aiUsageReservations, commercialPolicies, db, pool } from "@workspace/db";
import app from "../src/app";
import { AIProviderError, useCatalogGatewayFactory, type ConversationModelGateway, type ModelMessage } from "../src/ai/model-gateway";
import { classOrder, planModelRoute, NO_CAPACITY_MESSAGE, type ModelPreference } from "../src/ai/model-routing";
import { CatalogModelSchema, DEFAULT_MODEL_ROUTING_POLICY, ModelRoutingPolicySchema, type CatalogModel, type ModelRoutingPolicy } from "../src/lib/ai-usage-policy";
import { aiUsagePolicyFor } from "../src/lib/ai-usage";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const s = randomUUID().replaceAll("-", "").slice(0, 6);
const entry = (model: string, cls: CatalogModel["class"], extra: Partial<CatalogModel> = {}): CatalogModel => ({
  provider: "OPENAI_COMPATIBLE", model, class: cls, qualified: { arabic: true, tools: true, structuredOutput: true }, contextWindow: 128_000, maxTurnMicros: 50_000, ...extra,
});
const FREE_A = entry(`fx/free-a-${s}:free`, "FREE");
const FREE_B = entry(`fx/free-b-${s}:free`, "FREE");
const ECO = entry(`fx/economy-${s}`, "ECONOMY");
const CORE = entry(`fx/core-${s}`, "CORE");
const ADV = entry(`fx/advanced-${s}`, "ADVANCED");
const key = (e: { provider: string; model: string }) => `${e.provider}\u0000${e.model}`;
const priceRow = (e: CatalogModel, input: number, output: number, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), provider: e.provider, model: e.model, version: 1, currencyCode: "USD", inputPerMillionMicros: input, outputPerMillionMicros: output,
  cachedInputPerMillionMicros: null, cacheWriteInputPerMillionMicros: input, cacheWrite12hInputPerMillionMicros: input, requestMicros: 0,
  source: "CONTRACT", sourceReference: "deterministic test fixture; no provider call", effectiveFrom: new Date(Date.now() - 60_000), effectiveTo: null, createdAt: new Date(), ...extra,
}) as any;
const PRICES = new Map<string, any>([
  [key(FREE_A), priceRow(FREE_A, 0, 0)], [key(FREE_B), priceRow(FREE_B, 0, 0)],
  [key(ECO), priceRow(ECO, 100_000, 400_000)], [key(CORE), priceRow(CORE, 500_000, 2_000_000)], [key(ADV), priceRow(ADV, 2_000_000, 8_000_000)],
]);
const routing = (over: Partial<ModelRoutingPolicy> = {}): ModelRoutingPolicy => ModelRoutingPolicySchema.parse({
  ...DEFAULT_MODEL_ROUTING_POLICY,
  enabled: true,
  paidFallbackEnabled: true,
  models: [FREE_A, FREE_B, ECO, CORE, ADV],
  audiences: {
    GUEST: { classes: ["FREE", "ECONOMY"], paidFallback: true, perTurnMaxMicros: 2_000 },
    FREE: { classes: ["FREE", "ECONOMY", "CORE"], paidFallback: true, perTurnMaxMicros: 6_000 },
    BUSINESS_GO: { classes: ["FREE", "ECONOMY", "CORE"], paidFallback: true, perTurnMaxMicros: 20_000 },
    BUSINESS_PRO: { classes: ["FREE", "ECONOMY", "CORE", "ADVANCED"], paidFallback: true, perTurnMaxMicros: 60_000 },
  },
  ...over,
});
const plan = (opts: { policy?: ModelRoutingPolicy; tier?: "GUEST" | "FREE" | "BUSINESS_GO" | "BUSINESS_PRO"; preference?: ModelPreference; difficulty?: "LIGHT" | "HEAVY"; down?: string[]; prices?: Map<string, any>; killed?: boolean; allow?: string[] } = {}) =>
  planModelRoute({
    policy: opts.policy ?? routing(), tier: opts.tier ?? "FREE", preference: opts.preference ?? "AUTO", difficulty: opts.difficulty ?? "LIGHT",
    needs: { tools: true, structuredOutput: true, contextTokens: 6_000 }, prices: opts.prices ?? PRICES, spendCurrency: "USD",
    available: (e) => !(opts.down ?? []).includes(e.model), freeAllowlisted: (e) => (opts.allow ?? [FREE_A.model, FREE_B.model]).includes(e.model), paidKilled: opts.killed ?? false,
  });
const models = (p: ReturnType<typeof plan>) => (p.kind === "ROUTE" ? p.attempts.map((a) => a.model) : []);

// ---------------------------------------------------------------- planner (pure)
test("R1 free model available: FREE first, ECONOMY as the single failover (bounded to two)", () => {
  const p = plan();
  assert.deepEqual(models(p), [FREE_A.model, ECO.model]);
});
test("R2 first free model exhausted (breaker open): the alternative free model takes over", () => {
  assert.deepEqual(models(plan({ down: [FREE_A.model] })), [FREE_B.model, ECO.model]);
});
test("R3 all free models exhausted: the approved economy model answers, CORE backs it up", () => {
  assert.deepEqual(models(plan({ down: [FREE_A.model, FREE_B.model] })), [ECO.model, CORE.model]);
});
test("R4 economy rate-limited too: CORE is the last authorized step; nothing else is reachable", () => {
  assert.deepEqual(models(plan({ down: [FREE_A.model, FREE_B.model, ECO.model] })), [CORE.model]);
});
test("R5 a task that needs CORE goes to CORE directly, not through weaker models", () => {
  assert.deepEqual(classOrder("AUTO", "HEAVY"), ["CORE", "ECONOMY", "FREE"]);
  assert.equal(models(plan({ difficulty: "HEAVY" }))[0], CORE.model);
});
test("R6 user-selected CORE and ADVANCED are honoured only where the audience allows them", () => {
  assert.equal(models(plan({ preference: "CORE", tier: "BUSINESS_GO" }))[0], CORE.model);
  assert.deepEqual(models(plan({ preference: "ADVANCED", tier: "BUSINESS_PRO" })), [ADV.model, CORE.model]);
  // FREE accounts may not use ADVANCED: the permitted fallback (CORE) answers instead.
  assert.deepEqual(models(plan({ preference: "ADVANCED", tier: "FREE" })), [CORE.model]);
  // Guests never reach CORE or ADVANCED.
  assert.ok(!models(plan({ preference: "CORE", tier: "GUEST" })).includes(CORE.model));
});
test("R7 paid fallback off for an audience, or the emergency kill switch: only free models", () => {
  const guestNoPaid = routing({ audiences: { ...routing().audiences, GUEST: { classes: ["FREE", "ECONOMY"], paidFallback: false, perTurnMaxMicros: 2_000 } } });
  assert.deepEqual(models(plan({ policy: guestNoPaid, tier: "GUEST" })), [FREE_A.model, FREE_B.model]);
  assert.deepEqual(models(plan({ killed: true })), [FREE_A.model, FREE_B.model]);
  assert.deepEqual(models(plan({ policy: routing({ paidFallbackEnabled: false }) })), [FREE_A.model, FREE_B.model]);
  const all = plan({ killed: true, down: [FREE_A.model, FREE_B.model] });
  assert.equal(all.kind, "NO_CAPACITY", "no free capacity and paid killed: honest capacity refusal");
  assert.ok(all.excluded.some((x) => x.reason === "PAID_FALLBACK_DISABLED"));
});
test("R8 per-turn ceilings: a price change above the ceiling removes the model before any call", () => {
  const raised = new Map(PRICES);
  raised.set(key(ECO), priceRow(ECO, 5_000_000, 20_000_000)); // provider raised the price
  const p = plan({ prices: raised, down: [FREE_A.model, FREE_B.model] });
  assert.ok(!models(p).includes(ECO.model));
  assert.ok(p.excluded.some((x) => x.model === ECO.model && x.reason === "OVER_TURN_CEILING"));
  // Guest ceiling (2,000 micros) excludes CORE even if the class were listed.
  const guestCore = routing({ audiences: { ...routing().audiences, GUEST: { classes: ["CORE"], paidFallback: true, perTurnMaxMicros: 2_000 } } });
  assert.equal(plan({ policy: guestCore, tier: "GUEST" }).kind, "NO_CAPACITY");
});
test("R9 no approved price, placeholder price, currency mismatch, non-zero FREE, unlisted FREE: never routed", () => {
  const broken = new Map(PRICES);
  broken.delete(key(ECO));
  broken.set(key(CORE), priceRow(CORE, 1, 1, { source: "TEST_PLACEHOLDER" }));
  broken.set(key(FREE_B), priceRow(FREE_B, 1, 0));
  broken.set(key(ADV), priceRow(ADV, 1, 1, { currencyCode: "EUR" }));
  const p = plan({ prices: broken, tier: "BUSINESS_PRO", allow: [FREE_B.model] });
  const reasons = Object.fromEntries(p.excluded.map((x) => [x.model, x.reason]));
  assert.equal(reasons[ECO.model], "NO_APPROVED_PRICE");
  assert.equal(reasons[CORE.model], "NO_APPROVED_PRICE");
  assert.equal(reasons[FREE_B.model], "FREE_NOT_ZERO_PRICE");
  assert.equal(reasons[FREE_A.model], "FREE_NOT_ALLOWLISTED");
  assert.equal(p.kind, "NO_CAPACITY");
});
test("R10 unsupported tool calling, structured output, or a too-small context is excluded", () => {
  const p = plan({ policy: routing({ models: [
    entry(`fx/notools-${s}:free`, "FREE", { qualified: { arabic: true, tools: false, structuredOutput: true } }),
    entry(`fx/nostructured-${s}:free`, "FREE", { qualified: { arabic: true, tools: true, structuredOutput: false } }),
    entry(`fx/tiny-${s}:free`, "FREE", { contextWindow: 4_096 }),
  ] }), allow: [`fx/notools-${s}:free`, `fx/nostructured-${s}:free`, `fx/tiny-${s}:free`] });
  assert.equal(p.kind, "NO_CAPACITY");
  assert.deepEqual(p.excluded.map((x) => x.reason).sort(), ["CONTEXT_TOO_SMALL", "NOT_QUALIFIED", "NOT_QUALIFIED"]);
});
test("R11 the catalog refuses dynamic aliases and duplicate models; routing is off by default", () => {
  assert.equal(CatalogModelSchema.safeParse(entry("openrouter/free", "FREE")).success, false);
  assert.equal(ModelRoutingPolicySchema.safeParse({ ...routing(), models: [FREE_A, FREE_A] }).success, false);
  assert.equal(DEFAULT_MODEL_ROUTING_POLICY.enabled, false);
  assert.equal(DEFAULT_MODEL_ROUTING_POLICY.paidFallbackEnabled, false);
  assert.equal(DEFAULT_MODEL_ROUTING_POLICY.models.length, 0);
});

// ---------------------------------------------------------------- API journeys (scripted catalog)
for (const [e, input, output] of [[FREE_A, 0, 0], [FREE_B, 0, 0], [ECO, 100_000, 400_000], [CORE, 500_000, 2_000_000]] as const)
  await db.insert(aiModelPrices).values(priceRow(e, input, output));
process.env.DINAR_APPROVED_FREE_OPENROUTER_MODELS = [FREE_A.model, FREE_B.model].join(",");

type Behaviour = "OK" | "QUOTA" | "DOWN" | "WRONG_IDENTITY";
const behaviour = new Map<string, Behaviour>();
const calls: string[] = [];
const prompts: Array<{ model: string; messages: ModelMessage[] }> = [];
const scripted = (e: { provider: string; model: string }, fallback?: ConversationModelGateway): ConversationModelGateway => ({
  providerInfo: { provider: e.provider as never, requestedModel: e.model },
  ...(fallback ? { fallback } : {}),
  async proposeToolCall(messages) {
    calls.push(e.model);
    prompts.push({ model: e.model, messages: messages.map(({ role, content }) => ({ role, content })) });
    const mode = behaviour.get(e.model) ?? "OK";
    if (mode === "QUOTA") throw new AIProviderError(e.provider as never, "QUOTA_LIMITED", e.model, 5, 429);
    if (mode === "DOWN") throw new AIProviderError(e.provider as never, "UNAVAILABLE", e.model, 5, 503);
    return {
      id: "c", name: "dinarConversationTurn",
      arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: `جواب من ${e.model}` }),
      provider: e.provider, requestedModel: e.model, actualModel: mode === "WRONG_IDENTITY" ? "someone/else" : e.model,
      usage: { inputTokens: 1_000, outputTokens: 200 },
    } as any;
  },
});
const previousFactory = useCatalogGatewayFactory((e, fallback) => scripted(e, fallback));
// The configured (legacy) gateway must never be reached while routing is enabled.
app.locals.conversationModelGateway = scripted({ provider: "OPENAI_COMPATIBLE", model: `fx/legacy-${s}` });

const base0 = await aiUsagePolicyFor({ id: "JO" });
let version = 900_000 + Math.floor(Math.random() * 90_000);
async function setRouting(over: Partial<ModelRoutingPolicy>, spend: Partial<typeof base0.spend> = {}) {
  await db.insert(commercialPolicies).values({ id: randomUUID(), marketId: "JO", version: ++version, policy: { aiUsage: { ...base0, spend: { ...base0.spend, global: { ...base0.spend.global, limitMicros: 10_000_000 }, ...spend }, routing: routing({ models: [FREE_A, FREE_B, ECO, CORE], ...over }) } } });
}
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => {
  useCatalogGatewayFactory(previousFactory);
  await db.delete(commercialPolicies).where(and(eq(commercialPolicies.marketId, "JO")));
  server.close();
  await pool.end();
});
let ipn = 1;
async function request(pathname: string, method = "GET", body?: unknown, cookie = "", ip?: string) {
  const response = await fetch(base + pathname, { method, headers: { "content-type": "application/json", "X-Forwarded-For": ip ?? `203.0.${113 + (ipn >> 8)}.${ipn++ & 255}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let data: any; try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_440_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account() {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Rt-${randomUUID().slice(0, 12)}!`;
  const created = await request("/auth/register", "POST", { displayName: "Routing", accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  assert.equal(created.status, 201, created.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, created.cookie)).status, 200);
  return { id: created.data.user.id as string, cookie: created.cookie };
}
async function turn(cookie: string, message: string, extra: Record<string, unknown> = {}, conversationId?: string) {
  const id = conversationId ?? (await request("/ai/conversations", "POST", {}, cookie)).data.id;
  const response = await fetch(`${base}/ai/conversations/${id}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message, ...extra }) });
  const raw = await response.text();
  const events = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  const complete = events.find((e) => e.type === "complete");
  return { status: response.status, body: String(complete?.assistantMessage?.body ?? events.find((e) => e.type === "error")?.message ?? raw), conversationId: id as string };
}
const reservationsOf = (userId: string) => db.select().from(aiUsageReservations).where(eq(aiUsageReservations.ownerKey, `user:${userId}`));
const reset = () => { behaviour.clear(); calls.length = 0; prompts.length = 0; };

test("J1 free model available: a FREE account is answered by the free model only; usage is reserved and settled", async () => {
  reset(); await setRouting({});
  const user = await account();
  const reply = await turn(user.cookie, "اشرح لي فكرة الذكاء الاصطناعي ببساطة");
  assert.match(reply.body, new RegExp(`جواب من ${FREE_A.model.replace(/[/.]/gu, "\\$&")}`, "u"));
  assert.deepEqual(calls, [FREE_A.model]);
  const rows = await reservationsOf(user.id);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.status, "SETTLED");
});

test("J2 first free model quota-limited: one authorized failover (economy) answers, its cost is recorded", async () => {
  reset(); await setRouting({});
  behaviour.set(FREE_A.model, "QUOTA");
  const user = await account();
  const reply = await turn(user.cookie, "ما الفرق بين القهوة العربية والتركية؟");
  assert.match(reply.body, new RegExp(ECO.model.replace(/[/.]/gu, "\\$&"), "u"));
  assert.deepEqual(calls, [FREE_A.model, ECO.model], "exactly two models, never a third");
  const [row] = await reservationsOf(user.id);
  const ledger = await db.select().from(aiCostEvents).where(eq(aiCostEvents.usageReservationId, row!.id));
  assert.ok(ledger.length > 0, "the paid failover is recorded as a cost event");
});

test("J3 free and economy both down: no third model; the reservation is released (spending rollback)", async () => {
  reset(); await setRouting({});
  behaviour.set(FREE_A.model, "DOWN"); behaviour.set(ECO.model, "DOWN");
  const user = await account();
  const reply = await turn(user.cookie, "ما لون السماء صافية؟");
  // An outage may be retried once on the same model (existing DINAR_AI_MAX_RETRIES, default 1);
  // the route itself never reaches a third model.
  assert.deepEqual([...new Set(calls)], [FREE_A.model, ECO.model], "exactly the two planned models");
  assert.ok(calls.length <= 4, `bounded attempts (${calls.length})`);
  assert.doesNotMatch(reply.body, /جواب من/u);
  const [row] = await reservationsOf(user.id);
  assert.equal(row!.status, "RELEASED", "the failed turn rolls the reservation back"); assert.equal(row!.chargedRequests, 0, "the user is not charged a request for a failed turn");
});

test("J4 kill switch: paid fallback stops instantly; with free down the user gets the honest capacity message and zero calls", async () => {
  reset(); await setRouting({});
  process.env.DINAR_PAID_FALLBACK_KILL = "1";
  try {
    const user = await account();
    behaviour.set(FREE_A.model, "OK");
    const ok = await turn(user.cookie, "كيف أكتب رسالة شكر؟");
    assert.deepEqual(calls, [FREE_A.model], "free still answers under the kill switch");
    reset(); await setRouting({ models: [ECO, CORE] });
    const refused = await turn(user.cookie, "اكتب لي قصيدة قصيرة");
    assert.equal(refused.body, NO_CAPACITY_MESSAGE);
    assert.deepEqual(calls, [], "no paid call under the kill switch");
    assert.ok(ok.body.length > 0);
  } finally { delete process.env.DINAR_PAID_FALLBACK_KILL; }
});

test("J5 global budget exhausted: refusal before any model call", async () => {
  reset(); await setRouting({}, { global: { ...base0.spend.global, limitMicros: 1 }, holdMicros: { ...base0.spend.holdMicros, TEXT_REQUEST: 50_000 } });
  const user = await account();
  const reply = await turn(user.cookie, "ما عاصمة كندا؟");
  assert.deepEqual(calls, [], "no model is called once the platform budget is spent");
  assert.doesNotMatch(reply.body, /جواب من/u);
});

test("J6 invalid model identity is rejected and never trusted as the approved model", async () => {
  reset(); await setRouting({ models: [FREE_A] });
  behaviour.set(FREE_A.model, "WRONG_IDENTITY");
  const user = await account();
  const reply = await turn(user.cookie, "عرّفني على نفسك");
  assert.doesNotMatch(reply.body, /جواب من/u, "a reply from an unexpected model is not shown");
});

test("J7 guests: own audience (free only here), honest capacity message when free is out, no paid call", async () => {
  reset(); await setRouting({ audiences: { ...routing().audiences, GUEST: { classes: ["FREE", "ECONOMY"], paidFallback: false, perTurnMaxMicros: 2_000 } } });
  const ok = await request("/ai/preview", "POST", { message: "ما أطول نهر في العالم؟", marketId: "JO" }, "bdinar_guest_market=JO", "198.18.0.9");
  assert.equal(ok.status, 200, ok.raw);
  assert.deepEqual(calls, [FREE_A.model]);
  reset(); await setRouting({ models: [ECO, CORE], audiences: { ...routing().audiences, GUEST: { classes: ["FREE", "ECONOMY"], paidFallback: false, perTurnMaxMicros: 2_000 } } });
  const out = await request("/ai/preview", "POST", { message: "ما أطول نهر في العالم؟", marketId: "JO" }, "bdinar_guest_market=JO", "198.18.0.10");
  assert.match(out.raw, new RegExp(NO_CAPACITY_MESSAGE.slice(0, 20), "u"));
  assert.deepEqual(calls, [], "no anonymous paid usage when the guest paid fallback is off");
});

test("J8 duplicate retry of one message runs once; accounts never share usage", async () => {
  reset(); await setRouting({});
  const a = await account(); const b = await account();
  const clientMessageId = randomUUID();
  const first = await turn(a.cookie, "سؤال مكرر", { clientMessageId });
  const again = await turn(a.cookie, "سؤال مكرر", { clientMessageId }, first.conversationId);
  assert.equal(calls.length, 1, "the retry does not call a model again");
  assert.notEqual(again.status, 500);
  assert.equal((await reservationsOf(a.id)).length, 1);
  assert.equal((await reservationsOf(b.id)).length, 0, "another account is untouched");
});

test("J9 premium trial request with the trial disabled (default) uses the normal route and consumes no trial message", async () => {
  reset(); await setRouting({});
  const user = await account();
  const reply = await turn(user.cookie, "ما عاصمة اليابان؟", { modelPreference: "PREMIUM_TRIAL" });
  assert.deepEqual(calls, [FREE_A.model]);
  assert.match(reply.body, /التجربة المميزة غير مفعّلة حاليًا/u);
  const rows = await reservationsOf(user.id);
  assert.ok(rows.every((row) => row.premiumTrial === false), "a free-model turn never consumes a trial message");
});

test("J10 routing disabled (default): the configured route is used exactly as before", async () => {
  reset(); await setRouting({ enabled: false });
  const user = await account();
  const reply = await turn(user.cookie, "ما هو الطقس عادة في الكويت صيفًا؟");
  assert.match(reply.body, /جواب من fx\/legacy-/u);
  assert.deepEqual(calls, [`fx/legacy-${s}`]);
});

test("J11 a catalog model without DINAR's required structured-output capability is refused", async () => {
  reset();
  const incompatible = {
    ...ECO,
    qualified: { ...ECO.qualified, structuredOutput: false },
  };
  await setRouting({ models: [incompatible] });
  const user = await account();
  const reply = await turn(user.cookie, "ما الفرق بين القهوة العربية والتركية؟", { modelPreference: "ECONOMY" });
  assert.equal(reply.body, NO_CAPACITY_MESSAGE, "no compatible structured-turn model is available");
  assert.deepEqual(calls, [], "an incompatible model is never dispatched");
});

test("J12 changing model classes keeps one persisted conversation and its prior turns in every prompt", async () => {
  reset(); await setRouting({});
  const user = await account();
  const marker = `continuity-${s}`;
  const first = await turn(user.cookie, `ما الفرق بين القهوة العربية والتركية؟ تذكر الرمز ${marker}`, { modelPreference: "AUTO" });
  const second = await turn(user.cookie, "اشرح الفرق في جملة واحدة", { modelPreference: "ECONOMY" }, first.conversationId);
  const third = await turn(user.cookie, "وسّع الشرح بمثال", { modelPreference: "CORE" }, first.conversationId);
  const fourth = await turn(user.cookie, "اختصره", { modelPreference: "AUTO" }, first.conversationId);

  assert.deepEqual(calls, [FREE_A.model, ECO.model, CORE.model, FREE_A.model]);
  assert.deepEqual(
    [second.conversationId, third.conversationId, fourth.conversationId],
    [first.conversationId, first.conversationId, first.conversationId],
    "model changes never create a new conversation identity",
  );
  const promptText = (index: number) => prompts[index]!.messages.map((message) => message.content).join("\n");
  assert.ok(promptText(1).includes(marker), "ECONOMY receives the original user fact");
  assert.ok(promptText(1).includes(`جواب من ${FREE_A.model}`), "ECONOMY receives the prior FREE answer");
  assert.ok(promptText(2).includes(marker) && promptText(2).includes(`جواب من ${ECO.model}`), "CORE receives prior context after the ECONOMY turn");
  assert.ok(promptText(3).includes(marker) && promptText(3).includes(`جواب من ${CORE.model}`), "the downgrade to FREE retains the same context");
});

test("J13 the assembled request and output reserve are checked against each routed model before dispatch", async () => {
  reset();
  await setRouting({ models: [{ ...FREE_A, contextWindow: 12_000 }] });
  const user = await account();
  const reply = await turn(user.cookie, "اشرح لي كيف تعمل الطاقة الشمسية", { modelPreference: "AUTO" });
  assert.match(reply.body, /أطول من سعة النموذج المتاحة/u);
  assert.deepEqual(calls, [], "the scripted gateway is not dispatched when its declared context window cannot fit the prompt and output reserve");
  const [reservation] = await reservationsOf(user.id);
  assert.equal(reservation?.status, "RELEASED");
  assert.equal(reservation?.providerCalls, 0);
  assert.equal(reservation?.chargedRequests, 0, "a local context refusal consumes no request allowance");
});

test("J14 a guest's over-context request stays free-only and returns the safe Arabic refusal", async () => {
  reset();
  await setRouting({
    models: [{ ...FREE_A, contextWindow: 12_000 }],
    audiences: { ...routing().audiences, GUEST: { classes: ["FREE"], paidFallback: false, perTurnMaxMicros: 2_000 } },
  });
  const reply = await request(
    "/ai/preview",
    "POST",
    { message: "اشرح لي كيف تعمل الطاقة الشمسية", marketId: "JO" },
    "bdinar_guest_market=JO",
    "198.18.0.11",
  );
  assert.equal(reply.status, 200, reply.raw);
  assert.match(reply.raw, /أطول من سعة النموذج المتاحة/u);
  assert.deepEqual(calls, [], "guest context refusal never reaches a provider or paid fallback");
});
