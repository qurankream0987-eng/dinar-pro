import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  cashPaymentClaims,
  cashRefundCases,
  db,
  markets,
  orders,
  paymentIntents,
} from "@workspace/db";
import { marketAllowsCashDirect } from "../market-capability-registry";
import {
  recordCommissionReversal,
  recordOrderFinancialEvent,
} from "../order-journal";

type Order = typeof orders.$inferSelect;
type Claim = typeof cashPaymentClaims.$inferSelect;
type RefundCase = typeof cashRefundCases.$inferSelect;

/**
 * Direct cash never becomes a payment merely because someone clicked. This engine records
 * buyer claims, seller attestations and buyer-confirmed repayments in development only;
 * nothing here moves money through DINAR, and production currently reports cash as
 * unavailable until the owner activates it deliberately.
 */
export function cashEngineEnabled() {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.REPLIT_DEPLOYMENT === undefined
  );
}

export class CashEngineError extends Error {
  readonly expose = true;
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "CashEngineError";
  }
}

function reject(status: number, code: string, message: string): never {
  throw new CashEngineError(message, status, code);
}

function nonEmpty(value: string | undefined | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length ? trimmed : null;
}

export function cashPaymentClaimView(row: Claim) {
  return {
    id: row.id,
    orderId: row.orderId,
    amountMinor: row.amountMinor,
    currencyCode: row.currencyCode,
    status: row.status,
    claimedAt: row.claimedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    evidence: row.evidence,
    mode: row.mode,
    verification:
      row.status === "CONFIRMED"
        ? "SELLER_ATTESTED"
        : row.status === "DENIED"
          ? "SELLER_DENIED"
          : row.status === "DISPUTED"
            ? "BUYER_DISPUTED"
            : "UNVERIFIED_BUYER_CLAIM",
  };
}

export function cashRefundCaseView(row: RefundCase) {
  return {
    id: row.id,
    orderId: row.orderId,
    paymentClaimId: row.paymentClaimId,
    openedBy: row.openedBy,
    amountMinor: row.amountMinor,
    currencyCode: row.currencyCode,
    reason: row.reason,
    status: row.status,
    repaymentClaimedAt: row.repaymentClaimedAt?.toISOString() ?? null,
    repaymentNote: row.repaymentNote,
    repaymentEvidence: row.repaymentEvidence,
    buyerConfirmedAt: row.buyerConfirmedAt?.toISOString() ?? null,
    disputedAt: row.disputedAt?.toISOString() ?? null,
    disputeReason: row.disputeReason,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    mode: row.mode,
    verification:
      row.status === "CONFIRMED"
        ? "BUYER_ATTESTED_REPAYMENT"
        : row.status === "REPAYMENT_CLAIMED"
          ? "UNVERIFIED_SELLER_REPAYMENT_CLAIM"
          : row.status,
  };
}

async function lockOrder(tx: any, orderId: string): Promise<Order> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update");
  if (!order) reject(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
  return order;
}

async function assertMarketCash(order: Order, tx: any) {
  const [market] = await tx
    .select()
    .from(markets)
    .where(eq(markets.id, order.marketId));
  if (!market || !marketAllowsCashDirect(market))
    reject(409, "CASH_NOT_SUPPORTED", "هذا السوق لا يسمح بالدفع النقدي المباشر");
}

/** A cash claim cannot coexist with a pending or captured electronic intent. */
async function assertNoElectronicPayment(order: Order, tx: any) {
  const [intent] = await tx
    .select({ id: paymentIntents.id, status: paymentIntents.status })
    .from(paymentIntents)
    .where(eq(paymentIntents.orderId, order.id))
    .for("update");
  if (intent && intent.status !== "SIMULATION_FAILED")
    reject(
      409,
      "CASH_CONFLICT_ELECTRONIC",
      "يوجد مسار دفع إلكتروني لهذا الطلب؛ لا يمكن تسجيل دفع نقدي",
    );
}

async function claimForOrder(tx: any, orderId: string, forUpdate = false) {
  const query = tx
    .select()
    .from(cashPaymentClaims)
    .where(eq(cashPaymentClaims.orderId, orderId));
  const [claim] = forUpdate ? await query.for("update") : await query;
  return claim as Claim | undefined;
}

