// Upgrade fixtures for the canonical 0041–0046 sequence on PostgreSQL 16 and 18.
// DINAR_RELEASE_MIGRATION_TEST_PG=postgres://user@127.0.0.1:PORT (server URL, no database)
//
// Unlike the release runner (which requires 18), this uses drizzle's own migrator directly so
// the same upgrade path can be proven on both supported majors. It exists to catch the exact
// failure an incorrect journal causes: a missing migration whose `when` is older than the last
// applied row is treated as already applied and silently skipped.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "../drizzle");
const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(migrationsFolder, "release-manifest.json"), "utf8"));

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
  const name = `dinar_upgrade_${randomBytes(5).toString("hex")}`;
  await admin(`CREATE DATABASE ${name}`);
  created.push(name);
  return { name, url: `${server}/${name}` };
}
async function migrateFolder(url, folder) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: "drizzle" });
  } finally {
    await client.end();
  }
}
async function ledger(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query("SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
  } finally {
    await client.end();
  }
}
async function presentTables(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(
      `SELECT to_regclass('public.order_financial_events') IS NOT NULL AS financial,
              to_regclass('public.cash_refund_cases') IS NOT NULL AS cash,
              to_regclass('public.policy_registry_versions') IS NOT NULL AS policy,
              to_regclass('public.support_cases') IS NOT NULL AS support`,
    )).rows[0];
  } finally {
    await client.end();
  }
}
/** A copy of the migrations folder whose journal keeps only the first `count` entries. */
function slicedFolder(count) {
  const dir = mkdtempSync(path.join(tmpdir(), "dinar-upgrade-"));
  temporary.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }),
  );
  return dir;
}

after(async () => {
  for (const name of created) await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

test("the canonical journal is strictly increasing and matches the release manifest", () => {
  assert.equal(journal.entries.length, manifest.length);
  assert.equal(journal.entries.at(-1).tag, "0046_wave10_trust_support_whatsapp");
  journal.entries.forEach((entry, index) => {
    assert.equal(entry.idx, index, `${entry.tag} keeps its position`);
    assert.equal(entry.tag, manifest[index].tag, `${entry.tag} matches the manifest`);
    if (index > 0)
      assert.ok(entry.when > journal.entries[index - 1].when, `${entry.tag} is strictly after its predecessor`);
  });
});

for (const count of [0, 28, 42]) {
  test(`a database at migration ${count} is completed without skipping the integrated waves`, async () => {
    const db = await freshDatabase();
    if (count > 0) await migrateFolder(db.url, slicedFolder(count));
    const before = count > 0 ? await ledger(db.url) : [];
    assert.equal(before.length, count);

    await migrateFolder(db.url, migrationsFolder);
    const rows = await ledger(db.url);
    assert.equal(rows.length, journal.entries.length);
    assert.deepEqual(rows.map((row) => row.hash), manifest.map((entry) => entry.sha256));
    assert.deepEqual(rows.map((row) => row.created_at), journal.entries.map((entry) => String(entry.when)));
    // The tail entries were really executed, not assumed applied because of an older `when`.
    const tail = journal.entries.slice(count);
    tail.forEach((entry, offset) => {
      const row = rows[count + offset];
      assert.equal(row.hash, createHash("sha256").update(readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`))).digest("hex"));
    });
    assert.deepEqual(await presentTables(db.url), { financial: true, cash: true, policy: true, support: true });

    await migrateFolder(db.url, migrationsFolder);
    assert.equal((await ledger(db.url)).length, journal.entries.length, "a second run applies nothing");
  });
}
