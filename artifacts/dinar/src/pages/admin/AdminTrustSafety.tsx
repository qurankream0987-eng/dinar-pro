import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, ShieldAlert } from "lucide-react";
import { api, useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { Badge, EmptyState, ErrorState, InlineAlert, Skeleton } from "@/ui/Feedback";
import { Field, Input, Segmented, Select, Textarea } from "@/ui/Field";
import { Card, CardTitle, PageHeader } from "@/ui/Layout";

type Tab = "reports" | "listings" | "users" | "rules" | "policies" | "audit";
type ReportRow = {
  id: string;
  targetType: "LISTING" | "USER" | "ORDER";
  targetId: string;
  reasonCode: string;
  reasonLabel: string;
  note: string;
  status: string;
  createdAt: string;
  reporterName: string;
  resolutionNote: string | null;
  /** Server-computed against DINAR_REPORT_RESPONSE_HOURS; null when no target is approved. */
  dueAt: string | null;
  overdue: boolean;
  target: null | Record<string, any>;
};
type UserRow = { id: string; displayName: string; status: string; role: string; createdAt: string };
type RuleRow = { id: string; marketId: string | null; kind: string; value: string; reasonCode: string; isActive: boolean; note: string };
type AuditRow = { id: string; action: string; targetType: string; targetId: string; reason: string; actorName: string; createdAt: string };
type PolicyAdmin = {
  policies: { key: string; titleAr: string; version: string; effectiveDate: string; legalReviewStatus: string }[];
  retention: { record: string; handling: string; reason: string; period: string }[];
};

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ACTIVE: "success",
  RESTRICTED: "warning",
  SUSPENDED: "danger",
  DEACTIVATED: "neutral",
};
const ACTIONS_BY_TARGET: Record<ReportRow["targetType"], { value: string; label: string }[]> = {
  LISTING: [
    { value: "HIDE_LISTING", label: "إخفاء العرض" },
    { value: "REMOVE_LISTING", label: "حذف العرض إداريًا" },
    { value: "RESTRICT_USER", label: "تقييد البائع" },
    { value: "SUSPEND_USER", label: "إيقاف البائع" },
  ],
  USER: [
    { value: "RESTRICT_USER", label: "تقييد الحساب" },
    { value: "SUSPEND_USER", label: "إيقاف الحساب" },
  ],
  ORDER: [
    { value: "RESTRICT_USER", label: "تقييد طرف" },
    { value: "SUSPEND_USER", label: "إيقاف طرف" },
  ],
};

function when(value: string) {
  return new Date(value).toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" });
}

function TargetSummary({ target }: { target: ReportRow["target"] }) {
  if (!target) return <p className="text-sm text-muted-foreground">الهدف لم يعد موجودًا.</p>;
  if (target.kind === "LISTING")
    return (
      <p className="text-sm">
        عرض <b>{target.title}</b> · البائع {target.sellerName}{" "}
        <Badge tone={STATUS_TONE[target.sellerStatus] ?? "neutral"}>{target.sellerStatus}</Badge> · الحالة{" "}
        <Badge>{target.status}</Badge> · السوق {target.marketId}
      </p>
    );
  if (target.kind === "ORDER")
    return (
      <p className="text-sm">
        طلب <b>{target.title}</b> · المشتري {target.buyerName} · البائع {target.sellerName} ·{" "}
        <Badge>{target.status}</Badge>
      </p>
    );
  return (
    <p className="text-sm">
      حساب <b>{target.displayName}</b>{" "}
      <Badge tone={STATUS_TONE[target.status] ?? "neutral"}>{target.status}</Badge> · عروض منشورة{" "}
      {target.publishedListings} · طلبات {target.orders} · بلاغات مفتوحة {target.openReports}
    </p>
  );
}

