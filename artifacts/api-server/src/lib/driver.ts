/**
 * Block F4 — the delivery-driver authority.
 *
 * A driver is an ordinary DINAR account with a market-scoped DriverProfile: a server
 * lifecycle (DRAFT → PENDING_VERIFICATION → APPROVED / SUSPENDED) that only an
 * administrator moves to APPROVED, plus the driver's own stated availability. Work is
 * the market's COURIER orders that are open in Block D; accepting one inserts the single
 * ACCEPTED delivery_assignments row and moves the Block D fulfilment to ACCEPTED in the
 * same transaction. Every later step is a Block D transition or the shared order
 * handoff. There is no driver location, tracking, history or earnings here.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  deliveryAssignments,
  deliveryProgressEvents,
  driverProfiles,
  marketAudit,
  messages,
  offers,
  orderFulfillments,
  orders,
  transactionLocations,
  users,
} from "@workspace/db";
import { endLocationSharingForOrder } from "./driver-location";
import { ACCOUNT_STATUS } from "./account-status";
import { getCourierCommissionAccount } from "./courier-economics";
import { sameCourierCity } from "./courier-supply";
import { EXECUTABLE_ORDER, METHOD_LABELS, orderHandoff, orderReference, participantOrder, transitionDelivery } from "./delivery";
import type { marketFor } from "./markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
export type DriverProfileRow = typeof driverProfiles.$inferSelect;

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export const DRIVER_STATUS_LABELS: Record<string, string> = {
  DRAFT: "قيد الإعداد",
  PENDING_VERIFICATION: "بانتظار التحقق",
  APPROVED: "معتمد",
  SUSPENDED: "موقوف",
};
export const VEHICLE_TYPES = ["CAR", "MOTORCYCLE", "BICYCLE"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export const VEHICLE_LABELS: Record<VehicleType, string> = { CAR: "سيارة", MOTORCYCLE: "دراجة نارية", BICYCLE: "دراجة هوائية" };
export const DRIVER_FIELD_LABELS: Record<string, string> = { vehicleType: "نوع المركبة", serviceCity: "مدينة العمل" };

/**
 * The market's driver policy boundary. DINAR has no regulated checks yet (licence,
 * insurance, identity, background): a market administrator reviews each request, and
 * real verification belongs to the legal rollout. Only the account's existing phone
 * verification is read; nothing here sends an SMS.
 */
export function driverPolicy(_market: Pick<Market, "id">) {
  return {
    requiredFields: ["vehicleType", "serviceCity"] as const,
    requiresVerifiedPhone: true,
    approval: "ADMIN_REVIEW" as const,
  };
}

export function missingDriverFields(profile: Pick<DriverProfileRow, "vehicleType" | "serviceCity"> | undefined, market: Pick<Market, "id">): string[] {
  return driverPolicy(market).requiredFields.filter((field) => !profile?.[field]);
}

async function audit(tx: any, marketId: string, actorId: string, action: string, data: Record<string, unknown>) {
  await tx.insert(marketAudit).values({ id: randomUUID(), marketId, actorId, action, data });
}

export async function driverProfileFor(userId: string, marketId: string, tx: any = db): Promise<DriverProfileRow | undefined> {
  const [row] = await tx.select().from(driverProfiles).where(and(eq(driverProfiles.userId, userId), eq(driverProfiles.marketId, marketId)));
  return row;
}

async function activeUser(tx: any, userId: string, lock = false) {
  let query = tx.select().from(users).where(eq(users.id, userId));
  if (lock) query = query.for("share");
  const [user] = await query;
  if (!user || user.status !== ACCOUNT_STATUS.active) throw fail(403, "حسابك غير نشط حاليًا؛ لا يمكن تنفيذ أعمال التوصيل.", "ACCOUNT_INACTIVE");
  return user as typeof users.$inferSelect;
}

// ─── Profile lifecycle ───────────────────────────────────────────────────────

/**
 * Creates the user's DRAFT profile in this market (one per user and market), or fills
 * fields still being prepared. An approved or suspended profile is never edited here.
 */
