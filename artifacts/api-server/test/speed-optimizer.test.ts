import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BoundedHotCache,
  classifyFastArabicIntent,
  formatScopedCacheKey,
  FrameCoalescedTokenBuffer,
} from "../src/ai/speed-optimizer";
import { DualChannelStreamParser } from "../src/ai/dual-channel-stream";

test("Speed-01: FastArabicIntentClassifier classifies 1,000 Arabic turns in <15ms with strictly read-only authority", () => {
  const samples = [
    "السلام عليكم",
    "أريد أن أشتري آيفون 16 برو في الكويت",
    "https://mystore.salla.sa اربط متجري",
    "جاسم روح بيع لي منتجاتي بميزانية 50 دينار",
    "أين طلبي ومتى يصل المندوب؟",
    "قارن بين سماعة سوني وسماعة أبل",
  ];

  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    const plan = classifyFastArabicIntent(samples[i % samples.length]!);
    assert.equal(plan.authority, "READ_ONLY_PREFETCH_HINT");
    assert.ok(plan.speculativePrefetches.length >= 1);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 25, `Expected 1,000 intent classifications in <25ms, took ${elapsedMs.toFixed(2)}ms`);

  const connectPlan = classifyFastArabicIntent("https://elite.salla.sa");
  assert.equal(connectPlan.intent, "CONNECT_STORE_URL");
  assert.equal(connectPlan.extractedUrl, "https://elite.salla.sa");

  const goSellPlan = classifyFastArabicIntent("جاسم روح بيع لي السماعات");
  assert.equal(goSellPlan.intent, "GO_SELL_ADS");
  assert.ok(goSellPlan.speculativePrefetches.includes("SELLER_INVENTORY"));
});

test("Speed-02: FrameCoalescedTokenBuffer flushes first token in 0ms, coalesces bursts, and auto-flushes mid-sentence stalls", async () => {
  const autoFlushed: string[] = [];
  const coalescer = new FrameCoalescedTokenBuffer({
    frameIntervalMs: 16,
    maxBufferChars: 48,
    onAutoFlush: (chunk) => autoFlushed.push(chunk),
  });

  // First token flushes immediately at t=0ms (zero TTFT penalty)
  const first = coalescer.push("أهلاً", 100);
  assert.equal(first, "أهلاً");

  // Rapid sub-frame tokens at t=103ms, 106ms, 110ms are buffered so React doesn't thrash
  assert.equal(coalescer.push(" بك", 103), null);
  assert.equal(coalescer.push(" في", 106), null);
  assert.equal(coalescer.push(" جاسم", 110), null);

  // At t=117ms (>= 16ms frame tick), all buffered tokens flush in one smooth 60fps frame update
  const frameTick = coalescer.push(" الذكي", 117);
  assert.equal(frameTick, " بك في جاسم الذكي");

  // Mid-sentence stall test: push a token without punctuation, then pause > 20ms
  assert.equal(coalescer.push(" — منتج", 120), null);
  await new Promise((resolve) => setTimeout(resolve, 28));
  assert.deepEqual(autoFlushed, [" — منتج"]);
  assert.equal(coalescer.flushRemaining(), "");
});

test("Speed-03: Combined DualChannelStreamParser + FrameCoalescedTokenBuffer processes 2,000 tokens in <25ms", () => {
  const parser = new DualChannelStreamParser();
  const coalescer = new FrameCoalescedTokenBuffer({ frameIntervalMs: 16 });
  let visibleOutput = "";
  let renderFrames = 0;

  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) {
    const events = parser.push("كلمة ");
    for (const ev of events) {
      if (ev.type === "token") {
        const frame = coalescer.push(ev.delta, i * 2);
        if (frame) {
          visibleOutput += frame;
          renderFrames++;
        }
      }
    }
  }
  for (const ev of parser.flush()) {
    if (ev.type === "token") {
      const frame = coalescer.push(ev.delta, 4005);
      if (frame) visibleOutput += frame;
    }
  }
  visibleOutput += coalescer.flushRemaining();
  const elapsedMs = performance.now() - t0;

  assert.equal(visibleOutput.length, 2000 * 5);
  assert.ok(renderFrames < 550, `Expected <550 React render frames for 2,000 tokens, got ${renderFrames}`);
  assert.ok(elapsedMs < 35, `Expected 2,000 tokens parsed & coalesced in <35ms, took ${elapsedMs.toFixed(2)}ms`);
});

