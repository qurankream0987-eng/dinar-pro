/**
 * Builds and runs the live-model benchmark (or its guard tests) with the same bundling as
 * test/run.mjs, minus the disposable-database guard: the benchmark uses no database at all.
 *   node test/run-benchmark.mjs live-model-benchmark plan|simulate|run
 *   node test/run-benchmark.mjs live-model-benchmark.test
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const [entry, ...args] = process.argv.slice(2);
if (!["live-model-benchmark", "live-model-benchmark.test", "gemini-gateway.test", "ai-provider.test"].includes(entry ?? ""))
  throw new Error("Entry must be live-model-benchmark, live-model-benchmark.test, gemini-gateway.test, or ai-provider.test.");
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT !== undefined || process.env.RAILWAY_ENVIRONMENT !== undefined)
  throw new Error("The benchmark runner never runs in a deployment.");
mkdirSync(".test-build", { recursive: true });
await build({
  entryPoints: [`test/${entry}.ts`],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: `.test-build/${entry}.mjs`,
  external: ["pg-native", "pino", "pino-http"],
  logLevel: "warning",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
// Runtime modules resolve a database URL on import; point it at a closed loopback port so no
// benchmark or guard test can ever reach a real database.
const DEAD_DATABASE = "postgresql://benchmark@127.0.0.1:1/dinar_test_benchmark_no_database?sslmode=disable";
const env = Object.fromEntries(
  ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "DINAR_BENCHMARK_CONFIG", "DINAR_BENCHMARK_OUT", "DINAR_BENCHMARK_KEY_DIR", "DINAR_BENCHMARK_EXECUTE", "DINAR_BENCHMARK_APPROVAL_ID", "DINAR_BENCHMARK_LEDGER_DIR", "DINAR_BENCHMARK_TOKEN_BOUNDS"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(env, {
  NODE_ENV: "development",
  DATABASE_URL: DEAD_DATABASE,
  DINAR_DEV_DATABASE_URL: DEAD_DATABASE,
  DINAR_BENCHMARK_ISOLATED: "1",
});
// Only dedicated benchmark credentials may enter a live child; application/provider keys
// (including Replit integrations, production keys, Railway, storage and session secrets) do not.
if (entry === "live-model-benchmark" && args[0] === "run") {
  for (const key of ["DINAR_BENCH_OPENAI_API_KEY", "DINAR_BENCH_ANTHROPIC_API_KEY", "DINAR_BENCH_OPENROUTER_API_KEY", "DINAR_BENCH_GROQ_API_KEY", "DINAR_BENCH_GEMINI_API_KEY", "DINAR_BENCH_DEEPSEEK_API_KEY"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
}
const result = spawnSync(process.execPath, [...(entry.endsWith(".test") ? ["--test"] : []), `.test-build/${entry}.mjs`, ...args], { stdio: "inherit", env });
process.exit(result.status ?? 1);
