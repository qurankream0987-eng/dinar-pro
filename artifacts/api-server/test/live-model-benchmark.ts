/**
 * DINAR first controlled real-model benchmark (CLI). See
 * docs/dinar-next/DINAR_FIRST_LIVE_AI_BENCHMARK_READINESS.md.
 *
 *   pnpm --filter @workspace/api-server run benchmark:ai plan       # default: contacts nothing
 *   pnpm --filter @workspace/api-server run benchmark:ai simulate   # scripted gateway, LOCAL_SIMULATION
 *   pnpm --filter @workspace/api-server run benchmark:ai run        # LIVE, billable: owner approval only
 *
 * DINAR_BENCHMARK_CONFIG: owner-approved JSON (shape: live-model-benchmark.example.json).
 * DINAR_BENCHMARK_OUT: results directory outside the repository (simulate/run); it holds
 *   engineering/ (results.json: for engineers, never for raters) and raters/ (rating-sheet.csv).
 * DINAR_BENCHMARK_KEY_DIR: a separate directory outside the repository for blind-key.json (0600).
 * run also needs DINAR_BENCHMARK_EXECUTE=1, DINAR_BENCHMARK_APPROVAL_ID=<approval.id> and the
 * dedicated DINAR_BENCH_*_API_KEY of every candidate's provider. No database is used or reachable.
 * DINAR_BENCHMARK_LEDGER_DIR (run): a persistent directory outside the repository for the durable
 *   per-approval ledger; an approval whose ledger exists, or that is listed as consumed, is refused.
 */
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BENCHMARK_CREDENTIALS,
  BENCHMARK_ENDPOINTS,
  benchmarkEndpoint,
  BENCHMARK_TASKS,
  GROQ_BENCHMARK_TASKS,
  GEMINI_BENCHMARK_TASKS,
  DEEPSEEK_BENCHMARK_TASKS,
  DEEPSEEK_R3_TASKS,
  deepseekTasksFor,
  BENCHMARK_THRESHOLDS,
  BenchmarkConfigSchema,
  BenchmarkLedger,
  DurableRunJournal,
  beginApproval,
  finishApproval,
  assertApprovalUnused,
  assertGeminiLiveApproval,
  assertGroqLiveApproval,
  assertDeepSeekLiveApproval,
  GuardedBenchmarkGateway,
  OpenRouterFreeQuota,
  MODEL_ATTRIBUTABLE,
  contractOf,
  maskProviderIdentity,
  planBenchmark,
  prepareOutputLocations,
  scoreTask,
  taskOutcome,
  type BenchmarkCandidate,
  type BenchmarkConfig,
  type BenchmarkTask,
  type TaskOutcome,
} from "./live-model-benchmark-core";
import { fetchDeepSeekBalance } from "./deepseek-balance-preflight";

const mode = (process.argv[2] ?? "plan") as "plan" | "simulate" | "run";
if (!["plan", "simulate", "run"].includes(mode)) throw new Error("Mode must be plan, simulate or run.");
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT !== undefined || process.env.RAILWAY_ENVIRONMENT !== undefined)
  throw new Error("The benchmark never runs in a deployment.");

const configPath = process.env.DINAR_BENCHMARK_CONFIG;
if (!configPath) throw new Error("Set DINAR_BENCHMARK_CONFIG to the owner-approved benchmark JSON.");
const config: BenchmarkConfig = BenchmarkConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
const isGeminiPilot = config.candidates.some((candidate) => contractOf(candidate).provider === "GEMINI");
const isGroqPilot = config.candidates.some((candidate) => contractOf(candidate).provider === "GROQ");
const isDeepSeekPilot = config.candidates.some((candidate) => contractOf(candidate).provider === "DEEPSEEK");
const runTasks = isDeepSeekPilot ? deepseekTasksFor(config.approval.id) : isGeminiPilot ? GEMINI_BENCHMARK_TASKS : isGroqPilot ? GROQ_BENCHMARK_TASKS : BENCHMARK_TASKS;
const plan = planBenchmark(config, runTasks.length);
console.log("BENCHMARK_PLAN", JSON.stringify(plan, null, 2));
if (!plan.ok) {
  process.exitCode = 1;
  throw new Error(`Benchmark plan refused: ${plan.problems.join("; ")}`);
}
if (mode === "plan") process.exit(0);

