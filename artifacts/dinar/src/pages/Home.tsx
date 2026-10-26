import { Link } from "wouter";
import { ArrowLeft, Bot, LayoutGrid, Megaphone, PackageOpen, Search, Store } from "lucide-react";
import {
  useGetListings,
  useGetMarketplaceCategories,
} from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { categoryIcon, type Offer } from "@/lib/marketplace";
import { ButtonLink, buttonClass } from "@/ui/Button";
import { EmptyState, ErrorState, InlineAlert } from "@/ui/Feedback";
import { SectionHeader } from "@/ui/Layout";
import { OfferCard, OfferGrid, OfferGridSkeleton } from "@/features/OfferCard";
import { useMarketSheet } from "@/features/MarketSelector";

export function SearchLauncher() {
  return (
    <Link
      href="/search"
      data-testid="input-search"
      className="pressable flex h-12 items-center gap-3 rounded-full border border-border bg-card px-4 text-md text-muted-foreground shadow-xs hover:border-border-strong lg:hidden"
    >
      <Search size={20} className="text-foreground" aria-hidden />
      ماذا تبحث عنه؟
    </Link>
  );
}

function AiLauncher() {
  return (
    <Link
      href="/ai"
      data-testid="link-ai"
      className="pressable flex min-h-12 items-center gap-3 rounded-full border border-primary/25 bg-ink px-4 text-sm font-semibold text-ink-foreground shadow-xs hover:border-primary/50"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Bot size={16} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">خلّ DINAR AI يساعدك في البحث</span>
      <ArrowLeft size={16} className="shrink-0 text-accent" aria-hidden />
    </Link>
  );
}

function AdsInfo() {
  return (
    <aside
      aria-label="معلومات عن الإعلانات"
      data-testid="text-ads-info"
      className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Megaphone size={18} aria-hidden />
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-bold">عن الإعلانات</h2>
        <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
          كل إعلان هو عرض ينشره بائع في سوقك. راجع التفاصيل والكمية ومعلومات البائع قبل الطلب.
        </p>
      </div>
    </aside>
  );
}

/** Sellers set listing prices in the selected market's currency. */
function UnitPriceStrip() {
  const { market } = useAccount();
  const { open } = useMarketSheet();
  if (market && !market.isActive) return <InlineAlert title={`سوق ${market.countryNameAr} — قريبًا`}>بدينار لم يبدأ استقبال العروض والطلبات في هذا السوق بعد. يمكنك تغيير السوق من الشريط العلوي.</InlineAlert>;
  return (
    <section
      aria-label="أسعار العروض في السوق"
      className="relative flex items-center gap-3.5 overflow-hidden rounded-xl bg-ink p-4 text-ink-foreground md:p-5"
    >
      <span aria-hidden className="absolute -start-10 -top-12 h-36 w-36 rounded-full border-[18px] border-white/[0.04]" />
      <span
        aria-hidden
        className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-xl font-bold text-accent-foreground shadow-[inset_0_-3px_0_hsl(34_90%_40%/0.45)]"
      >
        <Store size={24} />
      </span>
      <div className="relative min-w-0 flex-1">
        <p className="text-sm text-ink-foreground/70">كل بائع يحدد سعر الوحدة في سوق {market?.countryNameAr ?? "الكويت"}</p>
        <p className="num text-xl font-bold leading-tight text-accent">{market?.currencyCode ?? "—"}</p>
        <p className="mt-0.5 hidden text-sm text-ink-foreground/70 sm:block">السعر والإجمالي ظاهران قبل تأكيد الطلب.</p>
      </div>
      <button
        type="button"
        onClick={open}
        className={buttonClass("secondary", "sm")}
      >
        تغيير السوق
      </button>
    </section>
  );
}

