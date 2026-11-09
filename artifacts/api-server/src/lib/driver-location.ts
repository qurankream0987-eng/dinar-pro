/**
 * First-party driver location sharing for an assigned COURIER delivery (migration 0061).
 *
 * - Sharing exists only between an explicit driver start (with consent) and its end. It is bound
 *   to one ACCEPTED delivery_assignments row: the actor must be that assignment's driver, in the
 *   order's market, while the delivery is in an active courier status.
 * - Only the latest position is kept: each accepted update overwrites the row. Ending the session
 *   (driver stop, delivery end, cancellation, revocation, expiry) clears every coordinate; the
 *   database refuses a position on an ENDED row.
 * - Updates are validated server-side: coordinate ranges, accuracy, a device timestamp that is
 *   neither in the future nor old, a strictly increasing sequence (replays and out-of-order
 *   messages are refused), a minimum interval (rate limit) and a plausible implied speed.
 * - Coordinates are never logged, audited or written into conversation state.
 * - The buyer reads the position only through the existing participant-authorized, no-store
 *   GET /orders/:id/tracking via firstPartyTrackingProvider; no other endpoint exposes it.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { db, deliveryAssignments, driverLocationShares, orderFulfillments, orders } from "@workspace/db";
import type { OrderTrackingProvider } from "./order-tracking";

export const SHARING_DELIVERY_STATUSES = ["ACCEPTED", "READY_FOR_PICKUP", "PICKED_UP", "OUT_FOR_DELIVERY"] as const;
const SHARING_ORDER_STATUSES = ["ACCEPTED", "IN_PROGRESS"];
export const MIN_UPDATE_INTERVAL_MS = 4_000;
export const MAX_DEVICE_AGE_MS = 120_000;
export const MAX_FUTURE_SKEW_MS = 30_000;
export const MAX_ACCURACY_METERS = 5_000;
/** 250 km/h: anything faster between two fixes is a spoofed or broken reading, not a delivery. */
export const MAX_IMPLIED_SPEED_MPS = 250 / 3.6;
/** No update for this long ends the session; a stale map is not kept alive indefinitely. */
export const IDLE_EXPIRY_MS = 15 * 60_000;
/** Ended rows hold no coordinates; their timestamps are kept this long for audit, then deleted. */
export const ENDED_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type EndReason = "DRIVER_STOPPED" | "DELIVERY_ENDED" | "ASSIGNMENT_ENDED" | "EXPIRED";

const fail = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

/** Production-like deployments enable sharing only by explicit configuration; development defaults on. */
export function driverLocationSharingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.DINAR_DRIVER_LOCATION_SHARING?.trim().toLowerCase();
  if (setting === "enabled") return true;
  if (setting === "disabled") return false;
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

const ENDED_POSITION = { latitude: null, longitude: null, accuracyMeters: null, observedAt: null } as const;

/** Ends every active share for an order (inside the caller's transaction). Safe to call repeatedly. */
export async function endLocationSharingForOrder(tx: any, orderId: string, reason: EndReason, now = new Date()) {
  await tx
    .update(driverLocationShares)
    .set({ status: "ENDED", endedAt: now, endReason: reason, ...ENDED_POSITION, updatedAt: now })
    .where(and(eq(driverLocationShares.orderId, orderId), eq(driverLocationShares.status, "ACTIVE")));
}

