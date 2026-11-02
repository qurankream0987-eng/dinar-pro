/**
 * D12 — an executing action must never stay "in progress" forever.
 *
 * confirmPendingAction commits the EXECUTING claim before the domain authority runs, so a
 * process that dies in between leaves a ledger row nobody can settle. The lease is the time
 * one execution is allowed to take. After it the row is settled as UNKNOWN — never as a
 * success or a failure, because the authority may have committed before the result was
 * recorded. Nothing is re-executed: the user opens a new review instead.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { aiResultSets, db } from "@workspace/db";

/** Longer than any single action authority runs; short enough that a crash is not permanent. */
export const ACTION_EXECUTION_LEASE_MS = 2 * 60 * 1000;

export const EXECUTION_UNKNOWN_NOTICE =
  "انقطع تأكيد التنفيذ قبل أن تُسجَّل نتيجته، فلم يتأكد حدوثه ولم يُعَد تنفيذه. راجع سجل الطلبات أو المحادثة قبل المحاولة من جديد.";

/** The only ledger kinds whose query carries an action status and an execution lease. */
const EXECUTION_KIND_SQL = sql.raw(`('ACTION', 'BUSINESS_ACTION', 'BUSINESS_SETUP')`);

type LedgerQueryLike = { status?: unknown; executingAt?: unknown; expiresAt?: unknown };

function claimedAt(query: LedgerQueryLike): number | undefined {
  const parsed = typeof query.executingAt === "string" ? Date.parse(query.executingAt) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * True only for an EXECUTING row whose lease is over. A claim written before the lease
 * existed has no executingAt; it is stale once its own confirmation window and one lease
 * have passed — an execution cannot still be running that long after its review expired.
 */
export function executionLeaseExpired(row: { expiresAt: Date | null; query: LedgerQueryLike }, now = Date.now()): boolean {
  if (row.query.status !== "EXECUTING") return false;
  const started = claimedAt(row.query);
  if (started !== undefined) return started + ACTION_EXECUTION_LEASE_MS <= now;
  const queryExpiry = typeof row.query.expiresAt === "string" ? Date.parse(row.query.expiresAt) : NaN;
  const expiry = row.expiresAt?.getTime() ?? (Number.isFinite(queryExpiry) ? queryExpiry : undefined);
  return expiry !== undefined && expiry + ACTION_EXECUTION_LEASE_MS <= now;
}

/**
 * Settles abandoned executions in bounded batches. A row is written only while it is still
 * EXECUTING and still carries the claim that was read, so a concurrent completion wins and a
 * live execution is never taken over. Returns how many rows were settled.
 */
export async function settleAbandonedExecutions(input: { now?: Date; limit?: number } = {}): Promise<number> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await db
    .select({ id: aiResultSets.id, expiresAt: aiResultSets.expiresAt, query: aiResultSets.query })
    .from(aiResultSets)
    .where(and(
      sql`${aiResultSets.query} ->> 'status' = 'EXECUTING'`,
      sql`${aiResultSets.query} ->> 'kind' in ${EXECUTION_KIND_SQL}`,
    ))
    .orderBy(asc(aiResultSets.createdAt))
    .limit(limit);
  let settled = 0;
  for (const row of rows) {
    const query = row.query as LedgerQueryLike;
    if (!executionLeaseExpired({ expiresAt: row.expiresAt, query }, now.getTime())) continue;
    const claim = typeof query.executingAt === "string" ? query.executingAt : null;
    const updated = await db
      .update(aiResultSets)
      .set({ query: { ...row.query, status: "UNKNOWN", notice: EXECUTION_UNKNOWN_NOTICE } })
      .where(and(
        eq(aiResultSets.id, row.id),
        sql`${aiResultSets.query} ->> 'status' = 'EXECUTING'`,
        sql`${aiResultSets.query} ->> 'executingAt' is not distinct from ${claim}`,
      ))
      .returning({ id: aiResultSets.id });
    settled += updated.length;
  }
  return settled;
}
