import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateAcceptanceDatabase } from "./acceptance-database-guard.mjs";

const local = "postgres://tester:unused@127.0.0.1/dinar_acceptance_wave5";
const envFor = (overrides = {}) => ({
  NODE_ENV: "development",
  BDINAR_DISPOSABLE_ACCEPTANCE_DB: "1",
  DINAR_DEV_DATABASE_URL: local,
  ...overrides,
});

test("accepts an explicit loopback disposable acceptance database", () => {
  assert.deepEqual(validateAcceptanceDatabase(envFor()), {
    host: "127.0.0.1",
    databaseName: "dinar_acceptance_wave5",
  });
  assert.equal(
    validateAcceptanceDatabase(
      envFor({ DINAR_DEV_DATABASE_URL: "postgres://u:p@[::1]/dinar_test_run_1" }),
    ).host,
    "::1",
  );
});

test("requires the explicit disposable acceptance flag", () => {
  assert.throws(
    () => validateAcceptanceDatabase(envFor({ BDINAR_DISPOSABLE_ACCEPTANCE_DB: undefined })),
    /BDINAR_DISPOSABLE_ACCEPTANCE_DB=1 is required/,
  );
});

test("validates the actual development resolver result, not DATABASE_URL", () => {
  assert.throws(
    () =>
      validateAcceptanceDatabase(
        envFor({
          DATABASE_URL: local,
          DINAR_DEV_DATABASE_URL: "postgres://u:p@postgres.railway.internal/dinar_acceptance_wave5",
        }),
      ),
    /resolved database host must be/,
  );
});

test("rejects Railway, production-like, and arbitrary remote hosts", () => {
  for (const host of [
    "postgres.railway.internal",
    "db.production.example",
    "203.0.113.18",
  ]) {
    assert.throws(
      () =>
        validateAcceptanceDatabase(
          envFor({ DINAR_DEV_DATABASE_URL: `postgres://u:p@${host}/dinar_acceptance_wave5` }),
        ),
      /resolved database host must be/,
    );
  }
});

test("rejects missing, malformed, and non-allowlisted database names", () => {
  assert.throws(
    () => validateAcceptanceDatabase(envFor({ DINAR_DEV_DATABASE_URL: undefined })),
    /resolved database target is unavailable/,
  );
  assert.throws(
    () => validateAcceptanceDatabase(envFor({ DINAR_DEV_DATABASE_URL: "not a URL" })),
    /cannot be parsed/,
  );
  assert.throws(
    () =>
      validateAcceptanceDatabase(
        envFor({ DINAR_DEV_DATABASE_URL: "postgres://u:p@localhost/development" }),
      ),
    /not on the disposable acceptance allowlist/,
  );
  assert.throws(
    () =>
      validateAcceptanceDatabase(
        envFor({
          DINAR_DEV_DATABASE_URL: "postgres://u:p@localhost/dinar_acceptance_canonical",
        }),
      ),
    /never disposable targets/,
  );
});

test("rejects URL host overrides and deployment environments", () => {
  assert.throws(
    () =>
      validateAcceptanceDatabase(
        envFor({
          DINAR_DEV_DATABASE_URL:
            "postgres://u:p@localhost/dinar_acceptance_wave5?host=remote.example",
        }),
      ),
    /host overrides and Unix-socket targets/,
  );
  assert.throws(
    () => validateAcceptanceDatabase(envFor({ REPLIT_DEPLOYMENT: "1" })),
    /deployment environments/,
  );
  assert.throws(
    () => validateAcceptanceDatabase(envFor({ RAILWAY_ENVIRONMENT: "production" })),
    /deployment environments/,
  );
});

test("runner rejects a remote resolved target before building or starting the suite", () => {
  const runner = path.resolve("test/run.mjs");
  const deniedEntry = "acceptance-guard-must-not-build.test";
  const outputPath = path.resolve(".test-build", `${deniedEntry}.mjs`);
  rmSync(outputPath, { force: true });

  const child = spawnSync(
    process.execPath,
    [runner, deniedEntry],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "development",
        BDINAR_DISPOSABLE_ACCEPTANCE_DB: "1",
        DATABASE_URL: local,
        DINAR_DEV_DATABASE_URL:
          "postgres://u:PRIVATE_VALUE@postgres.railway.internal/dinar_acceptance_wave5",
      },
      encoding: "utf8",
    },
  );
  const output = `${child.stdout}${child.stderr}`;
  assert.notEqual(child.status, 0);
  assert.match(output, /resolved database host must be/);
  assert.doesNotMatch(output, /PRIVATE_VALUE|postgres:\/\/|railway\.internal/);
  assert.equal(existsSync(outputPath), false);
});

test("isolated regression refuses to start without its explicit acceptance flag", () => {
  const child = spawnSync(
    process.execPath,
    ["test/isolated-regression.mjs", "test:blockf0"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BDINAR_DISPOSABLE_TEST_DATABASE: "1",
        DINAR_DISPOSABLE_ACCEPTANCE_DB: "",
        PGHOST: "127.0.0.1",
        PGUSER: "fixture",
      },
      encoding: "utf8",
    },
  );
  const output = `${child.stdout}${child.stderr}`;
  assert.notEqual(child.status, 0);
  assert.match(output, /explicit disposable flags/);
  assert.doesNotMatch(output, /createdb|dropdb/);
});
