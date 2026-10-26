import { Link } from "wouter";
import { ChevronLeft, CircleDot, ShoppingBag } from "lucide-react";
import type { Order } from "@workspace/api-client-react";
import { money, orderRef, relativeTime, unitsLabel } from "@/lib/format";
import { nextAction, orderStatus, type Role } from "@/lib/marketplace";
import { Avatar, SmartImage } from "@/ui/Media";
import { StatusBadge, Skeleton } from "@/ui/Feedback";

export type OrderView = Order & { buyerId?: string; sellerId?: string };

export const roleIn = (order: OrderView, userId?: string): Role =>
  order.sellerId && order.sellerId === userId ? "seller" : "buyer";

export function OrderCard({ order, userId }: { order: OrderView; userId?: string }) {
  const role = roleIn(order, userId);
  const status = orderStatus(order.status, role);
  const todo = nextAction(order.status, role);
  const other = role === "seller" ? order.buyerName : order.sellerName;
  const otherAvatarObjectPath =
    role === "seller"
      ? order.buyerAvatarObjectPath
      : order.sellerAvatarObjectPath;
  const title = order.items?.length === 1 ? order.items[0].listingTitle : order.listingTitle;
  return (
    <Link
      href={`/orders/${order.id}`}
      data-testid={`row-order-${order.id}`}
      className="pressable block rounded-xl border border-border bg-card p-3.5 hover:border-border-strong hover:shadow-sm md:p-4"
    >
      <div className="flex gap-3">
        <div className="h-[68px] w-[68px] shrink-0 overflow-hidden rounded-md">
          <SmartImage src={order.listingImageUrl} alt="" fallbackIcon={ShoppingBag} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-1 text-md font-semibold text-foreground">{title}</h3>
            <ChevronLeft size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">{role === "seller" ? "المشتري:" : "البائع:"}</span>
            <Avatar
              name={other}
              src={
                otherAvatarObjectPath
                  ? `/api/storage${otherAvatarObjectPath}`
                  : undefined
              }
              size={20}
            />
            <span className="min-w-0 truncate">{other}</span>
            <span className="shrink-0">· <span className="num" dir="ltr">{orderRef(order.id)}</span></span>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <StatusBadge label={status.label} tone={status.tone} testId={`status-${order.status}`} />
            <span className="text-sm">
              <span className="text-muted-foreground">{unitsLabel(order.quantity)} · </span>
              <span className="num font-bold text-foreground">{money(order.total, order.currency)}</span>
            </span>
          </div>
        </div>
      </div>
      {todo && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm font-semibold text-accent-ink">
          <CircleDot size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">المطلوب منك: {todo}</span>
          <span className="mt-px shrink-0 text-2xs font-medium opacity-80">{relativeTime(order.updatedAt)}</span>
        </div>
      )}
    </Link>
  );
}

export function OrderListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex gap-3 rounded-xl border border-border bg-card p-4">
          <Skeleton className="h-[68px] w-[68px]" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <div className="flex justify-between">
              <Skeleton className="h-6 w-24 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
