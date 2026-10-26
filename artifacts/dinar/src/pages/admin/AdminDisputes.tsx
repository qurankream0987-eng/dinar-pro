import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { AdminDispute } from "@workspace/api-zod";
import { api, useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { EmptyState, ErrorState, InlineAlert, Skeleton } from "@/ui/Feedback";
import { PageHeader } from "@/ui/Layout";
import { ConfirmDialog } from "@/ui/Sheet";

type Resolution = "BUYER" | "SELLER";

function formatMoney(minor: number, scale: number, currencyCode: string) {
  try {
    return new Intl.NumberFormat("ar", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    }).format(minor / 10 ** scale);
  } catch {
    return `${(minor / 10 ** scale).toFixed(scale)} ${currencyCode}`;
  }
}

function orderStatusLabel(status: string) {
  if (status === "DISPUTED") return "قيد النزاع";
  if (status === "COMPLETED") return "مكتمل";
  if (status === "CANCELLED") return "ملغى";
  return status;
}

function resolutionLabel(resolution: string | null) {
  if (resolution === "SELLER") return "لصالح البائع";
  if (resolution === "BUYER") return "لصالح المشتري";
  return "لم يُحسم";
}

export default function AdminDisputesPage() {
  const { user } = useAccount();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<Record<string, Resolution | "">>(
    {},
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmingOrderId, setConfirmingOrderId] = useState<string | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const disputesQuery = useQuery<AdminDispute[]>({
    queryKey: ["admin-disputes"],
    queryFn: async () => (await api("/admin/disputes")) as AdminDispute[],
    enabled: user?.role === "ADMIN",
    staleTime: 0,
  });

  const resolveDispute = useMutation({
    mutationFn: async ({
      orderId,
      resolution,
      note,
    }: {
      orderId: string;
      resolution: Resolution;
      note: string;
    }) =>
      api(`/admin/disputes/${encodeURIComponent(orderId)}/resolve`, "POST", {
        resolution,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async () => {
      setConfirmingOrderId(null);
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ["admin-disputes"] });
    },
    onError: (error) => setActionError(friendlyError(error)),
  });

  if (!user) return null;
  if (user.role !== "ADMIN") {
    return (
      <div className="container-app max-w-2xl py-6">
        <PageHeader back="/" title="إدارة النزاعات" />
        <InlineAlert tone="danger" title="الوصول مقيّد">
          هذه الصفحة متاحة لإدارة السوق فقط.
        </InlineAlert>
      </div>
    );
  }

  const disputes = disputesQuery.data ?? [];
  const confirming = disputes.find(
    (dispute) => dispute.orderId === confirmingOrderId,
  );
  const confirmingResolution = confirming
    ? selection[confirming.orderId]
    : "";

  return (
    <div className="container-app max-w-5xl space-y-5 py-6">
      <PageHeader
        back="/"
        title="إدارة النزاعات"
        subtitle="راجع الطلب وسياق النزاع، ثم اعتمد قرارًا واحدًا نهائيًا."
      />
      <InlineAlert tone="warning" title="لا يوجد تحصيل أو ردّ أموال هنا">
        الحسم يغيّر حالة الطلب والمخزون ومستحق المنصة المحفوظ فقط. لا ينفّذ
        تحويلًا ماليًا ولا يدّعي ردّ مبلغ.
      </InlineAlert>

      {actionError && (
        <InlineAlert tone="danger" title="تعذّر حسم النزاع">
          {actionError}
        </InlineAlert>
      )}

      {disputesQuery.isLoading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-44 w-full rounded-xl" />
          <Skeleton className="h-44 w-full rounded-xl" />
        </div>
      ) : disputesQuery.isError ? (
        <ErrorState
          title="تعذّر تحميل النزاعات"
          onRetry={() => void disputesQuery.refetch()}
        />
      ) : disputes.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="لا توجد نزاعات"
          body="ستظهر هنا الطلبات التي أبلغ مشتروها عن مشكلة بعد التسليم."
        />
      ) : (
        <div className="space-y-4">
          {disputes.map((dispute) => {
            const isOpen =
              dispute.status === "OPEN" && dispute.orderStatus === "DISPUTED";
            const choice = selection[dispute.orderId] ?? "";
            return (
              <article
                key={dispute.id}
                className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5"
                data-testid={`admin-dispute-${dispute.orderId}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold">
                      الطلب <span className="font-mono text-sm">{dispute.orderId}</span>
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {dispute.buyerName} ← {dispute.sellerName}
                    </p>
                  </div>
                  <span
                    className="rounded-full border border-border px-3 py-1 text-sm"
                    data-testid={`admin-dispute-status-${dispute.orderId}`}
                  >
                    {orderStatusLabel(dispute.orderStatus)}
                  </span>
                </div>

                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">حالة النزاع</dt>
                    <dd className="font-medium">
                      {dispute.status === "RESOLVED" ? "تم الحسم" : "مفتوح"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">كمية الطلب وقيمته</dt>
                    <dd className="font-medium">
                      {dispute.quantity} ·{" "}
                      {formatMoney(
                        dispute.subtotalMinor,
                        dispute.minorUnitScale,
                        dispute.currencyCode,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">سبب النزاع</dt>
                    <dd className="font-medium">{dispute.reason}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">تفاصيل المشتري</dt>
                    <dd className="whitespace-pre-wrap font-medium">
                      {dispute.description}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      الرسم المحفوظ · عمولة{" "}
                      {(dispute.commissionRateBps / 100).toLocaleString("ar")}٪
                    </dt>
                    <dd className="font-medium">
                      {formatMoney(
                        dispute.platformFeeMinor,
                        dispute.minorUnitScale,
                        dispute.currencyCode,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      استحقاق البائع المحفوظ
                    </dt>
                    <dd className="font-medium">
                      {formatMoney(
                        dispute.sellerAmountMinor,
                        dispute.minorUnitScale,
                        dispute.currencyCode,
                      )}
                    </dd>
                  </div>
                </dl>

                {dispute.evidence.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium">الأدلة المرفقة</h3>
                    <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                      {dispute.evidence.map((item, index) => (
                        <li key={`${item.createdAt}-${index}`}>
                          {item.reference || item.type}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {!isOpen && (
                  <div className="rounded-lg bg-muted/50 p-3 text-sm">
                    <p className="font-semibold">
                      النتيجة: {resolutionLabel(dispute.resolution)}
                    </p>
                    {dispute.resolutionNote && (
                      <p className="mt-1 whitespace-pre-wrap">
                        {dispute.resolutionNote}
                      </p>
                    )}
                    <p className="mt-1 text-muted-foreground">
                      {dispute.resolvedByName
                        ? `حسمه ${dispute.resolvedByName}`
                        : "حُسم"}
                      {dispute.resolvedAt
                        ? ` · ${new Date(dispute.resolvedAt).toLocaleString("ar")}`
                        : ""}
                    </p>
                  </div>
                )}

                {isOpen && (
                  <div className="space-y-3 border-t border-border pt-4">
                    <label
                      className="block space-y-1.5 text-sm font-medium"
                      htmlFor={`resolution-${dispute.orderId}`}
                    >
                      <span>قرار الإدارة</span>
                      <select
                        id={`resolution-${dispute.orderId}`}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2.5"
                        value={choice}
                        onChange={(event) =>
                          setSelection((previous) => ({
                            ...previous,
                            [dispute.orderId]: event.target.value as
                              | Resolution
                              | "",
                          }))
                        }
                        data-testid={`select-resolution-${dispute.orderId}`}
                      >
                        <option value="">اختر نتيجة الحسم</option>
                        <option value="BUYER">
                          لصالح المشتري — إلغاء الطلب دون مستحق بيع
                        </option>
                        <option value="SELLER">
                          لصالح البائع — إكمال الطلب بالرسم المحفوظ
                        </option>
                      </select>
                    </label>
                    <label
                      className="block space-y-1.5 text-sm font-medium"
                      htmlFor={`resolution-note-${dispute.orderId}`}
                    >
                      <span>ملاحظة الإدارة (اختيارية)</span>
                      <textarea
                        id={`resolution-note-${dispute.orderId}`}
                        maxLength={1000}
                        rows={3}
                        className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2.5"
                        value={notes[dispute.orderId] ?? ""}
                        onChange={(event) =>
                          setNotes((previous) => ({
                            ...previous,
                            [dispute.orderId]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <Button
                      disabled={!choice || resolveDispute.isPending}
                      onClick={() => setConfirmingOrderId(dispute.orderId)}
                      data-testid={`button-review-resolution-${dispute.orderId}`}
                    >
                      مراجعة القرار
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => !open && setConfirmingOrderId(null)}
        title="تأكيد حسم النزاع؟"
        body={
          confirmingResolution === "SELLER"
            ? "سيُكمل الطلب وسيُسجل الرسم المحفوظ مرة واحدة. لن يحدث تحصيل أو تحويل أموال."
            : "سيُلغى الطلب وتُعاد الكمية المحجوزة دون إنشاء مستحق بيع. لن يحدث ردّ مالي."
        }
        confirmLabel="تأكيد الحسم النهائي"
        cancelLabel="رجوع للمراجعة"
        loading={resolveDispute.isPending}
        onConfirm={() => {
          if (!confirming || !confirmingResolution) return;
          resolveDispute.mutate({
            orderId: confirming.orderId,
            resolution: confirmingResolution,
            note: notes[confirming.orderId] ?? "",
          });
        }}
      />
    </div>
  );
}