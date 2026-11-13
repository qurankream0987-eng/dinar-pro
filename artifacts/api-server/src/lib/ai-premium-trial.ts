/**
 * One-time premium-model trial entitlement. Grant markers and consumption live in the
 * canonical ai_usage_counters / ai_usage_reservations tables; this is not a billing ledger.
 */
import { aiUsageCounters, db } from "@workspace/db";

export const PREMIUM_TRIAL_MESSAGE_LIMIT = 15;
export const PREMIUM_TRIAL_PERIOD_START = new Date("1970-01-01T00:00:00.000Z");
export const PREMIUM_TRIAL_PERIOD_END = new Date("9999-12-31T00:00:00.000Z");

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Signup-only marker. The counter primary key makes a repeated grant a no-op. */
export async function grantPremiumTrialAtSignup(tx: Tx, userId: string, now = new Date()) {
  await tx
    .insert(aiUsageCounters)
    .values({
      ownerKey: `user:${userId}`,
      periodStart: PREMIUM_TRIAL_PERIOD_START,
      resource: "ALL",
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Paid trial use is intentionally off unless all deployment approvals and an exact model
 * selection are configured. Price approval and the platform cap are checked transactionally
 * by the canonical AI spend hold before the provider can be called.
 */
export function premiumTrialDeploymentAuthorized(
  env: NodeJS.ProcessEnv,
  policy: { approved: boolean; spend: { global: { limitMicros: number | null } } },
  model: { provider: string; model: string } | undefined,
): boolean {
  const deployment = env.DINAR_DEPLOYMENT_ENV?.trim().toLowerCase();
  return Boolean(
    env.DINAR_PREMIUM_TRIAL_ENABLED === "true" &&
      env.DINAR_PREMIUM_TRIAL_DEPLOYMENT_AUTHORIZED === "true" &&
      (deployment === "staging" || deployment === "production") &&
      (env.REPLIT_DEPLOYMENT !== undefined || env.RAILWAY_ENVIRONMENT !== undefined) &&
      policy.approved &&
      policy.spend.global.limitMicros !== null &&
      model &&
      env.DINAR_PREMIUM_TRIAL_PROVIDER === model.provider &&
      env.DINAR_PREMIUM_TRIAL_MODEL === model.model,
  );
}
