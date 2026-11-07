import OpenAI from "openai";
import { toFile } from "openai/uploads";

export type AIProvider = "GROQ" | "OPENROUTER" | "OPENAI" | "REPLIT_OPENAI" | "OPENAI_COMPATIBLE" | "GEMINI" | "DEEPSEEK";

export type AIProviderErrorCode =
  | "NOT_CONFIGURED"
  | "QUOTA_LIMITED"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE";

/** Why a provider answered without a usable DINAR turn (a model outcome, not a transport fault). */
/** INCOMPLETE: the provider ended generation for a reason that leaves the call unfinished (DeepSeek `aborted`). */
/** DISABLED, CIRCUIT_OPEN and UNSUPPORTED_OPTION are local refusals: nothing was sent to the provider. */
export type AIResponseDetail = "OUTPUT_LIMIT" | "REFUSAL" | "NO_TOOL_CALL" | "INCOMPLETE" | "DISABLED" | "CIRCUIT_OPEN" | "UNSUPPORTED_OPTION";
export const LOCAL_REFUSAL_DETAILS: readonly AIResponseDetail[] = ["DISABLED", "CIRCUIT_OPEN", "UNSUPPORTED_OPTION"];
/** An option this model cannot take (a per-call reasoning effort), refused before any request. */
function unsupportedOption(provider: AIProvider, model: string): AIProviderError {
  const error = new AIProviderError(provider, "UNAVAILABLE", model);
  error.detail = "UNSUPPORTED_OPTION";
  return error;
}

export class AIProviderError extends Error {
  /** Usage the provider reported for a response that was billed but not usable. */
  usage?: ProposedToolCall["usage"];
  detail?: AIResponseDetail;
  /** The provider's finish reason for a billed but unusable response. */
  finishReason?: string;
  /**
   * Non-enumerable, so log serializers never print it: the start of an unusable response's
   * content or tool arguments, read only by the isolated benchmark to diagnose a failure.
   */
  declare readonly responseExcerpt?: string;
  constructor(
    readonly provider: AIProvider,
    readonly code: AIProviderErrorCode,
    readonly requestedModel: string,
    readonly latencyMs = 0,
    readonly httpStatus?: number,
    readonly actualModel?: string,
  ) {
    // Never retain or expose the SDK's raw message or request details.
    super("DINAR AI provider request failed.");
    this.name = "AIProviderError";
  }
}

/** How DINAR talks to a provider. Responses is OpenAI's tool-calling API for models without Chat Completions tools. */
export type AITransport = "CHAT_COMPLETIONS" | "RESPONSES" | "GEMINI_GENERATE_CONTENT";
/** REQUIRED forces the DINAR turn tool; AUTO lets models that reject or degrade under forcing think first. */
export type AIToolChoice = "REQUIRED" | "AUTO";
export const AI_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type AIReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

export type AIProviderConfiguration = {
  provider: AIProvider;
  requestedModel: string;
  /** Provider-specific transport and tool policy; free-only Gemma uses Chat Completions with AUTO. */
  transport?: AITransport;
  toolChoice?: AIToolChoice;
  gemmaFreeOnly?: boolean;
  /** Sent as the provider's reasoning-effort field when set; omitted otherwise. */
  reasoningEffort?: AIReasoningEffort;
  /**
   * Self-hosted chat templates (e.g. Qwen3 served by vLLM/SGLang) that default to a thinking
   * phase: "disabled" sends chat_template_kwargs.enable_thinking=false. OPENAI_COMPATIBLE only.
   */
  thinking?: "disabled";
  credentialName:
    | "GROQ_API_KEY"
    | "OPENROUTER_API_KEY"
    | "OPENAI_API_KEY"
    | "DINAR_BENCH_OPENROUTER_API_KEY"
    | "DINAR_BENCH_GROQ_API_KEY"
    | "DINAR_BENCH_GEMINI_API_KEY"
    | "DINAR_BENCH_DEEPSEEK_API_KEY"
    | "DINAR_DEEPSEEK_API_KEY"
    | "AI_INTEGRATIONS_OPENAI_API_KEY"
    | "DINAR_AI_API_KEY"
    | "DINAR_AI_FALLBACK_API_KEY";
  baseURL?: string;
};

const GROQ_MODEL = "openai/gpt-oss-120b";
export const GROQ_FREE_MODELS = ["openai/gpt-oss-120b"] as const;
const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";
const DEEPSEEK_MODEL = "deepseek-flash";
const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
const OPENROUTER_FREE_MODEL = "openrouter/free";
export const GEMMA_FREE_MODELS = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
] as const;
export const GEMINI_FREE_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"] as const;
const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const OPENAI_MODEL = "gpt-5.6-terra";
// Replit AI Integrations proxy OpenAI with Replit-managed credentials; the endpoint is
// provisioned per Repl, so it is read from the environment and never hard-coded.
const REPLIT_OPENAI_MODEL = "gpt-5-mini";

/**
 * Provider selection is server-only. Development defaults to Groq. OPENAI_COMPATIBLE is the
 * provider-neutral slot for an owner-approved model behind any OpenAI-compatible chat endpoint
 * (DINAR_AI_BASE_URL + DINAR_AI_MODEL + DINAR_AI_API_KEY); nothing is chosen for the owner.
 * `slot: "FALLBACK"` reads the DINAR_AI_FALLBACK_* variables; a fallback exists only when set.
 */
