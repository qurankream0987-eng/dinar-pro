import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, offers, markets, pool } from "@workspace/db";
import { resolveMarket } from "../src/lib/markets";
import { searchMarketplaceListings } from "../src/lib/marketplace-listings";
import { searchCandidateQuery } from "../src/lib/marketplace-search-cursor";
import { searchMarketplaceListings as legacySearch } from "./fixtures/c1/legacy-marketplace-listings";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const [marketRow] = await db.select().from(markets).where(eq(markets.id, "JO"));
assert.ok(marketRow);
const market = await resolveMarket(marketRow);
const [seed] = await db.select().from(offers).where(eq(offers.marketId, "JO")).limit(1);
assert.ok(seed, "acceptance listing fixture required");
const ids = Array.from({ length: 512 }, (_, i) => `c1_fixture_${String(i).padStart(4, "0")}`);
for (let start = 0; start < ids.length; start += 64) {
  await db.insert(offers).values(ids.slice(start, start + 64).map((id, offset) => {
    const index = start + offset;
    return { ...seed, id, status: "PUBLISHED", pricingMode: "FIXED", unitPriceMinor: 1000 + index,
      inventoryMode: "LIMITED", availableQuantity: 3, reservedQuantity: 0,
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)),
      data: { ...seed.data, title: index === 511 ? "c1needle هاتف مستعمل" : `c1ordinary ${index}`,
        description: "جوال بحالة جيدة", city: "عمان", area: "خلدا" } };
  }));
}

await test("C1 golden: explicit ordering and stored references retain baseline records", async () => {
  for (const options of [
    { search: "c1needle", conversational: true },
    { search: "c1ordinary", sort: "PRICE_ASC" as const },
    { search: "c1ordinary", sort: "PRICE_DESC" as const },
    { search: "c1ordinary", sort: "NEWEST" as const },
    { search: "", allowedIds: [ids[511]!, ids[4]!, ids[8]!], sponsoredIds: [ids[4]!] },
    { search: "شيءلايوجد", conversational: true },
    { search: "c1ordinary", filters: [{ field: "price", operator: "lte" as const, value: 1.2 }], sort: "PRICE_ASC" as const },
  ]) {
    assert.deepEqual(await searchMarketplaceListings(market, options), await legacySearch(market, options), JSON.stringify(options));
  }
});

await test("C1 selective retrieval never transfers a full market into Node", async () => {
  const original = pool.query;
  let maximumOfferRows = 0;
  let cursorFetches = 0;
  const wrapped = new Map<any, any>();
  const wrap = (client: any) => {
    if (wrapped.has(client)) return;
    const query = client.query;
    wrapped.set(client, query);
    client.query = function (...args: any[]) {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      const result = query.apply(this, args);
      return /^FETCH /i.test(text) ? result.then((value: any) => {
        cursorFetches++;
        maximumOfferRows = Math.max(maximumOfferRows, value.rows.length);
        return value;
      }) : result;
    };
  };
  pool.on("acquire", wrap);
  (pool as any).query = function (...args: any[]) {
    const query = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
    const result = (original as any).apply(this, args);
    if (/from\s+"?offers"?/i.test(query) && result?.then) {
      return result.then((value: any) => {
        maximumOfferRows = Math.max(maximumOfferRows, value.rows.length);
        return value;
      });
    }
    return result;
  };
  try {
    const found = await searchMarketplaceListings(market, { search: "c1needle", conversational: true, limit: 1, sponsoredPlacement: false });
    assert.equal(found[0]?.id, ids[511]);
    assert.ok(maximumOfferRows <= 128, `unbounded transfer: ${maximumOfferRows} offer rows for one result`);
    assert.ok(cursorFetches > 0, "the production retrieval must expose measured bounded batches");
    console.log("C1_TRANSFER", JSON.stringify({ maximumOfferRows, cursorFetches }));
  } finally { pool.query = original; pool.off("acquire", wrap); for (const [client, query] of wrapped) client.query = query; }
});

await test("C1 numeric sort conversion agrees with finite JavaScript Number", async () => {
  for (const value of [null, true, false, "", "  ", "12.5", "0x20", "0b11", "0o10", "bad", "Infinity", [], [null], [7], [1, 2], {}, 0, -7, 1e20]) {
    const expected = Number(value);
    const result = await pool.query("select dinar_search_number($1::jsonb) as value", [JSON.stringify(value)]);
    assert.equal(result.rows[0].value, Number.isFinite(expected) ? expected : null, JSON.stringify(value));
  }
  assert.equal((await pool.query("select dinar_search_number(NULL) as value")).rows[0].value, null);
});

await test("C1 measured selective retrieval on 20,000 synthetic offers", async () => {
  const count = 20_000;
  for (let start = 0; start < count; start += 500) {
    await db.insert(offers).values(Array.from({ length: Math.min(500, count - start) }, (_, i) => ({
      ...seed, id: `c1_perf_${String(start + i).padStart(6, "0")}`, status: "PUBLISHED", pricingMode: "FIXED",
      unitPriceMinor: 1000 + start + i, inventoryMode: "LIMITED", availableQuantity: 3, reservedQuantity: 0,
      data: { ...seed.data, title: "c1perf هاتف", description: "منتج اختبار اصطناعي" },
    })));
  }
  await pool.query("ANALYZE offers");
  const filters = [{ field: "price", operator: "eq" as const, value: (999 + count) / 10 ** market.minorUnitScale }];
  const options = { search: "c1perf", filters, sort: "PRICE_ASC" as const, sponsoredPlacement: false as const, limit: 24 };
  const query = searchCandidateQuery({ marketId: market.id, filters, minorUnitScale: market.minorUnitScale, order: { field: "PRICE", direction: "ASC" } }).toSQL();
  const plan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params);
  const times: Record<string, number[]> = { legacy: [], sql: [] };
  for (let trial = 0; trial < 3; trial++) {
    let expected;
    for (const [name, search] of [["legacy", legacySearch], ["sql", searchMarketplaceListings]] as const) {
      const start = performance.now();
      const found = await search(market, options);
      times[name]!.push(performance.now() - start);
      if (name === "legacy") expected = found;
      else assert.deepEqual(found, expected);
    }
  }
  console.log("C1_PERFORMANCE", JSON.stringify({ fixtureOffers: count + ids.length, timesMs: times, plan: plan.rows[0]["QUERY PLAN"] }));
});

after(async () => { await pool.end(); });
