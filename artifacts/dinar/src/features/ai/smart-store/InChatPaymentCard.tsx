/**
 * Visual-only in-chat payment card prepared for the Connect payment slot.
 * Renders all six server-driven states without hardcoding prices, currencies, or payment wiring:
 * AVAILABLE, UNAVAILABLE_IN_COUNTRY, PENDING, PAID, FAILED, REFUNDED.
 */
import { AlertCircle, CheckCircle2, Clock3, CreditCard, Globe2, Lock, RotateCcw, ShieldCheck } from "lucide-react";

export type InChatPaymentState =
  | "AVAILABLE"
  | "UNAVAILABLE_IN_COUNTRY"
  | "PENDING"
  | "PAID"
  | "FAILED"
  | "REFUNDED";

export interface InChatPaymentCardProps {
  state: InChatPaymentState;
  merchantName: string;
  /** Server-formatted total amount (including currency). Never computed in the browser. */
  amountLabel?: string;
  /** Server-supplied order or payment reference code. */
  referenceId?: string;
  /** Server-formatted confirmation or refund timestamp. */
  timestampLabel?: string;
  /** Server-supplied payment method labels (e.g. ["بطاقة بنكية", "Apple Pay"]). */
  methods?: string[];
  /** Server-supplied explanation when UNAVAILABLE_IN_COUNTRY or FAILED. */
  reason?: string;
  /** Disabled while a live payment handoff is in flight. */
  busy?: boolean;
  onPay?: () => void;
  onRetry?: () => void;
}

const STATE_META: Record<
  InChatPaymentState,
  { badge: string; badgeClass: string; borderClass: string }
> = {
  AVAILABLE: {
    badge: "جاهز للدفع الآمن",
    badgeClass: "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
    borderClass: "border-amber-500/30 dark:border-amber-400/25",
  },
  UNAVAILABLE_IN_COUNTRY: {
    badge: "غير متاح في دولتك حاليًا",
    badgeClass: "border-border bg-muted/70 text-muted-foreground",
    borderClass: "border-border/80",
  },
  PENDING: {
    badge: "بانتظار تأكيد المزود",
    badgeClass: "border-sky-500/35 bg-sky-500/12 text-sky-700 dark:text-sky-300",
    borderClass: "border-sky-500/30",
  },
  PAID: {
    badge: "تم الدفع وتأكيده",
    badgeClass: "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    borderClass: "border-emerald-500/35",
  },
  FAILED: {
    badge: "تعذر إتمام الدفع",
    badgeClass: "border-destructive/35 bg-destructive/10 text-destructive",
    borderClass: "border-destructive/35",
  },
  REFUNDED: {
    badge: "تم استرداد المبلغ",
    badgeClass: "border-indigo-500/35 bg-indigo-500/12 text-indigo-700 dark:text-indigo-300",
    borderClass: "border-indigo-500/30",
  },
};

