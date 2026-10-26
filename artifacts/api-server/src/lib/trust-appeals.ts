/**
 * DINAR NEXT pre-integration: fair-process tools around existing trust decisions.
 *
 * - Dispute evidence: both parties of a disputed order may add bounded text statements while
 *   the dispute is open (the opener's evidence already exists; the other side gets its voice).
 * - Appeals: the affected party may appeal one decision — a listing moderation, their account
 *   restriction, a report outcome they filed, or a dispute resolution — once at a time. A human
 *   decides with a recorded reason, by default someone other than the original decider. An
 *   OVERTURNED appeal records the outcome only: the corrective change is applied through the
 *   existing authority (moderation, account status, dispute accounting), never automatically,
 *   so no money or commission rule moves from here.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, disputes, marketplaceReports, messages, moderationAudit, offers, orders, trustAppealEvents, trustAppeals, users } from "@workspace/db";
import { logger } from "./logger";
import { notifyUserAfterDecision } from "./notifications";
import { responseTargetHours, responseTiming } from "./response-targets";

const fail = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });

export const APPEAL_SUBJECTS = ["LISTING_MODERATION", "ACCOUNT_STATUS", "REPORT_DECISION", "DISPUTE_RESOLUTION"] as const;
type Subject = (typeof APPEAL_SUBJECTS)[number];
type Status = "SUBMITTED" | "UNDER_REVIEW" | "UPHELD" | "OVERTURNED" | "WITHDRAWN";
const TRANSITIONS: Record<Status, readonly Status[]> = {
  SUBMITTED: ["UNDER_REVIEW", "UPHELD", "OVERTURNED", "WITHDRAWN"],
  UNDER_REVIEW: ["UPHELD", "OVERTURNED", "WITHDRAWN"],
  UPHELD: [],
  OVERTURNED: [],
  WITHDRAWN: [],
};
export const APPEAL_STATUS_LABELS: Record<Status, string> = {
  SUBMITTED: "مستلم",
  UNDER_REVIEW: "قيد المراجعة",
  UPHELD: "أُيّد القرار",
  OVERTURNED: "أُلغي القرار",
  WITHDRAWN: "مسحوب",
};

/** Independent review is the default; a one-person team may relax it explicitly. */
const independentReview = () => process.env.DINAR_APPEALS_REQUIRE_DIFFERENT_REVIEWER !== "false";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who may appeal what: the affected party only, and only a decision that was actually made. */
async function appealable(tx: Tx, actorId: string, subject: Subject, subjectId: string): Promise<{ marketId: string | null; deciderId: string | null }> {
  const auditDecider = async (targetType: string) => {
    const [row] = await tx
      .select({ actorId: moderationAudit.actorId })
      .from(moderationAudit)
      .where(and(eq(moderationAudit.targetType, targetType), eq(moderationAudit.targetId, subjectId), eq(moderationAudit.actorRole, "ADMIN")))
      .orderBy(desc(moderationAudit.createdAt))
      .limit(1);
    return row?.actorId ?? null;
  };
  if (subject === "LISTING_MODERATION") {
    const [listing] = await tx.select({ sellerId: offers.sellerId, status: offers.status, marketId: offers.marketId }).from(offers).where(eq(offers.id, subjectId));
    if (!listing || listing.sellerId !== actorId) throw fail(404, "لا يوجد قرار يخصك بهذا الرقم");
    if (!["MODERATION_HIDDEN", "MODERATION_REMOVED"].includes(listing.status)) throw fail(409, "هذا الإعلان ليس عليه قرار إشراف قائم", "NO_DECISION");
    return { marketId: listing.marketId, deciderId: await auditDecider("LISTING") };
  }
  if (subject === "ACCOUNT_STATUS") {
    if (subjectId !== actorId) throw fail(404, "لا يوجد قرار يخصك بهذا الرقم");
    const [user] = await tx.select({ status: users.status, marketId: users.activeMarketId }).from(users).where(eq(users.id, actorId));
    if (user?.status !== "RESTRICTED") throw fail(409, "حسابك ليس مقيّدًا", "NO_DECISION");
    return { marketId: user.marketId, deciderId: await auditDecider("USER") };
  }
  if (subject === "REPORT_DECISION") {
    const [report] = await tx.select().from(marketplaceReports).where(eq(marketplaceReports.id, subjectId));
    if (!report || report.reporterId !== actorId) throw fail(404, "لا يوجد قرار يخصك بهذا الرقم");
    if (report.status === "OPEN") throw fail(409, "البلاغ لم يُقرر بعد", "NO_DECISION");
    return { marketId: report.marketId, deciderId: report.resolvedBy };
  }
  const [dispute] = await tx.select().from(disputes).where(eq(disputes.id, subjectId));
  const [order] = dispute ? await tx.select({ buyerId: orders.buyerId, sellerId: orders.sellerId, marketId: orders.marketId }).from(orders).where(eq(orders.id, dispute.orderId)) : [];
  if (!dispute || !order || (order.buyerId !== actorId && order.sellerId !== actorId)) throw fail(404, "لا يوجد قرار يخصك بهذا الرقم");
  if (dispute.status !== "RESOLVED") throw fail(409, "النزاع لم يُحسم بعد", "NO_DECISION");
  const [resolution] = await tx
    .select({ senderId: messages.senderId })
    .from(messages)
    .where(and(eq(messages.conversationId, dispute.orderId), eq(messages.contentType, "DISPUTE_RESOLUTION"), sql`${messages.metadata}->>'disputeId' = ${dispute.id}`))
    .limit(1);
  return { marketId: order.marketId, deciderId: resolution?.senderId ?? null };
}

