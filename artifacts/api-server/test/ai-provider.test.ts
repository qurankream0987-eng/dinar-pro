import { IllustrationSchema } from "../src/ai/card-presentation";
import { DisplayDirectiveSchema, PresentationProposalSchema } from "@workspace/api-zod/surface-composition";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AIProviderError,
  createConversationModelGateway,
  normalizeAIProviderError,
  resolveAIModelRuntimeConfiguration,
  resolveAIProviderConfiguration,
  type ConversationModelGateway,
  type ModelMessage,
  type ModelToolDefinition,
} from "../src/ai/model-gateway";
import { readFileSync } from "node:fs";
import { interpretWithModel, MAX_REPLY, MODEL_TOOL, ModelTurnOutput, outputTokensForReply, replyCapacityChars, type ModelTurn } from "../src/ai/model-turn";
import { isGroundedSellerDraftRequest } from "../src/ai/smart-turn";
import { claimsCompletedAction } from "../src/ai/action-receipts";

await test("development defaults to Groq's preferred model", () => {
  assert.deepEqual(resolveAIProviderConfiguration({}), {
    provider: "GROQ",
    requestedModel: "openai/gpt-oss-120b",
    credentialName: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
  });
});

await test("Groq model selection is server-configurable", () => {
  const config = resolveAIProviderConfiguration({
    DINAR_AI_PROVIDER: "GROQ",
    DINAR_AI_MODEL: "openai/gpt-oss-20b",
  });
  assert.equal(config.provider, "GROQ");
  assert.equal(config.requestedModel, "openai/gpt-oss-20b");
  assert.equal(config.credentialName, "GROQ_API_KEY");
  assert.equal(config.baseURL, "https://api.groq.com/openai/v1");
});

await test("Groq free-only benchmark accepts only the exact model and dedicated key", async () => {
  const env = {
    NODE_ENV: "development",
    DINAR_AI_PROVIDER: "GROQ",
    DINAR_GROQ_FREE_ONLY: "true",
    DINAR_GROQ_BENCHMARK_CONTEXT: "1",
    DINAR_AI_MODEL: "openai/gpt-oss-120b",
  };
  const config = resolveAIProviderConfiguration(env);
  assert.equal(config.provider, "GROQ");
  assert.equal(config.credentialName, "DINAR_BENCH_GROQ_API_KEY");
  assert.equal(config.transport, "CHAT_COMPLETIONS");
  assert.equal(config.toolChoice, "AUTO");
  const gateway = await createConversationModelGateway({ ...env, DINAR_BENCH_GROQ_API_KEY: "test-only-groq-key" });
  assert.deepEqual(gateway.providerInfo, { provider: "GROQ", requestedModel: "openai/gpt-oss-120b", maxOutputTokens: 8192 });
  assert.throws(
    () => resolveAIProviderConfiguration({ ...env, DINAR_AI_MODEL: "openai/gpt-oss-20b" }),
    /exact approved Groq benchmark model ID/,
  );
  assert.throws(
    () => resolveAIProviderConfiguration({ ...env, NODE_ENV: "production" }),
    /isolated development benchmark/,
  );
  assert.throws(
    () => resolveAIProviderConfiguration({ ...env, DINAR_GROQ_BENCHMARK_CONTEXT: undefined }),
    /isolated development benchmark/,
  );
});

await test("DeepSeek benchmark and conversation modes are model-pinned and never share a credential", async () => {
  const env = {
    NODE_ENV: "development",
    DINAR_AI_PROVIDER: "DEEPSEEK",
    DEEPSEEK_BENCHMARK_CONTEXT: "1",
    DINAR_AI_MODEL: "deepseek-flash",
  };
  const policy = { provider: "DEEPSEEK", requestedModel: "deepseek-flash", baseURL: "https://api.deepseek.com", transport: "CHAT_COMPLETIONS", toolChoice: "REQUIRED", reasoningEffort: "none" };
  assert.deepEqual(resolveAIProviderConfiguration(env), { ...policy, credentialName: "DINAR_BENCH_DEEPSEEK_API_KEY" });
  const gateway = await createConversationModelGateway({ ...env, DINAR_BENCH_DEEPSEEK_API_KEY: "test-only-deepseek-key" });
  assert.deepEqual(gateway.providerInfo, { provider: "DEEPSEEK", requestedModel: "deepseek-flash", maxOutputTokens: 8192 });
  for (const patch of [
    { NODE_ENV: "production" },
    { DINAR_AI_MODEL: "deepseek-v4-pro" },
    { DINAR_AI_MODEL: undefined },
    { REPLIT_DEPLOYMENT: "true" },
    { RAILWAY_ENVIRONMENT: "production" },
    { DINAR_AI_FALLBACK_PROVIDER: "OPENAI" },
  ]) assert.throws(() => resolveAIProviderConfiguration({ ...env, ...patch }));
  assert.throws(() => resolveAIProviderConfiguration({ DINAR_AI_PROVIDER: "GROQ", DINAR_AI_FALLBACK_PROVIDER: "DEEPSEEK", DINAR_AI_FALLBACK_MODEL: "deepseek-flash" }, "FALLBACK"));
  await assert.rejects(
    createConversationModelGateway({ ...env, DINAR_BENCH_DEEPSEEK_API_KEY: undefined, DINAR_DEEPSEEK_API_KEY: "must-not-be-used", OPENAI_API_KEY: "must-not-be-used" }),
    (error: unknown) => error instanceof AIProviderError && error.provider === "DEEPSEEK" && error.code === "NOT_CONFIGURED",
  );
  // Conversation mode: an explicit owner selection with its own key; the benchmark key never serves it.
  const conversation = { NODE_ENV: "development", DINAR_AI_PROVIDER: "DEEPSEEK", DINAR_AI_MODEL: "deepseek-flash" };
  assert.deepEqual(resolveAIProviderConfiguration(conversation), { ...policy, credentialName: "DINAR_DEEPSEEK_API_KEY" });
  await assert.rejects(
    createConversationModelGateway({ ...conversation, DINAR_BENCH_DEEPSEEK_API_KEY: "benchmark-key-must-not-be-used" }),
    (error: unknown) => error instanceof AIProviderError && error.provider === "DEEPSEEK" && error.code === "NOT_CONFIGURED",
  );
  assert.equal((await createConversationModelGateway({ ...conversation, DINAR_DEEPSEEK_API_KEY: "test-only-conversation-key" })).providerInfo?.provider, "DEEPSEEK");
  // Nothing selects DeepSeek implicitly.
  assert.equal(resolveAIProviderConfiguration({ NODE_ENV: "development", DINAR_DEEPSEEK_API_KEY: "present" }).provider, "GROQ");
});

/** A DeepSeek Chat Completions body in the documented shape (api-docs.deepseek.com/api/create-chat-completion). */
function deepseekBody(message: Record<string, unknown>, finish_reason: string, usage: Record<string, unknown> = { prompt_tokens: 90, completion_tokens: 40, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 26, prompt_tokens_details: { cached_tokens: 64 } }) {
  return { id: "deepseek-synthetic", object: "chat.completion", model: "deepseek-flash", choices: [{ index: 0, finish_reason, message: { role: "assistant", content: null, ...message } }], usage };
}
const turnCall = (args: string, id = "call-synthetic") => ({ id, type: "function", function: { name: "dinarConversationTurn", arguments: args } });

async function withDeepSeek<T>(bodies: unknown[], run: (gateway: ConversationModelGateway, requests: { url: string; init?: RequestInit }[]) => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const body = bodies[Math.min(requests.length - 1, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gateway = await createConversationModelGateway({
      NODE_ENV: "development", DINAR_AI_PROVIDER: "DEEPSEEK", DEEPSEEK_BENCHMARK_CONTEXT: "1",
      DINAR_AI_MODEL: "deepseek-flash", DINAR_BENCH_DEEPSEEK_API_KEY: "test-only-deepseek-key",
      DINAR_AI_MAX_RETRIES: "0", DINAR_AI_MAX_OUTPUT_TOKENS: "500", ...extra,
    });
    return await run(gateway, requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await test("DeepSeek Chat Completions sends the non-thinking forced-tool request and the canonical DINAR tool contract", async () => {
  const valid = JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "إجابة اصطناعية" });
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(valid)] }, "tool_calls")], async (gateway, requests) => {
    const tool: ModelToolDefinition = { name: "dinarConversationTurn", description: "structured turn", parameters: { type: "object", properties: { responseKind: { type: "string" } }, required: ["responseKind"], additionalProperties: false } };
    const history: ModelMessage[] = [{ role: "system", content: "نظام" }, { role: "user", content: "سؤال سابق" }, { role: "assistant", content: "جواب سابق" }, { role: "user", content: "سؤال عربي اصطناعي" }];
    const result = await gateway.proposeToolCall(history, [tool]);
    assert.equal(requests[0]!.url, "https://api.deepseek.com/chat/completions");
    assert.equal(new Headers(requests[0]!.init?.headers).get("authorization"), "Bearer test-only-deepseek-key");
    assert.ok(requests[0]!.init?.signal);
    const request = JSON.parse(String(requests[0]!.init?.body));
    assert.equal(request.model, "deepseek-flash");
    assert.equal(request.max_tokens, 500);
    assert.equal(request.max_completion_tokens, undefined);
    assert.equal(request.reasoning_effort, "none");
    assert.equal(request.tool_choice, "required");
    assert.equal(request.stream, undefined);
    // Fields DeepSeek does not document are never forwarded.
    for (const field of ["parallel_tool_calls", "provider", "store", "temperature"]) assert.equal(request[field], undefined, field);
    // DeepSeek's documented non-thinking switch, beside its equivalent reasoning_effort=none.
    assert.deepEqual(request.thinking, { type: "disabled" });
    assert.deepEqual(request.messages, history);
    assert.deepEqual(request.tools[0].function.parameters, tool.parameters);
    assert.deepEqual(result.usage, { inputTokens: 90, outputTokens: 40, cachedInputTokens: 64 });
    assert.equal(result.providerRequestId, "deepseek-synthetic");
    const validated = await interpretWithModel(gateway, "سؤال اصطناعي", {}, 1000);
    assert.equal(validated.ok, true);
  });
});