export async function ensureDriverDraft(input: {
  userId: string;
  market: Market;
  vehicleType?: VehicleType;
  serviceCity?: string;
}): Promise<{ profile: DriverProfileRow; created: boolean }> {
  return db.transaction(async (tx) => {
    const user = await activeUser(tx, input.userId);
    if (user.activeMarketId !== input.market.id) throw fail(409, "هذا السوق ليس سوقك النشط.", "MARKET_MISMATCH");
    const [inserted] = await tx
      .insert(driverProfiles)
      .values({
        id: randomUUID(),
        userId: input.userId,
        marketId: input.market.id,
        status: "DRAFT",
        vehicleType: input.vehicleType ?? null,
        serviceCity: input.serviceCity ?? null,
      })
      .onConflictDoNothing({ target: [driverProfiles.userId, driverProfiles.marketId] })
      .returning();
    if (inserted) {
      await audit(tx, input.market.id, input.userId, "DRIVER_PROFILE_CREATED", { driverProfileId: inserted.id });
      return { profile: inserted, created: true };
    }
    const [current] = await tx
      .select()
      .from(driverProfiles)
      .where(and(eq(driverProfiles.userId, input.userId), eq(driverProfiles.marketId, input.market.id)))
      .for("update");
    const changes = {
      ...(input.vehicleType && input.vehicleType !== current!.vehicleType ? { vehicleType: input.vehicleType } : {}),
      ...(input.serviceCity && input.serviceCity !== current!.serviceCity ? { serviceCity: input.serviceCity } : {}),
    };
    if (!["DRAFT", "PENDING_VERIFICATION"].includes(current!.status) || !Object.keys(changes).length) return { profile: current!, created: false };
    const [updated] = await tx
      .update(driverProfiles)
      .set({ ...changes, version: current!.version + 1, updatedAt: new Date() })
      .where(eq(driverProfiles.id, current!.id))
      .returning();
    return { profile: updated!, created: false };
  });
}

/** DRAFT → PENDING_VERIFICATION once every required field is known. Never approves. */
export async function submitDriverProfile(input: { userId: string; market: Market; profileId: string }): Promise<DriverProfileRow> {
  return db.transaction(async (tx) => {
    await activeUser(tx, input.userId);
    const [profile] = await tx.select().from(driverProfiles).where(eq(driverProfiles.id, input.profileId)).for("update");
    if (!profile || profile.userId !== input.userId || profile.marketId !== input.market.id) throw fail(404, "ملف السائق غير موجود");
    if (profile.status !== "DRAFT") throw fail(409, `طلب التسجيل ${DRIVER_STATUS_LABELS[profile.status]} بالفعل`, "NOT_DRAFT");
    const missing = missingDriverFields(profile, input.market);
    if (missing.length) throw fail(409, `معلومات ناقصة: ${missing.map((field) => DRIVER_FIELD_LABELS[field]).join("، ")}`, "MISSING_FIELDS");
    const [updated] = await tx
      .update(driverProfiles)
      .set({ status: "PENDING_VERIFICATION", version: profile.version + 1, updatedAt: new Date() })
      .where(eq(driverProfiles.id, profile.id))
      .returning();
    await audit(tx, profile.marketId, input.userId, "DRIVER_PROFILE_SUBMITTED", { driverProfileId: profile.id });
    return updated!;
  });
}

/**
 * The only path to APPROVED: an active market administrator, a submitted (or suspended)
 * profile with every required field, and an account whose phone is already verified.
 */
