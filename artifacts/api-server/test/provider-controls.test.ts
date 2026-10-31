/**
 * §13 provider controls at the one counted gateway entry (proposeThroughGateway):
 *  - DINAR_AI_DISABLED_PROVIDERS refuses a provider locally: the request is never sent, it is not
 *    retried on that provider, it records no billable attempt, and the configured fallback answers;
 *  - the per-provider circuit breaker opens after N consecutive outages, refuses during the
 *    cool-down without sending, lets exactly one trial through afterwards, and closes on success;
 *  - a billed-but-unusable answer is the model's, not an outage, and never opens the breaker;
 *  - providerHealth() reports state without prompts or keys.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AIProviderError,
  proposeThroughGateway,
  providerHealth,
  resetProviderBreakers,
  onProviderBreakerTransition,
  type ConversationModelGateway,
} from "../src/ai/model-gateway";
import { interpretWithModel } from "../src/ai/model-turn";

const reply = { id: "ok", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "ok" }) };
function gateway(provider: "OPENAI" | "DEEPSEEK", behaviour: () => Promise<any>, fallback?: ConversationModelGateway) {
  const calls = { count: 0 };
  const value = {
    providerInfo: { provider, requestedModel: `${provider.toLowerCase()}-test` },
    ...(fallback ? { fallback } : {}),
    async proposeToolCall() {
      calls.count += 1;
      return behaviour();
    },
  } as unknown as ConversationModelGateway;
  return { value, calls };
}
const outage = () => Promise.reject(new AIProviderError("OPENAI", "UNAVAILABLE", "openai-test"));
const env = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
};

beforeEach(() => {
  resetProviderBreakers();
  env({ DINAR_AI_DISABLED_PROVIDERS: undefined, DINAR_AI_BREAKER_FAILURES: undefined, DINAR_AI_BREAKER_COOLDOWN_MS: undefined });
});

await test("a disabled provider is never called; the fallback answers and the primary records no attempt", async () => {
  env({ DINAR_AI_DISABLED_PROVIDERS: "openai" });
  const backup = gateway("DEEPSEEK", async () => reply);
  const primary = gateway("OPENAI", async () => reply, backup.value);
  await assert.rejects(proposeThroughGateway(primary.value, [], []), (error: AIProviderError) => error.detail === "DISABLED" && error.code === "NOT_CONFIGURED");
  assert.equal(primary.calls.count, 0, "the request is never sent");
  const result = await interpretWithModel(primary.value, "مرحبا", {}, 5_000);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(primary.calls.count, 0);
  assert.equal(backup.calls.count, 1, "the configured fallback answers");
  const calls = ((result as { modelCall?: { calls?: Array<{ provider: string; kind: string }> } }).modelCall?.calls ?? []);
  assert.deepEqual(calls.map((call) => [call.provider, call.kind]), [["DEEPSEEK", "FALLBACK"]], `only the fallback is a billable attempt: ${JSON.stringify(calls)}`);
  env({ DINAR_AI_DISABLED_PROVIDERS: "*" });
  await assert.rejects(proposeThroughGateway(backup.value, [], []), (error: AIProviderError) => error.detail === "DISABLED");
});

await test("the breaker opens after N outages, refuses without sending, then lets one trial through", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "3", DINAR_AI_BREAKER_COOLDOWN_MS: "1000" });
  let healthy = false;
  const provider = gateway("OPENAI", () => (healthy ? Promise.resolve(reply) : outage()));
  for (let index = 0; index < 3; index++) await assert.rejects(proposeThroughGateway(provider.value, [], []));
  assert.equal(provider.calls.count, 3);
  assert.deepEqual(providerHealth(), [{ provider: "OPENAI", model: "openai-test", state: "OPEN", consecutiveFailures: 3 }]);
  await assert.rejects(proposeThroughGateway(provider.value, [], []), (error: AIProviderError) => error.detail === "CIRCUIT_OPEN");
  assert.equal(provider.calls.count, 3, "an open breaker never sends");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  healthy = true;
  const trial = proposeThroughGateway(provider.value, [], []);
  await assert.rejects(proposeThroughGateway(provider.value, [], []), (error: AIProviderError) => error.detail === "CIRCUIT_OPEN", "only one trial at a time");
  await trial;
  assert.equal(provider.calls.count, 4, "exactly one trial request");
  assert.deepEqual(providerHealth(), [{ provider: "OPENAI", model: "openai-test", state: "CLOSED", consecutiveFailures: 0 }]);
});

await test("a billed but unusable answer is the model's, not an outage", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "2" });
  const provider = gateway("OPENAI", () => Promise.reject(new AIProviderError("OPENAI", "INVALID_RESPONSE", "openai-test")));
  for (let index = 0; index < 4; index++) await assert.rejects(proposeThroughGateway(provider.value, [], []));
  assert.equal(provider.calls.count, 4, "never refused locally");
  assert.equal(providerHealth()[0]?.state, "CLOSED");
});

await test("an open breaker on the primary does not retry it; the fallback answers", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "1", DINAR_AI_BREAKER_COOLDOWN_MS: "60000" });
  const backup = gateway("DEEPSEEK", async () => reply);
  const primary = gateway("OPENAI", outage, backup.value);
  await assert.rejects(proposeThroughGateway(primary.value, [], []));
  const result = await interpretWithModel(primary.value, "مرحبا", {}, 5_000);
  assert.equal(result.ok, true);
  assert.equal(primary.calls.count, 1, "the open primary was not called again (no retry)");
  assert.equal(backup.calls.count, 1);
});

// ─── Production-readiness review (dual-tier mandate §2) ──────────────────────

await test("a locally refused call is not counted as a provider call (no estimated charge)", async () => {
  env({ DINAR_AI_DISABLED_PROVIDERS: "OPENAI" });
  const alone = gateway("OPENAI", async () => reply);
  const refused = await interpretWithModel(alone.value, "مرحبا", {}, 5_000);
  assert.equal(refused.ok, false);
  assert.equal((refused as any).modelCall?.providerCalls, 0, `a request never sent is never a provider call: ${JSON.stringify((refused as any).modelCall)}`);
  assert.deepEqual((refused as any).modelCall?.calls ?? [], []);
  const backup = gateway("DEEPSEEK", async () => reply);
  const withFallback = gateway("OPENAI", async () => reply, backup.value);
  const answered = await interpretWithModel(withFallback.value, "مرحبا", {}, 5_000);
  assert.equal((answered as any).modelCall?.providerCalls, 1, "only the fallback request was sent");
});

await test("the breaker isolates one model; a same-provider fallback model still answers", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "1", DINAR_AI_BREAKER_COOLDOWN_MS: "60000" });
  const healthyModel = { providerInfo: { provider: "OPENAI", requestedModel: "openai-small" }, calls: 0, async proposeToolCall() { this.calls++; return reply; } } as any;
  const brokenModel = gateway("OPENAI", outage, healthyModel);
  await assert.rejects(proposeThroughGateway(brokenModel.value, [], []));
  await proposeThroughGateway(healthyModel, [], []);
  assert.equal(healthyModel.calls, 1, "another model of the same provider is not blocked");
  env({ DINAR_AI_DISABLED_PROVIDERS: "OPENAI:openai-small" });
  await assert.rejects(proposeThroughGateway(healthyModel, [], []), (error: AIProviderError) => error.detail === "DISABLED", "one model can be disabled alone");
});

await test("a trial that never settles does not keep the breaker refusing forever", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "1", DINAR_AI_BREAKER_COOLDOWN_MS: "1000" });
  let hang = false;
  const provider = gateway("OPENAI", () => (hang ? new Promise(() => undefined) : outage()));
  await assert.rejects(proposeThroughGateway(provider.value, [], []));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  hang = true;
  void proposeThroughGateway(provider.value, [], []);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  hang = false;
  await assert.rejects(proposeThroughGateway(provider.value, [], []), (error: AIProviderError) => error.code === "UNAVAILABLE" && error.detail !== "CIRCUIT_OPEN", "a new trial is let through after the hung one expired");
  assert.equal(provider.calls.count, 3);
});

await test("a caller's own cancellation is not an outage", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "1" });
  const controller = new AbortController();
  const provider = gateway("OPENAI", () => { controller.abort(); return Promise.reject(new Error("aborted")); });
  await assert.rejects(proposeThroughGateway(provider.value, [], [], { signal: controller.signal }));
  assert.equal(providerHealth()[0]?.state, "CLOSED", "cancellation never opens the breaker");
});

await test("in production a gateway without provider metadata fails closed", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const anonymous = { async proposeToolCall() { return reply; } } as unknown as ConversationModelGateway;
    await assert.rejects(proposeThroughGateway(anonymous, [], []), (error: AIProviderError) => error.detail === "DISABLED");
  } finally {
    process.env.NODE_ENV = previous;
  }
});

await test("breaker transitions reach the alert hook with provider, model and state only", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "1", DINAR_AI_BREAKER_COOLDOWN_MS: "1000" });
  const events: unknown[] = [];
  onProviderBreakerTransition((event) => events.push(event));
  try {
    let healthy = false;
    const provider = gateway("OPENAI", () => (healthy ? Promise.resolve(reply) : outage()));
    await assert.rejects(proposeThroughGateway(provider.value, [{ role: "user", content: "سر المستخدم" } as any], []));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    healthy = true;
    await proposeThroughGateway(provider.value, [], []);
    assert.deepEqual(events, [
      { provider: "OPENAI", model: "openai-test", state: "OPEN", consecutiveFailures: 1 },
      { provider: "OPENAI", model: "openai-test", state: "CLOSED", consecutiveFailures: 1 },
    ]);
    assert.doesNotMatch(JSON.stringify([events, providerHealth()]), /سر المستخدم/u, "no prompt text in diagnostics");
  } finally {
    onProviderBreakerTransition(undefined);
  }
});

await test("primary and fallback both down: an honest failure, each tried once, no loop", async () => {
  env({ DINAR_AI_MAX_RETRIES: "0" });
  try {
    const backup = gateway("DEEPSEEK", () => Promise.reject(new AIProviderError("DEEPSEEK", "UNAVAILABLE", "deepseek-test")));
    const primary = gateway("OPENAI", outage, backup.value);
    const result = await interpretWithModel(primary.value, "مرحبا", {}, 5_000);
    assert.equal(result.ok, false);
    assert.equal(primary.calls.count + backup.calls.count, 2);
    assert.equal((result as any).modelCall?.providerCalls, 2);
    env({ DINAR_AI_DISABLED_PROVIDERS: "*" });
    const none = await interpretWithModel(primary.value, "مرحبا", {}, 5_000);
    assert.equal(none.ok, false);
    assert.equal((none as any).modelCall?.providerCalls, 0, "all providers disabled: nothing sent, nothing charged");
    assert.equal(primary.calls.count + backup.calls.count, 2);
  } finally {
    env({ DINAR_AI_MAX_RETRIES: undefined });
  }
});

await test("a hung trial that finally fails after a newer trial succeeded does not reopen the breaker", async () => {
  env({ DINAR_AI_BREAKER_FAILURES: "1", DINAR_AI_BREAKER_COOLDOWN_MS: "1000" });
  let release: (value: unknown) => void = () => undefined;
  let mode: "fail" | "hang" | "ok" = "fail";
  const provider = gateway("OPENAI", () => mode === "fail" ? outage() : mode === "hang" ? new Promise((_, reject) => { release = () => reject(new AIProviderError("OPENAI", "UNAVAILABLE", "openai-test")); }) : Promise.resolve(reply));
  await assert.rejects(proposeThroughGateway(provider.value, [], []));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  mode = "hang";
  const stale = proposeThroughGateway(provider.value, [], []).catch(() => "late failure");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  mode = "ok";
  await proposeThroughGateway(provider.value, [], []);
  release(undefined);
  assert.equal(await stale, "late failure");
  assert.equal(providerHealth()[0]?.state, "CLOSED", "the late outcome of an expired trial is ignored");
});
