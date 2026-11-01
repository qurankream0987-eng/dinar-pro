import { DRIVER_SURFACES } from "./driver-types";
import { MEMORY_SURFACES, normalizeMemory } from "./memory-types";
import { COMMERCIAL_SURFACES, normalizeCommercial, type CommercialPayload } from "./commercial-types";
import { PROVIDER_SURFACES } from "./provider-types";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createAiGuestHandoff as requestCreateAiGuestHandoff,
  createAiLearningHistoryEvent as requestCreateAiLearningHistoryEvent,
  getGetAiConversationQueryKey,
  getGetAiConversationsQueryKey,
  getSendAiConversationTurnUrl,
  transcribeAiVoiceMessage as requestTranscribeAiVoiceMessage,
  addAiListingToCart as requestAddAiListingToCart,
  useCreateAiConversation as useGeneratedCreateAiConversation,
  useCopyAiConversation as useGeneratedCopyAiConversation,
  useDeleteAiConversation as useGeneratedDeleteAiConversation,
  useRenameAiConversation as useGeneratedRenameAiConversation,
  useGetAiConversation as useGeneratedGetAiConversation,
  useGetAiConversations as useGeneratedGetAiConversations,
} from "@workspace/api-client-react";
import type {
  AiGuestHandoffInput,
  AiPhotoSuggestion,
  AiSearchState,
  Listing,
} from "@workspace/api-client-react";
import { SEARCH_OPERATORS } from "@workspace/api-zod/marketplace-schemas";
import {
  conversationSemanticSurfacesForToken,
  isRegisteredConversationSurface,
  type TutorialLearningEventInput,
  type ConversationSurfaceToken,
  type TutorialPayload,
} from "@workspace/api-zod/conversation-runtime";
import {
  parseCardEnvelope,
  type CardEnvelope,
} from "@workspace/api-zod/surface-composition";
import {
  EMPLOYMENT_SURFACES,
  normalizeEmployment,
  type EmploymentPayload,
} from "./employment-types";
import {
  DELIVERY_SURFACES,
  normalizeDelivery,
  type DeliveryPayload,
  type LocationSubmission,
} from "./delivery-types";
import {
  PROMOTION_SURFACES,
  normalizePromotion,
  type PromotionPayload,
} from "./promotion-types";
import {
  BUSINESS_SURFACES,
  normalizeBusiness,
  type BusinessPayload,
} from "./business-types";

export type AiRole = "USER" | "ASSISTANT";

export type AiListingManagementPreview = {
  previewId: string;
  action: "UPDATE" | "PAUSE" | "RESUME" | "ARCHIVE";
  listingId: string;
  listingTitle: string;
  fieldLabel: string;
  beforeValue: string;
  afterValue: string;
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
};

export type AiConversationSummary = {
  id: string;
  title: string;
  marketId: string;
  createdAt: string;
  updatedAt: string;
};

