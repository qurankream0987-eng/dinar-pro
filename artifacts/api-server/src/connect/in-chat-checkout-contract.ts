/**
 * Connect-02 — Server-Authoritative In-Chat Checkout State Machine Contract.
 * 100% aligned with front-end InChatPaymentCard (AVAILABLE, UNAVAILABLE_IN_COUNTRY, PENDING, PAID, FAILED, REFUNDED).
 * Enforces PRE_LEGAL market blocking and legal state transitions (never marks PAID without PENDING provider confirmation).
 */
import { z } from "zod";

export const IN_CHAT_PAYMENT_STATES = ["AVAILABLE", "UNAVAILABLE_IN_COUNTRY", "PENDING", "PAID", "FAILED", "REFUNDED"] as const;
export type InChatPaymentState = (typeof IN_CHAT_PAYMENT_STATES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<InChatPaymentState, readonly InChatPaymentState[]>> = {
  AVAILABLE: ["PENDING", "UNAVAILABLE_IN_COUNTRY"],
  UNAVAILABLE_IN_COUNTRY: [],
  PENDING: ["PAID", "FAILED"],
  PAID: ["REFUNDED"],
  FAILED: ["PENDING", "AVAILABLE"],
  REFUNDED: [],
};

export const InChatCheckoutSessionSchema = z.object({
  sessionId: z.string().min(4).max(80),
  partnerId: z.string().min(2).max(80),
  marketId: z.string().min(2).max(10),
  operationMode: z.enum(["FULL", "PRE_LEGAL", "CLOSED"]),
  amountMinor: z.number().int().min(1),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  state: z.enum(IN_CHAT_PAYMENT_STATES),
  idempotencyKey: z.string().min(8).max(120),
  providerReferenceId: z.string().max(120).optional(),
});
export type InChatCheckoutSession = z.infer<typeof InChatCheckoutSessionSchema>;

export function canTransitionInChatPayment(from: InChatPaymentState, to: InChatPaymentState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function resolveInitialInChatPaymentState(input: { operationMode: "FULL" | "PRE_LEGAL" | "CLOSED"; providerEnabledInMarket: boolean }): { state: InChatPaymentState; reasonAr?: string } {
  if (input.operationMode !== "FULL") {
    return { state: "UNAVAILABLE_IN_COUNTRY", reasonAr: "الدفع الإلكتروني داخل المحادثة غير متاح في هذا السوق حاليًا (تشغيل تقني — الدفع نقدًا فقط)." };
  }
  if (!input.providerEnabledInMarket) {
    return { state: "UNAVAILABLE_IN_COUNTRY", reasonAr: "بوابة الدفع غير مفعّلة في دولتك حاليًا." };
  }
  return { state: "AVAILABLE" };
}

export function applyInChatPaymentTransition(session: InChatCheckoutSession, nextState: InChatPaymentState, providerReferenceId?: string): InChatCheckoutSession {
  if (!canTransitionInChatPayment(session.state, nextState)) {
    throw new Error(`Illegal in-chat payment state transition: ${session.state} -> ${nextState}`);
  }
  return { ...session, state: nextState, ...(providerReferenceId ? { providerReferenceId } : {}) };
}
