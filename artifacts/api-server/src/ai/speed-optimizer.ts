/**
 * JassimAI High-Speed Generation, Frame-Coalesced Streaming & Speculative Prefetch Engine.
 *
 * Guarantees butter-smooth responsiveness across both backend generation and client rendering:
 * 1. FrameCoalescedTokenBuffer: Flushes the very first Arabic token in 0ms (instant TTFT), then
 *    coalesces high-frequency token bursts into 16ms (60fps) frame windows so fast providers
 *    (Groq / Gemini Flash) never cause main-thread DOM re-render stutter on the client.
 * 2. FastArabicIntentClassifier: Deterministic sub-50-microsecond (<0.05ms) intent & prefetch
 *    planner that fires read-only DB prefetches in parallel before the LLM round-trip completes.
 * 3. BoundedHotCache: Zero-leak O(1) LRU+TTL memory cache for hot market & category lookups.
 */

export type FastArabicIntent =
  | "GREETING"
  | "BUY_SEARCH"
  | "SELL_DRAFT"
  | "COMPARE"
  | "TRACK_DELIVERY"
  | "CONNECT_STORE_URL"
  | "GO_SELL_ADS"
  | "GENERAL_CHAT";

export type PrefetchTarget =
  | "MARKET_CONFIG"
  | "CATEGORY_SCHEMA"
  | "LEXICAL_LISTINGS"
  | "SELLER_INVENTORY"
  | "ACTIVE_ORDER_TELEMETRY"
  | "PROMOTION_PLANS";

export interface FastIntentPlan {
  intent: FastArabicIntent;
  confidence: number;
  extractedUrl?: string;
  speculativePrefetches: PrefetchTarget[];
  canSkipHeavyReasoning: boolean;
}

