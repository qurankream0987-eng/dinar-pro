import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { unwrapWebhook, WebhookVerificationError } from "@whop/sdk/helpers";
import {
  db,
  messages,
  orders,
  whopAccounts,
  whopCheckouts,
  whopDisputes,
  whopEvents,
  whopRefunds,
} from "@workspace/db";
import { whopConfig } from "./config";
import { deriveAccountStatus, moneyToMinor } from "./account-state";
import { whopRefusal } from "./errors";

type Json = Record<string, any>;

export type WebhookResult = { status: number; body: Json };

class PermanentWebhookError extends Error {
  constructor(readonly result: string) {
    super(result);
    this.name = "PermanentWebhookError";
  }
}

function headerMap(headers: Record<string, unknown>) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key.toLowerCase()] = value;
    else if (Array.isArray(value) && typeof value[0] === "string")
      result[key.toLowerCase()] = value[0];
  }
  return result;
}

export function verifyAndParseWebhook(
  raw: Buffer,
  headers: Record<string, unknown>,
): Json {
  const config = whopConfig();
  if (!config.configured || !config.webhookSecret)
    throw whopRefusal(404, "Not found", "WHOP_NOT_CONFIGURED");
  const map = headerMap(headers);
  try {
    return unwrapWebhook<Json>(raw.toString("utf8"), {
      headers: map,
      key: config.webhookSecret,
    });
  } catch (error) {
    if (error instanceof WebhookVerificationError)
      throw whopRefusal(401, "توقيع الحدث غير صالح", "WHOP_WEBHOOK_INVALID");
    throw error;
  }
}

function eventIdentity(body: Json, headers: Record<string, unknown>) {
  const map = headerMap(headers);
  const id =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : map["webhook-id"];
  const type =
    typeof body.type === "string"
      ? body.type
      : typeof body.event === "string"
        ? body.event
        : "";
  if (!id || id.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(id))
    throw whopRefusal(400, "حدث بلا معرف صالح", "WHOP_WEBHOOK_INVALID");
  return { id, type };
}

function paymentOf(body: Json): Json | null {
  const data = body.data;
  if (!data || typeof data !== "object") return null;
  const candidate = data.payment ?? data;
  return candidate && typeof candidate.id === "string" ? candidate : null;
}

function refundOf(body: Json): Json | null {
  const data = body.data;
  if (!data || typeof data !== "object") return null;
  const candidate = data.refund ?? data;
  return candidate && typeof candidate.id === "string" ? candidate : null;
}

function caseOf(body: Json): Json | null {
  const data = body.data;
  if (!data || typeof data !== "object") return null;
  const candidate = data.case ?? data.resolution_center_case ?? data.dispute ?? data;
  return candidate && (typeof candidate.id === "string" || typeof candidate.case_id === "string")
    ? candidate
    : null;
}

async function checkoutForPayment(tx: any, payment: Json) {
  const checkoutId =
    typeof payment.checkout_configuration_id === "string"
      ? payment.checkout_configuration_id
      : null;
  if (checkoutId) {
    const [row] = await tx
      .select()
      .from(whopCheckouts)
      .where(eq(whopCheckouts.whopCheckoutId, checkoutId));
    if (row) return row;
  }
  const orderId = payment.metadata?.dinar_order_id;
  if (typeof orderId === "string") {
    const [row] = await tx
      .select()
      .from(whopCheckouts)
      .where(eq(whopCheckouts.orderId, orderId));
    if (row) return row;
  }
  const [byPayment] = await tx
    .select()
    .from(whopCheckouts)
    .where(eq(whopCheckouts.whopPaymentId, payment.id));
  return byPayment ?? null;
}

async function appendSystemMessage(tx: any, orderId: string, text: string) {
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: orderId,
    senderId: null,
    body: text,
    actor: "SYSTEM",
    contentType: "TEXT",
    metadata: {},
  });
}

