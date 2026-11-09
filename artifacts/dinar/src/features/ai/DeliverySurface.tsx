import { lazy, Suspense, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Check, LocateFixed, Map as MapIcon, MapPin, PenLine, RotateCcw, Truck, X } from "lucide-react";
import { Button } from "@/ui/Button";
import { Field, Input, Textarea } from "@/ui/Field";
import { CourierFareCard } from "./CourierEconomicsSurfaces";
import type {
  DeliveryLocation,
  DeliveryPayload,
  DeliveryPreview,
  LocationSubmission,
} from "./delivery-types";
import { readDeviceLocationOnce } from "./one-time-location";
import { resolveMapStyle } from "../maps/map-style";
import type { MapPoint } from "../maps/DinarMap";

const DinarMap = lazy(() => import("../maps/DinarMap"));
const mapConfigured = () => resolveMapStyle().kind !== "NONE";

/**
 * Choose or adjust a delivery point on the map. Nothing is sent until the user confirms; the
 * point is submitted as source MAP (chosen on a map), never presented as a device reading.
 */
function MapPicker({ requestId, onSend, start, onClose }: { requestId: string; onSend: Send; start: MapPoint | null; onClose: () => void }) {
  const [point, setPoint] = useState<MapPoint | null>(start);
  const markers = useMemo(() => (point ? [{ id: "selection", kind: "selection" as const, point, label: "النقطة المختارة للتسليم" }] : []), [point]);
  return (
    <div className="mt-3" data-testid="delivery-map-picker">
      <p className="mb-2 text-sm text-muted-foreground">
        {point ? "اسحب العلامة أو اضغط على الخريطة لتعديل نقطة التسليم، ثم أكّد." : "اضغط على الخريطة لاختيار نقطة التسليم."}
      </p>
      <Suspense fallback={<div className="skeleton h-[260px] w-full rounded-2xl" />}>
        <DinarMap markers={markers} ariaLabel="اختيار نقطة التسليم على الخريطة" height={260} onSelect={setPoint} testId="delivery-picker-map" />
      </Suspense>
      <SurfaceActions>
        <Button
          size="sm"
          disabled={!point}
          icon={<Check size={14} aria-hidden />}
          onClick={() => point && onSend("استخدم النقطة المحددة على الخريطة", { locationRequestId: requestId, location: { source: "MAP", latitude: point.latitude, longitude: point.longitude } })}
          data-testid="delivery-map-use-point"
        >
          استخدم هذه النقطة
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={onClose} data-testid="delivery-map-close">
          رجوع
        </Button>
      </SurfaceActions>
    </div>
  );
}
import { FactList, SurfaceActions, SurfacePanel, factRows } from "./surface/primitives";

type Send = (text: string, location?: LocationSubmission) => void;

const ACTION_STATUS: Record<string, string> = {
  CONFIRMED: "تم التنفيذ بعد تأكيدك.",
  CANCELLED: "أُلغي دون أي تغيير.",
  EXPIRED: "انتهت صلاحيته دون أي تغيير.",
  REJECTED: "لم يُنفذ؛ لم يتغير شيء.",
};

/** Seller/buyer next steps; each sends the same conversational command a user could type. */
const NEXT_ACTION_COMMANDS: Record<string, [string, string]> = {
  ACCEPTED: ["قبول التوصيل", "اقبل التوصيل"],
  OUT_FOR_DELIVERY: ["خرج للتوصيل", "خرج للتوصيل"],
  READY_FOR_PICKUP: ["جاهز للاستلام", "جاهز للاستلام"],
  FAILED: ["تعذر التسليم", "تعذر التوصيل"],
  CANCELLED: ["إلغاء ترتيب التسليم", "ألغِ التوصيل"],
};
const METHOD_COMMANDS: Record<string, string> = {
  PICKUP: "استلام شخصي",
  SELLER_DELIVERY: "توصيل من البائع",
  COURIER: "مندوب يوصل طلبي",
};

