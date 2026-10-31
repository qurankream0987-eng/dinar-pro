/**
 * DINAR NEXT pre-integration: monetary AI cost accounting, provider-neutral.
 *
 *   hold ──► SETTLED   (calls were made: each call's cost is recorded and charged)
 *       └──► RELEASED  (no provider call happened: nothing charged)
 *       └──► EXPIRED   (never settled in time: one unknown call is charged its full hold)
 *
 * Money is integer micro-units of the spend policy currency (1 USD = 1_000_000 micros). A hold
 * is taken before any paid call, in the same transaction as the request allowance, by one
 * conditional UPDATE per scope (global → plan → account), so concurrent requests can never hold
 * more than a configured cap. Settlement replaces the hold with the calls' cost:
 *   - PROVIDER_REPORTED usage × the versioned model price  → ESTIMATED (until the provider bill)
 *   - usage not reported                                    → ESTIMATED from the token estimate
 *   - no applicable price (unknown model, unit or currency) → UNPRICED, charged its full hold
 * Unknown cost is never zero. Reconciliation with the provider's bill turns ESTIMATED into FINAL
 * and corrects the counters by the difference. Nothing here stores prompt, reply or audio.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  aiBillingReconciliations,
  aiCostEvents,
  aiModelPrices,
  aiSpendCounters,
  aiSpendHolds,
  db,
} from "@workspace/db";
import { usagePeriod, type AiPlanTier, type AiUsagePolicy, type AiUsageResource } from "./ai-usage-policy";
import { logger } from "./logger";
import type { ConversationModelGateway } from "../ai/model-gateway";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Hold = typeof aiSpendHolds.$inferSelect;
type Price = typeof aiModelPrices.$inferSelect;

export type AiCallKind = "PRIMARY" | "RETRY" | "FALLBACK" | "CORRECTION";
export type AiCallOutcome = "SUCCESS" | "FAILED" | "TIMEOUT" | "ABANDONED";

/** One provider request as it actually happened. Usage fields are only what the provider reported. */
export type AiCallRecord = {
  kind: AiCallKind;
  outcome: AiCallOutcome;
  provider: string;
  /** The model the provider says answered, else the one requested. */
  model: string;
  requestedModel?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheWrite12hInputTokens?: number;
  outputTokens?: number;
  imageUnits?: number;
  audioSeconds?: number;
  /** The call is billed in units the provider did not report (e.g. audio seconds): never priced as zero. */
  unitsUnreported?: boolean;
  providerRequestId?: string;
};

export type AiSpendRefusalReason =
  | "SPEND_BUDGET_UNCONFIGURED"
  | "GLOBAL_SPEND_EXHAUSTED"
  | "PLAN_SPEND_EXHAUSTED"
  | "ACCOUNT_SPEND_EXHAUSTED"
  | "MODEL_UNPRICED";

export const GLOBAL_SPEND_SCOPE = "spend:global";

class SpendRefused extends Error {
  constructor(readonly reason: AiSpendRefusalReason) {
    super(reason);
  }
}
export function isSpendRefusal(error: unknown): error is SpendRefused {
  return error instanceof SpendRefused;
}

/**
 * Where an approved money cap is mandatory before any paid call: production, an explicitly
 * labelled staging/production deployment, or an explicit opt-in. Development may run without one.
 */
export function spendRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === "production" ||
    env.DINAR_DEPLOYMENT_ENV === "staging" ||
    env.DINAR_DEPLOYMENT_ENV === "production" ||
    env.DINAR_AI_SPEND_REQUIRED === "true"
  );
}

/** Placeholder prices exist only for tests and development; a deployment never applies them. */
function placeholderPricesAllowed(env: NodeJS.ProcessEnv = process.env) {
  return !spendRequired(env) && (env.NODE_ENV === "development" || env.NODE_ENV === "test");
}

const SAFE_NAME = /^[A-Za-z0-9._:/-]{1,120}$/;
const safeName = (value: string | undefined, fallback = "UNKNOWN") => (value && SAFE_NAME.test(value) ? value : fallback);
const count = (value: number | undefined) => (Number.isInteger(value) && value! > 0 ? Math.min(value!, 2_000_000_000) : 0);