await test("the composer's per-turn depth preference never blocks or changes a DeepSeek turn", async () => {
  const valid = JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "تم" });
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(valid)] }, "tool_calls")], async (gateway, requests) => {
    for (const reasoningEffort of ["low", "medium", "high"] as const) {
      const result = await interpretWithModel(gateway, "سؤال اصطناعي", { reasoningEffort }, 1000);
      assert.equal(result.ok, true, reasoningEffort);
    }
    assert.equal(requests.length, 3);
    for (const request of requests) {
      const body = JSON.parse(String(request.init?.body));
      assert.deepEqual([body.reasoning_effort, body.tool_choice], ["none", "required"]);
    }
  });
});

await test("DeepSeek outcomes are classified from finish_reason, keep billed usage and are never mislabelled malformed", async () => {
  const cases: [unknown, string, string | undefined][] = [
    // The 2026-10-24 failure shape: arguments cut at the 500-token ceiling.
    [deepseekBody({ tool_calls: [turnCall('{"responseKind":"CONVERSATIONAL_RESPONSE","confidence":0.9,"conversationalReply":"مرحبا')] }, "length", { prompt_tokens: 3600, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 344 } }), "INVALID_RESPONSE", "OUTPUT_LIMIT"],
    [deepseekBody({ content: "", reasoning_content: "تفكير" }, "length", { prompt_tokens: 3600, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 } }), "INVALID_RESPONSE", "OUTPUT_LIMIT"],
    [deepseekBody({ content: "رد نصي بلا أداة" }, "stop"), "INVALID_RESPONSE", "NO_TOOL_CALL"],
    [deepseekBody({ tool_calls: [turnCall("{}", "a"), turnCall("{}", "b")] }, "tool_calls"), "INVALID_RESPONSE", "NO_TOOL_CALL"],
    [deepseekBody({ content: "" }, "content_filter"), "INVALID_RESPONSE", "REFUSAL"],
    [deepseekBody({ content: "" }, "insufficient_system_resource"), "UNAVAILABLE", undefined],
    // R3: a complete-looking call the provider filtered or aborted is never a usable turn.
    [deepseekBody({ tool_calls: [turnCall('{"responseKind":"CONVERSATIONAL_RESPONSE","confidence":0.9,"conversationalReply":"مرحبا"}')] }, "content_filter"), "INVALID_RESPONSE", "REFUSAL"],
    [deepseekBody({ tool_calls: [turnCall('{"responseKind":"CONVERSATIONAL_RESPONSE","confidence":0.9,"conversationalReply":"مرحبا"}')] }, "aborted"), "INVALID_RESPONSE", "INCOMPLETE"],
    [deepseekBody({ tool_calls: [turnCall('{"responseKind":"CONVERSATIONAL_RESPONSE","confidence":0.9,"conversationalReply":"مرحبا"}')] }, "unknown_future_reason"), "INVALID_RESPONSE", "INCOMPLETE"],
  ];
  for (const [body, code, detail] of cases)
    await withDeepSeek([body], async (gateway) => {
      await assert.rejects(gateway.proposeToolCall([{ role: "user", content: "س" }], []), (error: unknown) => {
        assert.ok(error instanceof AIProviderError);
        assert.deepEqual([error.code, error.detail, typeof error.usage?.inputTokens], [code, detail, "number"], `${code} ${detail}`);
        return true;
      });
    });
});

await test("DeepSeek finish reasons and unusable output reach the benchmark evidence, never an enumerable or logged field", async () => {
  const valid = JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "مرحبا" });
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(valid)] }, "tool_calls")], async (gateway) => {
    assert.equal((await gateway.proposeToolCall([{ role: "user", content: "س" }], [])).finishReason, "tool_calls");
  });
  const cut = '{"responseKind":"CONVERSATIONAL_RESPONSE","conversationalReply":"مرح';
  for (const [body, finishReason, excerpt] of [
    [deepseekBody({ tool_calls: [turnCall(cut)] }, "length"), "length", cut],
    [deepseekBody({ content: "رد نصي بلا أداة" }, "stop"), "stop", "رد نصي بلا أداة"],
    [deepseekBody({ content: "" }, "insufficient_system_resource"), "insufficient_system_resource", undefined],
  ] as const)
    await withDeepSeek([body], async (gateway) => {
      await assert.rejects(gateway.proposeToolCall([{ role: "user", content: "س" }], []), (error: unknown) => {
        assert.ok(error instanceof AIProviderError);
        assert.equal(error.finishReason, finishReason);
        assert.equal(error.responseExcerpt, excerpt);
        assert.equal(Object.keys(error).includes("responseExcerpt"), false);
        if (excerpt) assert.equal(JSON.stringify(error).includes(excerpt), false, "the excerpt is never serialized");
        return true;
      });
    });
});

/** Real R2 deepseek-flash responses (synthetic inputs), recorded once; replaying them sends nothing. */
const r2 = JSON.parse(readFileSync("test/fixtures/deepseek-r2-live-responses.json", "utf8")) as {
  measurementKind: string;
  cases: { taskId: string; message: string; finishReason: string; arguments: string; benchmarkOutcome: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }[];
};

await test("recorded R2 DeepSeek responses replay through the gateway and DINAR's Zod contract with the live verdicts", async () => {
  assert.equal(r2.measurementKind, "RECORDED_LIVE_PROVIDER");
  const expected: Record<string, [boolean, string | undefined, string | undefined]> = {
    "deepseek-general-arabic": [true, "CONVERSATIONAL_RESPONSE", undefined],
    // Rejected live (84-character intent; the fixture keeps that verdict). Since R3 the label is
    // clamped and the turn is usable; the model's own action choice (NONE) is unchanged.
    "deepseek-levantine-seller": [true, "CLARIFICATION_REQUIRED", "NONE"],
    "deepseek-search-compare": [true, "SEARCH_INTENT", "SEARCH_LISTINGS"],
    "deepseek-context-continuity": [true, "GROUNDED_ADVICE", "NONE"],
  };
  assert.equal(r2.cases.find((item) => item.taskId === "deepseek-levantine-seller")!.benchmarkOutcome, "MODEL_CONTRACT_VIOLATION", "the live verdict is preserved for audit");
  for (const recorded of r2.cases) {
    const usage = { prompt_tokens: recorded.usage.inputTokens, completion_tokens: recorded.usage.outputTokens, prompt_tokens_details: { cached_tokens: recorded.usage.cachedInputTokens } };
    await withDeepSeek([deepseekBody({ tool_calls: [turnCall(recorded.arguments)] }, recorded.finishReason, usage)], async (gateway, requests) => {
      const result = await interpretWithModel(gateway, recorded.message, {}, 5_000);
      const [ok, kind, action] = expected[recorded.taskId]!;
      assert.equal(result.ok, ok, recorded.taskId);
      assert.equal(requests.length, 1, "a rejected turn is never retried");
      if (result.ok) assert.deepEqual([result.turn.responseKind, result.turn.suggestedAction], [kind, action], recorded.taskId);
      else assert.equal(result.reason, "MALFORMED");
      assert.deepEqual(result.modelCall.usage, { inputTokens: recorded.usage.inputTokens, outputTokens: recorded.usage.outputTokens, cachedInputTokens: recorded.usage.cachedInputTokens });
    });
  }
});

await test("the dinarConversationTurn tool schema states every bound DINAR's Zod contract enforces", () => {
  const seller = JSON.parse(r2.cases.find((item) => item.taskId === "deepseek-levantine-seller")!.arguments);
  // The R2 seller turn was rejected for an 84-character intent the schema never limited.
  assert.ok(seller.intent.length > 60);
  assert.deepEqual(ModelTurnOutput.safeParse(seller).error?.issues.map((issue) => issue.path.join(".")), ["intent"]);
  const properties = MODEL_TOOL.parameters.properties as Record<string, any>;
  const base = { responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.5, conversationalReply: "رد" };
  const accepts = (patch: Record<string, unknown>) => ModelTurnOutput.safeParse({ ...base, ...patch }).success;
  const text = (length: number) => "س".repeat(length);
  assert.equal(properties.intent.maxLength, 60);
  assert.ok(accepts({ intent: text(60) }) && !accepts({ intent: text(61) }));
  assert.equal(properties.entities.properties.item.maxLength, 160);
  assert.ok(accepts({ entities: { item: text(160) } }) && !accepts({ entities: { item: text(161) } }));
  for (const field of ["knownFacts", "uncertainFacts", "missingFacts", "preferences"]) {
    assert.deepEqual([properties[field].maxItems, properties[field].items.maxLength], [8, 160], field);
    assert.ok(accepts({ [field]: Array(8).fill(text(160)) }) && !accepts({ [field]: Array(9).fill("x") }) && !accepts({ [field]: [text(161)] }), field);
  }
  assert.deepEqual([properties.confidence.minimum, properties.confidence.maximum], [0, 1]);
  assert.ok(!accepts({ confidence: 1.01 }));
  assert.equal(properties.conversationalReply.maxLength, MAX_REPLY);
  assert.ok(accepts({ conversationalReply: text(MAX_REPLY) }) && !accepts({ conversationalReply: text(MAX_REPLY + 1) }));
  assert.deepEqual([properties.targetReference.properties.ordinal.minimum, properties.targetReference.properties.ordinal.maximum], [1, 24]);
  assert.ok(!accepts({ targetReference: { kind: "ORDINAL", ordinal: 25 } }));
  assert.deepEqual([properties.entities.properties.quantity.minimum, properties.entities.properties.quantity.maximum], [1, 100]);
  assert.ok(!accepts({ entities: { quantity: 101 } }));
  // DeepSeek receives the bounded schema verbatim.
  return withDeepSeek([deepseekBody({ tool_calls: [turnCall(JSON.stringify(base))] }, "tool_calls")], async (gateway, requests) => {
    await interpretWithModel(gateway, "س", {}, 5_000);
    assert.equal(JSON.parse(String(requests[0]!.init?.body)).tools[0].function.parameters.properties.intent.maxLength, 60);
  });
});

