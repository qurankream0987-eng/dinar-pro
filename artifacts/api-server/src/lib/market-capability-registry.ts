import type { markets } from "@workspace/db";
import {
  PROVIDER_FAMILIES,
  type AnyProviderRegistration,
  type ProviderAdapterMap,
  type ProviderDeploymentEnvironment,
  type ProviderFamily,
  type ProviderMarketContext,
} from "./provider-boundaries";

export type MarketCapabilitySource = Pick<
  typeof markets.$inferSelect,
  | "id"
  | "countryCode"
  | "currencyCode"
  | "minorUnitScale"
  | "paymentMethods"
  | "fulfilmentMethods"
>;

/**
 * Country-specific provider policy belongs here, on the server. An absent entry denies
 * the provider, except the existing text-AI development opt-in. No frontend value can
 * select a provider or widen a market's policy.
 */
export const MARKET_PROVIDER_POLICY_BY_COUNTRY: Readonly<
  Record<string, Partial<Record<ProviderFamily, string>>>
> = Object.freeze({});

export const INTEGRATION_READINESS_MATRIX = [
  {
    family: "AI_TEXT",
    boundary: "READY",
    adapter: "DEVELOPMENT_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: ["GROQ_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "AI_INTEGRATIONS_OPENAI_API_KEY", "DINAR_AI_API_KEY", "DINAR_AI_FALLBACK_API_KEY"],
    connectableWithCredentialsOnly: false,
    note: "Development defaults to Groq; GROQ, OPENROUTER, OPENAI, REPLIT_OPENAI or a provider-neutral OPENAI_COMPATIBLE endpoint is selected by server configuration, with an optional owner-configured fallback model. The runtime contacts no text provider unless DINAR_AI_MODEL_FALLBACK=true; every call is metered and money-capped; no production registration exists.",
  },
  {
    family: "VISION",
    boundary: "READY",
    adapter: "DEVELOPMENT_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: ["GROQ_API_KEY"],
    connectableWithCredentialsOnly: false,
    note: "Development-only Groq/Qwen Vision adapters handle seller-photo suggestions and optional listing-image policy review. Suggestions remain tentative, neither adapter is authoritative, and no sandbox or production registration exists.",
  },
  {
    family: "SMS",
    boundary: "READY",
    adapter: "DEVELOPMENT_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "Only the development/test code-delivery adapter exists; no SMS vendor is selected. Staging/production take a vendor adapter through registerPhoneVerificationProvider (DINAR_PHONE_VERIFICATION_PROVIDER); until then challenges answer 503 and /readyz is not_ready.",
  },
  {
    family: "GOOGLE_OAUTH",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "Identity verification contract only; login routes, account linking, and a provider adapter are not configured.",
  },
  {
    family: "MAPS",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "No map service or provider selected.",
  },
  {
    family: "GEOCODING",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "No geocoding service or provider selected.",
  },
  {
    family: "ROUTES",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "No route-planning service or provider selected.",
  },
  {
    family: "PAYMENT",
    boundary: "READY",
    adapter: "TEST_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "DINAR's payment contract and test adapter exist; no vendor adapter is selected, and real money remains disabled.",
  },
  {
    family: "NOTIFICATIONS",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "Dispatch is wired for privacy-request, appeal and report decisions (lib/notifications.ts: ids and status codes only, never contact data). No vendor adapter is registered, so nothing is sent; order updates remain in-app. Needs a selected vendor, its registration, a country policy entry and DINAR_NOTIFICATION_CHANNEL.",
  },
  {
    family: "DRIVER_LOCATION",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "Ephemeral tracking boundary exists; no location provider is registered.",
  },
  {
    family: "EXTERNAL_DELIVERY",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "No external carrier is selected; DINAR remains authoritative for order and delivery state.",
  },
  {
    family: "SUBSCRIPTION_BILLING",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "Lifecycle state machine and signed idempotent webhook intake exist; no billing provider is registered, so checkout and webhooks answer BILLING_PROVIDER_NOT_CONNECTED. Subscriptions remain TEST_NO_TRANSFER simulation without auto-renewal.",
  },
  {
    family: "SHIPMENT_TRACKING",
    boundary: "READY",
    adapter: "INTERFACE_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "Carrier tracking contract only; no carrier is selected and no ETA is ever invented.",
  },
  {
    family: "MONITORING",
    boundary: "READY",
    adapter: "LOG_ONLY",
    sandbox: "NOT_CONNECTED",
    live: "NOT_CONNECTED",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "Structured, redacted pino logs. Unexpected 5xx errors are also handed to lib/monitoring.ts (event, code, request id and release only). No vendor adapter is registered, so nothing leaves DINAR; needs a selected vendor, registerMonitoringProvider at startup and DINAR_MONITORING_PROVIDER.",
  },
  {
    family: "OBJECT_STORAGE",
    boundary: "READY",
    adapter: "REPLIT_PLATFORM",
    sandbox: "NOT_APPLICABLE",
    live: "NOT_APPLICABLE",
    credentialNames: ["PRIVATE_OBJECT_DIR", "PUBLIC_OBJECT_SEARCH_PATHS"],
    connectableWithCredentialsOnly: false,
    note: "DINAR uses Replit-managed Object Storage through the platform sidecar; bucket paths are environment configuration, not an external marketplace provider.",
  },
  {
    family: "BUSINESS_PROVIDER_API",
    boundary: "READY",
    adapter: "DINAR_MANAGED_API",
    sandbox: "NOT_APPLICABLE",
    live: "NOT_APPLICABLE",
    credentialNames: [],
    connectableWithCredentialsOnly: false,
    note: "The owner-scoped inbound API is implemented. DINAR issues its own scoped bearer keys; this is not a vendor-specific connector or an outbound provider registration.",
  },
] as const;

