/**
 * Wave 10 fraud signals: observations, not verdicts.
 *
 * A signal records what a rule, a report or an admin noticed. It never changes an account, a
 * listing or a payment by itself. Only a human REVIEW of a signal records an opinion, and even a
 * CONFIRMED or ESCALATED review still applies no sanction — the corrective step goes through the
 * existing moderation, account-status or support paths.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, fraudSignalReviews, fraudSignals } from "@workspace/db";
import { assertAdminActor } from "./admin-authority";

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });

export const FRAUD_SUBJECT_TYPES = ["USER", "LISTING", "ORDER", "MESSAGE", "PAYMENT"] as const;
export type FraudSubjectType = (typeof FRAUD_SUBJECT_TYPES)[number];

/** Rule vocabulary only; an unknown key is rejected instead of stored as free text. */
export const FRAUD_SIGNAL_TYPES = [
  "RAPID_LISTING_CREATION",
  "REPEATED_ORDER_CANCELLATION",
  "OFF_PLATFORM_PAYMENT_REQUEST",
  "DUPLICATE_ACCOUNT_DEVICE",
  "CHARGEBACK_PATTERN",
  "REPORT_CLUSTER",
  "UNUSUAL_PRICE",
  "COUNTERFEIT_HINT",
  "MANUAL_NOTE",
] as const;

export const FRAUD_SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export const FRAUD_SOURCES = ["RULE", "REPORT", "ADMIN", "SYSTEM"] as const;
export const FRAUD_REVIEW_DECISIONS = ["CONFIRMED", "DISMISSED", "ESCALATED"] as const;

export const RecordFraudSignalBody = z
  .object({
    subjectType: z.enum(FRAUD_SUBJECT_TYPES),
    subjectId: z.string().trim().min(1).max(100),
    signalType: z.enum(FRAUD_SIGNAL_TYPES),
    severity: z.enum(FRAUD_SEVERITIES).default("LOW"),
    source: z.enum(FRAUD_SOURCES),
    evidence: z.record(z.string(), z.unknown()).optional(),
    dedupeKey: z.string().trim().min(3).max(120),
  })
  .strict();

type SignalRow = typeof fraudSignals.$inferSelect;
type ReviewRow = typeof fraudSignalReviews.$inferSelect;

export function fraudSignalView(row: SignalRow) {
  return {
    id: row.id,
    subjectType: row.subjectType as FraudSubjectType,
    subjectId: row.subjectId,
    signalType: row.signalType,
    severity: row.severity,
    source: row.source,
    evidence: row.evidence,
    dedupeKey: row.dedupeKey,
    observedAt: row.observedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    /** A signal is context for a human decision; it is never an enforced status. */
    enforcement: "NONE" as const,
  };
}

export function fraudReviewView(row: ReviewRow) {
  const nextStep =
    row.decision === "CONFIRMED"
      ? "SIGNAL_CONFIRMED_NO_AUTOMATIC_ACTION"
      : row.decision === "DISMISSED"
        ? "FALSE_POSITIVE_DISMISSED"
        : "REFERRED_TO_HUMAN_REVIEW";
  return {
    id: row.id,
    signalId: row.signalId,
    decision: row.decision,
    note: row.note,
    reviewerId: row.reviewerId,
    createdAt: row.createdAt.toISOString(),
    nextStep,
    appliedSanction: null,
  };
}

