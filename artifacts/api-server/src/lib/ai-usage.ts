/**
 * DINAR NEXT G1: server-side AI usage accounting. Every metered AI operation reserves its
 * allowance before the provider is called and is then settled (charged) or released:
 *
 *   reserve ──► SETTLED   (the user got the answer: one request + actual tokens charged)
 *          └──► RELEASED  (provider failure / timeout / invalid output: nothing charged)
 *          └──► EXPIRED   (never settled within the TTL: reconciled as abandoned)
 *
 * A reservation is idempotent per (owner, key): a retry never charges twice. Each counter
 * row is moved by one conditional UPDATE whose WHERE re-checks the limit after the row lock,
 * so concurrent requests near the limit can never overspend it. The global spending guard is
 * a counter of its own, charged conservatively (provider calls that failed still count there).
 * The plan tier is resolved on the server from the live subscription; clients cannot set it.
 * No prompt or reply text is stored.
 */
import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { aiSpendHolds, aiUsageCounters, aiUsageReservations, db } from "@workspace/db";
import { aiPlanFor } from "./business";
import { commercialSignature, getCommercialPolicy } from "./commercial-policy";
import {
  AI_RESOURCE_LABELS,
  AI_TIER_LABELS,
  AI_USAGE_RESOURCES,
  usagePeriod,
  type AiPlanTier,
  type AiUsagePolicy,
  type AiUsageResource,
} from "./ai-usage-policy";
import { logger } from "./logger";
import {
  applicableApprovedPrice,
  holdAiSpend,
  isSpendRefusal,
  isZeroCostTextPrice,
  settleAiSpend,
  type AiCallRecord,
  type AiSpendRefusalReason,
} from "./ai-spend";
import {
  PREMIUM_TRIAL_MESSAGE_LIMIT,
  PREMIUM_TRIAL_PERIOD_START,
  premiumTrialDeploymentAuthorized,
} from "./ai-premium-trial";

type MarketRef = { id: string };
export type AiUsageOwner =
  | { kind: "USER"; userId: string; market: MarketRef }
  | { kind: "GUEST"; guestKey: string; market: MarketRef };
type Reservation = typeof aiUsageReservations.$inferSelect;

export type AiUsageRefusalReason =
  | "NOT_INCLUDED"
  | "USER_ALLOWANCE_EXHAUSTED"
  | "TOKEN_ALLOWANCE_EXHAUSTED"
  | "GLOBAL_BUDGET_EXHAUSTED"
  | "DUPLICATE_IN_FLIGHT"
  | "ALREADY_PROCESSED"
  | "PREMIUM_TRIAL_NOT_AVAILABLE"
  | "PREMIUM_TRIAL_EXHAUSTED"
  | AiSpendRefusalReason;
export type AiUsageReservation = { ok: true; reservation: Reservation; policy: AiUsagePolicy };
export type AiUsageRefusal = { ok: false; reason: AiUsageRefusalReason; resource: AiUsageResource; tier: AiPlanTier; renewsAt: Date };
export type AiUsageOutcome = "SUCCESS" | "PROVIDER_FAILED" | "TIMEOUT" | "INVALID_OUTPUT" | "ABANDONED" | "CANCELLED";
export type AiUsageMeasurement = {
  outcome: AiUsageOutcome;
  /** Provider calls actually made for this operation (a corrective retry is a second call). */
  providerCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  provider?: string;
  model?: string;
  /** Each provider request as it happened (retry, fallback, correction); priced one by one. */
  calls?: AiCallRecord[];
};

export const GLOBAL_OWNER_KEY = "GLOBAL";

export function guestUsageKey(clientIp: string): string {
  return `guest:${commercialSignature("ai-usage-guest", clientIp).slice(0, 32)}`;
}

export function ownerKeyOf(owner: AiUsageOwner): string {
  return owner.kind === "USER" ? `user:${owner.userId}` : owner.guestKey;
}

export async function aiUsagePolicyFor(market: MarketRef): Promise<AiUsagePolicy> {
  return (await getCommercialPolicy(market.id)).aiUsage;
}

async function tierFor(owner: AiUsageOwner) {
  if (owner.kind === "GUEST") return { tier: "GUEST" as const, source: "GUEST" };
  const plan = await aiPlanFor(owner.userId, owner.market);
  return { tier: plan.tier, source: plan.source };
}

