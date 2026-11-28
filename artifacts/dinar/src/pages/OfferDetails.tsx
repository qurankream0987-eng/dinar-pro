import { ReportButton } from "@/features/ReportButton";
import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import {
  ArrowRight,
  Lock,
  MapPin,
  MessageCircle,
  PackageX,
  Pencil,
  Share2,
  ShoppingCart,
  Star,
  Zap,
} from "lucide-react";
import {
  getGetListingQueryKey,
  useGetListing,
  useGetMarketplaceCategories,
} from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { useCart } from "@/cart/CartContext";
import { formatMinorAmount, parseAmountToMinor } from "@/cart/cart-domain";
import { money, unitsLabel } from "@/lib/format";
import {
  categoryIcon,
  fulfilment,
  offerBuyerActions,
  offerDirectPurchase,
  offerPriceFallback,
  offerRepresentation,
  placeOf,
  stockOf,
  type Offer,
} from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { Button, ButtonLink, IconButton } from "@/ui/Button";
import { PriceDisplay, QuantitySelector } from "@/ui/Commerce";
import { Badge, ErrorState, EmptyState, Skeleton } from "@/ui/Feedback";
import { Avatar, SmartImage } from "@/ui/Media";

export default function OfferDetails({
  listingId,
  onBack,
  onSend,
}: { listingId?: string; onBack?: () => void; onSend?: (message: string) => void } = {}) {
  const params = useParams<{ id: string }>();
  const id = listingId ?? params.id ?? "";
  const listing = useGetListing(id, {
    query: { queryKey: getGetListingQueryKey(id), enabled: Boolean(id) },
  });
  if (listing.isLoading) return <OfferDetailsSkeleton />;
  if (listing.isError || !listing.data) {
    const status = (listing.error as { status?: number } | null)?.status;
    return (
      <div className="container-app">
        {status === 404 ? (
          <EmptyState
            icon={PackageX}
            title="هذا العرض غير متاح"
            body="ربما أُزيل، أو أنه في سوق آخر غير سوقك الحالي."
            action={<ButtonLink href="/search">تصفح العروض</ButtonLink>}
          />
        ) : (
          <ErrorState onRetry={() => listing.refetch()} />
        )}
      </div>
    );
  }
  return <OfferView offer={listing.data as Offer} onBack={onBack} onSend={onSend} />;
}

