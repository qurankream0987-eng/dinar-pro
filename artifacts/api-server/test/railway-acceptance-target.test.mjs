// node --test test/railway-acceptance-target.test.mjs   (optional: DINAR_RA_LOCAL_PG=postgres://user@127.0.0.1:55418)
// Proves the railway-acceptance seed target accepts only the pinned acceptance database, refuses
// every other target and entry point, and leaves the loopback/Replit guards exactly as they were.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import {
  RAILWAY_ACCEPTANCE as A,
  MIGRATION_REFERENCE_TABLES,
  validateRailwayAcceptanceTarget,
  verifyRailwayAcceptanceDatabase,
} from "./railway-acceptance-target.mjs";
import { validateAcceptanceDatabase } from "./acceptance-database-guard.mjs";

const URL_OK = `postgresql://postgres:x@${A.databaseHost}:5432/${A.databaseName}`;
const JOB = "11111111-2222-3333-4444-555555555555";
const good = () => ({
  DINAR_SEED_TARGET: "railway-acceptance",
  DINAR_SEED_ACK: A.acknowledgement,
  DINAR_DEPLOYMENT_ENV: "staging",
  NODE_ENV: "development",
  RAILWAY_PROJECT_ID: A.projectId,
  RAILWAY_ENVIRONMENT_ID: A.environmentId,
  RAILWAY_ENVIRONMENT_NAME: A.environmentName,
  RAILWAY_ENVIRONMENT: A.environmentName,
  RAILWAY_SERVICE_ID: JOB,
  DINAR_SEED_EXPECTED_SERVICE_ID: JOB,
  DINAR_DEV_DATABASE_URL: URL_OK,
  DATABASE_URL: URL_OK,
  BDINAR_DISPOSABLE_ACCEPTANCE_DB: "1",
});
const entry = A.entry;
const refused = (env, pattern, opts = { entry }) => assert.throws(() => validateRailwayAcceptanceTarget(env, opts), pattern);

test("RA-01 the exact acceptance target is accepted", () => {
  assert.deepEqual(validateRailwayAcceptanceTarget(good(), { entry }), { host: A.databaseHost, databaseName: A.databaseName });
});

test("RA-02 opt-in, acknowledgement, deployment label and runtime are all required", () => {
  refused({ ...good(), DINAR_SEED_TARGET: "railway" }, /exactly railway-acceptance/);
  refused({ ...good(), DINAR_SEED_ACK: undefined }, /DINAR_SEED_ACK/);
  refused({ ...good(), DINAR_SEED_ACK: "yes" }, /DINAR_SEED_ACK/);
  refused({ ...good(), DINAR_DEPLOYMENT_ENV: "production" }, /DINAR_DEPLOYMENT_ENV=staging/);
  refused({ ...good(), DINAR_DEPLOYMENT_ENV: undefined }, /DINAR_DEPLOYMENT_ENV=staging/);
  refused({ ...good(), NODE_ENV: "production" }, /NODE_ENV=development/);
  refused({ ...good(), REPL_ID: "x" }, /Replit/);
  refused({ ...good(), REPLIT_DEPLOYMENT: "1" }, /Replit/);
});

test("RA-03 wrong project, environment or service identity is refused", () => {
  refused({ ...good(), RAILWAY_PROJECT_ID: "65c1622c-dc31-4fe5-ad46-866a91094f52" }, /project/);
  refused({ ...good(), RAILWAY_PROJECT_ID: undefined }, /project/);
  refused({ ...good(), RAILWAY_ENVIRONMENT_ID: "fbc32503-3913-4b12-aa81-1fc2506b8825" }, /environment id/);
  refused({ ...good(), RAILWAY_ENVIRONMENT_NAME: "staging" }, /environment name/);
  refused({ ...good(), RAILWAY_SERVICE_ID: undefined }, /own Railway job service/);
  refused({ ...good(), RAILWAY_SERVICE_ID: A.databaseServiceId, DINAR_SEED_EXPECTED_SERVICE_ID: A.databaseServiceId }, /own Railway job service/);
  refused({ ...good(), DINAR_SEED_EXPECTED_SERVICE_ID: "other" }, /DINAR_SEED_EXPECTED_SERVICE_ID/);
});

