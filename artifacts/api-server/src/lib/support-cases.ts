/**
 * Wave 10 human support cases.
 *
 * A case is a user's own thread with the support team: RBAC separates the owner (their cases only,
 * no internal notes, no assignment) from ADMIN staff (every case, internal notes, assignment,
 * status changes). Messages are append-only, a closed case cannot reopen or receive user replies,
 * and a reply from staff notifies the user without ever blocking the reply itself.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, supportCaseEvents, supportCaseMessages, supportCases, users } from "@workspace/db";
import { assertAdminActor } from "./admin-authority";
import { notifyUserAfterDecision } from "./notifications";
import { responseTargetHours, responseTiming } from "./response-targets";

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });

export const SUPPORT_CATEGORIES = ["ORDER", "PAYMENT", "ACCOUNT", "SAFETY", "TECHNICAL", "DATA", "OTHER"] as const;
export const SUPPORT_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const SUPPORT_STATUSES = ["OPEN", "AWAITING_USER", "AWAITING_STAFF", "RESOLVED", "CLOSED"] as const;
type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  OPEN: "مستلمة",
  AWAITING_USER: "بانتظار ردّك",
  AWAITING_STAFF: "بانتظار فريق الدعم",
  RESOLVED: "تم الحل",
  CLOSED: "مغلقة",
};

/** A replying user sends the case back to staff; staff replies send it back to the user. */
const STAFF_TRANSITIONS: Record<SupportStatus, readonly SupportStatus[]> = {
  OPEN: ["AWAITING_USER", "AWAITING_STAFF", "RESOLVED", "CLOSED"],
  AWAITING_STAFF: ["AWAITING_USER", "RESOLVED", "CLOSED"],
  AWAITING_USER: ["AWAITING_STAFF", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

const isOpenForUserReply = (status: string) => status === "OPEN" || status === "AWAITING_USER" || status === "AWAITING_STAFF";

export const SUPPORT_CASES_PER_DAY_LIMIT = 20;

export const CreateSupportCaseBody = z
  .object({
    category: z.enum(SUPPORT_CATEGORIES),
    subject: z.string().trim().min(3).max(160),
    message: z.string().trim().min(5).max(4000),
  })
  .strict();

type CaseRow = typeof supportCases.$inferSelect;
type MessageRow = typeof supportCaseMessages.$inferSelect;
type EventRow = typeof supportCaseEvents.$inferSelect;

export function supportCaseView(row: CaseRow) {
  return {
    id: row.id,
    userId: row.userId,
    marketId: row.marketId,
    category: row.category,
    subject: row.subject,
    status: row.status as SupportStatus,
    statusLabel: SUPPORT_STATUS_LABELS[row.status as SupportStatus] ?? row.status,
    priority: row.priority,
    assignedTo: row.assignedTo,
    lastMessageAt: row.lastMessageAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function messageView(row: MessageRow, staff: boolean) {
  return {
    id: row.id,
    authorKind: row.authorKind,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    // Internal staff notes never reach the case owner.
    ...(staff ? { internal: row.internal, authorId: row.authorId } : {}),
  };
}

function eventView(row: EventRow) {
  return {
    id: row.id,
    actorKind: row.actorKind,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Staleness is a reporting flag for staff, never an automatic close. */
export function supportStaleHours(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.DINAR_SUPPORT_STALE_HOURS ?? 72);
  return Number.isInteger(hours) && hours >= 1 && hours <= 720 ? hours : 72;
}

export async function createSupportCase(userId: string, body: z.infer<typeof CreateSupportCaseBody>) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ marketId: users.activeMarketId }).from(users).where(eq(users.id, userId));
    if (!user) throw fail(401, "سجّل الدخول للمتابعة");
    if (!user.marketId) throw fail(409, "حدد سوقك قبل فتح طلب دعم", "MARKET_REQUIRED");
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(supportCases)
      .where(and(eq(supportCases.userId, userId), gte(supportCases.createdAt, sql`now() - interval '24 hours'`)));
    if (count >= SUPPORT_CASES_PER_DAY_LIMIT) throw fail(429, "وصلت إلى الحد اليومي لطلبات الدعم. حاول غدًا.", "SUPPORT_LIMIT");
    const now = new Date();
    const [row] = await tx
      .insert(supportCases)
      .values({
        id: randomUUID(),
        userId,
        marketId: user.marketId,
        category: body.category,
        subject: body.subject,
        status: "OPEN",
        priority: "NORMAL",
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(supportCaseMessages).values({
      id: randomUUID(),
      caseId: row!.id,
      authorKind: "USER",
      authorId: userId,
      body: body.message,
      internal: false,
      createdAt: now,
    });
    await tx.insert(supportCaseEvents).values({
      id: randomUUID(),
      caseId: row!.id,
      actorKind: "USER",
      actorId: userId,
      fromStatus: null,
      toStatus: "OPEN",
      note: null,
      createdAt: now,
    });
    return supportCaseView(row!);
  });
}

export async function ownSupportCases(userId: string) {
  const rows = await db.select().from(supportCases).where(eq(supportCases.userId, userId)).orderBy(asc(supportCases.createdAt)).limit(100);
  return rows.map(supportCaseView);
}

/** Wrong-user access is a uniform 404: a case id never confirms another user's case exists. */
export async function getSupportCase(actor: { id: string; role: string }, caseId: string) {
  const staff = actor.role === "ADMIN";
  const [row] = await db
    .select()
    .from(supportCases)
    .where(and(eq(supportCases.id, caseId), ...(staff ? [] : [eq(supportCases.userId, actor.id)])));
  if (!row) throw fail(404, "طلب الدعم غير موجود");
  const messages = await db
    .select()
    .from(supportCaseMessages)
    .where(and(eq(supportCaseMessages.caseId, row.id), ...(staff ? [] : [eq(supportCaseMessages.internal, false)])))
    .orderBy(asc(supportCaseMessages.createdAt));
  const events = staff
    ? await db.select().from(supportCaseEvents).where(eq(supportCaseEvents.caseId, row.id)).orderBy(asc(supportCaseEvents.createdAt))
    : [];
  return {
    case: supportCaseView(row),
    messages: messages.map((message) => messageView(message, staff)),
    events: events.map(eventView),
  };
}

export async function addUserSupportMessage(userId: string, caseId: string, body: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(supportCases)
      .where(and(eq(supportCases.id, caseId), eq(supportCases.userId, userId)))
      .for("update");
    if (!row) throw fail(404, "طلب الدعم غير موجود");
    if (!isOpenForUserReply(row.status)) throw fail(409, "هذا الطلب مغلق أو محلول؛ افتح طلبًا جديدًا إن احتجت.", "CASE_CLOSED");
    const now = new Date();
    const [message] = await tx
      .insert(supportCaseMessages)
      .values({ id: randomUUID(), caseId: row.id, authorKind: "USER", authorId: userId, body, internal: false, createdAt: now })
      .returning();
    const next: SupportStatus = row.status === "OPEN" || row.status === "AWAITING_USER" ? "AWAITING_STAFF" : (row.status as SupportStatus);
    await tx.update(supportCases).set({ status: next, lastMessageAt: now, updatedAt: now }).where(eq(supportCases.id, row.id));
    if (next !== row.status) {
      await tx.insert(supportCaseEvents).values({
        id: randomUUID(),
        caseId: row.id,
        actorKind: "USER",
        actorId: userId,
        fromStatus: row.status,
        toStatus: next,
        note: null,
        createdAt: now,
      });
    }
    return { case: supportCaseView({ ...row, status: next, lastMessageAt: now, updatedAt: now }), message: messageView(message!, false) };
  });
}