/**
 * R3: the provider-facing schema is hand-written (Zod's own JSON output would use
 * exclusiveMinimum, which Gemini rejects, and drops the descriptions), so this walks the Zod
 * contract field by field: a field, bound, enum value or strictness added to one and not the
 * other fails here, before any provider sees it.
 */
// Zod 4 introspection: a schema's definition is `_zod.def` (its kind in `type`), and each check is
// an object whose `_zod.def.check` names it. The walker compares exactly what the Zod 3 version did.
const zodChecks = (def: any) => (def.checks ?? []).map((check: any) => check._zod.def);
function zodMirrorIssues(schema: any, json: any, path: string): string[] {
  const def = schema._zod.def;
  const at = path || "<root>";
  switch (def.type) {
    case "object": {
      const issues: string[] = [];
      if (json.type !== "object") return [`${at}: type ${json.type}`];
      // .strict() is a `never` catchall: unknown keys are refused, so the tool must be closed too.
      if (def.catchall?._zod.def.type === "never" && json.additionalProperties !== false) issues.push(`${at}: not closed`);
      const shape = def.shape as Record<string, any>;
      const required = Object.keys(shape).filter((key) => shape[key]._zod.def.type !== "optional").sort();
      if (JSON.stringify(required) !== JSON.stringify([...(json.required ?? [])].sort())) issues.push(`${at}: required ${json.required} vs ${required}`);
      for (const key of new Set([...Object.keys(shape), ...Object.keys(json.properties ?? {})])) {
        if (!shape[key]) issues.push(`${path}.${key}: only in the tool schema`);
        else if (!json.properties?.[key]) issues.push(`${path}.${key}: only in Zod`);
        else issues.push(...zodMirrorIssues(shape[key], json.properties[key], `${path}.${key}`));
      }
      return issues;
    }
    case "optional":
      return zodMirrorIssues(def.innerType, json, path);
    case "enum":
      return JSON.stringify(Object.values(def.entries)) === JSON.stringify(json.enum) && json.type === "string" ? [] : [`${at}: enum`];
    case "array": {
      const max = zodChecks(def).find((check: any) => check.check === "max_length")?.maximum;
      return [
        ...(json.type !== "array" || max !== json.maxItems ? [`${at}: array bound`] : []),
        ...zodMirrorIssues(def.element, json.items, `${path}[]`),
      ];
    }
    case "string": {
      const checks = zodChecks(def);
      const max = checks.find((check: any) => check.check === "max_length")?.maximum;
      // A regex-constrained string is described in words (no provider pattern dialect is assumed).
      const patterned = checks.some((check: any) => check.check === "string_format" && check.format === "regex");
      return json.type === "string" && (patterned ? Boolean(json.description) : max === json.maxLength) ? [] : [`${at}: string bound ${max} vs ${json.maxLength}`];
    }
    case "number": {
      const checks = zodChecks(def);
      const integer = checks.some((check: any) => check.check === "number_format" && ["safeint", "int32", "uint32"].includes(check.format));
      const min = checks.find((check: any) => check.check === "greater_than");
      const max = checks.find((check: any) => check.check === "less_than");
      const issues: string[] = [];
      if (json.type !== (integer ? "integer" : "number")) issues.push(`${at}: type ${json.type}`);
      if (max?.value !== json.maximum) issues.push(`${at}: maximum`);
      // positive() is exclusive at 0; the tool states minimum 0 and Zod still refuses 0.
      if ((min?.inclusive === false && min.value === 0 ? 0 : min?.value) !== json.minimum) issues.push(`${at}: minimum`);
      return issues;
    }
    case "literal":
      return JSON.stringify(def.values) === JSON.stringify(json.enum) ? [] : [`${at}: literal`];
    case "unknown":
      // Generative UI: `presentation` is opaque in ModelTurnOutput so a bad proposal never drops
      // the turn; the server enforces PresentationProposalSchema, which the tool must mirror.
      // Phase 2: `display` is opaque for the same reason; the tool mirrors DisplayDirectiveSchema.
      return path === ".presentation"
        ? zodMirrorIssues(PresentationProposalSchema, json, path)
        : path === ".display"
          ? zodMirrorIssues(DisplayDirectiveSchema, json, path)
          // Flexible cards: `illustration` is opaque for the same reason; the tool mirrors IllustrationSchema.
          : path === ".illustration"
            ? zodMirrorIssues(IllustrationSchema, json, path)
            : [`${at}: unhandled unknown`];
    default:
      return [`${at}: unhandled ${def.type}`];
  }
}

await test("R3: the dinarConversationTurn tool schema mirrors every field, bound, enum and strictness of the Zod contract", () => {
  assert.deepEqual(zodMirrorIssues(ModelTurnOutput, MODEL_TOOL.parameters, ""), []);
  // The walker itself catches drift: a field missing from the tool, a looser bound, an open object.
  const drifted = structuredClone(MODEL_TOOL.parameters) as any;
  delete drifted.properties.goal;
  drifted.properties.entities.properties.quantity.maximum = 1000;
  delete drifted.properties.targetReference.additionalProperties;
  drifted.properties.suggestedAction.enum.push("EXECUTE_PURCHASE");
  assert.deepEqual(zodMirrorIssues(ModelTurnOutput, drifted, "").sort(), [".entities.quantity: maximum", ".goal: only in Zod", ".suggestedAction: enum", ".targetReference: not closed"]);
});

await test("an output-limited DeepSeek turn is not re-billed by a retry and its reported usage reaches the call record", async () => {
  const previous = process.env.DINAR_AI_MAX_RETRIES;
  process.env.DINAR_AI_MAX_RETRIES = "1";
  try {
  const truncated = deepseekBody({ tool_calls: [turnCall('{"responseKind":"CONVERSATIONAL_RESPONSE","conversationalReply":"مرح')] }, "length", { prompt_tokens: 3600, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 2300 } });
  await withDeepSeek([truncated], async (gateway, requests) => {
    const result = await interpretWithModel(gateway, "سؤال اصطناعي", {}, 10_000);
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1, "OUTPUT_LIMIT must not be retried");
    assert.deepEqual(result.modelCall.calls, [{ kind: "PRIMARY", outcome: "FAILED", provider: "DEEPSEEK", model: "deepseek-flash", inputTokens: 3600, outputTokens: 500, cachedInputTokens: 2300 }]);
  });
  // A transient overload is still retried once, and each billed request is recorded.
  const overloaded = deepseekBody({ content: "" }, "insufficient_system_resource");
  const valid = deepseekBody({ tool_calls: [turnCall(JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "تم" }))] }, "tool_calls");
    await withDeepSeek([overloaded, valid], async (gateway, requests) => {
      const result = await interpretWithModel(gateway, "سؤال اصطناعي", {}, 10_000);
      assert.equal(result.ok, true);
      assert.equal(requests.length, 2);
      assert.deepEqual(result.modelCall.calls?.map((call) => [call.kind, call.outcome, call.inputTokens]), [["PRIMARY", "FAILED", 90], ["RETRY", "SUCCESS", 90]]);
    });
  } finally {
    if (previous === undefined) delete process.env.DINAR_AI_MAX_RETRIES;
    else process.env.DINAR_AI_MAX_RETRIES = previous;
  }
});

await test("missing dedicated Groq benchmark credential never falls back to production keys", async () => {
  await assert.rejects(
    createConversationModelGateway({
      NODE_ENV: "development",
      DINAR_AI_PROVIDER: "GROQ",
      DINAR_GROQ_FREE_ONLY: "true",
      DINAR_GROQ_BENCHMARK_CONTEXT: "1",
      DINAR_AI_MODEL: "openai/gpt-oss-120b",
      GROQ_API_KEY: "must-not-be-used",
    }),
    (error: unknown) => error instanceof AIProviderError && error.provider === "GROQ" && error.code === "NOT_CONFIGURED",
  );
});