export function resolveAIProviderConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  slot: "PRIMARY" | "FALLBACK" | "HEAVY" = "PRIMARY",
): AIProviderConfiguration {
  if (env.DINAR_GEMMA_FREE_ONLY === "true" && slot !== "PRIMARY")
    throw new Error("DINAR_GEMMA_FREE_ONLY does not allow fallback providers.");
  const prefix = slot === "PRIMARY" ? "DINAR_AI_" : slot === "FALLBACK" ? "DINAR_AI_FALLBACK_" : "DINAR_AI_HEAVY_";
  const configured = (env[`${prefix}PROVIDER`] ?? (slot === "PRIMARY" ? "GROQ" : "")).trim().toUpperCase();
  const model = env[`${prefix}MODEL`]?.trim();
  if (configured === "GROQ") {
    if (env.DINAR_GROQ_FREE_ONLY === "true") {
      if (slot !== "PRIMARY" || env.NODE_ENV !== "development" ||
          env.REPLIT_DEPLOYMENT !== undefined || env.RAILWAY_ENVIRONMENT !== undefined ||
          env.DINAR_GROQ_BENCHMARK_CONTEXT !== "1")
        throw new Error("Groq free-only mode is restricted to the isolated development benchmark.");
      const requestedModel = model?.trim();
      if (!requestedModel || !(GROQ_FREE_MODELS as readonly string[]).includes(requestedModel))
        throw new Error("DINAR_GROQ_FREE_ONLY permits only the exact approved Groq benchmark model ID.");
      return {
        provider: "GROQ",
        requestedModel,
        credentialName: "DINAR_BENCH_GROQ_API_KEY",
        baseURL: GROQ_API_BASE_URL,
        transport: "CHAT_COMPLETIONS",
        toolChoice: "AUTO",
      };
    }
    return {
      provider: "GROQ",
      requestedModel: model || GROQ_MODEL,
      credentialName: "GROQ_API_KEY",
      baseURL: GROQ_API_BASE_URL,
    };
  }
  if (configured === "OPENROUTER") {
    if (env.DINAR_GEMMA_FREE_ONLY === "true") {
      if (slot !== "PRIMARY") throw new Error("Gemma free-only mode does not allow fallback providers.");
      const requestedModel = model?.trim();
      if (!requestedModel || !(GEMMA_FREE_MODELS as readonly string[]).includes(requestedModel))
        throw new Error("DINAR_GEMMA_FREE_ONLY permits only the exact approved Gemma :free model IDs.");
      return {
        provider: "OPENROUTER",
        requestedModel,
        credentialName: "DINAR_BENCH_OPENROUTER_API_KEY",
        baseURL: OPENROUTER_API_BASE_URL,
        toolChoice: "AUTO",
        gemmaFreeOnly: true,
      };
    }
    return {
      provider: "OPENROUTER",
      requestedModel: slot === "FALLBACK" && model ? model : OPENROUTER_FREE_MODEL,
      credentialName: "OPENROUTER_API_KEY",
      baseURL: OPENROUTER_API_BASE_URL,
    };
  }
  if (configured === "OPENAI")
    return {
      provider: "OPENAI",
      requestedModel: slot === "FALLBACK" && model ? model : OPENAI_MODEL,
      credentialName: "OPENAI_API_KEY",
    };
  if (configured === "REPLIT_OPENAI")
    return {
      provider: "REPLIT_OPENAI",
      requestedModel: slot === "FALLBACK" && model ? model : REPLIT_OPENAI_MODEL,
      credentialName: "AI_INTEGRATIONS_OPENAI_API_KEY",
      baseURL: env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim() || undefined,
    };
  if (configured === "GEMINI") {
    if (slot !== "PRIMARY" || env.DINAR_GEMINI_FREE_ONLY !== "true" || env.DINAR_GEMINI_BENCHMARK_CONTEXT !== "1")
      throw new Error("Gemini is available only in the explicitly marked isolated free-only benchmark.");
    const requestedModel = model?.trim();
    if (!requestedModel || !(GEMINI_FREE_MODELS as readonly string[]).includes(requestedModel))
      throw new Error("DINAR_GEMINI_FREE_ONLY permits only the exact verified free-tier Gemini model ID.");
    return {
      provider: "GEMINI",
      requestedModel,
      credentialName: "DINAR_BENCH_GEMINI_API_KEY",
      transport: "GEMINI_GENERATE_CONTENT",
      toolChoice: "AUTO",
    };
  }
  if (configured === "DEEPSEEK") {
    const requestedModel = model?.trim();
    if (slot !== "PRIMARY" || requestedModel !== DEEPSEEK_MODEL)
      throw new Error("DeepSeek is a primary-only provider for the exact approved model ID.");
    // The benchmark and the conversation never share a credential: the paid benchmark key
    // cannot silently become the conversation key, and the reverse.
    const benchmark = env.DEEPSEEK_BENCHMARK_CONTEXT === "1";
    if (
      benchmark &&
      (env.NODE_ENV !== "development" ||
        env.REPLIT_DEPLOYMENT !== undefined ||
        env.RAILWAY_ENVIRONMENT !== undefined ||
        env.DINAR_AI_FALLBACK_PROVIDER?.trim())
    )
      throw new Error("The DeepSeek benchmark is restricted to the isolated development environment, with no fallback.");
    return {
      provider: "DEEPSEEK",
      requestedModel,
      credentialName: benchmark ? "DINAR_BENCH_DEEPSEEK_API_KEY" : "DINAR_DEEPSEEK_API_KEY",
      baseURL: DEEPSEEK_API_BASE_URL,
      transport: "CHAT_COMPLETIONS",
      // One structured turn, not an agent loop: non-thinking mode spends the output budget on
      // the DINAR tool call and is the only mode in which DeepSeek accepts tool_choice=required.
      // The isolated benchmark may measure autonomous selection (AUTO); the conversation never does.
      toolChoice: benchmark && env.DINAR_AI_TOOL_CHOICE?.trim().toUpperCase() === "AUTO" ? "AUTO" : "REQUIRED",
      reasoningEffort: "none",
    };
  }
  if (configured === "OPENAI_COMPATIBLE") {
    const baseURL = safeProviderBaseUrl(env[`${prefix}BASE_URL`], env);
    const transport = (env[`${prefix}TRANSPORT`]?.trim().toUpperCase() || "CHAT_COMPLETIONS") as AITransport;
    const toolChoice = (env[`${prefix}TOOL_CHOICE`]?.trim().toUpperCase() || "REQUIRED") as AIToolChoice;
    const effort = env[`${prefix}REASONING_EFFORT`]?.trim().toLowerCase();
    const thinking = env[`${prefix}THINKING`]?.trim().toLowerCase();
    if (thinking && thinking !== "disabled") throw new Error(`${prefix}THINKING may only be "disabled".`);
    if (!["CHAT_COMPLETIONS", "RESPONSES"].includes(transport)) throw new Error(`${prefix}TRANSPORT must be CHAT_COMPLETIONS or RESPONSES.`);
    if (!["REQUIRED", "AUTO"].includes(toolChoice)) throw new Error(`${prefix}TOOL_CHOICE must be REQUIRED or AUTO.`);
    if (effort && !(AI_REASONING_EFFORTS as readonly string[]).includes(effort)) throw new Error(`${prefix}REASONING_EFFORT must be one of ${AI_REASONING_EFFORTS.join(", ")}.`);
    // The Responses API is OpenAI's; other OpenAI-compatible endpoints are not assumed to have it.
    // (A loopback endpoint is accepted only in development, where safeProviderBaseUrl allows it: test doubles.)
    if (transport === "RESPONSES" && baseURL && new URL(baseURL).host !== "api.openai.com" && new URL(baseURL).protocol !== "http:")
      throw new Error(`${prefix}TRANSPORT=RESPONSES is only supported for api.openai.com.`);
    return {
      provider: "OPENAI_COMPATIBLE",
      requestedModel: model ?? "",
      credentialName: slot === "PRIMARY" ? "DINAR_AI_API_KEY" : "DINAR_AI_FALLBACK_API_KEY",
      baseURL,
      ...(transport !== "CHAT_COMPLETIONS" ? { transport } : {}),
      ...(toolChoice !== "REQUIRED" ? { toolChoice } : {}),
      ...(effort ? { reasoningEffort: effort as AIReasoningEffort } : {}),
      ...(thinking ? { thinking: "disabled" as const } : {}),
    };
  }
  throw new Error(`${prefix}PROVIDER must be GROQ, OPENROUTER, OPENAI, REPLIT_OPENAI, OPENAI_COMPATIBLE, GEMINI or DEEPSEEK.`);
}

