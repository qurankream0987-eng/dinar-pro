import { ReportButton } from "@/features/ReportButton";
import { OrderSettlementCard } from "@/features/ai/OrderSettlementCard";
import { DealClosurePanel } from "@/features/DealClosurePanel";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Ban,
  CircleCheckBig,
  Clock,
  Hourglass,
  MapPin,
  PackageCheck,
  ReceiptText,
  Scale,
  ShoppingBag,
  Truck,
} from "lucide-react";
import {
  getGetDashboardQueryKey,
  getGetOrderMessagesQueryKey,
  getGetOrderQueryKey,
  getGetOrdersQueryKey,
  getGetCourierFareQueryKey,
  getGetOrderFulfillmentQueryKey,
  useAcceptOrder,
  useCancelOrder,
  useConfirmOrder,
  useGetOrder,
  useGetCourierFare,
  useGetOrderFulfillment,
  useMarkOrderDelivered,
  type OrderItem,
} from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { formatMinorAmount } from "@/cart/cart-domain";
import { friendlyError } from "@/lib/errors";
import { longDate, money, orderRef, unitsLabel } from "@/lib/format";
import { fulfilment, orderStatus } from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { Button, ButtonLink } from "@/ui/Button";
import { Chip, Field, Input } from "@/ui/Field";
import {
  EmptyState,
  ErrorState,
  InlineAlert,
  Skeleton,
  StatusBadge,
} from "@/ui/Feedback";
import { BackButton, Card, CardTitle, Summary } from "@/ui/Layout";
import { Avatar, SmartImage } from "@/ui/Media";
import { ConfirmDialog } from "@/ui/Sheet";
import { roleIn, type OrderView } from "@/features/OrderCard";
import {
  DisputeSheet,
  OrderChat,
  OrderTimeline,
  parseIssue,
} from "@/features/OrderParts";

type Detail = OrderView & {
  deliveryInstructions?: string | null;
  items?: OrderItem[];
};

const PROOF_TYPES = {
  CODE: { label: "رمز أو مرجع التسليم", placeholder: "مثال: KWT-2048" },
  COURIER: { label: "رقم الشحنة", placeholder: "رقم تتبع شركة التوصيل" },
} as const;
type ProofType = keyof typeof PROOF_TYPES;

function proofLabel(raw?: string | null) {
  if (!raw) return null;
  const [type, ...rest] = raw.split(": ");
  const label =
    type === "COURIER"
      ? "رقم الشحنة"
      : type === "CODE"
        ? "مرجع التسليم"
        : "إثبات التسليم";
  return { label, value: rest.join(": ") || raw };
}

/** Show the immutable fee amounts stored on the order, not today's policy. */
function sellerFee(feeMinor: number, sellerAmountMinor: number, currency: string) {
  return {
    fee: formatMinorAmount(feeMinor, currency),
    net: formatMinorAmount(sellerAmountMinor, currency),
  };
}

function useMinutesLeft(iso?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - now) / 60000);
}

