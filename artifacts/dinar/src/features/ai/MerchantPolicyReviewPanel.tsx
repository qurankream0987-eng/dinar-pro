import React, { useState } from "react";

export interface MerchantPolicyReviewData {
  policy: {
    id: string;
    businessId: string;
    kind: string;
    scopeKind: string;
    scopeRef?: string | null;
    rule: Record<string, unknown>;
    sensitivity: "NORMAL" | "SENSITIVE" | "HIGH_RISK";
    status: "PROPOSED" | "ACTIVE" | "REPLACED" | "REVOKED" | "CANCELLED";
    version: number;
    sourceText?: string | null;
  };
  summaryAr?: string;
  sensitivityLabelAr?: string;
  conflicts?: Array<{ policyId?: string; kind?: string; reasonAr?: string; message?: string }>;
  replacesPolicy?: { id: string; version: number; summaryAr?: string } | null;
}

const KIND_LABELS_AR: Record<string, string> = {
  PAYMENT_METHODS: "طرق الدفع المعتمدة",
  PAYMENT_GATEWAY: "بوابة الدفع الإلكترونية",
  PAYOUT_DETAILS: "بيانات استلام المستحقات",
  SHIPPING: "سياسة الشحن والتوصيل",
  COD_AREAS: "مناطق الدفع عند الاستلام",
  OUT_OF_STOCK: "سياسة نفاد المخزون",
  PRE_ORDER: "سياسة الطلب المسبق",
  ALTERNATIVES: "اقتراح البدائل",
  MIN_ORDER: "الحد الأدنى للطلب",
  ORDERING_PAUSED: "إيقاف/استئناف استقبال الطلبات",
  GEO_RESTRICTION: "النطاق الجغرافي للبيع",
  PRICE_NEGOTIATION: "سياسة التفاوض على الأسعار",
  DISCOUNT: "خصم المتجر",
  BULK_INQUIRY: "طلبات الكميات الكبيرة",
  B2B_QUESTIONS: "أسئلة عملاء الشركات",
};

const SCOPE_LABELS_AR: Record<string, string> = {
  STORE: "المتجر بالكامل",
  PRODUCT: "منتج محدد",
  CATEGORY: "فئة محددة",
  REGION: "منطقة محددة",
};