await test("Groq free-only transport sends the existing JSON-schema tool over Chat Completions", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      id: "chatcmpl-synthetic",
      model: "openai/gpt-oss-120b",
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call-synthetic",
            type: "function",
            function: {
              name: "dinarConversationTurn",
              arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "إجابة اختبارية" }),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 80, completion_tokens: 24 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const controller = new AbortController();
    const gateway = await createConversationModelGateway({
      NODE_ENV: "development",
      DINAR_AI_PROVIDER: "GROQ",
      DINAR_GROQ_FREE_ONLY: "true",
      DINAR_GROQ_BENCHMARK_CONTEXT: "1",
      DINAR_AI_MODEL: "openai/gpt-oss-120b",
      DINAR_BENCH_GROQ_API_KEY: "test-only-groq-key",
      DINAR_AI_MAX_RETRIES: "0",
      DINAR_AI_MAX_OUTPUT_TOKENS: "512",
    });
    const messages: ModelMessage[] = [{ role: "system", content: "synthetic system" }, { role: "user", content: "سؤال اصطناعي" }];
    const tool: ModelToolDefinition = {
      name: "dinarConversationTurn",
      description: "Return a DINAR structured conversational turn.",
      parameters: { type: "object", properties: { responseKind: { type: "string" } }, required: ["responseKind"], additionalProperties: false },
    };
    const result = await gateway.proposeToolCall(messages, [tool], { signal: controller.signal });
    assert.equal(capturedUrl, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(new Headers(capturedInit?.headers).get("authorization"), "Bearer test-only-groq-key");
    assert.ok(capturedInit?.signal, "the SDK request must carry timeout/cancellation handling");
    const request = JSON.parse(String(capturedInit?.body));
    assert.equal(request.model, "openai/gpt-oss-120b");
    assert.equal(request.tool_choice, "auto");
    assert.equal(request.parallel_tool_calls, false);
    assert.deepEqual(request.tools[0].function.parameters, tool.parameters);
    assert.equal(request.max_completion_tokens, 512);
    assert.equal(request.reasoning_effort, undefined);
    assert.equal(result.name, "dinarConversationTurn");
    assert.equal(result.actualModel, "openai/gpt-oss-120b");
    assert.deepEqual(result.usage, { inputTokens: 80, outputTokens: 24 });
    const validatedTurn = await interpretWithModel(gateway, "سؤال عربي اصطناعي", {}, 1000);
    assert.equal(validatedTurn.ok, true);
    if (validatedTurn.ok) assert.equal(validatedTurn.turn.conversationalReply, "إجابة اختبارية");
    const zodContractRequest = JSON.parse(String(capturedInit?.body));
    assert.equal(zodContractRequest.tools[0].function.name, "dinarConversationTurn");
    assert.equal(zodContractRequest.tools[0].function.parameters.additionalProperties, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("OpenAI adapter remains explicitly selectable", async () => {
  const config = resolveAIProviderConfiguration({
    DINAR_AI_PROVIDER: "OPENAI",
  });
  assert.equal(config.provider, "OPENAI");
  assert.equal(config.requestedModel, "gpt-5.6-terra");
  assert.equal(config.credentialName, "OPENAI_API_KEY");

  const gateway = await createConversationModelGateway({
    DINAR_AI_PROVIDER: "OPENAI",
    OPENAI_API_KEY: "test-openai-key",
  });
  assert.deepEqual(gateway.providerInfo, {
    provider: "OPENAI",
    requestedModel: "gpt-5.6-terra",
    maxOutputTokens: 8192,
  });
});

await test("Replit AI Integrations adapter is explicit and needs both its key and endpoint", async () => {
  const config = resolveAIProviderConfiguration({
    DINAR_AI_PROVIDER: "REPLIT_OPENAI",
    AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:1106/openai",
    DINAR_AI_MODEL: "qwen/qwen3.8-27b",
  });
  assert.deepEqual(config, {
    provider: "REPLIT_OPENAI",
    requestedModel: "gpt-5-mini",
    credentialName: "AI_INTEGRATIONS_OPENAI_API_KEY",
    baseURL: "http://127.0.0.1:1106/openai",
  });
  const gateway = await createConversationModelGateway({
    DINAR_AI_PROVIDER: "REPLIT_OPENAI",
    AI_INTEGRATIONS_OPENAI_API_KEY: "test-replit-key",
    AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:1106/openai",
  });
  assert.deepEqual(gateway.providerInfo, { provider: "REPLIT_OPENAI", requestedModel: "gpt-5-mini", maxOutputTokens: 8192 });
  for (const env of [
    { DINAR_AI_PROVIDER: "REPLIT_OPENAI", AI_INTEGRATIONS_OPENAI_API_KEY: "test-replit-key" },
    { DINAR_AI_PROVIDER: "REPLIT_OPENAI", AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:1106/openai", OPENAI_API_KEY: "test-openai-key" },
  ])
    await assert.rejects(
      createConversationModelGateway(env),
      (error: unknown) => error instanceof AIProviderError && error.provider === "REPLIT_OPENAI" && error.code === "NOT_CONFIGURED",
    );
});

await test("missing Groq credentials never fall back to a present OpenAI key", async () => {
  await assert.rejects(
    createConversationModelGateway({
      DINAR_AI_PROVIDER: "GROQ",
      OPENAI_API_KEY: "test-openai-key",
    }),
    (error: unknown) =>
      error instanceof AIProviderError &&
      error.provider === "GROQ" &&
      error.code === "NOT_CONFIGURED",
  );
});

await test("Gemma free-only mode accepts only exact free IDs and the isolated benchmark credential", async () => {
  const model = "google/gemma-4-26b-a4b-it:free";
  const config = resolveAIProviderConfiguration({
    DINAR_AI_PROVIDER: "OPENROUTER",
    DINAR_GEMMA_FREE_ONLY: "true",
    DINAR_AI_MODEL: model,
  });
  assert.equal(config.requestedModel, model);
  assert.equal(config.credentialName, "DINAR_BENCH_OPENROUTER_API_KEY");
  assert.equal(config.toolChoice, "AUTO");
  assert.equal(config.gemmaFreeOnly, true);
  assert.throws(
    () => resolveAIProviderConfiguration({ DINAR_AI_PROVIDER: "OPENROUTER", DINAR_GEMMA_FREE_ONLY: "true", DINAR_AI_MODEL: "google/gemma-4-26b-a4b-it" }),
    /exact approved Gemma :free model IDs/,
  );
  assert.throws(
    () => resolveAIProviderConfiguration({ DINAR_AI_PROVIDER: "OPENROUTER", DINAR_GEMMA_FREE_ONLY: "true", DINAR_AI_MODEL: "openrouter/free" }, "FALLBACK"),
    /does not allow fallback/,
  );
  await assert.rejects(
    createConversationModelGateway({ NODE_ENV: "development", DINAR_AI_PROVIDER: "OPENROUTER", DINAR_GEMMA_FREE_ONLY: "true", DINAR_AI_MODEL: model, OPENROUTER_API_KEY: "must-not-be-used" }),
    (error: unknown) => error instanceof AIProviderError && error.code === "NOT_CONFIGURED",
  );
});

await test("Gemma free-only quota is surfaced once and paid fallback configuration is refused", async () => {
  const model = "google/gemma-4-31b-it:free";
  const gateway: ConversationModelGateway = {
    providerInfo: { provider: "OPENROUTER", requestedModel: model },
    async proposeToolCall() {
      throw normalizeAIProviderError("OPENROUTER", model, { status: 429, message: "private quota response" }, 18);
    },
  };
  const result = await interpretWithModel(gateway, "سؤال عربي اصطناعي", {}, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "QUOTA_LIMITED");
  assert.equal(result.modelCall.providerCalls, 1, "quota exhaustion is not retried");

  assert.throws(
    () =>
      resolveAIModelRuntimeConfiguration({
        NODE_ENV: "development",
        DINAR_AI_PROVIDER: "OPENROUTER",
        DINAR_GEMMA_FREE_ONLY: "true",
        DINAR_AI_MODEL: model,
        DINAR_AI_FALLBACK_PROVIDER: "OPENAI",
        DINAR_AI_FALLBACK_MODEL: "gpt-4.1-mini",
      }),
    /fallback/i,
    "free-only quota exhaustion must not be routed to a paid model",
  );
});

await test("invalid provider configuration fails explicitly", () => {
  assert.throws(
    () => resolveAIProviderConfiguration({ DINAR_AI_PROVIDER: "UNKNOWN" }),
    /DINAR_AI_PROVIDER must be GROQ, OPENROUTER, OPENAI, REPLIT_OPENAI, OPENAI_COMPATIBLE, GEMINI or DEEPSEEK/,
  );
});

await test("an exhausted prepaid balance (HTTP 402) is a configuration fault, never retried as an outage", () => {
  const error = normalizeAIProviderError("DEEPSEEK", "deepseek-flash", Object.assign(new Error("Insufficient Balance"), { status: 402 }), 12);
  assert.deepEqual([error.code, error.httpStatus, error.message], ["NOT_CONFIGURED", 402, "JassimAI provider request failed."]);
});

await test("429 errors are normalized without exposing the upstream message", () => {
  const normalized = normalizeAIProviderError(
    "GROQ",
    "openai/gpt-oss-120b",
    { status: 429, message: "private raw upstream response" },
    135,
  );
  assert.equal(normalized.code, "QUOTA_LIMITED");
  assert.equal(normalized.httpStatus, 429);
  assert.equal(normalized.latencyMs, 135);
  assert.doesNotMatch(normalized.message, /private raw upstream response/);
});

await test("the structured turn reports a Groq quota limit instead of inventing output", async () => {
  const gateway: ConversationModelGateway = {
    providerInfo: {
      provider: "GROQ",
      requestedModel: "openai/gpt-oss-120b",
    },
    async proposeToolCall() {
      throw normalizeAIProviderError(
        "GROQ",
        "openai/gpt-oss-120b",
        { status: 429, message: "private upstream response" },
        42,
      );
    },
  };
  const result = await interpretWithModel(gateway, "أبحث عن منتج", {}, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "QUOTA_LIMITED");
  assert.deepEqual(result.modelCall, {
    provider: "GROQ",
    requestedModel: "openai/gpt-oss-120b",
    actualModel: undefined,
    latencyMs: 42,
    // NEXT G1 metering: the quota-limited request was issued once and is not retried.
    providerCalls: 1,
    // Pre-integration closure: each request is recorded for cost accounting (no retry on quota).
    calls: [{ kind: "PRIMARY", outcome: "FAILED", provider: "GROQ", model: "openai/gpt-oss-120b" }],
  });
});

await test("null optional fields are absent; a null required field is still rejected", async () => {
  const reply = (args: Record<string, unknown>): ConversationModelGateway => ({
    async proposeToolCall() {
      return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify(args) };
    },
  });
  const accepted = await interpretWithModel(
    reply({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "خطاب كامل", entities: { item: null, maxPrice: null }, suggestedAction: null, targetReference: null }),
    "اكتب لي خطابًا",
    {},
    1000,
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ok && accepted.turn.conversationalReply, "خطاب كامل");
  const rejected = await interpretWithModel(
    reply({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: null }),
    "اكتب لي خطابًا",
    {},
    1000,
  );
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.reason, "MALFORMED");
});

await test("the selected effort reaches the structured model call", async () => {
  let receivedEffort: string | undefined;
  const gateway: ConversationModelGateway = {
    async proposeToolCall(_messages, _tools, options) {
      receivedEffort = options?.reasoningEffort;
      return {
        id: "effort-test",
        name: "dinarConversationTurn",
        arguments: JSON.stringify({
          responseKind: "CONVERSATIONAL_RESPONSE",
          confidence: 0.9,
          conversationalReply: "إجابة اختبارية",
        }),
      };
    },
  };
  const result = await interpretWithModel(
    gateway,
    "اشرح لي بإيجاز",
    { reasoningEffort: "high" },
    1000,
  );
  assert.equal(result.ok, true);
  assert.equal(receivedEffort, "high");
});

console.log("AI provider selection and safe error handling passed");

await test("R3: the recorded R2 seller turn is usable: an over-long advisory intent label is clamped, never the reason a turn is lost", async () => {
  const recorded = r2.cases.find((item) => item.taskId === "deepseek-levantine-seller")!;
  const usage = { prompt_tokens: recorded.usage.inputTokens, completion_tokens: recorded.usage.outputTokens, prompt_tokens_details: { cached_tokens: recorded.usage.cachedInputTokens } };
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(recorded.arguments)] }, recorded.finishReason, usage)], async (gateway, requests) => {
    const result = await interpretWithModel(gateway, recorded.message, {}, 5_000);
    assert.equal(requests.length, 1);
    assert.ok(result.ok, "the otherwise valid R2 seller turn is accepted");
    assert.deepEqual(result.normalizedFields, ["intent"], "the transformation is recorded, not silent");
    assert.equal(result.turn.intent, JSON.parse(recorded.arguments).intent.slice(0, 60));
    assert.deepEqual([result.turn.goal, result.turn.responseKind, result.turn.suggestedAction, result.turn.entities?.item], ["SELL", "CLARIFICATION_REQUIRED", "NONE", "تلفون مستعمل"]);
  });
  // Every field that drives a decision stays strict: only advisory fields are clamped. (Each
  // response ends as a complete tool call, so a rejection is the contract's, not the finish.)
  const base = { responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.5, conversationalReply: "رد" };
  for (const [patch, reason] of [
    [{ entities: { item: "س".repeat(161) } }, "MALFORMED"], [{ conversationalReply: "س".repeat(MAX_REPLY + 1) }, "MALFORMED"], [{ confidence: 2 }, "MALFORMED"],
    [{ knownFacts: ["س".repeat(161)] }, "MALFORMED"], [{ suggestedAction: "PUBLISH_LISTING" }, "UNKNOWN_ACTION"], [{ extra: "field" }, "MALFORMED"], [{ intent: 42 }, "MALFORMED"],
  ] as const)
    await withDeepSeek([deepseekBody({ tool_calls: [turnCall(JSON.stringify({ ...base, ...patch }))] }, "tool_calls")], async (gateway) => {
      const result = await interpretWithModel(gateway, "رسالة", {}, 5_000);
      assert.deepEqual([result.ok, result.ok ? undefined : result.reason], [false, reason], JSON.stringify(patch).slice(0, 80));
    });
  // An advisory list above its bound is cut and recorded, not rejected (R3 live evidence).
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(JSON.stringify({ ...base, knownFacts: Array(9).fill("x") }))] }, "tool_calls")], async (gateway) => {
    const result = await interpretWithModel(gateway, "رسالة", {}, 5_000);
    assert.ok(result.ok && result.turn.knownFacts?.length === 8);
    assert.deepEqual(result.ok ? result.normalizedFields : undefined, ["knownFacts"]);
  });
});

