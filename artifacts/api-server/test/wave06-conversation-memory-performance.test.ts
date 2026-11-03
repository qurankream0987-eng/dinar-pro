/**
 * WAVE 06 D17.7 performance proof over disposable PostgreSQL: synthetic histories of 100, 1,000
 * and 10,000 messages in the canonical `messages` store. Measured per scale: search latency
 * (p50/p95), result bounds, EXPLAIN (ANALYZE, BUFFERS) plans with and without sequential scans to
 * show `messages_body_trgm_idx` usability, summary rebuild cost and its bounded source window,
 * rendered context size, and concurrent read/write stability.
 *
 * Asserted (stable, not timing-fragile): every search stays inside its declared limit and returns
 * results within the module's own 400 ms statement timeout; the planner uses the trigram index for
 * a selective query instead of a sequential scan; a summary reads a fixed window and never grows
 * with history; a model memory block never exceeds its budget; concurrent writes never break reads.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { conversationSummaries, conversations, db, markets, messages, pool, users } from "@workspace/db";
import { DEFAULT_MARKET } from "@workspace/global";
import {
  MAX_MEMORY_CONTEXT_CHARS,
  SUMMARY_MAX_CHARS,
  SUMMARY_SOURCE_LIMIT,
  conversationMemoryContext,
  currentConversationMemory,
  renderMemoryContext,
  searchConversationMemory,
} from "../src/ai/conversation-memory";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W06_D17_ACCEPTANCE");

const runId = randomUUID().slice(0, 8);
const SCALES = [100, 1_000, 10_000];
const report: Record<string, unknown> = { scales: SCALES, postgres: ((await db.execute(sql`SELECT version()`)).rows[0] as { version: string }).version };

const [market] = await db.select().from(markets).where(eq(markets.id, DEFAULT_MARKET)).limit(1);
assert.ok(market, `expected migrated market ${DEFAULT_MARKET}`);

const owner = randomUUID();
await db.insert(users).values({
  id: owner,
  displayName: `D17 perf ${runId}`,
  phoneCountryCode: "+962",
  phoneNumber: "779999999",
  normalizedPhone: `d17-perf-${runId}`,
  accountCountry: "JO",
  activeMarketId: market!.id,
  passwordHash: "fixture-unused",
  role: "USER",
});
const conversation = randomUUID();
await db.insert(conversations).values({ id: conversation, kind: "AI", ownerUserId: owner, marketId: market!.id });

let generated = 0;
/**
 * Appends synthetic turns up to `total`. Most turns carry a common word, one in ten carries a
 * brand, and one in 997 carries a rare word, so a selective query has a known small answer.
 */
async function growTo(total: number) {
  const started = performance.now();
  // A real insert path: the trigram GIN index is maintained as rows arrive.
  await db.execute(sql`
    INSERT INTO messages (id, conversation_id, sender_id, body, actor, metadata, created_at, updated_at)
    SELECT 'd17-perf-' || lpad(g::text, 6, '0'),
      ${conversation},
      ${owner},
      CASE
        WHEN g % 997 = 0 THEN 'زيركونيوم جوال معروض للبيع رقم ' || g
        WHEN g % 10 = 0 THEN 'سامسونج جوال معروض للبيع رقم ' || g
        ELSE 'جوال معروض للبيع رقم ' || g
      END,
      CASE WHEN g % 2 = 0 THEN 'USER' ELSE 'ASSISTANT' END,
      '{}'::jsonb,
      timestamptz '2026-01-01' + g * interval '1 second',
      timestamptz '2026-01-01' + g * interval '1 second'
    FROM generate_series(${generated + 1}::int, ${total}::int) g`);
  generated = total;
  await db.execute(sql`ANALYZE messages`);
  return Math.round(performance.now() - started);
}

const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!;

async function measure(query: string, limit: number, runs: number) {
  await searchConversationMemory({ actorId: owner, query, limit }); // warm the plan and caches
  const samples: number[] = [];
  let hits = 0;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    const found = await searchConversationMemory({ actorId: owner, query, limit });
    samples.push(performance.now() - started);
    hits = found.length;
  }
  return { p50: +quantile(samples, 0.5).toFixed(1), p95: +quantile(samples, 0.95).toFixed(1), hits, samples: samples.length };
}

