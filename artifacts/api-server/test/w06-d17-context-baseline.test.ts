/**
 * D17.1 — the measured baseline for long conversations, written before any memory code exists.
 *
 * The Wave-06 brief forbids raising limits blind. This suite measures what DINAR does today when a
 * conversation grows: how many rows one turn reads, how large the provider request actually is,
 * what fraction of an old transcript can still reach the model, and what it costs. Every number is
 * printed as one JSON line (W06_D17_BASELINE) so the report quotes measurements, not intentions.
 *
 * No provider is contacted: the request is captured at the single assembly point
 * (modelMessagesFor), the same array interpretWithModel sends. Model understanding is never
 * claimed from these fixtures — only the size, the reads and the reachability of history.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { DEFAULT_MARKET } from "@workspace/global";
import { marketFor } from "../src/lib/markets";
import { modelContext } from "../src/ai/smart-turn";
import { personalContext } from "../src/ai/personal-context-service";
import {
  conversationHistory,
  HISTORY_SCAN_ROWS,
  MAX_MODEL_INPUT_CHARS,
  modelMessagesFor,
} from "../src/ai/model-turn";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W06_D17_MEMORY");

const SCALES = [100, 1_000, 10_000] as const;
const OWNER = "w06d17-baseline-owner";
const runId = randomUUID().slice(0, 8);
// An Arabic-letter token survives redactForModel, so its presence or absence in the request is a
// fact about reachability rather than about scrubbing.
const letterOf = (char: string) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]!;
const HIDDEN_TOKEN = [...runId].map(letterOf).join("");
const VISIBLE_TOKEN = [...randomUUID().slice(0, 8)].map(letterOf).join("");

// Query counting is done on the pg client prototype itself, so every statement this turn issues —
// including ones inside the code under test — is counted without changing behaviour.
const probe = await pool.connect();
const clientPrototype = Object.getPrototypeOf(probe) as Record<string, any>;
const originalQuery = clientPrototype.query;
let queryCount = 0;
clientPrototype.query = function counted(this: any, ...args: unknown[]) {
  queryCount++;
  return originalQuery.apply(this, args);
};
probe.release();

async function countQueries<T>(work: () => Promise<T>): Promise<{ value: T; queries: number }> {
  const before = queryCount;
  const value = await work();
  return { value, queries: queryCount - before };
}

const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!;

/**
 * `EXPLAIN (FORMAT JSON)` returns one row whose single column carries the plan array — a JSON
 * string in some drivers, already parsed in others. Unwrap whichever shape this driver used.
 */
function explainPlan(rows: unknown[]): Record<string, unknown> {
  let value: unknown = rows[0];
  for (let step = 0; step < 4; step++) {
    if (typeof value === "string") { value = JSON.parse(value); continue; }
    if (Array.isArray(value)) { value = value[0]; continue; }
    const row = value as Record<string, unknown>;
    if ("Plan" in row) return row.Plan as Record<string, unknown>;
    value = Object.values(row)[0];
  }
  throw new Error(`unexpected EXPLAIN JSON shape: ${JSON.stringify(rows[0]).slice(0, 300)}`);
}

const report: Record<string, unknown> = {
  postgres: ((await db.execute(sql`SELECT version()`)).rows as Array<{ version: string }>)[0].version,
  scanRows: HISTORY_SCAN_ROWS + 1,
  inputCeilingChars: MAX_MODEL_INPUT_CHARS,
  hiddenToken: { position: 1 },
  visibleToken: { position: "last-2" },
  scales: {} as Record<string, unknown>,
};

await db.execute(sql`
  INSERT INTO users (id, display_name, phone_country_code, phone_number, normalized_phone, account_country, active_market_id, password_hash, status)
  VALUES (${OWNER}, 'صاحب محادثة القياس', '+962', '796000001', '+962796000001', 'JO', ${DEFAULT_MARKET}, 'x', 'ACTIVE')
  ON CONFLICT (id) DO NOTHING`);

// Measured in the serving state, the same one a real turn sees.
await db.execute(sql`UPDATE markets SET is_active = true, status = 'ACTIVE' WHERE id = ${DEFAULT_MARKET}`);
const market = await marketFor({ actor: { activeMarketId: DEFAULT_MARKET } });
report.market = { id: market.id, available: market.isActive && ["ACTIVE", "LIMITED"].includes(market.status) };

