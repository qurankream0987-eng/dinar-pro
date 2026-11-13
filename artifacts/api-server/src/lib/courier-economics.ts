import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  courierCommissionReceivables,
  courierCommissionSettlements,
  courierFareAgreements,
  courierFareProposals,
  deliveryAssignments,
  driverProfiles,
  orderFulfillments,
  orders,
  users,
} from "@workspace/db";
import { ACCOUNT_STATUS } from "./account-status";
import type { marketFor } from "./markets";
import {
  courierCommissionMinor,
  formatMinorUnits,
  parseFareAmount,
} from "./courier-money";
export { courierCommissionMinor, formatMinorUnits, parseFareAmount } from "./courier-money";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Transaction = any;
type Role = "BUYER" | "COURIER";

const fail = (status: number, message: string, code: string) =>
  Object.assign(new Error(message), { status, code });

const ACTIVE_ORDER_STATES = new Set(["ACCEPTED", "IN_PROGRESS"]);
const MUTABLE_ACCOUNT_STATES = new Set([
  ACCOUNT_STATUS.active,
  ACCOUNT_STATUS.restricted,
]);
const COMMISSION_RATE_BPS = 1000;
const HOLD_DELIVERY_COUNT = 10;
const MAX_MINOR_UNITS = 2_147_483_647;

function proposalView(row: typeof courierFareProposals.$inferSelect, role: Role) {
  return {
    id: row.id,
    fareMinor: row.fareMinor,
    currencyCode: row.currencyCode,
    minorUnitScale: row.minorUnitScale,
    amount: formatMinorUnits(row.fareMinor, row.minorUnitScale),
    status: row.status,
    proposedByMe:
      (role === "BUYER" && row.proposedByUserId === row.buyerId) ||
      (role === "COURIER" && row.proposedByUserId === row.courierId),
    buyerConfirmed: Boolean(row.buyerConfirmedAt),
    courierConfirmed: Boolean(row.courierConfirmedAt),
    canConfirm: row.status === "PENDING",
    createdAt: row.createdAt.toISOString(),
  };
}

function agreementView(row: typeof courierFareAgreements.$inferSelect) {
  return {
    id: row.id,
    proposalId: row.proposalId,
    fareMinor: row.fareMinor,
    currencyCode: row.currencyCode,
    minorUnitScale: row.minorUnitScale,
    amount: formatMinorUnits(row.fareMinor, row.minorUnitScale),
    commissionRateBps: row.commissionRateBps,
    estimatedCommissionMinor: row.commissionEstimateMinor,
    estimatedCommission: formatMinorUnits(row.commissionEstimateMinor, row.minorUnitScale),
    agreedAt: row.agreedAt.toISOString(),
  };
}

