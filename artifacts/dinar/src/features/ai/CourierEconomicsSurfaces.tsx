import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCourierCommissionAccountQueryKey,
  getGetCourierFareQueryKey,
  useConfirmCourierFare,
  useGetCourierCommissionAccount,
  useGetCourierFare,
  useProposeCourierFare,
  useSettleCourierCommissionSimulation,
} from "@workspace/api-client-react";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { Field, Input } from "@/ui/Field";

type FareRole = "BUYER" | "COURIER";

const messageFor = (error: unknown) =>
  friendlyError(error, "تعذر تنفيذ الطلب؛ أعد المحاولة.");

function newIdempotencyKey() {
  return crypto.randomUUID();
}

export function CourierFareCard({
  orderId,
  role,
  active,
}: {
  orderId: string;
  role: FareRole;
  active: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useGetCourierFare(orderId, {
    query: {
      queryKey: getGetCourierFareQueryKey(orderId),
      staleTime: 0,
      refetchOnMount: "always",
      refetchInterval: 15_000,
    },
  });
  const propose = useProposeCourierFare();
  const confirm = useConfirmCourierFare();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const busy = propose.isPending || confirm.isPending;
  const refreshFare = () =>
    queryClient.invalidateQueries({ queryKey: getGetCourierFareQueryKey(orderId) });

  const submitProposal = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    propose.mutate(
      {
        id: orderId,
        data: { amount: amount.trim(), idempotencyKey: newIdempotencyKey() },
      },
      {
        onSuccess: () => {
          setAmount("");
          void refreshFare();
        },
        onError: (cause) => setError(messageFor(cause)),
      },
    );
  };

  if (query.isPending && !query.data) {
    return (
      <div className="rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground" role="status" aria-busy="true">
        تحميل أجرة التوصيل…
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground" role="alert">
        <p>تعذر تحميل أجرة التوصيل لهذا الطلب.</p>
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>إعادة المحاولة</Button>
      </div>
    );
  }

  const fare = query.data;
  const proposal = fare.proposal;
  const agreement = fare.agreement;
  const currentConfirmed =
    role === "BUYER" ? proposal?.buyerConfirmed : proposal?.courierConfirmed;
  const otherConfirmed =
    role === "BUYER" ? proposal?.courierConfirmed : proposal?.buyerConfirmed;
  const presentationState = agreement ? "AGREED" : proposal?.buyerConfirmed && !proposal.courierConfirmed ? "AWAITING_COURIER_CONFIRMATION" : proposal?.courierConfirmed && !proposal.buyerConfirmed ? "AWAITING_BUYER_CONFIRMATION" : proposal ? "PROPOSED" : fare.status;
  const nextConfirmation = proposal?.buyerConfirmed && !proposal.courierConfirmed ? "بانتظار تأكيد المندوب" : proposal?.courierConfirmed && !proposal.buyerConfirmed ? "بانتظار تأكيد المشتري" : "بانتظار تأكيد المشتري والمندوب";

  return (
    <section
      className="min-w-0 rounded-xl border border-border bg-card p-3.5 shadow-xs [overflow-wrap:anywhere]"
      dir="rtl"
      aria-label="أجرة مندوب التوصيل"
      data-testid="courier-fare-card"
      data-status={fare.status}
      data-confirmation-state={presentationState}
    >
      <h3 className="font-semibold">أجرة مندوب التوصيل</h3>
      <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm font-semibold" role="status" data-testid="courier-fare-status">
        {agreement ? "أجرة متفق عليها — أكدها الطرفان" : proposal ? nextConfirmation : fare.status === "RELEASED" ? "انتهى إسناد المندوب" : "لم تُثبت أجرة بعد"}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        العملة: <span dir="ltr">{fare.currencyCode}</span>. تُثبت الأجرة بعد تأكيد المشتري والمندوب.
      </p>

      {fare.status === "WAITING_FOR_COURIER" && (
        <p className="mt-2 text-sm" role="status">
          بانتظار إسناد مندوب. يبدأ التفاوض على الأجرة بعد قبول المهمة.
        </p>
      )}

      {proposal && !agreement && (
        <div className="mt-3 rounded-lg bg-muted/50 p-2.5" data-testid="courier-fare-proposal">
          <p>
            {proposal.proposedByMe ? "الأجرة التي اقترحتها:" : "الأجرة المقترحة من الطرف الآخر:"}{" "}
            <strong className="num block text-xl" dir="ltr">
              {proposal.amount} {proposal.currencyCode}
            </strong>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            تأكيد المشتري: {proposal.buyerConfirmed ? "تم" : "مطلوب"} · تأكيد المندوب: {proposal.courierConfirmed ? "تم" : "مطلوب"}
          </p>
          {active && proposal.canConfirm && !currentConfirmed && (
            <Button
              className="mt-2"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError("");
                confirm.mutate(
                  { id: orderId, data: { proposalId: proposal.id } },
                  {
                    onSuccess: () => void refreshFare(),
                    onError: (cause) => setError(messageFor(cause)),
                  },
                );
              }}
              data-testid="courier-fare-confirm"
            >
              أؤكد هذه الأجرة
            </Button>
          )}
          {currentConfirmed && !otherConfirmed && (
            <p className="mt-2 text-sm text-muted-foreground" role="status">
              وصل تأكيدك؛ ننتظر تأكيد الطرف الآخر.
            </p>
          )}
        </div>
      )}

      {agreement && (
        <div className="mt-3 rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-2.5" data-testid="courier-fare-agreement">
          <p>
            الأجرة المتفق عليها:{" "}
            <strong className="num block text-2xl text-primary" dir="ltr">
              {agreement.amount} {agreement.currencyCode}
            </strong>
          </p>
          {role === "COURIER" ? (
            <p className="mt-1 text-sm">
              عمولة جاسم المتوقعة عليك عند التسليم الناجح:{" "}
              <strong className="num" dir="ltr">
                {agreement.estimatedCommission} {agreement.currencyCode}
              </strong>{" "}
              (10%).
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              لا تُخصم عمولة التوصيل من المشتري أو البائع.
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            مثبتة في سجل الطلب؛ لا يمكن تغييرها. لا تنتقل أموال حقيقية عبر هذه المحاكاة.
          </p>
        </div>
      )}

      {!agreement && fare.status !== "WAITING_FOR_COURIER" && fare.status !== "RELEASED" && active && (
        <form className="mt-3 grid gap-2" onSubmit={submitProposal} noValidate>
          <Field
            label={`اقترح أجرة (${fare.currencyCode})`}
            error={error || null}
            hint={`أدخل مبلغًا موجبًا حتى ${fare.minorUnitScale} منازل عشرية. أي عرض جديد يستبدل العرض السابق.`}
          >
            <Input
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setError("");
              }}
              inputMode="decimal"
              autoComplete="off"
              maxLength={32}
              dir="ltr"
              data-testid="courier-fare-amount"
            />
          </Field>
          <div>
            <Button type="submit" size="sm" disabled={busy || amount.trim().length === 0} data-testid="courier-fare-propose">
              {proposal ? "إرسال عرض مقابل" : "اقتراح أجرة"}
            </Button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
    </section>
  );
}