/** Credentials go only to HTTPS endpoints (plain HTTP only to loopback in development). */
export function safeProviderBaseUrl(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback && env.NODE_ENV === "development"))
      return url.toString().replace(/\/$/, "");
  } catch {
    // An unparsable endpoint is simply not configured.
  }
  return undefined;
}

export type AIModelRuntimeConfiguration = {
  primary: AIProviderConfiguration;
  fallback?: AIProviderConfiguration;
  /** The HEAVY tier model (DINAR_AI_HEAVY_PROVIDER / DINAR_AI_HEAVY_MODEL), used only when DINAR_AI_TIERING=on. */
  heavy?: AIProviderConfiguration;
  /** Whole-turn deadline across retries and fallback (DINAR_MODEL_TIMEOUT_MS). */
  timeoutMs: number;
  /** Retries of a transient outage on the same provider (DINAR_AI_MAX_RETRIES, 0–2). */
  maxRetries: number;
  /** Output ceiling per call (DINAR_AI_MAX_OUTPUT_TOKENS, 256–8192, default 8192): a hard cost bound. */
  maxOutputTokens: number;
  capabilities: {
    toolCalling: true;
    structuredOutput: "TOOL_SCHEMA";
    /** Turns are one validated structured tool call; progress is streamed (SSE), tokens are not. */
    tokenStreaming: false;
    imageInput: boolean;
    usageReporting: "PROVIDER_REPORTED_WHEN_AVAILABLE";
  };
};

export function resolveAIModelRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): AIModelRuntimeConfiguration {
  const primary = resolveAIProviderConfiguration(env);
  let fallback: AIProviderConfiguration | undefined;
  if (env.DINAR_AI_FALLBACK_PROVIDER?.trim()) {
    const candidate = resolveAIProviderConfiguration(env, "FALLBACK");
    // A fallback identical to the primary would only repeat the same failure at extra cost.
    if (candidate.provider !== primary.provider || candidate.requestedModel !== primary.requestedModel) fallback = candidate;
  }
  let heavy: AIProviderConfiguration | undefined;
  if (env.DINAR_AI_HEAVY_PROVIDER?.trim()) {
    const candidate = resolveAIProviderConfiguration(env, "HEAVY");
    // A heavy tier identical to the primary is the primary at high effort (model-tier.ts), not a second model.
    if (candidate.provider !== primary.provider || candidate.requestedModel !== primary.requestedModel) heavy = candidate;
  }
  const retries = Number(env.DINAR_AI_MAX_RETRIES ?? 1);
  const outputTokens = Number(env.DINAR_AI_MAX_OUTPUT_TOKENS ?? MAX_OUTPUT_TOKENS);
  const timeout = Number(env.DINAR_MODEL_TIMEOUT_MS ?? 25000);
  return {
    primary,
    ...(fallback ? { fallback } : {}),
    ...(heavy ? { heavy } : {}),
    timeoutMs: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 50), 120_000) : 25000,
    maxRetries: Number.isInteger(retries) ? Math.min(Math.max(retries, 0), 2) : 1,
    maxOutputTokens: Number.isInteger(outputTokens) ? Math.min(Math.max(outputTokens, 256), MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS,
    capabilities: {
      toolCalling: true,
      structuredOutput: "TOOL_SCHEMA",
      tokenStreaming: false,
      imageInput: env.DINAR_AI_IMAGE_INPUT === "true",
      usageReporting: "PROVIDER_REPORTED_WHEN_AVAILABLE",
    },
  };
}

function providerConfigured(configuration: AIProviderConfiguration, env: NodeJS.ProcessEnv) {
  if (!env[configuration.credentialName]) return false;
  if (configuration.provider === "REPLIT_OPENAI" || configuration.provider === "OPENAI_COMPATIBLE")
    return Boolean(configuration.baseURL) && Boolean(configuration.requestedModel);
  return true;
}

/**
 * Secret-free readiness of the AI runtime for operators: which slot points where, whether its
 * credential is present (never its value), and what the runtime supports. Contacts nothing.
 */
export function describeAIModelReadiness(env: NodeJS.ProcessEnv = process.env) {
  const slot = (configuration: AIProviderConfiguration) => ({
    provider: configuration.provider,
    model: configuration.requestedModel || null,
    endpointHost: configuration.baseURL ? new URL(configuration.baseURL).host : configuration.provider === "OPENAI" ? "api.openai.com" : null,
    credentialName: configuration.credentialName,
    credentialPresent: Boolean(env[configuration.credentialName]),
    transport: configuration.transport ?? "CHAT_COMPLETIONS",
    toolChoice: configuration.toolChoice ?? "REQUIRED",
    reasoningEffort: configuration.reasoningEffort ?? null,
    thinking: configuration.thinking ?? null,
    configured: providerConfigured(configuration, env),
  });
  try {
    const runtime = resolveAIModelRuntimeConfiguration(env);
    return {
      valid: true as const,
      modelCallsEnabled: env.DINAR_AI_MODEL_FALLBACK === "true",
      primary: slot(runtime.primary),
      fallback: runtime.fallback ? slot(runtime.fallback) : null,
      // Present only when configured, so the existing readiness shape is unchanged otherwise.
      ...(runtime.heavy || env.DINAR_AI_TIERING ? { tiering: { enabled: env.DINAR_AI_TIERING?.trim().toLowerCase() === "on", heavy: runtime.heavy ? slot(runtime.heavy) : "SAME_MODEL_HIGH_EFFORT" } } : {}),
      timeoutMs: runtime.timeoutMs,
      maxRetries: runtime.maxRetries,
      maxOutputTokens: runtime.maxOutputTokens,
      capabilities: runtime.capabilities,
      productionApproved: env.DINAR_AI_PRODUCTION_APPROVED === "true",
      liveProvidersEnabled: env.DINAR_LIVE_PROVIDERS_ENABLED === "true",
    };
  } catch (error) {
    return { valid: false as const, error: error instanceof Error ? error.message.slice(0, 200) : "invalid configuration" };
  }
}

/**
 * Vision is independently selected and deliberately development-only. The
 * supported Groq model is explicit so a text-model change cannot silently turn
 * image analysis into an unsupported request or switch providers.
 */
export function resolveDevelopmentVisionProviderConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): AIProviderConfiguration | undefined {
  if (env.NODE_ENV !== "development") return undefined;

  const configured = (env.DINAR_VISION_PROVIDER ?? "GROQ").trim().toUpperCase();
  if (configured === "DISABLED") return undefined;
  if (configured !== "GROQ") return undefined;

  const requestedModel =
    env.DINAR_VISION_MODEL?.trim() || "qwen/qwen3.8-27b";
  if (requestedModel !== "qwen/qwen3.8-27b") return undefined;

  return {
    provider: "GROQ",
    requestedModel,
    credentialName: "GROQ_API_KEY",
    baseURL: GROQ_API_BASE_URL,
  };
}

