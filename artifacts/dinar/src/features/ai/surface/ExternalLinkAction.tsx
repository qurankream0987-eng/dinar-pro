import { useState } from "react";
import type { SurfaceAction } from "@workspace/api-zod/surface-composition";
import { api } from "@/account/Account";
import { Button, buttonClass } from "@/ui/Button";

/** A user gesture prepares an owner-scoped server destination. No model URL is ever opened. */
export function ExternalLinkAction({ action }: { action: Extract<SurfaceAction, { kind: "EXTERNAL_LINK" }> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState<string | null>(null);
  const open = async () => {
    if (busy) return;
    setBusy(true); setError(""); setFallback(null);
    // Preserve the user activation for popup policies. The blank tab has no opener,
    // and only an authenticated same-origin server capability may replace it.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const result: unknown = await api("/connect/outbound", "POST", { resultSetId: action.resultSetId, cardId: action.cardId, trackingConsent: false });
      const path = result && typeof result === "object" ? (result as { openPath?: unknown }).openPath : undefined;
      if (typeof path !== "string" || !/^\/api\/connect\/outbound\/[0-9a-f-]{36}$/u.test(path)) throw new Error("تعذر التحقق من وجهة الرابط.");
      if (popup) popup.location.replace(path);
      else setFallback(path);
    } catch (caught) {
      popup?.close();
      setError(caught instanceof Error ? caught.message : "تعذر فتح المزوّد. أعد البحث في المحادثة.");
    } finally { setBusy(false); }
  };
  return <div className="min-w-0 max-w-full">
    <Button type="button" size="sm" className="min-h-11 max-w-full" variant="secondary" disabled={busy} aria-busy={busy} aria-label={`${action.label} — يفتح خارج DINAR في نافذة جديدة`} onClick={() => void open()} data-testid={action.testId}>
      {busy ? "نتحقق من الرابط…" : action.label}
    </Button>
    {fallback && <a href={fallback} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={buttonClass("secondary", "sm")} data-testid="connect-external-fallback">متابعة إلى المزوّد في نافذة جديدة</a>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
  </div>;
}