export function providerDeploymentEnvironment():
  | ProviderDeploymentEnvironment
  | undefined {
  const explicit = process.env.DINAR_DEPLOYMENT_ENV;
  if (
    explicit === "development" ||
    explicit === "staging" ||
    explicit === "production"
  )
    return explicit;

  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
    return "development";

  // Production/staging must be labelled explicitly; unknown environments fail closed.
  return undefined;
}

export function marketProviderPolicyAllows(
  countryCode: string,
  family: ProviderFamily,
  environment: ProviderDeploymentEnvironment,
): boolean {
  return marketProviderKey(countryCode, family, environment) !== undefined;
}

export function marketProviderKey(
  countryCode: string,
  family: ProviderFamily,
  environment: ProviderDeploymentEnvironment,
): string | undefined {
  const explicit = MARKET_PROVIDER_POLICY_BY_COUNTRY[countryCode]?.[family];
  if (explicit !== undefined) return explicit || undefined;

  // Preserve only the configured development AI slot. Every staging/live
  // selection, and every other provider family, requires a country policy entry.
  return family === "AI_TEXT" && environment === "development"
    ? "configured-development-ai"
    : undefined;
}

export async function resolveMarketProvider<K extends ProviderFamily>(input: {
  family: K;
  market: ProviderMarketContext;
  environment: ProviderDeploymentEnvironment;
  registrations: readonly AnyProviderRegistration[];
}): Promise<ProviderAdapterMap[K] | undefined> {
  if (
    !marketProviderPolicyAllows(
      input.market.countryCode,
      input.family,
      input.environment,
    )
  )
    return undefined;

  const mode =
    input.environment === "development"
      ? "DEVELOPMENT"
      : input.environment === "staging"
        ? "SANDBOX"
        : "LIVE";
  if (
    mode === "LIVE" &&
    process.env.DINAR_LIVE_PROVIDERS_ENABLED !== "true"
  )
    return undefined;
  const selectedProviderKey = marketProviderKey(
    input.market.countryCode,
    input.family,
    input.environment,
  );
  if (!selectedProviderKey) return undefined;

  const matchingRegistrations = input.registrations.filter(
    (candidate) =>
      candidate.family === input.family &&
      candidate.providerKey === selectedProviderKey &&
      candidate.mode === mode &&
      candidate.environments.includes(input.environment) &&
      (candidate.marketIds.includes(input.market.marketId) ||
        candidate.marketIds.includes("*")),
  ) as AnyProviderRegistration[];

  // Ambiguous server registrations must not silently pick an adapter by array order.
  if (matchingRegistrations.length !== 1) return undefined;
  return matchingRegistrations[0]!.create() as
    | Promise<ProviderAdapterMap[K]>
    | ProviderAdapterMap[K]
    | undefined;
}

export function marketAllowsFulfilment(
  market: Pick<MarketCapabilitySource, "fulfilmentMethods">,
  method: string,
): boolean {
  return market.fulfilmentMethods.includes(method);
}

