import type { ConversationModelGateway } from "../ai/model-gateway";
import type { ListingPhotoSuggestionProvider } from "../ai/listing-photo-intelligence";
import type { OrderTrackingProvider } from "./order-tracking";
import type { PaymentProviderAdapter } from "./payments/contracts";
import type { PhoneVerificationProvider } from "./phone-verification";
import type { SubscriptionBillingProvider } from "./subscription-billing";

export type ProviderFamily =
  | "AI_TEXT"
  | "VISION"
  | "SMS"
  | "GOOGLE_OAUTH"
  | "MAPS"
  | "GEOCODING"
  | "ROUTES"
  | "PAYMENT"
  | "NOTIFICATIONS"
  | "EXTERNAL_DELIVERY"
  | "DRIVER_LOCATION"
  | "SUBSCRIPTION_BILLING"
  | "SHIPMENT_TRACKING"
  | "MONITORING";

export const PROVIDER_FAMILIES: readonly ProviderFamily[] = [
  "AI_TEXT",
  "VISION",
  "SMS",
  "GOOGLE_OAUTH",
  "MAPS",
  "GEOCODING",
  "ROUTES",
  "PAYMENT",
  "NOTIFICATIONS",
  "EXTERNAL_DELIVERY",
  "DRIVER_LOCATION",
  "SUBSCRIPTION_BILLING",
  "SHIPMENT_TRACKING",
  "MONITORING",
];

export type ProviderMode = "DEVELOPMENT" | "SANDBOX" | "LIVE";
export type ProviderDeploymentEnvironment =
  | "development"
  | "staging"
  | "production";

export type ProviderMarketContext = {
  marketId: string;
  countryCode: string;
  currencyCode: string;
};

export type AITextProvider = ConversationModelGateway;
export type VisionProvider = ListingPhotoSuggestionProvider;
export type SmsProvider = PhoneVerificationProvider;
export type PaymentProvider = PaymentProviderAdapter;
export type DriverLocationProvider = OrderTrackingProvider;

export interface GoogleOAuthProvider {
  /** Verifies identity only. DINAR still links the account and creates its own session. */
  verifyIdentity(input: {
    idToken: string;
    expectedAudience: string;
  }): Promise<{
    subject: string;
    email?: string;
    emailVerified: boolean;
  }>;
}

export interface MapsProvider {
  getViewConfiguration(input: {
    market: ProviderMarketContext;
    center?: { latitude: number; longitude: number };
    zoom: number;
  }): Promise<{
    styleUrl: string;
    attribution: string;
    expiresAt?: string;
  }>;
}

export interface GeocodingProvider {
  geocode(input: {
    market: ProviderMarketContext;
    address: string;
  }): Promise<
    Array<{
      latitude: number;
      longitude: number;
      label: string;
      accuracy: "ROOFTOP" | "STREET" | "AREA" | "UNKNOWN";
    }>
  >;
}

export interface RoutesProvider {
  /** Route geometry and timing are ephemeral; callers must not persist or log coordinates. */
  route(input: {
    market: ProviderMarketContext;
    origin: { latitude: number; longitude: number };
    destination: { latitude: number; longitude: number };
  }): Promise<{
    encodedPolyline: string;
    distanceMeters: number;
    durationSeconds: number;
    observedAt: string;
  }>;
}

export type NotificationChannel = "EMAIL" | "SMS" | "PUSH";

export interface NotificationProvider {
  /** Uses a DINAR-owned recipient reference instead of exposing contact data to callers. */
  send(input: {
    market: ProviderMarketContext;
    recipientId: string;
    channel: NotificationChannel;
    templateKey: string;
    data: Record<string, string | number>;
  }): Promise<{ providerMessageId: string }>;
}

export interface ExternalDeliveryProvider {
  quote(input: {
    market: ProviderMarketContext;
    orderId: string;
    pickup: { latitude: number; longitude: number };
    destination: { latitude: number; longitude: number };
  }): Promise<{
    quoteId: string;
    feeMinor: number;
    currencyCode: string;
    expiresAt: string;
  }>;
  createDelivery(input: {
    market: ProviderMarketContext;
    orderId: string;
    quoteId: string;
    idempotencyKey: string;
  }): Promise<{ providerReference: string }>;
  getStatus(input: {
    market: ProviderMarketContext;
    providerReference: string;
  }): Promise<{
    status: "ACCEPTED" | "PICKED_UP" | "DELIVERED" | "FAILED" | "CANCELLED";
    observedAt: string;
  }>;
}

/** A third-party carrier's tracking for a shipment DINAR already knows; DINAR stays authoritative. */
export interface ShipmentTrackingProvider {
  track(input: { market: ProviderMarketContext; carrierCode: string; trackingNumber: string }): Promise<{
    status: "LABEL_CREATED" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "EXCEPTION" | "UNKNOWN";
    /** Carrier-reported time of the last scan; never an invented ETA. */
    observedAt: string;
    events: Array<{ code: string; description: string; at: string }>;
  }>;
}

/** External error reporting. Callers pass codes and ids only — never message text, PII or secrets. */
export interface MonitoringProvider {
  captureError(input: { event: string; code: string; requestId?: string; release?: string }): Promise<void>;
}

export type ProviderAdapterMap = {
  AI_TEXT: AITextProvider;
  VISION: VisionProvider;
  SMS: SmsProvider;
  GOOGLE_OAUTH: GoogleOAuthProvider;
  MAPS: MapsProvider;
  GEOCODING: GeocodingProvider;
  ROUTES: RoutesProvider;
  PAYMENT: PaymentProvider;
  NOTIFICATIONS: NotificationProvider;
  EXTERNAL_DELIVERY: ExternalDeliveryProvider;
  DRIVER_LOCATION: DriverLocationProvider;
  SUBSCRIPTION_BILLING: SubscriptionBillingProvider;
  SHIPMENT_TRACKING: ShipmentTrackingProvider;
  MONITORING: MonitoringProvider;
};

export type ProviderRegistration<K extends ProviderFamily> = {
  family: K;
  providerKey: string;
  mode: ProviderMode;
  environments: readonly ProviderDeploymentEnvironment[];
  /** "*" is allowed only after the server-side market policy permits this family. */
  marketIds: readonly string[];
  create: () => ProviderAdapterMap[K] | Promise<ProviderAdapterMap[K]>;
};

export type AnyProviderRegistration = {
  [K in ProviderFamily]: ProviderRegistration<K>;
}[ProviderFamily];