class Refused extends Error {
  constructor(readonly reason: AiUsageRefusalReason) {
    super(reason);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Moves one counter row; refuses (throws) when the limit would be exceeded. */
async function moveCounter(
  tx: Tx,
  row: { ownerKey: string; periodStart: Date; resource: string },
  delta: { reservedRequests?: number; reservedTokens?: number; consumedRequests?: number; consumedTokens?: number },
  limits: { requests?: number; tokens?: number } = {},
  refusal: AiUsageRefusalReason = "USER_ALLOWANCE_EXHAUSTED",
) {
  await tx.insert(aiUsageCounters).values(row).onConflictDoNothing();
  const rr = delta.reservedRequests ?? 0;
  const rt = delta.reservedTokens ?? 0;
  const cr = delta.consumedRequests ?? 0;
  const ct = delta.consumedTokens ?? 0;
  const updated = await tx
    .update(aiUsageCounters)
    .set({
      reservedRequests: sql`${aiUsageCounters.reservedRequests} + ${rr}`,
      reservedTokens: sql`${aiUsageCounters.reservedTokens} + ${rt}`,
      consumedRequests: sql`${aiUsageCounters.consumedRequests} + ${cr}`,
      consumedTokens: sql`${aiUsageCounters.consumedTokens} + ${ct}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiUsageCounters.ownerKey, row.ownerKey),
        eq(aiUsageCounters.periodStart, row.periodStart),
        eq(aiUsageCounters.resource, row.resource),
        ...(limits.requests !== undefined ? [sql`${aiUsageCounters.reservedRequests} + ${aiUsageCounters.consumedRequests} + ${rr} <= ${limits.requests}`] : []),
        ...(limits.tokens !== undefined ? [sql`${aiUsageCounters.reservedTokens} + ${aiUsageCounters.consumedTokens} + ${rt} <= ${limits.tokens}`] : []),
      ),
    )
    .returning({ ownerKey: aiUsageCounters.ownerKey });
  if (!updated.length) throw new Refused(refusal);
}

/**
 * Reserves one request of `resource` (and its token estimate) for the owner, the owner's
 * period token budget and the global guard, atomically. Returns a refusal instead of
 * throwing when any allowance would be exceeded, or when the key was already used.
 */
export async function reserveAiUsage(input: {
  owner: AiUsageOwner;
  resource: AiUsageResource;
  idempotencyKey: string;
  now?: Date;
  /** The model about to be called, so an unpriced model can be refused before it costs anything. */
  expectedModel?: { provider: string; model: string };
  /** Every additional model reachable by this operation (for example an explicit fallback). */
  expectedModels?: readonly { provider: string; model: string }[];
  /** Guest inference requires a real provider/contract price even in development. */
  requireApprovedModels?: boolean;
  /** Internal-only: reserve one of the account's one-time premium trial messages. */
  premiumTrial?: boolean;
}): Promise<AiUsageReservation | AiUsageRefusal> {
  const now = input.now ?? new Date();
  const ownerKey = ownerKeyOf(input.owner);
  const commercial = await getCommercialPolicy(input.owner.market.id);
  const policy = commercial.aiUsage;
  const { tier, source } = await tierFor(input.owner);
  const period = usagePeriod(policy.period, now);
  const refusal = (reason: AiUsageRefusalReason): AiUsageRefusal => ({
    ok: false,
    reason,
    resource: input.resource,
    tier,
    renewsAt:
      reason === "GLOBAL_BUDGET_EXHAUSTED"
        ? usagePeriod(policy.globalGuard.period, now).end
        : reason === "GLOBAL_SPEND_EXHAUSTED" || reason === "PLAN_SPEND_EXHAUSTED"
          ? usagePeriod(policy.spend.global.period, now).end
          : period.end,
  });
  if (!/^[A-Za-z0-9._:#-]{4,160}$/.test(input.idempotencyKey)) throw new Error("Invalid AI usage idempotency key");
  await reconcileAbandonedAiReservations({ ownerKey, now });
  const allowance = policy.tiers[tier];
  const requestLimit = allowance.requests[input.resource];
  if (requestLimit <= 0 && !input.premiumTrial) return refusal("NOT_INCLUDED");
  if (
    input.premiumTrial &&
    (input.owner.kind !== "USER" ||
      tier !== "FREE" ||
      input.resource !== "TEXT_REQUEST" ||
      !input.expectedModel ||
      !premiumTrialDeploymentAuthorized(process.env, policy, input.expectedModel))
  )
    return refusal("PREMIUM_TRIAL_NOT_AVAILABLE");
  const estimate = policy.tokenEstimates[input.resource];
  const globalPeriod = usagePeriod(policy.globalGuard.period, now);
  try {
    const reservation = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(aiUsageReservations)
        .where(and(eq(aiUsageReservations.ownerKey, ownerKey), eq(aiUsageReservations.idempotencyKey, input.idempotencyKey)))
        .for("update");
      if (existing?.status === "RESERVED") throw new Refused("DUPLICATE_IN_FLIGHT");
      if (existing?.status === "SETTLED") throw new Refused("ALREADY_PROCESSED");
      // Reserve in a fixed order (resource → owner budget → global) so no two requests deadlock.
      if (input.premiumTrial) {
        const [grant] = await tx
          .select({ ownerKey: aiUsageCounters.ownerKey })
          .from(aiUsageCounters)
          .where(
            and(
              eq(aiUsageCounters.ownerKey, ownerKey),
              eq(aiUsageCounters.periodStart, PREMIUM_TRIAL_PERIOD_START),
              eq(aiUsageCounters.resource, "ALL"),
            ),
          )
          .for("update");
        if (!grant) throw new Refused("PREMIUM_TRIAL_NOT_AVAILABLE");
        await moveCounter(
          tx,
          { ownerKey, periodStart: PREMIUM_TRIAL_PERIOD_START, resource: "ALL" },
          { reservedRequests: 1 },
          { requests: PREMIUM_TRIAL_MESSAGE_LIMIT },
          "PREMIUM_TRIAL_EXHAUSTED",
        );
        const price = await applicableApprovedPrice(input.expectedModel!.provider, [input.expectedModel!.model], now, tx);
        if (!price || isZeroCostTextPrice(price)) throw new Refused("PREMIUM_TRIAL_NOT_AVAILABLE");
      } else {
        if (requestLimit <= 0) throw new Refused("NOT_INCLUDED");
        await moveCounter(tx, { ownerKey, periodStart: period.start, resource: input.resource }, { reservedRequests: 1 }, { requests: requestLimit });
      }
      await moveCounter(tx, { ownerKey, periodStart: period.start, resource: "ALL" }, { reservedTokens: estimate }, { tokens: allowance.tokens }, "TOKEN_ALLOWANCE_EXHAUSTED");
      if (policy.globalGuard.enabled)
        await moveCounter(
          tx,
          { ownerKey: GLOBAL_OWNER_KEY, periodStart: globalPeriod.start, resource: "ALL" },
          { reservedRequests: 1, reservedTokens: estimate },
          { requests: policy.globalGuard.requests, tokens: policy.globalGuard.tokens },
          "GLOBAL_BUDGET_EXHAUSTED",
        );
      const values = {
        ownerKey,
        userId: input.owner.kind === "USER" ? input.owner.userId : null,
        marketId: input.owner.market.id,
        resource: input.resource,
        planTier: tier,
        entitlementSource: source,
        policyVersion: commercial.version,
        periodStart: period.start,
        periodEnd: period.end,
        globalPeriodStart: globalPeriod.start,
        globalGuarded: policy.globalGuard.enabled,
        status: "RESERVED",
        outcome: null,
        premiumTrial: input.premiumTrial === true,
        reservedRequests: 1,
        reservedTokens: estimate,
        chargedRequests: 0,
        chargedTokens: 0,
        providerCalls: 0,
        inputTokens: null,
        outputTokens: null,
        tokenSource: null,
        expiresAt: new Date(now.getTime() + policy.reservationTtlSeconds * 1000),
        settledAt: null,
        updatedAt: now,
      };
      // A released or expired attempt with the same key may run again (a genuine retry).
      const [row] = existing
        ? await tx
            .update(aiUsageReservations)
            .set({ ...values, attempts: existing.attempts + 1 })
            .where(eq(aiUsageReservations.id, existing.id))
            .returning()
        : await tx
            .insert(aiUsageReservations)
            .values({ id: randomUUID(), idempotencyKey: input.idempotencyKey, createdAt: now, ...values })
            .returning();
      // Money is held in the same transaction: a refused hold rolls the allowance back too.
      await holdAiSpend(tx, {
        ownerKey,
        tier,
        purpose: input.resource,
        resource: input.resource,
        policy,
        usageReservationId: row!.id,
        expectedModel: input.expectedModel,
        expectedModels: input.expectedModels,
        requireApprovedModels: input.premiumTrial === true || input.requireApprovedModels,
        now,
      });
      return row!;
    });
    return { ok: true, reservation, policy };
  } catch (error) {
    if (error instanceof Refused || isSpendRefusal(error)) {
      if (error.reason === "GLOBAL_BUDGET_EXHAUSTED" || error.reason === "GLOBAL_SPEND_EXHAUSTED") logger.warn({ event: "dinar_ai_global_budget_exhausted", reason: error.reason }, "AI global spending guard reached");
      return refusal(error.reason);
    }
    throw error;
  }
}

function charges(reservation: Reservation, measurement: AiUsageMeasurement) {
  const calls = Math.max(0, Math.floor(measurement.providerCalls));
  const reported =
    Number.isInteger(measurement.inputTokens) && Number.isInteger(measurement.outputTokens) && calls > 0
      ? Math.max(0, measurement.inputTokens!) + Math.max(0, measurement.outputTokens!)
      : undefined;
  const tokens = reported ?? (calls > 0 ? reservation.reservedTokens * calls : 0);
  const tokenSource = reported !== undefined ? "PROVIDER_REPORTED" : calls > 0 ? "ESTIMATED" : "NONE";
  const success = measurement.outcome === "SUCCESS";
  return {
    calls,
    tokenSource,
    // The user is charged only for an answer they actually received.
    user: { requests: success ? reservation.reservedRequests : 0, tokens: success ? tokens : 0 },
    // The platform guard counts every provider call that was made, successful or not.
    global: { requests: calls, tokens },
  };
}

/**
 * The provider calls of a measurement. Callers that know each request pass `calls`; otherwise
 * the aggregate is spread conservatively: the reported tokens on the first call, the remaining
 * calls without reported usage (so they are estimated, never free).
 */
function callRecords(measurement: AiUsageMeasurement, calls: number): AiCallRecord[] {
  if (measurement.calls?.length) return measurement.calls.slice(0, 16);
  const provider = measurement.provider ?? "UNKNOWN";
  const model = measurement.model ?? "UNKNOWN";
  const reported = Number.isInteger(measurement.inputTokens) && Number.isInteger(measurement.outputTokens);
  const final: AiCallRecord["outcome"] =
    measurement.outcome === "SUCCESS" ? "SUCCESS" : measurement.outcome === "TIMEOUT" ? "TIMEOUT" : measurement.outcome === "ABANDONED" ? "ABANDONED" : "FAILED";
  return Array.from({ length: Math.min(calls, 16) }, (_, index): AiCallRecord => ({
    kind: index === 0 ? "PRIMARY" : "RETRY",
    outcome: index === calls - 1 ? final : "FAILED",
    provider,
    model,
    ...(index === 0 && reported ? { inputTokens: measurement.inputTokens, outputTokens: measurement.outputTokens } : {}),
  }));
}

/**
 * Settles a reservation exactly once. A duplicate settlement (retry, repeated provider
 * callback) changes nothing and returns the stored row.
 */
export async function settleAiUsage(reservationId: string, measurement: AiUsageMeasurement, now = new Date()) {
  return db.transaction(async (tx) => {
    const [reservation] = await tx.select().from(aiUsageReservations).where(eq(aiUsageReservations.id, reservationId)).for("update");
    if (!reservation) throw new Error("AI usage reservation not found");
    if (reservation.status !== "RESERVED") return { duplicate: true as const, reservation };
    const charged = charges(reservation, measurement);
    const ownerRow = { ownerKey: reservation.ownerKey, periodStart: reservation.periodStart };
    if (reservation.premiumTrial) {
      await moveCounter(
        tx,
        { ownerKey: reservation.ownerKey, periodStart: PREMIUM_TRIAL_PERIOD_START, resource: "ALL" },
        {
          reservedRequests: -1,
          consumedRequests: charged.calls > 0 ? 1 : 0,
        },
      );
    } else {
      await moveCounter(tx, { ...ownerRow, resource: reservation.resource }, { reservedRequests: -reservation.reservedRequests, consumedRequests: charged.user.requests });
    }
    await moveCounter(tx, { ...ownerRow, resource: "ALL" }, { reservedTokens: -reservation.reservedTokens, consumedTokens: charged.user.tokens, consumedRequests: charged.user.requests });
    if (reservation.globalGuarded)
      await moveCounter(
        tx,
        { ownerKey: GLOBAL_OWNER_KEY, periodStart: reservation.globalPeriodStart, resource: "ALL" },
        { reservedRequests: -1, reservedTokens: -reservation.reservedTokens, consumedRequests: charged.global.requests, consumedTokens: charged.global.tokens },
      );
    const status = measurement.outcome === "SUCCESS" ? "SETTLED" : measurement.outcome === "ABANDONED" ? "EXPIRED" : "RELEASED";
    const [hold] = await tx
      .select({ id: aiSpendHolds.id })
      .from(aiSpendHolds)
      .where(and(eq(aiSpendHolds.usageReservationId, reservation.id), eq(aiSpendHolds.status, "HELD")))
      .for("update");
    if (hold) await settleAiSpend(tx, hold.id, callRecords(measurement, charged.calls), Math.ceil(reservation.reservedTokens), now);
    const [row] = await tx
      .update(aiUsageReservations)
      .set({
        status,
        outcome: measurement.outcome,
        chargedRequests: charged.user.requests,
        chargedTokens: charged.user.tokens,
        providerCalls: charged.calls,
        inputTokens: Number.isInteger(measurement.inputTokens) ? measurement.inputTokens! : null,
        outputTokens: Number.isInteger(measurement.outputTokens) ? measurement.outputTokens! : null,
        tokenSource: charged.tokenSource,
        provider: measurement.provider?.slice(0, 40) ?? null,
        model: measurement.model && /^[A-Za-z0-9._:/-]{1,120}$/.test(measurement.model) ? measurement.model : null,
        settledAt: now,
        updatedAt: now,
      })
      .where(eq(aiUsageReservations.id, reservation.id))
      .returning();
    return { duplicate: false as const, reservation: row! };
  });
}

/** Releases without charging the user (nothing was sent to a provider, or it was cancelled). */
export function releaseAiUsage(reservationId: string, outcome: Exclude<AiUsageOutcome, "SUCCESS"> = "CANCELLED", providerCalls = 0) {
  return settleAiUsage(reservationId, { outcome, providerCalls });
}

/**
 * Abandoned reservations (process stopped between reserve and settle) are released for the
 * user and counted conservatively (one call at the estimate) against the global guard.
 * Runs lazily before every reservation of the owner, and can be called by a periodic job.
 */
export async function reconcileAbandonedAiReservations(input: { ownerKey?: string; now?: Date; limit?: number } = {}) {
  const now = input.now ?? new Date();
  const stale = await db
    .select({ id: aiUsageReservations.id })
    .from(aiUsageReservations)
    .where(and(eq(aiUsageReservations.status, "RESERVED"), lt(aiUsageReservations.expiresAt, now), ...(input.ownerKey ? [eq(aiUsageReservations.ownerKey, input.ownerKey)] : [])))
    .limit(input.limit ?? 50);
  for (const row of stale) await settleAiUsage(row.id, { outcome: "ABANDONED", providerCalls: 1 }, now);
  return stale.length;
}

export type AiUsageSummary = Awaited<ReturnType<typeof aiUsageSummary>>;

/**
 * The owner's real usage in the current period, read from the counters. Percentages are
 * computed only from configured limits and recorded consumption; nothing is estimated.
 */
export async function aiUsageSummary(owner: AiUsageOwner, now = new Date()) {
  const policy = await aiUsagePolicyFor(owner.market);
  const { tier, source } = await tierFor(owner);
  const period = usagePeriod(policy.period, now);
  const ownerKey = ownerKeyOf(owner);
  await reconcileAbandonedAiReservations({ ownerKey, now });
  const rows = await db
    .select()
    .from(aiUsageCounters)
    .where(and(eq(aiUsageCounters.ownerKey, ownerKey), eq(aiUsageCounters.periodStart, period.start)));
  const byResource = new Map(rows.map((row) => [row.resource, row]));
  const [trialCounter] = owner.kind === "USER"
    ? await db
        .select()
        .from(aiUsageCounters)
        .where(
          and(
            eq(aiUsageCounters.ownerKey, ownerKey),
            eq(aiUsageCounters.periodStart, PREMIUM_TRIAL_PERIOD_START),
            eq(aiUsageCounters.resource, "ALL"),
          ),
        )
        .limit(1)
    : [];
  const allowance = policy.tiers[tier];
  const percent = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null);
  const resources = AI_USAGE_RESOURCES.map((resource) => {
    const row = byResource.get(resource);
    const limit = allowance.requests[resource];
    const used = row?.consumedRequests ?? 0;
    const reserved = row?.reservedRequests ?? 0;
    return { resource, label: AI_RESOURCE_LABELS[resource], limit, used, inProgress: reserved, remaining: Math.max(0, limit - used - reserved), percent: percent(used, limit), included: limit > 0 };
  });
  const all = byResource.get("ALL");
  const tokensUsed = all?.consumedTokens ?? 0;
  const tokens = { limit: allowance.tokens, used: tokensUsed, remaining: Math.max(0, allowance.tokens - tokensUsed - (all?.reservedTokens ?? 0)), percent: percent(tokensUsed, allowance.tokens) };
  const trialModel = {
    provider: process.env.DINAR_PREMIUM_TRIAL_PROVIDER ?? "",
    model: process.env.DINAR_PREMIUM_TRIAL_MODEL ?? "",
  };
  const trialPrice = trialCounter && trialModel.provider && trialModel.model
    ? await applicableApprovedPrice(trialModel.provider, [trialModel.model], now)
    : undefined;
  const trialReady = Boolean(
    trialCounter &&
      tier === "FREE" &&
      premiumTrialDeploymentAuthorized(process.env, policy, trialModel) &&
      trialPrice &&
      !isZeroCostTextPrice(trialPrice),
  );
  const trialUsed = trialCounter?.consumedRequests ?? 0;
  const trialInProgress = trialCounter?.reservedRequests ?? 0;
  const trialRemaining = trialCounter
    ? Math.max(0, PREMIUM_TRIAL_MESSAGE_LIMIT - trialUsed - trialInProgress)
    : 0;
  const premiumTrial = {
    eligible: Boolean(trialCounter),
    enabled: trialReady && trialRemaining > 0,
    limit: trialCounter ? PREMIUM_TRIAL_MESSAGE_LIMIT : 0,
    used: trialUsed,
    inProgress: trialInProgress,
    remaining: trialRemaining,
    status: !trialCounter
      ? ("NOT_ELIGIBLE" as const)
      : trialRemaining === 0
        ? ("EXHAUSTED" as const)
        : trialReady
          ? ("AVAILABLE" as const)
          : ("DISABLED" as const),
  };
  return {
    tier,
    tierLabel: AI_TIER_LABELS[tier],
    entitlementSource: source.startsWith("subscription:") ? ("SUBSCRIPTION" as const) : source === "GUEST" ? ("GUEST" as const) : ("DEFAULT_FREE" as const),
    approved: policy.approved,
    period: { kind: policy.period.kind, timeZone: policy.period.timeZone, start: period.start.toISOString(), renewsAt: period.end.toISOString() },
    resources,
    tokens,
    premiumTrial,
    nearLimitRatio: policy.nearLimitRatio,
    exhausted: resources.filter((item) => item.included && item.remaining === 0).map((item) => item.resource),
  };
}

/** The usage share of `resource` crossed the near-limit line with this settlement. */
export function crossedNearLimit(before: AiUsageSummary, after: AiUsageSummary, resource: AiUsageResource): number | null {
  const was = before.resources.find((item) => item.resource === resource);
  const now = after.resources.find((item) => item.resource === resource);
  if (!was || !now || now.limit <= 0) return null;
  const line = Math.round(after.nearLimitRatio * 100);
  return (was.percent ?? 0) < line && (now.percent ?? 0) >= line ? now.percent : null;
}

/** Read-only: would one more request of `resource` be allowed now (no reservation made)? */
export async function hasAiAllowance(owner: AiUsageOwner, resource: AiUsageResource, now = new Date()) {
  const summary = await aiUsageSummary(owner, now);
  const item = summary.resources.find((row) => row.resource === resource);
  return Boolean(item && item.remaining > 0 && summary.tokens.remaining > 0);
}

/** Read-only: does the platform guard still have room for one more request now? */
export async function globalGuardOpen(market: MarketRef, now = new Date()) {
  const policy = await aiUsagePolicyFor(market);
  if (!policy.globalGuard.enabled) return true;
  const period = usagePeriod(policy.globalGuard.period, now);
  const [row] = await db
    .select()
    .from(aiUsageCounters)
    .where(and(eq(aiUsageCounters.ownerKey, GLOBAL_OWNER_KEY), eq(aiUsageCounters.periodStart, period.start), eq(aiUsageCounters.resource, "ALL")));
  return !row || (row.reservedRequests + row.consumedRequests < policy.globalGuard.requests && row.reservedTokens + row.consumedTokens + policy.tokenEstimates.TEXT_REQUEST <= policy.globalGuard.tokens);
}
