/**
 * «نبض السوق» — aggregated market intelligence (Monetization V3).
 *
 * Deterministic aggregates over DemandSignals only: no model, no campaign data, no ad
 * impressions. Paying for ads can never raise a need's demand. A cluster is shown only when
 * at least the policy's minimum number of distinct actors contributed (cohort privacy),
 * and the sellers of matching supply are excluded from its demand so self-searches do not
 * inflate it. Business users get deeper windows and more insights; no subscription ever
 * unlocks a cohort below the threshold or any individual row.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { db, demandSignals } from "@workspace/db";
import {
  actorKey,
  formatMinorAmount,
  getCommercialPolicy,
  PULSE_WINDOW_MS,
  trafficClass,
  type PulseWindow,
} from "./commercial-policy";
import { needCoverage, needTokens } from "./demand-normalization";
import { searchMarketplaceListings } from "./marketplace-listings";
import { logger } from "./logger";

type Market = Parameters<typeof searchMarketplaceListings>[0];
type SignalRow = typeof demandSignals.$inferSelect;

export const INSUFFICIENT_DATA_MESSAGE = "لا توجد بيانات كافية لعرض إحصائية موثوقة حاليًا.";

export type DemandCluster = {
  needKey: string;
  title: string;
  categoryId: string | null;
  searchCount: number;
  uniqueDemandActors: number;
  zeroResultCount: number;
  unsatisfiedCount: number;
  satisfiedCount: number;
  conversionCount: number;
  activeSupply: number;
  availableSupply: number | null;
  demandSupplyRatio: number;
  unmetShare: number;
  requestedPriceMinMinor: number | null;
  requestedPriceMaxMinor: number | null;
  requestedPriceTypicalMinor: number | null;
  previousActors: number;
  trend: "RISING" | "STABLE" | "FALLING" | "INSUFFICIENT_DATA";
  signals: ("HIGH_DEMAND" | "LOW_SUPPLY" | "RISING" | "STABLE" | "FALLING")[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * Deterministic clusters for one market and window. Optional city/category/need narrow
 * the cohort; clusters below the cohort threshold are dropped entirely.
 */