export async function claimCashPayment(input: {
  buyerId: string;
  orderId: string;
  idempotencyKey: string;
  note?: string | null;
  evidence?: string[];
}) {
  return db.transaction(async (tx) => {
    const [byKey] = await tx
      .select()
      .from(cashPaymentClaims)
      .where(
        and(
          eq(cashPaymentClaims.buyerId, input.buyerId),
          eq(cashPaymentClaims.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (byKey && byKey.orderId !== input.orderId)
      reject(409, "IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم لطلب آخر");

    const order = await lockOrder(tx, input.orderId);
    if (order.buyerId !== input.buyerId)
      reject(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
    if (!["ACCEPTED", "SELLER_MARKED_DELIVERED", "COMPLETED"].includes(order.status))
      reject(409, "CASH_ORDER_NOT_ELIGIBLE", "لا يمكن تسجيل الدفع النقدي في حالة الطلب الحالية");
    await assertMarketCash(order, tx);
    await assertNoElectronicPayment(order, tx);

    const existing = await claimForOrder(tx, order.id, true);
    if (existing) {
      if (
        existing.buyerId === input.buyerId &&
        existing.idempotencyKey === input.idempotencyKey
      )
        return { claim: cashPaymentClaimView(existing), created: false };
      reject(409, "CASH_CLAIM_EXISTS", "يوجد ادعاء دفع نقدي لهذا الطلب");
    }
    if (byKey) return { claim: cashPaymentClaimView(byKey), created: false };

    const [created] = await tx
      .insert(cashPaymentClaims)
      .values({
        id: randomUUID(),
        orderId: order.id,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        amountMinor: order.subtotalMinor,
        currencyCode: order.currencyCode,
        status: "CLAIMED",
        evidence: [
          ...(input.evidence ?? []),
          ...(nonEmpty(input.note) ? [{ type: "NOTE", note: input.note!.trim() }] : []),
        ],
        idempotencyKey: input.idempotencyKey,
        mode: "CASH_DIRECT",
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [concurrent] = await tx
        .select()
        .from(cashPaymentClaims)
        .where(
          and(
            eq(cashPaymentClaims.buyerId, input.buyerId),
            eq(cashPaymentClaims.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (concurrent && concurrent.orderId === order.id)
        return { claim: cashPaymentClaimView(concurrent), created: false };
      reject(409, "IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم لطلب آخر");
    }
    return { claim: cashPaymentClaimView(created), created: true };
  });
}

export async function confirmCashPayment(input: {
  sellerId: string;
  orderId: string;
  note?: string | null;
  evidence?: string[];
}) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, input.orderId);
    if (order.sellerId !== input.sellerId)
      reject(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
    await assertMarketCash(order, tx);
    await assertNoElectronicPayment(order, tx);
    const claim = await claimForOrder(tx, order.id, true);
    if (!claim) reject(404, "CASH_CLAIM_NOT_FOUND", "لا يوجد ادعاء دفع نقدي");
    if (claim.status === "CONFIRMED")
      return { claim: cashPaymentClaimView(claim), confirmed: false };
    if (!["CLAIMED", "DENIED"].includes(claim.status))
      reject(409, "CASH_CLAIM_NOT_CONFIRMABLE", "لا يمكن تأكيد ادعاء الدفع في حالته الحالية");

    const now = new Date();
    const [updated] = await tx
      .update(cashPaymentClaims)
      .set({
        status: "CONFIRMED",
        decidedAt: now,
        decidedBy: input.sellerId,
        decisionReason: null,
        evidence: [
          ...(claim.evidence as unknown[]),
          ...(input.evidence ?? []),
          ...(nonEmpty(input.note) ? [{ type: "NOTE", note: input.note!.trim() }] : []),
          { type: "SELLER_ATTESTATION", at: now.toISOString(), by: input.sellerId },
        ],
        updatedAt: now,
      })
      .where(eq(cashPaymentClaims.id, claim.id))
      .returning();

    await tx
      .update(orders)
      .set({
        data: {
          ...order.data,
          paymentMode: "CASH_DIRECT",
          selectedPaymentMethod: "CASH_DIRECT",
          cashPayment: {
            claimId: updated.id,
            amountMinor: updated.amountMinor,
            currencyCode: updated.currencyCode,
            confirmedAt: now.toISOString(),
            verification: "SELLER_ATTESTED",
          },
        },
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));

    await recordOrderFinancialEvent(tx, {
      orderId: order.id,
      eventType: "PAYMENT_CAPTURED",
      accountObligation: "BUYER_PAYMENT",
      businessRef: updated.id,
      actorType: "SELLER",
      actorId: input.sellerId,
      currencyCode: order.currencyCode,
      amountMinor: updated.amountMinor,
      idempotencyKey: `cash-payment-confirmed:${updated.id}`,
      authorizationContext: {
        source: "CASH_DIRECT_SELLER_CONFIRMATION",
        claimId: updated.id,
        orderId: order.id,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        method: "CASH_DIRECT",
      },
      data: {
        verification: "COUNTERPARTY_ATTESTED",
        externalMoneyMovement: "BUYER_TO_SELLER_DIRECT",
      },
    });
    return { claim: cashPaymentClaimView(updated), confirmed: true };
  });
}

export async function denyCashPayment(input: {
  sellerId: string;
  orderId: string;
  reason: string;
}) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, input.orderId);
    if (order.sellerId !== input.sellerId)
      reject(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
    const claim = await claimForOrder(tx, order.id, true);
    if (!claim) reject(404, "CASH_CLAIM_NOT_FOUND", "لا يوجد ادعاء دفع نقدي");
    if (claim.status === "DENIED")
      return { claim: cashPaymentClaimView(claim), denied: false };
    if (claim.status !== "CLAIMED")
      reject(409, "CASH_CLAIM_NOT_DENIABLE", "لا يمكن رفض ادعاء الدفع في حالته الحالية");
    const now = new Date();
    const [updated] = await tx
      .update(cashPaymentClaims)
      .set({
        status: "DENIED",
        decidedAt: now,
        decidedBy: input.sellerId,
        decisionReason: input.reason.trim(),
        updatedAt: now,
      })
      .where(eq(cashPaymentClaims.id, claim.id))
      .returning();
    return { claim: cashPaymentClaimView(updated), denied: true };
  });
}

export async function disputeCashPayment(input: {
  buyerId: string;
  orderId: string;
  reason: string;
}) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, input.orderId);
    if (order.buyerId !== input.buyerId)
      reject(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
    const claim = await claimForOrder(tx, order.id, true);
    if (!claim) reject(404, "CASH_CLAIM_NOT_FOUND", "لا يوجد ادعاء دفع نقدي");
    if (claim.status === "DISPUTED")
      return { claim: cashPaymentClaimView(claim), disputed: false };
    if (!["CLAIMED", "DENIED"].includes(claim.status))
      reject(409, "CASH_CLAIM_NOT_DISPUTABLE", "لا يمكن الاعتراض على ادعاء الدفع في حالته الحالية");
    const now = new Date();
    const [updated] = await tx
      .update(cashPaymentClaims)
      .set({
        status: "DISPUTED",
        decidedAt: now,
        decidedBy: input.buyerId,
        decisionReason: input.reason.trim(),
        updatedAt: now,
      })
      .where(eq(cashPaymentClaims.id, claim.id))
      .returning();
    return { claim: cashPaymentClaimView(updated), disputed: true };
  });
}

