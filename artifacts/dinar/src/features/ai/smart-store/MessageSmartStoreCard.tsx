import { useEffect, useState } from "react";
import { SmartStoreCard } from "@workspace/api-zod/smart-store-card";
import { SmartStoreCardView } from "./SmartStoreCardView";
import { useLiveSmartStoreCard } from "./useLiveSmartStoreCard";

function Live({ initial }: { initial: SmartStoreCard }) {
  const live = useLiveSmartStoreCard(initial);
  return (
    <>
      <SmartStoreCardView card={live.card} onEvent={live.send} busy={live.busy} />
      {live.error && <p role="alert" className="mt-1 text-xs">{live.error}</p>}
    </>
  );
}

/** The server's smart store card for one assistant reply, if it issued one. Absent card: nothing shown. */
export function MessageSmartStoreCard({ messageId }: { messageId: string }) {
  const [card, setCard] = useState<SmartStoreCard | null>(null);
  useEffect(() => {
    let stopped = false;
    fetch(`/api/smart-store/cards?messageId=${encodeURIComponent(messageId)}`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { card?: unknown } | null) => {
        const parsed = SmartStoreCard.safeParse(body?.card);
        if (!stopped && parsed.success) setCard(parsed.data);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [messageId]);
  return card ? <Live key={card.cardId} initial={card} /> : null;
}
