import { useState } from "react";
import { Button } from "@/ui/Button";
import { Field, Input } from "@/ui/Field";
import { friendlyError } from "@/lib/errors";
import { setBusinessPublication, updateBusinessInfo, uploadBusinessDocument } from "@/features/business-document-upload";
import { FactList, factRows } from "./surface/primitives";
import type { BusinessCardPayload } from "./commercial-types";

const STATUS_TONE: Record<BusinessCardPayload["status"], string> = {
  DRAFT: "bg-muted text-foreground",
  DOCUMENTS_REQUIRED: "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200",
  PENDING_REVIEW: "bg-sky-100 text-sky-900 dark:bg-sky-900/30 dark:text-sky-200",
  VERIFIED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200",
  REJECTED: "bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200",
  SUSPENDED: "bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200",
};

/**
 * D2.4 — the DINAR Business card. Display and owner actions only: every status, document and
 * permitted action is the server's; each action calls the owner-scoped API or sends a message to
 * the same conversation, and the card is rebuilt from the server afterwards.
 */
export function BusinessCardSurface({ business, active, onSend }: { business: BusinessCardPayload; active: boolean; onSend?: (text: string) => void }) {
  const send = active ? onSend : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [legalName, setLegalName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [city, setCity] = useState("");
  const uploadKind = business.requirements.find((group) => !group.satisfied)?.kinds[0] ?? business.requirements[0]?.kinds[0] ?? "COMMERCIAL_REGISTRATION";
  const has = (key: string) => business.actions.some((action) => action.key === key);
  const run = async (task: () => Promise<void>, success: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await task();
      setDone(success);
      send?.("حالة توثيق نشاطي");
    } catch (failure) {
      setError(friendlyError(failure, "تعذر إكمال الطلب الآن. حاول مرة أخرى."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section dir="rtl" aria-label="جاسم بزنس" data-testid="business-card" data-status={business.status} className="ai-surface mt-3 min-w-0 max-w-xl space-y-4 rounded-xl border border-border bg-card p-4 text-sm [overflow-wrap:anywhere]">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          {/* business.brand is the internal wire value ("DINAR BUSINESS"); users see the product name. */}
          <p className="text-xs font-semibold tracking-wide text-primary" dir="ltr">JASSIM BUSINESS</p>
          <h3 className="text-base font-semibold" data-testid="business-name">{business.displayName}</h3>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${STATUS_TONE[business.status]}`} data-testid="business-status">{business.statusLabel}</span>
      </header>
      <FactList
        rows={factRows(
          [
            ["السوق", business.marketLabel],
            ["النشاط", business.categoryLabel],
            ["المدينة", business.city],
            ["الاسم القانوني", business.legalName],
            ["الشكل القانوني", business.legalFormLabel],
            ["رقم السجل", business.registrationNumberLast4 ? <bdi dir="ltr">••••{business.registrationNumberLast4}</bdi> : undefined],
          ],
          "HIDE",
        )}
      />
      {business.honestyNote && <p className="rounded-lg bg-muted/50 p-3 text-xs leading-6 text-muted-foreground" data-testid="business-honesty">{business.honestyNote}</p>}
      {business.requirements.length > 0 && business.status !== "VERIFIED" && (
        <div className="space-y-2">
          <h4 className="font-semibold">المطلوب للتحقق</h4>
          <ul className="space-y-1">
            {business.missingInfo.map((item) => <li key={item} className="flex gap-2"><span aria-hidden>○</span><span>{item}</span></li>)}
            {business.requirements.map((group, index) => <li key={index} className="flex gap-2"><span aria-hidden>{group.satisfied ? "●" : "○"}</span><span>{group.labels.join(" أو ")}{group.satisfied ? " — مرفوع" : ""}</span></li>)}
          </ul>
        </div>
      )}
      {business.documents.length > 0 && (
        <ul className="space-y-2" aria-label="المستندات" data-testid="business-documents">
          {business.documents.map((doc) => <li key={doc.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-muted/40 p-2"><span>{doc.kindLabel}</span><span className="text-xs text-muted-foreground">{doc.scanLabel}</span></li>)}
        </ul>
      )}
      {business.lastDecisionReason && <p role="status" className="text-xs">ملاحظة المراجع: {business.lastDecisionReason}</p>}
      {business.readiness.scanner === "NOT_CONNECTED" && business.status !== "VERIFIED" && <p className="text-xs leading-6 text-muted-foreground" data-testid="business-readiness">{business.readiness.note}</p>}
      {business.integrations && (
        <div className="space-y-2" data-testid="business-integrations">
          <p className="text-xs leading-6 text-muted-foreground">{business.integrations.note}</p>
          {business.integrations.requests.map((item, index) => <p key={index} className="text-xs">{item.kindLabel} — {item.systemName}: {item.statusLabel}</p>)}
        </div>
      )}
      {send && has("COMPLETE_INFO") && (
        <form
          className="space-y-2"
          data-testid="business-info-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => updateBusinessInfo(business.id, business.revision, { legalName: legalName.trim(), registrationNumber: registrationNumber.trim(), city: city.trim() }), "حُفظت البيانات كما كتبتها (غير موثّقة بعد).");
          }}
        >
          <Field label="الاسم القانوني كما في السجل"><Input value={legalName} maxLength={200} onChange={(event) => setLegalName(event.target.value)} data-testid="business-legal-name" /></Field>
          <Field label="رقم السجل التجاري"><Input value={registrationNumber} maxLength={60} dir="ltr" inputMode="text" onChange={(event) => setRegistrationNumber(event.target.value)} data-testid="business-registration" /></Field>
          <Field label="المدينة"><Input value={city} maxLength={60} onChange={(event) => setCity(event.target.value)} /></Field>
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !(legalName.trim() || registrationNumber.trim() || city.trim())}>حفظ البيانات</Button>
        </form>
      )}
      {send && has("UPLOAD_DOCUMENTS") && (
        <label className="block space-y-2" data-testid="business-upload">
          <span className="font-medium">ارفع المستند (PDF أو JPEG أو PNG حتى 10 ميغابايت)</span>
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            disabled={busy}
            className="block w-full text-xs file:me-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-primary-foreground"
            data-testid="business-upload-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void run(() => uploadBusinessDocument(business.id, uploadKind, file), "وصل المستند وحُفظ بشكل خاص.");
            }}
          />
        </label>
      )}
      <p className="text-xs leading-6 text-muted-foreground">{business.privacyNote}</p>
      <p className="text-xs text-muted-foreground">{business.salesNote}</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {done && <p role="status">{done}</p>}
      {send && (
        <div className="flex flex-wrap gap-2" data-testid="business-actions">
          {business.actions.filter((action) => action.kind === "SEND" && action.message).map((action) => (
            <Button key={action.key} size="sm" variant={action.key === "SUBMIT_FOR_REVIEW" ? "primary" : "secondary"} disabled={busy} onClick={() => send(action.message!)} data-testid={`business-action-${action.key}`}>{action.label}</Button>
          ))}
          {business.actions.filter((action) => action.kind === "PUBLISH").map((action) => (
            <Button key={action.key} size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => setBusinessPublication(business.id, action.key === "PUBLISH"), action.key === "PUBLISH" ? "نُشرت صفحة النشاط." : "أُوقف نشر الصفحة.")} data-testid={`business-action-${action.key}`}>{action.label}</Button>
          ))}
        </div>
      )}
      {!send && <p className="text-xs text-muted-foreground">تابع من أحدث بطاقة في المحادثة.</p>}
    </section>
  );
}
