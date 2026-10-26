import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  disputes,
  orders,
  paymentDisputeEvents,
  paymentEvents,
  paymentIntents,
  paymentReconciliationItems,
  paymentReconciliationRuns,
  paymentRefundObligations,
  paymentRefunds,
} from "@workspace/db";
import type {
  PaymentProviderAdapter,
  PaymentWebhookEvent,
  ProviderPaymentSnapshot,
} from "./contracts";
import { paymentWebhookDigest } from "./contracts";
import {
  recordPaymentCapturedOnDisputedOrder,
} from "./disputes";
import { expireOrderReservation } from "../order-expiry";
import {
  recordRefundObligation,
  resolveRefundObligation,
  type RefundObligationReason,
} from "./obligations";

export class PaymentCoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "PaymentCoreError";
  }
}

function reject(status: number, code: string, message: string): never {
  throw new PaymentCoreError(message, status, code);
}

export function paymentIntentView(row: typeof paymentIntents.$inferSelect) {
  return {
    id: row.id,
    orderId: row.orderId,
    amountMinor: row.amountMinor,
    currencyCode: row.currencyCode,
    status: row.status,
    capturedAmountMinor: row.capturedAmountMinor,
    refundedAmountMinor: row.refundedAmountMinor,
    disputeId: row.disputeId,
    mode: row.mode,
  };
}

export async function createPaymentIntent(input: {
  buyerId: string;
  orderId: string;
  idempotencyKey: string;
  providerKey: string;
  providerIntentId: string;
}) {
  const result = await db.transaction(async (tx) => {
    const [byKey] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.buyerId, input.buyerId),
          eq(paymentIntents.idempotencyKey, input.idempotencyKey),
        ),
      )
      .for("update");
    if (byKey) {
      if (byKey.orderId !== input.orderId)
        reject(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used");
      return { row: byKey, created: false };
    }

    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update");
    if (!order || order.buyerId !== input.buyerId)
      reject(404, "ORDER_NOT_FOUND", "Order was not found");
    if (
      order.status !== "CREATED" ||
      order.data.paymentMode !== "TEST_NO_TRANSFER" ||
      !order.reservationExpiresAt ||
      order.reservationExpiresAt.getTime() <= Date.now()
    ) {
      reject(409, "ORDER_NOT_PAYABLE", "Order is not eligible for a test intent");
    }

    const [existingForOrder] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.orderId, input.orderId))
      .for("update");
    // A retry of the same request that waited on the order lock sees the intent its twin
    // created: same buyer and key is the same request, not a conflict.
    if (
      existingForOrder?.buyerId === input.buyerId &&
      existingForOrder.idempotencyKey === input.idempotencyKey
    )
      return { row: existingForOrder, created: false };
    if (existingForOrder)
      reject(409, "ORDER_INTENT_EXISTS", "Order already has a payment intent");

    const [row] = await tx
      .insert(paymentIntents)
      .values({
        id: randomUUID(),
        orderId: order.id,
        buyerId: order.buyerId,
        providerKey: input.providerKey,
        providerIntentId: input.providerIntentId,
        idempotencyKey: input.idempotencyKey,
        amountMinor: order.subtotalMinor,
        currencyCode: order.currencyCode,
        status: "SIMULATION_PENDING",
        mode: "SIMULATION_ONLY",
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [racedIntent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.buyerId, input.buyerId),
            eq(paymentIntents.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (racedIntent?.orderId === input.orderId)
        return { row: racedIntent, created: false };
      reject(409, "PAYMENT_INTENT_CONFLICT", "Payment intent conflicts with an existing request");
    }
    return { row, created: true };
  });

  return { ...paymentIntentView(result.row), created: result.created };
}

function providerStatusForLocal(
  intent: typeof paymentIntents.$inferSelect,
): ProviderPaymentSnapshot["status"] {
  if (intent.capturedAmountMinor === 0) return "PENDING";
  if (intent.refundedAmountMinor === intent.capturedAmountMinor)
    return "REFUNDED";
  if (intent.refundedAmountMinor > 0) return "PARTIALLY_REFUNDED";
  return "CAPTURED";
}

