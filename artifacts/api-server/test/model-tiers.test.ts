/**
 * Dual-tier routing (model-tier.ts) over real HTTP and PostgreSQL with scripted LIGHT and HEAVY
 * gateways. It proves routing, escalation, caps and costing, not either model's quality: no live
 * provider is contacted (that evidence is BLOCKED until an authorized provider and budget exist).
 *
 *  - DINAR_AI_TIERING off (default): only the single configured model is used, exactly as before.
 *  - The tier is chosen deterministically (no routing call); HEAVY for analysis/writing/long asks.
 *  - LIGHT's invalid structured answer earns one HEAVY retry with the same context; outages do not.
 *  - Every request of the turn is costed on one reservation; HEAVY has its own per-actor cap.
 *  - Without a HEAVY model, HEAVY is the same model at reasoning effort "high".
 *  - Decisions never reach any tier.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { aiUsageReservations, carts, db, orders, pool } from "@workspace/db";
import app from "../src/app";
import { AIProviderError, createConversationModelGateway, describeAIModelReadiness, providerHealth, resetProviderBreakers, type ConversationModelGateway, type ModelCallOptions } from "../src/ai/model-gateway";
import { selectModelTier } from "../src/ai/model-tier";
import { interpretWithModel } from "../src/ai/model-turn";
import { HELD_OUT_CASES, ROUTING_CASES } from "./fixtures/tier-routing-corpus";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

type Behaviour = "OK" | "MALFORMED" | "OUTAGE" | "UNKNOWN_ACTION" | "LOW_CONFIDENCE" | "QUOTA" | "HANG" | "PROPOSE_PURCHASE";
function scripted(provider: "OPENAI" | "DEEPSEEK", model: string, reply: string) {
  const state = { calls: 0, behaviour: "OK" as Behaviour, efforts: [] as Array<string | undefined>, prompts: [] as string[], effortSupport: true };
  const gateway: ConversationModelGateway & { heavy?: ConversationModelGateway } = {
    providerInfo: { provider, requestedModel: model },
    async proposeToolCall(messages, _tools, options?: ModelCallOptions) {
      state.calls++;
      state.efforts.push(options?.reasoningEffort);
      state.prompts.push(messages.map((message) => String(message.content)).join("\n"));
      if (state.behaviour === "OUTAGE") throw new AIProviderError(provider, "UNAVAILABLE", model);
      if (state.behaviour === "QUOTA") throw new AIProviderError(provider, "QUOTA_LIMITED", model);
      if (state.behaviour === "HANG") await new Promise((resolve) => setTimeout(resolve, 5_000));
      const turn =
        state.behaviour === "UNKNOWN_ACTION" ? { responseKind: "ACTION_PROPOSAL", confidence: 0.9, conversationalReply: reply, suggestedAction: "PAY_ORDER" }
        : state.behaviour === "LOW_CONFIDENCE" ? { responseKind: "CLARIFICATION_REQUIRED", confidence: 0.2, conversationalReply: `${reply} أي واحد تقصد؟` }
        : state.behaviour === "PROPOSE_PURCHASE" ? { responseKind: "ACTION_PROPOSAL", confidence: 0.95, conversationalReply: `${reply} تم الشراء`, suggestedAction: "REVIEW_PURCHASE" }
        : { responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: reply };
      return {
        id: `${model}-${state.calls}`,
        name: "dinarConversationTurn",
        provider,
        requestedModel: model,
        arguments: state.behaviour === "MALFORMED" ? "{not json" : JSON.stringify(turn),
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
  // Whether this model accepts a per-call reasoning effort (only some do; model-gateway.ts).
  Object.defineProperty(gateway, "perCallReasoningEffort", { get: () => state.effortSupport });
  return { gateway, state };
}
const light = scripted("OPENAI", "light-test", "LIGHT_REPLY");
const heavy = scripted("DEEPSEEK", "heavy-test", "HEAVY_REPLY");
let withHeavy = true;
app.locals.conversationModelGateway = new Proxy(light.gateway, { get: (target, key) => (key === "heavy" ? (withHeavy ? heavy.gateway : undefined) : Reflect.get(target, key)) });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function fresh() {
  const number = `79${((Date.now() + 7919 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "model-tiers-password-1";
  const created = await request("/auth/register", "POST", { displayName: `مستخدم ${phone}`, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  const conv = (await request("/ai/conversations", "POST", {}, created.cookie)).data.id as string;
  return { cookie: created.cookie, id: created.data.user.id as string, conv };
}
async function say(user: { cookie: string; conv: string }, message: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(`${origin}/api/ai/conversations/${user.conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: user.cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID(), ...extra }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } }).find((event: any) => event.type === "complete");
  return String(complete?.assistantMessage?.body ?? "");
}
const lastReservation = async (userId: string) =>
  (await db.select().from(aiUsageReservations).where(eq(aiUsageReservations.ownerKey, `user:${userId}`)).orderBy(desc(aiUsageReservations.expiresAt)).limit(1))[0];
const env = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
};
// An open question nothing in DINAR claims, so the model fallback answers it.
const SIMPLE = "احكيلي نكتة قصيرة عن القهوة";
// Reasoning load (a plan, in detail): HEAVY. Explaining one thing is LIGHT (SIMPLE_EXPLANATION).
const ANALYSIS = "ضع لي خطة لتعلم الطبخ خلال شهر بالتفصيل";
const SIMPLE_EXPLANATION = "اشرح لي ما الفرق بين البيع بالجملة والبيع بالتجزئة لمشروع صغير";

beforeEach(() => {
  resetProviderBreakers();
  light.state.calls = heavy.state.calls = 0;
  light.state.behaviour = heavy.state.behaviour = "OK";
  light.state.efforts = [];
  heavy.state.efforts = [];
  light.state.prompts = [];
  heavy.state.prompts = [];
  light.state.effortSupport = heavy.state.effortSupport = true;
  withHeavy = true;
  env({ DINAR_AI_TIERING: "on", DINAR_AI_HEAVY_TURNS_PER_WINDOW: undefined, DINAR_AI_DISABLED_PROVIDERS: undefined, DINAR_AI_MAX_RETRIES: "0", DINAR_AI_BREAKER_FAILURES: undefined, DINAR_AI_BREAKER_COOLDOWN_MS: undefined, DINAR_MODEL_TIMEOUT_MS: undefined });
});

await test("DT-01 the tier is chosen deterministically, without any model call", () => {
  const on = { DINAR_AI_TIERING: "on" } as NodeJS.ProcessEnv;
  assert.deepEqual(selectModelTier(ANALYSIS, {} as NodeJS.ProcessEnv), { tier: "LIGHT", reason: "TIERING_OFF" });
  assert.deepEqual(selectModelTier(SIMPLE, on), { tier: "LIGHT", reason: "DEFAULT_LIGHT" });
  assert.deepEqual(selectModelTier(ANALYSIS, on), { tier: "HEAVY", reason: "ANALYSIS" });
  assert.deepEqual(selectModelTier(SIMPLE_EXPLANATION, on), { tier: "LIGHT", reason: "DEFAULT_LIGHT" }, "explaining one thing is LIGHT");
  assert.deepEqual(selectModelTier("اكتبلي وصف تسويقي لمحلي", on), { tier: "LIGHT", reason: "DEFAULT_LIGHT" }, "one listing's copy is LIGHT");
  assert.deepEqual(selectModelTier("اكتبلي حملة تسويقية كاملة لمحلي", on), { tier: "HEAVY", reason: "WRITING" });
  assert.deepEqual(selectModelTier("بعت 3 قطع بسعر 45 وخصم 10%، كم ربحي؟", on), { tier: "HEAVY", reason: "CALCULATION" });
  assert.deepEqual(selectModelTier(`«${"نص منسوخ ".repeat(60)}» هل هو واضح؟`, on), { tier: "LIGHT", reason: "DEFAULT_LIGHT" }, "pasted text is material, not instruction");
  assert.deepEqual(selectModelTier(SIMPLE, on, { requestedEffort: "high" }), { tier: "HEAVY", reason: "USER_PREFERENCE" });
  assert.deepEqual(selectModelTier(ANALYSIS, on, { requestedEffort: "low" }), { tier: "LIGHT", reason: "USER_PREFERENCE" });
  assert.deepEqual(selectModelTier("كم؟ ومتى؟ ووين؟", on), { tier: "HEAVY", reason: "MULTI_QUESTION" });
  assert.deepEqual(selectModelTier("س".repeat(400), on), { tier: "HEAVY", reason: "LONG_REQUEST" });
  assert.deepEqual(selectModelTier("نعم", on), { tier: "LIGHT", reason: "DECISION_NEVER_ESCALATES" });
});

await test("DT-02 tiering off (the default) is the single-model behaviour", async () => {
  env({ DINAR_AI_TIERING: undefined });
  const user = await fresh();
  const body = await say(user, ANALYSIS);
  assert.match(body, /LIGHT_REPLY/u, body);
  assert.equal(light.state.calls, 1);
  assert.equal(heavy.state.calls, 0, "no heavy model without the owner's switch");
});

await test("DT-03 a simple ask stays LIGHT; an analytical ask goes HEAVY once, with the same context", async () => {
  const user = await fresh();
  assert.match(await say(user, SIMPLE), /LIGHT_REPLY/u);
  assert.deepEqual([light.state.calls, heavy.state.calls], [1, 0]);
  const body = await say(user, ANALYSIS);
  assert.match(body, /HEAVY_REPLY/u, body);
  assert.deepEqual([light.state.calls, heavy.state.calls], [1, 1], "no routing call and no LIGHT attempt first");
  assert.match(heavy.state.prompts[0]!, /القهوة/u, "HEAVY receives the same conversation context");
  const reservation = await lastReservation(user.id);
  assert.equal(reservation?.status, "SETTLED");
});

await test("DT-04 LIGHT's invalid structured answer earns exactly one HEAVY retry; both are costed", async () => {
  const user = await fresh();
  light.state.behaviour = "MALFORMED";
  const body = await say(user, SIMPLE);
  assert.match(body, /HEAVY_REPLY/u, body);
  assert.deepEqual([light.state.calls, heavy.state.calls], [1, 1]);
  const reservation = await lastReservation(user.id);
  assert.equal(reservation?.status, "SETTLED");
  assert.equal(reservation?.providerCalls, 2, "the turn's both requests are on its one reservation");
  heavy.state.behaviour = "MALFORMED";
  await say(user, `${SIMPLE} ثانية`);
  assert.deepEqual([light.state.calls, heavy.state.calls], [2, 2], "never more than one escalation");
});

await test("DT-05 an outage does not escalate to HEAVY (the fallback path owns outages)", async () => {
  const user = await fresh();
  light.state.behaviour = "OUTAGE";
  const body = await say(user, SIMPLE);
  assert.doesNotMatch(body, /HEAVY_REPLY|LIGHT_REPLY/u, body);
  assert.equal(heavy.state.calls, 0);
});

await test("DT-06 the HEAVY allowance is capped per actor; past it the turn stays LIGHT", async () => {
  env({ DINAR_AI_HEAVY_TURNS_PER_WINDOW: "1" });
  const user = await fresh();
  assert.match(await say(user, ANALYSIS), /HEAVY_REPLY/u);
  assert.match(await say(user, `${ANALYSIS} مرة ثانية`), /LIGHT_REPLY/u, "the cap keeps the answer on LIGHT");
  assert.deepEqual([light.state.calls, heavy.state.calls], [1, 1]);
  env({ DINAR_AI_HEAVY_TURNS_PER_WINDOW: "0" });
  const other = await fresh();
  light.state.behaviour = "MALFORMED";
  await say(other, SIMPLE);
  assert.equal(heavy.state.calls, 1, "a zero cap also forbids escalation");
});

await test("DT-07 without a HEAVY model, HEAVY is the same model at high reasoning effort (where the model supports it)", async () => {
  withHeavy = false;
  const user = await fresh();
  assert.match(await say(user, ANALYSIS), /LIGHT_REPLY/u);
  assert.deepEqual(light.state.efforts, ["high"]);
  assert.equal(heavy.state.calls, 0);
});

await test("DT-08 a disabled HEAVY model is never sent to; the turn is answered by LIGHT and costed once", async () => {
  env({ DINAR_AI_DISABLED_PROVIDERS: "DEEPSEEK:heavy-test" });
  const user = await fresh();
  const body = await say(user, ANALYSIS);
  assert.match(body, /LIGHT_REPLY/u, `degrades to LIGHT instead of failing the turn: ${body}`);
  assert.equal(heavy.state.calls, 0);
  const reservation = await lastReservation(user.id);
  assert.equal(reservation?.providerCalls, 1, "only the LIGHT request was sent and costed");
});

await test("DT-09 a decision never escalates; with nothing pending it stays LIGHT and executes nothing", async () => {
  // A bare «نعم» with nothing to confirm is an open message, as in the single-model behaviour
  // (it reached the model there too); tiering must not make it HEAVY, even after an invalid answer.
  const user = await fresh();
  light.state.behaviour = "MALFORMED";
  await say(user, "نعم");
  assert.equal(heavy.state.calls, 0, "a decision word never earns HEAVY, not even by escalation");
  const agree = await say(user, "أوافق على الشروط");
  assert.match(agree, /وافقت على النسخ الحالية/u, "the terms decision is DINAR's own, deterministic");
  assert.equal(light.state.calls + heavy.state.calls, 1, "acceptance never reaches any tier");
});

await test("DT-10 configuration: a HEAVY slot builds a second gateway; identical or absent means none", async () => {
  const base = { NODE_ENV: "development", DINAR_AI_PROVIDER: "GROQ", GROQ_API_KEY: "test-only-not-a-key" } as NodeJS.ProcessEnv;
  const single = await createConversationModelGateway(base);
  assert.equal(single.heavy, undefined);
  assert.equal("tiering" in describeAIModelReadiness(base), false, "readiness is unchanged without tiering config");
  const same = await createConversationModelGateway({ ...base, DINAR_AI_HEAVY_PROVIDER: "GROQ", DINAR_AI_HEAVY_MODEL: single.providerInfo!.requestedModel });
  assert.equal(same.heavy, undefined, "a heavy identical to the primary is not a second model");
  const tiered = { ...base, DINAR_AI_TIERING: "on", DINAR_AI_HEAVY_PROVIDER: "GROQ", DINAR_AI_HEAVY_MODEL: "heavy-groq-test" } as NodeJS.ProcessEnv;
  const two = await createConversationModelGateway(tiered);
  assert.deepEqual(two.heavy?.providerInfo, { provider: "GROQ", requestedModel: "heavy-groq-test" });
  assert.deepEqual(two.providerInfo, single.providerInfo, "LIGHT is still the primary");
  const readiness = describeAIModelReadiness(tiered) as any;
  assert.equal(readiness.tiering.enabled, true);
  assert.equal(readiness.tiering.heavy.model, "heavy-groq-test");
  assert.doesNotMatch(JSON.stringify(readiness), /test-only-not-a-key/u, "no credential in readiness");
});

await test("DT-11 routing corpus: every labeled case routes as the policy says; held-out phrasings measured", () => {
  const on = { DINAR_AI_TIERING: "on" } as NodeJS.ProcessEnv;
  const misses = (cases: typeof ROUTING_CASES) => cases.filter((item) => selectModelTier(item.message, on).tier !== item.expected).map((item) => item.id);
  assert.deepEqual(misses(ROUTING_CASES), []);
  const heldOut = misses(HELD_OUT_CASES);
  console.log("TIER_HELD_OUT", JSON.stringify({ correct: HELD_OUT_CASES.length - heldOut.length, total: HELD_OUT_CASES.length, misses: heldOut }));
  assert.ok(heldOut.length <= 2, `held-out misses: ${heldOut.join(", ")}`);
});

await test("DT-12 a real gateway that cannot take a per-call effort refuses locally: not sent, not a provider call, never an outage", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "2" });
  const openai = await createConversationModelGateway({ NODE_ENV: "development", DINAR_AI_PROVIDER: "OPENAI", OPENAI_API_KEY: "test-only-not-a-key" } as NodeJS.ProcessEnv);
  assert.equal(openai.perCallReasoningEffort, false);
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await interpretWithModel(openai, "مرحبا", { reasoningEffort: "high" }, 2_000);
    assert.equal(result.ok, false);
    assert.equal((result as any).modelCall.providerCalls, 0, "an option the model cannot take was never sent");
  }
  assert.ok(providerHealth().every((entry) => entry.state === "CLOSED"), `the breaker never opens for it: ${JSON.stringify(providerHealth())}`);
});

await test("DT-13 HEAVY on a model without per-call effort and no HEAVY model degrades to LIGHT", async () => {
  withHeavy = false;
  light.state.effortSupport = false;
  const user = await fresh();
  assert.match(await say(user, ANALYSIS), /LIGHT_REPLY/u);
  assert.deepEqual(light.state.efforts, [undefined], "no unsupported effort is sent");
});

await test("DT-14 an open HEAVY breaker routes straight to LIGHT; a HEAVY outage is answered by LIGHT in the same turn", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "1", DINAR_AI_BREAKER_COOLDOWN_MS: "60000" });
  heavy.state.behaviour = "OUTAGE";
  const user = await fresh();
  assert.match(await say(user, ANALYSIS), /LIGHT_REPLY/u, "the separate HEAVY model was down: LIGHT answers once");
  assert.deepEqual([light.state.calls, heavy.state.calls], [1, 1]);
  const reservation = await lastReservation(user.id);
  assert.equal(reservation?.providerCalls, 2, "both sent requests are costed");
  assert.match(await say(user, `${ANALYSIS} ثانية`), /LIGHT_REPLY/u);
  assert.deepEqual([light.state.calls, heavy.state.calls], [2, 1], "an open breaker is not even tried");
});

await test("DT-15 the user's own depth preference: high asks HEAVY, low keeps LIGHT", async () => {
  const user = await fresh();
  assert.match(await say(user, SIMPLE, { reasoningEffort: "high" }), /HEAVY_REPLY/u);
  assert.match(await say(user, `${ANALYSIS} للمبتدئين`, { reasoningEffort: "low" }), /LIGHT_REPLY/u);
  assert.deepEqual([light.state.calls, heavy.state.calls], [1, 1]);
});

await test("DT-16 escalation is for a malformed structure only: never an unsupported action, low confidence, quota or timeout", async () => {
  for (const behaviour of ["UNKNOWN_ACTION", "LOW_CONFIDENCE", "QUOTA"] as const) {
    light.state.behaviour = behaviour;
    const user = await fresh();
    await say(user, `${SIMPLE} ${behaviour}`);
    assert.equal(heavy.state.calls, 0, `${behaviour} does not earn HEAVY`);
  }
  env({ DINAR_MODEL_TIMEOUT_MS: "300" });
  light.state.behaviour = "HANG";
  const slow = await fresh();
  await say(slow, `${SIMPLE} بطيء`);
  assert.equal(heavy.state.calls, 0, "a timeout spends the deadline; nothing escalates");
});

await test("DT-17 HEAVY has no extra authority: its purchase suggestion is only a review, and its success words are not trusted", async () => {
  heavy.state.behaviour = "PROPOSE_PURCHASE";
  const user = await fresh();
  const before = (await db.select().from(orders).where(eq(orders.buyerId, user.id))).length;
  const body = await say(user, ANALYSIS);
  assert.equal(heavy.state.calls, 1);
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, user.id))).length, before, "no order from model output");
  assert.equal((await db.select().from(carts).where(eq(carts.userId, user.id))).length, 0, "no cart from model output");
  assert.doesNotMatch(body, /تم الشراء/u, `no success text without a receipt: ${body}`);
});

await test("DT-18 a repeated identical request (same clientMessageId) is answered once", async () => {
  light.state.behaviour = "MALFORMED";
  const user = await fresh();
  const clientMessageId = randomUUID();
  await say(user, SIMPLE, { clientMessageId });
  const first = [light.state.calls, heavy.state.calls];
  await say(user, SIMPLE, { clientMessageId });
  assert.deepEqual([light.state.calls, heavy.state.calls], first, "the replay sends nothing again");
  assert.deepEqual(first, [1, 1]);
});

after(async () => {
  env({ DINAR_AI_TIERING: undefined, DINAR_AI_MAX_RETRIES: undefined });
  server.close();
  await pool.end();
});
