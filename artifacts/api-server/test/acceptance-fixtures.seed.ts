import { pool } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { seedAcceptanceFixtures, type AcceptanceFixtureModule } from "./acceptance-fixtures";

requireSafeReplitDevelopmentDatabase("BDINAR_ACCEPTANCE_FIXTURES");
const allowed = new Set<AcceptanceFixtureModule>([
  "MARKET_FIXTURES",
  "USER_FIXTURES",
  "PRODUCT_LISTINGS",
  "PHASE1_LISTINGS",
]);
const requested = (process.env.BDINAR_ACCEPTANCE_FIXTURE_MODULES ?? "")
  .split(",")
  .map((module) => module.trim())
  .filter(Boolean);
for (const module of requested)
  if (!allowed.has(module as AcceptanceFixtureModule))
    throw new Error(`Unknown acceptance fixture module: ${module}`);
await seedAcceptanceFixtures(requested as AcceptanceFixtureModule[]);
console.log(`ACCEPTANCE_FIXTURES ${requested.join(",") || "none"}`);
await pool.end();
