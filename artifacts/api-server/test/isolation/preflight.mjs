// Fail-closed isolation preflight. Runs before every suite of an isolation session
// (test/run.mjs calls it whenever DINAR_ISOLATION_SESSION is set) and refuses to continue
// unless the process is network-isolated, carries no provider credentials, and targets
// only the PostgreSQL cluster created by this session.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const FORBIDDEN_DOMAINS = ["railway.app", "rlwy.net", "railway.internal", "replit.com", "repl.co", "replit.dev", "neon.tech", "supabase"];
const LOCATION_NAMES = /^(DATABASE_URL|.*_DATABASE_URL|PG[A-Z]*|REDIS_URL|S3_.*|OBJECT_STORAGE_S3_ENDPOINT|AI_INTEGRATIONS_OPENAI_BASE_URL|.*_BASE_URL)$/;
// Provider credentials of any kind: AI, payment, SMS, storage, VCS.
const CREDENTIAL_NAMES = /(API_KEY|_TOKEN$|ACCESS_KEY|SECRET_ACCESS|STRIPE|PAYPAL|TAP_|CHECKOUT_|MOYASAR|PAYMENT_.*(KEY|SECRET)|WEBHOOK_SECRET|TWILIO|SMS_|DEEPSEEK|OPENAI|OPENROUTER|GROQ|GEMINI|ANTHROPIC|GITHUB_)/;
// Values the session itself sets, and suite switches whose names merely mention a vendor;
// never real credentials. Exact names only, so a key can never slip through by prefix.
const ALLOWED_NAMES = new Set(["SESSION_SECRET", "BDINAR_SEED_PASSWORD", "BDINAR_DEEPSEEK_BROWSER", "BDINAR_DEEPSEEK_CHAT_ACCEPTANCE"]);

function fail(reason) {
  console.error(`ISOLATION_PREFLIGHT: FAIL — ${reason}`);
  process.exit(97);
}

function hostOf(value) {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys())
      if (["host", "hostaddr", "service", "servicefile"].includes(key.toLowerCase())) return `query:${key}`;
    return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return value.toLowerCase();
  }
}

export async function runIsolationPreflight(env = process.env) {
  const nonce = env.DINAR_ISOLATION_SESSION;
  if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) fail("DINAR_ISOLATION_SESSION nonce missing; run through test/isolation/sandbox.sh.");

  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const lower = value.toLowerCase();
    if (FORBIDDEN_DOMAINS.some((domain) => lower.includes(domain))) fail(`${name} references a managed/remote domain.`);
    if (LOCATION_NAMES.test(name) && !["PGPORT", "PGUSER", "PGDATABASE", "PGDATA", "PGPASSWORD", "PGSSLMODE", "PGCONNECT_TIMEOUT"].includes(name)) {
      const host = hostOf(value);
      if (!LOOPBACK.has(host)) fail(`${name} points to a non-loopback host.`);
    }
    if (CREDENTIAL_NAMES.test(name) && !ALLOWED_NAMES.has(name)) fail(`${name} (provider credential) is present in the test environment.`);
  }
  if (env.PGHOSTADDR || env.PGSERVICE || env.PGSERVICEFILE) fail("libpq host overrides are not allowed.");
  if (env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT !== undefined || env.REPLIT_DEPLOYMENT !== undefined) fail("deployment environment markers present.");

  // Network: only the loopback interface may exist, and an outbound connect must fail.
  const interfaces = readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).map((line) => line.split(":")[0].trim()).filter(Boolean);
  // Loopback plus the sandbox's address-only sit0 (so Chromium reports navigator.onLine).
  // No IPv4 route may exist, and both address families must be unreachable.
  const up = interfaces.filter((name) => (Number.parseInt(readFileSync(`/sys/class/net/${name}/flags`, "utf8"), 16) & 1) === 1);
  if (up.some((name) => name !== "lo" && name !== "sit0")) fail(`unexpected interfaces up: ${up.join(",")}.`);
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  if (routes.length) fail(`IPv4 routes exist in the namespace (${routes.length}).`);
  // The probe runs without the net-guard preload so it measures the namespace itself.
  const probe = (target) => execFileSync(process.execPath, ["-e", `const s=require("net").connect({host:"${target}",port:443,timeout:1500});s.on("connect",()=>{console.log("REACHABLE");process.exit(0)});s.on("timeout",()=>{console.log("REACHABLE");process.exit(0)});s.on("error",e=>{console.log(e.code);process.exit(0)})`], { encoding: "utf8", env: { PATH: env.PATH } }).trim();
  const outcome = probe("1.1.1.1");
  if (outcome !== "ENETUNREACH") fail(`outbound IPv4 probe returned ${outcome}; expected ENETUNREACH.`);
  const outcome6 = probe("2606:4700:4700::1111");
  if (!["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(outcome6)) fail(`outbound IPv6 probe returned ${outcome6}.`);

  // Database: the cluster on PGHOST:PGPORT must hold this session's sentinel.
  const { PGHOST: host, PGPORT: port, PGUSER: user } = env;
  if (!LOOPBACK.has(host ?? "")) fail("PGHOST must be loopback.");
  let sentinel;
  try {
    sentinel = execFileSync("psql", ["-h", host, "-p", port, "-U", user, "-d", "dinar_isolation_sentinel", "-Atqc", "select nonce || '|' || data_dir from isolation_sentinel"], { encoding: "utf8", env: { PATH: env.PATH }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    fail("session sentinel database is missing on the target cluster.");
  }
  const [foundNonce, dataDir] = sentinel.split("|");
  if (foundNonce !== nonce) fail("target cluster was not created by this session (sentinel mismatch).");
  const liveDir = execFileSync("psql", ["-h", host, "-p", port, "-U", user, "-d", "dinar_isolation_sentinel", "-Atqc", "show data_directory"], { encoding: "utf8", env: { PATH: env.PATH } }).trim();
  if (liveDir !== dataDir || liveDir !== env.DINAR_ISOLATION_PGDATA) fail("target cluster data directory does not match the session cluster.");

  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    if (!LOOPBACK.has(url.hostname) || String(url.port || "5432") !== String(port)) fail("DATABASE_URL is not on the session cluster.");
  }
  return { ok: true, interfacesUp: up, ipv4Routes: 0, port, outbound: outcome, outbound6: outcome6 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runIsolationPreflight();
  console.log(`ISOLATION_PREFLIGHT: PASS ${JSON.stringify(result)}`);
}