export const StaffReplyBody = z
  .object({
    body: z.string().trim().min(1).max(4000),
    internal: z.boolean().default(false),
  })
  .strict();

export async function staffReplyToSupportCase(adminId: string, caseId: string, body: z.infer<typeof StaffReplyBody>) {
  await assertAdminActor(adminId);
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(supportCases).where(eq(supportCases.id, caseId)).for("update");
    if (!row) throw fail(404, "طلب الدعم غير موجود");
    if (row.status === "CLOSED") throw fail(409, "الطلب مغلق ولا يقبل ردودًا جديدة", "CASE_CLOSED");
    const now = new Date();
    const [message] = await tx
      .insert(supportCaseMessages)
      .values({ id: randomUUID(), caseId: row.id, authorKind: "STAFF", authorId: adminId, body: body.body, internal: body.internal, createdAt: now })
      .returning();
    // An internal note is invisible to the owner, so it must not move the conversation state.
    const next: SupportStatus = body.internal ? (row.status as SupportStatus) : "AWAITING_USER";
    await tx.update(supportCases).set({ status: next, lastMessageAt: now, updatedAt: now }).where(eq(supportCases.id, row.id));
    if (next !== row.status) {
      await tx.insert(supportCaseEvents).values({
        id: randomUUID(),
        caseId: row.id,
        actorKind: "STAFF",
        actorId: adminId,
        fromStatus: row.status,
        toStatus: next,
        note: null,
        createdAt: now,
      });
    }
    return { case: supportCaseView({ ...row, status: next, lastMessageAt: now, updatedAt: now }), message: messageView(message!, true) };
  });
  if (!body.internal) notifyUserAfterDecision({ recipientId: result.case.userId, templateKey: "SUPPORT_CASE_UPDATED", data: { caseId: result.case.id, status: result.case.status } });
  return result;
}

