import { useCallback, useEffect, useState } from "react";
import {
  ConnectDiagnosticsSchema,
  type ConnectDiagnostics,
} from "@workspace/api-zod/connect-platform";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
const states: Record<string, string> = {
  APPROVED: "معتمد",
  PENDING_REVIEW: "بانتظار المراجعة",
  REJECTED: "مرفوض",
  SUSPENDED: "معلّق",
  REVOKED: "ملغى",
  PENDING: "بانتظار الإثبات",
  VERIFIED: "مثبت",
  ACTIVE: "نشط",
  NOT_CONFIGURED: "غير مهيأ",
};
const reasons: Record<string, string> = {
  PROVIDER_TIMEOUT: "انتهت مهلة المزوّد",
  PROVIDER_RATE_LIMITED: "حد طلبات المزوّد",
  PROVIDER_UNAVAILABLE: "تعذر رد المزوّد",
  PRIVATE_ENDPOINT: "رفض عنوان شبكة غير عام",
  REDIRECT_REFUSED: "رفض تحويل إلى رابط آخر",
  PINNED_EGRESS_REQUIRED: "مسار اتصال آمن غير متاح",
  OAUTH_GRANT_UNAVAILABLE: "تفويض الحساب غير صالح",
  STALE_INTEGRATION: "تغيرت نسخة الربط",
  UNEXPECTED_FAILURE: "تعذرت المزامنة دون تفاصيل عامة",
};
const actions: Record<string, string> = {
  CATALOG_SYNC_COMPLETED: "اكتملت محاولة مزامنة مقبولة",
  CATALOG_SYNC_FAILED: "تعذرت محاولة مزامنة مقبولة",
  CATALOG_IMPORTED: "قبول دفعة كتالوج",
  PARTNER_APPROVED: "اعتماد حساب الشريك",
  PARTNER_SUSPENDED: "تعليق حساب الشريك",
  INTEGRATION_APPROVED: "اعتماد ربط",
  INTEGRATION_SUSPENDED: "تعليق ربط",
  AGREEMENT_PROPOSED: "اقتراح نسخة اتفاقية",
  AGREEMENT_ACCEPTED: "قبول نسخة اتفاقية",
  MARK_PAYABLE: "إثبات استحقاق بالمحاكاة",
  RECONCILE_SIMULATED_SETTLEMENT: "مراجعة تسوية اصطناعية",
  OPEN_DISPUTE: "فتح نزاع",
  RESOLVE_DISPUTE: "تسوية نزاع",
};
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString("ar") : "لا توجد ملاحظة مسجلة";
export function ConnectDiagnosticsPanel({
  partnerId,
  admin = false,
}: {
  partnerId: string;
  admin?: boolean;
}) {
  const [data, setData] = useState<ConnectDiagnostics | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [page, setPage] = useState<{
    integrationCursor?: string;
    auditCursor?: string;
  }>({});
  const endpoint = `${admin ? "/admin" : ""}/connect/partners/${partnerId}/diagnostics`;
  const load = useCallback(
    async (integrationCursor?: string, auditCursor?: string) => {
      setBusy(true);
      setError("");
      try {
        const query = new URLSearchParams();
        if (integrationCursor)
          query.set("integrationCursor", integrationCursor);
        if (auditCursor) query.set("auditCursor", auditCursor);
        const result = ConnectDiagnosticsSchema.parse(
          await api(endpoint + (query.size ? "?" + query.toString() : "")),
        );
        setData(result);
        setPage({ integrationCursor, auditCursor });
      } catch (e) {
        setError(e instanceof Error ? e.message : "تعذرت قراءة التشخيصات");
      } finally {
        setBusy(false);
      }
    },
    [endpoint],
  );
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  return (
    <section
      aria-label="تشخيصات الربط وسجل التدقيق"
      className="min-w-0 space-y-3 rounded-xl border p-4 [overflow-wrap:anywhere]"
    >
      <h2 className="font-bold">تشخيصات الربط وسجل التدقيق</h2>
      <p>
        هذه ملاحظات مسجلة داخل DINAR؛ لم يُنفّذ فحص اتصال حي بالمزوّد. حالة
        التفويض تُراجع من أدوات حساب الربط، ويعاد التحقق من صلاحيات كل عملية عند
        تنفيذها.
      </p>
      {busy && <p role="status">جارٍ قراءة سجلات الربط…</p>}
      {error && <p role="alert">{error}</p>}
      <Button variant="secondary" disabled={busy} onClick={() => void load()}>
        تحديث تشخيصات الربط
      </Button>
      {data && (
        <>
          <p>
            وقت السجل:{" "}
            <time dateTime={data.generatedAt}>{time(data.generatedAt)}</time>
          </p>
          <dl className="space-y-2 rounded-lg border p-3">
            {(
              [
                [
                  "failedAdmittedReads24h",
                  "محاولات مزامنة مقبولة تعذرت خلال 24 ساعة",
                ],
                [
                  "protectedResponseRefusals24h",
                  "ردود رُفضت لحماية الربط خلال 24 ساعة",
                ],
                ["suspensions24h", "أحداث تعليق خلال 24 ساعة"],
                ["currentDisputes", "معاملات في نزاع حاليًا"],
                [
                  "recoveryObligationTransactions",
                  "معاملات عليها التزام استرداد مستقل",
                ],
              ] as const
            ).map(([key, label]) => (
              <div className="flex flex-wrap justify-between gap-2" key={key}>
                <dt>{label}</dt>
                <dd>{data.reviewSignals[key]}</dd>
              </div>
            ))}
          </dl>
          {data.integrations.length === 0 && (
            <p>لا توجد روابط في هذه الصفحة.</p>
          )}
          {data.integrations.map((source) => (
            <article
              key={source.id}
              className="space-y-2 rounded-lg border p-3"
            >
              <h3 className="font-bold">{source.name}</h3>
              <p>
                {states[source.status] ?? source.status} — النسخة{" "}
                {source.revision}؛ النسخة المعتمدة{" "}
                {source.approvedRevision ?? "لم تعتمد"}
              </p>
              <p>
                إثبات الموقع: {states[source.siteStatus] ?? source.siteStatus} —{" "}
                {source.proofCurrentlyValid
                  ? "صالح في وقت قراءة السجل"
                  : "لا يثبت صلاحية حالية"}
                ؛ الانتهاء: {time(source.proofValidUntil)}
              </p>
              <p>
                مصدر قراءة مهيأ:{" "}
                {source.endpointConfigured ? "نعم؛ ليس إثبات اتصال حي" : "لا"}
              </p>
              <p>
                الاستقبال من المزوّد:{" "}
                {states[source.ingressStatus] ?? source.ingressStatus}؛ مفاتيح
                واردة نشطة: {source.activeIngressCredentials}. آخر مزامنة واردة
                ناجحة: {time(source.lastSuccessfulIngressAt)}
              </p>
              <p>
                عناصر منشورة: {source.catalog.published}؛ مخفية:{" "}
                {source.catalog.hidden}؛ سجلات تجاوز فحصها 24 ساعة:{" "}
                {source.catalog.stale}. آخر قبول كتالوج:{" "}
                {time(source.lastCatalogAcceptedAt)}
              </p>
              {source.lastObservedSync ? (
                <p>
                  آخر محاولة مسجلة خلال 24 ساعة:{" "}
                  {source.lastObservedSync.outcome === "COMPLETED"
                    ? "اكتملت"
                    : "تعذرت"}{" "}
                  — {time(source.lastObservedSync.observedAt)}؛ استغرقت القراءة
                  والتحقق {source.lastObservedSync.durationMs} مللي ثانية، لنسخة
                  الربط {source.lastObservedSync.reviewedRevision}.
                  {source.lastObservedSync.reason &&
                    ` ${reasons[source.lastObservedSync.reason] ?? "رفضت استجابة المزوّد أو لم تستوفِ عقد القراءة المعتمد"}.`}
                </p>
              ) : (
                <p>
                  لا توجد محاولة مزامنة مقبولة مسجلة لهذا الربط خلال 24 ساعة.
                  غياب سجل فشل لا يعني نجاح الاتصال.
                </p>
              )}
            </article>
          ))}
          {data.nextIntegrationCursor && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void load(data.nextIntegrationCursor!, page.auditCursor)
              }
            >
              الصفحة التالية للروابط
            </Button>
          )}
          <h3 className="font-bold">سجل التدقيق الموثّق</h3>
          {data.audit.length === 0 && <p>لا توجد أحداث تدقيق في هذه الصفحة.</p>}
          <ol className="space-y-2">
            {data.audit.map((event) => (
              <li key={event.id} className="rounded-lg border p-2">
                <p>{actions[event.action] ?? "حدث تدقيق مسجل"}</p>
                <p>
                  <time dateTime={event.createdAt}>
                    {time(event.createdAt)}
                  </time>{" "}
                  —{" "}
                  {
                    {
                      OWNER: "المالك",
                      ADMIN: "مسؤول مستقل",
                      PROVIDER: "المزوّد",
                      SYSTEM: "النظام",
                    }[event.actorKind]
                  }
                </p>
                {admin && (
                  <code dir="ltr" className="block break-all text-xs">
                    {event.action}
                  </code>
                )}
              </li>
            ))}
          </ol>
          {data.nextAuditCursor && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void load(page.integrationCursor, data.nextAuditCursor!)
              }
            >
              الصفحة التالية لسجل التدقيق
            </Button>
          )}
          <p className="text-sm">{data.disclosure}</p>
        </>
      )}
    </section>
  );
}
