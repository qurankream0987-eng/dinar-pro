// The one non-loopback target the synthetic fixture seed may write to: the isolated Railway
// `acceptance` environment (owner approval, 2026-11-14). Every expected identity is pinned here in
// source, never taken from the environment; the environment only has to match it.
//
// Checks, all required:
//  - explicit opt-in: DINAR_SEED_TARGET=railway-acceptance and DINAR_SEED_ACK=SEED_SYNTHETIC_ACCEPTANCE_ONLY
//  - DINAR_DEPLOYMENT_ENV=staging (SANDBOX provider rules), NODE_ENV=development (the seed runner)
//  - Railway-injected identity: project, environment id and name, and the job's own service id
//  - the database URL: exact private host of the acceptance PostgreSQL service, exact name, no overrides
//  - no provider credential in the process (no SMS, payment, AI or e-mail key can be reached)
//  - only the fixture seed entry point may use this target
// Then, on the server itself before any write (verifyRailwayAcceptanceDatabase):
//  - current_database(), PostgreSQL 18+, a private (non-loopback, non-public) server address
//  - the migration ledger is exactly the reviewed release manifest
//  - every table is empty except the six reference tables the migrations populate
// Railway metadata itself (project, environment, service and volume ids, region) is checked by the
// operator through the Railway API immediately before the one-time run; see the execution procedure.
import { readFileSync } from "node:fs";

export const RAILWAY_ACCEPTANCE = Object.freeze({
  projectId: "3810e583-cc70-434c-b6fa-9ea15779f3c1",
  environmentId: "02ff44f4-9b4c-44ab-aaef-9c5917564db0",
  environmentName: "acceptance",
  databaseServiceId: "df6b0ea6-515f-48d6-80a4-73e529865819",
  databaseHost: "postgres-j-d.railway.internal",
  databaseName: "jassimai_acceptance",
  acknowledgement: "SEED_SYNTHETIC_ACCEPTANCE_ONLY",
  entry: "acceptance-fixtures.seed",
});

/** Tables the 66 release migrations populate themselves (measured on a fresh PostgreSQL 18). */
export const MIGRATION_REFERENCE_TABLES = Object.freeze([
  "commission_policies",
  "market_legal_intake_topics",
  "market_legal_intakes",
  "marketplace_categories",
  "markets",
  "moderation_reason_codes",
]);

const FORBIDDEN_NAME_PARTS = ["prod", "production", "staging", "canonical", "legacy", "live", "main"];
const CREDENTIAL_NAME = /(?:TWILIO|WHOP|STRIPE|OPENROUTER|OPENAI|DEEPSEEK|ANTHROPIC|GROQ|GEMINI|SENDGRID|MAILGUN|SMTP|RESEND|WHATSAPP|AWS_SECRET|SECRET_ACCESS_KEY|ACCESS_KEY_ID|OBJECT_STORAGE_S3_SECRET)/;

function refuse(reason) {
  throw new Error(`Refusing railway-acceptance seed target: ${reason}`);
}

export function isRailwayAcceptanceRequested(env = process.env) {
  return env.DINAR_SEED_TARGET !== undefined;
}

