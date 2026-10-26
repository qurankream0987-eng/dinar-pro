/**
 * DemandSignal: normalised, allowlisted commercial intent from canonical DINAR searches
 * (Monetization V3). It keeps need words, category, a price range, a coarse public city,
 * condition, the organic result count and a state — never message text, contacts,
 * addresses, coordinates, payment data or negotiation terms. The actor is a one-way key
 * used only to count distinct people; it is never shown to anyone.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { db, demandSignals } from "@workspace/db";
import { actorKey, getCommercialPolicy, majorToMinor, trafficClass } from "./commercial-policy";
import { needKey, needTokens } from "./demand-normalization";
import { logger } from "./logger";

type Market = { id: string; currencyCode: string; minorUnitScale: number };
type Filter = { field: string; operator: string; value: unknown };

export type DemandNeed = {
  tokens: string[];
  needKey: string;
  normalizedNeed: string;
  categoryId?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  city?: string;
  condition?: string;
};

/** The allowlisted need behind a search state (search words + structured constraints). */
export function needFromSearch(market: Market, query: { search?: unknown; categoryId?: unknown; filters?: unknown; buyer?: unknown }): DemandNeed | undefined {
  const search = typeof query.search === "string" ? query.search : "";
  const categoryId = typeof query.categoryId === "string" && query.categoryId ? query.categoryId : undefined;
  const tokens = needTokens(search);
  if (!tokens.length) return undefined;
  const filters = (Array.isArray(query.filters) ? query.filters : []) as Filter[];
  const price = (operators: string[]) => {
    const filter = filters.find((item) => item.field === "price" && operators.includes(item.operator) && typeof item.value === "number");
    return filter ? majorToMinor(Number(filter.value), market.minorUnitScale) : undefined;
  };
  const buyerMax = (query.buyer as { maxPrice?: unknown } | undefined)?.maxPrice;
  const maxPriceMinor = price(["lte", "lt"]) ?? (typeof buyerMax === "number" ? majorToMinor(buyerMax, market.minorUnitScale) : undefined);
  const minPriceMinor = price(["gte", "gt"]);
  const city = filters.find((item) => item.field === "city" && typeof item.value === "string")?.value as string | undefined;
  const condition = filters.find((item) => item.field === "condition" && typeof item.value === "string")?.value as string | undefined;
  return {
    tokens,
    needKey: needKey(tokens, categoryId),
    normalizedNeed: tokens.filter((token) => !/^\d+$/.test(token)).join(" ") || tokens.join(" "),
    ...(categoryId ? { categoryId } : {}),
    ...(Number.isSafeInteger(minPriceMinor) ? { minPriceMinor } : {}),
    ...(Number.isSafeInteger(maxPriceMinor) ? { maxPriceMinor } : {}),
    ...(city ? { city: city.slice(0, 60) } : {}),
    ...(condition ? { condition: condition.slice(0, 40) } : {}),
  };
}

const REUSE_WINDOW_MS = 30 * 60 * 1000;

/**
 * One canonical search → one signal per actor and need (a repeat within 30 minutes
 * updates it). Zero results are unmet demand; fewer organic results than the policy's
 * low-supply threshold is a deterministic low-supply signal.
 */
export async function recordDemandSignal(input: { market: Market; userId: string; need: DemandNeed; resultCount: number }) {
  const policy = await getCommercialPolicy(input.market.id);
  const key = actorKey(input.userId);
  const state = input.resultCount === 0 ? "ZERO_RESULTS" : input.resultCount < policy.lowSupplyThreshold ? "LOW_SUPPLY" : "SEARCHED";
  const now = new Date();
  const [recent] = await db
    .select()
    .from(demandSignals)
    .where(and(eq(demandSignals.actorKey, key), eq(demandSignals.marketId, input.market.id), eq(demandSignals.needKey, input.need.needKey), gte(demandSignals.createdAt, new Date(now.getTime() - REUSE_WINDOW_MS))))
    .orderBy(desc(demandSignals.createdAt))
    .limit(1);
  if (recent) {
    // An explicit dissatisfaction or a conversion is stronger evidence than a repeat search.
    const keep = ["USER_UNSATISFIED", "CONVERTED"].includes(recent.state);
    await db
      .update(demandSignals)
      .set({ resultCount: input.resultCount, ...(keep ? {} : { state }), updatedAt: now })
      .where(eq(demandSignals.id, recent.id));
    return recent.id;
  }
  const id = randomUUID();
  await db.insert(demandSignals).values({
    id,
    marketId: input.market.id,
    actorKey: key,
    categoryId: input.need.categoryId ?? null,
    needKey: input.need.needKey,
    normalizedNeed: input.need.normalizedNeed.slice(0, 120),
    city: input.need.city ?? null,
    priceMinMinor: input.need.minPriceMinor ?? null,
    priceMaxMinor: input.need.maxPriceMinor ?? null,
    currencyCode: input.market.currencyCode,
    condition: input.need.condition ?? null,
    resultCount: input.resultCount,
    state,
    trafficClass: trafficClass(),
    expiresAt: new Date(now.getTime() + policy.demandSignalRetentionDays * 24 * 60 * 60 * 1000),
  });
  return id;
}

/** «ما عجبني شيء»: the buyer's own latest open need becomes USER_UNSATISFIED. */
export async function markLatestNeedUnsatisfied(input: { market: Market; userId: string; needKey: string }) {
  const key = actorKey(input.userId);
  const [latest] = await db
    .select()
    .from(demandSignals)
    .where(and(eq(demandSignals.actorKey, key), eq(demandSignals.marketId, input.market.id), eq(demandSignals.needKey, input.needKey)))
    .orderBy(desc(demandSignals.createdAt))
    .limit(1);
  if (!latest || latest.state === "CONVERTED") return false;
  await db.update(demandSignals).set({ state: "USER_UNSATISFIED", updatedAt: new Date() }).where(eq(demandSignals.id, latest.id));
  logger.info({ event: "demand_signal_unsatisfied", marketId: input.market.id }, "demand signal unsatisfied");
  return true;
}
