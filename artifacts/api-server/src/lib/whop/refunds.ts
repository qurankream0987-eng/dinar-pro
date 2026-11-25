import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, whopCheckouts, whopRefunds } from "@workspace/db";
import { whopConfig } from "./config";
import { whopClient } from "./client";
import { whopRefusal } from "./errors";
import { moneyToMinor } from "./account-state";

export type WhopRefundView = {
  id: string;
  orderId: string;
  paymentId: string;
  refundId: string | null;
  amountUsd: number;
  status: "REFUND_DUE" | "REQUESTED" | "SUCCEEDED" | "FAILED";
  reason: string;
  createdAt: string;
};

function view(row: typeof whopRefunds.$inferSelect): WhopRefundView {
  return {
    id: row.id,
    orderId: row.orderId,
    paymentId: row.whopPaymentId,
    refundId: row.whopRefundId,
    amountUsd: Number((row.amountUsdMinor / 100).toFixed(2)),
    status: row.status as WhopRefundView["status"],
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * An administrator refunds a settled Whop payment. The amount is always read from the
 * provider's payment, never from the request, and the request names a row before the
 * provider is called so a retry cannot issue two refunds.
 */
export async function refundWhopPayment(input: {
  orderId: string;
  adminId: string;
  idempotencyKey: string;
  amountUsdMinor?: number;
  reason: string;
}): Promise<{ refund: WhopRefundView; duplicate: boolean }> {
  const config = whopConfig();
  if (!config.configured)
    throw whopRefusal(503, "لم تُهيأ بوابة الدفع بعد", "WHOP_NOT_CONFIGURED");

  const [existing] = await db
    .select()
    .from(whopRefunds)
    .where(eq(whopRefunds.idempotencyKey, input.idempotencyKey));
  if (existing) return { refund: view(existing), duplicate: true };

  const [checkout] = await db
    .select()
    .from(whopCheckouts)
    .where(eq(whopCheckouts.orderId, input.orderId));
  if (!checkout || !["SUCCEEDED", "REFUND_DUE"].includes(checkout.status))
    throw whopRefusal(409, "لا توجد دفعة محصّلة لهذا الطلب", "WHOP_PAYMENT_NOT_SETTLED");
  if (!checkout.whopPaymentId)
    throw whopRefusal(409, "لا توجد دفعة معروفة لهذا الطلب", "WHOP_PAYMENT_MISSING");

  const client = whopClient(config);
  const payment = await client.payments.retrieve({ id: checkout.whopPaymentId });
  if (payment.currency !== "usd")
    throw whopRefusal(409, "عملة الدفعة غير مدعومة للاسترداد", "WHOP_CURRENCY_UNSUPPORTED");
  const totalMinor = moneyToMinor(payment.total, "usd");
  const alreadyRefundedMinor =
    moneyToMinor(payment.refunded_amount, "usd") ?? 0;
  if (!totalMinor)
    throw whopRefusal(409, "قيمة الدفعة غير صالحة للاسترداد", "WHOP_AMOUNT_INVALID");
  const remainingMinor = totalMinor - alreadyRefundedMinor;
  if (remainingMinor <= 0)
    throw whopRefusal(409, "لا يوجد مبلغ متبقٍ للاسترداد", "WHOP_NOTHING_TO_REFUND");

  const amountMinor = input.amountUsdMinor ?? remainingMinor;
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor > remainingMinor
  )
    throw whopRefusal(
      400,
      `المبلغ القابل للاسترداد الآن ${(remainingMinor / 100).toFixed(2)} USD`,
      "WHOP_REFUND_AMOUNT_INVALID",
    );

  const [row] = await db
    .insert(whopRefunds)
    .values({
      id: randomUUID(),
      orderId: input.orderId,
      whopPaymentId: checkout.whopPaymentId,
      idempotencyKey: input.idempotencyKey,
      amountUsdMinor: amountMinor,
      status: "REQUESTED",
      reason: input.reason.slice(0, 500),
      requestedBy: input.adminId,
      data: { full: amountMinor === remainingMinor },
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [raced] = await db
      .select()
      .from(whopRefunds)
      .where(eq(whopRefunds.idempotencyKey, input.idempotencyKey));
    if (!raced) throw new Error("Whop refund row disappeared after a conflicting insert");
    return { refund: view(raced), duplicate: true };
  }

  try {
    // Whop answers with the updated payment; the provider's refund id arrives with the
    // signed `refund.*` webhook, so a successful call only proves the request was accepted.
    const updatedPayment = await client.payments.refund({
      id: checkout.whopPaymentId,
      metadata: { dinar_refund_id: row.id },
      ...(amountMinor === remainingMinor
        ? {}
        : { partial_amount: amountMinor / 100 }),
    });
    const settledMinor =
      moneyToMinor(updatedPayment.refunded_amount, "usd") ?? alreadyRefundedMinor;
    const status = settledMinor >= alreadyRefundedMinor + amountMinor
      ? "SUCCEEDED"
      : "REQUESTED";
    const [updated] = await db
      .update(whopRefunds)
      .set({
        status,
        data: {
          ...row.data,
          providerRefundedMinor: settledMinor,
          providerPaymentStatus: updatedPayment.status ?? null,
        },
        updatedAt: new Date(),
      })
      .where(eq(whopRefunds.id, row.id))
      .returning();
    return { refund: view(updated), duplicate: false };
  } catch (error) {
    await db
      .update(whopRefunds)
      .set({
        status: "FAILED",
        data: {
          ...row.data,
          failure: error instanceof Error ? error.message.slice(0, 500) : "unknown",
        },
        updatedAt: new Date(),
      })
      .where(eq(whopRefunds.id, row.id));
    throw whopRefusal(502, "تعذر تنفيذ الاسترداد لدى Whop", "WHOP_REFUND_FAILED");
  }
}

export async function listWhopRefunds(orderId?: string) {
  const rows = orderId
    ? await db
        .select()
        .from(whopRefunds)
        .where(eq(whopRefunds.orderId, orderId))
        .orderBy(desc(whopRefunds.createdAt))
    : await db
        .select()
        .from(whopRefunds)
        .orderBy(desc(whopRefunds.createdAt))
        .limit(100);
  return rows.map(view);
}
