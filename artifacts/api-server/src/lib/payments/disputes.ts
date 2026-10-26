import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  disputes,
  orders,
  paymentDisputeEvents,
  paymentEvents,
  paymentIntents,
} from "@workspace/db";

type Transaction = any;
type Order = typeof orders.$inferSelect;
type Dispute = typeof disputes.$inferSelect;

function orderSnapshot(order: Order) {
  return {
    commissionRateBps:
      typeof order.data.commissionRateBps === "number"
        ? order.data.commissionRateBps
        : 1_000,
    platformFeeMinor: order.platformFeeMinor,
    sellerAmountMinor: order.sellerAmountMinor,
  };
}

async function insertDisputeEvent(
  tx: Transaction,
  values: {
    paymentIntentId: string;
    disputeId: string;
    sourcePaymentEventId?: string | null;
    eventType: "DISPUTE_OPENED" | "PAYMENT_CAPTURED" | "DISPUTE_RESOLVED";
    financialOutcome:
      | "HOLD_PENDING"
      | "HOLD_CAPTURED"
      | "BUYER_REFUND_DUE"
      | "SELLER_RELEASE_DUE";
    amountMinor: number;
    currencyCode: string;
    commissionRateBps: number;
    platformFeeMinor: number;
    sellerAmountMinor: number;
  },
) {
  const [inserted] = await tx
    .insert(paymentDisputeEvents)
    .values({
      id: randomUUID(),
      ...values,
      sourcePaymentEventId: values.sourcePaymentEventId ?? null,
      mode: "SIMULATION_ONLY",
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  const [existing] = await tx
    .select()
    .from(paymentDisputeEvents)
    .where(
      and(
        eq(paymentDisputeEvents.paymentIntentId, values.paymentIntentId),
        eq(paymentDisputeEvents.disputeId, values.disputeId),
        eq(paymentDisputeEvents.eventType, values.eventType),
      ),
    );
  if (
    !existing ||
    existing.disputeId !== values.disputeId ||
    existing.eventType !== values.eventType ||
    existing.sourcePaymentEventId !== (values.sourcePaymentEventId ?? null) ||
    existing.financialOutcome !== values.financialOutcome ||
    existing.amountMinor !== values.amountMinor ||
    existing.currencyCode !== values.currencyCode ||
    existing.commissionRateBps !== values.commissionRateBps ||
    existing.platformFeeMinor !== values.platformFeeMinor ||
    existing.sellerAmountMinor !== values.sellerAmountMinor
  ) {
    throw new Error(
      "Payment dispute audit event conflicts with stored history",
    );
  }
  return existing;
}

export async function recordOrderDisputeOpened(
  tx: Transaction,
  order: Order,
  dispute: Dispute,
) {
  if (order.id !== dispute.orderId)
    throw new Error("Payment dispute does not belong to the order");
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.orderId, order.id))
    .for("update");
  if (!intent) return null;
  if (intent.disputeId) {
    if (intent.disputeId !== dispute.id)
      throw new Error("Payment intent is already linked to another dispute");
    return intent;
  }

  let sourcePaymentEventId: string | null = null;
  if (intent.capturedAmountMinor > 0) {
    const [captureEvent] = await tx
      .select()
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.paymentIntentId, intent.id),
          eq(paymentEvents.eventType, "CAPTURE_SUCCEEDED"),
        ),
      );
    if (
      !captureEvent ||
      captureEvent.amountMinor !== intent.capturedAmountMinor ||
      captureEvent.currencyCode !== intent.currencyCode
    ) {
      throw new Error("Captured payment intent has no matching capture event");
    }
    sourcePaymentEventId = captureEvent.id;
  }

  const remainingCaptured =
    intent.capturedAmountMinor - intent.refundedAmountMinor;
  await insertDisputeEvent(tx, {
    paymentIntentId: intent.id,
    disputeId: dispute.id,
    sourcePaymentEventId,
    eventType: "DISPUTE_OPENED",
    financialOutcome:
      intent.capturedAmountMinor > 0 ? "HOLD_CAPTURED" : "HOLD_PENDING",
    amountMinor: remainingCaptured,
    currencyCode: intent.currencyCode,
    ...orderSnapshot(order),
  });

  const [updated] = await tx
    .update(paymentIntents)
    .set({
      disputeId: dispute.id,
      status: "SIMULATION_DISPUTED",
      updatedAt: new Date(),
    })
    .where(eq(paymentIntents.id, intent.id))
    .returning();
  return updated;
}

