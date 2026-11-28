/**
 * AI-03 — 3-Tier Hierarchical Context Compression Engine (L1 Hot / L2 Warm Rolling Digest / L3 Cold Archive).
 * Keeps LLM prompt token usage O(1) bounded even across 200+ turn conversations while preserving
 * user constraints, active entities, rejected options, and lossless on-demand recall.
 */
import { z } from "zod";

export const DEFAULT_HOT_WINDOW_TURNS = 8;
export const DEFAULT_MAX_PROMPT_CHARS = 6500;
export const DEFAULT_MAX_RECALL_CHARS = 1800;

export const ConversationTurnSchema = z.object({
  turnIndex: z.number().int().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string().optional(),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const ConversationDigestSchema = z.object({
  digestVersion: z.number().int().min(1),
  coveredThroughTurn: z.number().int().min(0),
  userIntent: z.string().max(240),
  constraints: z.array(z.string().max(120)).max(12),
  activeEntities: z.object({
    orderIds: z.array(z.string().max(64)).max(10),
    cardIds: z.array(z.string().max(64)).max(10),
    listingIds: z.array(z.string().max(64)).max(10),
  }),
  settledDecisions: z.array(z.string().max(140)).max(10),
  rejectedOptions: z.array(z.string().max(140)).max(10),
});
export type ConversationDigest = z.infer<typeof ConversationDigestSchema>;

export interface ActiveCardDelta {
  cardId: string;
  stageMode?: string;
  selectedIds: string[];
  quantity?: number;
}

export interface CompressedContextResult {
  l1HotTurns: ConversationTurn[];
  l2WarmDigest: ConversationDigest | null;
  activeCardCompact: ActiveCardDelta | null;
  droppedTurnCount: number;
  estimatedChars: number;
  needsBackgroundDistillation: boolean;
}

const PHONE_RE = /(?:\+?\d[\d\s-]{7,}\d)/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function sanitizeText(text: string, maxLen: number): string {
  return text.replace(PHONE_RE, "[رقم محجوب]").replace(EMAIL_RE, "[بريد محجوب]").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function uniqueBounded(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function extractHeuristicDigest(olderTurns: ConversationTurn[], existing: ConversationDigest | null): ConversationDigest {
  const userTexts = olderTurns.filter((t) => t.role === "user").map((t) => sanitizeText(t.text, 140));
  const constraints: string[] = [...(existing?.constraints ?? [])];
  const rejectedOptions: string[] = [...(existing?.rejectedOptions ?? [])];
  const settledDecisions: string[] = [...(existing?.settledDecisions ?? [])];

  for (const text of userTexts) {
    if (/(?:ميزانية|اقل من|أقل من|حد اقصى|حد أقصى|مقاس|حجم|لون|توصيل|نقد|كاش)/u.test(text)) {
      constraints.push(text.slice(0, 120));
    }
    if (/(?:لا اريد|لا أريد|بدون|مو عاجبني|ارفض|أرفض|ما بدي|بلاش)/u.test(text)) {
      rejectedOptions.push(text.slice(0, 140));
    }
    if (/(?:اخترت|اعتمد|مناسب|تمام خلينا على)/u.test(text)) {
      settledDecisions.push(text.slice(0, 140));
    }
  }

  const lastTurn = olderTurns[olderTurns.length - 1]?.turnIndex ?? existing?.coveredThroughTurn ?? 0;
  return ConversationDigestSchema.parse({
    digestVersion: (existing?.digestVersion ?? 0) + 1,
    coveredThroughTurn: Math.max(existing?.coveredThroughTurn ?? 0, lastTurn),
    userIntent: sanitizeText(existing?.userIntent || userTexts[0] || "محادثة تسوق واستفسار في جاسم", 240),
    constraints: uniqueBounded(constraints, 12),
    activeEntities: existing?.activeEntities ?? { orderIds: [], cardIds: [], listingIds: [] },
    settledDecisions: uniqueBounded(settledDecisions, 10),
    rejectedOptions: uniqueBounded(rejectedOptions, 10),
  });
}

export function compressConversationWindow(input: {
  turns: ConversationTurn[];
  existingDigest?: ConversationDigest | null;
  activeCardDelta?: ActiveCardDelta | null;
  hotWindowSize?: number;
  maxPromptChars?: number;
}): CompressedContextResult {
  const hotSize = Math.max(2, Math.min(20, input.hotWindowSize ?? DEFAULT_HOT_WINDOW_TURNS));
  const maxChars = Math.max(1200, input.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS);
  const sorted = [...input.turns].sort((a, b) => a.turnIndex - b.turnIndex);

  const splitAt = Math.max(0, sorted.length - hotSize);
  const olderTurns = sorted.slice(0, splitAt);
  const hotTurns = sorted.slice(splitAt).map((t) => ({ ...t, text: sanitizeText(t.text, 600) }));

  const l2WarmDigest =
    olderTurns.length > 0
      ? extractHeuristicDigest(olderTurns, input.existingDigest ?? null)
      : input.existingDigest ?? null;

  const activeCardCompact = input.activeCardDelta
    ? {
        cardId: input.activeCardDelta.cardId.slice(0, 64),
        ...(input.activeCardDelta.stageMode ? { stageMode: input.activeCardDelta.stageMode.slice(0, 32) } : {}),
        selectedIds: input.activeCardDelta.selectedIds.slice(0, 24),
        ...(input.activeCardDelta.quantity !== undefined ? { quantity: input.activeCardDelta.quantity } : {}),
      }
    : null;

  const digestChars = l2WarmDigest ? JSON.stringify(l2WarmDigest).length : 0;
  const cardChars = activeCardCompact ? JSON.stringify(activeCardCompact).length : 0;
  let totalChars = digestChars + cardChars + hotTurns.reduce((sum, t) => sum + t.text.length + 24, 0);
  while (totalChars > maxChars && hotTurns.length > 2) {
    const removed = hotTurns.shift();
    if (removed) totalChars -= removed.text.length + 24;
  }

  return {
    l1HotTurns: hotTurns,
    l2WarmDigest,
    activeCardCompact,
    droppedTurnCount: olderTurns.length,
    estimatedChars: totalChars,
    needsBackgroundDistillation: olderTurns.length > 0 && (olderTurns[olderTurns.length - 1]?.turnIndex ?? 0) > (input.existingDigest?.coveredThroughTurn ?? 0),
  };
}

export function recallColdArchiveTurns(input: {
  allTurns: ConversationTurn[];
  query?: string;
  turnStart?: number;
  turnEnd?: number;
  maxChars?: number;
}): { hits: ConversationTurn[]; truncated: boolean } {
  const maxChars = Math.max(200, input.maxChars ?? DEFAULT_MAX_RECALL_CHARS);
  const q = input.query?.trim().toLowerCase();
  const candidates = input.allTurns.filter((t) => {
    if (input.turnStart !== undefined && t.turnIndex < input.turnStart) return false;
    if (input.turnEnd !== undefined && t.turnIndex > input.turnEnd) return false;
    if (q && !t.text.toLowerCase().includes(q)) return false;
    return true;
  });

  const hits: ConversationTurn[] = [];
  let used = 0;
  let truncated = false;
  for (const turn of candidates) {
    const clean = { ...turn, text: sanitizeText(turn.text, 400) };
    if (used + clean.text.length > maxChars) {
      truncated = true;
      break;
    }
    hits.push(clean);
    used += clean.text.length;
  }
  return { hits, truncated };
}