export async function reviewDriverProfile(input: { adminId: string; profileId: string; decision: "APPROVE" | "SUSPEND" }): Promise<DriverProfileRow> {
  return db.transaction(async (tx) => {
    const [admin] = await tx.select().from(users).where(eq(users.id, input.adminId));
    if (!admin || admin.role !== "ADMIN" || admin.status !== ACCOUNT_STATUS.active) throw fail(403, "هذا الإجراء لإدارة السوق فقط", "ADMIN_ONLY");
    const [profile] = await tx.select().from(driverProfiles).where(eq(driverProfiles.id, input.profileId)).for("update");
    if (!profile) throw fail(404, "ملف السائق غير موجود");
    let next: Partial<DriverProfileRow>;
    if (input.decision === "APPROVE") {
      if (!["PENDING_VERIFICATION", "SUSPENDED"].includes(profile.status)) throw fail(409, "لا يمكن اعتماد الملف في حالته الحالية", "INVALID_STATUS");
      if (missingDriverFields(profile, { id: profile.marketId }).length) throw fail(409, "الملف ناقص", "MISSING_FIELDS");
      const [owner] = await tx.select({ phoneVerified: users.phoneVerified, status: users.status }).from(users).where(eq(users.id, profile.userId));
      if (driverPolicy({ id: profile.marketId }).requiresVerifiedPhone && !owner?.phoneVerified)
        throw fail(409, "رقم هاتف الحساب غير موثق", "PHONE_UNVERIFIED");
      next = { status: "APPROVED" };
    } else {
      if (!["PENDING_VERIFICATION", "APPROVED"].includes(profile.status)) throw fail(409, "لا يمكن إيقاف الملف في حالته الحالية", "INVALID_STATUS");
      next = { status: "SUSPENDED", availability: "UNAVAILABLE" };
    }
    const [updated] = await tx
      .update(driverProfiles)
      .set({ ...next, reviewedBy: admin.id, version: profile.version + 1, updatedAt: new Date() })
      .where(eq(driverProfiles.id, profile.id))
      .returning();
    if (input.decision === "SUSPEND") {
      const activeAssignments = await tx
        .select({ assignment: deliveryAssignments, fulfillment: orderFulfillments })
        .from(deliveryAssignments)
        .innerJoin(orderFulfillments, eq(orderFulfillments.orderId, deliveryAssignments.orderId))
        .where(and(
          eq(deliveryAssignments.driverProfileId, profile.id),
          eq(deliveryAssignments.status, "ACCEPTED"),
          eq(orderFulfillments.status, "ACCEPTED"),
        ))
        .for("update");
      for (const { assignment, fulfillment } of activeAssignments) {
        const [custody] = await tx.select({ id: deliveryProgressEvents.id }).from(deliveryProgressEvents)
          .where(and(eq(deliveryProgressEvents.orderId, assignment.orderId), eq(deliveryProgressEvents.type, "PICKED_UP")));
        if (custody) continue;
        const now = new Date();
        await endLocationSharingForOrder(tx, assignment.orderId, "ASSIGNMENT_ENDED", now);
        await tx.update(deliveryAssignments)
          .set({ status: "RELEASED", releasedAt: now, updatedAt: now })
          .where(eq(deliveryAssignments.id, assignment.id));
        await tx.update(orderFulfillments)
          .set({ status: "FAILED", failureReason: "OTHER", statusChangedBy: admin.id, version: fulfillment.version + 1, updatedAt: now })
          .where(eq(orderFulfillments.orderId, assignment.orderId));
        await tx.delete(transactionLocations)
          .where(and(eq(transactionLocations.orderId, assignment.orderId), eq(transactionLocations.purpose, "DELIVERY_DESTINATION")));
        await audit(tx, assignment.marketId, admin.id, "COURIER_ASSIGNMENT_REVOKED", {
          orderId: assignment.orderId,
          assignmentId: assignment.id,
          driverId: assignment.driverId,
          reason: "DRIVER_SUSPENDED_BEFORE_PICKUP",
          fromStatus: "ACCEPTED",
        });
      }
    }
    await audit(tx, profile.marketId, admin.id, input.decision === "APPROVE" ? "DRIVER_PROFILE_APPROVED" : "DRIVER_PROFILE_SUSPENDED", {
      driverProfileId: profile.id,
      from: profile.status,
    });
    return updated!;
  });
}

/** The driver's own explicit statement; only an approved driver on an active account can be AVAILABLE. */
export async function setDriverAvailability(input: { userId: string; market: Market; availability: "AVAILABLE" | "UNAVAILABLE" }): Promise<DriverProfileRow> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(driverProfiles)
      .where(and(eq(driverProfiles.userId, input.userId), eq(driverProfiles.marketId, input.market.id)))
      .for("update");
    if (!profile) throw fail(404, "لست مسجلًا كسائق في هذا السوق.", "NO_PROFILE");
    if (input.availability === "AVAILABLE") {
      await activeUser(tx, input.userId);
      if (profile.status !== "APPROVED")
        throw fail(409, `لا يمكن تفعيل الإتاحة: حالة تسجيلك كسائق «${DRIVER_STATUS_LABELS[profile.status]}».`, "NOT_APPROVED");
    }
    if (profile.availability === input.availability) return profile;
    const [updated] = await tx
      .update(driverProfiles)
      .set({ availability: input.availability, version: profile.version + 1, updatedAt: new Date() })
      .where(eq(driverProfiles.id, profile.id))
      .returning();
    await audit(tx, profile.marketId, input.userId, "DRIVER_AVAILABILITY_CHANGED", { driverProfileId: profile.id, availability: input.availability });
    return updated!;
  });
}

// ─── Work discovery ──────────────────────────────────────────────────────────

/** The allowlisted pre-assignment card: coarse areas only, no parties, contacts or coordinates. */
export type DeliveryWorkCard = {
  id: string;
  reference: string;
  title: string;
  quantity: number;
  pickup: { city: string; area: string };
  dropoff: { city: string; area: string };
  methodLabel: string;
  requestedAt: string;
};

/** Why a driver cannot work now, or undefined when approved, available and active in this market. */
export function driverWorkBlock(profile: DriverProfileRow | undefined, user: typeof users.$inferSelect | undefined, market: Pick<Market, "id">) {
  if (!user || user.status !== ACCOUNT_STATUS.active) return "حسابك غير نشط حاليًا؛ لا يمكن قبول مهام توصيل.";
  if (user.activeMarketId !== market.id) return "هذا السوق ليس سوقك النشط.";
  if (!profile) return "لست مسجلًا كسائق في هذا السوق.";
  if (profile.status !== "APPROVED") return `حالة تسجيلك كسائق «${DRIVER_STATUS_LABELS[profile.status]}»؛ لا يمكنك استلام مهام بعد.`;
  if (profile.availability !== "AVAILABLE") return "أنت غير متاح حاليًا؛ قل «أنا متاح» لتظهر لك مهام التوصيل.";
  return undefined;
}

