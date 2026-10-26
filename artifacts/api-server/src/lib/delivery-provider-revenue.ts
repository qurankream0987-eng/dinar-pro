import { z } from "zod";

/**
 * Contract data supplied by a configured delivery-provider agreement. It has no
 * default value and is not connected to any provider or financial authority.
 */
export const ExternalDeliveryRevenuePolicySchema = z.discriminatedUnion("model", [
  z
    .object({
      model: z.literal("PERCENTAGE"),
      basisPoints: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z
    .object({
      model: z.literal("FIXED_PER_COMPLETED_DELIVERY"),
      amountMinor: z.number().int().min(0).max(2_147_483_647),
      currencyCode: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict(),
  z
    .object({
      model: z.literal("CONTRACTUAL"),
      agreementReference: z.string().min(1).max(128),
    })
    .strict(),
]);

export type ExternalDeliveryRevenuePolicy = z.infer<
  typeof ExternalDeliveryRevenuePolicySchema
>;

export type ExternalDeliveryRevenueResolution =
  | { status: "NOT_COMPLETED"; amountMinor: 0 }
  | { status: "AGREEMENT_REQUIRED" }
  | { status: "CALCULATED"; amountMinor: number; currencyCode: string }
  | { status: "CONTRACTUAL_REVIEW"; agreementReference: string };

/** Calculate only from an explicit contract policy; never invent a provider share or FX rate. */
export function resolveExternalDeliveryRevenue(input: {
  policy: unknown | null;
  completed: boolean;
  fareMinor: number;
  currencyCode: string;
}): ExternalDeliveryRevenueResolution {
  if (!input.completed) return { status: "NOT_COMPLETED", amountMinor: 0 };
  if (input.policy === null || input.policy === undefined)
    return { status: "AGREEMENT_REQUIRED" };
  const parsed = ExternalDeliveryRevenuePolicySchema.parse(input.policy);
  if (!Number.isSafeInteger(input.fareMinor) || input.fareMinor < 0)
    throw new RangeError("Fare must be a non-negative minor-unit integer");
  if (parsed.model === "CONTRACTUAL")
    return {
      status: "CONTRACTUAL_REVIEW",
      agreementReference: parsed.agreementReference,
    };
  if (
    parsed.model === "FIXED_PER_COMPLETED_DELIVERY" &&
    parsed.currencyCode !== input.currencyCode
  )
    throw new Error("Provider contract currency must match the delivery market");
  const amountMinor =
    parsed.model === "PERCENTAGE"
      ? Number((BigInt(input.fareMinor) * BigInt(parsed.basisPoints) + 5000n) / 10000n)
      : parsed.amountMinor;
  return {
    status: "CALCULATED",
    amountMinor,
    currencyCode: input.currencyCode,
  };
}
