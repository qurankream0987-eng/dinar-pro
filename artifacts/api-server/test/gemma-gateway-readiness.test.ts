/**
 * GEMMA-READINESS — the owner-approved Gemma 4 family (31B primary, 26B A4B efficient) through
 * DINAR's existing OPENAI_COMPATIBLE slot with a pinned OpenRouter route. A loopback stand-in
 * answers like OpenRouter; this proves the request contract, privacy routing, model-substitution
 * refusal, failure classification and the benchmark contracts. It proves nothing about Gemma's
 * language quality, and makes no network call and spends nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MODEL_CONTRACTS, BENCHMARK_ENDPOINTS, BENCHMARK_CREDENTIALS } from "./live-model-benchmark-core";
import { AIProviderError, createConversationModelGateway, describeAIModelReadiness, resolveAIModelRuntimeConfiguration, resolveAIProviderConfiguration } from "../src/ai/model-gateway";
import { MODEL_TOOL, ModelTurnOutput } from "../src/ai/model-turn";

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
const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
const PRIMARY = "google/gemma-4-31b-it";
const EFFICIENT = "google/gemma-4-26b-a4b-it";
const env = (extra: Record<string, string> = {}) =>
  ({
    NODE_ENV: "development",
    DINAR_AI_PROVIDER: "OPENAI_COMPATIBLE",
    DINAR_AI_BASE_URL: baseURL,
    DINAR_AI_MODEL: PRIMARY,
    DINAR_AI_API_KEY: "local-test-key",
    DINAR_AI_PROVIDER_ORDER: "deepinfra",
    DINAR_AI_REQUIRE_PARAMETERS: "true",
    DINAR_AI_DATA_COLLECTION: "deny",
    DINAR_AI_ZDR: "true",
    ...extra,
  }) as NodeJS.ProcessEnv;
const turn = JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "أهلين، شلون أقدر أساعدك؟" });
const answer = (model: string, message: Record<string, unknown>, finish = "tool_calls") => ({
  body: { id: "gen-1", object: "chat.completion", model, provider: "DeepInfra", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: null, ...message } }], usage: { prompt_tokens: 2100, completion_tokens: 140, total_tokens: 2240 } },
});
const call = (args: string) => ({ tool_calls: [{ id: "call-1", type: "function", function: { name: "dinarConversationTurn", arguments: args } }] });
const tool = { name: MODEL_TOOL.name, description: MODEL_TOOL.description, parameters: MODEL_TOOL.parameters as any };
const messages = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "دينار، خلنا نسولف شوي" }];

await test("GM-01 request contract: model, bearer key, forced tool, pinned provider, no fallback, privacy", async () => {
  seen.length = 0;
  next = [answer(PRIMARY, call(turn))];
  const proposed = await (await createConversationModelGateway(env())).proposeToolCall(messages, [tool]);
  const sent = seen[0]!;
  assert.equal(sent.path, "/api/v1/chat/completions");
  assert.equal(sent.auth, "Bearer local-test-key");
  assert.equal(sent.body.model, PRIMARY);
  assert.equal(sent.body.tool_choice, "required");
  assert.equal(sent.body.tools[0].function.name, "dinarConversationTurn");
  assert.deepEqual(sent.body.provider, { order: ["deepinfra"], allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true });
  assert.equal(proposed.arguments, turn);
  assert.equal(proposed.usage?.inputTokens, 2100, "provider-reported usage reaches DINAR's accounting");
  assert.ok(ModelTurnOutput.safeParse(JSON.parse(proposed.arguments)).success, "the reply validates against DINAR's strict turn schema");
});

await test("GM-02 the turn tool's JSON Schema is closed and strict enough for require_parameters", () => {
  const schema = MODEL_TOOL.parameters as any;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ["confidence", "conversationalReply", "responseKind"]);
  assert.equal(schema.properties.presentation.additionalProperties, false, "the generative-UI proposal is closed too");
});

await test("GM-03 a substituted model on a pinned route is refused, never used as Gemma's answer", async () => {
  next = [answer("google/gemma-3-27b-it", call(turn))];
  await assert.rejects((await createConversationModelGateway(env())).proposeToolCall(messages, [tool]), (error: unknown) => error instanceof AIProviderError && error.code === "INVALID_RESPONSE");
});

await test("GM-04 the efficient model uses the same slot; switching is configuration, not code", async () => {
  seen.length = 0;
  next = [answer(EFFICIENT, call(turn))];
  await (await createConversationModelGateway(env({ DINAR_AI_MODEL: EFFICIENT }))).proposeToolCall(messages, [tool]);
  assert.equal(seen[0]!.body.model, EFFICIENT);
  assert.equal(seen[0]!.body.provider.allow_fallbacks, false);
});

await test("GM-05 thinking is a measured switch: off sends OpenRouter's reasoning field, absent sends nothing", async () => {
  seen.length = 0;
  next = [answer(PRIMARY, call(turn)), answer(PRIMARY, call(turn))];
  await (await createConversationModelGateway(env({ DINAR_AI_THINKING: "disabled" }))).proposeToolCall(messages, [tool]);
  await (await createConversationModelGateway(env())).proposeToolCall(messages, [tool]);
  assert.deepEqual(seen[0]!.body.reasoning, { enabled: false });
  assert.equal("chat_template_kwargs" in seen[0]!.body, false, "vLLM's switch is not sent to OpenRouter");
  assert.equal("reasoning" in seen[1]!.body, false);
});

await test("GM-06 unsafe routing configuration is refused before any request", () => {
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_BASE_URL: "https://api.deepinfra.com/v1/openai", NODE_ENV: "production" })), /apply only to openrouter\.ai/);
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_PROVIDER_ORDER: "" })), /must pin at least one provider/);
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_PROVIDER_ORDER: "DeepInfra; DROP" })), /provider slugs/);
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_DATA_COLLECTION: "allow" })), /may only be "deny"/);
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_ZDR: "false" })), /may only be "true"/);
  assert.throws(() => resolveAIProviderConfiguration(env({ DINAR_AI_BASE_URL: "http://example.com/v1", NODE_ENV: "production" })));
  // DeepInfra direct (fallback) is a plain OPENAI_COMPATIBLE slot without OpenRouter routing.
  const direct = resolveAIProviderConfiguration({ NODE_ENV: "production", DINAR_AI_PROVIDER: "OPENAI_COMPATIBLE", DINAR_AI_BASE_URL: "https://api.deepinfra.com/v1/openai", DINAR_AI_MODEL: "google/gemma-4-26B-A4B-it", DINAR_AI_API_KEY: "x" } as NodeJS.ProcessEnv);
  assert.equal(direct.openRouterRouting, undefined);
});

await test("GM-10 staging and production require a pinned non-free OpenRouter route with privacy controls", () => {
  const secure = env({
    NODE_ENV: "production",
    DINAR_DEPLOYMENT_ENV: "staging",
    DINAR_AI_BASE_URL: "https://openrouter.ai/api/v1",
  });
  const configuration = resolveAIProviderConfiguration(secure);
  assert.deepEqual(configuration.openRouterRouting, {
    order: ["deepinfra"],
    requireParameters: true,
    dataCollection: "deny",
    zdr: true,
  });

  for (const [name, value] of [
    ["DINAR_AI_PROVIDER_ORDER", ""],
    ["DINAR_AI_DATA_COLLECTION", undefined],
    ["DINAR_AI_ZDR", undefined],
    ["DINAR_AI_REQUIRE_PARAMETERS", undefined],
  ] as const) {
    const unsafe = { ...secure };
    if (value === undefined) delete unsafe[name];
    else unsafe[name] = value;
    assert.throws(() => resolveAIProviderConfiguration(unsafe), /staging\/production.*require|requires.*staging\/production/i, name);
  }

  assert.throws(
    () => resolveAIProviderConfiguration({ ...secure, DINAR_AI_PROVIDER: "OPENROUTER" }),
    /pinned OPENAI_COMPATIBLE OpenRouter route/,
    "the direct OpenRouter alias/free route is not deployable",
  );
  assert.throws(
    () => resolveAIProviderConfiguration({ ...secure, DINAR_AI_MODEL: "google/gemma-4-31b-it:free" }),
    /free model IDs are not permitted/,
  );
  assert.throws(
    () => resolveAIProviderConfiguration({ ...secure, DINAR_AI_MODEL: "OPENROUTER/FREE" }),
    /free model IDs are not permitted/,
    "the free alias is rejected without relying on its casing",
  );
  assert.throws(
    () => resolveAIModelRuntimeConfiguration({
      ...secure,
      DINAR_AI_FALLBACK_PROVIDER: "OPENAI_COMPATIBLE",
      DINAR_AI_FALLBACK_MODEL: "google/gemma-4-31b-it:free",
      DINAR_AI_FALLBACK_BASE_URL: "https://openrouter.ai/api/v1",
      DINAR_AI_FALLBACK_PROVIDER_ORDER: "deepinfra",
      DINAR_AI_FALLBACK_DATA_COLLECTION: "deny",
      DINAR_AI_FALLBACK_ZDR: "true",
      DINAR_AI_FALLBACK_REQUIRE_PARAMETERS: "true",
    }),
    /free model IDs are not permitted/,
    "a free OpenRouter route cannot be introduced as a fallback",
  );
});

await test("GM-07 provider failures fail closed: overload, timeout, malformed body, text-only tool call", async () => {
  const gateway = await createConversationModelGateway(env({ DINAR_MODEL_TIMEOUT_MS: "200" }));
  next = [{ status: 503, body: { error: { message: "overloaded" } } }];
  await assert.rejects(gateway.proposeToolCall(messages, [tool]), AIProviderError);
  next = [{ delayMs: 600, body: answer(PRIMARY, call(turn)).body }];
  await assert.rejects(gateway.proposeToolCall(messages, [tool]), AIProviderError);
  next = [{ body: { nonsense: true } }];
  await assert.rejects(gateway.proposeToolCall(messages, [tool]), AIProviderError);
  next = [answer(PRIMARY, { content: '<tool_call>{"name":"dinarConversationTurn"}</tool_call>' }, "stop")];
  await assert.rejects(gateway.proposeToolCall(messages, [tool]), AIProviderError);
});

await test("GM-08 readiness view shows the pinned route and never the key", () => {
  const view = JSON.stringify(describeAIModelReadiness(env()));
  assert.match(view, /"providerRouting":\{"order":\["deepinfra"\],"allowFallbacks":false,"requireParameters":true,"dataCollection":"deny","zdr":true\}/);
  assert.doesNotMatch(view, /local-test-key/);
});

await test("GM-09 benchmark contracts: both Gemma models on OpenRouter and the DeepInfra fallback; history kept", () => {
  for (const id of [PRIMARY, EFFICIENT, "google/gemma-4-31B-it", "google/gemma-4-26B-A4B-it"]) {
    const contract = MODEL_CONTRACTS[id];
    assert.ok(contract, id);
    assert.ok(contract.toolChoices.includes("REQUIRED"), `${id} supports DINAR's forced tool`);
    assert.ok(contract.priceTiers[0]!.outputPer1M > 0, `${id} is a paid route with a recorded price`);
  }
  assert.equal(BENCHMARK_ENDPOINTS.DEEPINFRA, "https://api.deepinfra.com/v1/openai");
  assert.equal(BENCHMARK_CREDENTIALS.DEEPINFRA, "DINAR_BENCH_DEEPINFRA_API_KEY");
  // Historical contracts stay available as evidence, never as defaults.
  for (const id of ["Qwen/Qwen3-14B", "google/gemma-4-31b-it:free", "deepseek-flash"]) assert.ok(MODEL_CONTRACTS[id], id);
});

server.close();
