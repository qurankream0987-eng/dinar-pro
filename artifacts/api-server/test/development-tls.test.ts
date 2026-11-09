import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkServerIdentity } from "node:tls";
import test from "node:test";
import { createRequire as createDatabaseRequire } from "node:module";
import {
  developmentCa,
  verifiedDevelopmentCredentials,
} from "../../../lib/db/src/development-tls";
import {
  assertCloneDatabaseIdentity,
  assertCloneMigrationBaseline,
  assertCloneMigrationJournal,
  EXPECTED_JOURNAL_ENTRIES,
  REVIEWED_PENDING_MIGRATIONS,
  resolveCloneMigrationTarget,
  verifiedCloneDatabaseCredentials,
} from "../../../lib/db/src/clone-migration-guard";
import { resolveMigrationDatabaseUrl } from "../../../lib/db/src/database-url";

// Resolve the database driver's declared owner, not an undeclared API dependency.
const pg = createDatabaseRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg");

const fixture = "postgresql://fixture:fixture@iriguchi.proxy.rlwy.net:18992/railway";
const env = { NODE_ENV: "development", DINAR_DEV_DATABASE_URL: fixture };
const cloneFixture = "postgresql://clone:clone-password@clone.proxy.rlwy.net:21987/railway";
const cloneEnv = {
  ...env,
  DINAR_MIGRATION_TARGET: "railway-clone",
  DINAR_CLONE_MIGRATION_ACK: "I_CONFIRM_RAILWAY_CLONE_ONLY",
  DINAR_CLONE_DATABASE_URL: cloneFixture,
  DINAR_CLONE_PROXY_HOST: "clone.proxy.rlwy.net",
  DINAR_CLONE_PROXY_PORT: "21987",
  DINAR_CLONE_SERVER_IDENTITY: "postgres-clone123.railway.internal",
  DINAR_CLONE_DATABASE_NAME: "railway",
  DINAR_CLONE_DATABASE_USER: "clone",
  DINAR_PRODUCTION_PROXY_HOST: "production.proxy.rlwy.net",
  DINAR_PRODUCTION_PROXY_PORT: "21988",
  DINAR_PRODUCTION_SERVER_IDENTITY: "postgres-prod1234.railway.internal",
  DINAR_CLONE_CA_CERT: developmentCa,
  DINAR_CLONE_CA_FINGERPRINT_SHA256:
    "0C:85:91:E8:D0:F0:8F:A9:FF:06:A0:79:A9:B6:45:B3:4E:20:5B:0C:91:F7:70:44:71:56:2F:29:79:6C:1E:9E",
};

test("CA matches independently authenticated Railway fingerprint", () => {
  assert.equal(new X509Certificate(developmentCa).fingerprint256,
    "0C:85:91:E8:D0:F0:8F:A9:FF:06:A0:79:A9:B6:45:B3:4E:20:5B:0C:91:F7:70:44:71:56:2F:29:79:6C:1E:9E");
});

test("development TLS refuses production, alternate targets and downgrade options", () => {
  assert.throws(() => verifiedDevelopmentCredentials(fixture, { ...env, NODE_ENV: "production" }));
  for (const value of [
    fixture.replace("18992", "18993"),
    fixture + "?sslmode=disable",
    fixture + "?sslmode=no-verify",
    fixture + "?options=unknown",
    "invalid",
  ]) {
    assert.throws(() => verifiedDevelopmentCredentials(value, { ...env, DINAR_DEV_DATABASE_URL: value }));
  }
  const config = verifiedDevelopmentCredentials(fixture, env);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.minVersion, "TLSv1.2");
});

test("clone credentials require explicit mode, pinned endpoint, CA, and service identity", () => {
  const target = resolveCloneMigrationTarget(cloneEnv);
  const credentials = verifiedCloneDatabaseCredentials(cloneFixture, cloneEnv);
  assert.equal(target.proxyHost, "clone.proxy.rlwy.net");
  assert.equal(credentials.ssl.rejectUnauthorized, true);
  assert.equal(credentials.ssl.minVersion, "TLSv1.2");
  assert.equal(typeof credentials.ssl.checkServerIdentity, "function");

  const rejectedEnvironments = [
    { ...cloneEnv, DINAR_MIGRATION_TARGET: undefined },
    { ...cloneEnv, DINAR_CLONE_MIGRATION_ACK: undefined },
    { ...cloneEnv, DINAR_CLONE_PROXY_HOST: "unknown.proxy.rlwy.net" },
    { ...cloneEnv, DINAR_CLONE_PROXY_PORT: "18992" },
    { ...cloneEnv, DINAR_CLONE_SERVER_IDENTITY: "postgres-57f7f853.railway.internal" },
    { ...cloneEnv, DINAR_PRODUCTION_PROXY_HOST: undefined },
    { ...cloneEnv, DINAR_CLONE_CA_FINGERPRINT_SHA256: "00".repeat(32) },
  ];
  for (const rejected of rejectedEnvironments) {
    assert.throws(() => resolveCloneMigrationTarget(rejected));
  }
  assert.throws(() => resolveCloneMigrationTarget({
    ...cloneEnv,
    DINAR_CLONE_DATABASE_URL: fixture,
    DINAR_CLONE_PROXY_HOST: "iriguchi.proxy.rlwy.net",
    DINAR_CLONE_PROXY_PORT: "18992",
    DINAR_CLONE_SERVER_IDENTITY: "postgres-57f7f853.railway.internal",
    DINAR_CLONE_DATABASE_USER: "fixture",
  }));
  assert.throws(() => resolveCloneMigrationTarget({
    ...cloneEnv,
    DINAR_CLONE_DATABASE_URL:
      "postgresql://clone:clone-password@production.proxy.rlwy.net:21988/railway",
    DINAR_CLONE_PROXY_HOST: "production.proxy.rlwy.net",
    DINAR_CLONE_PROXY_PORT: "21988",
    DINAR_CLONE_SERVER_IDENTITY: "postgres-prod1234.railway.internal",
  }));
  assert.throws(() =>
    verifiedCloneDatabaseCredentials(fixture, cloneEnv),
  );
});

