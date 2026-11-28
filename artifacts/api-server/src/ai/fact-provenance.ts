/**
 * Block F fact provenance. Current server state beats conversational memory; an explicit
 * user statement beats an image or DINAR inference; within one rank the later statement
 * wins. UNKNOWN or empty values never win, so an unknown fact stays unknown.
 *
 * M2 commerce provenance: every fact shown to a buyer or seller about store rules, prices,
 * shipping, stock, or payment options carries one of:
 *   STORE_SYSTEM | MERCHANT_POLICY (with version) | UNCONFIRMED | NEEDS_MERCHANT_APPROVAL
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

export const COMMERCE_PROVENANCE_SOURCES = [
  "STORE_SYSTEM",
  "MERCHANT_POLICY",
  "UNCONFIRMED",
  "NEEDS_MERCHANT_APPROVAL",
] as const;
export type CommerceProvenanceSource = (typeof COMMERCE_PROVENANCE_SOURCES)[number];
export type CommerceProvenance = {
  source: CommerceProvenanceSource;
  version?: number;
  labelAr: string;
};

export function commerceProvenance(
  source: CommerceProvenanceSource,
  version?: number,
): CommerceProvenance {
  switch (source) {
    case "STORE_SYSTEM":
      return { source, labelAr: "من نظام المتجر" };
    case "MERCHANT_POLICY":
      return {
        source,
        ...(version !== undefined ? { version } : {}),
        labelAr: version !== undefined ? `سياسة التاجر (نسخة ${version})` : "سياسة التاجر",
      };
    case "UNCONFIRMED":
      return { source, labelAr: "غير مؤكد" };
    case "NEEDS_MERCHANT_APPROVAL":
      return { source, labelAr: "بانتظار موافقة التاجر" };
  }
}
