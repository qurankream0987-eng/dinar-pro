import {
  SMART_STATE_KINDS,
  executeGuestModelTurn,
  isGroundedSellerDraftRequest,
  modelFailureMessage,
} from "../ai/smart-turn";
import { refreshNegotiationPayload } from "../ai/negotiation-turn";
import { refreshInquiryPayload } from "../ai/inquiry-turn";
import { buildCardEnvelope } from "../ai/card-envelope";
import { CardEnvelopeSchema } from "@workspace/api-zod/surface-composition";
import { acknowledgeClientAction, refreshControlPayload } from "../ai/product-control-turn";
import { guestUsageKey, reserveAiUsage, settleAiUsage, type AiUsageMeasurement, type AiUsageOwner } from "../lib/ai-usage";
import { usageLimitMessage } from "../ai/usage-turn";
import {
  AIProviderError,
  type ConversationModelGateway,
  transcribeVoiceRecording,
  VOICE_TRANSCRIPTION_MODEL,
} from "../ai/model-gateway";
import { conversationTitle } from "../ai/conversation-title";
import {
  isSafeGuestHandoffText,
  sanitizeGuestHandoffMessages,
} from "../ai/guest-handoff";
import { ConversationDraft, isGeneralRequest } from "../ai/listing-draft";
import { contextualQuery, normalizeSearch, resultPosition } from "../ai/search-context";
import { addToCartIntent, surfaceIntent } from "../ai/intent";
import { parseStructuredSearch } from "../ai/search-query";
import {
  hasExplicitMarketplaceSearchIntent,
  isVagueRequest,
} from "../ai/marketplace-intent";
import { SearchStateInput } from "../ai/search-state";
import {
  applyEmploymentAction,
  employmentStateExpiry,
  refreshEmploymentPayload,
} from "../ai/employment-turn";
import {
  deliveryStateExpiry,
  refreshDeliveryPayload,
  storableDeliveryPayload,
} from "../ai/delivery-turn";
import { refreshPurchaseReview } from "../ai/buyer-turn";
import {
  applyPromotionAction,
  promotionStateExpiry,
  refreshPromotionPayload,
} from "../ai/promotion-turn";
import { driverStateExpiry, refreshDriverPayload } from "../ai/driver-turn";
import { refreshBusinessPayload, type BusinessPayload } from "../ai/business-turn";
import { recordSellerEmployeeDraftBindingTx } from "../lib/business-delegations";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import express, { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  conversationSurfaceTokenSchema,
  ProductControlPayload,
  TutorialLearningEventInputSchema,
  TutorialLearningEventSchema,
  TutorialLearningEventsResponseSchema,
  TutorialPayloadSchema,
} from "@workspace/api-zod/conversation-runtime";
import {
  aiResultSets,
  aiUiBlocks,
  conversations,
  db,
  messages,
  tutorialLearningEvents,
} from "@workspace/db";
import {
  AcknowledgeAiControlActionBody,
  AcknowledgeAiControlActionParams,
  AcknowledgeAiControlActionResponse,
  AddAiListingToCartBody,
  AddAiListingToCartResponse,
  ApplyAiEmploymentActionBody,
  ApplyAiEmploymentActionParams,
  ApplyAiEmploymentActionResponse,
  ApplyAiListingManagementPreviewBody,
  ApplyAiListingManagementPreviewParams,
  ApplyAiListingManagementPreviewResponse,
  ApplyAiPromotionActionResponse,
  CreateAiGuestHandoffBody,
  CreateAiGuestHandoffResponse,
  CreateAiConversationResponse,
  GetAiConversationParams,
  CopyAiConversationBody,
  CopyAiConversationParams,
  CopyAiConversationResponse,
  RenameAiConversationBody,
  RenameAiConversationResponse,
  GetAiConversationResponse,
  GetAiConversationsResponse,
  SendAiConversationTurnBody,
  SendAiConversationTurnParams,
  TranscribeAiVoiceMessageResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import {
  AUTH_RATE_LIMIT_SCOPE,
  consumeRateLimit,
  normalizeClientIp,
} from "../lib/auth-rate-limiter";
import {
  GUEST_MARKET_COOKIE,
  isMarketAvailable,
  marketFor,
} from "../lib/markets";
import {
  categoryAliasWords,
  publishedListingCities,
  searchMarketplaceListings,
} from "../lib/marketplace-listings";
import {
  categorySchema,
  listMarketplaceCategories,
} from "../lib/marketplace-categories";
import { findCardAddReceipt } from "../lib/marketplace-cart";
import { taskPlanNotice } from "../ai/task-plan";
import { executeAiConversationTurn } from "../ai/conversation-runtime";
import { claimsCompletedAction, claimsUsersCompletedAction, enforceModelAuthority, MODEL_CLAIM_WITHHELD, receiptIdsOf, receiptsForTurn, receiptViews, receiptViewsByIds } from "../ai/action-receipts";
import { runInTurn } from "../ai/turn-context";
import {
  LISTING_PHOTO_UNCERTAINTIES,
  type ListingPhotoSuggestionProvider,
} from "../ai/listing-photo-intelligence";
import {
  type ListingPhotoVisionCapability,
  unavailableListingPhotoVisionCapability,
} from "../ai/groq-listing-photo-provider";
import {
  executeRegisteredTool,
  ToolRejectedError,
} from "../ai/tool-registry";
import { validateListingPhotoPathsForOwner } from "../lib/listing-photos";
import { commerceStateExpiry, refreshCommercePayload } from "../ai/commerce-turn";
import { afterOrganicSearch } from "../lib/demand-rescue";
import { mintAttributionToken, recordConversationEngagement } from "../lib/promotion-attribution";
import type { EngagementKind } from "../lib/commercial-policy";
import type { ListingRecord } from "../lib/dinar-data";
import { redactListingContactPhone } from "../lib/listing-contact";
import {
  applyListingPreviewAction,
  parseStoredListingManagementPreviewStatus,
} from "../ai/seller-management";
import {
  decorateStoredResults,
  storedSponsoredIds,
} from "../lib/recommendations";

const router = Router();

function safeTurnFailureMetadata(error: unknown): Record<string, string | number> {
  if (error === null || typeof error !== "object")
    return { errorType: typeof error };

  const value = error as Record<string, unknown>;
  const metadata: Record<string, string | number> = {};
  if (
    error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
  )
    metadata.errorType = error.name;
  if (
    value.cause instanceof Error &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.cause.name)
  )
    metadata.causeType = value.cause.name;
  if (value.cause !== null && typeof value.cause === "object") {
    const cause = value.cause as Record<string, unknown>;
    if (
      typeof cause.code === "string" &&
      /^[A-Za-z0-9_.:-]{1,80}$/.test(cause.code)
    )
      metadata.causeCode = cause.code;
    const causeStatus = cause.httpStatus ?? cause.status ?? cause.statusCode;
    if (
      typeof causeStatus === "number" &&
      Number.isInteger(causeStatus) &&
      causeStatus >= 100 &&
      causeStatus <= 599
    )
      metadata.causeStatus = causeStatus;
  }

  if (
    typeof value.code === "string" &&
    /^[A-Za-z0-9_.:-]{1,80}$/.test(value.code)
  )
    metadata.errorCode = value.code;

  const upstreamStatus = value.httpStatus ?? value.status ?? value.statusCode;
  if (
    typeof upstreamStatus === "number" &&
    Number.isInteger(upstreamStatus) &&
    upstreamStatus >= 100 &&
    upstreamStatus <= 599
  )
    metadata.upstreamStatus = upstreamStatus;

  if (
    typeof value.provider === "string" &&
    /^(GROQ|OPENAI|OPENROUTER)$/.test(value.provider)
  )
    metadata.provider = value.provider;

  for (const key of ["requestedModel", "actualModel"] as const) {
    const model = value[key];
    if (typeof model === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(model))
      metadata[key] = model;
  }

  if (error instanceof Error && typeof error.stack === "string") {
    const projectFrame = error.stack
      .split("\n")
      .slice(1)
      .map((frame) =>
        frame.match(/artifacts\/api-server\/src\/([\w./-]+):(\d+):\d+/),
      )
      .find((match) => match !== null);
    if (projectFrame)
      metadata.errorLocation = `${projectFrame[1]}:${projectFrame[2]}`;
  }

  return metadata;
}

// Keys location retry digests to this process: a stored digest cannot be brute-forced
// back to coordinates, and a retry after a restart simply asks for a fresh share.
const LOCATION_DIGEST_KEY = randomBytes(32);
const enabled = () =>
  process.env.NODE_ENV !== "production" || process.env.DINAR_AI_CHAT === "true";
const SearchStateSchema = SearchStateInput;
const Presentation = z.enum(["RESULTS", "DETAILS"]);
const PhotoSuggestionSchema = z.object({
  field: z.string().min(1).max(80),
  value: z.union([z.string().max(500), z.number().finite()]),
  confidence: z.number().min(0).max(1),
  imageObjectPath: z.string().min(1).max(500),
}).strict();
const StoredBlockPayload = z
  .object({
    resultSetId: z.string().uuid(),
    resourceIds: z.array(z.string().min(1).max(200)).max(24),
    searchState: SearchStateSchema.optional(),
    presentation: Presentation.optional(),
  })
  .strict();
