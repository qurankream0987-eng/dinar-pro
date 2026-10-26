/**
 * Block D delivery and transaction-location authority.
 *
 * The order stays the only commerce authority (parties, items, price, commission,
 * payment, completion, disputes). This module adds fulfilment execution metadata
 * to an existing order: the buyer-selected method, a small server-validated state
 * machine, and one purpose-scoped location snapshot per order. There is no live
 * tracking, location history or provider integration here; a changed location
 * replaces the snapshot, and precise fields are cleared once the order ends.
 *
 * Every function re-reads the order inside the caller's transaction, authorizes the
 * authenticated actor against it, and never trusts a client-supplied role or owner.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  deliveryAssignments,
  messages,
  orderFulfillments,
  orders,
  transactionLocations,
  users,
} from "@workspace/db";
import { ACCOUNT_STATUS } from "./account-status";
import { requireCourierFareAgreement } from "./courier-economics";
import { hasEligibleCourierSupply } from "./courier-supply";
import { deviceLocationSharingAllowed } from "./privacy-rights";
import { marketAllowsFulfilment } from "./market-capability-registry";
import type { marketFor } from "./markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
type OrderRow = typeof orders.$inferSelect;
type FulfillmentRow = typeof orderFulfillments.$inferSelect;
type LocationRow = typeof transactionLocations.$inferSelect;

export const DELIVERY_METHODS = ["PICKUP", "SELLER_DELIVERY", "COURIER", "EXTERNAL_PROVIDER"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];
export const DELIVERY_STATUSES = [
  "REQUESTED",
  "ACCEPTED",
  "READY_FOR_PICKUP",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "FAILED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const LOCATION_PURPOSES = ["DELIVERY_DESTINATION", "PICKUP_POINT", "SERVICE_APPOINTMENT"] as const;
export type LocationPurpose = (typeof LOCATION_PURPOSES)[number];
export const DELIVERY_FAILURE_REASONS = ["BUYER_UNAVAILABLE", "ADDRESS_UNREACHABLE", "SELLER_UNABLE", "OTHER"] as const;
export type DeliveryFailureReason = (typeof DELIVERY_FAILURE_REASONS)[number];
/** Targets reachable through the delivery authority; handoff stays with the order. */
export const DELIVERY_TRANSITION_TARGETS = ["ACCEPTED", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP", "CANCELLED", "FAILED"] as const;
export type DeliveryTransitionTarget = (typeof DELIVERY_TRANSITION_TARGETS)[number];

export const METHOD_LABELS: Record<DeliveryMethod, string> = {
  PICKUP: "استلام شخصي",
  SELLER_DELIVERY: "توصيل من البائع",
  COURIER: "مندوب توصيل",
  EXTERNAL_PROVIDER: "شركة توصيل",
};
export const STATUS_LABELS: Record<DeliveryStatus, string> = {
  REQUESTED: "بانتظار البائع",
  ACCEPTED: "قبل البائع التوصيل",
  READY_FOR_PICKUP: "جاهز للاستلام",
  PICKED_UP: "تم الاستلام من البائع",
  OUT_FOR_DELIVERY: "خرج للتوصيل",
  DELIVERED: "سلّمه البائع",
  CANCELLED: "أُلغي ترتيب التسليم",
  FAILED: "تعذر التسليم",
};
/** A DINAR driver, not the seller, carries COURIER orders. */
const COURIER_STATUS_LABELS: Partial<Record<DeliveryStatus, string>> = {
  REQUESTED: "بانتظار مندوب توصيل",
  ACCEPTED: "قبل مندوب التوصيل المهمة",
  DELIVERED: "سلّمه مندوب التوصيل",
};
export const statusLabel = (method: DeliveryMethod, status: DeliveryStatus) =>
  (method === "COURIER" ? COURIER_STATUS_LABELS[status] : undefined) ?? STATUS_LABELS[status];
export const PURPOSE_LABELS: Record<LocationPurpose, string> = {
  DELIVERY_DESTINATION: "موقع التسليم",
  PICKUP_POINT: "نقطة الاستلام",
  SERVICE_APPOINTMENT: "موقع تقديم الخدمة",
};
export const FAILURE_LABELS: Record<DeliveryFailureReason, string> = {
  BUYER_UNAVAILABLE: "المشتري غير متاح",
  ADDRESS_UNREACHABLE: "تعذر الوصول إلى العنوان",
  SELLER_UNABLE: "تعذر على البائع التوصيل",
  OTHER: "سبب آخر",
};

/** Order states in which the buyer may still arrange or change delivery. */
const ARRANGEABLE_ORDER = ["CREATED", "ACCEPTED", "IN_PROGRESS"];
/** Order states in which the seller executes fulfilment (after accepting the order). */
export const EXECUTABLE_ORDER = ["ACCEPTED", "IN_PROGRESS"];
const ACTIVE_FULFILMENT: DeliveryStatus[] = ["REQUESTED", "ACCEPTED", "READY_FOR_PICKUP", "OUT_FOR_DELIVERY"];
/** The buyer's destination is locked once the seller is on the way. */
const DESTINATION_EDITABLE: DeliveryStatus[] = ["REQUESTED", "ACCEPTED"];
const PICKUP_POINT_EDITABLE: DeliveryStatus[] = ["REQUESTED", "READY_FOR_PICKUP"];

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// ─── Location input ──────────────────────────────────────────────────────────

const cleanText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((value) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim())
    .pipe(z.string().max(max));

/** What a buyer or seller explicitly submits: one device reading or a typed address. */
export const LocationInput = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("DEVICE"),
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
      accuracyMeters: z.number().finite().min(0).max(1_000_000).optional(),
      note: cleanText(300).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("MANUAL"),
      city: cleanText(100).optional(),
      area: cleanText(100).optional(),
      addressText: cleanText(300).pipe(z.string().min(3)),
      note: cleanText(300).optional(),
    })
    .strict(),
]);
export type LocationInput = z.infer<typeof LocationInput>;