async function workRows(tx: any, marketId: string, orderIds?: string[]) {
  const rows = await tx
    .select({ order: orders, fulfillment: orderFulfillments })
    .from(orderFulfillments)
    .innerJoin(orders, eq(orders.id, orderFulfillments.orderId))
    .where(
      and(
        eq(orderFulfillments.marketId, marketId),
        eq(orderFulfillments.method, "COURIER"),
        ...(orderIds ? [inArray(orders.id, orderIds)] : [eq(orderFulfillments.status, "REQUESTED"), inArray(orders.status, EXECUTABLE_ORDER)]),
      ),
    )
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(200);
  return rows as { order: typeof orders.$inferSelect; fulfillment: typeof orderFulfillments.$inferSelect }[];
}

async function coarsePlaces(tx: any, rows: { order: typeof orders.$inferSelect }[]) {
  const orderIds = rows.map((row) => row.order.id);
  const listingIds = [...new Set(rows.map((row) => String(row.order.data.listingId ?? "")).filter(Boolean))];
  const [destinations, listings, assignments] = await Promise.all([
    orderIds.length
      ? tx
          .select({ orderId: transactionLocations.orderId, city: transactionLocations.city, area: transactionLocations.area })
          .from(transactionLocations)
          .where(and(inArray(transactionLocations.orderId, orderIds), eq(transactionLocations.purpose, "DELIVERY_DESTINATION"), isNull(transactionLocations.redactedAt)))
      : [],
    listingIds.length ? tx.select({ id: offers.id, data: offers.data }).from(offers).where(inArray(offers.id, listingIds)) : [],
    orderIds.length
      ? tx
          .select({ orderId: deliveryAssignments.orderId, driverId: deliveryAssignments.driverId })
          .from(deliveryAssignments)
          .where(and(inArray(deliveryAssignments.orderId, orderIds), eq(deliveryAssignments.status, "ACCEPTED")))
      : [],
  ]);
  return {
    destination: new Map<string, { city: string; area: string }>(destinations.map((row: any) => [row.orderId, { city: row.city, area: row.area }])),
    pickup: new Map<string, { city: string; area: string }>(
      listings.map((row: any) => [row.id, { city: String(row.data?.city ?? ""), area: String(row.data?.area ?? "") }]),
    ),
    assigned: new Map<string, string>(assignments.map((row: any) => [row.orderId, row.driverId])),
  };
}

/**
 * Open COURIER work this driver may take: the market's executable orders with a shared
 * destination, no active assignment, not the driver's own order, picked up in the
 * driver's coarse operating city. A city filter narrows by pickup or drop-off city.
 */
export async function listDeliveryWork(input: { userId: string; market: Market; city?: string; exclude?: string[] }): Promise<{ cards: DeliveryWorkCard[]; blocked?: string; serviceCity?: string | null }> {
  const [[user], profile] = await Promise.all([db.select().from(users).where(eq(users.id, input.userId)), driverProfileFor(input.userId, input.market.id)]);
  const blocked = driverWorkBlock(profile, user, input.market);
  if (blocked) return { cards: [], blocked, serviceCity: profile?.serviceCity ?? null };
  const commissionAccount = await getCourierCommissionAccount({ courierId: input.userId }, db);
  if (commissionAccount.hold)
    return {
      cards: [],
      blocked: "لديك 10 مهام توصيل مكتملة وعمولة جاسم مستحقة؛ سوِّ الرصيد المستحق قبل قبول مهمة جديدة.",
      serviceCity: profile?.serviceCity ?? null,
    };
  const rows = (await workRows(db, input.market.id)).filter(
    (row) => row.order.buyerId !== input.userId && row.order.sellerId !== input.userId && !input.exclude?.includes(row.order.id),
  );
  const places = await coarsePlaces(db, rows);
  const cards: DeliveryWorkCard[] = [];
  for (const { order, fulfillment } of rows) {
    const dropoff = places.destination.get(order.id);
    const pickup = places.pickup.get(String(order.data.listingId ?? "")) ?? { city: "", area: "" };
    if (!dropoff || places.assigned.has(order.id)) continue;
    if (!sameCourierCity(pickup.city, profile!.serviceCity)) continue;
    if (input.city && !sameCourierCity(pickup.city, input.city) && !sameCourierCity(dropoff.city, input.city)) continue;
    cards.push({
      id: order.id,
      reference: orderReference(order.id),
      title: String(order.data.listingTitle ?? ""),
      quantity: order.quantity,
      pickup,
      dropoff,
      methodLabel: METHOD_LABELS.COURIER,
      requestedAt: fulfillment.updatedAt.toISOString(),
    });
  }
  return { cards: cards.slice(0, 24), serviceCity: profile!.serviceCity };
}

