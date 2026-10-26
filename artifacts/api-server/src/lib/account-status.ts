import { db, sessions, users } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Account enforcement states.
 *
 * ACTIVE      full marketplace access.
 * RESTRICTED  may sign in, read history and finish existing orders, but may
 *             not publish, edit, resume, or start new purchases. Listings are
 *             hidden from discovery because search requires an ACTIVE seller.
 * SUSPENDED   no session is accepted; existing sessions are revoked.
 * DEACTIVATED the account was deleted by its owner; terminal and anonymized.
 */
export const ACCOUNT_STATUS = {
  active: "ACTIVE",
  restricted: "RESTRICTED",
  suspended: "SUSPENDED",
  deactivated: "DEACTIVATED",
} as const;

export type AccountStatus =
  (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

/** Statuses whose sessions are honoured by the session middleware. */
export const SESSION_STATUSES: readonly string[] = [
  ACCOUNT_STATUS.active,
  ACCOUNT_STATUS.restricted,
];

export function canHoldSession(status: string): boolean {
  return SESSION_STATUSES.includes(status);
}

const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

/**
 * New commerce (publishing, editing public content, buying) requires ACTIVE.
 * Reads the row inside the caller's transaction so a concurrent moderation
 * action cannot be bypassed with a stale session actor.
 */
export async function assertAccountCanTransact(userId: string, tx: any = db) {
  const [row] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .for("share");
  if (!row || row.status !== ACCOUNT_STATUS.active)
    throw fail(
      403,
      "حسابك مقيّد حاليًا. يمكنك متابعة طلباتك القائمة، ولا يمكن بدء عمليات بيع أو شراء جديدة.",
    );
}

export async function revokeUserSessions(userId: string, tx: any = db) {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}
