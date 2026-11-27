import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Wrench } from "lucide-react";
import { api } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { ErrorState, InlineAlert, Skeleton, StatusBadge } from "@/ui/Feedback";
import { Card, PageHeader } from "@/ui/Layout";

type Check = { key: string; passed: boolean; detail: string };
type Row = {
  marketId: string;
  countryNameAr: string;
  currencyCode: string | null;
  technicalStatus: "READY" | "NOT_READY" | "NOT_VERIFIED";
  technicalChecks: Check[];
  technicalVerifiedAt: string | null;
  legalStatus: "APPROVED" | "PENDING" | "SUSPENDED";
  legalTopicsReviewed: number;
  legalTopicsTotal: number;
  operationMode: "FULL" | "PRE_LEGAL" | "CLOSED";
  remaining: string[];
};

const TECH = {
  READY: { label: "جاهز تقنيًا", tone: "success" },
  NOT_READY: { label: "فحص تقني فاشل", tone: "danger" },
  NOT_VERIFIED: { label: "لم يُفحص تقنيًا", tone: "neutral" },
} as const;
const LEGAL = {
  APPROVED: { label: "معتمد قانونيًا", tone: "success" },
  PENDING: { label: "بانتظار الاعتماد القانوني", tone: "warning" },
  SUSPENDED: { label: "موقوف قانونيًا", tone: "danger" },
} as const;
const MODE = {
  FULL: "تشغيل كامل (بما فيه المدفوعات المعتمدة)",
  PRE_LEGAL: "تشغيل تقني: تصفح، نشر، تفاوض، طلبات ودفع نقدي مباشر — بلا مدفوعات إلكترونية",
  CLOSED: "مغلق",
} as const;

export default function AdminArabMarketsPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery<{ markets: Row[] }>({
    queryKey: ["admin", "arab-readiness"],
    queryFn: () => api("/admin/markets/arab-readiness"),
  });
  const verify = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await api("/admin/markets/arab-readiness/verify", "POST", {});
      qc.setQueryData(["admin", "arab-readiness"], { markets: data.markets });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const rows = query.data?.markets ?? [];
  const ready = rows.filter((r) => r.technicalStatus === "READY").length;
  const approved = rows.filter((r) => r.legalStatus === "APPROVED").length;
  return (
    <div className="container-app max-w-3xl">
      <PageHeader back="/settings" title="الأسواق العربية" subtitle="الجاهزية التقنية والاعتماد القانوني منفصلان" />
      <InlineAlert tone="info" className="mb-4">
        الفحص التقني يسجّل الجاهزية التقنية فقط. لا يسجّل أي مراجعة قانونية أو موافقة. أضف المستندات القانونية لكل
        دولة لاحقًا من «الجاهزية القانونية» دون إعادة بناء السوق.
      </InlineAlert>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button icon={<Wrench size={18} />} loading={busy} onClick={verify} data-testid="button-verify-arab-markets">
          شغّل الفحص التقني لكل الأسواق العربية
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="text-arab-summary">
          {rows.length} سوقًا · {ready} جاهز تقنيًا · {approved} معتمد قانونيًا
        </span>
      </div>
      {error && <InlineAlert tone="danger" className="mb-4">{error}</InlineAlert>}
      {query.isLoading && <Skeleton className="h-40" />}
      {query.isError && <ErrorState title="تعذر تحميل الأسواق" body={friendlyError(query.error)} />}
      <div className="grid gap-3">
        {rows.map((row) => (
          <Card key={row.marketId} className="p-4" data-testid={`arab-market-${row.marketId}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold">
                {row.countryNameAr} <span className="text-sm font-normal text-muted-foreground">({row.marketId} · {row.currencyCode})</span>
              </h2>
              <div className="flex flex-wrap gap-2">
                <StatusBadge label={TECH[row.technicalStatus].label} tone={TECH[row.technicalStatus].tone} testId={`tech-${row.marketId}`} />
                <StatusBadge label={LEGAL[row.legalStatus].label} tone={LEGAL[row.legalStatus].tone} testId={`legal-${row.marketId}`} />
              </div>
            </div>
            <p className="mt-2 text-sm">
              <ShieldCheck size={14} className="me-1 inline" />
              {MODE[row.operationMode]}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              المستندات القانونية: {row.legalTopicsReviewed}/{row.legalTopicsTotal} موضوعًا مراجَعًا
            </p>
            {row.technicalChecks.some((c) => !c.passed) && (
              <ul className="mt-2 list-disc ps-5 text-sm text-danger">
                {row.technicalChecks.filter((c) => !c.passed).map((c) => (
                  <li key={c.key}>{c.detail}</li>
                ))}
              </ul>
            )}
            {row.remaining.length > 0 && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer font-semibold">المتبقي للتشغيل التجاري القانوني</summary>
                <ul className="mt-1 list-disc ps-5 text-muted-foreground">
                  {row.remaining.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
