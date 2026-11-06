/**
 * C1 — the PostgreSQL search foundation over real PostgreSQL (fixture: search-fixture.ts).
 *
 *  SF-01 The SQL engine equals the legacy (full-market) engine result for result for all 88
 *        caller-shaped queries, both bounded and unlimited; against the golden captured from the
 *        pre-C1 code, every complete matching set is identical, every request with a defined order is
 *        identical including paid labels, and unsorted requests differ only in order (formerly the
 *        heap's) and in which paid listings that order scores first — never in their number.
 *  SF-02 The SQL engine reads a bounded candidate set from the database (never the whole market).
 *  SF-03 With no search documents at all (fresh deployment, nothing backfilled) results are identical:
 *        a missing or stale document can only widen the candidate set, never drop a result.
 *  SF-04 An edit is searchable at once (its document is stale until refreshed); a category change
 *        (label, aliases, searchable attributes) marks its listings stale by trigger.
 *  SF-05 A refresh racing an edit never stores text for an older revision.
 *  SF-06 Equal creation times are ordered by id (the former order was the heap's, unspecified).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { db, marketplaceCategories, offerSearchDocuments, offers, pool } from "@workspace/db";
import { marketFor } from "../src/lib/markets";
import { lastSearchStats, searchMarketplaceListings } from "../src/lib/marketplace-listings";
import { refreshSearchDocuments, staleSearchDocumentCount } from "../src/lib/marketplace-search-index";
import { idOf, LISTINGS, QUERIES, resultShape, seedSearchFixture } from "./search-fixture";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
await seedSearchFixture();
const market = await marketFor({ actor: { activeMarketId: "JO" } });
const golden = JSON.parse(readFileSync(new URL("./fixtures/search-golden.json", import.meta.url.replace("/.test-build/", "/test/")), "utf8")) as Array<{ options: unknown; result?: unknown; full?: unknown; error?: string }>;

type Run = Array<{ options: unknown; result?: unknown[][]; full?: unknown[][]; error?: string }>;
async function runAll(engine: "SQL" | "LEGACY"): Promise<Run> {
  process.env.DINAR_SEARCH_ENGINE = engine;
  const out: Run = [];
  for (const options of QUERIES) {
    try {
      const result = resultShape(await searchMarketplaceListings(market, options as any));
      const full = resultShape(await searchMarketplaceListings(market, { ...(options as any), limit: 100_000 })).map((row) => row.slice(0, 4)).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      out.push({ options, result, full });
    } catch (error) { out.push({ options, error: (error as Error).message }); }
  }
  return out;
}
/** Queries whose order is defined by the request (a sort, or a stored result's own order). */
// A category without an explicit sort uses its default sort (NEWEST); RELEVANCE means no sort at all.
const ordered = (options: any) =>
  Boolean(options.allowedIds || (options.sort && options.sort !== "RELEVANCE") || (!options.sort && (options.categoryId || options.category)));
const paidCount = (rows?: unknown[][]) => (rows ?? []).filter((row) => row[4]).length;
/**
 * Against the pre-C1 golden: the complete matching set of every query is identical (no listing gained
 * or lost); queries with a defined order are identical result for result, paid labels included; for
 * unsorted queries only the order — the heap's, before — and the paid slots it scores may differ.
 */
function assertPreservedAgainstGolden(actual: Run, label: string) {
  assert.equal(actual.length, golden.length);
  let unsortedOrderDiffers = 0;
  for (const [index, expected] of golden.entries()) {
    const got = actual[index]!;
    const where = `${label} query #${index} ${JSON.stringify(expected.options)}`;
    assert.equal(got.error, expected.error, where);
    if (expected.error) continue;
    assert.deepEqual(got.full, (expected as any).full, `${where}: the complete matching set changed`);
    if (ordered(expected.options)) assert.deepEqual(got.result, expected.result, `${where}: an ordered result changed`);
    else {
      assert.equal(got.result!.length, (expected.result as unknown[]).length, `${where}: result count`);
      assert.equal(paidCount(got.result), paidCount(expected.result as unknown[][]), `${where}: number of paid slots`);
      if (JSON.stringify(got.result) !== JSON.stringify(expected.result)) unsortedOrderDiffers += 1;
    }
  }
  console.log("SEARCH_GOLDEN_COMPARISON", JSON.stringify({ label, queries: golden.length, orderedExact: golden.filter((item) => !item.error && ordered(item.options)).length, unsortedOrderDiffers }));
}