/** The applicable price version for a model at `at`, or undefined (never a guess). */
export async function applicablePrice(provider: string, models: readonly (string | undefined)[], at: Date, tx: Tx | typeof db = db): Promise<Price | undefined> {
  for (const model of [...new Set(models.filter((item): item is string => Boolean(item && SAFE_NAME.test(item))))]) {
    const [row] = await tx
      .select()
      .from(aiModelPrices)
      .where(
        and(
          eq(aiModelPrices.provider, provider),
          eq(aiModelPrices.model, model),
          lte(aiModelPrices.effectiveFrom, at),
          or(isNull(aiModelPrices.effectiveTo), gte(aiModelPrices.effectiveTo, at)),
          ...(placeholderPricesAllowed() ? [] : [ne(aiModelPrices.source, "TEST_PLACEHOLDER")]),
        ),
      )
      .orderBy(desc(aiModelPrices.version))
      .limit(1);
    if (row) return row;
  }
  return undefined;
}

/** Upper bound for any single rate: $1,000,000 per million tokens / per unit, in micros. */
const MAX_RATE_MICROS = 1_000_000_000_000;
const rate = (value: number | null | undefined) => value === null || value === undefined || (Number.isInteger(value) && value >= 0 && value <= MAX_RATE_MICROS);

export type ModelPriceEntry = {
  provider: string;
  model: string;
  currencyCode: string;
  inputPerMillionMicros: number;
  outputPerMillionMicros: number;
  cachedInputPerMillionMicros?: number | null;
  cacheWriteInputPerMillionMicros?: number | null;
  cacheWrite12hInputPerMillionMicros?: number | null;
  imageUnitMicros?: number | null;
  audioSecondMicros?: number | null;
  requestMicros?: number;
  source: "PROVIDER_PUBLISHED" | "CONTRACT";
  sourceReference: string;
  effectiveFrom: Date;
};

/**
 * Adds the next price version for a model. Versions are append-only: a new version applies
 * from its own effective time, the previous one keeps pricing earlier calls, and nothing is
 * backdated (calls already estimated are never repriced here; reconciliation does that).
 * Test placeholders can never be entered this way.
 */
export async function addModelPrice(adminId: string, entry: ModelPriceEntry, now = new Date()) {
  const invalid = (message: string) => Object.assign(new Error(message), { status: 400, expose: true, code: "INVALID_PRICE" });
  if (!SAFE_NAME.test(entry.provider) || !SAFE_NAME.test(entry.model)) throw invalid("اسم المزود أو النموذج غير صالح");
  if (!/^[A-Z]{3}$/.test(entry.currencyCode)) throw invalid("رمز العملة غير صالح");
  if (![entry.inputPerMillionMicros, entry.outputPerMillionMicros, entry.cachedInputPerMillionMicros, entry.cacheWriteInputPerMillionMicros, entry.cacheWrite12hInputPerMillionMicros, entry.imageUnitMicros, entry.audioSecondMicros, entry.requestMicros].every(rate))
    throw invalid("قيمة سعر غير صالحة");
  if (entry.effectiveFrom.getTime() < now.getTime() - 60_000) throw invalid("لا يُسجل سعر بأثر رجعي؛ اختر وقتًا من الآن فصاعدًا");
  return db.transaction(async (tx) => {
    // Serialise versions per model; a concurrent entry waits rather than colliding.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai-price:${entry.provider}:${entry.model}`}))`);
    const [latest] = await tx
      .select({ version: sql<number>`coalesce(max(${aiModelPrices.version}), 0)::int` })
      .from(aiModelPrices)
      .where(and(eq(aiModelPrices.provider, entry.provider), eq(aiModelPrices.model, entry.model)));
    const [row] = await tx
      .insert(aiModelPrices)
      .values({
        id: randomUUID(),
        provider: entry.provider,
        model: entry.model,
        version: (latest?.version ?? 0) + 1,
        currencyCode: entry.currencyCode,
        inputPerMillionMicros: entry.inputPerMillionMicros,
        outputPerMillionMicros: entry.outputPerMillionMicros,
        cachedInputPerMillionMicros: entry.cachedInputPerMillionMicros ?? null,
        cacheWriteInputPerMillionMicros: entry.cacheWriteInputPerMillionMicros ?? null,
        cacheWrite12hInputPerMillionMicros: entry.cacheWrite12hInputPerMillionMicros ?? null,
        imageUnitMicros: entry.imageUnitMicros ?? null,
        audioSecondMicros: entry.audioSecondMicros ?? null,
        requestMicros: entry.requestMicros ?? 0,
        source: entry.source,
        sourceReference: entry.sourceReference,
        effectiveFrom: entry.effectiveFrom,
        createdBy: adminId,
      })
      .returning();
    return modelPriceView(row!);
  });
}

