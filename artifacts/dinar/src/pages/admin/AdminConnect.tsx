import { useCallback, useEffect, useState } from "react";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
import { ConnectDashboard } from "@/features/ConnectDashboard";
type ReviewItem = {
  id: string;
  revision: number;
  status: string;
  displayName?: string;
  name?: string;
  businessVerificationStatus?: string;
  hostname?: string;
  siteStatus?: string;
  mode?: string;
  capabilities?: string[];
};
export default function AdminConnect() {
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | null>(
    null,
  );
  const [queue, setQueue] = useState<{
      partners: ReviewItem[];
      integrations: ReviewItem[];
    }>({ partners: [], integrations: [] }),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const reload = useCallback(
    async () => setQueue(await api("/admin/connect/review")),
    [],
  );
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [reload]);
  const decide = async (kind: string, item: ReviewItem, decision: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`/admin/connect/${kind}/${item.id}/review`, "POST", {
        decision,
        expectedRevision: item.revision,
        reason,
      });
      await reload();
      setMessage("حفظ الخادم قرار المراجعة وسجل التدقيق.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذرت المراجعة");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main dir="rtl" className="container-app max-w-3xl space-y-4 py-6">
      <h1 className="text-2xl font-bold">مراجعة شركاء Connect</h1>
      <p>
        مراجعة مستقلة عن المالك. يلزم توثيق النشاط وإثبات الموقع قبل اعتماد
        الحساب أو صلاحيات الربط. لا يمنح الاعتماد إذنًا لتسوية أموال حقيقية.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <label className="block">
        سبب القرار
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={3}
          maxLength={500}
          className="mt-2 min-h-24 w-full rounded-lg border bg-background p-3"
        />
      </label>
      {(
        [
          ["partners", "الحسابات", queue.partners],
          ["integrations", "التكاملات", queue.integrations],
        ] as const
      ).map(([kind, title, items]) => (
        <section key={kind} className="space-y-3">
          <h2 className="font-bold">{title}</h2>
          {items.map((item) => (
            <article key={item.id} className="space-y-2 rounded-xl border p-4">
              <h3>
                {item.displayName ?? item.name} — {item.status}
              </h3>
              <p>
                الإصدار {item.revision}{" "}
                {item.businessVerificationStatus ?? item.siteStatus ?? ""}
              </p>
              {item.hostname && (
                <p dir="ltr" className="break-all">
                  {item.hostname}
                </p>
              )}
              {item.capabilities && (
                <p>
                  {item.capabilities.join("، ")} — {item.mode}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {kind === "partners" && (
                  <Button
                    variant="secondary"
                    onClick={() => setSelectedPartnerId(item.id)}
                  >
                    تقرير الحساب والمراجعة المالية
                  </Button>
                )}
                {[
                  ["APPROVE", "اعتماد الإصدار المعروض"],
                  ["REJECT", "رفض"],
                  ["SUSPEND", "تعليق"],
                ].map(([decision, label]) => (
                  <Button
                    key={decision}
                    variant={decision === "APPROVE" ? "primary" : "secondary"}
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => void decide(kind, item, decision!)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </article>
          ))}
        </section>
      ))}
      {selectedPartnerId && (
        <ConnectDashboard
          key={selectedPartnerId}
          partnerId={selectedPartnerId}
          admin
        />
      )}
    </main>
  );
}