if (mode === "run") {
  if (process.env.DINAR_BENCHMARK_EXECUTE !== "1" || process.env.DINAR_BENCHMARK_APPROVAL_ID !== config.approval.id)
    throw new Error("A live run needs DINAR_BENCHMARK_EXECUTE=1 and DINAR_BENCHMARK_APPROVAL_ID matching the approval record.");
  assertApprovalUnused(config);
  if (!process.env.DINAR_BENCHMARK_LEDGER_DIR) throw new Error("A live run needs DINAR_BENCHMARK_LEDGER_DIR for its durable ledger.");
  const missing = [...new Set(config.candidates.map((candidate) => BENCHMARK_CREDENTIALS[contractOf(candidate).provider]))].filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing benchmark credentials: ${missing.join(", ")}`);
  assertGeminiLiveApproval(config);
  assertGroqLiveApproval(config);
  assertDeepSeekLiveApproval(config);
}
// R3 authorizes one non-inference DeepSeek call besides chat completions: GET /user/balance.
// The model itself is verified on the official pages (contract) and on every response
// (GuardedBenchmarkGateway stops the run on any other returned model).
let deepseekBalance: { isAvailable: boolean; usdBalance: string | null } | undefined;
if (mode === "run" && config.candidates.some((item) => contractOf(item).provider === "DEEPSEEK")) {
  const balance = await fetchDeepSeekBalance(process.env[BENCHMARK_CREDENTIALS.DEEPSEEK]!);
  if (!balance.ok) throw new Error(`DeepSeek balance preflight failed (${balance.classification}); no inference was sent.`);
  const usd = balance.balances.find((item) => item.currency === "USD")?.total_balance ?? null;
  deepseekBalance = { isAvailable: balance.isAvailable, usdBalance: usd };
  console.log("DEEPSEEK_BALANCE_PREFLIGHT", JSON.stringify(deepseekBalance));
  if (!balance.isAvailable || usd === null || !(Number(usd) >= config.approval.budgetUsd))
    throw new Error("DeepSeek balance preflight did not confirm an available USD balance covering the approved budget; no inference was sent.");
}
// Measured input bounds (official tokenizer, offline) by request fingerprint: required for a
// DeepSeek live run, so no request whose size was not measured can be sent.
const boundsPath = process.env.DINAR_BENCHMARK_TOKEN_BOUNDS;
if (mode === "run" && isDeepSeekPilot && !boundsPath) throw new Error("A DeepSeek live run needs DINAR_BENCHMARK_TOKEN_BOUNDS (measured input bounds); no inference was sent.");
const measuredBounds = boundsPath
  ? new Map(Object.entries(JSON.parse(readFileSync(boundsPath, "utf8")) as Record<string, number>))
  : undefined;
if (mode === "run") {
  for (const candidate of config.candidates.filter((item) => contractOf(item).provider === "OPENROUTER")) {
    const response = await fetch(`${BENCHMARK_ENDPOINTS.OPENROUTER}/model/${candidate.model}`, { redirect: "error" });
    if (!response.ok) throw new Error(`OpenRouter public metadata preflight failed for ${candidate.model}.`);
    const payload = await response.json() as { data?: { id?: string; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[]; context_length?: number; top_provider?: { max_completion_tokens?: number } } };
    const model = payload.data;
    if (model?.id !== candidate.model || model.pricing?.prompt !== "0" || model.pricing?.completion !== "0" ||
        !model.supported_parameters?.includes("tools") || !model.supported_parameters.includes("tool_choice") || !model.supported_parameters.includes("max_tokens") ||
        !model.context_length || model.context_length < config.limits.maxInputTokensPerRequest ||
        !model.top_provider?.max_completion_tokens || model.top_provider.max_completion_tokens < config.limits.maxOutputTokens)
      throw new Error(`OpenRouter metadata no longer verifies the exact zero-price tool-capable model ${candidate.model}; no inference was sent.`);
  }
}

// Output locations are created and checked before any call, so a bad one costs nothing.
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const { outDir, keyDir } = prepareOutputLocations(repositoryRoot, process.env.DINAR_BENCHMARK_OUT, process.env.DINAR_BENCHMARK_KEY_DIR);

// Nothing below can reach a database: both URLs point at a closed loopback port before the
// runtime modules are imported. The runtime's own limits are pinned to the approved ones and
// no fallback slot exists.
const DEAD_DATABASE = "postgresql://benchmark@127.0.0.1:1/dinar_test_benchmark_no_database?sslmode=disable";
process.env.NODE_ENV = "development";
process.env.DATABASE_URL = DEAD_DATABASE;
process.env.DINAR_DEV_DATABASE_URL = DEAD_DATABASE;
process.env.DINAR_AI_MAX_RETRIES = String(config.limits.maxRetries);
process.env.DINAR_AI_MAX_OUTPUT_TOKENS = String(config.limits.maxOutputTokens);
for (const key of Object.keys(process.env)) if (key.startsWith("DINAR_AI_FALLBACK_")) delete process.env[key];

const { createConversationModelGateway } = await import("../src/ai/model-gateway");
const { interpretWithModel, ModelTurnOutput, withoutNullFields } = await import("../src/ai/model-turn");
const { conversationGuidance } = await import("../src/ai/conversation-guidance");
type Gateway = Awaited<ReturnType<typeof createConversationModelGateway>>;

/** LOCAL_SIMULATION: a scripted reply per task, to exercise the harness — never a model result. */
function simulatedGateway(candidate: BenchmarkCandidate): Gateway {
  return {
    providerInfo: { provider: "OPENAI_COMPATIBLE", requestedModel: candidate.model },
    async proposeToolCall(messages) {
      const user = String(messages.at(-1)?.content ?? "");
  const task = [...DEEPSEEK_R3_TASKS, ...DEEPSEEK_BENCHMARK_TASKS, ...GEMINI_BENCHMARK_TASKS, ...GROQ_BENCHMARK_TASKS, ...BENCHMARK_TASKS].find((item) => user.includes(`USER: ${item.message}`));
      const action = task?.expect.suggestedAction?.find(Boolean);
      const input = messages.reduce((sum, message) => sum + Buffer.byteLength(String(message.content)), 0);
      const simulatedReply = task?.id === "deepseek-context-continuity"
        ? "الخيار الأول تويوتا 2015 أرخص وحالتها جيدة، أما نيسان 2017 فتحتاج صيانة للمكيف؛ الاختيار يعتمد على أولوية السعر أو السنة."
        : `رد محاكى لاختبار الأداة فقط: ${task?.id ?? "?"}`;
      const simulatedItem = task?.id === "deepseek-levantine-seller" || task?.id === "r3-01-used-phone" ? "تلفون مستعمل"
        : task?.id === "deepseek-search-compare" || task?.id === "r3-03-search-compare" ? "سيارة مستعملة"
        : task?.id === "r3-02-cleaning-service" ? "خدمة تنظيف منازل"
        : task?.id === "tool-sell" ? "لابتوب ديل"
        : "ثلاجة";
      return {
        id: "simulated",
        name: "dinarConversationTurn",
        arguments: JSON.stringify({
          responseKind: action === "SEARCH_LISTINGS" ? "SEARCH_INTENT" : task?.expect.responseKinds?.[0] ?? "CONVERSATIONAL_RESPONSE",
          confidence: 0.9,
          conversationalReply: simulatedReply,
          ...(action ? { suggestedAction: action } : {}),
          ...(task?.expect.entityItem ? { entities: { item: simulatedItem } } : task?.expect.entityAmount !== undefined ? { entities: { amount: task.expect.entityAmount } } : {}),
          ...(action === "PRODUCT_CONTROL" ? { capability: { id: task?.expect.capabilityId, theme: "DARK" } } : {}),
        }),
        usage: { inputTokens: Math.ceil(input / 3), outputTokens: 160, reasoningTokens: 40 },
        providerRequestId: `sim-${randomInt(1e9)}`,
      };
    },
  };
}

function candidateGateway(candidate: BenchmarkCandidate): Promise<Gateway> {
  if (mode === "simulate") return Promise.resolve(simulatedGateway(candidate));
  const provider = contractOf(candidate).provider;
  const gemmaFree = provider === "OPENROUTER";
  const geminiFree = provider === "GEMINI";
  const groqFree = provider === "GROQ";
  const deepseek = provider === "DEEPSEEK";
  return createConversationModelGateway({
    NODE_ENV: "development",
    DINAR_AI_PROVIDER: gemmaFree ? "OPENROUTER" : geminiFree ? "GEMINI" : groqFree ? "GROQ" : deepseek ? "DEEPSEEK" : "OPENAI_COMPATIBLE",
    ...(gemmaFree ? { DINAR_GEMMA_FREE_ONLY: "true" } : {}),
    ...(geminiFree ? { DINAR_GEMINI_FREE_ONLY: "true" } : {}),
    ...(geminiFree ? { DINAR_GEMINI_BENCHMARK_CONTEXT: "1" } : {}),
    ...(groqFree ? { DINAR_GROQ_FREE_ONLY: "true", DINAR_GROQ_BENCHMARK_CONTEXT: "1" } : {}),
    ...(deepseek ? { DEEPSEEK_BENCHMARK_CONTEXT: "1" } : {}),
    ...(!gemmaFree && !geminiFree && !groqFree ? { DINAR_AI_BASE_URL: benchmarkEndpoint(provider) } : {}),
    ...(provider === "SELF_HOSTED" ? { DINAR_AI_THINKING: "disabled" } : {}),
    DINAR_AI_MODEL: candidate.model,
    ...(gemmaFree ? { DINAR_BENCH_OPENROUTER_API_KEY: process.env[BENCHMARK_CREDENTIALS[provider]] } : geminiFree ? { DINAR_BENCH_GEMINI_API_KEY: process.env[BENCHMARK_CREDENTIALS[provider]] } : groqFree ? { DINAR_BENCH_GROQ_API_KEY: process.env[BENCHMARK_CREDENTIALS[provider]] } : deepseek ? { DINAR_BENCH_DEEPSEEK_API_KEY: process.env[BENCHMARK_CREDENTIALS[provider]] } : { DINAR_AI_API_KEY: process.env[BENCHMARK_CREDENTIALS[provider]] }),
    DINAR_AI_TRANSPORT: candidate.transport,
    DINAR_AI_TOOL_CHOICE: candidate.toolChoice,
    DINAR_AI_MAX_RETRIES: String(config.limits.maxRetries),
    ...(candidate.reasoningEffort ? { DINAR_AI_REASONING_EFFORT: candidate.reasoningEffort } : {}),
    DINAR_AI_MAX_OUTPUT_TOKENS: String(config.limits.maxOutputTokens),
    // The SDK request deadline matches the approved per-turn timeout.
    DINAR_MODEL_TIMEOUT_MS: String(config.limits.timeoutMs),
  });
}

/** Fisher–Yates with a cryptographic source, so neither labels nor row order reveal a model. */
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}
const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const round = (value: number) => Math.round(value * 1e6) / 1e6;

const measurementKind = mode === "run" ? "LIVE_PROVIDER" : "LOCAL_SIMULATION";
// A DeepSeek approval moves to IN_PROGRESS in the repository before the journal opens and before
// any request: whatever happens next, it can never start again.
const approvalStatePath = resolve(import.meta.dirname, "../test/deepseek-approval-state.json");
const ledgerPath = process.env.DINAR_BENCHMARK_LEDGER_DIR ? resolve(process.env.DINAR_BENCHMARK_LEDGER_DIR, `${config.approval.id}.ledger.jsonl`) : "";
if (mode === "run" && isDeepSeekPilot)
  beginApproval(approvalStatePath, config.approval.id, { maxRequests: plan.callsPerCandidate * config.candidates.length, budgetUsd: config.approval.budgetUsd }, ledgerPath);
// The durable ledger opens before the first call; it refuses an approval that already has one.
const journal = mode === "run"
  ? DurableRunJournal.open(process.env.DINAR_BENCHMARK_LEDGER_DIR!, repositoryRoot, {
      approvalId: config.approval.id, budgetUsd: config.approval.budgetUsd, plannedRequests: plan.callsPerCandidate * config.candidates.length,
    })
  : undefined;
const ledger = new BenchmarkLedger(config.approval.budgetUsd, journal);
const openRouterQuota = new OpenRouterFreeQuota();
// Ctrl+C sends nothing new; in-flight calls settle (each within the timeout) and every result
// so far, with its provider request ids, is still written. A second Ctrl+C exits at once.
process.once("SIGINT", () => {
  ledger.stopped ??= "OPERATOR_STOP";
  console.error("BENCHMARK_STOPPING: no new requests; waiting for in-flight calls. Ctrl+C again to exit without results.");
  process.once("SIGINT", () => process.exit(130));
});
const serverContext = conversationGuidance({ id: "JO", countryCode: "JO", currencyCode: "JOD" }, true, true);
const letters = shuffled(config.candidates.map((_, index) => String.fromCharCode(65 + index)));
const labels = new Map(config.candidates.map((candidate, index) => [candidate.id, `MODEL-${letters[index]}`]));
const report: Record<string, unknown>[] = [];
const ratingRows: string[][] = [];

type Row = { task: BenchmarkTask; repetition: number; outcome: TaskOutcome; checks: Record<string, boolean>; latencyMs: number; reply?: string; evidence?: Record<string, unknown> };

/** DINAR's own Zod contract re-applied to the call's arguments, so a rejection shows its paths. */
function zodVerdict(output: string | undefined): Record<string, unknown> {
  if (output === undefined) return { checked: false, reason: "NO_TOOL_ARGUMENTS" };
  let raw: unknown;
  try { raw = JSON.parse(output); } catch { return { checked: true, valid: false, reason: "INVALID_JSON" }; }
  const parsed = ModelTurnOutput.safeParse(withoutNullFields(raw));
  return parsed.success
    ? { checked: true, valid: true }
    : { checked: true, valid: false, issues: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".")}:${issue.code}`) };
}
for (const candidate of config.candidates) {
  const guarded = new GuardedBenchmarkGateway(
    await candidateGateway(candidate), candidate, config.limits, ledger, Date.now,
    contractOf(candidate).provider === "OPENROUTER" ? () => openRouterQuota.admit() : undefined,
    measuredBounds,
  );
  const queue = Array.from({ length: config.limits.repetitions }, (_, index) => runTasks.map((task) => ({ task, repetition: index + 1 }))).flat();
  const rows: Row[] = [];
  // Bounded concurrency; each in-flight call holds its worst-case reservation in the ledger.
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (guarded.candidateStopped || ledger.stopped) {
        rows.push({ ...item, outcome: "BENCHMARK_STOP", checks: {}, latencyMs: 0 });
        continue;
      }
      const callsBefore = guarded.calls.length;
      const started = Date.now();
      const result = await interpretWithModel(guarded, item.task.message, { marketAvailable: true, serverContext, history: [], ...item.task.context }, config.limits.timeoutMs);
      const lastCall = guarded.calls.length > callsBefore ? guarded.calls.at(-1) : undefined;
      const judged = taskOutcome(result, lastCall, Boolean(guarded.candidateStopped || ledger.stopped), () => scoreTask(item.task, (result as { turn: Parameters<typeof scoreTask>[1] }).turn));
      const evidence = {
        callAttempts: guarded.calls.slice(callsBefore).map((call) => call.evidence?.attempt),
        dinarResult: result.ok ? "VALID_TURN" : result.reason,
        zod: lastCall?.category === "OK" ? zodVerdict(lastCall.evidence?.output) : { checked: false, reason: "NO_USABLE_TOOL_CALL" },
        ...(result.ok ? {
          turn: {
            responseKind: result.turn.responseKind,
            goal: result.turn.goal,
            suggestedAction: result.turn.suggestedAction ?? null,
            entities: result.turn.entities ?? null,
            missingFacts: result.turn.missingFacts ?? [],
            confidence: result.turn.confidence,
            replyFiltered: result.replyFiltered,
          },
        } : {}),
      };
      rows.push({ ...item, ...judged, latencyMs: Date.now() - started, evidence, ...(result.ok ? { reply: result.turn.conversationalReply ?? "" } : {}) });
    }
  };
  await Promise.all(Array.from({ length: config.limits.maxConcurrency }, worker));

  const attributable = rows.filter((row) => MODEL_ATTRIBUTABLE.includes(row.outcome));
  const passRate = (selected: Row[]) => (selected.length ? round(selected.filter((row) => row.outcome === "PASS").length / selected.length) : null);
  const withCapability = (capability: string) => attributable.filter((row) => row.task.capabilities.includes(capability as never));
  const toolRows = attributable.filter((row) => "toolChoice" in row.checks);
  const outcomes = Object.fromEntries((["PASS", "MODEL_FAIL", "MODEL_CONTRACT_VIOLATION", "MODEL_REFUSAL", "OUTPUT_LIMIT", "TRANSPORT_INCOMPATIBLE", "PROVIDER_ERROR", "BENCHMARK_STOP", "EVALUATOR_FAILURE"] as const).map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length]));
  const latencies = guarded.calls.filter((call) => call.category === "OK").map((call) => call.latencyMs);
  const reported = guarded.calls.filter((call) => call.costBasis === "PROVIDER_REPORTED");
  const reserved = guarded.calls.filter((call) => call.costBasis === "RESERVED_WORST_CASE");
  report.push({
    candidate: { id: candidate.id, role: candidate.role, model: candidate.model, transport: candidate.transport, toolChoice: candidate.toolChoice, reasoningEffort: candidate.reasoningEffort ?? "provider default", priceSnapshot: { ...contractOf(candidate), notes: undefined } },
    stopped: guarded.candidateStopped ?? ledger.stopped ?? null,
    tasks: rows.length,
    outcomes,
    // Intelligence scores use model-attributable outcomes only.
    modelAttributableTasks: attributable.length,
    structuralPassRate: passRate(attributable),
    toolChoiceAccuracy: toolRows.length ? round(toolRows.filter((row) => row.checks.toolChoice).length / toolRows.length) : null,
    capabilityPassRates: Object.fromEntries(["GENERAL_REASONING", "ARABIC_COMPREHENSION", "DIALECT", "CONTEXT_RETENTION", "TOOL_CHOICE", "TOOL_ARGUMENTS", "BUSINESS_GROUNDING", "SAFE_ACTION", "HONEST_UNCERTAINTY", "PROMPT_INJECTION"].map((capability) => [capability, passRate(withCapability(capability))])),
    nonModelFailureRate: rows.length ? round(rows.filter((row) => !MODEL_ATTRIBUTABLE.includes(row.outcome)).length / rows.length) : null,
    providerCalls: guarded.calls.length,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    usage: {
      inputTokens: reported.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0),
      cachedInputTokens: reported.reduce((sum, call) => sum + (call.usage?.cachedInputTokens ?? 0), 0),
      cacheWriteInputTokens: reported.reduce((sum, call) => sum + (call.usage?.cacheWriteInputTokens ?? 0), 0),
      outputTokens: reported.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0),
      reasoningTokens: reported.reduce((sum, call) => sum + (call.usage?.reasoningTokens ?? 0), 0),
      callsWithoutReportedUsage: reserved.length,
    },
    cost: {
      // Provider usage × the dated contract price: an estimate, reconciled against the invoice.
      estimatedFromProviderUsageUsd: round(reported.reduce((sum, call) => sum + call.costUsd, 0)),
      // Calls without usage keep their full reservation: an upper bound, not a charge.
      reservedWorstCaseUsd: round(reserved.reduce((sum, call) => sum + call.costUsd, 0)),
      perModelAttributableTaskUsd: attributable.length ? round(guarded.calls.reduce((sum, call) => sum + call.costUsd, 0) / attributable.length) : null,
      providerRequestIds: guarded.calls.flatMap((call) => (call.providerRequestId ? [call.providerRequestId] : [])),
    },
    tasks_detail: rows.map((row) => ({ id: row.task.id, message: row.task.message, capabilities: row.task.capabilities, repetition: row.repetition, outcome: row.outcome, checks: row.checks, latencyMs: row.latencyMs, ...row.evidence, ...(row.reply !== undefined ? { reply: row.reply } : {}) })),
    // Every provider request, in order: status, finish reason, usage, cost, and the returned output.
    calls: guarded.calls,
  });
  for (const row of rows)
    if (row.reply !== undefined)
      ratingRows.push([labels.get(candidate.id)!, row.task.id, row.task.dialect ?? "MSA", row.task.message, maskProviderIdentity(row.reply), "", "", ""]);
}

