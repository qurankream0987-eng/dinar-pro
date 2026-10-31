import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, orderFinancialEvents } from "@workspace/db";
import {
  commissionRateForOrder,
  commissionReversalForRefund,
} from "./commission-policy";

export const ORDER_FINANCIAL_EVENT_TYPES = [
  "ORDER_CREATED",
  "PAYMENT_CAPTURED",
  "PAYMENT_REFUNDED",
  "ORDER_COMPLETED",
  "ORDER_CANCELLED",
  "COMMISSION_ACCRUED",
  "COMMISSION_REVERSED",
  "SELLER_PAYABLE_DUE",
  "REFUND_OBLIGATION_OPENED",
  "REFUND_OBLIGATION_RESOLVED",
] as const;
export type OrderFinancialEventType =
  (typeof ORDER_FINANCIAL_EVENT_TYPES)[number];

export const FINANCIAL_ACCOUNT_OBLIGATIONS = [
  "BUYER_RECEIVABLE",
  "BUYER_PAYMENT",
  "BUYER_REFUND",
  "SELLER_PAYABLE",
  "PLATFORM_COMMISSION",
  "REFUND_OBLIGATION",
  "NONE",
] as const;
export type FinancialAccountObligation =
  (typeof FINANCIAL_ACCOUNT_OBLIGATIONS)[number];

export const FINANCIAL_ACTOR_TYPES = [
  "BUYER",
  "SELLER",
  "SYSTEM",
  "ADMIN",
  "PROVIDER",
] as const;
export type FinancialActorType = (typeof FINANCIAL_ACTOR_TYPES)[number];

type JournalEntry = typeof orderFinancialEvents.$inferSelect;

export type FinancialEventInput = {
  orderId: string;
  eventType: OrderFinancialEventType;
  accountObligation: FinancialAccountObligation;
  businessRef: string;
  actorType: FinancialActorType;
  actorId?: string | null;
  currencyCode: string;
  amountMinor: number;
  idempotencyKey: string;
  reversesEventId?: string | null;
  authorizationContext?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

function assertFinancialFacts(input: FinancialEventInput) {
  if (!ORDER_FINANCIAL_EVENT_TYPES.includes(input.eventType))
    throw new RangeError(`Unknown financial event type ${input.eventType}`);
  if (!FINANCIAL_ACCOUNT_OBLIGATIONS.includes(input.accountObligation))
    throw new RangeError(`Unknown account obligation ${input.accountObligation}`);
  if (!FINANCIAL_ACTOR_TYPES.includes(input.actorType))
    throw new RangeError(`Unknown financial actor ${input.actorType}`);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0)
    throw new RangeError("A financial amount must be a non-negative safe integer");
  if (!/^[A-Z]{3}$/.test(input.currencyCode))
    throw new RangeError("A financial entry needs an ISO 4217 currency code");
  if (!input.businessRef || input.businessRef.length > 300)
    throw new RangeError("A financial entry needs a business reference");
  if (!input.idempotencyKey || input.idempotencyKey.length > 200)
    throw new RangeError("A financial entry needs an idempotency key");
}

/**
 * The only writer for the order financial journal. A duplicate key returns the original
 * entry only when the financial facts match; reusing a key for different facts is refused.
 */
