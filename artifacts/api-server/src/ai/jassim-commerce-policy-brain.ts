/**
 * Jassim Intelligent Commerce, Payment Agreement & Conversational Merchant Policy Brain.
 *
 * Trains and powers JassimAI on the unified Payment Policy, Seller Classification,
 * Connect 10% Direct-Profit Share, 3 Store Operating Modes (A/B/C), 12 Conversational
 * Merchant Policies, Fact Provenance, and Unified Payment Options Composer.
 *
 * Core Invariants:
 * 1. JassimAI is NEVER a payment custodian: direct settlements happen between buyer and seller.
 * 2. Sensitive payment instructions (IBAN, CliQ alias, phone, merchant payment link) NEVER pass
 *    through chat messages; they are submitted and read exclusively via the protected Deal Card vault.
 * 3. The LLM NEVER computes prices, commissions, profit shares, or payment verification statuses;
 *    deterministic code computes all numbers and fills validated card contracts.
 * 4. Every fact in a policy or store response carries explicit provenance:
 *    STORE_SYSTEM | MERCHANT_POLICY | UNCONFIRMED | NEEDS_MERCHANT_APPROVAL.
 */
import { z } from "zod";
import { connectProfitShare, type DirectCost } from "../connect/profit-share";

export type SellerClassification =
  | "PERSONAL_SELLER"
  | "INDIVIDUAL_MERCHANT"
  | "REGISTERED_BUSINESS"
  | "CONNECT_PARTNER"
  | "UNDER_REVIEW";

export type Signal = { key: string; weight: number; detail?: string };

export const CLASSIFICATION_LABELS_AR: Record<SellerClassification, string> = {
  PERSONAL_SELLER: "بائع فردي (مقتنيات شخصية)",
  INDIVIDUAL_MERCHANT: "تاجر فردي",
  REGISTERED_BUSINESS: "شركة أو متجر مسجل",
  CONNECT_PARTNER: "شريك Jassim Connect",
  UNDER_REVIEW: "قيد المراجعة",
};

export const COMMERCE_OPERATING_MODES = [
  "MODE_A_CONNECTED_GATEWAY",
  "MODE_B_CONNECTED_DIRECT",
  "MODE_C_INDEPENDENT_SELLER",
] as const;
export type CommerceOperatingMode = (typeof COMMERCE_OPERATING_MODES)[number];

export const COMMERCE_PROVENANCE_TAGS = [
  "STORE_SYSTEM",
  "MERCHANT_POLICY",
  "UNCONFIRMED",
  "NEEDS_MERCHANT_APPROVAL",
] as const;
export type CommerceProvenanceTag = (typeof COMMERCE_PROVENANCE_TAGS)[number];

export const MERCHANT_POLICY_KINDS = [
  "PAYMENT_METHODS",
  "SHIPPING",
  "OUT_OF_STOCK",
  "MIN_ORDER",
  "PRE_ORDER",
  "PRICE_NEGOTIATION",
  "ORDERING_PAUSED",
  "GEO_RESTRICTION",
  "COD_AREAS",
  "BULK_INQUIRY",
  "B2B_QUESTIONS",
  "ALTERNATIVES",
] as const;
export type MerchantPolicyKind = (typeof MERCHANT_POLICY_KINDS)[number];

export const MERCHANT_POLICY_LABELS_AR: Record<MerchantPolicyKind, string> = {
  PAYMENT_METHODS: "سياسة طرق الدفع المقبولة",
  SHIPPING: "سياسة الشحن والتوصيل",
  OUT_OF_STOCK: "سياسة نفاد المخزون وتسجيل الاهتمام",
  MIN_ORDER: "سياسة الحد الأدنى للطلب",
  PRE_ORDER: "سياسة الطلب المسبق",
  PRICE_NEGOTIATION: "سياسة حدود التفاوض السعري",
  ORDERING_PAUSED: "سياسة الإيقاف المؤقت لاستقبال الطلبات",
  GEO_RESTRICTION: "سياسة النطاق الجغرافي",
  COD_AREAS: "سياسة مناطق الدفع عند الاستلام",
  BULK_INQUIRY: "سياسة طلبات الجملة والكميات الكبيرة",
  B2B_QUESTIONS: "سياسة مبيعات الشركات (B2B)",
  ALTERNATIVES: "سياسة اقتراح البدائل عند النفاد",
};

export const OutOfStockRuleSchema = z.object({
  kind: z.literal("OUT_OF_STOCK"),
  messageAr: z.string().min(2).max(240),
  captureInterest: z.boolean(),
  promiseDate: z.string().nullable().default(null),
});

