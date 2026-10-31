/**
 * Typed integration contracts for operations the conversation will reach but DINAR's AI does not
 * own: refunds, payout status, policy re-acceptance, support cases and disputes (Qoder W07–W12).
 *
 * This module defines the boundary only; it implements no finance, refund, policy or support
 * backend and registers nothing in ACTION_REGISTRY, so no new capability exists until an owner
 * plugs a real authority in. The rules it encodes are the same ones every DINAR action follows:
 *
 *  - A request carries identity and references only. Amounts, currency, fees, statuses and
 *    eligibility come from the authority's own records (parseOperationRequest rejects them).
 *  - review() is read-only and returns server-sourced lines; submit() needs a UserConfirmation,
 *    which only the user's own affirmative reply to that exact, unexpired review can mint.
 *    Model output can never produce one (no canonicalRequest may be a decision: routing-mode.ts).
 *  - submit() is idempotent by the request's idempotencyKey: a repeat returns the first receipt.
 *  - Success is said only from a receipt (operationOutcomeText). Nothing here marks money refunded;
 *    for refunds only a provider-signed REFUND_SUCCEEDED does (lib/payments/obligations.ts).
 *  - Until an authority is registered, every operation refuses with NOT_AVAILABLE.
 */
import { z } from "zod";
import { normalizeSearch } from "./search-context";

export const FUTURE_OPERATIONS = ["REFUND_REQUEST", "PAYOUT_STATUS", "POLICY_REACCEPTANCE", "SUPPORT_CASE", "DISPUTE_OPEN"] as const;
export type FutureOperation = (typeof FUTURE_OPERATIONS)[number];

/** What each operation may target; the authority re-checks ownership (404 for strangers). */
const TARGETS: Record<FutureOperation, readonly OperationTarget["kind"][]> = {
  REFUND_REQUEST: ["ORDER"],
  PAYOUT_STATUS: ["ACCOUNT"],
  POLICY_REACCEPTANCE: ["POLICY"],
  SUPPORT_CASE: ["ORDER", "LISTING", "ACCOUNT"],
  DISPUTE_OPEN: ["ORDER"],
};
export const OPERATION_REASON_CODES = ["NOT_RECEIVED", "NOT_AS_DESCRIBED", "DAMAGED", "CANCELLED_BY_SELLER", "ACCOUNT_HELP", "OTHER"] as const;

export type OperationTarget = { kind: "ORDER" | "LISTING" | "ACCOUNT" | "POLICY"; id: string };
export type OperationRequest = {
  operation: FutureOperation;
  actorId: string;
  marketId: string;
  target: OperationTarget;
  reasonCode?: (typeof OPERATION_REASON_CODES)[number];
  /** The user's own words for a support case, bounded; never used as an instruction. */
  note?: string;
  idempotencyKey: string;
};

const id = z.string().regex(/^[A-Za-z0-9_:-]{1,120}$/u);
const requestSchema = z.strictObject({
  operation: z.enum(FUTURE_OPERATIONS),
  actorId: id,
  marketId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
  target: z.strictObject({ kind: z.enum(["ORDER", "LISTING", "ACCOUNT", "POLICY"]), id }),
  reasonCode: z.enum(OPERATION_REASON_CODES).optional(),
  note: z.string().max(500).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_:.-]{8,160}$/u),
});

/**
 * The only way a request enters an authority. strictObject rejects amount, currency, fee,
 * status or approval fields whoever supplied them (client, model, another service).
 */
export function parseOperationRequest(value: unknown): { ok: true; request: OperationRequest } | { ok: false; code: "INVALID" } {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: "INVALID" };
  if (!TARGETS[parsed.data.operation].includes(parsed.data.target.kind)) return { ok: false, code: "INVALID" };
  return { ok: true, request: parsed.data };
}

export type ServerFact = { label: string; value: string; source: "SERVER_RECORD" };
export type OperationReview = {
  reviewId: string;
  operation: FutureOperation;
  actorId: string;
  target: OperationTarget;
  idempotencyKey: string;
  /** Every line is from the authority's records (amounts in the order's own currency snapshot). */
  facts: ServerFact[];
  expiresAt: string;
  requiresConfirmation: true;
};
export type OperationReceipt = {
  receiptId: string;
  operation: FutureOperation;
  /** SUBMITTED: the request is recorded, not resolved. A refund is never "refunded" here. */
  status: "SUBMITTED" | "ANSWERED";
  recordedAt: string;
  facts: ServerFact[];
};
export type OperationRefusal = { refused: true; code: "NOT_AVAILABLE" | "NOT_FOUND" | "NOT_ALLOWED" | "STALE" | "INVALID" | "EXPIRED" | "UNCONFIRMED" };