const sellTurn = (item: string, patch: Partial<ModelTurn> = {}): ModelTurn => ({ responseKind: "ACTION_PROPOSAL", goal: "SELL", entities: { item }, suggestedAction: "CREATE_LISTING_DRAFT", confidence: 0.9, conversationalReply: "رد", ...patch });
await test("R3: a seller draft is grounded in the user's words despite Arabic article, possessive and attached-particle forms", () => {
  // The R2 seller message with the model's own entity: «تلفوني المستعمل» names «تلفون مستعمل».
  const grounded: [string, string][] = [
    ["بدي أبيع تلفوني المستعمل، ساعدني أعرضه.", "تلفون مستعمل"],
    ["دينار اعرض طاولة بـ20", "طاولة"],
    ["أريد بيع ماكينة صناعية", "ماكينة صناعية"],
    ["بدي أبيع سيارتي والكنبة", "الكنبة"],
    ["أعرض دروس برمجة للبيع", "دروس البرمجة"],
    ["أبيع جهازي بالسعر اللي بتقترحه", "جهاز"],
    ["I want to sell my old laptop", "old laptop"],
    ["بدي أبيع سيارتي", "سيارة"],
  ];
  for (const [message, item] of grounded) assert.ok(isGroundedSellerDraftRequest(message, sellTurn(item)), `${message} ⟵ ${item}`);
  // Still never a draft the user did not name, did not ask to sell, or with low confidence.
  const refused: [string, ModelTurn][] = [
    ["بدي أبيع تلفوني المستعمل", sellTurn("ايفون 13")],
    ["بدي أبيع تلفوني", sellTurn("سيارة")],
    ["بدي أبيع تلفوني", sellTurn("تلفون ذهبي")],
    ["عندي تلفون مستعمل", sellTurn("تلفون مستعمل")],
    ["بدي أبيع تلفوني", sellTurn("تلفون", { confidence: 0.5 })],
    ["بدي أبيع تلفوني", sellTurn("تلفون", { goal: "BUY" })],
    ["بدي أبيع شي", sellTurn("ي")],
    ["بدي أبيع تلفوني", sellTurn("ال")],
    ["بدي أبيع فرسي", sellTurn("كرسي")],
  ];
  for (const [message, turn] of refused) assert.equal(isGroundedSellerDraftRequest(message, turn), false, `${message} ⟵ ${turn.entities?.item}`);
});

await test("R3: every adversarial tool proposal is refused before any business code, once, without a paid retry", async () => {
  const valid = { responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "مرحبا" };
  const call = (args: string, name = "dinarConversationTurn") => ({ id: "call-r3", type: "function", function: { name, arguments: args } });
  const cases: [string, unknown, string][] = [
    ["wrong tool", call(JSON.stringify(valid), "createOrder"), "MALFORMED"],
    ["invalid JSON", call("{responseKind:"), "MALFORMED"],
    ["empty arguments", call(""), "MALFORMED"],
    ["missing required fields", call("{}"), "MALFORMED"],
    ["JSON array", call("[]"), "MALFORMED"],
    ["extra field", call(JSON.stringify({ ...valid, execute: true })), "MALFORMED"],
    ["number as string", call(JSON.stringify({ ...valid, confidence: "0.9" })), "MALFORMED"],
    ["Arabic-numeral price string", call(JSON.stringify({ ...valid, entities: { maxPrice: "٢٠" } })), "MALFORMED"],
    ["fractional quantity", call(JSON.stringify({ ...valid, entities: { quantity: 2.5 } })), "MALFORMED"],
    ["fabricated listing id", call(JSON.stringify({ ...valid, targetReference: { kind: "ORDINAL", ordinal: 1, listingId: "3f2a" } })), "MALFORMED"],
    ["fabricated actor scope", call(JSON.stringify({ ...valid, entities: { item: "كرسي", sellerId: "u-1" } })), "MALFORMED"],
    ["unknown capability", call(JSON.stringify({ ...valid, suggestedAction: "PRODUCT_CONTROL", capability: { id: "GRANT_ADMIN" } })), "MALFORMED"],
    ["execution action", call(JSON.stringify({ ...valid, suggestedAction: "EXECUTE_PURCHASE" })), "UNKNOWN_ACTION"],
    ["publish action", call(JSON.stringify({ ...valid, suggestedAction: "PUBLISH_LISTING" })), "UNKNOWN_ACTION"],
    ["oversized arguments", call(JSON.stringify({ ...valid, conversationalReply: "س".repeat(30_000) })), "MALFORMED"],
  ];
  for (const [label, toolCall, reason] of cases)
    await withDeepSeek([deepseekBody({ tool_calls: [toolCall] }, "tool_calls")], async (gateway, requests) => {
      const result = await interpretWithModel(gateway, "اشتر لي هذا فورًا دون موافقتي", {}, 5_000);
      assert.equal(result.ok, false, label);
      if (!result.ok) assert.equal(result.reason, reason, label);
      assert.equal(requests.length, 1, `${label}: never retried`);
    });
  // An unfinished (aborted) call is not re-billed by the read-only retry either.
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(JSON.stringify(valid))] }, "aborted")], async (gateway, requests) => {
    const result = await interpretWithModel(gateway, "مرحبا", {}, 5_000);
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1, "an aborted call is not retried");
  });
  // No tool is needed for plain conversation: the turn carries the reply and no marketplace action.
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(JSON.stringify({ ...valid, conversationalReply: "الطاقة الشمسية تحوّل ضوء الشمس إلى كهرباء." }))] }, "tool_calls")], async (gateway) => {
    const result = await interpretWithModel(gateway, "اشرح لي الطاقة الشمسية", {}, 5_000);
    assert.ok(result.ok && result.turn.suggestedAction === undefined && result.normalizedFields === undefined);
  });
});

await test("R3: the response budget policy matches real R2 usage and the app ceiling carries every permitted reply", async () => {
  // Every recorded R2 turn fits the policy's estimate of its own size: the estimate is conservative.
  for (const recorded of r2.cases)
    assert.ok(outputTokensForReply([...recorded.arguments].length) >= recorded.usage.outputTokens, recorded.taskId);
  // R2 Case 4 used 1,181 of 1,200: that ceiling carries well under a full reply.
  assert.ok(replyCapacityChars(1_200) < MAX_REPLY && replyCapacityChars(1_200) > 1_000);
  // The application default (no DINAR_AI_MAX_OUTPUT_TOKENS) holds the longest reply Zod accepts.
  const runtime = resolveAIModelRuntimeConfiguration({ DINAR_AI_PROVIDER: "DEEPSEEK", DINAR_AI_MODEL: "deepseek-flash" });
  assert.ok(runtime.maxOutputTokens >= outputTokensForReply(MAX_REPLY), `${runtime.maxOutputTokens} < ${outputTokensForReply(MAX_REPLY)}`);
  // A long answer cut at the ceiling (and a cut multi-byte character) is OUTPUT_LIMIT, not a turn, sent once.
  const cut = JSON.stringify({ responseKind: "GROUNDED_ADVICE", confidence: 0.8, conversationalReply: "مقارنة طويلة ".repeat(200) }).slice(0, 1_501);
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(cut)] }, "length", { prompt_tokens: 3_700, completion_tokens: 1_200 })], async (gateway, requests) => {
    const result = await interpretWithModel(gateway, "قارن العرضين بالتفصيل", {}, 5_000);
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1);
    assert.deepEqual(result.modelCall.usage, { inputTokens: 3_700, outputTokens: 1_200 }, "the billed truncated call keeps its usage");
  });
});