const SurfaceBlock = z.object({
  type: z.literal("SURFACE"),
  version: z.literal(1),
  payload: z.object({
    resultSetId: z.string(),
    resourceIds: z.array(z.string()).optional(),
    resourceId: z.string().optional(),
    sellerContactRequested: z.boolean().optional(),
    hideMap: z.boolean().optional(),
      managementPreview: z
        .object({
          previewId: z.string().uuid(),
          action: z.enum(["UPDATE", "PAUSE", "RESUME", "ARCHIVE"]),
          listingId: z.string().min(1),
          listingTitle: z.string().min(1),
          fieldLabel: z.string().min(1),
          beforeValue: z.string(),
          afterValue: z.string(),
          status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED"]),
        })
        .strict()
        .optional(),
    draft: ConversationDraft.optional(),
    draftStep: z.string().optional(),
    draftReview: z.record(z.string(), z.unknown()).optional(),
    sellerInsight: z.record(z.string(), z.unknown()).optional(),
    comparison: z.record(z.string(), z.unknown()).optional(),
    purchaseReview: z.record(z.string(), z.unknown()).optional(),
    // AI-F02: capability reads and prepare reviews; every list is server-built and party-scoped.
    inventory: z.array(z.record(z.string(), z.unknown())).max(12).optional(),
    inquiries: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
    orders: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
    cart: z.array(z.record(z.string(), z.unknown())).max(24).optional(),
    checkout: z.record(z.string(), z.unknown()).optional(),
    fulfillment: z.record(z.string(), z.unknown()).optional(),
    preparedAction: z
      .object({
        actionId: z.string(),
        action: z.string(),
        targetResource: z.string(),
      })
      .optional(),
    preparedDraft: z.object({ draftId: z.string().optional() }).optional(),
    commerce: z.record(z.string(), z.unknown()).optional(),
    tutorial: TutorialPayloadSchema.optional(),
    photoSuggestionStatus: z.enum([
      "UNAVAILABLE",
      "FAILED",
      "NO_SUGGESTIONS",
      "SUGGESTIONS",
    ]).optional(),
    photoSuggestions: z.array(PhotoSuggestionSchema).max(12).optional(),
    photoSuggestionUncertainties: z
      .array(z.enum(LISTING_PHOTO_UNCERTAINTIES))
      .max(LISTING_PHOTO_UNCERTAINTIES.length)
      .optional(),
    employment: z.record(z.string(), z.unknown()).optional(),
    delivery: z.record(z.string(), z.unknown()).optional(),
    promotion: z.record(z.string(), z.unknown()).optional(),
    driver: z.record(z.string(), z.unknown()).optional(),
    provider: z.record(z.string(), z.unknown()).optional(),
    advice: z.record(z.string(), z.unknown()).optional(),
    policyReview: z.object({
      view: z.enum(["REVIEW", "ACCEPTED", "DECLINED", "CURRENT"]),
      reviewId: z.string().uuid().optional(),
      policies: z.array(z.object({
        key: z.string().max(60), version: z.string().max(40), title: z.string().max(120), effectiveDate: z.string().max(20),
        path: z.string().regex(/^\/policies\/[a-z0-9-]{1,60}$/u), legalReviewPending: z.boolean(), accepted: z.boolean(),
      }).strict()).max(12),
      optionalConsentsUnaffected: z.literal(true),
    }).strict().optional(),
    memory: z.object({ view: z.enum(["MY_INTERESTS", "MEMORY_SUMMARY", "MEMORY_CONFIRMATION", "MEMORY_UPDATED"]), groups: z.array(z.object({ label: z.string().max(80), items: z.array(z.object({ topic: z.string().max(80), label: z.string().max(120), reason: z.string().max(160) })).max(12) })).max(6) }).optional(),
    negotiation: z.record(z.string(), z.unknown()).optional(),
    inquiry: z.record(z.string(), z.unknown()).optional(),
    control: ProductControlPayload.optional(),
    business: z.record(z.string(), z.unknown()).optional(),
    relatesToAction: z.string().uuid().optional(),
    listings: z.array(z.record(z.string(), z.unknown())),
    surface: conversationSurfaceTokenSchema,
    card: CardEnvelopeSchema.optional(),
  }),
});
const ListingBlock = z.object({
  type: z.literal("LISTING_RESULTS"),
  version: z.literal(1),
  payload: z.object({
    resultSetId: z.string().uuid(),
    resourceIds: z.array(z.string().min(1).max(200)).max(24).optional(),
    searchState: SearchStateSchema.optional(),
    presentation: Presentation.optional(),
    listings: z.array(z.record(z.string(), z.unknown())),
    card: CardEnvelopeSchema.optional(),
  }),
});
const GuestAiPreviewResponse = z
  .object({
    body: z.string().max(7000),
    blocks: z
      .array(
        z
          .object({
            type: z.enum(["LISTING_RESULTS", "SURFACE"]),
            version: z.literal(1),
            payload: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(24),
    requiresAuth: z.boolean().optional(),
    query: z.string().max(200).optional(),
    searchState: SearchStateSchema.optional(),
  })
  .strict();
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

function recommendationText(query: Record<string, unknown>, count: number) {
  const stored = query.recommendation as { anchorTitle?: unknown; cheaper?: unknown };
  const anchor = typeof stored.anchorTitle === "string" ? `«${stored.anchorTitle}»` : "";
  const location = query.nearbyUnavailable
    ? " لا أستخدم موقعك؛ اختر عرضًا أو مدينة لأقترح ما هو قريب منها."
    : "";
  if (!count)
    return `${anchor ? `لم أجد بدائل مناسبة لـ${anchor}` : "لم أجد اقتراحات مناسبة"}${stored.cheaper ? " بسعر أقل" : ""} في عروض DINAR الحالية.${location}`;
  return `${anchor ? `اقتراحات مشابهة لـ${anchor}` : "اقتراحات من عروض DINAR"}${stored.cheaper ? " بسعر أقل" : ""} (${count}). سبب كل اقتراح ظاهر على بطاقته، والعروض الممولة تحمل شارة «إعلان ممول».${location}`;
}
const NEW_CONVERSATION_TITLE = "محادثة جديدة";

function requestData<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw fail(400, "بيانات الطلب غير صالحة");
  return parsed.data;
}

function send(res: any, value: unknown) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function conversationView(row: typeof conversations.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    marketId: row.marketId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ownedConversation(req: any, id: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, id),
        eq(conversations.ownerUserId, req.actor!.id),
        eq(conversations.kind, "AI"),
      ),
    );
  if (!row) throw fail(404, "المحادثة غير موجودة");
  // The conversation's original market is its isolated tool context. A user may still
  // continue ordinary chat after changing markets; its marketplace actions never drift
  // into another market's result sets.
  const market = await marketFor({ actor: { activeMarketId: row.marketId } });
  return { conversation: row, market };
}

async function freshBlocksForConversation(
  conversationId: string,
  market: Awaited<ReturnType<typeof marketFor>>,
  rows: (typeof aiUiBlocks.$inferSelect)[],
  actorId: string,
) {
  const surfaceBlocks = rows.flatMap((row) => {
    const parsed = SurfaceBlock.safeParse({
      type: row.blockType,
      version: row.version,
      payload: row.payload,
    });
    return parsed.success
      ? [{ messageId: row.messageId, createdAt: row.createdAt, block: parsed.data }]
      : [];
  });
  const surfaceMap = new Map<string, any[]>();
  for (const item of surfaceBlocks)
    surfaceMap.set(item.messageId, [
      ...(surfaceMap.get(item.messageId) ?? []),
      item.block,
    ]);
  // Employment blocks re-validate against live state: hidden profiles, unavailable
  // jobs and settled pending actions are never shown as they were.
  const employmentBlocks = surfaceBlocks.filter((item) => item.block.payload.employment);
  if (employmentBlocks.length) {
    const sets = await db
      .select({ id: aiResultSets.id, query: aiResultSets.query })
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.conversationId, conversationId),
          eq(aiResultSets.marketId, market.id),
          inArray(aiResultSets.id, employmentBlocks.map((item) => item.block.payload.resultSetId)),
        ),
      );
    const queries = new Map(sets.map((set) => [set.id, set.query]));
    for (const item of employmentBlocks) {
      const refreshed = await refreshEmploymentPayload(item.block.payload as Record<string, unknown>, {
        actorId,
        market,
        query: queries.get(item.block.payload.resultSetId),
      });
      item.block.payload.employment = refreshed.employment as Record<string, unknown>;
    }
  }
  // Delivery blocks are rebuilt from their state row and live order authorization;
  // stored copies never hold coordinates or address text.
  const deliveryBlocks = surfaceBlocks.filter((item) => item.block.payload.delivery);
  if (deliveryBlocks.length) {
    const sets = await db
      .select({ id: aiResultSets.id, query: aiResultSets.query, expiresAt: aiResultSets.expiresAt })
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.conversationId, conversationId),
          eq(aiResultSets.marketId, market.id),
          inArray(aiResultSets.id, deliveryBlocks.map((item) => item.block.payload.resultSetId)),
        ),
      );
    const byId = new Map(sets.map((set) => [set.id, set]));
    for (const item of deliveryBlocks) {
      const set = byId.get(item.block.payload.resultSetId);
      item.block.payload.delivery = await refreshDeliveryPayload(item.block.payload as Record<string, unknown>, {
        actorId,
        market,
        query: set?.query,
        expiresAt: set?.expiresAt,
      });
    }
  }
  // Driver blocks show the profile, review and assignment state as they are now (Block F4).
  const driverBlocks = surfaceBlocks.filter((item) => item.block.payload.driver);
  if (driverBlocks.length && actorId) {
    const sets = await db
      .select()
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.conversationId, conversationId),
          eq(aiResultSets.marketId, market.id),
          inArray(aiResultSets.id, driverBlocks.map((item) => item.block.payload.resultSetId)),
        ),
      );
    const byId = new Map(sets.map((set) => [set.id, set]));
    for (const item of driverBlocks) {
      const set = byId.get(item.block.payload.resultSetId);
      item.block.payload.driver = await refreshDriverPayload(item.block.payload as Record<string, unknown>, {
        actorId,
        market,
        query: set?.query,
        expiresAt: set?.expiresAt,
      });
    }
  }
  // D3-A business cards are rebuilt from the owner's live rows; a business that is no longer
  // theirs (or no longer exists in this market) is dropped rather than shown stale.
  const businessBlocks = surfaceBlocks.filter((item) => item.block.payload.business);
  for (const item of businessBlocks) {
    const refreshed = await refreshBusinessPayload(
      item.block.payload.business as unknown as BusinessPayload,
      conversationId,
      actorId,
      market,
    );
    if (refreshed) item.block.payload.business = refreshed as Record<string, unknown>;
    else item.block.payload.business = undefined;
  }
  // Promotion blocks are rebuilt from their state row and live campaign/listing state.
  const promotionBlocks = surfaceBlocks.filter((item) => item.block.payload.promotion);
  if (promotionBlocks.length) {
    const sets = await db
      .select()
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.conversationId, conversationId),
          eq(aiResultSets.marketId, market.id),
          inArray(aiResultSets.id, promotionBlocks.map((item) => item.block.payload.resultSetId)),
        ),
      );
    const byId = new Map(sets.map((set) => [set.id, set]));
    for (const item of promotionBlocks) {
      const set = byId.get(item.block.payload.resultSetId);
      item.block.payload.promotion = await refreshPromotionPayload(item.block.payload as Record<string, unknown>, {
        actorId,
        market,
        query: set?.query,
        resourceIds: set?.resourceIds,
        expiresAt: set?.expiresAt,
      });
    }
  }
  // Commercial blocks (balance, reviews, campaigns, Market Pulse) are rebuilt from live state.
  const commerceBlocks = surfaceBlocks.filter((item) => item.block.payload.commerce);
  if (commerceBlocks.length) {
    const sets = await db
      .select()
      .from(aiResultSets)
      .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, market.id), inArray(aiResultSets.id, commerceBlocks.map((item) => item.block.payload.resultSetId))));
    const byId = new Map(sets.map((set) => [set.id, set]));
    for (const item of commerceBlocks) {
      const set = byId.get(item.block.payload.resultSetId);
      item.block.payload.commerce = await refreshCommercePayload(item.block.payload as Record<string, unknown>, {
        actorId,
        market,
        query: set?.query,
        resourceIds: set?.resourceIds,
        expiresAt: set?.expiresAt,
      });
    }
  }
  // Negotiation views are rebuilt from the negotiation authority for this party only.
  const negotiationBlocks = surfaceBlocks.filter((item) => item.block.payload.negotiation);
  for (const item of negotiationBlocks)
    item.block.payload.negotiation = await refreshNegotiationPayload(item.block.payload.negotiation as Record<string, unknown>, actorId);
  // Inquiry views are rebuilt from the inquiry authority for this party only; opening an
  // incoming message or a thread status is the recipient's read receipt.
  const inquiryBlocks = surfaceBlocks.filter((item) => item.block.payload.inquiry);
  for (const item of inquiryBlocks)
    item.block.payload.inquiry = await refreshInquiryPayload(item.block.payload.inquiry as Record<string, unknown>, actorId, market);
  // Product-control cards show the device's acknowledgement or their pending action's status.
  for (const item of surfaceBlocks.filter((entry) => entry.block.payload.control)) {
    const control = await refreshControlPayload(item.block.payload.control, item.block.payload.resultSetId, conversationId);
    if (control) item.block.payload.control = control;
    else delete item.block.payload.control;
  }
  // Purchase reviews show the current status of their F0 pending action.
  const purchaseBlocks = surfaceBlocks.filter((item) => item.block.payload.purchaseReview);
  if (purchaseBlocks.length) {
    const sets = await db
      .select()
      .from(aiResultSets)
      .where(and(eq(aiResultSets.conversationId, conversationId), inArray(aiResultSets.id, purchaseBlocks.map((item) => item.block.payload.resultSetId))));
    const byId = new Map(sets.map((set) => [set.id, set]));
    for (const item of purchaseBlocks) {
      const set = byId.get(item.block.payload.resultSetId);
      item.block.payload.purchaseReview = await refreshPurchaseReview(item.block.payload.purchaseReview!, set?.query, set?.expiresAt);
    }
  }
  const previewBlocks = surfaceBlocks.filter(
    (item) => item.block.payload.managementPreview,
  );
  if (previewBlocks.length) {
    const previewIds = previewBlocks.map(
      (item) => item.block.payload.managementPreview!.previewId,
    );
    const previewSets = await db
      .select({ id: aiResultSets.id, query: aiResultSets.query })
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.conversationId, conversationId),
          eq(aiResultSets.marketId, market.id),
          inArray(aiResultSets.id, previewIds),
        ),
      );
    const statusById = new Map(
      previewSets.flatMap((set) => {
        const status = parseStoredListingManagementPreviewStatus(set.query);
        return status ? [[set.id, status] as const] : [];
      }),
    );
    for (const item of previewBlocks) {
      const preview = item.block.payload.managementPreview!;
      const status = statusById.get(preview.previewId);
      if (status) preview.status = status;
    }
  }
  // The card envelope is recomputed from the refreshed records, never replayed from the stored
  // copy: a confirmed, cancelled or expired review changes the card on the next read.
  const cardSetIds = [...new Set(surfaceBlocks.map((item) => item.block.payload.resultSetId))];
  const cardExpiry = new Map<string, Date | null>();
  if (cardSetIds.length) {
    const cardSets = await db
      .select({ id: aiResultSets.id, expiresAt: aiResultSets.expiresAt })
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.conversationId, conversationId),
          inArray(aiResultSets.id, cardSetIds),
        ),
      );
    for (const set of cardSets) cardExpiry.set(set.id, set.expiresAt);
  }
  for (const item of surfaceBlocks) {
    item.block.payload.card = buildCardEnvelope({
      conversationId,
      marketId: market.id,
      currency: market.currencyCode,
      token: item.block.payload.surface,
      resultSetId: item.block.payload.resultSetId,
      payload: item.block.payload as unknown as Record<string, unknown>,
      sourceTimestamp: item.createdAt,
      expiresAt: cardExpiry.get(item.block.payload.resultSetId),
    }) ?? undefined;
  }
  const parsedBlocks = rows.flatMap((row) => {
    const payload = StoredBlockPayload.safeParse(row.payload);
    if (
      !payload.success ||
      row.blockType !== "LISTING_RESULTS" ||
      row.version !== 1
    )
      return [];
    return [{ row, payload: payload.data }];
  });
  const resultSetIds = [
    ...new Set(parsedBlocks.map(({ payload }) => payload.resultSetId)),
  ];
  if (resultSetIds.length) {
    const resultSets = await db
      .select()
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.conversationId, conversationId),
          eq(aiResultSets.marketId, market.id),
          inArray(aiResultSets.id, resultSetIds),
        ),
      );
    const setsById = new Map(
      resultSets.map((resultSet) => [resultSet.id, resultSet]),
    );

    for (const { row, payload } of parsedBlocks) {
      const resultSet = setsById.get(payload.resultSetId);
      if (
        !resultSet ||
        (resultSet.expiresAt && resultSet.expiresAt.getTime() <= Date.now()) ||
        payload.resourceIds.some((id) => !resultSet.resourceIds.includes(id))
      )
        continue;

      // A stored empty result is a real empty state; a non-empty one whose listings all
      // disappeared since is dropped rather than shown as a misleading empty search.
      const listings = payload.resourceIds.length
        ? await decoratePaidCards(
            decorateStoredResults(
              await searchMarketplaceListings(market, {
                search: "",
                allowedIds: payload.resourceIds,
                sponsoredIds: storedSponsoredIds(resultSet.query),
                limit: 24,
              }),
              resultSet.query,
            ),
            resultSet.query,
            { actorId, marketId: market.id, resultSetId: resultSet.id },
          )
        : [];
      if (payload.resourceIds.length && !listings.length) continue;
      const block = ListingBlock.parse({
        type: row.blockType,
        version: row.version,
        payload: {
          resultSetId: payload.resultSetId,
          resourceIds: listings.map((listing) => listing.id),
          searchState: payload.searchState,
          ...(payload.presentation ? { presentation: payload.presentation } : {}),
          listings,
          card: buildCardEnvelope({
            conversationId,
            marketId: market.id,
            currency: market.currencyCode,
            presentation: payload.presentation,
            resultSetId: payload.resultSetId,
            payload: {
              resourceIds: listings.map((listing) => listing.id),
              ...(payload.presentation ? { presentation: payload.presentation } : {}),
              ...(payload.searchState ? { searchState: payload.searchState } : {}),
            },
            sourceTimestamp: row.createdAt,
            expiresAt: resultSet.expiresAt,
          }) ?? undefined,
        },
      });
      const current = surfaceMap.get(row.messageId) ?? [];
      current.push(block);
      surfaceMap.set(row.messageId, current);
    }
  }
  return surfaceMap;
}

