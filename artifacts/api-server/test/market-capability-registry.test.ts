import assert from "node:assert/strict";
import {
  buildMarketCapabilityRegistry,
  getMarketCapabilityProfile,
  INTEGRATION_READINESS_MATRIX,
  marketAllowsCashDirect,
  marketAllowsFulfilment,
  marketProviderPolicyAllows,
  resolveMarketProvider,
} from "../src/lib/market-capability-registry";
import type {
  AITextProvider,
  ProviderRegistration,
} from "../src/lib/provider-boundaries";

const baseMarket = {
  id: "market-sa",
  countryCode: "SA",
  currencyCode: "SAR",
  minorUnitScale: 2,
  paymentMethods: ["CASH_DIRECT"],
  fulfilmentMethods: ["PICKUP", "DELIVERY", "COURIER"],
};

await test("market capabilities come from one market record and default closed", () => {
  const profile = getMarketCapabilityProfile(baseMarket, "development");

  assert.equal(profile.marketId, "market-sa");
  assert.equal(profile.countryCode, "SA");
  assert.deepEqual(profile.currency, { code: "SAR", minorUnitScale: 2 });
  assert.equal(profile.payments.cashDirect.available, true);
  assert.equal(profile.payments.electronic.available, false);
  assert.equal(profile.authentication.phoneVerification.deliveryMode, "DEVELOPMENT_CODE_ONLY");
  assert.equal(profile.authentication.phoneVerification.smsProviderConnected, false);
  assert.equal(profile.authentication.googleLogin.available, false);
  assert.equal(profile.location.maps.available, false);
  assert.equal(profile.location.geocoding.available, false);
  assert.equal(profile.location.routes.available, false);
  assert.equal(profile.fulfilment.sellerSelfDelivery, true);
  assert.equal(profile.fulfilment.independentCourier, true);
  assert.equal(profile.fulfilment.externalDelivery.available, false);
  assert.equal(profile.fulfilment.crossBorderDelivery, false);
  assert.equal(profile.fulfilment.crossBorderDriverAssignment, false);
  assert.equal(profile.notifications.inAppOrderActionItems, true);
  assert.equal(profile.notifications.sms, false);
  assert.equal(profile.notifications.push, false);
  assert.equal(profile.ai.text.marketPolicyEnabled, true);
  assert.equal(profile.ai.text.sandboxConnected, false);
  assert.equal(profile.ai.text.liveConnected, false);
  assert.equal(profile.ai.vision.adapterImplemented, true);
});

await test("market-specific methods and currency do not bleed between countries", () => {
  const otherMarket = {
    ...baseMarket,
    id: "market-xx",
    countryCode: "XX",
    currencyCode: "XXX",
    minorUnitScale: 0,
    paymentMethods: [],
    fulfilmentMethods: ["PICKUP"],
  };
  const profile = getMarketCapabilityProfile(otherMarket, "staging");

  assert.equal(profile.currency.code, "XXX");
  assert.equal(profile.payments.cashDirect.available, false);
  assert.equal(profile.fulfilment.sellerSelfDelivery, false);
  assert.equal(profile.fulfilment.independentCourier, false);
  assert.equal(profile.ai.text.marketPolicyEnabled, false);
  assert.equal(profile.authentication.phoneVerification.deliveryMode, "UNAVAILABLE");
});

await test("the capability registry indexes the current market records by country", () => {
  const registry = buildMarketCapabilityRegistry(
    [
      baseMarket,
      {
        ...baseMarket,
        id: "market-xx",
        countryCode: "XX",
        currencyCode: "XXX",
        paymentMethods: [],
        fulfilmentMethods: ["PICKUP"],
      },
    ],
    "development",
  );

  assert.deepEqual(Object.keys(registry).sort(), ["SA", "XX"]);
  assert.equal(registry.SA.currency.code, "SAR");
  assert.equal(registry.XX.currency.code, "XXX");
  assert.throws(
    () => buildMarketCapabilityRegistry([baseMarket, { ...baseMarket, id: "duplicate" }], "development"),
    /unique country code/,
  );
});