let legacy: Run;
await test("SF-03 with no search documents (nothing backfilled) the SQL engine equals the legacy engine exactly", async () => {
  assert.ok((await staleSearchDocumentCount("JO")) >= LISTINGS.length, "every fixture listing starts stale");
  legacy = await runAll("LEGACY");
  assertPreservedAgainstGolden(legacy, "LEGACY");
  assert.deepEqual(await runAll("SQL"), legacy, "SQL/stale equals LEGACY result for result, paid labels included");
});

await test("SF-01 after the backfill the SQL engine still equals the legacy engine and the pre-C1 golden", async () => {
  while ((await refreshSearchDocuments({ limit: 500 })).refreshed > 0);
  assert.equal(await staleSearchDocumentCount("JO"), 0);
  const fresh = await runAll("SQL");
  assert.deepEqual(fresh, legacy, "SQL/fresh equals LEGACY");
  assertPreservedAgainstGolden(fresh, "SQL/fresh");
});

await test("SF-02 the SQL engine reads a bounded candidate set, never the whole market", async () => {
  process.env.DINAR_SEARCH_ENGINE = "SQL";
  const [{ total }] = (await db.execute(sql`SELECT count(*)::int AS total FROM offers WHERE market_id = 'JO'`)).rows as Array<{ total: number }>;
  await searchMarketplaceListings(market, { search: "سامسونج", conversational: true });
  const narrow = lastSearchStats();
  assert.equal(narrow?.engine, "SQL");
  assert.ok(narrow!.rowsRead <= 3, `a selective query reads only its candidates: ${JSON.stringify(narrow)} of ${total}`);
  await searchMarketplaceListings(market, { search: "", categoryId: "cars", filters: [{ field: "price", operator: "lte", value: 7000 }], limit: 200 });
  assert.ok(lastSearchStats()!.rowsRead <= 8, JSON.stringify(lastSearchStats()));
  await searchMarketplaceListings(market, { search: "هاتف", conversational: true, limit: 3, sponsoredSlots: 0 });
  assert.ok(lastSearchStats()!.rowsRead < total, `an early stop reads less than the market: ${JSON.stringify(lastSearchStats())}`);
  process.env.DINAR_SEARCH_ENGINE = "LEGACY";
  await searchMarketplaceListings(market, { search: "سامسونج", conversational: true });
  assert.equal(lastSearchStats()!.rowsRead, total, "the legacy engine loads every market row (the defect C1 removes)");
});

await test("SF-04 an edit is found at once; a category change marks its listings stale and they stay found", async () => {
  process.env.DINAR_SEARCH_ENGINE = "SQL";
  const id = idOf("مزهرية زجاج");
  const [row] = await db.select().from(offers).where(eq(offers.id, id));
  await db.update(offers).set({ data: { ...row!.data, title: "مزهرية كريستال فاخرة" } }).where(eq(offers.id, id));
  const ids = async (search: string) => (await searchMarketplaceListings(market, { search, conversational: true, limit: 200 })).map((listing) => listing.id);
  assert.deepEqual(await ids("كريستال"), [id], "the new title is searchable before any refresh");
  assert.deepEqual(await ids("زجاج"), [], "the old title no longer matches");
  const [category] = await db.select().from(marketplaceCategories).where(eq(marketplaceCategories.id, "other"));
  await db.update(marketplaceCategories).set({ aliases: [...(category!.aliases as string[]), "تحفة"] }).where(eq(marketplaceCategories.id, "other"));
  assert.ok((await staleSearchDocumentCount("JO")) >= 2, "listings of the changed category are stale");
  assert.ok((await ids("كريستال")).includes(id));
  await db.update(marketplaceCategories).set({ aliases: category!.aliases }).where(eq(marketplaceCategories.id, "other"));
  while ((await refreshSearchDocuments({ limit: 500 })).refreshed > 0);
  assert.deepEqual(await ids("كريستال"), [id]);
});

