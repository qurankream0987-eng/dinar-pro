/**
 * JassimAI High-Speed Generation, Frame-Coalesced Streaming & Scoped Cache Engine.
 *
 * Remediated & Intelligent Commerce Architecture:
 * 1. FrameCoalescedTokenBuffer:
 *    - Flushes the very first Arabic token in 0ms (instant TTFT).
 *    - Coalesces rapid sub-frame token bursts into 16ms (60fps) frame windows.
 *    - Handles mid-sentence stream pauses/stalls automatically via an idle flush timer
 *      (`onAutoFlush` / `flushIfStalled`) so buffered text is never delayed or lost.
 * 2. FastArabicIntentClassifier:
 *    - Deterministic sub-50-microsecond (<0.05ms) intent & read-only prefetch planner.
 *    - Trained on Deal Payment Agreements (22 Arab markets + open methods), Seller
 *      Classification (`0%` personal / `5%` merchant / `10%` Connect direct profit),
 *      and Conversational Merchant Policies.
 *    - Strictly advisory (`authority: "READ_ONLY_PREFETCH_HINT"`): NEVER grants execution,
 *      payment, or authorization bypass permissions.
 * 3. BoundedHotCache<V>:
 *    - Enforces strictly-typed composite keys (`ScopedCacheKey`) requiring explicit
 *      `marketId` and scope isolation (`PUBLIC_MARKET` | `TENANT` | `USER`).
 */

export type FastArabicIntent =
  | "GREETING"
  | "BUY_SEARCH"
  | "SELL_DRAFT"
  | "COMPARE"
  | "TRACK_DELIVERY"
  | "CONNECT_STORE_URL"
  | "GO_SELL_ADS"
  | "DEAL_PAYMENT_AGREEMENT"
  | "SELLER_CLASSIFICATION_POLICY"
  | "MERCHANT_COMMERCE_POLICY"
  | "GENERAL_CHAT";

export type PrefetchTarget =
  | "MARKET_CONFIG"
  | "CATEGORY_SCHEMA"
  | "LEXICAL_LISTINGS"
  | "SELLER_INVENTORY"
  | "ACTIVE_ORDER_TELEMETRY"
  | "PROMOTION_PLANS"
  | "DEAL_PAYMENT_CATALOG"
  | "SELLER_CLASSIFICATION_STATE"
  | "MERCHANT_POLICIES";

export interface FastIntentPlan {
  readonly authority: "READ_ONLY_PREFETCH_HINT";
  readonly intent: FastArabicIntent;
  readonly confidence: number;
  readonly extractedUrl?: string;
  readonly speculativePrefetches: readonly PrefetchTarget[];
  readonly canSkipHeavyReasoning: boolean;
}