test("RA-04 wrong host, database, port or URL tricks are refused", () => {
  const withUrl = (url) => ({ ...good(), DINAR_DEV_DATABASE_URL: url, DATABASE_URL: url });
  refused(withUrl(`postgresql://p:x@dinar-staging-postgres-ams.railway.internal:5432/${A.databaseName}`), /host/);
  refused(withUrl(`postgresql://p:x@postgres.railway.internal:5432/${A.databaseName}`), /host/);
  refused(withUrl(`postgresql://p:x@127.0.0.1:5432/${A.databaseName}`), /host/);
  refused(withUrl(`postgresql://p:x@${A.databaseHost}.evil.example:5432/${A.databaseName}`), /host/);
  refused(withUrl(`postgresql://p:x@${A.databaseHost}:6543/${A.databaseName}`), /port/);
  refused(withUrl(`postgresql://p:x@${A.databaseHost}:5432/dinar_staging`), /jassimai_acceptance/);
  refused(withUrl(`postgresql://p:x@${A.databaseHost}:5432/jassimai_acceptance_staging`), /jassimai_acceptance/);
  refused(withUrl(`postgresql://p:x@${A.databaseHost}:5432/railway`), /jassimai_acceptance/);
  refused(withUrl(`${URL_OK}?host=dinar-staging-postgres-ams.railway.internal`), /host overrides/);
  refused(withUrl(`${URL_OK}?hostaddr=10.0.0.1`), /host overrides/);
  refused(withUrl(`mysql://p:x@${A.databaseHost}:5432/${A.databaseName}`), /PostgreSQL URL/);
  refused({ ...good(), DINAR_DEV_DATABASE_URL: undefined }, /DINAR_DEV_DATABASE_URL/);
  refused({ ...good(), DATABASE_URL: `postgresql://p:x@dinar-staging-postgres-ams.railway.internal:5432/dinar_staging` }, /same target/);
});

test("RA-05 provider credentials in the process are refused (no outbound provider can be reached)", () => {
  for (const key of ["TWILIO_API_KEY_SECRET", "TWILIO_ACCOUNT_SID", "WHOP_API_KEY", "OPENROUTER_API_KEY", "DINAR_DEEPSEEK_API_KEY", "OPENAI_API_KEY", "SECRET_ACCESS_KEY", "SENDGRID_API_KEY"])
    refused({ ...good(), [key]: "value" }, /provider credentials/);
});

test("RA-06 only the fixture seed entry point may use the target", () => {
  for (const other of ["seed", "lab-fixtures.seed", "commerce.test", "admin-bootstrap.test", undefined])
    refused(good(), /may use this target/, { entry: other });
  assert.throws(() => validateAcceptanceDatabase(good(), { entry: "commerce.test" }), /may use this target/);
  assert.throws(() => validateAcceptanceDatabase(good()), /may use this target/);
  assert.doesNotThrow(() => validateAcceptanceDatabase(good(), { entry }));
});

test("RA-07 without DINAR_SEED_TARGET the existing loopback guard is unchanged", () => {
  const local = { BDINAR_DISPOSABLE_ACCEPTANCE_DB: "1", NODE_ENV: "development", DINAR_DEV_DATABASE_URL: "postgres://u@127.0.0.1:55432/dinar_test_x" };
  assert.doesNotThrow(() => validateAcceptanceDatabase(local, { entry: "commerce.test" }));
  assert.throws(() => validateAcceptanceDatabase({ ...local, DINAR_DEV_DATABASE_URL: `postgresql://p:x@${A.databaseHost}:5432/${A.databaseName}` }), /localhost/);
  assert.throws(() => validateAcceptanceDatabase({ ...local, RAILWAY_ENVIRONMENT: "acceptance" }), /deployment environments/);
  assert.throws(() => validateAcceptanceDatabase({ ...local, BDINAR_DISPOSABLE_ACCEPTANCE_DB: undefined }), /BDINAR_DISPOSABLE_ACCEPTANCE_DB/);
  // The opt-in still requires the disposable-run flag first.
  assert.throws(() => validateAcceptanceDatabase({ ...good(), BDINAR_DISPOSABLE_ACCEPTANCE_DB: undefined }, { entry }), /BDINAR_DISPOSABLE_ACCEPTANCE_DB/);
});

