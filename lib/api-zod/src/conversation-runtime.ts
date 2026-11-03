import { z } from "zod";
import { CreateAiLearningHistoryEventBody } from "./generated/api";

/**
 * Shared, non-executable contracts for the DINAR conversation runtime.
 * Server handlers remain the only authority for permissions and mutations.
 */
export const CONVERSATION_SURFACE_FAMILIES = {
  commercial: [
    "COMMERCIAL_BALANCE",
    "COMMERCIAL_LEDGER_SUMMARY",
    "COMMERCIAL_TOPUP_REVIEW",
    "COMMERCIAL_PRODUCTS",
    "COMMERCIAL_PRODUCT_REVIEW",
    "FEATURED_REVIEW",
    "VIP_REVIEW",
    "REFRESH_REVIEW",
    "BUNDLE_REVIEW",
    "BUNDLE_STATUS",
    "PROMOTION_TYPE_OPTIONS",
    "DEMAND_CAPTURE_REVIEW",
    "CAMPAIGN_STATUS",
    "CAMPAIGN_ANALYTICS",
    "MARKET_PULSE",
    "MARKET_OPPORTUNITY",
    "BUSINESS_PLAN_REVIEW",
    "BUSINESS_STATUS",
    "BUSINESS_PROFILE",
    "COMMERCE_NOTICE",
    "AI_USAGE",
    "AI_PLANS",
  ],
  memory: [
    "MY_INTERESTS",
    "MEMORY_SUMMARY",
    "MEMORY_CONFIRMATION",
    "MEMORY_UPDATED",
    "MEMORY_REMOVED",
  ],
  provider: [
    "PROVIDER_CONNECTION_REVIEW",
    "PROVIDER_SECRET_ONCE",
    "PROVIDER_STATUS",
  ],
  driver: [
    "DRIVER_ONBOARDING",
    "DRIVER_ONBOARDING_REVIEW",
    "DRIVER_STATUS",
    "DRIVER_AVAILABILITY",
    "DELIVERY_WORK_RESULTS",
    "DRIVER_ASSIGNMENT_REVIEW",
    "DRIVER_ASSIGNMENT_STATUS",
    "DRIVER_EARNINGS_HISTORY",
  ],
  employment: [
    "JOB_DRAFT",
    "JOB_REVIEW",
    "JOB_SEARCH_RESULTS",
    "JOB_DETAILS",
    "MY_JOBS",
    "CV_PROFILE",
    "CANDIDATE_SEARCH_RESULTS",
    "CANDIDATE_DETAILS",
    "APPLICATION_REVIEW",
    "MY_APPLICATIONS",
    "APPLICATION_LIST",
    "EMPLOYMENT_ACTION",
    "EMPLOYMENT_NOTICE",
  ],
  delivery: [
    "LOCATION_PERMISSION_REQUEST",
    "LOCATION_PREVIEW",
    "LOCATION_CONFIRMED",
    "MANUAL_ADDRESS",
    "DELIVERY_OPTIONS",
    "DELIVERY_SUMMARY",
    "DELIVERY_ACTION",
    "DELIVERY_STATUS",
    "PICKUP_DETAILS",
    "DELIVERY_NOTICE",
  ],
  promotion: [
    "PROMOTION_OPTIONS",
    "PROMOTION_REVIEW",
    "PROMOTION_STATUS",
    "MY_PROMOTIONS",
    "PROMOTION_DETAILS",
  ],
  smart: ["ADVICE"],
  negotiation: [
    "NEGOTIATION_REVIEW",
    "NEGOTIATION_STATUS",
    "NEGOTIATION_LIST",
  ],
  vision: ["SELL"],
  inquiry: [
    "INQUIRY_DRAFT",
    "INQUIRY_STATUS",
    "INQUIRY_INCOMING",
    "INQUIRY_LIST",
    "INQUIRY_NOTICE",
  ],
  /** Universal product control: app preferences, browsing market and account settings. */
  control: [
    "APP_THEME",
    "MARKET_SWITCH_REVIEW",
    "MARKET_SWITCH_STATUS",
    "PROFILE_REVIEW",
    "PROFILE_STATUS",
    "CONTROL_NOTICE",
    "PRIVACY_EXPORT",
  ],
  /** D3-A: the owner's business inside DINAR (setup, catalog, orders, insights). */
  business: [
    "BUSINESS_SETUP",
    "BUSINESS_PROFILE_REVIEW",
    "BUSINESS_PROFILE",
    "BUSINESS_CATALOG",
    "BUSINESS_CATALOG_DRAFT",
    "BUSINESS_LISTING_REVIEW",
    "BUSINESS_ORDERS",
    "BUSINESS_INSIGHTS",
  ],
} as const;

export const TUTORIAL_IDS = [
  "SELL_FIRST_LISTING",
  "PHOTO_FIRST_SELLING",
  "PROMOTION_OVERVIEW",
  "FEATURED_EXPLAINER",
  "VIP_EXPLAINER",
  "DEMAND_CAPTURE_EXPLAINER",
] as const;

export const TutorialPayloadSchema = z.object({
  id: z.enum(TUTORIAL_IDS),
  title: z.string().min(1).max(120),
  caption: z.string().min(1).max(300),
  steps: z.array(
    z.object({
      title: z.string().min(1).max(100),
      description: z.string().min(1).max(240),
    }).strict(),
  ).length(5),
  animation: z.literal("LOCAL_STEP_SEQUENCE"),
}).strict();

export type TutorialPayload = z.infer<typeof TutorialPayloadSchema>;

export const TutorialLearningEventTypes = [
  "TUTORIAL_OPENED",
  "PLAYBACK_STARTED",
  "PLAYBACK_PROGRESS_MILESTONE",
  "TEXT_FALLBACK_VIEWED",
  "CONTINUATION_TRIGGERED",
] as const;

export const TutorialLearningEventInputSchema = CreateAiLearningHistoryEventBody
  .strict()
  .superRefine((value, context) => {
  if (
    value.eventType === "PLAYBACK_PROGRESS_MILESTONE" &&
    value.milestonePercent === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["milestonePercent"],
      message: "Milestone percent is required.",
    });
  }
  if (
    value.eventType !== "PLAYBACK_PROGRESS_MILESTONE" &&
    value.milestonePercent !== undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["milestonePercent"],
      message: "Milestone percent is only valid for progress events.",
    });
  }
  });

export const TutorialLearningEventSchema = z.object({
  id: z.string().uuid(),
  tutorialId: z.enum(TUTORIAL_IDS),
  eventType: z.enum(TutorialLearningEventTypes),
  milestonePercent: z.number().int().nullable(),
  currentTimeSeconds: z.number().int().nullable(),
  createdAt: z.string().datetime(),
}).strict();
export const TutorialLearningEventsResponseSchema = z.array(
  TutorialLearningEventSchema,
).max(100);
export type TutorialLearningEventInput = z.infer<
  typeof TutorialLearningEventInputSchema
>;
export type TutorialLearningEvent = z.infer<typeof TutorialLearningEventSchema>;

const CORE_SURFACE_TOKENS = [
  "CART",
  "CHECKOUT",
  "AUTH",
  "SETTINGS",
  "POLICIES",
  "LOGOUT",
  "ORDERS",
  "ORDER",
  "ORDERS_LIST",
  "ORDER_SELECTOR",
  "ORDER_STATUS",
  "ORDER_TRACKING",
  "MARKET_SELECTOR",
  "SELL",
  "MY_LISTINGS",
  "DUES",
  "MARKET",
  "ACCOUNT",
  "CLARIFY",
  "UNSUPPORTED",
  "COMPARISON",
  "PURCHASE_REVIEW",
  "PAYMENT_REVIEW",
  "SELLER_INVENTORY",
  "TUTORIAL_VIDEO_CARD",
] as const;

