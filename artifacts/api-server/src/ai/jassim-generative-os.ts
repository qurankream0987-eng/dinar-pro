/**
 * Jassim Universal Generative OS — Single-Conversation Orchestrator Blueprint.
 * Unifies Multi-Brain Routing (OpenRouter Sticky Routing + Groq/Gemini/DeepSeek/Claude),
 * 3-Tier Context Compression, Read-Only ReAct Loops, and Universal Generative Surfaces so
 * EVERYTHING happens seamlessly inside ONE conversation.
 */

export type GenerativeSurfaceKind = "INFINITE_PRODUCT_CARD" | "LIVE_DELIVERY_TRACKER" | "CONNECT_URL_ONBOARDING" | "IN_CHAT_PAYMENT" | "WORKFLOW_RECOVERY" | "COMPARISON_MATRIX";
export type BrainTier = "FAST_HUMAN" | "COMMERCE_CORE" | "VISION" | "REASONING";

export interface GenerativeOrchestrationPlan {
  conversationId: string;
  brainTier: BrainTier;
  openRouterStickySessionKey: string;
  usePromptCache: boolean;
  useReadOnlyLoop: boolean;
  surfaces: GenerativeSurfaceKind[];
  requireExplicitUserConfirmationForWrites: true;
  inChatPaymentEligible: boolean;
}

export function planUniversalConversationTurn(input: {
  conversationId: string;
  intent: "GENERAL_CHAT" | "SHOP_CONFIGURE" | "TRACK_DELIVERY" | "CONNECT_STORE_URL" | "COMPARE_COMPLEX" | "IMAGE_SEARCH" | "WORKFLOW_FAILURE";
  marketOperationMode: "FULL" | "PRE_LEGAL" | "CLOSED";
  hasImageAttachment?: boolean;
}): GenerativeOrchestrationPlan {
  const surfaces: GenerativeSurfaceKind[] = [];
  let brainTier: BrainTier = "FAST_HUMAN";
  let useReadOnlyLoop = false;

  if (input.hasImageAttachment || input.intent === "IMAGE_SEARCH") {
    brainTier = "VISION"; surfaces.push("INFINITE_PRODUCT_CARD");
  } else if (input.intent === "SHOP_CONFIGURE") {
    brainTier = "COMMERCE_CORE"; useReadOnlyLoop = true; surfaces.push("INFINITE_PRODUCT_CARD", "IN_CHAT_PAYMENT");
  } else if (input.intent === "TRACK_DELIVERY") {
    brainTier = "FAST_HUMAN"; surfaces.push("LIVE_DELIVERY_TRACKER");
  } else if (input.intent === "CONNECT_STORE_URL") {
    brainTier = "COMMERCE_CORE"; surfaces.push("CONNECT_URL_ONBOARDING");
  } else if (input.intent === "COMPARE_COMPLEX") {
    brainTier = "REASONING"; useReadOnlyLoop = true; surfaces.push("COMPARISON_MATRIX");
  } else if (input.intent === "WORKFLOW_FAILURE") {
    brainTier = "COMMERCE_CORE"; surfaces.push("WORKFLOW_RECOVERY");
  }

  return { conversationId: input.conversationId, brainTier, openRouterStickySessionKey: `jassim:conv:${input.conversationId}`, usePromptCache: true, useReadOnlyLoop, surfaces, requireExplicitUserConfirmationForWrites: true, inChatPaymentEligible: input.marketOperationMode === "FULL" };
}