export const AssignSupportCaseBody = z.object({ staffId: z.string().trim().min(1).max(100) }).strict();

export async function assignSupportCase(adminId: string, caseId: string, staffId: string) {
  await assertAdminActor(adminId);
  return db.transaction(async (tx) => {
    const [staff] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, staffId));
    if (!staff || staff.role !== "ADMIN") throw fail(400, "التعيين متاح لحساب إداري فقط", "STAFF_REQUIRED");
    const [row] = await tx.select().from(supportCases).where(eq(supportCases.id, caseId)).for("update");
    if (!row) throw fail(404, "طلب الدعم غير موجود");
    if (row.status === "CLOSED") throw fail(409, "لا يمكن تعيين طلب مغلق", "CASE_CLOSED");
    const now = new Date();
    const [updated] = await tx.update(supportCases).set({ assignedTo: staffId, updatedAt: now }).where(eq(supportCases.id, row.id)).returning();
    await tx.insert(supportCaseEvents).values({
      id: randomUUID(),
      caseId: row.id,
      actorKind: "STAFF",
      actorId: adminId,
      fromStatus: row.status,
      toStatus: row.status,
      note: "ASSIGNED",
      createdAt: now,
    });
    return supportCaseView(updated!);
  });
}

export const SupportStatusBody = z
  .object({ status: z.enum(SUPPORT_STATUSES), note: z.string().trim().min(3).max(2000).optional() })
  .strict();

export async function transitionSupportCase(adminId: string, caseId: string, body: z.infer<typeof SupportStatusBody>) {
  await assertAdminActor(adminId);
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(supportCases).where(eq(supportCases.id, caseId)).for("update");
    if (!row) throw fail(404, "طلب الدعم غير موجود");
    const from = row.status as SupportStatus;
    if (!STAFF_TRANSITIONS[from].includes(body.status)) throw fail(409, `لا يمكن نقل الطلب من «${SUPPORT_STATUS_LABELS[from]}» إلى هذه الحالة.`, "INVALID_TRANSITION");
    const now = new Date();
    const closed = body.status === "RESOLVED" || body.status === "CLOSED";
    const [updated] = await tx
      .update(supportCases)
      .set({ status: body.status, closedAt: closed ? row.closedAt ?? now : null, updatedAt: now })
      .where(eq(supportCases.id, row.id))
      .returning();
    await tx.insert(supportCaseEvents).values({
      id: randomUUID(),
      caseId: row.id,
      actorKind: "STAFF",
      actorId: adminId,
      fromStatus: from,
      toStatus: body.status,
      note: body.note ?? null,
      createdAt: now,
    });
    return supportCaseView(updated!);
  });
  notifyUserAfterDecision({ recipientId: result.userId, templateKey: "SUPPORT_CASE_UPDATED", data: { caseId: result.id, status: result.status } });
  return result;
}

/** Staff queue: oldest activity first, closed cases excluded, staleness flagged but never auto-closed. */
export async function supportQueue() {
  const rows = await db.select().from(supportCases).where(ne(supportCases.status, "CLOSED")).orderBy(asc(supportCases.lastMessageAt)).limit(100);
  const targetHours = responseTargetHours("DINAR_SUPPORT_RESPONSE_HOURS");
  const staleHours = supportStaleHours();
  const now = new Date();
  return rows.map((row) => {
    const timing = responseTiming(row.createdAt, row.status !== "RESOLVED", targetHours, now);
    const hoursSinceActivity = Math.floor((now.getTime() - row.lastMessageAt.getTime()) / 3_600_000);
    return {
      ...supportCaseView(row),
      ...timing,
      stale: row.status === "AWAITING_USER" && hoursSinceActivity >= staleHours,
    };
  });
}

export async function queuedSupportStatus() {
  const rows = await db.select({ status: supportCases.status }).from(supportCases);
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
}
