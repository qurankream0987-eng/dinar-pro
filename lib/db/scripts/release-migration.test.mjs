// Release migration runner on disposable loopback PostgreSQL only.
// DINAR_RELEASE_MIGRATION_TEST_PG=postgres://user@127.0.0.1:PORT (server URL, no database).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  destructiveStatements,
  resolveReleaseMigrationConfig,
  runReleaseMigration,
} from "../src/release-migration.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "../drizzle");
const manifest = JSON.parse(readFileSync(path.join(migrationsFolder, "release-manifest.json"), "utf8"));
const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));

const server = process.env.DINAR_RELEASE_MIGRATION_TEST_PG;
const serverUrl = server ? new URL(server) : undefined;
if (!serverUrl || !["127.0.0.1", "localhost", "[::1]"].includes(serverUrl.hostname) || serverUrl.pathname.length > 1)
  throw new Error("DINAR_RELEASE_MIGRATION_TEST_PG must be a loopback PostgreSQL server URL without a database.");

const created = [];
const temporary = [];
async function admin(sql) {
  const client = new pg.Client({ connectionString: `${server}/postgres` });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}
async function freshDatabase() {
  const name = `dinar_migration_rel_${randomBytes(4).toString("hex")}`;
  await admin(`CREATE DATABASE ${name}`);
  created.push(name);
  return { name, url: `${server}/${name}` };
}
async function query(url, sql, params) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}
const disposable = (db, extra = {}) =>
  resolveReleaseMigrationConfig({
    DINAR_MIGRATION_TARGET: "disposable",
    DATABASE_URL: db.url,
    DINAR_MIGRATION_EXPECTED_DATABASE: db.name,
    ...extra,
  });
/** A copy of the migrations folder whose journal keeps the first `count` entries plus `extra`. */
function folderWith(count, extra = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "dinar-release-"));
  temporary.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  const entries = journal.entries.slice(0, count);
  const extraManifest = [];
  for (const [offset, migration] of extra.entries()) {
    const index = count + offset;
    const tag = `${String(index).padStart(4, "0")}_${migration.name}`;
    writeFileSync(path.join(dir, `${tag}.sql`), migration.sql);
    entries.push({ ...journal.entries.at(-1), idx: index, tag, when: journal.entries.at(-1).when + 1000 * (offset + 1) });
    extraManifest.push({ tag, sha256: sha256(migration.sql), ...(migration.reviewed ? { destructiveReviewed: migration.reviewed } : {}) });
  }
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return { dir, manifest: [...manifest.slice(0, count), ...extraManifest] };
}
import { createHash } from "node:crypto";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const ledger = (url) => query(url, "SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id");
const refusal = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
};