export function normalizeAIProviderError(
  provider: AIProvider,
  requestedModel: string,
  error: unknown,
  latencyMs: number,
): AIProviderError {
  if (error instanceof AIProviderError) return error;
  const httpStatus =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  // An expired/invalid credential, an unknown model or a request the provider rejects as invalid
  // (an unsupported parameter, a provider spend limit, an exhausted prepaid balance — HTTP 402)
  // is a configuration fault, not an outage: retrying cannot help, so it is never retried, and
  // the user is told it is not configured.
  const code: AIProviderErrorCode =
    httpStatus === 429
      ? "QUOTA_LIMITED"
      : httpStatus !== undefined && [400, 401, 402, 403, 404, 413, 422].includes(httpStatus)
        ? "NOT_CONFIGURED"
        : "UNAVAILABLE";
  return new AIProviderError(
    provider,
    code,
    requestedModel,
    latencyMs,
    httpStatus,
  );
}

export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
};

export type ProposedToolCall = {
  id: string;
  name: string;
  arguments: string;
  provider?: AIProvider;
  requestedModel?: string;
  actualModel?: string;
  latencyMs?: number;
  /**
   * Provider-reported token usage, when the provider returns it (G1 metering). Input includes
   * cache reads and cache writes; output includes reasoning.
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    /** Input written to the provider cache (billed above the uncached rate on newer OpenAI models). */
    cacheWriteInputTokens?: number;
    /** The part of cacheWriteInputTokens written with the 12-hour lifetime (a higher rate). */
    cacheWrite12hInputTokens?: number;
    reasoningTokens?: number;
  };
  /** The provider's own id for this request, used to reconcile its bill. */
  providerRequestId?: string;
  finishReason?: string;
};

export interface ConversationModelGateway {
  readonly providerInfo?: {
    provider: AIProvider;
    requestedModel: string;
  };
  proposeToolCall(
    messages: ModelMessage[],
    tools: ModelToolDefinition[],
    options?: ModelCallOptions,
  ): Promise<ProposedToolCall>;
  /** An owner-configured second model, tried only after the primary failed (never for a timeout). */
  readonly fallback?: ConversationModelGateway;
  /** The HEAVY tier (model-tier.ts): a stronger model for requests that earn it. Absent: same model, high effort. */
  readonly heavy?: ConversationModelGateway;
  /**
   * Whether a per-call reasoning effort is applied by this model (Groq gpt-oss today). Absent or
   * false: sending one is refused locally, so model-tier.ts never relies on it.
   */
  readonly perCallReasoningEffort?: boolean;
}

/** Aborting cancels the provider request (turn timeout); it never retries a mutation. */
export type ReasoningEffort = "low" | "medium" | "high";
export type ModelCallOptions = {
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
};

let modelGatewayCallCount = 0;

export function getModelGatewayCallCount(): number {
  return modelGatewayCallCount;
}

export function resetModelGatewayCallCount(): void {
  modelGatewayCallCount = 0;
}

/**
 * The one counted entry point to any gateway (production, blocked or a controlled test
 * provider), so every model call is visible to the deterministic-turn audits.
 */
export function proposeThroughGateway(
  gateway: ConversationModelGateway,
  messages: ModelMessage[],
  tools: ModelToolDefinition[],
  options?: ModelCallOptions,
): Promise<ProposedToolCall> {
  modelGatewayCallCount += 1;
  const provider = gateway.providerInfo?.provider;
  if (!provider) {
    // Without provider metadata nothing can be disabled, isolated or costed: production refuses it.
    if (process.env.NODE_ENV === "production") return Promise.reject(refusedLocally("UNKNOWN" as AIProvider, "UNKNOWN", "NOT_CONFIGURED", "DISABLED"));
    return gateway.proposeToolCall(messages, tools, options);
  }
  const model = gateway.providerInfo?.requestedModel ?? "UNKNOWN";
  // Owner switch (environment, read on every call): the request is never sent.
  if (isProviderDisabled(provider, model)) return Promise.reject(refusedLocally(provider, model, "NOT_CONFIGURED", "DISABLED"));
  const threshold = breakerThreshold();
  if (!threshold) return gateway.proposeToolCall(messages, tools, options);
  const key = `${provider}:${model}`;
  const state = breakers.get(key) ?? { failures: 0, openUntil: 0, trialSince: 0, generation: 0 };
  breakers.set(key, state);
  const now = Date.now();
  const cooldown = breakerCooldownMs();
  // A trial that has not settled within one cool-down (hung connection) no longer holds the slot.
  const trialLive = state.trialSince > 0 && now - state.trialSince < cooldown;
  if (state.openUntil > now || trialLive) return Promise.reject(refusedLocally(provider, model, "UNAVAILABLE", "CIRCUIT_OPEN"));
  // After the cool-down exactly one trial request is let through; its outcome closes or reopens.
  const isTrial = state.openUntil > 0;
  const generation = ++state.generation;
  if (isTrial) state.trialSince = now;
  // Only the latest request may move the breaker; a stale (expired) trial's late outcome is ignored.
  const current = () => state.generation === generation || !isTrial;
  return gateway.proposeToolCall(messages, tools, options).then(
    (call) => {
      if (current()) {
        if (state.openUntil) breakerTransition(provider, model, "CLOSED", state.failures);
        state.failures = 0;
        state.openUntil = 0;
        state.trialSince = 0;
      }
      return call;
    },
    (error: unknown) => {
      if (!current()) throw error;
      if (isTrial) state.trialSince = 0;
      // The caller's own cancellation (turn deadline, client gone) says nothing about the provider.
      if (options?.signal?.aborted) throw error;
      // Outages count; a billed but unusable answer (OUTPUT_LIMIT, REFUSAL…) is the model, not the provider.
      const outage = !(error instanceof AIProviderError) || (error.code === "UNAVAILABLE" && !LOCAL_REFUSAL_DETAILS.includes(error.detail as AIResponseDetail));
      if (outage) {
        state.failures += 1;
        if (isTrial || state.failures >= threshold) {
          state.openUntil = Date.now() + cooldown;
          breakerTransition(provider, model, "OPEN", state.failures);
        }
      }
      throw error;
    },
  );
}

/**
 * DINAR_AI_DISABLED_PROVIDERS: comma-separated `*`, `PROVIDER` or `PROVIDER:model` (case-insensitive).
 */
