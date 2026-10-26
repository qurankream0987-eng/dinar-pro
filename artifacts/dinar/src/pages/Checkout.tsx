import { useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Banknote, Clock, ShoppingBag, Store } from "lucide-react";
import {
  getGetDashboardQueryKey,
  getGetOrdersQueryKey,
  useCheckoutCart,
  type CheckoutConflict,
} from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { useCart } from "@/cart/CartContext";
import {
  formatMinorAmount,
  getCartTotalMinor,
  parseAmountToMinor,
} from "@/cart/cart-domain";
import { friendlyError } from "@/lib/errors";
import { money, unitsLabel } from "@/lib/format";
import { fulfilment, type Fulfilment } from "@/lib/marketplace";
import { Button, ButtonLink } from "@/ui/Button";
import { PriceDisplay } from "@/ui/Commerce";
import { EmptyState, InlineAlert, ErrorState, Skeleton } from "@/ui/Feedback";
import { Checkbox, Field, Textarea } from "@/ui/Field";
import { PageHeader, Summary } from "@/ui/Layout";
import { SmartImage } from "@/ui/Media";
import { groupBySeller, hasStockIssue } from "./Cart";

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 md:p-5">
      <h2 className="mb-3 flex items-center gap-2.5 text-md font-bold">
        <span className="num flex h-7 w-7 items-center justify-center rounded-full bg-primary-soft text-sm text-primary-soft-foreground">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function CheckoutPage() {
  const cart = useCart();
  const { market } = useAccount();
  const checkout = useCheckoutCart();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [instructions, setInstructions] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);

  if (cart.error)
    return (
      <div className="container-app">
        <ErrorState title="تعذر تحميل أو حفظ السلة" onRetry={cart.retry} />
      </div>
    );
  if (cart.loading)
    return (
      <div className="container-app space-y-3 pt-6" aria-busy="true">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );

  if (cart.items.length === 0)
    return (
      <div className="container-app max-w-3xl">
        <PageHeader title="إتمام الطلب" back="/cart" />
        <EmptyState
          icon={ShoppingBag}
          title="لا يوجد ما نتمّه"
          body="سلتك فارغة. أضف عروضًا ثم عد إلى هنا."
          action={<ButtonLink href="/">اكتشف العروض</ButtonLink>}
        />
      </div>
    );

  const groups = groupBySeller(cart.items);
  const currency = cart.items[0]?.currency;
  if (!currency) throw new Error("لا توجد عملة للسوق الحالي.");
  const total = formatMinorAmount(getCartTotalMinor(cart.items), currency);
  const types = [
    ...new Set(cart.items.map((i) => i.fulfilmentType)),
  ] as Fulfilment[];
  const needsInstructions = types.some(
    (t) => t === "DELIVERY" || t === "SERVICE",
  );
  const hasReservation = cart.items.some((i) => i.inventoryMode === "LIMITED");
  const needsAgreement = cart.items.some((i) => i.requiresAgreement);
  const blocked = hasStockIssue(cart.items) || needsAgreement;

  const placeOrder = () => {
    if (!agreed) {
      setError("راجع الطلب ووافق على المتابعة أولًا.");
      return;
    }
    setError(null);
    requestKey.current ??= window.crypto.randomUUID();
    checkout.mutate(
      {
        data: {
          idempotencyKey: requestKey.current,
          deliveryInstructions: needsInstructions ? instructions.trim() : "",
          items: cart.items.map(({ listingId, quantity, fulfilmentType }) => ({
            listingId,
            quantity,
            fulfilmentType: fulfilmentType as Fulfilment,
          })),
        },
      },
      {
        onSuccess: (res) => {
          requestKey.current = null;
          cart.clear();
          void qc.invalidateQueries({ queryKey: getGetOrdersQueryKey() });
          void qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
          const n = res?.orders?.length ?? groups.length;
          toast.success(
            n > 1 ? `تم إنشاء ${n} طلبات — طلب لكل بائع` : "تم إنشاء طلبك",
            {
              description: "سنرسل لك تحديثات داخل الطلب.",
            },
          );
          navigate("/orders");
        },
        onError: (err) => {
          const apiError = err as Error & {
            status?: number;
            data?: CheckoutConflict;
          };
          const conflict = apiError.data;
          if (apiError.status === 409 && conflict?.issues) {
            for (const issue of conflict.issues)
              if (
                issue.code === "OUT_OF_STOCK" &&
                issue.availableQuantity !== undefined
              )
                cart.updateAvailability(
                  issue.listingId,
                  issue.availableQuantity,
                );
            setError(
              conflict.issues.map((i) => i.message).join(" ") ||
                friendlyError(err),
            );
            return;
          }
          setError(friendlyError(err, "تعذر إنشاء الطلبات. حاول مرة أخرى."));
        },
      },
    );
  };

  return (
    <div className="container-app">
      <PageHeader
        title="إتمام الطلب"
        back="/cart"
        subtitle={`سوق ${market?.countryNameAr ?? ""} · ${unitsLabel(cart.unitCount)}`}
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        <div className="space-y-4">
          <Step n={1} title="الطلب">
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.sellerId}>
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-secondary">
                    <Store size={15} aria-hidden /> {g.sellerName}
                  </p>
                  <ul className="space-y-2">
                    {g.items.map((i) => (
                      <li key={i.listingId} className="flex items-center gap-3">
                        <span className="h-12 w-12 shrink-0 overflow-hidden rounded-sm">
                          <SmartImage
                            src={i.imageUrl}
                            alt=""
                            fallbackIcon={ShoppingBag}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-1 text-base font-medium">
                            {i.title}
                          </span>
                          <span className="num text-xs text-muted-foreground">
                            {money(i.unitPrice, i.currency)} × {i.quantity}
                          </span>
                        </span>
                        <span className="num text-base font-semibold">
                          {money(
                            formatMinorAmount(
                              parseAmountToMinor(i.unitPrice, i.currency) *
                                i.quantity,
                              i.currency,
                            ),
                            i.currency,
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {groups.length > 1 && (
                <p className="text-xs text-muted-foreground">
                  سيُنشأ طلب منفصل لكل بائع، ولكل طلب محادثته الخاصة.
                </p>
              )}
            </div>
          </Step>

          <Step n={2} title="التنفيذ">
            <ul className="space-y-3">
              {types.map((t) => {
                const f = fulfilment(t);
                const Icon = f.icon;
                return (
                  <li key={t} className="flex gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-soft-foreground">
                      <Icon size={19} aria-hidden />
                    </span>
                    <span>
                      <span className="block text-base font-semibold">
                        {f.label}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {f.buyer}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Step>

          {needsInstructions && (
            <Step n={3} title="الموقع والتنسيق">
              <Field
                label="تعليمات التوصيل أو الخدمة"
                optional
                hint={`تظهر للبائع فقط داخل الطلب. ${instructions.length}/1000`}
              >
                <Textarea
                  maxLength={1000}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="المدينة والمنطقة والوقت المناسب. شارك العنوان الدقيق فقط عند الحاجة."
                  data-testid="input-checkout-instructions"
                />
              </Field>
            </Step>
          )}

          <Step n={needsInstructions ? 4 : 3} title="الدفع">
            <div className="flex gap-3 rounded-lg border border-primary bg-primary-soft/50 p-4 ring-1 ring-primary">
              <Banknote
                size={22}
                className="mt-0.5 shrink-0 text-primary"
                aria-hidden
              />
              <div>
                <p className="text-base font-semibold">الدفع للبائع مباشرة</p>
                <p className="text-sm text-muted-foreground">
                  تدفع للبائع عند الاستلام أو التنفيذ. لا يوجد دفع إلكتروني داخل
                  بدينار حاليًا.
                </p>
              </div>
            </div>
          </Step>
        </div>

        <aside className="lg:sticky lg:top-[calc(var(--topbar-h)+24px)]">
          <div className="rounded-xl border border-border bg-card p-4 md:p-5">
            <h2 className="mb-3 text-md font-bold">المراجعة</h2>
            <Summary
              rows={[
                {
                  label: "الوحدات",
                  value: <span className="num">{cart.unitCount}</span>,
                },
                {
                  label: "الطلبات",
                  value: <span className="num">{groups.length}</span>,
                },
                { label: "رسوم بدينار على المشتري", value: "لا يوجد" },
                {
                  label: "الإجمالي",
                  value: (
                    <PriceDisplay
                      amount={total}
                      currency={currency}
                      size="lg"
                    />
                  ),
                  strong: true,
                },
              ]}
            />
            {hasReservation && (
              <p className="mt-4 flex gap-2 text-xs text-muted-foreground">
                <Clock size={15} className="shrink-0" aria-hidden />
                نحجز الكمية المحدودة لك حتى يقبل البائع الطلب خلال 30 دقيقة.
              </p>
            )}
            <div className="mt-4">
              <Checkbox
                checked={agreed}
                onChange={setAgreed}
                testId="checkbox-agree"
              >
                راجعت الطلب، وأعرف أن الدفع يتم مباشرة مع البائع.
              </Checkbox>
            </div>
            {blocked && (
              <InlineAlert tone="danger" className="mt-4">
                {needsAgreement
                  ? "في سلتك عرض بسعر قابل للتفاوض لم تتفق عليه بعد. احذفه من السلة أو اتفق مع البائع أولًا."
                  : "بعض الكميات لم تعد متوفرة. عدّلها في السلة."}
              </InlineAlert>
            )}
            {error && (
              <InlineAlert
                tone="danger"
                className="mt-4"
                testId="alert-cart-checkout-error"
              >
                {error}
              </InlineAlert>
            )}
            <div
              className="fixed inset-x-0 bottom-0 z-[var(--z-action-bar)] flex items-center gap-3 border-t border-border bg-card/95 px-[var(--gutter)] pt-3 backdrop-blur-xl md:static md:mt-5 md:block md:border-0 md:bg-transparent md:p-0"
              style={{ paddingBottom: "max(12px, var(--safe-bottom))" }}
            >
              <div className="md:hidden">
                <p className="text-2xs text-muted-foreground">الإجمالي</p>
                <PriceDisplay amount={total} currency={currency} size="md" />
              </div>
              <Button
                block
                size="lg"
                className="flex-1"
                disabled={blocked}
                loading={checkout.isPending}
                onClick={placeOrder}
                data-testid="button-cart-checkout"
              >
                {checkout.isPending ? "جارٍ إنشاء الطلب…" : "تأكيد الطلب"}
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