export function CourierCommissionPanel({ active, activeMarketId }: { active: boolean; activeMarketId?: string }) {
  const queryClient = useQueryClient();
  const query = useGetCourierCommissionAccount({
    query: {
      queryKey: getGetCourierCommissionAccountQueryKey(),
      enabled: active,
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
    },
  });
  const settle = useSettleCourierCommissionSimulation();
  const [error, setError] = useState("");
  const refreshAccount = () =>
    queryClient.invalidateQueries({ queryKey: getGetCourierCommissionAccountQueryKey() });

  if (query.isPending && !query.data) {
    return <section className="mt-3 rounded-xl border border-border bg-card p-3.5 text-sm" data-testid="courier-earnings-history" aria-label="سجل أرباح التوصيل"><p role="status" aria-busy="true">تحميل سجل التوصيلات المكتملة…</p></section>;
  }
  if (query.isError || !query.data) {
    return <section className="mt-3 space-y-2 rounded-xl border border-border bg-card p-3.5 text-sm text-muted-foreground" role="alert" data-testid="courier-earnings-history" aria-label="سجل أرباح التوصيل"><p>تعذر تحميل رصيد عمولة التوصيل.</p><Button size="sm" variant="secondary" onClick={() => void query.refetch()}>إعادة المحاولة</Button></section>;
  }

  const account = query.data;
  return (
    <section
      className="mt-3 min-w-0 rounded-xl border border-border bg-card p-3.5 text-sm [overflow-wrap:anywhere]"
      dir="rtl"
      aria-label="عمولات مندوب جاسم"
      data-testid="courier-commission-account"
    >
      <h3 className="font-semibold">مستحقات دينار</h3>
      <p className="mt-2 font-medium" data-testid="courier-unsettled-count">
        التوصيلات غير المسددة: <bdi className="num whitespace-nowrap" dir="ltr">{account.outstandingDeliveryCount} / {account.holdThreshold}</bdi>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        كل سوق وعملة معروضان منفصلين. التسوية هنا محاكاة اختبارية فقط ولا تنقل أموالًا.
      </p>
      {account.hold && (
        <p className="mt-2 rounded-lg border border-amber-600/30 bg-amber-600/5 p-2" role="status" data-testid="courier-commission-hold">
          تم إيقاف استقبال توصيلات جديدة مؤقتًا حتى سداد المستحقات. حد التوصيلات غير المسددة {account.holdThreshold}؛ تبقى الرحلات الحالية والسجل والدعم متاحة.
        </p>
      )}
      {account.balances.length === 0 ? (
        <p className="mt-2 text-muted-foreground">لا توجد عمولات مستحقة.</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {account.balances.map((balance) => (
            <li
              key={`${balance.marketId}:${balance.currencyCode}:${balance.minorUnitScale}`}
              className="rounded-lg bg-muted/50 p-2.5"
              data-testid={`courier-commission-balance-${balance.marketId}`}
            >
              <p>
                السوق <span className="font-mono text-xs">{balance.marketId}</span>
                {" · "}
                <strong className="num" dir="ltr">{balance.amount} {balance.currencyCode}</strong>
                <span className="text-xs text-muted-foreground"> · دقة {balance.minorUnitScale}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {balance.deliveryCount} عملية مكتملة غير مسددة
              </p>
              {active && balance.marketId === activeMarketId ? (
                <Button
                  className="mt-2"
                  size="sm"
                  variant="secondary"
                  disabled={settle.isPending}
                  onClick={() => {
                    setError("");
                    settle.mutate(
                      {
                        data: {
                          marketId: balance.marketId,
                          currencyCode: balance.currencyCode,
                          idempotencyKey: newIdempotencyKey(),
                        },
                      },
                      {
                        onSuccess: () => void refreshAccount(),
                        onError: (cause) => setError(messageFor(cause)),
                      },
                    );
                  }}
                  data-testid={`courier-commission-settle-${balance.marketId}-${balance.currencyCode}`}
                >
                  تسجيل تسوية تجريبية
                </Button>
              ) : active ? (
                <p className="mt-2 text-xs text-muted-foreground" data-testid={`courier-commission-market-inactive-${balance.marketId}`}>
                  لا تُتاح التسوية إلا للسوق النشط والمصرح به؛ لا تغيّر هذه الشاشة صلاحية التسوية.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <section className="mt-4 border-t border-border pt-3" aria-label="سجل أرباح التوصيل" data-testid="courier-earnings-history">
        <h4 className="font-semibold">سجل التوصيلات المكتملة</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          الحصة المحاسبية لا تثبت تحصيل أجرة أو تحويلها. لا تُجمع العملات المختلفة.
        </p>
        {account.earningsHistory.length === 0 ? (
          <p className="mt-2 text-muted-foreground" data-testid="courier-earnings-empty">
            لا توجد توصيلات مكتملة بمستحقات مسجلة بعد.
          </p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {account.earningsHistory.map((earning) => (
              <li
                key={earning.orderId}
                className="rounded-lg border border-border bg-background p-3"
                data-testid={`courier-earning-${earning.orderId}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <strong>طلب #{earning.orderReference}</strong>
                  <time className="text-xs text-muted-foreground" dateTime={earning.completedAt}>
                    {new Intl.DateTimeFormat("ar", { dateStyle: "medium" }).format(new Date(earning.completedAt))}
                  </time>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  السوق {earning.marketId} · الدقة {earning.minorUnitScale}
                </p>
                <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
                  <dt>الأجرة المتفق عليها</dt>
                  <dd className="num" dir="ltr">{earning.agreedFare} {earning.currencyCode}</dd>
                  <dt>عمولة جاسم (10%)</dt>
                  <dd className="num" dir="ltr">{earning.commission} {earning.currencyCode}</dd>
                  <dt>الحصة المحاسبية للمندوب</dt>
                  <dd className="num font-semibold" dir="ltr">{earning.courierShare} {earning.currencyCode}</dd>
                </dl>
                <p className="mt-2 text-xs" role="status">
                  {earning.receivableStatus === "SIMULATION_CLEARED"
                    ? `مُسجّل كتسوية محاكاة${earning.simulationClearedAt ? ` · ${new Intl.DateTimeFormat("ar", { dateStyle: "medium" }).format(new Date(earning.simulationClearedAt))}` : ""}؛ الدفع الحقيقي غير متحقق.`
                    : "العمولة مستحقة وغير مسوّاة."}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
    </section>
  );
}
