import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";

/** Block F4 driver views. Server-built allowlists; the client only renders them. */
export const DRIVER_SURFACES = CONVERSATION_SURFACE_FAMILIES.driver;
export type DriverSurface = (typeof DRIVER_SURFACES)[number];

export type Place = { city: string; area: string };
type WorkCard = { id: string; reference: string; title: string; quantity: number; pickup: Place; dropoff: Place; methodLabel: string };
type Profile = {
  statusLabel: string;
  availability: string;
  vehicleLabel: string | null;
  serviceCity: string | null;
  phoneVerified: boolean;
  remaining: string[];
};
type Assignment = { orderId: string; reference: string; title: string; status: string; statusLabel: string | null; dropoff: Place | null };
export type DriverPayload = {
  view: DriverSurface;
  profile?: Profile | null;
  work?: WorkCard[];
  card?: WorkCard | null;
  assignments?: Assignment[];
  status?: string;
  actionId?: string;
};

export function isDriverPayload(value: unknown): value is DriverPayload {
  const item = value as Partial<DriverPayload> | undefined;
  return Boolean(item && typeof item.view === "string" && (DRIVER_SURFACES as readonly string[]).includes(item.view));
}
