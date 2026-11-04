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
const historicalFixture = readFileSync(path.join(here, "rehearsal/pre-0056-fixtures.sql"), "utf8");
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

test(`a fresh PostgreSQL database receives exactly the ${journal.entries.length} reviewed migrations, then is current`, async () => {
  const db = await freshDatabase();
  const first = await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  assert.equal(first.status, "MIGRATED");
  assert.equal(first.applied, journal.entries.length);
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
  assert.equal(dry.pending.length, journal.entries.length - 28);
  assert.equal((await ledger(db.url)).length, 28, "a dry run applies nothing");
  const result = await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  assert.equal(result.status, "MIGRATED");
  assert.equal(result.appliedBefore, 28);
  assert.equal(result.applied, journal.entries.length - 28);
});

test("populated 0055 history survives a controlled interruption and resumes through 0056", async () => {
  const db = await freshDatabase();
  const prefixCount = journal.entries.length - 1;
  const older = folderWith(prefixCount);
  const prefix = await runReleaseMigration({ config: disposable(db), migrationsFolder: older.dir, manifest: older.manifest });
  assert.equal(prefix.applied, prefixCount);
  assert.equal((await query(db.url, "SELECT bool_or(is_active) AS any_active FROM markets"))[0]?.any_active, false);
  await query(db.url, historicalFixture);

  const snapshotSql = `
    SELECT jsonb_build_object(
      'users', (SELECT count(*)::int FROM users WHERE id LIKE 'g32-user-%'),
      'businesses', (SELECT count(*)::int FROM business_profiles WHERE id = 'g32-business'),
      'memberships', (SELECT count(*)::int FROM business_memberships WHERE id = 'g32-business-membership'),
      'listings', (SELECT count(*)::int FROM offers WHERE id = 'g32-offer'),
      'orders', (SELECT jsonb_agg(jsonb_build_array(id, buyer_id, seller_id, currency_code, unit_price_minor, quantity, subtotal_minor, platform_fee_minor, seller_amount_minor, status) ORDER BY id) FROM orders WHERE id = 'g32-order'),
      'items', (SELECT jsonb_agg(jsonb_build_array(id, order_id, offer_id, quantity, unit_price_minor, subtotal_minor) ORDER BY id) FROM order_items WHERE id = 'g32-order-item'),
      'payments', (SELECT jsonb_agg(jsonb_build_array(id, amount_minor, captured_amount_minor, refunded_amount_minor, currency_code, status) ORDER BY id) FROM payment_intents WHERE id = 'g32-payment'),
      'paymentEvents', (SELECT count(*)::int FROM payment_events WHERE id = 'g32-payment-event'),
      'disputes', (SELECT count(*)::int FROM disputes WHERE id = 'g32-dispute'),
      'ledger', (SELECT jsonb_agg(jsonb_build_array(id, event_type, amount_minor, currency_code) ORDER BY id) FROM order_financial_events WHERE id LIKE 'g32-ledger-%'),
      'audit', (SELECT count(*)::int FROM market_audit WHERE id = 'g32-market-audit')
    ) AS snapshot`;
  const [before] = await query(db.url, snapshotSql);
  assert.equal((await ledger(db.url)).length, prefixCount);

  await assert.rejects(
    runReleaseMigration({
      config: disposable(db),
      migrationsFolder,
      manifest,
      afterLock: async () => {
        throw new Error("controlled interruption before migration 0056");
      },
    }),
    /controlled interruption before migration 0056/,
  );
  assert.equal((await ledger(db.url)).length, prefixCount, "interrupted upgrade applied no partial migration");
  assert.deepEqual((await query(db.url, snapshotSql))[0]?.snapshot, before?.snapshot, "all historical records survived interruption");

  const resumed = await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  assert.equal(resumed.status, "MIGRATED");
  assert.equal(resumed.appliedBefore, prefixCount);
  assert.deepEqual(resumed.pending, [journal.entries.at(-1).tag]);
  assert.equal((await ledger(db.url)).length, journal.entries.length);
  assert.deepEqual((await query(db.url, snapshotSql))[0]?.snapshot, before?.snapshot, "all historical records survived migration 0056");
  assert.deepEqual(
    await query(db.url, "SELECT order_line_integrity_version FROM orders WHERE id = 'g32-order'"),
    [{ order_line_integrity_version: 0 }],
    "the pre-0056 order remains a version-0 historical snapshot",
  );

  const current = await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  assert.equal(current.status, "CURRENT", "retrying after recovery is idempotent");
  assert.deepEqual(
    await query(db.url, "SELECT bool_or(is_active) AS any_active FROM markets"),
    [{ any_active: false }],
    "the rehearsal never activated a real market",
  );
});

test("divergent, ahead and tampered states are refused before anything is applied", async () => {
  const db = await freshDatabase();
  const older = folderWith(10);
  await runReleaseMigration({ config: disposable(db), migrationsFolder: older.dir, manifest: older.manifest });
  await query(db.url, "UPDATE drizzle.__drizzle_migrations SET hash = 'unknown-history' WHERE id = (SELECT min(id) FROM drizzle.__drizzle_migrations)");
  await refusal(runReleaseMigration({ config: disposable(db), migrationsFolder, manifest }), "LEDGER_DIVERGENT");
  assert.equal((await ledger(db.url)).length, 10);

  const current = await freshDatabase();
  await runReleaseMigration({ config: disposable(current), migrationsFolder, manifest });
  await query(current.url, "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('future', 99999999999999)");
  await refusal(runReleaseMigration({ config: disposable(current), migrationsFolder, manifest }), "LEDGER_AHEAD");

  const edited = folderWith(journal.entries.length);
  writeFileSync(path.join(edited.dir, `${journal.entries[5].tag}.sql`), "SELECT 1;");
  await refusal(runReleaseMigration({ config: disposable(await freshDatabase()), migrationsFolder: edited.dir, manifest }), "MANIFEST");
});

test("unreviewed destructive SQL is refused; a failing migration rolls back completely", async () => {
  const db = await freshDatabase();
  await runReleaseMigration({ config: disposable(db), migrationsFolder, manifest });
  const destructive = folderWith(journal.entries.length, [{ name: "drop_markets", sql: "DROP TABLE markets CASCADE;" }]);
  await refusal(runReleaseMigration({ config: disposable(db), migrationsFolder: destructive.dir, manifest: destructive.manifest }), "DESTRUCTIVE");
  assert.deepEqual(await query(db.url, "SELECT to_regclass('public.markets') IS NOT NULL AS present"), [{ present: true }]);

  const failing = folderWith(journal.entries.length, [
    { name: "first_half", sql: "CREATE TABLE release_probe (id int);" },
    { name: "second_half", sql: "ALTER TABLE no_such_table ADD COLUMN x int;" },
  ]);
  await assert.rejects(runReleaseMigration({ config: disposable(db), migrationsFolder: failing.dir, manifest: failing.manifest }));
  assert.equal((await ledger(db.url)).length, journal.entries.length, "no ledger row from the failed batch");
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