const SENSITIVITY_BADGES: Record<string, { label: string; className: string }> = {
  NORMAL: { label: "تأكيد عادي", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  SENSITIVE: { label: "حسّاس — يؤثر على الطلبات والدفع", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  HIGH_RISK: { label: "عالي الحساسية — يتطلب جلسة دخول حديثة", className: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
};

export function MerchantPolicyReviewPanel({
  review,
  onReply,
}: {
  review: MerchantPolicyReviewData;
  onReply?: (text: string) => void;
}) {
  const [policy, setPolicy] = useState(review.policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);

  const badge = SENSITIVITY_BADGES[policy.sensitivity] ?? SENSITIVITY_BADGES.NORMAL;
  const kindLabel = KIND_LABELS_AR[policy.kind] ?? policy.kind;
  const scopeLabel = SCOPE_LABELS_AR[policy.scopeKind] ?? policy.scopeKind;
  const conflicts = review.conflicts ?? [];

  async function handleConfirm() {
    if (busy || policy.status !== "PROPOSED") return;
    setBusy(true);
    setError(null);
    setNeedsReauth(false);
    try {
      const res = await fetch(`/api/merchant-policies/${encodeURIComponent(policy.id)}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ expectedVersion: policy.version }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.code === "FRESH_LOGIN_REQUIRED" || res.status === 403 || policy.sensitivity === "HIGH_RISK") {
          setNeedsReauth(true);
        }
        setError(data?.error || "تعذّر تأكيد السياسة.");
      } else if (data?.policy) {
        setPolicy(data.policy);
      } else {
        setPolicy({ ...policy, status: "ACTIVE" });
      }
    } catch {
      setError("حدث خطأ في الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (busy || policy.status !== "PROPOSED") return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/merchant-policies/${encodeURIComponent(policy.id)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "تعذّر إلغاء المسودة.");
      } else if (data?.policy) {
        setPolicy(data.policy);
      } else {
        setPolicy({ ...policy, status: "CANCELLED" });
      }
    } catch {
      setError("حدث خطأ في الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      dir="rtl"
      data-testid="merchant-policy-review-card"
      aria-label="مراجعة سياسة المتجر"
      className="w-full max-w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 p-4 text-right text-slate-100 shadow-lg"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
        <div>
          <span className="text-xs text-slate-400">مراجعة سياسة المتجر · الإصدار {policy.version}</span>
          <h3 className="text-base font-semibold text-white">{kindLabel}</h3>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
          {review.sensitivityLabelAr || badge.label}
        </span>
      </div>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/5 px-3 py-2">
          <span className="text-slate-400">النطاق:</span>
          <span className="font-medium text-white">
            {scopeLabel}
            {policy.scopeRef ? ` (${policy.scopeRef})` : ""}
          </span>
        </div>

        {review.summaryAr && (
          <div className="rounded-xl bg-white/5 px-3 py-2.5 text-slate-200">
            <p className="text-xs text-slate-400">ملخص القاعدة:</p>
            <p className="mt-1 font-medium leading-relaxed">{review.summaryAr}</p>
          </div>
        )}

        {review.replacesPolicy && (
          <div
            data-testid="policy-replaces-notice"
            className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200"
          >
            ستحل هذه السياسة محل السياسة النشطة الحالية (الإصدار {review.replacesPolicy.version}).
          </div>
        )}

        {conflicts.length > 0 && (
          <div
            data-testid="policy-conflicts-warning"
            role="alert"
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200"
          >
            <p className="font-semibold">تعارضات يجب الانتباه إليها:</p>
            <ul className="mt-1 list-inside list-disc space-y-1">
              {conflicts.map((c, idx) => (
                <li key={idx}>{c.reasonAr || c.message || c.kind}</li>
              ))}
            </ul>
          </div>
        )}

        {policy.sensitivity === "HIGH_RISK" && (
          <div
            data-testid="policy-high-risk-notice"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
          >
            هذا التغيير عالي الحساسية؛ يتطلب جلسة تسجيل دخول حديثة لتفعيله.
          </div>
        )}

        {error && (
          <div role="alert" data-testid="policy-error-banner" className="rounded-xl border border-rose-500/40 bg-rose-500/15 px-3 py-2 text-xs text-rose-200">
            <p>{error}</p>
            {needsReauth && (
              <a
                href="/login?reauth=1"
                data-testid="policy-reauth-action"
                className="mt-1.5 inline-block rounded-lg bg-rose-500/30 px-2.5 py-1 font-semibold text-white hover:bg-rose-500/40"
              >
                تسجيل الدخول مجددًا لتأكيد السياسة
              </a>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
        <span data-testid="policy-status-badge" className="text-xs text-slate-400">
          الحالة:{" "}
          <strong className="text-white">
            {policy.status === "PROPOSED"
              ? "بانتظار تأكيدك"
              : policy.status === "ACTIVE"
                ? "مفعّلة (من سياسة التاجر — الإصدار " + policy.version + ")"
                : policy.status === "CANCELLED"
                  ? "ملغاة"
                  : policy.status}
          </strong>
        </span>

        {policy.status === "PROPOSED" && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              data-testid="policy-confirm-btn"
              onClick={handleConfirm}
              className="min-h-[40px] rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-50"
            >
              {busy ? "جاري التأكيد..." : "تأكيد وتفعيل السياسة"}
            </button>
            <button
              type="button"
              disabled={busy}
              data-testid="policy-cancel-btn"
              onClick={handleCancel}
              className="min-h-[40px] rounded-xl border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
            >
              إلغاء
            </button>
            {onReply && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onReply("تأكيد السياسة")}
                className="sr-only"
              >
                رد نصي
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
