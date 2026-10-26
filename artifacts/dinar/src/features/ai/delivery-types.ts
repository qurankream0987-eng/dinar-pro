/** Allowlisted delivery and location views sent by the server (Block D). The client only renders them. */
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
export const DELIVERY_SURFACES = CONVERSATION_SURFACE_FAMILIES.delivery;
export type DeliverySurface = (typeof DELIVERY_SURFACES)[number];

export type LocationPurpose = "DELIVERY_DESTINATION" | "PICKUP_POINT" | "SERVICE_APPOINTMENT";

export type DeliveryLocation = {
  id: string;
  purpose: LocationPurpose;
  purposeLabel: string;
  source: "DEVICE" | "MANUAL";
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  accuracyNote: string | null;
  city: string;
  area: string;
  addressText: string | null;
  note: string | null;
  redacted: boolean;
  sharedByRole: "BUYER" | "SELLER";
  updatedAt: string;
};

export type DeliveryOrderView = {
  orderId: string;
  orderRef: string;
  orderStatus: string;
  listingTitle: string;
  role: "BUYER" | "SELLER";
  capability: string;
  options: { method: string; label: string; available: boolean; reason?: string }[];
  fulfillment: null | {
    method: string;
    methodLabel: string;
    status: string;
    statusLabel: string;
    failureLabel: string | null;
  };
  destination: DeliveryLocation | null;
  pickupPoint: DeliveryLocation | null;
  serviceLocation: DeliveryLocation | null;
  fee: { implemented: boolean; note: string };
  canSelectMethod: boolean;
  canChangeDestination: boolean;
  canSetPickupPoint: boolean;
  nextActions: string[];
  awaitingHandoff: boolean;
};

export type DeliveryPreview = {
  purpose: LocationPurpose;
  purposeLabel: string;
  source: "DEVICE" | "MANUAL";
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  accuracyNote: string | null;
  poorAccuracy: boolean;
  city: string;
  area: string;
  addressText: string | null;
  note: string | null;
  available: boolean;
};

export type DeliveryPayload = {
  view: DeliverySurface;
  orderId?: string;
  order?: DeliveryOrderView;
  notice?: string;
  request?: { requestId: string; purpose?: LocationPurpose; purposeLabel?: string };
  preview?: DeliveryPreview;
  action?: {
    actionId: string;
    type: string;
    status: "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED" | "REJECTED";
    lines: string[];
    confirmLabel: string;
  };
};

/** One explicit, user-initiated location submission sent with a conversation turn. */
export type LocationSubmission = {
  locationRequestId: string;
  location:
    | { source: "DEVICE"; latitude: number; longitude: number; accuracyMeters?: number }
    | { source: "MANUAL"; city?: string; area?: string; addressText: string; note?: string };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Shape check of a server delivery payload; anything unexpected is not rendered. */
export function normalizeDelivery(value: unknown, surface: string): DeliveryPayload | null {
  if (!isObject(value) || value.view !== surface) return null;
  if (!(DELIVERY_SURFACES as readonly string[]).includes(surface)) return null;
  if (value.order !== undefined && (!isObject(value.order) || typeof value.order.orderId !== "string")) return null;
  if (value.request !== undefined && (!isObject(value.request) || typeof value.request.requestId !== "string")) return null;
  if (
    value.action !== undefined &&
    (!isObject(value.action) || typeof value.action.actionId !== "string" || !Array.isArray(value.action.lines))
  )
    return null;
  return value as unknown as DeliveryPayload;
}
