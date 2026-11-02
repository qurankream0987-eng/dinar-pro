/**
 * AI-FOUNDATION-01 — the one capability contract the universal DINAR intelligence runtime reads.
 *
 * A capability is never a second implementation: `canonicalService` names the existing DINAR
 * service that owns the data, permission checks and transaction. Only the three read-only tools
 * marked MODEL_TOOL are advertised to the bounded model loop; every other capability is reached
 * through its existing deterministic flow (a typed turn, a review or a confirmation), and the
 * model can only propose that flow as text.
 *
 * Actor roles are configurations of the same runtime, not separate agents:
 *   BUYER            a signed-in marketplace user
 *   SELLER           a seller/business owner acting for themselves
 *   SELLER_EMPLOYEE  a D5 delegated session; every call is re-authorized against its grant
 * Admin authority is deliberately absent: no capability grants it.
 */
import { z } from "zod";
import {
  CompareListingsInput,
  GetResourceInput,
  SearchListingsInput,
} from "./tool-registry";

export const CAPABILITY_NAMES = [
  "searchListings",
  "listingFacts",
  "compareListings",
  "readInventory",
  "readBusinessInquiries",
  "prepareInquiryReply",
  "prepareListingDraft",
  "requestPublicationReview",
  "readNegotiationStatus",
  "prepareNegotiationProposal",
  "readBuyerCart",
  "prepareCartMutation",
  "reviewCheckout",
  "readAuthorizedOrders",
  "readFulfillmentStatus",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export const ACTOR_ROLES = ["BUYER", "SELLER", "SELLER_EMPLOYEE"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

export type CapabilityMutation = "READ_ONLY" | "PREPARE_ONLY" | "MUTATING";
export type CapabilityConfirmation = "NONE" | "USER_CONFIRMATION";
export type CapabilityIdempotency = "READ_ONLY" | "IDEMPOTENCY_KEY" | "NON_IDEMPOTENT";
export type CapabilityAudit = "REDACTED_TURN_METADATA" | "PENDING_ACTION_METADATA" | "ACTION_RECEIPT";
/** MODEL_TOOL is advertised to the model; SERVER_ONLY exists only behind its deterministic flow. */
export type CapabilityAvailability = "MODEL_TOOL" | "SERVER_ONLY";

export type CapabilityDefinition = {
  readonly name: CapabilityName;
  /** Stable tool name. For SERVER_ONLY it is the canonical internal action, never a model tool. */
  readonly toolName: string;
  readonly purpose: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
  readonly actors: readonly ActorRole[];
  /** Server-enforced permissions or ownership predicates; never supplied by the model. */
  readonly permissions: readonly string[];
  readonly mutation: CapabilityMutation;
  readonly confirmation: CapabilityConfirmation;
  readonly idempotency: CapabilityIdempotency;
  /** Model tools use the loop's clamped per-call budget; other paths use the enclosing turn deadline. */
  readonly timeoutMs: number;
  readonly audit: CapabilityAudit;
  readonly canonicalService: string;
  readonly availability: CapabilityAvailability;
  /** Roles whose configuration may call this through the model tool loop (empty when SERVER_ONLY). */
  readonly modelActors: readonly ActorRole[];
};

export const MODEL_TOOL_TIMEOUT_MS = 3_500;
export const TURN_DEADLINE_MS = 25_000;

const empty = z.object({}).strict();
const id = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();
const title = z.string();
const count = z.number().int().nonnegative();

const ListingRow = z.object({
  id: z.string(),
  title,
  unitPrice: z.number().nullable(),
  currency: z.string(),
});

const capability = (definition: CapabilityDefinition) => definition;

export const CAPABILITY_REGISTRY: Record<CapabilityName, CapabilityDefinition> = {
  searchListings: capability({
    name: "searchListings",
    toolName: "searchListings",
    purpose: "Find published offers in the actor's active market with DINAR's search authority.",
    inputSchema: SearchListingsInput,
    outputSchema: z.object({
      kind: z.literal("SEARCH"),
      resultSetId: uuid,
      resourceIds: z.array(z.string()),
      listings: z.array(ListingRow),
    }),
    actors: ["BUYER", "SELLER"],
    permissions: ["marketplace.read"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/marketplace-listings.searchMarketplaceListings",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
  }),

  listingFacts: capability({
    name: "listingFacts",
    toolName: "getResource",
    purpose: "Retrieve the live recorded facts of one listing from a result set in this conversation.",
    inputSchema: GetResourceInput,
    outputSchema: z.object({
      kind: z.literal("RESOURCE"),
      resultSetId: uuid,
      resourceId: z.string(),
      listings: z.array(ListingRow),
    }),
    actors: ["BUYER", "SELLER"],
    permissions: ["marketplace.read", "results.owner"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/marketplace-listings.searchMarketplaceListings (live revalidation)",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
  }),

  compareListings: capability({
    name: "compareListings",
    toolName: "compareListings",
    purpose: "Compare two to six visible results side by side from DINAR's live records.",
    inputSchema: CompareListingsInput,
    outputSchema: z.object({
      kind: z.literal("SURFACE"),
      surface: z.literal("COMPARISON"),
      resultSetId: uuid,
      positions: z.array(z.number().int()),
      listings: z.array(z.object({ title: z.string(), isSponsored: z.boolean() })),
      rows: z.array(z.object({ label: z.string(), source: z.string(), values: z.array(z.unknown()) })),
      highlights: z.array(z.object({ label: z.string(), text: z.string() })),
    }),
    actors: ["BUYER", "SELLER"],
    permissions: ["marketplace.read", "results.owner"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "ai/buyer-turn.compareRows + lib/marketplace-listings.searchMarketplaceListings",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
  }),

  readInventory: capability({
    name: "readInventory",
    toolName: "READ_INVENTORY",
    purpose: "Read recorded stock for a listing inside the actor's own catalog or delegated scope.",
    inputSchema: z.object({ item: z.string().trim().min(1).max(160) }).strict(),
    outputSchema: z.object({
      listingTitle: title,
      inventoryMode: z.string(),
      availableQuantity: z.number().nullable(),
    }),
    actors: ["SELLER", "SELLER_EMPLOYEE"],
    permissions: ["business.inventory.read"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/business-delegations.delegatedSellerModelContext (READ_INVENTORY)",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  readBusinessInquiries: capability({
    name: "readBusinessInquiries",
    toolName: "INQUIRY_VIEW",
    purpose: "Read inquiries the actor is a party to, within the current market and business scope.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict(),
    outputSchema: z.object({
      inquiries: z.array(z.object({ id: uuid, status: z.string(), listingId: z.string().nullable() })),
    }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["inquiry.party"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/inquiries.listInquiries / inquiryForParty",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  prepareInquiryReply: capability({
    name: "prepareInquiryReply",
    toolName: "DRAFT_INQUIRY_REPLY",
    purpose: "Prepare a reply for the seller/owner to review; nothing is sent by the model.",
    inputSchema: z.object({ inquiryId: uuid, body: z.string().trim().min(1).max(2_000) }).strict(),
    outputSchema: z.object({ draft: z.string(), sent: z.literal(false) }),
    actors: ["SELLER", "SELLER_EMPLOYEE"],
    permissions: ["business.inquiries.reply", "business.messages.send"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/inquiry-turn.executeInquiryTurn (DRAFT_INQUIRY_REPLY)",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  prepareListingDraft: capability({
    name: "prepareListingDraft",
    toolName: "DRAFT_LISTING",
    purpose: "Collect listing fields into the existing draft flow; the model never publishes.",
    inputSchema: z.object({ description: z.string().trim().min(2).max(2_000) }).strict(),
    outputSchema: z.object({ draftId: uuid, step: z.string() }),
    actors: ["SELLER", "SELLER_EMPLOYEE"],
    permissions: ["business.catalog.draft", "business.catalog.draft.price"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/listing-draft.listingDraft",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  requestPublicationReview: capability({
    name: "requestPublicationReview",
    toolName: "REQUEST_PUBLICATION_REVIEW",
    purpose: "Open the owner's existing publication review for a bound draft; the owner confirms.",
    inputSchema: z.object({ draftId: uuid }).strict(),
    outputSchema: z.object({ pendingActionId: uuid, status: z.literal("AWAITING_CONFIRMATION") }),
    actors: ["SELLER", "SELLER_EMPLOYEE"],
    permissions: ["business.catalog.draft"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/draft-actions.executeDraftActionTurn (publication review)",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  readNegotiationStatus: capability({
    name: "readNegotiationStatus",
    toolName: "NEGOTIATION_VIEW",
    purpose: "Read the current negotiation state for a party to it.",
    inputSchema: z.object({ negotiationId: uuid.optional(), listingId: id.optional() }).strict(),
    outputSchema: z.object({
      negotiations: z.array(z.object({ id: uuid, status: z.string(), awaitingSeller: z.boolean() })),
    }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["negotiation.party"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "ai/negotiation-turn.executeNegotiationTurn",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  prepareNegotiationProposal: capability({
    name: "prepareNegotiationProposal",
    toolName: "SEND_NEGOTIATION_OFFER",
    purpose: "Prepare a single counter-offer as a pending review; the user sends it.",
    inputSchema: z.object({ negotiationId: uuid, amountMinor: z.number().int().positive() }).strict(),
    outputSchema: z.object({
      pendingActionId: uuid,
      status: z.literal("AWAITING_CONFIRMATION"),
      amountMinor: z.number().int(),
    }),
    actors: ["BUYER", "SELLER"],
    permissions: ["negotiation.party"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/price-proposal.priceProposal + ai/negotiation-turn.executeNegotiationTurn",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  readBuyerCart: capability({
    name: "readBuyerCart",
    toolName: "CART_VIEW",
    purpose: "Read the authenticated buyer's current cart.",
    inputSchema: empty,
    outputSchema: z.object({
      items: z.array(z.object({ listingId: z.string(), quantity: count, unitPrice: z.number().nullable() })),
    }),
    actors: ["BUYER"],
    permissions: ["cart.owner"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/marketplace-cart.getMarketplaceCart",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  prepareCartMutation: capability({
    name: "prepareCartMutation",
    toolName: "addToCart",
    purpose: "Add one visible listing to the cart after live stock/market checks and user confirmation.",
    inputSchema: z.object({ resultSetId: uuid, resourceId: id, quantity: z.number().int().min(1).max(100).default(1) }).strict(),
    outputSchema: z.object({ pendingActionId: uuid, status: z.literal("AWAITING_CONFIRMATION") }),
    actors: ["BUYER"],
    permissions: ["marketplace.cart.write", "results.owner"],
    mutation: "MUTATING",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "ACTION_RECEIPT",
    canonicalService: "lib/marketplace-cart.addMarketplaceCartItemOnce",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  reviewCheckout: capability({
    name: "reviewCheckout",
    toolName: "CHECKOUT_REVIEW",
    purpose: "Open the existing checkout review with server-computed totals; no payment occurs.",
    inputSchema: empty,
    outputSchema: z.object({ pendingActionId: uuid, totalMinor: z.number().int(), currency: z.string() }),
    actors: ["BUYER"],
    permissions: ["cart.owner"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/commerce-turn.executeCommerceTurn (checkout review)",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  readAuthorizedOrders: capability({
    name: "readAuthorizedOrders",
    toolName: "READ_ORDERS",
    purpose: "Read orders the actor is a party to, or those inside a delegated business scope.",
    inputSchema: z.object({ orderId: uuid.optional(), limit: z.number().int().min(1).max(20).default(10) }).strict(),
    outputSchema: z.object({ orders: z.array(z.object({ orderId: z.string(), status: z.string() })) }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["order.party", "business.orders.read"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "ai/order-context.orderContext",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),

  readFulfillmentStatus: capability({
    name: "readFulfillmentStatus",
    toolName: "DELIVERY_STATUS",
    purpose: "Read fulfilment/delivery status for an order the actor may see; never changes it.",
    inputSchema: z.object({ orderId: uuid }).strict(),
    outputSchema: z.object({ orderId: uuid, status: z.string(), fulfilment: z.string().nullable() }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["fulfilment.party", "business.orders.read"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: TURN_DEADLINE_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "ai/delivery-turn.executeDeliveryTurn",
    availability: "SERVER_ONLY",
    modelActors: [],
  }),
};

export const MODEL_TOOL_CAPABILITIES = CAPABILITY_NAMES.filter(
  (name) => CAPABILITY_REGISTRY[name].availability === "MODEL_TOOL",
);

export function capabilityForTool(toolName: string): CapabilityDefinition | undefined {
  return Object.values(CAPABILITY_REGISTRY).find((definition) => definition.toolName === toolName);
}

/** The model's tool list is derived from this registry, never invented by a provider adapter. */
export function modelToolCapabilityDefinitions(): CapabilityDefinition[] {
  return MODEL_TOOL_CAPABILITIES.map((name) => CAPABILITY_REGISTRY[name]);
}

/** No live provider call was made while building AI-FOUNDATION-01; scripted gateways only. */
export const LIVE_PROVIDER_STATUS = "LIVE_PROVIDER_NOT_VERIFIED" as const;
