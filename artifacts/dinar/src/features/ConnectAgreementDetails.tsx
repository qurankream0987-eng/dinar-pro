import type { ConnectAgreement } from "@workspace/api-zod/connect-platform";
import { minorToDecimal } from "@workspace/global";
export function ConnectAgreementDetails({terms}:{terms:ConnectAgreement}) { return <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
          <dl className="space-y-2 text-sm">
            <div>
              <dt>العمولة</dt>
              <dd>
                {terms.commission.kind === "PERCENTAGE"
                  ? `${terms.commission.basisPoints / 100}%`
                  : minorToDecimal(
                      terms.commission.amountMinor,
                      terms.currency,
                    )}{" "}
                — {terms.currency}
              </dd>
            </div>
            <div>
              <dt>مدة الإسناد</dt>
              <dd>{terms.attributionWindowSeconds} ثانية</dd>
            </div>
            <div>
              <dt>فترة سريان الاتفاقية</dt>
              <dd>
                {new Date(terms.effectiveFrom).toLocaleString("ar")} —{" "}
                {terms.effectiveUntil
                  ? new Date(terms.effectiveUntil).toLocaleString("ar")
                  : "دون تاريخ انتهاء محدد"}
              </dd>
            </div>
            <div>
              <dt>مهلة تأكيد التحويل بعد انتهاء الإسناد</dt>
              <dd>{terms.reportingGraceSeconds} ثانية</dd>
            </div>
            <div>
              <dt>الأحداث المؤهلة</dt>
              <dd>
                {terms.eligibleEvents
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
                {terms.rounding === "FLOOR"
                  ? "التقريب إلى وحدة العملة الصغرى الأدنى"
                  : "التقريب إلى أقرب وحدة عملة صغرى، والنصف إلى الأعلى"}
                . لا يوجد تحويل عملات تلقائي.
              </dd>
            </div>
            <div>
              <dt>موعد الاستحقاق</dt>
              <dd>{terms.settlementDueDays} يومًا من الحدث المؤهل</dd>
            </div>
            <div>
              <dt>شروط الدفع</dt>
              <dd className="whitespace-pre-wrap">{terms.paymentTerms}</dd>
            </div>
            <div>
              <dt>الإلغاء والاسترداد</dt>
              <dd className="whitespace-pre-wrap">
                {terms.cancellationPolicy} —{" "}
                {terms.refundPolicy === "PRO_RATA_ELIGIBLE_BASE"
                  ? "تخفيض العمولة بحسب الأساس المؤهل المسترد"
                  : "عكس العمولة كاملة عند أي استرداد"}
              </dd>
            </div>
            <div>
              <dt>الاستثناءات</dt>
              <dd className="break-all">
                المنتجات: {terms.excludedProductIds.join("، ") || "لا توجد"}
                ؛ التصنيفات:{" "}
                {terms.excludedCategoryIds.join("، ") || "لا توجد"}
              </dd>
            </div>
            <div>
              <dt>النسب الخاصة</dt>
              <dd>
                {terms.categoryRates
                  .map(
                    (rate) => `${rate.categoryId}: ${rate.basisPoints / 100}%`,
                  )
                  .join("، ") || "لا توجد"}
              </dd>
            </div>
          </dl>
          <p className="whitespace-pre-wrap text-sm">{terms.termsText}</p>
          <p className="text-sm">{terms.attributionNotice}</p>
          <p className="text-sm">
            نسخة إشعار الخصوصية: {terms.privacyPolicyVersion}
          </p>
  </div>;
}