export type AiUiBlock = {
  type: "LISTING_RESULTS" | "SURFACE";
  version: 1;
  payload: {
    memory?: import("./MemorySummary").MemoryPayload;
    policyReview?: unknown;
    commerce?: CommercialPayload;
    tutorial?: TutorialPayload;
    surface?: ConversationSurfaceToken;
    /** Wave 03: the server's typed, versioned envelope governing this card. */
    card?: CardEnvelope;
    /** G2 server-built advice (scope-labelled) and negotiation views. */
    advice?: unknown;
    negotiation?: unknown;
    /** NEXT G2 buyer–seller inquiry view (validated by InquirySurface). */
    inquiry?: unknown;
    /** Universal product control view (validated by ControlSurface). */
    control?: unknown;
    /** Server-built employment view; present only on employment surfaces. */
    employment?: EmploymentPayload;
    /** Server-built delivery/location view; present only on delivery surfaces. */
    delivery?: DeliveryPayload;
    /** Server-built seller promotion view; present only on promotion surfaces. */
    promotion?: PromotionPayload;
    /** Server-built driver view (Block F4); present only on driver surfaces. */
    driver?: unknown;
    /** Server-built provider connection view (G1); never contains a key. */
    provider?: unknown;
    /** D3-A server-built business view (setup, profile, catalog, orders, insights). */
    business?: BusinessPayload;
    draft?: Record<string, unknown>;
    draftStep?: string;
    /** Block F1 server-built draft review and seller insight. */
    draftReview?: unknown;
    sellerInsight?: unknown;
    /** Block F2 comparison and purchase review. */
    comparison?: unknown;
    purchaseReview?: unknown;
    searchState?: AiSearchState;
    /** DETAILS: one result opened from the conversation's current result set. */
    presentation?: "RESULTS" | "DETAILS";
    photoSuggestionStatus?:
      | "UNAVAILABLE"
      | "FAILED"
      | "NO_SUGGESTIONS"
      | "SUGGESTIONS";
    photoSuggestions?: AiPhotoSuggestion[];
    photoSuggestionUncertainties?: string[];
    resourceIds?: string[];
    resourceId?: string;
    /** Marker only; authorized contact is fetched separately from the order endpoint. */
    sellerContactRequested?: boolean;
    hideMap?: boolean;
    guestSellerIntent?: boolean;
    /** Local guest transcript reference used to resume this exact turn after market selection. */
    resumeMessageId?: string;
    managementPreview?: AiListingManagementPreview;
    resultSetId: string;
    listings: Listing[];
  };
};

/** A trusted action receipt (the AiActionReceipt API contract): the ledger's status, not the text's. */
export type AiActionReceipt = {
  action: string;
  lifecycle: "PROPOSED" | "REQUIRES_CONFIRMATION" | "EXECUTING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  outcome?: "REJECTED" | "CANCELLED" | "EXPIRED" | "SUPERSEDED";
  title: string;
  resource?: string;
  amount?: { value: string; currency: string; kind: "PROPOSED" | "SUBMITTED" | "AGREED" | "PAYMENT" };
  orderId?: string;
  paymentState?: "AWAITING_CONFIRMATION" | "SIMULATED_CAPTURED" | "CAPTURED";
  nextStep?: string;
  requiresConfirmation: boolean;
  failure?: string;
};

export type AiMessage = {
  id: string;
  role: AiRole;
  body: string;
  createdAt: string;
  blocks: AiUiBlock[];
  /** Present only when the server attached receipts. */
  receipts?: AiActionReceipt[];
};

const RECEIPT_LIFECYCLES = new Set(["PROPOSED", "REQUIRES_CONFIRMATION", "EXECUTING", "SUCCEEDED", "FAILED", "UNKNOWN"]);
const RECEIPT_OUTCOMES = new Set(["REJECTED", "CANCELLED", "EXPIRED", "SUPERSEDED"]);
const RECEIPT_AMOUNT_KINDS = new Set(["PROPOSED", "SUBMITTED", "AGREED", "PAYMENT"]);
const RECEIPT_PAYMENT_STATES = new Set(["AWAITING_CONFIRMATION", "SIMULATED_CAPTURED", "CAPTURED"]);
const boundedText = (value: unknown, max: number) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);