export const CONVERSATION_SURFACE_TOKENS = [
  ...CORE_SURFACE_TOKENS,
  ...CONVERSATION_SURFACE_FAMILIES.commercial,
  ...CONVERSATION_SURFACE_FAMILIES.memory,
  ...CONVERSATION_SURFACE_FAMILIES.provider,
  ...CONVERSATION_SURFACE_FAMILIES.driver,
  ...CONVERSATION_SURFACE_FAMILIES.employment,
  ...CONVERSATION_SURFACE_FAMILIES.delivery,
  ...CONVERSATION_SURFACE_FAMILIES.promotion,
  ...CONVERSATION_SURFACE_FAMILIES.smart,
  ...CONVERSATION_SURFACE_FAMILIES.negotiation,
  ...CONVERSATION_SURFACE_FAMILIES.inquiry,
  ...CONVERSATION_SURFACE_FAMILIES.control,
  ...CONVERSATION_SURFACE_FAMILIES.business,
] as const;

export type ConversationSurfaceToken =
  (typeof CONVERSATION_SURFACE_TOKENS)[number];

/** Narrow subset the model may request directly; domain features remain server-routed. */
export const MODEL_OPEN_SURFACE_TOKENS = [
  "CART",
  "CHECKOUT",
  "AUTH",
  "SETTINGS",
  "POLICIES",
  "ORDERS",
  "SELL",
  "MY_LISTINGS",
  "DUES",
  "MARKET",
  "ACCOUNT",
  "LOGOUT",
] as const satisfies readonly ConversationSurfaceToken[];

export const modelOpenSurfaceSchema = z.enum(MODEL_OPEN_SURFACE_TOKENS);

export const conversationSurfaceTokenSchema = z.enum(
  CONVERSATION_SURFACE_TOKENS,
).refine((token) => conversationSemanticSurfacesForToken(token).length > 0);

const resultSurface = {
  blockType: "LISTING_RESULTS",
  serverOwned: true,
} as const;
const surface = (
  tokens: readonly ConversationSurfaceToken[],
  renderer: string,
) => ({ blockType: "SURFACE", tokens, renderer, serverOwned: true as const });

/** Semantic views reconciled with the wire tokens rendered by existing components. */
export const CONVERSATION_SURFACE_REGISTRY = {
  PRODUCT_RESULT_CARD: resultSurface,
  SERVICE_RESULT_CARD: resultSurface,
  SEARCH_RESULTS_RAIL: resultSurface,
  SERVICE_RESULTS_RAIL: resultSurface,
  LISTING_DETAIL_CARD: resultSurface,
  LISTING_DRAFT_CARD: surface(["SELL"], "seller-draft"),
  PUBLISHED_LISTING_CARD: surface(["SELL"], "published-listing"),
  MY_LISTINGS_RAIL: surface(["MY_LISTINGS"], "seller-listings"),
  SELLER_INVENTORY_CARD: surface(["SELLER_INVENTORY"], "seller-listings"),
  COMPARISON_SURFACE: surface(["COMPARISON"], "comparison"),
  CART_SURFACE: surface(["CART"], "cart"),
  CHECKOUT_CONFIRMATION: surface(["CHECKOUT", "PURCHASE_REVIEW"], "checkout"),
  ORDER_STATUS_CARD: surface(
    ["ORDERS", "ORDER", "ORDERS_LIST", "ORDER_SELECTOR", "ORDER_STATUS"],
    "orders",
  ),
  TRACKING_CARD: surface(["ORDER_TRACKING"], "tracking"),
  DELIVERY_CARD: surface(
    CONVERSATION_SURFACE_FAMILIES.delivery,
    "delivery",
  ),
  PROMOTION_CARD: surface(
    [
      ...CONVERSATION_SURFACE_FAMILIES.promotion,
      // The DINAR Business identity card is its own semantic card, never a promotion card.
      ...CONVERSATION_SURFACE_FAMILIES.commercial.filter((token) => token !== "BUSINESS_PROFILE"),
    ],
    "promotion-and-commerce",
  ),
  MARKET_PULSE_CARD: surface(["MARKET_PULSE", "MARKET_OPPORTUNITY"], "market-pulse"),
  DINAR_BUSINESS_CARD: surface(
    ["BUSINESS_PLAN_REVIEW", "BUSINESS_STATUS", "BUSINESS_PROFILE"],
    "dinar-business",
  ),
  AI_USAGE_CARD: surface(["AI_USAGE"], "ai-usage"),
  AI_PLANS_CARD: surface(["AI_PLANS"], "ai-plans"),
  AUTH_CARD: surface(["AUTH"], "auth"),
  MARKET_SELECTOR_CARD: surface(["MARKET_SELECTOR", "MARKET"], "market-selector"),
  CONFIRMATION_CARD: surface(
    [
      "PURCHASE_REVIEW",
      "PAYMENT_REVIEW",
      "PROMOTION_REVIEW",
      "FEATURED_REVIEW",
      "VIP_REVIEW",
      "REFRESH_REVIEW",
      "BUNDLE_REVIEW",
      "DEMAND_CAPTURE_REVIEW",
      "BUSINESS_PLAN_REVIEW",
    ],
    "confirmation",
  ),
  EMPTY_RESULT_CARD: resultSurface,
  ERROR_CARD: surface(["CLARIFY", "UNSUPPORTED"], "notice"),
  PERSONAL_INTELLIGENCE: surface(
    CONVERSATION_SURFACE_FAMILIES.memory,
    "personal-intelligence",
  ),
  VISION_SELLER_SURFACE: surface(["SELL"], "seller-photo-assistance"),
  EMPLOYMENT_SURFACE: surface(
    CONVERSATION_SURFACE_FAMILIES.employment,
    "employment",
  ),
  DRIVER_SURFACE: surface(
    CONVERSATION_SURFACE_FAMILIES.driver,
    "driver",
  ),
  PROVIDER_SURFACE: surface(
    CONVERSATION_SURFACE_FAMILIES.provider,
    "provider",
  ),
  NEGOTIATION_SURFACE: surface(
    CONVERSATION_SURFACE_FAMILIES.negotiation,
    "negotiation",
  ),
  INQUIRY_SURFACE: surface(
    CONVERSATION_SURFACE_FAMILIES.inquiry,
    "marketplace-inquiry",
  ),
  CONVERSATION_TEXT: {
    blockType: "MESSAGE",
    serverOwned: true,
  },
  WORKFLOW_SURFACE: surface(
    [
      "SETTINGS",
      "POLICIES",
      "LOGOUT",
      "DUES",
      "ACCOUNT",
      "ORDER_TRACKING",
      "ORDERS",
    ],
    "existing-workflow",
  ),
  ASSISTANT_ADVICE_CARD: surface(
    CONVERSATION_SURFACE_FAMILIES.smart,
    "assistant-advice",
  ),
  TUTORIAL_VIDEO_CARD: surface(["TUTORIAL_VIDEO_CARD"], "local-tutorial"),
  PRODUCT_CONTROL_SURFACE: surface(
    CONVERSATION_SURFACE_FAMILIES.control,
    "product-control",
  ),
  BUSINESS_SETUP: surface(["BUSINESS_SETUP"], "business"),
  BUSINESS_PROFILE_REVIEW: surface(["BUSINESS_PROFILE_REVIEW"], "business"),
  BUSINESS_PROFILE: surface(["BUSINESS_PROFILE"], "business"),
  BUSINESS_CATALOG: surface(["BUSINESS_CATALOG"], "business"),
  BUSINESS_CATALOG_DRAFT: surface(["BUSINESS_CATALOG_DRAFT"], "business"),
  BUSINESS_LISTING_REVIEW: surface(["BUSINESS_LISTING_REVIEW"], "business"),
  BUSINESS_ORDERS: surface(["BUSINESS_ORDERS"], "business"),
  BUSINESS_INSIGHTS: surface(["BUSINESS_INSIGHTS"], "business"),
} as const;

export type ConversationSemanticSurface =
  keyof typeof CONVERSATION_SURFACE_REGISTRY;

export function isConversationSurfaceToken(
  value: unknown,
): value is ConversationSurfaceToken {
  return (
    typeof value === "string" &&
    (CONVERSATION_SURFACE_TOKENS as readonly string[]).includes(value)
  );
}