export async function recordOrderFinancialEvent(
  tx: any,
  input: FinancialEventInput,
): Promise<JournalEntry> {
  assertFinancialFacts(input);
  const [inserted] = await tx
    .insert(orderFinancialEvents)
    .values({
      id: randomUUID(),
      orderId: input.orderId,
      eventType: input.eventType,
      accountObligation: input.accountObligation,
      businessRef: input.businessRef,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      currencyCode: input.currencyCode,
      amountMinor: input.amountMinor,
      idempotencyKey: input.idempotencyKey,
      reversesEventId: input.reversesEventId ?? null,
      authorizationContext: input.authorizationContext ?? {},
      data: input.data ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await tx
    .select()
    .from(orderFinancialEvents)
    .where(
      and(
        eq(orderFinancialEvents.orderId, input.orderId),
        eq(orderFinancialEvents.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing)
    throw new Error(
      `Financial entry ${input.orderId}/${input.idempotencyKey} conflicted without an existing row`,
    );
  if (
    existing.eventType !== input.eventType ||
    existing.amountMinor !== input.amountMinor ||
    existing.currencyCode !== input.currencyCode ||
    existing.businessRef !== input.businessRef
  )
    throw new Error(
      `Financial idempotency key ${input.orderId}/${input.idempotencyKey} was reused with different facts`,
    );
  return existing;
}

export async function journalForOrder(
  orderId: string,
  tx: any = db,
): Promise<JournalEntry[]> {
  return await tx
    .select()
    .from(orderFinancialEvents)
    .where(eq(orderFinancialEvents.orderId, orderId))
    .orderBy(asc(orderFinancialEvents.recordedAt), asc(orderFinancialEvents.id));
}

/** Commission accrual and the seller's payable, both tied to the completed order. */
export async function postCompletedOrderJournal(
  tx: any,
  order: {
    id: string;
    sellerId: string;
    currencyCode: string;
    subtotalMinor: number;
    platformFeeMinor: number;
    sellerAmountMinor: number;
    data: Record<string, any>;
  },
): Promise<JournalEntry> {
  const authorizationContext = {
    source: "ORDER_COMPLETION",
    orderStatus: "COMPLETED",
    commissionPolicy: order.data?.commissionPolicy ?? null,
  };
  await recordOrderFinancialEvent(tx, {
    orderId: order.id,
    eventType: "SELLER_PAYABLE_DUE",
    accountObligation: "SELLER_PAYABLE",
    businessRef: order.id,
    actorType: "SYSTEM",
    currencyCode: order.currencyCode,
    amountMinor: order.sellerAmountMinor,
    idempotencyKey: `seller-payable:${order.id}`,
    authorizationContext,
  });
  return recordOrderFinancialEvent(tx, {
    orderId: order.id,
    eventType: "COMMISSION_ACCRUED",
    accountObligation: "PLATFORM_COMMISSION",
    businessRef: order.id,
    actorType: "SYSTEM",
    currencyCode: order.currencyCode,
    amountMinor: order.platformFeeMinor,
    idempotencyKey: `commission-accrued:${order.id}`,
    authorizationContext,
    data: {
      subtotalMinor: order.subtotalMinor,
      rateBasisPoints: commissionRateForOrder(order),
    },
  });
}

/**
 * A refund after completion gives back the commission on the refunded portion. The
 * reversal is a new journal entry linked to the accrual; nothing is deleted or edited.
 */
export async function recordCommissionReversal(
  tx: any,
  input: {
    order: {
      id: string;
      sellerId: string;
      currencyCode: string;
      subtotalMinor: number;
      platformFeeMinor: number;
      data: Record<string, any>;
    };
    refundAmountMinor: number;
    previouslyRefundedMinor: number;
    businessRef: string;
  },
): Promise<JournalEntry | null> {
  const [accrual] = await tx
    .select()
    .from(orderFinancialEvents)
    .where(
      and(
        eq(orderFinancialEvents.orderId, input.order.id),
        eq(orderFinancialEvents.eventType, "COMMISSION_ACCRUED"),
      ),
    )
    .limit(1);
  const rateBasisPoints = commissionRateForOrder(input.order);
  const amountMinor = commissionReversalForRefund({
    grossMinor: input.order.subtotalMinor,
    previouslyRefundedMinor: input.previouslyRefundedMinor,
    refundAmountMinor: input.refundAmountMinor,
    rateBasisPoints,
  });
  if (amountMinor === 0) return null;
  return recordOrderFinancialEvent(tx, {
    orderId: input.order.id,
    eventType: "COMMISSION_REVERSED",
    accountObligation: "PLATFORM_COMMISSION",
    businessRef: input.businessRef,
    actorType: "SYSTEM",
    currencyCode: input.order.currencyCode,
    amountMinor,
    idempotencyKey: `commission-reversal:${input.businessRef}`,
    reversesEventId: accrual?.id ?? null,
    authorizationContext: {
      source: "REFUND_COMMISSION_ADJUSTMENT",
      rateBasisPoints,
      previouslyRefundedMinor: input.previouslyRefundedMinor,
      refundAmountMinor: input.refundAmountMinor,
    },
    data: {
      grossMinor: input.order.subtotalMinor,
      accrualMinor: input.order.platformFeeMinor,
    },
  });
}

/** Commission reversals per order, in one query for the seller-dues views. */
export async function commissionReversalsByOrder(
  orderIds: string[],
  tx: any = db,
): Promise<Map<string, number>> {
  if (!orderIds.length) return new Map();
  const rows = await tx
    .select({
      orderId: orderFinancialEvents.orderId,
      reversed: sql<string>`sum(${orderFinancialEvents.amountMinor})`,
    })
    .from(orderFinancialEvents)
    .where(
      and(
        inArray(orderFinancialEvents.orderId, orderIds),
        eq(orderFinancialEvents.eventType, "COMMISSION_REVERSED"),
      ),
    )
    .groupBy(orderFinancialEvents.orderId);
  return new Map(
    rows.map((row: { orderId: string; reversed: string | number }) => [
      row.orderId,
      Number(row.reversed),
    ]),
  );
}

/** Net commission still owed after refund reversals. */
export function netCommissionDueMinor(
  accruedMinor: number,
  reversedMinor: number,
): number {
  return Math.max(0, accruedMinor - reversedMinor);
}
