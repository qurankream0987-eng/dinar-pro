/**
 * R3 preflight: the exact model request of every DeepSeek task (messages + tools), built as the
 * live runner builds it, with its fingerprint (requestFingerprint). Sends nothing and reaches no
 * database. The official DeepSeek tokenizer then measures each request offline.
 *   CAPTURE_TASKS=DEEPSEEK_R3_TASKS node .test-build/deepseek-request-capture.mjs > requests.jsonl
 */
const DEAD = "postgresql://capture@127.0.0.1:1/none?sslmode=disable";
process.env.NODE_ENV = "development";
process.env.DATABASE_URL = DEAD;
process.env.DINAR_DEV_DATABASE_URL = DEAD;
process.env.DINAR_AI_MAX_RETRIES = "0";
const { interpretWithModel } = await import("../src/ai/model-turn");
const { conversationGuidance } = await import("../src/ai/conversation-guidance");
const core = await import("./live-model-benchmark-core");
const tasks = (core as unknown as Record<string, typeof core.DEEPSEEK_R3_TASKS>)[process.env.CAPTURE_TASKS ?? "DEEPSEEK_R3_TASKS"]!;
// The same server context the runner gives every task.
const serverContext = conversationGuidance({ id: "JO", countryCode: "JO", currencyCode: "JOD" } as never, true, true);
for (const task of tasks) {
  let captured: { messages: Parameters<typeof core.requestFingerprint>[0]; tools: Parameters<typeof core.requestFingerprint>[1] } | undefined;
  const gateway = {
    providerInfo: { provider: "DEEPSEEK" as const, requestedModel: "deepseek-flash" },
    async proposeToolCall(messages: typeof captured extends { messages: infer M } ? M : never, tools: never) {
      captured ??= { messages, tools };
      throw new Error("capture only");
    },
  };
  await interpretWithModel(gateway as never, task.message, { marketAvailable: true, serverContext, history: [], ...task.context }, 5_000).catch(() => undefined);
  if (!captured) throw new Error(`${task.id}: no request was built`);
  process.stdout.write(`${JSON.stringify({ id: task.id, fingerprint: core.requestFingerprint(captured.messages, captured.tools), ...captured })}\n`);
}
