import {
  getGetOrderTrackingQueryKey,
  useGetOrderTracking,
  type OrderTracking,
} from "@workspace/api-client-react";

type PersistedProgressEvent = {
  type: string;
  occurredAt: string;
  actorRole: string;
};

type OrderTrackingWithProgress = OrderTracking & {
  progress?: unknown;
};

const UNAVAILABLE_COPY: Record<string, string> = {
  NOT_BUYER: "التتبع متاح للمشتري فقط.",
  NOT_COURIER: "هذا الطلب لا يستخدم توصيل المندوب.",
  NOT_ACTIVE: "التسليم ليس في حالة تسمح بالتتبع المباشر الآن.",
  NO_DRIVER: "لم يُسجّل مندوب توصيل معتمد لهذا الطلب بعد.",
  NO_PROVIDER: "التتبع المباشر غير متاح؛ لم يُربط مزود تتبع بهذا الطلب.",
};

const EVENT_LABELS: Record<string, string> = {
  COURIER_ASSIGNED: "تم إسناد الطلب إلى المندوب",
  PICKED_UP: "استلم المندوب الطلب",
  OUT_FOR_DELIVERY: "بدأ التوصيل",
  ARRIVED: "وصل المندوب",
  HANDED_OFF: "سلّم المندوب الطلب",
  DELIVERED: "تم تسجيل التسليم",
  BUYER_RECEIVED: "أكد المشتري الاستلام",
  DELIVERY_FAILED: "تعذر إتمام التسليم",
  CANCELLED: "أُلغي التوصيل",
};

const ACTOR_LABELS: Record<string, string> = {
  BUYER: "المشتري",
  SELLER: "البائع",
  COURIER: "المندوب",
  SYSTEM: "النظام",
};

function isProgressEvent(value: unknown): value is PersistedProgressEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.type === "string" &&
    typeof event.occurredAt === "string" &&
    typeof event.actorRole === "string"
  );
}

function formatOccurredAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ar", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function getLiveTrackingMessage(tracking: OrderTracking["tracking"] | undefined) {
  if (!tracking) return "حالة التتبع غير متاحة الآن.";
  if (tracking.state === "UNAVAILABLE") {
    return UNAVAILABLE_COPY[tracking.reason] ?? "التتبع المباشر غير متاح لهذا الطلب.";
  }
  if (tracking.state === "STOPPED") {
    return "توقف التتبع المباشر بعد وصول الطلب إلى حالة نهائية.";
  }
  if (tracking.state === "STALE") {
    return "بيانات الموقع قديمة وليست مباشرة. لا تتوفر خريطة أو تقديرات وصول حالية.";
  }
  return "بيانات الموقع لا تُعرض في هذه المحادثة. لا تتوفر خريطة أو تقديرات وصول هنا.";
}

export default function OrderTrackingSurface({
  orderId,
}: {
  orderId: string;
}) {
  const tracking = useGetOrderTracking(orderId, {
    query: {
      queryKey: getGetOrderTrackingQueryKey(orderId),
      staleTime: 0,
      gcTime: 0,
      refetchInterval: (query) =>
        query.state.data?.tracking.state === "LIVE" ? 15_000 : false,
    },
  });

  const data = tracking.data as OrderTrackingWithProgress | undefined;
  const progress = Array.isArray(data?.progress)
    ? data.progress.filter(isProgressEvent)
    : [];

  return (
    <section
      className="mt-3 min-w-0 max-w-[960px] break-words rounded-xl border border-border bg-background p-4"
      aria-label="تتبع الطلب"
      data-testid={`order-tracking-${orderId}`}
      dir="rtl"
      aria-busy={tracking.isLoading || undefined}
    >
      <header className="min-w-0">
        <h3 className="font-semibold text-foreground">تتبع الطلب</h3>
        {data?.delivery ? (
          <p className="mt-1 text-sm text-muted-foreground" data-testid={`tracking-delivery-status-${orderId}`}>
            {data.delivery.methodLabel} · {data.delivery.statusLabel}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground" data-testid={`tracking-delivery-status-${orderId}`}>
            {tracking.isLoading
              ? "جارٍ تحميل تفاصيل التسليم…"
              : tracking.isError
                ? "تفاصيل التسليم غير متاحة الآن."
                : "حالة التسليم غير مسجلة لهذا الطلب."}
          </p>
        )}
      </header>

      {tracking.isLoading ? (
        <div className="mt-4 space-y-3" role="status" aria-label="جارٍ تحميل التتبع" data-testid="tracking-loading">
          <div className="skeleton h-4 w-2/5 rounded" />
          <div className="skeleton h-10 w-full rounded-lg" />
          <span className="sr-only">جارٍ تحميل أحداث الطلب…</span>
        </div>
      ) : tracking.isError ? (
        <div className="mt-3 rounded-lg border border-destructive/25 bg-destructive-soft p-3 text-sm" role="alert" data-testid="tracking-error">
          <p className="text-destructive">تعذر تحميل سجل التتبع الآن. لم تتغير حالة الطلب المحفوظة.</p>
          <button
            type="button"
            className="mt-2 min-h-11 rounded-md border border-border px-3 text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => void tracking.refetch()}
            data-testid="button-retry-order-tracking"
          >
            إعادة تحميل التتبع
          </button>
        </div>
      ) : (
        <>
          <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground" role="status" data-testid={`tracking-live-state-${orderId}`}>
            {getLiveTrackingMessage(data?.tracking)}
          </p>

          <div className="mt-4" data-testid={`tracking-progress-${orderId}`}>
            <h4 className="text-sm font-semibold text-foreground">سجل تقدم الطلب</h4>
            {progress.length === 0 ? (
              <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground" data-testid={`tracking-progress-empty-${orderId}`}>
                لا توجد أحداث محفوظة لهذا الطلب حتى الآن.
              </p>
            ) : (
              <ol className="mt-3 space-y-0" aria-label="الأحداث المحفوظة للطلب">
                {progress.map((event, index) => (
                  <li
                    key={`${event.type}-${event.occurredAt}-${event.actorRole}-${index}`}
                    className="group relative flex gap-3 pb-4 last:pb-0"
                    data-testid={`tracking-event-${orderId}-${index}`}
                  >
                    <span
                      aria-hidden="true"
                      className="relative mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background after:absolute after:top-3 after:h-[calc(100%+1rem)] after:w-px after:bg-border group-last:after:hidden"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">
                        {EVENT_LABELS[event.type] ?? event.type}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <time dateTime={event.occurredAt}>{formatOccurredAt(event.occurredAt)}</time>
                        <span aria-hidden="true"> · </span>
                        <span>{ACTOR_LABELS[event.actorRole] ?? event.actorRole}</span>
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  );
}