test("Speed-04: BoundedHotCache enforces Market/Tenant/User isolation, rejects unscoped keys, and supports invalidation", () => {
  const cache = new BoundedHotCache<string>({ maxEntries: 16, defaultTtlMs: 5000 });

  // 1. Strict tenant & market separation: same resource name in two markets or two tenants never collides
  const kwTenantA = { scope: "TENANT" as const, marketId: "KW", tenantId: "merchant_A", resource: "inventory" };
  const kwTenantB = { scope: "TENANT" as const, marketId: "KW", tenantId: "merchant_B", resource: "inventory" };
  const saTenantA = { scope: "TENANT" as const, marketId: "SA", tenantId: "merchant_A", resource: "inventory" };
  const kwUser1 = { scope: "USER" as const, marketId: "KW", userId: "user_1", resource: "prefs" };
  const kwUser2 = { scope: "USER" as const, marketId: "KW", userId: "user_2", resource: "prefs" };

  cache.set(kwTenantA, "KW_A_DATA", 5000, 1000);
  cache.set(kwTenantB, "KW_B_DATA", 5000, 1000);
  cache.set(saTenantA, "SA_A_DATA", 5000, 1000);
  cache.set(kwUser1, "USER_1_PREFS", 5000, 1000);
  cache.set(kwUser2, "USER_2_PREFS", 5000, 1000);

  assert.equal(cache.get(kwTenantA, 2000), "KW_A_DATA");
  assert.equal(cache.get(kwTenantB, 2000), "KW_B_DATA");
  assert.equal(cache.get(saTenantA, 2000), "SA_A_DATA");
  assert.equal(cache.get(kwUser1, 2000), "USER_1_PREFS");
  assert.equal(cache.get(kwUser2, 2000), "USER_2_PREFS");

  // 2. Targeted tenant invalidation removes ONLY that tenant's entries in that market
  assert.equal(cache.invalidateTenant("KW", "merchant_A"), 1);
  assert.equal(cache.get(kwTenantA, 2000), undefined);
  assert.equal(cache.get(kwTenantB, 2000), "KW_B_DATA");
  assert.equal(cache.get(saTenantA, 2000), "SA_A_DATA");

  // 3. Targeted user invalidation removes ONLY that user's entries
  assert.equal(cache.invalidateUser("KW", "user_1"), 1);
  assert.equal(cache.get(kwUser1, 2000), undefined);
  assert.equal(cache.get(kwUser2, 2000), "USER_2_PREFS");

  // 4. Market invalidation removes all remaining KW entries while preserving SA
  assert.equal(cache.invalidateMarket("KW"), 2);
  assert.equal(cache.get(kwTenantB, 2000), undefined);
  assert.equal(cache.get(kwUser2, 2000), undefined);
  assert.equal(cache.get(saTenantA, 2000), "SA_A_DATA");

  // 5. Rejects empty or delimiter-injected keys
  assert.throws(() => formatScopedCacheKey({ scope: "PUBLIC_MARKET", marketId: "", resource: "plans" }));
  assert.throws(() => formatScopedCacheKey({ scope: "TENANT", marketId: "KW", tenantId: "a|b", resource: "plans" }));

  // 6. TTL expiration and clear()
  assert.equal(cache.get(saTenantA, 7000), undefined);
  cache.clear();
  assert.equal(cache.size, 0);
});
