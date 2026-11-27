/**
 * AI-07 — Provider-Aware Prompt Caching Layout Optimizer.
 * Separates the immutable static system prefix (brand rules, safety policies, tool schemas)
 * from dynamic per-turn state (market, L2 digest, L1 hot turns, user message) so providers
 * (OpenAI, DeepSeek, Gemini, Anthropic, Groq) achieve maximum prefix cache hit rates.
 */
import { createHash } from "node:crypto";

export interface PromptCacheSections {
  staticSystemPrefix: string;
  dynamicContextBlock: string;
  userMessage: string;
}

export interface BuiltCachedPrompt {
  prefixHash: string;
  staticChars: number;
  dynamicChars: number;
  messages: Array<
    | { role: "system"; content: string; cache_control?: { type: "ephemeral" } }
    | { role: "user"; content: string }
  >;
}

export function hashStaticPrefix(staticSystemPrefix: string): string {
  return createHash("sha256").update(staticSystemPrefix, "utf8").digest("hex").slice(0, 16);
}

export function buildCacheOptimizedPrompt(
  sections: PromptCacheSections,
  provider: "OPENAI" | "DEEPSEEK" | "GROQ" | "GEMINI" | "ANTHROPIC" | "OPENROUTER" | "OPENAI_COMPATIBLE",
): BuiltCachedPrompt {
  const staticTrimmed = sections.staticSystemPrefix.trim();
  const dynamicTrimmed = sections.dynamicContextBlock.trim();
  const prefixHash = hashStaticPrefix(staticTrimmed);

  const systemMessage: { role: "system"; content: string; cache_control?: { type: "ephemeral" } } = {
    role: "system",
    content: staticTrimmed,
    ...(provider === "ANTHROPIC" || provider === "OPENROUTER" ? { cache_control: { type: "ephemeral" } } : {}),
  };

  const userPayload = dynamicTrimmed
    ? `<jassim_turn_context>\n${dynamicTrimmed}\n</jassim_turn_context>\n\n${sections.userMessage.trim()}`
    : sections.userMessage.trim();

  return {
    prefixHash,
    staticChars: staticTrimmed.length,
    dynamicChars: userPayload.length,
    messages: [systemMessage, { role: "user", content: userPayload }],
  };
}
