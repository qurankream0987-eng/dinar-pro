/** The operator policy command: guarded target, same validation as the admin route, effective policy. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const { pool } = await import("@workspace/db");
const { getCommercialPolicy } = await import("../src/lib/commercial-policy");
const { DEFAULT_AI_USAGE_POLICY } = await import("../src/lib/ai-usage-policy");
after(() => pool.end());

const cli = path.resolve(import.meta.dirname, "../dist/bin/apply-commercial-policy.mjs");
const databaseUrl = process.env.DINAR_DEV_DATABASE_URL!;
const databaseName = new URL(databaseUrl).pathname.slice(1);
const run = (env: Record<string, string>) => spawnSync(process.execPath, [cli], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8" });
const trial = structuredClone(DEFAULT_AI_USAGE_POLICY) as any;
trial.tiers.GUEST.requests.TEXT_REQUEST = 40;
trial.spend.global = { period: { kind: "CALENDAR_MONTH", timeZone: "UTC" }, limitMicros: 5_000_000 };
const json = JSON.stringify({ aiUsage: trial });
const disposable = { DINAR_POLICY_TARGET: "disposable", NODE_ENV: "test", DATABASE_URL: databaseUrl, DINAR_POLICY_EXPECTED_DATABASE: databaseName };

test("refuses unsafe targets and invalid policies without writing", async () => {
  assert.ok(existsSync(cli), "run `pnpm run build` first");
  const before = await getCommercialPolicy("");
  const refusals: Array<[Record<string, string>, string]> = [
    [{ DINAR_POLICY_TARGET: "staging", NODE_ENV: "production", DINAR_DEPLOYMENT_ENV: "staging", DATABASE_URL: databaseUrl, DINAR_POLICY_EXPECTED_DATABASE: databaseName, DINAR_POLICY_JSON: json }, "ACK"],
    [{ DINAR_POLICY_TARGET: "staging", NODE_ENV: "production", DINAR_DEPLOYMENT_ENV: "staging", DINAR_POLICY_ACK: "APPLY_STAGING_POLICY", DATABASE_URL: databaseUrl, DINAR_POLICY_EXPECTED_DATABASE: databaseName, DINAR_POLICY_JSON: json }, "LOOPBACK"],
    [{ ...disposable, DINAR_POLICY_EXPECTED_DATABASE: "dinar_test_other", DINAR_POLICY_JSON: json }, "EXPECTED_DATABASE"],
    [{ ...disposable }, "POLICY_JSON"],
    [{ ...disposable, DINAR_POLICY_JSON: "{" }, "POLICY_JSON"],
    [{ ...disposable, DINAR_POLICY_JSON: JSON.stringify({ aiUsage: { ...trial, unknownField: 1 } }) }, "POLICY_INVALID"],
    [{ ...disposable, DINAR_POLICY_JSON: JSON.stringify({ searchSponsoredSlots: 99 }) }, "POLICY_INVALID"],
  ];
  for (const [env, code] of refusals) {
    const result = run(env);
    assert.equal(result.status, 1, `${code}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`"code":"${code}"`), result.stderr);
  }
  assert.equal((await getCommercialPolicy("")).version, before.version);
});

test("appends a global version that becomes the effective policy", async () => {
  const before = await getCommercialPolicy("");
  const ok = run({ ...disposable, DINAR_POLICY_JSON: json });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout).commercialPolicy;
  assert.equal(out.marketId, null);
  assert.equal(out.version, before.version + 1);
  assert.ok(!ok.stdout.includes(databaseUrl) && !ok.stderr.includes(databaseUrl));
  const now = await getCommercialPolicy("JO");
  assert.equal(now.aiUsage.spend.global.limitMicros, 5_000_000);
  assert.equal(now.aiUsage.tiers.GUEST.requests.TEXT_REQUEST, 40);
  const { rows } = await pool.query("select created_by from commercial_policies where id = $1", [out.id]);
  assert.equal(rows[0].created_by, null);
});
