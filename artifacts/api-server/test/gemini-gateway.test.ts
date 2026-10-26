import test from "node:test";
import assert from "node:assert/strict";
import {
  AIProviderError,
  createConversationModelGateway,
  resolveAIProviderConfiguration,
  type ModelMessage,
  type ModelToolDefinition,
} from "../src/ai/model-gateway";

const MODEL = "gemini-3.5-flash-lite";
const tool: ModelToolDefinition = {
  name: "dinarConversationTurn",
  description: "Return one validated DINAR conversation turn.",
  parameters: {
    type: "object",
    properties: { responseKind: { type: "string" }, confidence: { type: "number" } },
    required: ["responseKind", "confidence"],
    additionalProperties: false,
  },
};

test("Gemini is development-only, exact-model, free-only, and uses its dedicated benchmark key", async () => {
  assert.deepEqual(resolveAIProviderConfiguration({
    NODE_ENV: "development",
    DINAR_AI_PROVIDER: "GEMINI",
    DINAR_GEMINI_FREE_ONLY: "true",
    DINAR_GEMINI_BENCHMARK_CONTEXT: "1",
    DINAR_AI_MODEL: MODEL,
  }), {
    provider: "GEMINI",
    requestedModel: MODEL,
    credentialName: "DINAR_BENCH_GEMINI_API_KEY",
    transport: "GEMINI_GENERATE_CONTENT",
    toolChoice: "AUTO",
  });
  assert.throws(() => resolveAIProviderConfiguration({ DINAR_AI_PROVIDER: "GEMINI", DINAR_GEMINI_FREE_ONLY: "true", DINAR_AI_MODEL: MODEL }), /explicitly marked isolated free-only benchmark/);
  assert.throws(() => resolveAIProviderConfiguration({
    DINAR_AI_PROVIDER: "GEMINI",
    DINAR_GEMINI_FREE_ONLY: "true",
    DINAR_GEMINI_BENCHMARK_CONTEXT: "1",
    DINAR_AI_MODEL: "gemini-4-argon",
  }), /exact verified free-tier Gemini model ID/);
  await assert.rejects(createConversationModelGateway({
    NODE_ENV: "production",
    DINAR_AI_PROVIDER: "GEMINI",
    DINAR_GEMINI_FREE_ONLY: "true",
    DINAR_AI_MODEL: MODEL,
    DINAR_BENCH_GEMINI_API_KEY: "test-only",
  }), /restricted to an isolated development benchmark/);
  await assert.rejects(createConversationModelGateway({
    NODE_ENV: "development",
    DINAR_AI_PROVIDER: "GEMINI",
    DINAR_GEMINI_FREE_ONLY: "true",
    DINAR_GEMINI_BENCHMARK_CONTEXT: "1",
    DINAR_AI_MODEL: MODEL,
    OPENAI_API_KEY: "must-not-be-used",
  }), (error: unknown) => error instanceof AIProviderError && error.provider === "GEMINI" && error.code === "NOT_CONFIGURED");
});

test("Gemini adapter uses native GenerateContent, maps the existing function contract, and reports usage", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      responseId: "gemini-response-123",
      modelVersion: MODEL,
      candidates: [{
        finishReason: "STOP",
        content: { role: "model", parts: [{ functionCall: { name: "dinarConversationTurn", args: { responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9 } } }] },
      }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 35, thoughtsTokenCount: 9, cachedContentTokenCount: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gateway = await createConversationModelGateway({
      NODE_ENV: "development",
      DINAR_AI_PROVIDER: "GEMINI",
      DINAR_GEMINI_FREE_ONLY: "true",
      DINAR_GEMINI_BENCHMARK_CONTEXT: "1",
      DINAR_AI_MODEL: MODEL,
      DINAR_BENCH_GEMINI_API_KEY: "test-only",
      DINAR_AI_MAX_RETRIES: "0",
      DINAR_AI_MAX_OUTPUT_TOKENS: "512",
    });
    const messages: ModelMessage[] = [
      { role: "system", content: "System instructions." },
      { role: "user", content: "First user message." },
      { role: "user", content: "Follow-up." },
      { role: "assistant", content: "Assistant context." },
    ];
    const result = await gateway.proposeToolCall(messages, [tool]);
    assert.equal(capturedUrl, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
    assert.equal((capturedInit?.headers as Record<string, string>)["x-goog-api-key"], "test-only");
    assert.equal(new URL(capturedUrl).search, "");
    const request = JSON.parse(String(capturedInit?.body));
    assert.equal(request.systemInstruction.parts[0].text, "System instructions.");
    assert.deepEqual(request.contents, [
      { role: "user", parts: [{ text: "First user message." }, { text: "Follow-up." }] },
      { role: "model", parts: [{ text: "Assistant context." }] },
    ]);
    assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
    assert.equal(request.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
    assert.equal(request.generationConfig.maxOutputTokens, 512);
    assert.equal(result.provider, "GEMINI");
    assert.equal(result.name, "dinarConversationTurn");
    assert.equal(result.actualModel, MODEL);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 44, cachedInputTokens: 0, reasoningTokens: 9 });
    assert.equal(result.providerRequestId, "gemini-response-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini quota responses are normalized without exposing provider messages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "private provider detail" } }), { status: 429 });
  try {
    const gateway = await createConversationModelGateway({
      NODE_ENV: "development",
      DINAR_AI_PROVIDER: "GEMINI",
      DINAR_GEMINI_FREE_ONLY: "true",
      DINAR_GEMINI_BENCHMARK_CONTEXT: "1",
      DINAR_AI_MODEL: MODEL,
      DINAR_BENCH_GEMINI_API_KEY: "test-only",
      DINAR_AI_MAX_RETRIES: "0",
    });
    await assert.rejects(gateway.proposeToolCall([], [tool]), (error: unknown) =>
      error instanceof AIProviderError && error.code === "QUOTA_LIMITED" && error.httpStatus === 429 && !error.message.includes("private provider detail"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
