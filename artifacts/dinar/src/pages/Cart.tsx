import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ShoppingBag, Store, Trash2 } from "lucide-react";
import { useAccount } from "@/account/Account";
import { useCart } from "@/cart/CartContext";
import {
  AGREEMENT_REQUIRED_MESSAGE,
  formatMinorAmount,
  getCartTotalMinor,
  isQuantityCapped,
  parseAmountToMinor,
  type CartEntry,
} from "@/cart/cart-domain";
import { money, unitsLabel } from "@/lib/format";
import { fulfilment } from "@/lib/marketplace";
import { Button, ButtonLink, IconButton } from "@/ui/Button";
import { PriceDisplay, QuantitySelector } from "@/ui/Commerce";
import { EmptyState, InlineAlert, ErrorState, Skeleton } from "@/ui/Feedback";
import { PageHeader, Summary } from "@/ui/Layout";
import { Flag, SmartImage } from "@/ui/Media";
import { ConfirmDialog } from "@/ui/Sheet";

export const groupBySeller = (items: CartEntry[]) => {
  const groups = new Map<string, CartEntry[]>();
  for (const item of items) {
    const key = item.sellerId || item.sellerName;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([sellerId, lines]) => ({
    sellerId,
    sellerName: lines[0].sellerName,
    items: lines,
  }));
};

export const hasStockIssue = (items: CartEntry[]) =>
  items.some(
    (i) =>
      isQuantityCapped(i) &&
      (i.availableQuantity === null || i.availableQuantity < i.quantity),
  );

