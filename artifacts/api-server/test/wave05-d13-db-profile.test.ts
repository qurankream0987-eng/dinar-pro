/**
 * WAVE 05 / D13 — QUERY PLANS, ROUND TRIPS AND BACKGROUND WORK.
 *
 * Every number in the WAVE05_DB_PROFILE report is measured against the real schema on the runner's
 * throwaway loopback PostgreSQL: EXPLAIN (ANALYZE, BUFFERS) per hot predicate, a latency distribution
 * per predicate, the statement count and payload of a conversation-history read at three history
 * sizes, the duplicate work two background index workers do when they tick together, and the database
 * configuration the pool ceiling is compared against.
 *
 * The assertions are the scalability contract, not invented capacity figures:
 *  - a predicate the product issues on every page must be served from an index, not the heap;
 *  - opening a conversation must cost a bounded number of queries, not one per message per action;
 *  - several replicas must not rebuild the same documents twice;
 *  - nothing on the hot path may be sequentially slow enough to show up as a slow query.
 * Where the same SHA is dispatched twice (default and raised DINAR_DB_POOL_MAX), the report shows the
 * effect of the knob instead of a claim about it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import app from "../src/app";
import { db, offerSearchDocuments, offers, pool } from "@workspace/db";
import { receiptViews } from "../src/ai/action-receipts";
import { refreshSearchDocuments } from "../src/lib/marketplace-search-index";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE05_PROFILE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
process.env.DINAR_SEARCH_ENGINE = "SQL";

const OFFERS = Number(process.env.DINAR_WAVE05_LISTINGS ?? 20_000);
const BENCH_SELLERS = 50;
const SLOW_MS = 250;
const RUNS_PER_PREDICATE = 25;

const report: Record<string, unknown> = {
  configuration: {
    offers: OFFERS,
    runsPerPredicate: RUNS_PER_PREDICATE,
    slowQueryMs: SLOW_MS,
    poolMax: pool.options.max,
    connectionTimeoutMs: pool.options.connectionTimeoutMillis,
    poolMaxIsEnvKnob: true,
  },
};

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port as number}/api`;

// ─── statement counting ──────────────────────────────────────────────────────
// pg exposes no hook for "statements this process just issued", and the workspace does not let a
// test import pg directly (pnpm keeps it under lib/db). The client class is taken from a live pool
// connection instead, and its query() is wrapped. The connection used by this suite's own measurement
// queries is excluded, so a count is the application's, never the instrument's.
const probe = await pool.connect();
const clientPrototype = Object.getPrototypeOf(probe) as Record<string, unknown>;
const prototypeQuery = clientPrototype.query as (this: unknown, ...args: unknown[]) => unknown;
let counting = false;
let statements = 0;
clientPrototype.query = function (this: unknown, ...args: unknown[]) {
  if (counting && this !== probe) statements++;
  return prototypeQuery.apply(this, args);
};

async function measure<T>(workload: () => Promise<T>): Promise<{ statements: number; ms: number; value: T }> {
  statements = 0;
  counting = true;
  const started = performance.now();
  const value = await workload();
  const ms = performance.now() - started;
  counting = false;
  return { statements, ms, value };
}

type QueryResult = { status: number; bytes: number; json: any };
const getJson = async (path: string, cookie = ""): Promise<QueryResult> => {
  const response = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
  const text = await response.text();
  return { status: response.status, bytes: text.length, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined };
};

// ─── fixtures ────────────────────────────────────────────────────────────────

const phoneSeed = 2_000_000 + (Date.now() % 5_000_000);
let phoneOffset = 0;
let ipOctet = 0;
async function register(label: string): Promise<{ id: string; cookie: string }> {
  // Jordanian mobiles are 7[789] + 7 digits, validated by libphonenumber in normalizePhone().
  const phoneNumber = `79${phoneSeed + phoneOffset++}`;
  const forwarded = () => `203.0.113.${(ipOctet++ % 200) + 1}`;
  const headers = { "Content-Type": "application/json", "X-Forwarded-For": forwarded() };
  const challenge = await (await fetch(`${base}/auth/phone-verification/challenges`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phoneCountryCode: "+962", phoneNumber }),
  })).json();
  const verified = await (await fetch(`${base}/auth/phone-verification/challenges/verify`, {
    method: "POST",
    headers: { ...headers, "X-Forwarded-For": forwarded() },
    body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.developmentCode }),
  })).json();
  const password = `Wave05Profile-${randomUUID().slice(0, 12)}!`;
  const registered = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { ...headers, "X-Forwarded-For": forwarded() },
    body: JSON.stringify({
      displayName: `DINAR PF ${label}`,
      accountCountry: "JO",
      phoneCountryCode: "+962",
      phoneNumber,
      password,
      confirmPassword: password,
      acceptTerms: true,
      verificationToken: verified.verificationToken,
    }),
  });
  const text = await registered.text();
  assert.equal(registered.status, 201, text);
  const cookie = registered.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal((await fetch(`${base}/account/market`, { method: "PATCH", headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ marketId: "JO" }) })).status, 200);
  return { id: (JSON.parse(text) as any).user.id as string, cookie };
}

await test("PF-01 grow a market big enough that a plan choice is a fact, not a coincidence", async () => {
  await db.execute(sql`
    INSERT INTO users (id, display_name, phone_country_code, phone_number, normalized_phone, account_country, active_market_id, password_hash, status)
    SELECT 'pf-seller-' || g, 'بائع ملفات ' || g, '+962', '79' || lpad(g::text, 7, '0'), '+96279' || lpad(g::text, 7, '0'), 'JO', 'JO', 'x', 'ACTIVE'
    FROM generate_series(1, ${BENCH_SELLERS}) g
    ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO offers (id, seller_id, market_id, status, unit_price_minor, pricing_mode, inventory_mode, available_quantity, reserved_quantity, data, created_at, updated_at)
    SELECT 'pf-' || lpad(g::text, 7, '0'),
           'pf-seller-' || (1 + g % ${BENCH_SELLERS}),
           'JO',
           CASE WHEN g % 23 = 0 THEN 'PAUSED' ELSE 'PUBLISHED' END,
           (7 + (g * 41) % 3000) * 1000, 'FIXED', 'LIMITED', 500, 0,
           jsonb_build_object(
             'title', (ARRAY['هاتف','لابتوب','سيارة','كنب','غسالة','تيشيرت','فستان','عطر'])[1 + g % 8] || ' ملفات ' || g,
             'description', 'عرض صناعي لقياس خطط الاستعلام في DINAR — وصف واضح وسعر ثابت',
             'category', 'أزياء', 'categoryId', 'fashion',
             'city', CASE WHEN g % 3 = 0 THEN 'الزرقاء' ELSE 'عمان' END,
             'area', 'الاباء',
             'attributes', jsonb_build_object('condition', 'جديد'),
             'fulfilmentType', 'PICKUP',
             'paymentMethods', jsonb_build_array('CASH_DIRECT')),
           timestamptz '2026-02-01' + g * interval '1 second', timestamptz '2026-02-01' + g * interval '1 second'
    FROM generate_series(1, ${OFFERS}) g
    ON CONFLICT (id) DO NOTHING`);
  const [count] = (await db.execute(sql`SELECT count(*)::int AS n FROM offers WHERE id LIKE 'pf-%'`)).rows as Array<{ n: number }>;
  assert.equal(count.n, OFFERS, "the profile market is the size the plan was measured at");
  await db.execute(sql`UPDATE offers SET search_document_stale = true WHERE id LIKE 'pf-%'`);
  let built = 0;
  // Bounded, not open-ended: a claim that clears nothing ends the loop, and the cap says so if a
  // revision guard ever stops a flag from clearing instead of finishing the work.
  for (let pass = 0; pass < 40; pass++) {
    const { refreshed } = await refreshSearchDocuments({ limit: 2_000, marketId: "JO" });
    built += refreshed;
    if (!refreshed) break;
  }
  await probe.query("VACUUM ANALYZE offers");
  await probe.query("VACUUM ANALYZE offer_search_documents");
  await probe.query("VACUUM ANALYZE orders");
  await probe.query("VACUUM ANALYZE messages");
  report.pf01_growth = { offers: count.n, documentsBuilt: built };
  assert.ok(built >= OFFERS, "the background builder wrote a document for every synthetic listing");
});

const seller = await register("seller");
const buyer = await register("buyer");

await test("PF-02 a buyer order and a conversation to point the predicates at", async () => {
  const created = await (await fetch(`${base}/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: seller.cookie },
    body: JSON.stringify({
      title: "معطف ملفات ٠٥",
      description: "معطف صوف يفحص قراءة سجل الطلبات وفهرس البحث في سوق الأردن",
      category: "أزياء",
      categoryId: "fashion",
      city: "عمان",
      area: "الاباء",
      attributes: { condition: "جديد" },
      unitPrice: "48.000",
      inventoryMode: "LIMITED",
      availableQuantity: 25,
      fulfilmentType: "PICKUP",
      imageUrl: "",
      imageUrls: [],
      paymentMethods: ["CASH_DIRECT"],
    }),
  })).json();
  assert.ok(created.id, "the seller published a listing");
  const checkout = await (await fetch(`${base}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: buyer.cookie },
    body: JSON.stringify({ items: [{ listingId: created.id, quantity: 2, fulfilmentType: "PICKUP" }], idempotencyKey: `pf02-${randomUUID()}` }),
  })).json();
  assert.ok(checkout.orders?.length, "the buyer's order exists");
  report.pf02 = { listingId: created.id, orderId: checkout.orders[0].id };
});

// ─── PF-10 / PF-20: plan evidence and latency distribution ────────────────────

type PlanNode = {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Index Name"?: string | string[];
  "Actual Rows"?: number;
  "Total Cost"?: number;
  "Shared Blks Hit"?: number;
  "Shared Blks Read"?: number;
  Plans?: PlanNode[];
};
const walk = (node: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(node);
  for (const child of node.Plans ?? []) walk(child, out);
  return out;
};

const orderId = (report.pf02 as any).orderId as string;
const listingId = (report.pf02 as any).listingId as string;

const PREDICATES: Array<{ name: string; text: string; values?: unknown[]; mustUseIndex: boolean; note: string }> = [
  {
    name: "organic_browse",
    text: "SELECT id FROM offers WHERE market_id = 'JO' AND status = 'PUBLISHED' ORDER BY created_at, id LIMIT 24",
    mustUseIndex: true,
    note: "the first page of the marketplace, on every visitor: the index supplies the order and stops at 24",
  },
  {
    name: "price_sort",
    text: "SELECT id FROM offers WHERE market_id = 'JO' AND status = 'PUBLISHED' ORDER BY unit_price_minor, id LIMIT 24",
    mustUseIndex: false,
    note: "report only: sorting by price then id cannot stop early, so the planner may lawfully read the heap and sort",
  },
  {
    name: "seller_catalog",
    text: "SELECT id FROM offers WHERE seller_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50",
    values: [seller.id],
    mustUseIndex: true,
    note: "a seller's own management list, walked backwards through (seller_id, created_at, id)",
  },
  {
    name: "buyer_orders",
    text: "SELECT id, status, subtotal_minor FROM orders WHERE buyer_id = $1",
    values: [buyer.id],
    mustUseIndex: false,
    note: "report only: the orders table on the runner is far smaller than the catalog, so a heap read can be the cheaper plan",
  },
  {
    name: "conversation_messages",
    text: "SELECT id, body, metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at",
    values: [orderId],
    mustUseIndex: false,
    note: "report only here; PF-30 and PF-60 measure this read at 20, 40 and 600 messages through the API",
  },
  {
    name: "stale_claim",
    text: "SELECT id FROM offers WHERE search_document_stale AND market_id = $1 LIMIT 2000",
    values: ["JO"],
    mustUseIndex: true,
    note: "the background index worker's claim read, exactly as refreshSearchDocuments issues it (partial index over stale rows, keyed by market)",
  },
  {
    name: "listing_detail",
    text: "SELECT seller_id, status, data FROM offers WHERE id = $1",
    values: [listingId],
    mustUseIndex: true,
    note: "one listing's detail page",
  },
  {
    name: "category_filter",
    text: "SELECT id FROM offers WHERE market_id = 'JO' AND status = 'PUBLISHED' AND ((data->>'categoryId') = 'fashion' OR (data->>'category') = 'أزياء') LIMIT 24",
    mustUseIndex: false,
    note: "report only: the planner may Bitmap-Or the two expression indexes or read the heap",
  },
  {
    name: "text_trigram",
    text: "SELECT offer_id FROM offer_search_documents WHERE search_text LIKE '%هاتف%'",
    mustUseIndex: false,
    note: "report only: a GIN trigram match is wide by nature; search-sql-performance covers this path too",
  },
  {
    name: "city_filter",
    text: "SELECT id FROM offers WHERE market_id = 'JO' AND status = 'PUBLISHED' AND (data->>'city') = 'الزرقاء' LIMIT 24",
    mustUseIndex: false,
    note: "report only: no city index exists, so this is the candidate a future migration must justify with these numbers",
  },
];

await test("PF-10 EXPLAIN (ANALYZE, BUFFERS) for every hot predicate", async () => {
  const plans: Record<string, unknown> = {};
  for (const predicate of PREDICATES) {
    const explained = await probe.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${predicate.text}`, predicate.values ?? []);
    const root = (explained.rows[0] as any)["QUERY PLAN"][0] as PlanNode & {
      "Planning Time"?: number;
      "Execution Time"?: number;
      "Shared Blks Hit"?: number;
      "Shared Blks Read"?: number;
    };
    const scans = walk(root).filter((node) => /Scan$/.test(node["Node Type"] ?? ""));
    const sorts = walk(root).filter((node) => node["Node Type"] === "Sort").length;
    const heapScans = scans
      .filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"])
      .map((node) => String(node["Relation Name"]));
    plans[predicate.name] = {
      scans: scans.map((node) => ({
        type: node["Node Type"],
        relation: node["Relation Name"],
        index: Array.isArray(node["Index Name"]) ? node["Index Name"].join(" + ") : node["Index Name"],
        rows: node["Actual Rows"],
      })),
      sortNodes: sorts,
      heapScannedRelations: heapScans,
      planningMs: root["Planning Time"],
      executionMs: root["Execution Time"],
      buffers: { hit: root["Shared Blks Hit"], read: root["Shared Blks Read"] },
      note: predicate.note,
    };
    if (predicate.mustUseIndex) {
      // Both halves of the claim: something index-shaped is walked, and no part of the plan reads the
      // whole heap. A bitmap heap scan over a partial index is the first; a Seq Scan is the second.
      assert.ok(
        scans.some((node) => /Index/.test(node["Node Type"] ?? "")),
        `${predicate.name} has no index node in its plan: ${JSON.stringify(plans[predicate.name])}`,
      );
      assert.deepEqual(heapScans, [], `${predicate.name} must not read the heap: ${JSON.stringify(plans[predicate.name])}`);
    }
  }
  report.pf10_plans = plans;
});

await test("PF-20 the latency distribution of the same predicates, and the slow-query count", async () => {
  const timings: Record<string, unknown> = {};
  let slowTotal = 0;
  for (const predicate of PREDICATES) {
    const samples: number[] = [];
    for (let run = 0; run < RUNS_PER_PREDICATE; run++) {
      const started = performance.now();
      await probe.query(predicate.text, predicate.values ?? []);
      samples.push(performance.now() - started);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q: number) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!.toFixed(2);
    const slow = samples.filter((ms) => ms > SLOW_MS).length;
    slowTotal += slow;
    timings[predicate.name] = { runs: samples.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1), slowOverMs: SLOW_MS, slow };
  }
  report.pf20_latencies = timings;
  assert.equal(slowTotal, 0, `a hot predicate exceeded ${SLOW_MS}ms on loopback: ${JSON.stringify(timings)}`);
});

// ─── PF-30 / PF-31 / PF-60: conversation history ─────────────────────────────

/**
 * A history of `messages` assistant turns, each carrying `actions` ledger actions that name a real
 * listing and a real order. This is what the app stores after a conversational turn, written here
 * directly so the measurement is of the read path, not of a model call.
 */
