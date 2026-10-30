/**
 * Contract acceptance before commerce (W02-ULTRA B10). A user whose accepted versions of the
 * policies that require acceptance (lib/policies.ts) are not the current ones may keep chatting,
 * but may not publish a listing or place an order until they accept the current versions.
 *
 * Contract acceptance (policy_acceptances) is separate from optional privacy consents
 * (privacy_consent_events): nothing here grants or withdraws an optional consent.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, policyAcceptances } from "@workspace/db";
import { registrationAcceptancePolicies, type PolicyDocument } from "./policies";

type Tx = Pick<typeof db, "select" | "insert">;

/** The current versions this user has not accepted yet (empty when nothing is pending). */
export async function pendingPolicyAcceptances(userId: string, tx: Tx = db): Promise<PolicyDocument[]> {
  const required = registrationAcceptancePolicies();
  if (!required.length) return [];
  const accepted = await tx
    .select({ key: policyAcceptances.policyKey, version: policyAcceptances.policyVersion })
    .from(policyAcceptances)
    .where(and(eq(policyAcceptances.userId, userId), inArray(policyAcceptances.policyKey, required.map((policy) => policy.key))));
  return required.filter((policy) => !accepted.some((row) => row.key === policy.key && row.version === policy.version));
}

export const POLICY_REACCEPTANCE_MESSAGE =
  "حُدّثت شروط DINAR أو سياسة الخصوصية. راجع النسخة الحالية ووافق عليها قبل النشر أو الشراء؛ يمكنك متابعة المحادثة العامة.";

/** Refuses a contract action while a required current version is unaccepted (exposed 409). */
export async function assertPoliciesAccepted(userId: string, tx: Tx = db): Promise<void> {
  const pending = await pendingPolicyAcceptances(userId, tx);
  if (!pending.length) return;
  throw Object.assign(new Error(POLICY_REACCEPTANCE_MESSAGE), {
    status: 409,
    expose: true,
    code: "POLICY_REACCEPTANCE_REQUIRED",
    pending: pending.map((policy) => ({ key: policy.key, version: policy.version })),
  });
}

/**
 * Records acceptance of exactly the versions the user reviewed, and only while they are still
 * current: a version that changed after the review is not accepted on the old one's behalf.
 */
export async function acceptReviewedPolicies(
  userId: string,
  reviewed: ReadonlyArray<{ key: string; version: string }>,
  tx: Tx = db,
): Promise<{ accepted: Array<{ key: string; version: string }>; stale: boolean }> {
  const current = new Map(registrationAcceptancePolicies().map((policy) => [policy.key, policy.version]));
  const stale = reviewed.some((item) => current.get(item.key) !== item.version);
  if (stale) return { accepted: [], stale: true };
  if (reviewed.length)
    await tx
      .insert(policyAcceptances)
      .values(reviewed.map((item) => ({ userId, policyKey: item.key, policyVersion: item.version })))
      .onConflictDoNothing();
  return { accepted: [...reviewed], stale: false };
}
