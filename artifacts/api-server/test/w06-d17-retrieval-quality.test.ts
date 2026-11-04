/**
 * D17.8 retrieval quality. The measured baseline (w06-d17-context-baseline.test) proves the turn
 * request stays bounded; this suite proves what the bounded retrieval actually returns: recall and
 * precision against labelled Arabic fixtures, stable pagination, the paraphrase gap that lexical
 * search provably cannot close, the trigram index it costs, and that the derived memory a turn uses
 * is disclosed in the user's own data export and disappears when it is forgotten.
 *
 * Deterministic fixtures only — no live model is consulted, so nothing here claims model
 * understanding. PostgreSQL rows remain the source of truth; the summary is derived evidence.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { DEFAULT_MARKET } from "@workspace/global";
import {
  MEMORY_SEARCH_MAX_LIMIT,
  forgetConversationMemory,
  rebuildSummary,
  searchConversationMemory,
} from "../src/ai/conversation-memory";
import { buildPersonalDataExport, personalDataSummary } from "../src/lib/privacy-rights";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W06_D17_MEMORY");

const OWNER = "w06d17-quality-owner";
const OTHER = "w06d17-quality-other";
const CONV = "w06d17-quality-conv";
const DISTRACTORS = 380;

/**
 * Each topic has the literal phrase its own messages contain, a query that repeats it, and a
 * paraphrase that shares no literal run with the stored text. The labelled relevant ids are exactly
 * the messages written for `phrase`, so recall and precision need no judgement call.
 */
const TOPICS = [
  { key: "fridge", phrase: "ثلاجة بابين", query: "ثلاجة بابين", paraphrase: "تبريد مزدوج الفتحات", count: 4 },
  { key: "washer", phrase: "غسالة اوتوماتيك", query: "غسالة اوتوماتيك", paraphrase: "تنظيف الملابس بدون تدخل", count: 3 },
  { key: "bike", phrase: "دراجة هوائية جبلية", query: "دراجة هوائية جبلية", paraphrase: "عجلة للطرق الوعرة", count: 2 },
  { key: "laptop", phrase: "لابتوب للاستخدام الخفيف", query: "لابتوب للاستخدام الخفيف", paraphrase: "حاسوب محمول للمكتب", count: 5 },
  { key: "ac", phrase: "قطع غيار مكيف سبليت", query: "قطع غيار مكيف سبليت", paraphrase: "تبريد غرفة معلّق", count: 1 },
] as const;

const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!;

const quality: Record<string, unknown> = {
  fixture: { conversations: 1, labelledMessages: TOPICS.reduce((sum, topic) => sum + topic.count, 0), distractorMessages: DISTRACTORS },
  queries: {} as Record<string, unknown>,
  pagination: {} as Record<string, unknown>,
};

await db.execute(sql`
  INSERT INTO users (id, display_name, phone_country_code, phone_number, normalized_phone, account_country, active_market_id, password_hash, status)
  VALUES (${OWNER}, 'صاحب قياس الاسترجاع', '+962', '796000011', '+962796000011', 'JO', ${DEFAULT_MARKET}, 'x', 'ACTIVE'),
         (${OTHER}, 'آخر لا علاقة له', '+962', '796000012', '+962796000012', 'JO', ${DEFAULT_MARKET}, 'x', 'ACTIVE')
  ON CONFLICT (id) DO NOTHING`);
await db.execute(sql`
  INSERT INTO conversations (id, owner_user_id, market_id, kind, title, created_at, updated_at)
  VALUES (${CONV}, ${OWNER}, ${DEFAULT_MARKET}, 'AI', 'محادثة قياس الاسترجاع', timestamptz '2026-01-01', timestamptz '2026-02-01')
  ON CONFLICT (id) DO NOTHING`);

// Old-first ids: `-q000001` is the oldest stored message. Every message a topic owns is labelled by
// its own id range, which is how recall is computed without a human judge.
await db.execute(sql`
  INSERT INTO messages (id, conversation_id, sender_id, body, actor, content_type, metadata, created_at, updated_at)
  SELECT ${CONV} || '-q' || lpad(g::text, 6, '0'), ${CONV}, ${OWNER},
         'سألت عن هاتف مستعمل بحالة جيدة مع ملحقاته، الفقرة ' || g || ' والبائع متاح اليوم في عمان.',
         'USER', 'TEXT', '{}'::jsonb,
         timestamptz '2026-01-01' + g * interval '1 second',
         timestamptz '2026-01-01' + g * interval '1 second'
  FROM generate_series(1, ${DISTRACTORS}::int) g
  ON CONFLICT (id) DO NOTHING`);