/** Validates and minimizes an explicit location submission (no altitude, heading or speed). */
export function normalizeLocationInput(raw: unknown): LocationInput {
  const parsed = LocationInput.safeParse(raw);
  if (!parsed.success)
    throw fail(400, "بيانات الموقع غير صالحة. شارك موقعك من جديد أو اكتب العنوان يدويًا.", "LOCATION_INVALID");
  const value = parsed.data;
  if (value.source === "DEVICE")
    return {
      source: "DEVICE",
      // ~0.1 m; more digits add no delivery value.
      latitude: Math.round(value.latitude * 1e6) / 1e6,
      longitude: Math.round(value.longitude * 1e6) / 1e6,
      ...(value.accuracyMeters !== undefined
        ? { accuracyMeters: Math.min(100_000, Math.round(value.accuracyMeters)) }
        : {}),
      ...(value.note ? { note: value.note } : {}),
    };
  return {
    source: "MANUAL",
    ...(value.city ? { city: value.city } : {}),
    ...(value.area ? { area: value.area } : {}),
    addressText: value.addressText,
    ...(value.note ? { note: value.note } : {}),
  };
}

/** Readings worse than this are shown as approximate and offered a retry or manual address. */
export const POOR_ACCURACY_METERS = 200;

export function accuracyNote(accuracyMeters: number | null | undefined): string | null {
  if (accuracyMeters === null || accuracyMeters === undefined) return null;
  if (accuracyMeters > POOR_ACCURACY_METERS)
    return `دقة الموقع منخفضة (حوالي ${accuracyMeters} م). أعد المحاولة في مكان مفتوح أو أضف وصفًا أو اكتب العنوان يدويًا.`;
  return `الموقع تقريبي بدقة حوالي ${accuracyMeters} م.`;
}

// ─── Capability ──────────────────────────────────────────────────────────────

export type DeliveryOption = {
  method: DeliveryMethod;
  label: string;
  available: boolean;
  reason?: string;
};

/**
 * Methods offered for an order come from the fulfilment type snapshotted at order
 * time, so later listing or seller changes never rewrite an existing order.
 * Courier availability is supplied from the read-only F4 eligibility query;
 * external providers remain disabled until a verified integration exists.
 */
export function deliveryOptions(
  order: OrderRow,
  market?: Pick<Market, "fulfilmentMethods">,
  courierAvailable = false,
): DeliveryOption[] {
  const snapshot = String(order.data.fulfilmentType ?? "");
  const marketAllows = (method: string) => !market || marketAllowsFulfilment(market, method);
  const courierReason = snapshot !== "DELIVERY"
    ? "التوصيل بالمندوب غير متاح لهذا النوع من الطلبات."
    : !market || !marketAllows("COURIER")
      ? "التوصيل بالمندوب غير مفعّل في هذا السوق."
      : "حاليًا ما فيه مندوب مؤهل متاح لطلبك.";
  // DINAR drivers (Block F4) carry only deliverable orders, and only where the market
  // explicitly enables COURIER; without a market there is no such policy to rely on.
  const courier = snapshot === "DELIVERY" && Boolean(market && marketAllows("COURIER")) && courierAvailable;
  return [
    snapshot === "PICKUP" && marketAllows("PICKUP")
      ? { method: "PICKUP", label: METHOD_LABELS.PICKUP, available: true }
      : { method: "PICKUP", label: METHOD_LABELS.PICKUP, available: false, reason: "البائع لا يعرض الاستلام الشخصي لهذا الطلب." },
    snapshot === "DELIVERY" && marketAllows("DELIVERY")
      ? { method: "SELLER_DELIVERY", label: METHOD_LABELS.SELLER_DELIVERY, available: true }
      : { method: "SELLER_DELIVERY", label: METHOD_LABELS.SELLER_DELIVERY, available: false, reason: "البائع لا يوصل هذا الطلب." },
    courier
      ? { method: "COURIER", label: METHOD_LABELS.COURIER, available: true }
      : { method: "COURIER", label: METHOD_LABELS.COURIER, available: false, reason: courierReason },
    { method: "EXTERNAL_PROVIDER", label: METHOD_LABELS.EXTERNAL_PROVIDER, available: false, reason: "شركات التوصيل الخارجية غير مفعّلة." },
  ];
}

async function courierSupplyForOrder(order: OrderRow, market: Pick<Market, "fulfilmentMethods"> | undefined, tx: any) {
  if (!market || !deliveryOptions(order, market, true).some((option) => option.method === "COURIER" && option.available))
    return false;
  return hasEligibleCourierSupply(order, tx);
}

export function deliveryCapability(order: OrderRow): "PICKUP_ONLY" | "SELLER_DELIVERY" | "SERVICE" | "NONE" {
  const snapshot = String(order.data.fulfilmentType ?? "");
  if (snapshot === "PICKUP") return "PICKUP_ONLY";
  if (snapshot === "DELIVERY") return "SELLER_DELIVERY";
  if (snapshot === "SERVICE") return "SERVICE";
  return "NONE";
}