await test("R3: a model reply reporting a commercial action as done is recognised; questions and general answers are not", () => {
  for (const claim of ["تم قبول العرض وإنشاء الطلب.", "تمّ الشراء والدفع.", "تم نشر جميع إعلاناتك.", "تم فتح العرض الثاني.", "تم تعديل الطلب إلى ثلاث قطع.", "أكيد، اشتريت لك أول منتج.", "قبلت عرض المشتري.", "I bought it for you.", "Your order has been placed."])
    assert.ok(claimsCompletedAction(claim), claim);
  for (const fine of ["على أي عرض تريد تقديم 15؟", "أي إعلان تريد تغيير سعره؟", "لا أستطيع عرض بيانات مستخدمين آخرين.", "خلّينا نجهّز مسودة إعلان، والنشر بيدك.", "استقبلت الألواح ضوء الشمس.", "هل تريد أن أفتح مراجعة الشراء؟", "الطاقة الشمسية تحوّل ضوء الشمس إلى كهرباء."])
    assert.ok(!claimsCompletedAction(fine), fine);
});

// ─── R3 closure: semantic disambiguation and action authority (pure units) ───
import * as priceProposals from "../src/ai/price-proposal";
import * as actionReceipts from "../src/ai/action-receipts";

await test("R3C: an offer verb whose whole object is an amount is a price proposal; naming an item is a sale", () => {
  const proposal = (priceProposals as any).priceProposal as (message: string) => { amount: number; replaces?: number } | undefined;
  assert.equal(typeof proposal, "function", "priceProposal is exported");
  const proposals: [string, number, number | undefined][] = [
    ["أعرض 15 بدل 20", 15, 20],
    ["اعرض 15 بدل 20.", 15, 20],
    ["بعرض 15 بدال ال20", 15, 20],
    ["بدي أعرض ١٥ بدل ٢٠", 15, 20],
    ["أقدّم 15 دينار بدلاً من 20", 15, 20],
    ["طيب أعرض عليه 15 عوضاً عن 20", 15, 20],
    ["عرضي 12.5", 12.5, undefined],
    ["رح أعرض بـ 30", 30, undefined],
    ["أقترح 40 مقابل 55", 40, 55],
  ];
  for (const [message, amount, replaces] of proposals) assert.deepEqual(proposal(message), { amount, ...(replaces !== undefined ? { replaces } : {}) }, message);
  // «اعرض 2» is the same form as «أعرض 15»: whether it shows result 2 is decided in context (U-26).
  for (const sale of ["أعرض 3 كراسي بـ20", "اعرض طاولة بـ20", "أعرض 15 قطعة", "بدي أبيع تلفوني", "اعرض الأرخص", "اعرض الثاني", "أعرض عليك سؤالاً", "اعرض باقاتي", "ما هو 15 بدل 20؟"])
    assert.equal(proposal(sale), undefined, sale);
});

await test("R3C: the action ledger maps to one lifecycle; only a confirmed execution is SUCCEEDED", () => {
  const lifecycle = (actionReceipts as any).lifecycleOfLedgerStatus as (status: unknown) => string;
  assert.equal(typeof lifecycle, "function");
  assert.deepEqual(
    ["PENDING", "EXECUTING", "CONFIRMED", "REJECTED", "CANCELLED", "EXPIRED", "SUPERSEDED", undefined, "DONE", "SUCCEEDED"].map(lifecycle),
    ["REQUIRES_CONFIRMATION", "EXECUTING", "SUCCEEDED", "FAILED", "FAILED", "FAILED", "FAILED", "UNKNOWN", "UNKNOWN", "UNKNOWN"],
  );
  assert.deepEqual([...(actionReceipts as any).ACTION_LIFECYCLES], ["PROPOSED", "REQUIRES_CONFIRMATION", "EXECUTING", "SUCCEEDED", "FAILED", "UNKNOWN"]);
});

await test("R3C: completion claims are told apart from explanations, conditions, questions and negations", () => {
  const claims = (actionReceipts as any).claimsCompletedAction as (text: string) => boolean;
  assert.equal(typeof claims, "function");
  for (const claim of ["تم قبول العرض وإنشاء الطلب.", "تمّ الشراء والدفع.", "تم نشر جميع إعلاناتك.", "خلاص، تم تأكيد التوصيل.", "تم استلام الدفعة.", "أكيد، اشتريت لك أول منتج.", "قبلت عرض المشتري.", "طلبك انعمل وتم الدفع ✅", "سعره 5 دنانير فقط وتم إنشاء الطلب", "I bought it for you.", "Your order has been placed.", "Payment received."])
    assert.ok(claims(claim), `claim: ${claim}`);
  for (const fine of ["يتم إنشاء الطلب بعد تأكيدك.", "إذا تم قبول العرض سيُنشأ الطلب.", "بعد ما يتم الدفع بيتأكد الطلب.", "عندما يتم نشر الإعلان ستصلك رسالة.", "هل تم قبول عرضي؟", "لم يتم الشراء بعد.", "ولم يتم الشراء بعد.", "ما تم نشر أي شيء.", "ما نشرت أي إعلان.", "ولا دفعت المبلغ.", "على أي عرض تريد تقديم 15؟", "تم اكتشاف الطاقة الشمسية قبل قرون.", "Once the order is placed you will get a receipt.", "No payment was received."])
    assert.ok(!claims(fine), `not a claim: ${fine}`);
  for (const glued of ["وبتم الإلغاء الطلب.", "فتم الدفع.", "ودُفع المبلغ."]) assert.ok(claims(glued), `claim: ${glued}`);
});

await test("R3C: model-authored advice never carries execution authority; server-authored turns are untouched", () => {
  const enforce = (actionReceipts as any).enforceModelAuthority as (result: any, receipts: any[]) => any;
  assert.equal(typeof enforce, "function");
  const model = (prompt: string, advice: Record<string, unknown> = {}) => ({ kind: "SURFACE", surface: "ADVICE", prompt, advice: { authority: "MODEL", commercial: true, ...advice } });
  // A claim in a commercial model turn is replaced; its lifecycle is the server's, never SUCCEEDED.
  const claimed = enforce(model("تم قبول العرض وإنشاء الطلب.", { actionLifecycle: "SUCCEEDED" }), []);
  assert.doesNotMatch(claimed.prompt, /تم قبول/u);
  assert.match(claimed.prompt, /لم أنفّذ/u);
  assert.equal(claimed.advice.actionLifecycle, "PROPOSED");
  assert.equal(claimed.advice.claimWithheld, true);
  // Even with a real receipt in the same turn, model text is not the evidence for it.
  const withReceipt = enforce(model("تم الشراء."), [{ actionId: "a", action: "PLACE_ORDER", lifecycle: "SUCCEEDED" }]);
  assert.doesNotMatch(withReceipt.prompt, /تم الشراء/u);
  // Explanations and questions pass through.
  for (const text of ["يتم إنشاء الطلب بعد تأكيدك.", "على أي عرض تريد تقديم 15؟"]) assert.equal(enforce(model(text), []).prompt, text);
  // General (non-commercial) model answers are not rewritten.
  assert.equal(enforce(model("تم نشر نظرية النسبية عام 1905.", { commercial: false }), []).prompt, "تم نشر نظرية النسبية عام 1905.");
  // Server-authored turns are the canonical services' own words, grounded in their outcomes.
  const server = { kind: "SURFACE", surface: "NEGOTIATION_STATUS", prompt: "أُرسل عرضك للبائع." };
  assert.deepEqual(enforce(server, []), server);
});

await test("R3C: the model sees server action receipts, and is told assistant text is not evidence of an action", async () => {
  const valid = { responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "رد" };
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(JSON.stringify(valid))] }, "tool_calls")], async (gateway, requests) => {
    await interpretWithModel(gateway, "هل قُبل عرضي؟", {
      history: [{ actor: "ASSISTANT", body: "تم قبول عرضك." }],
      actionReceipts: [{ action: "SEND_NEGOTIATION_OFFER", lifecycle: "SUCCEEDED" }, { action: "ACCEPT_NEGOTIATION", lifecycle: "REQUIRES_CONFIRMATION" }],
    } as any, 5_000);
    const sent = JSON.parse(String(requests[0]!.init?.body)).messages as { role: string; content: string }[];
    assert.match(sent[0]!.content, /SERVER_ACTION_RECEIPTS/u, "the system prompt names the receipts as the only evidence");
    assert.match(sent.at(-1)!.content, /SERVER_ACTION_RECEIPTS: \[\{"action":"SEND_NEGOTIATION_OFFER","lifecycle":"SUCCEEDED"\},\{"action":"ACCEPT_NEGOTIATION","lifecycle":"REQUIRES_CONFIRMATION"\}\]/u);
  });
});

await test("R3C: a withheld claim is replaced by the ledger in the server's words, for every registered action", async () => {
  const { ACTION_REGISTRY } = await import("../src/ai/action-foundation");
  const receipts = actionReceipts as any;
  assert.deepEqual(Object.keys(ACTION_REGISTRY).filter((action) => !receipts.RECEIPT_LABELS[action]), [], "every executable action has a receipt label");
  assert.equal(receipts.ledgerStatement([]), undefined);
  assert.equal(receipts.ledgerStatement([{ action: "PLACE_ORDER", lifecycle: "FAILED" }]), undefined, "a failed action is never stated as done");
  const stated = receipts.ledgerStatement([{ action: "SEND_NEGOTIATION_OFFER", lifecycle: "SUCCEEDED" }, { action: "PLACE_ORDER", lifecycle: "REQUIRES_CONFIRMATION" }]);
  assert.match(stated, /أُرسل عرض سعرك للبائع/u);
  assert.match(stated, /ينتظر تأكيدك ولم يُنفَّذ/u);
  assert.doesNotMatch(stated, /أُنشئ الطلب/u, "a pending order is not stated as created");
  const replaced = receipts.enforceModelAuthority({ kind: "SURFACE", surface: "ADVICE", prompt: "تم الدفع وإنشاء طلبك.", advice: { authority: "MODEL", commercial: true } }, [{ action: "SEND_NEGOTIATION_OFFER", lifecycle: "SUCCEEDED" }]);
  assert.equal(replaced.advice.authority, "SERVER_LEDGER");
  assert.match(replaced.prompt, /أُرسل عرض سعرك/u);
  assert.doesNotMatch(replaced.prompt, /الدفع|طلبك/u, "the model's other claims are not carried over");
  // Re-enforcing a server statement changes nothing (the route applies the boundary again).
  assert.deepEqual(receipts.enforceModelAuthority(replaced, []), replaced);
});