/**
 * Paid cards carry their VIP tier and an opaque, signed attribution token bound to this
 * viewer, market and result set. The campaign behind a slot is server state only.
 */
async function decoratePaidCards(
  listings: ListingRecord[],
  query: unknown,
  context: { actorId?: string; marketId: string; resultSetId: string },
): Promise<ListingRecord[]> {
  const stored = ((query as { sponsoredCampaigns?: unknown } | null)?.sponsoredCampaigns ?? {}) as Record<string, { promotionId?: unknown; placement?: unknown }>;
  return Promise.all(
    listings.map(async (listing) => {
      if (!listing.isSponsored) return listing;
      const promotionId = typeof stored[listing.id]?.promotionId === "string" ? String(stored[listing.id]!.promotionId) : listing.sponsoredCampaignId;
      const placement = typeof stored[listing.id]?.placement === "string" ? String(stored[listing.id]!.placement) : listing.sponsoredPlacement;
      const decorated: ListingRecord = { ...listing, sponsoredTier: placement === "VIP" ? "VIP" : "STANDARD" };
      if (promotionId && placement && context.actorId)
        decorated.sponsoredToken = await mintAttributionToken({ promotionId, listingId: listing.id, placement, resultSetId: context.resultSetId, marketId: context.marketId, viewerUserId: context.actorId });
      return decorated;
    }),
  );
}

async function attributeEngagement(req: any, conversationId: string, market: Awaited<ReturnType<typeof marketFor>>, listingIds: string[], kind: EngagementKind) {
  if (!req.actor?.id || !listingIds.length) return;
  try {
    await recordConversationEngagement({ conversationId, market, viewerUserId: req.actor.id, listingIds, kind });
  } catch (error) {
    req.log.warn({ event: "engagement_attribution_failed", kind, err: error instanceof Error ? error.message : "unknown" }, "engagement attribution skipped");
  }
}

function sendGuestPreview(res: any, value: unknown) {
  return res.json(GuestAiPreviewResponse.parse(value));
}

const OPEN_GUEST_SELLER_QUESTION =
  /[؟?]|(?:^|\s)(?:شو|وش|ايش|شنو|ماذا|كيف|ليش|لماذا|هل|what|which|why|how|where|when)(?=\s|$)/iu;
const GUEST_SELLER_INTENT =
  /(?:\b(?:sell|selling|list|listing|post|advertise)\b|للبيع|ابيع|بيع|اعرض|انشر)/iu;
const GUEST_SELL_REQUEST =
  /(?:\b(?:sell(?:ing)?|advertis(?:e|ing)|post(?:ing)?)\b|\blist(?:ing)?\s+(?:my|a|an|this|the)\b|للبيع|ابيع|بيع|اعرض|انشر)/iu;
const GUEST_BUY_INTENT =
  /(?:^|\s)(?:ابي|ابغى|اريد|بدي|احتاج)\s*(?:ان\s*)?(?:اشتري|شراء|اطلب)|(?:^|\s)(?:اشتري|شراء|اطلب)(?=\s|$)/u;
const GUEST_NEGOTIATION_OFFER_INTENT =
  /^(?:ارسل|ارسله|قدم)\s+(?:العرض|عرض|عرضي|عرضا)(?:\s|$)|(?:^|\s)(?:قله|قلها|قول\s+له|قول\s+لها)\s*(?:اعطيه|أعطيه|اعطيها|أعطيها|اعرض\s+عليه|أعرض\s+عليه)\s*\d+(?:[.,]\d+)?|(?:^|\s)(?:اعطيه|أعطيه|اعطيها|أعطيها)\s*\d+(?:[.,]\d+)?/u;
const GUEST_PRIVATE_SURFACES = new Set([
  "ORDERS",
  "ORDER",
  "ORDERS_LIST",
  "ORDER_SELECTOR",
  "ORDER_STATUS",
  "ORDER_TRACKING",
  "MY_LISTINGS",
  "DUES",
]);

function marketSelectionPreview(
  market: Awaited<ReturnType<typeof marketFor>>,
  unselected = false,
) {
  return {
    body: unselected
      ? "اختر سوقًا متاحًا للمتابعة."
      : `سوق ${market.countryNameAr} غير متاح حاليًا. اختر سوقًا متاحًا للمتابعة.`,
    blocks: [
      {
        type: "SURFACE" as const,
        version: 1 as const,
        payload: {
          resultSetId: randomUUID(),
          listings: [],
          surface: "MARKET_SELECTOR",
        },
      },
    ],
  };
}

function guestUsageMeasurement(outcome: Awaited<ReturnType<typeof executeGuestModelTurn>>): AiUsageMeasurement {
  if (!outcome) return { outcome: "CANCELLED", providerCalls: 0 };
  const call = outcome.modelCall;
  return {
    outcome: outcome.ok ? "SUCCESS" : outcome.reason === "TIMEOUT" ? "TIMEOUT" : outcome.reason === "MALFORMED" || outcome.reason === "UNKNOWN_ACTION" ? "INVALID_OUTPUT" : "PROVIDER_FAILED",
    // A gateway that could not be created made no provider call.
    providerCalls: call.providerCalls ?? 0,
    ...(call.usage ? call.usage : {}),
    ...(call.provider ? { provider: call.provider } : {}),
    ...(call.actualModel ?? call.requestedModel ? { model: call.actualModel ?? call.requestedModel } : {}),
    ...(call.calls?.length ? { calls: call.calls } : {}),
  };
}

// Guest turns share the conversation model, but use bounded, market-scoped history and
// the same read-only marketplace search authority as the authenticated experience.
router.post(
  "/ai/voice-transcription",
  express.raw({
    type: ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"],
    limit: "10mb",
  }),
  async (req, res): Promise<void> => {
    if (!enabled()) {
      res.status(404).json({ error: "هذه الميزة غير متاحة" });
      return;
    }
    const mimeType = req.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (
      !["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"].includes(mimeType ?? "") ||
      !Buffer.isBuffer(req.body) ||
      req.body.length === 0
    ) {
      res.status(400).json({ error: "تعذر قراءة التسجيل الصوتي." });
      return;
    }
    let limited: Awaited<ReturnType<typeof consumeRateLimit>>;
    try {
      limited = await consumeRateLimit(
        [{
          scope: AUTH_RATE_LIMIT_SCOPE.guestAiPreview,
          value: normalizeClientIp(req.ip || req.socket.remoteAddress || ""),
        }],
        900,
        8,
      );
    } catch {
      res.setHeader("Retry-After", "30");
      res.status(503).json({ error: "التفريغ الصوتي غير متاح مؤقتًا." });
      return;
    }
    if (limited) {
      res.setHeader("Retry-After", String(limited.retryAfterSeconds));
      res.status(429).json({ error: "طلبات صوتية كثيرة. حاول لاحقًا." });
      return;
    }
    // Voice input is a paid provider call like any other: allowance, spend hold, then settle.
    const market = await marketFor(req);
    const owner: AiUsageOwner = req.actor
      ? { kind: "USER", userId: req.actor.id, market }
      : { kind: "GUEST", guestKey: guestUsageKey(normalizeClientIp(req.ip || req.socket.remoteAddress || "")), market };
    const reserved = await reserveAiUsage({ owner, resource: "AUDIO_TRANSCRIPTION", idempotencyKey: `voice:${randomUUID()}`, expectedModel: VOICE_TRANSCRIPTION_MODEL });
    if (!reserved.ok) {
      res.status(429).json({ error: usageLimitMessage(reserved, undefined, { plansConfigured: false, planHintAlreadyShown: true }), code: reserved.reason });
      return;
    }
    try {
      const transcription = await transcribeVoiceRecording(req.body, mimeType).catch(async (error) => {
        const reachedProvider = !(error instanceof AIProviderError && error.code === "NOT_CONFIGURED" && !error.httpStatus);
        await settleAiUsage(reserved.reservation.id, {
          outcome: "PROVIDER_FAILED",
          providerCalls: reachedProvider ? 1 : 0,
          ...(reachedProvider ? { calls: [{ kind: "PRIMARY" as const, outcome: "FAILED" as const, ...VOICE_TRANSCRIPTION_MODEL, unitsUnreported: true }] } : {}),
        }).catch(() => undefined);
        throw error;
      });
      await settleAiUsage(reserved.reservation.id, {
        outcome: transcription.text ? "SUCCESS" : "INVALID_OUTPUT",
        providerCalls: 1,
        ...VOICE_TRANSCRIPTION_MODEL,
        calls: [{
          kind: "PRIMARY",
          outcome: "SUCCESS",
          ...VOICE_TRANSCRIPTION_MODEL,
          ...(transcription.durationSeconds !== undefined ? { audioSeconds: transcription.durationSeconds } : { unitsUnreported: true }),
        }],
      });
      const transcript = transcription.text;
      if (!transcript) {
        res.status(400).json({ error: "لم أتمكن من فهم التسجيل. حاول تسجيله مجددًا." });
        return;
      }
      res.json(
        TranscribeAiVoiceMessageResponse.parse({
          transcript: transcript.slice(0, 4000),
        }),
      );
    } catch (error) {
      req.log.warn(
        { code: error instanceof AIProviderError ? error.code : "TRANSCRIPTION_FAILED" },
        "DINAR voice transcription failed",
      );
      res.status(503).json({ error: "تعذر تحويل التسجيل الصوتي الآن. حاول مجددًا لاحقًا." });
    }
  },
);

