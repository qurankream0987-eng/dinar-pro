import { useMutation, useQuery } from "@tanstack/react-query";
import { CreditCard, ExternalLink, ShieldCheck } from "lucide-react";
import { api, useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { InlineAlert } from "@/ui/Feedback";
import { Card, CardTitle } from "@/ui/Layout";

export type WhopPaymentView = {
  orderId: string;
  checkoutId: string | null;
  purchaseUrl: string | null;
  status: "NONE" | "CREATED" | "SUCCEEDED" | "FAILED" | "CANCELED" | "REFUND_DUE";
  amountUsd: number | null;
  feeUsd: number | null;
  feePercent: number | null;
  currency: "USD";
  paidAt: string | null;
  environment: "sandbox" | "production";
};

type PaymentResponse = {
  enabled: boolean;
  environment?: "sandbox" | "production";
  payment: WhopPaymentView | null;
};

function usd(amount: number | null) {
  return amount === null ? "" : `${amount.toFixed(2)} USD`;
}

/**
 * Card payments are optional: until the server reports a configured Whop environment the
 * panel renders nothing, so an unconfigured marketplace never shows a dead pay button.
 */
export function WhopPaymentPanel({
  orderId,
  orderStatus,
  role,
}: {
  orderId: string;
  orderStatus: string;
  role: "buyer" | "seller" | "stranger";
}) {
  const { user, market } = useAccount();
  const query = useQuery<PaymentResponse>({
    queryKey: ["whop-payment", orderId],
    queryFn: async () => (await api(`/whop/orders/${encodeURIComponent(orderId)}/payment`)) as PaymentResponse,
    enabled: Boolean(user?.id && orderId),
    staleTime: 5_000,
  });
  const start = useMutation<WhopPaymentView>({
    mutationFn: async () =>
      (await api("/whop/checkout", "POST", { orderId })) as WhopPaymentView,
    onSuccess: (view) => {
      if (view.purchaseUrl) window.location.assign(view.purchaseUrl);
    },
  });

  if (market?.operationMode === "PRE_LEGAL") {
    return (
      <Card testId="whop-payment-panel" className="rounded-2xl border-border/80 bg-card/95 shadow-xs">
        <CardTitle>الدفع الإلكتروني غير متاح في دولتك حاليًا</CardTitle>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          هذا السوق في وضع التشغيل التقني — الدفع نقدًا فقط. يمكنك تنسيق الدفع المباشر مع البائع من بطاقة التواصل والدفع.
        </p>
      </Card>
    );
  }
  if (query.isLoading || query.isError || !query.data?.enabled) return null;
  const payment = query.data.payment;
  if (!payment) return null;
  if (payment.status === "NONE" && !(role === "buyer" && orderStatus === "CREATED"))
    return null;

  return (
    <Card testId="whop-payment-panel">
      <CardTitle>الدفع بالبطاقة عبر Whop</CardTitle>
      {payment.status === "NONE" && (
        <>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            يُخصم المبلغ بالدولار بسعر تحويل ثابت، ويستلم البائع مستحقاته بعد خصم عمولة
            المنصة. تُفعّل الطلبية بعد تأكيد Whop للدفع.
          </p>
          <Button
            className="mt-3"
            block
            loading={start.isPending}
            icon={<CreditCard size={18} />}
            onClick={() => start.mutate()}
            data-testid="button-whop-pay"
          >
            المتابعة إلى الدفع
          </Button>
        </>
      )}
      {payment.status === "CREATED" && payment.purchaseUrl && (
        <>
          <InlineAlert tone="warning" title="لم يُستلم الدفع بعد">
            أُعدّت صفحة الدفع ولم يكتمل تأكيد Whop. أكمل الدفع أو أعد المحاولة.
          </InlineAlert>
          <Button
            className="mt-3"
            block
            variant="secondary"
            icon={<ExternalLink size={18} />}
            onClick={() => window.location.assign(payment.purchaseUrl!)}
            data-testid="button-whop-resume"
          >
            إكمال الدفع في Whop
          </Button>
        </>
      )}
      {payment.status === "SUCCEEDED" && (
        <InlineAlert tone="success" title="تم استلام الدفعة">
          استلمت Whop <bdi dir="ltr" className="font-semibold tabular-nums">{usd(payment.amountUsd)}</bdi>. لا حاجة لأي إجراء إضافي.
        </InlineAlert>
      )}
      {payment.status === "REFUND_DUE" && (
        <InlineAlert tone="warning" title="دفعة بحاجة إلى استرداد">
          وصلت دفعة على طلب ملغى أو منتهي الحجز، فسُجّل التزام استرداد كامل. لا
          تُعدّ بيعًا حتى يكتمل الاسترداد من الإدارة.
        </InlineAlert>
      )}
      {(payment.status === "FAILED" || payment.status === "CANCELED") && (
        <InlineAlert tone="danger" title="لم تكتمل الدفعة">
          لم تسجّل Whop دفعة ناجحة لهذا الطلب. يمكنك إعادة المحاولة من صفحة الدفع.
        </InlineAlert>
      )}
      {start.isError && (
        <InlineAlert tone="danger" className="mt-3">
          {friendlyError(start.error)}
        </InlineAlert>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <ShieldCheck size={14} aria-hidden />
        {query.data.environment === "sandbox"
          ? "بيئة اختبار Whop — لا تُخصم أموال حقيقية."
          : "الدفع مؤمّن عبر Whop."}
      </p>
    </Card>
  );
}
