import { test } from "node:test";
import assert from "node:assert/strict";
import { DualChannelStreamParser, formatSseFrame, isTokenStreamingEnabled } from "../src/ai/dual-channel-stream";
import { buildModelFirstDialectPrompt, decideModelFirstEntry } from "../src/ai/model-first-router";
import { compressConversationWindow, recallColdArchiveTurns, type ConversationTurn } from "../src/ai/context-compressor";
import { isReadOnlyAgentLoopEnabled, isSafeReadOnlyTool, runBoundedReadOnlyLoop } from "../src/ai/read-only-agent-loop";
import { cosineSimilarity, reciprocalRankFusion, rerankHybridCandidates, type SearchCandidate } from "../src/ai/hybrid-search";
import { buildHydratedUniversalCardEnvelope, calculateAuthoritativeCardQuote, type ServerCatalogPricing } from "../src/ai/infinite-card-adapter";
import { buildCacheOptimizedPrompt } from "../src/ai/prompt-cache-layout";

test("AI-01: DualChannelStreamParser streams Arabic tokens immediately and parses split card fences safely", () => {
  assert.equal(isTokenStreamingEnabled({}), false);
  assert.equal(isTokenStreamingEnabled({ DINAR_AI_TOKEN_STREAMING: "1" }), true);
  const parser = new DualChannelStreamParser();
  const events = [
    ...parser.push("أهلًا! جهزت لك "),
    ...parser.push("بطاقة البرغر:\n``"),
    ...parser.push("`jassim-card\n{\"cardId\":\"burger-1\",\"stageMode\":\"LAYERED_STACK\"}\n``"),
    ...parser.push("`\nبالعافية!"),
    ...parser.flush(),
  ];
  const tokens = events.filter((e) => e.type === "token").map((e) => e.delta).join("");
  const cards = events.filter((e) => e.type === "card");
  assert.equal(tokens.includes("أهلًا! جهزت لك بطاقة البرغر:"), true);
  assert.equal(tokens.includes("بالعافية!"), true);
  assert.equal(tokens.includes("cardId"), false);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "jassim-card");
  assert.match(formatSseFrame(cards[0]), /^event: card\ndata: /);
});

test("AI-02: MODEL_FIRST router respects decision guard and falls back safely to LEGACY", () => {
  assert.equal(decideModelFirstEntry({ message: "نعم أكد الطلب وادفع الآن", hasPendingDecision: false, modelAvailable: true, env: { DINAR_AI_ROUTING_MODE: "MODEL_FIRST" } }).route, "BYPASS_DECISION_GUARD");
  assert.equal(decideModelFirstEntry({ message: "بدي جوال مستعمل رخيص للتصوير في عمّان", hasPendingDecision: false, modelAvailable: true, env: { DINAR_AI_ROUTING_MODE: "MODEL_FIRST" } }).route, "MODEL_FIRST");
  assert.equal(decideModelFirstEntry({ message: "أبغى لابتوب للمونتاج", hasPendingDecision: false, modelAvailable: false, env: { DINAR_AI_ROUTING_MODE: "MODEL_FIRST" } }).route, "FALLBACK_LEGACY");
  const prompt = buildModelFirstDialectPrompt({ countryNameAr: "الأردن", currencyCode: "JOD" });
  assert.match(prompt, /الأردن/);
  assert.match(prompt, /بدي/);
});

test("AI-03: 3-tier context compression keeps 50-turn chats O(1) bounded with lossless L3 recall", () => {
  const turns: ConversationTurn[] = Array.from({ length: 50 }, (_, i) => ({
    turnIndex: i + 1,
    role: i % 2 === 0 ? "user" : "assistant",
    text: i === 2 ? "أريد جاكيت كحلي مقاس L وميزانية أقل من 40 دينار ولا أريد اللون الأسود ورقمي 0791234567" : `رسالة محادثة رقم ${i + 1} حول التسوق في جاسم`,
  }));
  const compressed = compressConversationWindow({ turns, hotWindowSize: 6, maxPromptChars: 4000, activeCardDelta: { cardId: "demo-mannequin", stageMode: "MANNEQUIN", selectedIds: ["shirt-white", "jacket-navy"], quantity: 1 } });
  assert.equal(compressed.l1HotTurns.length, 6);
  assert.equal(compressed.droppedTurnCount, 44);
  assert.ok(compressed.l2WarmDigest !== null);
  assert.ok(compressed.estimatedChars <= 4000);
  assert.equal(JSON.stringify(compressed.l2WarmDigest).includes("0791234567"), false);
  const recall = recallColdArchiveTurns({ allTurns: turns, query: "جاكيت كحلي" });
  assert.equal(recall.hits.length, 1);
  assert.equal(recall.hits[0].turnIndex, 3);
});