export function conversationSemanticSurfacesForToken(
  token: ConversationSurfaceToken,
): ConversationSemanticSurface[] {
  return (Object.entries(CONVERSATION_SURFACE_REGISTRY) as [
    ConversationSemanticSurface,
    (typeof CONVERSATION_SURFACE_REGISTRY)[ConversationSemanticSurface],
  ][])
    .filter(([, definition]) =>
      "tokens" in definition ? definition.tokens.includes(token) : false,
    )
    .map(([id]) => id);
}

export function isRegisteredConversationSurface(
  value: unknown,
): value is ConversationSurfaceToken {
  return (
    isConversationSurfaceToken(value) &&
    conversationSemanticSurfacesForToken(value).length > 0
  );
}

export const CONVERSATION_CAPABILITY_REGISTRY = {
  GENERAL_CHAT: {
    availability: "AVAILABLE",
    marketRequired: false,
    authorization: "PUBLIC",
  },
  SEARCH: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "PUBLIC",
  },
  SELL_PRODUCT: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  SELL_SERVICE: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  BUY: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  ORDERS: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  TRACKING: {
    availability: "AVAILABLE_PROVIDER_DEPENDENT",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  DELIVERY: {
    availability: "AVAILABLE_INTERNAL",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  LIVE_DRIVER_LOCATION: {
    availability: "PROVIDER_NOT_CONFIGURED",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  PROMOTIONS: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  PAYMENTS: {
    availability: "SIMULATION_ONLY",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  MARKET_PULSE: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  DINAR_BUSINESS: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  PERSONAL_INTELLIGENCE: {
    availability: "AVAILABLE",
    marketRequired: false,
    authorization: "AUTHENTICATED",
  },
  VISION_SELLER_ASSISTANCE: {
    availability: "DEVELOPMENT_ONLY",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  AI_PROVIDER: {
    availability: "AVAILABLE_INTERNAL",
    marketRequired: false,
    authorization: "AUTHENTICATED",
  },
  PUBLICATION_IMAGE_REVIEW: {
    availability: "DEVELOPMENT_ONLY_SCHEMA_PENDING",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  /** NEXT G1: the user's own AI usage, allowances and plan comparison (no billing authority). */
  AI_USAGE: {
    availability: "AVAILABLE",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  /** NEXT G2: buyer–seller messages through DINAR; in-app delivery only (no notification transport). */
  MARKETPLACE_INQUIRY: {
    availability: "AVAILABLE_INTERNAL",
    marketRequired: true,
    authorization: "AUTHENTICATED",
  },
  /** Client-local preferences (theme); applied and acknowledged by the client only. */
  APP_PREFERENCES: {
    availability: "AVAILABLE",
    marketRequired: false,
    authorization: "PUBLIC",
  },
  /** The account's active browsing market (never seller eligibility or legal country). */
  MARKET_SELECTION: {
    availability: "AVAILABLE",
    marketRequired: false,
    authorization: "AUTHENTICATED",
  },
  /** Profile fields the existing account authority already lets the owner edit. */
  ACCOUNT_SETTINGS: {
    availability: "AVAILABLE",
    marketRequired: false,
    authorization: "AUTHENTICATED",
  },
} as const;

export type ConversationCapabilityId =
  keyof typeof CONVERSATION_CAPABILITY_REGISTRY;
export type ConversationCapabilityAvailability =
  (typeof CONVERSATION_CAPABILITY_REGISTRY)[ConversationCapabilityId]["availability"];

export type ConversationRouteKind =
  | "CHAT"
  | "READ_ACTION"
  | "STATE_CHANGING_ACTION"
  | "CLIENT_ACTION"
  | "AUTH_REQUIRED"
  | "MARKET_REQUIRED"
  | "PROVIDER_REQUIRED"
  | "CLARIFICATION"
  | "UNAVAILABLE";

type ConversationActionDefinition = {
  actionId: string;
  /** CLIENT_ACTION: a device-local change the client applies and acknowledges; no server mutation. */
  routeKind: "READ_ACTION" | "STATE_CHANGING_ACTION" | "CLIENT_ACTION" | "CHAT";
  capabilityId: ConversationCapabilityId;
  authorization: "PUBLIC" | "AUTHENTICATED";
  marketRequired: boolean;
  confirmationRequired: boolean;
  canonicalService: string;
  allowedSurfaceResponse: ConversationSemanticSurface;
  buttonMessage?: string;
  providerRequirement?: "LIVE_DRIVER_LOCATION";
};

export const CONVERSATION_ACTION_REGISTRY = {
  GENERAL_CHAT: {
    actionId: "GENERAL_CHAT",
    routeKind: "CHAT",
    capabilityId: "GENERAL_CHAT",
    authorization: "PUBLIC",
    marketRequired: false,
    confirmationRequired: false,
    canonicalService: "executeModelFallback",
    allowedSurfaceResponse: "CONVERSATION_TEXT",
  },
  VIEW_TUTORIAL: {
    actionId: "VIEW_TUTORIAL",
    routeKind: "READ_ACTION",
    capabilityId: "GENERAL_CHAT",
    authorization: "PUBLIC",
    marketRequired: false,
    confirmationRequired: false,
    canonicalService: "executeCommerceTurn:tutorial-registry",
    allowedSurfaceResponse: "TUTORIAL_VIDEO_CARD",
  },
  SEARCH_LISTINGS: {
    actionId: "SEARCH_LISTINGS",
    routeKind: "READ_ACTION",
    capabilityId: "SEARCH",
    authorization: "PUBLIC",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "searchListings",
    allowedSurfaceResponse: "SEARCH_RESULTS_RAIL",
  },
  OPEN_LISTING: {
    actionId: "OPEN_LISTING",
    routeKind: "READ_ACTION",
    capabilityId: "SEARCH",
    authorization: "PUBLIC",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "getResource",
    allowedSurfaceResponse: "LISTING_DETAIL_CARD",
  },
  COMPARE_LISTINGS: {
    actionId: "COMPARE_LISTINGS",
    routeKind: "READ_ACTION",
    capabilityId: "SEARCH",
    authorization: "PUBLIC",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "executeBuyerTurn",
    allowedSurfaceResponse: "COMPARISON_SURFACE",
  },
  CREATE_PRODUCT_DRAFT: {
    actionId: "CREATE_PRODUCT_DRAFT",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "listingDraft",
    allowedSurfaceResponse: "LISTING_DRAFT_CARD",
  },
  CREATE_SERVICE_DRAFT: {
    actionId: "CREATE_SERVICE_DRAFT",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_SERVICE",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "listingDraft",
    allowedSurfaceResponse: "LISTING_DRAFT_CARD",
  },
  PUBLISH_LISTING: {
    actionId: "PUBLISH_LISTING",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:PUBLISH_LISTING",
    allowedSurfaceResponse: "CONFIRMATION_CARD",
    buttonMessage: "انشره",
  },
  BUY_LISTING: {
    actionId: "BUY_LISTING",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "executePurchaseTurn",
    allowedSurfaceResponse: "CHECKOUT_CONFIRMATION",
    buttonMessage: "اشتريه رقم {position}",
  },
  ADD_TO_CART: {
    actionId: "ADD_TO_CART",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:ADD_TO_CART",
    allowedSurfaceResponse: "CART_SURFACE",
    buttonMessage: "أضف رقم {position} للسلة",
  },
  REMOVE_FROM_CART: {
    actionId: "REMOVE_FROM_CART",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "replaceMarketplaceCart",
    allowedSurfaceResponse: "CART_SURFACE",
  },
  CONTINUE_CHECKOUT: {
    actionId: "CONTINUE_CHECKOUT",
    routeKind: "READ_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "executePurchaseTurn",
    allowedSurfaceResponse: "CHECKOUT_CONFIRMATION",
    buttonMessage: "كمل",
  },
  UPDATE_LISTING_PRICE: {
    actionId: "UPDATE_LISTING_PRICE",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "updateOwnedListing",
    allowedSurfaceResponse: "CONFIRMATION_CARD",
  },
  PAUSE_LISTING: {
    actionId: "PAUSE_LISTING",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "applyListingPreviewAction",
    allowedSurfaceResponse: "CONFIRMATION_CARD",
    buttonMessage: "وقف الإعلان رقم {position}",
  },
  RESUME_LISTING: {
    actionId: "RESUME_LISTING",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "applyListingPreviewAction",
    allowedSurfaceResponse: "CONFIRMATION_CARD",
    buttonMessage: "استأنف الإعلان رقم {position}",
  },
  ARCHIVE_LISTING: {
    actionId: "ARCHIVE_LISTING",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "applyListingPreviewAction",
    allowedSurfaceResponse: "CONFIRMATION_CARD",
    buttonMessage: "أرشف الإعلان رقم {position}",
  },
  PROMOTE_LISTING: {
    actionId: "PROMOTE_LISTING",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "PROMOTIONS",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "executePromotionTurn",
    allowedSurfaceResponse: "PROMOTION_CARD",
    buttonMessage: "روّج الإعلان رقم {position}",
  },
  SHOW_MY_LISTINGS: {
    actionId: "SHOW_MY_LISTINGS",
    routeKind: "READ_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "executeSellerListingManagementTurn",
    allowedSurfaceResponse: "MY_LISTINGS_RAIL",
  },
  SHOW_ORDERS: {
    actionId: "SHOW_ORDERS",
    routeKind: "READ_ACTION",
    capabilityId: "ORDERS",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "orderContext",
    allowedSurfaceResponse: "ORDER_STATUS_CARD",
  },
  TRACK_ORDER: {
    actionId: "TRACK_ORDER",
    routeKind: "READ_ACTION",
    capabilityId: "TRACKING",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "orderContext",
    allowedSurfaceResponse: "TRACKING_CARD",
  },
  LIVE_DRIVER_LOCATION: {
    actionId: "LIVE_DRIVER_LOCATION",
    routeKind: "READ_ACTION",
    capabilityId: "LIVE_DRIVER_LOCATION",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "provider-capability-check",
    allowedSurfaceResponse: "TRACKING_CARD",
    providerRequirement: "LIVE_DRIVER_LOCATION",
  },
  REQUEST_DELIVERY: {
    actionId: "REQUEST_DELIVERY",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "DELIVERY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: false,
    canonicalService: "executeDeliveryTurn",
    allowedSurfaceResponse: "DELIVERY_CARD",
  },
  PERSONAL_INTELLIGENCE: {
    actionId: "PERSONAL_INTELLIGENCE",
    routeKind: "READ_ACTION",
    capabilityId: "PERSONAL_INTELLIGENCE",
    authorization: "AUTHENTICATED",
    marketRequired: false,
    confirmationRequired: false,
    canonicalService: "executePersonalMemoryTurn",
    allowedSurfaceResponse: "PERSONAL_INTELLIGENCE",
  },
  REMEMBER_PREFERENCE: {
    actionId: "REMEMBER_PREFERENCE",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "PERSONAL_INTELLIGENCE",
    authorization: "AUTHENTICATED",
    marketRequired: false,
    confirmationRequired: true,
    canonicalService: "executePersonalMemoryTurn",
    allowedSurfaceResponse: "PERSONAL_INTELLIGENCE",
  },
  FORGET_MEMORY: {
    actionId: "FORGET_MEMORY",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "PERSONAL_INTELLIGENCE",
    authorization: "AUTHENTICATED",
    marketRequired: false,
    confirmationRequired: true,
    canonicalService: "executePersonalMemoryTurn",
    allowedSurfaceResponse: "PERSONAL_INTELLIGENCE",
  },
  PLACE_ORDER: {
    actionId: "PLACE_ORDER",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:PLACE_ORDER",
    allowedSurfaceResponse: "CHECKOUT_CONFIRMATION",
  },
  SUBMIT_DRIVER_PROFILE: {
    actionId: "SUBMIT_DRIVER_PROFILE",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "DELIVERY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:SUBMIT_DRIVER_PROFILE",
    allowedSurfaceResponse: "DRIVER_SURFACE",
  },
  ACCEPT_DELIVERY: {
    actionId: "ACCEPT_DELIVERY",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "DELIVERY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:ACCEPT_DELIVERY",
    allowedSurfaceResponse: "DRIVER_SURFACE",
  },
  CREATE_PAYMENT_INTENT: {
    actionId: "CREATE_PAYMENT_INTENT",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "PAYMENTS",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:CREATE_PAYMENT_INTENT",
    allowedSurfaceResponse: "CONFIRMATION_CARD",
  },
  SEND_INQUIRY_MESSAGE: {
    actionId: "SEND_INQUIRY_MESSAGE",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "MARKETPLACE_INQUIRY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:SEND_INQUIRY_MESSAGE",
    allowedSurfaceResponse: "INQUIRY_SURFACE",
  },
  SEND_NEGOTIATION_OFFER: {
    actionId: "SEND_NEGOTIATION_OFFER",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:SEND_NEGOTIATION_OFFER",
    allowedSurfaceResponse: "NEGOTIATION_SURFACE",
  },
  REQUEST_BEST_PRICE: {
    actionId: "REQUEST_BEST_PRICE",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:REQUEST_BEST_PRICE",
    allowedSurfaceResponse: "NEGOTIATION_SURFACE",
    buttonMessage: "اطلب تسعيرة للإعلان رقم {position}",
  },
  COUNTER_NEGOTIATION: {
    actionId: "COUNTER_NEGOTIATION",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:COUNTER_NEGOTIATION",
    allowedSurfaceResponse: "NEGOTIATION_SURFACE",
  },
  ACCEPT_NEGOTIATION: {
    actionId: "ACCEPT_NEGOTIATION",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:ACCEPT_NEGOTIATION",
    allowedSurfaceResponse: "NEGOTIATION_SURFACE",
  },
  REJECT_NEGOTIATION: {
    actionId: "REJECT_NEGOTIATION",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "SELL_PRODUCT",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:REJECT_NEGOTIATION",
    allowedSurfaceResponse: "NEGOTIATION_SURFACE",
  },
  WITHDRAW_NEGOTIATION: {
    actionId: "WITHDRAW_NEGOTIATION",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "BUY",
    authorization: "AUTHENTICATED",
    marketRequired: true,
    confirmationRequired: true,
    canonicalService: "action-foundation:WITHDRAW_NEGOTIATION",
    allowedSurfaceResponse: "NEGOTIATION_SURFACE",
  },
  CREATE_PROVIDER_CONNECTION: {
    actionId: "CREATE_PROVIDER_CONNECTION",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "AI_PROVIDER",
    authorization: "AUTHENTICATED",
    marketRequired: false,
    confirmationRequired: true,
    canonicalService: "action-foundation:CREATE_PROVIDER_CONNECTION",
    allowedSurfaceResponse: "PROVIDER_SURFACE",
  },
  ROTATE_PROVIDER_CREDENTIAL: {
    actionId: "ROTATE_PROVIDER_CREDENTIAL",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "AI_PROVIDER",
    authorization: "AUTHENTICATED",
    marketRequired: false,
    confirmationRequired: true,
    canonicalService: "action-foundation:ROTATE_PROVIDER_CREDENTIAL",
    allowedSurfaceResponse: "PROVIDER_SURFACE",
  },
  REVOKE_PROVIDER_CONNECTION: {
    actionId: "REVOKE_PROVIDER_CONNECTION",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "AI_PROVIDER",
    authorization: "AUTHENTICATED",
    marketRequired: false,
    confirmationRequired: true,
    canonicalService: "action-foundation:REVOKE_PROVIDER_CONNECTION",
    allowedSurfaceResponse: "PROVIDER_SURFACE",
  },
  SET_THEME: {
    actionId: "SET_THEME",
    routeKind: "CLIENT_ACTION",
    capabilityId: "APP_PREFERENCES",
    authorization: "PUBLIC",
    marketRequired: false,
    confirmationRequired: false,
    canonicalService: "client:lib/theme.setThemePreference",
    allowedSurfaceResponse: "PRODUCT_CONTROL_SURFACE",
  },
  SWITCH_MARKET: {
    actionId: "SWITCH_MARKET",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "MARKET_SELECTION",
    authorization: "AUTHENTICATED",
    marketRequired: false,
    confirmationRequired: true,
    canonicalService: "action-foundation:SWITCH_MARKET",
    allowedSurfaceResponse: "PRODUCT_CONTROL_SURFACE",
  },
  UPDATE_DISPLAY_NAME: {
    actionId: "UPDATE_DISPLAY_NAME",
    routeKind: "STATE_CHANGING_ACTION",
    capabilityId: "ACCOUNT_SETTINGS",
    authorization: "AUTHENTICATED",
    marketRequired: false,
    confirmationRequired: true,
    canonicalService: "action-foundation:UPDATE_DISPLAY_NAME",
    allowedSurfaceResponse: "PRODUCT_CONTROL_SURFACE",
  },
} as const satisfies Record<string, ConversationActionDefinition>;

export type ConversationActionId = keyof typeof CONVERSATION_ACTION_REGISTRY;

export type ConversationRouteDecision = {
  kind: ConversationRouteKind;
  actionId: ConversationActionId;
  capabilityId: ConversationCapabilityId;
  capabilityAvailability: ConversationCapabilityAvailability;
  marketState: "ACTIVE" | "INACTIVE" | "NOT_SELECTED";
  authenticationState: "AUTHENTICATED" | "GUEST";
  providerState?: "CONFIGURED" | "NOT_CONFIGURED";
  reason?: "AUTH_REQUIRED" | "MARKET_REQUIRED" | "MARKET_INACTIVE" | "PROVIDER_NOT_CONFIGURED";
};

function normalizeActionText(message: string): string {
  return message
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[؟?!،,؛;:()«»"'.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const HOW_TO = /(?:^|\s)(?:كيف|شلون|طريقه|اشرح|اشرحلي|ما\s+فهمت|مو\s+فاهم|مش\s+فاهم)(?:\s|$)/u;
/** Words that only name DINAR's own selling and promotion features. */
const DINAR_FEATURE = /ترويج|روج|اعلان|مميز|featured|vip|روح\s+بيع/u;
const SELL_VERB = /(?:^|\s)(?:ابيع|نبيع|تبيع|بيع)(?:\s|$)/u;
const PHOTO_WORD = /(?:^|\s)(?:(?:ال)?(?:صور|صوره|صوري|تصوير)|اصور|نصور|تصور)(?:\s|$)/u;
/** A sale, or the user's own goods («منتجي», «بضاعتي»); «منتجات احترافية» alone is photography. */
const SELLING_CONTEXT = /(?:^|\s)(?:ابيع|نبيع|تبيع|بيع|البيع|للبيع|منتجي|منتجاتي|بضاعتي|اغراضي|اعلاني|مسوده|المسوده)(?:\s|$)/u;
const DINAR_ANCHOR = /دينار|dinar|(?:^|\s)(?:هنا|هون|هني|التطبيق|المنصه|عندكم|فيكم|بالسوق)(?:\s|$)/u;

/**
 * «كيف أروّج إعلاني؟», «كيف أبيع؟», «كيف أصوّر منتجي للبيع؟»: a how-to question about DINAR's
 * own selling flow, answered by its local tutorial. A generic verb alone is not enough:
 * «كيف أبيع فكرتي للمستثمرين؟» or «كيف تعمل الصور الرقمية؟» are general questions for the model.
 * Selling counts only with no object, or anchored to DINAR; photos only in a selling context.
 */
export function isDinarTutorialQuestion(message: string): boolean {
  const text = normalizeActionText(message);
  if (!HOW_TO.test(text)) return false;
  if (DINAR_FEATURE.test(text)) return true;
  const sell = SELL_VERB.test(text);
  const photo = PHOTO_WORD.test(text);
  if (!sell && !photo) return false;
  if (DINAR_ANCHOR.test(text)) return true;
  if (photo) return SELLING_CONTEXT.test(text);
  return /(?:^|\s)(?:ابيع|نبيع|تبيع|بيع)$/u.test(text);
}

/** A listing or a shown result is the object: «رجّع الإعلان», «استأنف الإعلان رقم 2», «رجعه». */
const LISTING_OBJECT = String.raw`(?:(?:ال)?(?:اعلان|عرض|منتج)|الاول|الاولي|الثاني|الثانيه|الثالث|الثالثه|رقم\s+\d+)`;
/** «قارن الأول والثاني», «قارنهم», «قارن العروض»: results in view, not any two named things. */
const COMPARED_RESULTS = String.raw`(?:(?:ال)?(?:اول|اولي|ثاني|ثانيه|ثالث|ثالثه|رابع|خامس)|الاثنين|الثلاثه|(?:ال)?(?:عروض|اعلانات|نتائج|خيارات)|رقم\s+\d+)`;

const ACTION_MATCHERS: readonly [RegExp, ConversationActionId][] = [
  [/^(?:وين|اين|مكان|موقع)\s+(?:المندوب|السائق)|(?:موقع|خريطة)\s+(?:المندوب|السائق)/u, "LIVE_DRIVER_LOCATION"],
  [new RegExp(`^(?:قارنهم|قارنهما|قارنها|(?:قارن|قارنلي)\\s+(?:بين\\s+)?${COMPARED_RESULTS})|^(?:ايهم|ايهما)\\s+افضل(?:\\s|$)`, "u"), "COMPARE_LISTINGS"],
  [/^(?:الاول|الاولى|الثاني|الثانيه|الثالث|الثالثه|رقم\s+\d+|العرض\s+\d+|الاعلان\s+\d+)/u, "OPEN_LISTING"],
  [/^(?:انشر|انشره|انشرها|نشر|publish)(?:\s|$)/u, "PUBLISH_LISTING"],
  [/^(?:روج|روّج|روج الإعلان|روج الاعلان|روّج الإعلان|روّج الاعلان)(?:\s|$)/u, "PROMOTE_LISTING"],
  [/^(?:وقفه|اوقفه|علقها|وقف|اوقف|علق)\s+(?:(?:ال)?اعلان)?/u, "PAUSE_LISTING"],
  [new RegExp(`^(?:رجعه|ارجعه|رجعها|ارجعها)$|^(?:رجع|ارجع|استانف|فعل)\\s+${LISTING_OBJECT}|^استانف$`, "u"), "RESUME_LISTING"],
  [/^(?:ارشف|أرشف|ارشفة)\s+(?:(?:ال)?اعلان)?/u, "ARCHIVE_LISTING"],
  [/^(?:غير|عدل|حدث)\s+(?:سعر|السعر)|^(?:خل|خلي)\s+.*(?:السعر|سعره)/u, "UPDATE_LISTING_PRICE"],
  [/(?:اضف|اضيف|اضافة|ضيف|حط|ضع|ادخل).*(?:سلة|سله|عربة)|^(?:اضف|اضيف|ضيف|حط)\s+(?:(?:ال)?(?:اول|ثاني|ثالث|رابع|خامس|\d{1,2}))(?:\s*(?:و|،)\s*(?:(?:ال)?(?:اول|ثاني|ثالث|رابع|خامس|\d{1,2})))*$/u, "ADD_TO_CART"],
  [/^(?:شيل|احذف|ازل|ازيل)\s+(?:(?:العنصر|المنتج)\s+)?(?:ال)?(?:اول|ثاني|ثالث|رابع|خامس|اخر|اخير)(?:\s|$)/u, "REMOVE_FROM_CART"],
  [/^(?:كمل|اكمل|كمل\s+(?:ال)?(?:شراء|الدفع)|اكمل\s+(?:ال)?(?:شراء|الدفع))$/u, "CONTINUE_CHECKOUT"],
  [/^(?:ابي|اريد|بدي|ابغى)\s+(?:(?:ال)?(?:اول|اولى|ثاني|ثانيه|ثالث|ثالثه|رابع|رابعه|خامس|خامسه|سادس|سادسه|سابع|سابعه|ثامن|ثامنه|تاسع|تاسعه|عاشر|عاشره)|رقم\s+\d{1,2}|\d{1,2})$/u, "BUY_LISTING"],
  [/^(?:ابيه|ابيها|اشتريه|اشتريها|اشتري|شراء|ابي\s+اشتري(?:ه|ها)?|ابغى\s+اشتري(?:ه|ها)?|اريد\s+شراء)/u, "BUY_LISTING"],
  [/^(?:اعرض|ورني|ارني|اظهر)\s+(?:اعلاناتي|عروضي|قوائمي)|(?:اعلاناتي|عروضي)\s*$/u, "SHOW_MY_LISTINGS"],
  [/^(?:وين|اين)\s+طلبي|^تتبع\s+.*طلب/u, "TRACK_ORDER"],
  [/^(?:اعرض|ورني|ارني)\s+طلباتي|^طلباتي\s*$/u, "SHOW_ORDERS"],
  [/^(?:ابي|ابغى|اريد)\s+مندوب|^مندوب\s+(?:للطلب|للتوصيل)/u, "REQUEST_DELIVERY"],
  [/^ماذا\s+تعرف\s+عن\s+اهتماماتي/u, "PERSONAL_INTELLIGENCE"],
  [/^(?:تذكر|احفظ|سجل|remember|save|خل\s+ببالك|خلي\s+ببالك)\s/u, "REMEMBER_PREFERENCE"],
  [/^(?:انس|انسى|forget)\s/u, "FORGET_MEMORY"],
  [/^(?:انا\s+)?(?:مصور|مصوره|مقدم|مقدمه)\s+.*(?:اعرض|انشر|ابيع)|^(?:انا\s+)?(?:عندي|لدي)\s+.*(?:خدمتي|خدماتي)\s+(?:للبيع|اعرض|انشر)|^(?:ابي|ابغى|اريد)\s+(?:اعرض|انشر|اقدم)\s+(?:خدمتي|الخدمه|خدمات)/u, "CREATE_SERVICE_DRAFT"],
  [/^(?:انا\s+)?(?:عندي|لدي|املك)\s+.*(?:ابي\s+ابيعه|ابيعه|ابيع|للبيع)/u, "CREATE_PRODUCT_DRAFT"],
  [/^(?:اطلب|اطلب لي)\s+تسعيره(?:\s|$)/u, "REQUEST_BEST_PRICE"],
  [/^(?:ابحث|دور|دورلي|دور\s+لي|ابغى\s+ادور|اريد\s+ابحث|احتاج)\s/u, "SEARCH_LISTINGS"],
];

export function resolveConversationActionId(
  message: string,
): ConversationActionId | undefined {
  if (isDinarTutorialQuestion(message)) return "VIEW_TUTORIAL";
  const text = normalizeActionText(message);
  return ACTION_MATCHERS.find(([pattern]) => pattern.test(text))?.[1];
}

export function conversationActionMessage(
  actionId: ConversationActionId,
  values: { position?: number } = {},
): string {
  const definition = CONVERSATION_ACTION_REGISTRY[actionId];
  const template = "buttonMessage" in definition
    ? definition.buttonMessage
    : undefined;
  if (!template)
    throw new Error(`Action ${actionId} has no conversational button message.`);
  return template.replaceAll(
    "{position}",
    String(Math.max(1, Math.trunc(values.position ?? 1))),
  );
}

/**
 * DINAR NEXT C/D: the seller's own business facts (stock, order counts, per-listing results),
 * aggregated by the server from the seller's rows in the active market. The server parses
 * every payload with this schema before emitting it; the client renders only what parses.
 */
const BusinessInsightBase = { kind: z.literal("BUSINESS_SUMMARY"), source: z.literal("DINAR_ONLY") };
const CountMetric = z.number().int().min(0).max(1_000_000);
export const SellerBusinessInsight = z.discriminatedUnion("topic", [
  z.object({
    ...BusinessInsightBase,
    topic: z.literal("INVENTORY"),
    metrics: z.array(z.object({ listingId: z.string().min(1).max(200), label: z.string().max(250), value: z.string().min(1).max(120), status: z.string().min(1).max(40) }).strict()).max(24),
  }).strict(),
  z.object({
    ...BusinessInsightBase,
    topic: z.literal("ORDERS"),
    metrics: z.array(z.object({ key: z.enum(["all", "active", "completed", "closed"]), label: z.string().min(1).max(60), value: CountMetric }).strict()).length(4),
  }).strict(),
  z.object({
    ...BusinessInsightBase,
    topic: z.literal("PERFORMANCE"),
    metrics: z.array(z.object({
      listingId: z.string().min(1).max(200),
      label: z.string().max(250),
      orders: CountMetric,
      priceOffers: CountMetric,
      campaignImpressions: CountMetric.optional(),
      campaignEngagements: CountMetric.optional(),
    }).strict()).min(1).max(10),
  }).strict(),
]);
export type SellerBusinessInsight = z.infer<typeof SellerBusinessInsight>;

/**
 * DINAR NEXT (conversation-first C): the seller's own sales for an explicit period, from the
 * order and payment records. Orders, completed sales, gross value, (simulated) paid amounts,
 * refunds and recognised net sales are separate figures; unpaid orders are never money received.
 */
const SalesPeriod = z.object({
  key: z.enum(["TODAY", "LAST_7_DAYS", "THIS_MONTH", "LAST_MONTH", "LAST_30_DAYS", "ALL_TIME"]),
  label: z.string().min(1).max(80),
  start: z.string().max(40).nullable(),
  end: z.string().max(40),
  timeZone: z.string().min(1).max(40),
}).strict();
const SalesMetric = z.object({
  key: z.enum(["orders", "completed", "cancelled", "gross", "paid", "refunded", "recognized"]),
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(60),
  raw: z.number().int().min(0).max(1_000_000_000_000),
}).strict();
export const SellerSalesInsight = z.object({
  ...BusinessInsightBase,
  topic: z.literal("SALES"),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  period: SalesPeriod,
  metrics: z.array(SalesMetric).length(7),
  previous: z.object({ period: SalesPeriod, metrics: z.array(SalesMetric).length(7) }).strict().optional(),
  topProducts: z.array(z.object({ listingId: z.string().min(1).max(200), label: z.string().max(250), units: CountMetric, orders: CountMetric }).strict()).max(5),
  notes: z.array(z.string().min(1).max(240)).max(4),
}).strict();
export type SellerSalesInsight = z.infer<typeof SellerSalesInsight>;

// ─── Universal conversational product control ────────────────────────────────

/**
 * How much room a surface needs. Cards size to their content within the conversation column:
 * a status or a small review stays COMPACT, statistics and orders MEDIUM, and only result
 * rails and side-by-side comparisons may use the full column (WIDE).
 */
export const CONVERSATION_SURFACE_SIZES = ["COMPACT", "MEDIUM", "WIDE"] as const;
export type ConversationSurfaceSize = (typeof CONVERSATION_SURFACE_SIZES)[number];

const COMPACT_SURFACES: readonly ConversationSurfaceToken[] = [
  ...CONVERSATION_SURFACE_FAMILIES.control,
  ...CONVERSATION_SURFACE_FAMILIES.inquiry,
  "AI_USAGE",
  "COMMERCE_NOTICE",
  "COMMERCIAL_BALANCE",
  "BUSINESS_STATUS",
  "BUSINESS_PLAN_REVIEW",
  "COMMERCIAL_TOPUP_REVIEW",
  "FEATURED_REVIEW",
  "VIP_REVIEW",
  "REFRESH_REVIEW",
  "BUNDLE_REVIEW",
  "LOCATION_PERMISSION_REQUEST",
  "LOCATION_PREVIEW",
  "LOCATION_CONFIRMED",
  "MANUAL_ADDRESS",
  "DELIVERY_NOTICE",
  "DELIVERY_ACTION",
  "PICKUP_DETAILS",
  "MEMORY_CONFIRMATION",
  "MEMORY_UPDATED",
  "MEMORY_REMOVED",
  "NEGOTIATION_REVIEW",
  "NEGOTIATION_STATUS",
  "PAYMENT_REVIEW",
  "PURCHASE_REVIEW",
  "CLARIFY",
  "UNSUPPORTED",
  "AUTH",
  "LOGOUT",
  "MARKET_SELECTOR",
  "DRIVER_AVAILABILITY",
  "DRIVER_ASSIGNMENT_STATUS",
  "PROVIDER_STATUS",
  "PROVIDER_SECRET_ONCE",
  "PROVIDER_CONNECTION_REVIEW",
  "EMPLOYMENT_NOTICE",
  "EMPLOYMENT_ACTION",
];
const WIDE_SURFACES: readonly ConversationSurfaceToken[] = [
  "COMPARISON",
  "COMMERCIAL_PRODUCTS",
  "JOB_SEARCH_RESULTS",
  "CANDIDATE_SEARCH_RESULTS",
  "DELIVERY_WORK_RESULTS",
  "MY_LISTINGS",
  "MARKET_PULSE",
  "CAMPAIGN_ANALYTICS",
];

export function conversationSurfaceSize(token: string): ConversationSurfaceSize {
  if ((COMPACT_SURFACES as readonly string[]).includes(token)) return "COMPACT";
  if ((WIDE_SURFACES as readonly string[]).includes(token)) return "WIDE";
  return "MEDIUM";
}

export const THEME_PREFERENCES = ["LIGHT", "DARK", "SYSTEM"] as const;
export type ThemePreferenceValue = (typeof THEME_PREFERENCES)[number];
export const THEME_LABELS: Record<ThemePreferenceValue, string> = {
  LIGHT: "الوضع الفاتح",
  DARK: "الوضع الداكن",
  SYSTEM: "وضع الجهاز",
};

/**
 * Allowlisted product-control view rebuilt from server state. Theme changes are client
 * actions: the server only records what was requested and what the client acknowledged.
 */
export const ProductControlPayload = z.discriminatedUnion("view", [
  z.object({
    view: z.literal("APP_THEME"),
    clientAction: z.object({ type: z.literal("SET_THEME"), theme: z.enum(THEME_PREFERENCES) }).strict(),
    status: z.enum(["REQUESTED", "APPLIED", "FAILED"]),
    label: z.string().min(1).max(40),
  }).strict(),
  z.object({
    view: z.enum(["MARKET_SWITCH_REVIEW", "MARKET_SWITCH_STATUS"]),
    status: z.enum(["AWAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]),
    from: z.object({ marketId: z.string().max(32), countryNameAr: z.string().max(80), currencyCode: z.string().max(3) }).strict(),
    to: z.object({ marketId: z.string().max(32), countryNameAr: z.string().max(80), currencyCode: z.string().max(3) }).strict(),
    unchanged: z.array(z.string().min(1).max(160)).max(4),
    notice: z.string().max(300).optional(),
  }).strict(),
  z.object({
    view: z.enum(["PROFILE_REVIEW", "PROFILE_STATUS"]),
    status: z.enum(["AWAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]),
    field: z.literal("displayName"),
    fieldLabel: z.string().max(40),
    before: z.string().max(80),
    after: z.string().max(80),
    notice: z.string().max(300).optional(),
  }).strict(),
  z.object({
    // The export re-authenticates in a compact form posting to /account/privacy/exports; the
    // password never becomes a chat message and the server keeps no copy of the export.
    view: z.literal("PRIVACY_EXPORT"),
    status: z.literal("AWAITING_REAUTHENTICATION"),
    includes: z.array(z.string().min(1).max(80)).max(8),
    notice: z.string().max(300),
  }).strict(),
  z.object({
    view: z.literal("CONTROL_NOTICE"),
    tone: z.enum(["INFO", "UNAVAILABLE", "REFUSED"]),
    title: z.string().min(1).max(80),
    lines: z.array(z.string().min(1).max(240)).max(6),
    options: z.array(z.object({ label: z.string().min(1).max(60), message: z.string().min(1).max(120) }).strict()).max(6).optional(),
  }).strict(),
]);
export type ProductControlPayload = z.infer<typeof ProductControlPayload>;

type CapabilityActor = "ANYONE" | "AUTHENTICATED" | "SELLER" | "ORDER_PARTICIPANT" | "ORDER_BUYER_WITH_ASSIGNED_DRIVER";
type CapabilityAccess = "READ" | "WRITE" | "CLIENT";

/**
 * The universal capability catalog: every product operation DINAR may reach from the
 * conversation, described once. It is descriptive, never executable by itself — the model may
 * name a `modelDiscoverable` capability, and the server turns that into the capability's
 * canonical utterance, which re-enters the same deterministic adapter a typed request takes.
 */
export type ProductCapability = {
  id: string;
  /** What users ask for, in words the model can match; not a keyword list. */
  intents: readonly string[];
  /** Arguments the model may supply; everything else is resolved by the server. */
  input: readonly ("theme" | "countryCode")[];
  actor: CapabilityActor;
  resourceScope: string;
  marketScope: "NONE" | "ACTIVE_MARKET" | "TARGET_MARKET" | "RESOURCE_MARKET";
  access: CapabilityAccess;
  confirmation: "NONE" | "REQUIRED" | "PROVIDER_VERIFIED";
  executor: string;
  surface: ConversationSemanticSurface;
  idempotency: string;
  errors: readonly string[];
  availability: ConversationCapabilityAvailability | "UNAVAILABLE_NO_AUTHORITY";
  modelDiscoverable: boolean;
};

export const PRODUCT_CAPABILITY_CATALOG = [
  {
    id: "SET_THEME", intents: ["change app appearance to light, dark or device theme"], input: ["theme"],
    actor: "ANYONE", resourceScope: "this device", marketScope: "NONE", access: "CLIENT", confirmation: "NONE",
    executor: "client:lib/theme.setThemePreference", surface: "PRODUCT_CONTROL_SURFACE",
    idempotency: "same theme is a no-op; acknowledgement is recorded once per request",
    errors: ["THEME_UNSUPPORTED", "CLIENT_APPLY_FAILED"], availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "SWITCH_MARKET", intents: ["browse or use another country's marketplace", "change my market to a country"], input: ["countryCode"],
    actor: "AUTHENTICATED", resourceScope: "the account's active browsing market and this conversation", marketScope: "TARGET_MARKET",
    access: "WRITE", confirmation: "REQUIRED", executor: "action-foundation:SWITCH_MARKET", surface: "PRODUCT_CONTROL_SURFACE",
    idempotency: "pending action is owner-bound, expires in 10 minutes and executes once",
    errors: ["MARKET_UNKNOWN", "MARKET_UNAVAILABLE", "ALREADY_ACTIVE", "EXPIRED"], availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "SELLER_MARKET_ELIGIBILITY", intents: ["sell in another country", "expand my business to another market"], input: ["countryCode"],
    actor: "AUTHENTICATED", resourceScope: "seller eligibility for one market (read)", marketScope: "TARGET_MARKET",
    access: "READ", confirmation: "NONE", executor: "lib/markets seller eligibility", surface: "PRODUCT_CONTROL_SURFACE",
    idempotency: "read only", errors: ["MARKET_UNKNOWN", "APPROVAL_REQUIRED"], availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "UPDATE_DISPLAY_NAME", intents: ["change my name on DINAR"], input: [],
    actor: "AUTHENTICATED", resourceScope: "own profile", marketScope: "NONE", access: "WRITE", confirmation: "REQUIRED",
    executor: "action-foundation:UPDATE_DISPLAY_NAME", surface: "PRODUCT_CONTROL_SURFACE",
    idempotency: "pending action executes once; same name is a no-op", errors: ["NAME_INVALID", "EXPIRED"],
    availability: "AVAILABLE", modelDiscoverable: false,
  },
  {
    id: "VIEW_ACCOUNT", intents: ["show my account information", "open settings or privacy settings", "log out"], input: [],
    actor: "AUTHENTICATED", resourceScope: "own account", marketScope: "NONE", access: "READ", confirmation: "NONE",
    executor: "surfaceIntent:ACCOUNT|SETTINGS|LOGOUT", surface: "WORKFLOW_SURFACE", idempotency: "read only",
    errors: [], availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "NOTIFICATION_PREFERENCES", intents: ["change notification or marketing message preferences", "stop promotional messages"], input: [],
    actor: "AUTHENTICATED", resourceScope: "own communication preferences", marketScope: "NONE", access: "WRITE", confirmation: "NONE",
    executor: "privacy-turn → lib/privacy-rights.updatePrivacyPreferences", surface: "PRODUCT_CONTROL_SURFACE",
    idempotency: "same value is a no-op; each change appends one consent event",
    errors: ["STALE_PREFERENCES"], availability: "AVAILABLE_INTERNAL", modelDiscoverable: true,
  },
  {
    id: "PRIVACY_CENTER", intents: ["what personal data does DINAR keep about me", "show my privacy settings", "my privacy requests"], input: [],
    actor: "AUTHENTICATED", resourceScope: "own personal data summary and privacy requests", marketScope: "NONE", access: "READ", confirmation: "NONE",
    executor: "privacy-turn → lib/privacy-rights.personalDataSummary", surface: "PRODUCT_CONTROL_SURFACE", idempotency: "read only",
    errors: [], availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "EXPORT_MY_DATA", intents: ["download or export a copy of my data"], input: [],
    actor: "AUTHENTICATED", resourceScope: "own records", marketScope: "NONE", access: "READ", confirmation: "REQUIRED",
    executor: "client form → POST /account/privacy/exports (password re-authentication)", surface: "PRODUCT_CONTROL_SURFACE",
    idempotency: "each export is a tracked request keyed by the client", errors: ["REAUTHENTICATION_FAILED", "RATE_LIMITED"],
    availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "DEVICE_LOCATION_SHARING", intents: ["stop or allow sharing my device location"], input: [],
    actor: "AUTHENTICATED", resourceScope: "own location-sharing permission", marketScope: "NONE", access: "WRITE", confirmation: "NONE",
    executor: "privacy-turn → lib/privacy-rights.updatePrivacyPreferences (enforced by lib/delivery)", surface: "PRODUCT_CONTROL_SURFACE",
    idempotency: "same value is a no-op", errors: [], availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "AI_PLANS", intents: ["show subscription plans", "subscribe to Go or Pro", "pay my subscription", "plan prices"], input: [],
    actor: "AUTHENTICATED", resourceScope: "own subscription", marketScope: "ACTIVE_MARKET", access: "WRITE", confirmation: "PROVIDER_VERIFIED",
    executor: "commerce-turn:AI_PLANS → lib/business.subscribeBusiness", surface: "AI_PLANS_CARD",
    idempotency: "subscription keyed by pending action id", errors: ["PRICE_NOT_APPROVED", "BILLING_NOT_CONNECTED"],
    availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "AI_USAGE", intents: ["how much AI allowance did I use", "when does my allowance renew"], input: [],
    actor: "AUTHENTICATED", resourceScope: "own usage", marketScope: "ACTIVE_MARKET", access: "READ", confirmation: "NONE",
    executor: "lib/ai-usage summary", surface: "AI_USAGE_CARD", idempotency: "read only", errors: [],
    availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "SELLER_SALES", intents: ["my sales statistics", "compare this month with last month"], input: [],
    actor: "SELLER", resourceScope: "own orders", marketScope: "ACTIVE_MARKET", access: "READ", confirmation: "NONE",
    executor: "seller-sales SALES insight", surface: "ASSISTANT_ADVICE_CARD", idempotency: "read only", errors: [],
    availability: "AVAILABLE", modelDiscoverable: true,
  },
  {
    id: "SHARE_LOCATION", intents: ["send my location for my order", "use my current location for delivery", "type my address"], input: [],
    actor: "ORDER_PARTICIPANT", resourceScope: "one order's delivery destination, pickup point or service location", marketScope: "RESOURCE_MARKET",
    access: "WRITE", confirmation: "REQUIRED", executor: "delivery-turn → lib/delivery.attachTransactionLocation", surface: "DELIVERY_CARD",
    idempotency: "same location is a no-op; device read once per tap", errors: ["PERMISSION_DENIED", "LOCATION_INVALID", "EXPIRED"],
    availability: "AVAILABLE_INTERNAL", modelDiscoverable: true,
  },
  {
    id: "SHARE_LOCATION_WITH_DRIVER", intents: ["send my location to the driver of my order"], input: [],
    actor: "ORDER_BUYER_WITH_ASSIGNED_DRIVER", resourceScope: "the order's delivery destination, visible to its assigned driver only",
    marketScope: "RESOURCE_MARKET", access: "WRITE", confirmation: "REQUIRED", executor: "delivery-turn → lib/delivery.attachTransactionLocation",
    surface: "DELIVERY_CARD", idempotency: "same location is a no-op", errors: ["NO_ASSIGNED_DRIVER", "DESTINATION_LOCKED"],
    availability: "AVAILABLE_INTERNAL", modelDiscoverable: true,
  },
  {
    id: "SHARE_BUSINESS_LOCATION", intents: ["send my shop or restaurant location to a customer"], input: [],
    actor: "SELLER", resourceScope: "a pickup order's pickup point, or the listing's public area through an existing inquiry",
    marketScope: "RESOURCE_MARKET", access: "WRITE", confirmation: "REQUIRED",
    executor: "delivery-turn PICKUP_POINT | action-foundation:SEND_INQUIRY_MESSAGE", surface: "DELIVERY_CARD",
    idempotency: "pending action executes once", errors: ["NO_RELATIONSHIP", "PRECISE_ADDRESS_REFUSED"],
    availability: "AVAILABLE_INTERNAL", modelDiscoverable: true,
  },
  {
    id: "MARKETPLACE_INQUIRY", intents: ["ask the seller a question", "what did the seller reply"], input: [],
    actor: "AUTHENTICATED", resourceScope: "one buyer–seller relationship", marketScope: "ACTIVE_MARKET", access: "WRITE",
    confirmation: "REQUIRED", executor: "action-foundation:SEND_INQUIRY_MESSAGE", surface: "INQUIRY_SURFACE",
    idempotency: "message keyed by pending action id", errors: ["NO_RELATIONSHIP", "PRICE_OFFER"],
    availability: "AVAILABLE_INTERNAL", modelDiscoverable: false,
  },
] as const satisfies readonly ProductCapability[];

export type ProductCapabilityId = (typeof PRODUCT_CAPABILITY_CATALOG)[number]["id"];
export const MODEL_DISCOVERABLE_CAPABILITIES = PRODUCT_CAPABILITY_CATALOG
  .filter((capability) => capability.modelDiscoverable)
  .map((capability) => capability.id) as ProductCapabilityId[];

/**
 * The deterministic utterance a model-named capability re-enters the runtime with. The server
 * then resolves, authorizes and reviews it exactly as if the user had typed it.
 */
export function capabilityUtterance(
  id: ProductCapabilityId,
  args: { theme?: ThemePreferenceValue; countryNameAr?: string } = {},
): string | undefined {
  switch (id) {
    case "SET_THEME":
      return args.theme ? `فعّل ${THEME_LABELS[args.theme]}` : undefined;
    case "SWITCH_MARKET":
      return args.countryNameAr ? `حوّل سوقي إلى ${args.countryNameAr}` : undefined;
    case "SELLER_MARKET_ELIGIBILITY":
      return args.countryNameAr ? `أريد البيع في ${args.countryNameAr}` : undefined;
    case "VIEW_ACCOUNT":
      return "أرني بيانات حسابي";
    case "NOTIFICATION_PREFERENCES":
      return "غيّر تفضيلات الإشعارات";
    case "PRIVACY_CENTER":
      return "ما البيانات التي تحتفظون بها عني";
    case "EXPORT_MY_DATA":
      return "صدّر بياناتي";
    case "DEVICE_LOCATION_SHARING":
      return "تفضيلات الإشعارات";
    case "AI_PLANS":
      return "اعرض الباقات";
    case "AI_USAGE":
      return "كم نسبة استهلاكي؟";
    case "SELLER_SALES":
      return "أعطني إحصائيات مبيعاتي";
    case "SHARE_LOCATION":
      return "أرسل موقعي";
    case "SHARE_LOCATION_WITH_DRIVER":
      return "أرسل موقعي للمندوب";
    case "SHARE_BUSINESS_LOCATION":
      return "أرسل موقع متجري للعميل";
    default:
      return undefined;
  }
}
