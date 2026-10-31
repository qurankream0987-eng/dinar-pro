import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { aiResultSets, db } from "@workspace/db";
import type { ListingRecord } from "../lib/dinar-data";
import type { marketFor } from "../lib/markets";
import { addMarketplaceCartItem, addMarketplaceCartItemOnce } from "../lib/marketplace-cart";
import {
  categoryAliasWords,
  searchMarketplaceListings,
} from "../lib/marketplace-listings";
import { resolveMarketplaceCategory } from "../lib/marketplace-categories";
import { genericTokens, itemTokens, purposeTokens } from "../lib/arabic-search-terms";
import { normalizeSearch } from "./search-context";
import {
  decorateStoredResults,
  recommendListings,
  storedSponsoredIds,
} from "../lib/recommendations";
import type { ModelToolDefinition } from "./model-gateway";
import {
  SEARCH_OPERATORS,
  SEARCH_SORTS,
  type SearchFilter,
  type SearchSort, searchFilterDefinition } from "@workspace/api-zod/marketplace-schemas";
import {
  MODEL_OPEN_SURFACE_TOKENS,
  modelOpenSurfaceSchema,
  type TutorialPayload,
} from "@workspace/api-zod/conversation-runtime";
import { SearchFilterInput, SearchSortInput } from "./search-state";
import type {
  ListingPhotoSuggestion,
  ListingPhotoSuggestionStatus,
  ListingPhotoUncertainty,
} from "./listing-photo-intelligence";

export type ToolContext = {
  conversationId: string;
  market: Awaited<ReturnType<typeof marketFor>>;
  actorId?: string;
};

export type ToolResult = {
  memory?: import("./personal-memory-turn").MemorySummary;
  /** RESULTS restores an existing result set exactly; it never creates a new one. */
  kind: "SEARCH" | "RESOURCE" | "RESULTS" | "SURFACE";
  surface?: string;
  resourceIds?: string[];
  resourceId?: string;
  sellerContactRequested?: boolean;
  hideMap?: boolean;
  managementPreview?: {
    previewId: string;
    action: "UPDATE" | "PAUSE" | "RESUME" | "ARCHIVE";
    listingId: string;
    listingTitle: string;
    fieldLabel: string;
    beforeValue: string;
    afterValue: string;
    status: "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
  };
  draft?: Record<string, unknown>;
  draftStep?: string;
  /** Block F typed draft review: values with provenance and every missing field. */
  draftReview?: Record<string, unknown>;
  /** Block F seller insight (price comparables, listing factors); facts only. */
  sellerInsight?: Record<string, unknown>;
  /** Block F2 server facts side by side; unknown values stay null. */
  comparison?: Record<string, unknown>;
  /** Set when the model's canonical request re-entered the runtime (routing-mode.ts); diagnostics only. */
  modelRouted?: { canonicalRequest: string };
  /** W02-ULTRA B10: the policy versions reviewed, accepted or declined in this conversation. */
  policyReview?: import("./policy-turn").PolicyReview;
  /** Block F2 purchase review for an F0 pending action; nothing is paid. */
  purchaseReview?: Record<string, unknown>;
  photoSuggestionStatus?: ListingPhotoSuggestionStatus;
  photoSuggestions?: ListingPhotoSuggestion[];
  photoSuggestionUncertainties?: ListingPhotoUncertainty[];
  prompt?: string;
  /** Allowlisted employment view (Block C); built only by the employment adapter. */
  employment?: Record<string, unknown>;
  /** Allowlisted delivery/location view (Block D); built only by the delivery adapter. */
  delivery?: Record<string, unknown>;
  /** Allowlisted seller promotion view (Block E); built only by the promotion adapter. */
  promotion?: Record<string, unknown>;
  /** Server-built driver view (Block F4); present only on driver surfaces. */
  driver?: Record<string, unknown>;
  /** Server-built provider connection view (G1); never contains a key or hash. */
  provider?: Record<string, unknown>;
  /** G2 conversational answer (advice, discussion, clarification); never an action. */
  advice?: Record<string, unknown>;
  /** G2 allowlisted negotiation view for one of its parties. */
  negotiation?: Record<string, unknown>;
  /** NEXT G2: buyer–seller inquiry view (lib/inquiries.ts). */
  inquiry?: Record<string, unknown>;
  /** Monetization V3 commercial view (balance, reviews, campaigns, Market Pulse, Business). */
  commerce?: Record<string, unknown>;
  /** Universal product control view (theme, market, profile); built only by product-control-turn. */
  control?: Record<string, unknown>;
  /** D3-A: the owner's business card (setup, profile, catalog, orders, insights); server-built. */
  business?: Record<string, unknown>;
  tutorial?: TutorialPayload;
  /**
   * G2: the pending action this answer discusses. Such an answer keeps that action
   * pending (it is not a newer conversation step) and is never stored as a result set.
   */
  relatesToAction?: string;
  resultSetId?: string;
  query: Record<string, unknown>;
  listings: ListingRecord[];
};