for (const [index, topic] of TOPICS.entries()) {
  await db.execute(sql`
    INSERT INTO messages (id, conversation_id, sender_id, body, actor, content_type, metadata, created_at, updated_at)
    SELECT ${CONV} || '-t' || (${index}::int + 1) || '-' || lpad(g::text, 3, '0'), ${CONV}, ${OWNER},
           'أريد ' || ${topic.phrase} || ' مع تفاصيل عن الحالة والسعر والضمان، الفقرة ' || g || '.',
           'USER', 'TEXT', '{}'::jsonb,
           timestamptz '2026-01-01' + (${DISTRACTORS}::int + ${index}::int * 10 + g) * interval '1 second',
           timestamptz '2026-01-01' + (${DISTRACTORS}::int + ${index}::int * 10 + g) * interval '1 second'
    FROM generate_series(1, ${topic.count}::int) g
    ON CONFLICT (id) DO NOTHING`);
}

/** The labelled ids for one topic, straight from the fixture layout. */
const labelledIds = (index: number, topic: { count: number }) =>
  Array.from({ length: topic.count }, (_, g) => `${CONV}-t${index + 1}-${String(g + 1).padStart(3, "0")}`);

await test("D17.8-R1 lexical retrieval returns every labelled message and nothing else", async () => {
  for (const [index, topic] of TOPICS.entries()) {
    const expected = new Set(labelledIds(index, topic));
    const samples: number[] = [];
    let hits: Awaited<ReturnType<typeof searchConversationMemory>> = [];
    for (let run = 0; run < 7; run++) {
      const started = performance.now();
      hits = await searchConversationMemory({ actorId: OWNER, query: topic.query, conversationId: CONV, limit: 8 });
      samples.push(performance.now() - started);
    }
    const returned = new Set(hits.map((hit) => hit.messageId));
    const recall = [...expected].filter((id) => returned.has(id)).length / expected.size;
    const precision = hits.length === 0 ? 0 : [...returned].filter((id) => expected.has(id)).length / hits.length;
    (quality.queries as Record<string, unknown>)[topic.key] = {
      labelled: expected.size,
      returned: hits.length,
      recallAt8: +recall.toFixed(3),
      precisionAt8: +precision.toFixed(3),
      latencyMs: { p50: +quantile(samples, 0.5).toFixed(2), p95: +quantile(samples, 0.95).toFixed(2) },
    };
    assert.equal(recall, 1, `${topic.key}: every labelled message must be retrievable within the limit`);
    assert.equal(precision, 1, `${topic.key}: no unlabelled message may be returned for a literal phrase`);
    assert.ok(hits.length <= MEMORY_SEARCH_MAX_LIMIT, `${topic.key}: result bound`);
    assert.ok(hits.every((hit) => hit.body.includes(topic.phrase)), `${topic.key}: the hit must carry the phrase it matched`);
  }
});

await test("D17.8-R2 a page smaller than the labelled set loses recall exactly by its size, and paging recovers it", async () => {
  const index = 3; // five labelled messages
  const topic = TOPICS[index]!;
  const expected = new Set(labelledIds(index, topic));
  const first = await searchConversationMemory({ actorId: OWNER, query: topic.query, conversationId: CONV, limit: 2 });
  const second = await searchConversationMemory({ actorId: OWNER, query: topic.query, conversationId: CONV, limit: 2, offset: 2 });
  const third = await searchConversationMemory({ actorId: OWNER, query: topic.query, conversationId: CONV, limit: 2, offset: 4 });
  const pages = [first, second, third].map((page) => page.map((hit) => hit.messageId));
  const union = new Set(pages.flat());
  (quality.pagination as Record<string, unknown>)[topic.key] = {
    labelled: expected.size,
    recallAt2: +(first.filter((hit) => expected.has(hit.messageId)).length / expected.size).toFixed(3),
    pageSizes: pages.map((page) => page.length),
    unionRecoversLabelled: [...expected].every((id) => union.has(id)),
    pagesOverlap: new Set(pages.flat()).size !== pages.flat().length,
  };
  assert.equal(first.length, 2, "a bounded page is a bounded page");
  assert.equal(union.size, expected.size, "three pages of two must cover exactly the five labelled messages");
  assert.ok([...expected].every((id) => union.has(id)), "pagination must be able to reach what one page cannot");
  assert.equal(new Set(pages.flat()).size, pages.flat().length, "offsets must not repeat or skip a message");
});

await test("D17.8-R3 the paraphrase gap is measured, not claimed away", async () => {
  const gaps: Record<string, unknown> = {};
  for (const [index, topic] of TOPICS.entries()) {
    const expected = new Set(labelledIds(index, topic));
    const hits = await searchConversationMemory({ actorId: OWNER, query: topic.paraphrase, conversationId: CONV, limit: 8 });
    gaps[topic.key] = {
      query: topic.paraphrase,
      returned: hits.length,
      recall: +([...expected].filter((id) => hits.some((hit) => hit.messageId === id)).length / expected.size).toFixed(3),
    };
  }
  quality.paraphraseGap = gaps;
  // Lexical retrieval cannot bridge synonyms; that is the documented limit of D17.3 and the reason
  // any embedding layer would need consent, approval and its own measurement before it is built.
  assert.ok(Object.values(gaps).every((gap) => (gap as { recall: number }).recall === 0), JSON.stringify(gaps));
});

