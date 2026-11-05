import { useState } from "react";
import {
  ConnectReferralDisclosureSchema,
  type ConnectReferralDisclosure,
} from "@workspace/api-zod/connect";
import type { SurfaceAction } from "@workspace/api-zod/surface-composition";
import { api } from "@/account/Account";
import { Button, buttonClass } from "@/ui/Button";

/** A user gesture prepares an owner-scoped server destination. No model URL is ever opened. */
export function ExternalLinkAction({
  action,
}: {
  action: Extract<SurfaceAction, { kind: "EXTERNAL_LINK" }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState<string | null>(null);
  const [terms, setTerms] = useState<ConnectReferralDisclosure | null>(null);
  const [tracking, setTracking] = useState(false);
  const [termsBusy, setTermsBusy] = useState(false);
  const [termsNotice, setTermsNotice] = useState("");
  const loadTerms = async () => {
    if (termsBusy) return;
    setTermsBusy(true);
    setTermsNotice("");
    setTracking(false);
    try {
      setTerms(
        ConnectReferralDisclosureSchema.parse(
          await api(
            `/connect/offers/${encodeURIComponent(action.cardId)}/referral-terms`,
          ),
        ),
      );
    } catch {
      setTerms(null);
      setTermsNotice(
        "لم يتوفر إشعار إحالة مقبول لهذا العرض؛ يمكنك فتح المزوّد دون تتبّع.",
      );
    } finally {
      setTermsBusy(false);
    }
  };
  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setFallback(null);
    // Preserve the user activation for popup policies. The blank tab has no opener,
    // and only an authenticated same-origin server capability may replace it.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const result: unknown = await api("/connect/outbound", "POST", {
        resultSetId: action.resultSetId,
        cardId: action.cardId,
        trackingConsent: tracking && Boolean(terms),
        ...(tracking && terms
          ? {
              expectedAgreementId: terms.agreementId,
              expectedTermsDigest: terms.termsDigest,
              expectedPrivacyPolicyVersion: terms.privacyPolicyVersion,
            }
          : {}),
      });
      const path =
        result && typeof result === "object"
          ? (result as { openPath?: unknown }).openPath
          : undefined;
      if (
        typeof path !== "string" ||
        !/^\/api\/connect\/outbound\/[0-9a-f-]{36}$/u.test(path)
      )
        throw new Error("تعذر التحقق من وجهة الرابط.");
      if (popup) popup.location.replace(path);
      else setFallback(path);
    } catch (caught) {
      popup?.close();
      setTracking(false);
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر فتح المزوّد. أعد البحث في المحادثة.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-w-0 max-w-full" role="group" aria-label={action.label}>
      {/^[0-9a-f-]{36}$/u.test(action.providerId) && (
        <div className="mb-2 space-y-2 text-sm">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={termsBusy || busy}
            aria-busy={termsBusy}
            onClick={() => void loadTerms()}
          >
            خيارات خصوصية الإحالة
          </Button>
          {termsBusy && <p role="status">جارٍ التحقق من إشعار الإحالة…</p>}
          {termsNotice && <p role="status">{termsNotice}</p>}
          {terms && (
            <div className="space-y-2 rounded-lg border p-3">
              <p>{terms.attributionNotice}</p>
              <p>{terms.disclosure}</p>
              <p>
                هذه إحالة بالمحاكاة. مدة الإسناد:{" "}
                {terms.attributionWindowSeconds} ثانية. يمكنك سحب الموافقة من
                إعدادات الخصوصية.
              </p>
              <label className="flex min-h-11 cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0"
                  checked={tracking}
                  disabled={busy}
                  onChange={(event) => setTracking(event.target.checked)}
                  aria-label="أوافق اختياريًا على مشاركة معرّف إحالة مبهم مع المزوّد"
                />
                <span>
                  أوافق اختياريًا على مشاركة معرّف إحالة مبهم لهذا الرابط وفق
                  إشعار الخصوصية المعروض. يمكنني المتابعة دون موافقة.
                </span>
              </label>
            </div>
          )}
        </div>
      )}
      <Button
        type="button"
        size="sm"
        className="min-h-11 max-w-full"
        variant="secondary"
        disabled={busy}
        aria-busy={busy}
        aria-label={`${action.label} — يفتح خارج DINAR في نافذة جديدة`}
        onClick={() => void open()}
        data-testid={action.testId}
      >
        {busy ? "نتحقق من الرابط…" : action.label}
      </Button>
      {fallback && (
        <a
          href={fallback}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className={buttonClass("secondary", "sm")}
          data-testid="connect-external-fallback"
        >
          متابعة إلى المزوّد في نافذة جديدة
        </a>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