// ─── Authorization ───────────────────────────────────────────────────────────

/** DRIVER is the driver holding the order's ACCEPTED assignment (Block F4), nobody else. */
export type DeliveryRole = "BUYER" | "SELLER" | "DRIVER";

/** Non-participants get the same 404 as a missing order: no existence leak. */
export async function participantOrder(
  tx: any,
  orderId: string,
  actorId: string,
  lock = false,
): Promise<{ order: OrderRow; role: DeliveryRole }> {
  let query = tx.select().from(orders).where(eq(orders.id, orderId));
  if (lock) query = query.for("update");
  const [order] = (await query) as OrderRow[];
  if (order && (order.buyerId === actorId || order.sellerId === actorId))
    return { order, role: order.buyerId === actorId ? "BUYER" : "SELLER" };
  if (order) {
    const [assignment] = await tx
      .select({ id: deliveryAssignments.id })
      .from(deliveryAssignments)
      .where(and(eq(deliveryAssignments.orderId, order.id), eq(deliveryAssignments.driverId, actorId), eq(deliveryAssignments.status, "ACCEPTED")));
    if (assignment) return { order, role: "DRIVER" };
  }
  throw fail(404, "الطلب غير موجود", "ORDER_NOT_FOUND");
}

/**
 * Mutations follow the existing account policy: ACTIVE, or RESTRICTED finishing an
 * existing order. The row is read in the transaction, never from the session.
 * The order must belong to the actor's active market.
 */
async function assertMayMutate(tx: any, actorId: string, order: OrderRow, market: Market) {
  if (order.marketId !== market.id)
    throw fail(409, "هذا الطلب في سوق آخر. غيّر السوق النشط قبل متابعة التوصيل.", "MARKET_MISMATCH");
  const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, actorId)).for("share");
  if (!actor || ![ACCOUNT_STATUS.active, ACCOUNT_STATUS.restricted].includes(actor.status))
    throw fail(403, "حسابك لا يسمح بتعديل التوصيل.", "ACCOUNT_INACTIVE");
}

async function fulfillmentFor(tx: any, orderId: string, lock = false): Promise<FulfillmentRow | undefined> {
  let query = tx.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, orderId));
  if (lock) query = query.for("update");
  const [row] = await query;
  return row;
}

async function locationsFor(tx: any, orderId: string): Promise<LocationRow[]> {
  return tx.select().from(transactionLocations).where(eq(transactionLocations.orderId, orderId));
}

/**
 * Runs a write whose parameters include precise location. Driver and ORM errors embed
 * query parameters and failing rows; they are replaced so no coordinate or address
 * can reach an error log. Authority (4xx) errors pass through unchanged.
 */
async function locationWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500) throw error;
    throw Object.assign(new Error("Transaction location write failed"), { status: 500, code: "LOCATION_WRITE_FAILED" });
  }
}

/** Order-conversation audit line; never carries coordinates or address text. */
async function auditMessage(tx: any, orderId: string, body: string) {
  await tx.insert(messages).values({ id: randomUUID(), conversationId: orderId, body });
}

// ─── Serializer ──────────────────────────────────────────────────────────────

export type LocationView = {
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
  sharedByRole: DeliveryRole;
  updatedAt: string;
};