/** Only the typed receipt fields, each checked; anything else the payload carries is dropped. */
function normalizeReceipt(value: unknown): AiActionReceipt | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const action = boundedText(item.action, 40);
  const title = boundedText(item.title, 120);
  if (!action || !title || !RECEIPT_LIFECYCLES.has(item.lifecycle as string) || typeof item.requiresConfirmation !== "boolean") return null;
  const amount = item.amount as Record<string, unknown> | undefined;
  const value_ = boundedText(amount?.value, 24);
  const currency = boundedText(amount?.currency, 8);
  const resource = boundedText(item.resource, 160);
  const orderId = boundedText(item.orderId, 64);
  const nextStep = boundedText(item.nextStep, 200);
  const failure = boundedText(item.failure, 240);
  return {
    action,
    lifecycle: item.lifecycle as AiActionReceipt["lifecycle"],
    ...(RECEIPT_OUTCOMES.has(item.outcome as string) ? { outcome: item.outcome as AiActionReceipt["outcome"] } : {}),
    title,
    ...(resource ? { resource } : {}),
    ...(value_ && currency && RECEIPT_AMOUNT_KINDS.has(amount?.kind as string)
      ? { amount: { value: value_, currency, kind: amount!.kind as NonNullable<AiActionReceipt["amount"]>["kind"] } }
      : {}),
    ...(orderId ? { orderId } : {}),
    ...(RECEIPT_PAYMENT_STATES.has(item.paymentState as string) ? { paymentState: item.paymentState as AiActionReceipt["paymentState"] } : {}),
    ...(nextStep ? { nextStep } : {}),
    requiresConfirmation: item.requiresConfirmation,
    ...(failure ? { failure } : {}),
  };
}

export type AiConversationDetail = AiConversationSummary & {
  messages: AiMessage[];
};

export type AiGuestHandoffResult = AiConversationDetail & {
  continuationStatus:
    | "NOT_STARTED"
    | "PENDING"
    | "FAILED"
    | "COMPLETED"
    | "UNCERTAIN";
};

export type AiStreamEvent =
  | { type: "status"; stage: "understanding" | "searching" }
  | { type: "delta"; content: string }
  | {
      type: "complete";
      conversation: AiConversationSummary;
      userMessage: AiMessage;
      assistantMessage: AiMessage;
      blocks?: AiUiBlock[];
    }
  | { type: "error"; code?: string; message: string };

const conversationsKey = getGetAiConversationsQueryKey();
const conversationKey = (id: string) => getGetAiConversationQueryKey(id);

/** The semantic card types a listing result block may carry (it has no wire token). */
const LISTING_CARD_TYPES = new Set(["PRODUCT_RESULT_CARD", "SERVICE_RESULT_CARD", "SEARCH_RESULTS_RAIL", "LISTING_DETAIL_CARD"]);

/**
 * An envelope must describe this block: its type belongs to the block's token. A card whose
 * envelope names another surface is not rendered under this block, even when it says nothing.
 */
function cardMatchesBlock(card: CardEnvelope, type: AiUiBlock["type"], surface: ConversationSurfaceToken | undefined): boolean {
  if (type === "LISTING_RESULTS") return LISTING_CARD_TYPES.has(card.surfaceType);
  if (!surface) return false;
  return (
    card.surfaceType === surface ||
    (conversationSemanticSurfacesForToken(surface) as readonly string[]).includes(card.surfaceType)
  );
}