async function loadOrderAndActors(
  tx: Transaction,
  input: { actorId: string; orderId: string; market: Market; lock?: boolean },
): Promise<{
  order: typeof orders.$inferSelect;
  fulfillment: typeof orderFulfillments.$inferSelect;
  assignment: typeof deliveryAssignments.$inferSelect | undefined;
  role: Role;
}> {
  let orderQuery = tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (input.lock) orderQuery = orderQuery.for("update");
  const [order] = await orderQuery;
  if (!order) throw fail(404, "الطلب غير موجود.", "ORDER_NOT_FOUND");
  const [fulfillment] = await tx
    .select()
    .from(orderFulfillments)
    .where(eq(orderFulfillments.orderId, order.id));
  if (
    order.marketId !== input.market.id ||
    !fulfillment ||
    fulfillment.marketId !== order.marketId
  )
    throw fail(409, "الطلب ليس في سوق التسليم النشط.", "MARKET_MISMATCH");
  if (fulfillment.method !== "COURIER")
    throw fail(409, "التفاوض على الأجرة متاح فقط لمهام مندوب جاسم.", "COURIER_REQUIRED");

  let assignmentQuery = tx
    .select()
    .from(deliveryAssignments)
    .where(
      and(
        eq(deliveryAssignments.orderId, order.id),
        eq(deliveryAssignments.status, "ACCEPTED"),
      ),
    );
  if (input.lock) assignmentQuery = assignmentQuery.for("update");
  const [assignment] = await assignmentQuery;
  if (
    assignment &&
    assignment.marketId !== order.marketId
  )
    throw fail(409, "إسناد مندوب التوصيل غير متاح للتفاوض.", "ASSIGNMENT_UNAVAILABLE");

  const role: Role | undefined =
    order.buyerId === input.actorId
      ? "BUYER"
      : assignment?.driverId === input.actorId && assignment.status === "ACCEPTED"
        ? "COURIER"
        : undefined;
  if (!role) throw fail(404, "الطلب غير موجود لهذا المستخدم.", "ORDER_NOT_FOUND");
  const [actor] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, input.actorId));
  if (!actor || !MUTABLE_ACCOUNT_STATES.has(actor.status))
    throw fail(403, "حسابك لا يسمح بتأكيد أجرة هذه المهمة.", "ACCOUNT_INACTIVE");
  if (role === "COURIER") {
    const [profile] = await tx
      .select()
      .from(driverProfiles)
      .where(eq(driverProfiles.id, assignment!.driverProfileId));
    if (!profile || profile.userId !== input.actorId || profile.marketId !== order.marketId)
      throw fail(409, "ملف المندوب لا يطابق سوق الطلب.", "MARKET_MISMATCH");
  }
  return { order, fulfillment, assignment, role };
}

export async function getCourierFareView(input: {
  actorId: string;
  orderId: string;
  market: Market;
}, tx: Transaction): Promise<{
  orderId: string;
  status: string;
  role: Role;
  currencyCode: string;
  minorUnitScale: number;
  proposal: ReturnType<typeof proposalView> | null;
  agreement: ReturnType<typeof agreementView> | null;
}> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (!order) throw fail(404, "الطلب غير موجود.", "ORDER_NOT_FOUND");
  const [fulfillment] = await tx
    .select()
    .from(orderFulfillments)
    .where(eq(orderFulfillments.orderId, order.id));
  if (
    order.marketId !== input.market.id ||
    fulfillment?.marketId !== order.marketId
  )
    throw fail(409, "الطلب ليس في سوق التسليم النشط.", "MARKET_MISMATCH");
  if (fulfillment?.method !== "COURIER")
    throw fail(409, "هذا الطلب لا يستخدم مندوب جاسم.", "COURIER_REQUIRED");

  const [assignment] = await tx
    .select()
    .from(deliveryAssignments)
    .where(eq(deliveryAssignments.orderId, order.id))
    .orderBy(desc(deliveryAssignments.createdAt));
  const role: Role | undefined =
    order.buyerId === input.actorId
      ? "BUYER"
      : assignment?.driverId === input.actorId && assignment.status === "ACCEPTED"
        ? "COURIER"
        : undefined;
  if (!role) throw fail(404, "الطلب غير موجود لهذا المستخدم.", "ORDER_NOT_FOUND");

  if (!assignment) {
    return {
      orderId: order.id,
      status: "WAITING_FOR_COURIER",
      role,
      currencyCode: order.currencyCode,
      minorUnitScale: order.minorUnitScale,
      proposal: null,
      agreement: null,
    };
  }
  if (assignment.marketId !== order.marketId)
    throw fail(409, "إسناد التوصيل لا يطابق سوق الطلب.", "MARKET_MISMATCH");
  if (role === "COURIER") {
    const [profile] = await tx
      .select()
      .from(driverProfiles)
      .where(eq(driverProfiles.id, assignment.driverProfileId));
    if (!profile || profile.userId !== input.actorId || profile.marketId !== order.marketId)
      throw fail(404, "الطلب غير موجود لهذا المستخدم.", "ORDER_NOT_FOUND");
  }

  const [agreement] = await tx
    .select()
    .from(courierFareAgreements)
    .where(eq(courierFareAgreements.assignmentId, assignment.id));
  const [proposal] = agreement
    ? []
    : await tx
        .select()
        .from(courierFareProposals)
        .where(and(eq(courierFareProposals.assignmentId, assignment.id), eq(courierFareProposals.status, "PENDING")))
        .orderBy(desc(courierFareProposals.createdAt));
  return {
    orderId: order.id,
    status: agreement ? "AGREED" : proposal ? "AWAITING_CONFIRMATION" : assignment.status,
    role,
    currencyCode: agreement?.currencyCode ?? order.currencyCode,
    minorUnitScale: agreement?.minorUnitScale ?? order.minorUnitScale,
    proposal: proposal ? proposalView(proposal, role) : null,
    agreement: agreement ? agreementView(agreement) : null,
  };
}