export async function recordPaymentCapturedOnDisputedOrder(
  tx: Transaction,
  input: {
    intent: typeof paymentIntents.$inferSelect;
    order: Order;
    dispute: Dispute;
    paymentEventId: string;
    capturedAmountMinor: number;
    refundedAmountMinor: number;
  },
) {
  if (
    input.dispute.status !== "OPEN" &&
    !(
      input.dispute.status === "RESOLVED" &&
      ["BUYER", "SELLER"].includes(input.dispute.resolution ?? "")
    )
  ) {
    throw new Error("Payment capture cannot follow an invalid dispute state");
  }
  const isOpen = input.dispute.status === "OPEN";
  const financialOutcome = isOpen
    ? "HOLD_CAPTURED"
    : input.dispute.resolution === "BUYER"
      ? "BUYER_REFUND_DUE"
      : "SELLER_RELEASE_DUE";
  const amountMinor =
    financialOutcome === "SELLER_RELEASE_DUE"
      ? input.order.sellerAmountMinor
      : Math.max(
          0,
          input.capturedAmountMinor - input.refundedAmountMinor,
        );
  await insertDisputeEvent(tx, {
    paymentIntentId: input.intent.id,
    disputeId: input.dispute.id,
    sourcePaymentEventId: input.paymentEventId,
    eventType: "PAYMENT_CAPTURED",
    financialOutcome,
    amountMinor,
    currencyCode: input.intent.currencyCode,
    ...orderSnapshot(input.order),
  });
  return isOpen
    ? "SIMULATION_DISPUTED"
    : input.dispute.resolution === "BUYER"
      ? "SIMULATION_BUYER_REFUND_DUE"
      : "SIMULATION_SELLER_RELEASE_DUE";
}

export async function recordOrderDisputeResolved(
  tx: Transaction,
  order: Order,
  dispute: Dispute,
  resolution: "BUYER" | "SELLER",
) {
  if (order.id !== dispute.orderId)
    throw new Error("Payment dispute does not belong to the order");
  let [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.orderId, order.id))
    .for("update");
  if (!intent) return null;
  if (!intent.disputeId) {
    intent = await recordOrderDisputeOpened(tx, order, dispute);
  }
  if (!intent || intent.disputeId !== dispute.id)
    throw new Error("Payment intent and dispute linkage do not match");

  const financialOutcome =
    resolution === "BUYER" ? "BUYER_REFUND_DUE" : "SELLER_RELEASE_DUE";
  const amountMinor =
    resolution === "BUYER"
      ? Math.max(
          0,
          intent.capturedAmountMinor - intent.refundedAmountMinor,
        )
      : order.sellerAmountMinor;
  await insertDisputeEvent(tx, {
    paymentIntentId: intent.id,
    disputeId: dispute.id,
    eventType: "DISPUTE_RESOLVED",
    financialOutcome,
    amountMinor,
    currencyCode: intent.currencyCode,
    ...orderSnapshot(order),
  });

  const [updated] = await tx
    .update(paymentIntents)
    .set({
      status:
        resolution === "BUYER"
          ? "SIMULATION_BUYER_REFUND_DUE"
          : "SIMULATION_SELLER_RELEASE_DUE",
      updatedAt: new Date(),
    })
    .where(eq(paymentIntents.id, intent.id))
    .returning();
  return updated;
}