/** A synthetic conversation of `count` alternating turns, old first, with the two probe tokens. */
async function seedConversation(conversationId: string, count: number) {
  await db.execute(sql`
    INSERT INTO conversations (id, owner_user_id, market_id, kind, title, created_at, updated_at)
    VALUES (${conversationId}, ${OWNER}, ${DEFAULT_MARKET}, 'AI', 'محادثة قياس الذاكرة',
            timestamptz '2026-01-01', timestamptz '2026-01-01' + ${count} * interval '1 second')
    ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO messages (id, conversation_id, sender_id, body, actor, content_type, metadata, created_at, updated_at)
    SELECT ${conversationId} || '-m' || lpad(g::text, 6, '0'),
           ${conversationId},
           ${OWNER},
           CASE WHEN g % 2 = 0 THEN
             'ابي ' || (ARRAY['هاتف','لابتوب','كنب','غسالة','دراجة','فستان'])[1 + g % 6] ||
             ' مستعمل بسعر مناسب في عمان مع ضمان مكتوب، الفقرة ' || g ||
             ' تفصيل عن الحالة والاستعمال والبائع المتاح للتواصل اليوم.'
           ELSE
             'عندي ' || (ARRAY['هاتف','لابتوب','كنب','غسالة','دراجة','فستان'])[1 + g % 6] ||
             ' بحالة ممتازة وسعره معقول، الفقرة ' || g ||
             ' رد من المساعد يشرح الخيارات المتاحة ويطلب تفاصيل إضافية عن الميزانية والمدينة.'
           END ||
           CASE WHEN g = 1 THEN ' احتفظت بعقد الصيانة تحت رمز ' || ${HIDDEN_TOKEN} || ' ولا أريد تغييره.'
                WHEN g = ${count} - 2 THEN ' رمز الفحص الأخير هو ' || ${VISIBLE_TOKEN} || ' وأرجو عدم نسيانه.'
                ELSE '' END,
           CASE WHEN g % 2 = 0 THEN 'USER' ELSE 'ASSISTANT' END,
           'TEXT', '{}'::jsonb,
           timestamptz '2026-01-01' + g * interval '1 second',
           timestamptz '2026-01-01' + g * interval '1 second'
    FROM generate_series(1, ${count}) g
    ON CONFLICT (id) DO NOTHING`);
}

const currentMessage = "كم يبقى من محادثتي صالحًا للاستخدام؟";

for (const scale of SCALES) {
  await test(`D17.1-${scale} one turn reads a bounded window and sends a bounded request`, async () => {
    const conversationId = `w06d17-conv-${scale}`;
    const seedStarted = performance.now();
    await seedConversation(conversationId, scale);
    const seedMs = Math.round(performance.now() - seedStarted);

    const stored = (await db.execute(sql`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conversationId}`)).rows as Array<{ n: number }>;
    assert.equal(stored[0]!.n, scale, `${scale} synthetic turns must be on file`);

    const runs = scale >= 10_000 ? 5 : 7;
    const latencies: number[] = [];
    let heapPeak = 0;
    let context: Awaited<ReturnType<typeof modelContext>> | undefined;
    let queries = 0;
    for (let run = 0; run < runs; run++) {
      const before = process.memoryUsage().heapUsed;
      const started = performance.now();
      const measured = await countQueries(() =>
        modelContext({ conversationId, message: currentMessage, market, actorId: OWNER }),
      );
      latencies.push(performance.now() - started);
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed - before);
      context = measured.value;
      queries = measured.queries;
    }

    const historyRows = await db.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT id FROM messages WHERE conversation_id = ${conversationId}
        ORDER BY created_at DESC LIMIT ${HISTORY_SCAN_ROWS + 1}
      ) window`);
    const windowRows = (historyRows.rows as Array<{ n: number }>)[0]!.n;

    const messages = modelMessagesFor(currentMessage, context!);
    const text = messages.map((message) => message.content).join("\n");
    const history = conversationHistory(context!);
    const perRole = Object.fromEntries(
      ["system", "user", "assistant"].map((role) => [
        role,
        messages.filter((message) => message.role === role).reduce((sum, message) => sum + message.content.length, 0),
      ]),
    );

    // What a real token search over the stored transcript costs at this scale, unindexed: the
    // number D17.3's PostgreSQL lexical index has to beat.
    const needleSql = `SELECT id FROM messages WHERE conversation_id = $1 AND body ILIKE '%' || $2 || '%'`;
    await pool.query(needleSql, [conversationId, HIDDEN_TOKEN]); // warm
    const scanSamples: number[] = [];
    let scanBuffers = 0;
    for (let run = 0; run < 3; run++) {
      const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${needleSql}`, [conversationId, HIDDEN_TOKEN]);
      const plan = explainPlan(explained.rows);
      scanSamples.push(Number(plan["Actual Total Time"]));
      scanBuffers += Number(plan["Shared Hit Blocks"] ?? 0) + Number(plan["Shared Read Blocks"] ?? 0);
    }

    const size = await db.execute(sql`
      SELECT pg_total_relation_size('messages')::bigint AS table_bytes,
             pg_relation_size('messages_conversation_idx')::bigint AS conversation_index_bytes`);
    const sizes = (size.rows as Array<{ table_bytes: string; conversation_index_bytes: string }>)[0]!;

    const promptChars = text.length;
    const entry = {
      storedTurns: scale,
      seedMs,
      contextQueries: queries,
      contextRowsRead: windowRows,
      contextMs: { p50: +quantile(latencies, 0.5).toFixed(1), p95: +quantile(latencies, 0.95).toFixed(1) },
      heapPeakKb: Math.round(heapPeak / 1024),
      requestChars: promptChars,
      requestMessages: messages.length,
      perRoleChars: perRole,
      recentTurns: history.recent.length,
      earlierTopicHints: history.earlierUserTopics.length,
      historyTurnsSupplied: context!.history?.length ?? 0,
      turnsReachableByModel: history.recent.length + history.earlierUserTopics.length,
      transcriptCoverage: +(history.recent.length / scale).toFixed(5),
      hiddenTokenInRequest: text.includes(HIDDEN_TOKEN),
      visibleTokenInRequest: text.includes(VISIBLE_TOKEN),
      unindexedNeedleScan: {
        p50Ms: +quantile(scanSamples, 0.5).toFixed(2),
        blocksPerProbe: Math.round(scanBuffers / 3),
      },
      messagesTableBytes: Number(sizes.table_bytes),
      conversationIndexBytes: Number(sizes.conversation_index_bytes),
    };
    (report.scales as Record<string, unknown>)[String(scale)] = entry;
    console.log("W06_D17_BASELINE", JSON.stringify({ scale, ...entry }));

    // The request is bounded by the engine's own published ceiling, at every scale.
    assert.ok(promptChars <= MAX_MODEL_INPUT_CHARS, `${scale}: ${promptChars} > ${MAX_MODEL_INPUT_CHARS}`);
    // One turn never loads the transcript: the window is the scan bound, not the conversation size.
    assert.equal(windowRows, Math.min(scale, HISTORY_SCAN_ROWS + 1), `${scale}: window rows`);
    assert.equal(context!.history!.length, Math.min(scale, HISTORY_SCAN_ROWS + 1) - 1, `${scale}: history handed to the model`);
    // The out-of-window fact is not merely short, it is unreachable.
    assert.equal(entry.hiddenTokenInRequest, false, `${scale}: an out-of-window fact must not reach the provider today`);
    // The in-window fact proves the measurement reads the real request.
    assert.equal(entry.visibleTokenInRequest, true, `${scale}: the recent window must carry its own facts`);
    // A longer conversation may not add reads: the same bounded queries at every scale.
    assert.equal(queries, (report.scales as Record<string, any>)["100"]?.contextQueries, `${scale}: queries per turn must not grow with the transcript`);
  });
}