/** What must happen before the seller can record the hand-off, or null when it can be recorded now. */
function handoffPrerequisite(arrangement?: { method?: string; status?: string } | null): string | null {
  if (!arrangement?.status || !["REQUESTED", "ACCEPTED", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP"].includes(arrangement.status))
    return null;
  if (arrangement.method === "COURIER") return "يسجّل مندوب التوصيل المسند تسليم هذا الطلب.";
  if (arrangement.method === "PICKUP" && arrangement.status !== "READY_FOR_PICKUP")
    return "عندما يصبح الطلب جاهزًا اكتب «جاهز للاستلام» في المحادثة، ثم سجّل التسليم هنا.";
  if (arrangement.method === "SELLER_DELIVERY" && arrangement.status !== "OUT_FOR_DELIVERY")
    return "عند خروجك للتوصيل اكتب «خرج للتوصيل» في المحادثة، ثم سجّل التسليم هنا.";
  return null;
}

function CompletedBuyerReceipt({
  order,
  role,
}: {
  order: Detail;
  role: "buyer" | "seller" | "other";
}) {
  const visible = role === "buyer" && order.status === "COMPLETED";
  const delivery = useGetOrderFulfillment(order.id, {
    query: {
      queryKey: getGetOrderFulfillmentQueryKey(order.id),
      enabled: visible,
    },
  });
  const isCourier = delivery.data?.fulfillment?.method === "COURIER";
  const fare = useGetCourierFare(order.id, {
    query: {
      queryKey: getGetCourierFareQueryKey(order.id),
      enabled: visible && isCourier,
    },
  });
  if (!visible) return null;

  const items: OrderItem[] = order.items?.length
    ? order.items
    : [{
        listingId: order.listingId,
        listingTitle: order.listingTitle,
        listingImageUrl: order.listingImageUrl,
        quantity: order.quantity,
        unitPrice: order.unitPrice,
        total: order.total,
        currency: order.currency,
        fulfilmentType: order.fulfilmentType as OrderItem["fulfilmentType"],
      }];
  const method = delivery.data?.fulfillment?.method;
  const deliveryLabel =
    method === "COURIER"
      ? "مندوب"
      : method === "SELLER_DELIVERY"
        ? "توصيل البائع"
        : method === "PICKUP"
          ? "استلام من البائع"
          : method === "EXTERNAL_PROVIDER"
            ? "مزود توصيل خارجي"
            : delivery.isLoading
              ? "جارٍ التحقق من طريقة التسليم"
              : "غير مسجل";
  const courierFare =
    method !== "COURIER"
      ? "لا توجد أجرة مندوب"
      : fare.data?.agreement
        ? `${formatMinorAmount(fare.data.agreement.fareMinor, fare.data.currencyCode)} ${fare.data.currencyCode}`
        : fare.isLoading
          ? "جارٍ تحميل الأجرة المتفق عليها"
          : "الأجرة المتفق عليها غير متاحة في السجل";

  return (
    <Card testId="completed-order-receipt">
      <CardTitle>إيصال الطلب المكتمل</CardTitle>
      <p className="text-xs text-muted-foreground">
        رقم الطلب <span className="num" dir="ltr">{orderRef(order.id)}</span>
        {" · "}اكتمل {longDate(order.updatedAt)}
      </p>
      <ul className="mt-3 divide-y divide-border">
        {items.map((item) => (
          <li key={item.listingId} className="flex justify-between gap-3 py-2">
            <span className="min-w-0">
              {item.listingTitle} <span className="text-muted-foreground">× {item.quantity}</span>
            </span>
            <strong className="num shrink-0">{money(item.total, item.currency)}</strong>
          </li>
        ))}
      </ul>
      <Summary
        className="mt-2 border-t border-border pt-3"
        rows={[
          { label: "إجمالي الطلب", value: <strong className="num">{money(order.total, order.currency)}</strong>, strong: true },
          { label: "طريقة التسليم", value: deliveryLabel },
          { label: "أجرة المندوب المتفق عليها", value: courierFare },
        ]}
      />
      <p className="mt-3 text-xs text-muted-foreground">
        الأجرة منفصلة عن إجمالي مشترياتك، ولا تُضاف عمولة جاسم إلى فاتورتك. هذا الإيصال لا يثبت تحصيلًا أو تحويلًا ماليًا.
      </p>
    </Card>
  );
}

export default function OrderDetailsPage() {
  const { id = "" } = useParams<{ id: string }>();
  const order = useGetOrder(id, {
    query: {
      queryKey: getGetOrderQueryKey(id),
      enabled: !!id,
      refetchInterval: 20000,
    },
  });
  if (order.isLoading)
    return (
      <div
        className="container-app space-y-4 pt-6"
        aria-busy="true"
        aria-label="جارٍ تحميل الطلب"
      >
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-52 w-full rounded-xl" />
      </div>
    );
  if (order.isError || !order.data) {
    const status = (order.error as { status?: number } | null)?.status;
    return (
      <div className="container-app">
        {status === 404 ? (
          <EmptyState
            icon={ReceiptText}
            title="الطلب غير موجود"
            body="ربما الرابط غير صحيح، أو أن الطلب لا يخصك."
            action={<ButtonLink href="/orders">طلباتي</ButtonLink>}
          />
        ) : (
          <ErrorState onRetry={() => order.refetch()} />
        )}
      </div>
    );
  }
  return <OrderView order={order.data as Detail} />;
}

export function OrderInlineSurface({ orderId }: { orderId: string }) {
  const order = useGetOrder(orderId, {
    query: {
      queryKey: getGetOrderQueryKey(orderId),
      enabled: !!orderId,
      refetchInterval: 20000,
    },
  });
  if (order.isLoading)
    return <div className="p-4" aria-busy="true"><Skeleton className="h-8 w-48" /><Skeleton className="mt-3 h-40 w-full rounded-xl" /></div>;
  if (order.isError || !order.data)
    return <div className="p-4"><ErrorState onRetry={() => order.refetch()} /></div>;
  return <OrderView order={order.data as Detail} />;
}

function OrderView({ order }: { order: Detail }) {
  const { user } = useAccount();
  const qc = useQueryClient();
  const role = roleIn(order, user?.id);
  const status = orderStatus(order.status, role);
  const other = role === "seller" ? order.buyerName : order.sellerName;
  const otherAvatarObjectPath =
    role === "seller"
      ? order.buyerAvatarObjectPath
      : order.sellerAvatarObjectPath;
  const how = fulfilment(order.fulfilmentType);
  const items: OrderItem[] = order.items?.length
    ? order.items
    : [
        {
          listingId: order.listingId,
          listingTitle: order.listingTitle,
          listingImageUrl: order.listingImageUrl,
          quantity: order.quantity,
          unitPrice: order.unitPrice,
          total: order.total,
          currency: order.currency,
          fulfilmentType: order.fulfilmentType as OrderItem["fulfilmentType"],
        },
      ];
  const title =
    items.length === 1
      ? items[0].listingTitle
      : `${items.length} عروض من ${order.sellerName}`;

  const accept = useAcceptOrder();
  const delivered = useMarkOrderDelivered();
  const confirm = useConfirmOrder();
  const cancel = useCancelOrder();
  const [dialog, setDialog] = useState<null | "cancel" | "deliver" | "receive">(
    null,
  );
  const [dispute, setDispute] = useState(false);
  const [error, setError] = useState("");
  const [proofType, setProofType] = useState<ProofType>(
    order.fulfilmentType === "DELIVERY" ? "COURIER" : "CODE",
  );
  const [proof, setProof] = useState("");
  const minutesLeft = useMinutesLeft(order.expiresAt);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getGetOrderQueryKey(order.id) });
    void qc.invalidateQueries({
      queryKey: getGetOrderMessagesQueryKey(order.id),
    });
    void qc.invalidateQueries({ queryKey: getGetOrdersQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  };
  const run = <T,>(
    m: { mutate: (vars: T, opts: object) => void },
    vars: T,
    success: string,
    after?: () => void,
  ) => {
    setError("");
    m.mutate(vars, {
      onSuccess: () => {
        refresh();
        setDialog(null);
        after?.();
        toast.success(success);
      },
      onError: (e: unknown) => {
        setDialog(null);
        setError(friendlyError(e));
        refresh();
      },
    });
  };

  const OPEN = ["CREATED", "PAYMENT_PENDING", "PAID"].includes(order.status);
  const WORKING = ["ACCEPTED", "IN_PROGRESS"].includes(order.status);
  const DELIVERED = order.status === "SELLER_MARKED_DELIVERED";
  // With an active delivery arrangement the server records the hand-off only once it is ready
  // (lib/delivery.ts recordOrderHandoff); the card says what comes first instead of a refusal.
  const arrangement = useGetOrderFulfillment(order.id, {
    query: {
      queryKey: getGetOrderFulfillmentQueryKey(order.id),
      enabled: role === "seller" && WORKING,
    },
  }).data?.fulfillment;
  const handoffFirst = handoffPrerequisite(arrangement);
  const proofShown = proofLabel(order.deliveryProof);
  const issue = parseIssue(order.issue);

  /* ---------- "What you need to do now" ---------- */
  let action: ReactNode = null;
  if (role === "seller" && OPEN) {
    action = (
      <ActionCard
        tone="accent"
        icon={<ShoppingBag size={20} />}
        title="طلب جديد بانتظار موافقتك"
        testId="panel-next-action"
      >
        <p>
          {unitsLabel(order.quantity)} بإجمالي{" "}
          <b className="num">{money(order.total, order.currency)}</b>.{" "}
          <span data-testid="text-accept-fee-disclosure">
            عند اكتمال الطلب تُسجل عليك رسوم جاسم{" "}
            {((order.commissionRateBps ?? 1_000) / 100).toLocaleString("ar")}٪ (
            <b className="num">
              {money(
                (order.platformFeeMinor / 10 ** order.minorUnitScale).toFixed(
                  order.minorUnitScale,
                ),
                order.currency,
              )}
            </b>
            ).
          </span>
          {minutesLeft !== null &&
            (minutesLeft > 0 ? (
              <>
                {" "}
                اقبله خلال <b className="num">{minutesLeft}</b> دقيقة وإلا يُلغى
                تلقائيًا ويُعاد المخزون.
              </>
            ) : (
              " انتهت مهلة القبول."
            ))}
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button
            block
            loading={accept.isPending}
            onClick={() => run(accept, { id: order.id }, "تم قبول الطلب")}
            data-testid="button-accept-order"
          >
            قبول الطلب
          </Button>
          <Button
            block
            variant="secondary"
            onClick={() => setDialog("cancel")}
            data-testid="button-cancel-order"
          >
            رفض الطلب
          </Button>
        </div>
      </ActionCard>
    );
  } else if (role === "seller" && WORKING) {
    const pt = PROOF_TYPES[proofType];
    action = (
      <ActionCard
        tone="accent"
        icon={<Truck size={20} />}
        title="سلّم الطلب ثم أضف إثبات التسليم"
        testId="panel-next-action"
      >
        <p>{how.seller}</p>
        <div
          className="mt-4 flex flex-wrap gap-2"
          role="radiogroup"
          aria-label="نوع الإثبات"
        >
          {(Object.keys(PROOF_TYPES) as ProofType[]).map((k) => (
            <Chip
              key={k}
              active={proofType === k}
              onClick={() => setProofType(k)}
            >
              {PROOF_TYPES[k].label}
            </Chip>
          ))}
        </div>
        <Field
          label={pt.label}
          className="mt-3"
          hint="يراه المشتري قبل تأكيد الاستلام."
        >
          <Input
            value={proof}
            maxLength={200}
            onChange={(e) => setProof(e.target.value)}
            placeholder={pt.placeholder}
            data-testid="input-delivery-proof"
          />
        </Field>
        {handoffFirst && (
          <p className="mt-3 text-sm" role="status" data-testid="text-handoff-prerequisite">
            {handoffFirst}
          </p>
        )}
        <Button
          block
          className="mt-4"
          disabled={!proof.trim() || Boolean(handoffFirst)}
          onClick={() => setDialog("deliver")}
          icon={<PackageCheck size={18} />}
          data-testid="button-mark-delivered"
        >
          تأكيد التسليم
        </Button>
      </ActionCard>
    );
  } else if (role === "buyer" && DELIVERED) {
    action = (
      <ActionCard
        tone="accent"
        icon={<PackageCheck size={20} />}
        title="هل استلمت طلبك؟"
        testId="panel-next-action"
      >
        <p>
          أفاد {order.sellerName} بأنه سلّم الطلب. راجع الإثبات ثم أكّد
          الاستلام، أو أبلغ عن مشكلة.
        </p>
        {proofShown && (
          <div className="mt-3 rounded-md border border-border bg-card px-3.5 py-2.5">
            <p className="text-2xs text-muted-foreground">{proofShown.label}</p>
            <p
              className="font-semibold [overflow-wrap:anywhere]"
              data-testid="text-delivery-proof"
            >
              {proofShown.value}
            </p>
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button
            block
            onClick={() => setDialog("receive")}
            icon={<CircleCheckBig size={18} />}
            data-testid="button-confirm-receipt"
          >
            تأكيد الاستلام
          </Button>
          <Button
            block
            variant="secondary"
            onClick={() => setDispute(true)}
            data-testid="button-open-dispute"
          >
            الإبلاغ عن مشكلة
          </Button>
        </div>
      </ActionCard>
    );
  } else if (role === "buyer" && OPEN) {
    action = (
      <ActionCard
        tone="info"
        icon={<Hourglass size={20} />}
        title="بانتظار موافقة البائع"
      >
        <p>
          أرسلنا طلبك إلى {order.sellerName}.{" "}
          {minutesLeft !== null && minutesLeft > 0 && (
            <>
              إن لم يقبله خلال <b className="num">{minutesLeft}</b> دقيقة يُلغى
              تلقائيًا.
            </>
          )}
        </p>
        <Button
          variant="danger-soft"
          size="sm"
          className="mt-3"
          onClick={() => setDialog("cancel")}
          data-testid="button-cancel-order"
        >
          إلغاء الطلب
        </Button>
      </ActionCard>
    );
  } else if (role === "buyer" && WORKING) {
    action = (
      <ActionCard
        tone="info"
        icon={<Clock size={20} />}
        title="البائع يجهّز طلبك"
      >
        <p>{how.buyer} ستصلك رسالة هنا عند التسليم.</p>
      </ActionCard>
    );
  } else if (role === "seller" && DELIVERED) {
    action = (
      <ActionCard
        tone="info"
        icon={<Hourglass size={20} />}
        title="بانتظار تأكيد المشتري"
      >
        <p>سجّلت التسليم. يكتمل الطلب عندما يؤكد {order.buyerName} الاستلام.</p>
      </ActionCard>
    );
  } else if (order.status === "DISPUTED") {
    action = (
      <ActionCard
        tone="danger"
        icon={<Scale size={20} />}
        title="نزاع مفتوح"
        testId="panel-dispute"
      >
        <dl className="mt-1 space-y-2">
          {issue.reason && (
            <div>
              <dt className="text-2xs opacity-75">السبب</dt>
              <dd className="font-semibold">{issue.reason}</dd>
            </div>
          )}
          <div>
            <dt className="text-2xs opacity-75">الوصف</dt>
            <dd>{issue.details || "—"}</dd>
          </div>
          <div>
            <dt className="text-2xs opacity-75">الأدلة</dt>
            <dd>
              {[
                proofShown && `${proofShown.label}: ${proofShown.value}`,
                issue.evidence && `مرجع المشتري: ${issue.evidence}`,
              ]
                .filter(Boolean)
                .join(" · ") || "لا توجد أدلة مرفقة"}
            </dd>
          </div>
          <div>
            <dt className="text-2xs opacity-75">القرار</dt>
            <dd>
              لم يُحسم بعد. الطلب لا يُحتسب مكتملًا ولا تُسجل عليه رسوم. تابعا
              التفاصيل في المحادثة.
            </dd>
          </div>
        </dl>
      </ActionCard>
    );
  } else if (["COMPLETED", "BUYER_CONFIRMED"].includes(order.status)) {
    action = (
      <ActionCard
        tone="success"
        icon={<CircleCheckBig size={20} />}
        title="اكتمل الطلب"
      >
        <p>
          {role === "buyer"
            ? "أكدت الاستلام. شكرًا لتسوقك من جاسم."
            : "أكد المشتري الاستلام. سُجّلت رسوم جاسم ضمن مستحقاتك."}
        </p>
      </ActionCard>
    );
  } else if (order.status === "CANCELLED") {
    action = (
      <ActionCard tone="neutral" icon={<Ban size={20} />} title="الطلب ملغي">
        <p>{order.issue || "أُلغي الطلب قبل بدء التنفيذ."}</p>
      </ActionCard>
    );
  }

  const fee =
    role === "seller" &&
    Number.isSafeInteger(order.platformFeeMinor) &&
    Number.isSafeInteger(order.sellerAmountMinor)
      ? sellerFee(order.platformFeeMinor, order.sellerAmountMinor, order.currency)
      : null;
  const commissionPercent = (order.commissionRateBps ?? 1_000) / 100;

  return (
    <div className="container-app">
      <header className="flex items-start gap-3 pb-4 pt-5 md:pt-8">
        <BackButton to="/orders" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold md:text-2xl">
              طلب{" "}
              <span className="num" dir="ltr">
                {orderRef(order.id)}
              </span>
            </h1>
            <StatusBadge
              label={status.label}
              tone={status.tone}
              testId={`status-${order.status}`}
            />
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {role === "seller" ? "بيع إلى" : "شراء من"} {other} ·{" "}
            {longDate(order.createdAt)}
          </p>
        </div>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6">
        <div className="min-w-0 space-y-4">
          {action}
          <DealClosurePanel orderId={order.id} status={order.status} />
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
          <OrderSettlementCard orderId={order.id} role={role === "seller" ? "seller" : role === "buyer" ? "buyer" : null} />
          <OrderChat
            orderId={order.id}
            title={`المحادثة مع ${other}`}
            subtitle={`${title} · ${orderRef(order.id)}`}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <ReportButton targetType="ORDER" targetId={order.id} label="الإبلاغ عن سوء تعامل في الطلب" />
            {(role === "seller" ? order.buyerId : order.sellerId) && (
              <ReportButton
                targetType="USER"
                targetId={(role === "seller" ? order.buyerId : order.sellerId)!}
                label={role === "seller" ? "إبلاغ عن المشتري" : "إبلاغ عن البائع"}
              />
            )}
          </div>
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-[calc(var(--topbar-h)+24px)]">
          <Card>
            <CardTitle>ملخص الطلب</CardTitle>
            <ul className="space-y-3">
              {items.map((it) => (
                <li key={it.listingId} className="flex gap-3">
                  <Link
                    href={`/listings/${it.listingId}`}
                    className="h-14 w-14 shrink-0 overflow-hidden rounded-md"
                    tabIndex={-1}
                    aria-hidden
                  >
                    <SmartImage
                      src={it.listingImageUrl}
                      alt=""
                      fallbackIcon={ShoppingBag}
                    />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/listings/${it.listingId}`}
                      className="-my-2.5 line-clamp-2 py-2.5 text-base font-semibold hover:underline"
                    >
                      {it.listingTitle}
                    </Link>
                    <p className="num text-xs text-muted-foreground">
                      {money(it.unitPrice, it.currency)} × {it.quantity}
                    </p>
                  </div>
                  <span className="num text-base font-semibold">
                    {money(it.total, it.currency)}
                  </span>
                </li>
              ))}
            </ul>
            <Summary
              className="mt-4 border-t border-border pt-3 text-base"
              rows={[
                {
                  label: "الوحدات",
                  value: <span className="num">{order.quantity}</span>,
                },
                ...(fee
                  ? [
                      {
                        label: `رسوم جاسم (${commissionPercent}%)`,
                        value: (
                          <span className="num text-muted-foreground">
                            − {money(fee.fee, order.currency)}
                          </span>
                        ),
                      },
                      {
                        label: "صافي لك",
                        value: (
                          <span className="num">
                            {money(fee.net, order.currency)}
                          </span>
                        ),
                      },
                    ]
                  : []),
                {
                  label: role === "seller" ? "يدفع المشتري" : "الإجمالي",
                  value: (
                    <span className="num">
                      {money(order.total, order.currency)}
                    </span>
                  ),
                  strong: true,
                },
              ]}
            />
            {fee && (
              <p className="mt-2 text-2xs text-muted-foreground">
                تُستحق الرسوم فقط بعد اكتمال الطلب. لا تُضاف على المشتري.
              </p>
            )}
          </Card>

          <Card>
            <CardTitle>مراحل الطلب</CardTitle>
            <OrderTimeline
              status={order.status}
              createdAt={order.createdAt}
              updatedAt={order.updatedAt}
            />
          </Card>

          <Card>
            <div className="flex items-center gap-3">
              <Avatar
                name={other}
                src={
                  otherAvatarObjectPath
                    ? `/api/storage${otherAvatarObjectPath}`
                    : undefined
                }
                size={40}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  {role === "seller" ? "المشتري" : "البائع"}
                </p>
                <p className="truncate font-bold">{other}</p>
              </div>
            </div>
            <div className="mt-4 space-y-3 border-t border-border pt-4 text-base">
              <p className="flex items-start gap-2.5">
                <how.icon
                  size={18}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span>{how.label}</span>
              </p>
              {order.deliveryInstructions && (
                <div className="flex items-start gap-2.5">
                  <MapPin
                    size={18}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div>
                    <p className="text-xs text-muted-foreground">
                      تعليمات خاصة (تظهر للطرفين فقط)
                    </p>
                    <p className="whitespace-pre-line [overflow-wrap:anywhere]">
                      {order.deliveryInstructions}
                    </p>
                  </div>
                </div>
              )}
              {proofShown && !DELIVERED && (
                <p className={cn("flex items-start gap-2.5")}>
                  <PackageCheck
                    size={18}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span>
                    {proofShown.label}:{" "}
                    <b className="[overflow-wrap:anywhere]">
                      {proofShown.value}
                    </b>
                  </span>
                </p>
              )}
            </div>
          </Card>
        </aside>
      </div>

      <div className="mt-4">
        <CompletedBuyerReceipt order={order} role={role} />
      </div>

      <ConfirmDialog
        open={dialog === "cancel"}
        onOpenChange={(v) => !v && setDialog(null)}
        title={role === "seller" ? "رفض هذا الطلب؟" : "إلغاء الطلب؟"}
        body="يُلغى الطلب ويُعاد المخزون المحجوز. لا يمكن التراجع عن ذلك."
        confirmLabel={role === "seller" ? "رفض الطلب" : "إلغاء الطلب"}
        cancelLabel="رجوع"
        tone="danger"
        icon={<Ban size={19} />}
        loading={cancel.isPending}
        onConfirm={() =>
          run(
            cancel,
            {
              id: order.id,
              data: {
                reason:
                  role === "seller" ? "رفض البائع الطلب" : "ألغى المشتري الطلب",
              },
            },
            "تم إلغاء الطلب",
          )
        }
      />
      <ConfirmDialog
        open={dialog === "deliver"}
        onOpenChange={(v) => !v && setDialog(null)}
        title="تأكيد تسليم الطلب؟"
        body={`سيُطلب من ${order.buyerName} تأكيد الاستلام. تأكد أن الطلب وصله فعلًا.`}
        confirmLabel="نعم، تم التسليم"
        icon={<PackageCheck size={19} />}
        loading={delivered.isPending}
        onConfirm={() =>
          run(
            delivered,
            { id: order.id, data: { proofType, proofToken: proof.trim() } },
            "تم تسجيل التسليم",
            () => setProof(""),
          )
        }
      />
      <ConfirmDialog
        open={dialog === "receive"}
        onOpenChange={(v) => !v && setDialog(null)}
        title="هل استلمت الطلب بالفعل؟"
        body="بعد التأكيد سيتم اعتبار الطلب مكتملًا، ولن تتمكن من فتح نزاع عليه."
        confirmLabel="نعم، استلمته"
        cancelLabel="ليس بعد"
        icon={<CircleCheckBig size={19} />}
        loading={confirm.isPending}
        onConfirm={() =>
          run(
            confirm,
            { id: order.id, data: { received: true, issue: null } },
            "تم تأكيد الاستلام — اكتمل الطلب",
          )
        }
      />
      <DisputeSheet
        open={dispute}
        onOpenChange={setDispute}
        pending={confirm.isPending}
        error={error}
        onSubmit={(disputeData) =>
          run(
            confirm,
            { id: order.id, data: { received: false, dispute: disputeData } },
            "تم إرسال البلاغ",
            () => setDispute(false),
          )
        }
      />
    </div>
  );
}

function ActionCard({
  tone,
  icon,
  title,
  children,
  testId,
}: {
  tone: "accent" | "info" | "success" | "danger" | "neutral";
  icon: ReactNode;
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  const tones = {
    accent: "border-accent/60 bg-accent-soft/70",
    info: "border-info/25 bg-info-soft/70",
    success: "border-success/25 bg-success-soft/70",
    danger: "border-destructive/25 bg-destructive-soft/70",
    neutral: "border-border bg-muted/70",
  };
  const iconTones = {
    accent: "bg-accent text-accent-foreground",
    info: "bg-info text-white dark:text-background",
    success: "bg-success text-white dark:text-background",
    danger: "bg-destructive text-white dark:text-background",
    neutral: "bg-border-strong text-foreground",
  };
  return (
    <section
      data-testid={testId}
      className={cn("rounded-xl border p-4 md:p-5", tones[tone])}
      aria-labelledby={`${testId ?? "action"}-title`}
    >
      {tone === "accent" && (
        <p className="mb-2 text-2xs font-bold tracking-wide text-accent-ink">
          المطلوب منك الآن
        </p>
      )}
      <div className="flex gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
            iconTones[tone],
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1 text-base leading-7 text-text-secondary">
          <h2
            id={`${testId ?? "action"}-title`}
            className="mb-0.5 text-md font-bold text-foreground"
          >
            {title}
          </h2>
          {children}
        </div>
      </div>
    </section>
  );
}