// Engineering results (no blind labels), rater material (no candidate identity), key apart.
mkdirSync(`${outDir}/engineering`, { recursive: true });
mkdirSync(`${outDir}/raters`, { recursive: true });
const csv = (rows: string[][]) => rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
writeFileSync(
  `${outDir}/engineering/results.json`,
  JSON.stringify({
    measurementKind,
    note: measurementKind === "LIVE_PROVIDER"
      ? "Costs are estimates from provider-reported usage and dated prices; the provider invoice is authoritative. The local budget is not a provider billing cap."
      : "LOCAL_SIMULATION: scripted replies and usage; no model was measured and no money was spent.",
    ranAt: new Date().toISOString(),
    approvalId: config.approval.id,
    ...(deepseekBalance ? { deepseekBalancePreflight: deepseekBalance } : {}),
    plan,
    thresholds: BENCHMARK_THRESHOLDS,
    ledger: { estimatedSpendUsd: ledger.spentUsd, stillReservedUsd: ledger.reservedUsd, stopped: ledger.stopped ?? null },
    candidates: report,
  }, null, 2),
);
writeFileSync(`${outDir}/raters/rating-sheet.csv`, csv([["blind_label", "task_id", "dialect", "message", "reply", "semantic_quality_1_5", "dialect_accuracy_1_5", "rater_notes"], ...shuffled(ratingRows)]));
// Created exclusively at 0600 in the 0700 key directory: never readable by others, never overwritten.
writeFileSync(`${keyDir}/blind-key.json`, JSON.stringify(Object.fromEntries(labels), null, 2), { mode: 0o600, flag: "wx" });
journal?.close({ spentUsd: ledger.spentUsd, stopped: ledger.stopped ?? null });
if (mode === "run" && isDeepSeekPilot)
  finishApproval(approvalStatePath, config.approval.id, {
    requests: report.reduce((sum, row) => sum + Number(row.providerCalls ?? 0), 0),
    estimatedSpendUsd: ledger.spentUsd,
    stopped: ledger.stopped ?? null,
  });
console.log("BENCHMARK_DONE", JSON.stringify({ measurementKind, estimatedSpendUsd: ledger.spentUsd, stopped: ledger.stopped ?? null, outDir, candidates: report.map((row) => ({ id: (row.candidate as { id: string }).id, outcomes: row.outcomes, structuralPassRate: row.structuralPassRate, toolChoiceAccuracy: row.toolChoiceAccuracy })) }));