function CategoryRail() {
  const categories = useGetMarketplaceCategories();
  const categoryLabels = categories.data?.map((category) => category.label) ?? [];
  return (
    <nav aria-label="التصنيفات" className="-mx-[var(--gutter)] overflow-x-auto scrollbar-none">
      <ul className="flex gap-2 px-[var(--gutter)] md:gap-3">
        {[{ name: "الكل", href: "/search", Icon: LayoutGrid }, ...categoryLabels.map((c) => ({ name: c, href: `/search?category=${encodeURIComponent(c)}`, Icon: categoryIcon(c) }))].map(
          ({ name, href, Icon }) => (
            <li key={name} className="shrink-0">
              <Link
                href={href}
                data-testid={`button-category-${name}`}
                className="pressable group flex w-[76px] flex-col items-center gap-1.5 rounded-lg py-1 text-center md:w-[92px]"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card text-primary shadow-xs transition-colors group-hover:border-primary/40 group-hover:bg-primary-soft md:h-16 md:w-16">
                  <Icon size={24} strokeWidth={1.8} aria-hidden />
                </span>
                <span className="line-clamp-1 text-xs font-semibold text-text-secondary">{name}</span>
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

function SellPrompt() {
  const { market } = useAccount();
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center md:p-6">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
        <Store size={24} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-bold">عندك شيء تبيعه أو خدمة تقدمها؟</h2>
        <p className="mt-0.5 text-base text-muted-foreground">
          اعرضه في دقائق. أنت تحدد سعر الوحدة وما تشمله والكمية.
        </p>
      </div>
      <ButtonLink href="/ai?sell=1" variant="gold" className="shrink-0" icon={<ArrowLeft size={17} className="order-last" />}>
        ابدأ البيع
      </ButtonLink>
    </section>
  );
}

function GuestWelcome() {
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary-soft/60 p-4">
      <p className="text-base font-semibold text-foreground">حساب واحد للشراء والبيع. سلتك محفوظة لكل سوق.</p>
      <div className="flex gap-2">
        <ButtonLink href="/register" size="sm">
          إنشاء حساب
        </ButtonLink>
        <ButtonLink href="/login" size="sm" variant="secondary">
          دخول
        </ButtonLink>
      </div>
    </section>
  );
}

export default function Home() {
  const { user } = useAccount();
  const categoryRegistry = useGetMarketplaceCategories();
  const categoryRows = categoryRegistry.data ?? [];
  const sharedSortIds = categoryRows.length
    ? categoryRows.slice(1).reduce(
        (ids, category) =>
          ids.filter((id) =>
            category.rules.sorting.options.some(
              (option) => option.id === id && option.field !== "ATTRIBUTE",
            ),
          ),
        categoryRows[0].rules.sorting.options
          .filter((option) => option.field !== "ATTRIBUTE")
          .map((option) => option.id),
      )
    : [];
  const sharedSortOptions =
    categoryRows[0]?.rules.sorting.options.filter((option) =>
      sharedSortIds.includes(option.id),
    ) ?? [];
  const firstDefault = categoryRows[0]?.rules.sorting.defaultSort;
  const aggregateSort =
    firstDefault &&
    categoryRows.every(
      (category) => category.rules.sorting.defaultSort === firstDefault,
    ) &&
    sharedSortIds.includes(firstDefault)
      ? firstDefault
      : sharedSortOptions.find(
          (option) => option.field === "CREATED_AT" && option.direction === "DESC",
        )?.id ??
        sharedSortOptions[0]?.id;
  const listings = useGetListings({
    status: "PUBLISHED",
    sort: aggregateSort,
  });
  const offers = (listings.data ?? []) as Offer[];
  const fresh = offers.slice(0, 10);
  const more = offers.slice(10);

  return (
    <div className="container-app space-y-6 pt-4 md:space-y-8 md:pt-6">
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
          <SearchLauncher />
          <AiLauncher />
        </div>
        <AdsInfo />
        <UnitPriceStrip />
      </div>
      <CategoryRail />
      {!user && <GuestWelcome />}

      <section aria-labelledby="fresh-title">
        <SectionHeader title={<span id="fresh-title">وصل حديثًا</span>} href="/search" linkLabel="كل العروض" />
        {listings.isLoading ? (
          <OfferGridSkeleton count={6} />
        ) : listings.isError ? (
          <ErrorState onRetry={() => listings.refetch()} />
        ) : offers.length === 0 ? (
          <EmptyState
            icon={PackageOpen}
            title="لا توجد عروض في هذا السوق بعد"
            body="كن أول من يعرض هنا — الإعداد يأخذ دقائق."
            action={<ButtonLink href="/ai?sell=1">أضف أول عرض</ButtonLink>}
            testId="state-home-empty"
          />
        ) : (
          <OfferGrid>
            {fresh.map((o, i) => (
              <OfferCard key={o.id} offer={o} eager={i < 4} />
            ))}
          </OfferGrid>
        )}
      </section>

      <SellPrompt />

      {more.length > 0 && (
        <section aria-labelledby="more-title">
          <SectionHeader title={<span id="more-title">المزيد من العروض</span>} />
          <OfferGrid>
            {more.map((o) => (
              <OfferCard key={o.id} offer={o} />
            ))}
          </OfferGrid>
        </section>
      )}
    </div>
  );
}