export function isProviderDisabled(provider: string, model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const disabled = (env.DINAR_AI_DISABLED_PROVIDERS ?? "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  const p = provider.toUpperCase();
  return disabled.includes("*") || disabled.includes(p) || disabled.includes(`${p}:${model.toUpperCase()}`);
}

/** Whether a request to this gateway would be sent now: not disabled and its breaker not open. */
export function gatewayLocallyAvailable(gateway: ConversationModelGateway, now = Date.now()): boolean {
  const info = gateway.providerInfo;
  if (!info) return true;
  if (isProviderDisabled(info.provider, info.requestedModel)) return false;
  const state = breakers.get(`${info.provider}:${info.requestedModel}`);
  return !state || state.openUntil <= now;
}

/**
 * Per provider+model circuit breaker (§13). DINAR_AI_BREAKER_FAILURES consecutive outages open it
 * for DINAR_AI_BREAKER_COOLDOWN_MS; 0 disables it. Default 5, except in model-blocked test runs.
 * State is in this process only: each replica protects itself and a restart starts CLOSED.
 */
type BreakerState = { failures: number; openUntil: number; trialSince: number; generation: number };
const breakers = new Map<string, BreakerState>();
function breakerThreshold(env: NodeJS.ProcessEnv = process.env): number {
  if (env.DINAR_AI_BREAKER_FAILURES !== undefined) {
    const value = Number(env.DINAR_AI_BREAKER_FAILURES);
    return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 0;
  }
  return env.BDINAR_BLOCK_MODEL_CALLS === "1" ? 0 : 5;
}
function breakerCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DINAR_AI_BREAKER_COOLDOWN_MS);
  return Number.isInteger(value) && value >= 1000 ? Math.min(value, 3_600_000) : 60_000;
}
function refusedLocally(provider: AIProvider, model: string, code: AIProviderErrorCode, detail: AIResponseDetail): AIProviderError {
  const error = new AIProviderError(provider, code, model);
  error.detail = detail;
  return error;
}

type BreakerListener = (event: { provider: string; model: string; state: "OPEN" | "CLOSED"; consecutiveFailures: number }) => void;
let breakerListener: BreakerListener | undefined;
/** The alert hook: called on every OPEN/CLOSED transition with no prompt, user or key. */
export function onProviderBreakerTransition(listener: BreakerListener | undefined): void {
  breakerListener = listener;
}
function breakerTransition(provider: string, model: string, state: "OPEN" | "CLOSED", consecutiveFailures: number): void {
  try {
    breakerListener?.({ provider, model, state, consecutiveFailures });
  } catch {
    // An alerting failure never changes the request's outcome.
  }
}

/** Health for monitoring: no prompts, no keys, only each provider+model breaker state. */
export function providerHealth(): Array<{ provider: string; model: string; state: "CLOSED" | "OPEN" | "HALF_OPEN"; consecutiveFailures: number }> {
  const now = Date.now();
  return [...breakers].map(([key, state]) => {
    const split = key.indexOf(":");
    return {
      provider: key.slice(0, split),
      model: key.slice(split + 1),
      state: state.openUntil > now ? "OPEN" : state.openUntil ? "HALF_OPEN" : "CLOSED",
      consecutiveFailures: state.failures,
    };
  });
}

/** Test-only: forget breaker state between scenarios. */
export function resetProviderBreakers(): void {
  breakers.clear();
}

class BlockedTestModelGateway implements ConversationModelGateway {
  async proposeToolCall(): Promise<ProposedToolCall> {
    throw new Error("Model calls are blocked during phase-one acceptance tests.");
  }
}

/**
 * OpenAI's reasoning models think at "medium" by default, which put a structured turn at
 * 18–24 s against the 25 s budget; "low" keeps answers complete at a few seconds.
 */
const REASONING_EFFORT: Partial<Record<AIProvider, "low">> = {
  OPENAI: "low",
  REPLIT_OPENAI: "low",
};

const MAX_OUTPUT_TOKENS = 8192;
/** Per-request SDK deadline when none is configured; the turn's own deadline still applies. */
const REQUEST_TIMEOUT_MS = 25000;

/** Cache-write counts from an OpenAI input-token breakdown (Chat Completions or Responses). */
function cacheWriteUsage(details: unknown): { cacheWriteInputTokens?: number; cacheWrite12hInputTokens?: number } {
  const value = details as { cache_write_tokens?: unknown; cache_write_tokens_details?: { ttl_12h_tokens?: unknown } } | undefined;
  const writes = value?.cache_write_tokens;
  const long = value?.cache_write_tokens_details?.ttl_12h_tokens;
  if (!Number.isInteger(writes) || (writes as number) <= 0) return {};
  return {
    cacheWriteInputTokens: writes as number,
    ...(Number.isInteger(long) && (long as number) > 0 ? { cacheWrite12hInputTokens: long as number } : {}),
  };
}

class OpenAICompatibleChatGateway implements ConversationModelGateway {
  constructor(
    private readonly client: OpenAI,
    readonly providerInfo: {
      provider: AIProvider;
      requestedModel: string;
    },
    readonly fallback?: ConversationModelGateway,
    private readonly maxOutputTokens = MAX_OUTPUT_TOKENS,
    private readonly policy: { toolChoice?: AIToolChoice; reasoningEffort?: AIReasoningEffort } = {},
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
    private readonly gemmaFreeOnly = false,
    private readonly selfHostedThinking?: "disabled",
  ) {}

  /** Only Groq's gpt-oss applies a per-call effort; DeepSeek ignores one (its turn stays non-thinking). */
  get perCallReasoningEffort(): boolean {
    return this.providerInfo.provider === "GROQ" && this.providerInfo.requestedModel === "openai/gpt-oss-120b";
  }

