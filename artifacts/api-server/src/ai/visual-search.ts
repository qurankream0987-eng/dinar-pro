import { z } from "zod";
type ListingText = { title: string; description: string; attributes?: Record<string, string | number> };
import {
  AIProviderError,
  resolveAIModelRuntimeConfiguration,
  type AIProviderConfiguration,
} from "./model-gateway";
import { normalizeMarketplaceText } from "./arabic-normalization";

/**
 * Visual product search. The model only DESCRIBES the photo (strict schema, no ids, no prices,
 * no claims about availability). Results always come from the canonical marketplace search,
 * and the EXACT / PROBABLE / SIMILAR label is computed here, deterministically, from the
 * description and the persisted listing — never taken from model text.
 */
export const VisualAnalysis = z
  .object({
    isProduct: z.boolean(),
    category: z.string().trim().max(60).optional(),
    brand: z.string().trim().max(60).optional(),
    model: z.string().trim().max(80).optional(),
    color: z.string().trim().max(40).optional(),
    keywords: z.array(z.string().trim().min(1).max(40)).max(6),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type VisualAnalysis = z.infer<typeof VisualAnalysis>;

export type VisualMatch = "EXACT" | "PROBABLE" | "SIMILAR";
export type VisualAnalyzerResult =
  | { status: "ANALYZED"; analysis: VisualAnalysis }
  | { status: "BLOCKED_PROVIDER"; reason: "NO_IMAGE_MODEL" | "MODEL_CALLS_BLOCKED" }
  | { status: "FAILED"; reason: string };

export interface VisualAnalyzer {
  analyze(image: { contentType: string; bytes: Buffer }, text?: string): Promise<VisualAnalyzerResult>;
}

const SYSTEM = [
  "You describe ONE product photo for a marketplace search. Reply only by calling describeProduct.",
  "Never invent prices, sellers, stock or listing ids. Use Arabic for category, color and keywords; keep brand/model as printed.",
  "If the photo does not show a product (a person, a document, a screenshot of text), set isProduct=false.",
].join(" ");

const TOOL = {
  type: "function" as const,
  function: {
    name: "describeProduct",
    description: "Structured description of the product in the photo.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["isProduct", "keywords", "confidence"],
      properties: {
        isProduct: { type: "boolean" },
        category: { type: "string" },
        brand: { type: "string" },
        model: { type: "string" },
        color: { type: "string" },
        keywords: { type: "array", items: { type: "string" }, maxItems: 6 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
  },
};

/**
 * Provider-neutral: any OPENAI_COMPATIBLE slot (OpenRouter-pinned Gemma 4, DeepInfra, vLLM) that
 * the operator marked image-capable with DINAR_AI_IMAGE_INPUT=true. Anything else is
 * BLOCKED_PROVIDER — the caller then answers honestly and asks the buyer to describe the item.
 */
export function createVisualAnalyzer(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): VisualAnalyzer {
  return {
    async analyze(image, text) {
      if (env.BDINAR_BLOCK_MODEL_CALLS === "1") return { status: "BLOCKED_PROVIDER", reason: "MODEL_CALLS_BLOCKED" };
      let runtime;
      try {
        runtime = resolveAIModelRuntimeConfiguration(env);
      } catch {
        return { status: "BLOCKED_PROVIDER", reason: "NO_IMAGE_MODEL" };
      }
      const slot: AIProviderConfiguration = runtime.primary;
      if (!runtime.capabilities.imageInput || slot.provider !== "OPENAI_COMPATIBLE" || !slot.baseURL || !env[slot.credentialName])
        return { status: "BLOCKED_PROVIDER", reason: "NO_IMAGE_MODEL" };
      const body: Record<string, unknown> = {
        model: slot.requestedModel,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              ...(text ? [{ type: "text", text: text.slice(0, 500) }] : []),
              { type: "image_url", image_url: { url: `data:${image.contentType};base64,${image.bytes.toString("base64")}` } },
            ],
          },
        ],
        tools: [TOOL],
        tool_choice: "required",
        max_tokens: 400,
      };
      if (slot.openRouterRouting)
        body.provider = {
          order: slot.openRouterRouting.order,
          allow_fallbacks: false,
          require_parameters: slot.openRouterRouting.requireParameters,
          ...(slot.openRouterRouting.dataCollection ? { data_collection: slot.openRouterRouting.dataCollection } : {}),
          ...(slot.openRouterRouting.zdr ? { zdr: true } : {}),
        };
      if (slot.thinking === "disabled") body[slot.openRouterRouting ? "reasoning" : "chat_template_kwargs"] = slot.openRouterRouting ? { enabled: false } : { enable_thinking: false };
      try {
        const response = await fetchImpl(`${slot.baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env[slot.credentialName]}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(runtime.timeoutMs),
        });
        if (!response.ok) return { status: "FAILED", reason: `HTTP_${response.status}` };
        const json = (await response.json()) as any;
        if (slot.openRouterRouting && json?.model !== slot.requestedModel) return { status: "FAILED", reason: "MODEL_SUBSTITUTED" };
        const call = json?.choices?.[0]?.message?.tool_calls?.[0];
        if (call?.function?.name !== "describeProduct") return { status: "FAILED", reason: "NO_TOOL_CALL" };
        const parsed = VisualAnalysis.safeParse(JSON.parse(call.function.arguments));
        return parsed.success ? { status: "ANALYZED", analysis: parsed.data } : { status: "FAILED", reason: "INVALID_SCHEMA" };
      } catch (error) {
        return { status: "FAILED", reason: error instanceof AIProviderError ? error.code : "TRANSPORT" };
      }
    },
  };
}

/** Search words from the analysis plus the buyer's own words; the buyer's words come first. */
export function visualSearchTerms(analysis: VisualAnalysis, text?: string): string {
  const parts = [text, analysis.brand, analysis.model, analysis.category, ...analysis.keywords]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);
  return [...new Set(parts)].join(" ").slice(0, 200);
}

const tokens = (value: string) => new Set(normalizeMarketplaceText(value).split(/\s+/u).filter((word) => word.length > 1));

/** Deterministic: brand+model both found in the listing → EXACT; brand or model or strong overlap → PROBABLE. */
export function classifyVisualMatch(analysis: VisualAnalysis, listing: ListingText): VisualMatch {
  const haystack = normalizeMarketplaceText(
    [listing.title, listing.description, ...Object.values(listing.attributes ?? {}).map(String)].join(" "),
  );
  const contains = (value?: string) => {
    if (!value) return false;
    const words = [...tokens(value)];
    return words.length > 0 && words.every((word) => haystack.includes(word));
  };
  const brand = contains(analysis.brand);
  const model = contains(analysis.model);
  if (brand && model && analysis.confidence >= 0.6) return "EXACT";
  const keywordHits = analysis.keywords.filter((keyword) => contains(keyword)).length;
  if (brand || model || (analysis.keywords.length > 0 && keywordHits / analysis.keywords.length >= 0.5)) return "PROBABLE";
  return "SIMILAR";
}

const ORDER: Record<VisualMatch, number> = { EXACT: 0, PROBABLE: 1, SIMILAR: 2 };
export function rankVisualMatches<T extends ListingText>(analysis: VisualAnalysis, listings: readonly T[]) {
  return listings
    .map((listing, index) => ({ listing, match: classifyVisualMatch(analysis, listing), index }))
    .sort((a, b) => ORDER[a.match] - ORDER[b.match] || a.index - b.index)
    .map(({ listing, match }) => ({ listing, match }));
}