test("AI-04: Bounded read-only ReAct loop chains parallel read tools and HARD-BLOCKS write/payment tools", async () => {
  assert.equal(isReadOnlyAgentLoopEnabled({}), false);
  assert.equal(isSafeReadOnlyTool("search_listings"), true);
  assert.equal(isSafeReadOnlyTool("place_order"), false);
  const ok = await runBoundedReadOnlyLoop({
    planNext: async (hop) => hop === 1 ? { kind: "TOOLS", calls: [{ id: "c1", name: "search_listings", args: { q: "سامسونج" } }, { id: "c2", name: "get_seller_rating", args: { sellerId: "s1" } }] } : { kind: "FINAL", reply: "هذه أفضل 3 هواتف سامسونج." },
    executeReadOnlyTool: async (call) => ({ ok: true, tool: call.name }),
  });
  assert.equal(ok.status, "COMPLETED");
  assert.equal(ok.hops, 2);
  const blocked = await runBoundedReadOnlyLoop({
    planNext: async () => ({ kind: "TOOLS", calls: [{ id: "w1", name: "checkout_pay", args: { orderId: "ord_1" } }] }),
    executeReadOnlyTool: async () => { throw new Error("Must never execute write tool!"); },
  });
  assert.equal(blocked.status, "BLOCKED_WRITE_ATTEMPT");
});

test("AI-05: Hybrid Search RRF fuses lexical + semantic matches with strict market & budget guards", () => {
  assert.ok(cosineSimilarity([1, 0, 0], [1, 0, 0]) > 0.99);
  const fused = reciprocalRankFusion([{ listingId: "l1", rank: 1 }, { listingId: "l2", rank: 2 }], [{ listingId: "l3", rank: 1 }, { listingId: "l1", rank: 2 }]);
  assert.equal(fused[0].listingId, "l1");
  const meta = new Map<string, SearchCandidate>([
    ["l1", { listingId: "l1", marketId: "JO", title: "عود ملكي فاخر", unitPriceMinor: 3500, inStock: true, verifiedMerchant: true, rating: 4.9 }],
    ["l2", { listingId: "l2", marketId: "KW", title: "عرض من سوق آخر", unitPriceMinor: 1000, inStock: true }],
    ["l3", { listingId: "l3", marketId: "JO", title: "عطر هدية فخمة", unitPriceMinor: 9000, inStock: true }],
  ]);
  const ranked = rerankHybridCandidates({ fused, metadata: meta, marketId: "JO", maxBudgetMinor: 5000 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].listingId, "l1");
});

test("AI-06: Infinite Card Server Adapter strips LLM prices and computes authoritative server totals", () => {
  const pricing: ServerCatalogPricing = { listingId: "burger-house-1", currencyCode: "JOD", currencyDecimals: 2, baseUnitMinor: 450, optionDeltasMinor: { cheese: 50, "patty-extra": 175, lettuce: 0 } };
  const envelope = buildHydratedUniversalCardEnvelope({ cardId: "card-burger-99", vertical: "FOOD_BUILDER", listingId: "burger-house-1", merchantName: "برغر هاوس", merchantTier: "CONNECT_PARTNER", title: "ساندويش برغر مخصص", stageMode: "LAYERED_STACK", selectedOptionIds: ["cheese", "patty-extra", "lettuce"], quantity: 2 }, pricing);
  assert.equal(envelope.quote.totalLabel, "13.50 JOD");
  assert.equal(calculateAuthoritativeCardQuote({ pricing, selectedOptionIds: ["cheese"], quantity: 1 }).totalLabel, "5.00 JOD");
});

test("AI-07: Prompt Cache Layout keeps static prefix hash stable across turns & Arabic evals pass", () => {
  const staticSys = "أنت جاسم (JassimAI)، مساعد التجارة الذكي. لا تُنفذ أي دفع دون تأكيد المستخدم.";
  const p1 = buildCacheOptimizedPrompt({ staticSystemPrefix: staticSys, dynamicContextBlock: "market=JO", userMessage: "أبي جوال" }, "ANTHROPIC");
  const p2 = buildCacheOptimizedPrompt({ staticSystemPrefix: staticSys, dynamicContextBlock: "market=SA", userMessage: "بدي ساعة" }, "ANTHROPIC");
  assert.equal(p1.prefixHash, p2.prefixHash);
  assert.deepEqual(p1.messages[0].cache_control, { type: "ephemeral" });
  for (const utterance of ["نعم", "أكيد نفذ", "ادفع الآن", "موافق على السعر", "انشره", "confirm"]) {
    assert.equal(decideModelFirstEntry({ message: utterance, hasPendingDecision: false, modelAvailable: true, env: { DINAR_AI_ROUTING_MODE: "MODEL_FIRST" } }).route, "BYPASS_DECISION_GUARD");
  }
});
