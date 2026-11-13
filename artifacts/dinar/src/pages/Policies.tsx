import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ChevronLeft, FileText } from "lucide-react";
import { api } from "@/account/Account";
import { Badge, ErrorState, Skeleton } from "@/ui/Feedback";
import { PageHeader } from "@/ui/Layout";

export type PolicySummary = {
  key: string;
  version: string;
  effectiveDate: string;
  titleAr: string;
  summaryAr: string;
  legalReviewStatus: "PENDING_LEGAL_APPROVAL" | "APPROVED";
  requiresAcceptance: boolean;
};
type PolicyDocument = PolicySummary & {
  sections: { heading: string; body: string }[];
};
export type PolicyIndex = {
  policies: PolicySummary[];
  fees: { commissionRateBps: number; payer: "SELLER"; buyerFeeBps: number };
};

/** Server-authored fee and policy registry; UI never hardcodes the rate. */
export function usePolicyIndex() {
  return useQuery<PolicyIndex>({
    queryKey: ["policies"],
    queryFn: async () => (await api("/policies")) as PolicyIndex,
    staleTime: 300_000,
  });
}

export function commissionPercentLabel(bps: number | undefined) {
  return bps === undefined
    ? "…"
    : `${(bps / 100).toLocaleString("ar", { maximumFractionDigits: 2 })}٪`;
}

function LegalReviewBadge({ status }: { status: PolicySummary["legalReviewStatus"] }) {
  return status === "APPROVED" ? null : (
    <Badge tone="warning" testId="badge-legal-review">
      بانتظار المراجعة القانونية
    </Badge>
  );
}

export function PoliciesIndexPage() {
  const policies = usePolicyIndex();
  return (
    <div className="container-app max-w-2xl">
      <PageHeader
        back
        title="الشروط والسياسات"
        subtitle="كل ما يحكم استخدام جاسم في مكان واحد"
      />
      {policies.isLoading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : policies.error ? (
        <ErrorState onRetry={() => policies.refetch()} />
      ) : (
        <ul className="space-y-2" data-testid="list-policies">
          {policies.data!.policies.map((policy) => (
            <li key={policy.key}>
              <Link
                href={`/policies/${policy.key}`}
                className="pressable flex items-center gap-3 rounded-xl border border-border bg-card p-4 hover:bg-muted"
                data-testid={`link-policy-${policy.key}`}
              >
                <FileText size={20} className="shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-bold">{policy.titleAr}</span>
                  <span className="block text-sm text-muted-foreground">
                    {policy.summaryAr}
                  </span>
                </span>
                <ChevronLeft size={18} className="text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PolicyPage() {
  const params = useParams<{ key: string }>();
  return <PolicyDocument policyKey={params.key} />;
}

/** A fixed public URL (/privacy, /terms) showing the same published document as /policies/:key. */
export function FixedPolicyPage({ policyKey }: { policyKey: "privacy" | "terms" }) {
  return <PolicyDocument policyKey={policyKey} />;
}

function PolicyDocument({ policyKey }: { policyKey: string }) {
  const key = policyKey;
  const policy = useQuery<PolicyDocument>({
    queryKey: ["policy", key],
    queryFn: async () => (await api(`/policies/${encodeURIComponent(key)}`)) as PolicyDocument,
    staleTime: 300_000,
  });
  if (policy.isLoading)
    return (
      <div className="container-app max-w-2xl pt-6">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  if (policy.error || !policy.data)
    return (
      <div className="container-app max-w-2xl pt-6">
        <ErrorState onRetry={() => policy.refetch()} />
      </div>
    );
  const document = policy.data;
  return (
    <article className="container-app max-w-2xl" data-testid={`policy-${document.key}`}>
      <PageHeader
        back="/policies"
        title={document.titleAr}
        subtitle={`الإصدار ${document.version} · ساري من ${document.effectiveDate}`}
        actions={<LegalReviewBadge status={document.legalReviewStatus} />}
      />
      <div className="space-y-3">
        {document.sections.map((section, index) => (
          <section
            key={section.heading}
            className="rounded-xl border border-border bg-card p-4 md:p-5"
          >
            <h2 className="flex items-center gap-2 text-md font-bold">
              <span className="num flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs">
                {index + 1}
              </span>
              {section.heading}
            </h2>
            <p className="mt-2 text-base leading-7 text-text-secondary">
              {section.body}
            </p>
          </section>
        ))}
      </div>
      <p className="mt-4 text-center text-sm">
        <Link href="/policies" className="font-semibold text-primary">
          كل السياسات
        </Link>
      </p>
    </article>
  );
}