async function buildHistory(label: string, messages: number, actionsPerMessage: number) {
  const conversation = await (await fetch(`${base}/ai/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: buyer.cookie },
    body: JSON.stringify({}),
  })).json();
  const conversationId = conversation.id as string;
  const listingIds = (
    (await db.execute(sql`SELECT id FROM offers WHERE id LIKE 'pf-%' AND status = 'PUBLISHED' ORDER BY id LIMIT 12`)).rows as Array<{ id: string }>
  ).map((row) => row.id);
  const baseTime = 1_770_000_000_000;
  const at = (message: number) => new Date(baseTime + message * 1_000).toISOString();
  // The fixture is written in two statements, not one per row: the measurement below is of the read
  // path, and a slow fixture would only add noise to it.
  const actionRows: string[][] = [];
  const messageRows: Array<{ id: string; body: string; metadata: string; createdAt: string }> = [];
  for (let message = 0; message < messages; message++) {
    const actionIds: string[] = [];
    for (let action = 0; action < actionsPerMessage; action++) {
      const actionId = randomUUID();
      actionIds.push(actionId);
      actionRows.push([
        actionId,
        conversationId,
        JSON.stringify({
          kind: "ACTION",
          ownerId: buyer.id,
          action: "PLACE_ORDER",
          status: "CONFIRMED",
          targetResource: listingIds[(message + action) % listingIds.length],
          result: { orderId },
        }),
        at(message),
      ]);
    }
    messageRows.push({
      id: randomUUID(),
      body: `دورة ${message} — ${label}`,
      metadata: JSON.stringify({ actionReceipts: actionIds.map((actionId) => ({ actionId })) }),
      createdAt: at(message),
    });
  }
  if (actionRows.length) {
    await db.execute(sql`
      INSERT INTO ai_result_sets (id, conversation_id, market_id, query, resource_ids, created_at)
      VALUES ${sql.join(
        actionRows.map(([actionId, rowConversationId, rowQuery, rowCreatedAt]) => sql`(${actionId}, ${rowConversationId}, 'JO', ${rowQuery}::jsonb, '[]'::jsonb, ${rowCreatedAt})`),
        sql`, `,
      )}`);
  }
  await db.execute(sql`
    INSERT INTO messages (id, conversation_id, sender_id, body, actor, content_type, metadata, created_at, updated_at)
    VALUES ${sql.join(
      messageRows.map((row) => sql`(${row.id}, ${conversationId}, NULL, ${row.body}, 'ASSISTANT', 'TEXT', ${row.metadata}::jsonb, ${row.createdAt}, ${row.createdAt})`),
      sql`, `,
    )}`);
  return conversationId;
}

const history20 = await buildHistory("صغرية", 20, 6);
const history40 = await buildHistory("متوسطة", 40, 6);

await test("PF-30 reading a conversation costs a bounded number of queries and keeps every receipt", async () => {
  const measured = await measure(() => getJson(`/ai/conversations/${history20}`, buyer.cookie));
  assert.equal(measured.value.status, 200);
  const messages = measured.value.json.messages as any[];
  assert.equal(messages.length, 20, "the whole history is returned");
  const receipts = messages.map((row) => row.actionReceipts ?? []);
  assert.ok(
    receipts.every((rows: any[]) => rows.length === 6),
    `every assistant turn re-derives all six of its receipts: ${JSON.stringify(receipts.map((rows: any[]) => rows.length))}`,
  );
  assert.equal(receipts[0][0].lifecycle, "SUCCEEDED", "the ledger, not a model claim, decides the lifecycle");
  assert.ok(receipts[0][0].orderId === orderId, "the order the action named is shown to the party that owns it");
  assert.ok(typeof receipts[0][0].resource === "string", "the listing title the action named is resolved");
  // 20 messages x 6 actions = 120 ledger reads. The same 120 receipts read one message at a time, as
  // this endpoint's handler did before the batched ledger read, is measured against the single read.
  // The ids come from the stored metadata, because a response deliberately never carries a ledger id.
  const scope = { actorId: buyer.id, conversationId: history20 };
  const storedReceipts = (
    await db.execute(sql`SELECT metadata FROM messages WHERE conversation_id = ${history20} ORDER BY created_at`)
  ).rows as Array<{ metadata: { actionReceipts?: { actionId: string }[] } }>;
  const idsPerMessage = storedReceipts.map((row) => (row.metadata?.actionReceipts ?? []).map((item) => item.actionId));
  assert.equal(idsPerMessage.reduce((sum, ids) => sum + ids.length, 0), 120, "the stored history holds one hundred and twenty ledger actions");
  const perMessage = await measure(async () => {
    const views: unknown[] = [];
    for (const ids of idsPerMessage) views.push(...(await receiptViews(scope, ids)));
    return views;
  });
  report.pf30_historyRead = {
    messages: 20,
    actions: 120,
    statements: measured.statements,
    ms: +measured.ms.toFixed(1),
    payloadBytes: measured.value.bytes,
    bound: 40,
    perMessageRead: { statements: perMessage.statements, ms: +perMessage.ms.toFixed(1), receipts: perMessage.value.length },
  };
  assert.equal(perMessage.value.length, 120, "both access patterns return the same 120 receipts");
  assert.ok(measured.statements <= 40, `a history read issued ${measured.statements} statements; round trips must not grow with the history`);
  assert.ok(
    perMessage.statements > measured.statements * 2,
    `reading one message at a time cost ${perMessage.statements} statements against ${measured.statements} for the whole history — the batched read is not doing what it claims`,
  );
});

await test("PF-31 doubling the history does not double the round trips", async () => {
  const small = await measure(() => getJson(`/ai/conversations/${history20}`, buyer.cookie));
  const large = await measure(() => getJson(`/ai/conversations/${history40}`, buyer.cookie));
  report.pf31_scaling = {
    messagesSmall: 20,
    statementsSmall: small.statements,
    messagesLarge: 40,
    statementsLarge: large.statements,
    deltaStatements: large.statements - small.statements,
    msSmall: +small.ms.toFixed(1),
    msLarge: +large.ms.toFixed(1),
  };
  assert.equal(large.value.json.messages.length, 40, "the longer history is complete too");
  assert.ok(
    large.statements - small.statements <= 6,
    `doubling the messages added ${large.statements - small.statements} statements: the read is proportional to the history`,
  );
});

await test("PF-60 quantify what an unbounded history read still costs", async () => {
  const long = await buildHistory("طويلة", 600, 0);
  const measured = await measure(() => getJson(`/ai/conversations/${long}`, buyer.cookie));
  const short = await measure(() => getJson(`/ai/conversations/${history20}`, buyer.cookie));
  report.pf60_unboundedHistory = {
    messages600: { statements: measured.statements, ms: +measured.ms.toFixed(1), payloadBytes: measured.value.bytes },
    messages20: { statements: short.statements, ms: +short.ms.toFixed(1), payloadBytes: short.value.bytes },
    bytesPerMessage: Math.round(measured.value.bytes / 600),
    observed:
      "the statement count is flat, but the response itself still grows with the history: the endpoint has no page, so a long conversation is one large read. Pagination is an API contract change (lib/api-zod and the web client), recorded as an integration requirement rather than done silently here.",
  };
  assert.equal(measured.value.json.messages.length, 600, "the whole conversation is returned, as the contract says today");
  assert.ok(measured.statements <= 12, `a receipt-free history read issued ${measured.statements} statements`);
  assert.ok(measured.ms < 5_000, `600 messages took ${measured.ms.toFixed(0)}ms to read on loopback`);
});

// ─── PF-50: multi-replica background work ────────────────────────────────────

await test("PF-50 five background workers ticking together must not rebuild the same documents", async () => {
  // A known starting point: drain every stale row through the product's own builder first, then mark
  // exactly this many in one market. The claim test then measures claims, not whatever the fixture
  // happened to leave behind.
  for (let pass = 0; pass < 40; pass++) {
    const { refreshed } = await refreshSearchDocuments({ limit: 2_000 });
    if (!refreshed) break;
  }
  const [leftover] = (await db.execute(sql`SELECT count(*)::int AS n FROM offers WHERE search_document_stale`)).rows as Array<{ n: number }>;
  const CLAIMED = 5_000;
  await db.execute(sql`UPDATE offers SET search_document_stale = true WHERE id IN (SELECT id FROM offers WHERE id LIKE 'pf-%' ORDER BY id LIMIT ${CLAIMED})`);
  // Only the workers' own market is counted: the claim read is market-scoped, so a stale row left in
  // another market is neither claimed nor expected to disappear here.
  const staleInMarket = sql`SELECT count(*)::int AS n FROM offers WHERE search_document_stale AND market_id = 'JO'`;
  const [staleBefore] = (await db.execute(staleInMarket)).rows as Array<{ n: number }>;
  // The old read shape, measured rather than asserted: five workers that each ask for the first 2000
  // stale rows of the same market are handed the same slice, and none of them knows it.
  const naive = await Promise.all(
    Array.from({ length: 5 }, () =>
      db.execute(sql`SELECT id FROM offers WHERE ${offers.searchDocumentStale} AND ${offers.marketId} = 'JO' LIMIT 2000`),
    ),
  );
  const naiveSets = naive.map((result) => new Set((result.rows as Array<{ id: string }>).map((row) => row.id)));
  const naiveConsidered = naiveSets.reduce((sum, set) => sum + set.size, 0);
  const naiveUnique = new Set(naiveSets.flatMap((set) => [...set])).size;
  // The watermark comes from the database's own clock, because the documents' updated_at does.
  const startedAt = new Date((await probe.query("SELECT now() AS t")).rows[0].t as string);
  const workers = await Promise.all(
    Array.from({ length: 5 }, () =>
      measure(() => refreshSearchDocuments({ limit: 2_000, marketId: "JO" })),
    ),
  );
  const totalRefreshed = workers.reduce((sum, worker) => sum + worker.value.refreshed, 0);
  const totalConsidered = workers.reduce((sum, worker) => sum + worker.value.considered, 0);
  const [uniqueWritten] = (
    await db.execute(sql`
      SELECT count(*)::int AS n FROM ${offerSearchDocuments} d
      JOIN offers o ON o.id = d.offer_id
      WHERE o.market_id = 'JO' AND d.updated_at >= ${startedAt}`)
  ).rows as Array<{ n: number }>;
  const [staleAfter] = (await db.execute(staleInMarket)).rows as Array<{ n: number }>;
  report.pf50_replicaCoordination = {
    staleLeftoverAfterDrain: leftover.n,
    staleBefore: staleBefore.n,
    workers: 5,
    limitPerClaim: 2_000,
    unclaimedRead: { considered: naiveConsidered, uniqueListings: naiveUnique, duplicatedConsidered: naiveConsidered - naiveUnique },
    considered: totalConsidered,
    refreshed: totalRefreshed,
    uniqueDocumentsWritten: uniqueWritten.n,
    duplicatedDocuments: totalRefreshed - uniqueWritten.n,
    staleAfter: staleAfter.n,
    perWorkerConsidered: workers.map((worker) => worker.value.considered),
    claimHeldTransactionMs: workers.map((worker) => +worker.ms.toFixed(1)),
  };
  assert.ok(staleBefore.n >= CLAIMED, "the five thousand synthetic listings were left stale for the workers");
  assert.ok(naiveConsidered > naiveUnique, `five workers that do not claim read ${naiveConsidered} rows for ${naiveUnique} listings — the duplication the lock removes is measured, not asserted`);
  // The duplicate-work claim, stated as arithmetic: N replicas that each claim the whole slice
  // consider N × stale rows. Disjoint SKIP LOCKED claims consider each stale row once.
  assert.equal(
    totalConsidered,
    staleBefore.n,
    `${totalConsidered} claims for ${staleBefore.n} stale listings: workers read rows another worker already held, so N replicas do N times the work`,
  );
  assert.equal(totalRefreshed, uniqueWritten.n, `${totalRefreshed} writes for ${uniqueWritten.n} documents: the same listing was rebuilt twice`);
  assert.equal(staleAfter.n, 0, "every claimed row's document was written and its flag cleared");
  // The claim holds row locks while it builds text; that hold is what a replica costs the database,
  // so it is measured rather than assumed away.
  for (const worker of workers) assert.ok(worker.ms < 5_000, `one claim held its transaction for ${worker.ms.toFixed(0)}ms`);
});

// ─── PF-70: the configuration the pool ceiling is compared against ───────────

await test("PF-70 database capacity facts, and what a replica count would need", async () => {
  const show = async (name: string) => (await probe.query(`SHOW ${name}`)).rows[0][name] as string;
  const maxConnections = Number(await show("max_connections"));
  const superuserReserved = Number(await show("superuser_reserved_connections"));
  const poolMax = pool.options.max ?? 10;
  const [backends] = (
    await probe.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`)
  ).rows as Array<{ n: number }>;
  report.pf70_capacity = {
    server: {
      maxConnections,
      superuserReserved,
      usableByNonSuperusers: maxConnections - superuserReserved,
      sharedBuffers: await show("shared_buffers"),
      workMem: await show("work_mem"),
      maintenanceWorkMem: await show("maintenance_work_mem"),
      effectiveCacheSize: await show("effective_cache_size"),
      statementTimeout: await show("statement_timeout"),
      idleInTransactionSessionTimeout: await show("idle_in_transaction_session_timeout"),
      poolIdleTimeoutMs: (pool.options as any).idleTimeoutMillis ?? "library default (0: never)",
      version: (await probe.query("SHOW server_version")).rows[0].server_version,
    },
    application: {
      poolMax,
      connectionTimeoutMs: pool.options.connectionTimeoutMillis,
      currentlyOpenBackends: backends.n,
      // A deployment fact, computed, never asserted as a capacity claim: this is what N replicas of
      // THIS process would ask for, compared with what the server allows.
      replicasTestableWithinLimit: Math.max(0, Math.floor((maxConnections - superuserReserved - 2) / poolMax)),
    },
    note: "No Railway numbers are asserted here. On the runner the server limit is the CI Postgres default; a deployment must raise DINAR_DB_POOL_MAX and max_connections together and re-run this suite.",
  };
  assert.ok(poolMax >= 1 && poolMax <= maxConnections, "one replica's pool cannot exceed the server's connection limit");
  assert.equal(
    (process.env.DINAR_DB_POOL_MAX ? Number(process.env.DINAR_DB_POOL_MAX) : 10),
    poolMax,
    "DINAR_DB_POOL_MAX reaches the pool, or the before/after dispatch measures nothing",
  );
});

after(async () => {
  clientPrototype.query = prototypeQuery;
  console.log("WAVE05_DB_PROFILE", JSON.stringify(report));
  probe.release();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
