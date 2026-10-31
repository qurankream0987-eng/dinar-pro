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
  assert.deepEqual(providerHealth(), [{ provider: "OPENAI", state: "OPEN", consecutiveFailures: 3 }]);
  await assert.rejects(proposeThroughGateway(provider.value, [], []), (error: AIProviderError) => error.detail === "CIRCUIT_OPEN");
  assert.equal(provider.calls.count, 3, "an open breaker never sends");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  healthy = true;
  const trial = proposeThroughGateway(provider.value, [], []);
  await assert.rejects(proposeThroughGateway(provider.value, [], []), (error: AIProviderError) => error.detail === "CIRCUIT_OPEN", "only one trial at a time");
  await trial;
  assert.equal(provider.calls.count, 4, "exactly one trial request");
  assert.deepEqual(providerHealth(), [{ provider: "OPENAI", state: "CLOSED", consecutiveFailures: 0 }]);
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