const SearchListingsInput = z
  .object({
    query: z.string().trim().max(200).default(""),
    category: z.string().trim().min(1).max(80).optional(),
    categoryId: z.string().trim().min(1).max(80).optional(),
    filters: z.array(SearchFilterInput).max(12).optional(),
    sort: SearchSortInput.optional(),
  })
  .strict();

const GetResourceInput = z
  .object({
    resultSetId: z.string().uuid(),
    resourceId: z.string().min(1).max(200),
  })
  .strict();

type SearchListingsArgs = z.infer<typeof SearchListingsInput>;
type GetResourceArgs = z.infer<typeof GetResourceInput>;

export class ToolRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRejectedError";
  }
}

type ToolDefinition = {
  name: string;
  version: 1;
  description: string;
  permissions: readonly ("marketplace.read" | "marketplace.cart.write")[];
  riskLevel: "LOW" | "MEDIUM";
  idempotency: "READ_ONLY" | "NON_IDEMPOTENT";
  auditPolicy: "REDACTED_TURN_METADATA";
  inputSchema: z.ZodTypeAny;
  modelDefinition: ModelToolDefinition;
  exposedToModel?: boolean;
  execute: (input: any, context: ToolContext) => Promise<ToolResult>;
};

export const aiToolRegistry: Record<string, ToolDefinition> = {
  openSurface: {
    name: "openSurface",
    version: 1,
    description:
      "Render an existing marketplace workflow inside the conversation. This never performs a mutation.",
    permissions: ["marketplace.read"],
    riskLevel: "LOW",
    idempotency: "READ_ONLY",
    auditPolicy: "REDACTED_TURN_METADATA",
     inputSchema: z
       .object({
         surface: modelOpenSurfaceSchema,
       })
      .strict(),
    modelDefinition: {
      name: "openSurface",
      description:
        "Open a known existing workflow: cart, checkout, account/auth, settings, policies, orders, listing creation, the seller's own listings, dues, or market. For ordinary open-ended requests, respond conversationally instead of claiming a dedicated workflow is unavailable. No successful action is implied.",
      parameters: {
        type: "object",
        properties: {
          surface: {
            type: "string",
            enum: [...MODEL_OPEN_SURFACE_TOKENS],
          },
        },
        required: ["surface"],
        additionalProperties: false,
      },
    },
    execute: async (input) => ({
      kind: "SURFACE",
      surface: input.surface,
      query: {},
      listings: [],
    }),
  },

  addToCart: {
    name: "addToCart",
    version: 1,
    description:
      "Add a previously returned listing to the authenticated user's cart after live stock and market validation.",
    permissions: ["marketplace.cart.write"],
    riskLevel: "MEDIUM",
    idempotency: "NON_IDEMPOTENT",
    auditPolicy: "REDACTED_TURN_METADATA",
    exposedToModel: false,
    inputSchema: z
      .object({
        resultSetId: z.string().uuid(),
        resourceId: z.string().min(1).max(200),
        quantity: z.number().int().min(1).max(100).default(1),
        /** A card button: the conversation/result-set/listing identity is the receipt key. */
        cardReceipt: z.boolean().optional(),
      })
      .strict(),
    modelDefinition: {
      name: "addToCart",
      description: "Internal action only; never call directly from the model.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      if (!context.actorId)
        throw new ToolRejectedError("An authenticated user is required.");
      const [resultSet] = await db
        .select()
        .from(aiResultSets)
        .where(
          and(
            eq(aiResultSets.id, input.resultSetId),
            eq(aiResultSets.conversationId, context.conversationId),
            eq(aiResultSets.marketId, context.market.id),
          ),
        );
      if (
        !resultSet ||
        (resultSet.expiresAt && resultSet.expiresAt.getTime() <= Date.now()) ||
        !resultSet.resourceIds.includes(input.resourceId)
      )
        throw new ToolRejectedError(
          "The requested listing is not in this conversation's current results.",
        );

      if (input.cardReceipt) {
        const { receipt } = await addMarketplaceCartItemOnce({
          userId: context.actorId,
          expectedMarketId: context.market.id,
          conversationId: context.conversationId,
          resultSetId: input.resultSetId,
          listingId: input.resourceId,
          quantity: input.quantity,
        });
        return {
          kind: "SURFACE",
          surface: "CART",
          query: {},
          listings: [],
          prompt: receipt.body,
        };
      }

      const receipt = await addMarketplaceCartItem({
        userId: context.actorId,
        expectedMarketId: context.market.id,
        listingId: input.resourceId,
        quantity: input.quantity,
      });
      return {
        kind: "SURFACE",
        surface: "CART",
        query: {},
        listings: [],
        prompt: `أُضيف «${receipt.listing.title}» إلى سلتك (${receipt.quantity}). راجع السلة قبل إكمال الطلب.`,
      };
    },
  },

  searchListings: {
    name: "searchListings",
    version: 1,
    description:
      "Find published marketplace offers using a short natural-language query and optional category.",
    permissions: ["marketplace.read"],
    riskLevel: "LOW",
    idempotency: "READ_ONLY",
    auditPolicy: "REDACTED_TURN_METADATA",
    inputSchema: SearchListingsInput,
    modelDefinition: {
      name: "searchListings",
      description:
        "Search the current authenticated user's active marketplace. Query is required; category is optional.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 200 },
          category: { type: "string", minLength: 1, maxLength: 80 },
          categoryId: { type: "string", maxLength: 80 },
          filters: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                field: { type: "string", minLength: 1, maxLength: 80 },
                operator: { type: "string", enum: [...SEARCH_OPERATORS] },
                value: { anyOf: [{ type: "string", maxLength: 200 }, { type: "number" }] },
              },
              required: ["field", "operator", "value"],
              additionalProperties: false,
            },
          },
          sort: { type: "string", enum: [...SEARCH_SORTS] },
        },
        required: [],
        additionalProperties: false,
      },
    },
    execute: async (
      input: SearchListingsArgs,
      context: ToolContext,
    ): Promise<ToolResult> => {
      const run = (search: string) =>
        searchMarketplaceListings(context.market, {
          search,
          conversational: true,
          category: input.category,
          categoryId: input.categoryId,
          filters: input.filters as SearchFilter[] | undefined,
          sort: input.sort as SearchSort | undefined,
        });
      let listings = await run(input.query);
      let broadenedFrom: string[] | undefined;
      // Product words that are only category aliases ("كنب") narrow results; when nothing
      // matches them, show the category's real matches and say so instead of an empty state.
      if (!listings.length && (input.categoryId || input.category)) {
        const category = await resolveMarketplaceCategory(input.categoryId, input.category);
        const { aliasWords, remaining } = categoryAliasWords(category, input.query);
        if (aliasWords.length) {
          listings = await run(remaining);
          if (listings.length) broadenedFrom = aliasWords;
        }
      }
      // «شعار لمقهى»: a purpose word no listing mentions is relaxed, and reported.
      if (!listings.length && !broadenedFrom && input.query) {
        const words = itemTokens(normalizeSearch(input.query).split(/\s+/).filter(Boolean));
        const purpose = purposeTokens(words);
        const remaining = words.filter((word) => !purpose.includes(word));
        if (purpose.length && remaining.length) {
          listings = await run(remaining.join(" "));
          if (listings.length) broadenedFrom = purpose;
        }
      }
      // «موبايل ايفون»: a generic kind-of-thing word beside a specific one may be relaxed, and reported.
      if (!listings.length && !broadenedFrom && input.query) {
        const words = itemTokens(normalizeSearch(input.query).split(/\s+/).filter(Boolean));
        const generic = genericTokens(words);
        if (generic.length) {
          listings = await run(words.filter((word) => !generic.includes(word)).join(" "));
          if (listings.length) broadenedFrom = generic;
        }
      }
      // «محتاج حد ينضف الشقة»: the category inferred from a noun («الشقة» → عقارات) may be the
      // wrong one. With nothing inside it, the same words are searched across categories and the
      // reply says the category was widened. Only category-independent filters are kept.
      let widenedFromCategory: string | undefined;
      if (!listings.length && (input.categoryId || input.category) && input.query) {
        const category = await resolveMarketplaceCategory(input.categoryId, input.category);
        const wider = await searchMarketplaceListings(context.market, {
          search: input.query,
          conversational: true,
          // Only filters that exist without a category: a category's own field (condition) would be
          // refused there and fail the whole turn (W04 sealed S01).
          filters: (input.filters as SearchFilter[] | undefined)?.filter((filter) => searchFilterDefinition(undefined, filter.field) !== undefined),
          sort: input.sort as SearchSort | undefined,
        });
        if (wider.length) {
          listings = wider;
          widenedFromCategory = category?.label ?? input.category ?? input.categoryId;
        }
      }
      const sponsoredIds = listings.filter((item) => item.isSponsored).map((item) => item.id);
      return {
        kind: "SEARCH",
        query: {
          search: input.query,
          category: input.category ?? null,
          categoryId: input.categoryId ?? null,
          filters: input.filters ?? [],
          ...(input.sort ? { sort: input.sort } : {}),
          ...(broadenedFrom ? { broadenedFrom } : {}),
          ...(widenedFromCategory ? { widenedFromCategory } : {}),
          // Which positions were paid, so a restored result keeps the same labels.
          ...(sponsoredIds.length ? { sponsoredIds } : {}),
        },
        listings,
      };
    },
  },
  getResource: {
    name: "getResource",
    version: 1,
    description:
      "Open one listing from a previous result set in this conversation. Use only an ID shown in the supplied prior results.",
    permissions: ["marketplace.read"],
    riskLevel: "LOW",
    idempotency: "READ_ONLY",
    auditPolicy: "REDACTED_TURN_METADATA",
    inputSchema: GetResourceInput,
    modelDefinition: {
      name: "getResource",
      description:
        "Retrieve one live listing from a previous result set owned by this conversation.",
      parameters: {
        type: "object",
        properties: {
          resultSetId: { type: "string", format: "uuid" },
          resourceId: { type: "string", minLength: 1, maxLength: 200 },
        },
        required: ["resultSetId", "resourceId"],
        additionalProperties: false,
      },
    },
    execute: async (
      input: GetResourceArgs,
      context: ToolContext,
    ): Promise<ToolResult> => {
      const [resultSet] = await db
        .select()
        .from(aiResultSets)
        .where(
          and(
            eq(aiResultSets.id, input.resultSetId),
            eq(aiResultSets.conversationId, context.conversationId),
            eq(aiResultSets.marketId, context.market.id),
          ),
        );
      if (
        !resultSet ||
        (resultSet.expiresAt && resultSet.expiresAt.getTime() <= Date.now()) ||
        !resultSet.resourceIds.includes(input.resourceId)
      )
        throw new ToolRejectedError(
          "The requested resource is not in this conversation's results.",
        );

      return {
        kind: "RESOURCE",
        resultSetId: resultSet.id,
        query: { resultSetId: resultSet.id, resourceId: input.resourceId },
        listings: decorateStoredResults(
          await searchMarketplaceListings(context.market, {
            search: "",
            allowedIds: [input.resourceId],
            sponsoredIds: storedSponsoredIds(resultSet.query),
            limit: 1,
          }),
          resultSet.query,
        ),
      };
    },
  },
  recommendListings: {
    name: "recommendListings",
    version: 1,
    description:
      "Recommend similar internal DINAR listings for the current listing or results. Internal action only.",
    permissions: ["marketplace.read"],
    riskLevel: "LOW",
    idempotency: "READ_ONLY",
    auditPolicy: "REDACTED_TURN_METADATA",
    exposedToModel: false,
    inputSchema: z
      .object({
        anchorId: z.string().min(1).max(200).optional(),
        excludeIds: z.array(z.string().min(1).max(200)).max(24).optional(),
        categoryId: z.string().trim().min(1).max(80).optional(),
        filters: z.array(SearchFilterInput).max(12).optional(),
        sort: SearchSortInput.optional(),
        cheaper: z.boolean().optional(),
        nearby: z.boolean().optional(),
      })
      .strict(),
    modelDefinition: {
      name: "recommendListings",
      description: "Internal action only; never call directly from the model.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    execute: async (input, context): Promise<ToolResult> => {
      const result = await recommendListings(context.market, {
        ...input,
        filters: input.filters as SearchFilter[] | undefined,
        sort: input.sort as SearchSort | undefined,
      });
      // An ordinary persisted result set: ordinals, back and refinements keep working.
      return {
        kind: "SEARCH",
        query: {
          search: "",
          category: null,
          categoryId: result.categoryId ?? null,
          filters: result.filters,
          ...(result.sort ? { sort: result.sort } : {}),
          ...(result.sponsoredIds.length ? { sponsoredIds: result.sponsoredIds } : {}),
          recommendation: result.recommendation,
          ...(result.nearbyUnavailable ? { nearbyUnavailable: true } : {}),
        },
        listings: result.listings,
      };
    },
  },
  restoreResults: {
    name: "restoreResults",
    version: 1,
    description:
      "Return to an earlier result set in this conversation with its original order. Never searches again.",
    permissions: ["marketplace.read"],
    riskLevel: "LOW",
    idempotency: "READ_ONLY",
    auditPolicy: "REDACTED_TURN_METADATA",
    exposedToModel: false,
    inputSchema: z.object({ resultSetId: z.string().uuid() }).strict(),
    modelDefinition: {
      name: "restoreResults",
      description: "Internal action only; never call directly from the model.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    execute: async (
      input: { resultSetId: string },
      context: ToolContext,
    ): Promise<ToolResult> => {
      const [resultSet] = await db
        .select()
        .from(aiResultSets)
        .where(
          and(
            eq(aiResultSets.id, input.resultSetId),
            eq(aiResultSets.conversationId, context.conversationId),
            eq(aiResultSets.marketId, context.market.id),
          ),
        );
      if (
        !resultSet ||
        (resultSet.expiresAt && resultSet.expiresAt.getTime() <= Date.now())
      )
        throw new ToolRejectedError(
          "The requested results are not available in this conversation.",
        );
      // Live re-validation keeps paused, sold or moderated listings out, in the stored order.
      const listings = resultSet.resourceIds.length
        ? decorateStoredResults(
            await searchMarketplaceListings(context.market, {
              search: "",
              allowedIds: resultSet.resourceIds,
              sponsoredIds: storedSponsoredIds(resultSet.query),
              limit: 24,
            }),
            resultSet.query,
          )
        : [];
      return {
        kind: "RESULTS",
        resultSetId: resultSet.id,
        query: resultSet.query,
        listings,
      };
    },
  },
};

export function modelToolDefinitions(): ModelToolDefinition[] {
  return Object.values(aiToolRegistry)
    .filter((tool) => tool.exposedToModel !== false)
    .map((tool) => tool.modelDefinition);
}

export async function executeRegisteredTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<{ tool: string; version: number; result: ToolResult }> {
  const tool = aiToolRegistry[name];
  if (!tool)
    throw new ToolRejectedError("The model proposed an unsupported tool.");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawArguments);
  } catch {
    throw new ToolRejectedError("The model proposed invalid tool JSON.");
  }
  let input: unknown;
  try {
    input = tool.inputSchema.parse(parsedJson);
  } catch {
    throw new ToolRejectedError("The model proposed invalid tool arguments.");
  }
  const result = await tool.execute(input, context);
  return { tool: tool.name, version: tool.version, result };
}