function normalizeBlock(value: unknown): AiUiBlock | null {
  if (!value || typeof value !== "object") return null;
  const block = value as Partial<AiUiBlock>;
  if (
    !["LISTING_RESULTS", "SURFACE"].includes(block.type ?? "") ||
    block.version !== 1 ||
    !block.payload
  )
    return null;
  const payload = block.payload as Partial<AiUiBlock["payload"]>;
  if (block.type === "SURFACE" && !isRegisteredConversationSurface(payload.surface))
    return null;
  if (payload.card !== undefined) {
    const card = parseCardEnvelope(payload.card);
    // An unknown version or a mismatched surface is never partially applied: the block is dropped.
    if (!card || !cardMatchesBlock(card, block.type as AiUiBlock["type"], payload.surface))
      return null;
    payload.card = card;
  }
  if (payload.surface && (MEMORY_SURFACES as readonly string[]).includes(payload.surface)) {
    const memory = normalizeMemory(payload.memory);
    if (!memory || memory.view !== payload.surface) return null;
  }
  if (
    payload.commerce !== undefined &&
    payload.surface &&
    (COMMERCIAL_SURFACES as readonly string[]).includes(payload.surface)
  ) {
    const commerce = normalizeCommercial(payload.commerce);
    if (!commerce || commerce.view !== payload.surface) return null;
    payload.commerce = commerce;
  }
  if (
    payload.surface &&
    (PROMOTION_SURFACES as readonly string[]).includes(payload.surface) &&
    !normalizePromotion(payload.promotion, payload.surface)
  )
    return null;
  if (
    payload.surface &&
    (DELIVERY_SURFACES as readonly string[]).includes(payload.surface) &&
    !normalizeDelivery(payload.delivery, payload.surface)
  )
    return null;
  if (
    payload.surface &&
    (EMPLOYMENT_SURFACES as readonly string[]).includes(payload.surface) &&
    !normalizeEmployment(payload.employment, payload.surface)
  )
    return null;
  if (
    payload.business !== undefined &&
    payload.surface &&
    (BUSINESS_SURFACES as readonly string[]).includes(payload.surface)
  ) {
    const business = normalizeBusiness(payload.business, payload.surface);
    if (!business) return null;
    payload.business = business;
  }
  if (
    typeof payload.resultSetId !== "string" ||
    !Array.isArray(payload.listings) ||
    payload.listings.some(
      (listing) =>
        !listing ||
        typeof listing !== "object" ||
        typeof (listing as { id?: unknown }).id !== "string",
    )
  )
    return null;
  if (payload.searchState !== undefined) {
    const searchState = payload.searchState as
      | Partial<AiSearchState>
      | undefined;
    if (
      !searchState ||
      typeof searchState.search !== "string" ||
      !Array.isArray(searchState.filters) ||
      searchState.filters.some(
        (filter) =>
          !filter ||
          typeof filter.field !== "string" ||
          !(SEARCH_OPERATORS as readonly string[]).includes(
            filter.operator,
          ) ||
          !(typeof filter.value === "string" ||
            (typeof filter.value === "number" &&
              Number.isFinite(filter.value))),
      )
    )
      return null;
  }
  if (
    payload.presentation !== undefined &&
    !["RESULTS", "DETAILS"].includes(payload.presentation)
  )
    return null;
  if (
    payload.photoSuggestionStatus !== undefined &&
    !["UNAVAILABLE", "FAILED", "NO_SUGGESTIONS", "SUGGESTIONS"].includes(
      payload.photoSuggestionStatus,
    )
  )
    return null;
  if (
    payload.photoSuggestions !== undefined &&
    (!Array.isArray(payload.photoSuggestions) ||
      payload.photoSuggestions.some(
        (suggestion) =>
          !suggestion ||
          typeof suggestion.field !== "string" ||
          !(typeof suggestion.value === "string" ||
            (typeof suggestion.value === "number" &&
              Number.isFinite(suggestion.value))) ||
          typeof suggestion.confidence !== "number" ||
          suggestion.confidence < 0 ||
          suggestion.confidence > 1 ||
          typeof suggestion.imageObjectPath !== "string",
      ))
  )
    return null;
  if (
    payload.photoSuggestionUncertainties !== undefined &&
    (!Array.isArray(payload.photoSuggestionUncertainties) ||
      payload.photoSuggestionUncertainties.some(
        (uncertainty) =>
          typeof uncertainty !== "string" ||
          ![
            "CATEGORY_UNCERTAIN",
            "MODEL_UNCERTAIN",
            "VISIBILITY_LIMITED",
            "CONDITION_NOT_VERIFIABLE",
            "SERVICE_CREDENTIALS_NOT_VERIFIABLE",
            "PARTIAL_IMAGE_COVERAGE",
            "OTHER_DETAILS_NEED_SELLER",
          ].includes(uncertainty),
      ))
  )
    return null;
  if (payload.managementPreview !== undefined) {
    const preview = payload.managementPreview as
      | Partial<AiListingManagementPreview>
      | undefined;
    if (
      !preview ||
      typeof preview.previewId !== "string" ||
      !["UPDATE", "PAUSE", "RESUME", "ARCHIVE"].includes(preview.action ?? "") ||
      typeof preview.listingId !== "string" ||
      typeof preview.listingTitle !== "string" ||
      typeof preview.fieldLabel !== "string" ||
      typeof preview.beforeValue !== "string" ||
      typeof preview.afterValue !== "string" ||
      !["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED"].includes(
        preview.status ?? "",
      )
    )
      return null;
  }
  return {
    type: block.type!,
    version: 1,
    payload: payload as AiUiBlock["payload"],
  };
}

