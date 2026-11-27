import { lazy, Suspense, useState } from "react";
import { Bike, Check, Clock3, MapPin, MessageSquare, Navigation, Phone, Star, Store } from "lucide-react";
import type { DinarMapMarker } from "../maps/DinarMap";
const DinarMap = lazy(() => import("../maps/DinarMap"));

export type DeliveryStepState = "ACCEPTED" | "PREPARING" | "PICKED_UP" | "OUT_FOR_DELIVERY" | "ARRIVED" | "DELIVERED";

export interface LiveDeliveryTrackerProps {
  orderRef: string;
  merchantName: string;
  status: DeliveryStepState;
  etaLabel: string;
  remainingKmLabel: string;
  progressPercent: number;
  courierName?: string;
  courierRating?: number;
  courierPhone?: string;
  vehicleLabel?: string;
  pickupCoords?: { lat: number; lng: number };
  dropoffCoords?: { lat: number; lng: number };
  courierCoords?: { lat: number; lng: number };
  onQuickMessage?: (text: string) => void;
}

const STEPS: { key: DeliveryStepState; label: string }[] = [
  { key: "ACCEPTED", label: "تم القبول" },
  { key: "PICKED_UP", label: "استلام المندوب" },
  { key: "OUT_FOR_DELIVERY", label: "في الطريق إليك" },
  { key: "DELIVERED", label: "تم التسليم" },
];
const STEP_ORDER: Record<DeliveryStepState, number> = { ACCEPTED: 0, PREPARING: 0, PICKED_UP: 1, OUT_FOR_DELIVERY: 2, ARRIVED: 2, DELIVERED: 3 };
const QUICK_REPLIES = ["أنا عند الباب", "اتصل بي عند الوصول", "اترك الطلب عند الاستقبال"];

