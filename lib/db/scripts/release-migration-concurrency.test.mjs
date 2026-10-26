// Release migration concurrency and lock scope, on disposable loopback PostgreSQL only.
// DINAR_RELEASE_MIGRATION_TEST_PG=postgres://user@127.0.0.1:PORT (server URL, no database).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { MIGRATION_LOCK_KEY, resolveReleaseMigrationConfig, runReleaseMigration } from "../src/release-migration.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "../drizzle");
const manifest = JSON.parse(readFileSync(path.join(migrationsFolder, "release-manifest.json"), "utf8"));
const server = process.env.DINAR_RELEASE_MIGRATION_TEST_PG;
const serverUrl = server ? new URL(server) : undefined;
if (!serverUrl || !["127.0.0.1", "localhost", "[::1]"].includes(serverUrl.hostname) || serverUrl.pathname.length > 1)
  throw new Error("DINAR_RELEASE_MIGRATION_TEST_PG must be a loopback PostgreSQL server URL without a database.");

const created = [];
async function query(url, sql, params) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}
async function freshDatabase() {
  const name = `dinar_migration_cc_${randomBytes(4).toString("hex")}`;
  await query(`${server}/postgres`, `CREATE DATABASE ${name}`);
  created.push(name);
  return { name, url: `${server}/${name}` };
}
after(async () => {
  for (const name of created) await query(`${server}/postgres`, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
});

function cli(db) {
  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(here, "migrate-release.mjs")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DINAR_MIGRATION_TARGET: "disposable", DATABASE_URL: db.url, DINAR_MIGRATION_EXPECTED_DATABASE: db.name },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

test("two release runners started together: exactly one migrates, the other refuses or finds it current", async () => {
  const outcomes = [];
  for (let round = 0; round < 8; round++) {
    const db = await freshDatabase();
    const results = await Promise.all([cli(db), cli(db)]);
    const statuses = results.map((result) =>
      result.status === 0
        ? JSON.parse(result.stdout).releaseMigration.status
        : JSON.parse(result.stderr).releaseMigration.code,
    );
    outcomes.push(statuses.sort().join("+"));
    assert.equal(statuses.filter((status) => status === "MIGRATED").length, 1, `round ${round}: ${statuses}`);
    assert.ok(statuses.every((status) => ["MIGRATED", "LOCKED", "CURRENT"].includes(status)), `round ${round}: ${statuses}`);
    const ledger = await query(db.url, "SELECT count(*)::int AS n, count(DISTINCT hash)::int AS distinct_hashes FROM drizzle.__drizzle_migrations");
    assert.deepEqual(ledger[0], { n: manifest.length, distinct_hashes: manifest.length });
    const locks = await query(db.url, "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
    assert.equal(locks[0].n, 0, "the advisory lock is released after both runners exit");
  }
  console.log(`CONCURRENT_RUNNER_OUTCOMES ${JSON.stringify(outcomes)}`);
});

test("the session lock is held by the runner's own connection for the whole run and released explicitly", async () => {
  const db = await freshDatabase();
  const config = resolveReleaseMigrationConfig({ DINAR_MIGRATION_TARGET: "disposable", DATABASE_URL: db.url, DINAR_MIGRATION_EXPECTED_DATABASE: db.name });
  let observed;
  const result = await runReleaseMigration({
    config,
    migrationsFolder,
    manifest,
    afterLock: async () => {
      // From an independent session: exactly one advisory lock, session-level (not xact), on our key.
      observed = await query(db.url, `
        SELECT l.pid, l.granted, a.backend_type, a.datname,
               ((l.classid::bigint << 32) | l.objid::bigint) AS key, l.objsubid
          FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE l.locktype = 'advisory'
           AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    },
  });
  assert.equal(result.status, "MIGRATED");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].granted, true);
  assert.equal(observed[0].datname, db.name);
  assert.equal(BigInt(observed[0].key), BigInt(MIGRATION_LOCK_KEY));
  assert.equal(observed[0].objsubid, 1, "objsubid 1 = single bigint key (pg_advisory_lock(bigint))");
  const remaining = await query(db.url, "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
  assert.equal(remaining[0].n, 0);
});

test("the runner never uses a pool: one client carries the lock, the migration and the unlock", () => {
  const source = readFileSync(path.join(here, "../src/release-migration.ts"), "utf8");
  assert.doesNotMatch(source, /new pg\.Pool|\bPool\(/, "a pool could run the migration on a connection without the lock");
  assert.match(source, /pg_try_advisory_lock\(\$1\)/);
  assert.match(source, /migrate\(drizzle\(client\)/, "the migrator runs on the locked client");
  assert.match(source, /pg_advisory_unlock\(\$1\)/);
});
