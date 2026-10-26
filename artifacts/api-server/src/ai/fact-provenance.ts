/**
 * Block F fact provenance. Current server state beats conversational memory; an explicit
 * user statement beats an image or DINAR inference; within one rank the later statement
 * wins. UNKNOWN or empty values never win, so an unknown fact stays unknown.
 */
export const FACT_SOURCES = ["SERVER_FACT", "USER_DECLARED", "IMAGE_INFERRED", "DINAR_DERIVED", "UNKNOWN"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];
export type Fact<T = unknown> = { value: T | null; source: FactSource };

const RANK: Record<FactSource, number> = {
  SERVER_FACT: 4,
  USER_DECLARED: 3,
  IMAGE_INFERRED: 2,
  DINAR_DERIVED: 2,
  UNKNOWN: 0,
};

export function resolveFact<T>(candidates: readonly Fact<T>[]): Fact<T> {
  let best: Fact<T> = { value: null, source: "UNKNOWN" };
  for (const candidate of candidates) {
    if (candidate.source === "UNKNOWN" || candidate.value === null || candidate.value === undefined || candidate.value === "") continue;
    if (RANK[candidate.source] >= RANK[best.source]) best = candidate;
  }
  return best;
}
