import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJassimCommerceSystemCurriculum,
  buildSellerClassificationCardPayload,
  composeUnifiedPaymentOptionsCard,
  evaluateStoreTurnWithPolicies,
  parseConversationalMerchantPolicy,
  resolveCommerceOperatingMode,
  verifyAuthoritativeGatewayPayment,
} from "../src/ai/jassim-commerce-policy-brain";
import { classifyFastArabicIntent } from "../src/ai/speed-optimizer";
import { planUniversalConversationTurn } from "../src/ai/jassim-generative-os";

test("CommerceBrain-01: resolves Operating Modes A, B, and C strictly from backend facts", () => {
  const modeA = resolveCommerceOperatingMode({
    isApprovedConnectPartner: true,
    hasVerifiedGatewayAdapter: true,
    gatewaySupportsOrder: true,
  });
  assert.equal(modeA.mode, "MODE_A_CONNECTED_GATEWAY");
  assert.equal(modeA.gatewayEligible, true);

  const modeB = resolveCommerceOperatingMode({
    isApprovedConnectPartner: true,
    hasVerifiedGatewayAdapter: false,
  });
  assert.equal(modeB.mode, "MODE_B_CONNECTED_DIRECT");
  assert.equal(modeB.gatewayEligible, false);

  const modeC = resolveCommerceOperatingMode({
    isApprovedConnectPartner: false,
    hasVerifiedGatewayAdapter: true, // Even if true, non-Connect partner is Mode C
  });
  assert.equal(modeC.mode, "MODE_C_INDEPENDENT_SELLER");
  assert.equal(modeC.gatewayEligible, false);
});

test("CommerceBrain-02: parses natural Arabic merchant policies into PROPOSED state with fact provenance", () => {
  const oos = parseConversationalMerchantPolicy({
    message: "إذا نفد الهاتف أخبرهم أنه سيعود قريبًا وخذ أرقامهم",
    currencyCode: "JOD",
  });
  assert.ok(oos);
  assert.equal(oos.kind, "OUT_OF_STOCK");
  assert.equal(oos.status, "PROPOSED");
  assert.equal(oos.requiresExplicitConfirmation, true);
  assert.equal(oos.provenance, "MERCHANT_POLICY");
  assert.equal(oos.rule.kind, "OUT_OF_STOCK");
  if (oos.rule.kind === "OUT_OF_STOCK") {
    assert.equal(oos.rule.captureInterest, true);
    assert.equal(oos.rule.promiseDate, null);
  }

  const neg = parseConversationalMerchantPolicy({
    message: "حد التفاوض من 220 إلى 250",
    currencyCode: "JOD",
    minorUnitScale: 1000,
  });
  assert.ok(neg);
  assert.equal(neg.kind, "PRICE_NEGOTIATION");
  if (neg.rule.kind === "PRICE_NEGOTIATION") {
    assert.equal(neg.rule.floorMinor, 220_000);
    assert.equal(neg.rule.ceilingMinor, 250_000);
  }

  const ship = parseConversationalMerchantPolicy({
    message: "رسوم التوصيل 3 ومجاني فوق 50",
    currencyCode: "JOD",
    minorUnitScale: 1000,
  });
  assert.ok(ship);
  assert.equal(ship.kind, "SHIPPING");

  const codAreas = parseConversationalMerchantPolicy({
    message: "الدفع عند الاستلام في عمان والزرقاء فقط",
    currencyCode: "JOD",
  });
  assert.ok(codAreas);
  assert.equal(codAreas.kind, "COD_AREAS");
});

test("CommerceBrain-03: store system live stock overrides out-of-stock policy and enforces negotiation floor", () => {
  const oosProposal = parseConversationalMerchantPolicy({
    message: "إذا نفد الهاتف أخبرهم أنه سيعود قريبًا وخذ أرقامهم",
    currencyCode: "JOD",
  })!;
  const negProposal = parseConversationalMerchantPolicy({
    message: "حد التفاوض من 220 إلى 250",
    currencyCode: "JOD",
    minorUnitScale: 100,
  })!;
  const shipProposal = parseConversationalMerchantPolicy({
    message: "رسوم التوصيل 3 ومجاني فوق 50",
    currencyCode: "JOD",
    minorUnitScale: 100,
  })!;

  const activePolicies = [
    { ...oosProposal, status: "ACTIVE" as const },
    { ...negProposal, status: "ACTIVE" as const },
    { ...shipProposal, status: "ACTIVE" as const },
  ];

  // When stock > 0, OUT_OF_STOCK policy never blocks the order; negotiation >= 220 is auto-accepted
  const accepted = evaluateStoreTurnWithPolicies({
    storeSystemStockQuantity: 5,
    unitPriceMinor: 250_00,
    requestedQuantity: 1,
    offeredUnitPriceMinor: 230_00,
    currencyCode: "JOD",
    activePolicies,
  });
  assert.equal(accepted.canProceedToOrder, true);
  assert.equal(accepted.negotiationOutcome, "ACCEPTED_BY_POLICY");
  assert.equal(accepted.shippingFeeMinor, 0); // 230 >= 50 free threshold
  assert.equal(accepted.totalMinor, 230_00);

  // When buyer offers below floor (200 < 220), it requires merchant approval
  const belowFloor = evaluateStoreTurnWithPolicies({
    storeSystemStockQuantity: 5,
    unitPriceMinor: 250_00,
    requestedQuantity: 1,
    offeredUnitPriceMinor: 200_00,
    currencyCode: "JOD",
    activePolicies,
  });
  assert.equal(belowFloor.canProceedToOrder, false);
  assert.equal(belowFloor.provenance, "NEEDS_MERCHANT_APPROVAL");
});