  async proposeToolCall(
    messages: ModelMessage[],
    tools: ModelToolDefinition[],
    options: ModelCallOptions = {},
  ): Promise<ProposedToolCall> {
    const startedAt = Date.now();
    // The composer's depth preference does not apply to DeepSeek: its structured turn must stay
    // non-thinking (thinking refuses the forced tool call), so the turn runs at that policy.
    if (
      options.reasoningEffort &&
      this.providerInfo.provider !== "DEEPSEEK" &&
      !this.perCallReasoningEffort
    )
      throw unsupportedOption(this.providerInfo.provider, this.providerInfo.requestedModel);
    // DeepSeek rejects a forced tool call in thinking mode (HTTP 400): refuse it before a billed request.
    if (this.providerInfo.provider === "DEEPSEEK" && this.policy.toolChoice !== "AUTO" && this.policy.reasoningEffort !== "none")
      throw new AIProviderError(this.providerInfo.provider, "NOT_CONFIGURED", this.providerInfo.requestedModel);
    try {
      const result = await this.client.chat.completions.create(
        {
          model: this.providerInfo.requestedModel,
          // Follow the provider guidance; the schema, not a low token cap,
          // bounds the structured turn.
          ...(this.gemmaFreeOnly || this.providerInfo.provider === "DEEPSEEK"
            ? { max_tokens: this.maxOutputTokens }
            : { max_completion_tokens: this.maxOutputTokens }),
          ...(this.providerInfo.provider === "GROQ" &&
          this.providerInfo.requestedModel === "openai/gpt-oss-120b" &&
          options.reasoningEffort
            ? { reasoning_effort: options.reasoningEffort }
            : {}),
          ...(REASONING_EFFORT[this.providerInfo.provider]
            ? { reasoning_effort: REASONING_EFFORT[this.providerInfo.provider] }
            : this.policy.reasoningEffort
              ? { reasoning_effort: this.policy.reasoningEffort }
              : {}),
          // DeepSeek's documented non-thinking switch, sent with reasoning_effort=none (its
          // equivalent): both name the same mode, so no reasoning tokens consume the output.
          ...(this.providerInfo.provider === "DEEPSEEK" && this.policy.reasoningEffort === "none"
            ? { thinking: { type: "disabled" } }
            : {}),
          // Self-hosted Qwen-style templates: no thinking phase before the forced tool call.
          ...(this.providerInfo.provider === "OPENAI_COMPATIBLE" && this.selfHostedThinking === "disabled"
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
          messages,
          tools: tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: this.policy.toolChoice === "AUTO" ? "auto" : "required",
          ...(this.policy.toolChoice === "AUTO" && !this.gemmaFreeOnly && this.providerInfo.provider !== "DEEPSEEK"
            ? { parallel_tool_calls: false }
            : {}),
          ...(this.gemmaFreeOnly ? {
            provider: {
              allow_fallbacks: false,
              max_price: { prompt: 0, completion: 0 },
              data_collection: "deny",
              zdr: true,
            },
          } : {}),
        },
        { timeout: this.requestTimeoutMs, maxRetries: 0, signal: options.signal },
      );
      const latencyMs = Date.now() - startedAt;
      const actualModel =
        typeof result.model === "string" &&
        /^[A-Za-z0-9._:/-]{1,120}$/.test(result.model)
          ? result.model
          : undefined;
      if (this.gemmaFreeOnly && actualModel !== this.providerInfo.requestedModel)
        throw new AIProviderError(this.providerInfo.provider, "INVALID_RESPONSE", this.providerInfo.requestedModel, latencyMs, undefined, actualModel);
      const cached = result.usage?.prompt_tokens_details?.cached_tokens;
      const reasoning = result.usage?.completion_tokens_details?.reasoning_tokens;
      const usage =
        Number.isInteger(result.usage?.prompt_tokens) && Number.isInteger(result.usage?.completion_tokens)
          ? {
              inputTokens: result.usage!.prompt_tokens,
              outputTokens: result.usage!.completion_tokens,
              ...(Number.isInteger(cached) ? { cachedInputTokens: cached! } : {}),
              ...cacheWriteUsage(result.usage!.prompt_tokens_details),
              ...(Number.isInteger(reasoning) && reasoning! > 0 ? { reasoningTokens: reasoning! } : {}),
            }
          : undefined;
      const choice = result.choices[0];
      const finishReason: string | undefined = choice?.finish_reason;
      // DeepSeek reports server overload as a finish reason: a transient provider fault, still billed.
      if (finishReason === "insufficient_system_resource") {
        const error = new AIProviderError(this.providerInfo.provider, "UNAVAILABLE", this.providerInfo.requestedModel, latencyMs, undefined, actualModel);
        if (usage) error.usage = usage;
        error.finishReason = finishReason;
        throw error;
      }
      const functionCalls = choice?.message.tool_calls?.filter((call) => call.type === "function") ?? [];
      const toolCall = functionCalls.find(
        (call) => call.type === "function",
      );
      // DeepSeek's documented finish reasons: only a call that ended as a call (or a stop) is
      // complete. A filtered, aborted or unknown ending never becomes a turn, however whole it looks.
      const deepseekUnfinished = this.providerInfo.provider === "DEEPSEEK" && finishReason !== "tool_calls" && finishReason !== "stop";
      // A call cut off at the output ceiling carries truncated arguments: an output limit, not a malformed turn.
      if (!toolCall || toolCall.type !== "function" || finishReason === "length" || deepseekUnfinished ||
          (this.providerInfo.provider === "DEEPSEEK" && functionCalls.length !== 1))
        throw unusableResponse(
          this.providerInfo,
          latencyMs,
          actualModel,
          usage,
          finishReason === "length" ? "OUTPUT_LIMIT" : finishReason === "content_filter" || choice?.message.refusal ? "REFUSAL" : toolCall && deepseekUnfinished ? "INCOMPLETE" : "NO_TOOL_CALL",
          finishReason,
          (toolCall?.type === "function" ? toolCall.function.arguments : undefined) ?? choice?.message.content ?? undefined,
        );
      const providerRequestId = typeof result.id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(result.id) ? result.id : undefined;
      return {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
        provider: this.providerInfo.provider,
        requestedModel: this.providerInfo.requestedModel,
        actualModel,
        latencyMs,
        ...(usage ? { usage } : {}),
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(finishReason ? { finishReason } : {}),
      };
    } catch (error) {
      throw normalizeAIProviderError(
        this.providerInfo.provider,
        this.providerInfo.requestedModel,
        error,
        Date.now() - startedAt,
      );
    }
  }
}

/** A billed response that carries no DINAR turn: usage is kept so its cost is never lost. */
function unusableResponse(
  providerInfo: { provider: AIProvider; requestedModel: string },
  latencyMs: number,
  actualModel: string | undefined,
  usage: ProposedToolCall["usage"],
  detail: AIResponseDetail,
  finishReason?: string,
  excerpt?: string,
): AIProviderError {
  const error = new AIProviderError(providerInfo.provider, "INVALID_RESPONSE", providerInfo.requestedModel, latencyMs, undefined, actualModel);
  error.detail = detail;
  if (finishReason) error.finishReason = finishReason;
  if (excerpt) Object.defineProperty(error, "responseExcerpt", { value: excerpt.slice(0, 4000), enumerable: false });
  if (usage) error.usage = usage;
  return error;
}

/**
 * OpenAI Responses API transport, for models whose tool calling is not offered on Chat
 * Completions (or only without reasoning). Same contract as the chat transport: one function
 * call proposed for the DINAR turn, nothing executed, nothing stored at the provider.
 */
class OpenAIResponsesGateway implements ConversationModelGateway {
  constructor(
    private readonly client: OpenAI,
    readonly providerInfo: { provider: AIProvider; requestedModel: string },
    readonly fallback: ConversationModelGateway | undefined,
    private readonly maxOutputTokens: number,
    private readonly policy: { toolChoice?: AIToolChoice; reasoningEffort?: AIReasoningEffort },
    private readonly requestTimeoutMs: number,
  ) {}