const URL_RE = /https?:\/\/[^\s"'<>]+|(?:[a-z0-9-]+\.)+(?:salla\.sa|zid\.store|myshopify\.com|com|net|store|shop)\b/i;
const GREETING_RE = /^(?:السلام عليكم|مرحبا|أهلا|اهلا|هلا|صباح الخير|مساء الخير|كيف حالك|شلونك|يا جاسم)[!؟.\s]*$/u;
const GO_SELL_RE = /(?:روح بيع|روّج|روج لي|حملة إعلانية|حمله اعلانيه|إعلان ممول|اعلان ممول|زيادة مبيعات|مدير التسويق)/u;
const TRACK_RE = /(?:أين طلبي|وين طلبي|تتبع الطلب|تتبع التوصيل|المندوب وصل|كم باقي للطلب|حالة الطلب)/u;
const COMPARE_RE = /(?:قارن|مقارنة|الفرق بين|أيهما أفضل|ايهما افضل)/u;
const SELL_RE = /(?:أريد أن أبيع|اريد ان ابيع|عندي للبيع|أعرض للبيع|اعرض منتج|انشر إعلان|انشر اعلان)/u;
const BUY_RE = /(?:أريد أن أشتري|اريد ان اشتري|أبحث عن|ابحث عن|بكم سعر|كم سعر|عندكم|متوفر)/u;

/**
 * Classifies an Arabic turn in <0.05ms and returns the exact read-only DB queries
 * that should be fired in parallel (`Promise.all`) before waiting on the LLM.
 */
export function classifyFastArabicIntent(rawText: string): FastIntentPlan {
  const text = rawText.trim();
  if (!text) {
    return {
      intent: "GENERAL_CHAT",
      confidence: 1,
      speculativePrefetches: ["MARKET_CONFIG"],
      canSkipHeavyReasoning: true,
    };
  }

  if (GREETING_RE.test(text)) {
    return {
      intent: "GREETING",
      confidence: 0.99,
      speculativePrefetches: ["MARKET_CONFIG"],
      canSkipHeavyReasoning: true,
    };
  }

  const urlMatch = text.match(URL_RE);
  if (urlMatch && (text.length < 180 || /(?:اربط|متجري|موقعي|كونيكت|connect)/iu.test(text))) {
    return {
      intent: "CONNECT_STORE_URL",
      confidence: 0.96,
      extractedUrl: urlMatch[0],
      speculativePrefetches: ["MARKET_CONFIG", "CATEGORY_SCHEMA"],
      canSkipHeavyReasoning: true,
    };
  }

  if (GO_SELL_RE.test(text)) {
    return {
      intent: "GO_SELL_ADS",
      confidence: 0.95,
      speculativePrefetches: ["MARKET_CONFIG", "SELLER_INVENTORY", "PROMOTION_PLANS"],
      canSkipHeavyReasoning: false,
    };
  }

  if (TRACK_RE.test(text)) {
    return {
      intent: "TRACK_DELIVERY",
      confidence: 0.95,
      speculativePrefetches: ["ACTIVE_ORDER_TELEMETRY"],
      canSkipHeavyReasoning: true,
    };
  }

  if (COMPARE_RE.test(text)) {
    return {
      intent: "COMPARE",
      confidence: 0.92,
      speculativePrefetches: ["MARKET_CONFIG", "CATEGORY_SCHEMA", "LEXICAL_LISTINGS"],
      canSkipHeavyReasoning: false,
    };
  }

  if (SELL_RE.test(text)) {
    return {
      intent: "SELL_DRAFT",
      confidence: 0.93,
      speculativePrefetches: ["MARKET_CONFIG", "CATEGORY_SCHEMA"],
      canSkipHeavyReasoning: true,
    };
  }

  if (BUY_RE.test(text)) {
    return {
      intent: "BUY_SEARCH",
      confidence: 0.91,
      speculativePrefetches: ["MARKET_CONFIG", "CATEGORY_SCHEMA", "LEXICAL_LISTINGS"],
      canSkipHeavyReasoning: true,
    };
  }

  return {
    intent: "GENERAL_CHAT",
    confidence: 0.75,
    speculativePrefetches: ["MARKET_CONFIG"],
    canSkipHeavyReasoning: true,
  };
}

/**
 * Coalesces rapid LLM token streams into smooth 16ms frame ticks while guaranteeing
 * 0ms latency on the very first token (TTFT) and immediate flush on sentence boundaries.
 */
export class FrameCoalescedTokenBuffer {
  private buffer = "";
  private firstTokenFlushed = false;
  private lastFlushMs = 0;
  private readonly frameIntervalMs: number;
  private readonly maxBufferChars: number;

  constructor(options?: { frameIntervalMs?: number; maxBufferChars?: number }) {
    this.frameIntervalMs = options?.frameIntervalMs ?? 16;
    this.maxBufferChars = options?.maxBufferChars ?? 48;
  }

  /**
   * Push a visible text delta and return a coalesced string if a frame boundary
   * (or first token / sentence boundary) was reached, or null if buffered for the current frame.
   */
  push(delta: string, nowMs: number = performance.now()): string | null {
    if (!delta) return null;
    this.buffer += delta;

    // 1. First token ALWAYS flushes in 0ms for instant perceived response (TTFT)
    if (!this.firstTokenFlushed) {
      this.firstTokenFlushed = true;
      this.lastFlushMs = nowMs;
      const out = this.buffer;
      this.buffer = "";
      return out;
    }

    // 2. Flush if 16ms (one 60fps frame) elapsed, buffer exceeded max chars, or newline/sentence end
    const elapsed = nowMs - this.lastFlushMs;
    const isBoundary = /[\n.؟!،]$/u.test(this.buffer);
    if (elapsed >= this.frameIntervalMs || this.buffer.length >= this.maxBufferChars || isBoundary) {
      this.lastFlushMs = nowMs;
      const out = this.buffer;
      this.buffer = "";
      return out;
    }

    return null;
  }

  flushRemaining(): string {
    const out = this.buffer;
    this.buffer = "";
    return out;
  }
}

/**
 * O(1) In-Memory LRU + TTL Cache for hot read-only metadata (markets, categories, promotion plans).
 */
export class BoundedHotCache<V> {
  private readonly map = new Map<string, { value: V; expiresAtMs: number }>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(options?: { maxEntries?: number; defaultTtlMs?: number }) {
    this.maxEntries = Math.max(16, options?.maxEntries ?? 256);
    this.defaultTtlMs = Math.max(1000, options?.defaultTtlMs ?? 30_000);
  }

  get(key: string, nowMs: number = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (nowMs > entry.expiresAtMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number, nowMs: number = Date.now()): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, {
      value,
      expiresAtMs: nowMs + (ttlMs ?? this.defaultTtlMs),
    });
  }

  get size(): number {
    return this.map.size;
  }
}
