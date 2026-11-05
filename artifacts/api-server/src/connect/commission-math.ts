import {
  ConnectAgreementTerms,
  type ConnectAgreement,
} from "@workspace/api-zod/connect-platform";
import { connectError } from "./provider-registry";
export type ConnectCommissionItem = {
  externalId: string;
  categoryId: string;
  grossMinor: number;
  eligible: boolean;
  basisPoints: number | null;
};
type InputItem = Pick<
  ConnectCommissionItem,
  "externalId" | "categoryId" | "grossMinor"
>;
type RefundItem = { externalId: string; amountMinor: number };
function minor(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw connectError(
      400,
      "INVALID_AMOUNT",
      "يلزم مبلغ صحيح غير سالب بوحدات العملة الصغرى",
    );
  return BigInt(value);
}
function safe(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw connectError(
      400,
      "AMOUNT_OUT_OF_RANGE",
      "المبلغ خارج حدود الدقة المدعومة",
    );
  return Number(value);
}
function divide(
  value: bigint,
  denominator: bigint,
  rounding: ConnectAgreement["rounding"],
): number {
  if (denominator <= 0n)
    throw connectError(400, "INVALID_BASIS", "أساس العمولة غير صالح");
  return safe(
    (value + (rounding === "HALF_UP" ? denominator / 2n : 0n)) / denominator,
  );
}
function unique(items: { externalId: string }[]) {
  if (
    !items.length ||
    items.length > 100 ||
    new Set(items.map((item) => item.externalId)).size !== items.length
  )
    throw connectError(
      400,
      "INVALID_ITEMS",
      "يلزم كشف بنود أصلي بلا معرّفات مكررة",
    );
}
export function commissionSnapshot(
  rawTerms: ConnectAgreement,
  source: InputItem[],
) {
  const terms = ConnectAgreementTerms.parse(rawTerms);
  unique(source);
  const items: ConnectCommissionItem[] = source.map((item) => {
    minor(item.grossMinor);
    const eligible =
      !terms.excludedProductIds.includes(item.externalId) &&
      !terms.excludedCategoryIds.includes(item.categoryId);
    return {
      ...item,
      eligible,
      basisPoints:
        terms.commission.kind === "PERCENTAGE"
          ? (terms.categoryRates.find(
              (rate) => rate.categoryId === item.categoryId,
            )?.basisPoints ?? terms.commission.basisPoints)
          : null,
    };
  });
  const calculated = remainingCommission(terms, items, []);
  return { ...calculated, items };
}
/** Recalculate only from immutable transaction item + accepted agreement snapshots.
 * Refund amounts are cumulative per product, never deltas or a replacement price. */
export function remainingCommission(
  rawTerms: ConnectAgreement,
  items: ConnectCommissionItem[],
  refunds: RefundItem[],
) {
  const terms = ConnectAgreementTerms.parse(rawTerms);
  unique(items);
  if (
    refunds.length > 100 ||
    new Set(refunds.map((item) => item.externalId)).size !== refunds.length
  )
    throw connectError(
      400,
      "INVALID_REFUND",
      "كشف الاسترداد مكرر أو أكبر من الحد المسموح",
    );
  const byId = new Map(
    refunds.map((item) => [item.externalId, minor(item.amountMinor)]),
  );
  if (
    [...byId.keys()].some(
      (key) => !items.some((item) => item.externalId === key),
    )
  )
    throw connectError(
      400,
      "UNKNOWN_REFUND_ITEM",
      "لا يمكن استرداد بند غير موجود في المعاملة الأصلية",
    );
  let gross = 0n,
    eligible = 0n,
    remaining = 0n,
    refunded = 0n,
    numerator = 0n;
  for (const item of items) {
    const amount = minor(item.grossMinor),
      returned = byId.get(item.externalId) ?? 0n;
    if (returned > amount)
      throw connectError(
        400,
        "REFUND_EXCEEDS_ORIGINAL",
        "مجموع الاسترداد يتجاوز مبلغ البند الأصلي",
      );
    gross += amount;
    refunded += returned;
    if (item.eligible) {
      eligible += amount;
      remaining += amount - returned;
      if (terms.commission.kind === "PERCENTAGE") {
        if (
          !Number.isInteger(item.basisPoints) ||
          item.basisPoints! < 0 ||
          item.basisPoints! > 10000
        )
          throw connectError(
            400,
            "INVALID_RATE_SNAPSHOT",
            "معدل العمولة المثبت غير صالح",
          );
        numerator += (amount - returned) * BigInt(item.basisPoints!);
      }
    }
  }
  const commissionMinor =
    remaining === 0n ||
    (terms.refundPolicy === "FULL_REVERSAL_ON_ANY_REFUND" && refunded > 0n)
      ? 0
      : terms.commission.kind === "PERCENTAGE"
        ? divide(numerator, 10000n, terms.rounding)
        : divide(
            BigInt(terms.commission.amountMinor) * remaining,
            eligible,
            terms.rounding,
          );
  return {
    grossMinor: safe(gross),
    eligibleMinor: safe(eligible),
    remainingEligibleMinor: safe(remaining),
    refundedMinor: safe(refunded),
    commissionMinor,
  };
}