function OfferView({
  offer,
  onBack,
  onSend,
}: {
  offer: Offer;
  onBack?: () => void;
  /** Inside a conversation: the listing is in focus there, so negotiation commands go to it. */
  onSend?: (message: string) => void;
}) {
  const [, navigate] = useLocation();
  const { user } = useAccount();
  const categories = useGetMarketplaceCategories();
  const cart = useCart();
  const [quantity, setQuantity] = useState(1);
  const [photo, setPhoto] = useState(0);
  const images = [
    ...new Set(
      [
        offer.imageUrl,
        ...((offer as Offer & { imageUrls?: string[] }).imageUrls ?? []),
      ].filter(Boolean),
    ),
  ];
  const [notice, setNotice] = useState<string | null>(null);
  const stock = stockOf(offer);
  const how = fulfilment(offer.fulfilmentType);
  const HowIcon = how.icon;
  const place = placeOf(offer);
  const categorySchema =
    categories.data?.find(
      (category) =>
        category.id === offer.categoryId || category.label === offer.category,
    );
  const attributeRows = (
    categorySchema?.rules.display.detailAttributes ?? []
  ).flatMap((key) => {
    const value = offer.attributes?.[key];
    return typeof value === "string" || typeof value === "number"
      ? [{ key, label: categorySchema?.attributes[key]?.label ?? key, value }]
      : [];
  });
  // Same rule as checkout: only a definite asking price (FIXED) is bought directly; every listing
  // accepts a buyer's price proposal, and the seller decides.
  const requiresAgreement = !offerDirectPurchase(offer);
  const representation = offerRepresentation(offer);
  const out = stock.tone === "out";
  const own = !!user && offer.sellerId === user.id;
  const buyerActions = offerBuyerActions(offer, { isSeller: own, inStock: !out });
  const negotiateMessage = "قدّم عرض سعر";
  const total = requiresAgreement
    ? null
    : formatMinorAmount(
        parseAmountToMinor(offer.unitPrice!, offer.currency) * quantity,
        offer.currency,
      );

  const addToCart = () => {
    if (requiresAgreement) {
      setNotice("يلزم الاتفاق على السعر مع البائع؛ لا يمكن شراء هذا العرض مباشرة.");
      return false;
    }
    if (!user) {
      toast("سجّل الدخول لإضافة العروض إلى سلتك");
      navigate(`/login?next=${encodeURIComponent(`/listings/${offer.id}`)}`);
      return false;
    }
    const result = cart.add(
      {
        listingId: offer.id,
        title: offer.title,
        imageUrl: offer.imageUrl,
        sellerId: offer.sellerId ?? offer.sellerName,
        sellerName: offer.sellerName,
        unitPrice: offer.unitPrice!,
        currency: offer.currency,
        quantity,
        fulfilmentType: offer.fulfilmentType,
        inventoryMode: offer.inventoryMode,
        availableQuantity: stock.remaining,
      },
      quantity,
    );
    setNotice(result.ok ? null : result.message);
    return result.ok;
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: offer.title, url });
      else {
        await navigator.clipboard.writeText(url);
        toast.success("تم نسخ رابط العرض");
      }
    } catch {
      /* user dismissed the share sheet */
    }
  };

  return (
    <div className="container-app @container pt-0 md:pt-6">
      <nav
        aria-label="مسار التصفح"
        className="hidden items-center gap-1.5 pb-4 text-sm text-muted-foreground md:flex"
      >
        <Link href="/" className="hover:text-foreground">
          الرئيسية
        </Link>
        <span aria-hidden>/</span>
        <Link
          href={`/search?category=${encodeURIComponent(offer.category)}`}
          className="hover:text-foreground"
        >
          {offer.category}
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-foreground">{offer.title}</span>
      </nav>

      {/* Columns follow the space this detail actually has (a page, or a chat column beside panels). */}
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1fr)_400px] @4xl:gap-10">
        {/* Gallery */}
        <div className="relative -mx-[var(--gutter)] md:mx-0 @4xl:col-start-1 @4xl:row-start-1">
          <div className="aspect-square max-h-[560px] w-full overflow-hidden md:aspect-[4/3] md:rounded-[24px] md:border md:border-amber-400/25 md:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_20px_44px_-16px_rgba(0,0,0,0.32)]">
            <SmartImage
              src={images[photo] ?? offer.imageUrl}
              alt={offer.title}
              fallbackIcon={categoryIcon(offer.category)}
              eager
              testId="img-offer"
            />
          </div>
          {images.length > 1 && (
            <div
              className="flex gap-2 overflow-x-auto p-3"
              aria-label="صور العرض"
            >
              {images.map((src, i) => (
                <button
                  key={src}
                  type="button"
                  aria-label={`الصورة ${i + 1}`}
                  aria-pressed={photo === i}
                  onClick={() => setPhoto(i)}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 ${photo === i ? "border-primary" : "border-border"}`}
                >
                  <SmartImage src={src} alt={`الصورة ${i + 1}`} />
                </button>
              ))}
            </div>
          )}
          <div className="absolute inset-x-3 top-3 flex justify-between md:hidden">
            <IconButton
              label="رجوع"
              variant="solid"
              className="bg-card/90 text-foreground shadow-sm backdrop-blur hover:bg-card"
              onClick={() => {
                if (onBack) onBack();
                else if (window.history.length > 1) window.history.back();
                else navigate("/");
              }}
            >
              <ArrowRight size={20} />
            </IconButton>
            <IconButton
              label="مشاركة العرض"
              variant="solid"
              className="bg-card/90 text-foreground shadow-sm backdrop-blur hover:bg-card"
              onClick={share}
            >
              <Share2 size={19} />
            </IconButton>
          </div>
        </div>

        {/* Purchase column */}
        <aside className="@4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1">
          <div className="space-y-4 @4xl:sticky @4xl:top-[calc(var(--topbar-h)+24px)]">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral">{offer.category}</Badge>
                <Badge tone="primary" icon={<HowIcon size={12} aria-hidden />}>
                  {how.label}
                </Badge>
              </div>
              <div className="flex items-start gap-2">
                <h1 className="min-w-0 flex-1 text-2xl font-bold leading-snug text-foreground md:text-3xl">
                  {offer.title}
                </h1>
                <IconButton
                  label="مشاركة العرض"
                  variant="outline"
                  className="hidden md:inline-flex"
                  onClick={share}
                >
                  <Share2 size={18} />
                </IconButton>
              </div>
              {place && (
                <p className="mt-1.5 flex items-center gap-1 text-sm text-muted-foreground">
                  <MapPin size={15} aria-hidden /> {place}
                </p>
              )}
              {attributeRows.length > 0 && (
                <dl className="mt-4 grid grid-cols-2 gap-2">
                  {attributeRows.map((item) => (
                    <div
                      key={item.key}
                      className="rounded-lg border border-border bg-muted/40 px-3 py-2"
                    >
                      <dt className="text-xs text-muted-foreground">
                        {item.label}
                      </dt>
                      <dd className="mt-0.5 truncate text-sm font-medium">
                        {item.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            <div className="rounded-2xl border border-border/85 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_34px_-14px_rgba(0,0,0,0.22)] backdrop-blur-sm md:p-5">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {representation === "STARTING_FROM"
                      ? "يبدأ من — ليس سعرًا نهائيًا"
                      : representation === "OPEN_TO_OFFERS"
                        ? "سعر استرشادي"
                        : representation === "NEGOTIABLE"
                          ? "السعر المطلوب — قابل للتفاوض"
                          : "سعر الوحدة"}
                  </p>
                  {offer.unitPrice == null ? (
                    <p className="mt-1 text-lg font-bold text-foreground">
                      {offerPriceFallback(offer)}
                    </p>
                  ) : (
                    <PriceDisplay
                      amount={offer.unitPrice!}
                      currency={offer.currency}
                      size="xl"
                      className="mt-1"
                    />
                  )}
                </div>
                <span
                  data-testid="status-listing-inventory"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
                    stock.tone === "ok" && "bg-success-soft text-success",
                    stock.tone === "low" && "bg-warning-soft text-warning",
                    stock.tone === "out" &&
                      "bg-destructive-soft text-destructive",
                  )}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full bg-current"
                  />
                  {stock.remaining === null ? "متوفر" : stock.label}
                </span>
              </div>

              {!own && !out && !requiresAgreement && (
                <>
                  <div className="my-4 h-px bg-border" />
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-md font-semibold">الكمية</p>
                      <p className="text-xs text-muted-foreground">
                        {stock.remaining === null
                          ? "بدون حد أقصى"
                          : `الحد الأقصى ${stock.remaining}`}
                      </p>
                    </div>
                    <QuantitySelector
                      value={quantity}
                      onChange={(n) => {
                        setQuantity(n);
                        setNotice(null);
                      }}
                      max={stock.remaining}
                      label="الكمية"
                      ids={{
                        input: "input-listing-quantity-selector",
                        dec: "button-decrease-quantity",
                        inc: "button-increase-quantity",
                      }}
                    />
                  </div>
                  <div className="mt-4 flex items-center justify-between rounded-md bg-muted px-3.5 py-3">
                    <span className="num text-sm text-muted-foreground">
                      {money(offer.unitPrice!, offer.currency)} × {quantity}
                    </span>
                    <span className="flex items-baseline gap-2">
                      <span className="text-sm text-muted-foreground">
                        الإجمالي
                      </span>
                      <PriceDisplay
                        amount={total!}
                        currency={offer.currency}
                        size="lg"
                        testId="text-order-total"
                      />
                    </span>
                  </div>
                </>
              )}

              {notice && (
                <p
                  role="alert"
                  data-testid="status-cart-add"
                  className="mt-3 text-sm font-medium text-destructive"
                >
                  {notice}
                </p>
              )}

              {own ? (
                <div className="mt-4 space-y-2">
                  <p className="text-sm text-muted-foreground">
                    هذا عرضك. يظهر للمشترين في سوقك الحالي.
                  </p>
                  <ButtonLink
                    href={`/seller/offers/${offer.id}/edit`}
                    variant="secondary"
                    block
                    icon={<Pencil size={17} />}
                  >
                    تعديل العرض
                  </ButtonLink>
                </div>
              ) : out ? (
                <p className="mt-4 rounded-md bg-muted p-3 text-center text-sm font-semibold text-muted-foreground">
                  نفدت الكمية حاليًا. تحقق لاحقًا.
                </p>
              ) : requiresAgreement ? (
                <div
                  className="mt-4 rounded-md bg-muted p-3 text-center text-sm font-medium text-muted-foreground"
                  data-testid="status-requires-agreement"
                >
                  <p>
                    {representation === "STARTING_FROM"
                      ? "المبلغ المعروض سعر بداية وليس سعرًا نهائيًا. اتفق مع البائع على السعر قبل الشراء."
                      : representation === "QUOTE_REQUIRED"
                        ? "هذا الإعلان بالتسعيرة: اطلب تسعيرة، فيرسل البائع سعره لتقبله أو تفاوض عليه."
                        : "اتفق مع البائع على السعر قبل الشراء. هذا العرض غير متاح للسلة أو الشراء المباشر إلا بعد الاتفاق."}
                  </p>
                  <p className="mt-1 text-xs">
                    في المحادثة اكتب «اعرض على البائع …» بالمبلغ أو «اطلب تسعيرة»؛ بعد موافقة البائع
                    تشتريه بالسعر المتفق عليه.
                  </p>
                  {!own && onSend && (
                    <div className="mt-3 flex flex-wrap justify-center gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => onSend(buyerActions.includes("REQUEST_QUOTE") ? "اطلب تسعيرة" : "اطلب آخر سعر")}
                        data-testid="button-request-best-price"
                      >
                        {buyerActions.includes("REQUEST_QUOTE") ? "اطلب تسعيرة" : "اطلب آخر سعر من البائع"}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => onSend(negotiateMessage)}
                        data-testid="button-make-offer"
                      >
                        {buyerActions.includes("NEGOTIATE") ? "تفاوض مع البائع" : "قدّم عرض سعر"}
                      </Button>
                    </div>
                  )}
                  {!own && !onSend && (
                    <ButtonLink
                      href={`/ai?ask=${encodeURIComponent(`ابحث عن ${offer.title}`.slice(0, 160))}`}
                      variant="secondary"
                      className="mt-3"
                      data-testid="button-negotiate-in-chat"
                    >
                      تفاوض مع البائع في المحادثة
                    </ButtonLink>
                  )}
                </div>
              ) : (
                /* Mobile: fixed thumb-reach bar. Desktop: inline in this card. */
                <div
                  className="fixed inset-x-0 bottom-0 z-[var(--z-action-bar)] border-t border-border bg-card/95 px-[var(--gutter)] pt-3 backdrop-blur-xl md:static md:mt-4 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none"
                  style={{ paddingBottom: "max(12px, var(--safe-bottom))" }}
                >
                  <div className="mb-2 flex items-center justify-between text-sm md:hidden">
                    <span className="text-muted-foreground">
                      {unitsLabel(quantity)}
                    </span>
                    <span className="num font-bold">
                      {money(total!, offer.currency)}
                    </span>
                  </div>
                  <div className="flex gap-2 md:flex-col">
                    <Button
                      block
                      size="lg"
                      icon={<ShoppingCart size={19} />}
                      onClick={() => {
                        if (addToCart())
                          toast.success(
                            `أُضيفت ${unitsLabel(quantity)} إلى السلة`,
                            {
                              action: {
                                label: "عرض السلة",
                                onClick: () => navigate("/cart"),
                              },
                            },
                          );
                      }}
                      data-testid="button-add-to-cart"
                      className="md:order-first"
                    >
                      أضف للسلة
                    </Button>
                    <Button
                      block
                      size="lg"
                      variant="secondary"
                      icon={<Zap size={18} />}
                      onClick={() => {
                        if (addToCart()) navigate("/checkout");
                      }}
                      data-testid="button-create-order"
                    >
                      شراء بالسعر المعروض
                    </Button>
                  </div>
                  {/* Universal negotiation: a definite price can still be proposed against. */}
                  {buyerActions.includes("MAKE_OFFER") && (
                    onSend ? (
                      <Button
                        block
                        variant="ghost"
                        className="mt-2"
                        onClick={() => onSend(negotiateMessage)}
                        data-testid="button-make-offer"
                      >
                        قدّم عرض سعر
                      </Button>
                    ) : (
                      <ButtonLink
                        href={`/ai?ask=${encodeURIComponent(`ابحث عن ${offer.title}`.slice(0, 160))}`}
                        variant="ghost"
                        block
                        className="mt-2"
                        data-testid="button-make-offer"
                      >
                        قدّم عرض سعر في المحادثة
                      </ButtonLink>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Seller */}
            <div className="flex items-center gap-3 rounded-2xl border border-border/85 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_12px_28px_-14px_rgba(0,0,0,0.18)] backdrop-blur-sm">
              <Avatar
                name={offer.sellerName}
                src={
                  offer.sellerAvatarObjectPath
                    ? `/api/storage${offer.sellerAvatarObjectPath}`
                    : undefined
                }
                size={44}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">البائع</p>
                <p className="truncate text-md font-bold">{offer.sellerName}</p>
                {!!offer.paymentMethods?.length && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    الدفع المتاح: {offer.paymentMethods.map((method) =>
                      method === "CASH_DIRECT" ? "كاش" : "فيزا داخل جاسم",
                    ).join("، ")}
                  </p>
                )}
              </div>
                {offer.contactPhone && (
                  <a
                    href={`tel:${offer.contactPhone}`}
                    dir="ltr"
                    aria-label={`اتصل بالبائع ${offer.sellerName}`}
                    className="shrink-0 rounded-lg bg-primary-soft px-3 py-2 text-sm font-semibold text-primary-soft-foreground"
                  >
                    {offer.contactPhone}
                  </a>
                )}
              {!own && offer.sellerId && (
                <ReportButton targetType="USER" targetId={offer.sellerId} label="إبلاغ عن البائع" />
              )}
              {(offer.reviewCount ?? 0) > 0 ? (
                <span className="flex items-center gap-1 text-sm font-semibold">
                  <Star
                    size={15}
                    className="fill-accent text-accent"
                    aria-hidden
                  />
                  <span className="num">{offer.rating.toFixed(1)}</span>
                  <span className="text-muted-foreground">
                    ({offer.reviewCount})
                  </span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  لا توجد تقييمات بعد
                </span>
              )}
            </div>
            {!own && (
              <div className="flex justify-end">
                <ReportButton targetType="LISTING" targetId={offer.id} label="الإبلاغ عن هذا العرض" />
              </div>
            )}
          </div>
        </aside>

        {/* Details */}
        <div className="space-y-4 @4xl:col-start-1 @4xl:row-start-2">
          <section className="rounded-2xl border border-border/85 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_34px_-14px_rgba(0,0,0,0.22)] backdrop-blur-sm md:p-5">
            <h2 className="mb-2 text-md font-bold">ما تشمله الوحدة</h2>
            <p className="whitespace-pre-line text-md leading-8 text-text-secondary">
              {offer.description}
            </p>
          </section>

          <section className="rounded-2xl border border-border/85 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_34px_-14px_rgba(0,0,0,0.22)] backdrop-blur-sm md:p-5">
            <h2 className="mb-3 text-md font-bold">طريقة التنفيذ</h2>
            <div className="flex gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-soft-foreground">
                <HowIcon size={21} aria-hidden />
              </span>
              <div>
                <p className="text-md font-semibold">{how.label}</p>
                <p className="mt-0.5 text-base text-muted-foreground">
                  {how.buyer}
                </p>
              </div>
            </div>
            {place && offer.fulfilmentType !== "DIGITAL" && (
              <div className="mt-4 flex gap-3 border-t border-border pt-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-text-secondary">
                  <MapPin size={20} aria-hidden />
                </span>
                <div>
                  <p className="text-md font-semibold">{place}</p>
                  <p className="mt-0.5 text-base text-muted-foreground">
                    المنطقة العامة فقط. العنوان الدقيق يُشارك داخل الطلب عند
                    الحاجة.
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <TrustItem
              icon={MessageCircle}
              title="تواصل داخل الطلب"
              body="كل الرسائل مرتبطة بالطلب ومحفوظة للطرفين."
            />
            <TrustItem
              icon={Lock}
              title="تأكيد قبل الإكمال"
              body="لا يكتمل الطلب قبل أن تؤكد الاستلام بنفسك."
            />
          </section>
        </div>
      </div>
    </div>
  );
}

function TrustItem({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Lock;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3 rounded-2xl border border-border/80 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_24px_-14px_rgba(0,0,0,0.16)]">
      <Icon size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <div>
        <p className="text-base font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function OfferDetailsSkeleton() {
  return (
    <div
      className="container-app @container md:pt-6"
      aria-busy="true"
      aria-label="جارٍ تحميل العرض"
    >
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1fr)_400px] @4xl:gap-10">
        <Skeleton className="-mx-[var(--gutter)] aspect-square rounded-none md:mx-0 md:aspect-[4/3] md:rounded-2xl" />
        <div className="space-y-3">
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="h-8 w-4/5" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-44 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