const URL_RE = /https?:\/\/[^\s"'<>]+|(?:[a-z0-9-]+\.)+(?:salla\.sa|zid\.store|myshopify\.com|com|net|store|shop)\b/i;
const GREETING_RE = /^(?:السلام عليكم|مرحبا|أهلا|اهلا|هلا|صباح الخير|مساء الخير|كيف حالك|شلونك|يا جاسم)[!؟.\s]*$/u;
const GO_SELL_RE = /(?:روح بيع|روّج|روج لي|حملة إعلانية|حمله اعلانيه|إعلان ممول|اعلان ممول|زيادة مبيعات|مدير التسويق)/u;
const TRACK_RE = /(?:أين طلبي|وين طلبي|تتبع الطلب|تتبع التوصيل|المندوب وصل|كم باقي للطلب|حالة الطلب)/u;
const SELLER_CLASSIFICATION_RE = /(?:ما تصنيفي|شو تصنيفي|تصنيفي كبائع|مقتنياتي الشخصيه|مقتنياتي الشخصية|سريري الشخصي|أغراضي الشخصية|اغراضي الشخصيه|أعترض على التصنيف|اعترض على التصنيف|بائع فردي|حصة الربح المباشر|كم عمولة جاسم)/u;
const MERCHANT_POLICY_RE = /(?:سياسة المتجر|سياسه المتجر|إذا نفد|اذا نفد|حد التفاوض|حدود التفاوض|أوقف استقبال الطلبات|اوقف استقبال الطلبات|الحد الأدنى للطلب|الحد الادني للطلب|مناطق الدفع عند الاستلام)/u;
const DEAL_PAYMENT_RE = /(?:طرق الدفع|طريقة الدفع|طريقه الدفع|كليك|cliq|إنستاباي|انستاباي|instapay|تحويل بنكي|ومض|wamd|كي نت|knet|بنفت باي|فوران|آني|زين كاش|الدفع عند الاستلام|حولت المبلغ|استلمت المبلغ|شارك بيانات الدفع|بطاقة الصفقة|بطاقه الصفقه)/iu;
const COMPARE_RE = /(?:قارن|مقارنة|الفرق بين|أيهما أفضل|ايهما افضل)/u;
const SELL_RE = /(?:أريد أن أبيع|اريد ان ابيع|عندي للبيع|أعرض للبيع|اعرض منتج|انشر إعلان|انشر اعلان)/u;
const BUY_RE = /(?:أريد أن أشتري|اريد ان اشتري|أبحث عن|ابحث عن|بكم سعر|كم سعر|عندكم|متوفر)/u;

/**
 * Classifies an Arabic turn in <0.05ms for read-only prefetching only.
 * Never grants write, payment, or authorization permissions.
 */
export function classifyFastArabicIntent(rawText: string): FastIntentPlan {
  const text = rawText.trim();
  if (!text) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "GENERAL_CHAT",
      confidence: 1,
      speculativePrefetches: ["MARKET_CONFIG"],
      canSkipHeavyReasoning: true,
    };
  }

  if (GREETING_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "GREETING",
      confidence: 0.99,
      speculativePrefetches: ["MARKET_CONFIG"],
      canSkipHeavyReasoning: true,
    };
  }

  const urlMatch = text.match(URL_RE);
  if (urlMatch && (text.length < 180 || /(?:اربط|متجري|موقعي|كونيكت|connect)/iu.test(text))) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "CONNECT_STORE_URL",
      confidence: 0.96,
      extractedUrl: urlMatch[0],
      speculativePrefetches: ["MARKET_CONFIG", "CATEGORY_SCHEMA"],
      canSkipHeavyReasoning: true,
    };
  }

  if (SELLER_CLASSIFICATION_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "SELLER_CLASSIFICATION_POLICY",
      confidence: 0.96,
      speculativePrefetches: ["MARKET_CONFIG", "SELLER_CLASSIFICATION_STATE", "SELLER_INVENTORY"],
      canSkipHeavyReasoning: true,
    };
  }

  if (MERCHANT_POLICY_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "MERCHANT_COMMERCE_POLICY",
      confidence: 0.95,
      speculativePrefetches: ["MARKET_CONFIG", "MERCHANT_POLICIES", "SELLER_INVENTORY"],
      canSkipHeavyReasoning: false,
    };
  }

  if (DEAL_PAYMENT_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "DEAL_PAYMENT_AGREEMENT",
      confidence: 0.96,
      speculativePrefetches: ["MARKET_CONFIG", "DEAL_PAYMENT_CATALOG", "ACTIVE_ORDER_TELEMETRY"],
      canSkipHeavyReasoning: true,
    };
  }

  if (GO_SELL_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "GO_SELL_ADS",
      confidence: 0.95,
      speculativePrefetches: ["MARKET_CONFIG", "SELLER_INVENTORY", "PROMOTION_PLANS"],
      canSkipHeavyReasoning: false,
    };
  }

  if (TRACK_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "TRACK_DELIVERY",
      confidence: 0.95,
      speculativePrefetches: ["ACTIVE_ORDER_TELEMETRY"],
      canSkipHeavyReasoning: true,
    };
  }

  if (COMPARE_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "COMPARE",
      confidence: 0.92,
      speculativePrefetches: ["MARKET_CONFIG", "CATEGORY_SCHEMA", "LEXICAL_LISTINGS"],
      canSkipHeavyReasoning: false,
    };
  }

  if (SELL_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "SELL_DRAFT",
      confidence: 0.93,
      speculativePrefetches: ["MARKET_CONFIG", "CATEGORY_SCHEMA"],
      canSkipHeavyReasoning: true,
    };
  }

  if (BUY_RE.test(text)) {
    return {
      authority: "READ_ONLY_PREFETCH_HINT",
      intent: "BUY_SEARCH",
      confidence: 0.91,
      speculativePrefetches: ["MARKET_CONFIG", "CATEGORY_SCHEMA", "LEXICAL_LISTINGS"],
      canSkipHeavyReasoning: true,
    };
  }

  return {
    authority: "READ_ONLY_PREFETCH_HINT",
    intent: "GENERAL_CHAT",
    confidence: 0.75,
    speculativePrefetches: ["MARKET_CONFIG"],
    canSkipHeavyReasoning: true,
  };
}

export class FrameCoalescedTokenBuffer {
  private buffer = "";
  private firstTokenFlushed = false;
  private lastFlushMs = 0;
  private lastPushMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly frameIntervalMs: number;
  private readonly maxBufferChars: number;
  private readonly onAutoFlush?: (chunk: string) => void;

