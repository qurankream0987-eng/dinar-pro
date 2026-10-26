/**
 * Provider transports without any provider: a loopback HTTP double answers as the Chat
 * Completions and Responses APIs would, and every request DINAR sends is captured. Covers the
 * unchanged defaults, the AUTO tool policy, the Responses adapter, usage (cached and reasoning),
 * unusable responses (output limit, refusal, no tool call), non-retried 400s and cancellation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AIProviderError, createConversationModelGateway, describeAIModelReadiness, resolveAIProviderConfiguration } from "../src/ai/model-gateway";
import { interpretWithModel } from "../src/ai/model-turn";

type Reply = { status?: number; body?: unknown; delayMs?: number };
const requests: { path: string; body: any }[] = [];
let next: Reply[] = [];
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined });
  const reply = next.shift() ?? { status: 500, body: { error: { message: "no scripted reply" } } };
  if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
  if (res.destroyed) return;
  res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body ?? {}));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
const env = (extra: Record<string, string> = {}) =>
  ({ NODE_ENV: "development", DINAR_AI_PROVIDER: "OPENAI_COMPATIBLE", DINAR_AI_BASE_URL: baseURL, DINAR_AI_MODEL: "scripted-model", DINAR_AI_API_KEY: "test-key", ...extra }) as NodeJS.ProcessEnv;
const turnArguments = JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "مرحبًا" });
const chat = (message: Record<string, unknown>, finish = "tool_calls", usage: Record<string, unknown> = { prompt_tokens: 900, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 300 }, completion_tokens_details: { reasoning_tokens: 40 } }) => ({
  body: { id: "chatcmpl-1", model: "scripted-model", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: null, ...message } }], usage },
});
const toolMessage = { tool_calls: [{ id: "call_1", type: "function", function: { name: "dinarConversationTurn", arguments: turnArguments } }] };
const responses = (output: unknown[], extra: Record<string, unknown> = {}) => ({
  body: { id: "resp_1", object: "response", model: "scripted-model", status: "completed", output, usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 500 }, output_tokens: 150, output_tokens_details: { reasoning_tokens: 90 }, total_tokens: 1350 }, ...extra },
});
const tool = { name: "dinarConversationTurn", description: "turn", parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const } };
const messages = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "مرحبا" }];

await test("defaults are unchanged: Chat Completions, forced tool, no reasoning field", async () => {
  assert.deepEqual(resolveAIProviderConfiguration(env()), { provider: "OPENAI_COMPATIBLE", requestedModel: "scripted-model", credentialName: "DINAR_AI_API_KEY", baseURL });
  requests.length = 0;
  next = [chat(toolMessage)];
  const call = await (await createConversationModelGateway(env())).proposeToolCall(messages, [tool]);
  assert.equal(requests[0]!.path, "/v1/chat/completions");
  assert.equal(requests[0]!.body.tool_choice, "required");
  assert.equal("reasoning_effort" in requests[0]!.body, false);
  assert.equal("parallel_tool_calls" in requests[0]!.body, false);
  assert.equal(requests[0]!.body.max_completion_tokens, 8192);
  assert.deepEqual(call.usage, { inputTokens: 900, outputTokens: 80, cachedInputTokens: 300, reasoningTokens: 40 });
});

await test("AUTO tool policy and an explicit effort reach Chat Completions; the readiness view shows them", async () => {
  requests.length = 0;
  next = [chat(toolMessage)];
  const configured = env({ DINAR_AI_TOOL_CHOICE: "auto", DINAR_AI_REASONING_EFFORT: "none", DINAR_AI_MAX_OUTPUT_TOKENS: "1024" });
  await (await createConversationModelGateway(configured)).proposeToolCall(messages, [tool]);
  assert.deepEqual([requests[0]!.body.tool_choice, requests[0]!.body.parallel_tool_calls, requests[0]!.body.reasoning_effort, requests[0]!.body.max_completion_tokens], ["auto", false, "none", 1024]);
  const readiness = describeAIModelReadiness(configured);
  assert.ok(readiness.valid);
  assert.deepEqual([readiness.primary.transport, readiness.primary.toolChoice, readiness.primary.reasoningEffort], ["CHAT_COMPLETIONS", "AUTO", "none"]);
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_TOOL_CHOICE: "any" })), /TOOL_CHOICE must be/);
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_REASONING_EFFORT: "max" })), /REASONING_EFFORT must be/);
  assert.throws(() => resolveAIProviderConfiguration({ ...env(), DINAR_AI_BASE_URL: "https://api.anthropic.com/v1", DINAR_AI_TRANSPORT: "RESPONSES" }), /only supported for api.openai.com/);
});

await test("Responses transport: tool shape, no provider storage, effort, normalized call and usage", async () => {
  requests.length = 0;
  next = [responses([{ type: "reasoning", id: "rs_1", summary: [] }, { type: "function_call", id: "fc_1", call_id: "call_9", name: "dinarConversationTurn", arguments: turnArguments, status: "completed" }])];
  const gateway = await createConversationModelGateway(env({ DINAR_AI_TRANSPORT: "RESPONSES", DINAR_AI_REASONING_EFFORT: "low", DINAR_AI_MAX_OUTPUT_TOKENS: "2048" }));
  const call = await gateway.proposeToolCall(messages, [tool]);
  const body = requests[0]!.body;
  assert.equal(requests[0]!.path, "/v1/responses");
  assert.deepEqual(body.input, [{ role: "system", content: "sys" }, { role: "user", content: "مرحبا" }]);
  assert.deepEqual(body.tools, [{ type: "function", name: "dinarConversationTurn", description: "turn", parameters: tool.parameters, strict: false }]);
  assert.deepEqual([body.tool_choice, body.parallel_tool_calls, body.store, body.reasoning, body.max_output_tokens], ["required", false, false, { effort: "low" }, 2048]);
  assert.deepEqual([call.id, call.name, call.arguments, call.providerRequestId], ["call_9", "dinarConversationTurn", turnArguments, "resp_1"]);
  assert.deepEqual(call.usage, { inputTokens: 1200, outputTokens: 150, cachedInputTokens: 500, reasoningTokens: 90 });
});

await test("cache writes are reported on both transports, so their surcharge is never lost", async () => {
  next = [responses([{ type: "function_call", id: "fc_2", call_id: "call_2", name: "dinarConversationTurn", arguments: turnArguments, status: "completed" }], { usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2048, cache_write_tokens_details: { ttl_30m_tokens: 2048, ttl_12h_tokens: 0 } }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3040 } })];
  const viaResponses = await (await createConversationModelGateway(env({ DINAR_AI_TRANSPORT: "RESPONSES" }))).proposeToolCall(messages, [tool]);
  assert.deepEqual(viaResponses.usage, { inputTokens: 3000, outputTokens: 40, cachedInputTokens: 0, cacheWriteInputTokens: 2048 });
  next = [chat(toolMessage, "tool_calls", { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2048, cache_write_tokens_details: { ttl_12h_tokens: 1024 } } })];
  const viaChat = await (await createConversationModelGateway(env())).proposeToolCall(messages, [tool]);
  assert.deepEqual(viaChat.usage, { inputTokens: 3000, outputTokens: 40, cachedInputTokens: 0, cacheWriteInputTokens: 2048, cacheWrite12hInputTokens: 1024 });
});

await test("the SDK request deadline follows DINAR_MODEL_TIMEOUT_MS on both transports", async () => {
  for (const transport of ["CHAT_COMPLETIONS", "RESPONSES"]) {
    next = [{ ...chat(toolMessage), delayMs: 2_000 }];
    const started = Date.now();
    await assert.rejects((await createConversationModelGateway(env({ DINAR_AI_TRANSPORT: transport, DINAR_MODEL_TIMEOUT_MS: "200" }))).proposeToolCall(messages, [tool]), AIProviderError);
    assert.ok(Date.now() - started < 1_500, `${transport}: the client gives up at the configured deadline`);
  }
});

await test("a billed response without a DINAR turn keeps its usage and says why", async () => {
  const cases: [Reply, string, string][] = [
    [responses([{ type: "reasoning", id: "rs_2", summary: [] }], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), "RESPONSES", "OUTPUT_LIMIT"],
    [responses([{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }]), "RESPONSES", "REFUSAL"],
    [responses([{ type: "message", id: "m2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "plain text", annotations: [] }] }]), "RESPONSES", "NO_TOOL_CALL"],
    [chat({ content: "cut" }, "length"), "CHAT_COMPLETIONS", "OUTPUT_LIMIT"],
    [chat({ content: "", refusal: "no" }, "stop"), "CHAT_COMPLETIONS", "REFUSAL"],
    [chat({ content: "plain text" }, "stop"), "CHAT_COMPLETIONS", "NO_TOOL_CALL"],
  ];
  for (const [reply, transport, detail] of cases) {
    next = [reply];
    const gateway = await createConversationModelGateway(env({ DINAR_AI_TRANSPORT: transport }));
    await assert.rejects(gateway.proposeToolCall(messages, [tool]), (error) => {
      assert.ok(error instanceof AIProviderError, String(error));
      assert.deepEqual([error.code, error.detail, typeof error.usage?.inputTokens], ["INVALID_RESPONSE", detail, "number"], `${transport} ${detail}`);
      return true;
    });
  }
});

await test("a 400 is a configuration fault: not retried; an outage is retried once", async () => {
  const previous = process.env.DINAR_AI_MAX_RETRIES;
  process.env.DINAR_AI_MAX_RETRIES = "1";
  try {
    requests.length = 0;
    next = [{ status: 400, body: { error: { message: "tool_choice not supported" } } }, chat(toolMessage)];
    const rejected = await interpretWithModel(await createConversationModelGateway(env()), "مرحبا", {}, 5000);
    assert.deepEqual([rejected.ok, rejected.ok ? "" : rejected.reason, rejected.modelCall.providerCalls], [false, "NOT_CONFIGURED", 1]);
    assert.equal(requests.length, 1, "the invalid request was sent once");
    next = [];
    requests.length = 0;
    next = [{ status: 503, body: { error: { message: "busy" } } }, chat(toolMessage)];
    const retried = await interpretWithModel(await createConversationModelGateway(env()), "مرحبا", {}, 10_000);
    assert.equal(retried.ok, true);
    assert.equal(requests.length, 2, "a transient outage is retried once");
  } finally {
    if (previous === undefined) delete process.env.DINAR_AI_MAX_RETRIES;
    else process.env.DINAR_AI_MAX_RETRIES = previous;
  }
});

await test("cancellation aborts the provider request", async () => {
  next = [{ ...chat(toolMessage), delayMs: 2_000 }];
  const controller = new AbortController();
  const pending = (await createConversationModelGateway(env())).proposeToolCall(messages, [tool], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await assert.rejects(pending, AIProviderError);
  assert.ok(Date.now() - started < 1_500, "the call ends at the abort, not at the reply");
});

server.close();
