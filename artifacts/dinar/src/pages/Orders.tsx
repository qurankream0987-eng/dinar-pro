import { useState } from "react";
import { useSearch } from "wouter";
import { ReceiptText, Store } from "lucide-react";
import { useGetOrders } from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { isActiveOrder, isClosedOrder, nextAction } from "@/lib/marketplace";
import { ButtonLink } from "@/ui/Button";
import { Chip, Segmented } from "@/ui/Field";
import { EmptyState, ErrorState } from "@/ui/Feedback";
import { PageHeader } from "@/ui/Layout";
import { OrderCard, OrderListSkeleton, roleIn, type OrderView } from "@/features/OrderCard";

type Filter = "all" | "todo" | "active" | "done" | "issues";
type RoleFilter = "all" | "buyer" | "seller";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "الكل" },
  { value: "todo", label: "تحتاج إجراء" },
  { value: "active", label: "جارية" },
  { value: "done", label: "مكتملة" },
  { value: "issues", label: "ملغاة ونزاعات" },
];

export default function OrdersPage({ resourceIds, conversational = false }: { resourceIds?: string[]; conversational?: boolean } = {}) {
  const { user } = useAccount();
  const params = new URLSearchParams(useSearch());
  const [role, setRole] = useState<RoleFilter>(
    conversational ? "all" : params.get("role") === "seller" ? "seller" : "buyer",
  );
  const [filter, setFilter] = useState<Filter>("all");
  const orders = useGetOrders();
  const all = (orders.data ?? []) as OrderView[];
  const mine = role === "all" ? all : all.filter((o) => roleIn(o, user?.id) === role);
  const count = (r: "buyer" | "seller") => all.filter((o) => roleIn(o, user?.id) === r).length;
  const shown = (resourceIds ? resourceIds.flatMap(id => mine.filter(o => o.id === id)) : mine).filter((o) => {
    if (filter === "todo")
      return !!nextAction(o.status, role === "all" ? roleIn(o, user?.id) : role);
    if (filter === "active") return isActiveOrder(o.status);
    if (filter === "done") return isClosedOrder(o.status) && o.status !== "CANCELLED";
    if (filter === "issues") return ["CANCELLED", "DISPUTED"].includes(o.status);
    return true;
  });
  const todoCount = mine.filter((o) =>
    nextAction(o.status, role === "all" ? roleIn(o, user?.id) : role),
  ).length;

  return (
    <div className="container-app max-w-3xl">
      <PageHeader title="طلباتي" subtitle="تابع كل طلب من الإنشاء حتى الاكتمال" />
      {!conversational && (
        <>
          <Segmented
            label="نوع الطلبات"
            value={role}
            onChange={(v) => {
              setRole(v);
              setFilter("all");
            }}
            options={[
              { value: "buyer", label: <>مشترياتي <span className="num text-xs opacity-70">{count("buyer")}</span></>, testId: "button-orders-buyer" },
              { value: "seller", label: <>مبيعاتي <span className="num text-xs opacity-70">{count("seller")}</span></>, testId: "button-orders-seller" },
            ]}
          />
          <div className="-mx-[var(--gutter)] mt-3 overflow-x-auto scrollbar-none">
            <div className="flex gap-2 px-[var(--gutter)] pb-1">
              {FILTERS.map((f) => (
                <Chip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)} testId={`button-orders-${f.value}`}>
                  {f.label}
                  {f.value === "todo" && todoCount > 0 && (
                    <span className="num rounded-full bg-accent px-1.5 text-2xs font-bold text-accent-foreground">{todoCount}</span>
                  )}
                </Chip>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="mt-4">
        {orders.isLoading ? (
          <div role="status" aria-label="جارٍ تحميل طلباتك" aria-busy="true"><OrderListSkeleton /></div>
        ) : orders.isError ? (
          <ErrorState onRetry={() => orders.refetch()} />
        ) : shown.length === 0 ? (
          mine.length === 0 ? (
            role === "buyer" || role === "all" ? (
              <EmptyState
                icon={ReceiptText}
                title={role === "all" ? "لا توجد طلبات بعد" : "لا توجد مشتريات بعد"}
                body={
                  role === "all"
                    ? "ستظهر مشترياتك ومبيعاتك هنا لمتابعة كل طلب من البداية حتى الاكتمال."
                    : "عندما تطلب عرضًا، ستتابع هنا كل خطوة حتى الاستلام."
                }
                action={<ButtonLink href="/">اكتشف العروض</ButtonLink>}
                testId="state-orders-empty"
              />
            ) : (
              <EmptyState
                icon={Store}
                title="لا توجد مبيعات بعد"
                body="عندما يطلب أحد عروضك، سيظهر الطلب هنا لتقبله وتسلّمه."
                action={<ButtonLink href="/ai?sell=1">أضف عرضًا</ButtonLink>}
                testId="state-orders-empty"
              />
            )
          ) : (
            <EmptyState icon={ReceiptText} title="لا توجد طلبات بهذه الحالة" compact />
          )
        ) : (
          <div className="space-y-3.5">
            {shown.map((o, index) => (
              <div key={o.id} data-testid={conversational ? `order-result-${index + 1}` : undefined}>
                {conversational && <p className="mb-2 text-sm font-semibold text-muted-foreground">الطلب {index + 1}</p>}
                <OrderCard order={o} userId={user?.id} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