export type WorkState = {
  actorStatus: string;
  actorMarketId: string;
  orderMarketId: string;
  /** OPEN, or why the order cannot be taken by this driver now. */
  code: "OPEN" | "OWN_ORDER" | "NO_PROFILE" | "DRIVER_BLOCKED" | "COMMISSION_HOLD" | "TAKEN" | "ASSIGNED_TO_YOU" | "NOT_OPEN" | "OUT_OF_AREA";
  reason?: string;
  version: string;
};

/** Everything an accept depends on, re-read from server rows. */
export async function deliveryWorkState(actorId: string, orderId: string, tx: any = db): Promise<WorkState | undefined> {
  const [[user], [order]] = await Promise.all([
    tx.select().from(users).where(eq(users.id, actorId)),
    tx.select().from(orders).where(eq(orders.id, orderId)),
  ]);
  if (!user || !order) return undefined;
  const [fulfillment] = await tx.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, orderId));
  const profile = await driverProfileFor(actorId, order.marketId, tx);
  const places = await coarsePlaces(tx, [{ order }]);
  const assignedTo = places.assigned.get(order.id);
  const blocked = driverWorkBlock(profile, user, { id: order.marketId });
  const commissionAccount =
    !blocked && !assignedTo
      ? await getCourierCommissionAccount({ courierId: actorId }, tx)
      : undefined;
  const commissionHold = Boolean(commissionAccount?.hold);
  const open =
    fulfillment?.method === "COURIER" && fulfillment.status === "REQUESTED" && EXECUTABLE_ORDER.includes(order.status) && places.destination.has(order.id);
  const code: WorkState["code"] =
    order.buyerId === actorId || order.sellerId === actorId
      ? "OWN_ORDER"
      : !profile
        ? "NO_PROFILE"
        : blocked
          ? "DRIVER_BLOCKED"
          : assignedTo
            ? assignedTo === actorId
              ? "ASSIGNED_TO_YOU"
              : "TAKEN"
            : !open
              ? "NOT_OPEN"
              : commissionHold
                ? "COMMISSION_HOLD"
                : !sameCourierCity(places.pickup.get(String(order.data.listingId ?? ""))?.city, profile.serviceCity)
                ? "OUT_OF_AREA"
                : "OPEN";
  return {
    actorStatus: user.status,
    actorMarketId: user.activeMarketId,
    orderMarketId: order.marketId,
    code,
    ...(code === "DRIVER_BLOCKED" ? { reason: blocked } : {}),
    ...(code === "COMMISSION_HOLD"
      ? { reason: "لديك 10 مهام توصيل مكتملة وعمولة جاسم مستحقة؛ سوِّ الرصيد قبل قبول مهمة جديدة." }
      : {}),
    version: `${fulfillment?.version ?? 0}|${fulfillment?.status ?? ""}|${profile?.version ?? 0}|${assignedTo ?? ""}|${commissionHold ? "HOLD" : "CLEAR"}`,
  };
}

export const WORK_STATE_MESSAGES: Record<Exclude<WorkState["code"], "OPEN" | "DRIVER_BLOCKED">, string> = {
  OWN_ORDER: "لا يمكنك توصيل طلب أنت طرف فيه",
  NO_PROFILE: "لست مسجلًا كسائق في هذا السوق",
  COMMISSION_HOLD: "لديك 10 مهام توصيل مكتملة وعمولة جاسم مستحقة؛ سوِّ الرصيد قبل قبول مهمة جديدة.",
  TAKEN: "تم أخذ مهمة التوصيل بالفعل",
  ASSIGNED_TO_YOU: "هذه المهمة مسندة إليك بالفعل",
  NOT_OPEN: "مهمة التوصيل هذه لم تعد متاحة",
  OUT_OF_AREA: "هذه المهمة خارج منطقة عملك",
};

// ─── Assignment ──────────────────────────────────────────────────────────────

const isUniqueViolation = (error: unknown) => {
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return value?.code === "23505" || value?.cause?.code === "23505";
};

/**
 * Atomic accept: the order and its fulfilment are locked, every eligibility fact is
 * re-read, then the one ACCEPTED assignment is inserted (a partial unique index backs
 * the lock) and Block D moves the fulfilment REQUESTED → ACCEPTED for the driver.
 */