await test("SF-05 a refresh racing an edit never stores text for an older revision", async () => {
  const id = idOf("مصباح طاولة");
  const [before] = await db.select().from(offers).where(eq(offers.id, id));
  await db.update(offers).set({ data: { ...before!.data, title: "مصباح أرضي" } }).where(eq(offers.id, id));
  // A refresh computed from the earlier snapshot (revision before the edit) must be refused.
  const stale = await refreshSearchDocuments({ rows: [{ offer: before!, seller: undefined as any }] });
  assert.equal(stale.refreshed, 0, "the older revision is not written");
  const [after] = await db.select().from(offers).where(eq(offers.id, id));
  assert.equal(after!.searchDocumentStale, true);
  const [doc] = await db.select().from(offerSearchDocuments).where(eq(offerSearchDocuments.offerId, id));
  assert.ok(!doc || doc.sourceRevision !== after!.searchRevision, "no document claims the current revision with old text");
  process.env.DINAR_SEARCH_ENGINE = "SQL";
  assert.deepEqual((await searchMarketplaceListings(market, { search: "أرضي", conversational: true })).map((listing) => listing.id), [id]);
});

await test("SF-06 rows with an equal creation time are ordered by id (deterministic)", async () => {
  const at = new Date("2026-09-30T00:00:00.000Z");
  for (const suffix of ["zz-b", "zz-a", "zz-c"])
    await db.insert(offers).values({ id: `sf-tie-${suffix}`, sellerId: "sf-seller-a", marketId: "JO", status: "PUBLISHED", unitPriceMinor: 5_000, pricingMode: "FIXED", inventoryMode: "LIMITED", availableQuantity: 1, reservedQuantity: 0, data: { title: `قطعة تعادل ${suffix}`, description: "", category: "أخرى", categoryId: "other", city: "عمان", area: "", attributes: {} }, createdAt: at, updatedAt: at });
  process.env.DINAR_SEARCH_ENGINE = "SQL";
  const found = (await searchMarketplaceListings(market, { search: "تعادل", conversational: true })).map((listing) => listing.id);
  assert.deepEqual(found, ["sf-tie-zz-a", "sf-tie-zz-b", "sf-tie-zz-c"]);
});

await test("SF-HIST-C1 historical numeric whitespace, underflow and subnormal values retain JavaScript search semantics", async () => {
  // Port the real edge values from codex/11-c1-sql-search without importing its obsolete SQL chain.
  const values: unknown[] = [null, true, false, "", "  ", "12.5", "0x20", "0b11", "0o10", "bad", "Infinity", [], [null], [7], [1, 2], {}, 0, -7, 1e20, "v12", "12v", "v", "\u000b12\u000b", "2e-999", "1e999", ["v12"], [[7]], "1e-999999", "3e-324", "2e-324"];
  const [seed] = await db.select().from(offers).where(eq(offers.id, idOf(LISTINGS[0]!.title))).limit(1);
  assert.ok(seed);
  const ids = values.map((_, index) => `sf-historical-number-${index}`);
  await db.insert(offers).values(values.map((value, index) => ({ ...seed, id: ids[index]!, data: { ...seed.data, title: "سيارة اختبار التحويل", attributes: { year: value } } as typeof seed.data, createdAt: new Date(1_790_000_000_000 + index), updatedAt: new Date(1_790_000_000_000 + index) })));
  try {
    process.env.DINAR_SEARCH_ENGINE = "SQL";
    const options = { search: "التحويل", categoryId: "cars", sponsoredPlacement: false as const, limit: 100 };
    const numeric = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : null; };
    const expected = values.map((value, index) => ({ index, value: numeric(value) })).sort((a, b) => a.value === null ? (b.value === null ? b.index - a.index : 1) : b.value === null ? -1 : a.value - b.value || b.index - a.index).map(row => ids[row.index]);
    assert.deepEqual((await searchMarketplaceListings(market, { ...options, sort: "YEAR_ASC" })).map(row => row.id), expected);
    for (const bound of [...new Set(values.map(numeric).filter((n): n is number => n !== null))]) {
      const matches = await searchMarketplaceListings(market, { ...options, filters: [{ field: "year", operator: "eq", value: bound }] });
      const expectedIds = values.flatMap((value, index) => value != null && numeric(value) === bound ? [ids[index]!] : []).sort();
      assert.deepEqual(matches.map(row => row.id).sort(), expectedIds, `historical numeric bound ${String(bound)}`);
    }
  } finally { await db.delete(offers).where(inArray(offers.id, ids)); }
});

after(async () => {
  delete process.env.DINAR_SEARCH_ENGINE;
  await pool.end();
});