/** Text-only place summary; no map provider and no coordinates in any link. */
function placeLines(place: Pick<DeliveryLocation, "source" | "latitude" | "longitude" | "accuracyNote" | "city" | "area" | "addressText" | "note">): [string, ReactNode][] {
  const rows: [string, ReactNode][] = [];
  if (place.source !== "MANUAL" && place.latitude !== null && place.longitude !== null)
    rows.push(["الموقع", place.source === "MAP" ? "نقطة محددة على الخريطة لهذا الطلب؛ لا تُعرض الإحداثيات في المحادثة." : "تم استلام الموقع لهذا الطلب؛ لا تُعرض الإحداثيات في المحادثة."]);
  const coarse = [place.city, place.area].filter(Boolean).join("، ");
  if (coarse) rows.push(["المنطقة", coarse]);
  if (place.addressText) rows.push(["العنوان", place.addressText]);
  if (place.note) rows.push(["ملاحظة", place.note]);
  if (place.accuracyNote) rows.push(["الدقة", place.accuracyNote]);
  return rows;
}

function PlaceCard({ place, testId }: { place: DeliveryLocation; testId: string }) {
  return (
    <div className="mt-2 rounded-lg bg-muted/50 p-2.5" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <MapPin size={15} aria-hidden /> {place.purposeLabel}
      </p>
      {place.redacted ? (
        <p className="mt-1 text-sm text-muted-foreground">حُذفت التفاصيل الدقيقة بعد انتهاء الطلب.</p>
      ) : (
        <FactList rows={factRows(placeLines(place))} />
      )}
    </div>
  );
}