await test("fulfilment and cash policy helpers use only the supplied market", () => {
  assert.equal(marketAllowsCashDirect(baseMarket), true);
  assert.equal(marketAllowsCashDirect({ paymentMethods: [] }), false);
  assert.equal(marketAllowsFulfilment(baseMarket, "COURIER"), true);
  assert.equal(marketAllowsFulfilment(baseMarket, "EXTERNAL_PROVIDER"), false);
  assert.equal(
    getMarketCapabilityProfile({
      ...baseMarket,
      fulfilmentMethods: ["PICKUP", "COURIER"],
    }, "development").fulfilment.independentCourier,
    false,
  );
});

await test("provider selection requires market policy, matching mode, environment, and scope", async () => {
  const ai: AITextProvider = {
    async proposeToolCall() {
      return { id: "test-call", name: "search", arguments: "{}" };
    },
  };
  const registration: ProviderRegistration<"AI_TEXT"> = {
    family: "AI_TEXT",
    providerKey: "configured-development-ai",
    mode: "DEVELOPMENT",
    environments: ["development"],
    marketIds: ["*"],
    create: () => ai,
  };
  const market = {
    marketId: baseMarket.id,
    countryCode: baseMarket.countryCode,
    currencyCode: baseMarket.currencyCode,
  };

  assert.equal(
    marketProviderPolicyAllows("SA", "AI_TEXT", "development"),
    true,
  );
  assert.equal(
    marketProviderPolicyAllows("SA", "AI_TEXT", "staging"),
    false,
  );
  assert.strictEqual(
    await resolveMarketProvider({
      family: "AI_TEXT",
      market,
      environment: "development",
      registrations: [registration],
    }),
    ai,
  );
  assert.equal(
    await resolveMarketProvider({
      family: "AI_TEXT",
      market,
      environment: "staging",
      registrations: [registration],
    }),
    undefined,
  );
  assert.equal(
    await resolveMarketProvider({
      family: "AI_TEXT",
      market,
      environment: "development",
      registrations: [registration, registration],
    }),
    undefined,
  );
});

await test("the readiness matrix never reports an unverified sandbox or live connection", () => {
  assert.equal(INTEGRATION_READINESS_MATRIX.length, 16);
  assert.equal(
    new Set(INTEGRATION_READINESS_MATRIX.map((provider) => provider.family)).size,
    INTEGRATION_READINESS_MATRIX.length,
    "each integration family has exactly one readiness entry",
  );
  for (const provider of INTEGRATION_READINESS_MATRIX) {
    assert.ok(["NOT_CONNECTED", "NOT_APPLICABLE"].includes(provider.sandbox), provider.family);
    assert.ok(["NOT_CONNECTED", "NOT_APPLICABLE"].includes(provider.live), provider.family);
    assert.ok(Array.isArray(provider.credentialNames), provider.family);
  }
  assert.equal(
    INTEGRATION_READINESS_MATRIX.find((provider) => provider.family === "VISION")?.adapter,
    "DEVELOPMENT_ONLY",
  );
  assert.equal(
    INTEGRATION_READINESS_MATRIX.find((provider) => provider.family === "OBJECT_STORAGE")?.adapter,
    "REPLIT_PLATFORM",
  );
  assert.equal(
    INTEGRATION_READINESS_MATRIX.find((provider) => provider.family === "BUSINESS_PROVIDER_API")?.adapter,
    "DINAR_MANAGED_API",
  );
  assert.deepEqual(
    INTEGRATION_READINESS_MATRIX.find((provider) => provider.family === "AI_TEXT")
      ?.credentialNames,
    ["GROQ_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "AI_INTEGRATIONS_OPENAI_API_KEY", "DINAR_AI_API_KEY", "DINAR_AI_FALLBACK_API_KEY"],
  );
});

async function test(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
