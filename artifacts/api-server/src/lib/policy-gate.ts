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
import type { PolicyDocument } from "./policies";
import { recordPolicyDecision, requiredAcceptanceVersions } from "./policy-lifecycle";

type Tx = Pick<typeof db, "select" | "insert">;

/** The current versions this user has not accepted yet (empty when nothing is pending). */
export async function pendingPolicyAcceptances(userId: string, tx: Tx = db): Promise<PolicyDocument[]> {
  // Integration: the required versions are W09's (registry PUBLISHED version, else the wording's).
  const required = (await requiredAcceptanceVersions(tx)).map(({ document, version }) => ({ ...document, version }));
  if (!required.length) return [];
  const accepted = await tx
    .select({ key: policyAcceptances.policyKey, version: policyAcceptances.policyVersion })
    .from(policyAcceptances)
    .where(and(eq(policyAcceptances.userId, userId), inArray(policyAcceptances.policyKey, required.map((policy) => policy.key))));
  return required.filter((policy) => !accepted.some((row) => row.key === policy.key && row.version === policy.version));
}

export const POLICY_REACCEPTANCE_MESSAGE =
  "حُدّثت شروط جاسم أو سياسة الخصوصية. راجع النسخة الحالية ووافق عليها قبل النشر أو الشراء؛ يمكنك متابعة المحادثة العامة.";

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
  const current = new Map((await requiredAcceptanceVersions(tx)).map(({ document, version }) => [document.key, version]));
  const stale = reviewed.some((item) => current.get(item.key) !== item.version);
  if (stale) return { accepted: [], stale: true };
  // Integration: recorded through the W09 consent authority, so every card acceptance has the
  // same hashed consent event as an API acceptance (and the policy_acceptances row it writes).
  for (const item of reviewed)
    await recordPolicyDecision({
      userId,
      key: item.key,
      version: item.version,
      decision: "ACCEPTED",
      source: "POLICY_REVIEW",
      idempotencyKey: `policy-card:${item.key}:${item.version}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128),
    });
  return { accepted: [...reviewed], stale: false };
}