function ReportCard({ report, onDone }: { report: ReportRow; onDone: () => void }) {
  const [action, setAction] = useState("");
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("");
  const resolve = useMutation({
    mutationFn: (decision: "DISMISS" | "ACTION") =>
      api(`/admin/reports/${report.id}/resolve`, "POST", {
        decision,
        ...(decision === "ACTION" ? { action } : {}),
        ...(decision === "ACTION" && report.targetType === "ORDER" ? { subjectUserId: subject } : {}),
        reason,
      }),
    onSuccess: onDone,
  });
  const open = report.status === "OPEN";
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2" data-testid={`admin-report-${report.id}`}>
        <Badge tone={open ? "warning" : "neutral"}>{report.status}</Badge>
        <Badge tone="info">{report.targetType}</Badge>
        <b>{report.reasonLabel}</b>
        <span className="text-sm text-muted-foreground">
          من {report.reporterName} · {when(report.createdAt)}
        </span>
        {open && report.overdue && <Badge tone="danger" testId={`admin-report-overdue-${report.id}`}>متأخر عن موعد الرد</Badge>}
        {open && report.dueAt && !report.overdue && <span className="text-xs text-muted-foreground">الرد قبل {when(report.dueAt)}</span>}
      </div>
      <div className="mt-2">
        <TargetSummary target={report.target} />
      </div>
      {report.note && <p className="mt-2 rounded-md bg-muted p-2 text-sm">{report.note}</p>}
      {!open && report.resolutionNote && (
        <p className="mt-2 text-sm text-muted-foreground">القرار: {report.resolutionNote}</p>
      )}
      {open && (
        <div className="mt-3 grid gap-3">
          <Field label="سبب القرار (يُسجَّل في سجل الإشراف)">
            <Textarea
              rows={2}
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
              data-testid={`input-report-decision-${report.id}`}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="الإجراء" className="min-w-48">
              <Select
                value={action}
                onChange={(event) => setAction(event.target.value)}
                data-testid={`select-report-action-${report.id}`}
              >
                <option value="">اختر إجراء</option>
                {ACTIONS_BY_TARGET[report.targetType].map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </Field>
            {report.targetType === "ORDER" && report.target && (
              <Field label="الطرف" className="min-w-40">
                <Select value={subject} onChange={(event) => setSubject(event.target.value)}>
                  <option value="">اختر الطرف</option>
                  <option value={report.target.buyerId}>المشتري</option>
                  <option value={report.target.sellerId}>البائع</option>
                </Select>
              </Field>
            )}
            <Button
              variant="danger"
              disabled={!action || reason.trim().length < 3}
              loading={resolve.isPending && resolve.variables === "ACTION"}
              onClick={() => resolve.mutate("ACTION")}
              data-testid={`button-report-action-${report.id}`}
            >
              تنفيذ الإجراء
            </Button>
            <Button
              variant="secondary"
              disabled={reason.trim().length < 3}
              loading={resolve.isPending && resolve.variables === "DISMISS"}
              onClick={() => resolve.mutate("DISMISS")}
              data-testid={`button-report-dismiss-${report.id}`}
            >
              رفض البلاغ
            </Button>
          </div>
          {resolve.error && <InlineAlert tone="danger">{friendlyError(resolve.error)}</InlineAlert>}
        </div>
      )}
    </Card>
  );
}

function ReportsTab() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("OPEN");
  const reports = useQuery<ReportRow[]>({
    queryKey: ["admin-reports", status],
    queryFn: async () => (await api(`/admin/reports?status=${status}`)) as ReportRow[],
    staleTime: 0,
  });
  return (
    <div className="space-y-3">
      <Segmented
        label="حالة البلاغات"
        value={status}
        onChange={setStatus}
        options={[
          { value: "OPEN", label: "مفتوحة" },
          { value: "ACTIONED", label: "نُفذ إجراء" },
          { value: "DISMISSED", label: "مرفوضة" },
        ]}
      />
      {reports.isLoading ? (
        <Skeleton className="h-40" />
      ) : reports.error ? (
        <ErrorState onRetry={() => reports.refetch()} />
      ) : !reports.data?.length ? (
        <EmptyState icon={Flag} title="لا توجد بلاغات" body="ستظهر هنا البلاغات حسب الحالة المختارة." />
      ) : (
        reports.data.map((report) => (
          <ReportCard
            key={report.id}
            report={report}
            onDone={() => void queryClient.invalidateQueries({ queryKey: ["admin-reports"] })}
          />
        ))
      )}
    </div>
  );
}

function ListingsTab() {
  const [listingId, setListingId] = useState("");
  const [reason, setReason] = useState("");
  const moderate = useMutation({
    mutationFn: (action: "HIDE" | "RESTORE" | "REMOVE") =>
      api(`/admin/listings/${encodeURIComponent(listingId.trim())}/moderation`, "POST", { action, reason }) as Promise<{
        status: string;
      }>,
  });
  const ready = listingId.trim().length > 0 && reason.trim().length >= 3;
  return (
    <Card>
      <CardTitle>إشراف العروض</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">
        الإخفاء يزيل العرض من الاكتشاف والشراء دون حذف الطلبات السابقة. لا يستطيع البائع استعادة عرض مخفي إداريًا. الحذف الإداري نهائي.
      </p>
      <div className="grid gap-3">
        <Field label="معرّف العرض">
          <Input value={listingId} onChange={(event) => setListingId(event.target.value)} dir="ltr" />
        </Field>
        <Field label="السبب">
          <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" disabled={!ready} onClick={() => moderate.mutate("HIDE")}>
            إخفاء
          </Button>
          <Button variant="secondary" disabled={!ready} onClick={() => moderate.mutate("RESTORE")}>
            استعادة
          </Button>
          <Button variant="danger-soft" disabled={!ready} onClick={() => moderate.mutate("REMOVE")}>
            حذف إداري
          </Button>
        </div>
        {moderate.data && <InlineAlert tone="success">الحالة الآن: {moderate.data.status}</InlineAlert>}
        {moderate.error && <InlineAlert tone="danger">{friendlyError(moderate.error)}</InlineAlert>}
      </div>
    </Card>
  );
}

