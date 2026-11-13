/**
 * Trusted action receipts in the chat (R3D). Each receipt is the server's reading of DINAR's
 * action ledger for an action this turn opened or moved, re-read on every load: the status here
 * is never taken from the assistant's text, and the text above cannot change it.
 */
import { AlertTriangle, CheckCircle2, Clock, HelpCircle } from "lucide-react";
import { orderRef } from "@/lib/format";
import type { AiActionReceipt } from "./ai-api";

const STATUS: Record<AiActionReceipt["lifecycle"], { label: string; tone: string; Icon: typeof Clock }> = {
  PROPOSED: { label: "مقترح", tone: "text-muted-foreground", Icon: HelpCircle },
  REQUIRES_CONFIRMATION: { label: "بانتظار تأكيدك", tone: "text-amber-700 dark:text-amber-300", Icon: Clock },
  EXECUTING: { label: "قيد التحقق", tone: "text-amber-700 dark:text-amber-300", Icon: Clock },
  SUCCEEDED: { label: "منفَّذ", tone: "text-emerald-700 dark:text-emerald-300", Icon: CheckCircle2 },
  FAILED: { label: "لم يُنفَّذ", tone: "text-rose-700 dark:text-rose-300", Icon: AlertTriangle },
  UNKNOWN: { label: "غير مؤكد", tone: "text-muted-foreground", Icon: HelpCircle },
};
const AMOUNT_LABEL: Record<NonNullable<AiActionReceipt["amount"]>["kind"], string> = {
  PROPOSED: "المبلغ المقترح",
  SUBMITTED: "المبلغ المرسَل",
  AGREED: "السعر المتفق عليه",
  PAYMENT: "مبلغ الدفع",
};
const PAYMENT_STATE: Record<NonNullable<AiActionReceipt["paymentState"]>, string> = {
  AWAITING_CONFIRMATION: "الدفع بانتظار التأكيد؛ لم يُستلم أي مبلغ بعد.",
  SIMULATED_CAPTURED: "دفع في وضع المحاكاة؛ لم تُحصَّل أموال حقيقية.",
  CAPTURED: "تم استلام الدفع.",
};

export function ActionReceiptList({ receipts }: { receipts: AiActionReceipt[] }) {
  if (!receipts.length) return null;
  return (
    <section className="ai-surface mt-3 max-w-xl space-y-2" aria-label="حالة الإجراءات في سجل جاسم" data-testid="action-receipts">
      {receipts.map((receipt, index) => {
        const status = STATUS[receipt.lifecycle];
        return (
          <div
            key={`${receipt.action}-${index}`}
            role="status"
            aria-label={`${status.label}: ${receipt.title}`}
            data-testid="action-receipt"
            data-lifecycle={receipt.lifecycle}
            className="rounded-xl border border-border bg-card p-3 text-sm"
          >
            <p className={`flex items-center gap-1.5 text-xs font-semibold ${status.tone}`}>
              <status.Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {status.label}
              <span className="font-normal text-muted-foreground">· سجل جاسم</span>
            </p>
            <p className="mt-1 break-words font-semibold">{receipt.title}</p>
            {receipt.resource && <p className="mt-0.5 break-words text-muted-foreground">{receipt.resource}</p>}
            {receipt.amount && (
              <p className="mt-1">
                {AMOUNT_LABEL[receipt.amount.kind]}:{" "}
                <span dir="ltr" className="num">{`${receipt.amount.value} ${receipt.amount.currency}`}</span>
              </p>
            )}
            {receipt.orderId && (
              <p className="mt-1">
                رقم الطلب <span dir="ltr" className="num">{orderRef(receipt.orderId)}</span>
              </p>
            )}
            {receipt.paymentState && <p className="mt-1">{PAYMENT_STATE[receipt.paymentState]}</p>}
            {receipt.failure && <p className="mt-1 break-words text-rose-700 dark:text-rose-300">{receipt.failure}</p>}
            {receipt.nextStep && <p className="mt-1 break-words text-muted-foreground">{receipt.nextStep}</p>}
          </div>
        );
      })}
    </section>
  );
}