export async function assignDelivery(input: { actorId: string; orderId: string; market: Market }): Promise<{ assignmentId: string; orderId: string }> {
  try {
    return await db.transaction(async (tx) => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).for("update");
      await tx.select({ id: orderFulfillments.orderId }).from(orderFulfillments).where(eq(orderFulfillments.orderId, input.orderId)).for("update");
      await tx
        .select({ id: driverProfiles.id })
        .from(driverProfiles)
        .where(and(eq(driverProfiles.userId, input.actorId), eq(driverProfiles.marketId, input.market.id)))
        .for("share");
      const state = await deliveryWorkState(input.actorId, input.orderId, tx);
      if (!state) throw fail(404, "الطلب غير موجود", "ORDER_NOT_FOUND");
      if (state.actorStatus !== ACCOUNT_STATUS.active) throw fail(403, "حسابك غير نشط حاليًا؛ لا يمكن قبول مهام توصيل.", "ACCOUNT_INACTIVE");
      if (state.orderMarketId !== input.market.id || state.actorMarketId !== input.market.id)
        throw fail(409, "هذا الطلب ليس في سوقك الحالي", "MARKET_MISMATCH");
      if (state.code !== "OPEN") throw fail(409, state.reason ?? WORK_STATE_MESSAGES[state.code as keyof typeof WORK_STATE_MESSAGES], state.code);
      const profile = (await driverProfileFor(input.actorId, input.market.id, tx))!;
      const assignmentId = randomUUID();
      await tx.insert(deliveryAssignments).values({
        id: assignmentId,
        orderId: input.orderId,
        marketId: input.market.id,
        driverProfileId: profile.id,
        driverId: input.actorId,
        status: "ACCEPTED",
      });
      await transitionDelivery({ actorId: input.actorId, orderId: input.orderId, to: "ACCEPTED", market: input.market }, tx);
      await audit(tx, input.market.id, input.actorId, "DELIVERY_ASSIGNED", { orderId: input.orderId, assignmentId, driverProfileId: profile.id });
      return { assignmentId, orderId: input.orderId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw fail(409, WORK_STATE_MESSAGES.TAKEN, "TAKEN");
    throw error;
  }
}

/**
 * Market administrators may revoke a courier before pickup, but cannot transfer a
 * parcel whose fulfillment has reached OUT_FOR_DELIVERY. The buyer must explicitly
 * choose a delivery method again; no replacement courier or fee is selected here.
 */
export async function revokeCourierAssignment(input: {
  adminId: string;
  orderId: string;
  market: Market;
  reason: string;
  idempotencyKey: string;
}) {
  return db.transaction(async (tx) => {
    const [admin] = await tx.select().from(users).where(eq(users.id, input.adminId)).for("share");
    if (!admin || admin.role !== "ADMIN" || admin.status !== ACCOUNT_STATUS.active)
      throw fail(403, "هذا الإجراء لإدارة السوق فقط", "ADMIN_ONLY");
    if (admin.activeMarketId !== input.market.id)
      throw fail(409, "هذا الطلب ليس في سوقك النشط.", "MARKET_MISMATCH");

    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update");
    if (!order || order.marketId !== input.market.id)
      throw fail(404, "إسناد المندوب غير موجود.", "ASSIGNMENT_NOT_FOUND");
    const [prior] = await tx
      .select({ data: marketAudit.data })
      .from(marketAudit)
      .where(and(
        eq(marketAudit.marketId, order.marketId),
        eq(marketAudit.actorId, input.adminId),
        eq(marketAudit.action, "COURIER_ASSIGNMENT_REVOKED"),
        sql`${marketAudit.data}->>'idempotencyKey' = ${input.idempotencyKey}`,
      ))
      .limit(1);
    if (prior) {
      if (prior.data.orderId !== order.id || prior.data.reason !== input.reason)
        throw fail(409, "مفتاح التكرار استُخدم لطلب مختلف.", "IDEMPOTENCY_KEY_CONFLICT");
      return { orderId: order.id, assignmentId: String(prior.data.assignmentId), fulfillmentStatus: "FAILED" as const, idempotent: true };
    }
    const [fulfillment] = order
      ? await tx.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, order.id)).for("update")
      : [];
    const [assignment] = order
      ? await tx
          .select()
          .from(deliveryAssignments)
          .where(and(eq(deliveryAssignments.orderId, order.id), eq(deliveryAssignments.status, "ACCEPTED")))
          .for("update")
      : [];
    if (!fulfillment || !assignment || assignment.marketId !== order.marketId)
      throw fail(404, "إسناد المندوب غير موجود.", "ASSIGNMENT_NOT_FOUND");
    if (fulfillment.method !== "COURIER" || fulfillment.status !== "ACCEPTED")
      throw fail(409, "لا يمكن إلغاء الإسناد بعد بدء التوصيل؛ إذا كانت الشحنة في حيازة المندوب، يلزم حل يدوي آمن قبل أي نقل.", "CUSTODY_RESOLUTION_REQUIRED");
    const [pickup] = await tx.select({ id: deliveryProgressEvents.id }).from(deliveryProgressEvents)
      .where(and(eq(deliveryProgressEvents.orderId, order.id), eq(deliveryProgressEvents.type, "PICKED_UP")));
    if (pickup)
      throw fail(409, "استلم المندوب الطلب بالفعل؛ يلزم حل يدوي آمن قبل أي نقل.", "CUSTODY_RESOLUTION_REQUIRED");

    const now = new Date();
    await endLocationSharingForOrder(tx, order.id, "ASSIGNMENT_ENDED", now);
    await tx.update(deliveryAssignments)
      .set({ status: "RELEASED", releasedAt: now, updatedAt: now })
      .where(eq(deliveryAssignments.id, assignment.id));
    await tx.update(orderFulfillments)
      .set({ status: "FAILED", failureReason: "OTHER", statusChangedBy: input.adminId, version: fulfillment.version + 1, updatedAt: now })
      .where(eq(orderFulfillments.orderId, order.id));
    await tx.delete(transactionLocations)
      .where(and(eq(transactionLocations.orderId, order.id), eq(transactionLocations.purpose, "DELIVERY_DESTINATION")));
    await audit(tx, order.marketId, input.adminId, "COURIER_ASSIGNMENT_REVOKED", {
      orderId: order.id,
      assignmentId: assignment.id,
      driverId: assignment.driverId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      fromStatus: fulfillment.status,
    });
    await tx.insert(messages).values({
      id: randomUUID(),
      conversationId: order.id,
      body: "ألغت إدارة جاسم إسناد المندوب قبل استلام الطلب. لم يُلغَ الطلب؛ على المشتري إعادة ترتيب التوصيل.",
    });
    return { orderId: order.id, assignmentId: assignment.id, fulfillmentStatus: "FAILED" as const, idempotent: false };
  });
}