test("CommerceBrain-04: composes unified PAYMENT_OPTIONS and enforces strict webhook + refetch verification", () => {
  const composed = composeUnifiedPaymentOptionsCard({
    orderRef: "ORD-9911",
    countryCode: "JO",
    currencyCode: "JOD",
    amountMinor: 253_000,
    buyerAreaAr: "إربد",
    isApprovedConnectPartner: true,
    gatewayAdapter: {
      id: "tap-merchant",
      labelAr: "بوابة المتجر الإلكترونية (Tap)",
      verifiedIntegration: true,
      supports: ({ country, currency }) => country === "JO" && currency === "JOD",
    },
    directMethods: [
      { code: "CLIQ", labelAr: "كليك (CliQ)", kind: "DIRECT", standing: "VERIFIED_METHOD" },
      { code: "DECLARED:زين_كاش", labelAr: "زين كاش", kind: "DIRECT", standing: "USER_DECLARED_METHOD" },
      { code: "COD", labelAr: "الدفع نقدًا عند الاستلام", kind: "COD", standing: "VERIFIED_METHOD" },
    ],
    codAllowedAreasAr: ["عمان", "الزرقاء"],
  });

  assert.equal(composed.operatingMode, "MODE_A_CONNECTED_GATEWAY");
  assert.equal(composed.options.length, 4);
  assert.equal(composed.options[0]?.channel, "MERCHANT_GATEWAY");
  // COD in Irbid is marked unavailable because policy restricts COD to Amman & Zarqa
  const codOpt = composed.options.find((o) => o.code === "COD");
  assert.equal(codOpt?.available, false);

  // Gateway verification rejects unsigned or mismatched payments
  const rejected = verifyAuthoritativeGatewayPayment({
    expectedOrderRef: "ORD-9911",
    expectedAmountMinor: 253_000,
    expectedCurrency: "JOD",
    webhookSignatureValid: false,
    eventAlreadyProcessed: false,
    refetchedPayment: { orderRef: "ORD-9911", amountMinor: 253_000, currency: "JOD", status: "PAID" },
  });
  assert.equal(rejected.verifiedPaid, false);

  const verified = verifyAuthoritativeGatewayPayment({
    expectedOrderRef: "ORD-9911",
    expectedAmountMinor: 253_000,
    expectedCurrency: "JOD",
    webhookSignatureValid: true,
    eventAlreadyProcessed: false,
    refetchedPayment: { orderRef: "ORD-9911", amountMinor: 253_000, currency: "JOD", status: "PAID" },
  });
  assert.equal(verified.verifiedPaid, true);
  assert.equal(verified.status, "PAID");
});

test("CommerceBrain-05: fast Arabic intent classifier, generative OS, and seller classification card payload", () => {
  const dealIntent = classifyFastArabicIntent("أقبل الدفع عبر كليك أو زين كاش");
  assert.equal(dealIntent.intent, "DEAL_PAYMENT_AGREEMENT");
  assert.equal(dealIntent.authority, "READ_ONLY_PREFETCH_HINT");

  const classIntent = classifyFastArabicIntent("ما تصنيفي كبائع؟");
  assert.equal(classIntent.intent, "SELLER_CLASSIFICATION_POLICY");

  const policyIntent = classifyFastArabicIntent("إذا نفد الهاتف أخبرهم أنه سيعود قريبًا");
  assert.equal(policyIntent.intent, "MERCHANT_COMMERCE_POLICY");

  const osPlan = planUniversalConversationTurn({
    conversationId: "conv-1",
    intent: "DEAL_PAYMENT_AGREEMENT",
    marketOperationMode: "FULL",
  });
  assert.deepEqual(osPlan.surfaces, ["DEAL_PAYMENT_CARD"]);

  const cardPayload = buildSellerClassificationCardPayload({
    classification: "CONNECT_PARTNER",
    confidence: 0.98,
    source: "CONNECT_PARTNER",
    reason: "شريك Jassim Connect معتمد",
    signals: [],
    publishedRateBps: 500,
    connectProfitPreview: {
      revenueMinor: 500,
      costs: [
        { label: "تكلفة البضاعة", amountMinor: 300, approved: true, documented: true },
        { label: "مصروف غير موثق", amountMinor: 50, approved: true, documented: false },
      ],
      currencyCode: "JOD",
    },
  });
  assert.equal(cardPayload.profitSharePreview?.directProfitMinor, 200);
  assert.equal(cardPayload.profitSharePreview?.jassimShareMinor, 20);
  assert.equal(cardPayload.profitSharePreview?.excludedCount, 1);

  const curriculum = buildJassimCommerceSystemCurriculum({
    countryCode: "JO",
    countryNameAr: "الأردن",
    currencyCode: "JOD",
  });
  assert.ok(curriculum.includes("PERSONAL_SELLER"));
  assert.ok(curriculum.includes("CONNECT_PARTNER"));
  assert.ok(curriculum.includes("MERCHANT_POLICY"));
});