async function recordRefundDue(
  tx: any,
  input: {
    checkout: typeof whopCheckouts.$inferSelect;
    order: typeof orders.$inferSelect;
    payment: Json;
    amountMinor: number;
    reason: string;
  },
) {
  const idempotencyKey = `whop-refund-due:${input.payment.id}`;
  const [created] = await tx
    .insert(whopRefunds)
    .values({
      id: randomUUID(),
      orderId: input.order.id,
      whopPaymentId: input.payment.id,
      idempotencyKey,
      amountUsdMinor: input.amountMinor,
      status: "REFUND_DUE",
      reason: input.reason,
      requestedBy: null,
      data: { checkoutId: input.checkout.whopCheckoutId, automatic: true },
    })
    .onConflictDoNothing()
    .returning();
  // `created` is one row (or undefined on a replay): read the existing row only in that case.
  const row =
    created ??
    (
      await tx
        .select()
        .from(whopRefunds)
        .where(eq(whopRefunds.idempotencyKey, idempotencyKey))
    )[0];
  await tx
    .update(whopCheckouts)
    .set({ status: "REFUND_DUE", whopPaymentId: input.payment.id, updatedAt: new Date() })
    .where(eq(whopCheckouts.id, input.checkout.id));
  return row;
}

async function handlePaymentSucceeded(tx: any, payment: Json): Promise<string> {
  if (payment.status !== "paid")
    throw new PermanentWebhookError(`payment_status_${payment.status ?? "unknown"}`);
  if (payment.currency !== "usd")
    throw new PermanentWebhookError("payment_currency_mismatch");
  const amountMinor = moneyToMinor(payment.total, "usd");
  if (amountMinor === null) throw new PermanentWebhookError("payment_amount_invalid");

  const checkout = await checkoutForPayment(tx, payment);
  if (!checkout) return "unrelated_payment";

  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, checkout.orderId))
    .for("update");
  if (!order) throw new PermanentWebhookError("checkout_order_missing");

  const [sellerAccount] = await tx
    .select()
    .from(whopAccounts)
    .where(eq(whopAccounts.sellerUserId, checkout.sellerUserId));
  if (!sellerAccount || sellerAccount.whopAccountId !== payment.account_id)
    throw new PermanentWebhookError("payment_account_mismatch");

  if (amountMinor !== checkout.amountUsdMinor)
    throw new PermanentWebhookError("payment_amount_mismatch");

  const [lockedCheckout] = await tx
    .select()
    .from(whopCheckouts)
    .where(eq(whopCheckouts.id, checkout.id))
    .for("update");
  if (!lockedCheckout) throw new PermanentWebhookError("checkout_missing");

  if (lockedCheckout.status === "SUCCEEDED") {
    if (lockedCheckout.whopPaymentId === payment.id) return "already_succeeded";
    // A second settled payment for the same order is never kept: it becomes one refund obligation.
    await recordRefundDue(tx, {
      checkout: lockedCheckout,
      order,
      payment,
      amountMinor,
      reason: "DUPLICATE_PAYMENT",
    });
    return "duplicate_payment_refund_due";
  }

  const lapsed =
    order.status === "CANCELLED" ||
    (order.status === "CREATED" &&
      order.reservationExpiresAt !== null &&
      order.reservationExpiresAt <= new Date());
  if (lapsed) {
    await recordRefundDue(tx, {
      checkout: lockedCheckout,
      order,
      payment,
      amountMinor,
      reason: order.status === "CANCELLED" ? "ORDER_CANCELLED" : "RESERVATION_EXPIRED",
    });
    await appendSystemMessage(
      tx,
      order.id,
      "وصلت دفعة بعد إلغاء الطلب أو انتهاء حجزه، فسُجلت obligation استرداد كاملة. لا تُعدّ بيعًا حتى ينجح الاسترداد.",
    );
    return "refund_due_recorded";
  }

  const paidAt =
    typeof payment.paid_at === "string" ? payment.paid_at : new Date().toISOString();
  const data = {
    ...order.data,
    whopPayment: {
      provider: "whop",
      paymentId: payment.id,
      checkoutId: lockedCheckout.whopCheckoutId,
      amountUsdMinor: amountMinor,
      feeUsdMinor: lockedCheckout.feeUsdMinor,
      paidAt,
      environment: whopConfig().environment,
    },
  };
  await tx
    .update(orders)
    .set({ data, updatedAt: new Date() })
    .where(eq(orders.id, order.id));
  await tx
    .update(whopCheckouts)
    .set({ status: "SUCCEEDED", whopPaymentId: payment.id, updatedAt: new Date() })
    .where(eq(whopCheckouts.id, lockedCheckout.id));
  await appendSystemMessage(
    tx,
    order.id,
    `تم استلام الدفعة عبر Whop (${(amountMinor / 100).toFixed(2)} USD). الإيصال: ${payment.id}.`,
  );
  return "payment_recorded";
}

