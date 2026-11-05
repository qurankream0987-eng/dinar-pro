import { useEffect, useState } from "react";
import {
  ConnectAgreementTerms,
  type ConnectAgreement,
} from "@workspace/api-zod/connect-platform";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
import { minorToDecimal } from "@workspace/global";
type Agreement = {
  id: string;
  version: number;
  termsDigest: string;
  terms: ConnectAgreement;
  accepted: boolean;
  acceptance: { acceptedAt: string } | null;
};
export function ConnectAgreements({ partnerId }: { partnerId: string }) {
  const [agreements, setAgreements] = useState<Agreement[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const load = async () => {
    const rows = await api(`/connect/partners/${partnerId}/agreements`);
    if (!Array.isArray(rows)) throw new Error("تعذر قراءة الاتفاقيات");
    setAgreements(
      rows.map((row) => ({
        ...row,
        terms: ConnectAgreementTerms.parse(row.terms),
      })),
    );
  };
  useEffect(() => {
    setSelected(null);
    setAgreements([]);
    setError("");
    setMessage("");
    void load().catch((e) => setError(e.message));
  }, [partnerId]);
  const accept = async (row: Agreement) => {
    if (busy || selected !== row.id) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const receipt = await api(
        `/connect/agreements/${row.id}/accept`,
        "POST",
        {
          expectedDigest: row.termsDigest,
          accept: true,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (receipt.accepted !== true)
        throw new Error("تعذر التحقق من دليل القبول");
      await load();
      setSelected(null);
      setMessage(
        "سجل الخادم قبولك الصريح لهذه النسخة؛ لا يثبت ذلك تحويلًا أو تسوية مال حقيقي.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر قبول الاتفاقية");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-bold">اتفاقيات العمولة المنفصلة</h2>
      <p className="text-sm">
        التسجيل المجاني لا يتطلب قبول عمولة. لا تُحتسب عمولة خارجية دون نسخة
        شروط مقبولة وتحويل مؤهل موثّق. الاتفاقيات المتاحة هنا بالمحاكاة فقط.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {agreements.length === 0 && <p>لا توجد اتفاقية مقترحة لهذا الحساب.</p>}
      {agreements.map((row) => (
        <article key={row.id} className="space-y-3 rounded-lg border p-3">
          <h3 className="font-bold">
            النسخة {row.version} —{" "}
            {row.accepted ? "مقبولة" : "بانتظار اختيار المالك"}
          </h3>
          <dl className="space-y-2 text-sm">
            <div>
              <dt>العمولة</dt>
              <dd>
                {row.terms.commission.kind === "PERCENTAGE"
                  ? `${row.terms.commission.basisPoints / 100}%`
                  : minorToDecimal(
                      row.terms.commission.amountMinor,
                      row.terms.currency,
                    )}{" "}
                — {row.terms.currency}
              </dd>
            </div>
            <div>
              <dt>مدة الإسناد</dt>
              <dd>{row.terms.attributionWindowSeconds} ثانية</dd>
            </div>
            <div>
              <dt>فترة سريان الاتفاقية</dt>
              <dd>
                {new Date(row.terms.effectiveFrom).toLocaleString("ar")} —{" "}
                {row.terms.effectiveUntil
                  ? new Date(row.terms.effectiveUntil).toLocaleString("ar")
                  : "دون تاريخ انتهاء محدد"}
              </dd>
            </div>
            <div>
              <dt>مهلة تأكيد التحويل بعد انتهاء الإسناد</dt>
              <dd>{row.terms.reportingGraceSeconds} ثانية</dd>
            </div>
            <div>
              <dt>الأحداث المؤهلة</dt>
              <dd>
                {row.terms.eligibleEvents
                  .map(
                    (event) =>
                      ({
                        PURCHASE_COMPLETED: "شراء مكتمل",
                        BOOKING_CONFIRMED: "حجز مؤكد",
                        SERVICE_COMPLETED: "خدمة مكتملة",
                      })[event],
                  )
                  .join("، ")}
              </dd>
            </div>
            <div>
              <dt>قاعدة الحساب</dt>
              <dd>
                تُثبّت نسخة الاتفاقية عند الإحالة؛{" "}
                {row.terms.rounding === "FLOOR"
                  ? "التقريب إلى وحدة العملة الصغرى الأدنى"
                  : "التقريب إلى أقرب وحدة عملة صغرى، والنصف إلى الأعلى"}
                . لا يوجد تحويل عملات تلقائي.
              </dd>
            </div>
            <div>
              <dt>موعد الاستحقاق</dt>
              <dd>{row.terms.settlementDueDays} يومًا من الحدث المؤهل</dd>
            </div>
            <div>
              <dt>شروط الدفع</dt>
              <dd className="whitespace-pre-wrap">{row.terms.paymentTerms}</dd>
            </div>
            <div>
              <dt>الإلغاء والاسترداد</dt>
              <dd className="whitespace-pre-wrap">
                {row.terms.cancellationPolicy} —{" "}
                {row.terms.refundPolicy === "PRO_RATA_ELIGIBLE_BASE"
                  ? "تخفيض العمولة بحسب الأساس المؤهل المسترد"
                  : "عكس العمولة كاملة عند أي استرداد"}
              </dd>
            </div>
            <div>
              <dt>الاستثناءات</dt>
              <dd className="break-all">
                المنتجات: {row.terms.excludedProductIds.join("، ") || "لا توجد"}
                ؛ التصنيفات:{" "}
                {row.terms.excludedCategoryIds.join("، ") || "لا توجد"}
              </dd>
            </div>
            <div>
              <dt>النسب الخاصة</dt>
              <dd>
                {row.terms.categoryRates
                  .map(
                    (rate) => `${rate.categoryId}: ${rate.basisPoints / 100}%`,
                  )
                  .join("، ") || "لا توجد"}
              </dd>
            </div>
          </dl>
          <p className="whitespace-pre-wrap text-sm">{row.terms.termsText}</p>
          <p className="text-sm">{row.terms.attributionNotice}</p>
          <p className="text-sm">
            نسخة إشعار الخصوصية: {row.terms.privacyPolicyVersion}
          </p>
          {row.accepted ? (
            <p role="status">
              حُفظ دليل القبول في{" "}
              {row.acceptance?.acceptedAt
                ? new Date(row.acceptance.acceptedAt).toLocaleString("ar")
                : "سجل الخادم"}
              .
            </p>
          ) : (
            <>
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0"
                  disabled={busy}
                  checked={selected === row.id}
                  onChange={(e) =>
                    setSelected(e.target.checked ? row.id : null)
                  }
                />
                <span>
                  قرأت الشروط المعروضة وأختار قبول هذه النسخة بالمحاكاة صراحةً
                  بصفتي مالك النشاط.
                </span>
              </label>
              <Button
                disabled={busy || selected !== row.id}
                onClick={() => void accept(row)}
              >
                تسجيل قبول النسخة {row.version}
              </Button>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
