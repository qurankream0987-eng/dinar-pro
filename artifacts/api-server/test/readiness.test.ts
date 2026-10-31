import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL =
  "postgres://readiness:readiness@127.0.0.1:1/readiness_test";
process.env.DINAR_DEV_DATABASE_URL = process.env.DATABASE_URL;

const [{ default: app }, { pool }, { serializeSafeError }] = await Promise.all([
  import("../src/app"),
  import("@workspace/db"),
  import("../src/lib/logger"),
]);
const {
  assessMigrationLedger,
  parseExpectedMigrationJournal,
  readExpectedMigrationJournal,
} = await import("../src/routes/migration-readiness");

type MockablePool = {
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

const testPool = pool as unknown as MockablePool;
const originalQuery = testPool.query;
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}/api`;

let scenario:
  | "database-unavailable"
  | "ledger-unavailable"
  | "pending"
  | "current"
  | "inconsistent" = "database-unavailable";
const queries: string[] = [];
const expectedJournal = await readExpectedMigrationJournal();
const expectedApplied = expectedJournal.map((entry) => ({
  created_at: String(entry.when),
  hash: `test-hash-${entry.tag}`,
}));

testPool.query = async (sql) => {
  queries.push(sql);
  if (sql === "SELECT 1") {
    if (scenario === "database-unavailable")
      throw new Error("test database is intentionally unreachable");
    return { rows: [] };
  }
  if (scenario === "ledger-unavailable")
    throw new Error("test migration table is intentionally absent");
  return {
    rows:
      scenario === "current"
        ? expectedApplied
        : scenario === "pending"
          ? expectedApplied.slice(0, -1)
          : [
              ...expectedApplied.slice(0, -1),
              { ...expectedApplied.at(-1)!, hash: "" },
            ],
  };
};

async function request(path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Cookie: "invalid-session",
      "X-Request-Id": "client-controlled-value",
    },
  });
  return {
    response,
    body: (await response.json()) as {
      status: string;
      checks?: { database: string; migrations: string; configuration: string; phoneVerification: string };
    },
  };
}

await test("liveness is unauthenticated and independent of database access", async () => {
  queries.length = 0;
  const { response, body } = await request("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: "ok" });
  assert.equal(queries.length, 0);
  assert.ok(response.headers.get("x-request-id"));
  assert.notEqual(
    response.headers.get("x-request-id"),
    "client-controlled-value",
  );
});

await test("readiness fails closed when the database is unreachable", async () => {
  scenario = "database-unavailable";
  queries.length = 0;
  const { response, body } = await request("/readyz");
  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    status: "not_ready",
    checks: { database: "unavailable", migrations: "unchecked", configuration: "ready", phoneVerification: "ready" },
  });
  assert.deepEqual(queries, ["SELECT 1"]);
});

await test("readiness fails closed while canonical migrations are pending", async () => {
  scenario = "pending";
  const { response, body } = await request("/readyz");
  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    status: "not_ready",
    checks: { database: "ready", migrations: "pending", configuration: "ready", phoneVerification: "ready" },
  });
});

await test("readiness returns success only when the full migration journal is recorded", async () => {
  scenario = "current";
  const { response, body } = await request("/readyz");
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    status: "ready",
    checks: { database: "ready", migrations: "current", configuration: "ready", phoneVerification: "ready" },
  });
});

await test("readiness fails closed when migration metadata is unavailable", async () => {
  scenario = "ledger-unavailable";
  const { response, body } = await request("/readyz");
  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    status: "not_ready",
    checks: { database: "ready", migrations: "unavailable", configuration: "ready", phoneVerification: "ready" },
  });
});

await test("readiness fails closed when migration metadata is inconsistent", async () => {
  scenario = "inconsistent";
  const { response, body } = await request("/readyz");
  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    status: "not_ready",
    checks: { database: "ready", migrations: "unavailable", configuration: "ready", phoneVerification: "ready" },
  });
});

// G (wave 1): a deployed service with a current schema is still not ready while essential
// configuration or phone-verification delivery is missing. Values never appear in the body.
const deployed = {
  NODE_ENV: "production",
  DINAR_DEPLOYMENT_ENV: "staging",
  SESSION_SECRET: "readiness-session-secret-0123456789abcdef",
  OBJECT_STORAGE_PROVIDER: "s3",
  OBJECT_STORAGE_S3_ENDPOINT: "https://objects.example.test",
  OBJECT_STORAGE_S3_REGION: "auto",
  OBJECT_STORAGE_S3_BUCKET: "dinar-readiness",
  OBJECT_STORAGE_S3_ACCESS_KEY_ID: "READINESSKEY",
  OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "readiness-secret-value-not-real",
};
async function deployedReadiness(overrides: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys({ ...deployed, ...overrides }).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries({ ...deployed, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await request("/readyz");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

await test("deployed readiness: current schema without an SMS adapter is not ready", async () => {
  scenario = "current";
  const { response, body } = await deployedReadiness({});
  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    status: "not_ready",
    checks: { database: "ready", migrations: "current", configuration: "ready", phoneVerification: "not_configured" },
  });
});

await test("deployed readiness: each missing essential setting makes configuration invalid", async () => {
  scenario = "current";
  for (const overrides of [
    { SESSION_SECRET: undefined },
    { SESSION_SECRET: "short" },
    { DINAR_DEPLOYMENT_ENV: undefined },
    { OBJECT_STORAGE_PROVIDER: undefined },
    { OBJECT_STORAGE_PROVIDER: "replit" },
    { OBJECT_STORAGE_S3_BUCKET: undefined },
    { APP_ORIGIN: "not a url" },
    { APP_ORIGIN: "https://dinar.example/path" },
    { DINAR_WEB_DIST: "/nonexistent/web" },
  ]) {
    const { response, body } = await deployedReadiness(overrides);
    assert.equal(response.status, 503, JSON.stringify(overrides));
    assert.equal(body.checks?.configuration, "invalid", JSON.stringify(overrides));
    assert.ok(!JSON.stringify(body).includes(deployed.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY));
    assert.ok(!JSON.stringify(body).includes(deployed.SESSION_SECRET));
  }
});

await test("deployed readiness: ready only with valid configuration and a matching SMS adapter", async () => {
  scenario = "current";
  const { registerPhoneVerificationProvider, unregisterPhoneVerificationProvider } = await import("../src/lib/phone-verification");
  const adapter = { sendCode: async () => ({}) };
  const base = { family: "SMS" as const, providerKey: "readiness-sms", marketIds: ["*"] as const, create: () => adapter };
  try {
    // A LIVE registration does not serve staging, and the selection key must match.
    registerPhoneVerificationProvider({ ...base, mode: "LIVE", environments: ["production"] });
    assert.equal((await deployedReadiness({ DINAR_PHONE_VERIFICATION_PROVIDER: "readiness-sms" })).body.checks?.phoneVerification, "not_configured");
    registerPhoneVerificationProvider({ ...base, mode: "SANDBOX", environments: ["staging"] });
    assert.equal((await deployedReadiness({ DINAR_PHONE_VERIFICATION_PROVIDER: "other-sms" })).body.checks?.phoneVerification, "not_configured");
    const ready = await deployedReadiness({ DINAR_PHONE_VERIFICATION_PROVIDER: "readiness-sms", APP_ORIGIN: "https://dinar.example" });
    assert.equal(ready.response.status, 200);
    assert.deepEqual(ready.body, {
      status: "ready",
      checks: { database: "ready", migrations: "current", configuration: "ready", phoneVerification: "ready" },
    });
    // Production needs a LIVE registration and the explicit live switch.
    registerPhoneVerificationProvider({ ...base, mode: "LIVE", environments: ["production"] });
    assert.equal((await deployedReadiness({ DINAR_DEPLOYMENT_ENV: "production", DINAR_PHONE_VERIFICATION_PROVIDER: "readiness-sms" })).body.checks?.phoneVerification, "not_configured");
    assert.equal((await deployedReadiness({ DINAR_DEPLOYMENT_ENV: "production", DINAR_PHONE_VERIFICATION_PROVIDER: "readiness-sms", DINAR_LIVE_PROVIDERS_ENABLED: "true" })).response.status, 200);
  } finally {
    unregisterPhoneVerificationProvider("readiness-sms");
  }
});

await test("deployed readiness reports every failing area even when the database is down", async () => {
  scenario = "database-unavailable";
  const { response, body } = await deployedReadiness({ SESSION_SECRET: undefined });
  assert.equal(response.status, 503);
  assert.deepEqual(body.checks, { database: "unavailable", migrations: "unchecked", configuration: "invalid", phoneVerification: "not_configured" });
});

await test("migration expectation fails closed when the source journal cannot be resolved", () => {
  assert.throws(() => parseExpectedMigrationJournal(undefined));
});

await test("migration ledger assessment distinguishes current, behind, and inconsistent history", () => {
  assert.equal(assessMigrationLedger(expectedJournal, expectedApplied), "current");
  assert.equal(
    assessMigrationLedger(expectedJournal, expectedApplied.slice(0, -1)),
    "pending",
  );
  assert.equal(
    assessMigrationLedger(expectedJournal, [
      ...expectedApplied.slice(0, -1),
      { ...expectedApplied.at(-1)!, created_at: "1" },
    ]),
    "inconsistent",
  );
});

await test("readiness derives its expected head from the current migration journal", () => {
  assert.equal(expectedJournal.at(-1)?.tag, "0041_search_foundation");
  assert.equal(
    String(expectedJournal.at(-1)?.when),
    expectedApplied.at(-1)?.created_at,
  );
});

await test("readiness path contains no separate stale 0026 threshold", async () => {
  const healthSource = await readFile(
    new URL("../src/routes/health.ts", import.meta.url),
    "utf8",
  );
  assert.equal(healthSource.includes("1791414714693"), false);
  assert.equal(healthSource.includes("0026"), false);
});

await test("error serialization excludes messages, SQL, parameters, and stacks", () => {
  const error = Object.assign(new Error("private SQL and coordinates"), {
    code: "42703",
    query: "SELECT private_value",
    params: ["private-coordinate"],
    detail: "private detail",
  });
  const serialized = serializeSafeError(error);
  assert.deepEqual(serialized, { type: "Error", code: "42703" });
  assert.equal(JSON.stringify(serialized).includes("private"), false);
});

after(async () => {
  testPool.query = originalQuery;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});