export function marketAllowsCashDirect(
  market: Pick<MarketCapabilitySource, "paymentMethods">,
): boolean {
  return market.paymentMethods.includes("CASH_DIRECT");
}

const ELECTRONIC_PAYMENT_METHODS = new Set([
  "CARD",
  "ELECTRONIC",
  "WALLET",
  "BANK_TRANSFER",
]);

export function getMarketCapabilityProfile(
  market: MarketCapabilitySource,
  environment = providerDeploymentEnvironment(),
) {
  const resolvedEnvironment = environment ?? "development";
  const providerPolicy = Object.fromEntries(
    PROVIDER_FAMILIES.map((family) => [
      family,
      environment
        ? marketProviderPolicyAllows(
            market.countryCode,
            family,
            resolvedEnvironment,
          )
        : false,
    ]),
  ) as Record<ProviderFamily, boolean>;
  const electronicPolicyEnabled = market.paymentMethods.some((method) =>
    ELECTRONIC_PAYMENT_METHODS.has(method),
  );
  const developmentAiOptIn =
    environment === "development" &&
    process.env.DINAR_AI_MODEL_FALLBACK === "true";
  const fulfilmentMethods = [...market.fulfilmentMethods];

  return {
    marketId: market.id,
    countryCode: market.countryCode,
    currency: {
      code: market.currencyCode,
      minorUnitScale: market.minorUnitScale,
    },
    payments: {
      cashDirect: {
        marketPolicyEnabled: marketAllowsCashDirect(market),
        // The engine records claims and attestations only; production stays unavailable
        // until the owner activates direct cash deliberately for a market.
        engineImplemented: true,
        environment:
          marketAllowsCashDirect(market) && resolvedEnvironment === "development"
            ? "DEVELOPMENT_ONLY"
            : "UNAVAILABLE",
        available:
          marketAllowsCashDirect(market) && resolvedEnvironment === "development",
      },
      electronic: {
        marketPolicyEnabled: electronicPolicyEnabled,
        providerConnected: false,
        available: false,
      },
    },
    authentication: {
      phoneVerification: {
        flowImplemented: true,
        deliveryMode:
          environment === "development"
            ? "DEVELOPMENT_CODE_ONLY"
            : "UNAVAILABLE",
        smsProviderConnected: false,
      },
      googleLogin: {
        marketPolicyEnabled: providerPolicy.GOOGLE_OAUTH,
        available: false,
      },
    },
    location: {
      maps: { marketPolicyEnabled: providerPolicy.MAPS, available: false },
      geocoding: {
        marketPolicyEnabled: providerPolicy.GEOCODING,
        available: false,
      },
      routes: { marketPolicyEnabled: providerPolicy.ROUTES, available: false },
    },
    fulfilment: {
      configuredMethods: fulfilmentMethods,
      sellerSelfDelivery: marketAllowsFulfilment(market, "DELIVERY"),
      independentCourier:
        marketAllowsFulfilment(market, "DELIVERY") &&
        marketAllowsFulfilment(market, "COURIER"),
      externalDelivery: {
        marketPolicyEnabled: marketAllowsFulfilment(
          market,
          "EXTERNAL_PROVIDER",
        ),
        providerConnected: false,
        available: false,
      },
      crossBorderDelivery: false,
      crossBorderDriverAssignment: false,
    },
    notifications: {
      inAppOrderActionItems: true,
      email: false,
      sms: false,
      push: false,
    },
    ai: {
      text: {
        marketPolicyEnabled: providerPolicy.AI_TEXT,
        adapterImplemented: true,
        developmentOptIn: developmentAiOptIn,
        sandboxConnected: false,
        liveConnected: false,
      },
      vision: {
        marketPolicyEnabled: providerPolicy.VISION,
        adapterImplemented: true,
        sandboxConnected: false,
        liveConnected: false,
      },
    },
  };
}

export function buildMarketCapabilityRegistry(
  markets: readonly MarketCapabilitySource[],
  environment = providerDeploymentEnvironment(),
) {
  const countryCodes = markets.map((market) => market.countryCode);
  if (new Set(countryCodes).size !== countryCodes.length)
    throw new Error("Each market capability entry must have a unique country code.");

  return Object.fromEntries(
    markets.map((market) => [
      market.countryCode,
      getMarketCapabilityProfile(market, environment),
    ]),
  );
}