export async function aggregateDemand(input: {
  market: Market;
  window: PulseWindow;
  city?: string;
  categoryId?: string;
  needText?: string;
  now?: Date;
}): Promise<{ clusters: DemandCluster[]; cohortThreshold: number; policyVersion: number }> {
  const policy = await getCommercialPolicy(input.market.id);
  const now = input.now ?? new Date();
  const span = PULSE_WINDOW_MS[input.window];
  const since = new Date(now.getTime() - span);
  const previousSince = new Date(since.getTime() - span);
  const rows: SignalRow[] = await db
    .select()
    .from(demandSignals)
    .where(and(eq(demandSignals.marketId, input.market.id), eq(demandSignals.trafficClass, trafficClass()), gte(demandSignals.createdAt, previousSince), lt(demandSignals.createdAt, now)))
    .limit(50_000);
  const focus = input.needText ? needTokens(input.needText) : [];
  const inScope = rows.filter(
    (row) =>
      (!input.city || (row.city ?? "") === input.city) &&
      (!input.categoryId || row.categoryId === input.categoryId) &&
      (!focus.length || needCoverage(focus, row.normalizedNeed) >= 0.5),
  );
  const groups = new Map<string, SignalRow[]>();
  for (const row of inScope) groups.set(row.needKey, [...(groups.get(row.needKey) ?? []), row]);
  const clusters: DemandCluster[] = [];
  for (const [key, group] of groups) {
    const current = group.filter((row) => row.createdAt.getTime() >= since.getTime());
    if (!current.length) continue;
    const title = mostCommon(current.map((row) => row.normalizedNeed));
    const categoryId = mostCommon(current.map((row) => row.categoryId ?? "")) || null;
    // Supply through the canonical search authority, organic only.
    const supply = await searchMarketplaceListings(input.market, {
      search: title,
      ...(categoryId ? { categoryId } : {}),
      sponsoredPlacement: false,
      limit: 200,
    });
    const sellerKeys = new Set(supply.map((listing) => actorKey(String(listing.sellerId ?? ""))));
    const demand = current.filter((row) => !sellerKeys.has(row.actorKey));
    const previous = group.filter((row) => row.createdAt.getTime() < since.getTime() && !sellerKeys.has(row.actorKey));
    const actors = new Set(demand.map((row) => row.actorKey)).size;
    if (actors < policy.minCohortSize) continue;
    const previousActors = new Set(previous.map((row) => row.actorKey)).size;
    const zero = demand.filter((row) => row.resultCount === 0).length;
    const unsatisfied = demand.filter((row) => row.state === "USER_UNSATISFIED").length;
    const unmetActors = new Set(demand.filter((row) => row.resultCount === 0 || row.state === "USER_UNSATISFIED").map((row) => row.actorKey)).size;
    const maxPrices = demand.map((row) => row.priceMaxMinor).filter((value): value is number => value != null);
    const minPrices = demand.map((row) => row.priceMinMinor).filter((value): value is number => value != null);
    const limited = supply.filter((listing) => listing.inventoryMode === "LIMITED");
    const ratio = actors / Math.max(1, supply.length);
    const unmetShare = unmetActors / actors;
    const trend: DemandCluster["trend"] =
      previousActors < policy.minCohortSize ? "INSUFFICIENT_DATA"
        : actors >= previousActors * 1.25 ? "RISING"
          : actors <= previousActors * 0.8 ? "FALLING"
            : "STABLE";
    const signals: DemandCluster["signals"] = [];
    if (ratio >= 3) signals.push("HIGH_DEMAND");
    if (unmetShare >= 0.5 || supply.length <= 1) signals.push("LOW_SUPPLY");
    if (trend !== "INSUFFICIENT_DATA") signals.push(trend);
    clusters.push({
      needKey: key,
      title,
      categoryId,
      searchCount: demand.length,
      uniqueDemandActors: actors,
      zeroResultCount: zero,
      unsatisfiedCount: unsatisfied,
      satisfiedCount: demand.filter((row) => row.state === "SATISFIED").length,
      conversionCount: demand.filter((row) => row.state === "CONVERTED").length,
      activeSupply: supply.length,
      availableSupply: limited.length ? limited.reduce((sum, listing) => sum + Math.max(0, (listing.availableQuantity ?? 0) - listing.reservedQuantity), 0) : null,
      demandSupplyRatio: Math.round(ratio * 10) / 10,
      unmetShare: Math.round(unmetShare * 100) / 100,
      requestedPriceMinMinor: minPrices.length ? Math.min(...minPrices) : null,
      requestedPriceMaxMinor: maxPrices.length ? Math.max(...maxPrices) : null,
      requestedPriceTypicalMinor: median(maxPrices),
      previousActors,
      trend,
      signals,
      confidence: actors >= policy.minCohortSize * 3 ? "HIGH" : actors >= policy.minCohortSize * 2 ? "MEDIUM" : "LOW",
    });
  }
  return { clusters, cohortThreshold: policy.minCohortSize, policyVersion: policy.version };
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

/** Rounded down to a band of 5 to avoid false precision in what people see. */
export function approximate(value: number): string {
  if (value < 10) return String(value);
  return `${Math.floor(value / 5) * 5}+`;
}

export type PulseMode = "TOP" | "UNMET" | "OPPORTUNITIES";

export type MarketInsightView = {
  needKey: string;
  title: string;
  categoryId: string | null;
  demandLabel: string;
  unmetLabel: string;
  supplyLabel: string;
  ratioLabel: string;
  priceRangeLabel: string | null;
  trend: DemandCluster["trend"];
  trendLabel: string;
  signals: DemandCluster["signals"];
  confidence: DemandCluster["confidence"];
};

const TREND_LABELS: Record<DemandCluster["trend"], string> = {
  RISING: "صاعد",
  STABLE: "مستقر",
  FALLING: "هابط",
  INSUFFICIENT_DATA: "لا تكفي البيانات لتحديد الاتجاه",
};

export function insightView(cluster: DemandCluster, market: Market): MarketInsightView {
  const price = (minor: number | null) => (minor == null ? null : formatMinorAmount(minor, market.minorUnitScale, market.currencyCode));
  const typical = price(cluster.requestedPriceTypicalMinor);
  return {
    needKey: cluster.needKey,
    title: cluster.title,
    categoryId: cluster.categoryId,
    demandLabel: `${approximate(cluster.uniqueDemandActors)} باحثًا`,
    unmetLabel: `${Math.round(cluster.unmetShare * 100)}% لم يجدوا ما يناسبهم`,
    supplyLabel: `${cluster.activeSupply} عرضًا نشطًا`,
    ratioLabel: `${cluster.demandSupplyRatio} باحث لكل عرض`,
    priceRangeLabel: typical ? `حتى حوالي ${typical} غالبًا` : null,
    trend: cluster.trend,
    trendLabel: TREND_LABELS[cluster.trend],
    signals: cluster.signals,
    confidence: cluster.confidence,
  };
}

/**
 * The Market Pulse answer for one request: ordered insights (by unmet demand per unit of
 * supply for opportunities), the window, market, threshold and generation time. A budget
 * keeps only needs whose typical requested price fits it. Nothing here is purchasable.
 */
export async function marketPulse(input: {
  market: Market;
  window: PulseWindow;
  mode: PulseMode;
  limit: number;
  city?: string;
  categoryId?: string;
  needText?: string;
  budgetMinor?: number;
}) {
  const { clusters, cohortThreshold, policyVersion } = await aggregateDemand(input);
  let ranked = clusters;
  if (input.budgetMinor !== undefined)
    ranked = ranked.filter((cluster) => cluster.requestedPriceTypicalMinor !== null && cluster.requestedPriceTypicalMinor <= input.budgetMinor!);
  const opportunity = (cluster: DemandCluster) => cluster.uniqueDemandActors * (0.5 + cluster.unmetShare) / (cluster.activeSupply + 1);
  ranked = [...ranked].sort((a, b) =>
    input.mode === "TOP"
      ? b.uniqueDemandActors - a.uniqueDemandActors || a.needKey.localeCompare(b.needKey)
      : input.mode === "UNMET"
        ? b.unmetShare * b.uniqueDemandActors - a.unmetShare * a.uniqueDemandActors || a.needKey.localeCompare(b.needKey)
        : opportunity(b) - opportunity(a) || a.needKey.localeCompare(b.needKey),
  );
  if (input.mode === "UNMET") ranked = ranked.filter((cluster) => cluster.unmetShare > 0);
  const generatedAt = new Date().toISOString();
  logger.info({ event: "market_insight_generated", marketId: input.market.id, window: input.window, clusters: ranked.length }, "market insight generated");
  return {
    status: ranked.length ? ("OK" as const) : ("INSUFFICIENT_DATA" as const),
    message: ranked.length ? undefined : INSUFFICIENT_DATA_MESSAGE,
    window: input.window,
    marketId: input.market.id,
    city: input.city ?? null,
    generatedAt,
    cohortThreshold,
    policyVersion,
    clusters: ranked.slice(0, input.limit),
  };
}
