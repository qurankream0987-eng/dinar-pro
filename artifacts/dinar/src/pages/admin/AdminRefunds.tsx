import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReceiptText, RotateCcw } from "lucide-react";
import { api, useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { longDate, orderRef } from "@/lib/format";
import { Button } from "@/ui/Button";
import { Field, Input } from "@/ui/Field";
import { EmptyState, ErrorState, InlineAlert, Skeleton, StatusBadge } from "@/ui/Feedback";
import type { Tone } from "@/lib/marketplace";
import { Card, CardTitle, PageHeader } from "@/ui/Layout";

type RefundStatus = "REFUND_DUE" | "REQUESTED" | "SUCCEEDED" | "FAILED";

type WhopRefund = {
  id: string;
  orderId: string;
  paymentId: string;
  refundId: string | null;
  amountUsd: number;
  status: RefundStatus;
  reason: string;
  createdAt: string;
};

type WhopStatus = { enabled: boolean; configured: boolean; environment: string | null };

const STATUS: Record<RefundStatus, { label: string; tone: Tone }> = {
  REFUND_DUE: { label: "استرداد مستحق", tone: "warning" },
  REQUESTED: { label: "قيد التنفيذ", tone: "info" },
  SUCCEEDED: { label: "تم الاسترداد", tone: "success" },
  FAILED: { label: "فشل", tone: "danger" },
};

function newKey() {
  return `admin-refund-${crypto.randomUUID()}`;
}

export default function AdminRefundsPage() {
  const { user } = useAccount();
  const queryClient = useQueryClient();
  const [orderId, setOrderId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const status = useQuery<WhopStatus>({
    queryKey: ["whop-status"],
    queryFn: async () => (await api("/whop/status")) as WhopStatus,
    enabled: user?.role === "ADMIN",
    staleTime: 30_000,
  });
  const refunds = useQuery<{ refunds: WhopRefund[] }>({
    queryKey: ["whop-admin-refunds"],
    queryFn: async () => (await api("/whop/admin/refunds")) as { refunds: WhopRefund[] },
    enabled: user?.role === "ADMIN",
    staleTime: 0,
  });

  const refund = useMutation<{ refund: WhopRefund; duplicate: boolean }>({
    mutationFn: async () => {
      const parsed = amount.trim() ? Number(amount) : undefined;
      if (parsed !== undefined && (!Number.isFinite(parsed) || parsed <= 0))
        throw new Error("أدخل مبلغًا بالدولار أكبر من صفر أو اتركه فارغًا للاسترداد الكامل.");
      return (await api(
        "/whop/admin/refunds",
        "POST",
        {
          orderId: orderId.trim(),
          ...(parsed === undefined ? {} : { amountUsdMinor: Math.round(parsed * 100) }),
          reason: reason.trim(),
        },
        { "Idempotency-Key": idempotencyKey },
      )) as { refund: WhopRefund; duplicate: boolean };
    },
    onSuccess: async (result) => {
      setError(null);
      setNotice(
        result.duplicate
          ? "هذا الطلب سبق إرساله بنفس المفتاح، فأُعيدت النتيجة المحفوظة دون استرداد ثانٍ."
          : `سُجّل طلب استرداد ${result.refund.amountUsd.toFixed(2)} USD (${result.refund.status}).`,
      );
      setIdempotencyKey(newKey());
      await queryClient.invalidateQueries({ queryKey: ["whop-admin-refunds"] });
    },
    onError: (mutationError) => {
      setNotice(null);
      setError(friendlyError(mutationError));
    },
  });

  const list = refunds.data?.refunds ?? [];

  return (
    <div className="container-app max-w-4xl">
      <PageHeader
        back="/settings"
        title="استرداد مدفوعات Whop"
        subtitle="استرداد كامل أو جزئي لدفعة محصّلة عبر Whop"
      />
      {status.data && !status.data.configured ? (
        <EmptyState
          icon={ReceiptText}
          title="بوابة Whop غير مهيأة"
          body="لا يمكن الاسترداد قبل تهيئة مفاتيح Whop على الخادم."
          testId="state-whop-refunds-disabled"
        />
      ) : (
        <div className="space-y-4">
          <Card testId="card-whop-refund-form">
            <CardTitle icon={<RotateCcw size={18} aria-hidden />}>طلب استرداد</CardTitle>
            <form
              className="mt-2 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                refund.mutate();
              }}
            >
              <Field label="رقم الطلب" hint="معرّف الطلب كما يظهر في المحادثة">
                <Input
                  dir="ltr"
                  value={orderId}
                  onChange={(event) => setOrderId(event.target.value)}
                  required
                  data-testid="input-refund-order"
                />
              </Field>
              <Field
                label="المبلغ بالدولار"
                optional
                hint="اتركه فارغًا لاسترداد كل المتبقي من الدفعة"
              >
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="28.20"
                  data-testid="input-refund-amount"
                />
              </Field>
              <Field label="السبب" optional>
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={500}
                  data-testid="input-refund-reason"
                />
              </Field>
              {error && <InlineAlert tone="danger">{error}</InlineAlert>}
              {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
              <Button
                type="submit"
                loading={refund.isPending}
                disabled={!orderId.trim()}
                data-testid="button-whop-refund"
              >
                تنفيذ الاسترداد
              </Button>
              <p className="text-2xs text-muted-foreground">
                المبلغ يُقرأ من دفعة Whop نفسها ويُقيَّد بالمتبقي. نجاح الطلب يعني أن Whop
                قبل الطلب؛ التأكيد النهائي يصل عبر webhook موقّع.
              </p>
            </form>
          </Card>

          <Card>
            <CardTitle>الاستردادات</CardTitle>
            {refunds.isLoading ? (
              <div className="mt-2 space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
            ) : refunds.isError ? (
              <ErrorState onRetry={() => refunds.refetch()} />
            ) : list.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">لا توجد استردادات مسجلة بعد.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {list.map((row) => {
                  const state = STATUS[row.status] ?? STATUS.REQUESTED;
                  return (
                    <li key={row.id} className="py-3" data-testid={`row-refund-${row.id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="num text-sm font-semibold" dir="ltr">
                          {orderRef(row.orderId)}
                        </span>
                        <StatusBadge label={state.label} tone={state.tone} />
                        <span className="num ms-auto text-sm font-bold">
                          {row.amountUsd.toFixed(2)} USD
                        </span>
                      </div>
                      <p className="num mt-1 text-2xs text-muted-foreground" dir="ltr">
                        {row.paymentId}
                        {row.refundId ? ` · ${row.refundId}` : ""}
                      </p>
                      {row.reason && <p className="mt-1 text-sm">{row.reason}</p>}
                      <p className="mt-1 text-2xs text-muted-foreground">{longDate(row.createdAt)}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
