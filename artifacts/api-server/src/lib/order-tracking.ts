import { and, eq } from "drizzle-orm";
import { db, deliveryAssignments, deliveryProgressEvents, orderFulfillments, users } from "@workspace/db";
import {
  METHOD_LABELS,
  participantOrder,
  statusLabel,
  type DeliveryMethod,
  type DeliveryStatus,
} from "./delivery";
import type { marketFor } from "./markets";
type Market = Awaited<ReturnType<typeof marketFor>>;

export type EphemeralTrackingSnapshot = {
  position: {
    latitude: number;
    longitude: number;
    accuracyMeters?: number | null;
    observedAt: string;
  };
  route?: {
    encodedPolyline: string;
    observedAt: string;
  } | null;
  eta?: {
    arrivalAt: string;
    observedAt: string;
  } | null;
};

/** Optional adapter supplied by a future delivery provider; its data is never persisted. */
export type OrderTrackingProvider = {
  getSnapshot(input: {
    orderId: string;
    marketId: string;
    assignedDriverId: string;
  }): Promise<EphemeralTrackingSnapshot | null>;
};

export type OrderTrackingView = {
  orderId: string;
  orderStatus: string;
  delivery: null | {
    method: DeliveryMethod;
    methodLabel: string;
    status: DeliveryStatus;
    statusLabel: string;
    updatedAt: string;
  };
  tracking:
    | { state: "UNAVAILABLE"; reason: "NOT_BUYER" | "NOT_COURIER" | "NOT_ACTIVE" | "NO_DRIVER" | "NO_PROVIDER" }
    | { state: "STOPPED"; reason: "ORDER_TERMINAL" }
    | {
        state: "LIVE" | "STALE";
        position: EphemeralTrackingSnapshot["position"];
        route: EphemeralTrackingSnapshot["route"];
        eta: EphemeralTrackingSnapshot["eta"];
      };
  progress: { type: string; occurredAt: string; actorRole: "COURIER" | "BUYER" }[];
};

const TERMINAL_ORDER_STATUSES = new Set([
  "BUYER_CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "DISPUTED",
  "SELLER_MARKED_DELIVERED",
]);
const TERMINAL_DELIVERY_STATUSES = new Set(["DELIVERED", "CANCELLED", "FAILED"]);
const TRACKABLE_DELIVERY_STATUSES = new Set(["ACCEPTED", "OUT_FOR_DELIVERY"]);
const MAX_LOCATION_AGE_MS = 90_000;

function unavailable(
  orderId: string,
  orderStatus: string,
  delivery: OrderTrackingView["delivery"],
  progress: OrderTrackingView["progress"],
  reason: Extract<OrderTrackingView["tracking"], { state: "UNAVAILABLE" }>["reason"],
): OrderTrackingView {
  return { orderId, orderStatus, delivery, progress, tracking: { state: "UNAVAILABLE", reason } };
}

function stopped(
  orderId: string,
  orderStatus: string,
  delivery: OrderTrackingView["delivery"],
  progress: OrderTrackingView["progress"],
): OrderTrackingView {
  return { orderId, orderStatus, delivery, progress, tracking: { state: "STOPPED", reason: "ORDER_TERMINAL" } };
}

function validSnapshot(value: unknown): value is EphemeralTrackingSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as EphemeralTrackingSnapshot;
  const position = snapshot.position;
  if (
    !position ||
    !Number.isFinite(position.latitude) ||
    position.latitude < -90 ||
    position.latitude > 90 ||
    !Number.isFinite(position.longitude) ||
    position.longitude < -180 ||
    position.longitude > 180 ||
    !Number.isFinite(Date.parse(position.observedAt)) ||
    (position.accuracyMeters != null &&
      (!Number.isFinite(position.accuracyMeters) || position.accuracyMeters < 0))
  )
    return false;
  if (
    snapshot.route != null &&
    (typeof snapshot.route.encodedPolyline !== "string" ||
      snapshot.route.encodedPolyline.length > 200_000 ||
      !Number.isFinite(Date.parse(snapshot.route.observedAt)))
  )
    return false;
  if (
    snapshot.eta != null &&
    (!Number.isFinite(Date.parse(snapshot.eta.arrivalAt)) ||
      !Number.isFinite(Date.parse(snapshot.eta.observedAt)))
  )
    return false;
  return true;
}