function UsersTab() {
  const [search, setSearch] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();
  const users = useQuery<UserRow[]>({
    queryKey: ["admin-users", search],
    queryFn: async () => (await api(`/admin/users?search=${encodeURIComponent(search)}`)) as UserRow[],
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/admin/users/${id}/status`, "POST", { status, reason: reasons[id] ?? "" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  return (
    <div className="space-y-3">
      <Field label="ابحث بالاسم أو المعرّف">
        <Input value={search} onChange={(event) => setSearch(event.target.value)} />
      </Field>
      {setStatus.error && <InlineAlert tone="danger">{friendlyError(setStatus.error)}</InlineAlert>}
      {(users.data ?? []).map((row) => (
        <Card key={row.id}>
          <div className="flex flex-wrap items-center gap-2">
            <b>{row.displayName}</b>
            <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge>
            {row.role === "ADMIN" && <Badge tone="info">ADMIN</Badge>}
            <span className="text-xs text-muted-foreground" dir="ltr">
              {row.id}
            </span>
          </div>
          {row.role !== "ADMIN" && row.status !== "DEACTIVATED" && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="السبب" className="min-w-60 flex-1">
                <Input
                  value={reasons[row.id] ?? ""}
                  onChange={(event) => setReasons({ ...reasons, [row.id]: event.target.value })}
                />
              </Field>
              {(["ACTIVE", "RESTRICTED", "SUSPENDED"] as const)
                .filter((status) => status !== row.status)
                .map((status) => (
                  <Button
                    key={status}
                    size="sm"
                    variant={status === "ACTIVE" ? "secondary" : "danger-soft"}
                    disabled={(reasons[row.id] ?? "").trim().length < 3}
                    onClick={() => setStatus.mutate({ id: row.id, status })}
                  >
                    {status === "ACTIVE" ? "تفعيل" : status === "RESTRICTED" ? "تقييد" : "إيقاف"}
                  </Button>
                ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function RulesTab() {
  const queryClient = useQueryClient();
  const { markets } = useAccount();
  const [draft, setDraft] = useState({ marketId: "", kind: "TERM", value: "", note: "" });
  const [toggleReason, setToggleReason] = useState("");
  const rules = useQuery<RuleRow[]>({
    queryKey: ["admin-policy-rules"],
    queryFn: async () => (await api("/admin/policy-rules")) as RuleRow[],
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin-policy-rules"] });
  const create = useMutation({
    mutationFn: () =>
      api("/admin/policy-rules", "POST", {
        marketId: draft.marketId || null,
        kind: draft.kind,
        value: draft.value,
        reasonCode: "PROHIBITED_ITEM",
        note: draft.note,
      }),
    onSuccess: () => {
      setDraft({ ...draft, value: "", note: "" });
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (rule: RuleRow) =>
      api(`/admin/policy-rules/${rule.id}`, "PATCH", { isActive: !rule.isActive, reason: toggleReason }),
    onSuccess: refresh,
  });
  return (
    <div className="space-y-3">
      <InlineAlert tone="info">
        القواعد هنا قيود محددة (تصنيف، نوع عرض، طريقة تنفيذ، كلمة). المطابقة النصية لا تضمن الامتثال القانوني؛ المحتوى غير المؤكد يُعالج عبر البلاغات.
      </InlineAlert>
      <Card>
        <CardTitle>قاعدة جديدة</CardTitle>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="السوق">
            <Select value={draft.marketId} onChange={(event) => setDraft({ ...draft, marketId: event.target.value })}>
              <option value="">كل الأسواق</option>
              {markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.countryNameAr}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="النوع">
            <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
              <option value="TERM">كلمة في العرض</option>
              <option value="CATEGORY">تصنيف (معرّف أو اسم)</option>
              <option value="RESOURCE_TYPE">نوع العرض (PRODUCT/SERVICE)</option>
              <option value="FULFILMENT">طريقة التنفيذ</option>
            </Select>
          </Field>
          <Field label="القيمة">
            <Input value={draft.value} maxLength={120} onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
          </Field>
          <Field label="ملاحظة" optional>
            <Input value={draft.note} maxLength={500} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
          </Field>
        </div>
        <Button className="mt-3" disabled={!draft.value.trim()} loading={create.isPending} onClick={() => create.mutate()}>
          إضافة القاعدة
        </Button>
        {create.error && <InlineAlert tone="danger">{friendlyError(create.error)}</InlineAlert>}
      </Card>
      <Field label="سبب تفعيل/تعطيل القواعد">
        <Input value={toggleReason} onChange={(event) => setToggleReason(event.target.value)} />
      </Field>
      {toggle.error && <InlineAlert tone="danger">{friendlyError(toggle.error)}</InlineAlert>}
      {(rules.data ?? []).map((rule) => (
        <Card key={rule.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={rule.isActive ? "danger" : "neutral"}>{rule.isActive ? "مفعلة" : "معطلة"}</Badge>
            <Badge>{rule.kind}</Badge>
            <b>{rule.value}</b>
            <span className="text-sm text-muted-foreground">{rule.marketId ?? "كل الأسواق"}</span>
            <Button
              size="sm"
              variant="secondary"
              className="ms-auto"
              disabled={toggleReason.trim().length < 3}
              onClick={() => toggle.mutate(rule)}
            >
              {rule.isActive ? "تعطيل" : "تفعيل"}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function PoliciesTab() {
  const policies = useQuery<PolicyAdmin>({
    queryKey: ["admin-policies"],
    queryFn: async () => (await api("/admin/policies")) as PolicyAdmin,
  });
  if (!policies.data) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-3">
      <Card>
        <CardTitle>إصدارات السياسات</CardTitle>
        <ul className="space-y-2 text-sm">
          {policies.data.policies.map((policy) => (
            <li key={policy.key} className="flex flex-wrap items-center gap-2">
              <a href={`/policies/${policy.key}`} className="font-semibold text-primary">
                {policy.titleAr}
              </a>
              <span className="text-muted-foreground">
                {policy.version} · ساري من {policy.effectiveDate}
              </span>
              <Badge tone={policy.legalReviewStatus === "APPROVED" ? "success" : "warning"}>
                {policy.legalReviewStatus === "APPROVED" ? "معتمدة قانونيًا" : "بانتظار المراجعة القانونية"}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardTitle>الاحتفاظ بالبيانات عند حذف الحساب</CardTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-muted-foreground">
                <th className="p-2 text-start">السجل</th>
                <th className="p-2 text-start">المعالجة</th>
                <th className="p-2 text-start">المدة</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.retention.map((row) => (
                <tr key={row.record} className="border-t border-border">
                  <td className="p-2" dir="ltr">{row.record}</td>
                  <td className="p-2">{row.handling}</td>
                  <td className="p-2">{row.period}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AuditTab() {
  const audit = useQuery<AuditRow[]>({
    queryKey: ["admin-moderation-audit"],
    queryFn: async () => (await api("/admin/moderation-audit")) as AuditRow[],
    staleTime: 0,
  });
  return (
    <Card>
      <CardTitle>سجل الإشراف</CardTitle>
      <ul className="divide-y divide-border text-sm">
        {(audit.data ?? []).map((row) => (
          <li key={row.id} className="py-2">
            <b>{row.action}</b> · {row.targetType} <span dir="ltr">{row.targetId.slice(0, 8)}</span> ·{" "}
            {row.actorName} · {when(row.createdAt)}
            {row.reason && <p className="text-muted-foreground">{row.reason}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function AdminTrustSafetyPage() {
  const { user } = useAccount();
  const [tab, setTab] = useState<Tab>("reports");
  if (user?.role !== "ADMIN")
    return (
      <div className="container-app max-w-2xl">
        <EmptyState icon={ShieldAlert} title="هذه الصفحة متاحة لإدارة السوق فقط" />
      </div>
    );
  return (
    <div className="container-app max-w-4xl pb-10" data-testid="page-admin-trust-safety">
      <PageHeader title="البلاغات والإشراف" subtitle="مراجعة البلاغات، الإشراف على العروض والحسابات، وقواعد السوق" />
      <div className="mb-4 overflow-x-auto">
        <Segmented
          label="أقسام الإشراف"
          value={tab as string}
          onChange={(value) => setTab(value as Tab)}
          options={[
            { value: "reports", label: "البلاغات" },
            { value: "listings", label: "العروض" },
            { value: "users", label: "الحسابات" },
            { value: "rules", label: "المحظورات" },
            { value: "policies", label: "السياسات" },
            { value: "audit", label: "السجل" },
          ]}
        />
      </div>
      {tab === "reports" && <ReportsTab />}
      {tab === "listings" && <ListingsTab />}
      {tab === "users" && <UsersTab />}
      {tab === "rules" && <RulesTab />}
      {tab === "policies" && <PoliciesTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}