export async function receivePaymentWebhook(input: {
  adapter: PaymentProviderAdapter;
  event: PaymentWebhookEvent;
  signature: string;
}) {
  if (!input.adapter.verifyWebhook(input.event, input.signature))
    reject(401, "INVALID_WEBHOOK_SIGNATURE", "Invalid webhook signature");

  const digest = paymentWebhookDigest(input.event);
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.providerKey, input.adapter.providerKey),
          eq(paymentIntents.providerIntentId, input.event.providerIntentId),
        ),
      );
    if (!identity)
      reject(404, "PAYMENT_INTENT_NOT_FOUND", "Payment intent was not found");

    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, identity.orderId))
      .for("update");
    if (!order)
      reject(409, "PAYMENT_ORDER_NOT_FOUND", "Payment order was not found");

    let dispute: typeof disputes.$inferSelect | undefined;
    if (identity.disputeId) {
      const [linkedDispute] = await tx
        .select()
        .from(disputes)
        .where(eq(disputes.id, identity.disputeId))
        .for("update");
      dispute = linkedDispute;
      if (!dispute || dispute.orderId !== order.id)
        reject(409, "PAYMENT_DISPUTE_LINK_MISMATCH", "Payment dispute link is invalid");
      if (
        (dispute.status === "OPEN" &&
          (dispute.resolution !== null || dispute.resolvedAt !== null || order.status !== "DISPUTED")) ||
        (dispute.status === "RESOLVED" &&
          (dispute.resolvedAt === null ||
            !["BUYER", "SELLER"].includes(dispute.resolution ?? "") ||
            order.status !== (dispute.resolution === "BUYER" ? "CANCELLED" : "COMPLETED"))) ||
        !["OPEN", "RESOLVED"].includes(dispute.status)
      ) {
        reject(
          409,
          "PAYMENT_DISPUTE_STATE_MISMATCH",
          "Payment dispute state does not match its order",
        );
      }
    }

    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, identity.id))
      .for("update");
    if (
      !intent ||
      intent.providerKey !== identity.providerKey ||
      intent.providerIntentId !== identity.providerIntentId ||
      intent.disputeId !== identity.disputeId
    ) {
      reject(409, "PAYMENT_INTENT_CHANGED", "Payment intent changed while processing");
    }
    if (
      intent.mode !== "SIMULATION_ONLY" ||
      input.event.currencyCode !== intent.currencyCode
    ) {
      reject(409, "PAYMENT_EVENT_MISMATCH", "Payment event does not match its intent");
    }

    const [existingEvent] = await tx
      .select()
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.providerKey, input.adapter.providerKey),
          eq(paymentEvents.providerEventId, input.event.id),
        ),
      );
    if (existingEvent) {
      if (
        existingEvent.paymentIntentId !== intent.id ||
        existingEvent.payloadSha256 !== digest
      ) {
        reject(409, "PROVIDER_EVENT_ID_REUSED", "Provider event id was reused");
      }
      return {
        duplicate: true,
        paymentIntent: paymentIntentView(intent),
      };
    }

    let refund: typeof paymentRefunds.$inferSelect | undefined;
    let refundDueReason: RefundObligationReason | undefined;
    const now = new Date();
    if (input.event.type === "CAPTURE_SUCCEEDED") {
      const captureCanFollowDispute =
        !!dispute &&
        [
          "SIMULATION_DISPUTED",
          "SIMULATION_BUYER_REFUND_DUE",
          "SIMULATION_SELLER_RELEASE_DUE",
        ].includes(intent.status) &&
        intent.capturedAmountMinor === 0;
      if (
        (intent.status !== "SIMULATION_PENDING" && !captureCanFollowDispute) ||
        input.event.amountMinor !== intent.amountMinor
      ) {
        reject(409, "CAPTURE_STATE_MISMATCH", "Capture does not match pending intent");
      }
      // A verified capture for an order that is cancelled, or whose reservation lapsed before
      // the sweep ran, is never a normal payment: it is recorded as evidence and becomes a
      // REFUND_DUE obligation (owner policy D3). Disputed orders keep their own rules above.
      if (!dispute && order.status === "CANCELLED")
        refundDueReason = "CAPTURE_AFTER_CANCELLATION";
      else if (
        !dispute &&
        order.status === "CREATED" &&
        (!order.reservationExpiresAt ||
          order.reservationExpiresAt.getTime() <= now.getTime())
      )
        refundDueReason = "RESERVATION_EXPIRED";
    } else {
      if (dispute)
        reject(
          409,
          "PAYMENT_DISPUTE_REQUIRES_PROVIDER",
          "Dispute-related refunds require an approved provider integration",
        );
      const [matchedRefund] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.providerRefundId, input.event.providerRefundId))
        .for("update");
      refund = matchedRefund;
      if (
        !refund ||
        refund.paymentIntentId !== intent.id ||
        refund.status !== "REQUESTED" ||
        refund.amountMinor !== input.event.amountMinor ||
        refund.currencyCode !== input.event.currencyCode ||
        ![
          "SIMULATION_CAPTURED",
          "SIMULATION_PARTIALLY_REFUNDED",
          "SIMULATION_BUYER_REFUND_DUE",
        ].includes(intent.status) ||
        intent.refundedAmountMinor + input.event.amountMinor >
          intent.capturedAmountMinor
      ) {
        reject(409, "REFUND_STATE_MISMATCH", "Refund does not match a pending request");
      }
    }

    const [insertedEvent] = await tx
      .insert(paymentEvents)
      .values({
        id: randomUUID(),
        paymentIntentId: intent.id,
        refundId: refund?.id ?? null,
        providerKey: input.adapter.providerKey,
        providerEventId: input.event.id,
        eventType: input.event.type,
        amountMinor: input.event.amountMinor,
        currencyCode: input.event.currencyCode,
        payloadSha256: digest,
        mode: "SIMULATION_ONLY",
      })
      .onConflictDoNothing()
      .returning({ id: paymentEvents.id });
    if (!insertedEvent) {
      const [racedEvent] = await tx
        .select()
        .from(paymentEvents)
        .where(
          and(
            eq(paymentEvents.providerKey, input.adapter.providerKey),
            eq(paymentEvents.providerEventId, input.event.id),
          ),
        );
      if (
        racedEvent?.paymentIntentId === intent.id &&
        racedEvent.payloadSha256 === digest
      ) {
        return {
          duplicate: true,
          paymentIntent: paymentIntentView(intent),
        };
      }
      reject(409, "PROVIDER_EVENT_ID_REUSED", "Provider event id was reused");
    }

    if (input.event.type === "REFUND_FAILED") {
      // Nothing moved at the provider: the request fails and the balance stays owed, so a
      // later request (a new idempotency key) can retry it.
      await tx
        .update(paymentRefunds)
        .set({ status: "FAILED", updatedAt: now })
        .where(eq(paymentRefunds.id, refund!.id));
      return { duplicate: false, paymentIntent: paymentIntentView(intent) };
    }

    let nextStatus: string;
    let capturedAmountMinor = intent.capturedAmountMinor;
    let refundedAmountMinor = intent.refundedAmountMinor;
    if (input.event.type === "CAPTURE_SUCCEEDED") {
      capturedAmountMinor = input.event.amountMinor;
      nextStatus = dispute
        ? await recordPaymentCapturedOnDisputedOrder(tx, {
            intent,
            order,
            dispute,
            paymentEventId: insertedEvent.id,
            capturedAmountMinor,
            refundedAmountMinor,
          })
        : "SIMULATION_CAPTURED";
      // The lapsed order is cancelled first (its intent still shows no capture, so expiry
      // records nothing); the obligation below then owes the capture recorded here.
      if (refundDueReason === "RESERVATION_EXPIRED")
        await expireOrderReservation(tx, order, now);
    } else {
      refundedAmountMinor += input.event.amountMinor;
      const fullyRefunded = refundedAmountMinor === capturedAmountMinor;
      nextStatus =
        intent.status === "SIMULATION_BUYER_REFUND_DUE"
          ? fullyRefunded
            ? "SIMULATION_REFUNDED"
            : "SIMULATION_BUYER_REFUND_DUE"
          : fullyRefunded
            ? "SIMULATION_REFUNDED"
            : "SIMULATION_PARTIALLY_REFUNDED";
      await tx
        .update(paymentRefunds)
        .set({
          status: "SIMULATED_COMPLETED",
          updatedAt: now,
        })
        .where(eq(paymentRefunds.id, refund!.id));
    }

    let [updated] = await tx
      .update(paymentIntents)
      .set({
        status: nextStatus,
        capturedAmountMinor,
        refundedAmountMinor,
        updatedAt: now,
      })
      .where(eq(paymentIntents.id, intent.id))
      .returning();
    if (refundDueReason) {
      await recordRefundObligation(tx, {
        intent: updated,
        reason: refundDueReason,
        sourcePaymentEventId: insertedEvent.id,
      });
      [updated] = await tx
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, intent.id));
    }
    if (
      input.event.type === "REFUND_SUCCEEDED" &&
      intent.status === "SIMULATION_BUYER_REFUND_DUE" &&
      nextStatus === "SIMULATION_REFUNDED"
    )
      await resolveRefundObligation(tx, {
        paymentIntentId: intent.id,
        refundEventId: insertedEvent.id,
        now,
      });
    return {
      duplicate: false,
      paymentIntent: paymentIntentView(updated),
    };
  });
}