async function activeAssignmentFor(tx: any, input: { actorId: string; orderId: string; marketId: string }, lock = false) {
  let query = tx
    .select({
      assignmentId: deliveryAssignments.id,
      driverId: deliveryAssignments.driverId,
      orderStatus: orders.status,
      orderMarketId: orders.marketId,
      method: orderFulfillments.method,
      deliveryStatus: orderFulfillments.status,
    })
    .from(deliveryAssignments)
    .innerJoin(orders, eq(orders.id, deliveryAssignments.orderId))
    .innerJoin(orderFulfillments, eq(orderFulfillments.orderId, deliveryAssignments.orderId))
    .where(and(eq(deliveryAssignments.orderId, input.orderId), eq(deliveryAssignments.status, "ACCEPTED")))
    .limit(1);
  if (lock) query = query.for("update", { of: deliveryAssignments });
  const [row] = await query;
  // Strangers, other drivers and other markets all see the same 404.
  if (!row || row.driverId !== input.actorId || row.orderMarketId !== input.marketId)
    throw fail(404, "لا توجد مهمة توصيل نشطة مسندة إليك لهذا الطلب.", "ASSIGNMENT_NOT_FOUND");
  return row as { assignmentId: string; driverId: string; orderStatus: string; method: string; deliveryStatus: string };
}

function sharingAllowed(row: { orderStatus: string; method: string; deliveryStatus: string }) {
  return (
    row.method === "COURIER" &&
    SHARING_ORDER_STATUSES.includes(row.orderStatus) &&
    (SHARING_DELIVERY_STATUSES as readonly string[]).includes(row.deliveryStatus)
  );
}

export type SharingView = { active: boolean; consentedAt: string | null; lastObservedAt: string | null; sequence: number; endReason: EndReason | null };

function view(row: typeof driverLocationShares.$inferSelect | undefined): SharingView {
  return {
    active: row?.status === "ACTIVE",
    consentedAt: row?.status === "ACTIVE" ? row.consentedAt.toISOString() : null,
    lastObservedAt: row?.status === "ACTIVE" && row.observedAt ? row.observedAt.toISOString() : null,
    sequence: row?.status === "ACTIVE" ? row.sequence : 0,
    endReason: (row?.endReason as EndReason | null) ?? null,
  };
}

export async function startDriverLocationSharing(input: { actorId: string; orderId: string; marketId: string; consent: boolean; now?: Date }): Promise<SharingView> {
  if (!driverLocationSharingEnabled()) throw fail(503, "مشاركة موقع المندوب غير مفعّلة في هذه البيئة.", "LOCATION_SHARING_DISABLED");
  if (input.consent !== true) throw fail(400, "مشاركة الموقع تحتاج موافقتك الصريحة.", "CONSENT_REQUIRED");
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const assignment = await activeAssignmentFor(tx, input, true);
    if (!sharingAllowed(assignment)) throw fail(409, "حالة التوصيل لا تسمح بمشاركة الموقع الآن.", "DELIVERY_NOT_ACTIVE");
    const [row] = await tx
      .insert(driverLocationShares)
      .values({
        assignmentId: assignment.assignmentId,
        orderId: input.orderId,
        marketId: input.marketId,
        driverId: input.actorId,
        status: "ACTIVE",
        consentedAt: now,
      })
      .onConflictDoUpdate({
        target: driverLocationShares.assignmentId,
        // A restart is a fresh session: earlier coordinates and sequence never carry over.
        set: { status: "ACTIVE", consentedAt: now, endedAt: null, endReason: null, ...ENDED_POSITION, receivedAt: null, sequence: 0, updatedAt: now },
      })
      .returning();
    return view(row);
  });
}

export async function stopDriverLocationSharing(input: { actorId: string; orderId: string; marketId: string; now?: Date }): Promise<SharingView> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(driverLocationShares)
      .set({ status: "ENDED", endedAt: now, endReason: "DRIVER_STOPPED", ...ENDED_POSITION, updatedAt: now })
      .where(
        and(
          eq(driverLocationShares.orderId, input.orderId),
          eq(driverLocationShares.driverId, input.actorId),
          eq(driverLocationShares.marketId, input.marketId),
          eq(driverLocationShares.status, "ACTIVE"),
        ),
      )
      .returning();
    // Stopping is idempotent and reveals nothing: an unknown order answers like an ended one.
    return view(row ?? undefined);
  });
}

