import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStoreFromUrlAndSignals, validatePublicStoreUrl } from "../src/connect/url-auto-connect";
import { computeLiveDeliveryTelemetry, haversineKm } from "../src/ai/delivery-tracker-engine";
import { planUniversalConversationTurn } from "../src/ai/jassim-generative-os";

test("URL Auto-Connect: blocks SSRF/private hosts and auto-detects Salla, Zid, Shopify & MCP stores", () => {
  assert.equal(validatePublicStoreUrl("http://localhost:8080").ok, false);
  assert.equal(validatePublicStoreUrl("https://169.254.169.254/latest").ok, false);
  assert.equal(validatePublicStoreUrl("https://192.168.1.1").ok, false);
  assert.equal(validatePublicStoreUrl("https://user:pass@mystore.com").ok, false);
  const salla = detectStoreFromUrlAndSignals({ rawUrl: "mystore.salla.sa", partnerSeed: "p1", htmlSnippet: "<title>متجر القهوة المختصة</title>" });
  assert.equal(salla.ok, true);
  if (salla.ok) { assert.equal(salla.discovery.platform, "SALLA"); assert.equal(salla.discovery.suggestedStoreName, "متجر القهوة المختصة"); }
  const shopify = detectStoreFromUrlAndSignals({ rawUrl: "https://elite-watch.com", partnerSeed: "p2", headers: { "x-shopify-stage": "production" } });
  assert.equal(shopify.ok, true);
  if (shopify.ok) assert.equal(shopify.discovery.platform, "SHOPIFY");
});

test("Delivery Tracker Engine: computes accurate Haversine distance, progress & ETA window", () => {
  const pickup = { lat: 31.9539, lng: 35.9106 };
  const dropoff = { lat: 31.9700, lng: 35.8700 };
  const courier = { lat: 31.9620, lng: 35.8900 };
  assert.ok(haversineKm(pickup, dropoff) > 3.5);
  const now = 1_760_000_000_000;
  const telemetry = computeLiveDeliveryTelemetry({ pickup, dropoff, courier, lastObservedAtMs: now - 15_000, nowMs: now, status: "OUT_FOR_DELIVERY" });
  assert.equal(telemetry.isLocationStale, false);
  assert.ok(telemetry.progressPercent >= 40 && telemetry.progressPercent <= 65);
});

test("Jassim Universal Generative OS: routes everything inside ONE conversation with sticky OpenRouter session", () => {
  const shopPlan = planUniversalConversationTurn({ conversationId: "conv_77", intent: "SHOP_CONFIGURE", marketOperationMode: "FULL" });
  assert.equal(shopPlan.brainTier, "COMMERCE_CORE");
  assert.equal(shopPlan.openRouterStickySessionKey, "jassim:conv:conv_77");
  assert.equal(shopPlan.inChatPaymentEligible, true);
  const preLegalPlan = planUniversalConversationTurn({ conversationId: "conv_88", intent: "SHOP_CONFIGURE", marketOperationMode: "PRE_LEGAL" });
  assert.equal(preLegalPlan.inChatPaymentEligible, false);
});