export const PriceNegotiationRuleSchema = z.object({
  kind: z.literal("PRICE_NEGOTIATION"),
  floorMinor: z.number().int().nonnegative(),
  ceilingMinor: z.number().int().nonnegative(),
  currencyCode: z.string().min(3).max(4),
  autoAcceptAtOrAboveFloor: z.boolean().default(true),
});

export const ShippingRuleSchema = z.object({
  kind: z.literal("SHIPPING"),
  feeMinor: z.number().int().nonnegative(),
  freeAboveMinor: z.number().int().nonnegative().nullable().default(null),
  currencyCode: z.string().min(3).max(4),
});

export const MinOrderRuleSchema = z.object({
  kind: z.literal("MIN_ORDER"),
  minAmountMinor: z.number().int().positive(),
  currencyCode: z.string().min(3).max(4),
});

export const CodAreasRuleSchema = z.object({
  kind: z.literal("COD_AREAS"),
  allowedAreasAr: z.array(z.string().min(2).max(60)).min(1).max(30),
});

export const OrderingPausedRuleSchema = z.object({
  kind: z.literal("ORDERING_PAUSED"),
  paused: z.boolean(),
  reasonAr: z.string().min(2).max(200),
});

export const PaymentMethodsRuleSchema = z.object({
  kind: z.literal("PAYMENT_METHODS"),
  methods: z.array(z.string().min(2).max(60)).min(1).max(15),
});

export const GenericMerchantPolicyRuleSchema = z.object({
  kind: z.enum(["PRE_ORDER", "GEO_RESTRICTION", "BULK_INQUIRY", "B2B_QUESTIONS", "ALTERNATIVES"]),
  summaryAr: z.string().min(2).max(240),
  requiresMerchantApprovalForExecution: z.boolean().default(true),
});

export const MerchantPolicyRuleSchema = z.discriminatedUnion("kind", [
  OutOfStockRuleSchema,
  PriceNegotiationRuleSchema,
  ShippingRuleSchema,
  MinOrderRuleSchema,
  CodAreasRuleSchema,
  OrderingPausedRuleSchema,
  PaymentMethodsRuleSchema,
  GenericMerchantPolicyRuleSchema,
]);
export type MerchantPolicyRule = z.infer<typeof MerchantPolicyRuleSchema>;

export interface ConversationalPolicyProposal {
  policyId: string;
  kind: MerchantPolicyKind;
  labelAr: string;
  scope: "STORE_WIDE" | "CATEGORY" | "PRODUCT";
  status: "PROPOSED" | "ACTIVE";
  requiresExplicitConfirmation: true;
  provenance: CommerceProvenanceTag;
  version: number;
  rule: MerchantPolicyRule;
  summaryAr: string;
  sourceText: string;
}

export interface StoreCheckoutAdapterSupportInput {
  country: string;
  currency: string;
  amountMinor: number;
}

export interface StoreCheckoutAdapterDescriptor {
  id: string;
  labelAr: string;
  verifiedIntegration: boolean;
  supports: (input: StoreCheckoutAdapterSupportInput) => boolean;
}

/**
 * Resolves the authoritative Operating Mode (A, B, or C) from real backend facts,
 * NEVER from LLM claims.
 */
export function resolveCommerceOperatingMode(input: {
  isApprovedConnectPartner: boolean;
  hasVerifiedGatewayAdapter: boolean;
  gatewaySupportsOrder?: boolean;
}): {
  mode: CommerceOperatingMode;
  labelAr: string;
  descriptionAr: string;
  gatewayEligible: boolean;
} {
  if (input.isApprovedConnectPartner && input.hasVerifiedGatewayAdapter && input.gatewaySupportsOrder !== false) {
    return {
      mode: "MODE_A_CONNECTED_GATEWAY",
      labelAr: "النمط A — متجر مرتبط ببوابة دفع موثقة + طرق مباشرة",
      descriptionAr: "تُعرض بوابة المتجر الرسمية عبر محوّلها الموثق إلى جانب أي وسائل دفع مباشرة اعتمدها التاجر.",
      gatewayEligible: true,
    };
  }
  if (input.isApprovedConnectPartner) {
    return {
      mode: "MODE_B_CONNECTED_DIRECT",
      labelAr: "النمط B — متجر مرتبط بوسائل دفع مباشرة",
      descriptionAr: "تُستخدم وسائل الدفع المباشرة التي حددها التاجر عبر بطاقة اتفاق الدفع والخزنة المحمية.",
      gatewayEligible: false,
    };
  }
  return {
    mode: "MODE_C_INDEPENDENT_SELLER",
    labelAr: "النمط C — بائع مستقل بتفاوض مفتوح وخزنة محمية",
    descriptionAr: "يتفق البائع والمشتري على أي وسيلة دفع مباشرة، وتُشارك بيانات التحويل عبر النموذج المحمي فقط.",
    gatewayEligible: false,
  };
}