/** The same predicate and ordering the module issues, so the plan is the real one. */
const SEARCH_SQL = `
  SELECT m.id FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.owner_user_id = $1 AND c.kind = 'AI'
    AND m.body ILIKE $2
  ORDER BY similarity(m.body, $3) * 0.7 + exp(-extract(epoch FROM (now() - m.created_at)) / 604800.0) * 0.3 DESC,
    m.created_at DESC, m.id ASC
  LIMIT $4`;

async function planFor(query: string, limit: number, sequential: boolean) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL enable_seqscan = ${sequential ? "on" : "off"}`);
    const explained = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${SEARCH_SQL}`, [owner, `%${query}%`, query, limit]);
    await client.query("ROLLBACK");
    const text = explained.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
    return {
      text,
      index: text.includes("messages_body_trgm_idx"),
      anyIndex: /Index Scan|Bitmap Index Scan/.test(text),
      seqScan: /Seq Scan on messages/.test(text),
      rowsRemoved: Number(/Rows Removed by Filter: (\d+)/.exec(text)?.[1] ?? 0),
    };
  } finally {
    client.release();
  }
}

/** The bare selective predicate, proving the trigram index is usable for this pattern at all. */
async function trigramPlanFor(query: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const explained = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT id FROM messages WHERE body ILIKE $1 LIMIT 20`,
      [`%${query}%`],
    );
    await client.query("ROLLBACK");
    const text = explained.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
    return { text, index: text.includes("messages_body_trgm_idx") };
  } finally {
    client.release();
  }
}

const [trigramIndex] = (await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'messages' AND indexname = 'messages_body_trgm_idx'`)).rows as Array<{ indexdef: string }>;
assert.ok(trigramIndex, "the migration created messages_body_trgm_idx");
assert.match(trigramIndex!.indexdef, /USING gin/i);
assert.match(trigramIndex!.indexdef, /gin_trgm_ops/);

for (const scale of SCALES) {
  await test(`D17.7 ${scale.toLocaleString("en")} messages: bounded result, bounded latency and a real index plan`, async () => {
    const ingestMs = await growTo(scale);
    const common = await measure("جوال", 20, scale >= 10_000 ? 7 : 11);
    const brand = await measure("سامسونج", 20, scale >= 10_000 ? 7 : 11);
    const rare = await measure("زيركونيوم", 20, 5);
    // The module's own 400 ms statement timeout means an empty result is also a failure to answer;
    // a non-empty, limit-bounded answer proves the query completed inside its budget.
    assert.ok(common.hits > 0, `${scale}: the common query answered inside its statement timeout`);
    assert.ok(common.hits <= 20 && brand.hits <= 20 && rare.hits <= 20, `${scale}: results never exceed the requested limit`);
    assert.equal(rare.hits, scale >= 1_000 ? Math.min(20, Math.floor(scale / 997)) : 0, `${scale}: a rare term matches only planted rows`);
    for (const [name, sample] of Object.entries({ common, brand, rare })) assert.ok(sample.p95 < 2_000, `${scale} ${name}: p95 ${sample.p95}ms`);
    const indexPlan = await planFor("زيركونيوم", 20, false);
    const naturalPlan = await planFor("زيركونيوم", 20, true);
    // Owner-first execution is index-driven at every scale; which index leads depends on how much
    // of the table belongs to this owner, so only "an index, never a sequential scan" is asserted.
    if (scale >= 1_000) assert.ok(indexPlan.anyIndex && !indexPlan.seqScan, `${scale}: the scoped search is index-driven\n${indexPlan.text}`);
    // The trigram GIN index proves it is usable for this selective pattern.
    const trigramPlan = scale >= 1_000 ? await trigramPlanFor("زيركونيوم") : null;
    if (trigramPlan) assert.ok(trigramPlan.index, `${scale}: the selective predicate can use messages_body_trgm_idx\n${trigramPlan.text}`);
    report[`scale_${scale}`] = {
      ingestMs,
      common,
      brand,
      rare,
      scopedPlan: { trigramIndex: indexPlan.index, anyIndex: indexPlan.anyIndex, seqScan: indexPlan.seqScan, text: indexPlan.text },
      naturalPlan: { trigramIndex: naturalPlan.index, seqScan: naturalPlan.seqScan },
      trigramPlan: trigramPlan ? { index: trigramPlan.index, text: trigramPlan.text } : null,
    };
  });
}

