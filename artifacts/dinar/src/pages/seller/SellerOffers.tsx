import { useState } from "react";
import { Link } from "wouter";
import { Pencil, Plus, Tag } from "lucide-react";
import { useGetListings } from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { OWN_LISTINGS, categoryIcon, fulfilment, placeOf, stockOf, type Offer } from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { ButtonLink, iconButtonClass } from "@/ui/Button";
import { Chip } from "@/ui/Field";
import { Badge, EmptyState, ErrorState, Skeleton } from "@/ui/Feedback";
import { PageHeader } from "@/ui/Layout";
import { SmartImage } from "@/ui/Media";

const STATUS: Record<string, string> = { DRAFT: "مسودة", PAUSED: "متوقف", ARCHIVED: "مؤرشف", MODERATION_HIDDEN: "مخفي بقرار إداري", MODERATION_REMOVED: "محذوف بقرار إداري" };

export function SellerOfferRow({ offer, compact }: { offer: Offer; compact?: boolean }) {
  const stock = stockOf(offer);
  return (
    <article data-testid={`row-seller-offer-${offer.id}`} className="flex items-center gap-3 p-3 md:p-4">
      <Link href={`/listings/${offer.id}`} className={cn("shrink-0 overflow-hidden rounded-md", compact ? "h-12 w-12" : "h-16 w-16")}>
        <SmartImage src={offer.imageUrl} alt="" fallbackIcon={categoryIcon(offer.category)} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link href={`/listings/${offer.id}`} className="line-clamp-1 text-base font-semibold hover:underline" data-testid={`text-seller-offer-title-${offer.id}`}>
          {offer.title}
        </Link>
        {!compact && (
          <p className="truncate text-xs text-muted-foreground">
            {offer.category} · {fulfilment(offer.fulfilmentType).label}
            {placeOf(offer) && ` · ${placeOf(offer)}`}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge tone={stock.tone === "out" ? "danger" : stock.tone === "low" ? "warning" : "success"} testId={`status-seller-offer-inventory-${offer.id}`}>
            {offer.inventoryMode === "UNLIMITED" ? "غير محدودة" : stock.tone === "out" ? "نفدت" : `متوفر ${stock.remaining}`}
          </Badge>
          {offer.reservedQuantity > 0 && <Badge tone="info">محجوز {offer.reservedQuantity}</Badge>}
          {STATUS[offer.status] && <Badge>{STATUS[offer.status]}</Badge>}
        </div>
      </div>
      <Link
        href={`/seller/offers/${offer.id}/edit`}
        aria-label={`تعديل ${offer.title}`}
        data-testid={`link-edit-offer-${offer.id}`}
        className={iconButtonClass("outline", compact ? "sm" : "md")}
      >
        <Pencil size={compact ? 15 : 17} aria-hidden />
      </Link>
    </article>
  );
}

type Filter = "all" | "available" | "low" | "out";

export default function SellerOffers() {
  const { user, market } = useAccount();
  const listings = useGetListings(OWN_LISTINGS);
  const [filter, setFilter] = useState<Filter>("all");
  const offers = ((listings.data ?? []) as Offer[]).filter((o) => o.sellerId === user?.id);
  const shown = offers.filter((o) => filter === "all" || (filter === "available" ? stockOf(o).tone === "ok" : stockOf(o).tone === filter));
  const n = (f: Filter) => offers.filter((o) => (f === "available" ? stockOf(o).tone === "ok" : stockOf(o).tone === f)).length;

  return (
    <div className="container-app max-w-3xl">
      <PageHeader
        back="/seller"
        title="عروضي"
        subtitle={`في سوق ${market?.countryNameAr ?? ""}`}
        actions={
          <ButtonLink href="/ai?sell=1" size="sm" variant="gold" icon={<Plus size={16} />} data-testid="link-new-listing-offers">
            عرض جديد
          </ButtonLink>
        }
      />
      {listings.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : listings.isError ? (
        <ErrorState onRetry={() => listings.refetch()} />
      ) : offers.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="لم تنشر أي عرض بعد"
          body="أنشئ أول عرض وحدد ما تشمله الوحدة والكمية المتوفرة."
          action={<ButtonLink href="/ai?sell=1" icon={<Plus size={17} />} data-testid="link-create-first-offer">أنشئ أول عرض</ButtonLink>}
          testId="state-seller-offers-empty"
        />
      ) : (
        <>
          <div className="-mx-[var(--gutter)] mb-4 overflow-x-auto scrollbar-none">
            <div className="flex gap-2 px-[var(--gutter)]">
              <Chip active={filter === "all"} onClick={() => setFilter("all")}>
                الكل <span className="num opacity-70">{offers.length}</span>
              </Chip>
              <Chip active={filter === "available"} onClick={() => setFilter("available")}>
                متوفرة <span className="num opacity-70">{n("available")}</span>
              </Chip>
              <Chip active={filter === "low"} onClick={() => setFilter("low")}>
                كمية منخفضة <span className="num opacity-70">{n("low")}</span>
              </Chip>
              <Chip active={filter === "out"} onClick={() => setFilter("out")}>
                نفدت <span className="num opacity-70">{n("out")}</span>
              </Chip>
            </div>
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={Tag} title="لا توجد عروض بهذه الحالة" compact />
          ) : (
            <div data-testid="list-seller-offers" className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {shown.map((o) => (
                <SellerOfferRow key={o.id} offer={o} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