const REFUND_STATUS: Record<string, "REQUESTED" | "SUCCEEDED" | "FAILED"> = {
  pending: "REQUESTED",
  requires_action: "REQUESTED",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  canceled: "FAILED",
};

async function handleRefund(tx: any, refund: Json): Promise<string> {
  const status = REFUND_STATUS[String(refund.status)] ?? "REQUESTED";
  const amountMinor =
    moneyToMinor(refund.original_amount, "usd") ??
    moneyToMinor(refund.amount, "usd");
  const paymentId = typeof refund.payment_id === "string" ? refund.payment_id : null;

  const [byId] = await tx
    .select()
    .from(whopRefunds)
    .where(eq(whopRefunds.whopRefundId, refund.id));
  let target = byId ?? null;
  if (!target && paymentId) {
    const [open] = await tx
      .select()
      .from(whopRefunds)
      .where(
        and(
          eq(whopRefunds.whopPaymentId, paymentId),
          eq(whopRefunds.status, "REFUND_DUE"),
        ),
      );
    target = open ?? null;
  }
  if (!target && typeof refund.metadata?.dinar_refund_id === "string") {
    const [requested] = await tx
      .select()
      .from(whopRefunds)
      .where(eq(whopRefunds.id, refund.metadata.dinar_refund_id));
    target = requested ?? null;
  }
  if (!target) return "unrelated_refund";

  const [updated] = await tx
    .update(whopRefunds)
    .set({
      whopRefundId: refund.id,
      status,
      amountUsdMinor: amountMinor ?? target.amountUsdMinor,
      data: { ...target.data, providerStatus: refund.status ?? null },
      updatedAt: new Date(),
    })
    .where(eq(whopRefunds.id, target.id))
    .returning();

  if (status === "SUCCEEDED")
    await appendSystemMessage(
      tx,
      updated.orderId,
      `تم رد مبلغ ${(updated.amountUsdMinor / 100).toFixed(2)} USD عبر Whop (${refund.id}).`,
    );
  return `refund_${status.toLowerCase()}`;
}

async function handleDispute(tx: any, dispute: Json): Promise<string> {
  const caseId = String(dispute.id ?? dispute.case_id);
  const paymentId =
    typeof dispute.payment_id === "string" ? dispute.payment_id : null;
  let orderId: string | null = null;
  if (paymentId) {
    const [checkout] = await tx
      .select()
      .from(whopCheckouts)
      .where(eq(whopCheckouts.whopPaymentId, paymentId));
    orderId = checkout?.orderId ?? null;
  }
  const amountMinor = moneyToMinor(dispute.amount, "usd");
  await tx
    .insert(whopDisputes)
    .values({
      id: randomUUID(),
      orderId,
      whopCaseId: caseId,
      whopPaymentId: paymentId,
      status: String(dispute.status ?? "unknown").slice(0, 64),
      amountUsdMinor: amountMinor,
      data: { caseNumber: dispute.case_number ?? null },
    })
    .onConflictDoUpdate({
      target: whopDisputes.whopCaseId,
      set: {
        status: String(dispute.status ?? "unknown").slice(0, 64),
        amountUsdMinor: amountMinor,
        updatedAt: new Date(),
      },
    });
  return "dispute_recorded";
}