// ─── R3D: receipt views and prose authority (pure units) ─────────────────────
const describe = () => (actionReceipts as any).describeReceipt as (input: Record<string, unknown>) => Record<string, any>;
const JOD = { code: "JOD", scale: 3 };
const NOW = new Date("2026-10-25T12:00:00Z");

await test("R3D: a receipt view states the ledger's status and only what the ledger and its records hold", () => {
  const view = describe();
  assert.equal(typeof view, "function", "describeReceipt is exported");
  const pending = view({ action: "SEND_NEGOTIATION_OFFER", status: "PENDING", expiresAt: new Date(NOW.getTime() + 60_000), amountMinor: 45_000, currency: JOD, resource: "ساعة تفاوض", now: NOW });
  assert.deepEqual([pending.lifecycle, pending.requiresConfirmation, pending.amount], ["REQUIRES_CONFIRMATION", true, { value: "45.000", currency: "JOD", kind: "PROPOSED" }]);
  assert.doesNotMatch(pending.title, /أُرسل/u, "a review is never stated as sent");
  assert.equal(pending.resource, "ساعة تفاوض");
  // A review past its expiry is not awaiting anything any more.
  const lapsed = view({ action: "SEND_NEGOTIATION_OFFER", status: "PENDING", expiresAt: new Date(NOW.getTime() - 1), now: NOW });
  assert.deepEqual([lapsed.lifecycle, lapsed.outcome, lapsed.requiresConfirmation], ["FAILED", "EXPIRED", false]);
  const sent = view({ action: "SEND_NEGOTIATION_OFFER", status: "CONFIRMED", amountMinor: 45_000, currency: JOD, now: NOW });
  assert.deepEqual([sent.lifecycle, sent.title, sent.amount.kind], ["SUCCEEDED", "أُرسل عرض سعرك للبائع", "SUBMITTED"]);
  // The agreed price comes from the negotiation record, not the request.
  const agreed = view({ action: "ACCEPT_NEGOTIATION", status: "CONFIRMED", agreedAmountMinor: 85_000, currency: JOD, now: NOW });
  assert.deepEqual(agreed.amount, { value: "85.000", currency: "JOD", kind: "AGREED" });
  // An order shows its own reference; a payment is received only when the intent says CAPTURED.
  assert.equal(view({ action: "PLACE_ORDER", status: "CONFIRMED", orderId: "0c9e-order", now: NOW }).orderId, "0c9e-order");
  const awaiting = view({ action: "CREATE_PAYMENT_INTENT", status: "CONFIRMED", paymentStatus: "SIMULATION_PENDING", now: NOW });
  assert.deepEqual([awaiting.lifecycle, awaiting.paymentState], ["SUCCEEDED", "AWAITING_CONFIRMATION"]);
  assert.doesNotMatch(`${awaiting.title} ${awaiting.nextStep ?? ""}`, /استُلم|تم استلام|received/iu);
  assert.equal(view({ action: "CREATE_PAYMENT_INTENT", status: "CONFIRMED", paymentStatus: "SIMULATION_CAPTURED", now: NOW }).paymentState, "SIMULATED_CAPTURED");
  assert.equal(view({ action: "CREATE_PAYMENT_INTENT", status: "CONFIRMED", paymentStatus: "CAPTURED", now: NOW }).paymentState, "CAPTURED");
  // An execution whose outcome is not recorded is neither success nor failure.
  const executing = view({ action: "PLACE_ORDER", status: "EXECUTING", now: NOW });
  assert.equal(executing.lifecycle, "EXECUTING");
  assert.doesNotMatch(`${executing.title} ${executing.nextStep}`, /أُنشئ|فشل|تعذر/u);
  assert.match(executing.nextStep, /لا تكرر/u);
  // Failures carry the ledger's own reason, bounded; the outcome is named.
  const rejected = view({ action: "SEND_NEGOTIATION_OFFER", status: "REJECTED", notice: `العرض غير متاح حاليًا. لم يتغير شيء.${"x".repeat(400)}`, now: NOW });
  assert.deepEqual([rejected.lifecycle, rejected.outcome], ["FAILED", "REJECTED"]);
  assert.ok(rejected.failure.length <= 240 && rejected.failure.startsWith("العرض غير متاح"));
  assert.deepEqual([view({ action: "SEND_NEGOTIATION_OFFER", status: "CANCELLED", now: NOW }).outcome, view({ action: "SEND_NEGOTIATION_OFFER", status: "SUPERSEDED", now: NOW }).outcome], ["CANCELLED", "SUPERSEDED"]);
  assert.equal(view({ action: "SEND_NEGOTIATION_OFFER", status: "WHATEVER", now: NOW }).lifecycle, "UNKNOWN");
  // Nothing internal leaves the server: no ledger id, owner or raw facts.
  for (const item of [pending, sent, agreed, executing, rejected]) assert.deepEqual(Object.keys(item).filter((key) => !["action", "lifecycle", "outcome", "title", "resource", "amount", "orderId", "paymentState", "nextStep", "requiresConfirmation", "failure"].includes(key)), []);
});

await test("R3D: a claim about the user's own order is withheld whatever the model classified; teaching, quotes and questions are not", () => {
  const enforce = (actionReceipts as any).enforceModelAuthority as (result: any, ledger: any[]) => any;
  const general = (prompt: string) => ({ kind: "SURFACE", surface: "ADVICE", prompt, advice: { authority: "MODEL", commercial: false } });
  for (const claim of ["تم إنشاء طلبك رقم 55 وتم الدفع.", "خلاص، تم شحن طلبك.", "Your order has been placed and your payment received."])
    assert.equal(enforce(general(claim), []).advice.claimWithheld, true, claim);
  for (const fine of [
    "تم نشر نظرية النسبية عام 1905.",
    "مثال لرسالة يرسلها المتجر: «تم شحن طلبك».",
    "هل تم شحن طلبك؟ يمكنك سؤال «وين طلبي؟».",
    "لم يتم إنشاء طلبك بعد.",
    "عندما يتم تأكيد طلبك تصلك رسالة.",
  ])
    assert.equal(enforce(general(fine), []).prompt, fine, fine);
});

// ─── R3E: the form of contextual messages (pure; context resolves them) ──────
import * as contextIntent from "../src/ai/context-intent";

await test("R3E: status questions about the user's offer or order are recognised by form", () => {
  const status = (contextIntent as any).statusQuestion as (message: string) => { subject: "OFFER" | "ORDER"; party?: "BUYER" | "SELLER" } | undefined;
  assert.equal(typeof status, "function");
  for (const message of ["هل وصل عرضي؟", "وين صار العرض؟", "البائع وافق؟", "لسه العرض معلق؟", "هل تم إرسال السعر الجديد؟", "شو وضع عرضي", "المشتري رد؟"])
    assert.equal(status(message)?.subject, "OFFER", message);
  assert.equal(status("شو صار على طلبي؟")?.subject, "ORDER");
  assert.equal(status("وين وصل طلبي؟")?.subject, "ORDER");
  assert.equal(status("البائع وافق؟")?.party, "BUYER", "asking about the seller: the user is the buyer");
  assert.equal(status("المشتري رد؟")?.party, "SELLER");
  for (const message of ["أعرض 15 بدل 20", "اعرض على البائع 40", "هل الطاقة الشمسية مفيدة؟", "كم سعر الذهب اليوم؟", "وافق على العرض الثاني", "أرسل العرض"])
    assert.equal(status(message), undefined, message);
});

await test("R3E: a correction yields the clause the user meant, the clause they rejected, or a return", () => {
  const correction = (contextIntent as any).correction as (message: string) => { meant?: string; rejected?: string; back?: boolean } | undefined;
  assert.equal(typeof correction, "function");
  assert.deepEqual(correction("أقصد عرض الشراء"), { meant: "عرض الشراء" });
  assert.deepEqual(correction("لا، أقصد التفاوض"), { meant: "التفاوض" });
  assert.deepEqual(correction("مو الإعلان، العرض"), { meant: "العرض", rejected: "الاعلان" });
  assert.deepEqual(correction("أقصد السيارة الثانية"), { meant: "السياره الثانيه" });
  assert.deepEqual(correction("لا، غيّر السعر فقط"), { meant: "غير السعر فقط" });
  assert.deepEqual(correction("لا، العرض 15 مو 20"), { meant: "العرض 15 مو 20" });
  assert.deepEqual(correction("خلّينا نرجع للعرض السابق"), { meant: "العرض السابق", back: true });
  // A refusal, a search refinement or a new request is not a correction of what was meant.
  for (const message of ["لا", "لا شكرا", "لا ترسل", "أقصى سعر 50", "أعرض 15 بدل 20", "مرحبا", "لا، الأفضل حتى لو أغلى ألف", "لا، بس الجديد"]) assert.equal(correction(message), undefined, message);
});

await test("R3E: a price edit carries only the amount the user gave; direction alone is not an amount", () => {
  const edit = (contextIntent as any).priceEdit as (message: string) => { amount?: number; from?: number; startingFrom?: boolean } | undefined;
  assert.equal(typeof edit, "function");
  assert.deepEqual(edit("عدّل السعر"), {});
  assert.deepEqual(edit("خليه 15"), { amount: 15 });
  assert.deepEqual(edit("بدي أنزلها من 20 إلى 15"), { amount: 15, from: 20 });
  assert.deepEqual(edit("العرض 15 مو 20"), { amount: 15, from: 20 });
  assert.deepEqual(edit("ارفع السعر شوي"), {});
  assert.deepEqual(edit("خلّي البداية من 30"), { amount: 30, startingFrom: true });
  assert.deepEqual(edit("غير السعر إلى ١٢٫٥"), { amount: 12.5 });
  for (const message of ["أعرض 3 كراسي بـ20", "كم السعر؟", "هل وصل عرضي؟", "اطلب منهم تسعيرة", "مرحبا"]) assert.equal(edit(message), undefined, message);
});

