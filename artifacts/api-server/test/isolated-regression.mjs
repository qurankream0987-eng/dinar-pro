/**
 * Deterministic regression: every suite runs against its own fresh, migrated and seeded
 * disposable database, so fixtures from one suite never leak into another (for example
 * F0's listings into F1-08's comparables). Runtime behaviour is untouched.
 *
 * Usage (from artifacts/api-server, with a loopback PostgreSQL in PGHOST/PGPORT/PGUSER):
 *   BDINAR_DISPOSABLE_TEST_DATABASE=1 DINAR_DISPOSABLE_ACCEPTANCE_DB=1 node test/isolated-regression.mjs test:blockf0 test:blockf1 ...
 *
 * It refuses any host other than loopback, creates only dinar_test_* databases, drops
 * each one afterwards, and strips external model credentials from every suite.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { validateAcceptanceDatabase } from "./acceptance-database-guard.mjs";

const host = process.env.PGHOST ?? "";
const port = process.env.PGPORT ?? "5432";
const user = process.env.PGUSER ?? "";
if (
  process.env.BDINAR_DISPOSABLE_TEST_DATABASE !== "1" ||
  process.env.DINAR_DISPOSABLE_ACCEPTANCE_DB !== "1" ||
  !["127.0.0.1", "localhost", "::1"].includes(host) ||
  !user ||
  process.env.PGHOSTADDR ||
  process.env.PGSERVICE ||
  process.env.PGSERVICEFILE
)
  throw new Error("Isolated regression requires explicit disposable flags and a direct loopback PostgreSQL target.");
const suites = process.argv.slice(2);
if (!suites.length) throw new Error("Name at least one package script, e.g. test:blockf0.");

// Suites that gate on an explicit approval flag get it here; each is honoured only for a
// disposable loopback database (see test/safe-development-database.ts).
const baseEnv = {
  ...process.env,
  BDINAR_DISPOSABLE_TEST_DATABASE: "1",
  BDINAR_DISPOSABLE_ACCEPTANCE_DB: "1",
  BDINAR_TEST_DATABASE: "development",
  BDINAR_PHASE1_ACCEPTANCE: "development",
  BDINAR_PHASE2_ACCEPTANCE: "development",
};
for (const key of ["DATABASE_URL", "DINAR_DEV_DATABASE_URL", "PGDATABASE", "AI_INTEGRATIONS_OPENAI_API_KEY", "AI_INTEGRATIONS_OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY"]) delete baseEnv[key];
const summaryPattern = /(ACCEPTANCE_FIXTURES|BLOCK[A-Z0-9]*_SUMMARY|LOG_SCAN|ℹ (?:tests|pass|fail) )/;
const report = [];
const common = ["MARKET_FIXTURES"];
const marketplace = [...common, "USER_FIXTURES", "PRODUCT_LISTINGS", "PHASE1_LISTINGS"];
const fixtureModulesBySuite = {
  "test:blocka": marketplace,
  "test:blockb": [...common, "USER_FIXTURES", "PRODUCT_LISTINGS"],
  "test:blockc": common,
  "test:blockd": common,
  "test:blocke": marketplace,
  "test:blockf0": marketplace,
  "test:blockf1": marketplace,
  "test:blockf2": marketplace,
  "test:blockf3": marketplace,
  "test:blockf4": marketplace,
  "test:blockf5": marketplace,
  "test:g1": marketplace,
  "test:g2": marketplace,
  "test:universal-negotiation": marketplace,
  "test:g3": common,
  "test:contact": common,
  "test:gfinal": marketplace,
  "test:wave3": common,
  "test:wave4": common,
  "test:ucc": common,
  "test:xp": common,
  "test:api": marketplace,
  "test:security": common,
  "test:closure": common,
  test: marketplace,
};
// Suites without a package script run by file name: «file:nl-commerce-microclosure.test».
// They get every acceptance approval flag, honoured only for this disposable database.
const FILE_SUITE_FLAGS = Object.fromEntries(
  ["G1", "G2", "G3", "BLOCKF", "WAVE4", "XP", "UCC", "GFINAL"].map((gate) => [`BDINAR_${gate}_ACCEPTANCE`, "development"]),
);

for (const script of suites) {
  const fileSuite = script.startsWith("file:") ? script.slice(5) : undefined;
  if (fileSuite !== undefined && !/^[a-z0-9-]+\.test$/.test(fileSuite)) throw new Error(`Invalid file suite ${script}.`);
  const modules = fileSuite ? marketplace : fixtureModulesBySuite[script];
  if (!modules) throw new Error(`No explicit acceptance fixture module mapping for ${script}.`);
  // dinar_test_<suite>_<random>: some suites assert their own database name.
  const suite = script.replace(/^(?:test:?|file:)/, "").replace(/\.test$/, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase() || "core";
  const name = `dinar_test_${suite}_${randomBytes(3).toString("hex")}`;
  const url = `postgresql://${user}@${host}:${port}/${name}?sslmode=disable`;
  const env = {
    ...baseEnv,
    NODE_ENV: "development",
    PGDATABASE: name,
    DATABASE_URL: url,
    DINAR_DEV_DATABASE_URL: url,
  };
  const validatedTarget = validateAcceptanceDatabase(env);
  if (validatedTarget.host !== host || validatedTarget.databaseName !== name)
    throw new Error("Isolated regression target does not match the validated loopback database.");
  const started = Date.now();
  let status = 1;
  let tail = "";
  try {
    execFileSync("createdb", [name], { env, stdio: "ignore" });
    execFileSync("pnpm", ["--filter", "@workspace/db", "run", "migrate"], { cwd: "../..", env, stdio: "ignore" });
    const fixtureSetup = spawnSync(process.execPath, ["test/run.mjs", "acceptance-fixtures.seed"], {
      env: {
        ...env,
        BDINAR_ACCEPTANCE_FIXTURES: "development",
        BDINAR_ACCEPTANCE_FIXTURE_MODULES: modules.join(","),
        BDINAR_SEED_PASSWORD: `fixture-${randomBytes(16).toString("hex")}`,
      },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    let output = `${fixtureSetup.stdout ?? ""}\n${fixtureSetup.stderr ?? ""}`;
    if (fixtureSetup.status === 0) {
      let prerequisiteStatus = 0;
      if (script === "test:blocke") {
        const legacyFixture = spawnSync(process.execPath, ["test/run.mjs", "seed"], {
          env: {
            ...env,
            BDINAR_SEED: "development",
            BDINAR_SEED_PASSWORD: `fixture-${randomBytes(16).toString("hex")}`,
          },
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
        });
        prerequisiteStatus = legacyFixture.status ?? 1;
        output += `\n${legacyFixture.stdout}\n${legacyFixture.stderr}`;
      }
      if (prerequisiteStatus === 0) {
        const run = fileSuite
          ? spawnSync(process.execPath, ["test/run.mjs", fileSuite], { env: { ...env, ...FILE_SUITE_FLAGS, BDINAR_PROMOTIONS_ENABLED: "true" }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
          : spawnSync("pnpm", ["run", script], { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
        status = run.status ?? 1;
        output += `\n${run.stdout}\n${run.stderr}`;
      } else {
        status = prerequisiteStatus;
      }
    } else {
      status = fixtureSetup.status ?? 1;
    }
    writeFileSync(`.test-build/isolated-${script.replace(/[^a-z0-9]+/gi, "_")}.log`, output);
    tail = output.split("\n").filter((line) => summaryPattern.test(line)).map((line) => line.slice(0, 400)).join("\n");
  } finally {
    spawnSync("dropdb", ["--if-exists", name], { env, stdio: "ignore" });
  }
  const row = { script, status, seconds: Math.round((Date.now() - started) / 1000), tail };
  report.push(row);
  console.log(`ISOLATED ${script} exit=${status} ${row.seconds}s\n${tail}`);
}
console.log("ISOLATED_SUMMARY", JSON.stringify(report.map(({ script, status, seconds }) => ({ script, status, seconds }))));
process.exitCode = report.some((row) => row.status !== 0) ? 1 : 0;