/** Idempotent on (subject, dedupeKey): the same observation is stored once. */
export async function recordFraudSignal(
  input: z.infer<typeof RecordFraudSignalBody> & { createdBy?: string | null },
) {
  const [inserted] = await db
    .insert(fraudSignals)
    .values({
      id: randomUUID(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      signalType: input.signalType,
      severity: input.severity,
      source: input.source,
      evidence: input.evidence ?? {},
      dedupeKey: input.dedupeKey,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { duplicate: false as const, signal: fraudSignalView(inserted) };
  const [existing] = await db
    .select()
    .from(fraudSignals)
    .where(
      and(
        eq(fraudSignals.subjectType, input.subjectType),
        eq(fraudSignals.subjectId, input.subjectId),
        eq(fraudSignals.dedupeKey, input.dedupeKey),
      ),
    );
  if (!existing) throw fail(409, "تعذر تسجيل الإشارة", "SIGNAL_CONFLICT");
  return { duplicate: true as const, signal: fraudSignalView(existing) };
}

export const ReviewFraudSignalBody = z
  .object({
    decision: z.enum(FRAUD_REVIEW_DECISIONS),
    note: z.string().trim().min(5).max(2000),
  })
  .strict();

/**
 * One human review per signal. The review records an opinion; it never applies a sanction, so a
 * false positive costs nothing and a confirmed signal still needs a separate, attributed action.
 */
export async function reviewFraudSignal(adminId: string, signalId: string, body: z.infer<typeof ReviewFraudSignalBody>) {
  await assertAdminActor(adminId);
  return db.transaction(async (tx) => {
    const [signal] = await tx.select().from(fraudSignals).where(eq(fraudSignals.id, signalId)).for("update");
    if (!signal) throw fail(404, "الإشارة غير موجودة", "SIGNAL_NOT_FOUND");
    const [existing] = await tx.select().from(fraudSignalReviews).where(eq(fraudSignalReviews.signalId, signal.id));
    if (existing) throw fail(409, "تمت مراجعة هذه الإشارة بالفعل", "SIGNAL_ALREADY_REVIEWED");
    const [review] = await tx
      .insert(fraudSignalReviews)
      .values({ id: randomUUID(), signalId: signal.id, reviewerId: adminId, decision: body.decision, note: body.note })
      .returning();
    return { signal: fraudSignalView(signal), review: fraudReviewView(review!) };
  });
}

export async function fraudSignalsFor(query: { subjectType?: string; subjectId?: string; limit?: number }) {
  const rows = await db
    .select()
    .from(fraudSignals)
    .where(
      and(
        ...(query.subjectType ? [eq(fraudSignals.subjectType, query.subjectType)] : []),
        ...(query.subjectId ? [eq(fraudSignals.subjectId, query.subjectId)] : []),
      ),
    )
    .orderBy(desc(fraudSignals.observedAt))
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
  const reviews = rows.length
    ? await db.select().from(fraudSignalReviews).where(inArray(fraudSignalReviews.signalId, rows.map((row) => row.id)))
    : [];
  const bySignal = new Map(reviews.map((row) => [row.signalId, row]));
  return rows.map((row) => ({
    ...fraudSignalView(row),
    review: bySignal.has(row.id) ? fraudReviewView(bySignal.get(row.id)!) : null,
  }));
}

export async function fraudOverview() {
  const rows = await db.select().from(fraudSignals).orderBy(desc(fraudSignals.observedAt)).limit(200);
  const reviews = rows.length
    ? await db.select().from(fraudSignalReviews).where(inArray(fraudSignalReviews.signalId, rows.map((row) => row.id)))
    : [];
  const reviewed = new Set(reviews.map((row) => row.signalId));
  const bySeverity: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  for (const row of rows) bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + 1;
  return {
    total: rows.length,
    unreviewed: rows.filter((row) => !reviewed.has(row.id)).length,
    bySeverity,
    byDecision: reviews.reduce<Record<string, number>>((acc, row) => {
      acc[row.decision] = (acc[row.decision] ?? 0) + 1;
      return acc;
    }, {}),
    /** Signals never sanction on their own, even after review. */
    automaticEnforcement: false,
    latest: rows.slice(0, 20).map((row) => ({
      ...fraudSignalView(row),
      review: reviewed.has(row.id) ? reviews.find((review) => review.signalId === row.id)!.decision : null,
    })),
  };
}
