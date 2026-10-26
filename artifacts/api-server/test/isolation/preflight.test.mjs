// Run inside test/isolation/sandbox.sh: proves the preflight refuses each unsafe condition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const preflight = new URL("./preflight.mjs", import.meta.url).pathname;
const run = (overrides) => spawnSync(process.execPath, [preflight], { env: { ...process.env, ...overrides }, encoding: "utf8" });

test("baseline session passes", () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
});

test("suite switches that only mention a vendor are not credentials", () => {
  const result = run({ BDINAR_DEEPSEEK_BROWSER: "1", BDINAR_DEEPSEEK_CHAT_ACCEPTANCE: "development" });
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, overrides] of [
  ["Railway database URL", { DATABASE_URL: "postgresql://u@abc.proxy.rlwy.net:5432/railway" }],
  ["Railway internal host", { DINAR_DEV_DATABASE_URL: "postgresql://u@postgres.railway.internal/db" }],
  ["Replit DB", { REPLIT_DB_URL: "https://kv.replit.com/v0/x" }],
  ["remote PGHOST", { PGHOST: "db.example.com" }],
  ["libpq host override", { DATABASE_URL: "postgresql://u@127.0.0.1:55432/x?host=evil" }],
  ["remote Redis", { REDIS_URL: "redis://cache.example.com:6379" }],
  ["remote S3 endpoint", { OBJECT_STORAGE_S3_ENDPOINT: "https://s3.amazonaws.com" }],
  ["DeepSeek key", { DINAR_DEEPSEEK_API_KEY: "sk-test" }],
  ["benchmark key", { DINAR_BENCH_DEEPSEEK_API_KEY: "sk-test" }],
  ["DeepSeek key beside the allowed switches", { BDINAR_DEEPSEEK_BROWSER: "1", DEEPSEEK_API_KEY: "sk-test" }],
  ["OpenAI key", { OPENAI_API_KEY: "sk-test" }],
  ["payment secret", { PAYMENT_PROVIDER_SECRET_KEY: "x" }],
  ["webhook secret", { DINAR_PAYMENT_WEBHOOK_SECRET: "x" }],
  ["GitHub token", { GITHUB_TOKEN: "x" }],
  ["production NODE_ENV", { NODE_ENV: "production" }],
  ["Railway marker", { RAILWAY_ENVIRONMENT: "staging" }],
  ["foreign cluster (nonce mismatch)", { DINAR_ISOLATION_SESSION: "0".repeat(32) }],
  ["missing nonce", { DINAR_ISOLATION_SESSION: "" }],
  ["wrong data directory", { DINAR_ISOLATION_PGDATA: "/var/lib/postgresql/data" }],
]) {
  test(`refuses: ${name}`, () => {
    const result = run(overrides);
    assert.equal(result.status, 97, `${name}: expected refusal, got ${result.status}\n${result.stdout}`);
    assert.match(result.stderr, /ISOLATION_PREFLIGHT: FAIL/);
  });
}
