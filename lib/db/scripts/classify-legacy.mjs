// Read-only inventory; never selects user payloads or copies data.
import pg from "pg";
import { writeFile } from "node:fs/promises";
if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT)
  throw new Error("Development editor only");
if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.DINAR_DEV_DATABASE_URL)
  throw new Error("A separate legacy DATABASE_URL is required");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='20s'");
  const tables = (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
  const dependencies = (await client.query(`select c.relname as name, string_agg(distinct r.relname, ', ' order by r.relname) as dependencies from pg_constraint p join pg_class c on c.oid=p.conrelid join pg_class r on r.oid=p.confrelid join pg_namespace n on n.oid=c.relnamespace where p.contype='f' and n.nspname='public' group by c.relname`)).rows;
  const rows = [];
  for (const { tablename: name } of tables) {
    const count = Number((await client.query(`select count(*) as n from public.${quote(name)}`)).rows[0].n);
    let category = "UNKNOWN", reason = "Row-level ownership/provenance is not proven by counts or identifiers.", transform = "Review provenance and canonical field compatibility before any import.";
    if (/^(markets|market_price_versions|marketplace_categories|promotion_products|commercial_policies|platform_settings|market_settings)/.test(name)) {
      category = "RESEED"; reason = "Configuration must come from canonical migrations or separately approved development settings."; transform = "Recreate approved configuration; do not copy historical pricing.";
    } else if (/session|rate_limit|verification|token|preview|result_set|ai_ui_blocks|checkout|draft|payment|ledger|balance|commercial_|commission|receivable|promotion|entitlement|subscription|settlement|dues|reservation|cart|order|dispute|audit|attribution|signal|cluster|cache|notification|delivery_|driver_assignment/.test(name)) {
      category = "SKIP_TEST_STATE"; reason = "Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven."; transform = "No import; recreate only with approved fixtures if needed.";
    }
    if (!count && category === "UNKNOWN") { reason = "Empty table; no legacy records to recover."; }
    rows.push({ name, count, category, reason, dependencies: dependencies.find(d => d.name === name)?.dependencies || "—", transform });
  }
  await client.query("ROLLBACK");
  const totals = Object.fromEntries(["MIGRATE_DIRECT","TRANSFORM_REQUIRED","RESEED","SKIP_TEST_STATE","UNKNOWN"].map(k=>[k,rows.filter(r=>r.category===k).length]));
  const report = `# DINAR legacy provenance classification\n\nRead-only, repeatable-read inventory of the legacy development database. No records imported or modified. No personal payloads exported.\n\nClassification is complete at the table level, not a certification of user-created provenance. UNKNOWN is deliberately retained where evidence is insufficient. No table is approved for migration. Financial/test history is excluded, not repaired by fabricated values. Dependencies reflect legacy foreign keys; canonical validation is additionally required before any future data-only import.\n\nCategory totals (tables): ${JSON.stringify(totals)}\n\n| Table | Rows | Category | Reason | Dependencies | Required transformation | Safe to migrate |\n|---|---:|---|---|---|---|---|\n` + rows.map(r=>`| ${r.name} | ${r.count} | ${r.category} | ${r.reason} | ${r.dependencies} | ${r.transform} | NO |`).join("\n")+"\n";
  await writeFile(new URL("../../../docs/DINAR-LEGACY-PROVENANCE.md", import.meta.url), report);
  console.log(JSON.stringify({ tables: rows.length, categories: totals }));
} finally { await client.end(); }