export async function proposeCourierFare(input: {
  actorId: string;
  orderId: string;
  market: Market;
  amount: unknown;
  idempotencyKey: string;
}, tx: Transaction) {
  const { order, fulfillment, assignment, role } = await loadOrderAndActors(tx, {
    actorId: input.actorId,
    orderId: input.orderId,
    market: input.market,
    lock: true,
  });
  if (!assignment) throw fail(409, "انتظر إسناد مندوب قبل اقتراح الأجرة.", "COURIER_NOT_ASSIGNED");
  if (assignment.driverId === order.buyerId)
    throw fail(409, "لا يمكن للمشتري تنفيذ مهمة التوصيل.", "ASSIGNMENT_INVALID");
  if (
    !ACTIVE_ORDER_STATES.has(order.status) ||
    !["REQUESTED", "ACCEPTED"].includes(fulfillment.status)
  )
    throw fail(409, "انتهت فرصة التفاوض على أجرة هذه المهمة.", "FARE_NEGOTIATION_CLOSED");

  const fareMinor = parseFareAmount(input.amount, order.minorUnitScale);
  const [priorByKey] = await tx
    .select()
    .from(courierFareProposals)
    .where(
      and(
        eq(courierFareProposals.proposedByUserId, input.actorId),
        eq(courierFareProposals.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (priorByKey) {
    if (
      priorByKey.orderId !== order.id ||
      priorByKey.assignmentId !== assignment.id ||
      priorByKey.fareMinor !== fareMinor ||
      priorByKey.currencyCode !== order.currencyCode
    )
      throw fail(409, "استخدم مفتاحًا جديدًا لعرض أجرة مختلف.", "IDEMPOTENCY_KEY_REUSED");
    return { proposal: proposalView(priorByKey, role), agreement: null, idempotent: true };
  }

  const [agreement] = await tx
    .select()
    .from(courierFareAgreements)
    .where(eq(courierFareAgreements.assignmentId, assignment.id));
  if (agreement) throw fail(409, "أكد الطرفان الأجرة بالفعل؛ لا يمكن تغييرها.", "FARE_LOCKED");

  const [pending] = await tx
    .select()
    .from(courierFareProposals)
    .where(and(eq(courierFareProposals.assignmentId, assignment.id), eq(courierFareProposals.status, "PENDING")))
    .for("update");
  if (pending) {
    await tx
      .update(courierFareProposals)
      .set({ status: "SUPERSEDED", updatedAt: new Date() })
      .where(eq(courierFareProposals.id, pending.id));
  }
  const now = new Date();
  const [proposal] = await tx
    .insert(courierFareProposals)
    .values({
      id: randomUUID(),
      orderId: order.id,
      assignmentId: assignment.id,
      marketId: order.marketId,
      buyerId: order.buyerId,
      courierId: assignment.driverId,
      proposedByUserId: input.actorId,
      fareMinor,
      currencyCode: order.currencyCode,
      minorUnitScale: order.minorUnitScale,
      idempotencyKey: input.idempotencyKey,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { proposal: proposalView(proposal, role), agreement: null, idempotent: false };
}

export async function confirmCourierFare(input: {
  actorId: string;
  orderId: string;
  market: Market;
  proposalId: string;
}, tx: Transaction) {
  const { order, fulfillment, assignment, role } = await loadOrderAndActors(tx, {
    actorId: input.actorId,
    orderId: input.orderId,
    market: input.market,
    lock: true,
  });
  if (!assignment) throw fail(409, "انتظر إسناد مندوب قبل تأكيد الأجرة.", "COURIER_NOT_ASSIGNED");
  const [existingAgreement] = await tx
    .select()
    .from(courierFareAgreements)
    .where(eq(courierFareAgreements.assignmentId, assignment.id));
  if (existingAgreement) {
    if (existingAgreement.proposalId !== input.proposalId)
      throw fail(409, "تم تثبيت أجرة أخرى لهذه المهمة.", "FARE_LOCKED");
    return { proposal: null, agreement: agreementView(existingAgreement), agreed: true, idempotent: true };
  }
  if (
    !ACTIVE_ORDER_STATES.has(order.status) ||
    !["REQUESTED", "ACCEPTED"].includes(fulfillment.status)
  )
    throw fail(409, "انتهت فرصة تأكيد أجرة هذه المهمة.", "FARE_NEGOTIATION_CLOSED");
  const [proposal] = await tx
    .select()
    .from(courierFareProposals)
    .where(
      and(
        eq(courierFareProposals.id, input.proposalId),
        eq(courierFareProposals.orderId, order.id),
        eq(courierFareProposals.assignmentId, assignment.id),
      ),
    )
    .for("update");
  if (!proposal || proposal.status !== "PENDING")
    throw fail(409, "هذا العرض لم يعد ساريًا؛ راجع أحدث أجرة مقترحة.", "FARE_PROPOSAL_STALE");
  const now = new Date();
  const alreadyConfirmed =
    role === "BUYER" ? Boolean(proposal.buyerConfirmedAt) : Boolean(proposal.courierConfirmedAt);
  const buyerConfirmed = Boolean(proposal.buyerConfirmedAt) || role === "BUYER";
  const courierConfirmed = Boolean(proposal.courierConfirmedAt) || role === "COURIER";
  const buyerConfirmedAt = proposal.buyerConfirmedAt ?? (role === "BUYER" ? now : null);
  const courierConfirmedAt = proposal.courierConfirmedAt ?? (role === "COURIER" ? now : null);
  let updatedProposal = proposal;
  if (!buyerConfirmed || !courierConfirmed) {
    if (!alreadyConfirmed) {
      [updatedProposal] = await tx
        .update(courierFareProposals)
        .set(
          role === "BUYER"
            ? { buyerConfirmedAt: now, updatedAt: now }
            : { courierConfirmedAt: now, updatedAt: now },
        )
        .where(eq(courierFareProposals.id, proposal.id))
        .returning();
    }
    return {
      proposal: proposalView(updatedProposal, role),
      agreement: null,
      agreed: false,
      idempotent: alreadyConfirmed,
    };
  }

  const [agreedProposal] = await tx
    .update(courierFareProposals)
    .set({
      status: "AGREED",
      buyerConfirmedAt,
      courierConfirmedAt,
      updatedAt: now,
    })
    .where(eq(courierFareProposals.id, proposal.id))
    .returning();
  const [agreement] = await tx
    .insert(courierFareAgreements)
    .values({
      id: randomUUID(),
      proposalId: agreedProposal.id,
      assignmentId: assignment.id,
      orderId: order.id,
      marketId: order.marketId,
      buyerId: order.buyerId,
      courierId: assignment.driverId,
      fareMinor: agreedProposal.fareMinor,
      currencyCode: agreedProposal.currencyCode,
      minorUnitScale: agreedProposal.minorUnitScale,
      commissionRateBps: COMMISSION_RATE_BPS,
      commissionEstimateMinor: courierCommissionMinor(agreedProposal.fareMinor),
      agreedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!agreement) {
    const [raced] = await tx
      .select()
      .from(courierFareAgreements)
      .where(eq(courierFareAgreements.assignmentId, assignment.id));
    if (!raced || raced.proposalId !== agreedProposal.id)
      throw fail(409, "لم يُثبّت هذا العرض؛ أعد تحميل الأجرة الحالية.", "FARE_LOCKED");
    return { proposal: proposalView(agreedProposal, role), agreement: agreementView(raced), agreed: true, idempotent: true };
  }
  return {
    proposal: proposalView(agreedProposal, role),
    agreement: agreementView(agreement),
    agreed: true,
    idempotent: false,
  };
}

/** Block a courier departure unless both parties have locked the fare snapshot. */
export async function requireCourierFareAgreement(
  tx: Transaction,
  input: { orderId: string; marketId: string },
) {
  const [[order], [fulfillment], [assignment]] = await Promise.all([
    tx.select().from(orders).where(eq(orders.id, input.orderId)),
    tx.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, input.orderId)),
    tx
      .select()
      .from(deliveryAssignments)
      .where(
        and(
          eq(deliveryAssignments.orderId, input.orderId),
          eq(deliveryAssignments.status, "ACCEPTED"),
        ),
      ),
  ]);
  if (
    !order ||
    !fulfillment ||
    !assignment ||
    order.marketId !== input.marketId ||
    fulfillment.marketId !== input.marketId ||
    assignment.marketId !== input.marketId ||
    fulfillment.method !== "COURIER" ||
    assignment.status !== "ACCEPTED"
  )
    throw fail(409, "لا يطابق إسناد التوصيل سوق الطلب.", "MARKET_MISMATCH");
  const [agreement] = await tx
    .select()
    .from(courierFareAgreements)
    .where(
      and(
        eq(courierFareAgreements.orderId, order.id),
        eq(courierFareAgreements.assignmentId, assignment.id),
        eq(courierFareAgreements.marketId, order.marketId),
      ),
    );
  if (!agreement)
    throw fail(409, "يجب أن يؤكد المشتري ومندوب التوصيل الأجرة قبل بدء الرحلة.", "COURIER_FARE_REQUIRED");
  return agreement;
}

/** Adds one separate courier receivable on a successful, buyer-confirmed handoff. */
export async function recordCourierCommissionAccrual(
  tx: Transaction,
  order: typeof orders.$inferSelect,
  now: Date,
): Promise<boolean> {
  const [fulfillment] = await tx
    .select()
    .from(orderFulfillments)
    .where(eq(orderFulfillments.orderId, order.id));
  if (fulfillment?.method !== "COURIER" || fulfillment.status !== "DELIVERED") return false;
  const [assignment] = await tx
    .select()
    .from(deliveryAssignments)
    .where(and(eq(deliveryAssignments.orderId, order.id), eq(deliveryAssignments.status, "ACCEPTED")));
  if (!assignment) return false;
  const [agreement] = await tx
    .select()
    .from(courierFareAgreements)
    .where(
      and(
        eq(courierFareAgreements.orderId, order.id),
        eq(courierFareAgreements.assignmentId, assignment.id),
      ),
    );
  if (!agreement) return false;
  const [profile] = await tx
    .select()
    .from(driverProfiles)
    .where(eq(driverProfiles.id, assignment.driverProfileId));
  if (
    order.marketId !== fulfillment.marketId ||
    assignment.marketId !== order.marketId ||
    agreement.marketId !== order.marketId ||
    !profile ||
    profile.userId !== assignment.driverId ||
    profile.marketId !== order.marketId ||
    agreement.courierId !== assignment.driverId ||
    agreement.buyerId !== order.buyerId ||
    agreement.currencyCode !== order.currencyCode
  )
    throw fail(409, "تعذر مطابقة أجرة المندوب مع الطلب والسوق.", "COURIER_FARE_MISMATCH");

  const [receivable] = await tx
    .insert(courierCommissionReceivables)
    .values({
      id: randomUUID(),
      agreementId: agreement.id,
      assignmentId: assignment.id,
      orderId: order.id,
      courierId: assignment.driverId,
      marketId: order.marketId,
      fareMinor: agreement.fareMinor,
      commissionRateBps: COMMISSION_RATE_BPS,
      amountMinor: courierCommissionMinor(agreement.fareMinor),
      currencyCode: agreement.currencyCode,
      minorUnitScale: agreement.minorUnitScale,
      status: "OUTSTANDING",
      settlementId: null,
      accruedAt: now,
      settledAt: null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: courierCommissionReceivables.id });
  return Boolean(receivable);
}

export async function getCourierCommissionAccount(input: { courierId: string }, tx: Transaction) {
  const rows = await tx
    .select()
    .from(courierCommissionReceivables)
    .where(
      and(
        eq(courierCommissionReceivables.courierId, input.courierId),
        eq(courierCommissionReceivables.status, "OUTSTANDING"),
      ),
    )
    .orderBy(courierCommissionReceivables.marketId, courierCommissionReceivables.accruedAt);
  const balances = new Map<
    string,
    { marketId: string; currencyCode: string; minorUnitScale: number; amountMinor: number; deliveryCount: number }
  >();
  let outstandingDeliveryCount = 0;
  for (const row of rows) {
    const key = `${row.marketId}:${row.currencyCode}:${row.minorUnitScale}`;
    const balance = balances.get(key) ?? {
      marketId: row.marketId,
      currencyCode: row.currencyCode,
      minorUnitScale: row.minorUnitScale,
      amountMinor: 0,
      deliveryCount: 0,
    };
    balance.amountMinor += row.amountMinor;
    balance.deliveryCount += 1;
    outstandingDeliveryCount += 1;
    balances.set(key, balance);
  }
  const normalizedBalances = [...balances.values()].map((balance) => ({
    ...balance,
    amount: formatMinorUnits(balance.amountMinor, balance.minorUnitScale),
  }));
  const historyRows = await tx
    .select({
      receivable: courierCommissionReceivables,
      settledAt: courierCommissionSettlements.simulatedAt,
      settlementMode: courierCommissionSettlements.mode,
    })
    .from(courierCommissionReceivables)
    .innerJoin(orders, eq(orders.id, courierCommissionReceivables.orderId))
    .leftJoin(
      courierCommissionSettlements,
      eq(courierCommissionSettlements.id, courierCommissionReceivables.settlementId),
    )
    .where(
      and(
        eq(courierCommissionReceivables.courierId, input.courierId),
        eq(orders.status, "COMPLETED"),
      ),
    )
    .orderBy(desc(courierCommissionReceivables.accruedAt));
  type HistoryRow = {
    receivable: typeof courierCommissionReceivables.$inferSelect;
    settledAt: Date | null;
    settlementMode: typeof courierCommissionSettlements.$inferSelect.mode | null;
  };
  const earningsHistory = (historyRows as HistoryRow[]).map(({ receivable, settledAt, settlementMode }) => ({
    orderId: receivable.orderId,
    orderReference: receivable.orderId.slice(-8).toUpperCase(),
    completedAt: receivable.accruedAt.toISOString(),
    marketId: receivable.marketId,
    agreedFareMinor: receivable.fareMinor,
    agreedFare: formatMinorUnits(receivable.fareMinor, receivable.minorUnitScale),
    commissionRateBps: receivable.commissionRateBps,
    commissionMinor: receivable.amountMinor,
    commission: formatMinorUnits(receivable.amountMinor, receivable.minorUnitScale),
    courierShareMinor: receivable.fareMinor - receivable.amountMinor,
    courierShare: formatMinorUnits(
      receivable.fareMinor - receivable.amountMinor,
      receivable.minorUnitScale,
    ),
    currencyCode: receivable.currencyCode,
    minorUnitScale: receivable.minorUnitScale,
    receivableStatus: receivable.status,
    simulationClearedAt: settledAt?.toISOString() ?? null,
    settlementMode: settlementMode ?? null,
    realPaymentVerified: false as const,
  }));
  return {
    courierId: input.courierId,
    outstandingDeliveryCount,
    hold:
      outstandingDeliveryCount >= HOLD_DELIVERY_COUNT &&
      normalizedBalances.some((balance) => balance.amountMinor > 0),
    holdThreshold: HOLD_DELIVERY_COUNT,
    settlementMode: "SIMULATION_ONLY" as const,
    realMoneyTransferred: false as const,
    balances: normalizedBalances,
    earningsHistory,
  };
}

export async function settleCourierCommissionSimulation(input: {
  courierId: string;
  market: { id: string; currencyCode: string; minorUnitScale: number };
  idempotencyKey: string;
}, tx: Transaction) {
  const [courier] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.courierId))
    .for("update");
  if (!courier) throw fail(404, "حساب المندوب غير موجود.", "COURIER_NOT_FOUND");
  const [previous] = await tx
    .select()
    .from(courierCommissionSettlements)
    .where(
      and(
        eq(courierCommissionSettlements.courierId, input.courierId),
        eq(courierCommissionSettlements.marketId, input.market.id),
        eq(courierCommissionSettlements.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (previous) {
    if (
      previous.currencyCode !== input.market.currencyCode ||
      previous.minorUnitScale !== input.market.minorUnitScale
    )
      throw fail(409, "تغيرت بيانات السوق لهذا المفتاح؛ استخدم مفتاحًا جديدًا.", "IDEMPOTENCY_KEY_REUSED");
    return { settlement: previous, idempotent: true };
  }

  const receivables = (await tx
    .select()
    .from(courierCommissionReceivables)
    .where(
      and(
        eq(courierCommissionReceivables.courierId, input.courierId),
        eq(courierCommissionReceivables.marketId, input.market.id),
        eq(courierCommissionReceivables.status, "OUTSTANDING"),
      ),
    )
    .for("update")) as (typeof courierCommissionReceivables.$inferSelect)[];
  const amountMinor = receivables.reduce((sum, row) => sum + row.amountMinor, 0);
  if (!receivables.length || amountMinor <= 0)
    throw fail(409, "لا يوجد رصيد مستحق قابل للتسوية في هذا السوق.", "NO_OUTSTANDING_COMMISSION");
  if (!Number.isSafeInteger(amountMinor) || amountMinor > MAX_MINOR_UNITS)
    throw fail(409, "تجاوز الرصيد الحد الآمن للتسوية في هذا السوق؛ تواصل مع دعم جاسم.", "SETTLEMENT_AMOUNT_LIMIT");
  if (
    receivables.some(
      (row) =>
        row.currencyCode !== input.market.currencyCode ||
        row.minorUnitScale !== input.market.minorUnitScale,
    )
  )
    throw fail(409, "تختلف دقة العملة المسجلة؛ راجع دعم جاسم.", "CURRENCY_SNAPSHOT_MISMATCH");

  const now = new Date();
  const [settlement] = await tx
    .insert(courierCommissionSettlements)
    .values({
      id: randomUUID(),
      courierId: input.courierId,
      marketId: input.market.id,
      amountMinor,
      currencyCode: input.market.currencyCode,
      minorUnitScale: input.market.minorUnitScale,
      receivableCount: receivables.length,
      idempotencyKey: input.idempotencyKey,
      mode: "SIMULATION_ONLY",
      simulatedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!settlement) {
    const [raced] = await tx
      .select()
      .from(courierCommissionSettlements)
      .where(
        and(
          eq(courierCommissionSettlements.courierId, input.courierId),
          eq(courierCommissionSettlements.marketId, input.market.id),
          eq(courierCommissionSettlements.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (!raced) throw fail(409, "تعذر تأكيد التسوية التجريبية؛ أعد المحاولة.", "SETTLEMENT_CONFLICT");
    if (
      raced.currencyCode !== input.market.currencyCode ||
      raced.minorUnitScale !== input.market.minorUnitScale
    )
      throw fail(409, "تغيرت بيانات السوق لهذا المفتاح؛ استخدم مفتاحًا جديدًا.", "IDEMPOTENCY_KEY_REUSED");
    return { settlement: raced, idempotent: true };
  }
  await tx
    .update(courierCommissionReceivables)
    .set({ status: "SIMULATION_CLEARED", settlementId: settlement.id, settledAt: now })
    .where(
      and(
        eq(courierCommissionReceivables.courierId, input.courierId),
        eq(courierCommissionReceivables.marketId, input.market.id),
        eq(courierCommissionReceivables.status, "OUTSTANDING"),
        inArray(courierCommissionReceivables.id, receivables.map((row) => row.id)),
      ),
    );
  return { settlement, idempotent: false };
}