router.post("/ai/preview", async (req, res) => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  let rateDecision: Awaited<ReturnType<typeof consumeRateLimit>>;
  try {
    rateDecision = await consumeRateLimit(
      [
        {
          scope: AUTH_RATE_LIMIT_SCOPE.guestAiPreview,
          value: normalizeClientIp(req.ip || req.socket.remoteAddress || ""),
        },
      ],
      900,
    );
  } catch {
    res.setHeader("Retry-After", "30");
    throw fail(503, "المحادثة غير متاحة مؤقتًا");
  }
  if (rateDecision) {
    res.setHeader("Retry-After", String(rateDecision.retryAfterSeconds));
    throw fail(429, "طلبات كثيرة. حاول لاحقًا.");
  }

  const {
    message,
    marketId,
    reasoningEffort,
    history = [],
    earlierUserTopics = [],
    query: previous,
    resourceIds,
    searchState: previousState,
  } = requestData(
    z
      .object({
        message: z.string().trim().min(1).max(2000),
        marketId: z.string().trim().min(1).max(32),
        reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
        history: z
          .array(
            z
              .object({
                actor: z.enum(["USER", "ASSISTANT"]),
                body: z.string().max(1200),
              })
              .strict(),
          )
          .max(10)
          .optional(),
        // Topic hints only: read by the model turn below, never by routing or authorization.
        earlierUserTopics: z.array(z.string().trim().min(1).max(160)).max(6).optional(),
        query: z.string().max(200).optional(),
        resourceIds: z.array(z.string().max(200)).max(24).optional(),
        searchState: SearchStateSchema.optional(),
      })
      .strict(),
    req.body,
  );
  const market = await marketFor(req);
  if (market.id !== marketId)
    throw fail(409, "تغيّر السوق؛ لم أستخدم سياق المحادثة السابق.");
  const marketAvailable = isMarketAvailable(market);
  const surface = surfaceIntent(message);
  const explicitGuestSell =
    surface === "SELL" ||
    GUEST_SELL_REQUEST.test(normalizeSearch(message));
  const sellerAdviceQuestion =
    explicitGuestSell && OPEN_GUEST_SELLER_QUESTION.test(message);
  const guestSurface =
    surface ?? (explicitGuestSell && !sellerAdviceQuestion ? "SELL" : undefined);
  const marketBoundIntent =
    (guestSurface === "SELL" && !sellerAdviceQuestion) ||
    surface === "CART" ||
    surface === "CHECKOUT" ||
    hasExplicitMarketplaceSearchIntent(message) ||
    GUEST_BUY_INTENT.test(normalizeSearch(message));
  if (!req.actor && !req.cookies?.[GUEST_MARKET_COOKIE] && marketBoundIntent)
    return sendGuestPreview(res, marketSelectionPreview(market, true));
  if (!marketAvailable && marketBoundIntent)
    return sendGuestPreview(res, marketSelectionPreview(market));
  if (!req.actor && GUEST_NEGOTIATION_OFFER_INTENT.test(normalizeSearch(message)))
    return sendGuestPreview(res, {
      body: "سجّل الدخول أولًا لإرسال عرض سعر؛ لن يُرسل أي عرض قبل التحقق من حسابك ومراجعة المبلغ.",
      requiresAuth: true,
      blocks: [
        {
          type: "SURFACE",
          version: 1,
          payload: {
            resultSetId: randomUUID(),
            listings: [],
            surface: "AUTH",
          },
        },
      ],
    });
  const hasSearchContext = Boolean(
    previous || previousState || resourceIds?.length,
  );
  // After a search, a message refines it only when it reads as a refinement (filter, sort,
  // category or position); «ارجع لموضوع الطاقة» or «اشرح لي …» is a general turn again.
  const refinesSearch =
    resultPosition(message) !== undefined ||
    parseStructuredSearch(message, previousState ?? { search: previous ?? "", filters: [] }) !== undefined;
  const generalTurn =
    sellerAdviceQuestion ||
    (!guestSurface &&
      !hasExplicitMarketplaceSearchIntent(message) &&
      (!hasSearchContext ||
        GUEST_SELLER_INTENT.test(normalizeSearch(message)) ||
        (isGeneralRequest(message) && !refinesSearch)));
  let modelSearchQuery: string | undefined;

  if (guestSurface && !sellerAdviceQuestion) {
    const privateSurface = GUEST_PRIVATE_SURFACES.has(guestSurface);
    return sendGuestPreview(res, {
      body:
        privateSurface
          ? "سجّل الدخول لعرض سجلاتك الخاصة ومتابعة ما يخصك."
          : guestSurface === "UNSUPPORTED"
          ? "هذه الخدمة المتخصصة غير متاحة حاليًا."
          : "تفضل، تابع من البطاقة.",
      ...(guestSurface === "SELL" || privateSurface
        ? { requiresAuth: true }
        : {}),
      blocks: [
        {
          type: "SURFACE",
          version: 1,
          payload: {
            resultSetId: randomUUID(),
            listings: [],
            surface: guestSurface,
            ...(guestSurface === "SELL" ? { guestSellerIntent: true } : {}),
          },
        },
      ],
    });
  }

  if (generalTurn) {
    // G1: guests have their own small allowance keyed by an HMAC of the client address; it is
    // never merged into an account after sign-in (the account starts its own FREE allowance).
    const guestOwner = { kind: "GUEST" as const, guestKey: guestUsageKey(normalizeClientIp(req.ip || req.socket.remoteAddress || "")), market };
    const reserved = await reserveAiUsage({ owner: guestOwner, resource: "TEXT_REQUEST", idempotencyKey: `guest:${randomUUID()}` });
    if (!reserved.ok)
      return sendGuestPreview(res, {
        body: usageLimitMessage(reserved, undefined, { plansConfigured: false, planHintAlreadyShown: true }),
        blocks: [],
      });
    let outcome: Awaited<ReturnType<typeof executeGuestModelTurn>>;
    try {
      outcome = await executeGuestModelTurn(
        { market, message, history, earlierUserTopics, reasoningEffort },
        (req.app.locals as { conversationModelGateway?: ConversationModelGateway })
          .conversationModelGateway,
      );
    } catch (error) {
      await settleAiUsage(reserved.reservation.id, { outcome: "PROVIDER_FAILED", providerCalls: 1 }).catch(() => undefined);
      throw error;
    }
    await settleAiUsage(reserved.reservation.id, guestUsageMeasurement(outcome));
    if (!outcome)
      return sendGuestPreview(res, {
        body: modelFailureMessage("NOT_CONFIGURED"),
        blocks: [],
      });
    if (!outcome.ok)
      return sendGuestPreview(res, {
        body: modelFailureMessage(outcome.reason),
        blocks: [],
      });
    if (outcome.toolRequest)
      return sendGuestPreview(res, {
        body: modelFailureMessage("MALFORMED"),
        blocks: [],
      });

    const turn = outcome.turn;
    const isSearchSuggestion =
      turn.suggestedAction === "SEARCH_LISTINGS" ||
      turn.responseKind === "SEARCH_INTENT";
    if (isSearchSuggestion) {
      if (!marketAvailable)
        return sendGuestPreview(res, marketSelectionPreview(market));
      const item = turn.entities?.item?.trim();
      const normalizedItem = item ? normalizeSearch(item) : "";
      if (
        !item ||
        normalizedItem.length < 2 ||
        !normalizeSearch(message).includes(normalizedItem) ||
        turn.confidence < 0.65
      )
        return sendGuestPreview(res, {
          body: "ما المنتج الذي تريد البحث عنه داخل عروض DINAR؟",
          blocks: [],
        });
      modelSearchQuery = item;
    } else if (
      turn.suggestedAction === "CREATE_LISTING_DRAFT" &&
      isGroundedSellerDraftRequest(message, turn)
    ) {
      if (!marketAvailable)
        return sendGuestPreview(res, marketSelectionPreview(market));
      return sendGuestPreview(res, {
        body: "سجّل الدخول لإكمال مسودة الإعلان. لم ننشئ إعلانًا ولم ننشر شيئًا.",
        requiresAuth: true,
        blocks: [
          {
            type: "SURFACE",
            version: 1,
            payload: {
              resultSetId: randomUUID(),
              listings: [],
              surface: "SELL",
              guestSellerIntent: true,
            },
          },
        ],
      });
    } else if (turn.suggestedAction === "CREATE_LISTING_DRAFT") {
      return sendGuestPreview(res, {
        body: "لم أبدأ مسودة إعلان. إذا أردت إعداد إعلان، اذكر الغرض الذي تريد عرضه.",
        blocks: [],
      });
    } else if (
      turn.suggestedAction &&
      turn.suggestedAction !== "NONE"
    ) {
      return sendGuestPreview(res, {
        body: "سجّل الدخول لمراجعة هذا الإجراء. لم يُنفّذ أي إجراء.",
        requiresAuth: true,
        blocks: [],
      });
    } else {
      return sendGuestPreview(res, {
        // A guest has no ledger at all: model text that reports a commercial outcome is withheld.
        body: ((turn.goal === "BUY" || turn.goal === "SELL" || turn.goal === "NEGOTIATE") ? claimsCompletedAction(turn.conversationalReply) : claimsUsersCompletedAction(turn.conversationalReply))
          ? MODEL_CLAIM_WITHHELD
          : turn.conversationalReply,
        blocks: [],
      });
    }
  }

  if (!marketAvailable)
    return sendGuestPreview(res, marketSelectionPreview(market));
  const [categoryRows, knownCities] = await Promise.all([
    listMarketplaceCategories(),
    publishedListingCities(market.id),
  ]);
  const categories = categoryRows.map(categorySchema);
  const previousStructured = previousState ?? {
    search: previous ?? "",
    filters: [],
  };
  const structured = parseStructuredSearch(
    message,
    previousStructured,
    categories,
    { knownCities },
  );
  const parsedQuery = structured?.search ?? contextualQuery(message, previous);
  const query = modelSearchQuery ?? parsedQuery;
  const position = resultPosition(message);
  if (
    (!structured && position === undefined && isVagueRequest(message)) ||
    (!query &&
      !structured?.categoryId &&
      !previousState?.categoryId &&
      !structured?.filters.length) ||
    /^(شيء|خدمة|اشتري|شراء)$/.test(query)
  ) {
    return sendGuestPreview(res, {
      body: "ما المنتج أو الخدمة التي تحتاجها؟ اذكر النوع والمواصفات لنبحث في السوق.",
      blocks: [],
    });
  }
  const reference =
    position === undefined ? undefined : resourceIds?.[position];
  const keepPrevious = Boolean(
    previousState && (query === previous || reference !== undefined),
  );
  const activeSearchState =
    structured
      ? { ...structured, search: query }
      : reference && previousState
        ? previousState
        : {
            search: query,
            ...(keepPrevious && previousState?.categoryId
              ? { categoryId: previousState.categoryId }
              : {}),
            filters: keepPrevious ? previousState?.filters ?? [] : [],
            ...(keepPrevious && previousState?.sort
              ? { sort: previousState.sort }
              : {}),
          };
  const runPreview = (search: string) =>
    searchMarketplaceListings(
      market,
      reference
        ? { allowedIds: [reference], limit: 1 }
        : {
            search,
            conversational: true,
            categoryId: activeSearchState.categoryId,
            filters: activeSearchState.filters,
            sort: activeSearchState.sort,
          },
    );
  let listings = await runPreview(activeSearchState.search);
  if (!listings.length && !reference && activeSearchState.categoryId) {
    const { aliasWords, remaining } = categoryAliasWords(
      categories.find((category) => category.id === activeSearchState.categoryId),
      activeSearchState.search,
    );
    if (aliasWords.length) listings = await runPreview(remaining);
  }
  return sendGuestPreview(res, {
    query: reference ? previous : query,
    searchState: activeSearchState,
    body: listings.length
      ? `وجدت ${listings.length} نتيجة في سوقك.`
      : "لم أجد عروضًا مطابقة في السوق الحالي. جرّب اسم المنتج ومواصفاته. سجّل الدخول لحفظ المحادثة ومتابعة البحث بسياقه.",
    blocks: [
      {
        type: "LISTING_RESULTS",
        version: 1,
        payload: {
          resultSetId: randomUUID(),
          resourceIds: listings.map((listing) => listing.id),
          searchState: activeSearchState,
          ...(reference ? { presentation: "DETAILS" } : {}),
          listings,
        },
      },
    ],
  });
});