  async proposeToolCall(messages: ModelMessage[], tools: ModelToolDefinition[], options: ModelCallOptions = {}): Promise<ProposedToolCall> {
    const startedAt = Date.now();
    // Per-call effort is a Groq gpt-oss feature; the configured effort is the only one here.
    if (options.reasoningEffort)
      throw unsupportedOption(this.providerInfo.provider, this.providerInfo.requestedModel);
    try {
      const result = await this.client.responses.create(
        {
          model: this.providerInfo.requestedModel,
          input: messages.map((message) => ({ role: message.role, content: message.content })),
          tools: tools.map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
          tool_choice: this.policy.toolChoice === "AUTO" ? "auto" : "required",
          parallel_tool_calls: false,
          max_output_tokens: this.maxOutputTokens,
          // DINAR keeps its own conversation; nothing is retained at the provider.
          store: false,
          ...(this.policy.reasoningEffort ? { reasoning: { effort: this.policy.reasoningEffort } } : {}),
        },
        { timeout: this.requestTimeoutMs, maxRetries: 0, signal: options.signal },
      );
      const latencyMs = Date.now() - startedAt;
      const actualModel = typeof result.model === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(result.model) ? result.model : undefined;
      const reasoning = result.usage?.output_tokens_details?.reasoning_tokens;
      const usage =
        result.usage && Number.isInteger(result.usage.input_tokens) && Number.isInteger(result.usage.output_tokens)
          ? {
              inputTokens: result.usage.input_tokens,
              outputTokens: result.usage.output_tokens,
              ...(Number.isInteger(result.usage.input_tokens_details?.cached_tokens) ? { cachedInputTokens: result.usage.input_tokens_details.cached_tokens } : {}),
              ...cacheWriteUsage(result.usage.input_tokens_details),
              ...(Number.isInteger(reasoning) && reasoning! > 0 ? { reasoningTokens: reasoning! } : {}),
            }
          : undefined;
      const call = result.output.find((item) => item.type === "function_call");
      if (!call || call.type !== "function_call") {
        const refused = result.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"));
        throw unusableResponse(
          this.providerInfo,
          latencyMs,
          actualModel,
          usage,
          result.status === "incomplete" && result.incomplete_details?.reason === "max_output_tokens" ? "OUTPUT_LIMIT" : refused || result.incomplete_details?.reason === "content_filter" ? "REFUSAL" : "NO_TOOL_CALL",
        );
      }
      const providerRequestId = typeof result.id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(result.id) ? result.id : undefined;
      return {
        id: call.call_id,
        name: call.name,
        arguments: call.arguments,
        provider: this.providerInfo.provider,
        requestedModel: this.providerInfo.requestedModel,
        actualModel,
        latencyMs,
        ...(usage ? { usage } : {}),
        ...(providerRequestId ? { providerRequestId } : {}),
      };
    } catch (error) {
      throw normalizeAIProviderError(this.providerInfo.provider, this.providerInfo.requestedModel, error, Date.now() - startedAt);
    }
  }
}

type GeminiJson = Record<string, unknown>;
const isJsonObject = (value: unknown): value is GeminiJson =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "additionalProperties")
      .map(([key, child]) => [key, geminiSchema(child)]),
  );
}

class GeminiGenerateContentGateway implements ConversationModelGateway {
  constructor(
    readonly providerInfo: { provider: AIProvider; requestedModel: string },
    private readonly apiKey: string,
    private readonly maxOutputTokens: number,
    private readonly requestTimeoutMs: number,
  ) {}

