/**
 * C1 — the PostgreSQL search foundation over real PostgreSQL (fixture: search-fixture.ts).
 *
 *  SF-01 Both engines reproduce the golden captured from the pre-C1 in-memory search, for all 88
 *        caller-shaped queries: identities, order, prices, statuses, categories, paid labels, errors.
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
import { eq, sql } from "drizzle-orm";
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
const golden = JSON.parse(readFileSync(new URL("./fixtures/search-golden.json", import.meta.url.replace("/.test-build/", "/test/")), "utf8")) as Array<{ options: unknown; result?: unknown; error?: string }>;

async function runAll(engine: "SQL" | "LEGACY") {
  process.env.DINAR_SEARCH_ENGINE = engine;
  const out: Array<{ options: unknown; result?: unknown; error?: string }> = [];
  for (const options of QUERIES) {
    try { out.push({ options, result: resultShape(await searchMarketplaceListings(market, options as any)) }); }
    catch (error) { out.push({ options, error: (error as Error).message }); }
  }
  return out;
}
function assertGolden(actual: Awaited<ReturnType<typeof runAll>>, label: string) {
  assert.equal(actual.length, golden.length);
  for (const [index, expected] of golden.entries())
    assert.deepEqual(actual[index], expected, `${label} query #${index} ${JSON.stringify(expected.options)}`);
}

await test("SF-03 with no search documents (nothing backfilled) the SQL engine already equals the golden", async () => {
  assert.ok((await staleSearchDocumentCount("JO")) >= LISTINGS.length, "every fixture listing starts stale");
  assertGolden(await runAll("SQL"), "SQL/stale");
});

await test("SF-01 after the backfill both engines reproduce the golden exactly", async () => {
  while ((await refreshSearchDocuments({ limit: 500 })).refreshed > 0);
  assert.equal(await staleSearchDocumentCount("JO"), 0);
  assertGolden(await runAll("SQL"), "SQL/fresh");
  assertGolden(await runAll("LEGACY"), "LEGACY");
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

after(async () => {
  delete process.env.DINAR_SEARCH_ENGINE;
  await pool.end();
});
