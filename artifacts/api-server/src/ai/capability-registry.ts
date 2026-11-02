/**
 * AI-FOUNDATION-01/02 — the one capability contract the universal DINAR intelligence runtime reads.
 *
 * A capability is never a second implementation: `canonicalService` names the existing DINAR
 * service that owns the data, permission checks and transaction. F01 advertised only three
 * read-only tools; F02 advertises every capability under its stable model tool name, with roles
 * filtered from server rows. A prepare capability still only creates a pending action: the
 * mutation runs after the actor's explicit confirmation through the canonical service.
 *
 * Actor roles are configurations of the same runtime, not separate agents:
 *   BUYER            a signed-in marketplace user
 *   SELLER           a seller/business owner acting for themselves
 *   SELLER_EMPLOYEE  a D5 delegated session; every call is re-authorized against its grant
 * Admin authority is deliberately absent: no capability grants it, and no model tool is an
 * admin capability. SELLER_EMPLOYEE is never a model actor (its deterministic path remains).
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
/** MODEL_TOOL is advertised to the model (prepare tools only propose); SERVER_ONLY stays deterministic. */
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
    toolName: "readInventory",
    purpose: "Read the seller's own offers in the active market; never another seller's catalog.",
    inputSchema: empty,
    outputSchema: z.object({
      inventory: z.array(z.object({
        listingId: z.string(),
        title,
        status: z.string(),
        pricingMode: z.string(),
        unitPrice: z.string().nullable(),
        currency: z.string(),
        inventoryMode: z.string(),
        availableQuantity: z.number().int().nullable(),
      })),
    }),
    actors: ["SELLER", "SELLER_EMPLOYEE"],
    permissions: ["business.inventory.read"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/business-delegations.delegatedSellerModelContext (READ_INVENTORY) / offers by sellerId",
    availability: "MODEL_TOOL",
    modelActors: ["SELLER"],
  }),

  readBusinessInquiries: capability({
    name: "readBusinessInquiries",
    toolName: "readBusinessInquiries",
    purpose: "Read inquiries the actor is a party to, within the current market.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict(),
    outputSchema: z.object({
      inquiries: z.array(z.object({
        inquiryId: uuid,
        listingId: z.string().nullable(),
        role: z.enum(["BUYER", "SELLER"]),
        status: z.string(),
        lastMessageAt: z.string(),
      })),
    }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["inquiry.party"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/inquiries.listInquiries / inquiryForParty",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
  }),

  prepareInquiryReply: capability({
    name: "prepareInquiryReply",
    toolName: "prepareInquiryMessage",
    purpose: "Prepare one inquiry message (buyer question or seller reply) for party review; nothing is sent.",
    inputSchema: z.object({ target: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(2_000) }).strict(),
    outputSchema: z.object({
      preparedAction: z.object({ actionId: uuid, action: z.literal("SEND_INQUIRY_MESSAGE"), targetResource: z.string() }),
      resultSetId: uuid,
    }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["inquiry.party", "business.inquiries.reply", "business.messages.send"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/action-foundation.SEND_INQUIRY_MESSAGE + lib/inquiries.submitInquiryMessage",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
  }),

  prepareListingDraft: capability({
    name: "prepareListingDraft",
    toolName: "prepareListingDraft",
    purpose: "Collect listing fields into the existing draft flow; the model never publishes.",
    inputSchema: z.object({ title: z.string().trim().min(1).max(120) }).passthrough(),
    outputSchema: z.object({
      draft: z.record(z.string(), z.unknown()).optional(),
      draftStep: z.string().optional(),
      preparedDraft: z.object({ draftId: uuid.optional() }),
    }),
    actors: ["SELLER", "SELLER_EMPLOYEE"],
    permissions: ["business.catalog.draft", "business.catalog.draft.price"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/listing-draft.listingDraft",
    availability: "MODEL_TOOL",
    modelActors: ["SELLER"],
  }),

  requestPublicationReview: capability({
    name: "requestPublicationReview",
    toolName: "requestPublicationReview",
    purpose: "Open the owner's existing publication review for a complete draft; the owner confirms.",
    inputSchema: z.object({ draftId: z.string().trim().min(1).max(200) }).strict(),
    outputSchema: z.object({
      preparedAction: z.object({ actionId: uuid, action: z.literal("PUBLISH_LISTING"), targetResource: z.string() }),
      resultSetId: uuid,
    }),
    actors: ["SELLER", "SELLER_EMPLOYEE"],
    permissions: ["business.catalog.draft"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/draft-actions.executeDraftActionTurn (publication review)",
    availability: "MODEL_TOOL",
    modelActors: ["SELLER"],
  }),

  readNegotiationStatus: capability({
    name: "readNegotiationStatus",
    toolName: "readNegotiationStatus",
    purpose: "Read the current negotiation state for a party to it.",
    inputSchema: z.object({ negotiationId: z.string().trim().min(1).max(200) }).strict(),
    outputSchema: z.object({
      negotiation: z.object({
        negotiationId: uuid,
        listingId: z.string(),
        title,
        role: z.enum(["BUYER", "SELLER"]),
        status: z.string(),
        quantity: z.number().int(),
        offerAmount: z.string().nullable(),
        counterAmount: z.string().nullable(),
        currency: z.string(),
      }),
    }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["negotiation.party"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/negotiations.negotiationForParty",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
  }),

  prepareNegotiationProposal: capability({
    name: "prepareNegotiationProposal",
    toolName: "prepareNegotiationProposal",
    purpose: "Prepare one buyer offer or seller counter as a pending review; the user sends it.",
    inputSchema: z
      .object({
        negotiationId: z.string().trim().min(1).max(200).optional(),
        listingId: z.string().trim().min(1).max(200).optional(),
        amount: z.number().positive(),
        quantity: z.number().int().min(1).max(999).optional(),
      })
      .strict(),
    outputSchema: z.object({
      preparedAction: z.object({
        actionId: uuid,
        action: z.enum(["SEND_NEGOTIATION_OFFER", "COUNTER_NEGOTIATION"]),
        targetResource: z.string(),
      }),
      resultSetId: uuid,
    }),
    actors: ["BUYER", "SELLER"],
    permissions: ["negotiation.party"],
    mutation: "PREPARE_ONLY",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "PENDING_ACTION_METADATA",
    canonicalService: "ai/action-foundation.SEND_NEGOTIATION_OFFER/COUNTER_NEGOTIATION",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
  }),

  readBuyerCart: capability({
    name: "readBuyerCart",
    toolName: "readCart",
    purpose: "Read the authenticated buyer's current cart.",
    inputSchema: empty,
    outputSchema: z.object({
      cart: z.array(z.object({
        listingId: z.string(),
        title,
        quantity: count,
        unitPrice: z.string().nullable(),
        availableQuantity: z.number().int().nullable(),
      })),
    }),
    actors: ["BUYER"],
    permissions: ["cart.owner"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/marketplace-cart.getMarketplaceCart",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER"],
  }),

  prepareCartMutation: capability({
    name: "prepareCartMutation",
    toolName: "prepareCartChange",
    purpose: "Propose one cart line for the buyer's review; the cart changes only after confirmation.",
    inputSchema: z.object({ listingId: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(999).optional() }).strict(),
    outputSchema: z.object({
      preparedAction: z.object({ actionId: uuid, action: z.literal("ADD_TO_CART"), targetResource: z.string() }),
      resultSetId: uuid,
    }),
    actors: ["BUYER"],
    permissions: ["marketplace.cart.write", "results.owner"],
    mutation: "MUTATING",
    confirmation: "USER_CONFIRMATION",
    idempotency: "IDEMPOTENCY_KEY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "ACTION_RECEIPT",
    canonicalService: "ai/action-foundation.ADD_TO_CART + lib/marketplace-cart.addMarketplaceCartItemOnce",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER"],
  }),

  reviewCheckout: capability({
    name: "reviewCheckout",
    toolName: "reviewCheckout",
    purpose: "Read the cart exactly as checkout sees it; no payment and no order occur.",
    inputSchema: empty,
    outputSchema: z.object({
      checkout: z.object({
        lines: z.number().int(),
        total: z.string(),
        currency: z.string(),
        readOnly: z.literal(true),
      }),
    }),
    actors: ["BUYER"],
    permissions: ["cart.owner"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/commerce.planCheckout + lib/marketplace-cart.getMarketplaceCart",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER"],
  }),

  readAuthorizedOrders: capability({
    name: "readAuthorizedOrders",
    toolName: "readOrders",
    purpose: "Read orders the actor is a party to, in the active market.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict(),
    outputSchema: z.object({ orders: z.array(z.object({ orderId: z.string(), status: z.string() })) }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["order.party", "business.orders.read"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "ai/order-context.orderContext / orders by buyerId or sellerId",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
  }),

  readFulfillmentStatus: capability({
    name: "readFulfillmentStatus",
    toolName: "readFulfillment",
    purpose: "Read fulfilment/delivery status for an order the actor may see; never changes it.",
    inputSchema: z.object({ orderId: z.string().trim().min(1).max(200) }).strict(),
    outputSchema: z.object({
      fulfillment: z.record(z.string(), z.unknown()),
    }),
    actors: ["BUYER", "SELLER", "SELLER_EMPLOYEE"],
    permissions: ["fulfilment.party", "business.orders.read"],
    mutation: "READ_ONLY",
    confirmation: "NONE",
    idempotency: "READ_ONLY",
    timeoutMs: MODEL_TOOL_TIMEOUT_MS,
    audit: "REDACTED_TURN_METADATA",
    canonicalService: "lib/delivery.getDeliveryView (participant-only)",
    availability: "MODEL_TOOL",
    modelActors: ["BUYER", "SELLER"],
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