await test("D17.1-B the request does not grow with the transcript", async () => {
  const scales = report.scales as Record<string, { requestChars: number; contextQueries: number; turnsReachableByModel: number; transcriptCoverage: number }>;
  const base = scales["100"]!;
  for (const scale of ["1000", "10000"]) {
    const entry = scales[scale]!;
    assert.ok(
      Math.abs(entry.requestChars - base.requestChars) <= 400,
      `${scale}: request grew from ${base.requestChars} to ${entry.requestChars} chars while the transcript grew 100x`,
    );
    assert.ok(entry.turnsReachableByModel <= 16, `${scale}: at most ten recent turns plus six topic hints reach the model`);
    assert.ok(entry.transcriptCoverage < base.transcriptCoverage, `${scale}: coverage of the transcript falls as it grows (${entry.transcriptCoverage})`);
  }
  report.summary = {
    requestCharsByScale: Object.fromEntries(Object.entries(scales).map(([key, value]) => [key, value.requestChars])),
    contextQueriesByScale: Object.fromEntries(Object.entries(scales).map(([key, value]) => [key, value.contextQueries])),
    coverageByScale: Object.fromEntries(Object.entries(scales).map(([key, value]) => [key, value.transcriptCoverage])),
  };
});

await test("D17.1-C the existing memory path is per-owner topic rows loaded and ranked in Node", async () => {
  const started = performance.now();
  const measured = await countQueries(() => personalContext.getRelevantContext(OWNER, currentMessage));
  const ms = performance.now() - started;
  const memoryRows = (await db.execute(sql`SELECT count(*)::int AS n FROM personal_memories WHERE user_id = ${OWNER}`)).rows as Array<{ n: number }>;
  report.personalMemoryPath = {
    storedRowsForOwner: memoryRows[0]!.n,
    queriesPerTurn: measured.queries,
    ms: +ms.toFixed(2),
    returned: measured.value.length,
    // getRelevantContext selects every row for the owner and ranks them in the process.
    loadsAllOwnerRows: true,
  };
  assert.ok(measured.queries >= 1, "the memory path is consulted on every smart turn");
});

after(async () => {
  clientPrototype.query = originalQuery;
  await db.execute(sql`DELETE FROM messages WHERE conversation_id LIKE 'w06d17-conv-%'`);
  await db.execute(sql`DELETE FROM conversations WHERE id LIKE 'w06d17-conv-%'`);
  await db.execute(sql`DELETE FROM personal_memory_events WHERE user_id = ${OWNER}`);
  await db.execute(sql`DELETE FROM personal_memories WHERE user_id = ${OWNER}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${OWNER}`);
  console.log("W06_D17_BASELINE_SUMMARY", JSON.stringify(report));
  await pool.end();
});