test("canonical migration runner never falls back when a clone target mode is set", () => {
  assert.equal(resolveMigrationDatabaseUrl(env), fixture);
  assert.throws(() =>
    resolveMigrationDatabaseUrl({
      ...env,
      DINAR_MIGRATION_TARGET: "railway-clone",
    }),
  );
  assert.throws(() =>
    resolveMigrationDatabaseUrl({
      ...env,
      DINAR_MIGRATION_TARGET: "unknown",
    }),
  );
});

test("clone preflight rejects canonical, production, and non-TLS database identities", () => {
  const target = resolveCloneMigrationTarget(cloneEnv);
  const valid = {
    databaseName: "railway",
    databaseUser: "clone",
    serverPort: 5432,
    ssl: true,
    readOnly: true,
  };
  assert.doesNotThrow(() => assertCloneDatabaseIdentity(valid, target));
  for (const invalid of [
    { ...valid, databaseName: "other" },
    { ...valid, databaseUser: "production-user" },
    { ...valid, serverPort: 18992 },
    { ...valid, ssl: false },
    { ...valid, readOnly: false },
  ]) {
    assert.throws(() => assertCloneDatabaseIdentity(invalid, target));
  }
});

test("clone migration refuses a ledger other than the exact 28-entry baseline", () => {
  const expected = Array.from({ length: 28 }, (_, index) => ({
    hash: `hash-${index}`,
    when: index + 100,
  }));
  const rows = expected.map((entry) => ({
    hash: entry.hash,
    created_at: String(entry.when),
  }));
  assert.doesNotThrow(() => assertCloneMigrationBaseline(rows, expected));
  assert.throws(() => assertCloneMigrationBaseline(rows.slice(0, 27), expected));
  const altered = rows.map((row) => ({ ...row }));
  altered[0].hash = "unexpected";
  assert.throws(() => assertCloneMigrationBaseline(altered, expected));
});

test("clone migration accepts only the reviewed journal (every entry hashed and reviewed), checked against the files on disk", () => {
  const migrations = new URL("../../../lib/db/drizzle/", import.meta.url);
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", migrations), "utf8")) as { entries: Array<{ tag: string }> };
  const entries = journal.entries.map(({ tag }) => ({
    tag,
    sha256: createHash("sha256").update(readFileSync(new URL(`${tag}.sql`, migrations))).digest("hex"),
  }));
  assert.equal(entries.length, EXPECTED_JOURNAL_ENTRIES);
  assert.equal(REVIEWED_PENDING_MIGRATIONS.at(-1)?.tag, "0062_account_identities");
  assert.doesNotThrow(() => assertCloneMigrationJournal(entries));
  assert.throws(() => assertCloneMigrationJournal(entries.slice(0, entries.length - 1)), new RegExp(`expects ${EXPECTED_JOURNAL_ENTRIES}`));
  assert.throws(() => assertCloneMigrationJournal([...entries, { tag: "9999_unreviewed", sha256: "0".repeat(64) }]), new RegExp(`expects ${EXPECTED_JOURNAL_ENTRIES}`));
  const edited = entries.map((entry) => ({ ...entry }));
  edited[37].sha256 = "f".repeat(64);
  assert.throws(() => assertCloneMigrationJournal(edited), /0037_pre_integration_closure differs/);
  const renamed = entries.map((entry) => ({ ...entry }));
  renamed[30].tag = "0030_renamed";
  assert.throws(() => assertCloneMigrationJournal(renamed), /differs from its reviewed version/);
});

test("live TLS validates chain and service identity, rejecting wrong identity and CA", {
  skip: process.env.DINAR_TLS_ACCEPTANCE !== "1",
}, async () => {
  const config = verifiedDevelopmentCredentials(process.env.DINAR_DEV_DATABASE_URL!);
  const client = new pg.Client({ ...config, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const result = await client.query("select ssl from pg_stat_ssl where pid=pg_backend_pid()");
    assert.equal(result.rows[0].ssl, true);
  } finally {
    await client.end();
  }
  for (const ssl of [
    { ...config.ssl, checkServerIdentity: (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) =>
      checkServerIdentity("wrong-service.invalid", cert) },
    { ...config.ssl, ca: [] },
  ]) {
    const rejected = new pg.Client({ ...config, ssl, connectionTimeoutMillis: 10000 });
    try {
      await assert.rejects(rejected.connect(), (error: any) =>
        ["ERR_TLS_CERT_ALTNAME_INVALID", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]
          .includes(error.code));
    } finally {
      await rejected.end().catch(() => {});
    }
  }
});
