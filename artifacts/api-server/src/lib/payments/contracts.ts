import { createHash } from "node:crypto";
import { z } from "zod";

const providerId = z.string().min(1).max(180);
const currency = z.string().regex(/^[A-Z]{3}$/);
const amountMinor = z.number().int().positive().max(2_000_000_000);

export const PaymentWebhookEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: providerId,
      type: z.literal("CAPTURE_SUCCEEDED"),
      providerIntentId: providerId,
      amountMinor,
      currencyCode: currency,
    })
    .strict(),
  z
    .object({
      id: providerId,
      type: z.literal("REFUND_SUCCEEDED"),
      providerIntentId: providerId,
      providerRefundId: providerId,
      amountMinor,
      currencyCode: currency,
    })
    .strict(),
]);

export type PaymentWebhookEvent = z.infer<typeof PaymentWebhookEventSchema>;

export type ProviderPaymentSnapshot = {
  status: "PENDING" | "CAPTURED" | "PARTIALLY_REFUNDED" | "REFUNDED" | "DECLINED";
  amountMinor: number;
  capturedAmountMinor: number;
  refundedAmountMinor: number;
  currencyCode: string;
};

export type SignedPaymentWebhook = {
  event: PaymentWebhookEvent;
  signature: string;
};

export interface PaymentProviderAdapter {
  readonly providerKey: string;
  verifyWebhook(event: PaymentWebhookEvent, signature: string): boolean;
  getSnapshot(
    providerIntentId: string,
  ): Promise<ProviderPaymentSnapshot | undefined>;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortedJsonValue(entry)]),
    );
  }
  return value;
}

export function canonicalPaymentWebhook(event: PaymentWebhookEvent): string {
  return JSON.stringify(sortedJsonValue(event));
}

export function paymentWebhookDigest(event: PaymentWebhookEvent): string {
  return createHash("sha256")
    .update(canonicalPaymentWebhook(event))
    .digest("hex");
}