async function handleAccountEvent(tx: any, eventType: string, body: Json) {
  const data = body.data && typeof body.data === "object" ? body.data : {};
  const accountId =
    typeof data.account_id === "string"
      ? data.account_id
      : typeof data.company_id === "string"
        ? data.company_id
        : typeof data.id === "string" && data.id.startsWith("biz_")
          ? data.id
          : null;
  if (!accountId) return "account_unidentified";
  const [row] = await tx
    .select()
    .from(whopAccounts)
    .where(eq(whopAccounts.whopAccountId, accountId));
  if (!row) return "account_not_linked";

  // The payload may not carry the full account shape. When it does, persist its
  // verification state; otherwise the seller's refresh endpoint reads it from Whop.
  if (data.verification && typeof data.verification === "object") {
    const derived = deriveAccountStatus(data as any);
    await tx
      .update(whopAccounts)
      .set({
        status: derived.status,
        identityStatus: derived.identityStatus,
        verificationStatus: derived.verificationStatus,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(whopAccounts.id, row.id));
    return `account_${eventType}_synced`;
  }
  if (eventType === "verification.succeeded") {
    await tx
      .update(whopAccounts)
      .set({ status: "VERIFIED", verificationStatus: "approved", lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(whopAccounts.id, row.id));
    return "account_verified";
  }
  return "account_event_recorded";
}

async function dispatch(body: Json, eventType: string): Promise<string> {
  if (eventType === "payment.succeeded") {
    const payment = paymentOf(body);
    if (!payment) throw new PermanentWebhookError("payment_payload_invalid");
    return db.transaction((tx) => handlePaymentSucceeded(tx, payment));
  }
  if (eventType === "refund.created" || eventType === "refund.updated") {
    const refund = refundOf(body);
    if (!refund) throw new PermanentWebhookError("refund_payload_invalid");
    return db.transaction((tx) => handleRefund(tx, refund));
  }
  if (
    eventType.startsWith("resolution_center_case.") ||
    eventType === "dispute.created" ||
    eventType === "dispute.updated"
  ) {
    const dispute = caseOf(body);
    if (!dispute) throw new PermanentWebhookError("dispute_payload_invalid");
    return db.transaction((tx) => handleDispute(tx, dispute));
  }
  if (
    eventType.startsWith("transfer.") ||
    eventType.startsWith("payout.") ||
    eventType.startsWith("withdrawal.")
  )
    return "money_movement_observed";
  if (
    eventType === "verification.succeeded" ||
    eventType.startsWith("identity_profile.") ||
    eventType === "account.updated" ||
    eventType === "payout_account.status_updated"
  )
    return db.transaction((tx) => handleAccountEvent(tx, eventType, body));
  return "ignored_event_type";
}

/**
 * The endpoint's whole job: verify, claim the provider event id once, then apply its
 * effect in one transaction. A replay is answered from the ledger without moving money.
 */
export async function receiveWhopWebhook(
  raw: Buffer,
  headers: Record<string, unknown>,
): Promise<WebhookResult> {
  const body = verifyAndParseWebhook(raw, headers);
  const { id, type } = eventIdentity(body, headers);
  if (!type) throw whopRefusal(400, "حدث بلا نوع", "WHOP_WEBHOOK_INVALID");
  const payloadSha256 = createHash("sha256").update(raw).digest("hex");

  const claimed = await db
    .insert(whopEvents)
    .values({
      id: randomUUID(),
      eventId: id,
      eventType: type.slice(0, 120),
      payloadSha256,
      processingStatus: "FAILED",
      result: "PROCESSING",
    })
    .onConflictDoNothing()
    .returning();
  if (!claimed.length) return { status: 200, body: { received: true, duplicate: true } };

  try {
    const result = await dispatch(body, type);
    const status = result === "ignored_event_type" ? "IGNORED" : "PROCESSED";
    await db
      .update(whopEvents)
      .set({ processingStatus: status, result: result.slice(0, 500), updatedAt: new Date() })
      .where(eq(whopEvents.id, claimed[0].id));
    return { status: 200, body: { received: true, result } };
  } catch (error) {
    if (error instanceof PermanentWebhookError) {
      await db
        .update(whopEvents)
        .set({ processingStatus: "FAILED", result: error.result, updatedAt: new Date() })
        .where(eq(whopEvents.id, claimed[0].id));
      // Answering 200 stops a retry that would fail identically; the ledger carries the proof.
      return { status: 200, body: { received: true, result: error.result } };
    }
    // A transient failure releases the claim so Whop's retry can process the event.
    await db.delete(whopEvents).where(eq(whopEvents.id, claimed[0].id));
    throw error;
  }
}