export type ActiveAssignment = { orderId: string; reference: string; title: string; status: string; dropoff: { city: string; area: string } | null };

/** The driver's current deliveries, oldest first; coarse places only. */
export async function activeDriverAssignments(actorId: string, marketId: string): Promise<ActiveAssignment[]> {
  const assigned = await db
    .select({ orderId: deliveryAssignments.orderId })
    .from(deliveryAssignments)
    .where(and(eq(deliveryAssignments.driverId, actorId), eq(deliveryAssignments.marketId, marketId), eq(deliveryAssignments.status, "ACCEPTED")))
    .orderBy(asc(deliveryAssignments.createdAt), asc(deliveryAssignments.id));
  if (!assigned.length) return [];
  const rows = (await workRows(db, marketId, assigned.map((row) => row.orderId))).filter(
    (row) => !["DELIVERED", "CANCELLED", "FAILED"].includes(row.fulfillment.status),
  );
  const places = await coarsePlaces(db, rows);
  const byId = new Map(rows.map((row) => [row.order.id, row]));
  return assigned
    .map(({ orderId }) => byId.get(orderId))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map(({ order, fulfillment }) => ({
      orderId: order.id,
      reference: orderReference(order.id),
      title: String(order.data.listingTitle ?? ""),
      status: fulfillment.status,
      dropoff: places.destination.get(order.id) ?? null,
    }));
}

/** «استلمت الطلب» / «أنا في الطريق»: the Block D ACCEPTED → OUT_FOR_DELIVERY transition. */
export async function driverOutForDelivery(input: { actorId: string; orderId: string; market: Market }) {
  return db.transaction(async (tx) => {
    const { order, role } = await participantOrder(tx, input.orderId, input.actorId, true);
    if (role !== "DRIVER") throw fail(404, "الطلب غير موجود", "ORDER_NOT_FOUND");
    if (order.marketId !== input.market.id) throw fail(409, "هذا الطلب ليس في سوقك الحالي.", "MARKET_MISMATCH");
    const [pickup] = await tx.select().from(deliveryProgressEvents).where(and(
      eq(deliveryProgressEvents.orderId, input.orderId),
      eq(deliveryProgressEvents.type, "PICKED_UP"),
    ));
    const [assignment] = await tx.select({ id: deliveryAssignments.id }).from(deliveryAssignments).where(and(
      eq(deliveryAssignments.orderId, input.orderId), eq(deliveryAssignments.driverId, input.actorId),
      eq(deliveryAssignments.status, "ACCEPTED"), eq(deliveryAssignments.marketId, input.market.id),
    )).limit(1);
    if (!assignment || !pickup || pickup.actorId !== input.actorId || pickup.assignmentId !== assignment.id)
      throw fail(409, "أكّد استلام الطلب من البائع أولًا.", "PICKUP_NOT_CONFIRMED");
    const result = await transitionDelivery({ actorId: input.actorId, orderId: input.orderId, to: "OUT_FOR_DELIVERY", market: input.market }, tx);
    await tx.insert(deliveryProgressEvents).values({
      id: randomUUID(), orderId: order.id, marketId: order.marketId, assignmentId: assignment.id,
      actorId: input.actorId, type: "OUT_FOR_DELIVERY",
    }).onConflictDoNothing();
    return result;
  });
}

