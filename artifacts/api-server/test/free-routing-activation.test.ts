/**
 * Owner decision Option A: free-model enforcement is inactive until a versioned, environment-bound
 * policy is set AND an exact model is approved. Scripted gateways only — no provider call, no key.
 *
 *  A  inactive (no policy): a FREE account and a guest keep the existing route; the model answers
 *     and the turn still goes through the canonical usage reservation.
 *  B  active + approved zero-price model: the free route answers.
 *  C  active, model on the allowlist but no approved zero price: honest refusal, zero model calls,
 *     nothing reserved as consumed.
 *  P  the policy parser: other environment, unknown version, no approved model → COMPAT.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { aiModelPrices, aiUsageReservations, db, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { FREE_ROUTING_POLICY_VERSION, freeRoutingPolicy } from "../src/ai/free-model-policy";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const ENV = process.env.DINAR_DEPLOYMENT_ENV?.trim().toLowerCase() || "development";
const ENFORCE = `${FREE_ROUTING_POLICY_VERSION}:enforce:${ENV}`;
const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const EXISTING = { provider: "OPENAI_COMPATIBLE", model: `fixture/existing-route-${suffix}` };
const FREE = { provider: "OPENROUTER", model: `fixture/free-${suffix}:free` };
const UNPRICED_FREE = { provider: "OPENROUTER", model: `fixture/unpriced-${suffix}:free` };

const calls: string[] = [];
const scripted = (route: { provider: string; model: string }): ConversationModelGateway => ({
  providerInfo: { provider: route.provider, requestedModel: route.model },
  async proposeToolCall() {
    calls.push(route.model);
    return {
      id: "c",
      name: "dinarConversationTurn",
      arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: `جواب من ${route.model}` }),
      provider: route.provider,
      requestedModel: route.model,
      actualModel: route.model,
      usage: { inputTokens: 50, outputTokens: 10 },
    };
  },
});
const price = (route: { provider: string; model: string }, rate: number) =>
  db.insert(aiModelPrices).values({
    id: randomUUID(), provider: route.provider, model: route.model, version: 1, currencyCode: "USD",
    inputPerMillionMicros: rate, outputPerMillionMicros: rate,
    ...(route.provider === "OPENAI_COMPATIBLE" ? { cacheWriteInputPerMillionMicros: rate, cacheWrite12hInputPerMillionMicros: rate } : {}),
    source: "CONTRACT", sourceReference: "deterministic test fixture; no provider call", effectiveFrom: new Date(Date.now() - 60_000),
  });
await price(EXISTING, 2_000_000);
await price(FREE, 0);

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => { server.close(); await pool.end(); });

let ip = 1;
async function request(pathname: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + pathname, {
    method,
    headers: { "content-type": "application/json", "X-Forwarded-For": `198.51.${100 + (ip >> 8)}.${ip++ & 255}`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_550_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function freeAccount() {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Fr-${randomUUID().slice(0, 12)}!`;
  const created = await request("/auth/register", "POST", { displayName: "Free routing", accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  assert.equal(created.status, 201, created.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, created.cookie)).status, 200);
  return { id: created.data.user.id as string, cookie: created.cookie };
}
async function turn(cookie: string, message: string) {
  const conversation = (await request("/ai/conversations", "POST", {}, cookie)).data.id as string;
  const response = await fetch(`${base}/ai/conversations/${conversation}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  return { status: response.status, body: String(complete?.assistantMessage?.body ?? raw) };
}
async function withRoute<T>(gateway: ConversationModelGateway, env: Record<string, string | undefined>, run: () => Promise<T>) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  app.locals.conversationModelGateway = gateway;
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
}
const REFUSAL = /لا يوجد نموذج مجاني OpenRouter معتمد/u;

test("P policy parser: only the exact version, «enforce», this environment and an approved model activate it", () => {
  const ok = { DINAR_DEPLOYMENT_ENV: "staging", DINAR_FREE_ROUTING_POLICY: `${FREE_ROUTING_POLICY_VERSION}:enforce:staging`, DINAR_APPROVED_FREE_OPENROUTER_MODELS: FREE.model } as NodeJS.ProcessEnv;
  assert.equal(freeRoutingPolicy(ok).mode, "ENFORCE");
  assert.deepEqual(freeRoutingPolicy({ ...ok, DINAR_FREE_ROUTING_POLICY: undefined }), { mode: "COMPAT", reason: "NOT_REQUESTED" });
  assert.deepEqual(freeRoutingPolicy({ ...ok, DINAR_DEPLOYMENT_ENV: "production" }), { mode: "COMPAT", reason: "OTHER_ENVIRONMENT" }, "a staging value copied to production does nothing");
  assert.deepEqual(freeRoutingPolicy({ ...ok, DINAR_FREE_ROUTING_POLICY: `2026-01-01.v0:enforce:staging` }), { mode: "COMPAT", reason: "UNKNOWN_VERSION" });
  assert.deepEqual(freeRoutingPolicy({ ...ok, DINAR_FREE_ROUTING_POLICY: `${FREE_ROUTING_POLICY_VERSION}:enforce:staging:extra` }), { mode: "COMPAT", reason: "UNKNOWN_VERSION" });
  assert.deepEqual(freeRoutingPolicy({ ...ok, DINAR_APPROVED_FREE_OPENROUTER_MODELS: "" }), { mode: "COMPAT", reason: "NO_APPROVED_MODEL" });
  assert.deepEqual(freeRoutingPolicy({ ...ok, DINAR_APPROVED_FREE_OPENROUTER_MODELS: "openrouter/free" }), { mode: "COMPAT", reason: "NO_APPROVED_MODEL" }, "the dynamic alias never counts");
});

test("A inactive policy: a FREE account and a guest keep the existing route, through the usage reservation", async () => {
  const user = await freeAccount();
  await withRoute(scripted(EXISTING), { DINAR_FREE_ROUTING_POLICY: undefined, DINAR_APPROVED_FREE_OPENROUTER_MODELS: undefined }, async () => {
    const before = calls.length;
    const reply = await turn(user.cookie, "اشرح لي الفرق بين الشاي الأخضر والأسود");
    assert.equal(reply.status, 200);
    assert.doesNotMatch(reply.body, REFUSAL, "chat is not disabled before activation");
    assert.match(reply.body, new RegExp(`جواب من ${EXISTING.model.replace(/[/.]/gu, "\\$&")}`, "u"));
    assert.deepEqual(calls.slice(before), [EXISTING.model]);
    const reservations = await db.select().from(aiUsageReservations).where(eq(aiUsageReservations.ownerKey, `user:${user.id}`));
    assert.equal(reservations.length, 1, "the canonical usage reservation still runs");
    assert.equal(reservations[0]!.status, "SETTLED");
    assert.equal(reservations[0]!.premiumTrial, false);

    const guestBefore = calls.length;
    const guest = await request("/ai/preview", "POST", { message: "ما عاصمة اليابان؟", marketId: "JO" }, "bdinar_guest_market=JO");
    assert.equal(guest.status, 200, guest.raw);
    assert.doesNotMatch(guest.raw, REFUSAL);
    assert.deepEqual(calls.slice(guestBefore), [EXISTING.model], "the guest keeps the existing route too");
  });
});

test("A' enforcement requested without an approved model stays inactive (no silent outage)", async () => {
  const user = await freeAccount();
  await withRoute(scripted(EXISTING), { DINAR_FREE_ROUTING_POLICY: ENFORCE, DINAR_APPROVED_FREE_OPENROUTER_MODELS: "" }, async () => {
    const reply = await turn(user.cookie, "اكتب لي بيت شعر عن البحر");
    assert.doesNotMatch(reply.body, REFUSAL);
    assert.match(reply.body, /جواب من/u);
  });
});

test("B active policy with an approved zero-price model: FREE accounts use the free route", async () => {
  const user = await freeAccount();
  await withRoute({ ...scripted(EXISTING), fallback: scripted(FREE) }, { DINAR_FREE_ROUTING_POLICY: ENFORCE, DINAR_APPROVED_FREE_OPENROUTER_MODELS: FREE.model }, async () => {
    const before = calls.length;
    const reply = await turn(user.cookie, "وش أفضل وقت لزيارة العلا؟");
    assert.doesNotMatch(reply.body, REFUSAL);
    assert.deepEqual(calls.slice(before), [FREE.model], "only the approved free model is called; the paid primary is never reached");
  });
});

test("C active policy, allowlisted model without an approved zero price: honest refusal and no model call", async () => {
  const user = await freeAccount();
  await withRoute(scripted(UNPRICED_FREE), { DINAR_FREE_ROUTING_POLICY: ENFORCE, DINAR_APPROVED_FREE_OPENROUTER_MODELS: UNPRICED_FREE.model }, async () => {
    const before = calls.length;
    const reply = await turn(user.cookie, "كيف أطبخ كبسة؟");
    assert.match(reply.body, REFUSAL);
    assert.equal(calls.length, before, "no unapproved model is called");
    const consumed = (await db.select().from(aiUsageReservations).where(eq(aiUsageReservations.ownerKey, `user:${user.id}`))).filter((row) => row.chargedRequests > 0);
    assert.equal(consumed.length, 0, "nothing is charged");
    const guestBefore = calls.length;
    const guest = await request("/ai/preview", "POST", { message: "ما عاصمة فرنسا؟", marketId: "JO" }, "bdinar_guest_market=JO");
    assert.equal(guest.status, 200);
    assert.equal(calls.length, guestBefore, "the guest is not routed to an unapproved model either");
  });
});
