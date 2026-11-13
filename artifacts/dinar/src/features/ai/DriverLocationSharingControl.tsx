import { useEffect, useState } from "react";
import { MapPin, MapPinOff } from "lucide-react";
import {
  getGetDriverLocationSharingQueryKey,
  useGetDriverLocationSharing,
  useStartDriverLocationSharing,
  useStopDriverLocationSharing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/ui/Button";
import { sharedDriverLocationSharer, type SharingState } from "./driver-location-sharing";

const STATE_COPY: Record<SharingState["kind"], string> = {
  IDLE: "مشاركة الموقع متوقفة.",
  WAITING_FOR_FIX: "بانتظار أول قراءة من جهازك…",
  SHARING: "مشاركة الموقع مفعّلة لهذا الطلب فقط.",
  PAUSED_HIDDEN: "المشاركة متوقفة مؤقتًا لأن الصفحة غير ظاهرة. افتح جاسم لاستئنافها؛ المتصفح لا يشارك الموقع في الخلفية.",
  PERMISSION_DENIED: "لم يُسمح بالوصول إلى الموقع؛ توقفت المشاركة. يمكنك متابعة التوصيل وتحديث الحالة يدويًا.",
  UNAVAILABLE: "هذا الجهاز لا يوفر تحديد الموقع.",
  REJECTED: "رُفضت قراءة غير دقيقة أو غير منطقية؛ ستُرسل القراءة التالية.",
  ENDED: "انتهت مشاركة الموقع مع انتهاء مرحلة التوصيل أو سحب المهمة.",
};

/** Explicit, assignment-bound sharing for the assigned driver; visible at all times while active. */
export function DriverLocationSharingControl({ orderId, enabled }: { orderId: string; enabled: boolean }) {
  const client = useQueryClient();
  const status = useGetDriverLocationSharing(orderId, { query: { queryKey: getGetDriverLocationSharingQueryKey(orderId), enabled, staleTime: 0 } });
  const start = useStartDriverLocationSharing();
  const stop = useStopDriverLocationSharing();
  const [consentOpen, setConsentOpen] = useState(false);
  const [state, setState] = useState<SharingState>({ kind: "IDLE" });
  const active = status.data?.active === true;
  const initialSequence = status.data?.sequence ?? 0;

  useEffect(() => {
    if (!enabled || !active) return;
    const sharer = sharedDriverLocationSharer(orderId, initialSequence);
    const unsubscribe = sharer.subscribe((next) => {
      setState(next);
      if (next.kind === "ENDED" || next.kind === "PERMISSION_DENIED") {
        void client.invalidateQueries({ queryKey: getGetDriverLocationSharingQueryKey(orderId) });
        if (next.kind === "PERMISSION_DENIED") void stop.mutateAsync({ id: orderId }).catch(() => undefined);
      }
    });
    sharer.start();
    return () => {
      unsubscribe();
    };
    // initialSequence only seeds a new session; later status refreshes must not recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, active, orderId]);

  if (!enabled) return null;

  const begin = async () => {
    setConsentOpen(false);
    await start.mutateAsync({ id: orderId, data: { consent: true } }).catch(() => undefined);
    await client.invalidateQueries({ queryKey: getGetDriverLocationSharingQueryKey(orderId) });
  };
  const end = async () => {
    sharedDriverLocationSharer(orderId, 0).stop();
    await stop.mutateAsync({ id: orderId }).catch(() => undefined);
    setState({ kind: "IDLE" });
    await client.invalidateQueries({ queryKey: getGetDriverLocationSharingQueryKey(orderId) });
  };

  return (
    <div className="mt-3 rounded-xl border border-border bg-muted/40 p-3" data-testid={`driver-location-sharing-${orderId}`}>
      {active ? (
        <>
          <p className="dinar-sharing-indicator" role="status" data-testid="driver-sharing-active">
            <span className="dinar-sharing-dot" aria-hidden /> الموقع يُشارك الآن مع مشتري هذا الطلب
          </p>
          <p className="mt-2 text-sm text-muted-foreground" data-testid="driver-sharing-state" data-state={state.kind}>
            {STATE_COPY[state.kind]}
          </p>
          <Button size="sm" variant="secondary" className="mt-2" icon={<MapPinOff size={14} aria-hidden />} onClick={() => void end()} data-testid="driver-sharing-stop">
            إيقاف مشاركة الموقع
          </Button>
        </>
      ) : consentOpen ? (
        <div role="dialog" aria-modal="false" aria-labelledby={`sharing-consent-${orderId}`} data-testid="driver-sharing-consent">
          <p id={`sharing-consent-${orderId}`} className="font-medium text-foreground">مشاركة موقعك أثناء هذا التوصيل؟</p>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-muted-foreground">
            <li>يرى مشتري هذا الطلب فقط آخر موقع لك، ولا يُحفظ مسار تحركاتك.</li>
            <li>تعمل المشاركة وصفحة جاسم مفتوحة فقط، وتتوقف عند الإيقاف أو انتهاء التوصيل.</li>
            <li>يمكنك الإيقاف في أي وقت، ويُحذف الموقع المحفوظ فورًا.</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" icon={<MapPin size={14} aria-hidden />} onClick={() => void begin()} disabled={start.isPending} data-testid="driver-sharing-consent-accept">
              أوافق وأبدأ المشاركة
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConsentOpen(false)} data-testid="driver-sharing-consent-cancel">
              ليس الآن
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button size="sm" variant="secondary" icon={<MapPin size={14} aria-hidden />} onClick={() => setConsentOpen(true)} data-testid="driver-sharing-start">
            مشاركة موقعي مع المشتري
          </Button>
          {status.data?.endReason && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="driver-sharing-ended">{STATE_COPY.ENDED}</p>
          )}
        </>
      )}
    </div>
  );
}
