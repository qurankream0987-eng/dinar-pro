import { useCallback, useState } from "react";
import { SmartStoreCard, type CardEvent } from "@workspace/api-zod/smart-store-card";

/** Sends one event at a time to the server and always shows the server's card (also on a stale 409). */
export function useLiveSmartStoreCard(initial: SmartStoreCard) {
  const [card, setCard] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = useCallback(async (event: CardEvent) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/smart-store/cards/${encodeURIComponent(event.cardId)}/events`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
      const body = (await response.json().catch(() => ({}))) as { card?: unknown; error?: string };
      const parsed = SmartStoreCard.safeParse(body.card);
      if (parsed.success) setCard(parsed.data);
      if (!response.ok && response.status !== 409) setError(body.error ?? "تعذر تحديث البطاقة الآن.");
    } catch {
      setError("تعذر الاتصال الآن.");
    } finally {
      setBusy(false);
    }
  }, []);
  return { card, busy, error, send };
}