export async function cashForOrder(input: {
  actorId: string;
  orderId: string;
}) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (
    !order ||
    (order.buyerId !== input.actorId && order.sellerId !== input.actorId)
  )
    reject(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
  const claim = await claimForOrder(db, order.id);
  const cases = await db
    .select()
    .from(cashRefundCases)
    .where(eq(cashRefundCases.orderId, order.id))
    .orderBy(desc(cashRefundCases.createdAt));
  return {
    orderId: order.id,
    mode: "CASH_DIRECT",
    engine: cashEngineEnabled() ? "DEVELOPMENT_ONLY" : "DISABLED",
    claim: claim ? cashPaymentClaimView(claim) : null,
    refundCases: cases.map(cashRefundCaseView),
  };
}

/** Opens a refund case before any repayment has happened. */
export async function openCashRefundCase(input: {
  actorId: string;
  orderId: string;
  idempotencyKey: string;
  amountMinor: number;
  reason: string;
  evidence?: string[];
}) {
  return db.transaction(async (tx) => {
    const [byKey] = await tx
      .select()
      .from(cashRefundCases)
      .where(
        and(
          eq(cashRefundCases.openedBy, input.actorId),
          eq(cashRefundCases.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (byKey) {
      if (
        byKey.orderId === input.orderId &&
        byKey.amountMinor === input.amountMinor &&
        byKey.reason === input.reason.trim()
      )
        return { refund: cashRefundCaseView(byKey), created: false };
      reject(409, "IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم لبيانات مختلفة");
    }

    const order = await lockOrder(tx, input.orderId);
    if (order.buyerId !== input.actorId && order.sellerId !== input.actorId)
      reject(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
    await assertMarketCash(order, tx);
    await assertNoElectronicPayment(order, tx);

    const claim = await claimForOrder(tx, order.id);
    if (!claim || claim.status !== "CONFIRMED")
      reject(409, "CASH_PAYMENT_NOT_CONFIRMED", "لا يوجد دفع نقدي مؤكد لهذا الطلب");

    const existing = await tx
      .select()
      .from(cashRefundCases)
      .where(eq(cashRefundCases.orderId, order.id))
      .for("update");
    const reserved = existing
      .filter((row) =>
        ["OPEN", "REPAYMENT_CLAIMED", "DISPUTED"].includes(row.status),
      )
      .reduce((sum, row) => sum + row.amountMinor, 0);
    const alreadyConfirmed = existing
      .filter((row) => row.status === "CONFIRMED")
      .reduce((sum, row) => sum + row.amountMinor, 0);
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1 ||
      input.amountMinor > claim.amountMinor - reserved - alreadyConfirmed
    )
      reject(409, "CASH_REFUND_EXCEEDS_PAYMENT", "مبلغ الاسترداد يتجاوز المبلغ النقدي المؤكد");

    const [created] = await tx
      .insert(cashRefundCases)
      .values({
        id: randomUUID(),
        orderId: order.id,
        paymentClaimId: claim.id,
        openedBy: input.actorId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        amountMinor: input.amountMinor,
        currencyCode: order.currencyCode,
        reason: input.reason.trim(),
        status: "OPEN",
        repaymentEvidence: input.evidence ?? [],
        idempotencyKey: input.idempotencyKey,
        mode: "CASH_DIRECT",
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [concurrent] = await tx
        .select()
        .from(cashRefundCases)
        .where(
          and(
            eq(cashRefundCases.openedBy, input.actorId),
            eq(cashRefundCases.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (
        concurrent &&
        concurrent.orderId === order.id &&
        concurrent.amountMinor === input.amountMinor
      )
        return { refund: cashRefundCaseView(concurrent), created: false };
      reject(409, "IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم لبيانات مختلفة");
    }
    return { refund: cashRefundCaseView(created), created: true };
  });
}

export async function claimCashRefundRepayment(input: {
  sellerId: string;
  refundId: string;
  note: string;
  evidence?: string[];
}) {
  return db.transaction(async (tx) => {
    const [refund] = await tx
      .select()
      .from(cashRefundCases)
      .where(eq(cashRefundCases.id, input.refundId))
      .for("update");
    if (!refund || refund.sellerId !== input.sellerId)
      reject(404, "CASH_REFUND_NOT_FOUND", "حالة الاسترداد غير موجودة");
    if (refund.status === "REPAYMENT_CLAIMED")
      return { refund: cashRefundCaseView(refund), claimed: false };
    if (refund.status !== "OPEN")
      reject(409, "CASH_REFUND_NOT_CLAIMABLE", "لا يمكن تسجيل السداد في حالة الاسترداد الحالية");
    const now = new Date();
    const [updated] = await tx
      .update(cashRefundCases)
      .set({
        status: "REPAYMENT_CLAIMED",
        repaymentClaimedAt: now,
        repaymentNote: input.note.trim(),
        repaymentEvidence: [
          ...(refund.repaymentEvidence as unknown[]),
          ...(input.evidence ?? []),
          { type: "SELLER_REPAYMENT_CLAIM", at: now.toISOString(), by: input.sellerId },
        ],
        updatedAt: now,
      })
      .where(eq(cashRefundCases.id, refund.id))
      .returning();
    return { refund: cashRefundCaseView(updated), claimed: true };
  });
}

export async function confirmCashRefundReceipt(input: {
  buyerId: string;
  refundId: string;
}) {
  return db.transaction(async (tx) => {
    // Lock order first, then the refund row: openCashRefundCase takes the same order -> refund
    // order, so the confirmation path must not invert it (ABBA deadlock on concurrent cases).
    const [preview] = await tx
      .select({ orderId: cashRefundCases.orderId })
      .from(cashRefundCases)
      .where(eq(cashRefundCases.id, input.refundId));
    if (!preview)
      reject(404, "CASH_REFUND_NOT_FOUND", "حالة الاسترداد غير موجودة");
    const order = await lockOrder(tx, preview.orderId);
    const [refund] = await tx
      .select()
      .from(cashRefundCases)
      .where(eq(cashRefundCases.id, input.refundId))
      .for("update");
    if (!refund || refund.buyerId !== input.buyerId)
      reject(404, "CASH_REFUND_NOT_FOUND", "حالة الاسترداد غير موجودة");
    if (refund.status === "CONFIRMED")
      return { refund: cashRefundCaseView(refund), confirmed: false };
    if (refund.status !== "REPAYMENT_CLAIMED")
      reject(409, "CASH_REFUND_NOT_CONFIRMABLE", "لا يمكن تأكيد استلام الاسترداد في حالته الحالية");

    const now = new Date();
    const [updated] = await tx
      .update(cashRefundCases)
      .set({
        status: "CONFIRMED",
        buyerConfirmedAt: now,
        updatedAt: now,
      })
      .where(eq(cashRefundCases.id, refund.id))
      .returning();

    await recordOrderFinancialEvent(tx, {
      orderId: order.id,
      eventType: "PAYMENT_REFUNDED",
      accountObligation: "BUYER_REFUND",
      businessRef: updated.id,
      actorType: "BUYER",
      actorId: input.buyerId,
      currencyCode: order.currencyCode,
      amountMinor: updated.amountMinor,
      idempotencyKey: `cash-refund-confirmed:${updated.id}`,
      authorizationContext: {
        source: "CASH_REFUND_BUYER_CONFIRMATION",
        refundCaseId: updated.id,
        paymentClaimId: updated.paymentClaimId,
        orderId: order.id,
      },
      data: {
        verification: "BUYER_ATTESTED_REPAYMENT",
        externalMoneyMovement: "SELLER_TO_BUYER_DIRECT",
      },
    });

    if (order.status === "COMPLETED") {
      const prior = await tx
        .select({ amountMinor: sql<string>`coalesce(sum(${cashRefundCases.amountMinor}), 0)` })
        .from(cashRefundCases)
        .where(
          and(
            eq(cashRefundCases.orderId, order.id),
            eq(cashRefundCases.status, "CONFIRMED"),
            sql`${cashRefundCases.id} <> ${updated.id}`,
          ),
        );
      await recordCommissionReversal(tx, {
        order,
        refundAmountMinor: updated.amountMinor,
        previouslyRefundedMinor: Number(prior[0]?.amountMinor ?? 0),
        businessRef: `cash-refund:${updated.id}`,
      });
    }
    return { refund: cashRefundCaseView(updated), confirmed: true };
  });
}

export async function disputeCashRefundRepayment(input: {
  buyerId: string;
  refundId: string;
  reason: string;
}) {
  return db.transaction(async (tx) => {
    const [refund] = await tx
      .select()
      .from(cashRefundCases)
      .where(eq(cashRefundCases.id, input.refundId))
      .for("update");
    if (!refund || refund.buyerId !== input.buyerId)
      reject(404, "CASH_REFUND_NOT_FOUND", "حالة الاسترداد غير موجودة");
    if (refund.status === "DISPUTED")
      return { refund: cashRefundCaseView(refund), disputed: false };
    if (refund.status !== "REPAYMENT_CLAIMED")
      reject(409, "CASH_REFUND_NOT_DISPUTABLE", "لا يمكن الاعتراض على السداد في حالته الحالية");
    const now = new Date();
    const [updated] = await tx
      .update(cashRefundCases)
      .set({
        status: "DISPUTED",
        disputedAt: now,
        disputeReason: input.reason.trim(),
        updatedAt: now,
      })
      .where(eq(cashRefundCases.id, refund.id))
      .returning();
    return { refund: cashRefundCaseView(updated), disputed: true };
  });
}

export async function withdrawCashRefundCase(input: {
  actorId: string;
  refundId: string;
}) {
  return db.transaction(async (tx) => {
    const [refund] = await tx
      .select()
      .from(cashRefundCases)
      .where(eq(cashRefundCases.id, input.refundId))
      .for("update");
    if (!refund || refund.openedBy !== input.actorId)
      reject(404, "CASH_REFUND_NOT_FOUND", "حالة الاسترداد غير موجودة");
    if (refund.status === "WITHDRAWN")
      return { refund: cashRefundCaseView(refund), withdrawn: false };
    if (refund.status !== "OPEN")
      reject(409, "CASH_REFUND_NOT_WITHDRAWABLE", "لا يمكن سحب حالة الاسترداد في حالتها الحالية");
    const now = new Date();
    const [updated] = await tx
      .update(cashRefundCases)
      .set({ status: "WITHDRAWN", withdrawnAt: now, updatedAt: now })
      .where(eq(cashRefundCases.id, refund.id))
      .returning();
    return { refund: cashRefundCaseView(updated), withdrawn: true };
  });
}

/** Confirmed cash refunds for one order, used by completion accounting. */
export async function confirmedCashRefundTotalMinor(
  tx: any,
  orderId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${cashRefundCases.amountMinor}), 0)`,
    })
    .from(cashRefundCases)
    .where(
      and(
        eq(cashRefundCases.orderId, orderId),
        eq(cashRefundCases.status, "CONFIRMED"),
      ),
    );
  return Number(row?.total ?? 0);
}
