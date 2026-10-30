import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { messages, offers, orderItems, orders, paymentIntents } from "@workspace/db";
import { settleOrderFulfillment } from "./delivery";
import { recordRefundObligation } from "./payments/obligations";
import { recordOrderFinancialEvent } from "./order-journal";

/**
 * Cancels a CREATED order whose seller-acceptance window lapsed and releases its reservation.
 * The caller holds the order row lock. A payment already captured for the order is not
 * discarded: it becomes one REFUND_DUE obligation in the same transaction (owner policy D3).
 */
export async function expireOrderReservation(
  tx: any,
  row: typeof orders.$inferSelect,
  now: Date,
) {
  if (row.status !== "CREATED")
    throw new Error(`Order ${row.id} cannot expire from ${row.status}`);
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, row.id))
    .orderBy(orderItems.offerId);
  for (const item of items) {
    if (item.data.inventoryMode !== "LIMITED") continue;
    const [offer] = await tx
      .select()
      .from(offers)
      .where(eq(offers.id, item.offerId))
      .for("update");
    if (!offer) continue;
    await tx
      .update(offers)
      .set({
        reservedQuantity: Math.max(0, offer.reservedQuantity - item.quantity),
        updatedAt: now,
      })
      .where(eq(offers.id, offer.id));
  }
  await settleOrderFulfillment(tx, row.id, "CANCELLED", now);
  const data = {
    ...row.data,
    issue: "انتهت مهلة قبول الطلب",
    reservationReleasedAt: now.toISOString(),
  };
  const [updated] = await tx
    .update(orders)
    .set({ status: "CANCELLED", data, updatedAt: now })
    .where(eq(orders.id, row.id))
    .returning();
  await recordOrderFinancialEvent(tx, {
    orderId: row.id,
    eventType: "ORDER_CANCELLED",
    accountObligation: "NONE",
    businessRef: row.id,
    actorType: "SYSTEM",
    currencyCode: row.currencyCode,
    amountMinor: 0,
    idempotencyKey: `order-cancelled:${row.id}`,
    authorizationContext: { source: "RESERVATION_EXPIRY" },
    data: { status: "CANCELLED", issue: data.issue },
  });
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.orderId, row.id))
    .for("update");
  if (intent && intent.capturedAmountMinor > intent.refundedAmountMinor)
    await recordRefundObligation(tx, { intent, reason: "RESERVATION_EXPIRED" });
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: row.id,
    body: "انتهت مهلة قبول الطلب وأُعيد المخزون المحجوز.",
  });
  return updated as typeof orders.$inferSelect;
}
