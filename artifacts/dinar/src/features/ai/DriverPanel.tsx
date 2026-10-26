import { Check, PackageCheck, MapPin, X } from "lucide-react";
import { Button } from "@/ui/Button";
import { PendingNotice } from "./SmartSurfaces";
import { CourierCommissionPanel, CourierFareCard } from "./CourierEconomicsSurfaces";

export { DRIVER_SURFACES, isDriverPayload, type DriverPayload, type DriverSurface } from "./driver-types";
import type { DriverPayload, Place } from "./driver-types";

const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
const place = (value: Place | null | undefined) => (value ? [value.city, value.area].filter(Boolean).join(" - ") : "—");
const REVIEW_STATUS: Record<string, string> = {
  CONFIRMED: "تم بعد تأكيدك.",
  CANCELLED: "أُلغي دون أي تغيير.",
  EXPIRED: "انتهت صلاحية هذه المراجعة دون أي تغيير.",
  REJECTED: "لم يُنفذ؛ لم يتغير شيء.",
};

export function DriverPanel({ driver, active, activeMarketId, onSend }: { driver: DriverPayload; active: boolean; activeMarketId?: string; onSend?: (text: string) => void }) {
  const canAct = active && Boolean(onSend);
  return (
    <section className="ai-surface mt-3 max-w-xl rounded-xl border border-border bg-card p-3 text-sm" aria-label="مهام السائق" data-testid="driver-panel" data-view={driver.view}>
      {driver.profile && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">الحالة</dt>
          <dd>{driver.profile.statusLabel}</dd>
          <dt className="text-muted-foreground">المركبة</dt>
          <dd>{driver.profile.vehicleLabel ?? "—"}</dd>
          <dt className="text-muted-foreground">مدينة العمل</dt>
          <dd className="break-words">{driver.profile.serviceCity ?? "—"}</dd>
          <dt className="text-muted-foreground">الإتاحة</dt>
          <dd>{driver.profile.availability === "AVAILABLE" ? "متاح" : "غير متاح"}</dd>
          {driver.profile.remaining.length > 0 && (
            <>
              <dt className="text-muted-foreground">المتبقي</dt>
              <dd className="break-words">{driver.profile.remaining.join("، ")}</dd>
            </>
          )}
        </dl>
      )}
      {driver.work && (
        <ul className="grid gap-2" data-testid="delivery-work">
          {driver.work.map((card, index) => (
            <li key={card.id} className="rounded-lg border border-border p-2">
              <p className="break-words font-semibold">
                {index + 1}. {card.title} <span className="text-xs text-muted-foreground">({card.reference})</span>
              </p>
              <p className="break-words text-xs text-muted-foreground">
                الاستلام: {place(card.pickup)} · التسليم: {place(card.dropoff)}
              </p>
              {canAct && index < ORDINALS.length && (
                <Button size="sm" className="mt-2" onClick={() => onSend!(`أقبل ${ORDINALS[index]}`)} data-testid={`driver-accept-${index + 1}`}>
                  قبول المهمة
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {driver.card && (
        <p className="break-words">
          {driver.card.title} ({driver.card.reference}): {place(driver.card.pickup)} ← {place(driver.card.dropoff)}
        </p>
      )}
      {driver.assignments && driver.assignments.length > 0 && (
        <ul className="grid gap-1">
          {driver.assignments.map((row, index) => (
            <li key={row.orderId} className="break-words">
              {row.title} ({row.reference}) · {row.statusLabel ?? "—"} · التسليم: {place(row.dropoff)}
              <div className="mt-2">
                <CourierFareCard orderId={row.orderId} role="COURIER" active={active} />
              </div>
              {canAct && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3" data-testid={`driver-tracking-actions-${row.orderId}`}>
                  {row.status === "ACCEPTED" && <Button
                    size="sm"
                    variant="secondary"
                    icon={<PackageCheck size={15} aria-hidden />}
                    onClick={() => onSend!(`استلمت الطلب ${ORDINALS[index] ?? "الأول"}`)}
                    data-testid={`driver-pickup-${row.orderId}`}
                  >
                    تأكيد استلام الطلب
                  </Button>}
                  {row.status === "ACCEPTED" && <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onSend!(`أنا في الطريق ${ORDINALS[index] ?? "الأول"}`)}
                    data-testid={`driver-progress-${row.orderId}`}
                  >
                    بدء التوصيل
                  </Button>}
                  {row.status === "OUT_FOR_DELIVERY" && <Button
                    size="sm"
                    variant="secondary"
                    icon={<MapPin size={15} aria-hidden />}
                    onClick={() => onSend!(`وصلت للعميل في الطلب ${ORDINALS[index] ?? "الأول"}`)}
                    data-testid={`driver-arrival-${row.orderId}`}
                  >
                    تأكيد الوصول للعميل
                  </Button>}
                  {row.status === "OUT_FOR_DELIVERY" && <Button
                    size="sm"
                    onClick={() => onSend!(`تم التسليم ${ORDINALS[index] ?? "الأول"}`)}
                    data-testid={`driver-handoff-${row.orderId}`}
                  >
                    تسجيل التسليم
                  </Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <CourierCommissionPanel active={active} activeMarketId={activeMarketId} />
      {driver.actionId && driver.status === "PENDING" && <PendingNotice />}
      {driver.actionId &&
        (driver.status === "PENDING" && canAct ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" icon={<Check size={14} aria-hidden />} onClick={() => onSend!("نعم")} data-testid="driver-confirm">
              {driver.view === "DRIVER_ASSIGNMENT_REVIEW" ? "قبول المهمة" : "إرسال التسجيل"}
            </Button>
            <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => onSend!("إلغاء")} data-testid="driver-cancel">
              إلغاء
            </Button>
          </div>
        ) : (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {REVIEW_STATUS[driver.status ?? ""] ?? ""}
          </p>
        ))}
    </section>
  );
}
