import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDatabaseUrl,
  resolveMigrationDatabaseUrl,
} from "@workspace/db/database-url";

test("development runtime selects the explicit canonical database override", () => {
  assert.equal(
    resolveDatabaseUrl({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://managed-legacy/database",
      DINAR_DEV_DATABASE_URL: "postgres://canonical-development/database",
    }),
    "postgres://canonical-development/database",
  );
});

test("production and test runtimes ignore the development-only override", () => {
  for (const nodeEnv of ["production", "test"]) {
    assert.equal(
      resolveDatabaseUrl({
        NODE_ENV: nodeEnv,
        DATABASE_URL: "postgres://managed/database",
        DINAR_DEV_DATABASE_URL: "postgres://canonical-development/database",
      }),
      "postgres://managed/database",
    );
  }
});

test("development runtime refuses silent fallback to the managed URL", () => {
  assert.throws(
    () => resolveDatabaseUrl({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://managed-legacy/database",
    }),
    /Refusing development runtime database fallback/,
  );
});

test("runtime requires a database URL when neither source is available", () => {
  assert.throws(
    () => resolveDatabaseUrl({ NODE_ENV: "development" }),
    /DINAR_DEV_DATABASE_URL must explicitly select/,
  );
});

test("migrations require an explicit development environment and override", () => {
  assert.equal(
    resolveMigrationDatabaseUrl({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://managed-legacy/database",
      DINAR_DEV_DATABASE_URL: "postgres://canonical-development/database",
    }),
    "postgres://canonical-development/database",
  );
  assert.throws(
    () =>
      resolveMigrationDatabaseUrl({
        NODE_ENV: "development",
        DATABASE_URL: "postgres://managed-legacy/database",
      }),
    /managed legacy DATABASE_URL is not a migration target/,
  );
  assert.throws(
    () =>
      resolveMigrationDatabaseUrl({
        NODE_ENV: "production",
        DINAR_DEV_DATABASE_URL: "postgres://canonical-development/database",
      }),
    /NODE_ENV=development/,
  );
});
