import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  paymentEvents,
  paymentIntents,
  paymentRefundObligations,
} from "@workspace/db";

type Intent = typeof paymentIntents.$inferSelect;
export type RefundObligationReason =
  | "RESERVATION_EXPIRED"
  | "CAPTURE_AFTER_CANCELLATION";

/**
 * Owner policy D3: a verified payment on an order that was cancelled becomes one durable
 * REFUND_DUE obligation. The intent must already be locked by the caller and carry the
 * capture; the order's cancellation happens in the same transaction. Idempotent: a second
 * call for the same intent returns the existing obligation. Nothing here moves money.
 */
export async function recordRefundObligation(
  tx: any,
  input: {
    intent: Intent;
    reason: RefundObligationReason;
    sourcePaymentEventId?: string;
  },
) {
  const { intent } = input;
  const owedMinor = intent.capturedAmountMinor - intent.refundedAmountMinor;
  if (intent.disputeId || owedMinor <= 0) return null;
  if (
    ![
      "SIMULATION_CAPTURED",
      "SIMULATION_PARTIALLY_REFUNDED",
      "SIMULATION_BUYER_REFUND_DUE",
    ].includes(intent.status)
  )
    throw new Error(`Payment intent ${intent.id} cannot owe a refund from ${intent.status}`);

  let sourcePaymentEventId = input.sourcePaymentEventId;
  if (!sourcePaymentEventId) {
    const [capture] = await tx
      .select({ id: paymentEvents.id })
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.paymentIntentId, intent.id),
          eq(paymentEvents.eventType, "CAPTURE_SUCCEEDED"),
        ),
      );
    if (!capture)
      throw new Error(`Payment intent ${intent.id} has no capture evidence`);
    sourcePaymentEventId = capture.id;
  }

  if (intent.status !== "SIMULATION_BUYER_REFUND_DUE")
    await tx
      .update(paymentIntents)
      .set({ status: "SIMULATION_BUYER_REFUND_DUE", updatedAt: new Date() })
      .where(eq(paymentIntents.id, intent.id));

  const [created] = await tx
    .insert(paymentRefundObligations)
    .values({
      id: randomUUID(),
      paymentIntentId: intent.id,
      orderId: intent.orderId,
      sourcePaymentEventId,
      reason: input.reason,
      amountMinor: owedMinor,
      currencyCode: intent.currencyCode,
      status: "OPEN",
      mode: "SIMULATION_ONLY",
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [existing] = await tx
    .select()
    .from(paymentRefundObligations)
    .where(eq(paymentRefundObligations.paymentIntentId, intent.id));
  return existing;
}

/** Marks the intent's open obligation resolved by the provider's REFUND_SUCCEEDED event. */
export async function resolveRefundObligation(
  tx: any,
  input: { paymentIntentId: string; refundEventId: string; now: Date },
) {
  await tx
    .update(paymentRefundObligations)
    .set({
      status: "RESOLVED",
      resolvedRefundEventId: input.refundEventId,
      resolvedAt: input.now,
    })
    .where(
      and(
        eq(paymentRefundObligations.paymentIntentId, input.paymentIntentId),
        eq(paymentRefundObligations.status, "OPEN"),
      ),
    );
}

/** The administration's reconciliation queue: obligations newest first. */
export async function listRefundObligations(status?: "OPEN" | "RESOLVED") {
  const rows = await db
    .select()
    .from(paymentRefundObligations)
    .where(status ? eq(paymentRefundObligations.status, status) : undefined)
    .orderBy(desc(paymentRefundObligations.createdAt))
    .limit(200);
  return rows.map((row) => ({
    id: row.id,
    paymentIntentId: row.paymentIntentId,
    orderId: row.orderId,
    reason: row.reason,
    amountMinor: row.amountMinor,
    currencyCode: row.currencyCode,
    status: row.status,
    resolvedRefundEventId: row.resolvedRefundEventId,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    mode: row.mode,
  }));
}