router.post("/ai/conversations", requireAuth, async (req, res) => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const market = await marketFor(req);
  const [row] = await db
    .insert(conversations)
    .values({
      id: randomUUID(),
      orderId: null,
      ownerUserId: req.actor!.id,
      marketId: market.id,
      kind: "AI",
      title: NEW_CONVERSATION_TITLE,
    })
    .returning();
  res
    .status(201)
    .json(CreateAiConversationResponse.parse(conversationView(row)));
});

router.post("/ai/conversations/:id/copies", requireAuth, async (req, res): Promise<void> => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const { id } = requestData(CopyAiConversationParams, req.params);
  const input = requestData(CopyAiConversationBody, req.body);
  const { conversation: source } = await ownedConversation(req, id);
  const sourceRows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, source.id))
    .orderBy(messages.createdAt);
  const copyableRows = sourceRows.filter((row) => row.actor === "USER" || row.actor === "ASSISTANT");
  let rowsToCopy = copyableRows;
  if (input.beforeMessageId) {
    const anchorIndex = copyableRows.findIndex((row) => row.id === input.beforeMessageId);
    if (anchorIndex < 0) {
      res.status(404).json({ error: "رسالة التعديل غير موجودة." });
      return;
    }
    if (
      copyableRows[anchorIndex]!.actor !== "USER" ||
      copyableRows[anchorIndex]!.senderId !== req.actor!.id
    ) {
      res.status(400).json({ error: "يمكن تعديل رسائلك أنت فقط." });
      return;
    }
    rowsToCopy = copyableRows.slice(0, anchorIndex);
  }

  const copyId = randomUUID();
  const title = `نسخة من ${source.title}`.slice(0, 80);
  const copied = await db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(conversations)
      .values({
        id: copyId,
        orderId: null,
        ownerUserId: req.actor!.id,
        marketId: source.marketId,
        kind: "AI",
        title,
      })
      .returning();
    const baseTime = Date.now();
    const copiedMessages = rowsToCopy.length
      ? await tx
          .insert(messages)
          .values(rowsToCopy.map((row, index) => ({
            id: randomUUID(),
            conversationId: copyId,
            senderId: row.actor === "USER" ? req.actor!.id : null,
            body: row.body,
            actor: row.actor,
            contentType: "TEXT",
            metadata: {},
            createdAt: new Date(baseTime + index),
          })))
          .returning()
      : [];
    return { conversation: conversation!, messages: copiedMessages };
  });
  res.status(201).json(CopyAiConversationResponse.parse({
    conversation: conversationView(copied.conversation),
    messages: copied.messages.map((row) => ({
      id: row.id,
      actor: row.actor,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      blocks: [],
    })),
  }));
});

type GuestHandoffInput = z.infer<typeof CreateAiGuestHandoffBody>;

function handoffContinuationStatus(
  row: typeof messages.$inferSelect | undefined,
):
  | "NOT_STARTED"
  | "PENDING"
  | "FAILED"
  | "COMPLETED"
  | "UNCERTAIN" {
  switch (row?.metadata.turnStatus) {
    case "pending":
      return "PENDING";
    case "failed":
      return "FAILED";
    case "completed":
      return "COMPLETED";
    case "uncertain":
      return "UNCERTAIN";
    default:
      return row ? "UNCERTAIN" : "NOT_STARTED";
  }
}

router.get("/ai/vision-capability", requireAuth, (req, res) => {
  const provider = req.app.locals.listingPhotoSuggestionProvider as
    | { capability?: () => ListingPhotoVisionCapability }
    | undefined;
  res.json(
    provider?.capability?.() ??
      unavailableListingPhotoVisionCapability(),
  );
});

router.post("/ai/conversations/guest-handoff", requireAuth, async (req, res): Promise<void> => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const input = requestData(CreateAiGuestHandoffBody, req.body);
  if (
    input.continuation &&
    !isSafeGuestHandoffText(input.continuation.body)
  )
    throw fail(400, "تعذر استئناف الرسالة لأنها تحتوي على بيانات خاصة.");
  if (input.userId !== req.actor!.id)
    throw fail(409, "تعذر ربط المحادثة بهذا الحساب");
  const market = await marketFor(req);
  if (input.marketId !== market.id)
    throw fail(400, "تغيّر السوق؛ لم أستخدم سياق المحادثة السابق.");
  const continuationListingId = input.continuation?.listingId;
  const continuationListing = continuationListingId
    ? (await searchMarketplaceListings(market, {
        allowedIds: [continuationListingId],
        limit: 1,
      }))[0]
    : undefined;
  if (continuationListingId && continuationListing?.id !== continuationListingId)
    throw fail(409, "تعذر استعادة الإعلان المحدد؛ لم يُستأنف العرض.");

  const inputMessageIds = input.messages.map((message) => message.id);
  if (
    new Set(inputMessageIds).size !== inputMessageIds.length ||
    inputMessageIds.includes(input.handoffId) ||
    (input.continuation &&
      inputMessageIds.includes(input.continuation.messageId))
  )
    throw fail(400, "رسائل المحادثة غير صالحة");

  const safeMessages = sanitizeGuestHandoffMessages(input.messages);
  const result = await db.transaction(async (tx) => {
    const [newConversation] = await tx
      .insert(conversations)
      .values({
        id: input.handoffId,
        orderId: null,
        ownerUserId: req.actor!.id,
        marketId: market.id,
        kind: "AI",
        title: NEW_CONVERSATION_TITLE,
      })
      .onConflictDoNothing()
      .returning();
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, input.handoffId))
      .for("update");
    if (
      !conversation ||
      conversation.ownerUserId !== req.actor!.id ||
      conversation.kind !== "AI" ||
      conversation.marketId !== market.id
    )
      throw fail(409, "تعذر ربط المحادثة بهذا الحساب أو السوق");

    const existingRows = await tx
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(messages.createdAt);
    const existingHandoffRows = existingRows.filter(
      (row) => row.metadata.guestHandoffId === input.handoffId,
    );
    let importedRows = existingHandoffRows;
    if (existingHandoffRows.length) {
      const matches =
        existingHandoffRows.length === safeMessages.length &&
        existingHandoffRows.every(
          (row, index) =>
            row.id === safeMessages[index]?.id &&
            row.actor === safeMessages[index]?.actor &&
            row.body === safeMessages[index]?.body &&
            row.senderId ===
              (safeMessages[index]?.actor === "USER"
                ? req.actor!.id
                : null),
        );
      if (!matches) throw fail(409, "سبق نقل سياق مختلف لهذه المحادثة");
    } else {
      if (!newConversation && existingRows.length)
        throw fail(409, "معرّف المحادثة مستخدم مسبقًا");
      if (safeMessages.length) {
        const conflictingIds = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(inArray(messages.id, safeMessages.map((message) => message.id)));
        if (conflictingIds.length)
          throw fail(409, "سبق ربط بعض الرسائل بمحادثة أخرى");

        const baseTime = Date.now();
        const inserted = await tx
          .insert(messages)
          .values(
            safeMessages.map((message, index) => ({
              id: message.id,
              conversationId: conversation.id,
              senderId: message.actor === "USER" ? req.actor!.id : null,
              actor: message.actor,
              contentType: "TEXT",
              body: message.body,
              metadata: {
                guestHandoffId: input.handoffId,
                importedFromGuest: true,
              },
              createdAt: new Date(baseTime + index),
              updatedAt: new Date(baseTime + index),
            })),
          )
          .onConflictDoNothing()
          .returning();
        if (inserted.length !== safeMessages.length)
          throw fail(409, "تعذر نقل الرسائل دون تكرار");
        importedRows = inserted;

        const firstUserMessage = safeMessages.find(
          (message) => message.actor === "USER",
        );
        await tx
          .update(conversations)
          .set({
            ...(firstUserMessage
              ? { title: conversationTitle(firstUserMessage.body) }
              : {}),
            updatedAt: inserted.at(-1)!.createdAt,
          })
          .where(eq(conversations.id, conversation.id));
      }
    }

    let continuationRow:
      | (typeof messages.$inferSelect)
      | undefined;
    if (input.continuation) {
      [continuationRow] = await tx
        .select()
        .from(messages)
        .where(eq(messages.id, input.continuation.messageId))
        .limit(1);
      if (
        continuationRow &&
        (continuationRow.conversationId !== conversation.id ||
          continuationRow.senderId !== req.actor!.id ||
          continuationRow.actor !== "USER" ||
          continuationRow.body !== input.continuation.body)
      )
        throw fail(409, "تعذر استئناف الرسالة بأمان");
    }

    if (continuationListing) {
      const [existingContext] = await tx
        .select()
        .from(aiResultSets)
        .where(eq(aiResultSets.id, input.handoffId))
        .limit(1);
      if (existingContext) {
        if (
          existingContext.conversationId !== conversation.id ||
          existingContext.marketId !== market.id ||
          JSON.stringify(existingContext.resourceIds) !==
            JSON.stringify([continuationListing.id])
        )
          throw fail(409, "سبق ربط سياق إعلان مختلف بهذه المحادثة");
      } else {
        let contextMessage = importedRows.at(-1);
        if (!contextMessage || contextMessage.actor !== "ASSISTANT") {
          [contextMessage] = await tx
            .insert(messages)
            .values({
              id: randomUUID(),
              conversationId: conversation.id,
              senderId: null,
              actor: "ASSISTANT",
              contentType: "TEXT",
              body: `الإعلان المحدد: ${continuationListing.title}`,
              metadata: { guestHandoffId: input.handoffId, restoredListingContext: true },
            })
            .returning();
        }
        const searchState = {
          search: String(continuationListing.title ?? ""),
          ...(continuationListing.categoryId
            ? { categoryId: continuationListing.categoryId }
            : {}),
          filters: [],
        };
        await tx.insert(aiResultSets).values({
          id: input.handoffId,
          conversationId: conversation.id,
          marketId: market.id,
          messageId: contextMessage!.id,
          query: searchState,
          resourceIds: [continuationListing.id],
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        await tx.insert(aiUiBlocks).values({
          id: randomUUID(),
          conversationId: conversation.id,
          messageId: contextMessage!.id,
          blockType: "LISTING_RESULTS",
          version: 1,
          payload: {
            resultSetId: input.handoffId,
            resourceIds: [continuationListing.id],
            searchState,
            presentation: "DETAILS",
          },
          ordinal: 0,
        });
      }
    }

    const [currentConversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    return {
      created: Boolean(newConversation),
      conversation: currentConversation ?? conversation,
      messages: importedRows,
      continuationStatus: handoffContinuationStatus(continuationRow),
    };
  });

  res
    .status(result.created ? 201 : 200)
    .json(
      CreateAiGuestHandoffResponse.parse({
        conversation: conversationView(result.conversation),
        messages: result.messages.map((row) => ({
          id: row.id,
          actor: row.actor,
          body: row.body,
          createdAt: row.createdAt.toISOString(),
          blocks: [],
        })),
        continuationStatus: result.continuationStatus,
      }),
    );
});

router.get("/ai/conversations", requireAuth, async (req, res) => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.ownerUserId, req.actor!.id),
        eq(conversations.kind, "AI"),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(100);
  res.json(GetAiConversationsResponse.parse(rows.map(conversationView)));
});