/** Synchronous identity checks; returns { host, databaseName } or throws. */
export function validateRailwayAcceptanceTarget(env = process.env, { entry } = {}) {
  if (env.DINAR_SEED_TARGET !== "railway-acceptance") refuse("DINAR_SEED_TARGET must be exactly railway-acceptance.");
  if (entry !== RAILWAY_ACCEPTANCE.entry) refuse(`only ${RAILWAY_ACCEPTANCE.entry} may use this target.`);
  if (env.DINAR_SEED_ACK !== RAILWAY_ACCEPTANCE.acknowledgement) refuse(`DINAR_SEED_ACK=${RAILWAY_ACCEPTANCE.acknowledgement} is required.`);
  if (env.DINAR_DEPLOYMENT_ENV !== "staging") refuse("DINAR_DEPLOYMENT_ENV=staging is required.");
  if (env.NODE_ENV !== "development") refuse("the fixture seed runs with NODE_ENV=development.");
  if (env.REPLIT_DEPLOYMENT !== undefined || env.REPL_ID !== undefined) refuse("Replit environments are not this target.");
  if (env.RAILWAY_PROJECT_ID !== RAILWAY_ACCEPTANCE.projectId) refuse("Railway project does not match the acceptance project.");
  if (env.RAILWAY_ENVIRONMENT_ID !== RAILWAY_ACCEPTANCE.environmentId) refuse("Railway environment id does not match acceptance.");
  if (env.RAILWAY_ENVIRONMENT_NAME !== RAILWAY_ACCEPTANCE.environmentName) refuse("Railway environment name is not acceptance.");
  if (!env.RAILWAY_SERVICE_ID || env.RAILWAY_SERVICE_ID === RAILWAY_ACCEPTANCE.databaseServiceId)
    refuse("the seed must run in its own Railway job service, not in the database service.");
  if (env.DINAR_SEED_EXPECTED_SERVICE_ID !== env.RAILWAY_SERVICE_ID)
    refuse("DINAR_SEED_EXPECTED_SERVICE_ID must name this job service (checked against Railway metadata).");
  const credentials = Object.keys(env).filter((key) => CREDENTIAL_NAME.test(key) && env[key]);
  if (credentials.length) refuse(`provider credentials must not reach the seed (${credentials.join(", ")}).`);

  const url = env.DINAR_DEV_DATABASE_URL;
  if (!url) refuse("DINAR_DEV_DATABASE_URL is required.");
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== url) refuse("DATABASE_URL and DINAR_DEV_DATABASE_URL must be the same target.");
  let target;
  try { target = new URL(url); } catch { refuse("the database URL cannot be parsed."); }
  if (!["postgres:", "postgresql:"].includes(target.protocol)) refuse("the target is not a PostgreSQL URL.");
  if ([...target.searchParams.keys()].some((key) => ["host", "hostaddr", "service", "servicefile"].includes(key.toLowerCase())))
    refuse("host overrides are not allowed.");
  const host = target.hostname.toLowerCase();
  if (host !== RAILWAY_ACCEPTANCE.databaseHost) refuse("the database host is not the acceptance PostgreSQL service.");
  if (target.port && target.port !== "5432") refuse("unexpected database port.");
  let databaseName;
  try { databaseName = decodeURIComponent(target.pathname.slice(1)); } catch { refuse("the database name cannot be parsed."); }
  if (databaseName !== RAILWAY_ACCEPTANCE.databaseName) refuse("the database name is not jassimai_acceptance.");
  if (databaseName.toLowerCase().split(/[_-]/).some((part) => FORBIDDEN_NAME_PARTS.includes(part)))
    refuse("production, staging, canonical and live databases are never targets.");
  return { host, databaseName };
}

const PRIVATE_ADDRESS = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|f[cd][0-9a-f]{2}:)/i;

/** Server-side identity and emptiness checks; run immediately before the first write. */
export async function verifyRailwayAcceptanceDatabase(client, { manifestPath }) {
  const one = async (sql) => (await client.query(sql)).rows[0];
  const identity = await one("select current_database() as db, current_setting('server_version_num')::int as version, host(inet_server_addr()) as address");
  if (identity.db !== RAILWAY_ACCEPTANCE.databaseName) refuse("the connected database is not jassimai_acceptance.");
  if (identity.version < 180000) refuse("PostgreSQL 18+ is required.");
  if (!identity.address || identity.address === "127.0.0.1" || identity.address === "::1" || !PRIVATE_ADDRESS.test(identity.address))
    refuse("the server address is not a private Railway address.");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const ledger = (await client.query("select hash from drizzle.__drizzle_migrations order by id")).rows.map((row) => row.hash);
  if (ledger.length !== manifest.length || ledger.some((hash, index) => hash !== manifest[index].sha256))
    refuse(`the migration ledger is not exactly the ${manifest.length} reviewed release migrations.`);

  const tables = (await client.query("select tablename from pg_tables where schemaname = 'public' order by tablename")).rows.map((row) => row.tablename);
  const populated = [];
  for (const table of tables) {
    if (MIGRATION_REFERENCE_TABLES.includes(table)) continue;
    const { rows } = await client.query(`select exists (select 1 from public."${table.replaceAll('"', '""')}") as has`);
    if (rows[0].has) populated.push(table);
  }
  if (populated.length) refuse(`the database is not empty (${populated.slice(0, 5).join(", ")}${populated.length > 5 ? ", …" : ""}).`);
  return { database: identity.db, version: identity.version, ledger: ledger.length, tables: tables.length };
}
