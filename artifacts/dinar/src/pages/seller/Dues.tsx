import { Link } from "wouter";
import { ChevronLeft, CircleCheckBig, Coins, Info } from "lucide-react";
import { useGetSellerDues, type SellerDue } from "@workspace/api-client-react";
import { longDate, money, orderRef } from "@/lib/format";
import { currencyScale } from "@/cart/cart-domain";
import type { Tone } from "@/lib/marketplace";
import { ButtonLink } from "@/ui/Button";
import { useAccount } from "@/account/Account";
import { EmptyState, ErrorState, Skeleton, StatusBadge } from "@/ui/Feedback";
import { PageHeader } from "@/ui/Layout";
import { WhopPayoutsCard } from "./Payouts";

const DUE_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "بانتظار السداد", tone: "warning" },
  PAID: { label: "مسدد", tone: "success" },
  DISPUTED: { label: "قيد المراجعة", tone: "danger" },
};

/** Sum per currency in minor units (dues can come from several markets). */
function totalsByCurrency(dues: SellerDue[]) {
  const map = new Map<string, number>();
  for (const d of dues) {
    const scale = currencyScale(d.currency);
    map.set(d.currency, (map.get(d.currency) ?? 0) + Math.round(Number(d.amount) * 10 ** scale));
  }
  return [...map.entries()].map(([currency, minor]) => ({ currency, amount: (minor / 10 ** currencyScale(currency)).toFixed(currencyScale(currency)) }));
}

export default function DuesPage() {
  const { market } = useAccount();
  const dues = useGetSellerDues();
  const list = [...((dues.data ?? []) as SellerDue[])].sort((a, b) => new Date(b.dueAt).getTime() - new Date(a.dueAt).getTime());
  const pending = list.filter((d) => d.status === "PENDING");
  const totals = totalsByCurrency(pending);

  return (
    <div className="container-app max-w-3xl">
      <PageHeader back="/seller" title="المستحقات" subtitle="رسوم جاسم على طلباتك المكتملة" />
      {dues.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : dues.isError ? (
        <ErrorState onRetry={() => dues.refetch()} />
      ) : (
        <div className="space-y-5">
          <section className="rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">إجمالي المستحق عليك</p>
            {totals.length === 0 ? (
              <p className="num mt-1 text-3xl font-bold">{money(0, market?.currencyCode)}</p>
            ) : (
              totals.map((t) => (
                <p key={t.currency} className="num mt-1 text-3xl font-bold" data-testid="text-dues-total">
                  {money(t.amount, t.currency)}
                </p>
              ))
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              من <span className="num">{pending.length}</span> طلب مكتمل
            </p>
            <div className="mt-4 flex gap-2.5 rounded-md bg-muted p-3 text-sm leading-6 text-text-secondary">
              <Info size={17} className="mt-0.5 shrink-0 text-info" aria-hidden />
              <p>
                عندما يكتمل طلب ويدفع لك المشتري مباشرة، تُسجَّل رسوم جاسم (15% من قيمة الطلب) هنا. هذه ليست محفظة أو رصيدًا — إنها
                المبلغ المستحق لجاسم. السداد الإلكتروني غير متاح حاليًا.
              </p>
            </div>
          </section>

          <WhopPayoutsCard />

          {list.length === 0 ? (
            <EmptyState
              icon={CircleCheckBig}
              title="لا توجد مستحقات"
              body="ستظهر هنا رسوم الطلبات المكتملة فقط."
              action={<ButtonLink href="/seller" variant="secondary">مساحة البائع</ButtonLink>}
              testId="state-dues-empty"
            />
          ) : (
            <section>
              <h2 className="mb-2 text-md font-bold">السجل</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {list.map((d) => {
                  const st = DUE_STATUS[d.status] ?? { label: d.status, tone: "neutral" as Tone };
                  return (
                    <li key={d.id}>
                      <Link href={`/orders/${d.orderId}`} className="flex items-center gap-3 p-4 hover:bg-muted/50" data-testid={`row-due-${d.id}`}>
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-text-secondary">
                          <Coins size={18} aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-1 text-base font-semibold">{d.listingTitle}</span>
                          <span className="block text-xs text-muted-foreground">
                            طلب <span className="num" dir="ltr">{orderRef(d.orderId)}</span> · استُحق {longDate(d.dueAt)}
                          </span>
                          <span className="mt-1 block">
                            <StatusBadge label={st.label} tone={st.tone} />
                          </span>
                        </span>
                        <span className="num text-md font-bold">{money(d.amount, d.currency)}</span>
                        <ChevronLeft size={17} className="text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