/** One explicit tap → one device reading. Denial or failure offers manual entry and an explicit retry. */
function ShareLocationButtons({ requestId, onSend }: { requestId: string; onSend: Send }) {
  const [reading, setReading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<"DENIED" | "UNAVAILABLE" | "TIMEOUT" | null>(null);
  const share = async () => {
    setReading(true);
    setProblem(null);
    const result = await readDeviceLocationOnce();
    setReading(false);
    if (result.kind !== "OK") {
      setProblem(result.kind);
      return;
    }
    onSend("مشاركة موقعي الحالي", {
      locationRequestId: requestId,
      location: {
        source: "DEVICE",
        latitude: result.latitude,
        longitude: result.longitude,
        accuracyMeters: result.accuracyMeters,
      },
    });
  };
  return (
    <>
      {problem && (
        <div role="alert" className="mt-3 rounded-lg border border-border bg-muted/50 p-2.5 text-sm" data-testid="delivery-location-problem">
          {problem === "DENIED"
            ? "لم يُسمح بالوصول إلى الموقع، ولم يُرسل شيء. يمكنك كتابة العنوان يدويًا، أو السماح بالموقع من إعدادات المتصفح ثم إعادة المحاولة."
            : problem === "TIMEOUT"
              ? "استغرق تحديد الموقع وقتًا طويلًا، ولم يُرسل شيء. أعد المحاولة أو اكتب العنوان يدويًا."
              : "تعذر تحديد الموقع على هذا الجهاز، ولم يُرسل شيء. اكتب العنوان يدويًا."}
        </div>
      )}
      <SurfaceActions>
        <Button
          size="sm"
          loading={reading}
          icon={problem ? <RotateCcw size={14} aria-hidden /> : <LocateFixed size={14} aria-hidden />}
          onClick={() => void share()}
          data-testid="delivery-share-location"
        >
          {problem ? "إعادة المحاولة" : "مشاركة موقعي الآن"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={reading}
          icon={<PenLine size={14} aria-hidden />}
          onClick={() => onSend("اكتب العنوان يدويًا")}
          data-testid="delivery-manual-address"
        >
          اكتب العنوان يدويًا
        </Button>
        {mapConfigured() && !picking && (
          <Button size="sm" variant="secondary" disabled={reading} icon={<MapIcon size={14} aria-hidden />} onClick={() => setPicking(true)} data-testid="delivery-pick-on-map">
            اختيار على الخريطة
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={reading} icon={<X size={14} aria-hidden />} onClick={() => onSend("إلغاء")} data-testid="delivery-cancel">
          إلغاء
        </Button>
      </SurfaceActions>
      {picking && <MapPicker requestId={requestId} onSend={onSend} start={null} onClose={() => setPicking(false)} />}
    </>
  );
}

function ManualAddressForm({ requestId, onSend }: { requestId: string; onSend: Send }) {
  const [city, setCity] = useState("");
  const [area, setArea] = useState("");
  const [addressText, setAddressText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (addressText.trim().length < 3) {
      setError("اكتب العنوان أو وصفًا واضحًا للمكان.");
      return;
    }
    onSend("عنوان تسليم يدوي", {
      locationRequestId: requestId,
      location: {
        source: "MANUAL",
        ...(city.trim() ? { city: city.trim() } : {}),
        ...(area.trim() ? { area: area.trim() } : {}),
        addressText: addressText.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    });
  };
  return (
    <form className="mt-3 grid gap-3" onSubmit={submit} data-testid="delivery-manual-form" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="المدينة" optional>
          <Input value={city} maxLength={100} onChange={(event) => setCity(event.target.value)} autoComplete="off" data-testid="delivery-manual-city" />
        </Field>
        <Field label="المنطقة" optional>
          <Input value={area} maxLength={100} onChange={(event) => setArea(event.target.value)} autoComplete="off" data-testid="delivery-manual-area" />
        </Field>
      </div>
      <Field label="العنوان" error={error || null} hint="الشارع والمبنى أو وصف يساعد على الوصول. يراه الطرف الآخر في هذا الطلب فقط.">
        <Textarea
          value={addressText}
          maxLength={300}
          rows={2}
          onChange={(event) => {
            setAddressText(event.target.value);
            setError("");
          }}
          autoComplete="off"
          data-testid="delivery-manual-address-text"
        />
      </Field>
      <Field label="ملاحظة للتسليم" optional>
        <Input value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} autoComplete="off" data-testid="delivery-manual-note" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" icon={<Check size={14} aria-hidden />} data-testid="delivery-manual-submit">
          مراجعة العنوان
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => onSend("إلغاء")}>
          إلغاء
        </Button>
      </div>
    </form>
  );
}

function PreviewCard({ preview }: { preview: DeliveryPreview }) {
  return (
    <div className="mt-2 rounded-lg bg-muted/50 p-2.5" data-testid="delivery-location-preview">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <MapPin size={15} aria-hidden /> {preview.purposeLabel}
        <span className="text-xs font-normal text-muted-foreground">
          · {preview.source === "DEVICE" ? "من موقع جهازك" : preview.source === "MAP" ? "نقطة اخترتها على الخريطة" : "عنوان مكتوب"}
        </span>
      </p>
      {preview.available && preview.latitude !== null && preview.longitude !== null && mapConfigured() && (
        <div className="mt-2">
          <Suspense fallback={<div className="skeleton h-[180px] w-full rounded-2xl" />}>
            <DinarMap
              markers={[{ id: "preview", kind: "destination", point: { latitude: preview.latitude, longitude: preview.longitude }, label: preview.purposeLabel }]}
              ariaLabel="معاينة نقطة التسليم"
              height={180}
              testId="delivery-preview-map"
            />
          </Suspense>
        </div>
      )}
      {preview.available ? (
        <FactList rows={factRows(placeLines(preview))} />
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">لم يعد الموقع المعروض محفوظًا.</p>
      )}
    </div>
  );
}

/** Renders a server-built delivery view. Buttons send the same conversational commands. */
export function DeliverySurface({
  delivery,
  active,
  onSend,
}: {
  delivery: DeliveryPayload;
  active: boolean;
  onSend?: Send;
}) {
  const send = active ? onSend : undefined;
  const { view, order } = delivery;
  const status = order?.fulfillment;
  // A notice is the assistant's text itself; it has no card.
  if (view === "DELIVERY_NOTICE") return <span hidden data-testid="delivery-delivery_notice" />;
  return (
    <section className="ai-surface mt-3 max-w-2xl space-y-2.5" aria-label="التوصيل والموقع" data-testid={`delivery-${view.toLowerCase()}`}>
      <SurfacePanel testId="delivery-card">
          {order && (
            <h3 className="flex items-center gap-1.5 break-words font-semibold">
              <Truck size={16} aria-hidden />
              {order.listingTitle}
              <span className="num text-xs font-normal text-muted-foreground">#{order.orderRef}</span>
            </h3>
          )}

          {(view === "LOCATION_PERMISSION_REQUEST" || view === "MANUAL_ADDRESS") && delivery.request && (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {view === "MANUAL_ADDRESS"
                  ? `${delivery.request.purposeLabel ?? "العنوان"} — ستراجعه قبل إرساله.`
                  : "يُقرأ موقع جهازك مرة واحدة فقط عند الضغط، وتراجعه قبل إرساله. لا تتبع ولا مشاركة تلقائية."}
              </p>
              {send &&
                (view === "MANUAL_ADDRESS" ? (
                  <ManualAddressForm requestId={delivery.request.requestId} onSend={send} />
                ) : (
                  <ShareLocationButtons requestId={delivery.request.requestId} onSend={send} />
                ))}
            </>
          )}

          {view === "LOCATION_PREVIEW" && delivery.preview && (
            <>
              <PreviewCard preview={delivery.preview} />
              {delivery.action && (
                <ul className="mt-2 space-y-1 text-sm">
                  {delivery.action.lines.map((line) => (
                    <li key={line} className="break-words">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
              {send && delivery.action?.status === "PENDING" ? (
                <>
                  <SurfaceActions>
                    <Button size="sm" icon={<Check size={14} aria-hidden />} onClick={() => send("تأكيد الموقع")} data-testid="delivery-confirm-location">
                      تأكيد الموقع
                    </Button>
                    {delivery.preview.source === "MANUAL" && (
                      <Button size="sm" variant="secondary" icon={<PenLine size={14} aria-hidden />} onClick={() => send("اكتب العنوان يدويًا")}>
                        تعديل العنوان
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => send("إلغاء")} data-testid="delivery-cancel">
                      إلغاء
                    </Button>
                  </SurfaceActions>
                  {delivery.preview.source === "DEVICE" && (
                    <ShareLocationButtonsRetry requestId={delivery.action.actionId} onSend={send} />
                  )}
                  {delivery.preview.source !== "MANUAL" && delivery.preview.latitude !== null && delivery.preview.longitude !== null && mapConfigured() && (
                    <AdjustOnMap
                      requestId={delivery.action.actionId}
                      onSend={send}
                      start={{ latitude: delivery.preview.latitude, longitude: delivery.preview.longitude }}
                    />
                  )}
                </>
              ) : (
                delivery.action && (
                  <p role="status" className="mt-2 text-sm text-muted-foreground" data-testid="delivery-action-status" data-status={delivery.action.status}>
                    {ACTION_STATUS[delivery.action.status] ?? ""}
                  </p>
                )
              )}
            </>
          )}

          {(view === "DELIVERY_SUMMARY" || view === "DELIVERY_ACTION") && delivery.action && (
            <>
              <ul className="mt-2 space-y-1 text-sm" data-testid="delivery-summary-lines">
                {delivery.action.lines.map((line) => (
                  <li key={line} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
              {send && delivery.action.status === "PENDING" ? (
                <SurfaceActions>
                  <Button size="sm" icon={<Check size={14} aria-hidden />} onClick={() => send("نعم")} data-testid="delivery-confirm">
                    {delivery.action.confirmLabel}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => send("إلغاء")} data-testid="delivery-cancel">
                    إلغاء
                  </Button>
                </SurfaceActions>
              ) : (
                <p role="status" className="mt-2 text-sm text-muted-foreground" data-testid="delivery-action-status" data-status={delivery.action.status}>
                  {ACTION_STATUS[delivery.action.status] ?? ""}
                </p>
              )}
            </>
          )}

          {view === "DELIVERY_OPTIONS" && order && (
            <ul className="mt-2 space-y-2" data-testid="delivery-options">
              {order.options.map((option) => (
                <li key={option.method} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 p-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{option.label}</p>
                    {!option.available && <p className="text-xs text-muted-foreground">{option.reason ?? "غير متاح"}</p>}
                  </div>
                  {option.available && order.canSelectMethod && send && METHOD_COMMANDS[option.method] ? (
                    <Button size="sm" variant="soft" onClick={() => send(METHOD_COMMANDS[option.method])} data-testid={`delivery-option-${option.method.toLowerCase()}`}>
                      اختيار
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground" data-testid={`delivery-option-${option.method.toLowerCase()}-state`}>
                      {option.available ? "متاح" : "غير متاح"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {(view === "DELIVERY_STATUS" || view === "PICKUP_DETAILS" || view === "LOCATION_CONFIRMED") && order && (
            <>
              <FactList
                rows={factRows([
                  ["الطريقة", status?.methodLabel ?? "لم تُختر بعد"],
                  ["الحالة", status ? `${status.statusLabel}${status.failureLabel ? ` — ${status.failureLabel}` : ""}` : "—"],
                  ["رسوم التوصيل", order.fee.note],
                ])}
              />
              {order.destination && <PlaceCard place={order.destination} testId="delivery-destination" />}
              {order.pickupPoint && <PlaceCard place={order.pickupPoint} testId="delivery-pickup-point" />}
              {order.serviceLocation && <PlaceCard place={order.serviceLocation} testId="delivery-service-location" />}
              {status?.method === "COURIER" && order.role === "BUYER" && (
                <div className="mt-3">
                  <CourierFareCard orderId={order.orderId} role="BUYER" active={active} />
                </div>
              )}
              {send && (
                <SurfaceActions>
                  {order.nextActions.map((action) =>
                    NEXT_ACTION_COMMANDS[action] ? (
                      <Button
                        key={action}
                        size="sm"
                        variant={action === "CANCELLED" || action === "FAILED" ? "ghost" : "soft"}
                        onClick={() => send(NEXT_ACTION_COMMANDS[action][1])}
                        data-testid={`delivery-next-${action.toLowerCase()}`}
                      >
                        {NEXT_ACTION_COMMANDS[action][0]}
                      </Button>
                    ) : null,
                  )}
                  {order.canChangeDestination && (
                    <Button size="sm" variant="secondary" onClick={() => send("غير موقع التسليم")} data-testid="delivery-change-destination">
                      {order.destination ? "تغيير موقع التسليم" : "مشاركة موقع التسليم"}
                    </Button>
                  )}
                  {order.canSetPickupPoint && (
                    <Button size="sm" variant="secondary" onClick={() => send("هذا موقع الاستلام")} data-testid="delivery-set-pickup">
                      {order.pickupPoint ? "تغيير نقطة الاستلام" : "تحديد نقطة الاستلام"}
                    </Button>
                  )}
                  {order.awaitingHandoff && order.role === "SELLER" && (
                    <Button size="sm" onClick={() => send("تم التوصيل")} data-testid="delivery-handoff">
                      تسجيل التسليم
                    </Button>
                  )}
                </SurfaceActions>
              )}
            </>
          )}
      </SurfacePanel>
    </section>
  );
}

/** Adjust a previewed point on the map; the adjusted point is submitted as MAP, not as a device reading. */
function AdjustOnMap({ requestId, onSend, start }: { requestId: string; onSend: Send; start: MapPoint }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <MapPicker requestId={requestId} onSend={onSend} start={start} onClose={() => setOpen(false)} />
  ) : (
    <SurfaceActions>
      <Button size="sm" variant="secondary" icon={<MapIcon size={14} aria-hidden />} onClick={() => setOpen(true)} data-testid="delivery-adjust-on-map">
        تعديل النقطة على الخريطة
      </Button>
    </SurfaceActions>
  );
}

/** Retry from a device preview: a new explicit tap reads once more and supersedes the preview. */
function ShareLocationButtonsRetry({ requestId, onSend }: { requestId: string; onSend: Send }) {
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState("");
  const retry = async () => {
    setReading(true);
    setProblem("");
    const result = await readDeviceLocationOnce();
    setReading(false);
    if (result.kind !== "OK") {
      setProblem(result.kind === "DENIED" ? "لم يُسمح بالوصول إلى الموقع، ولم يُرسل شيء." : "تعذر تحديد الموقع، ولم يُرسل شيء.");
      return;
    }
    onSend("مشاركة موقعي الحالي", {
      locationRequestId: requestId,
      location: { source: "DEVICE", latitude: result.latitude, longitude: result.longitude, accuracyMeters: result.accuracyMeters },
    });
  };
  return (
    <>
      {problem && (
        <p role="alert" className="mt-2 text-sm text-muted-foreground">
          {problem}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" loading={reading} icon={<RotateCcw size={14} aria-hidden />} onClick={() => void retry()} data-testid="delivery-retry-location">
          إعادة المحاولة
        </Button>
        <Button size="sm" variant="ghost" disabled={reading} icon={<PenLine size={14} aria-hidden />} onClick={() => onSend("اكتب العنوان يدويًا")}>
          اكتب العنوان يدويًا
        </Button>
      </div>
    </>
  );
}
