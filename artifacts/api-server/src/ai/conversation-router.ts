import {
  CONVERSATION_ACTION_REGISTRY,
  CONVERSATION_CAPABILITY_REGISTRY,
  resolveConversationActionId,
  type ConversationActionId,
  type ConversationRouteDecision,
} from "@workspace/api-zod/conversation-runtime";

export type ConversationRouteInput = {
  message: string;
  actorId?: string;
  marketId?: string;
  marketActive?: boolean;
  /** A known existing intent adapter may provide its classification without reparsing. */
  actionId?: ConversationActionId;
  liveDriverLocationConfigured?: boolean;
};

export function resolveConversationRoute(
  input: ConversationRouteInput,
): ConversationRouteDecision {
  const actionId =
    input.actionId ??
    resolveConversationActionId(input.message) ??
    "GENERAL_CHAT";
  const action = CONVERSATION_ACTION_REGISTRY[actionId];
  const capability = CONVERSATION_CAPABILITY_REGISTRY[action.capabilityId];
  const authenticated = Boolean(input.actorId);
  const marketState = !input.marketId
    ? "NOT_SELECTED"
    : input.marketActive === false
      ? "INACTIVE"
      : "ACTIVE";
  const providerState = "providerRequirement" in action && action.providerRequirement
    ? input.liveDriverLocationConfigured
      ? "CONFIGURED"
      : "NOT_CONFIGURED"
    : undefined;

  let kind: ConversationRouteDecision["kind"] = action.routeKind;
  let reason: ConversationRouteDecision["reason"];
  if (action.marketRequired && marketState === "NOT_SELECTED") {
    kind = "MARKET_REQUIRED";
    reason = "MARKET_REQUIRED";
  } else if (action.authorization === "AUTHENTICATED" && !authenticated) {
    kind = "AUTH_REQUIRED";
    reason = "AUTH_REQUIRED";
  } else if (providerState === "NOT_CONFIGURED") {
    kind = "PROVIDER_REQUIRED";
    reason = "PROVIDER_NOT_CONFIGURED";
  }

  return {
    kind,
    actionId,
    capabilityId: action.capabilityId,
    capabilityAvailability: capability.availability,
    marketState,
    authenticationState: authenticated ? "AUTHENTICATED" : "GUEST",
    ...(providerState ? { providerState } : {}),
    ...(reason ? { reason } : {}),
  };
}