function CartLine({
  item,
  onError,
}: {
  item: CartEntry;
  onError: (m: string | null) => void;
}) {
  const cart = useCart();
  const lineTotal = formatMinorAmount(
    parseAmountToMinor(item.unitPrice, item.currency) * item.quantity,
    item.currency,
  );
  const max = item.requiresAgreement
    ? item.quantity
    : isQuantityCapped(item)
      ? Math.max(0, item.availableQuantity ?? 0)
      : null;
  const unavailable = max === 0;
  const short =
    isQuantityCapped(item) &&
    (item.availableQuantity === null || item.quantity > item.availableQuantity);
  return (
    <article
      data-testid={`row-cart-item-${item.listingId}`}
      className="flex gap-3 py-4 first:pt-1 last:pb-1"
    >
      <Link
        href={`/listings/${item.listingId}`}
        className="h-20 w-20 shrink-0 overflow-hidden rounded-md"
        tabIndex={-1}
        aria-hidden
      >
        <SmartImage src={item.imageUrl} alt="" fallbackIcon={ShoppingBag} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Link
              href={`/listings/${item.listingId}`}
              className="-my-2.5 line-clamp-2 py-2.5 text-base font-semibold leading-6 hover:underline"
              data-testid={`text-cart-title-${item.listingId}`}
            >
              {item.title}
            </Link>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {fulfilment(item.fulfilmentType).label}
            </p>
          </div>
          <IconButton
            label={`حذف ${item.title} من السلة`}
            size="sm"
            onClick={() => {
              onError(null);
              cart.remove(item.listingId);
            }}
            data-testid={`button-remove-${item.listingId}`}
            className="-me-1.5 -mt-1 hover:bg-destructive-soft hover:text-destructive"
          >
            <Trash2 size={17} />
          </IconButton>
        </div>
        <p
          className="num mt-1 text-xs text-muted-foreground"
          data-testid={`text-cart-unit-price-${item.listingId}`}
        >
          {money(item.unitPrice, item.currency)} × {item.quantity}
        </p>
        {item.agreedPrice && (
          <p
            className="mt-1 text-xs font-medium text-primary"
            data-testid={`status-cart-agreed-${item.listingId}`}
          >
            سعر متفق عليه مع البائع لك وحدك
            {item.listedUnitPrice &&
              ` (السعر المعلن ${money(item.listedUnitPrice, item.currency)})`}
          </p>
        )}
        {item.requiresAgreement && (
          <p
            className="mt-1 text-xs font-semibold text-destructive"
            data-testid={`status-cart-needs-agreement-${item.listingId}`}
          >
            {AGREEMENT_REQUIRED_MESSAGE} احذفه أو اتفق مع البائع من المحادثة.
          </p>
        )}
        {short && (
          <p
            className="mt-1 text-xs font-semibold text-destructive"
            data-testid={`status-cart-stock-${item.listingId}`}
          >
            {unavailable
              ? item.agreedPrice
                ? "لم تعد الكمية المتفق عليها متاحة — احذفه للمتابعة"
                : "نفدت الكمية — احذفه للمتابعة"
              : item.agreedPrice
                ? `السعر المتفق عليه يتيح لك ${item.availableQuantity} فقط`
                : `المتوفر الآن ${item.availableQuantity} فقط`}
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <QuantitySelector
            size="sm"
            value={item.quantity}
            max={max}
            disabled={unavailable}
            label={`كمية ${item.title}`}
            onChange={(n) => {
              const result = cart.setQuantity(item.listingId, n);
              onError(result.ok ? null : result.message);
            }}
            ids={{
              input: `input-quantity-${item.listingId}`,
              dec: `button-decrease-${item.listingId}`,
              inc: `button-increase-${item.listingId}`,
              group: `control-quantity-${item.listingId}`,
            }}
          />
          <PriceDisplay
            amount={lineTotal}
            currency={item.currency}
            size="sm"
            testId={`text-cart-line-total-${item.listingId}`}
          />
        </div>
      </div>
    </article>
  );
}

export default function CartPage() {
  const cart = useCart();
  const { market } = useAccount();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const groups = groupBySeller(cart.items);

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
      <div className="container-app max-w-3xl" data-testid="page-cart">
        <PageHeader title="السلة" back="/" />
        <EmptyState
          icon={ShoppingBag}
          title="سلتك فارغة"
          body="أضف عروضًا من السوق وستجدها هنا — مرتبة حسب البائع."
          action={
            <ButtonLink
              href="/"
              icon={<ArrowLeft size={17} className="order-last" />}
              data-testid="button-continue-shopping-empty"
            >
              اكتشف العروض
            </ButtonLink>
          }
          testId="state-cart-empty"
        />
      </div>
    );

  const currency = cart.items[0]?.currency ?? market?.currencyCode;
  if (!currency) throw new Error("لا توجد عملة للسوق الحالي.");
  // A line still awaiting a price agreement has no payable price, so it is not in the total.
  const total = formatMinorAmount(
    getCartTotalMinor(cart.items.filter((item) => !item.requiresAgreement)),
    currency,
  );
  const stockIssue = hasStockIssue(cart.items);
  const agreementIssue = cart.items.some((item) => item.requiresAgreement);

  return (
    <div className="container-app" data-testid="page-cart">
      <PageHeader
        title="السلة"
        back="/"
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <Flag code={market?.countryCode} size={16} /> سوق{" "}
            {market?.countryNameAr} · {unitsLabel(cart.unitCount)}
          </span>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={16} />}
            onClick={() => setConfirmClear(true)}
            data-testid="button-clear-cart"
          >
            إفراغ
          </Button>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        <div className="space-y-4" data-testid="list-cart-sellers">
          {groups.length > 1 && (
            <InlineAlert tone="info">
              سلتك من {groups.length} بائعين — سيُنشأ طلب منفصل لكل بائع.
            </InlineAlert>
          )}
          {groups.map((g) => (
            <section
              key={g.sellerId}
              data-testid={`section-seller-${g.sellerId}`}
              className="rounded-2xl border border-border/80 bg-card/95 shadow-xs"
            >
              <header className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Store
                  size={17}
                  className="text-muted-foreground"
                  aria-hidden
                />
                <h2
                  className="min-w-0 flex-1 truncate text-base font-bold"
                  data-testid={`text-seller-name-${g.sellerId}`}
                >
                  {g.sellerName}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {g.items.length === 1 ? "عرض واحد" : `${g.items.length} عروض`}
                </span>
              </header>
              <div className="divide-y divide-border px-4">
                {g.items.map((item) => (
                  <CartLine
                    key={item.listingId}
                    item={item}
                    onError={setError}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <aside
          className="lg:sticky lg:top-[calc(var(--topbar-h)+24px)]"
          data-testid="panel-cart-summary"
        >
          <div className="rounded-2xl border border-border/80 bg-card/95 p-4 shadow-xs md:p-5">
            <h2 className="mb-3 text-md font-bold">ملخص الطلب</h2>
            <Summary
              rows={[
                {
                  label: "عدد الوحدات",
                  value: (
                    <span className="num" data-testid="text-cart-item-count">
                      {cart.unitCount}
                    </span>
                  ),
                },
                {
                  label: "عدد الطلبات",
                  value: (
                    <span className="num" data-testid="text-cart-seller-count">
                      {groups.length}
                    </span>
                  ),
                },
                { label: "رسوم جاسم على المشتري", value: "لا يوجد" },
                { label: "الدفع والتسليم", value: "يُنسَّق مع البائع بعد القبول" },
                ...(agreementIssue
                  ? [{ label: "غير محتسب في الإجمالي", value: <span data-testid="text-cart-unpriced">عرض بانتظار الاتفاق على السعر</span> }]
                  : []),
                {
                  label: "الإجمالي",
                  value: (
                    <PriceDisplay
                      amount={total}
                      currency={currency}
                      size="lg"
                      testId="text-cart-total"
                    />
                  ),
                  strong: true,
                },
              ]}
            />
            {stockIssue && (
              <InlineAlert
                tone="danger"
                className="mt-4"
                testId="alert-cart-stock"
              >
                عدّل الكميات غير المتوفرة قبل المتابعة.
              </InlineAlert>
            )}
            {agreementIssue && (
              <InlineAlert
                tone="danger"
                className="mt-4"
                testId="alert-cart-agreement"
              >
                في سلتك عرض بسعر قابل للتفاوض لم تتفق عليه بعد. احذفه أو اتفق مع البائع قبل المتابعة.
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
                disabled={stockIssue || agreementIssue}
                onClick={() => navigate("/checkout")}
                data-testid="button-cart-checkout"
                className="flex-1"
              >
                متابعة لإتمام الطلب
              </Button>
            </div>
            <Link
              href="/"
              className="mt-3 hidden text-center text-sm font-semibold text-primary hover:underline md:block"
              data-testid="button-continue-shopping"
            >
              متابعة التسوق
            </Link>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="إفراغ السلة؟"
        body={`ستُحذف كل العروض (${unitsLabel(cart.unitCount)}) من سلة سوق ${market?.countryNameAr ?? ""}.`}
        confirmLabel="إفراغ السلة"
        tone="danger"
        icon={<Trash2 size={19} />}
        onConfirm={() => {
          cart.clear();
          setConfirmClear(false);
        }}
      />
    </div>
  );
}