router.get("/ai/conversations/:id", requireAuth, async (req, res) => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const { id } = requestData(GetAiConversationParams, req.params);
  const { conversation, market } = await ownedConversation(req, id);
  const [messageRows, blockRows] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(messages.createdAt),
    db
      .select()
      .from(aiUiBlocks)
      .where(eq(aiUiBlocks.conversationId, conversation.id))
      .orderBy(aiUiBlocks.ordinal),
  ]);
  const blocksByMessage = await freshBlocksForConversation(
    conversation.id,
    market,
    blockRows,
    req.actor!.id,
  );
  // Stored receipts are only ledger ids: each read re-derives the current status, and shows only
  // this viewer's actions in this conversation. One batched ledger read serves the whole history,
  // so opening a long conversation costs a constant number of queries instead of one per action.
  const receiptIdsByMessage = messageRows.map((row) => {
    const stored = (row.metadata as { actionReceipts?: { actionId?: unknown }[] } | null)?.actionReceipts;
    return row.actor === "ASSISTANT" && Array.isArray(stored)
      ? receiptIdsOf(stored.map((item) => String(item?.actionId)))
      : [];
  });
  const receiptsById = await receiptViewsByIds(
    { actorId: req.actor!.id, conversationId: conversation.id },
    receiptIdsByMessage.flat(),
  );
  res.json(
    GetAiConversationResponse.parse({
      conversation: conversationView(conversation),
      messages: messageRows.map((row, index) => {
        const actionReceipts = receiptIdsByMessage[index]!
          .map((actionId) => receiptsById.get(actionId))
          .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined);
        return {
          id: row.id,
          actor: row.actor,
          body: row.body,
          createdAt: row.createdAt.toISOString(),
          blocks: blocksByMessage.get(row.id) ?? [],
          ...(actionReceipts.length ? { actionReceipts } : {}),
        };
      }),
    }),
  );
});

router.get("/ai/learning-history", requireAuth, async (req, res) => {
  const rows = await db
    .select({
      id: tutorialLearningEvents.id,
      tutorialId: tutorialLearningEvents.tutorialId,
      eventType: tutorialLearningEvents.eventType,
      milestonePercent: tutorialLearningEvents.milestonePercent,
      currentTimeSeconds: tutorialLearningEvents.currentTimeSeconds,
      createdAt: tutorialLearningEvents.createdAt,
    })
    .from(tutorialLearningEvents)
    .where(eq(tutorialLearningEvents.userId, req.actor!.id))
    .orderBy(desc(tutorialLearningEvents.createdAt))
    .limit(100);
  res.json(TutorialLearningEventsResponseSchema.parse(rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }))));
});

router.post("/ai/learning-history", requireAuth, async (req, res) => {
  const body = TutorialLearningEventInputSchema.parse(req.body);
  const [event] = await db
    .insert(tutorialLearningEvents)
    .values({
      id: randomUUID(),
      userId: req.actor!.id,
      idempotencyKey: body.idempotencyKey,
      tutorialId: body.tutorialId,
      eventType: body.eventType,
      milestonePercent: body.milestonePercent ?? null,
      currentTimeSeconds: body.currentTimeSeconds ?? null,
    })
    .onConflictDoNothing({
      target: [tutorialLearningEvents.userId, tutorialLearningEvents.idempotencyKey],
    })
    .returning({
      id: tutorialLearningEvents.id,
      tutorialId: tutorialLearningEvents.tutorialId,
      eventType: tutorialLearningEvents.eventType,
      milestonePercent: tutorialLearningEvents.milestonePercent,
      currentTimeSeconds: tutorialLearningEvents.currentTimeSeconds,
      createdAt: tutorialLearningEvents.createdAt,
    });
  if (event) {
    res.status(201).json(TutorialLearningEventSchema.parse({
      ...event,
      createdAt: event.createdAt.toISOString(),
    }));
    return;
  }
  const [existing] = await db
    .select({
      id: tutorialLearningEvents.id,
      tutorialId: tutorialLearningEvents.tutorialId,
      eventType: tutorialLearningEvents.eventType,
      milestonePercent: tutorialLearningEvents.milestonePercent,
      currentTimeSeconds: tutorialLearningEvents.currentTimeSeconds,
      createdAt: tutorialLearningEvents.createdAt,
    })
    .from(tutorialLearningEvents)
    .where(and(
      eq(tutorialLearningEvents.userId, req.actor!.id),
      eq(tutorialLearningEvents.idempotencyKey, body.idempotencyKey),
    ))
    .limit(1);
  if (!existing) throw fail(409, "تعذر حفظ سجل التعلم.");
  res.json(TutorialLearningEventSchema.parse({
    ...existing,
    createdAt: existing.createdAt.toISOString(),
  }));
});

// A rename is the owner's label only: it never reorders the history (updatedAt is kept) and
// turns never overwrite it, because automatic titles apply only to «محادثة جديدة».
router.patch("/ai/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const { id } = requestData(GetAiConversationParams, req.params);
  const { title: raw } = requestData(RenameAiConversationBody, req.body);
  const title = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!title) throw fail(400, "اكتب عنوانًا للمحادثة.");
  const [renamed] = await db
    .update(conversations)
    .set({ title })
    .where(and(eq(conversations.id, id), eq(conversations.ownerUserId, req.actor!.id), eq(conversations.kind, "AI")))
    .returning();
  if (!renamed) {
    res.status(404).json({ error: "المحادثة غير موجودة" });
    return;
  }
  res.json(RenameAiConversationResponse.parse(conversationView(renamed)));
});

router.delete(
  "/ai/conversations/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
    const { id } = requestData(GetAiConversationParams, req.params);
    const deleted = await db.transaction(async (tx) => {
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, id),
            eq(conversations.ownerUserId, req.actor!.id),
            eq(conversations.kind, "AI"),
          ),
        )
        .for("update")
        .limit(1);
      if (!conversation) return false;

      await tx
        .delete(messages)
        .where(eq(messages.conversationId, conversation.id));
      const [removed] = await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.id, conversation.id),
            eq(conversations.ownerUserId, req.actor!.id),
            eq(conversations.kind, "AI"),
          ),
        )
        .returning({ id: conversations.id });
      return Boolean(removed);
    });

    if (!deleted) {
      res.status(404).json({ error: "المحادثة غير موجودة" });
      return;
    }
    res.sendStatus(204);
  },
);

router.post(
  "/ai/conversations/:id/actions/add-to-cart",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!enabled()) {
      res.status(404).json({ message: "هذه الميزة غير متاحة" });
      return;
    }
    const { id } = requestData(SendAiConversationTurnParams, req.params);
    const { conversation, market } = await ownedConversation(req, id);
    const action = requestData(AddAiListingToCartBody, req.body);
    let execution: Awaited<ReturnType<typeof executeRegisteredTool>>;
    try {
      execution = await executeRegisteredTool(
        "addToCart",
        JSON.stringify({
          resultSetId: action.resultSetId,
          resourceId: action.resourceId,
          quantity: 1,
          cardReceipt: true,
        }),
        {
          conversationId: conversation.id,
          market,
          actorId: req.actor!.id,
        },
      );
    } catch (cause) {
      if (cause instanceof ToolRejectedError) {
        res.status(409).json({ message: cause.message });
        return;
      }
      throw cause;
    }

    if (
      execution.result.kind !== "SURFACE" ||
      execution.result.surface !== "CART"
    )
      throw fail(500, "تعذر تأكيد إضافة العرض إلى السلة");

    // The card's receipt (and its single cart effect) is written exactly once by the tool;
    // repeated taps, retries, reloads and a second session all read this stored row back.
    const receipt = await findCardAddReceipt({
      conversationId: conversation.id,
      resultSetId: action.resultSetId,
      listingId: action.resourceId,
    });
    if (!receipt) throw fail(500, "تعذر تأكيد إضافة العرض إلى السلة");

    res.json(
      AddAiListingToCartResponse.parse({
        assistantMessage: {
          id: receipt.id,
          actor: "ASSISTANT",
          body: receipt.body,
          createdAt: receipt.createdAt.toISOString(),
          blocks: [
            SurfaceBlock.parse({
              type: "SURFACE",
              version: 1,
              payload: {
                ...receipt.block,
                card: buildCardEnvelope({
                  conversationId: conversation.id,
                  marketId: market.id,
                  currency: market.currencyCode,
                  token: String(receipt.block.surface ?? ""),
                  resultSetId: String(receipt.block.resultSetId ?? ""),
                  payload: receipt.block,
                  sourceTimestamp: receipt.createdAt,
                }) ?? undefined,
              },
            }),
          ],
        },
      }),
    );
  },
);

router.post(
  "/ai/conversations/:id/control-actions/:resultSetId/acknowledgement",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!enabled()) {
      res.status(404).json({ message: "هذه الميزة غير متاحة" });
      return;
    }
    const { id, resultSetId } = requestData(AcknowledgeAiControlActionParams, req.params);
    const { conversation } = await ownedConversation(req, id);
    const { status } = requestData(AcknowledgeAiControlActionBody, req.body);
    const recorded = await acknowledgeClientAction({ conversationId: conversation.id, resultSetId, actorId: req.actor!.id, status });
    res.json(AcknowledgeAiControlActionResponse.parse(recorded));
  },
);

router.post(
  "/ai/listing-management-previews/:id/action",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!enabled()) {
      res.status(404).json({ message: "هذه الميزة غير متاحة" });
      return;
    }
    const { id } = requestData(
      ApplyAiListingManagementPreviewParams,
      req.params,
    );
    const action = requestData(
      ApplyAiListingManagementPreviewBody,
      req.body,
    );
    const market = await marketFor(req);
    const result = await applyListingPreviewAction({
      previewId: id,
      ownerId: req.actor!.id,
      market,
      action: action.action,
    });
    res.json(ApplyAiListingManagementPreviewResponse.parse(result));
  },
);

// Promotion review/cancel cards: the same authority as typing «تأكيد» or «إلغاء».
router.post("/ai/promotion-actions/:id/action", requireAuth, async (req, res) => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const { id } = requestData(ApplyAiEmploymentActionParams, req.params);
  const { action } = requestData(ApplyAiEmploymentActionBody, req.body);
  const market = await marketFor(req);
  const outcome = await applyPromotionAction({
    actionId: id,
    actorId: req.actor!.id,
    market,
    decision: action,
  });
  res.json(
    ApplyAiPromotionActionResponse.parse({
      status: outcome.status,
      message: outcome.message,
      ...(outcome.promotionId ? { promotionId: outcome.promotionId } : {}),
    }),
  );
});

// The same authority as a conversational «نعم»: one exact pending action, owner only.
router.post("/ai/employment-actions/:id/action", requireAuth, async (req, res) => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const { id } = requestData(ApplyAiEmploymentActionParams, req.params);
  const { action } = requestData(ApplyAiEmploymentActionBody, req.body);
  const market = await marketFor(req);
  const outcome = await applyEmploymentAction({
    actionId: id,
    actorId: req.actor!.id,
    market,
    decision: action,
  });
  res.json(
    ApplyAiEmploymentActionResponse.parse({
      status: outcome.status,
      message: outcome.message,
    }),
  );
});

