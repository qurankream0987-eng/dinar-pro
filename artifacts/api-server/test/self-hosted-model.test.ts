/**
 * Self-hosted open-weight model (Qwen family behind vLLM/SGLang) through DINAR's existing
 * OPENAI_COMPATIBLE gateway slot. A loopback stand-in returns vLLM-shaped responses; this proves
 * the request contract and failure classification, not the model's language quality.
 * No network, no database, no paid provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { benchmarkEndpoint, MODEL_CONTRACTS } from "./live-model-benchmark-core";
import { AIProviderError, createConversationModelGateway, describeAIModelReadiness, isProviderDisabled, resolveAIProviderConfiguration } from "../src/ai/model-gateway";

type Reply = { status?: number; body?: unknown; delayMs?: number };
const seen: { path: string; auth: string | undefined; body: any }[] = [];
let next: Reply[] = [];
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
  const reply = next.shift() ?? { status: 500, body: { error: { message: "no scripted reply" } } };
  if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
  if (res.destroyed) return;
  res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body ?? {}));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
const MODEL = "Qwen/Qwen3-14B";
const env = (extra: Record<string, string> = {}) =>
  ({ NODE_ENV: "development", DINAR_AI_PROVIDER: "OPENAI_COMPATIBLE", DINAR_AI_BASE_URL: baseURL, DINAR_AI_MODEL: MODEL, DINAR_AI_API_KEY: "local-test-key", DINAR_AI_THINKING: "disabled", ...extra }) as NodeJS.ProcessEnv;
const turn = JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "أهلًا، كيف أساعدك؟" });
// vLLM with a reasoning parser returns reasoning separately; DINAR must use only the tool call.
const vllm = (message: Record<string, unknown>, finish = "tool_calls") => ({
  body: { id: "chatcmpl-vllm-1", object: "chat.completion", model: MODEL, choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: null, reasoning_content: null, ...message } }], usage: { prompt_tokens: 1400, completion_tokens: 90, total_tokens: 1490 } },
});
const call = (name: string, args: string) => ({ tool_calls: [{ id: "chatcmpl-tool-1", type: "function", function: { name, arguments: args } }] });
const tool = { name: "dinarConversationTurn", description: "turn", parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const } };
const messages = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "أبي جوال زين بسعر معقول" }];

await test("SH-01 request contract: bearer key, model, forced tool, token cap, thinking disabled via chat_template_kwargs", async () => {
  seen.length = 0;
  next = [vllm(call("dinarConversationTurn", turn))];
  const proposed = await (await createConversationModelGateway(env({ DINAR_AI_MAX_OUTPUT_TOKENS: "1024" }))).proposeToolCall(messages, [tool]);
  const sent = seen[0]!;
  assert.equal(sent.path, "/v1/chat/completions");
  assert.equal(sent.auth, "Bearer local-test-key", "the key travels server to server only");
  assert.equal(sent.body.model, MODEL);
  assert.equal(sent.body.tool_choice, "required");
  assert.equal(sent.body.max_completion_tokens, 1024);
  assert.deepEqual(sent.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(proposed.name, "dinarConversationTurn");
  assert.equal(proposed.arguments, turn);
  assert.deepEqual(proposed.usage?.inputTokens, 1400);
});

await test("SH-02 the thinking switch is opt-in, validated and only sent for OPENAI_COMPATIBLE", async () => {
  seen.length = 0;
  next = [vllm(call("dinarConversationTurn", turn))];
  await (await createConversationModelGateway(env({ DINAR_AI_THINKING: "" }))).proposeToolCall(messages, [tool]);
  assert.equal("chat_template_kwargs" in seen[0]!.body, false);
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_THINKING: "enabled" })), /THINKING may only be "disabled"/);
  assert.equal(resolveAIProviderConfiguration(env()).thinking, "disabled");
});

await test("SH-03 reasoning text in reasoning_content or content never becomes the turn", async () => {
  next = [vllm({ content: "<think>internal plan</think>", reasoning_content: "internal plan", ...call("dinarConversationTurn", turn) })];
  const proposed = await (await createConversationModelGateway(env())).proposeToolCall(messages, [tool]);
  assert.equal(proposed.arguments, turn, "only the structured tool arguments are used");
  assert.doesNotMatch(JSON.stringify(proposed), /internal plan/u);
});

await test("SH-04 failures are classified and fail closed: no tool call, overload, timeout, bad JSON from the server", async () => {
  const gateway = await createConversationModelGateway(env({ DINAR_MODEL_TIMEOUT_MS: "300" }));
  next = [vllm({ content: "<tool_call>{\"name\": \"dinarConversationTurn\"}</tool_call>" }, "stop")];
  await assert.rejects(gateway.proposeToolCall(messages, [tool]), (error) => error instanceof AIProviderError, "an unparsed text tool call is not executed");
  next = [{ status: 503, body: { error: { message: "overloaded" } } }];
  await assert.rejects(gateway.proposeToolCall(messages, [tool]), (error) => error instanceof AIProviderError);
  next = [{ ...vllm(call("dinarConversationTurn", turn)), delayMs: 1500 }];
  await assert.rejects(gateway.proposeToolCall(messages, [tool]), (error) => error instanceof AIProviderError);
  next = [{ status: 200, body: { choices: "not-an-array" } }];
  await assert.rejects(gateway.proposeToolCall(messages, [tool]), (error) => error instanceof AIProviderError);
});

await test("SH-05 a non-HTTPS remote endpoint is not configured; the provider can be disabled without a deploy", () => {
  const remotePlain = resolveAIProviderConfiguration(env({ DINAR_AI_BASE_URL: "http://gpu.example.net:8000/v1" }));
  assert.equal(remotePlain.baseURL, undefined, "credentials are never sent over plain HTTP to a remote host");
  const refused = describeAIModelReadiness(env({ DINAR_AI_BASE_URL: "http://gpu.example.net:8000/v1" }));
  assert.ok(refused.valid);
  assert.equal(refused.primary.configured, false, "the slot is not usable without an HTTPS endpoint");
  assert.equal(refused.primary.endpointHost, null);
  const ready = describeAIModelReadiness(env());
  assert.ok(ready.valid);
  assert.deepEqual([ready.primary.configured, ready.primary.thinking, ready.primary.credentialPresent], [true, "disabled", true]);
  assert.doesNotMatch(JSON.stringify(ready), /local-test-key/u, "readiness never contains the key");
  assert.equal(resolveAIProviderConfiguration(env({ NODE_ENV: "production", DINAR_AI_BASE_URL: baseURL })).baseURL, undefined, "loopback HTTP is development only");
  assert.equal(isProviderDisabled("OPENAI_COMPATIBLE", MODEL, { DINAR_AI_DISABLED_PROVIDERS: `OPENAI_COMPATIBLE:${MODEL}` } as NodeJS.ProcessEnv), true);
  assert.equal(isProviderDisabled("OPENAI_COMPATIBLE", MODEL, { DINAR_AI_DISABLED_PROVIDERS: "*" } as NodeJS.ProcessEnv), true);
});

await test("SH-06 no automatic fallback exists unless one is explicitly configured", () => {
  assert.throws(() => resolveAIProviderConfiguration(env(), "FALLBACK"), /PROVIDER must be/);
});

await test("SH-07 the live benchmark accepts a self-hosted gateway only over HTTPS, with a dedicated key name", () => {
  assert.equal(benchmarkEndpoint("SELF_HOSTED", { DINAR_BENCH_SELF_HOSTED_BASE_URL: "https://llm.example.org/v1/" } as NodeJS.ProcessEnv), "https://llm.example.org/v1");
  for (const bad of ["http://llm.example.org/v1", "https://user:pw@llm.example.org/v1", "https://llm.example.org/v1?key=x", "", "not a url"])
    assert.throws(() => benchmarkEndpoint("SELF_HOSTED", { DINAR_BENCH_SELF_HOSTED_BASE_URL: bad } as NodeJS.ProcessEnv), /DINAR_BENCH_SELF_HOSTED_BASE_URL/, bad);
  for (const model of ["Qwen/Qwen3-14B", "Qwen/Qwen3.5-9B"]) {
    assert.equal(MODEL_CONTRACTS[model]?.provider, "SELF_HOSTED", model);
    assert.deepEqual(MODEL_CONTRACTS[model]?.toolChoices, ["REQUIRED"], model);
  }
});

test.after(() => server.close());