export function InChatPaymentCard({
  state,
  merchantName,
  amountLabel,
  referenceId,
  timestampLabel,
  methods = [],
  reason,
  busy = false,
  onPay,
  onRetry,
}: InChatPaymentCardProps) {
  const meta = STATE_META[state];

  return (
    <section
      dir="rtl"
      aria-label="بطاقة الدفع داخل المحادثة"
      data-testid="in-chat-payment-card"
      data-payment-state={state}
      className={`animate-fade w-full max-w-[440px] rounded-2xl border bg-card/95 p-4 shadow-sm backdrop-blur-sm transition-all duration-200 ${meta.borderClass}`}
    >
      <header className="flex items-start justify-between gap-2 border-b border-border/60 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-amber-500/25 bg-gradient-to-br from-blue-600/15 to-amber-500/15 text-amber-600 dark:text-amber-400">
            {state === "PAID" ? (
              <CheckCircle2 size={18} className="text-emerald-500" aria-hidden />
            ) : state === "PENDING" ? (
              <Clock3 size={18} className="animate-pulse text-sky-500" aria-hidden />
            ) : state === "FAILED" ? (
              <AlertCircle size={18} className="text-destructive" aria-hidden />
            ) : state === "REFUNDED" ? (
              <RotateCcw size={18} className="text-indigo-500" aria-hidden />
            ) : state === "UNAVAILABLE_IN_COUNTRY" ? (
              <Globe2 size={18} className="text-muted-foreground" aria-hidden />
            ) : (
              <CreditCard size={18} aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-foreground">الدفع عبر جاسم كونيكت</h3>
            <p className="truncate text-xs text-muted-foreground">{merchantName}</p>
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${meta.badgeClass}`}>
          {meta.badge}
        </span>
      </header>

      {amountLabel && (
        <div className="mt-3 flex items-baseline justify-between gap-2 rounded-xl border border-border/60 bg-muted/35 px-3.5 py-2.5">
          <span className="text-xs font-medium text-muted-foreground">الإجمالي المعتمد</span>
          <bdi dir="ltr" className="text-base font-bold tabular-nums text-foreground" data-testid="in-chat-payment-amount">
            {amountLabel}
          </bdi>
        </div>
      )}

      {state === "AVAILABLE" && (
        <div className="mt-3 space-y-3">
          {methods.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="وسائل الدفع المدعومة">
              {methods.map((method) => (
                <span
                  key={method}
                  className="inline-flex items-center rounded-lg border border-border/70 bg-background/80 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
                >
                  {method}
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={busy || !onPay}
            onClick={onPay}
            data-testid="in-chat-payment-cta"
            className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-l from-amber-500 to-amber-400 px-4 text-sm font-bold text-slate-950 shadow-xs transition hover:brightness-105 hover:shadow-[0_6px_22px_rgba(245,158,11,0.28)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Lock size={15} aria-hidden />
            <span>{busy ? "جارٍ تجهيز بوابة الدفع…" : "إتمام الدفع الآمن"}</span>
          </button>
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck size={13} className="shrink-0 text-emerald-500" aria-hidden />
            <span>لا تُحفظ بيانات البطاقة داخل المحادثة.</span>
          </p>
        </div>
      )}

      {state === "UNAVAILABLE_IN_COUNTRY" && (
        <p className="mt-3 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          {reason ?? "الدفع الإلكتروني المباشر غير متاح في دولتك حاليًا. يمكنك تنسيق الدفع النقدي أو التحويل المحلي مع البائع عبر بطاقة التواصل والدفع."}
        </p>
      )}

      {state === "PENDING" && (
        <div className="mt-3 space-y-2 rounded-xl border border-sky-500/25 bg-sky-500/8 px-3 py-2.5 text-xs text-foreground">
          <p className="font-medium">لم يُؤكَّد الدفع بعد؛ ننتظر رد مزود الدفع.</p>
          {referenceId && (
            <p className="text-muted-foreground">
              المرجع: <bdi dir="ltr" className="font-mono tabular-nums">{referenceId}</bdi>
            </p>
          )}
        </div>
      )}

      {state === "PAID" && (
        <dl className="mt-3 grid gap-1.5 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3 py-2.5 text-xs">
          {referenceId && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">رقم العملية</dt>
              <dd className="font-mono font-semibold tabular-nums text-foreground"><bdi dir="ltr">{referenceId}</bdi></dd>
            </div>
          )}
          {timestampLabel && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">وقت التأكيد</dt>
              <dd className="tabular-nums text-foreground"><bdi>{timestampLabel}</bdi></dd>
            </div>
          )}
        </dl>
      )}

      {state === "FAILED" && (
        <div className="mt-3 space-y-2.5">
          <p className="rounded-xl border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-xs leading-relaxed text-destructive" role="alert">
            {reason ?? "لم تكتمل العملية لدى مزود الدفع. لم يُخصم أي مبلغ مؤكد."}
          </p>
          {onRetry && (
            <button
              type="button"
              disabled={busy}
              onClick={onRetry}
              data-testid="in-chat-payment-retry"
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-60"
            >
              <RotateCcw size={14} aria-hidden />
              <span>إعادة المحاولة</span>
            </button>
          )}
        </div>
      )}

      {state === "REFUNDED" && (
        <dl className="mt-3 grid gap-1.5 rounded-xl border border-indigo-500/25 bg-indigo-500/8 px-3 py-2.5 text-xs">
          {referenceId && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">مرجع الاسترداد</dt>
              <dd className="font-mono font-semibold tabular-nums text-foreground"><bdi dir="ltr">{referenceId}</bdi></dd>
            </div>
          )}
          {timestampLabel && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">تاريخ الاسترداد</dt>
              <dd className="tabular-nums text-foreground"><bdi>{timestampLabel}</bdi></dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}