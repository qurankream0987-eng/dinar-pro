import { CONVERSATION_CAPABILITY_REGISTRY } from "@workspace/api-zod/conversation-runtime";

export type ConversationMarket = {
  id: string;
  countryCode: string;
  currencyCode: string;
};

const MARKET_DEFAULT_DIALECT: Record<string, string> = {
  JO: "colloquial Jordanian Arabic",
  SA: "colloquial Saudi Arabic",
  KW: "colloquial Kuwaiti Arabic",
};

/**
 * Server-authored context shared by authenticated and guest model turns. Sent whole: model-turn
 * holds it to MAX_SERVER_CONTEXT, so facts the model must not get wrong (what is connected,
 * who may change what) come first and each capability is one compact
 * «availability authorization [MARKET]» string.
 */
export function conversationGuidance(
  market: ConversationMarket,
  marketAvailable: boolean,
  authenticated = false,
) {
  const countryCode = market.countryCode.toUpperCase();
  return {
    market: {
      id: market.id,
      countryCode,
      currencyCode: market.currencyCode,
      availability: marketAvailable ? "ACTIVE" : "INACTIVE",
      selected: true,
    },
    authentication: {
      state: authenticated ? "AUTHENTICATED" : "GUEST",
    },
    providers: {
      liveDriverLocation: "NOT_CONFIGURED",
      externalDelivery: "NOT_CONFIGURED",
      payments: "SIMULATION_ONLY",
      sellerPhotoVision: "DEVELOPMENT_ONLY",
      publicationImageReview: "DEVELOPMENT_ONLY_SCHEMA_PENDING",
      other: "Any courier, bank, card, wallet or third-party service not listed is NOT_CONNECTED; say so and never claim it ran.",
    },
    authority: {
      model: "SUGGESTIONS_ONLY",
      mutations: "CANONICAL_SERVER_SERVICES_ONLY",
      highImpact: "EXPLICIT_USER_CONFIRMATION_REQUIRED",
      ui: "MODEL_MUST_NOT_GENERATE_UI_OR_SURFACES",
    },
    capabilities: {
      generalConversation: "AVAILABLE",
      ...Object.fromEntries(
        Object.entries(CONVERSATION_CAPABILITY_REGISTRY).map(([id, definition]) => [
          id,
          `${definition.availability} ${definition.authorization}${definition.marketRequired ? " MARKET" : ""}`,
        ]),
      ),
    },
    locale: {
      language: "Mirror the user's current language.",
      marketDefault:
        MARKET_DEFAULT_DIALECT[countryCode] ??
        "Mirror the user's language; use Modern Standard Arabic only as a fallback.",
      identityBoundary:
        "Market locale is a response-style default only. It is not evidence of the user's nationality, identity, or preferred dialect.",
      priority: [
        "current explicit instruction",
        "recent conversation",
        "explicit stored conversation-style preference",
        "market default",
        "Modern Standard Arabic fallback",
      ],
    },
  };
}
