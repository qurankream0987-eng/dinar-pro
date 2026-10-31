import { useEffect, useRef } from "react";

/**
 * Minimal cross-tab card signal.
 *
 * One tab tells sibling tabs of the same signed-in account in the same market that a conversation
 * may have changed. The message carries no card, no resource facts and no authority: a receiving
 * tab only invalidates its conversation query and lets the server rebuild every envelope. Any
 * message from another account or market, any unknown field and any malformed identity is
 * refused, so a forged broadcast can never enact anything.
 */
export const CARD_SYNC_TYPE = "dinar.cards.invalidate";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKET = /^[A-Z]{2}$/;
const KEYS = ["type", "userId", "marketId", "conversationId", "issuedAt"].sort().join(",");

export type CardSyncEvent = {
  type: typeof CARD_SYNC_TYPE;
  userId: string;
  marketId: string;
  conversationId: string;
  issuedAt: number;
};

export function cardSyncChannelName(userId: string, marketId: string): string {
  return `dinar:card-sync:v1:${userId}:${marketId}`;
}

export function cardSyncEvent(
  userId: string,
  marketId: string,
  conversationId: string,
  issuedAt: number = Date.now(),
): CardSyncEvent {
  return { type: CARD_SYNC_TYPE, userId, marketId, conversationId, issuedAt };
}

/** Returns the event only when it addresses this exact account and market with the exact shape. */
export function parseCardSyncEvent(
  value: unknown,
  userId: string,
  marketId: string,
): CardSyncEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== KEYS) return null;
  if (record.type !== CARD_SYNC_TYPE) return null;
  if (record.userId !== userId || record.marketId !== marketId) return null;
  if (typeof record.conversationId !== "string" || !UUID.test(record.conversationId)) return null;
  if (typeof record.issuedAt !== "number" || !Number.isSafeInteger(record.issuedAt) || record.issuedAt <= 0) return null;
  return {
    type: CARD_SYNC_TYPE,
    userId,
    marketId,
    conversationId: record.conversationId,
    issuedAt: record.issuedAt,
  };
}

/** Announces a server-confirmed change to sibling tabs; it never carries what changed. */
export function publishCardSync(
  userId: string | null | undefined,
  marketId: string | null | undefined,
  conversationId: string | null | undefined,
): void {
  if (!userId || !marketId || !conversationId) return;
  if (!UUID.test(userId) || !MARKET.test(marketId) || !UUID.test(conversationId)) return;
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(cardSyncChannelName(userId, marketId));
  try {
    channel.postMessage(cardSyncEvent(userId, marketId, conversationId));
  } finally {
    channel.close();
  }
}

export function useCardSync(
  userId: string | null | undefined,
  marketId: string | null | undefined,
  onInvalidate: (event: CardSyncEvent) => void,
): void {
  const handler = useRef(onInvalidate);
  handler.current = onInvalidate;
  useEffect(() => {
    if (!userId || !marketId || !UUID.test(userId) || !MARKET.test(marketId)) return;
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(cardSyncChannelName(userId, marketId));
    channel.onmessage = (message: MessageEvent) => {
      const event = parseCardSyncEvent(message.data, userId, marketId);
      if (event) handler.current(event);
    };
    return () => {
      channel.onmessage = null;
      channel.close();
    };
  }, [userId, marketId]);
}