  async proposeToolCall(messages: ModelMessage[], tools: ModelToolDefinition[], options: ModelCallOptions = {}): Promise<ProposedToolCall> {
    const startedAt = Date.now();
    if (options.reasoningEffort)
      throw unsupportedOption("GEMINI", this.providerInfo.requestedModel);
    const systemInstruction = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      const role = message.role === "assistant" ? "model" : "user";
      const prior = contents.at(-1);
      if (prior?.role === role) prior.parts.push({ text: message.content });
      else contents.push({ role, parts: [{ text: message.content }] });
    }
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(this.requestTimeoutMs)])
      : AbortSignal.timeout(this.requestTimeoutMs);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.providerInfo.requestedModel)}:generateContent`,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({
            ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
            contents,
            tools: [{ functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: geminiSchema(tool.parameters),
            })) }],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            generationConfig: { maxOutputTokens: this.maxOutputTokens },
          }),
        },
      );
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        const code: AIProviderErrorCode = response.status === 429
          ? "QUOTA_LIMITED"
          : [400, 401, 403, 404, 413, 422].includes(response.status)
            ? "NOT_CONFIGURED"
            : "UNAVAILABLE";
        throw new AIProviderError("GEMINI", code, this.providerInfo.requestedModel, latencyMs, response.status);
      }
      let payload: GeminiJson;
      try {
        const parsed: unknown = await response.json();
        if (!isJsonObject(parsed)) throw new Error("invalid response");
        payload = parsed;
      } catch {
        throw new AIProviderError("GEMINI", "INVALID_RESPONSE", this.providerInfo.requestedModel, latencyMs);
      }
      const metadata = isJsonObject(payload.usageMetadata) ? payload.usageMetadata : undefined;
      const inputTokens = metadata?.promptTokenCount;
      const visibleOutputTokens = metadata?.candidatesTokenCount;
      const thoughtsTokens = metadata?.thoughtsTokenCount;
      const usage = Number.isInteger(inputTokens) && Number.isInteger(visibleOutputTokens)
        ? {
            inputTokens: inputTokens as number,
            outputTokens: (visibleOutputTokens as number) + (Number.isInteger(thoughtsTokens) ? thoughtsTokens as number : 0),
            ...(Number.isInteger(metadata?.cachedContentTokenCount) ? { cachedInputTokens: metadata!.cachedContentTokenCount as number } : {}),
            ...(Number.isInteger(thoughtsTokens) && (thoughtsTokens as number) > 0 ? { reasoningTokens: thoughtsTokens as number } : {}),
          }
        : undefined;
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      const candidate = isJsonObject(candidates[0]) ? candidates[0] : undefined;
      const candidateContent = candidate && isJsonObject(candidate.content) ? candidate.content : undefined;
      const parts = candidateContent && Array.isArray(candidateContent.parts) ? candidateContent.parts : [];
      const calls = parts.filter((part) => isJsonObject(part) && isJsonObject(part.functionCall));
      const finishReason = candidate?.finishReason;
      const promptFeedback = isJsonObject(payload.promptFeedback) ? payload.promptFeedback : undefined;
      const blocked = typeof promptFeedback?.blockReason === "string";
      if (calls.length !== 1 || !isJsonObject(calls[0]!.functionCall)) {
        const detail: AIResponseDetail = finishReason === "MAX_TOKENS"
          ? "OUTPUT_LIMIT"
          : blocked || ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(String(finishReason))
            ? "REFUSAL"
            : "NO_TOOL_CALL";
        throw unusableResponse(this.providerInfo, latencyMs, undefined, usage, detail);
      }
      const functionCall = calls[0]!.functionCall;
      const name = functionCall.name;
      const args = functionCall.args;
      if (typeof name !== "string" || !isJsonObject(args))
        throw unusableResponse(this.providerInfo, latencyMs, undefined, usage, "NO_TOOL_CALL");
      const actualModel = typeof payload.modelVersion === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(payload.modelVersion)
        ? payload.modelVersion
        : undefined;
      const providerRequestId = typeof payload.responseId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(payload.responseId)
        ? payload.responseId
        : undefined;
      return {
        id: providerRequestId ?? `gemini-${Date.now()}`,
        name,
        arguments: JSON.stringify(args),
        provider: "GEMINI",
        requestedModel: this.providerInfo.requestedModel,
        actualModel,
        latencyMs,
        ...(usage ? { usage } : {}),
        ...(providerRequestId ? { providerRequestId } : {}),
      };
    } catch (error) {
      throw normalizeAIProviderError("GEMINI", this.providerInfo.requestedModel, error, Date.now() - startedAt);
    }
  }
}

function chatGateway(configuration: AIProviderConfiguration, env: NodeJS.ProcessEnv, fallback?: ConversationModelGateway) {
  // The Replit proxy and an OPENAI_COMPATIBLE endpoint have no public default: without a URL
  // (and a model) they are not configured.
  if (!providerConfigured(configuration, env))
    throw new AIProviderError(
      configuration.provider,
      "NOT_CONFIGURED",
      configuration.requestedModel,
    );
  const client = new OpenAI({
    apiKey: env[configuration.credentialName]!,
    ...(configuration.baseURL ? { baseURL: configuration.baseURL } : {}),
  });
  const providerInfo = { provider: configuration.provider, requestedModel: configuration.requestedModel };
  // The SDK deadline follows DINAR_MODEL_TIMEOUT_MS (default 25 s, as before), so a longer
  // configured turn is not cut short by a fixed client timeout.
  const { maxOutputTokens, timeoutMs } = resolveAIModelRuntimeConfiguration(env);
  if (env.DINAR_GEMMA_FREE_ONLY === "true" && env.DINAR_AI_FALLBACK_PROVIDER?.trim())
    throw new Error("DINAR_GEMMA_FREE_ONLY does not permit any provider fallback.");
  const policy = {
    ...(configuration.toolChoice ? { toolChoice: configuration.toolChoice } : {}),
    ...(configuration.reasoningEffort ? { reasoningEffort: configuration.reasoningEffort } : {}),
  };
  if (configuration.transport === "RESPONSES")
    return new OpenAIResponsesGateway(client, providerInfo, fallback, maxOutputTokens, policy, timeoutMs);
  return new OpenAICompatibleChatGateway(client, providerInfo, fallback, maxOutputTokens, policy, timeoutMs, configuration.gemmaFreeOnly === true, configuration.thinking);
}

export async function createConversationModelGateway(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConversationModelGateway> {
  if (env.DINAR_GEMINI_FREE_ONLY === "true" && (env.NODE_ENV !== "development" || env.REPLIT_DEPLOYMENT !== undefined || env.RAILWAY_ENVIRONMENT !== undefined))
    throw new Error("DINAR_GEMINI_FREE_ONLY is restricted to an isolated development benchmark.");
  if (env.DINAR_GEMMA_FREE_ONLY === "true" && (env.NODE_ENV === "production" || env.REPLIT_DEPLOYMENT !== undefined || env.RAILWAY_ENVIRONMENT !== undefined))
    throw new Error("DINAR_GEMMA_FREE_ONLY is restricted to an isolated development benchmark.");
  if (env.BDINAR_BLOCK_MODEL_CALLS === "1")
    return new BlockedTestModelGateway();
  const runtime = resolveAIModelRuntimeConfiguration(env);
  if (runtime.primary.provider === "GEMINI") {
    if (!runtime.primary.credentialName || !env[runtime.primary.credentialName])
      throw new AIProviderError("GEMINI", "NOT_CONFIGURED", runtime.primary.requestedModel);
    if (runtime.fallback || env.DINAR_AI_FALLBACK_PROVIDER?.trim() || runtime.maxRetries !== 0)
      throw new Error("The Gemini free-only benchmark requires no fallback and zero retries.");
    const { maxOutputTokens, timeoutMs } = runtime;
    return new GeminiGenerateContentGateway(
      { provider: "GEMINI", requestedModel: runtime.primary.requestedModel },
      env[runtime.primary.credentialName]!,
      maxOutputTokens,
      timeoutMs,
    );
  }
  let fallback: ConversationModelGateway | undefined;
  if (runtime.fallback) {
    try {
      fallback = chatGateway(runtime.fallback, env);
    } catch {
      // An unconfigured fallback is simply absent; the primary decides on its own.
    }
  }
  const primary = chatGateway(runtime.primary, env, fallback);
  if (!runtime.heavy) return primary;
  let heavy: ConversationModelGateway;
  try {
    // The heavy tier shares the primary's fallback: a heavy outage still has an answer path.
    heavy = chatGateway(runtime.heavy, env, fallback);
  } catch {
    return primary; // An unconfigured heavy model is simply absent: HEAVY becomes high effort.
  }
  return {
    providerInfo: primary.providerInfo,
    ...(primary.fallback ? { fallback: primary.fallback } : {}),
    heavy,
    perCallReasoningEffort: (primary as ConversationModelGateway).perCallReasoningEffort === true,
    proposeToolCall: (messages, tools, options) => primary.proposeToolCall(messages, tools, options),
  };
}

const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

export const VOICE_TRANSCRIPTION_MODEL = { provider: "GROQ" as const, model: GROQ_TRANSCRIPTION_MODEL };

/**
 * Audio is transcribed with Groq only; this never changes the selected text provider. The
 * provider-reported duration (billing unit) is returned when present; absent, cost stays unpriced.
 */
export async function transcribeVoiceRecording(
  audio: Buffer,
  mimeType: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ text: string; durationSeconds?: number }> {
  const configuration = resolveAIProviderConfiguration(env);
  if (configuration.provider !== "GROQ")
    throw new AIProviderError(
      configuration.provider,
      "NOT_CONFIGURED",
      GROQ_TRANSCRIPTION_MODEL,
    );
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey)
    throw new AIProviderError("GROQ", "NOT_CONFIGURED", GROQ_TRANSCRIPTION_MODEL);

  const extension =
    mimeType === "audio/mp4" ? "mp4" :
    mimeType === "audio/ogg" ? "ogg" :
    mimeType === "audio/wav" ? "wav" : "webm";
  const client = new OpenAI({ apiKey, baseURL: GROQ_API_BASE_URL });
  const startedAt = Date.now();
  try {
    const result = await client.audio.transcriptions.create({
      file: await toFile(audio, `recording.${extension}`, { type: mimeType }),
      model: GROQ_TRANSCRIPTION_MODEL,
      language: "ar",
      response_format: "verbose_json",
      temperature: 0,
    });
    const duration = (result as { duration?: unknown }).duration;
    return {
      text: result.text.trim(),
      ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? { durationSeconds: Math.ceil(duration) } : {}),
    };
  } catch (error) {
    throw normalizeAIProviderError(
      "GROQ",
      GROQ_TRANSCRIPTION_MODEL,
      error,
      Date.now() - startedAt,
    );
  }
}
