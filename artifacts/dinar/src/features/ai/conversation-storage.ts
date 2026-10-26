import {
  SEARCH_OPERATORS,
  SEARCH_SORTS,
  type SearchOperator,
  type SearchSort,
} from "@workspace/api-zod/marketplace-schemas";
import { normalizeMessage, type AiMessage } from "./ai-api";

export type GuestSearchState = {
  search: string;
  categoryId?: string;
  filters: {
    field: string;
    operator: SearchOperator;
    value: string | number;
  }[];
  sort?: SearchSort;
};
export type GuestContext = {
  query?: string;
  resourceIds?: string[];
  searchState?: GuestSearchState;
};
export type GuestSellerIntent = {
  messageId: string;
  marketId: string;
  message: string;
  listingId?: string;
};
export type GuestAuthIntent = GuestSellerIntent;
export type GuestHandoffMessage = {
  id: string;
  actor: "USER" | "ASSISTANT";
  body: string;
};

const GUEST_PRIVATE_CONTENT = [
  /\b(?:password|passcode|api[_ -]?key|secret|token|bearer|authorization|private key)\b|كلمة(?: المرور| السر)|رمز(?: التحقق| الدخول)|مفتاح(?: خاص| API)/iu,
  /\b[A-Za-z0-9_-]{32,}\b/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?<!\d)(?:\+?\d[\s().-]*){10,15}(?!\d)/u,
  /(?:private|uploads?|objects?|bucket)\/[A-Za-z0-9._/-]{8,}/iu,
  /-?\d{1,2}\.\d{4,}\s*[,/]\s*-?\d{1,3}\.\d{4,}/u,
];

// A complete general answer (up to 6000 chars plus a status line) must survive restore and handoff.
const GUEST_MESSAGE_MAX = 7000;

export function isSafeGuestHandoffText(body: string) {
  return (
    body.trim().length > 0 &&
    body.length <= GUEST_MESSAGE_MAX &&
    !GUEST_PRIVATE_CONTENT.some((pattern) => pattern.test(body))
  );
}

/** Only a bounded text transcript is transferable; UI blocks and transient context are omitted. */
export function guestHandoffMessages(
  messages: AiMessage[],
  continuationMessageId?: string,
): GuestHandoffMessage[] {
  const continuationIndex = continuationMessageId
    ? messages.findIndex((message) => message.id === continuationMessageId)
    : -1;
  const completedPrefix =
    continuationIndex >= 0 ? messages.slice(0, continuationIndex) : messages;
  return completedPrefix
    .slice(-12)
    .flatMap((message) => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          message.id,
        ) ||
        (message.role !== "USER" && message.role !== "ASSISTANT") ||
        !isSafeGuestHandoffText(message.body)
      )
        return [];
      return [
        {
          id: message.id,
          actor: message.role,
          body: message.body.trim(),
        },
      ];
    });
}

function restoreSearchState(value: unknown): GuestSearchState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const state = value as Record<string, unknown>;
  if (
    typeof state.search !== "string" ||
    state.search.length > 200 ||
    !Array.isArray(state.filters) ||
    state.filters.length > 12
  )
    return;
  const filters = state.filters.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const filter = item as Record<string, unknown>;
    if (
      typeof filter.field !== "string" ||
      filter.field.length < 1 ||
      filter.field.length > 80 ||
      /seller|contact|phone|owner|user|account|email|password|token/i.test(
        filter.field,
      ) ||
      !(SEARCH_OPERATORS as readonly string[]).includes(
        String(filter.operator),
      ) ||
      !(typeof filter.value === "string" ||
        (typeof filter.value === "number" && Number.isFinite(filter.value)))
    )
      return [];
    return [{
      field: filter.field,
      operator: filter.operator as GuestSearchState["filters"][number]["operator"],
      value: filter.value as string | number,
    }];
  });
  if (filters.length !== state.filters.length) return;
  if (
    state.categoryId !== undefined &&
    (typeof state.categoryId !== "string" || state.categoryId.length > 80)
  )
    return;
  if (
    state.sort !== undefined &&
    !(SEARCH_SORTS as readonly string[]).includes(String(state.sort))
  )
    return;
  return {
    search: state.search,
    ...(typeof state.categoryId === "string" ? { categoryId: state.categoryId } : {}),
    filters,
    ...(typeof state.sort === "string"
      ? { sort: state.sort as GuestSearchState["sort"] }
      : {}),
  };
}
export function restoreGuestConversation(
  raw: string | null,
  marketId: string,
): {
  messages: AiMessage[];
  context: GuestContext;
  authIntent?: GuestAuthIntent;
  handoffId?: string;
  targetUserId?: string;
} | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !("marketId" in value) ||
      value.marketId !== marketId ||
      !("messages" in value) ||
      !Array.isArray(value.messages)
    )
      return null;
    const messages = value.messages.map(normalizeMessage);
    const rawIntent =
      ("authIntent" in value && value.authIntent) ||
      ("sellerIntent" in value && value.sellerIntent);
    const storedIntent =
      rawIntent && typeof rawIntent === "object"
        ? (rawIntent as Record<string, unknown>)
        : undefined;
    const intentMessage =
      storedIntent?.marketId === marketId &&
      typeof storedIntent.messageId === "string"
        ? messages.find(
            (message) =>
              message.id === storedIntent.messageId &&
              message.role === "USER" &&
              isSafeGuestHandoffText(message.body),
          )
        : undefined;
    const context: GuestContext = {};
    if (
      "context" in value &&
      value.context &&
      typeof value.context === "object"
    ) {
      if ("query" in value.context && typeof value.context.query === "string")
        context.query = value.context.query;
      if (
        "resourceIds" in value.context &&
        Array.isArray(value.context.resourceIds) &&
        value.context.resourceIds.every((id) => typeof id === "string")
      )
        context.resourceIds = value.context.resourceIds;
      if ("searchState" in value.context)
        context.searchState = restoreSearchState(value.context.searchState);
    }
    return {
      messages,
      context,
      ...(intentMessage
        ? {
            authIntent: {
              messageId: intentMessage.id,
              marketId,
              message: intentMessage.body,
              ...(typeof storedIntent?.listingId === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storedIntent.listingId)
                ? { listingId: storedIntent.listingId }
                : {}),
            },
          }
        : {}),
      ...("handoffId" in value &&
      typeof value.handoffId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.handoffId,
      )
        ? { handoffId: value.handoffId }
        : {}),
      ...("targetUserId" in value &&
      typeof value.targetUserId === "string" &&
      value.targetUserId.length > 0 &&
      value.targetUserId.length <= 200
        ? { targetUserId: value.targetUserId }
        : {}),
    };
  } catch {
    return null;
  }
}

