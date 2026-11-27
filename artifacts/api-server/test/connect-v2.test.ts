import { test } from "node:test";
import assert from "node:assert/strict";
import { autoDetectCardMapping, CONNECT_PLATFORM_PRESETS } from "../src/connect/platform-presets";
import { applyInChatPaymentTransition, resolveInitialInChatPaymentState } from "../src/connect/in-chat-checkout-contract";
import { mapMerchantPayloadToInteractiveCards } from "../src/connect/interactive-card-mapping";
import { signInventoryWebhook, verifyInventoryWebhook } from "../src/connect/inventory-webhook";
import { buildWorkflowRecoveryPlan } from "../src/connect/workflow-recovery";

test("Connect-01: Platform presets cover Salla/Zid/Shopify/WooCommerce & auto-detector infers pointers", () => {
  assert.equal(CONNECT_PLATFORM_PRESETS.SALLA.pricePointer, "/price/amount");
  assert.equal(CONNECT_PLATFORM_PRESETS.ZID.titlePointer, "/name/ar");
  const sampleSalla = { data: [{ id: "p1", name: "قهوة عربية مختصة", price: { amount: 12.5 }, main_image: "https://cdn.example.com/1.jpg", is_available: true, options: [{ id: "o1" }] }] };
  const detected = autoDetectCardMapping(sampleSalla);
  assert.ok(detected);
  assert.equal(detected.itemsPointer, "/data");
  assert.equal(detected.pricePointer, "/price/amount");
  assert.equal(detected.modifiersPointer, "/options");
  assert.equal(detected.confidence, 1);
});

test("Connect-02: In-chat checkout state machine blocks PRE_LEGAL and enforces valid transitions", () => {
  assert.equal(resolveInitialInChatPaymentState({ operationMode: "PRE_LEGAL", providerEnabledInMarket: true }).state, "UNAVAILABLE_IN_COUNTRY");
  assert.equal(resolveInitialInChatPaymentState({ operationMode: "FULL", providerEnabledInMarket: true }).state, "AVAILABLE");
  const session = { sessionId: "sess_1001", partnerId: "partner_1", marketId: "KW", operationMode: "FULL" as const, amountMinor: 1500, currencyCode: "KWD", state: "AVAILABLE" as const, idempotencyKey: "idem_key_12345678" };
  assert.throws(() => applyInChatPaymentTransition(session, "PAID"));
  const pending = applyInChatPaymentTransition(session, "PENDING", "prov_ref_1");
  const paid = applyInChatPaymentTransition(pending, "PAID");
  assert.equal(applyInChatPaymentTransition(paid, "REFUNDED").state, "REFUNDED");
});

test("Connect-03: Interactive card mapper transforms merchant modifiers into LAYERED_STACK / MANNEQUIN specs", () => {
  const mapped = mapMerchantPayloadToInteractiveCards(
    { items: [{ id: "burger-classic", title: "برغر أنغوس كلاسيك", price: "4.50", modifiers: [{ id: "cheese", label: "جبن شيدر", priceDelta: 0.5, color: "#facc15" }, { id: "patty2", label: "شريحة إضافية", priceDelta: 1.75, color: "#6b2d18" }] }] },
    { stageMode: "LAYERED_STACK", itemsPointer: "/items", idPointer: "/id", titlePointer: "/title", pricePointer: "/price", modifiersPointer: "/modifiers", currencyCode: "JOD" },
  );
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].basePriceMinor, 450);
  assert.equal(mapped[0].modifiers[1].deltaMinor, 175);
});

test("Connect-04: Signed inventory webhook verifies HMAC-SHA256 and rejects tampered or expired requests", () => {
  const secret = "whsec_test_secret_123";
  const now = 1_760_000_000_000;
  const rawBody = JSON.stringify({ eventId: "evt_001", partnerId: "partner_1", type: "INVENTORY_UPDATED", listingExternalId: "sku_99", availableQuantity: 4, occurredAt: "2026-11-27T20:00:00Z" });
  const sig = signInventoryWebhook(rawBody, now, secret);
  assert.equal(verifyInventoryWebhook({ rawBody, signatureHex: sig, timestampMs: now, secret, nowMs: now + 10_000 }).ok, true);
  assert.equal(verifyInventoryWebhook({ rawBody, signatureHex: "0".repeat(sig.length), timestampMs: now, secret, nowMs: now }).ok, false);
  assert.equal(verifyInventoryWebhook({ rawBody, signatureHex: sig, timestampMs: now - 10 * 60_000, secret, nowMs: now }).ok, false);
});

test("Connect-05: Workflow recovery plan preserves committed steps and suggests verified alternative partners", () => {
  const plan = buildWorkflowRecoveryPlan({
    marketId: "JO",
    steps: [
      { index: 0, partnerId: "store-a", partnerName: "متجر الأثاث الحديث", capability: "ORDER_CREATE", status: "SUCCEEDED", referenceId: "ORD-88" },
      { index: 1, partnerId: "install-b", partnerName: "شركة التركيب السريع", capability: "BOOK_INSTALL", status: "FAILED", errorReason: "لا يوجد موعد متاح" },
    ],
    alternatives: [
      { partnerId: "install-c", partnerName: "خبراء التركيب المعتمدون", capability: "BOOK_INSTALL", marketId: "JO", verified: true, rating: 4.9 },
      { partnerId: "install-kw", partnerName: "شركة الكويت", capability: "BOOK_INSTALL", marketId: "KW", verified: true, rating: 5.0 },
    ],
  });
  assert.ok(plan);
  assert.equal(plan.failedStepIndex, 1);
  assert.ok(plan.options.some((o) => o.kind === "SWAP_ALTERNATIVE_PARTNER" && o.partnerId === "install-c"));
  assert.ok(!plan.options.some((o) => o.kind === "SWAP_ALTERNATIVE_PARTNER" && o.partnerId === "install-kw"));
});