function normalizeSummary(value: unknown): AiConversationSummary {
  if (!value || typeof value !== "object")
    throw new Error("تعذر قراءة بيانات المحادثة.");
  const item = value as Partial<AiConversationSummary> & {
    conversation?: Partial<AiConversationSummary>;
  };
  const source = item.conversation ?? item;
  if (
    typeof source.id !== "string" ||
    typeof source.title !== "string" ||
    typeof source.marketId !== "string" ||
    typeof source.createdAt !== "string" ||
    typeof source.updatedAt !== "string"
  )
    throw new Error("بيانات المحادثة غير مكتملة.");
  return {
    id: source.id,
    title: source.title,
    marketId: source.marketId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export function normalizeMessage(value: unknown): AiMessage {
  if (!value || typeof value !== "object")
    throw new Error("تعذر قراءة رسالة المحادثة.");
  const item = value as Partial<AiMessage> & {
    actor?: AiRole;
    blocks?: unknown[];
    actionReceipts?: unknown;
  };
  if (
    typeof item.id !== "string" ||
    typeof item.body !== "string" ||
    typeof item.createdAt !== "string"
  )
    throw new Error("بيانات رسالة المحادثة غير مكتملة.");
  const role = item.role ?? item.actor;
  if (role !== "USER" && role !== "ASSISTANT")
    throw new Error("نوع رسالة المحادثة غير صالح.");
  return {
    id: item.id,
    role,
    body: item.body,
    createdAt: item.createdAt,
    blocks: (item.blocks ?? [])
      .map(normalizeBlock)
      .filter((block): block is AiUiBlock => Boolean(block)),
    ...(Array.isArray(item.actionReceipts)
      ? {
          receipts: item.actionReceipts
            .map(normalizeReceipt)
            .filter((receipt): receipt is AiActionReceipt => Boolean(receipt))
            .slice(0, 12),
        }
      : {}),
  };
}

export function normalizeDetail(value: unknown): AiConversationDetail {
  if (!value || typeof value !== "object")
    throw new Error("تعذر قراءة سجل المحادثة.");
  const source = value as Partial<AiConversationDetail> & {
    conversation?: Partial<AiConversationDetail>;
  };
  const summary = normalizeSummary(source);
  const messages = (source.messages ?? []).map(normalizeMessage);
  return { ...summary, messages };
}

export async function createAiGuestHandoff(
  input: AiGuestHandoffInput,
): Promise<AiGuestHandoffResult> {
  const response = await requestCreateAiGuestHandoff(input);
  const summary = normalizeSummary(response.conversation);
  return {
    ...summary,
    messages: response.messages.map(normalizeMessage),
    continuationStatus: response.continuationStatus,
  };
}

export async function recordTutorialLearningEvent(
  input: Omit<TutorialLearningEventInput, "idempotencyKey">,
): Promise<boolean> {
  try {
    await requestCreateAiLearningHistoryEvent({
      ...input,
      idempotencyKey: crypto.randomUUID(),
    });
    return true;
  } catch {
    return false;
  }
}

export function useGetAiConversations(options?: { enabled?: boolean }) {
  const query = useGeneratedGetAiConversations({
    query: {
      enabled: options?.enabled ?? true,
      queryKey: getGetAiConversationsQueryKey(),
      staleTime: 20_000,
    },
  });
  const data = useMemo(
    () => (query.data ?? []).map(normalizeSummary),
    [query.data],
  );
  return { ...query, data };
}

export function useGetAiConversation(
  id: string | undefined,
  options?: { enabled?: boolean },
) {
  const query = useGeneratedGetAiConversation(id ?? "", {
    query: {
      enabled: Boolean(id) && (options?.enabled ?? true),
      queryKey: getGetAiConversationQueryKey(id ?? ""),
      staleTime: 20_000,
    },
  });
  const data = useMemo(
    () => (query.data ? normalizeDetail(query.data) : undefined),
    [query.data],
  );
  return { ...query, data };
}

/** Normalize generated conversation responses and seed their detail cache. */
export function useCreateAiConversation() {
  const generated = useGeneratedCreateAiConversation();
  const queryClient = useQueryClient();
  return {
    ...generated,
    mutateAsync: async () => {
      const summary = normalizeSummary(await generated.mutateAsync());
      const conversation: AiConversationDetail = { ...summary, messages: [] };
      queryClient.setQueryData(conversationKey(conversation.id), conversation);
      queryClient.invalidateQueries({ queryKey: conversationsKey });
      return conversation;
    },
  };
}

/** Copy an owned conversation as plain text; stale interactive controls are deliberately omitted. */
export function useCopyAiConversation() {
  const generated = useGeneratedCopyAiConversation();
  const queryClient = useQueryClient();
  return {
    ...generated,
    mutateAsync: async (id: string, beforeMessageId?: string) => {
      const response = await generated.mutateAsync({
        id,
        data: beforeMessageId ? { beforeMessageId } : {},
      });
      const detail = normalizeDetail(response);
      queryClient.setQueryData(getGetAiConversationQueryKey(detail.id), detail);
      await queryClient.invalidateQueries({ queryKey: getGetAiConversationsQueryKey() });
      return detail;
    },
  };
}

export function useDeleteAiConversation() {
  const generated = useGeneratedDeleteAiConversation();
  const queryClient = useQueryClient();
  return {
    ...generated,
    /** `onDeleted` runs once the server confirms, before the cache forgets the conversation,
     * so a screen showing it can let go first instead of refetching a deleted id. */
    mutateAsync: async (id: string, onDeleted?: () => void) => {
      await generated.mutateAsync({ id });
      onDeleted?.();
      queryClient.removeQueries({
        queryKey: conversationKey(id),
        exact: true,
      });
      await queryClient.invalidateQueries({ queryKey: conversationsKey });
    },
  };
}

/** The owner's label for a conversation; the list is refreshed from the server afterwards. */
export function useRenameAiConversation() {
  const generated = useGeneratedRenameAiConversation();
  const queryClient = useQueryClient();
  return {
    ...generated,
    mutateAsync: async (id: string, title: string) => {
      await generated.mutateAsync({ id, data: { title } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationsKey }),
        queryClient.invalidateQueries({ queryKey: conversationKey(id), exact: true }),
      ]);
    },
  };
}

