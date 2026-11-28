import React, { useState } from "react";

export interface CommerceProvenanceView {
  source: "STORE_SYSTEM" | "MERCHANT_POLICY" | "UNCONFIRMED" | "NEEDS_MERCHANT_APPROVAL";
  policyVersion?: number;
  labelAr: string;
}

export interface PaymentOptionItemView {
  kind: "DIRECT" | "COD" | "STORE_GATEWAY";
  code: string;
  label: string;
  available: boolean;
  reason?: string;
  standingLabel?: string;
  adapterId?: string;
  provenance: CommerceProvenanceView;
}

export interface PaymentOptionsCardView {
  kind: "PAYMENT_OPTIONS";
  orderId: string;
  orderReference: string;
  currency: string;
  subtotalMinor: number;
  shippingFeeMinor: number | null;
  totalMinor: number;
  options: PaymentOptionItemView[];
  provenance: CommerceProvenanceView;
  shippingProvenance?: CommerceProvenanceView | null;
}

export interface PaymentStatusCardView {
  kind: "PAYMENT_STATUS";
  orderId: string;
  sessionId?: string;
  status: "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "CANCELLED" | "MISMATCH_REVIEW";
  amountMinor: number;
  currencyCode: string;
  checkoutUrl?: string;
  adapterName?: string;
  paidAt?: string;
  note: string;
}