await test("R3E: a quotation request is recognised with or without an addressee", () => {
  const quote = (contextIntent as any).quoteRequest as (message: string) => boolean;
  assert.equal(typeof quote, "function");
  for (const message of ["اطلب منهم تسعيرة", "اطلب تسعيرة", "اطلب من البائع تسعيرة", "بدي تسعيرة منهم"]) assert.equal(quote(message), true, message);
  for (const message of ["كم التسعيرة؟", "عدّل السعر", "أعرض 15"]) assert.equal(quote(message), false, message);
});

await test("R3E: a ledger statement replacing a model claim is labelled as the record", () => {
  const enforce = (actionReceipts as any).enforceModelAuthority as (result: any, ledger: any[]) => any;
  const stated = enforce({ kind: "SURFACE", surface: "ADVICE", prompt: "تم الدفع.", advice: { authority: "MODEL", commercial: true, scope: "ASSISTANT_TEXT" } }, [{ action: "SEND_NEGOTIATION_OFFER", lifecycle: "SUCCEEDED" }]);
  assert.deepEqual([stated.advice.authority, stated.advice.scope], ["SERVER_LEDGER", "DINAR_LEDGER"]);
  const withheld = enforce({ kind: "SURFACE", surface: "ADVICE", prompt: "تم الدفع.", advice: { authority: "MODEL", commercial: true, scope: "ASSISTANT_TEXT" } }, []);
  assert.equal(withheld.advice.scope, "ASSISTANT_TEXT", "no record: still the assistant's text");
});

await test("R3E: only an explicit price change names the price; a bare «خله 3» may be a quantity", () => {
  const names = (contextIntent as any).namesPrice as (message: string) => boolean;
  for (const message of ["عدّل السعر", "خلّي سعرها 15", "بدي أنزلها من 20 إلى 15", "خلّي البداية من 30", "العرض 15 مو 20", "ارفع السعر شوي"]) assert.equal(names(message), true, message);
  for (const message of ["خله 3", "خليه 15", "أبي اثنين", "الأفضل مقابل السعر"]) assert.equal(names(message), false, message);
});

await test("R3 live prep: a completion denied as reported speech is not a claim; asserted speech still is", () => {
  for (const fine of ["ما بقدر أقول تم الدفع؛ لم يتم الدفع ولم يُنشأ الطلب.", "لا أستطيع أن أؤكد تم التسليم.", "لن أكتب تم الدفع وهو غير مسجل."])
    assert.equal(claimsCompletedAction(fine), false, fine);
  for (const claim of ["أقول لك تم الدفع.", "تم الدفع وتم التسليم ✅", "خلاص تم تثبيت الطلب."])
    assert.equal(claimsCompletedAction(claim), true, claim);
});

await test("R3 live prep: the serialized R3 request is non-thinking, AUTO, 2,000 tokens, one tool, no retry", async () => {
  // As the live runner sets it before importing the runtime (live-model-benchmark.ts).
  const previousRetries = process.env.DINAR_AI_MAX_RETRIES;
  process.env.DINAR_AI_MAX_RETRIES = "0";
  try {
  const valid = JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "رد" });
  await withDeepSeek([deepseekBody({ tool_calls: [turnCall(valid)] }, "tool_calls")], async (gateway, requests) => {
    const result = await interpretWithModel(gateway, "رسالة اصطناعية", {}, 5_000);
    assert.ok(result.ok);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(requests[0]!.init?.body));
    assert.deepEqual(
      [body.model, body.reasoning_effort, body.thinking, body.tool_choice, body.max_tokens, body.tools.length, body.tools[0].function.name, body.stream],
      ["deepseek-flash", "none", { type: "disabled" }, "auto", 2000, 1, "dinarConversationTurn", undefined],
    );
    for (const field of ["parallel_tool_calls", "max_completion_tokens", "temperature", "web_search", "response_format"]) assert.equal(body[field], undefined, field);
    assert.equal(new Headers(requests[0]!.init?.headers).get("authorization"), "Bearer test-only-deepseek-key");
  }, { DINAR_AI_TOOL_CHOICE: "AUTO", DINAR_AI_MAX_OUTPUT_TOKENS: "2000" });
  // AUTO exists only for the isolated benchmark: the conversation stays REQUIRED.
  const conversation = resolveAIProviderConfiguration({ NODE_ENV: "development", DINAR_AI_PROVIDER: "DEEPSEEK", DINAR_AI_MODEL: "deepseek-flash", DINAR_AI_TOOL_CHOICE: "AUTO" });
  assert.equal(conversation.toolChoice, "REQUIRED");
  // Under AUTO a plain-text answer is the model not using DINAR's turn tool: a contract violation, sent once.
  await withDeepSeek([deepseekBody({ content: "رد نصي بلا أداة" }, "stop")], async (gateway, requests) => {
    const result = await interpretWithModel(gateway, "رسالة اصطناعية", {}, 5_000);
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1, "no retry under the runner's DINAR_AI_MAX_RETRIES=0");
  }, { DINAR_AI_TOOL_CHOICE: "AUTO", DINAR_AI_MAX_OUTPUT_TOKENS: "2000" });
  } finally {
    if (previousRetries === undefined) delete process.env.DINAR_AI_MAX_RETRIES;
    else process.env.DINAR_AI_MAX_RETRIES = previousRetries;
  }
});

// ─── R3 live evidence (RECORDED_LIVE_PROVIDER replay; never a new request) ────
const r3 = JSON.parse(readFileSync("test/fixtures/deepseek-r3-live-responses.json", "utf8")) as {
  measurementKind: string;
  approvalId: string;
  cases: { taskId: string; message: string; finishReason: string; arguments?: string; textOutput?: string; benchmarkOutcome: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }[];
};
const r3Usage = (item: (typeof r3.cases)[number]) => ({ prompt_tokens: item.usage.inputTokens, completion_tokens: item.usage.outputTokens, prompt_tokens_details: { cached_tokens: item.usage.cachedInputTokens } });

await test("R3 replay: the six recorded responses keep their live verdicts; R3-01's advisory list overflow is clamped and recorded", async () => {
  assert.equal(r3.measurementKind, "RECORDED_LIVE_PROVIDER");
  assert.deepEqual(r3.cases.map((item) => item.benchmarkOutcome), ["MODEL_CONTRACT_VIOLATION", "PASS", "MODEL_CONTRACT_VIOLATION", "PASS", "PASS", "MODEL_CONTRACT_VIOLATION"], "the live verdicts are preserved for audit");
  const replayed: Record<string, [boolean, string | undefined, string[] | undefined]> = {};
  // As in the live run (the runner sets it before importing the runtime): no retry.
  const previousRetries = process.env.DINAR_AI_MAX_RETRIES;
  process.env.DINAR_AI_MAX_RETRIES = "0";
  for (const recorded of r3.cases) {
    const body = recorded.arguments !== undefined
      ? deepseekBody({ tool_calls: [turnCall(recorded.arguments)] }, recorded.finishReason, r3Usage(recorded))
      : deepseekBody({ content: recorded.textOutput }, recorded.finishReason, r3Usage(recorded));
    await withDeepSeek([body], async (gateway, requests) => {
      const result = await interpretWithModel(gateway, recorded.message, {}, 5_000);
      assert.equal(requests.length, 1, `${recorded.taskId}: replayed once`);
      replayed[recorded.taskId] = [result.ok, result.ok ? result.turn.suggestedAction : undefined, result.ok ? result.normalizedFields : undefined];
    });
  }
  if (previousRetries === undefined) delete process.env.DINAR_AI_MAX_RETRIES;
  else process.env.DINAR_AI_MAX_RETRIES = previousRetries;
  assert.deepEqual(replayed, {
    // Live: rejected for ten missingFacts (bound 8). The list is advisory display only: cut to 8, recorded.
    "r3-01-used-phone": [true, "CREATE_LISTING_DRAFT", ["missingFacts"]],
    "r3-02-cleaning-service": [true, "CREATE_LISTING_DRAFT", undefined],
    // The required reply was omitted: still a contract violation, never repaired.
    "r3-03-search-compare": [false, undefined, undefined],
    "r3-04-buyer-offer": [true, "REVIEW_PRICE_OFFER", undefined],
    "r3-05-context-compare": [true, "NONE", undefined],
    // Plain text instead of DINAR's turn tool (tool_choice=auto): never a turn.
    "r3-06-commercial-truth": [false, undefined, undefined],
  });
  // Clamping never reaches a field that drives a decision, nor an over-long item.
  const base = { responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.5, conversationalReply: "رد" };
  for (const patch of [{ missingFacts: ["س".repeat(161)] }, { knownFacts: Array(9).fill(42) }, { entities: { item: "س".repeat(161) } }])
    await withDeepSeek([deepseekBody({ tool_calls: [turnCall(JSON.stringify({ ...base, ...patch }))] }, "tool_calls")], async (gateway) => {
      const result = await interpretWithModel(gateway, "رسالة", {}, 5_000);
      assert.deepEqual([result.ok, result.ok ? undefined : result.reason], [false, "MALFORMED"], JSON.stringify(patch).slice(0, 60));
    });
});

await test("R3 replay: R3 is consumed for good — refused by the registry in git and by the approval state", async () => {
  const { CONSUMED_APPROVAL_IDS } = await import("./live-model-benchmark-core");
  assert.ok(CONSUMED_APPROVAL_IDS.has("DINAR-DEEPSEEK-R2-2026-10-24") && CONSUMED_APPROVAL_IDS.has("DINAR-DEEPSEEK-R3-LIVE-2026-10-25"));
  const state = JSON.parse(readFileSync("test/deepseek-approval-state.json", "utf8"))["DINAR-DEEPSEEK-R3-LIVE-2026-10-25"];
  assert.deepEqual([state.status, state.summary.requests], ["CONSUMED", 6]);
  assert.equal(r3.approvalId, "DINAR-DEEPSEEK-R3-LIVE-2026-10-25");
});