export async function createRefundRequest(input: {
  paymentIntentId: string;
  idempotencyKey: string;
  amountMinor: number;
  reason: string;
}) {
  return db.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.paymentIntentId))
      .for("update");
    if (!intent)
      reject(404, "PAYMENT_INTENT_NOT_FOUND", "Payment intent was not found");

    const [existing] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.paymentIntentId, intent.id),
          eq(paymentRefunds.idempotencyKey, input.idempotencyKey),
        ),
      )
      .for("update");
    if (existing) {
      if (
        existing.amountMinor !== input.amountMinor ||
        existing.reason !== input.reason
      ) {
        reject(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used");
      }
      return existing;
    }

    // A REFUND_DUE obligation (no dispute) is refunded through the same request path; a
    // dispute's refund still needs an approved provider integration.
    if (
      !(
        ["SIMULATION_CAPTURED", "SIMULATION_PARTIALLY_REFUNDED"].includes(
          intent.status,
        ) ||
        (intent.status === "SIMULATION_BUYER_REFUND_DUE" && !intent.disputeId)
      )
    ) {
      reject(409, "PAYMENT_NOT_REFUNDABLE", "No simulated capture is available");
    }
    const refunds = await tx
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.paymentIntentId, intent.id));
    const reservedMinor = refunds
      .filter((row) => row.status === "REQUESTED")
      .reduce((sum, row) => sum + row.amountMinor, 0);
    const availableMinor =
      intent.capturedAmountMinor - intent.refundedAmountMinor - reservedMinor;
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1 ||
      input.amountMinor > availableMinor
    ) {
      reject(409, "REFUND_AMOUNT_EXCEEDS_BALANCE", "Refund exceeds captured balance");
    }

    const [created] = await tx
      .insert(paymentRefunds)
      .values({
        id: randomUUID(),
        paymentIntentId: intent.id,
        idempotencyKey: input.idempotencyKey,
        amountMinor: input.amountMinor,
        currencyCode: intent.currencyCode,
        reason: input.reason,
        status: "REQUESTED",
        mode: "SIMULATION_ONLY",
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [racedRefund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.paymentIntentId, intent.id),
          eq(paymentRefunds.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (
      racedRefund &&
      racedRefund.amountMinor === input.amountMinor &&
      racedRefund.reason === input.reason
    ) {
      return racedRefund;
    }
    reject(409, "REFUND_REQUEST_CONFLICT", "Refund request conflicts with an existing request");
  });
}

