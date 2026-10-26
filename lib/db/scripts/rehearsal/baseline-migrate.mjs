// Disposable rehearsals only: apply the first N checked-in migrations to a loopback database
// through drizzle's own migrator, so the ledger matches a database that stopped at that point.
//   node ./scripts/rehearsal/baseline-migrate.mjs <loopback-url> <count> <scratch-dir>
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const [url, count, scratch] = process.argv.slice(2);
if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("The rehearsal target must be a disposable loopback database.");
}
if (!/^\d+$/.test(count ?? "") || !scratch || !path.isAbsolute(scratch)) {
  throw new Error("Usage: baseline-migrate.mjs <loopback-url> <count> <absolute-scratch-dir>");
}
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const work = path.join(scratch, `drizzle-${count}`);
await rm(work, { recursive: true, force: true });
await cp(source, work, { recursive: true });
const journalPath = path.join(work, "meta/_journal.json");
const journal = JSON.parse(await readFile(journalPath, "utf8"));
journal.entries = journal.entries.slice(0, Number(count));
await writeFile(journalPath, JSON.stringify(journal));
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await migrate(drizzle(client), { migrationsFolder: work, migrationsSchema: "drizzle" });
  const { rows } = await client.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
  console.log(JSON.stringify({ appliedEntries: rows[0].n }));
} finally {
  await client.end();
}
