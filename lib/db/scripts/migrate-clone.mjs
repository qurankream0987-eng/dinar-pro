import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  assertCloneDatabaseIdentity,
  assertCloneMigrationBaseline,
  assertCloneMigrationJournal,
  resolveCloneMigrationTarget,
  verifiedCloneDatabaseCredentials,
} from "../src/clone-migration-guard.ts";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const journalPath = path.join(packageDirectory, "drizzle/meta/_journal.json");
const migrationsDirectory = path.join(packageDirectory, "drizzle");
let target;
let client;
let phase = "configuration";
try {
  // The checked-in plan is verified before any connection: an unreviewed migration never runs.
  phase = "journal";
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const entries = [];
  for (const entry of journal.entries) {
    const sql = await readFile(path.join(migrationsDirectory, `${entry.tag}.sql`));
    entries.push({
      tag: entry.tag,
      when: entry.when,
      hash: createHash("sha256").update(sql).digest("hex"),
    });
  }
  assertCloneMigrationJournal(entries.map(({ tag, hash }) => ({ tag, sha256: hash })));
  const expected = entries.slice(0, 28).map(({ when, hash }) => ({ when, hash }));

  phase = "configuration";
  target = resolveCloneMigrationTarget(process.env);
  client = new pg.Client({
    ...verifiedCloneDatabaseCredentials(target.connectionString, process.env),
    connectionTimeoutMillis: 15_000,
  });
  phase = "connect";
  await client.connect();
  phase = "read-only-preflight";
  await client.query("BEGIN READ ONLY");
  const identityResult = await client.query(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      inet_server_port()::integer AS server_port,
      (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
      current_setting('transaction_read_only') = 'on' AS read_only
  `);
  const identity = identityResult.rows[0];
  assertCloneDatabaseIdentity({
    databaseName: identity.database_name,
    databaseUser: identity.database_user,
    serverPort: Number(identity.server_port),
    ssl: identity.ssl === true,
    readOnly: identity.read_only === true,
  }, target);

  const ledger = await client.query(
    "SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  assertCloneMigrationBaseline(ledger.rows, expected);
  await client.query("ROLLBACK");

  phase = "migration";
  console.log("Verified the isolated Railway clone, its 28-migration baseline and the reviewed journal.");
  await migrate(drizzle(client), {
    migrationsFolder: migrationsDirectory,
    migrationsSchema: "drizzle",
  });
  console.log("Clone migration rehearsal completed.");
} catch (error) {
  await client?.query("ROLLBACK").catch(() => {});
  const code = error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "CHECK_FAILED";
  console.error(`Clone migration stopped during ${phase} (${code}); no URL or secret was logged.`);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