declare const confirmed: unique symbol;
/** Minted only by confirmationFromUser; the brand keeps any other code path from forging one. */
export type UserConfirmation = { readonly reviewId: string; readonly actorId: string; readonly confirmedAt: string; readonly [confirmed]: true };

const AFFIRMATIVE = /^(?:نعم|ايوه|ايوا|اكد|اؤكد|موافق|تمام|نفذ|ارسل|قدم|قدمه|قدمها|yes|confirm)$/u;

/**
 * The user's own affirmative reply to this exact review, before it expires. Anything else —
 * a negative, a longer sentence, another actor, an expired review — mints nothing.
 */
export function confirmationFromUser(review: OperationReview, input: { actorId: string; utterance: string; reviewId: string; now?: Date }): UserConfirmation | undefined {
  const now = input.now ?? new Date();
  if (input.actorId !== review.actorId || input.reviewId !== review.reviewId) return undefined;
  if (Date.parse(review.expiresAt) <= now.getTime()) return undefined;
  const text = normalizeSearch(input.utterance).replace(/[.!؟?،,]/gu, "").trim();
  if (!AFFIRMATIVE.test(text)) return undefined;
  return { reviewId: review.reviewId, actorId: review.actorId, confirmedAt: now.toISOString() } as UserConfirmation;
}

/** What Qoder's backend implements per operation. */
export interface OperationAuthority {
  readonly operation: FutureOperation;
  /** Read-only: ownership, eligibility and server facts. Never changes state. */
  review(request: OperationRequest): Promise<OperationReview | OperationRefusal>;
  /** The one write; idempotent by review.idempotencyKey. */
  submit(review: OperationReview, confirmation: UserConfirmation): Promise<OperationReceipt | OperationRefusal>;
}

const notAvailable = (operation: FutureOperation): OperationAuthority => ({
  operation,
  review: async () => ({ refused: true, code: "NOT_AVAILABLE" }),
  submit: async () => ({ refused: true, code: "NOT_AVAILABLE" }),
});
const authorities = new Map<FutureOperation, OperationAuthority>();

/** The authority for an operation: the registered one, or a refusal that changes nothing. */
export function operationAuthority(operation: FutureOperation): OperationAuthority {
  return authorities.get(operation) ?? notAvailable(operation);
}
/** For the owning backend's wiring (and test doubles). Returns the unregister function. */
export function registerOperationAuthority(authority: OperationAuthority): () => void {
  authorities.set(authority.operation, authority);
  return () => {
    if (authorities.get(authority.operation) === authority) authorities.delete(authority.operation);
  };
}

/**
 * Runs review → (user confirmation) → submit with the checks no authority may skip: the
 * confirmation must match the review, and a review must still be current when submitted.
 */
export async function submitConfirmedOperation(review: OperationReview, confirmation: UserConfirmation | undefined, now = new Date()): Promise<OperationReceipt | OperationRefusal> {
  if (!confirmation || confirmation.reviewId !== review.reviewId || confirmation.actorId !== review.actorId) return { refused: true, code: "UNCONFIRMED" };
  if (Date.parse(review.expiresAt) <= now.getTime()) return { refused: true, code: "EXPIRED" };
  return operationAuthority(review.operation).submit(review, confirmation);
}

const NAMES: Record<FutureOperation, string> = {
  REFUND_REQUEST: "طلب الاسترداد",
  PAYOUT_STATUS: "استعلام المستحقات",
  POLICY_REACCEPTANCE: "الموافقة على السياسة",
  SUPPORT_CASE: "طلب الدعم",
  DISPUTE_OPEN: "فتح النزاع",
};
/** User-facing outcome text: success words only with a receipt; a refund is "submitted", never "refunded". */
export function operationOutcomeText(operation: FutureOperation, result: OperationReceipt | OperationRefusal): string {
  if ("refused" in result)
    return result.code === "NOT_AVAILABLE"
      ? `${NAMES[operation]} غير متاح عبر المحادثة بعد. لم يُنفّذ أي إجراء.`
      : `لم يُنفّذ ${NAMES[operation]}. لم يتغير شيء.`;
  return `سُجّل ${NAMES[operation]} (رقم ${result.receiptId}). ${operation === "REFUND_REQUEST" ? "هذا طلب، وليس استردادًا تمّ؛ ستصلك النتيجة عند معالجته." : ""}`.trim();
}