test("RA-08 the Replit/loopback guard allows the target only for the fixture seed", async () => {
  // Bundled inside the package so workspace dependencies resolve; removed afterwards.
  const dir = mkdtempSync(path.join(new URL("../.test-build/", import.meta.url).pathname, "ra-guard-"));
  try {
    const out = path.join(dir, "guard.mjs");
    await build({ entryPoints: [new URL("./safe-development-database.ts", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent", packages: "external" });
    const { requireSafeReplitDevelopmentDatabase } = await import(out);
    const saved = { ...process.env };
    try {
      // A clean process environment: only what the one-time job would carry.
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, { PATH: saved.PATH }, good(), { BDINAR_ACCEPTANCE_FIXTURES: "development" });
      assert.doesNotThrow(() => requireSafeReplitDevelopmentDatabase("BDINAR_ACCEPTANCE_FIXTURES"));
      assert.throws(() => requireSafeReplitDevelopmentDatabase("BDINAR_SEED"), /reserved for the acceptance fixture seed/);
      assert.throws(() => requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE"), /reserved for the acceptance fixture seed/);
      process.env.BDINAR_ACCEPTANCE_FIXTURES = "yes";
      assert.throws(() => requireSafeReplitDevelopmentDatabase("BDINAR_ACCEPTANCE_FIXTURES"), /BDINAR_ACCEPTANCE_FIXTURES=development/);
      process.env.BDINAR_ACCEPTANCE_FIXTURES = "development";
      process.env.RAILWAY_ENVIRONMENT_ID = "fbc32503-3913-4b12-aa81-1fc2506b8825";
      assert.throws(() => requireSafeReplitDevelopmentDatabase("BDINAR_ACCEPTANCE_FIXTURES"), /environment id/);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Server-side checks with a controllable client.
const dir = mkdtempSync(path.join(tmpdir(), "ra-manifest-"));
const manifestPath = path.join(dir, "release-manifest.json");
const manifest = [{ tag: "0000_a", sha256: "a".repeat(64) }, { tag: "0001_b", sha256: "b".repeat(64) }];
writeFileSync(manifestPath, JSON.stringify(manifest));
function fakeClient({ db = A.databaseName, version = 180006, address = "fd12:3456::7", ledger = manifest.map((m) => m.sha256), tables = ["users", ...MIGRATION_REFERENCE_TABLES], populated = MIGRATION_REFERENCE_TABLES } = {}) {
  return {
    async query(sql) {
      if (sql.includes("current_database()")) return { rows: [{ db, version, address }] };
      if (sql.includes("__drizzle_migrations")) return { rows: ledger.map((hash) => ({ hash })) };
      if (sql.includes("pg_tables")) return { rows: tables.map((tablename) => ({ tablename })) };
      const table = /public\."([^"]+)"/.exec(sql)?.[1];
      return { rows: [{ has: populated.includes(table) }] };
    },
  };
}
const verify = (opts) => verifyRailwayAcceptanceDatabase(fakeClient(opts), { manifestPath });

test("RA-09 server checks: an empty, fully migrated acceptance database passes", async () => {
  assert.deepEqual(await verify(), { database: A.databaseName, version: 180006, ledger: 2, tables: 7 });
  assert.ok(await verify({ address: "10.250.3.4" }));
});

test("RA-10 server checks: wrong database, old server, loopback or public address are refused", async () => {
  await assert.rejects(verify({ db: "dinar_staging" }), /not jassimai_acceptance/);
  await assert.rejects(verify({ version: 160004 }), /PostgreSQL 18/);
  for (const address of ["127.0.0.1", "::1", "34.90.1.2", null]) await assert.rejects(verify({ address }), /private Railway address/);
});

test("RA-11 server checks: a missing, extra or tampered migration ledger is refused", async () => {
  await assert.rejects(verify({ ledger: [manifest[0].sha256] }), /migration ledger/);
  await assert.rejects(verify({ ledger: [...manifest.map((m) => m.sha256), "c".repeat(64)] }), /migration ledger/);
  await assert.rejects(verify({ ledger: [manifest[0].sha256, "f".repeat(64)] }), /migration ledger/);
});

test("RA-12 server checks: any unexpected existing data is refused (a second run cannot reseed)", async () => {
  await assert.rejects(verify({ populated: [...MIGRATION_REFERENCE_TABLES, "users"] }), /not empty \(users\)/);
  await assert.rejects(verify({ tables: ["sessions", ...MIGRATION_REFERENCE_TABLES], populated: ["sessions"] }), /not empty \(sessions\)/);
});

test("RA-13 a real loopback server named jassimai_acceptance is still refused", { skip: !process.env.DINAR_RA_LOCAL_PG }, async () => {
  const { createRequire } = await import("node:module");
  const pg = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg");
  const admin = new pg.Client({ connectionString: `${process.env.DINAR_RA_LOCAL_PG}/postgres` });
  await admin.connect();
  await admin.query("drop database if exists jassimai_acceptance");
  await admin.query("create database jassimai_acceptance");
  const client = new pg.Client({ connectionString: `${process.env.DINAR_RA_LOCAL_PG}/jassimai_acceptance` });
  await client.connect();
  try {
    await assert.rejects(verifyRailwayAcceptanceDatabase(client, { manifestPath }), /private Railway address/);
  } finally {
    await client.end();
    await admin.query("drop database jassimai_acceptance");
    await admin.end();
  }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