export async function attachProviderRefundId(
  refundId: string,
  providerRefundId: string,
) {
  const [refund] = await db
    .select()
    .from(paymentRefunds)
    .where(eq(paymentRefunds.id, refundId));
  if (!refund)
    reject(404, "REFUND_NOT_FOUND", "Refund request was not found");
  if (refund.providerRefundId && refund.providerRefundId !== providerRefundId)
    reject(409, "REFUND_PROVIDER_ID_CONFLICT", "Refund provider id conflicts");
  if (!refund.providerRefundId) {
    await db
      .update(paymentRefunds)
      .set({ providerRefundId, updatedAt: new Date() })
      .where(eq(paymentRefunds.id, refundId));
  }
  return { ...refund, providerRefundId };
}

export async function getPaymentIntentForActor(input: {
  paymentIntentId: string;
  actorId: string;
}) {
  const [row] = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, input.paymentIntentId));
  if (!row || row.buyerId !== input.actorId)
    reject(404, "PAYMENT_INTENT_NOT_FOUND", "Payment intent was not found");
  return row;
}

export async function reconcilePayments(adapter: PaymentProviderAdapter) {
  const intents = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.providerKey, adapter.providerKey))
    .limit(1000);
  const intentIds = intents.map((intent) => intent.id);
  const orderIds = [...new Set(intents.map((intent) => intent.orderId))];
  const disputeIds = [
    ...new Set(
      intents.flatMap((intent) => (intent.disputeId ? [intent.disputeId] : [])),
    ),
  ];
  const [orderRows, disputeRows, disputeAuditRows, paymentRows] =
    await Promise.all([
      orderIds.length
        ? db.select().from(orders).where(inArray(orders.id, orderIds))
        : [],
      disputeIds.length
        ? db.select().from(disputes).where(inArray(disputes.id, disputeIds))
        : [],
      intentIds.length
        ? db
            .select()
            .from(paymentDisputeEvents)
            .where(inArray(paymentDisputeEvents.paymentIntentId, intentIds))
        : [],
      intentIds.length
        ? db.select().from(paymentEvents).where(inArray(paymentEvents.paymentIntentId, intentIds))
        : [],
    ]);
  const orderById = new Map(orderRows.map((row) => [row.id, row]));
  const disputeById = new Map(disputeRows.map((row) => [row.id, row]));
  const auditByIntent = new Map<string, typeof disputeAuditRows>();
  for (const row of disputeAuditRows) {
    const rows = auditByIntent.get(row.paymentIntentId) ?? [];
    rows.push(row);
    auditByIntent.set(row.paymentIntentId, rows);
  }
  const paymentEventsByIntent = new Map<string, typeof paymentRows>();
  for (const row of paymentRows) {
    const rows = paymentEventsByIntent.get(row.paymentIntentId) ?? [];
    rows.push(row);
    paymentEventsByIntent.set(row.paymentIntentId, rows);
  }

  const obligationRows = intentIds.length
    ? await db
        .select()
        .from(paymentRefundObligations)
        .where(inArray(paymentRefundObligations.paymentIntentId, intentIds))
    : [];
  const obligationByIntent = new Map(
    obligationRows.map((row) => [row.paymentIntentId, row]),
  );
  /** A non-dispute REFUND_DUE intent owes exactly its open obligation; a refunded one resolved it. */
  function obligationStateMatches(intent: (typeof intents)[number]) {
    const obligation = obligationByIntent.get(intent.id);
    if (intent.disputeId) return !obligation;
    if (intent.status === "SIMULATION_BUYER_REFUND_DUE")
      return (
        obligation?.status === "OPEN" &&
        obligation.currencyCode === intent.currencyCode &&
        obligation.amountMinor <= intent.capturedAmountMinor &&
        intent.capturedAmountMinor - intent.refundedAmountMinor > 0
      );
    if (!obligation) return true;
    return (
      obligation.status === "RESOLVED" &&
      intent.status === "SIMULATION_REFUNDED" &&
      intent.refundedAmountMinor === intent.capturedAmountMinor
    );
  }

  function disputeStateMatches(intent: (typeof intents)[number]) {
    const auditRows = auditByIntent.get(intent.id) ?? [];
    if (!intent.disputeId) return auditRows.length === 0;

    const order = orderById.get(intent.orderId);
    const dispute = disputeById.get(intent.disputeId);
    if (!order || !dispute || dispute.orderId !== order.id) return false;
    const openedRows = auditRows.filter(
      (row) => row.eventType === "DISPUTE_OPENED",
    );
    const captureAudits = auditRows.filter(
      (row) => row.eventType === "PAYMENT_CAPTURED",
    );
    const resolutionAudits = auditRows.filter(
      (row) => row.eventType === "DISPUTE_RESOLVED",
    );
    const opened = openedRows[0];
    if (
      openedRows.length !== 1 ||
      captureAudits.length > 1 ||
      resolutionAudits.length !== (dispute.status === "RESOLVED" ? 1 : 0) ||
      auditRows.length !==
        openedRows.length + captureAudits.length + resolutionAudits.length ||
      auditRows.some((row) => row.disputeId !== dispute.id) ||
      opened.paymentIntentId !== intent.id
    ) {
      return false;
    }
    const resolved = resolutionAudits[0];

    const expectedCommissionRateBps =
      typeof order.data.commissionRateBps === "number"
        ? order.data.commissionRateBps
        : 1_000;
    if (
      auditRows.some(
        (row) =>
          row.currencyCode !== intent.currencyCode ||
          row.commissionRateBps !== expectedCommissionRateBps ||
          row.platformFeeMinor !== order.platformFeeMinor ||
          row.sellerAmountMinor !== order.sellerAmountMinor,
      )
    ) {
      return false;
    }

    const paymentCaptureEvents = (
      paymentEventsByIntent.get(intent.id) ?? []
    ).filter((row) => row.eventType === "CAPTURE_SUCCEEDED");
    if (
      paymentCaptureEvents.length !== (intent.capturedAmountMinor > 0 ? 1 : 0) ||
      paymentCaptureEvents.some(
        (row) =>
          row.amountMinor !== intent.capturedAmountMinor ||
          row.currencyCode !== intent.currencyCode,
      )
    ) {
      return false;
    }
    const captureEventById = new Map(
      paymentCaptureEvents.map((row) => [row.id, row]),
    );
    const referencedCaptureIds = new Set<string>();
    const openingCaptureId = opened.sourcePaymentEventId;
    const hasCaptureAtOpening = opened.financialOutcome === "HOLD_CAPTURED";
    if (
      hasCaptureAtOpening !== Boolean(openingCaptureId) ||
      (!hasCaptureAtOpening &&
        (opened.financialOutcome !== "HOLD_PENDING" ||
          opened.amountMinor !== 0)) ||
      (openingCaptureId && !captureEventById.has(openingCaptureId))
    ) {
      return false;
    }
    if (openingCaptureId) referencedCaptureIds.add(openingCaptureId);
    if (
      captureAudits.some(
        (row) =>
          !row.sourcePaymentEventId ||
          !captureEventById.has(row.sourcePaymentEventId) ||
          referencedCaptureIds.has(row.sourcePaymentEventId),
      )
    ) {
      return false;
    }
    for (const row of captureAudits) {
      referencedCaptureIds.add(row.sourcePaymentEventId!);
    }
    if (
      paymentCaptureEvents.some((row) => !referencedCaptureIds.has(row.id)) ||
      (openingCaptureId &&
        (opened.amountMinor !==
          Math.max(
            0,
            intent.capturedAmountMinor - intent.refundedAmountMinor,
          ) ||
          paymentCaptureEvents.length !== 1))
    ) {
      return false;
    }

    const currentCapturedBalance = Math.max(
      0,
      intent.capturedAmountMinor - intent.refundedAmountMinor,
    );
    if (dispute.status === "OPEN") {
      const latestOutcome =
        captureAudits[0]?.financialOutcome ?? opened.financialOutcome;
      const latestAmount =
        captureAudits[0]?.amountMinor ?? opened.amountMinor;
      return (
        order.status === "DISPUTED" &&
        dispute.resolution === null &&
        dispute.resolvedAt === null &&
        intent.status === "SIMULATION_DISPUTED" &&
        latestOutcome ===
          (intent.capturedAmountMinor > 0 ? "HOLD_CAPTURED" : "HOLD_PENDING") &&
        latestAmount === currentCapturedBalance &&
        captureAudits.every(
          (row) =>
            row.financialOutcome === "HOLD_CAPTURED" &&
            row.amountMinor === currentCapturedBalance,
        )
      );
    }
    if (
      dispute.status !== "RESOLVED" ||
      !dispute.resolvedAt ||
      !resolved ||
      !["BUYER", "SELLER"].includes(dispute.resolution ?? "")
    ) {
      return false;
    }

    if (dispute.resolution === "BUYER") {
      return (
        order.status === "CANCELLED" &&
        intent.status === "SIMULATION_BUYER_REFUND_DUE" &&
        resolved.financialOutcome === "BUYER_REFUND_DUE" &&
        (resolved.amountMinor === 0 ||
          resolved.amountMinor === currentCapturedBalance) &&
        captureAudits.every(
          (row) =>
            (row.financialOutcome === "HOLD_CAPTURED" &&
              row.amountMinor === currentCapturedBalance) ||
            (row.financialOutcome === "BUYER_REFUND_DUE" &&
              row.amountMinor === currentCapturedBalance),
        )
      );
    }
    if (dispute.resolution === "SELLER") {
      return (
        order.status === "COMPLETED" &&
        intent.status === "SIMULATION_SELLER_RELEASE_DUE" &&
        resolved.financialOutcome === "SELLER_RELEASE_DUE" &&
        resolved.amountMinor === order.sellerAmountMinor &&
        captureAudits.every(
          (row) =>
            (row.financialOutcome === "HOLD_CAPTURED" &&
              row.amountMinor === currentCapturedBalance) ||
            (row.financialOutcome === "SELLER_RELEASE_DUE" &&
              row.amountMinor === order.sellerAmountMinor),
        )
      );
    }
    return false;
  }

  const comparisons = await Promise.all(
    intents.map(async (intent) => {
      const snapshot = await adapter.getSnapshot(intent.providerIntentId);
      const matches = Boolean(
        snapshot &&
          snapshot.status === providerStatusForLocal(intent) &&
          snapshot.amountMinor === intent.amountMinor &&
          snapshot.currencyCode === intent.currencyCode &&
          snapshot.capturedAmountMinor === intent.capturedAmountMinor &&
          snapshot.refundedAmountMinor === intent.refundedAmountMinor &&
          disputeStateMatches(intent) &&
          obligationStateMatches(intent),
      );
      return { intent, snapshot, result: matches ? "MATCH" : "MISMATCH" };
    }),
  );
  const matchedCount = comparisons.filter(
    (item) => item.result === "MATCH",
  ).length;
  const mismatchCount = comparisons.length - matchedCount;
  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(paymentReconciliationRuns).values({
      id: runId,
      providerKey: adapter.providerKey,
      status: mismatchCount ? "MISMATCHED" : "MATCHED",
      matchedCount,
      mismatchCount,
      mode: "SIMULATION_ONLY",
    });
    if (comparisons.length) {
      await tx.insert(paymentReconciliationItems).values(
        comparisons.map(({ intent, snapshot, result }) => ({
          id: randomUUID(),
          runId,
          paymentIntentId: intent.id,
          result,
          localStatus: intent.status,
          providerStatus: snapshot?.status ?? null,
          localCapturedAmountMinor: intent.capturedAmountMinor,
          providerCapturedAmountMinor: snapshot?.capturedAmountMinor ?? null,
          localRefundedAmountMinor: intent.refundedAmountMinor,
          providerRefundedAmountMinor: snapshot?.refundedAmountMinor ?? null,
          mode: "SIMULATION_ONLY",
        })),
      );
    }
  });
  return {
    id: runId,
    status: mismatchCount ? "MISMATCHED" : "MATCHED",
    matchedCount,
    mismatchCount,
    mode: "SIMULATION_ONLY" as const,
    items: comparisons.map(({ intent, snapshot, result }) => ({
      paymentIntentId: intent.id,
      result,
      localStatus: intent.status,
      providerStatus: snapshot?.status ?? null,
      localCapturedAmountMinor: intent.capturedAmountMinor,
      providerCapturedAmountMinor: snapshot?.capturedAmountMinor ?? null,
      localRefundedAmountMinor: intent.refundedAmountMinor,
      providerRefundedAmountMinor: snapshot?.refundedAmountMinor ?? null,
    })),
  };
}