export function LiveDeliveryTrackerCard({ orderRef, merchantName, status, etaLabel, remainingKmLabel, progressPercent, courierName, courierRating, courierPhone, vehicleLabel = "دراجة توصيل سريعة", pickupCoords, dropoffCoords, courierCoords, onQuickMessage }: LiveDeliveryTrackerProps) {
  const [showMap, setShowMap] = useState(false);
  const currentIdx = STEP_ORDER[status];
  const clamped = Math.max(5, Math.min(100, progressPercent));
  const hasMapPoints = Boolean(pickupCoords && dropoffCoords);

  const markers: DinarMapMarker[] = [
    ...(pickupCoords ? [{ id: "pickup", kind: "pickup" as const, point: { latitude: pickupCoords.lat, longitude: pickupCoords.lng }, label: merchantName }] : []),
    ...(courierCoords ? [{ id: "courier", kind: "driver" as const, point: { latitude: courierCoords.lat, longitude: courierCoords.lng }, label: courierName ?? "المندوب" }] : []),
    ...(dropoffCoords ? [{ id: "dropoff", kind: "destination" as const, point: { latitude: dropoffCoords.lat, longitude: dropoffCoords.lng }, label: "موقع التسليم" }] : []),
  ];

  return (
    <section dir="rtl" aria-label="تتبع التوصيل المباشر داخل المحادثة" data-testid="live-delivery-tracker-card" data-delivery-status={status} className="animate-fade w-full max-w-[480px] overflow-hidden rounded-2xl border border-amber-500/30 bg-card/95 shadow-md backdrop-blur-sm">
      <header className="flex items-center justify-between gap-3 border-b border-amber-400/20 bg-gradient-to-l from-[#071830] via-[#0e2d5a] to-[#081d3b] px-4 py-3 text-white">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300">
            <span className="size-2 animate-pulse rounded-full bg-emerald-400" aria-hidden />
            <span>تتبع مباشر · <bdi dir="ltr" className="tabular-nums">{orderRef}</bdi></span>
          </div>
          <h3 className="mt-0.5 truncate text-sm font-bold">{merchantName}</h3>
        </div>
        <div className="shrink-0 rounded-xl border border-amber-400/35 bg-amber-500/15 px-3 py-1.5 text-center">
          <p className="text-[10px] text-amber-200">الوقت المتوقع</p>
          <p className="text-sm font-bold tabular-nums text-amber-300" data-testid="tracker-eta">{etaLabel}</p>
        </div>
      </header>
      <div className="space-y-3.5 p-4">
        <div className="rounded-xl border border-border/70 bg-muted/35 p-3">
          <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><Store size={13} className="text-primary" aria-hidden /> المتجر</span>
            <span className="flex items-center gap-1 font-semibold tabular-nums text-foreground"><Navigation size={12} className="text-amber-500" aria-hidden /> متبقي {remainingKmLabel}</span>
            <span className="flex items-center gap-1"><MapPin size={13} className="text-emerald-500" aria-hidden /> موقعك</span>
          </div>
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-border/80" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-gradient-to-l from-amber-400 via-amber-500 to-emerald-500 transition-all duration-500" style={{ width: `${clamped}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1 text-center">
            {STEPS.map((step, i) => {
              const done = i < currentIdx || status === "DELIVERED";
              const active = i === currentIdx && status !== "DELIVERED";
              return (
                <div key={step.key} className="flex flex-col items-center gap-1">
                  <span className={`grid size-6 place-items-center rounded-full border text-[11px] font-bold transition ${done ? "border-emerald-500 bg-emerald-500 text-white" : active ? "border-amber-500 bg-amber-500/20 text-amber-600 dark:text-amber-300" : "border-border bg-background text-muted-foreground"}`}>
                    {done ? <Check size={12} aria-hidden /> : active ? <Bike size={12} aria-hidden /> : i + 1}
                  </span>
                  <span className={`text-[10.5px] leading-tight ${done || active ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{step.label}</span>
                </div>
              );
            })}
          </div>
        </div>
        {hasMapPoints && (
          <div>
            <button type="button" onClick={() => setShowMap((v) => !v)} data-testid="button-toggle-tracker-map" className="pressable flex min-h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-border/80 bg-background/80 text-xs font-semibold text-foreground hover:bg-muted/60">
              <MapPin size={14} className="text-amber-500" aria-hidden />
              <span>{showMap ? "إخفاء الخريطة المباشرة" : "عرض الخريطة المباشرة داخل المحادثة"}</span>
            </button>
            {showMap && (
              <div className="mt-2 h-48 overflow-hidden rounded-xl border border-border">
                <Suspense fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground"><Clock3 size={16} className="animate-spin" /></div>}>
                  <DinarMap markers={markers} ariaLabel="خريطة التتبع المباشر للطلب" height={192} />
                </Suspense>
              </div>
            )}
          </div>
        )}
        {courierName && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/25 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-foreground">{courierName}</p>
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>{vehicleLabel}</span>
                {courierRating && <span className="inline-flex items-center gap-0.5 font-semibold tabular-nums text-amber-500">· <Star size={11} className="fill-amber-400" aria-hidden /> {courierRating.toFixed(1)}</span>}
              </p>
            </div>
            {courierPhone && (
              <a href={`tel:${courierPhone}`} aria-label="الاتصال بالمندوب" className="pressable inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/12 px-3 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <Phone size={14} aria-hidden /><span>اتصال</span>
              </a>
            )}
          </div>
        )}
        {onQuickMessage && (
          <div className="flex flex-wrap gap-1.5" aria-label="رسائل سريعة للمندوب">
            {QUICK_REPLIES.map((msg) => (
              <button key={msg} type="button" onClick={() => onQuickMessage(msg)} className="pressable inline-flex min-h-9 items-center gap-1 rounded-full border border-border/80 bg-background/80 px-3 text-[11.5px] font-medium text-foreground hover:border-amber-500/45 hover:bg-amber-500/10">
                <MessageSquare size={11} className="text-amber-500" aria-hidden /><span>{msg}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