export async function addAiListingToCartAction(
  conversationId: string,
  input: { resultSetId: string; resourceId: string },
): Promise<AiMessage> {
  const result = await requestAddAiListingToCart(conversationId, input);
  return normalizeMessage(result.assistantMessage);
}

export async function transcribeAiVoiceRecording(recording: Blob): Promise<string> {
  const result = await requestTranscribeAiVoiceMessage(recording, {
    headers: { "Content-Type": recording.type.split(";")[0] || "audio/webm" },
  });
  return result.transcript;
}

export async function sendAiConversationTurn(
  id: string,
  message: string,
  onEvent: (event: AiStreamEvent) => void,
  signal?: AbortSignal,
  clientMessageId?: string,
  imageObjectPaths?: string[],
  location?: LocationSubmission,
  reasoningEffort?: "low" | "medium" | "high",
) {
  let response: Response;
  try {
    response = await fetch(
      getSendAiConversationTurnUrl(encodeURIComponent(id)),
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        // An explicit location travels only in the POST body, never in a URL.
        body: JSON.stringify({ message, clientMessageId, imageObjectPaths, reasoningEffort, ...(location ?? {}) }),
        signal,
      },
    );
  } catch (cause) {
    if (signal?.aborted) throw cause;
    // The request may have reached the server before the connection failed: the outcome is
    // unknown until the conversation is read again, never a failure to report.
    throw Object.assign(
      cause instanceof Error ? cause : new Error("تعذر إرسال رسالتك. حاول مرة أخرى."),
      { deliveryUnknown: true },
    );
  }

  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const error =
      typeof result?.message === "string"
        ? result.message
        : "تعذر إرسال رسالتك. حاول مرة أخرى.";
    throw Object.assign(new Error(error), { status: response.status });
  }
  if (!response.body) throw new Error("تعذر بدء المحادثة. حاول مرة أخرى.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventData = "";
  let terminalEventReceived = false;

  const dispatch = () => {
    if (!eventData) return;
    // The first complete or error is final: a duplicate or a late event is never applied.
    if (terminalEventReceived) {
      eventData = "";
      return;
    }
    try {
      const event = normalizeStreamEvent(JSON.parse(eventData));
      if (event) {
        onEvent(event);
        if (event.type === "complete" || event.type === "error")
          terminalEventReceived = true;
      }
    } catch {
      // Invalid event payloads are ignored; malformed listing blocks are never rendered.
    }
    eventData = "";
  };

  const consume = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        if (eventData) eventData += "\n";
        eventData += line.slice(5).replace(/^ /, "");
      } else if (line === "") dispatch();
    }
  };

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw Object.assign(
        cause instanceof Error ? cause : new Error("انتهت المحادثة قبل وصول نتيجة مكتملة. حاول مرة أخرى."),
        { deliveryUnknown: true },
      );
    }
    if (chunk.done) break;
    consume(decoder.decode(chunk.value, { stream: true }));
  }
  consume(decoder.decode());
  if (buffer.startsWith("data:")) {
    if (eventData) eventData += "\n";
    eventData += buffer.slice(5).replace(/^ /, "");
  }
  if (eventData) {
    dispatch();
  }
  if (!terminalEventReceived)
    throw Object.assign(
      new Error("انتهت المحادثة قبل وصول نتيجة مكتملة. حاول مرة أخرى."),
      { deliveryUnknown: true },
    );
}

