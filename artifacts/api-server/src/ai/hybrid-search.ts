/**
 * AI-05 — Hybrid Semantic + Lexical Search & Reciprocal Rank Fusion (RRF) Reranker.
 * Designed to fuse existing PostgreSQL lexical/trigram search with pgvector semantic embeddings
 * without changing organic vs paid boundaries or leaking out-of-market items.
 */

export interface SearchCandidate {
  listingId: string;
  marketId: string;
  title: string;
  unitPriceMinor?: number | null;
  inStock: boolean;
  verifiedMerchant?: boolean;
  rating?: number | null;
}

export interface RankedCandidate {
  listingId: string;
  rank: number;
  score?: number;
}

export interface FusedResult {
  listingId: string;
  rrfScore: number;
  lexicalRank?: number;
  semanticRank?: number;
}

export interface VectorIndexAdapter {
  embedQuery(text: string): Promise<number[]>;
  searchNearest(input: { marketId: string; vector: number[]; limit: number }): Promise<RankedCandidate[]>;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function reciprocalRankFusion(
  lexical: readonly RankedCandidate[],
  semantic: readonly RankedCandidate[],
  options: { k?: number; lexicalWeight?: number; semanticWeight?: number } = {},
): FusedResult[] {
  const k = Math.max(1, options.k ?? 60);
  const wLex = options.lexicalWeight ?? 0.45;
  const wSem = options.semanticWeight ?? 0.55;

  const map = new Map<string, FusedResult>();
  for (const item of lexical) {
    const existing = map.get(item.listingId) ?? { listingId: item.listingId, rrfScore: 0 };
    existing.lexicalRank = item.rank;
    existing.rrfScore += wLex / (k + item.rank);
    map.set(item.listingId, existing);
  }
  for (const item of semantic) {
    const existing = map.get(item.listingId) ?? { listingId: item.listingId, rrfScore: 0 };
    existing.semanticRank = item.rank;
    existing.rrfScore += wSem / (k + item.rank);
    map.set(item.listingId, existing);
  }

  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.listingId.localeCompare(b.listingId));
}

export function rerankHybridCandidates(input: {
  fused: readonly FusedResult[];
  metadata: ReadonlyMap<string, SearchCandidate>;
  marketId: string;
  maxBudgetMinor?: number;
}): (FusedResult & { candidate: SearchCandidate; finalScore: number })[] {
  const out: (FusedResult & { candidate: SearchCandidate; finalScore: number })[] = [];
  for (const item of input.fused) {
    const candidate = input.metadata.get(item.listingId);
    if (!candidate) continue;
    if (candidate.marketId !== input.marketId) continue;
    if (
      input.maxBudgetMinor !== undefined &&
      candidate.unitPriceMinor != null &&
      candidate.unitPriceMinor > input.maxBudgetMinor
    ) {
      continue;
    }
    let multiplier = 1.0;
    if (!candidate.inStock) multiplier *= 0.35;
    if (candidate.verifiedMerchant) multiplier *= 1.08;
    if (candidate.rating != null && candidate.rating >= 4.5) multiplier *= 1.05;
    out.push({ ...item, candidate, finalScore: item.rrfScore * multiplier });
  }
  return out.sort((a, b) => b.finalScore - a.finalScore);
}
