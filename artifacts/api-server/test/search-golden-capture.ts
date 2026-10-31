/** Re-captures fixtures/search-golden.json from the search implementation in this tree (C1 baseline: run on 9a0f86f). */
import { writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { marketFor } from "../src/lib/markets";
import { searchMarketplaceListings } from "../src/lib/marketplace-listings";
import { QUERIES, resultShape, seedSearchFixture } from "./search-fixture";
await seedSearchFixture();
const market = await marketFor({ actor: { activeMarketId: "JO" } });
const golden: unknown[] = [];
for (const options of QUERIES) {
  try {
    const result = resultShape(await searchMarketplaceListings(market, options as any));
    // The complete matching set (no limit), order-free: what must never change.
    const full = resultShape(await searchMarketplaceListings(market, { ...(options as any), limit: 100_000 })).map((row) => row.slice(0, 4)).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    golden.push({ options, result, full });
  } catch (error) { golden.push({ options, error: (error as Error).message }); }
}
writeFileSync("/home/user/dinar-c1/artifacts/api-server/test/fixtures/search-golden.json", JSON.stringify(golden, null, 1) + "\n");
console.log("SEARCH_GOLDEN", golden.length, golden.filter((g: any) => g.error).length, "errors", golden.filter((g: any) => g.result?.some((r: any) => r[4])).length, "with sponsored");
await pool.end();