export async function driverLocationSharingStatus(input: { actorId: string; orderId: string; marketId: string }): Promise<SharingView> {
  const [row] = await db
    .select()
    .from(driverLocationShares)
    .where(
      and(
        eq(driverLocationShares.orderId, input.orderId),
        eq(driverLocationShares.driverId, input.actorId),
        eq(driverLocationShares.marketId, input.marketId),
      ),
    )
    .orderBy(sql`${driverLocationShares.updatedAt} desc`)
    .limit(1);
  return view(row);
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type LocationUpdate = { latitude: number; longitude: number; accuracyMeters: number; observedAt: string; sequence: number };

export type UpdateResult =
  | { accepted: true; sequence: number }
  | { accepted: false; reason: "DUPLICATE_OR_OUT_OF_ORDER" | "TOO_FREQUENT"; retryAfterMs?: number };

export async function updateDriverLocation(input: { actorId: string; orderId: string; marketId: string; update: LocationUpdate; now?: Date }): Promise<UpdateResult> {
  if (!driverLocationSharingEnabled()) throw fail(503, "مشاركة موقع المندوب غير مفعّلة في هذه البيئة.", "LOCATION_SHARING_DISABLED");
  const now = input.now ?? new Date();
  const { latitude, longitude, accuracyMeters, sequence } = input.update;
  const observedMs = Date.parse(input.update.observedAt);
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    (latitude === 0 && longitude === 0) ||
    !Number.isFinite(accuracyMeters) || accuracyMeters < 0 ||
    !Number.isSafeInteger(sequence) || sequence < 1 ||
    !Number.isFinite(observedMs)
  )
    throw fail(400, "قراءة الموقع غير صالحة.", "INVALID_POSITION");
  if (accuracyMeters > MAX_ACCURACY_METERS) throw fail(422, "دقة الموقع ضعيفة جدًا لعرضها.", "ACCURACY_TOO_LOW");
  if (observedMs > now.getTime() + MAX_FUTURE_SKEW_MS) throw fail(422, "توقيت قراءة الموقع في المستقبل.", "TIMESTAMP_IN_FUTURE");
  if (observedMs < now.getTime() - MAX_DEVICE_AGE_MS) throw fail(422, "قراءة الموقع قديمة جدًا.", "TIMESTAMP_TOO_OLD");

  return db.transaction(async (tx) => {
    const assignment = await activeAssignmentFor(tx, input, true);
    const [share] = await tx
      .select()
      .from(driverLocationShares)
      .where(and(eq(driverLocationShares.assignmentId, assignment.assignmentId), eq(driverLocationShares.status, "ACTIVE")))
      .for("update")
      .limit(1);
    if (!share) throw fail(409, "مشاركة الموقع غير نشطة لهذا الطلب.", "SHARING_NOT_ACTIVE");
    if (!sharingAllowed(assignment)) {
      await endLocationSharingForOrder(tx, input.orderId, "DELIVERY_ENDED", now);
      throw fail(409, "انتهت مرحلة التوصيل؛ توقفت مشاركة الموقع.", "SHARING_ENDED");
    }
    if (sequence <= share.sequence || (share.observedAt && observedMs < share.observedAt.getTime()))
      return { accepted: false as const, reason: "DUPLICATE_OR_OUT_OF_ORDER" as const };
    if (share.receivedAt && now.getTime() - share.receivedAt.getTime() < MIN_UPDATE_INTERVAL_MS)
      return { accepted: false as const, reason: "TOO_FREQUENT" as const, retryAfterMs: MIN_UPDATE_INTERVAL_MS - (now.getTime() - share.receivedAt.getTime()) };
    if (share.latitude != null && share.longitude != null && share.observedAt) {
      const seconds = Math.max(1, (observedMs - share.observedAt.getTime()) / 1000);
      // Movement within the combined accuracy radius is noise, not speed.
      const meters = Math.max(0, distanceMeters(share as { latitude: number; longitude: number }, { latitude, longitude }) - accuracyMeters - (share.accuracyMeters ?? 0));
      if (meters / seconds > MAX_IMPLIED_SPEED_MPS) throw fail(422, "قفزة غير منطقية في الموقع؛ لم تُعتمد القراءة.", "IMPLAUSIBLE_MOVEMENT");
    }
    await tx
      .update(driverLocationShares)
      .set({
        latitude,
        longitude,
        accuracyMeters: Math.round(accuracyMeters),
        observedAt: new Date(observedMs),
        receivedAt: now,
        sequence,
        updatedAt: now,
      })
      .where(eq(driverLocationShares.assignmentId, assignment.assignmentId));
    return { accepted: true as const, sequence };
  });
}