function normalizeStreamEvent(value: unknown): AiStreamEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (
    event.type === "status" &&
    (event.stage === "understanding" || event.stage === "searching")
  )
    return { type: "status", stage: event.stage };
  if (event.type === "delta" && typeof event.content === "string")
    return { type: "delta", content: event.content };
  if (event.type === "error" && typeof event.message === "string")
    return {
      type: "error",
      code: typeof event.code === "string" ? event.code : undefined,
      message: event.message,
    };
  if (event.type === "complete") {
    try {
      const blocks = Array.isArray(event.blocks)
        ? event.blocks
            .map(normalizeBlock)
            .filter((block): block is AiUiBlock => Boolean(block))
        : [];
      const assistantMessage = normalizeMessage(event.assistantMessage);
      const userMessage = normalizeMessage(event.userMessage);
      const conversation = normalizeSummary(event.conversation);
      if (assistantMessage.role !== "ASSISTANT" || userMessage.role !== "USER")
        return null;
      return {
        type: "complete",
        conversation,
        userMessage,
        assistantMessage: {
          ...assistantMessage,
          blocks: assistantMessage.blocks.length
            ? assistantMessage.blocks
            : blocks,
        },
        blocks,
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function aiQueryKeys() {
  return { conversations: conversationsKey, conversation: conversationKey };
}
