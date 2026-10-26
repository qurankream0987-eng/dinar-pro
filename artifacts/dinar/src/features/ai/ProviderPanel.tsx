import { useState } from "react";
import { Check, KeyRound, X } from "lucide-react";
import { Button } from "@/ui/Button";
import { PendingNotice } from "./SmartSurfaces";

/**
 * G1 provider connection views. Server-built allowlists that never carry a key: the full
 * key exists only in this component's state after the owner presses the issue button,
 * and is never sent to the conversation or stored.
 */
export { PROVIDER_SURFACES, isProviderPayload, type ProviderPayload, type ProviderSurface } from "./provider-types";
import type { Connection, ProviderPayload } from "./provider-types";

const STATUS_LABELS: Record<string, string> = { ACTIVE: "نشط", REVOKED: "موقوف" };

async function issueProviderKey(connectionId: string) {
  const response = await fetch(`/api/provider-connections/${encodeURIComponent(connectionId)}/credentials`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.key !== "string")
    throw new Error("تعذر إنشاء المفتاح. حاول لاحقًا.");
  return body.key as string;
}

function ConnectionRow({ connection }: { connection: Connection }) {
  return (
    <li className="rounded-lg border border-border p-2" data-testid="provider-connection">
      <p className="break-words font-semibold">
        {connection.name} <span className="text-xs text-muted-foreground">({STATUS_LABELS[connection.status] ?? connection.status})</span>
      </p>
      <p className="break-words text-xs text-muted-foreground">
        السوق: {connection.marketId} · المفتاح: <span dir="ltr">{connection.keyPrefix ? `${connection.keyPrefix}…` : "—"}</span> · عروض: {connection.mappedListings}
        {connection.linkedDrivers > 0 ? ` · سائقون: ${connection.linkedDrivers}` : ""}
      </p>
      <p className="break-words text-xs text-muted-foreground">{connection.scopes.map((scope) => scope.label).join("، ")}</p>
    </li>
  );
}

function SecretOnce({ connection, warning, active }: { connection: Connection; warning: string; active: boolean }) {
  const [key, setKey] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (key)
    return (
      <div className="mt-2 grid gap-2" data-testid="provider-secret">
        <span className="provider-once-badge"><KeyRound size={14} aria-hidden />يظهر مرة واحدة</span>
        <p role="alert" className="font-semibold text-warning">{warning}</p>
        <code dir="ltr" className="select-all break-all rounded-md bg-muted p-2 text-xs">{key}</code>
        <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(key)}>
          نسخ المفتاح
        </Button>
      </div>
    );
  return (
    <div className="mt-2 grid gap-2">
      <p className="text-xs text-muted-foreground">{warning}</p>
      {active && connection.status === "ACTIVE" && (
        <p className="text-xs font-semibold text-foreground" data-testid="provider-replace-notice">
          إن كان لهذا الربط مفتاح حالي فسيتوقف فورًا ويحل المفتاح الجديد محله.
        </p>
      )}
      {active && connection.status === "ACTIVE" && (
        <Button
          size="sm"
          icon={<KeyRound size={14} aria-hidden />}
          loading={busy}
          data-testid="provider-issue-key"
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              setKey(await issueProviderKey(connection.id));
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          إنشاء المفتاح وعرضه
        </Button>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function ProviderPanel({ provider, active, onSend }: { provider: ProviderPayload; active: boolean; onSend?: (text: string) => void }) {
  const canAct = active && Boolean(onSend);
  return (
    <section className="ai-surface mt-3 max-w-xl rounded-xl border border-border bg-card p-3 text-sm" aria-label="ربط الأنظمة" data-testid="provider-panel" data-view={provider.view}>
      {provider.review && (
        <ul className="grid gap-1">
          {provider.review.lines.map((line) => (
            <li key={line} className="break-words">{line}</li>
          ))}
        </ul>
      )}
      {provider.connections && provider.connections.length > 0 && (
        <ul className="grid gap-2">
          {provider.connections.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} />
          ))}
        </ul>
      )}
      {provider.view === "SECRET_ONCE" && provider.connection && (
        <>
          <ul className="grid gap-2">
            <ConnectionRow connection={provider.connection} />
          </ul>
          <SecretOnce connection={provider.connection} warning={provider.warning ?? ""} active={active} />
        </>
      )}
      {provider.limits && provider.limits.length > 0 && provider.view !== "SECRET_ONCE" && (
        <ul className="mt-2 grid gap-0.5 text-xs text-muted-foreground">
          {provider.limits.map((limit) => (
            <li key={limit} className="break-words">• {limit}</li>
          ))}
        </ul>
      )}
      {/* No server status on this view: only the live (latest) review is still actionable. */}
      {provider.view === "REVIEW" && provider.review && active && <PendingNotice />}
      {provider.view === "REVIEW" && canAct && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" icon={<Check size={14} aria-hidden />} onClick={() => onSend!("نعم")} data-testid="provider-confirm">
            تأكيد
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => onSend!("لا")} data-testid="provider-cancel">
            إلغاء
          </Button>
        </div>
      )}
    </section>
  );
}