/** Append one authenticated courier progress event; retries by the same active assignee are harmless. */
export async function recordCourierProgress(input: {
  actorId: string; orderId: string; market: Market; type: "PICKED_UP" | "ARRIVED";
}) {
  return db.transaction(async (tx) => {
    const { order, role } = await participantOrder(tx, input.orderId, input.actorId, true);
    if (role !== "DRIVER") throw fail(404, "الطلب غير موجود", "ORDER_NOT_FOUND");
    if (order.marketId !== input.market.id) throw fail(409, "هذا الطلب ليس في سوقك الحالي.", "MARKET_MISMATCH");
    const [fulfillment] = await tx.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, order.id)).for("update");
    const [assignment] = await tx.select().from(deliveryAssignments).where(and(
      eq(deliveryAssignments.orderId, order.id), eq(deliveryAssignments.driverId, input.actorId),
      eq(deliveryAssignments.status, "ACCEPTED"), eq(deliveryAssignments.marketId, input.market.id),
    )).limit(1);
    if (!assignment || fulfillment?.method !== "COURIER")
      throw fail(403, "لم تعد المهمة مسندة إليك.", "ASSIGNMENT_RELEASED");
    const [prior] = await tx.select().from(deliveryProgressEvents).where(and(
      eq(deliveryProgressEvents.orderId, order.id), eq(deliveryProgressEvents.type, input.type),
    )).limit(1);
    if (prior) {
      if (prior.actorId === input.actorId && prior.assignmentId === assignment.id)
        return { changed: false, event: prior };
      throw fail(409, "سُجّل هذا التقدم من قبل لمهمة أخرى.", "PROGRESS_ALREADY_RECORDED");
    }
    const validStage = input.type === "PICKED_UP"
      ? fulfillment.status === "ACCEPTED"
      : fulfillment.status === "OUT_FOR_DELIVERY";
    if (!validStage) throw fail(409, "حالة المهمة لا تسمح بتسجيل هذا التقدم.", "INVALID_PROGRESS_STAGE");
    const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId));
    if (!actor || !([ACCOUNT_STATUS.active, ACCOUNT_STATUS.restricted] as string[]).includes(actor.status))
      throw fail(403, "حسابك لا يسمح بتعديل التوصيل.", "ACCOUNT_INACTIVE");
    const [event] = await tx.insert(deliveryProgressEvents).values({
      id: randomUUID(), orderId: order.id, marketId: order.marketId, assignmentId: assignment.id,
      actorId: input.actorId, type: input.type,
    }).onConflictDoNothing().returning();
    if (!event) throw fail(409, "سُجّل هذا التقدم بالفعل.", "PROGRESS_ALREADY_RECORDED");
    return { changed: true, event };
  });
}

/** «تم التسليم»: the shared order handoff; the buyer still confirms receipt. */
export async function driverHandoff(input: { actorId: string; orderId: string; market: Market }) {
  return db.transaction(async (tx) => {
    const { order, role } = await participantOrder(tx, input.orderId, input.actorId, true);
    if (role !== "DRIVER") throw fail(404, "الطلب غير موجود", "ORDER_NOT_FOUND");
    if (order.marketId !== input.market.id) throw fail(409, "هذا الطلب ليس في سوقك الحالي", "MARKET_MISMATCH");
    const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.actorId));
    // Existing policy: a restricted account may still finish work it already holds.
    if (!actor || !([ACCOUNT_STATUS.active, ACCOUNT_STATUS.restricted] as string[]).includes(actor.status))
      throw fail(403, "حسابك لا يسمح بتعديل التوصيل.", "ACCOUNT_INACTIVE");
    const now = new Date();
    const handoff = await orderHandoff(tx, order, input.actorId, { proofType: "DRIVER_HANDOFF", proofToken: orderReference(order.id) }, now);
    await tx.update(orders).set({ status: handoff.status, data: handoff.data, updatedAt: now }).where(eq(orders.id, order.id));
    const [assignment] = await tx.select({ id: deliveryAssignments.id }).from(deliveryAssignments).where(and(
      eq(deliveryAssignments.orderId, order.id), eq(deliveryAssignments.driverId, input.actorId), eq(deliveryAssignments.status, "ACCEPTED"),
    ));
    if (assignment) await tx.insert(deliveryProgressEvents).values({
      id: randomUUID(), orderId: order.id, marketId: order.marketId, assignmentId: assignment.id,
      actorId: input.actorId, type: "HANDED_OFF",
    }).onConflictDoNothing();
    await tx.insert(messages).values({ id: randomUUID(), conversationId: order.id, body: "سجّل مندوب التوصيل تسليم الطلب؛ بانتظار تأكيد المشتري للاستلام." });
    await audit(tx, order.marketId, input.actorId, "DELIVERY_HANDED_OFF", { orderId: order.id });
    return { orderId: order.id, status: handoff.status };
  });
}