export function modelPriceView(row: Price) {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    version: row.version,
    currencyCode: row.currencyCode,
    inputPerMillionMicros: row.inputPerMillionMicros,
    outputPerMillionMicros: row.outputPerMillionMicros,
    cachedInputPerMillionMicros: row.cachedInputPerMillionMicros,
    cacheWriteInputPerMillionMicros: row.cacheWriteInputPerMillionMicros,
    cacheWrite12hInputPerMillionMicros: row.cacheWrite12hInputPerMillionMicros,
    imageUnitMicros: row.imageUnitMicros,
    audioSecondMicros: row.audioSecondMicros,
    requestMicros: row.requestMicros,
    source: row.source,
    sourceReference: row.sourceReference,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every version, newest version first per model, marking the one that prices a call made now. */
export async function listModelPrices(now = new Date()) {
  const rows = await db.select().from(aiModelPrices).orderBy(aiModelPrices.provider, aiModelPrices.model, desc(aiModelPrices.version)).limit(500);
  // Mirrors applicablePrice: the highest version whose window covers `now`.
  const priced = new Set<string>();
  return rows.map((row) => {
    const model = `${row.provider} ${row.model}`;
    const applies = row.effectiveFrom <= now && (!row.effectiveTo || row.effectiveTo >= now) && (placeholderPricesAllowed() || row.source !== "TEST_PLACEHOLDER");
    const current = applies && !priced.has(model);
    if (current) priced.add(model);
    return { ...modelPriceView(row), current };
  });
}

const PER_MILLION = 1_000_000n;
const ceilDiv = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;

/**
 * Cost of one call in micros, or undefined when any billed unit has no price (or the currency
 * differs from the budget currency: there is no silent conversion).
 */
export function callCostMicros(price: Price | undefined, usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number; cacheWrite12hInputTokens?: number; outputTokens: number; imageUnits: number; audioSeconds: number }, currencyCode: string): number | undefined {
  if (!price || price.currencyCode !== currencyCode) return undefined;
  if (usage.imageUnits > 0 && price.imageUnitMicros === null) return undefined;
  if (usage.audioSeconds > 0 && price.audioSecondMicros === null) return undefined;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const written = Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached);
  const written12h = Math.min(usage.cacheWrite12hInputTokens ?? 0, written);
  if (written > 0 && price.cacheWriteInputPerMillionMicros === null) return undefined;
  if (written12h > 0 && price.cacheWrite12hInputPerMillionMicros === null) return undefined;
  const cachedRate = BigInt(price.cachedInputPerMillionMicros ?? price.inputPerMillionMicros);
  const writeRate = BigInt(price.cacheWriteInputPerMillionMicros ?? price.inputPerMillionMicros);
  const write12hRate = BigInt(price.cacheWrite12hInputPerMillionMicros ?? price.cacheWriteInputPerMillionMicros ?? price.inputPerMillionMicros);
  const tokens =
    BigInt(usage.inputTokens - cached - written) * BigInt(price.inputPerMillionMicros) +
    BigInt(cached) * cachedRate +
    BigInt(written - written12h) * writeRate +
    BigInt(written12h) * write12hRate +
    BigInt(usage.outputTokens) * BigInt(price.outputPerMillionMicros);
  const total =
    ceilDiv(tokens, PER_MILLION) +
    BigInt(usage.imageUnits) * BigInt(price.imageUnitMicros ?? 0) +
    BigInt(usage.audioSeconds) * BigInt(price.audioSecondMicros ?? 0) +
    BigInt(price.requestMicros);
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
}

