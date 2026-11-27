/**
 * Live Delivery Telemetry & ETA Engine for In-Chat Tracking (Uber / Talabat-grade).
 * Pure, deterministic geospatial math (Haversine + route progress + staleness detection)
 * compatible with OpenFreeMap / MapLibre without requiring paid map API keys.
 */

export interface GeoPoint { lat: number; lng: number; }
export type DeliveryMilestone = "ACCEPTED" | "PREPARING" | "PICKED_UP" | "OUT_FOR_DELIVERY" | "ARRIVED" | "DELIVERED";

export interface LiveDeliveryTelemetry {
  totalKm: number;
  remainingKm: number;
  progressPercent: number;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  milestoneLabelAr: string;
  isLocationStale: boolean;
}

const EARTH_RADIUS_KM = 6371;
const STALE_LOCATION_MS = 120_000;

const MILESTONE_LABELS: Record<DeliveryMilestone, string> = {
  ACCEPTED: "تم قبول الطلب وتعيين المندوب",
  PREPARING: "المتجر يجهّز طلبك الآن",
  PICKED_UP: "استلم المندوب الطلب من المتجر",
  OUT_FOR_DELIVERY: "المندوب في الطريق إليك",
  ARRIVED: "وصل المندوب إلى موقعك",
  DELIVERED: "تم تسليم الطلب بنجاح",
};

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function computeLiveDeliveryTelemetry(input: {
  pickup: GeoPoint;
  dropoff: GeoPoint;
  courier?: GeoPoint | null;
  lastObservedAtMs?: number | null;
  nowMs?: number;
  status: DeliveryMilestone;
  avgSpeedKmh?: number;
}): LiveDeliveryTelemetry {
  const now = input.nowMs ?? Date.now();
  const speed = Math.max(10, Math.min(80, input.avgSpeedKmh ?? 28));
  const totalKm = Math.max(0.1, haversineKm(input.pickup, input.dropoff));
  const isLocationStale = !input.lastObservedAtMs || now - input.lastObservedAtMs > STALE_LOCATION_MS;

  if (input.status === "DELIVERED" || input.status === "ARRIVED") {
    return { totalKm: Number(totalKm.toFixed(2)), remainingKm: 0, progressPercent: 100, etaMinMinutes: 0, etaMaxMinutes: input.status === "ARRIVED" ? 2 : 0, milestoneLabelAr: MILESTONE_LABELS[input.status], isLocationStale };
  }

  const remainingKm = input.courier ? haversineKm(input.courier, input.dropoff) : totalKm;
  const rawProgress = input.courier ? Math.round(((totalKm - remainingKm) / totalKm) * 100) : input.status === "PICKED_UP" ? 35 : input.status === "PREPARING" ? 18 : 10;
  const progressPercent = Math.max(5, Math.min(96, rawProgress));
  const baseMinutes = Math.max(2, Math.round((remainingKm / speed) * 60));

  return { totalKm: Number(totalKm.toFixed(2)), remainingKm: Number(remainingKm.toFixed(2)), progressPercent, etaMinMinutes: baseMinutes, etaMaxMinutes: baseMinutes + Math.max(3, Math.round(baseMinutes * 0.25)), milestoneLabelAr: MILESTONE_LABELS[input.status], isLocationStale };
}