/**
 * Housekeeping: ends sessions whose assignment or delivery is no longer active, or that went
 * idle, and deletes ended rows (which hold no coordinates) after the audit retention window.
 */
export async function sweepDriverLocationShares(now = new Date()): Promise<{ ended: number; deleted: number }> {
  return db.transaction(async (tx) => {
    const active = await tx
      .select({
        assignmentId: driverLocationShares.assignmentId,
        orderId: driverLocationShares.orderId,
        receivedAt: driverLocationShares.receivedAt,
        consentedAt: driverLocationShares.consentedAt,
        assignmentStatus: deliveryAssignments.status,
        orderStatus: orders.status,
        method: orderFulfillments.method,
        deliveryStatus: orderFulfillments.status,
      })
      .from(driverLocationShares)
      .innerJoin(deliveryAssignments, eq(deliveryAssignments.id, driverLocationShares.assignmentId))
      .innerJoin(orders, eq(orders.id, driverLocationShares.orderId))
      .leftJoin(orderFulfillments, eq(orderFulfillments.orderId, driverLocationShares.orderId))
      .where(eq(driverLocationShares.status, "ACTIVE"));
    let ended = 0;
    for (const row of active) {
      const lastSignal = (row.receivedAt ?? row.consentedAt).getTime();
      const reason: EndReason | null =
        row.assignmentStatus !== "ACCEPTED"
          ? "ASSIGNMENT_ENDED"
          : !sharingAllowed({ orderStatus: row.orderStatus, method: row.method ?? "", deliveryStatus: row.deliveryStatus ?? "" })
            ? "DELIVERY_ENDED"
            : now.getTime() - lastSignal > IDLE_EXPIRY_MS
              ? "EXPIRED"
              : null;
      if (!reason) continue;
      await tx
        .update(driverLocationShares)
        .set({ status: "ENDED", endedAt: now, endReason: reason, ...ENDED_POSITION, updatedAt: now })
        .where(and(eq(driverLocationShares.assignmentId, row.assignmentId), eq(driverLocationShares.status, "ACTIVE")));
      ended += 1;
    }
    const deleted = await tx
      .delete(driverLocationShares)
      .where(and(eq(driverLocationShares.status, "ENDED"), lt(driverLocationShares.endedAt, new Date(now.getTime() - ENDED_RETENTION_MS))))
      .returning({ id: driverLocationShares.assignmentId });
    return { ended, deleted: deleted.length };
  });
}

/** Feeds the existing tracking view from the latest shared position of the assigned driver. */
export const firstPartyTrackingProvider: OrderTrackingProvider = {
  async getSnapshot({ orderId, marketId, assignedDriverId }) {
    const [row] = await db
      .select()
      .from(driverLocationShares)
      .where(
        and(
          eq(driverLocationShares.orderId, orderId),
          eq(driverLocationShares.marketId, marketId),
          eq(driverLocationShares.driverId, assignedDriverId),
          eq(driverLocationShares.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!row || row.latitude == null || row.longitude == null || !row.observedAt) return null;
    return {
      position: {
        latitude: row.latitude,
        longitude: row.longitude,
        accuracyMeters: row.accuracyMeters,
        observedAt: row.observedAt.toISOString(),
      },
      // No routing provider is approved: route and ETA are never invented.
      route: null,
      eta: null,
    };
  },
};

