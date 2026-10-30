import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  offers,
  orderItems,
  orders,
  paymentIntents,
  sellerDues,
} from "@workspace/db";
import { settleOrderFulfillment } from "./delivery";
import {
  postCompletedOrderJournal,
  recordCommissionReversal,
  recordOrderFinancialEvent,
} from "./order-journal";

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

  await recordOrderFinancialEvent(tx, {
    orderId: order.id,
    eventType: status === "COMPLETED" ? "ORDER_COMPLETED" : "ORDER_CANCELLED",
    accountObligation: "NONE",
    businessRef: order.id,
    actorType: "SYSTEM",
    currencyCode: order.currencyCode,
    amountMinor: 0,
    idempotencyKey: `${status === "COMPLETED" ? "order-completed" : "order-cancelled"}:${order.id}`,
    authorizationContext: { source: "TERMINAL_ACCOUNTING" },
    data: {
      status,
      issue: order.data?.issue ?? null,
      subtotalMinor: order.subtotalMinor,
    },
  });

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
    await postCompletedOrderJournal(tx, order);
    // A refund verified before completion must not leave commission charged on money
    // the buyer already got back. The reversal is journaled against the accrual.
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.orderId, order.id));
    if (intent && intent.refundedAmountMinor > 0)
      await recordCommissionReversal(tx, {
        order,
        refundAmountMinor: intent.refundedAmountMinor,
        previouslyRefundedMinor: 0,
        businessRef: `capture-refunds:${intent.id}`,
      });
    return Boolean(due);
  }
  return false;
}