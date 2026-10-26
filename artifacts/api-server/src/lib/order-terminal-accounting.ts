import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { offers, orderItems, orders, sellerDues } from "@workspace/db";
import { settleOrderFulfillment } from "./delivery";

type TerminalOrderStatus = "COMPLETED" | "CANCELLED";
type OrderRecord = typeof orders.$inferSelect;

/**
 * Applies the existing inventory and seller-due effects for a terminal order.
 * Commission is never recalculated here; the order's persisted fee snapshot is
 * the sole source for a completed-sale due. Precise delivery location is cleared
 * because a terminal order no longer needs it.
 */
export async function applyTerminalOrderAccounting(
  tx: any,
  order: OrderRecord,
  status: TerminalOrderStatus,
  now: Date,
): Promise<boolean> {
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(orderItems.offerId);

  for (const item of items) {
    if (item.data.inventoryMode !== "LIMITED") continue;
    const [offer] = await tx
      .select()
      .from(offers)
      .where(eq(offers.id, item.offerId))
      .for("update");
    if (!offer) throw new Error(`Order ${order.id} references a missing offer`);

    await tx
      .update(offers)
      .set({
        reservedQuantity: Math.max(0, offer.reservedQuantity - item.quantity),
        availableQuantity:
          status === "COMPLETED" && offer.inventoryMode === "LIMITED"
            ? Math.max(0, offer.availableQuantity! - item.quantity)
            : offer.availableQuantity,
        updatedAt: now,
      })
      .where(eq(offers.id, offer.id));
  }

  await settleOrderFulfillment(tx, order.id, status, now);

  if (status === "COMPLETED") {
    const [due] = await tx
      .insert(sellerDues)
      .values({
        id: randomUUID(),
        orderId: order.id,
        sellerId: order.sellerId,
        amountMinor: order.platformFeeMinor,
        currencyCode: order.currencyCode,
      })
      .onConflictDoNothing()
      .returning({ id: sellerDues.id });
    return Boolean(due);
  }
  return false;
}