await test("D17.8-R4 the owner bound is enforced by the query, not by filtering after the fact", async () => {
  const stranger = await searchConversationMemory({ actorId: OTHER, query: TOPICS[0]!.query, limit: 8 });
  const mine = await searchConversationMemory({ actorId: OWNER, query: TOPICS[0]!.query, conversationId: CONV, limit: 8 });
  const scopedElsewhere = await searchConversationMemory({ actorId: OWNER, query: TOPICS[0]!.query, conversationId: "w06d17-quality-other-conv", limit: 8 });
  assert.equal(stranger.length, 0, JSON.stringify(stranger));
  assert.equal(mine.length, TOPICS[0]!.count);
  assert.equal(scopedElsewhere.length, 0, "a conversation id that is not the owner's returns nothing");
});

await test("D17.8-R5 derived memory is disclosed in the user's own export and disappears when forgotten", async () => {
  const summary = await rebuildSummary(OWNER, CONV);
  assert.ok(summary, "a rebuild over stored messages produces a derived summary");
  const index = await personalDataSummary(OWNER);
  const derived = index.categories.find((item) => item.key === "conversationSummaries");
  assert.ok(derived && derived.count >= 1, `the privacy summary must count the derived rows: ${JSON.stringify(index.categories)}`);
  const exported = await buildPersonalDataExport(OWNER);
  const rows = exported.conversationSummaries.items;
  const mine = rows.filter((row) => row.conversationId === CONV);
  assert.equal(mine.length, 1, JSON.stringify(rows.map((row) => row.conversationId)));
  assert.equal(mine[0]!.derivation, "DETERMINISTIC_EXTRACTIVE", "the export says how the row was made");
  assert.ok(mine[0]!.sourceMessageIds.length > 0, "the export names the messages it was derived from");
  assert.equal(exported.conversationSummaries.truncated, false);
  assert.equal(await forgetConversationMemory(OWNER, CONV), true, "forgetting removes the derived row");
  const afterForget = await buildPersonalDataExport(OWNER);
  assert.equal(
    afterForget.conversationSummaries.items.filter((row) => row.conversationId === CONV).length,
    0,
    "a forgotten summary is gone from the export too, not only from the turn",
  );
});

await test("D17.8-R6 the trigram index behind retrieval is measured against the rows it indexes", async () => {
  const sizes = await db.execute(sql`
    SELECT pg_relation_size('messages')::bigint AS messages_heap_bytes,
           pg_indexes_size('messages')::bigint AS messages_index_bytes,
           pg_relation_size('messages_body_trgm_idx')::bigint AS trigram_index_bytes,
           (SELECT count(*) FROM pg_class WHERE relname = 'messages_body_trgm_idx')::int AS trigram_present,
           (SELECT count(*) FROM messages)::bigint AS indexed_messages`);
  const row = (sizes.rows as Array<Record<string, string>>)[0]!;
  const storedMessages = DISTRACTORS + TOPICS.reduce((sum, topic) => sum + topic.count, 0);
  const indexedMessages = Number(row.indexed_messages);
  const trigramBytes = Number(row.trigram_index_bytes);
  quality.index = {
    present: Number(row.trigram_present) === 1,
    storedMessages,
    indexedMessages,
    messagesHeapBytes: Number(row.messages_heap_bytes),
    messagesIndexBytes: Number(row.messages_index_bytes),
    trigramIndexBytes: trigramBytes,
    trigramBytesPerMessage: Math.round(trigramBytes / indexedMessages),
  };
  assert.equal(quality.index.present, true, "the D17 conversation-memory migration must create the trigram index");
  // The index covers every row in messages, and on a shared-database chain other suites' messages
  // are in there too. Dividing the whole index by this suite's own rows would charge their cost to
  // it, so the denominator is the row count the index actually covers.
  assert.ok(
    indexedMessages >= storedMessages,
    `the index must cover at least this suite's own messages: ${JSON.stringify(quality.index)}`,
  );
  // Calibrated against the D17.1 measurement: the trigram index cost ~2.3KB per ~150-character
  // message. An order of magnitude more per message would mean the index is not fit for this table.
  assert.ok(
    trigramBytes > 0 && Math.round(trigramBytes / indexedMessages) < 8192,
    `trigram index cost per message: ${JSON.stringify(quality.index)}`,
  );
});

after(async () => {
  // Messages reference the conversation and are not cascaded; the derived summary is.
  await db.execute(sql`DELETE FROM messages WHERE conversation_id = ${CONV}`);
  await db.execute(sql`DELETE FROM conversation_summaries WHERE conversation_id = ${CONV}`);
  await db.execute(sql`DELETE FROM conversations WHERE id = ${CONV}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER}, ${OTHER})`);
  console.log("W06_D17_RETRIEVAL_QUALITY_SUMMARY", JSON.stringify(quality));
  await pool.end();
});
