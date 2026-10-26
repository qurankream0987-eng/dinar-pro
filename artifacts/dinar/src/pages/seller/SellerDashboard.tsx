import { Link } from "wouter";
import {
  ChevronLeft,
  CircleCheckBig,
  Coins,
  Inbox,
  PackageOpen,
  Plus,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { useGetDashboard, useGetListings, useGetOrders } from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { money } from "@/lib/format";
import { OWN_LISTINGS, nextAction, stockOf, type Offer } from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { ButtonLink } from "@/ui/Button";
import { EmptyState, ErrorState, Skeleton } from "@/ui/Feedback";
import { Card, SectionHeader } from "@/ui/Layout";
import { Flag } from "@/ui/Media";
import { OrderCard, type OrderView } from "@/features/OrderCard";
import { SellerOfferRow } from "./SellerOffers";

function Stat({
  icon: Icon,
  label,
  value,
  href,
  highlight,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  href: string;
  highlight?: boolean;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className={cn(
        "pressable flex flex-col gap-2 rounded-xl border p-4 hover:shadow-sm",
        highlight ? "border-accent/60 bg-accent-soft/70" : "border-border bg-card hover:border-border-strong",
      )}
    >
      <span className="flex items-center justify-between">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-md", highlight ? "bg-accent text-accent-foreground" : "bg-muted text-text-secondary")}>
          <Icon size={18} aria-hidden />
        </span>
        <ChevronLeft size={16} className="text-muted-foreground" aria-hidden />
      </span>
      <span className="num text-2xl font-bold leading-none text-foreground">{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </Link>
  );
}

export default function SellerDashboard() {
  const { user, market } = useAccount();
  const dashboard = useGetDashboard();
  const orders = useGetOrders({ role: "seller" });
  const listings = useGetListings(OWN_LISTINGS);

  if (dashboard.isLoading || orders.isLoading || listings.isLoading)
    return (
      <div className="container-app space-y-4 pt-6" aria-busy="true" aria-label="جارٍ تحميل مساحة البائع">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  if (dashboard.isError || !dashboard.data)
    return (
      <div className="container-app">
        <ErrorState onRetry={() => dashboard.refetch()} />
      </div>
    );

  const d = dashboard.data;
  const sales = (orders.data ?? []) as OrderView[];
  const offers = ((listings.data ?? []) as Offer[]).filter((o) => o.sellerId === user?.id);
  const todo = sales.filter((o) => nextAction(o.status, "seller"));
  const newOrders = sales.filter((o) => ["CREATED", "PAYMENT_PENDING", "PAID"].includes(o.status)).length;
  const lowStock = offers.filter((o) => ["low", "out"].includes(stockOf(o).tone));
  const firstTime = offers.length === 0 && sales.length === 0;
  const hasDues = Number(d.pendingDuesAmount) > 0;

  return (
    <div className="container-app">
      <header className="flex flex-wrap items-end justify-between gap-3 pb-5 pt-5 md:pt-8">
        <div>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Flag code={market?.countryCode} size={16} /> مساحة البائع · سوق {market?.countryNameAr}
          </p>
          <h1 className="mt-1 text-2xl font-bold md:text-3xl">مرحبًا، {d.userName}</h1>
        </div>
        <ButtonLink href="/ai?sell=1" variant="gold" icon={<Plus size={18} />} className="max-sm:w-full" data-testid="link-new-listing">
          إضافة عرض
        </ButtonLink>
      </header>

      {firstTime ? (
        <Card className="text-center">
          <EmptyState
            icon={Tag}
            title="ابدأ البيع في دقائق"
            body="أنت تحدد سعر الوحدة وما تشمله والكمية وطريقة التسليم — وبدينار يتولى الباقي."
            action={
              <ButtonLink href="/ai?sell=1" icon={<Plus size={18} />} data-testid="link-empty-new-listing">
                أضف أول عرض
              </ButtonLink>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={Inbox} label="طلبات جديدة" value={newOrders} href="/orders?role=seller" highlight={newOrders > 0} testId="stat-new-orders" />
            <Stat icon={Tag} label="عروض نشطة" value={d.activeListings} href="/seller/offers" testId="stat-active-listings" />
            <Stat icon={CircleCheckBig} label="مبيعات مكتملة" value={d.completedOrders} href="/orders?role=seller" testId="stat-completed" />
            <Stat
              icon={Coins}
              label="مستحقات بدينار"
              value={<span className="text-xl">{money(d.pendingDuesAmount, market?.currencyCode)}</span>}
              href="/seller/dues"
              testId="stat-dues"
            />
          </div>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <section>
              <SectionHeader title="طلبات تحتاج إجراء" href={todo.length ? "/orders?role=seller" : undefined} />
              {todo.length === 0 ? (
                <Card>
                  <EmptyState icon={CircleCheckBig} title="لا شيء بانتظارك الآن" body="ستظهر هنا الطلبات التي تحتاج قبولك أو تسليمك." compact />
                </Card>
              ) : (
                <div className="space-y-3">
                  {todo.slice(0, 5).map((o) => (
                    <OrderCard key={o.id} order={o} userId={user?.id} />
                  ))}
                </div>
              )}
            </section>

            <div className="space-y-6">
              {hasDues && (
                <Link
                  href="/seller/dues"
                  className="pressable flex items-center gap-3 rounded-xl border border-border bg-card p-4 hover:border-border-strong"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-warning-soft text-warning">
                    <Coins size={19} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold">مستحقات بانتظار السداد</span>
                    <span className="block text-sm text-muted-foreground">
                      <span className="num">{money(d.pendingDuesAmount, market?.currencyCode)}</span> من {d.pendingDues} طلب مكتمل
                    </span>
                  </span>
                  <ChevronLeft size={18} className="text-muted-foreground" aria-hidden />
                </Link>
              )}
              <section>
                <SectionHeader title="عروضي" href="/seller/offers" linkLabel="إدارة العروض" />
                {offers.length === 0 ? (
                  <Card>
                    <EmptyState icon={PackageOpen} title="لا توجد عروض في هذا السوق" compact action={<ButtonLink href="/ai?sell=1" size="sm">أضف عرضًا</ButtonLink>} />
                  </Card>
                ) : (
                  <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {(lowStock.length ? lowStock : offers).slice(0, 4).map((o) => (
                      <SellerOfferRow key={o.id} offer={o} compact />
                    ))}
                  </div>
                )}
                {lowStock.length > 0 && (
                  <p className="mt-2 text-xs text-warning">{lowStock.length} عروض كميتها منخفضة أو نفدت.</p>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