/** The one tab-scoped record of a guest conversation waiting to move into an account. */
export const GUEST_HANDOFF_KEY = "dinar-guest-handoff";

export function clearGuestHandoff(): void {
  try {
    sessionStorage.removeItem(GUEST_HANDOFF_KEY);
  } catch {
    /* Storage may be unavailable (private browsing); nothing is kept then either. */
  }
}

/** Who a stored record belongs to, read without the market filter of restoreGuestConversation. */
function storedHandoffOwner(raw: string | null): { marketId?: string; targetUserId?: string; messages: number } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { messages: 0 };
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.marketId === "string" ? { marketId: record.marketId } : {}),
      ...(typeof record.targetUserId === "string" && record.targetUserId ? { targetUserId: record.targetUserId } : {}),
      messages: Array.isArray(record.messages) ? record.messages.length : 0,
    };
  } catch {
    return { messages: 0 };
  }
}

export type GuestHandoffDecision =
  /** A guest transcript exists for this identity: bind it to the account and transfer it once. */
  | { kind: "CAPTURE"; messages: AiMessage[]; saved: ReturnType<typeof restoreGuestConversation> }
  /** The transcript started in another market; it is dropped with a notice, never re-offered. */
  | { kind: "MARKET_CHANGED" }
  /** Nothing to transfer; any stale, empty or foreign record is removed. */
  | { kind: "NONE"; clearStored: boolean };

/**
 * Decides, once per authenticated identity on this page, whether a guest conversation should
 * move into the account. Only a guest transcript qualifies: the guest messages still on screen
 * from this tab's guest session, or a stored record not yet bound to another account. The
 * account's own later messages never become a "guest" transcript, and a record bound to a
 * different user (an earlier login in this tab) is discarded rather than retried or shown.
 */
export function decideGuestHandoff(input: {
  userId: string;
  marketId: string;
  raw: string | null;
  /** The page was showing this market as a guest immediately before the identity appeared. */
  cameFromGuest: boolean;
  /** Messages on screen at that moment; guest messages only when `cameFromGuest`. */
  localMessages: AiMessage[] | null;
}): GuestHandoffDecision {
  const owner = storedHandoffOwner(input.raw);
  const foreign = Boolean(owner?.targetUserId && owner.targetUserId !== input.userId);
  const saved = foreign ? null : restoreGuestConversation(input.raw, input.marketId);
  const guestOnScreen = input.cameFromGuest && input.localMessages?.length ? input.localMessages : null;
  const messages = guestOnScreen ?? (saved?.messages.length ? saved.messages : null);
  if (messages) return { kind: "CAPTURE", messages, saved };
  if (owner && !foreign && owner.messages > 0 && owner.marketId !== input.marketId) return { kind: "MARKET_CHANGED" };
  return { kind: "NONE", clearStored: Boolean(owner) };
}

/** A server refusal (4xx) is final for this handoff id: retrying it can only be refused again. */
export function isFinalHandoffRejection(cause: unknown): boolean {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

/**
 * The guest's own messages older than the 10 sent as history, as short topic hints so
 * «ارجع لموضوع …» still finds a subject that later turns pushed out. Bounded like the server
 * schema (6 × 160); the server re-sanitizes them and never routes or authorizes on them.
 */
export function earlierGuestTopics(transcript: readonly { role: string; body: string }[]): string[] {
  return transcript
    .slice(0, Math.max(0, transcript.length - 10))
    .filter((message) => message.role === "USER")
    .map((message) => message.body.replace(/\s+/g, " ").trim().slice(0, 160).trim())
    .filter(Boolean)
    .slice(-6);
}
