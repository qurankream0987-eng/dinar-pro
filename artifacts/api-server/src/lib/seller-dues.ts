/**
 * The seller's commission dues, as the seller-dues route has always reported them: the commission
 * rate comes from the order's immutable policy snapshot, and reversals recorded in the order
 * journal reduce the amount due. Shared by GET /seller-dues and the model's readSellerDues read.
 */
import { and, eq } from "drizzle-orm";
import { db, orders, sellerDues } from "@workspace/db";
import { commissionReversalsByOrder, netCommissionDueMinor } from "./order-journal";

const money = (amount: number, scale: number) => (amount / 10 ** scale).toFixed(scale);

export async function sellerDuesView(sellerId: string, marketId?: string) {
  const rows = await db
    .select({ due: sellerDues, order: orders })
    .from(sellerDues)
    .innerJoin(orders, eq(orders.id, sellerDues.orderId))
    .where(marketId ? and(eq(sellerDues.sellerId, sellerId), eq(orders.marketId, marketId)) : eq(sellerDues.sellerId, sellerId));
  const reversals = await commissionReversalsByOrder(rows.map(({ order }) => order.id));
  return rows.map(({ due, order }) => {
    const snapshot = order.data.commissionPolicy;
    const commissionRateBps =
      snapshot && typeof snapshot === "object" &&
      Number.isSafeInteger((snapshot as Record<string, unknown>).rateBasisPoints)
        ? ((snapshot as Record<string, unknown>).rateBasisPoints as number)
        : typeof order.data.commissionRateBps === "number"
          ? order.data.commissionRateBps
          : 1_000;
    const netMinor = netCommissionDueMinor(due.amountMinor, reversals.get(order.id) ?? 0);
    return {
      id: due.id,
      orderId: order.id,
      listingTitle: order.data.listingTitle,
      amount: money(netMinor, order.minorUnitScale),
      currency: due.currencyCode,
      reason: `عمولة ${commissionRateBps / 100}% بعد اكتمال الطلب — لا يتوفر سداد إلكتروني`,
      dueAt: due.createdAt.toISOString(),
      status: due.status,
    };
  });
}