router.post("/ai/conversations/:id/turns", requireAuth, async (req, res) => {
  if (!enabled()) throw fail(404, "هذه الميزة غير متاحة");
  const { id } = requestData(SendAiConversationTurnParams, req.params);
  const { conversation, market } = await ownedConversation(req, id);
  const input = requestData(SendAiConversationTurnBody, req.body);
  const message = input.message.trim();
  if (!message) throw fail(400, "أدخل رسالة قبل الإرسال");
  const imageObjectPaths = input.imageObjectPaths ?? [];
  await validateListingPhotoPathsForOwner(imageObjectPaths, req.actor!.id);
  if ((input.location === undefined) !== (input.locationRequestId === undefined))
    throw fail(400, "بيانات الموقع غير صالحة");
  if (input.location && imageObjectPaths.length)
    throw fail(400, "لا يمكن إرسال صور مع الموقع في الرسالة نفسها");
  // Retries compare a digest; the message metadata never stores the location itself.
  const locationDigest = input.location
    ? createHmac("sha256", LOCATION_DIGEST_KEY).update(JSON.stringify([input.locationRequestId, input.location])).digest("hex")
    : undefined;
  const turnMetadata = { imageObjectPaths, ...(locationDigest ? { locationDigest } : {}) };
  const turnId = randomUUID();
  const userMessageId = input.clientMessageId ?? randomUUID();
  let createdAt = new Date();
  let modelToolContinuation: unknown;
  const title =
    conversation.title === NEW_CONVERSATION_TITLE
      ? conversationTitle(redactListingContactPhone(message))
      : conversation.title;
  await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(messages).values({
      id: userMessageId,
      conversationId: conversation.id,
      senderId: req.actor!.id,
      body: message,
      actor: "USER",
      contentType: "TEXT",
      metadata: { turnStatus: "pending", ...turnMetadata },
    }).onConflictDoNothing().returning();
    if (!inserted) {
      const [existing] = await tx.select().from(messages).where(and(eq(messages.id, userMessageId), eq(messages.conversationId, conversation.id), eq(messages.senderId, req.actor!.id), eq(messages.actor, "USER")));
      if (!existing || existing.body !== message) throw fail(409, "تعذر إعادة هذه الرسالة. حدّث المحادثة ثم حاول مرة أخرى.");
      const existingImagePaths = Array.isArray(existing.metadata.imageObjectPaths)
        ? existing.metadata.imageObjectPaths
        : [];
      if (JSON.stringify(existingImagePaths) !== JSON.stringify(imageObjectPaths))
        throw fail(409, "لا يمكن تغيير الصور عند إعادة المحاولة. حدّث المحادثة ثم أرسل رسالة جديدة.");
      if (existing.metadata.locationDigest !== locationDigest)
        throw fail(409, "لا يمكن تغيير الموقع عند إعادة المحاولة. شارك الموقع من جديد.");
      const [latest] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, conversation.id)).orderBy(desc(messages.createdAt)).limit(1);
      const rawContinuation = existing.metadata.modelToolContinuation;
      const hasContinuation = Boolean(rawContinuation && typeof rawContinuation === "object" && !Array.isArray(rawContinuation));
      const continuationResumeCount =
        hasContinuation && Number.isInteger((rawContinuation as Record<string, unknown>).resumeCount)
          ? Number((rawContinuation as Record<string, unknown>).resumeCount)
          : 0;
      const canResume = hasContinuation && continuationResumeCount < 5;
      const staleReadOnlyTurn =
        existing.metadata.turnStatus === "pending" &&
        Date.now() - existing.createdAt.getTime() >= 60_000 &&
        canResume;
      const failedTurnCanRetry =
        existing.metadata.turnStatus === "failed" &&
        (!hasContinuation || canResume);
      if ((!failedTurnCanRetry && !staleReadOnlyTurn) || latest?.id !== existing.id)
        throw fail(409, "هذه الرسالة قيد المعالجة أو اكتملت بالفعل. حدّث المحادثة قبل متابعة الإجراء.");
      // Atomic claim: simultaneous retries cannot execute the same turn twice.
      const claimedMetadata: Record<string, unknown> = { turnStatus: "pending", ...turnMetadata };
      if (hasContinuation && canResume) {
        modelToolContinuation = {
          ...(rawContinuation as Record<string, unknown>),
          resumeCount: continuationResumeCount + 1,
        };
        claimedMetadata.modelToolContinuation = modelToolContinuation;
      }
      const [claimed] = await tx.update(messages).set({ metadata: claimedMetadata }).where(and(eq(messages.id, existing.id), eq(messages.metadata, existing.metadata))).returning();
      if (!claimed) throw fail(409, "هذه الرسالة قيد المعالجة. انتظر قليلًا ثم حدّث المحادثة.");
      createdAt = existing.createdAt;
    } else { createdAt = inserted.createdAt; }
    await tx
      .update(conversations)
      .set({ title, updatedAt: createdAt })
      .where(eq(conversations.id, conversation.id));
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  send(res, { type: "status", stage: "understanding" });

  let toolName = "unknown";
  try {
    // Receipts are the ledger rows this turn opened or settled (stamped through the turn
    // context), read by the server; no handler claims them.
    const execution = await runInTurn(userMessageId, () => executeAiConversationTurn(
      {
        conversationId: conversation.id,
        currentMessageId: userMessageId,
        modelToolContinuation,
        message,
        market,
          actorId: req.actor!.id,
        imageObjectPaths,
        reasoningEffort: input.reasoningEffort,
        location: input.location,
        locationRequestId: input.locationRequestId,
      },
      {
        photoSuggestionProvider: req.app.locals.listingPhotoSuggestionProvider as ListingPhotoSuggestionProvider | undefined,
        modelGateway: req.app.locals.conversationModelGateway as ConversationModelGateway | undefined,
        onToolSelected(name) {
          toolName = name;
          send(res, { type: "status", stage: ["searchListings", "getResource", "compareListings"].includes(name) ? "searching" : "understanding" });
        },
        async onModelToolProgress(state) {
          const resumeCount =
            modelToolContinuation &&
            typeof modelToolContinuation === "object" &&
            Number.isInteger((modelToolContinuation as Record<string, unknown>).resumeCount)
              ? Number((modelToolContinuation as Record<string, unknown>).resumeCount)
              : state.resumeCount;
          await db.update(messages).set({
            metadata: {
              turnStatus: "pending",
              ...turnMetadata,
              modelToolContinuation: { ...state, resumeCount },
            },
          }).where(and(
            eq(messages.id, userMessageId),
            eq(messages.conversationId, conversation.id),
            eq(messages.senderId, req.actor!.id),
            eq(messages.actor, "USER"),
          ));
        },
      },
    ));
    toolName = execution.tool;
    const actionReceipts = await receiptsForTurn(conversation.id, req.actor!.id, userMessageId);
    execution.result = enforceModelAuthority(execution.result, actionReceipts);
    // A compound request's step plan lives on the user message that owns it (task-plan.ts).
    const completedTurnMetadata = {
      turnStatus: "completed",
      ...(execution.taskPlan ? { taskPlan: execution.taskPlan } : {}),
    };
    const withPlanNotice = (text: string) => {
      const notice = execution.taskPlan ? taskPlanNotice(execution.taskPlan) : "";
      return notice ? `${text}\n\n${notice}` : text;
    };

    const toolResult = execution.result;
    if (toolResult.kind === "SURFACE") {
      const resultSetId = toolResult.resultSetId ?? randomUUID();
      const surfacePayload: Record<string, unknown> = {
        resultSetId,
        listings: [],
        surface: toolResult.surface,
        resourceIds: toolResult.resourceIds,
        resourceId: toolResult.resourceId,
        sellerContactRequested: toolResult.sellerContactRequested,
        hideMap: toolResult.hideMap,
        managementPreview: toolResult.managementPreview,
        draft: toolResult.draft,
        draftStep: toolResult.draftStep,
        draftReview: toolResult.draftReview,
        sellerInsight: toolResult.sellerInsight,
        comparison: toolResult.comparison,
        purchaseReview: toolResult.purchaseReview,
        inventory: toolResult.inventory,
        inquiries: toolResult.inquiries,
        orders: toolResult.orders,
        cart: toolResult.cart,
        checkout: toolResult.checkout,
        fulfillment: toolResult.fulfillment,
        preparedAction: toolResult.preparedAction,
        preparedDraft: toolResult.preparedDraft,
        photoSuggestionStatus: toolResult.photoSuggestionStatus,
        photoSuggestions: toolResult.photoSuggestions,
        photoSuggestionUncertainties:
          toolResult.photoSuggestionUncertainties,
        employment: toolResult.employment,
        delivery: toolResult.delivery,
        promotion: toolResult.promotion,
        commerce: toolResult.commerce,
        tutorial: toolResult.tutorial,
        driver: toolResult.driver,
        provider: toolResult.provider,
        advice: toolResult.advice,
        memory: toolResult.memory,
        policyReview: toolResult.policyReview,
        negotiation: toolResult.negotiation,
        inquiry: toolResult.inquiry,
        control: toolResult.control,
        business: toolResult.business,
        relatesToAction: toolResult.relatesToAction,
      };
      const block = SurfaceBlock.parse({
        type: "SURFACE",
        version: 1,
        payload: {
          ...surfacePayload,
          // The envelope is server-derived: surface type, resource, lifecycle, allowed
          // capabilities, pending review and expiry come from the records above.
          card: buildCardEnvelope({
            conversationId: conversation.id,
            marketId: market.id,
            currency: market.currencyCode,
            token: toolResult.surface,
            resultSetId,
            payload: surfacePayload,
            sourceTimestamp: new Date(),
          }) ?? undefined,
        },
      });
      const body = withPlanNotice(toolResult.prompt ?? (
        toolResult.surface === "CLARIFY"
          ? "ما المنتج أو الخدمة التي تحتاجها؟ اذكر النوع والمواصفات لنبحث في السوق."
          : toolResult.surface === "UNSUPPORTED"
            ? "هذه الخدمة المتخصصة غير متاحة حاليًا. يمكنك البحث في العروض المنشورة أو متابعة الاستكشاف."
            : "تفضل، يمكنك متابعة طلبك هنا."));
      const assistant = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(messages)
          .values({
            id: randomUUID(),
            conversationId: conversation.id,
            actor: "ASSISTANT",
            body,
            contentType: "TEXT",
            // NEXT G2: inquiry answers quote the other party's words; they never become model history.
            ...(toolResult.inquiry || actionReceipts.length
              ? { metadata: { ...(toolResult.inquiry ? { inquiryContent: true } : {}), ...(actionReceipts.length ? { actionReceipts } : {}) } }
              : {}),
          })
          .returning();
        await tx
          .insert(aiUiBlocks)
          .values({
            id: randomUUID(),
            conversationId: conversation.id,
            messageId: row.id,
            blockType: "SURFACE",
            version: 1,
            payload: block.payload.delivery
              // The envelope is derived on every read; a stored copy would be stale by design.
              ? { ...block.payload, card: undefined, delivery: storableDeliveryPayload(block.payload.delivery) }
              : { ...block.payload, card: undefined },
            ordinal: 0,
          });
        const d5DraftBinding = (toolResult as typeof toolResult & {
          d5DraftBinding?: {
            sessionId: string;
            businessId: string;
            draftId: string;
          };
        }).d5DraftBinding;
        if (d5DraftBinding) {
          await recordSellerEmployeeDraftBindingTx(tx, {
            actorId: req.actor!.id,
            conversationId: conversation.id,
            marketId: market.id,
            sessionId: d5DraftBinding.sessionId,
            expectedBusinessId: d5DraftBinding.businessId,
            draftId: d5DraftBinding.draftId,
          });
        }
        if (
          (toolResult.query?.kind === "SELLER_CONTEXT" ||
            toolResult.query?.kind === "LISTING_PREVIEW" ||
            toolResult.query?.kind === "EMPLOYMENT" ||
            toolResult.query?.kind === "DELIVERY" ||
            toolResult.query?.kind === "PROMOTION" ||
            toolResult.query?.kind === "COMMERCE" ||
            toolResult.query?.kind === "DRIVER" ||
            toolResult.query?.kind === "ORDERS" ||
            toolResult.query?.kind === "INQUIRY" ||
            toolResult.query?.kind === "CONTROL" ||
            SMART_STATE_KINDS.includes(String(toolResult.query?.kind))) &&
          toolResult.resultSetId &&
          // An answer that only discusses a pending action never becomes a newer step.
          !toolResult.relatesToAction
        ) {
          await tx.insert(aiResultSets).values({
            id: toolResult.resultSetId,
            conversationId: conversation.id,
            marketId: market.id,
            messageId: row.id,
            query: toolResult.query,
            resourceIds: toolResult.resourceIds ?? [],
            expiresAt:
              employmentStateExpiry(toolResult.query) ??
              deliveryStateExpiry(toolResult.query) ??
              promotionStateExpiry(toolResult.query) ??
              commerceStateExpiry(toolResult.query) ??
              driverStateExpiry(toolResult.query) ??
              (SMART_STATE_KINDS.includes(String(toolResult.query?.kind)) ? new Date(Date.now() + 24 * 60 * 60 * 1000) : undefined) ??
              new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          });
        }
        await tx
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, conversation.id));
        await tx.update(messages).set({ metadata: completedTurnMetadata }).where(eq(messages.id, userMessageId));
        return row;
      });
      // Comparing, negotiating or reviewing a purchase of a paid placement from the buyer's
      // own result set are server-observed qualified engagements («روح بع لي» billing).
      const engagement = ({ COMPARISON: "COMPARISON_STARTED", PURCHASE_REVIEW: "PURCHASE_REVIEW_STARTED", NEGOTIATION_REVIEW: "NEGOTIATION_STARTED" } as const)[toolResult.surface as "COMPARISON"];
      if (engagement) {
        const ids = [
          ...(toolResult.resourceIds ?? []),
          ...(toolResult.resourceId ? [toolResult.resourceId] : []),
          ...[(toolResult.purchaseReview as { listingId?: unknown } | undefined)?.listingId, (toolResult.negotiation as { listingId?: unknown } | undefined)?.listingId].filter((id): id is string => typeof id === "string"),
        ];
        await attributeEngagement(req, conversation.id, market, ids, engagement);
      }
      send(res, {
        type: "complete",
        conversation: conversationView({ ...conversation, title }),
        userMessage: {
          id: userMessageId,
          actor: "USER",
          body: message,
          createdAt: createdAt.toISOString(),
          blocks: [],
        },
        assistantMessage: {
          id: assistant.id,
          actor: "ASSISTANT",
          body,
          createdAt: assistant.createdAt.toISOString(),
          // The pending-action binding is server bookkeeping, as in history reads.
          blocks: [{ ...block, payload: { ...block.payload, relatesToAction: undefined } }],
          // What the ledger holds now for the actions this turn moved; never ids or raw facts.
          actionReceipts: await receiptViews({ actorId: req.actor!.id, conversationId: conversation.id }, actionReceipts.map((item) => item.actionId)),
        },
      });
      res.end();
      return;
    }

    const resultSetId =
      toolResult.kind === "SEARCH" ? randomUUID() : toolResult.resultSetId!;
    // Monetization V3: every organic search records its need; on zero or low supply,
    // eligible «روح بع لي» campaigns may add labelled paid options after the organic list.
    let demandTrigger: string | undefined;
    if (toolResult.kind === "SEARCH") {
      const sponsoredCampaigns: Record<string, { promotionId: string; placement: string }> = {
        ...((toolResult.query.sponsoredCampaigns as Record<string, { promotionId: string; placement: string }> | undefined) ?? {}),
      };
      for (const listing of toolResult.listings)
        if (listing.isSponsored && listing.sponsoredCampaignId && listing.sponsoredPlacement)
          sponsoredCampaigns[listing.id] = { promotionId: listing.sponsoredCampaignId, placement: listing.sponsoredPlacement };
      if (!toolResult.query.demandRescue) {
        try {
          const rescue = await afterOrganicSearch({ market, actorId: req.actor!.id, query: toolResult.query, listings: toolResult.listings });
          if (rescue.listings.length) {
            demandTrigger = rescue.trigger;
            toolResult.listings = [...toolResult.listings, ...rescue.listings];
            Object.assign(sponsoredCampaigns, rescue.sponsoredCampaigns);
            toolResult.query.demandRescue = rescue.trigger;
          }
        } catch (error) {
          req.log.warn({ event: "demand_rescue_failed", err: error instanceof Error ? error.message : "unknown" }, "demand rescue skipped");
        }
      } else demandTrigger = String(toolResult.query.demandRescue);
      const paidIds = toolResult.listings.filter((listing) => listing.isSponsored).map((listing) => listing.id);
      if (paidIds.length) {
        toolResult.query.sponsoredIds = paidIds;
        toolResult.query.sponsoredCampaigns = Object.fromEntries(Object.entries(sponsoredCampaigns).filter(([id]) => paidIds.includes(id)));
      }
    }
    if (toolResult.kind === "SEARCH" || toolResult.kind === "RESULTS" || toolResult.kind === "RESOURCE")
      toolResult.listings = await decoratePaidCards(toolResult.listings, toolResult.query, { actorId: req.actor!.id, marketId: market.id, resultSetId });
    const resourceIds = toolResult.listings.map((listing) => listing.id);
    const stateSource =
      toolResult.kind === "SEARCH" || toolResult.kind === "RESULTS"
        ? toolResult.query
        : undefined;
    const searchState = stateSource
      ? SearchStateSchema.parse({
          search:
            typeof stateSource.search === "string" ? stateSource.search : "",
          ...(typeof stateSource.categoryId === "string"
            ? { categoryId: stateSource.categoryId }
            : {}),
          filters: Array.isArray(stateSource.filters) ? stateSource.filters : [],
          ...(typeof stateSource.sort === "string"
            ? { sort: stateSource.sort }
            : {}),
        })
      : undefined;
    // A conversation keeps the market it started in (ownedConversation). After the account moved
    // to another market, a search here still reads this conversation's market — say so (W04).
    const marketNote =
      req.actor!.activeMarketId && req.actor!.activeMarketId !== conversation.marketId && (toolResult.kind === "SEARCH" || toolResult.kind === "RESULTS")
        ? ` هذه المحادثة مرتبطة بسوق ${conversation.marketId}، وسوقك الحالي ${req.actor!.activeMarketId}؛ لعروض سوقك الحالي ابدأ محادثة جديدة.`
        : "";
    const assistantText = (
      toolResult.kind === "RESOURCE"
        ? typeof (toolResult.query.buyer as { message?: unknown } | undefined)?.message === "string"
          ? String((toolResult.query.buyer as { message: string }).message)
          : toolResult.listings.length
            ? "هذا هو العرض الذي أشرت إليه. افتح البطاقة لمراجعة التفاصيل الحالية."
            : "لم يعد هذا العرض متاحًا في سوقك الحالي. يمكنك متابعة البحث من جديد."
        : toolResult.kind === "RESULTS"
          ? toolResult.listings.length
            ? `عدت إلى نتائجك السابقة (${toolResult.listings.length}) بالترتيب نفسه.`
            : "لا توجد عروض متاحة الآن من نتائجك السابقة. يمكنك البحث من جديد."
          : toolResult.query.recommendation
            ? recommendationText(toolResult.query, toolResult.listings.length)
          : typeof (toolResult.query.buyer as { message?: unknown } | undefined)?.message === "string"
            ? String((toolResult.query.buyer as { message: string }).message)
          : toolResult.listings.length && typeof toolResult.query.widenedFromCategory === "string"
            ? `لم أجد عروضًا مطابقة في تصنيف «${toolResult.query.widenedFromCategory}»، فعرضت ${toolResult.listings.length} عروض من تصنيفات أخرى تطابق كلماتك.`
          : toolResult.listings.length && Array.isArray(toolResult.query.broadenedFrom)
            ? `لم أجد عروضًا تذكر «${toolResult.query.broadenedFrom.join(" ")}» تحديدًا، فعرضت ${toolResult.listings.length} عروض تطابق بقية طلبك.`
          : toolResult.listings.length
            ? `وجدت ${toolResult.listings.length} عروض منشورة تطابق طلبك. راجع التفاصيل الحالية من بطاقات العرض.`
            : searchState?.filters.length
              ? "لم أجد عروضًا منشورة مطابقة في سوقك الحالي. جرّب إزالة أحد الشروط، مثل السعر أو المدينة، أو اكتب «امسح الفلاتر»."
              : "لم أجد عروضًا منشورة مطابقة في سوقك الحالي. جرّب كلمات أخرى أو تصنيفًا أوسع."
    ) + marketNote;
    const organicCount = toolResult.listings.filter((listing) => !listing.isSponsored).length;
    const paidDemandCount = toolResult.listings.length - organicCount;
    const demandText =
      demandTrigger === "ZERO_RESULTS"
        ? `لم أجد عروضًا عادية مطابقة لطلبك. ${paidDemandCount === 1 ? "هذا خيار ممول يطابق" : "هذه خيارات ممولة تطابق"} شروطك (شارة «ممول»؛ ليست توصية من دينار).`
        : demandTrigger === "LOW_SUPPLY"
          ? `وجدت ${organicCount} ${organicCount === 1 ? "عرضًا عاديًا" : "عروض عادية"} مطابقة، وبعدها ${paidDemandCount === 1 ? "خيار ممول يطابق" : "خيارات ممولة تطابق"} شروطك (شارة «ممول»).`
          : undefined;
    const finalAssistantText = withPlanNotice(demandTrigger === "USER_UNSATISFIED" || !demandText ? assistantText : demandText);
    const assistantMessageId = randomUUID();
    const messageCreatedAt = new Date();
    const presentation = toolResult.kind === "RESOURCE" ? "DETAILS" : "RESULTS";
    // Searches and restores always render a typed block, including a real empty state.
    const blocks =
      resourceIds.length || toolResult.kind !== "RESOURCE"
        ? [
            ListingBlock.parse({
              type: "LISTING_RESULTS",
              version: 1,
              payload: {
                resultSetId,
                resourceIds,
                ...(searchState ? { searchState } : {}),
                presentation,
                listings: toolResult.listings,
                card: buildCardEnvelope({
                  conversationId: conversation.id,
                  marketId: market.id,
                  currency: market.currencyCode,
                  presentation,
                  resultSetId,
                  payload: {
                    resourceIds,
                    presentation,
                    ...(searchState ? { searchState } : {}),
                  },
                  sourceTimestamp: messageCreatedAt,
                }) ?? undefined,
              },
            }),
          ]
        : [];
    const storedBlockPayload = StoredBlockPayload.parse({
      resultSetId,
      resourceIds,
      ...(searchState ? { searchState } : {}),
      presentation,
    });

    await db.transaction(async (tx) => {
      const [assistant] = await tx
        .insert(messages)
        .values({
          id: assistantMessageId,
          conversationId: conversation.id,
          body: finalAssistantText,
          actor: "ASSISTANT",
          contentType: "TEXT",
          metadata: { resultSetId: resourceIds.length ? resultSetId : null },
        })
        .returning();
      if (toolResult.kind === "SEARCH") {
        await tx.insert(aiResultSets).values({
          id: resultSetId,
          conversationId: conversation.id,
          marketId: market.id,
          messageId: assistant.id,
          query: toolResult.query,
          resourceIds,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
      }
      if (blocks.length) {
        await tx.insert(aiUiBlocks).values({
          id: randomUUID(),
          conversationId: conversation.id,
          messageId: assistant.id,
          blockType: "LISTING_RESULTS",
          version: 1,
          payload: storedBlockPayload,
          ordinal: 0,
        });
      }
      await tx
        .update(conversations)
        .set({ updatedAt: messageCreatedAt })
        .where(eq(conversations.id, conversation.id));
      await tx.update(messages).set({ metadata: completedTurnMetadata }).where(eq(messages.id, userMessageId));
    });

    const [updatedConversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    const userMessageView = {
      id: userMessageId,
      actor: "USER",
      body: message,
      createdAt: createdAt.toISOString(),
      blocks: [],
    };
    const assistantMessageView = {
      id: assistantMessageId,
      actor: "ASSISTANT",
      body: finalAssistantText,
      createdAt: messageCreatedAt.toISOString(),
      blocks,
    };
    // A paid placement the buyer opened from their own result set is a qualified engagement.
    if (toolResult.kind === "RESOURCE")
      await attributeEngagement(req, conversation.id, market, resourceIds, "DETAIL_OPENED");
    send(res, { type: "delta", content: finalAssistantText });
    send(res, {
      type: "complete",
      conversation: conversationView(updatedConversation ?? conversation),
      userMessage: userMessageView,
      assistantMessage: assistantMessageView,
      blocks,
    });
    req.log.info(
      {
        event: "dinar_ai_turn",
        conversationId: conversation.id,
        turnId,
        toolName,
        resultCount: resourceIds.length,
        status: "completed",
      },
      "DINAR AI turn completed",
    );
    res.end();
  } catch (error) {
    // A mutation may have committed before a response failed. Never replay it blindly.
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(messages).where(eq(messages.id, userMessageId)).for("update");
      if (current?.metadata.turnStatus === "pending")
        await tx.update(messages).set({
          metadata: {
            ...current.metadata,
            turnStatus: addToCartIntent(message) || toolName === "addToCart" ? "uncertain" : "failed",
          },
        }).where(eq(messages.id, userMessageId));
    });
    const code =
      error instanceof ToolRejectedError
        ? "AI_TOOL_REJECTED"
        : error instanceof AIProviderError
          ? "AI_PROVIDER_ERROR"
          : "AI_RUNTIME_ERROR";
    req.log.warn(
      {
        event: "dinar_ai_turn",
        conversationId: conversation.id,
        turnId,
        toolName,
        status: "failed",
        code,
        ...safeTurnFailureMetadata(error),
      },
      "DINAR AI turn failed",
    );
    send(res, {
      type: "error",
      code,
      message: "تعذر إكمال الرد الآن. رسالتك محفوظة، حاول مرة أخرى.",
    });
    res.end();
  }
});

export default router;
