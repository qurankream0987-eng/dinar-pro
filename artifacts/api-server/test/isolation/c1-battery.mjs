// Full sequential inventory; each suite gets a fresh loopback DB and net-guard.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const suites = readdirSync("test").filter(name => name.endsWith(".test.ts")).map(name => name.slice(0, -3)).sort();
const scripts = Object.values(JSON.parse(readFileSync("package.json", "utf8")).scripts);
const flags = [...new Set(scripts.flatMap(script => [...script.matchAll(/(BDINAR_[A-Z0-9_]+)=(development|true)/g)].map(match => match[0])))];
const logs = resolve("c1-evidence");
mkdirSync(logs, { recursive: true });
const results = [];
for (const suite of suites) {
  const started = Date.now();
  const env = { ...process.env, DINAR_SUITE_SEED: "fixtures" };
  const extra = [...flags];
  if (["admin-bootstrap.test", "readiness.test", "ai-authority-boundary.test", "fresh-environment.test"].includes(suite)) env.DINAR_SUITE_SEED = "none";
  if (["pre-switch.test", "phase2-commission-acceptance.test"].includes(suite)) env.DINAR_SUITE_SEED = "development";
  if (suite === "fresh-environment.test") env.DINAR_SUITE_DB = "dinar_test_fresh_c1";
  if (suite === "listing-pricing-invariants.test") env.DINAR_SUITE_DB = "dinar_test_blockb_c1";
  if (suite === "listing-image-publication-acceptance.test") {
    env.DINAR_SUITE_DB = "dinar_test_image_review_c1";
    extra.push("BDINAR_IMAGE_PUBLICATION_ACCEPTANCE=disposable");
  }
  if (scripts.some(script => script.includes(suite) && script.includes("BDINAR_LOG_SCAN=1"))) extra.push("BDINAR_LOG_SCAN=1");
  let command = ["sh", "test/isolation/local-suite.sh", suite, ...extra];
  const temporary = [];
  if (suite === "personal-intelligence.test") {
    const seed = "test/c1-personal-seed.test.ts";
    writeFileSync(seed, 'import { pool } from "@workspace/db"; await pool.end();\n');
    const setup = spawnSync("sh", ["test/isolation/local-suite.sh", "c1-personal-seed.test", ...flags], {
      env: { ...env, DINAR_LOCAL_PG: "postgres://dinar_isolation@127.0.0.1:55479", DINAR_SUITE_DB: "dinar_test_c1_personal", DINAR_SUITE_KEEP_DB: "1" },
      encoding: "utf8", timeout: 180_000, maxBuffer: 20_000_000,
    });
    writeFileSync(`${logs}/personal-setup.log`, (setup.stdout ?? "") + (setup.stderr ?? ""));
    unlinkSync(seed);
    if (setup.status !== 0) throw new Error("personal database setup failed; see personal-setup.log");
    const wrapper = "test/c1-personal-wrapper.test.ts";
    writeFileSync(wrapper, 'process.env.DINAR_PERSONAL_TEST_DATABASE_URL="postgres://dinar_isolation@127.0.0.1:55479/dinar_test_c1_personal"; await import("./personal-intelligence.test");\n');
    temporary.push(wrapper);
    command[2] = "c1-personal-wrapper.test";
  }
  if (["storage-portability.test", "storage-s3-wire.test"].includes(suite)) {
    const build = spawnSync("pnpm", ["exec", "esbuild", `test/${suite}.ts`, "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=.test-build/${suite}.mjs`], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(build.stderr);
    const netlog = `${logs}/${suite}.netlog`;
    writeFileSync(netlog, "");
    command = ["env", "-i", `PATH=${process.env.PATH}`, `HOME=${process.env.HOME}`, "NODE_ENV=development", "BDINAR_BLOCK_MODEL_CALLS=1", `DINAR_ISOLATION_NET_LOG=${netlog}`, `NODE_OPTIONS=--import=file://${resolve("test/isolation/net-guard.mjs")}`, "node", "--test", `.test-build/${suite}.mjs`];
  }
  const run = spawnSync(command[0], command.slice(1), { env, encoding: "utf8", timeout: 1_200_000, maxBuffer: 50_000_000 });
  for (const path of temporary) unlinkSync(path);
  const output = (run.stdout ?? "") + (run.stderr ?? "") + (run.error ? String(run.error) : "");
  writeFileSync(`${logs}/${suite}.log`, output);
  let exit = run.status ?? 124;
  const netfile = `${logs}/${suite}.netlog`;
  const outbound = suite.startsWith("storage-") ? readFileSync(netfile, "utf8").trim().split("\n").filter(Boolean).length : Number(/LOCAL_SUITE .*outbound=(\d+)/.exec(output)?.[1] ?? -1);
  if (outbound !== 0 && exit === 0) exit = 98;
  const result = { suite, exit, seconds: Math.round((Date.now() - started) / 1000), outbound,
    pass: Number(/(?:ℹ|#) pass (\d+)/.exec(output)?.[1] ?? 0), fail: Number(/(?:ℹ|#) fail (\d+)/.exec(output)?.[1] ?? 0) };
  results.push(result);
  writeFileSync(`${logs}/summary.json`, JSON.stringify(results, null, 2));
  console.log("C1_BATTERY", JSON.stringify(result));
  if (exit !== 0) console.log(output.slice(-10_000));
}
console.log("C1_BATTERY_TOTAL", JSON.stringify({ suites: results.length, pass: results.filter(result => result.exit === 0).length, cases: results.reduce((sum, result) => sum + result.pass, 0) }));
process.exitCode = results.some(result => result.exit !== 0) ? 1 : 0;
