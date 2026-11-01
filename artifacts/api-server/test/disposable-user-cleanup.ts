import { inArray } from "drizzle-orm";
import { db, policyConsentEvents, users } from "@workspace/db";

/**
 * Test cleanup after W09: signup writes append-only policy consent evidence that references the
 * account, so such accounts are never hard-deleted (the disposable database is dropped with
 * them). Accounts without evidence are deleted as before. Returns how many were kept.
 */
export async function deleteDisposableUsers(userIds: readonly string[]): Promise<number> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return 0;
  const evidenced = new Set(
    (await db.select({ userId: policyConsentEvents.userId }).from(policyConsentEvents).where(inArray(policyConsentEvents.userId, ids))).map((row) => row.userId),
  );
  const deletable = ids.filter((id) => !evidenced.has(id));
  if (deletable.length) await db.delete(users).where(inArray(users.id, deletable));
  return evidenced.size;
}