/** Participant-authorized, no-store tracking. Provider coordinates never enter chat state or logs. */
export async function getOrderTrackingView(input: {
  actorId: string;
  orderId: string;
  market: Market;
  provider?: OrderTrackingProvider;
}): Promise<OrderTrackingView> {
  const { order, role } = await participantOrder(db, input.orderId, input.actorId);
  if (order.marketId !== input.market.id)
    throw Object.assign(new Error("هذا الطلب في سوق آخر."), { status: 404, code: "MARKET_MISMATCH" });
  const events = await db.select().from(deliveryProgressEvents)
    .where(eq(deliveryProgressEvents.orderId, order.id))
    .orderBy(deliveryProgressEvents.createdAt);
  const progress = events.map((event) => ({
    type: event.type,
    occurredAt: event.createdAt.toISOString(),
    actorRole: event.type === "BUYER_RECEIVED" ? "BUYER" as const : "COURIER" as const,
  }));
  const [fulfillment] = await db
    .select()
    .from(orderFulfillments)
    .where(eq(orderFulfillments.orderId, order.id))
    .limit(1);
  const method = fulfillment?.method as DeliveryMethod | undefined;
  const status = fulfillment?.status as DeliveryStatus | undefined;
  const delivery: OrderTrackingView["delivery"] =
    fulfillment && method && status
      ? {
          method,
          methodLabel: METHOD_LABELS[method],
          status,
          statusLabel: statusLabel(method, status),
          updatedAt: fulfillment.updatedAt.toISOString(),
        }
      : null;

  if (TERMINAL_ORDER_STATUSES.has(order.status) || (status && TERMINAL_DELIVERY_STATUSES.has(status)))
    return stopped(order.id, order.status, delivery, progress);
  if (role !== "BUYER")
    return unavailable(order.id, order.status, delivery, progress, "NOT_BUYER");
  if (method !== "COURIER" || !fulfillment)
    return unavailable(order.id, order.status, delivery, progress, "NOT_COURIER");
  if (!status || !TRACKABLE_DELIVERY_STATUSES.has(status))
    return unavailable(order.id, order.status, delivery, progress, "NOT_ACTIVE");

  const [assignment] = await db
    .select({ driverId: deliveryAssignments.driverId })
    .from(deliveryAssignments)
    .where(
      and(
        eq(deliveryAssignments.orderId, order.id),
        eq(deliveryAssignments.status, "ACCEPTED"),
      ),
    )
    .limit(1);
  if (!assignment) return unavailable(order.id, order.status, delivery, progress, "NO_DRIVER");
  if (!input.provider)
    return unavailable(order.id, order.status, delivery, progress, "NO_PROVIDER");

  let snapshotValue: EphemeralTrackingSnapshot | null;
  try {
    snapshotValue = await input.provider.getSnapshot({
      orderId: order.id,
      marketId: order.marketId,
      assignedDriverId: assignment.driverId,
    });
  } catch {
    // Provider errors may contain precise coordinates; never forward or log them.
    return unavailable(order.id, order.status, delivery, progress, "NO_PROVIDER");
  }
  if (!snapshotValue || !validSnapshot(snapshotValue))
    return unavailable(order.id, order.status, delivery, progress, "NO_PROVIDER");

  // Discard a provider response if the order became terminal while the request was in flight.
  const { order: currentOrder } = await participantOrder(db, order.id, input.actorId);
  const [currentActor] = await db
    .select({ activeMarketId: users.activeMarketId })
    .from(users)
    .where(eq(users.id, input.actorId))
    .limit(1);
  if (
    !currentActor ||
    currentActor.activeMarketId !== currentOrder.marketId ||
    currentOrder.marketId !== input.market.id
  )
    throw Object.assign(new Error("هذا الطلب في سوق آخر."), { status: 404, code: "MARKET_MISMATCH" });
  const [currentFulfillment] = await db
    .select({ method: orderFulfillments.method, status: orderFulfillments.status })
    .from(orderFulfillments)
    .where(eq(orderFulfillments.orderId, order.id))
    .limit(1);
  if (
    TERMINAL_ORDER_STATUSES.has(currentOrder.status) ||
    (currentFulfillment && TERMINAL_DELIVERY_STATUSES.has(currentFulfillment.status))
  )
    return stopped(order.id, currentOrder.status, delivery, progress);
  if (
    currentFulfillment?.method !== "COURIER" ||
    !TRACKABLE_DELIVERY_STATUSES.has(currentFulfillment.status)
  )
    return unavailable(order.id, currentOrder.status, delivery, progress, "NOT_ACTIVE");
  const [currentAssignment] = await db
    .select({ driverId: deliveryAssignments.driverId })
    .from(deliveryAssignments)
    .where(
      and(
        eq(deliveryAssignments.orderId, order.id),
        eq(deliveryAssignments.status, "ACCEPTED"),
      ),
    )
    .limit(1);
  if (!currentAssignment || currentAssignment.driverId !== assignment.driverId)
    return unavailable(order.id, currentOrder.status, delivery, progress, "NO_DRIVER");

  const state =
    Date.now() - Date.parse(snapshotValue.position.observedAt) <= MAX_LOCATION_AGE_MS
      ? "LIVE"
      : "STALE";
  return {
    orderId: order.id,
    orderStatus: currentOrder.status,
    delivery,
    progress,
    tracking: {
      state,
      position: snapshotValue.position,
      route: snapshotValue.route ?? null,
      eta: snapshotValue.eta ?? null,
    },
  };
}