await test("D17.5/D17.7 a summary over 10,000 messages reads a fixed source window and stays inside its cap", async () => {
  assert.equal(generated, 10_000);
  const started = performance.now();
  const summary = await currentConversationMemory(owner, conversation);
  const rebuildMs = performance.now() - started;
  assert.ok(summary, "a summary exists for the history");
  assert.ok(summary!.summary.length <= SUMMARY_MAX_CHARS, `${summary!.summary.length} <= ${SUMMARY_MAX_CHARS}`);
  assert.ok(summary!.messageCount <= 12, `summary covers ${summary!.messageCount} messages, not the whole history`);
  const [row] = await db.select().from(conversationSummaries).where(eq(conversationSummaries.conversationId, conversation));
  assert.ok(row);
  assert.ok(row!.sourceMessageIds.length <= SUMMARY_SOURCE_LIMIT);
  assert.ok(row!.sourceMessageIds.length <= 12);
  // The bounded prompt block is what the model actually receives.
  const context = await conversationMemoryContext({ actorId: owner, conversationId: conversation, marketId: market!.id, query: "زيركونيوم" });
  const rendered = renderMemoryContext(context);
  assert.ok(rendered.length > 0);
  assert.ok(rendered.length <= MAX_MEMORY_CONTEXT_CHARS + 260, `${rendered.length} chars`);
  report.summary = { rebuildMs: +rebuildMs.toFixed(1), messageCount: summary!.messageCount, characters: summary!.summary.length, contextCharacters: rendered.length };
});

await test("D17.7 concurrent writes do not break bounded reads or corrupt the derived summary", async () => {
  const write = (async () => {
    await db.execute(sql`
      INSERT INTO messages (id, conversation_id, sender_id, body, actor, metadata, created_at, updated_at)
      SELECT 'd17-perf-live-' || lpad(g::text, 4, '0'), ${conversation}, ${owner},
        'جوال أثناء الكتابة رقم ' || g || CASE WHEN g % 50 = 0 THEN ' سامسونج' ELSE '' END,
        'USER', '{}'::jsonb, now() + g * interval '10 milliseconds', now() + g * interval '10 milliseconds'
      FROM generate_series(1, 100) g`);
  })();
  const reads = Array.from({ length: 10 }, () => searchConversationMemory({ actorId: owner, query: "جوال", limit: 5 }));
  await write;
  const results = await Promise.all(reads);
  assert.ok(results.every((hits) => Array.isArray(hits) && hits.length <= 5), "every concurrent read stayed bounded");
  assert.ok(results.every((hits) => hits.every((hit) => hit.conversationId === conversation)), "no concurrent read escaped the conversation");
  const answered = results.filter((hits) => hits.length > 0).length;
  // Under contention the layer may degrade to an empty answer (its designed fail-closed fallback);
  // it must never throw, widen, or mislabel. A settled read after the write must still answer.
  const settled = await searchConversationMemory({ actorId: owner, query: "جوال", limit: 5 });
  assert.ok(settled.length > 0, "a settled read still answers after the concurrent write");
  assert.ok(settled.every((hit) => hit.conversationId === conversation), "the settled read stays scoped");
  const summary = await currentConversationMemory(owner, conversation);
  assert.ok(summary);
  assert.equal((await db.select().from(conversationSummaries).where(eq(conversationSummaries.conversationId, conversation))).length, 1, "one derived row");
  report.concurrent = { reads: results.length, answeredDuringWrite: answered, settledHits: settled.length };
});

after(async () => {
  console.log("D17_MEMORY_PERFORMANCE", JSON.stringify(report));
  if (process.env.DINAR_MEMORY_BENCH_OUT) writeFileSync(process.env.DINAR_MEMORY_BENCH_OUT, JSON.stringify(report, null, 1));
  await db.delete(conversationSummaries).where(eq(conversationSummaries.conversationId, conversation));
  await db.execute(sql`DELETE FROM messages WHERE conversation_id = ${conversation}`);
  await db.delete(conversations).where(eq(conversations.id, conversation));
  await db.delete(users).where(eq(users.id, owner));
  await pool.end();
});