const normalizeAr = (text: string) =>
  text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Parses a natural Arabic merchant instruction into a validated `PROPOSED` merchant policy.
 * Never activates a policy without explicit merchant confirmation (`status: "PROPOSED"`).
 */
export function parseConversationalMerchantPolicy(input: {
  message: string;
  currencyCode: string;
  minorUnitScale?: number;
  version?: number;
}): ConversationalPolicyProposal | null {
  const raw = input.message.trim();
  const norm = normalizeAr(raw);
  if (!norm) return null;

  const scale = input.minorUnitScale ?? 100;
  const version = input.version ?? 1;

  // 1. OUT_OF_STOCK policy («إذا نفد الهاتف أخبرهم أنه سيعود قريبًا وخذ أرقامهم»)
  if (/(?:اذا|لو|عند|في حال)\s+(?:نفد|خلص|انتهي|غير متوفر)|سياسه نفاد/u.test(norm)) {
    const captureInterest = /(?:خذ|سجل|احفظ|اجمع)\s+(?:ارقامهم|رقمهم|اهتمامهم|طلباتهم)|تنبيه|اعلمهم/u.test(norm);
    const comeBackSoon = /(?:سيعود قريبا|سيتوفر قريبا|راجع قريبا|قريبا)/u.test(norm);
    const messageAr = comeBackSoon
      ? "المنتج نافد حاليًا وسيعود قريبًا بإذن الله."
      : "المنتج غير متوفر في المخزون حاليًا.";
    const rule = OutOfStockRuleSchema.parse({
      kind: "OUT_OF_STOCK",
      messageAr,
      captureInterest,
      promiseDate: null, // Never invent a date unless explicitly set
    });
    return {
      policyId: `pol-oos-v${version}`,
      kind: "OUT_OF_STOCK",
      labelAr: MERCHANT_POLICY_LABELS_AR.OUT_OF_STOCK,
      scope: "STORE_WIDE",
      status: "PROPOSED",
      requiresExplicitConfirmation: true,
      provenance: "MERCHANT_POLICY",
      version,
      rule,
      summaryAr: `${messageAr}${captureInterest ? " مع تفعيل تسجيل اهتمام المشترين وأرقامهم تلقائيًا دون وعد بموعد غير مؤكد." : ""}`,
      sourceText: raw,
    };
  }

  // 2. PRICE_NEGOTIATION policy («حد التفاوض من 220 إلى 250», «لا تقبل تفاوض أقل من 220»)
  if (/(?:حد|حدود|سقف|ادني)\s+(?:التفاوض|الخصم|السعر)|(?:لا تقبل|ما تقبل)\s+(?:تفاوض|سعر)\s+(?:اقل|تحت)/u.test(norm)) {
    const nums = [...norm.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    if (nums.length >= 1) {
      const floorMajor = Math.min(...nums);
      const ceilingMajor = nums.length >= 2 ? Math.max(...nums) : floorMajor;
      const rule = PriceNegotiationRuleSchema.parse({
        kind: "PRICE_NEGOTIATION",
        floorMinor: Math.round(floorMajor * scale),
        ceilingMinor: Math.round(ceilingMajor * scale),
        currencyCode: input.currencyCode,
        autoAcceptAtOrAboveFloor: true,
      });
      return {
        policyId: `pol-neg-v${version}`,
        kind: "PRICE_NEGOTIATION",
        labelAr: MERCHANT_POLICY_LABELS_AR.PRICE_NEGOTIATION,
        scope: "STORE_WIDE",
        status: "PROPOSED",
        requiresExplicitConfirmation: true,
        provenance: "MERCHANT_POLICY",
        version,
        rule,
        summaryAr: `الحد الأدنى للتفاوض ${floorMajor} ${input.currencyCode}${ceilingMajor > floorMajor ? ` والسقف ${ceilingMajor} ${input.currencyCode}` : ""}؛ أي عرض أقل يُرفض أو يُحال لموافقة التاجر.`,
        sourceText: raw,
      };
    }
  }

  // 3. SHIPPING policy («التوصيل 3 دنانير ومجاني فوق 50»)
  if (/(?:سياسه|سعر|رسوم)\s+(?:الشحن|التوصيل)|(?:التوصيل|الشحن)\s+ب?\s*\d+/u.test(norm)) {
    const nums = [...norm.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    if (nums.length >= 1) {
      const feeMajor = nums[0]!;
      const freeAboveMajor = nums.length >= 2 && /مجاني|فوق|اكثر من/u.test(norm) ? nums[1]! : null;
      const rule = ShippingRuleSchema.parse({
        kind: "SHIPPING",
        feeMinor: Math.round(feeMajor * scale),
        freeAboveMinor: freeAboveMajor !== null ? Math.round(freeAboveMajor * scale) : null,
        currencyCode: input.currencyCode,
      });
      return {
        policyId: `pol-ship-v${version}`,
        kind: "SHIPPING",
        labelAr: MERCHANT_POLICY_LABELS_AR.SHIPPING,
        scope: "STORE_WIDE",
        status: "PROPOSED",
        requiresExplicitConfirmation: true,
        provenance: "MERCHANT_POLICY",
        version,
        rule,
        summaryAr: `رسوم التوصيل ${feeMajor} ${input.currencyCode}${freeAboveMajor !== null ? `، ومجاني للطلبات فوق ${freeAboveMajor} ${input.currencyCode}` : ""}.`,
        sourceText: raw,
      };
    }
  }

  // 4. MIN_ORDER policy («الحد الأدنى للطلب 15 دينار»)
  if (/الحد الادني للطلب|اقل طلب/u.test(norm)) {
    const match = norm.match(/(\d+(?:\.\d+)?)/);
    if (match) {
      const minMajor = Number(match[1]);
      const rule = MinOrderRuleSchema.parse({
        kind: "MIN_ORDER",
        minAmountMinor: Math.round(minMajor * scale),
        currencyCode: input.currencyCode,
      });
      return {
        policyId: `pol-min-v${version}`,
        kind: "MIN_ORDER",
        labelAr: MERCHANT_POLICY_LABELS_AR.MIN_ORDER,
        scope: "STORE_WIDE",
        status: "PROPOSED",
        requiresExplicitConfirmation: true,
        provenance: "MERCHANT_POLICY",
        version,
        rule,
        summaryAr: `الحد الأدنى لقبول الطلب هو ${minMajor} ${input.currencyCode}.`,
        sourceText: raw,
      };
    }
  }

  // 5. ORDERING_PAUSED policy («أوقف استقبال الطلبات مؤقتًا بسبب الجرد»)
  if (/(?:اوقف|ايقاف|وقف|عطل)\s+(?:استقبال\s+)?(?:الطلبات|البيع)\s*(?:مؤقتا)?/u.test(norm)) {
    const rule = OrderingPausedRuleSchema.parse({
      kind: "ORDERING_PAUSED",
      paused: true,
      reasonAr: raw.length <= 160 ? raw : "إيقاف مؤقت لاستقبال الطلبات بطلب التاجر.",
    });
    return {
      policyId: `pol-pause-v${version}`,
      kind: "ORDERING_PAUSED",
      labelAr: MERCHANT_POLICY_LABELS_AR.ORDERING_PAUSED,
      scope: "STORE_WIDE",
      status: "PROPOSED",
      requiresExplicitConfirmation: true,
      provenance: "MERCHANT_POLICY",
      version,
      rule,
      summaryAr: "إيقاف استقبال الطلبات الجديدة مؤقتًا مع إبقاء التصفح والاستفسار متاحين.",
      sourceText: raw,
    };
  }

  // 6. COD_AREAS policy («الدفع عند الاستلام في عمان والزرقاء فقط»)
  if (/الدفع عند الاستلام\s+(?:في|داخل|فقط في)\s+(.+)/u.test(norm)) {
    const match = norm.match(/الدفع عند الاستلام\s+(?:في|داخل|فقط في)\s+(.+)/u);
    const rawAreas = (match?.[1] ?? "")
      .replace(/\s*فقط.*$/u, "")
      .split(/\s+(?:و|او)\s*|،|,/u)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    if (rawAreas.length > 0) {
      const rule = CodAreasRuleSchema.parse({
        kind: "COD_AREAS",
        allowedAreasAr: rawAreas,
      });
      return {
        policyId: `pol-cod-v${version}`,
        kind: "COD_AREAS",
        labelAr: MERCHANT_POLICY_LABELS_AR.COD_AREAS,
        scope: "STORE_WIDE",
        status: "PROPOSED",
        requiresExplicitConfirmation: true,
        provenance: "MERCHANT_POLICY",
        version,
        rule,
        summaryAr: `الدفع نقدًا عند الاستلام متاح في: ${rawAreas.join("، ")}.`,
        sourceText: raw,
      };
    }
  }

  return null;
}

/**
 * Evaluates active merchant policies against real store system facts.
 * Invariant: Merchant policy NEVER overrides live store system stock facts (`STORE_SYSTEM` > `MERCHANT_POLICY`).
 */
export function evaluateStoreTurnWithPolicies(input: {
  storeSystemStockQuantity: number;
  unitPriceMinor: number;
  requestedQuantity: number;
  offeredUnitPriceMinor?: number;
  buyerAreaAr?: string;
  currencyCode: string;
  minorUnitScale?: number;
  activePolicies: readonly ConversationalPolicyProposal[];
}): {
  canProceedToOrder: boolean;
  provenance: CommerceProvenanceTag;
  shippingFeeMinor: number;
  totalMinor: number;
  outOfStockNoticeAr?: string;
  captureBuyerInterest?: boolean;
  negotiationOutcome?: "ACCEPTED_BY_POLICY" | "NEEDS_MERCHANT_APPROVAL" | "WITHIN_LIST_PRICE";
  rejectionReasonAr?: string;
} {
  const active = input.activePolicies.filter((p) => p.status === "ACTIVE");

  // 1. Check ORDERING_PAUSED policy
  const pausePolicy = active.find((p) => p.rule.kind === "ORDERING_PAUSED");
  if (pausePolicy && pausePolicy.rule.kind === "ORDERING_PAUSED" && pausePolicy.rule.paused) {
    return {
      canProceedToOrder: false,
      provenance: "MERCHANT_POLICY",
      shippingFeeMinor: 0,
      totalMinor: 0,
      rejectionReasonAr: `استقبال الطلبات متوقف مؤقتًا بأمر التاجر (${pausePolicy.rule.reasonAr}).`,
    };
  }

  // 2. Check live STORE_SYSTEM stock first (policy never claims out-of-stock if stock > 0)
  if (input.storeSystemStockQuantity <= 0 || input.storeSystemStockQuantity < input.requestedQuantity) {
    const oosPolicy = active.find((p) => p.rule.kind === "OUT_OF_STOCK");
    if (oosPolicy && oosPolicy.rule.kind === "OUT_OF_STOCK") {
      return {
        canProceedToOrder: false,
        provenance: "MERCHANT_POLICY",
        shippingFeeMinor: 0,
        totalMinor: 0,
        outOfStockNoticeAr: oosPolicy.rule.messageAr,
        captureBuyerInterest: oosPolicy.rule.captureInterest,
      };
    }
    return {
      canProceedToOrder: false,
      provenance: "STORE_SYSTEM",
      shippingFeeMinor: 0,
      totalMinor: 0,
      outOfStockNoticeAr: "الكمية المطلوبة غير متوفرة حاليًا في مخزون المتجر.",
      captureBuyerInterest: true,
    };
  }

  // 3. Check PRICE_NEGOTIATION policy if buyer proposed a lower price
  let effectiveUnitMinor = input.unitPriceMinor;
  let negotiationOutcome: "ACCEPTED_BY_POLICY" | "NEEDS_MERCHANT_APPROVAL" | "WITHIN_LIST_PRICE" = "WITHIN_LIST_PRICE";
  if (typeof input.offeredUnitPriceMinor === "number" && input.offeredUnitPriceMinor < input.unitPriceMinor) {
    const negPolicy = active.find((p) => p.rule.kind === "PRICE_NEGOTIATION");
    if (negPolicy && negPolicy.rule.kind === "PRICE_NEGOTIATION") {
      if (input.offeredUnitPriceMinor >= negPolicy.rule.floorMinor) {
        effectiveUnitMinor = input.offeredUnitPriceMinor;
        negotiationOutcome = "ACCEPTED_BY_POLICY";
      } else {
        return {
          canProceedToOrder: false,
          provenance: "NEEDS_MERCHANT_APPROVAL",
          shippingFeeMinor: 0,
          totalMinor: 0,
          negotiationOutcome: "NEEDS_MERCHANT_APPROVAL",
          rejectionReasonAr: "السعر المقترح أقل من الحد المسموح به تلقائيًا ويحتاج موافقة خاصة من التاجر.",
        };
      }
    } else {
      return {
        canProceedToOrder: false,
        provenance: "NEEDS_MERCHANT_APPROVAL",
        shippingFeeMinor: 0,
        totalMinor: 0,
        negotiationOutcome: "NEEDS_MERCHANT_APPROVAL",
        rejectionReasonAr: "هذا العرض السعري يحتاج موافقة التاجر.",
      };
    }
  }

  const subtotalMinor = effectiveUnitMinor * input.requestedQuantity;

  // 4. Check MIN_ORDER policy
  const minPolicy = active.find((p) => p.rule.kind === "MIN_ORDER");
  if (minPolicy && minPolicy.rule.kind === "MIN_ORDER" && subtotalMinor < minPolicy.rule.minAmountMinor) {
    return {
      canProceedToOrder: false,
      provenance: "MERCHANT_POLICY",
      shippingFeeMinor: 0,
      totalMinor: subtotalMinor,
      rejectionReasonAr: minPolicy.summaryAr,
    };
  }

  // 5. Calculate SHIPPING from policy (code always calculates)
  let shippingFeeMinor = 0;
  const shipPolicy = active.find((p) => p.rule.kind === "SHIPPING");
  if (shipPolicy && shipPolicy.rule.kind === "SHIPPING") {
    if (shipPolicy.rule.freeAboveMinor !== null && subtotalMinor >= shipPolicy.rule.freeAboveMinor) {
      shippingFeeMinor = 0;
    } else {
      shippingFeeMinor = shipPolicy.rule.feeMinor;
    }
  }

  return {
    canProceedToOrder: true,
    provenance: shipPolicy || negotiationOutcome === "ACCEPTED_BY_POLICY" ? "MERCHANT_POLICY" : "STORE_SYSTEM",
    shippingFeeMinor,
    totalMinor: subtotalMinor + shippingFeeMinor,
    negotiationOutcome,
  };
}

export interface UnifiedPaymentOptionEntry {
  code: string;
  labelAr: string;
  channel: "MERCHANT_GATEWAY" | "DIRECT_TO_SELLER" | "COD";
  standing: "INTEGRATED_PROVIDER" | "VERIFIED_METHOD" | "UNDER_REVIEW" | "USER_DECLARED_METHOD";
  available: boolean;
  provenance: CommerceProvenanceTag;
  noteAr?: string;
}

/**
 * Unified PAYMENT_OPTIONS composer: merges a Mode A verified store gateway checkout
 * (when supported for country/currency/amount) with the merchant's direct payment methods
 * and COD area rules into one authoritative options card.
 */
export function composeUnifiedPaymentOptionsCard(input: {
  orderRef: string;
  countryCode: string;
  currencyCode: string;
  amountMinor: number;
  buyerAreaAr?: string;
  isApprovedConnectPartner: boolean;
  gatewayAdapter?: StoreCheckoutAdapterDescriptor | null;
  directMethods: ReadonlyArray<{
    code: string;
    labelAr: string;
    kind: "DIRECT" | "COD";
    standing: "VERIFIED_METHOD" | "UNDER_REVIEW" | "USER_DECLARED_METHOD";
  }>;
  codAllowedAreasAr?: readonly string[];
}): {
  operatingMode: CommerceOperatingMode;
  orderRef: string;
  options: UnifiedPaymentOptionEntry[];
} {
  const gatewaySupports =
    Boolean(input.gatewayAdapter?.verifiedIntegration) &&
    Boolean(
      input.gatewayAdapter?.supports({
        country: input.countryCode,
        currency: input.currencyCode,
        amountMinor: input.amountMinor,
      }),
    );

  const modeInfo = resolveCommerceOperatingMode({
    isApprovedConnectPartner: input.isApprovedConnectPartner,
    hasVerifiedGatewayAdapter: Boolean(input.gatewayAdapter?.verifiedIntegration),
    gatewaySupportsOrder: gatewaySupports,
  });

  const options: UnifiedPaymentOptionEntry[] = [];

  if (modeInfo.gatewayEligible && input.gatewayAdapter) {
    options.push({
      code: `GATEWAY:${input.gatewayAdapter.id}`,
      labelAr: input.gatewayAdapter.labelAr,
      channel: "MERCHANT_GATEWAY",
      standing: "INTEGRATED_PROVIDER",
      available: true,
      provenance: "STORE_SYSTEM",
      noteAr: "بوابة المتجر الرسمية الموثقة (تأكيد الدفع يتم عبر Webhook موقّع ومطابقة الدفعة).",
    });
  }

  for (const method of input.directMethods) {
    if (method.kind === "COD") {
      const areaAllowed =
        !input.codAllowedAreasAr?.length ||
        !input.buyerAreaAr ||
        input.codAllowedAreasAr.some((area) => normalizeAr(area) === normalizeAr(input.buyerAreaAr!));
      options.push({
        code: method.code,
        labelAr: method.labelAr,
        channel: "COD",
        standing: method.standing,
        available: areaAllowed,
        provenance: input.codAllowedAreasAr?.length ? "MERCHANT_POLICY" : "STORE_SYSTEM",
        noteAr: areaAllowed ? "الدفع نقدًا عند الاستلام" : `متاح فقط في: ${input.codAllowedAreasAr?.join("، ")}`,
      });
    } else {
      options.push({
        code: method.code,
        labelAr: method.labelAr,
        channel: "DIRECT_TO_SELLER",
        standing: method.standing,
        available: true,
        provenance: "MERCHANT_POLICY",
        noteAr:
          method.standing === "USER_DECLARED_METHOD"
            ? "وسيلة مباشرة يحددها التاجر (تعليمات محمية داخل البطاقة)"
            : "تحويل مباشر للتاجر عبر الخزنة المحمية",
      });
    }
  }

  return {
    operatingMode: modeInfo.mode,
    orderRef: input.orderRef,
    options,
  };
}

/**
 * Enforces the Mode A StoreCheckoutAdapter payment verification law:
 * Returning from a checkout URL or a buyer clicking "I paid" NEVER marks a payment PAID.
 * Only a signed webhook + non-duplicate eventId + provider re-fetch matching orderRef, amountMinor, and currency can mark PAID.
 */
export function verifyAuthoritativeGatewayPayment(input: {
  expectedOrderRef: string;
  expectedAmountMinor: number;
  expectedCurrency: string;
  webhookSignatureValid: boolean;
  eventAlreadyProcessed: boolean;
  refetchedPayment: {
    orderRef: string;
    amountMinor: number;
    currency: string;
    status: "PAID" | "FAILED" | "REFUNDED" | "DISPUTED" | "PENDING";
  } | null;
}): {
  verifiedPaid: boolean;
  status: "PAID" | "REJECTED_SIGNATURE" | "DUPLICATE_EVENT" | "MISMATCH" | "NOT_PAID";
  reasonAr: string;
} {
  if (!input.webhookSignatureValid) {
    return { verifiedPaid: false, status: "REJECTED_SIGNATURE", reasonAr: "توقيع حدث بوابة الدفع غير صالح." };
  }
  if (input.eventAlreadyProcessed) {
    return { verifiedPaid: false, status: "DUPLICATE_EVENT", reasonAr: "تمت معالجة حدث بوابة الدفع مسبقًا." };
  }
  if (!input.refetchedPayment) {
    return { verifiedPaid: false, status: "NOT_PAID", reasonAr: "تعذر إعادة قراءة الدفعة من مزود البوابة." };
  }
  if (
    input.refetchedPayment.orderRef !== input.expectedOrderRef ||
    input.refetchedPayment.amountMinor !== input.expectedAmountMinor ||
    input.refetchedPayment.currency !== input.expectedCurrency
  ) {
    return { verifiedPaid: false, status: "MISMATCH", reasonAr: "بيانات الدفعة لدى المزود لا تطابق مبلغ أو عملة أو مرجع الطلب." };
  }
  if (input.refetchedPayment.status !== "PAID") {
    return { verifiedPaid: false, status: "NOT_PAID", reasonAr: `حالة الدفعة لدى المزود: ${input.refetchedPayment.status}.` };
  }
  return {
    verifiedPaid: true,
    status: "PAID",
    reasonAr: "تم التحقق من الدفع عبر توقيع البوابة وإعادة مطابقة الدفعة من المزود.",
  };
}

/**
 * Builds a live interactive `jassim-seller-classification` card payload for in-chat rendering.
 */
export function buildSellerClassificationCardPayload(input: {
  classification: SellerClassification;
  confidence: number;
  source: string;
  reason: string;
  signals: readonly Signal[];
  publishedRateBps: number;
  connectProfitPreview?: { revenueMinor: number; costs: DirectCost[]; currencyCode: string; minorUnitScale?: number };
}) {
  const ratePercent = input.publishedRateBps / 100;
  const commissionLabelAr =
    input.classification === "PERSONAL_SELLER"
      ? "0% — مبيعات شخصية معفاة بالكامل من العمولة"
      : input.classification === "CONNECT_PARTNER"
        ? "0% عمولة سوق — تطبق اتفاقية Jassim Connect (10% من الربح المباشر بعد التكاليف المعتمدة والموثقة)"
        : input.classification === "UNDER_REVIEW"
          ? "0% تلقائيًا — الحساب قيد المراجعة ولا تُفرض أي عمولة تلقائية"
          : `${ratePercent}% على البيع المكتمل فقط (تُسجّل مستحقة ولا تُقتطع من المشتري)`;

  const profitBreakdown = input.connectProfitPreview
    ? connectProfitShare({
        revenueMinor: input.connectProfitPreview.revenueMinor,
        costs: input.connectProfitPreview.costs,
      })
    : null;

  return {
    schemaVersion: "1.0" as const,
    classification: input.classification,
    classificationLabelAr: CLASSIFICATION_LABELS_AR[input.classification],
    commissionLabelAr,
    confidencePercent: Math.round(input.confidence * 100),
    source: input.source,
    reasonAr: input.reason,
    signals: input.signals.map((s) => ({ key: s.key, detail: s.detail ?? s.key, weight: s.weight })),
    profitSharePreview: profitBreakdown
      ? {
          revenueMinor: profitBreakdown.revenueMinor,
          approvedDirectCostsMinor: profitBreakdown.approvedDirectCostsMinor,
          directProfitMinor: profitBreakdown.directProfitMinor,
          jassimShareMinor: profitBreakdown.jassimShareMinor,
          excludedCount: profitBreakdown.excludedCosts.length,
          currencyCode: input.connectProfitPreview!.currencyCode,
        }
      : null,
  };
}

/**
 * Builds the cache-optimized Arabic System Curriculum that teaches Jassim's LLM brain
 * the complete payment agreement, seller classification, Connect profit-share, and
 * conversational merchant policy architecture.
 */
export function buildJassimCommerceSystemCurriculum(market?: {
  countryCode?: string;
  countryNameAr?: string;
  currencyCode?: string;
}): string {
  const marketHeader = market?.countryNameAr
    ? `السوق النشط: ${market.countryNameAr} (${market.countryCode ?? "—"}) — العملة: ${market.currencyCode ?? "—"}.`
    : "التزم بالسوق والعملة المحددين من الخادم.";

  return [
    "=== دستور جاسم الذكي للتجارة، اتفاق الدفع، تصنيف البائعين، وسياسات المتاجر ===",
    marketHeader,
    "1. الفصل المالي واتفاق الدفع المباشر (Payment Preferences & Agreement):",
    "   - جاسم ليس بوابة دفع ولا يستلم أو يحتفظ بأموال المبيعات؛ ينسق جاسم طريقة التسوية المباشرة بين البائع والمشتري داخل المحادثة.",
    "   - الكتالوج يرشد ولا يمنع: يمكن للطرفين الاتفاق على أي وسيلة دفع مباشرة يذكرانها (كليك، إنستاباي، سريع، ومض، آآني، فوران، بنفت باي، كي نت عبر رابط التاجر، زين كاش، تحويل بنكي، أو الدفع عند الاستلام COD).",
    "   - لا تقدم أي وسيلة على أنها بوابة متكاملة مع جاسم وهي ليست كذلك؛ أوضح وضع الوسيلة بشفافية (موثقة في الكتالوج، قيد المراجعة، أو وسيلة سماها الطرفان).",
    "   - حماية البيانات البنكية: لا تقبل ولا تقتبس رقم IBAN أو حساب أو هاتف تحويل أو رقم بطاقة في نص المحادثة أبدًا؛ وجّه البائع دائمًا لإدخال بيانات التحويل في النموذج المحمي داخل بطاقة الصفقة (Deal Card)، ووجّه المشتري لعرضها من المساحة المحمية.",
    "2. تصنيف البائعين والعمولات وحصة Connect (Seller Classification & Profit Share):",
    "   - بائع فردي (مقتنيات شخصية PERSONAL_SELLER): عمولة 0%.",
    "   - تاجر فردي أو شركة مسجلة (INDIVIDUAL_MERCHANT / REGISTERED_BUSINESS): العمولة المنشورة (5%) تُستحق عند اكتمال الطلب فقط ولا تُقتطع من المشتري.",
    "   - شريك Jassim Connect (CONNECT_PARTNER): 0% عمولة سوق؛ تطبق اتفاقية Connect وهي 10% من الربح المباشر فقط (الإيراد ناقص التكاليف المباشرة المعتمدة والموثقة معًا، وصفر عند عدم وجود ربح).",
    "   - قيد المراجعة أو اعتراض مفتوح (UNDER_REVIEW): 0% عمولة تلقائية حتى يُبت في المراجعة.",
    "3. أنماط التشغيل الثلاثة وسياسات المتجر المدارة بالمحادثة (Merchant-Owned Commerce):",
    "   - النمط A (متجر مرتبط ببوابة دفع موثقة)، النمط B (متجر مرتبط بطرق دفع مباشرة)، النمط C (بائع مستقل).",
    "   - يدير التاجر سياسات متجره بالمحادثة الطبيعية (طرق الدفع، الشحن، نفاد المخزون، الحد الأدنى، الطلب المسبق، حدود التفاوض، الإيقاف المؤقت، مناطق الدفع عند الاستلام)، وتُعرض كبطاقة اقتراح لا تسري إلا بعد تأكيد التاجر الصريح.",
    "   - ميّز دائمًا مصدر المعلومة: (STORE_SYSTEM من نظام المتجر مباشرة، MERCHANT_POLICY من سياسة التاجر المؤكدة، UNCONFIRMED غير مؤكدة، NEEDS_MERCHANT_APPROVAL تحتاج موافقة التاجر).",
  ].join("\n");
}