after(async () => {
  for (const name of created) await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

test("configuration refuses every ambiguous or unsafe target", () => {
  const staging = {
    DINAR_MIGRATION_TARGET: "staging",
    NODE_ENV: "production",
    DINAR_DEPLOYMENT_ENV: "staging",
    DINAR_MIGRATION_ACK: "APPLY_STAGING_MIGRATIONS",
    DATABASE_URL: "postgresql://app:secret@postgres.railway.internal:5432/railway",
    DINAR_MIGRATION_EXPECTED_DATABASE: "railway",
  };
  assert.equal(resolveReleaseMigrationConfig(staging).target, "staging");
  const refuses = (env, code) =>
    assert.throws(() => resolveReleaseMigrationConfig(env), (error) => error.code === code);
  refuses({ ...staging, DINAR_MIGRATION_TARGET: undefined }, "TARGET");
  refuses({ ...staging, DINAR_MIGRATION_TARGET: "development" }, "TARGET");
  refuses({ ...staging, DINAR_DEV_DATABASE_URL: "postgres://x@y/z" }, "DEV_URL_PRESENT");
  refuses({ ...staging, NODE_ENV: "development" }, "NODE_ENV");
  refuses({ ...staging, DINAR_DEPLOYMENT_ENV: "production" }, "DEPLOYMENT_ENV");
  refuses({ ...staging, DINAR_MIGRATION_ACK: "APPLY_PRODUCTION_MIGRATIONS" }, "ACK");
  refuses({ ...staging, DINAR_MIGRATION_TARGET: "production", DINAR_DEPLOYMENT_ENV: "production" }, "ACK");
  refuses({ ...staging, DATABASE_URL: "postgresql://a:b@iriguchi.proxy.rlwy.net:18992/railway" }, "FORBIDDEN_HOST");
  refuses({ ...staging, DATABASE_URL: "postgresql://a:b@127.0.0.1:5432/railway" }, "LOOPBACK");
  refuses({ ...staging, DATABASE_URL: "postgresql://a:b@postgres.railway.internal/railway?host=10.0.0.1" }, "DATABASE_URL");
  refuses({ ...staging, DINAR_MIGRATION_EXPECTED_DATABASE: "other" }, "EXPECTED_DATABASE");
  refuses({ ...staging, DINAR_MIGRATION_EXPECTED_DATABASE: undefined }, "EXPECTED_DATABASE");
  refuses({ DINAR_MIGRATION_TARGET: "disposable", DATABASE_URL: "postgresql://a@postgres.railway.internal/dinar_test_x", DINAR_MIGRATION_EXPECTED_DATABASE: "dinar_test_x" }, "DISPOSABLE");
  refuses({ DINAR_MIGRATION_TARGET: "disposable", DATABASE_URL: "postgresql://a@127.0.0.1/railway", DINAR_MIGRATION_EXPECTED_DATABASE: "railway" }, "DISPOSABLE");
});

test("the destructive scan flags data removal but not protective TRUNCATE triggers", () => {
  assert.deepEqual(destructiveStatements(readFileSync(path.join(migrationsFolder, "0016_wave4_payment_disputes.sql"), "utf8")), []);
  for (const entry of journal.entries)
    assert.deepEqual(destructiveStatements(readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8")), [], entry.tag);
  assert.equal(destructiveStatements('ALTER TABLE "x" DROP COLUMN "y";').length, 1);
  assert.equal(destructiveStatements("DROP TABLE x;--> statement-breakpoint\nCREATE TABLE z (id int);").length, 1);
  assert.equal(destructiveStatements("DELETE FROM x WHERE true;").length, 1);
});

test("a fresh PostgreSQL database receives exactly the 40 reviewed migrations, then is current", async () => {
  const db = await freshDatabase();
  const first = await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  assert.equal(first.status, "MIGRATED");
  assert.equal(first.applied, 40);
  assert.ok(first.serverVersionNum >= 180000);
  const rows = await ledger(db.url);
  assert.deepEqual(rows.map((row) => row.hash), manifest.map((entry) => entry.sha256));
  assert.deepEqual(rows.map((row) => row.created_at), journal.entries.map((entry) => String(entry.when)));
  const second = await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  assert.equal(second.status, "CURRENT");
  assert.equal(second.applied, 0);
  // No development fixture arrives with the schema.
  assert.deepEqual(await query(db.url, "SELECT count(*)::int AS n FROM users"), [{ n: 0 }]);
});

test("a database at an earlier release is completed from its exact ledger prefix", async () => {
  const db = await freshDatabase();
  const older = folderWith(28);
  assert.equal((await runReleaseMigration({ config: disposable(db), migrationsFolder: older.dir, manifest: older.manifest })).applied, 28);
  const dry = await runReleaseMigration({ config: disposable(db, { DINAR_MIGRATION_DRY_RUN: "1" }), migrationsFolder, manifest });
  assert.equal(dry.status, "PENDING_DRY_RUN");
  assert.equal(dry.pending.length, 12);
  assert.equal((await ledger(db.url)).length, 28, "a dry run applies nothing");
  const result = await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  assert.equal(result.status, "MIGRATED");
  assert.equal(result.appliedBefore, 28);
  assert.equal(result.applied, 12);
});

test("divergent, ahead and tampered states are refused before anything is applied", async () => {
  const db = await freshDatabase();
  const older = folderWith(10);
  await runReleaseMigration({ config: disposable(db), migrationsFolder: older.dir, manifest: older.manifest });
  await query(db.url, "UPDATE drizzle.__drizzle_migrations SET hash = 'tampered' WHERE id = (SELECT min(id) FROM drizzle.__drizzle_migrations)");
  await refusal(runReleaseMigration({ config: disposable(db), migrationsFolder, manifest }), "LEDGER_DIVERGENT");
  assert.equal((await ledger(db.url)).length, 10);

  const current = await freshDatabase();
  await runReleaseMigration({ config: disposable(current), migrationsFolder, manifest });
  await query(current.url, "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('future', 99999999999999)");
  await refusal(runReleaseMigration({ config: disposable(current), migrationsFolder, manifest }), "LEDGER_AHEAD");

  const edited = folderWith(40);
  writeFileSync(path.join(edited.dir, `${journal.entries[5].tag}.sql`), "SELECT 1;");
  await refusal(runReleaseMigration({ config: disposable(await freshDatabase()), migrationsFolder: edited.dir, manifest }), "MANIFEST");
});

test("unreviewed destructive SQL is refused; a failing migration rolls back completely", async () => {
  const db = await freshDatabase();
  await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  const destructive = folderWith(40, [{ name: "drop_markets", sql: "DROP TABLE markets CASCADE;" }]);
  await refusal(runReleaseMigration({ config: disposable(db), migrationsFolder: destructive.dir, manifest: destructive.manifest }), "DESTRUCTIVE");
  assert.deepEqual(await query(db.url, "SELECT to_regclass('public.markets') IS NOT NULL AS present"), [{ present: true }]);

  const failing = folderWith(40, [
    { name: "first_half", sql: "CREATE TABLE release_probe (id int);" },
    { name: "second_half", sql: "ALTER TABLE no_such_table ADD COLUMN x int;" },
  ]);
  await assert.rejects(runReleaseMigration({ config: disposable(db), migrationsFolder: failing.dir, manifest: failing.manifest }));
  assert.equal((await ledger(db.url)).length, 40, "no ledger row from the failed batch");
  assert.deepEqual(await query(db.url, "SELECT to_regclass('public.release_probe') IS NOT NULL AS present"), [{ present: false }]);
});

test("identity and concurrency: wrong database and a second runner are refused", async () => {
  const db = await freshDatabase();
  const other = await freshDatabase();
  const mismatched = { ...disposable(db), expectedDatabase: other.name };
  await refusal(runReleaseMigration({ config: mismatched, migrationsFolder, manifest }), "IDENTITY");

  let release;
  const held = new Promise((resolve) => (release = resolve));
  let signalLocked;
  const locked = new Promise((resolve) => (signalLocked = resolve));
  const first = runReleaseMigration({
    config: disposable(db),
    migrationsFolder,
    manifest,
    afterLock: async () => {
      signalLocked();
      await held;
    },
  });
  await locked;
  await refusal(runReleaseMigration({ config: disposable(db), migrationsFolder, manifest }), "LOCKED");
  release();
  assert.equal((await first).status, "MIGRATED");
});

test("the CLI prints a JSON summary or a refusal code, never the connection URL", async () => {
  const db = await freshDatabase();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const cli = (extra) =>
    spawnSync(process.execPath, ["--experimental-strip-types", path.join(here, "migrate-release.mjs")], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const refused = cli({ DINAR_MIGRATION_TARGET: "staging", DATABASE_URL: db.url, DINAR_MIGRATION_EXPECTED_DATABASE: db.name });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"code":"NODE_ENV"/);
  const ok = cli({ DINAR_MIGRATION_TARGET: "disposable", DATABASE_URL: db.url, DINAR_MIGRATION_EXPECTED_DATABASE: db.name });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /"status":"MIGRATED"/);
  for (const output of [refused.stdout, refused.stderr, ok.stdout, ok.stderr]) assert.ok(!output.includes(db.url));
});