export const AppealBody = z
  .object({
    subjectType: z.enum(APPEAL_SUBJECTS),
    subjectId: z.string().min(1).max(80),
    statement: z.string().trim().min(10).max(2000),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();

type AppealRow = typeof trustAppeals.$inferSelect;
export function appealView(row: AppealRow) {
  return {
    id: row.id,
    subjectType: row.subjectType as Subject,
    subjectId: row.subjectId,
    status: row.status as Status,
    statusLabel: APPEAL_STATUS_LABELS[row.status as Status] ?? row.status,
    statement: row.statement,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    /** An overturned decision is corrected through its own authority, not by this record. */
    ...(row.status === "OVERTURNED" ? { followUp: "تُطبّق الإدارة التصحيح عبر الإجراء المختص (الإشراف أو حالة الحساب أو النزاع)." } : {}),
  };
}

export async function submitAppeal(actorId: string, body: z.infer<typeof AppealBody>) {
  return db.transaction(async (tx) => {
    const [prior] = await tx.select().from(trustAppeals).where(and(eq(trustAppeals.appellantId, actorId), eq(trustAppeals.idempotencyKey, body.idempotencyKey)));
    if (prior) {
      if (prior.subjectType !== body.subjectType || prior.subjectId !== body.subjectId) throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      return appealView(prior);
    }
    const scope = await appealable(tx, actorId, body.subjectType, body.subjectId);
    const now = new Date();
    const [row] = await tx
      .insert(trustAppeals)
      .values({ id: randomUUID(), appellantId: actorId, subjectType: body.subjectType, subjectId: body.subjectId, marketId: scope.marketId, originalDeciderId: scope.deciderId, statement: body.statement, status: "SUBMITTED", idempotencyKey: body.idempotencyKey, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!row) throw fail(409, "لديك طعن مفتوح على هذا القرار بالفعل", "APPEAL_ALREADY_OPEN");
    await tx.insert(trustAppealEvents).values({ id: randomUUID(), appealId: row.id, actorKind: "USER", actorId, fromStatus: null, toStatus: "SUBMITTED", createdAt: now });
    logger.info({ event: "dinar_appeal_submitted", subjectType: body.subjectType }, "appeal submitted");
    return appealView(row);
  });
}

export async function ownAppeals(actorId: string) {
  const rows = await db.select().from(trustAppeals).where(eq(trustAppeals.appellantId, actorId)).orderBy(desc(trustAppeals.createdAt)).limit(50);
  return rows.map(appealView);
}

async function move(appealId: string, to: Status, actor: { kind: "USER" | "ADMIN"; id: string }, note?: string, ownerId?: string) {
  let appellantId = "";
  const view = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(trustAppeals)
      .where(and(eq(trustAppeals.id, appealId), ...(ownerId ? [eq(trustAppeals.appellantId, ownerId)] : [])))
      .for("update");
    if (!row) throw fail(404, "الطعن غير موجود");
    const from = row.status as Status;
    if (!TRANSITIONS[from].includes(to)) throw fail(409, `لا يمكن نقل الطعن من «${APPEAL_STATUS_LABELS[from]}» إلى «${APPEAL_STATUS_LABELS[to]}».`, "INVALID_TRANSITION");
    const deciding = to === "UPHELD" || to === "OVERTURNED";
    if (deciding && actor.kind === "ADMIN") {
      if (actor.id === row.appellantId) throw fail(409, "لا يقرر صاحب الطعن في طعنه", "CONFLICT_OF_INTEREST");
      if (independentReview() && row.originalDeciderId && row.originalDeciderId === actor.id)
        throw fail(409, "يراجع الطعن شخص غير صاحب القرار الأصلي", "INDEPENDENT_REVIEW_REQUIRED");
    }
    const now = new Date();
    const [updated] = await tx
      .update(trustAppeals)
      .set({ status: to, ...(deciding ? { decidedBy: actor.id, decidedAt: now, decisionNote: note!.slice(0, 2000) } : {}), updatedAt: now })
      .where(eq(trustAppeals.id, row.id))
      .returning();
    await tx.insert(trustAppealEvents).values({ id: randomUUID(), appealId: row.id, actorKind: actor.kind, actorId: actor.id, fromStatus: from, toStatus: to, note: note?.slice(0, 2000) ?? null, createdAt: now });
    appellantId = row.appellantId;
    return appealView(updated!);
  });
  if (actor.kind === "ADMIN") notifyUserAfterDecision({ recipientId: appellantId, templateKey: "TRUST_APPEAL_UPDATED", data: { appealId: view.id, status: view.status } });
  return view;
}

export function withdrawAppeal(actorId: string, appealId: string) {
  return move(appealId, "WITHDRAWN", { kind: "USER", id: actorId }, undefined, actorId);
}

export const AppealDecisionBody = z
  .object({ status: z.enum(["UNDER_REVIEW", "UPHELD", "OVERTURNED"]), note: z.string().trim().min(5).max(2000).optional() })
  .strict()
  .refine((body) => body.status === "UNDER_REVIEW" || Boolean(body.note), { message: "a decision needs its reason" });

export function decideAppeal(adminId: string, appealId: string, body: z.infer<typeof AppealDecisionBody>) {
  return move(appealId, body.status, { kind: "ADMIN", id: adminId }, body.note);
}

export async function appealQueue() {
  const rows = await db.select().from(trustAppeals).where(inArray(trustAppeals.status, ["SUBMITTED", "UNDER_REVIEW"])).orderBy(trustAppeals.createdAt).limit(100);
  const targetHours = responseTargetHours("DINAR_APPEAL_RESPONSE_HOURS");
  return rows.map((row) => ({ ...appealView(row), appellantId: row.appellantId, originalDeciderId: row.originalDeciderId, marketId: row.marketId, ...responseTiming(row.createdAt, true, targetHours) }));
}

export const DisputeEvidenceBody = z
  .object({ statement: z.string().trim().min(5).max(1000), reference: z.string().trim().max(300).optional() })
  .strict();
const MAX_EVIDENCE = 20;

/** Either party adds a text statement to an open dispute of their own order. */
export async function addDisputeEvidence(actorId: string, orderId: string, body: z.infer<typeof DisputeEvidenceBody>) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ buyerId: orders.buyerId, sellerId: orders.sellerId }).from(orders).where(eq(orders.id, orderId));
    if (!order || (order.buyerId !== actorId && order.sellerId !== actorId)) throw fail(404, "الطلب غير موجود");
    const [dispute] = await tx.select().from(disputes).where(and(eq(disputes.orderId, orderId), eq(disputes.status, "OPEN"))).for("update");
    if (!dispute) throw fail(409, "لا يوجد نزاع مفتوح على هذا الطلب", "NO_OPEN_DISPUTE");
    const evidence = Array.isArray(dispute.evidence) ? (dispute.evidence as unknown[]) : [];
    if (evidence.length >= MAX_EVIDENCE) throw fail(409, "بلغ النزاع الحد الأقصى من الأدلة؛ ستراجعه الإدارة كما هو.", "EVIDENCE_LIMIT");
    const entry = {
      type: "TEXT",
      reference: body.reference ? `${body.statement} — ${body.reference}` : body.statement,
      submittedBy: actorId,
      submittedRole: order.buyerId === actorId ? "BUYER" : "SELLER",
      createdAt: new Date().toISOString(),
    };
    await tx.update(disputes).set({ evidence: [...evidence, entry], updatedAt: new Date() }).where(eq(disputes.id, dispute.id));
    return { disputeId: dispute.id, evidenceCount: evidence.length + 1, entry: { type: entry.type, submittedRole: entry.submittedRole, createdAt: entry.createdAt } };
  });
}
