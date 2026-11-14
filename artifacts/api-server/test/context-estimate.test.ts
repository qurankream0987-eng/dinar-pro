/**
 * Context-window estimate before dispatch (model-gateway.ts estimateModelRequestInputTokens).
 * The requests are the real ones interpretWithModel assembles (system instruction, bounded
 * history, data, memory, message and tool schemas). REAL_TOKENS were measured offline on these
 * exact scenarios with the DeepSeek V3 tokenizer and o200k (the higher of the two), 2026-11-14.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretWithModel } from "../src/ai/model-turn";
import { estimateModelRequestInputTokens, MAX_OUTPUT_TOKENS, type ConversationModelGateway, type ModelMessage, type ModelToolDefinition } from "../src/ai/model-gateway";

const REAL_TOKENS = { short_arabic: 6_273, long_arabic: 10_290, long_english: 7_462, long_mixed: 8_899 } as const;
const ar = "أبحث عن سيارة تويوتا كورولا موديل حديث بحالة ممتازة في عمان، وأفضل أن يكون السعر قابلاً للتفاوض مع ضمان من البائع وفحص كامل قبل الشراء. ";
const en = "I am looking for a recent Toyota Corolla in excellent condition in Amman, ideally negotiable with a seller warranty and a full inspection before buying. ";
const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
function scenario(unit: string, long: boolean) {
  const history = long
    ? Array.from({ length: 40 }, (_, i) => ({ actor: i % 2 ? "assistant" : "user", body: fill(unit, i === 39 ? 6000 : 1200) }))
    : [{ actor: "user", body: fill(unit, 80) }, { actor: "assistant", body: fill(unit, 160) }];
  const results = Array.from({ length: long ? 10 : 2 }, (_, i) => ({ position: i + 1, title: fill(unit, 60), price: "4500.000", currency: "JOD", condition: "مستعمل", city: "عمان" }));
  return { message: fill(unit, long ? 4000 : 60), context: { history, results, goal: long ? fill(unit, 200) : null, preferences: long ? [fill(unit, 120), fill(unit, 120)] : [], conversationMemory: long ? fill(unit, 4000) : undefined, marketAvailable: true } as any };
}
async function captured(message: string, context: any): Promise<{ messages: ModelMessage[]; tools: ModelToolDefinition[] }> {
  let request: { messages: ModelMessage[]; tools: ModelToolDefinition[] } | undefined;
  const gateway: ConversationModelGateway = { providerInfo: { provider: "DEEPSEEK" as never, requestedModel: "estimate-probe" }, async proposeToolCall(messages, tools) { request = { messages, tools }; throw new Error("captured"); } };
  await interpretWithModel(gateway, message, context, 5000).catch(() => undefined);
  assert.ok(request, "the request was assembled");
  return request;
}
const cases = { short_arabic: scenario(ar, false), long_arabic: scenario(ar, true), long_english: scenario(en, true), long_mixed: scenario(ar + en, true) };
const estimates: Record<string, number> = {};
for (const [name, { message, context }] of Object.entries(cases)) {
  const request = await captured(message, context);
  estimates[name] = estimateModelRequestInputTokens(request.messages, request.tools).estimatedInputTokens;
}
console.log("CONTEXT_ESTIMATES", JSON.stringify({ estimates, real: REAL_TOKENS }));
const fits = (estimate: number, window: number) => estimate + MAX_OUTPUT_TOKENS <= window;

test("CE-01 a long Arabic conversation fits 32k, 64k and 128k windows with the output reserve", () => {
  for (const window of [32_768, 65_536, 131_072]) {
    for (const name of Object.keys(cases)) assert.ok(fits(estimates[name]!, window), `${name} (${estimates[name]}) + ${MAX_OUTPUT_TOKENS} must fit ${window}`);
  }
});

test("CE-02 the estimate stays above the measured real token count (never an underestimate)", () => {
  for (const [name, real] of Object.entries(REAL_TOKENS)) assert.ok(estimates[name]! >= real * 1.25, `${name}: estimate ${estimates[name]} vs real ${real}`);
});

test("CE-03 user-controlled text keeps the strict one-token-per-byte bound", async () => {
  const flood = "🙂".repeat(4000);
  const request = await captured(flood, { history: [], marketAvailable: true });
  const untrusted = Buffer.byteLength(JSON.stringify(request.messages.slice(1)), "utf8");
  assert.ok(estimateModelRequestInputTokens(request.messages, request.tools).estimatedInputTokens >= untrusted, "hostile text is never discounted");
});

test("CE-04 a genuinely oversized request is still refused before dispatch", () => {
  const messages: ModelMessage[] = [{ role: "system", content: "instructions" }, { role: "user", content: fill(ar, 30_000) }];
  assert.ok(!fits(estimateModelRequestInputTokens(messages, []).estimatedInputTokens, 32_768), "30,000 Arabic characters of user text cannot fit 32k");
  assert.ok(!fits(estimates.short_arabic!, 12_000), "the ordinary request still exceeds a 12k window (J13)");
});
