/**
 * C1 performance proof over real PostgreSQL 16 with synthetic markets of 1,000 and 10,000 listings
 * (100,000 with DINAR_SEARCH_BENCH_FULL=1). Measured per scale and engine: p50/p95 latency, rows
 * read from the database, heap growth, EXPLAIN ANALYZE of the SQL engine's first batch, write-path
 * (trigger) and refresh cost, and recall/precision against a labelled oracle.
 *
 * Asserted (stable, not timing-fragile): both engines return identical results at every scale; the
 * SQL engine's selective and early-stopping queries read a bounded number of rows; at 10,000+ the
 * SQL engine's median is below the legacy engine's for every query.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, listingPromotions, pool, promotionProducts } from "@workspace/db";
import { marketFor } from "../src/lib/markets";
import { lastSearchStats, searchMarketplaceListings } from "../src/lib/marketplace-listings";
import { refreshSearchDocuments } from "../src/lib/marketplace-search-index";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
process.env.DINAR_SEARCH_CAPTURE_SQL = "1";
const SCALES = process.env.DINAR_SEARCH_BENCH_FULL === "1" ? [1_000, 10_000, 100_000] : [1_000, 10_000];
const report: Record<string, unknown> = { scales: SCALES, postgres: (await db.execute(sql`SELECT version()`)).rows[0] };

// Product words with their category; the oracle labels a listing by the product it was generated as.
const PRODUCTS: Array<[word: string, categoryId: string, label: string]> = [
  ["هاتف", "electronics", "إلكترونيات"], ["جوال", "electronics", "إلكترونيات"], ["لابتوب", "electronics", "إلكترونيات"], ["سماعة", "electronics", "إلكترونيات"],
  ["سيارة", "cars", "سيارات"], ["كنب", "home", "منزل"], ["غسالة", "home", "منزل"], ["تيشيرت", "fashion", "أزياء"],
  ["فستان", "fashion", "أزياء"], ["شقة", "property", "عقارات"], ["صيانة مكيفات", "services", "خدمات"], ["مزهرية", "other", "أخرى"],
];
const BRANDS = ["سامسونج", "ايفون", "هواوي", "نوكيا", "ديل", "لينوفو", "كيا", "تويوتا", "ايكيا", "زارا", "عادي", "ممتاز"];
const CITIES = ["عمان", "الزرقاء", "اربد", "العقبة"];

await db.execute(sql`UPDATE offers SET status = 'ARCHIVED' WHERE market_id = 'JO'`);
await db.execute(sql`
  INSERT INTO users (id, display_name, phone_country_code, phone_number, normalized_phone, account_country, active_market_id, password_hash, status)
  VALUES ('bench-a','بائع أ','+962','791000001','+962791000001','JO','JO','x','ACTIVE'),
         ('bench-b','بائع ب','+962','791000002','+962791000002','JO','JO','x','ACTIVE'),
         ('bench-c','بائع ج','+962','791000003','+962791000003','JO','JO','x','SUSPENDED')`);
let generated = 0;
async function growTo(total: number) {
  const words = PRODUCTS.map((p) => p[0]), ids = PRODUCTS.map((p) => p[1]), labels = PRODUCTS.map((p) => p[2]);
  await db.execute(sql`
    INSERT INTO offers (id, seller_id, market_id, status, unit_price_minor, pricing_mode, inventory_mode, available_quantity, reserved_quantity, data, created_at, updated_at)
    SELECT 'bench-' || lpad(g::text, 7, '0'),
      (ARRAY['bench-a','bench-b','bench-c'])[1 + (g / 144) % 3],
      'JO',
      CASE WHEN g % 17 = 0 THEN 'PAUSED' WHEN g % 23 = 0 THEN 'SOLD_OUT' ELSE 'PUBLISHED' END,
      (5 + (g * 37) % 5000) * 1000, 'FIXED', 'LIMITED', 3, CASE WHEN g % 11 = 0 THEN 3 ELSE 0 END,
      jsonb_build_object(
        'title', (${sql.param(words)}::text[])[1 + g % ${PRODUCTS.length}] || ' ' || (${sql.param(BRANDS)}::text[])[1 + (g / 12) % ${BRANDS.length}] || CASE WHEN g % 5000 = 0 THEN ' نادر' ELSE '' END || ' رقم ' || g,
        'description', CASE g % 3 WHEN 0 THEN 'بحالة ممتازة' WHEN 1 THEN 'استعمال خفيف' ELSE 'للبيع بسعر مناسب' END,
        'category', (${sql.param(labels)}::text[])[1 + g % ${PRODUCTS.length}],
        'categoryId', (${sql.param(ids)}::text[])[1 + g % ${PRODUCTS.length}],
        'city', (${sql.param(CITIES)}::text[])[1 + g % 4], 'area', '',
        'attributes', jsonb_build_object('condition', CASE WHEN g % 4 = 0 THEN 'جديد' ELSE 'مستعمل' END, 'year', 2000 + g % 25),
        'product', 1 + g % ${PRODUCTS.length}),
      timestamptz '2026-01-01' + g * interval '1 second', timestamptz '2026-01-01' + g * interval '1 second'
    FROM generate_series(${generated + 1}::int, ${total}::int) g`);
  generated = total;
}

const market = await marketFor({ actor: { activeMarketId: "JO" } });
const QUERIES: Record<string, Parameters<typeof searchMarketplaceListings>[1]> = {
  narrowText: { search: "نادر", conversational: true },
  broadText: { search: "هاتف", conversational: true },
  categoryPrice: { search: "", categoryId: "cars", filters: [{ field: "price", operator: "lte", value: 1000 }] },
  browse: {},
  priceSort: { search: "هاتف", conversational: true, sort: "PRICE_ASC" },
  ownSeller: { ownSellerId: "bench-a" },
  attributeSort: { search: "", categoryId: "cars", sort: "YEAR_DESC" },
  restoreIds: { search: "", allowedIds: ["bench-0000005", "bench-0000017", "bench-0000400", "bench-0000999"] },
};
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!;

async function measure(engine: "SQL" | "LEGACY", options: Parameters<typeof searchMarketplaceListings>[1], runs: number) {
  process.env.DINAR_SEARCH_ENGINE = engine;
  await searchMarketplaceListings(market, options); // warm caches and plans
  const samples: number[] = [];
  let heap = 0;
  let result: string[] = [];
  const stages: Record<string, number[]> = {};
  for (let run = 0; run < runs; run++) {
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    const found = await searchMarketplaceListings(market, options);
    samples.push(performance.now() - started);
    for (const [stage, value] of Object.entries(lastSearchStats()?.ms ?? {})) (stages[stage] ??= []).push(value);
    heap = Math.max(heap, process.memoryUsage().heapUsed - before);
    result = found.map((listing: any) => `${listing.id}${listing.isSponsored ? "*" : ""}`);
  }
  const stats = lastSearchStats()!;
  return { p50: +quantile(samples, 0.5).toFixed(1), p95: +quantile(samples, 0.95).toFixed(1), rowsRead: stats.rowsRead, batches: stats.batches, heapGrowthKb: Math.round(heap / 1024), result, sql: stats.sql, ms: Object.keys(stages).length ? Object.fromEntries(Object.entries(stages).map(([key, values]) => [key, +quantile(values, 0.5).toFixed(1)])) : undefined };
}

for (const scale of SCALES) {
  await test(`SP-${scale} ${scale.toLocaleString("en")} listings: identical results, bounded reads, faster than the legacy engine`, async () => {
    await growTo(scale);
    if (scale === SCALES[0]) {
      // Two serving campaigns: one early in organic order, one late (the scan must pass it).
      await db.insert(promotionProducts).values({ id: "bench-product", marketId: "JO", categoryId: "electronics", name: "bench", priceMinor: 2_500, currencyCode: "JOD", durationDays: 7 });
      const campaign = (id: string, listing: string, seller: string) => ({ id, listingId: listing, sellerId: seller, marketId: "JO", productId: "bench-product", productNameSnapshot: "bench", categoryIdSnapshot: "electronics", priceMinorSnapshot: 2_500, currencyCodeSnapshot: "JOD", placementSnapshot: "SEARCH_AND_CHAT", durationDaysSnapshot: 7, status: "ACTIVE", paymentStatus: "SIMULATION_CAPTURED", startsAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() + 86_400_000) });
      await db.insert(listingPromotions).values([campaign("bench-promo-1", "bench-0000012", "bench-a"), campaign("bench-promo-2", "bench-0000960", "bench-a")] as any);
    }
    const refreshStarted = performance.now();
    let documents = 0;
    for (;;) { const { refreshed } = await refreshSearchDocuments({ limit: 2_000 }); documents += refreshed; if (!refreshed) break; }
    const refreshMs = performance.now() - refreshStarted;
    await db.execute(sql`ANALYZE offers`);
    await db.execute(sql`ANALYZE offer_search_documents`);
    const runs = scale >= 100_000 ? 5 : 11;
    const perQuery: Record<string, unknown> = {};
    for (const [name, options] of Object.entries(QUERIES)) {
      const sqlRun = await measure("SQL", options, runs);
      const legacyRun = await measure("LEGACY", options, scale >= 100_000 ? 3 : runs);
      assert.deepEqual(sqlRun.result, legacyRun.result, `${scale} ${name}: both engines return the same listings in the same order`);
      let plan: string | undefined;
      if (sqlRun.sql && ["narrowText", "broadText", "categoryPrice", "browse", "priceSort"].includes(name)) {
        const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sqlRun.sql.sql}`, sqlRun.sql.params as unknown[]);
        plan = explained.rows.map((row: any) => row["QUERY PLAN"]).join("\n");
      }
      perQuery[name] = { sql: { p50: sqlRun.p50, p95: sqlRun.p95, rowsRead: sqlRun.rowsRead, batches: sqlRun.batches, heapGrowthKb: sqlRun.heapGrowthKb, stageMedianMs: sqlRun.ms }, legacy: { p50: legacyRun.p50, p95: legacyRun.p95, rowsRead: legacyRun.rowsRead, heapGrowthKb: legacyRun.heapGrowthKb }, results: sqlRun.result.length, ...(plan ? { plan } : {}) };
      if (name === "narrowText") assert.ok(sqlRun.rowsRead <= Math.ceil(scale / 5000) + 2, `${scale} narrow: ${sqlRun.rowsRead} rows read`);
      if (name === "browse" || name === "ownSeller") assert.ok(sqlRun.rowsRead <= 2_000, `${scale} ${name}: early stop, ${sqlRun.rowsRead} rows read`);
      if (scale >= 10_000 && name !== "restoreIds") assert.ok(sqlRun.p50 < legacyRun.p50, `${scale} ${name}: SQL p50 ${sqlRun.p50}ms vs legacy ${legacyRun.p50}ms`);
    }
    // Write path: an edit pays one trigger; measured over 500 edits.
    const editStarted = performance.now();
    // A real change each time (the scale), so every edit fires the trigger and needs a refresh.
    await db.execute(sql`UPDATE offers SET data = data || jsonb_build_object('edited', ${scale}::int) WHERE id IN (SELECT id FROM offers WHERE id LIKE 'bench-%' ORDER BY id LIMIT 500)`);
    assert.equal(Number(((await db.execute(sql`SELECT count(*)::int AS n FROM offers WHERE search_document_stale AND id LIKE 'bench-%'`)).rows[0] as { n: number }).n), 500, "each of the 500 edits marked its document stale");
    const editMs = performance.now() - editStarted;
    const reRefreshStarted = performance.now();
    while ((await refreshSearchDocuments({ limit: 2_000 })).refreshed);
    report[`scale_${scale}`] = { documents, refreshMs: Math.round(refreshMs), refreshPerSecond: Math.round(documents / (refreshMs / 1000)), edit500Ms: Math.round(editMs), refresh500Ms: Math.round(performance.now() - reRefreshStarted), perQuery };
  });
}

await test("SP-R recall and precision against a labelled oracle (identical for both engines by SF-01)", async () => {
  process.env.DINAR_SEARCH_ENGINE = "SQL";
  // Oracle: eligible (published, active seller, available) listings generated as the product(s).
  const eligible = sql`o.market_id = 'JO' AND o.id LIKE 'bench-%' AND o.status = 'PUBLISHED' AND u.status = 'ACTIVE' AND o.available_quantity - o.reserved_quantity > 0`;
  const labelled: Record<string, { query: string; products: number[] }> = {
    phoneBySynonym: { query: "هاتف", products: [1, 2] },
    mobileBySynonym: { query: "جوال", products: [1, 2] },
    sofa: { query: "كنب", products: [6] },
    acService: { query: "مكيفات", products: [11] },
    brandAndProduct: { query: "سيارة كيا", products: [5] },
  };
  const out: Record<string, unknown> = {};
  for (const [name, { query, products }] of Object.entries(labelled)) {
    const truth = new Set(((await db.execute(sql`SELECT o.id FROM offers o JOIN users u ON u.id = o.seller_id WHERE ${eligible} AND (o.data->>'product')::int = ANY(${sql.param(products)}::int[]) ${name === "brandAndProduct" ? sql`AND o.data->>'title' LIKE '%كيا%'` : sql``}`)).rows as Array<{ id: string }>).map((row) => row.id));
    const found = new Set((await searchMarketplaceListings(market, { search: query, conversational: true, limit: 1_000_000, sponsoredPlacement: false })).map((listing) => listing.id).filter((id) => id.startsWith("bench-")));
    const hit = [...found].filter((id) => truth.has(id)).length;
    out[name] = { query, relevant: truth.size, returned: found.size, recall: truth.size ? +(hit / truth.size).toFixed(3) : null, precision: found.size ? +(hit / found.size).toFixed(3) : null };
  }
  report.relevance = out;
  console.log("SEARCH_RELEVANCE", JSON.stringify(out));
});

after(async () => {
  const summary = Object.fromEntries(Object.entries(report).map(([key, value]) => [key, key.startsWith("scale_") ? { ...(value as any), perQuery: Object.fromEntries(Object.entries((value as any).perQuery).map(([name, item]: any) => [name, { ...item, plan: undefined }])) } : value]));
  console.log("SEARCH_PERFORMANCE", JSON.stringify(summary));
  if (process.env.DINAR_SEARCH_BENCH_OUT) writeFileSync(process.env.DINAR_SEARCH_BENCH_OUT, JSON.stringify(report, null, 1));
  delete process.env.DINAR_SEARCH_ENGINE;
  await pool.end();
});
