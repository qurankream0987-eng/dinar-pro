import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ShieldCheck, Wrench } from "lucide-react";
import { api } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { Chip, Input } from "@/ui/Field";
import { EmptyState, ErrorState, InlineAlert, Skeleton, StatusBadge } from "@/ui/Feedback";
import { Card, PageHeader } from "@/ui/Layout";
import { ConfirmDialog } from "@/ui/Sheet";

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

type TechFilter = "ALL" | Row["technicalStatus"];
type LegalFilter = "ALL" | Row["legalStatus"];

export default function AdminArabMarketsPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [techFilter, setTechFilter] = useState<TechFilter>("ALL");
  const [legalFilter, setLegalFilter] = useState<LegalFilter>("ALL");

  const query = useQuery<{ markets: Row[] }>({
    queryKey: ["admin", "arab-readiness"],
    queryFn: () => api("/admin/markets/arab-readiness"),
  });

  const verify = async () => {
    setConfirmOpen(false);
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (techFilter !== "ALL" && row.technicalStatus !== techFilter) return false;
      if (legalFilter !== "ALL" && row.legalStatus !== legalFilter) return false;
      if (!q) return true;
      return (
        row.countryNameAr.toLowerCase().includes(q) ||
        row.marketId.toLowerCase().includes(q) ||
        (row.currencyCode ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, search, techFilter, legalFilter]);

  return (
    <div className="container-app max-w-4xl">
      <PageHeader back="/settings" title="الأسواق العربية" subtitle="الجاهزية التقنية والاعتماد القانوني منفصلان" />
      <InlineAlert tone="info" className="mb-4">
        الفحص التقني يسجّل الجاهزية التقنية فقط. لا يسجّل أي مراجعة قانونية أو موافقة. أضف المستندات القانونية لكل
        دولة لاحقًا من «الجاهزية القانونية» دون إعادة بناء السوق.
      </InlineAlert>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Button
          icon={<Wrench size={18} />}
          loading={busy}
          onClick={() => setConfirmOpen(true)}
          data-testid="button-verify-arab-markets"
        >
          شغّل الفحص التقني لكل الأسواق العربية
        </Button>
        <span className="text-sm tabular-nums text-muted-foreground" data-testid="text-arab-summary">
          {rows.length} سوقًا · {ready} جاهز تقنيًا · {approved} معتمد قانونيًا
        </span>
      </div>

      <section aria-label="البحث والتصفية" className="mb-4 space-y-3 rounded-2xl border border-border/80 bg-card/95 p-3.5 shadow-xs">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث باسم الدولة أو رمز السوق أو العملة..."
            aria-label="البحث في الأسواق العربية"
            data-testid="input-arab-market-search"
            className="ps-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">الحالة التقنية:</span>
          {(["ALL", "READY", "NOT_READY", "NOT_VERIFIED"] as const).map((status) => (
            <Chip
              key={status}
              active={techFilter === status}
              onClick={() => setTechFilter(status)}
              testId={`filter-tech-${status}`}
            >
              {status === "ALL" ? "الكل" : TECH[status].label}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">الحالة القانونية:</span>
          {(["ALL", "APPROVED", "PENDING", "SUSPENDED"] as const).map((status) => (
            <Chip
              key={status}
              active={legalFilter === status}
              onClick={() => setLegalFilter(status)}
              testId={`filter-legal-${status}`}
            >
              {status === "ALL" ? "الكل" : LEGAL[status].label}
            </Chip>
          ))}
        </div>
      </section>

      {error && <InlineAlert tone="danger" className="mb-4">{error}</InlineAlert>}
      {query.isLoading && <Skeleton className="h-40" />}
      {query.isError && <ErrorState title="تعذر تحميل الأسواق" body={friendlyError(query.error)} />}

      {!query.isLoading && !query.isError && filtered.length === 0 ? (
        <EmptyState icon={Search} title="لا توجد أسواق مطابقة للتصفية" compact />
      ) : (
        <div className="grid gap-3">
          {filtered.map((row) => (
            <Card key={row.marketId} className="rounded-2xl border-border/80 bg-card/95 p-4 shadow-xs" data-testid={`arab-market-${row.marketId}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="text-base font-bold">
                  {row.countryNameAr}{" "}
                  <span className="text-sm font-normal tabular-nums text-muted-foreground">
                    (<bdi dir="ltr">{row.marketId}</bdi> · <bdi dir="ltr">{row.currencyCode ?? "—"}</bdi>)
                  </span>
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-2 py-1">
                    <span className="text-[11px] font-medium text-muted-foreground">تقني:</span>
                    <StatusBadge label={TECH[row.technicalStatus].label} tone={TECH[row.technicalStatus].tone} testId={`tech-${row.marketId}`} />
                  </div>
                  <div className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-2 py-1">
                    <span className="text-[11px] font-medium text-muted-foreground">قانوني:</span>
                    <StatusBadge label={LEGAL[row.legalStatus].label} tone={LEGAL[row.legalStatus].tone} testId={`legal-${row.marketId}`} />
                  </div>
                </div>
              </div>
              <p className="mt-2.5 text-sm">
                <ShieldCheck size={14} className="me-1.5 inline text-primary" aria-hidden />
                {MODE[row.operationMode]}
              </p>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                المستندات القانونية: {row.legalTopicsReviewed}/{row.legalTopicsTotal} موضوعًا مراجَعًا
              </p>
              {row.technicalChecks.some((c) => !c.passed) && (
                <ul className="mt-2 list-disc ps-5 text-xs text-destructive">
                  {row.technicalChecks.filter((c) => !c.passed).map((c) => (
                    <li key={c.key}>{c.detail}</li>
                  ))}
                </ul>
              )}
              {row.remaining.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer font-semibold text-foreground">المتبقي للتشغيل التجاري القانوني</summary>
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
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="تشغيل الفحص التقني الشامل"
        body="سيُعاد فحص الجاهزية التقنية لجميع الأسواق العربية المسجلة دون تعديل حالتها القانونية. هل تريد المتابعة؟"
        confirmLabel="تشغيل الفحص الآن"
        onConfirm={() => void verify()}
      />
    </div>
  );
}