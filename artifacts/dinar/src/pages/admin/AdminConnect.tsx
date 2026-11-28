import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Globe, Code2, KeyRound, CheckCircle2, AlertTriangle } from "lucide-react";
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
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | null>(null);
  const [queue, setQueue] = useState<{
    partners: ReviewItem[];
    integrations: ReviewItem[];
  }>({ partners: [], integrations: [] });
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => setQueue(await api("/admin/connect/review")), []);

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
    <main dir="rtl" className="container-app max-w-4xl space-y-6 py-6">
      <header className="rounded-2xl border border-amber-400/30 bg-gradient-to-l from-[#071830] via-[#0e2d5a] to-[#081d3b] p-5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_18px_40px_-16px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-amber-300/40 bg-amber-400/20 text-amber-300">
            <ShieldCheck size={20} aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-extrabold md:text-2xl">مراجعة شركاء Connect</h1>
            <p className="mt-1 text-xs leading-relaxed text-sky-100/85">
              مراجعة مستقلة عن المالك. يلزم توثيق النشاط وإثبات الموقع قبل اعتماد الحساب أو صلاحيات الربط. لا يمنح الاعتماد إذنًا لتسوية أموال حقيقية.
            </p>
          </div>
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-destructive/35 bg-destructive-soft/80 px-4 py-3 text-sm font-semibold text-destructive"
        >
          <AlertTriangle size={17} aria-hidden />
          <span>{error}</span>
        </p>
      )}
      {message && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/12 px-4 py-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300"
        >
          <CheckCircle2 size={17} aria-hidden />
          <span>{message}</span>
        </p>
      )}

      <section className="rounded-2xl border border-border/80 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_28px_-14px_rgba(0,0,0,0.18)] backdrop-blur-sm md:p-5">
        <label className="block text-sm font-bold text-foreground">
          سبب القرار
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={3}
            maxLength={500}
            placeholder="وثّق سبب الاعتماد أو الرفض أو التعليق في سجل التدقيق (3 أحرف على الأقل)…"
            className="mt-2 min-h-24 w-full rounded-xl border border-border bg-background/90 p-3 text-sm outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/10"
          />
        </label>
      </section>

      {(
        [
          ["partners", "الحسابات", queue.partners],
          ["integrations", "التكاملات", queue.integrations],
        ] as const
      ).map(([kind, title, items]) => (
        <section key={kind} className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-extrabold text-foreground">{title}</h2>
            <span className="rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
              {items.length}
            </span>
          </div>
          {items.map((item) => (
            <article
              key={item.id}
              className="space-y-3 rounded-2xl border border-border/80 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_12px_30px_-14px_rgba(0,0,0,0.2)] backdrop-blur-sm md:p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-extrabold text-foreground">
                  {item.displayName ?? item.name} — {item.status}
                </h3>
                <span className="rounded-full border border-amber-400/35 bg-amber-500/12 px-3 py-0.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
                  الإصدار {item.revision} {item.businessVerificationStatus ?? item.siteStatus ?? ""}
                </span>
              </div>

              {item.hostname && (
                <p dir="ltr" className="inline-flex items-center gap-1.5 break-all rounded-lg border border-border/70 bg-muted/35 px-2.5 py-1 font-mono text-xs text-foreground">
                  <Globe size={13} className="text-primary" aria-hidden />
                  {item.hostname}
                </p>
              )}

              {item.capabilities && (
                <p className="text-xs font-medium text-muted-foreground">
                  {item.capabilities.join("، ")} — {item.mode}
                </p>
              )}

              {item.endpointUrl && (
                <dl className="grid gap-1.5 rounded-xl border border-border/70 bg-muted/25 p-3 text-xs">
                  <dt className="font-semibold text-muted-foreground">المصدر الذي سيقرأه جاسم</dt>
                  <dd dir="ltr" className="break-all font-mono text-foreground">{item.endpointUrl}</dd>
                  <dt className="mt-1 font-semibold text-muted-foreground">مسارات الإحالة المقترحة</dt>
                  <dd className="break-all text-foreground">{item.config?.allowedPathPrefixes?.join("، ")}</dd>
                </dl>
              )}

              {item.config?.websiteCategoryId && (
                <p className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  تصنيف صفحة الموقع المقترح للمراجعة: <code className="font-semibold text-foreground">{item.config.websiteCategoryId}</code>. البيانات من صفحة واحدة؛ لا شراء ولا تنفيذ JavaScript.
                </p>
              )}

              {item.config?.reviewedTools?.map((tool) => (
                <div key={tool.name} className="space-y-1.5 rounded-xl border border-border/80 bg-muted/20 p-3 text-xs">
                  <p className="flex items-center gap-1.5 font-semibold text-foreground">
                    <Code2 size={14} className="text-amber-500" aria-hidden />
                    عملية MCP المقترحة: <code className="break-all">{tool.name}</code>
                  </p>
                  <p className="text-muted-foreground">
                    {tool.capability} — {tool.readOnly ? "قراءة فقط" : "غير معتمدة للقراءة"}
                  </p>
                  <p className="text-muted-foreground">
                    بصمة مخطط المدخلات: <code dir="ltr" className="mt-0.5 block break-all rounded bg-background/80 px-2 py-1 font-mono text-[11px]">{tool.inputSchemaSha256}</code>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    يتطلب الاعتماد مراجعة المصدر والعقد؛ تلميحات المزوّد وحدها لا تمنح صلاحية.
                  </p>
                </div>
              ))}

              {item.config?.oauth && (
                <dl className="space-y-1.5 rounded-xl border border-border/80 bg-muted/20 p-3 text-xs">
                  <dt className="flex items-center gap-1.5 font-semibold text-foreground">
                    <KeyRound size={13} className="text-amber-500" aria-hidden />
                    تفويض الحساب المقترح — نطاقات القراءة
                  </dt>
                  <dd className="text-muted-foreground">{item.config.oauth.scopes.join("، ")}</dd>
                  <dt className="font-semibold text-foreground">العميل العام</dt>
                  <dd dir="ltr" className="break-all font-mono">{item.config.oauth.clientId}</dd>
                  <dt className="font-semibold text-foreground">عنوان التفويض</dt>
                  <dd dir="ltr" className="break-all font-mono">{item.config.oauth.authorizationEndpoint}</dd>
                  <dt className="font-semibold text-foreground">عنوان تبادل الرمز</dt>
                  <dd dir="ltr" className="break-all font-mono">{item.config.oauth.tokenEndpoint}</dd>
                </dl>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                {kind === "partners" && (
                  <Button variant="secondary" onClick={() => setSelectedPartnerId(item.id)}>
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
      {selectedPartnerId && <ConnectDiagnosticsPanel key={"diagnostics-" + selectedPartnerId} partnerId={selectedPartnerId} admin />}
      {selectedPartnerId && <ConnectAgreementProposal key={"agreement-" + selectedPartnerId} partnerId={selectedPartnerId} />}
      {selectedPartnerId && <ConnectDashboard key={selectedPartnerId} partnerId={selectedPartnerId} admin />}
    </main>
  );
}
