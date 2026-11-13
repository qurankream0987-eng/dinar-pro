import { useCallback, useEffect, useState } from "react";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
import { ConnectAgreementProposal } from "@/features/ConnectAgreementProposal";
import { ConnectDiagnosticsPanel } from "@/features/ConnectDiagnostics";
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
  endpointUrl?: string | null;
  config?: {
    allowedPathPrefixes?: string[];
    websiteCategoryId?: string;
    reviewedTools?: { name: string; inputSchemaSha256: string; readOnly: boolean; capability: string }[];
    oauth?: { authorizationEndpoint: string; tokenEndpoint: string; clientId: string; scopes: string[] };
  };
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
              {item.endpointUrl && <dl className="space-y-1"><dt>المصدر الذي سيقرأه جاسم</dt><dd dir="ltr" className="break-all">{item.endpointUrl}</dd><dt>مسارات الإحالة المقترحة</dt><dd className="break-all">{item.config?.allowedPathPrefixes?.join("، ")}</dd></dl>}
              {item.config?.websiteCategoryId && <p>تصنيف صفحة الموقع المقترح للمراجعة: <code>{item.config.websiteCategoryId}</code>. البيانات من صفحة واحدة؛ لا شراء ولا تنفيذ JavaScript.</p>}
              {item.config?.reviewedTools?.map(tool => <div key={tool.name} className="space-y-1 rounded-lg border p-2"><p>عملية MCP المقترحة: <code className="break-all">{tool.name}</code></p><p>{tool.capability} — {tool.readOnly ? "قراءة فقط" : "غير معتمدة للقراءة"}</p><p>بصمة مخطط المدخلات: <code dir="ltr" className="block break-all">{tool.inputSchemaSha256}</code></p><p>يتطلب الاعتماد مراجعة المصدر والعقد؛ تلميحات المزوّد وحدها لا تمنح صلاحية.</p></div>)}
              {item.config?.oauth && <dl className="space-y-1 rounded-lg border p-2"><dt>تفويض الحساب المقترح — نطاقات القراءة</dt><dd>{item.config.oauth.scopes.join("، ")}</dd><dt>العميل العام</dt><dd dir="ltr" className="break-all">{item.config.oauth.clientId}</dd><dt>عنوان التفويض</dt><dd dir="ltr" className="break-all">{item.config.oauth.authorizationEndpoint}</dd><dt>عنوان تبادل الرمز</dt><dd dir="ltr" className="break-all">{item.config.oauth.tokenEndpoint}</dd></dl>}
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
      {selectedPartnerId && <ConnectDiagnosticsPanel key={"diagnostics-"+selectedPartnerId} partnerId={selectedPartnerId} admin />}
      {selectedPartnerId && <ConnectAgreementProposal key={"agreement-"+selectedPartnerId} partnerId={selectedPartnerId} />}
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
