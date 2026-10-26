import { Link } from "wouter";
import { MapPin, Star } from "lucide-react";
import { useGetMarketplaceCategories } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { categoryIcon, fulfilment, offerPriceFallback, offerPriceNote, placeOf, stockOf, type Offer } from "@/lib/marketplace";
import { Avatar, SmartImage } from "@/ui/Media";
import { PriceDisplay } from "@/ui/Commerce";
import { Skeleton } from "@/ui/Feedback";

export function OfferCard({
  offer,
  eager,
  onOpen,
  conversational = false,
  isBDinar = false,
}: {
  offer: Offer;
  eager?: boolean;
  onOpen?: () => void;
  conversational?: boolean;
  isBDinar?: boolean;
}) {
  const categories = useGetMarketplaceCategories();
  const stock = stockOf(offer);
  const how = fulfilment(offer.fulfilmentType);
  const HowIcon = how.icon;
  const place = placeOf(offer);
  const categorySchema = categories.data?.find(
    (category) =>
      category.id === offer.categoryId || category.label === offer.category,
  );
  const attributePriority =
    categorySchema?.rules.display.cardAttributes ?? [];
  const attributeSummary = attributePriority
    .filter((key) => offer.attributes?.[key] != null && offer.attributes[key] !== "")
    .slice(0, 3)
    .map(
      (key) =>
        `${categorySchema?.attributes[key]?.label ?? key}: ${offer.attributes?.[key]}`,
    );
  const reviewCount = offer.reviewCount ?? 0;
  const out = stock.tone === "out";
  if (conversational) {
    // Chat result card: image, title, price, one line of real facts. Fulfilment, seller and
    // description stay in the detail view.
    const facts = attributePriority
      .map((key) => [key, offer.attributes?.[key]] as const)
      .filter(([, value]) => value != null && value !== "" && !offer.title.includes(String(value)))
      .slice(0, 2)
      .map(([key, value]) =>
        /mileage|odometer|km/i.test(key) && Number.isFinite(Number(value))
          ? `${Number(value).toLocaleString("en")} كم`
          : String(value),
      );
    return (
      <Link
        href={`/listings/${offer.id}`}
        onClick={onOpen ? (event) => { event.preventDefault(); onOpen(); } : undefined}
        data-testid={`card-listing-${offer.id}`}
        className="ai-result-card group flex min-w-0 flex-col overflow-hidden"
      >
        <div className={cn("ai-result-card-media relative", out && "opacity-60 grayscale")}>
          <SmartImage
            src={offer.imageUrl}
            alt={offer.title}
            fallbackIcon={categoryIcon(offer.category)}
            eager={eager}
            className="transition-transform duration-500 group-hover:scale-[1.03]"
          />
          {out && (
            <span className="absolute inset-x-0 bottom-0 bg-foreground/80 py-1.5 text-center text-xs font-bold text-background">
              نفدت الكمية
            </span>
          )}
        </div>
        <div className="ai-result-card-body">
          {offer.isSponsored && (
            <span
              data-testid={`label-sponsored-${offer.id}`}
              className="ai-result-sponsored"
              title="ظهر هذا العرض في موضع مدفوع لأنه يطابق بحثك"
            >
              إعلان ممول
            </span>
          )}
          {offer.fulfilmentType === "SERVICE" && (
            <span
              data-testid={`label-service-${offer.id}`}
              className="mb-1 inline-flex w-fit items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-2xs font-semibold text-muted-foreground"
            >
              <HowIcon size={12} aria-hidden />
              {how.label}
            </span>
          )}
          <h3 className="ai-result-card-title">{offer.title}</h3>
          <div className="ai-result-price-row">
            {offer.unitPrice == null ? (
              <span className="text-sm font-semibold text-muted-foreground">
                {offerPriceFallback(offer)}
              </span>
            ) : (
              <PriceDisplay
                amount={offer.unitPrice}
                currency={offer.currency}
                size="md"
                className="ai-result-card-price"
                suffix={offerPriceNote(offer)}
              />
            )}
            <span
              data-testid={`status-card-inventory-${offer.id}`}
              className={cn(
                "ai-result-stock",
                stock.tone === "ok" && "text-success",
                stock.tone === "low" && "text-warning",
                stock.tone === "out" && "text-destructive",
              )}
              title={how.label}
            >
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
              {stock.tone === "ok" ? "متوفر" : stock.label}
            </span>
          </div>
          {offer.recommendationReasons && offer.recommendationReasons.length > 0 && (
            <ul className="ai-result-reasons" aria-label="سبب الاقتراح" data-testid={`recommendation-reasons-${offer.id}`}>
              {offer.recommendationReasons.slice(0, 2).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <div className="ai-result-card-meta">
            {place && (
              <span className="ai-result-fact">
                <MapPin size={13} aria-hidden />
                <span className="truncate">{place}</span>
              </span>
            )}
            {facts.map((fact) => (
              <span className="ai-result-fact" key={fact}>
                <span className="truncate">{fact}</span>
              </span>
            ))}
          </div>
        </div>
      </Link>
    );
  }
  return (
    <Link
      href={`/listings/${offer.id}`}
      onClick={onOpen ? (event) => { event.preventDefault(); onOpen(); } : undefined}
      data-testid={`card-listing-${offer.id}`}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden border border-border bg-card transition-[box-shadow,border-color,transform] duration-200 hover:border-border-strong hover:shadow-md focus-visible:shadow-md active:scale-[0.99]",
        conversational
          ? "rounded-2xl shadow-sm shadow-black/15"
          : "rounded-xl",
      )}
    >
      <div className={cn("relative", conversational ? "aspect-[4/3]" : "aspect-square", out && "opacity-60 grayscale")}>
        <SmartImage
          src={offer.imageUrl}
          alt={offer.title}
          fallbackIcon={categoryIcon(offer.category)}
          eager={eager}
          className="transition-transform duration-500 group-hover:scale-[1.03]"
        />
        <span className="absolute start-2 top-2 inline-flex h-6 items-center gap-1 rounded-full bg-card/92 px-2 text-2xs font-semibold text-text-secondary shadow-xs backdrop-blur">
          <HowIcon size={12} aria-hidden />
          {how.label}
        </span>
        {isBDinar && (
          <span className="absolute end-2 top-2 inline-flex h-7 items-center rounded-full bg-accent px-2.5 text-xs font-bold text-accent-foreground shadow-sm">
            بدينار
          </span>
        )}
        {out && (
          <span className="absolute inset-x-0 bottom-0 bg-foreground/80 py-1.5 text-center text-xs font-bold text-background">
            نفدت الكمية
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3 md:p-3.5">
        {offer.isSponsored && (
          <span
            data-testid={`label-sponsored-${offer.id}`}
            className="mb-1 w-fit rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-xs font-bold text-foreground"
            title="ظهر هذا العرض في موضع مدفوع لأنه يطابق بحثك"
          >
            إعلان ممول
          </span>
        )}
        <h3 className="line-clamp-2 min-h-[44px] text-base font-semibold leading-[22px] text-foreground">
          {offer.title}
        </h3>
        {conversational && offer.description?.trim() && (
          <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">
            {offer.description}
          </p>
        )}
        {offer.recommendationReasons && offer.recommendationReasons.length > 0 && (
          <ul
            className="mt-1 flex flex-wrap gap-1"
            aria-label="سبب الاقتراح"
            data-testid={`recommendation-reasons-${offer.id}`}
          >
            {offer.recommendationReasons.slice(0, 3).map((reason) => (
              <li
                key={reason}
                className="max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground"
              >
                {reason}
              </li>
            ))}
          </ul>
        )}
        {attributeSummary.length > 0 && (
          <p className="mt-1 line-clamp-1 text-xs leading-5 text-primary">
            {attributeSummary.join(" · ")}
          </p>
        )}
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Avatar
            name={offer.sellerName}
            src={
              offer.sellerAvatarObjectPath
                ? `/api/storage${offer.sellerAvatarObjectPath}`
                : undefined
            }
            size={conversational ? 18 : 20}
          />
          <span className="truncate">{offer.sellerName}</span>
        </div>
        <div className="mt-auto pt-2.5">
          <div className="flex items-end justify-between gap-2">
            {offer.unitPrice == null ? (
              <span className="text-sm font-semibold text-muted-foreground">
                {offerPriceFallback(offer)}
              </span>
            ) : (
              <PriceDisplay
                amount={offer.unitPrice}
                currency={offer.currency}
                size={conversational ? "lg" : "md"}
                className={conversational ? "ai-result-card-price" : undefined}
                suffix={offerPriceNote(offer)}
              />
            )}
            <span
              data-testid={`status-card-inventory-${offer.id}`}
              className={cn(
                "inline-flex items-center gap-1 text-2xs font-semibold",
                stock.tone === "ok" && "text-success",
                stock.tone === "low" && "text-warning",
                stock.tone === "out" && "text-destructive",
              )}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
              {stock.tone === "ok" ? "متوفر" : stock.label}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-2xs text-muted-foreground">
            {place && (
              <span className="flex min-w-0 items-center gap-0.5">
                <MapPin size={12} className="shrink-0" aria-hidden />
                <span className="truncate">{place}</span>
              </span>
            )}
            {reviewCount > 0 &&
              typeof offer.rating === "number" &&
              Number.isFinite(offer.rating) && (
              <span className="flex shrink-0 items-center gap-0.5">
                <Star size={12} className="fill-accent text-accent" aria-hidden />
                <span className="num">{offer.rating.toFixed(1)}</span>
                <span className="num text-muted-foreground">
                  ({reviewCount.toLocaleString("en")})
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

export function OfferGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4 xl:grid-cols-5", className)}>
      {children}
    </div>
  );
}

export function OfferCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <Skeleton className="aspect-square rounded-none" />
      <div className="space-y-2 p-3">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
        <div className="flex justify-between pt-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-10" />
        </div>
      </div>
    </div>
  );
}

export function OfferGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <OfferGrid>
      {Array.from({ length: count }, (_, i) => (
        <OfferCardSkeleton key={i} />
      ))}
    </OfferGrid>
  );
}
