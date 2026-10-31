import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, offers, markets, pool } from "@workspace/db";
import { resolveMarket } from "../src/lib/markets";
import { searchMarketplaceListings } from "../src/lib/marketplace-listings";
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

after(async () => { await pool.end(); });