  constructor(options?: {
    frameIntervalMs?: number;
    maxBufferChars?: number;
    onAutoFlush?: (chunk: string) => void;
  }) {
    this.frameIntervalMs = options?.frameIntervalMs ?? 16;
    this.maxBufferChars = options?.maxBufferChars ?? 48;
    this.onAutoFlush = options?.onAutoFlush;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.onAutoFlush || !this.buffer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.buffer && this.onAutoFlush) {
        const out = this.buffer;
        this.buffer = "";
        this.lastFlushMs = performance.now();
        this.onAutoFlush(out);
      }
    }, this.frameIntervalMs);
  }

  push(delta: string, nowMs: number = performance.now()): string | null {
    if (!delta) return null;
    this.clearIdleTimer();
    this.buffer += delta;
    this.lastPushMs = nowMs;

    if (!this.firstTokenFlushed) {
      this.firstTokenFlushed = true;
      this.lastFlushMs = nowMs;
      const out = this.buffer;
      this.buffer = "";
      return out;
    }

    const elapsed = nowMs - this.lastFlushMs;
    const isBoundary = /[\n.؟!،]$/u.test(this.buffer);
    if (elapsed >= this.frameIntervalMs || this.buffer.length >= this.maxBufferChars || isBoundary) {
      this.lastFlushMs = nowMs;
      const out = this.buffer;
      this.buffer = "";
      return out;
    }

    this.armIdleTimer();
    return null;
  }

  flushIfStalled(nowMs: number = performance.now()): string | null {
    if (!this.buffer) return null;
    if (nowMs - this.lastPushMs >= this.frameIntervalMs) {
      this.clearIdleTimer();
      this.lastFlushMs = nowMs;
      const out = this.buffer;
      this.buffer = "";
      return out;
    }
    return null;
  }

  flushRemaining(): string {
    this.clearIdleTimer();
    const out = this.buffer;
    this.buffer = "";
    return out;
  }

  cancel(): void {
    this.clearIdleTimer();
    this.buffer = "";
  }
}

export type ScopedCacheKey =
  | { scope: "PUBLIC_MARKET"; marketId: string; resource: string }
  | { scope: "TENANT"; marketId: string; tenantId: string; resource: string }
  | { scope: "USER"; marketId: string; userId: string; resource: string };

const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.-]{1,120}$/;

function assertSafeSegment(name: string, value: string): void {
  if (!value || !SAFE_SEGMENT_RE.test(value)) {
    throw new Error(`Invalid or unscoped BoundedHotCache key segment "${name}": must match [A-Za-z0-9_.-]{1,120}`);
  }
}

export function formatScopedCacheKey(key: ScopedCacheKey): string {
  assertSafeSegment("marketId", key.marketId);
  assertSafeSegment("resource", key.resource);
  if (key.scope === "PUBLIC_MARKET") {
    return `PUBLIC_MARKET|${key.marketId}|_|${key.resource}`;
  }
  if (key.scope === "TENANT") {
    assertSafeSegment("tenantId", key.tenantId);
    return `TENANT|${key.marketId}|${key.tenantId}|${key.resource}`;
  }
  if (key.scope === "USER") {
    assertSafeSegment("userId", key.userId);
    return `USER|${key.marketId}|${key.userId}|${key.resource}`;
  }
  throw new Error("Unsupported cache key scope");
}

export class BoundedHotCache<V> {
  private readonly map = new Map<string, { value: V; expiresAtMs: number; marketId: string; ownerId: string; scope: ScopedCacheKey["scope"] }>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(options?: { maxEntries?: number; defaultTtlMs?: number }) {
    this.maxEntries = Math.max(16, options?.maxEntries ?? 256);
    this.defaultTtlMs = Math.max(1000, options?.defaultTtlMs ?? 30_000);
  }

  get(key: ScopedCacheKey, nowMs: number = Date.now()): V | undefined {
    const formatted = formatScopedCacheKey(key);
    const entry = this.map.get(formatted);
    if (!entry) return undefined;
    if (nowMs > entry.expiresAtMs) {
      this.map.delete(formatted);
      return undefined;
    }
    this.map.delete(formatted);
    this.map.set(formatted, entry);
    return entry.value;
  }

  set(key: ScopedCacheKey, value: V, ttlMs?: number, nowMs: number = Date.now()): void {
    const formatted = formatScopedCacheKey(key);
    if (this.map.has(formatted)) {
      this.map.delete(formatted);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    const ownerId = key.scope === "TENANT" ? key.tenantId : key.scope === "USER" ? key.userId : "_";
    this.map.set(formatted, {
      value,
      expiresAtMs: nowMs + (ttlMs ?? this.defaultTtlMs),
      marketId: key.marketId,
      ownerId,
      scope: key.scope,
    });
  }

  delete(key: ScopedCacheKey): boolean {
    const formatted = formatScopedCacheKey(key);
    return this.map.delete(formatted);
  }

  invalidateMarket(marketId: string): number {
    assertSafeSegment("marketId", marketId);
    let removed = 0;
    for (const [k, entry] of this.map.entries()) {
      if (entry.marketId === marketId) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  invalidateTenant(marketId: string, tenantId: string): number {
    assertSafeSegment("marketId", marketId);
    assertSafeSegment("tenantId", tenantId);
    let removed = 0;
    for (const [k, entry] of this.map.entries()) {
      if (entry.scope === "TENANT" && entry.marketId === marketId && entry.ownerId === tenantId) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  invalidateUser(marketId: string, userId: string): number {
    assertSafeSegment("marketId", marketId);
    assertSafeSegment("userId", userId);
    let removed = 0;
    for (const [k, entry] of this.map.entries()) {
      if (entry.scope === "USER" && entry.marketId === marketId && entry.ownerId === userId) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