type Scope = { scopeKey: string; periodStart: Date; limitMicros: number | null; refusal: AiSpendRefusalReason };

function scopesFor(policy: AiUsagePolicy, ownerKey: string, tier: AiPlanTier | null, now: Date): Scope[] {
  const spend = policy.spend;
  const globalStart = usagePeriod(spend.global.period, now).start;
  return [
    { scopeKey: GLOBAL_SPEND_SCOPE, periodStart: globalStart, limitMicros: spend.global.limitMicros, refusal: "GLOBAL_SPEND_EXHAUSTED" },
    ...(tier
      ? [
          { scopeKey: `spend:plan:${tier}`, periodStart: globalStart, limitMicros: spend.perPlan[tier], refusal: "PLAN_SPEND_EXHAUSTED" as const },
          { scopeKey: `spend:${ownerKey}`, periodStart: usagePeriod(policy.period, now).start, limitMicros: spend.perAccount[tier], refusal: "ACCOUNT_SPEND_EXHAUSTED" as const },
        ]
      : []),
  ];
}

async function moveSpend(
  tx: Tx,
  row: { scopeKey: string; periodStart: Date; currencyCode: string },
  delta: { reserved?: number; spent?: number; unpriced?: number },
  limit?: { micros: number; refusal: AiSpendRefusalReason },
) {
  await tx.insert(aiSpendCounters).values(row).onConflictDoNothing();
  const reserved = delta.reserved ?? 0;
  const spent = delta.spent ?? 0;
  const updated = await tx
    .update(aiSpendCounters)
    .set({
      reservedMicros: sql`GREATEST(0, ${aiSpendCounters.reservedMicros} + ${reserved})`,
      spentMicros: sql`GREATEST(0, ${aiSpendCounters.spentMicros} + ${spent})`,
      unpricedCalls: sql`${aiSpendCounters.unpricedCalls} + ${delta.unpriced ?? 0}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiSpendCounters.scopeKey, row.scopeKey),
        eq(aiSpendCounters.periodStart, row.periodStart),
        eq(aiSpendCounters.currencyCode, row.currencyCode),
        ...(limit ? [sql`${aiSpendCounters.reservedMicros} + ${aiSpendCounters.spentMicros} + ${reserved} <= ${limit.micros}`] : []),
      ),
    )
    .returning({ scopeKey: aiSpendCounters.scopeKey });
  if (!updated.length) throw new SpendRefused(limit?.refusal ?? "GLOBAL_SPEND_EXHAUSTED");
}

/**
 * Holds money for one operation inside the caller's transaction. Throws a spend refusal (which
 * rolls the caller's transaction back) when a cap would be exceeded or none is configured where
 * one is required. `expectedModel` lets an unpriced model be refused before it is ever called.
 */
/**
 * Whether a model may be called under this spend policy: with `unpricedModel: "REFUSE"` it needs an
 * applicable price in the policy currency, and where spend is required OpenAI models also need
 * their cache-write rates. The usage hold checks the expected model; the conversation checks every
 * other model a turn could reach (a separate HEAVY model, a provider fallback) the same way.
 */
export async function modelPricingAcceptable(policy: AiUsagePolicy, model: { provider: string; model: string }, now = new Date(), tx: Tx | typeof db = db): Promise<boolean> {
  const spend = policy.spend;
  const price = await applicablePrice(model.provider, [model.model], now, tx);
  const missingRequiredOpenAiCacheRates =
    spendRequired() &&
    ["OPENAI", "OPENAI_COMPATIBLE"].includes(model.provider) &&
    (!price || price.cacheWriteInputPerMillionMicros === null || price.cacheWrite12hInputPerMillionMicros === null);
  return !(missingRequiredOpenAiCacheRates || (spend.unpricedModel === "REFUSE" && (!price || price.currencyCode !== spend.currencyCode)));
}

export async function holdAiSpend(
  tx: Tx,
  input: {
    ownerKey: string;
    tier: AiPlanTier | null;
    purpose: AiUsageResource | `PLATFORM_${string}`;
    resource: AiUsageResource;
    policy: AiUsagePolicy;
    usageReservationId?: string;
    expectedModel?: { provider: string; model: string };
    now: Date;
  },
): Promise<Hold> {
  const spend = input.policy.spend;
  if (spendRequired() && spend.global.limitMicros === null) throw new SpendRefused("SPEND_BUDGET_UNCONFIGURED");
  if (input.expectedModel && !(await modelPricingAcceptable(input.policy, input.expectedModel, input.now, tx))) throw new SpendRefused("MODEL_UNPRICED");
  const amount = spend.holdMicros[input.resource];
  const scopes = scopesFor(input.policy, input.ownerKey, input.tier, input.now);
  // Fixed order (global → plan → account) so two holds never deadlock.
  for (const scope of scopes)
    await moveSpend(
      tx,
      { scopeKey: scope.scopeKey, periodStart: scope.periodStart, currencyCode: spend.currencyCode },
      { reserved: amount },
      scope.limitMicros === null ? undefined : { micros: scope.limitMicros, refusal: scope.refusal },
    );
  const [hold] = await tx
    .insert(aiSpendHolds)
    .values({
      id: randomUUID(),
      usageReservationId: input.usageReservationId ?? null,
      ownerKey: input.ownerKey,
      purpose: input.purpose,
      currencyCode: spend.currencyCode,
      reservedMicros: amount,
      scopes: scopes.map((scope) => ({ scopeKey: scope.scopeKey, periodStart: scope.periodStart.toISOString() })),
      status: "HELD",
      enforced: scopes.some((scope) => scope.limitMicros !== null),
      expiresAt: new Date(input.now.getTime() + input.policy.reservationTtlSeconds * 1000),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return hold!;
}

/**
 * Replaces a hold with the real cost of the calls made, exactly once. `tokenEstimate` prices a
 * call whose usage the provider did not report. Returns the stored hold (duplicate = unchanged).
 */
export async function settleAiSpend(tx: Tx, holdId: string, calls: readonly AiCallRecord[], tokenEstimate: number, now = new Date()) {
  const [hold] = await tx.select().from(aiSpendHolds).where(eq(aiSpendHolds.id, holdId)).for("update");
  if (!hold) throw new Error("AI spend hold not found");
  if (hold.status !== "HELD") return { duplicate: true as const, hold, events: [] as (typeof aiCostEvents.$inferSelect)[] };
  const rows: (typeof aiCostEvents.$inferInsert)[] = [];
  let charged = 0;
  let unpriced = 0;
  for (const [index, call] of calls.entries()) {
    const provider = safeName(call.provider);
    const model = safeName(call.model);
    const reported = Number.isInteger(call.inputTokens) && Number.isInteger(call.outputTokens);
    const usage = {
      inputTokens: count(call.inputTokens),
      cachedInputTokens: count(call.cachedInputTokens),
      cacheWriteInputTokens: count(call.cacheWriteInputTokens),
      cacheWrite12hInputTokens: count(call.cacheWrite12hInputTokens),
      outputTokens: count(call.outputTokens),
      imageUnits: count(call.imageUnits),
      audioSeconds: count(call.audioSeconds),
    };
    const price = provider === "UNKNOWN" || call.unitsUnreported ? undefined : await applicablePrice(provider, [model, call.requestedModel], now, tx);
    // Unreported usage is priced as if the whole estimate were output tokens (the dearer side).
    const priced = callCostMicros(price, reported ? usage : { ...usage, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheWrite12hInputTokens: 0, outputTokens: Math.max(1, tokenEstimate) }, hold.currencyCode);
    const budgetCharged = priced ?? hold.reservedMicros;
    if (priced === undefined) unpriced += 1;
    charged += budgetCharged;
    rows.push({
      id: randomUUID(),
      holdId: hold.id,
      usageReservationId: hold.usageReservationId,
      ownerKey: hold.ownerKey,
      purpose: hold.purpose,
      callIndex: index,
      callKind: call.kind,
      callOutcome: call.outcome,
      provider,
      model,
      priceId: priced === undefined ? null : price!.id,
      usageSource: reported ? "PROVIDER_REPORTED" : usage.imageUnits || usage.audioSeconds ? "ESTIMATED" : "MISSING",
      ...usage,
      currencyCode: hold.currencyCode,
      estimatedCostMicros: priced ?? null,
      finalCostMicros: null,
      budgetChargedMicros: budgetCharged,
      costStatus: priced === undefined ? "UNPRICED" : "ESTIMATED",
      providerRequestId: call.providerRequestId && /^[A-Za-z0-9._:-]{1,200}$/.test(call.providerRequestId) ? call.providerRequestId : null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const events = rows.length ? await tx.insert(aiCostEvents).values(rows).onConflictDoNothing().returning() : [];
  for (const scope of hold.scopes)
    await moveSpend(tx, { scopeKey: scope.scopeKey, periodStart: new Date(scope.periodStart), currencyCode: hold.currencyCode }, { reserved: -hold.reservedMicros, spent: charged, unpriced });
  const abandoned = calls.some((call) => call.outcome === "ABANDONED");
  const [settled] = await tx
    .update(aiSpendHolds)
    .set({ status: abandoned ? "EXPIRED" : calls.length ? "SETTLED" : "RELEASED", chargedMicros: charged, settledAt: now, updatedAt: now })
    .where(eq(aiSpendHolds.id, hold.id))
    .returning();
  if (unpriced) logger.warn({ event: "dinar_ai_unpriced_calls", calls: unpriced, purpose: hold.purpose }, "AI calls without an applicable price were charged their hold");
  return { duplicate: false as const, hold: settled!, events };
}

/** A hold for a platform-owned call (e.g. safety review) that no user allowance pays for. */
export async function holdPlatformAiSpend(input: { purpose: `PLATFORM_${string}`; resource: AiUsageResource; policy: AiUsagePolicy; expectedModel?: { provider: string; model: string }; now?: Date }) {
  const now = input.now ?? new Date();
  try {
    const hold = await db.transaction((tx) => holdAiSpend(tx, { ownerKey: `platform:${input.purpose}`, tier: null, purpose: input.purpose, resource: input.resource, policy: input.policy, expectedModel: input.expectedModel, now }));
    return { ok: true as const, hold };
  } catch (error) {
    if (isSpendRefusal(error)) return { ok: false as const, reason: error.reason };
    throw error;
  }
}

export function settlePlatformAiSpend(holdId: string, calls: readonly AiCallRecord[], tokenEstimate: number) {
  return db.transaction((tx) => settleAiSpend(tx, holdId, calls, tokenEstimate));
}

/**
 * A background/platform model call path (no user request is charged): holds money under the
 * global cap first, records every call the wrapped gateway makes, and settles once. Refused or
 * unavailable → no gateway, so the caller falls back to its deterministic path.
 */
export async function meteredPlatformGateway(
  gateway: ConversationModelGateway | undefined,
  input: { purpose: `PLATFORM_${string}`; resource: AiUsageResource; policy: AiUsagePolicy },
): Promise<{ gateway?: ConversationModelGateway; settle: () => Promise<void> }> {
  if (!gateway) return { settle: async () => undefined };
  const expectedModel = gateway.providerInfo ? { provider: gateway.providerInfo.provider, model: gateway.providerInfo.requestedModel } : undefined;
  const hold = await holdPlatformAiSpend({ ...input, expectedModel });
  if (!hold.ok) return { settle: async () => undefined };
  const calls: AiCallRecord[] = [];
  const metered: ConversationModelGateway = {
    providerInfo: gateway.providerInfo,
    async proposeToolCall(messages, tools, options) {
      const base = { kind: calls.length ? ("RETRY" as const) : ("PRIMARY" as const), provider: gateway.providerInfo?.provider ?? "UNKNOWN", model: gateway.providerInfo?.requestedModel ?? "UNKNOWN" };
      try {
        const call = await gateway.proposeToolCall(messages, tools, options);
        calls.push({ ...base, outcome: "SUCCESS", model: call.actualModel ?? call.requestedModel ?? base.model, ...(call.usage ? { inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens } : {}), ...(call.providerRequestId ? { providerRequestId: call.providerRequestId } : {}) });
        return call;
      } catch (error) {
        calls.push({ ...base, outcome: "FAILED" });
        throw error;
      }
    },
  };
  let settled = false;
  return {
    gateway: metered,
    settle: async () => {
      if (settled) return;
      settled = true;
      await settlePlatformAiSpend(hold.hold.id, calls, input.policy.tokenEstimates[input.resource]).catch((error) => logger.warn({ event: "dinar_ai_spend_settle_failed", code: (error as { code?: string }).code }, "platform AI spend could not be settled"));
    },
  };
}

/** Holds never settled within their TTL (process stopped): one unknown call, charged in full. */
export async function reconcileAbandonedSpendHolds(input: { now?: Date; limit?: number } = {}) {
  const now = input.now ?? new Date();
  const stale = await db
    .select({ id: aiSpendHolds.id })
    .from(aiSpendHolds)
    .where(and(eq(aiSpendHolds.status, "HELD"), isNull(aiSpendHolds.usageReservationId), lt(aiSpendHolds.expiresAt, now)))
    .limit(input.limit ?? 50);
  for (const row of stale)
    await db.transaction((tx) => settleAiSpend(tx, row.id, [{ kind: "PRIMARY", outcome: "ABANDONED", provider: "UNKNOWN", model: "UNKNOWN" }], 0, now));
  return stale.length;
}

/** Recorded money per scope for the current periods. Amounts are what the counters were charged. */
export async function aiSpendSummary(policy: AiUsagePolicy, now = new Date()) {
  const globalStart = usagePeriod(policy.spend.global.period, now).start;
  const rows = await db
    .select()
    .from(aiSpendCounters)
    .where(and(eq(aiSpendCounters.periodStart, globalStart), eq(aiSpendCounters.currencyCode, policy.spend.currencyCode)));
  const statuses = await db
    .select({ status: aiCostEvents.costStatus, events: sql<number>`count(*)::int`, micros: sql<number>`coalesce(sum(${aiCostEvents.budgetChargedMicros}), 0)::bigint` })
    .from(aiCostEvents)
    .where(and(gte(aiCostEvents.createdAt, globalStart), eq(aiCostEvents.currencyCode, policy.spend.currencyCode)))
    .groupBy(aiCostEvents.costStatus);
  const global = rows.find((row) => row.scopeKey === GLOBAL_SPEND_SCOPE);
  return {
    currencyCode: policy.spend.currencyCode,
    periodStart: globalStart.toISOString(),
    required: spendRequired(),
    configured: policy.spend.global.limitMicros !== null,
    global: {
      limitMicros: policy.spend.global.limitMicros,
      spentMicros: global?.spentMicros ?? 0,
      reservedMicros: global?.reservedMicros ?? 0,
      unpricedCalls: global?.unpricedCalls ?? 0,
    },
    plans: rows
      .filter((row) => row.scopeKey.startsWith("spend:plan:"))
      .map((row) => ({ tier: row.scopeKey.slice("spend:plan:".length), spentMicros: row.spentMicros, reservedMicros: row.reservedMicros, unpricedCalls: row.unpricedCalls })),
    costStatuses: statuses.map((row) => ({ status: row.status, events: Number(row.events), budgetChargedMicros: Number(row.micros) })),
  };
}

/** A provider's billed amounts per request, as its billing/usage export reports them. */
export type ProviderBillingItem = { providerRequestId: string; costMicros: number };
export interface AiBillingSource {
  readonly provider: string;
  /** Billed items for the window, or `{ available: false }` when the provider offers no such export. */
  fetchBilledItems(window: { start: Date; end: Date }): Promise<{ available: true; currencyCode: string; items: ProviderBillingItem[]; totalMicros?: number } | { available: false }>;
}

/**
 * Compares recorded calls of one provider in a window with its billed items. Matched calls
 * become FINAL and the counters are corrected by the difference; a call the bill does not cover
 * stays ESTIMATED/UNPRICED and makes the run INCOMPLETE. Re-running is safe (FINAL rows are skipped).
 */
export async function reconcileProviderBilling(input: {
  provider: string;
  periodStart: Date;
  periodEnd: Date;
  currencyCode: string;
  items: readonly ProviderBillingItem[];
  providerTotalMicros?: number;
  source: string;
}) {
  if (!(input.periodEnd > input.periodStart)) throw new Error("Invalid reconciliation window");
  const billed = new Map(input.items.filter((item) => Number.isSafeInteger(item.costMicros) && item.costMicros >= 0).map((item) => [item.providerRequestId, item.costMicros]));
  return db.transaction(async (tx) => {
    const events = await tx
      .select()
      .from(aiCostEvents)
      .where(and(eq(aiCostEvents.provider, input.provider), gte(aiCostEvents.createdAt, input.periodStart), lt(aiCostEvents.createdAt, input.periodEnd)))
      .for("update");
    let matched = 0;
    let unreported = 0;
    let localEstimated = 0;
    let providerBilled = 0;
    const seen = new Set<string>();
    for (const event of events) {
      localEstimated += event.estimatedCostMicros ?? event.budgetChargedMicros;
      const cost = event.providerRequestId ? billed.get(event.providerRequestId) : undefined;
      if (cost === undefined || event.currencyCode !== input.currencyCode) {
        if (event.costStatus !== "FINAL") unreported += 1;
        continue;
      }
      seen.add(event.providerRequestId!);
      providerBilled += cost;
      matched += 1;
      if (event.costStatus === "FINAL") continue;
      const delta = cost - event.budgetChargedMicros;
      await tx
        .update(aiCostEvents)
        .set({ finalCostMicros: cost, budgetChargedMicros: cost, costStatus: "FINAL", reconciledAt: new Date(), updatedAt: new Date() })
        .where(eq(aiCostEvents.id, event.id));
      if (delta || event.costStatus === "UNPRICED") {
        const [hold] = await tx.select().from(aiSpendHolds).where(eq(aiSpendHolds.id, event.holdId)).for("update");
        // A billed UNPRICED call is now priced: it leaves the unpriced count.
        for (const scope of hold?.scopes ?? [])
          await moveSpend(tx, { scopeKey: scope.scopeKey, periodStart: new Date(scope.periodStart), currencyCode: event.currencyCode }, { spent: delta, unpriced: event.costStatus === "UNPRICED" ? -1 : 0 });
      }
    }
    const unmatchedProvider = [...billed.keys()].filter((id) => !seen.has(id)).length;
    const totalsDiffer = input.providerTotalMicros !== undefined && input.providerTotalMicros !== [...billed.values()].reduce((sum, value) => sum + value, 0);
    const status = unmatchedProvider || totalsDiffer ? "DISCREPANCY" : unreported ? "INCOMPLETE" : "MATCHED";
    const [run] = await tx
      .insert(aiBillingReconciliations)
      .values({
        id: randomUUID(),
        provider: safeName(input.provider),
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        currencyCode: input.currencyCode,
        source: input.source.slice(0, 80),
        matchedEvents: matched,
        unmatchedProviderItems: unmatchedProvider,
        unreportedLocalEvents: unreported,
        localEstimatedMicros: localEstimated,
        providerBilledMicros: providerBilled,
        providerTotalMicros: input.providerTotalMicros ?? null,
        status,
      })
      .returning();
    return run!;
  });
}

/** Runs reconciliation from a billing source; an unavailable export is reported, never faked. */
export async function reconcileFromBillingSource(source: AiBillingSource, window: { start: Date; end: Date }) {
  const result = await source.fetchBilledItems(window);
  if (!result.available) return { available: false as const };
  return {
    available: true as const,
    run: await reconcileProviderBilling({
      provider: source.provider,
      periodStart: window.start,
      periodEnd: window.end,
      currencyCode: result.currencyCode,
      items: result.items,
      providerTotalMicros: result.totalMicros,
      source: `billing-source:${source.provider}`,
    }),
  };
}
