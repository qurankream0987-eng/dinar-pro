/**
 * Every merchant policy kind: its validated rule shape, the permission scope that may change it,
 * how sensitive a change is, and the scopes it can apply to. A rule is enforced only from these
 * validated shapes — never from the merchant's free text.
 */
import { z } from "zod";

export type Sensitivity = "NORMAL" | "SENSITIVE" | "HIGH_RISK";
export type ScopeKind = "STORE" | "PRODUCT" | "CATEGORY" | "REGION";
export type PolicyScope = (typeof import("@workspace/db").MERCHANT_POLICY_SCOPES)[number];

const minor = z.number().int().nonnegative().max(2_000_000_000);
const text = (max: number) => z.string().trim().min(1).max(max);
const areas = z.array(text(60)).min(1).max(50);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const POLICY_KINDS = {
  PAYMENT_METHODS: {
    scope: "policy.payment_methods",
    sensitivity: "SENSITIVE",
    scopes: ["STORE"],
    rule: z.object({ methods: z.array(z.object({ code: z.string().min(2).max(60), label: text(60).optional() }).strict()).min(1).max(12), keepStoreGateway: z.boolean() }).strict(),
    labelAr: "طرق الدفع",
  },
  PAYMENT_GATEWAY: {
    scope: "policy.payment_gateway",
    sensitivity: "HIGH_RISK",
    scopes: ["STORE"],
    // No gateway integration exists yet (M3/M4): this only records the merchant's intent.
    rule: z.object({ enabled: z.boolean(), providerLabel: text(60).optional() }).strict(),
    labelAr: "بوابة الدفع",
  },
  PAYOUT_DETAILS: {
    scope: "policy.payout_details",
    sensitivity: "HIGH_RISK",
    scopes: ["STORE"],
    rule: z.object({ method: z.string().min(2).max(60), beneficiaryName: text(120).optional(), iban: text(40).optional(), alias: text(80).optional(), walletNumber: text(40).optional(), bankName: text(80).optional() }).strict(),
    labelAr: "بيانات استقبال الأموال",
  },
  SHIPPING: {
    scope: "policy.shipping",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY", "REGION"],
    rule: z.object({ feeMinor: minor, freeAboveMinor: minor.optional(), etaDays: z.number().int().min(0).max(90).optional(), note: text(200).optional() }).strict(),
    labelAr: "الشحن",
  },
  COD_AREAS: {
    scope: "policy.shipping",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z.object({ areas }).strict(),
    labelAr: "مناطق الدفع عند الاستلام",
  },
  OUT_OF_STOCK: {
    scope: "policy.inventory",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z.object({ action: z.enum(["TELL_AND_CAPTURE_INTEREST", "TELL_ONLY", "NOT_SOLD"]), message: text(200), promiseDate: isoDate.nullable() }).strict(),
    labelAr: "نفاد المخزون",
  },
  PRE_ORDER: {
    scope: "policy.inventory",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z.object({ enabled: z.boolean(), note: text(200).optional() }).strict(),
    labelAr: "الطلب المسبق",
  },
  ALTERNATIVES: {
    scope: "policy.inventory",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z.object({ suggest: z.boolean() }).strict(),
    labelAr: "اقتراح البدائل",
  },
  MIN_ORDER: {
    scope: "policy.orders",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z.object({ minQuantity: z.number().int().min(1).max(100_000).optional(), minAmountMinor: minor.optional() }).strict().refine((r) => r.minQuantity !== undefined || r.minAmountMinor !== undefined, "minQuantity or minAmountMinor"),
    labelAr: "الحد الأدنى للطلب",
  },
  ORDERING_PAUSED: {
    scope: "policy.store_pause",
    sensitivity: "SENSITIVE",
    scopes: ["STORE"],
    rule: z.object({ paused: z.boolean(), reason: text(200).optional() }).strict(),
    labelAr: "إيقاف استقبال الطلبات",
  },
  GEO_RESTRICTION: {
    scope: "policy.products",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z.object({ allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(22) }).strict(),
    labelAr: "الدول المسموح البيع فيها",
  },
  PRICE_NEGOTIATION: {
    scope: "policy.negotiation",
    sensitivity: "SENSITIVE",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z
      .object({ allowed: z.boolean(), maxDiscountBps: z.number().int().min(0).max(9_000).optional(), floorMinor: minor.optional() })
      .strict()
      .refine((r) => !r.allowed || r.maxDiscountBps !== undefined || r.floorMinor !== undefined, "an allowed negotiation needs a limit"),
    labelAr: "حدود التفاوض على السعر",
  },
  DISCOUNT: {
    scope: "policy.discounts",
    sensitivity: "SENSITIVE",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z
      .object({ percentBps: z.number().int().min(1).max(9_000).optional(), amountMinor: minor.optional(), startsOn: isoDate.optional(), endsOn: isoDate.optional() })
      .strict()
      .refine((r) => (r.percentBps === undefined) !== (r.amountMinor === undefined), "exactly one of percentBps or amountMinor")
      .refine((r) => !r.startsOn || !r.endsOn || r.startsOn <= r.endsOn, "endsOn before startsOn"),
    labelAr: "الخصم",
  },
  BULK_INQUIRY: {
    scope: "policy.orders",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z.object({ thresholdQuantity: z.number().int().min(2).max(1_000_000), action: z.enum(["CONTACT_FOR_QUOTE"]) }).strict(),
    labelAr: "الطلبات بكميات كبيرة",
  },
  B2B_QUESTIONS: {
    scope: "policy.orders",
    sensitivity: "NORMAL",
    scopes: ["STORE", "PRODUCT", "CATEGORY"],
    rule: z.object({ askQuantity: z.boolean(), askCompanyName: z.boolean().optional() }).strict(),
    labelAr: "أسئلة عملاء الشركات",
  },
} as const satisfies Record<string, { scope: PolicyScope; sensitivity: Sensitivity; scopes: readonly ScopeKind[]; rule: z.ZodTypeAny; labelAr: string }>;

export type PolicyKind = keyof typeof POLICY_KINDS;
export const isPolicyKind = (value: string): value is PolicyKind => value in POLICY_KINDS;

/** Values in these fields never appear in the audit log in clear. */
export const MASKED_FIELDS: Partial<Record<PolicyKind, string[]>> = { PAYOUT_DETAILS: ["iban", "alias", "walletNumber", "beneficiaryName"] };
export function maskRule(kind: PolicyKind, rule: Record<string, unknown> | null) {
  if (!rule) return null;
  const masked = { ...rule };
  for (const field of MASKED_FIELDS[kind] ?? []) if (typeof masked[field] === "string") masked[field] = `•••${String(masked[field]).slice(-2)}`;
  return masked;
}
