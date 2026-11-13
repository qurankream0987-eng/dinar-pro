import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { BadgeCheck, MessagesSquare, Clock, MapPin, Store } from "lucide-react";
import { api } from "@/account/Account";
import { OfferCard, OfferGrid, OfferGridSkeleton } from "@/features/OfferCard";
import { fulfilment as fulfilmentOf, type Offer } from "@/lib/marketplace";
import { Badge, EmptyState, ErrorState, InlineAlert, Skeleton } from "@/ui/Feedback";
import { PageHeader, Card, Summary } from "@/ui/Layout";

type BusinessProfile = {
  area?: string;
  fulfilment?: string;
  hours?: string;
  serviceAreas?: string[];
};

/** The DINAR-hosted public profile: only what the business chose to publish. */
type PublicBusiness = {
  id: string;
  name: string;
  description: string;
  businessType: string;
  businessTypeLabel: string;
  operatingMode: "INTERNAL_DINAR" | string;
  marketId: string;
  currency: string;
  /** True only when D2 verified the business identity; never inferred here. */
  verified: boolean;
  verificationStatus: "VERIFIED" | "PENDING_D2";
  profile: BusinessProfile;
  listings: Offer[];
  listingCount: number;
};

export default function PublicBusinessPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const business = useQuery<PublicBusiness>({
    queryKey: ["public-business", id],
    queryFn: async () => (await api(`/businesses/${encodeURIComponent(id ?? "")}/storefront`)) as PublicBusiness,
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: false,
  });

  if (business.isLoading)
    return (
      <div className="container-app max-w-4xl space-y-3 pt-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <OfferGridSkeleton count={4} />
      </div>
    );
  if (business.error || !business.data)
    return (
      <div className="container-app max-w-2xl">
        <ErrorState
          title="النشاط غير متاح"
          body="قد يكون النشاط موقوفًا أو غير منشور في جاسم."
          onRetry={() => business.refetch()}
        />
      </div>
    );

  const data = business.data;
  const profile = data.profile ?? {};
  const listingCount = data.listingCount ?? data.listings?.length ?? 0;
  const facts = [
    profile.area ? { label: "المنطقة", value: profile.area } : null,
    profile.fulfilment
      ? { label: "طريقة التسليم", value: fulfilmentOf(profile.fulfilment).label }
      : null,
    profile.hours ? { label: "أوقات العمل", value: profile.hours } : null,
    profile.serviceAreas?.length
      ? { label: "مناطق الخدمة", value: profile.serviceAreas.join("، ") }
      : null,
  ].filter((row): row is { label: string; value: string } => Boolean(row));

  return (
    <div className="container-app max-w-4xl" data-testid={`page-business-${data.id}`}>
      <PageHeader
        back="/"
        title={data.name}
        subtitle={data.businessTypeLabel}
        actions={
          data.verified ? (
            <Badge tone="success" icon={<BadgeCheck size={14} aria-hidden />} testId="badge-business-verified">
              نشاط موثّق
            </Badge>
          ) : (
            <Badge tone="neutral" icon={<Store size={13} aria-hidden />} testId="badge-business-hosted">
              على دينار
            </Badge>
          )
        }
      />

      <div className="space-y-4">
        <Card className="space-y-3" testId="card-business-profile">
          {data.description ? (
            <p className="text-base leading-7 text-text-secondary">{data.description}</p>
          ) : null}
          {facts.length > 0 && <Summary rows={facts} />}
          <InlineAlert tone="info" title="الشراء يتم عبر جاسم">
            كل المنتجات هنا من كتالوج النشاط نفسه في سوق جاسم. اختر منتجًا للتعرّف عليه، أو اسأل دينار في المحادثة.
          </InlineAlert>
          <a
            href="/#chat"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
            data-testid="link-business-chat"
          >
            <MessagesSquare size={16} aria-hidden />
            اسأل دينار عن هذا النشاط
          </a>
        </Card>

        <section aria-labelledby="business-listings">
          <h2 id="business-listings" className="mb-3 text-lg font-bold text-foreground">
            المنتجات ({listingCount.toLocaleString("ar-EG")})
          </h2>
          {listingCount === 0 ? (
            <EmptyState
              compact
              icon={Store}
              title="لا توجد منتجات منشورة بعد"
              body="ستظهر منتجات النشاط هنا فور نشرها في السوق."
              testId="empty-business-listings"
            />
          ) : (
            <OfferGrid>
              {data.listings.map((listing, index) => (
                <OfferCard
                  key={listing.id}
                  offer={listing}
                  eager={index < 4}
                  // In chat-only DINAR every purchase starts from the conversation: pre-type the
                  // request (never send it) so the canonical search and checkout stay the only path.
                  onOpen={() => navigate(`/ai?ask=${encodeURIComponent(`أبي ${listing.title}`)}`)}
                />
              ))}
            </OfferGrid>
          )}
        </section>

        <p className="flex items-center justify-center gap-1.5 pb-6 text-center text-xs text-muted-foreground">
          <Clock size={13} aria-hidden />
          البيانات المعروضة يحدّثها صاحب النشاط من محادثة دينار.
          {profile.area ? (
            <span className="inline-flex items-center gap-1">
              <MapPin size={13} aria-hidden />
              {profile.area}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