const STATUS_LABELS_AR: Record<PaymentStatusCardView["status"], { label: string; badgeClass: string }> = {
  PENDING: { label: "بانتظار الدفع عبر بوابة المتجر", badgeClass: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  PAID: { label: "مدفوع ومؤكّد", badgeClass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  FAILED: { label: "فشل الدفع", badgeClass: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
  EXPIRED: { label: "منتهي الصلاحية", badgeClass: "bg-slate-500/15 text-slate-300 border-slate-500/30" },
  CANCELLED: { label: "ملغى", badgeClass: "bg-slate-500/15 text-slate-300 border-slate-500/30" },
  MISMATCH_REVIEW: { label: "قيد المراجعة لعدم تطابق البيانات", badgeClass: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
};

function formatMinor(minor: number, currency: string) {
  const scale = currency === "JOD" || currency === "KWD" || currency === "BHD" || currency === "OMR" ? 3 : 2;
  return `${(minor / 10 ** scale).toFixed(scale)} ${currency}`;
}

export function PaymentOptionsPanel({
  card,
  onSelectDirectMethod,
  onGatewaySessionCreated,
}: {
  card: PaymentOptionsCardView;
  onSelectDirectMethod?: (code: string) => void;
  onGatewaySessionCreated?: (statusCard: PaymentStatusCardView) => void;
}) {
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeStatusCard, setActiveStatusCard] = useState<PaymentStatusCardView | null>(null);

  async function handleChoose(option: PaymentOptionItemView) {
    if (!option.available || busyCode) return;
    setError(null);
    setBusyCode(option.code);
    try {
      if (option.kind === "STORE_GATEWAY" && option.adapterId) {
        const res = await fetch("/api/store-checkout/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            orderId: card.orderId,
            adapterId: option.adapterId,
            idempotencyKey: `payopt-${card.orderId}-${option.adapterId}`,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.error || "تعذّر فتح بوابة دفع المتجر.");
        } else if (data?.card) {
          setActiveStatusCard(data.card);
          onGatewaySessionCreated?.(data.card);
        }
      } else {
        const res = await fetch(`/api/orders/${encodeURIComponent(card.orderId)}/deal-payment`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ type: "SELECT_METHOD", method: option.code }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.error || "تعذّر اختيار وسيلة الدفع.");
        } else {
          onSelectDirectMethod?.(option.code);
        }
      }
    } catch {
      setError("حدث خطأ في الاتصال بالخادم.");
    } finally {
      setBusyCode(null);
    }
  }

  return (
    <section
      dir="rtl"
      data-testid="payment-options-card"
      aria-label="خيارات الدفع المتاحة للطلب"
      className="w-full max-w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 p-4 text-right text-slate-100 shadow-lg"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
        <div>
          <span className="text-xs text-slate-400">طلب #{card.orderReference}</span>
          <h3 className="text-base font-semibold text-white">طرق الدفع المتاحة لهذا الطلب</h3>
        </div>
        <span data-testid="payment-options-provenance" className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-xs text-slate-300">
          {card.provenance.labelAr}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 rounded-xl bg-white/5 p-3 text-xs sm:grid-cols-3">
        <div>
          <span className="text-slate-400">قيمة المنتجات: </span>
          <strong className="text-white">{formatMinor(card.subtotalMinor, card.currency)}</strong>
        </div>
        {card.shippingFeeMinor !== null && (
          <div>
            <span className="text-slate-400">الشحن: </span>
            <strong className="text-white">
              {card.shippingFeeMinor === 0 ? "مجاني" : formatMinor(card.shippingFeeMinor, card.currency)}
            </strong>
            {card.shippingProvenance && (
              <span className="mr-1 text-[11px] text-slate-400">({card.shippingProvenance.labelAr})</span>
            )}
          </div>
        )}
        <div>
          <span className="text-slate-400">الإجمالي: </span>
          <strong className="text-emerald-300">{formatMinor(card.totalMinor, card.currency)}</strong>
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/15 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      <div className="mt-3 space-y-2">
        {card.options.map((opt) => (
          <div
            key={`${opt.kind}:${opt.code}`}
            data-testid={`payment-option-${opt.code}`}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 ${
              opt.available ? "border-white/15 bg-white/5" : "border-white/5 bg-white/[0.02] opacity-70"
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-white">{opt.label}</span>
                <span className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] text-slate-300">
                  {opt.provenance.labelAr}
                </span>
              </div>
              {opt.reason && <p className="mt-1 text-xs text-amber-300">{opt.reason}</p>}
            </div>

            <button
              type="button"
              disabled={!opt.available || busyCode !== null}
              data-testid={`choose-payment-${opt.code}`}
              onClick={() => handleChoose(opt)}
              className="min-h-[38px] shrink-0 rounded-xl bg-sky-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {busyCode === opt.code
                ? "جاري الفتح..."
                : opt.kind === "STORE_GATEWAY"
                  ? "الدفع عبر بوابة المتجر"
                  : "اختيار الوسيلة"}
            </button>
          </div>
        ))}
      </div>

      {activeStatusCard && (
        <div className="mt-4">
          <PaymentStatusPanel card={activeStatusCard} />
        </div>
      )}
    </section>
  );
}

export function PaymentStatusPanel({ card }: { card: PaymentStatusCardView }) {
  const meta = STATUS_LABELS_AR[card.status] ?? STATUS_LABELS_AR.PENDING;
  return (
    <section
      dir="rtl"
      data-testid="payment-status-card"
      aria-label="حالة الدفع عبر بوابة المتجر"
      className="w-full max-w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 p-4 text-right text-slate-100 shadow-lg"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
        <div>
          <span className="text-xs text-slate-400">{card.adapterName || "بوابة المتجر الإلكترونية"}</span>
          <h3 className="text-base font-semibold text-white">
            {formatMinor(card.amountMinor, card.currencyCode)}
          </h3>
        </div>
        <span
          data-testid="payment-status-badge"
          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${meta.badgeClass}`}
        >
          {meta.label}
        </span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-300">{card.note}</p>

      {card.status === "PENDING" && card.checkoutUrl && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <a
            href={card.checkoutUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="payment-gateway-external-link"
            className="inline-flex min-h-[40px] items-center justify-center rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            فتح صفحة الدفع الخارجية للمتجر ↗
          </a>
        </div>
      )}
    </section>
  );
}