/** Explicit allowlist for the order's own buyer and seller; never spread a row. */
function locationView(row: LocationRow, order: OrderRow): LocationView {
  return {
    id: row.id,
    purpose: row.purpose as LocationPurpose,
    purposeLabel: PURPOSE_LABELS[row.purpose as LocationPurpose],
    source: row.source as "DEVICE" | "MANUAL",
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyMeters: row.accuracyMeters,
    accuracyNote: accuracyNote(row.accuracyMeters),
    city: row.city,
    area: row.area,
    addressText: row.addressText,
    note: row.note,
    redacted: row.redactedAt !== null,
    sharedByRole: row.sharedBy === order.sellerId ? "SELLER" : "BUYER",
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type DeliveryView = {
  orderId: string;
  orderRef: string;
  orderStatus: string;
  listingTitle: string;
  role: DeliveryRole;
  capability: ReturnType<typeof deliveryCapability>;
  options: DeliveryOption[];
  fulfillment: null | {
    method: DeliveryMethod;
    methodLabel: string;
    status: DeliveryStatus;
    statusLabel: string;
    failureReason: DeliveryFailureReason | null;
    failureLabel: string | null;
    version: number;
    updatedAt: string;
  };
  destination: LocationView | null;
  pickupPoint: LocationView | null;
  serviceLocation: LocationView | null;
  fee: { implemented: false; note: string };
  canSelectMethod: boolean;
  canChangeDestination: boolean;
  canSetPickupPoint: boolean;
  nextActions: DeliveryTransitionTarget[];
  awaitingHandoff: boolean;
};

export const DELIVERY_FEE_NOTE =
  "الاستلام الشخصي وتوصيل البائع بلا عمولة توصيل من DINAR.";

function deliveryFeeNote(method?: DeliveryMethod): string {
  if (method === "COURIER")
    return "يتفق المشتري ومندوب DINAR على الأجرة ويؤكدانها. عمولة DINAR هي 10% من المندوب بعد التسليم الناجح فقط؛ التسوية الحالية محاكاة ولا تنقل أموالًا.";
  if (method === "EXTERNAL_PROVIDER")
    return "توصيل الشركات الخارجية غير مفعّل؛ أي إيراد لـ DINAR يتطلب اتفاقًا موثقًا مع المزود.";
  return DELIVERY_FEE_NOTE;
}

export const orderReference = (orderId: string) => orderId.replace(/-/g, "").slice(0, 8).toUpperCase();

export function buildDeliveryView(
  order: OrderRow,
  role: DeliveryRole,
  fulfillment: FulfillmentRow | undefined,
  locations: LocationRow[],
  market?: Pick<Market, "fulfilmentMethods">,
  courierAvailable = false,
): DeliveryView {
  const byPurpose = new Map(locations.map((row) => [row.purpose, row]));
  const view = (purpose: LocationPurpose) => {
    const row = byPurpose.get(purpose);
    return row ? locationView(row, order) : null;
  };
  const status = fulfillment?.status as DeliveryStatus | undefined;
  const method = fulfillment?.method as DeliveryMethod | undefined;
  const arrangeable = ARRANGEABLE_ORDER.includes(order.status);
  const executable = EXECUTABLE_ORDER.includes(order.status);
  const nextActions = fulfillment
    ? DELIVERY_TRANSITION_TARGETS.filter((to) => transitionRule(to, method!, status!, role, order.status, byPurpose.has("DELIVERY_DESTINATION")) === null)
    : [];
  return {
    orderId: order.id,
    orderRef: orderReference(order.id),
    orderStatus: order.status,
    listingTitle: String(order.data.listingTitle ?? ""),
    role,
    capability: deliveryCapability(order),
    options: deliveryOptions(order, market, courierAvailable),
    fulfillment: fulfillment
      ? {
          method: method!,
          methodLabel: METHOD_LABELS[method!],
          status: status!,
          statusLabel: statusLabel(method!, status!),
          failureReason: (fulfillment.failureReason as DeliveryFailureReason | null) ?? null,
          failureLabel: fulfillment.failureReason ? FAILURE_LABELS[fulfillment.failureReason as DeliveryFailureReason] : null,
          version: fulfillment.version,
          updatedAt: fulfillment.updatedAt.toISOString(),
        }
      : null,
    destination: view("DELIVERY_DESTINATION"),
    pickupPoint: view("PICKUP_POINT"),
    serviceLocation: view("SERVICE_APPOINTMENT"),
    fee: { implemented: false, note: deliveryFeeNote(method) },
    canSelectMethod:
      role === "BUYER" && arrangeable && (!fulfillment || ["REQUESTED", "CANCELLED", "FAILED"].includes(status!)),
    canChangeDestination:
      role === "BUYER" && arrangeable && (method === "SELLER_DELIVERY" || method === "COURIER") && DESTINATION_EDITABLE.includes(status!),
    canSetPickupPoint:
      role === "SELLER" && arrangeable && method === "PICKUP" && PICKUP_POINT_EDITABLE.includes(status!),
    nextActions,
    awaitingHandoff:
      executable &&
      (((method === "SELLER_DELIVERY" || method === "COURIER") && status === "OUT_FOR_DELIVERY") || (method === "PICKUP" && status === "READY_FOR_PICKUP")),
  };
}

/** Participant-only read. The order's market is not required to match for reads. */
export async function getDeliveryView(input: { actorId: string; orderId: string; market?: Market }, tx: any = db) {
  const { order, role } = await participantOrder(tx, input.orderId, input.actorId);
  const [fulfillment, locations] = await Promise.all([fulfillmentFor(tx, order.id), locationsFor(tx, order.id)]);
  const courierAvailable = await courierSupplyForOrder(order, input.market, tx);
  return buildDeliveryView(order, role, fulfillment, locations, input.market, courierAvailable);
}

// ─── Method selection ────────────────────────────────────────────────────────

export async function selectDeliveryMethod(
  input: { actorId: string; orderId: string; method: DeliveryMethod; market: Market },
  tx: any,
): Promise<{ changed: boolean; view: DeliveryView }> {
  const { order, role } = await participantOrder(tx, input.orderId, input.actorId, true);
  if (role !== "BUYER") throw fail(403, "اختيار طريقة الاستلام للمشتري فقط.", "ROLE_FORBIDDEN");
  await assertMayMutate(tx, input.actorId, order, input.market);
  if (!ARRANGEABLE_ORDER.includes(order.status))
    throw fail(409, "لا يمكن تغيير طريقة الاستلام في حالة الطلب الحالية.", "ORDER_LOCKED");
  const courierAvailable = input.method === "COURIER" && await courierSupplyForOrder(order, input.market, tx);
  const options = deliveryOptions(order, input.market, courierAvailable);
  const option = options.find((candidate) => candidate.method === input.method);
  if (!option?.available) {
    const offered = options.filter((candidate) => candidate.available).map((candidate) => candidate.label);
    throw fail(
      409,
      `${option?.reason ?? "طريقة التسليم غير متاحة."} ${offered.length ? `المتاح لهذا الطلب: ${offered.join("، ")}.` : "لا توجد طريقة تسليم متاحة لهذا الطلب."}`,
      "METHOD_UNAVAILABLE",
    );
  }
  const now = new Date();
  const current = await fulfillmentFor(tx, order.id, true);
  if (current && current.method === input.method && ACTIVE_FULFILMENT.includes(current.status as DeliveryStatus)) {
    return { changed: false, view: buildDeliveryView(order, role, current, await locationsFor(tx, order.id), input.market, courierAvailable) };
  }
  if (current && !["REQUESTED", "CANCELLED", "FAILED"].includes(current.status))
    throw fail(409, "بدأ البائع تنفيذ التسليم؛ لا يمكن تغيير الطريقة الآن. تواصل معه داخل الطلب.", "FULFILMENT_LOCKED");
  if (current) {
    await tx
      .update(orderFulfillments)
      .set({ method: input.method, status: "REQUESTED", failureReason: null, selectedBy: input.actorId, statusChangedBy: input.actorId, version: current.version + 1, updatedAt: now })
      .where(eq(orderFulfillments.orderId, order.id));
    // A different method needs a different place; never carry the old one over.
    await tx
      .delete(transactionLocations)
      .where(and(eq(transactionLocations.orderId, order.id), inArray(transactionLocations.purpose, ["DELIVERY_DESTINATION", "PICKUP_POINT"])));
  } else {
    await tx.insert(orderFulfillments).values({
      orderId: order.id,
      marketId: order.marketId,
      method: input.method,
      status: "REQUESTED",
      selectedBy: input.actorId,
      statusChangedBy: input.actorId,
    });
  }
  await auditMessage(tx, order.id, `اختار المشتري طريقة التسليم: ${METHOD_LABELS[input.method]}.`);
  const fulfillment = await fulfillmentFor(tx, order.id);
  const currentSupply = input.method === "COURIER" ? await courierSupplyForOrder(order, input.market, tx) : false;
  return { changed: true, view: buildDeliveryView(order, role, fulfillment, await locationsFor(tx, order.id), input.market, currentSupply) };
}

// ─── Location snapshot ───────────────────────────────────────────────────────

/** Which actor may share which purpose, and whether the order still allows it. */
function locationRule(
  purpose: LocationPurpose,
  order: OrderRow,
  role: DeliveryRole,
  fulfillment: FulfillmentRow | undefined,
): Error | null {
  if (!ARRANGEABLE_ORDER.includes(order.status))
    return fail(409, "انتهت مرحلة ترتيب التسليم لهذا الطلب؛ لا يمكن مشاركة موقع الآن.", "ORDER_LOCKED");
  if (purpose === "SERVICE_APPOINTMENT") {
    if (role !== "BUYER") return fail(403, "موقع تقديم الخدمة يحدده المشتري فقط.", "ROLE_FORBIDDEN");
    if (deliveryCapability(order) !== "SERVICE")
      return fail(409, "هذا الطلب ليس خدمة تحتاج موقعًا.", "PURPOSE_UNAVAILABLE");
    return null;
  }
  if (purpose === "DELIVERY_DESTINATION") {
    if (role !== "BUYER") return fail(403, "موقع التسليم يحدده المشتري فقط.", "ROLE_FORBIDDEN");
    if (fulfillment?.method === "PICKUP" && ACTIVE_FULFILMENT.includes(fulfillment.status as DeliveryStatus))
      return fail(409, "اخترت الاستلام الشخصي لهذا الطلب؛ لا يحتاج البائع موقعك. البائع يحدد نقطة الاستلام.", "PICKUP_SELECTED");
    if (!fulfillment || !["SELLER_DELIVERY", "COURIER"].includes(fulfillment.method) || !ACTIVE_FULFILMENT.includes(fulfillment.status as DeliveryStatus))
      return fail(409, "اختر «توصيل من البائع» أولًا، ثم شارك موقع التسليم.", "METHOD_REQUIRED");
    if (!DESTINATION_EDITABLE.includes(fulfillment.status as DeliveryStatus))
      return fail(409, "خرج الطلب للتوصيل؛ لا يمكن تغيير موقع التسليم الآن. تواصل مع البائع داخل الطلب.", "DESTINATION_LOCKED");
    return null;
  }
  if (role !== "SELLER") return fail(403, "نقطة الاستلام يحددها البائع فقط.", "ROLE_FORBIDDEN");
  if (fulfillment?.method !== "PICKUP" || !PICKUP_POINT_EDITABLE.includes(fulfillment.status as DeliveryStatus))
    return fail(409, "نقطة الاستلام متاحة فقط بعد أن يختار المشتري الاستلام الشخصي.", "METHOD_REQUIRED");
  return null;
}

/** Read-only pre-check used before asking the device for a location. */
export async function checkLocationAllowed(
  input: { actorId: string; orderId: string; purpose: LocationPurpose; market: Market },
  tx: any = db,
) {
  const { order, role } = await participantOrder(tx, input.orderId, input.actorId);
  if (order.marketId !== input.market.id)
    throw fail(409, "هذا الطلب في سوق آخر. غيّر السوق النشط قبل متابعة التوصيل.", "MARKET_MISMATCH");
  const rejection = locationRule(input.purpose, order, role, await fulfillmentFor(tx, order.id));
  if (rejection) throw rejection;
  return { order, role };
}

/** The purpose a participant shares for an order, derived from server state only. */
export function purposeFor(order: OrderRow, role: DeliveryRole): LocationPurpose {
  if (role === "SELLER") return "PICKUP_POINT";
  if (deliveryCapability(order) === "SERVICE") return "SERVICE_APPOINTMENT";
  return "DELIVERY_DESTINATION";
}

function sameLocation(row: LocationRow, location: LocationInput) {
  if (row.redactedAt) return false;
  if (location.source === "DEVICE")
    return (
      row.source === "DEVICE" &&
      row.latitude === location.latitude &&
      row.longitude === location.longitude &&
      row.accuracyMeters === (location.accuracyMeters ?? null) &&
      row.note === (location.note ?? null)
    );
  return (
    row.source === "MANUAL" &&
    row.latitude === null &&
    row.city === (location.city ?? "") &&
    row.area === (location.area ?? "") &&
    row.addressText === location.addressText &&
    row.note === (location.note ?? null)
  );
}

/**
 * Attaches an explicitly confirmed location to the order as its single current
 * snapshot for that purpose. Repeating the same location is a no-op; a different
 * one replaces it without keeping the old coordinates.
 */
export async function attachTransactionLocation(
  input: { actorId: string; orderId: string; purpose: LocationPurpose; location: LocationInput; market: Market },
  tx: any,
): Promise<{ changed: boolean; replaced: boolean; locationId: string; view: DeliveryView }> {
  const location = normalizeLocationInput(input.location);
  // The user's own privacy setting gates device coordinates on the server.
  if (location.source === "DEVICE" && !(await deviceLocationSharingAllowed(input.actorId, tx)))
    throw Object.assign(new Error("أوقفت مشاركة موقع الجهاز من إعدادات الخصوصية. أدخل المدينة والمنطقة يدويًا أو فعّل المشاركة."), { status: 403, code: "LOCATION_SHARING_DISABLED" });
  const { order, role } = await participantOrder(tx, input.orderId, input.actorId, true);
  await assertMayMutate(tx, input.actorId, order, input.market);
  const fulfillment = await fulfillmentFor(tx, order.id, true);
  const rejection = locationRule(input.purpose, order, role, fulfillment);
  if (rejection) throw rejection;
  const [existing] = (await tx
    .select()
    .from(transactionLocations)
    .where(and(eq(transactionLocations.orderId, order.id), eq(transactionLocations.purpose, input.purpose)))
    .for("update")) as LocationRow[];
  const done = async (changed: boolean, replaced: boolean, locationId: string) => {
    const [current, locations] = await Promise.all([fulfillmentFor(tx, order.id), locationsFor(tx, order.id)]);
    const supply = current?.method === "COURIER" ? await courierSupplyForOrder(order, input.market, tx) : false;
    return {
      changed,
      replaced,
      locationId,
      view: buildDeliveryView(order, role, current, locations, input.market, supply),
    };
  };
  if (existing && sameLocation(existing, location)) return done(false, false, existing.id);
  const now = new Date();
  const values = {
    source: location.source,
    latitude: location.source === "DEVICE" ? location.latitude : null,
    longitude: location.source === "DEVICE" ? location.longitude : null,
    accuracyMeters: location.source === "DEVICE" ? (location.accuracyMeters ?? null) : null,
    city: location.source === "MANUAL" ? (location.city ?? "") : "",
    area: location.source === "MANUAL" ? (location.area ?? "") : "",
    addressText: location.source === "MANUAL" ? location.addressText : null,
    note: location.note ?? null,
    sharedBy: input.actorId,
    redactedAt: null,
    updatedAt: now,
  };
  const id = existing?.id ?? randomUUID();
  await locationWrite(() =>
    existing
      ? tx.update(transactionLocations).set(values).where(eq(transactionLocations.id, existing.id))
      : tx.insert(transactionLocations).values({ id, orderId: order.id, marketId: order.marketId, purpose: input.purpose, ...values, createdAt: now }),
  );
  // A changed destination needs the seller's fresh acceptance.
  if (existing && input.purpose === "DELIVERY_DESTINATION" && fulfillment?.status === "ACCEPTED")
    await tx
      .update(orderFulfillments)
      .set({ status: "REQUESTED", statusChangedBy: input.actorId, version: fulfillment.version + 1, updatedAt: now })
      .where(eq(orderFulfillments.orderId, order.id));
  else if (fulfillment && input.purpose !== "SERVICE_APPOINTMENT")
    await tx
      .update(orderFulfillments)
      .set({ version: fulfillment.version + 1, updatedAt: now })
      .where(eq(orderFulfillments.orderId, order.id));
  const who = role === "SELLER" ? "البائع" : "المشتري";
  await auditMessage(
    tx,
    order.id,
    existing ? `حدّث ${who} ${PURPOSE_LABELS[input.purpose]} لهذا الطلب.` : `شارك ${who} ${PURPOSE_LABELS[input.purpose]} لهذا الطلب.`,
  );
  return done(true, Boolean(existing), id);
}

// ─── State machine ───────────────────────────────────────────────────────────

/**
 * Allowed transitions. Final handoff (DELIVERED / PICKED_UP) is not reachable here:
 * it happens only through the existing order handoff with proof, so the buyer's
 * confirmation remains the commercial completion authority.
 */
function transitionRule(
  to: DeliveryTransitionTarget,
  method: DeliveryMethod,
  from: DeliveryStatus,
  role: DeliveryRole,
  orderStatus: string,
  hasDestination: boolean,
): Error | null {
  const notAllowed = () =>
    fail(409, `لا يمكن الانتقال من «${STATUS_LABELS[from]}» إلى «${STATUS_LABELS[to]}».`, "INVALID_TRANSITION");
  const sellerOnly = () => fail(403, "هذا الإجراء للبائع فقط.", "ROLE_FORBIDDEN");
  const needsAcceptedOrder = () => fail(409, "اقبل الطلب أولًا قبل تنفيذ التسليم.", "ORDER_NOT_ACCEPTED");
  // Who carries the order: the seller for SELLER_DELIVERY/PICKUP, the assigned driver for COURIER.
  const carrier = method === "COURIER" ? "DRIVER" : "SELLER";
  const carrierOnly = () =>
    carrier === "DRIVER" ? fail(403, "هذا الإجراء لمندوب التوصيل المسند فقط.", "ROLE_FORBIDDEN") : sellerOnly();
  const delivered = method === "SELLER_DELIVERY" || method === "COURIER";
  switch (to) {
    case "ACCEPTED":
      if (!delivered || from !== "REQUESTED") return notAllowed();
      if (role !== carrier) return carrierOnly();
      if (!EXECUTABLE_ORDER.includes(orderStatus)) return needsAcceptedOrder();
      if (!hasDestination) return fail(409, "بانتظار موقع التسليم من المشتري.", "DESTINATION_REQUIRED");
      return null;
    case "OUT_FOR_DELIVERY":
      if (!delivered || from !== "ACCEPTED") return notAllowed();
      if (role !== carrier) return carrierOnly();
      if (!EXECUTABLE_ORDER.includes(orderStatus)) return needsAcceptedOrder();
      return null;
    case "READY_FOR_PICKUP":
      if (method !== "PICKUP" || from !== "REQUESTED") return notAllowed();
      if (role !== "SELLER") return sellerOnly();
      if (!EXECUTABLE_ORDER.includes(orderStatus)) return needsAcceptedOrder();
      return null;
    case "CANCELLED":
      if (!["REQUESTED", "ACCEPTED", "READY_FOR_PICKUP"].includes(from)) return notAllowed();
      // Releasing an accepted delivery goes through DINAR support, not the driver alone.
      if (role === "DRIVER") return fail(403, "لا يمكن لمندوب التوصيل إلغاء مهمة مقبولة؛ تواصل مع دعم DINAR لإعادة إسنادها.", "ROLE_FORBIDDEN");
      if (!ARRANGEABLE_ORDER.includes(orderStatus)) return fail(409, "لا يمكن تغيير التسليم في حالة الطلب الحالية.", "ORDER_LOCKED");
      return null;
    case "FAILED":
      if (!["ACCEPTED", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP"].includes(from)) return notAllowed();
      if (role !== carrier) return carrierOnly();
      if (!EXECUTABLE_ORDER.includes(orderStatus)) return needsAcceptedOrder();
      return null;
    default:
      // DELIVERED / PICKED_UP and anything else: only the order handoff reaches them.
      return notAllowed();
  }
}

/** Read-only pre-check for a transition proposed in conversation. */
export async function checkTransition(
  input: { actorId: string; orderId: string; to: DeliveryTransitionTarget; market: Market },
  tx: any = db,
) {
  const { order, role } = await participantOrder(tx, input.orderId, input.actorId);
  if (order.marketId !== input.market.id)
    throw fail(409, "هذا الطلب في سوق آخر. غيّر السوق النشط قبل متابعة التوصيل.", "MARKET_MISMATCH");
  const fulfillment = await fulfillmentFor(tx, order.id);
  if (!fulfillment) throw fail(409, "لم يُختر ترتيب تسليم لهذا الطلب بعد.", "NO_FULFILMENT");
  if (fulfillment.status === input.to) return { order, role, fulfillment, repeat: true };
  if (input.to === "OUT_FOR_DELIVERY" && fulfillment.method === "COURIER")
    await requireCourierFareAgreement(tx, { orderId: order.id, marketId: input.market.id });
  const locations = await locationsFor(tx, order.id);
  const rejection = transitionRule(
    input.to,
    fulfillment.method as DeliveryMethod,
    fulfillment.status as DeliveryStatus,
    role,
    order.status,
    locations.some((row) => row.purpose === "DELIVERY_DESTINATION" && !row.redactedAt),
  );
  if (rejection) throw rejection;
  return { order, role, fulfillment, repeat: false };
}

export async function transitionDelivery(
  input: {
    actorId: string;
    orderId: string;
    to: DeliveryTransitionTarget;
    failureReason?: DeliveryFailureReason;
    market: Market;
  },
  tx: any,
): Promise<{ changed: boolean; view: DeliveryView }> {
  const { order, role } = await participantOrder(tx, input.orderId, input.actorId, true);
  await assertMayMutate(tx, input.actorId, order, input.market);
  const fulfillment = await fulfillmentFor(tx, order.id, true);
  if (!fulfillment) throw fail(409, "لم يُختر ترتيب تسليم لهذا الطلب بعد.", "NO_FULFILMENT");
  const view = async () => {
    const [current, locations] = await Promise.all([fulfillmentFor(tx, order.id), locationsFor(tx, order.id)]);
    const supply = current?.method === "COURIER" ? await courierSupplyForOrder(order, input.market, tx) : false;
    return buildDeliveryView(order, role, current, locations, input.market, supply);
  };
  // Repeating the current state (a network retry) changes nothing.
  if (fulfillment.status === input.to) return { changed: false, view: await view() };
  if (input.to === "OUT_FOR_DELIVERY" && fulfillment.method === "COURIER")
    await requireCourierFareAgreement(tx, { orderId: order.id, marketId: input.market.id });
  const locations = await locationsFor(tx, order.id);
  const rejection = transitionRule(
    input.to,
    fulfillment.method as DeliveryMethod,
    fulfillment.status as DeliveryStatus,
    role,
    order.status,
    locations.some((row) => row.purpose === "DELIVERY_DESTINATION" && !row.redactedAt),
  );
  if (rejection) throw rejection;
  const failureReason = input.to === "FAILED" ? (input.failureReason ?? "OTHER") : null;
  const now = new Date();
  await tx
    .update(orderFulfillments)
    .set({ status: input.to, failureReason, statusChangedBy: input.actorId, version: fulfillment.version + 1, updatedAt: now })
    .where(eq(orderFulfillments.orderId, order.id));
  if (input.to === "CANCELLED" || input.to === "FAILED") {
    // The arrangement ended: its places are no longer needed, and a driver's
    // assignment is released (kept as history, never deleted).
    await tx
      .delete(transactionLocations)
      .where(and(eq(transactionLocations.orderId, order.id), inArray(transactionLocations.purpose, ["DELIVERY_DESTINATION", "PICKUP_POINT"])));
    await releaseAssignments(tx, order.id, now);
  }
  const who = role === "SELLER" ? "البائع" : role === "DRIVER" ? "مندوب التوصيل" : "المشتري";
  await auditMessage(
    tx,
    order.id,
    input.to === "FAILED"
      ? `سجّل ${who} تعذر التسليم: ${FAILURE_LABELS[failureReason!]}. الطلب نفسه لم يُلغَ.`
      : input.to === "CANCELLED"
        ? `ألغى ${who} ترتيب التسليم. الطلب نفسه لم يُلغَ ويمكن اختيار طريقة جديدة.`
        : `حالة التسليم: ${statusLabel(fulfillment.method as DeliveryMethod, input.to)}.`,
  );
  return { changed: true, view: await view() };
}

// ─── Order lifecycle hooks ───────────────────────────────────────────────────

/**
 * Called by the existing seller handoff (order → SELLER_MARKED_DELIVERED). With an
 * active delivery arrangement the handoff must follow it; the arrangement then
 * records DELIVERED / PICKED_UP. Without one, the legacy handoff is unchanged.
 */
export async function recordOrderHandoff(tx: any, order: OrderRow, actorId: string, now: Date) {
  const fulfillment = await fulfillmentFor(tx, order.id, true);
  if (!fulfillment || !ACTIVE_FULFILMENT.includes(fulfillment.status as DeliveryStatus)) return;
  if (fulfillment.method === "COURIER") {
    // A DINAR driver carries this order: only the assigned driver records the handoff.
    const [assignment] = await tx
      .select({ driverId: deliveryAssignments.driverId })
      .from(deliveryAssignments)
      .where(and(eq(deliveryAssignments.orderId, order.id), eq(deliveryAssignments.status, "ACCEPTED")));
    if (assignment?.driverId !== actorId)
      throw fail(403, "يسجّل مندوب التوصيل المسند تسليم هذا الطلب.", "ROLE_FORBIDDEN");
  }
  const ready =
    ((fulfillment.method === "SELLER_DELIVERY" || fulfillment.method === "COURIER") && fulfillment.status === "OUT_FOR_DELIVERY") ||
    (fulfillment.method === "PICKUP" && fulfillment.status === "READY_FOR_PICKUP");
  if (!ready)
    throw fail(
      409,
      fulfillment.method === "PICKUP"
        ? "حدّث حالة التسليم إلى «جاهز للاستلام» قبل تسجيل التسليم."
        : "حدّث حالة التسليم إلى «خرج للتوصيل» قبل تسجيل التسليم.",
      "HANDOFF_NOT_READY",
    );
  await tx
    .update(orderFulfillments)
    .set({
      status: fulfillment.method === "PICKUP" ? "PICKED_UP" : "DELIVERED",
      statusChangedBy: actorId,
      version: fulfillment.version + 1,
      updatedAt: now,
    })
    .where(eq(orderFulfillments.orderId, order.id));
}

/**
 * The order-side handoff shared by the seller's order action and the assigned driver:
 * the order must be under execution with a proof, and the delivery arrangement (if any)
 * must be ready. The caller writes the returned order status in its own transaction.
 */
export async function orderHandoff(
  tx: any,
  order: OrderRow,
  actorId: string,
  proof: { proofType: string; proofToken: string },
  now: Date,
) {
  if (!EXECUTABLE_ORDER.includes(order.status) || !proof.proofToken.trim())
    throw fail(409, "راجع حالة الطلب وإثبات التسليم");
  await recordOrderHandoff(tx, order, actorId, now);
  return {
    status: "SELLER_MARKED_DELIVERED",
    data: { ...order.data, deliveryProof: `${proof.proofType}: ${proof.proofToken}` },
  };
}

/**
 * Terminal order (completed or cancelled, by any path): precise location is no
 * longer needed, so coordinates, address and notes are cleared; coarse fields and
 * the method/state history remain for authorized order history.
 */
export async function settleOrderFulfillment(tx: any, orderId: string, terminal: "COMPLETED" | "CANCELLED", now: Date) {
  await tx
    .update(transactionLocations)
    .set({ latitude: null, longitude: null, accuracyMeters: null, addressText: null, note: null, redactedAt: now, updatedAt: now })
    .where(and(eq(transactionLocations.orderId, orderId), isNull(transactionLocations.redactedAt)));
  if (terminal === "CANCELLED") {
    await tx
      .update(orderFulfillments)
      .set({ status: "CANCELLED", statusChangedBy: null, updatedAt: now })
      .where(and(eq(orderFulfillments.orderId, orderId), inArray(orderFulfillments.status, ACTIVE_FULFILMENT)));
    await releaseAssignments(tx, orderId, now);
  }
}

/** Ends an order's active driver assignment; the row stays as history. */
async function releaseAssignments(tx: any, orderId: string, now: Date) {
  await tx
    .update(deliveryAssignments)
    .set({ status: "RELEASED", releasedAt: now, updatedAt: now })
    .where(and(eq(deliveryAssignments.orderId, orderId), eq(deliveryAssignments.status, "ACCEPTED")));
}
