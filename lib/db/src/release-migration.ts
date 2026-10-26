import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { type DeployedTarget, refuseTarget, resolveDeployedTarget, TargetRefusedError } from "./deployed-target.ts";

/**
 * Release migrations for staging and production. The development runner (`drizzle-kit migrate`)
 * only ever targets DINAR_DEV_DATABASE_URL; this one targets DATABASE_URL of a deployed
 * environment, and only after every check below passes:
 *
 *   configuration → the checked-in journal equals the reviewed release manifest
 *   → identity (database name, server version) → session advisory lock
 *   → the applied ledger is an exact prefix of the journal → no unreviewed destructive SQL
 *   → drizzle's own migrator (one transaction) → the ledger now equals the journal.
 *
 * Nothing is pushed from the TypeScript schema, nothing is retried, and no URL is ever logged.
 */

export type ReleaseTarget = DeployedTarget;

export const MIGRATION_LOCK_KEY = 0x44494e41_52; // "DINAR" — one release migration at a time
export const MINIMUM_SERVER_VERSION_NUM = 180000;

export { TargetRefusedError as ReleaseMigrationError };
const refuse = refuseTarget;

export interface ReleaseMigrationConfig {
  target: ReleaseTarget;
  connectionString: string;
  expectedDatabase: string;
  dryRun: boolean;
}

/** Resolves the target from an explicit, allowlisted environment. Every ambiguity refuses. */
export function resolveReleaseMigrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReleaseMigrationConfig {
  const resolved = resolveDeployedTarget(env, {
    prefix: "DINAR_MIGRATION",
    acknowledgements: { staging: "APPLY_STAGING_MIGRATIONS", production: "APPLY_PRODUCTION_MIGRATIONS" },
  });
  return { ...resolved, dryRun: env.DINAR_MIGRATION_DRY_RUN === "1" };
}

export interface ManifestEntry {
  tag: string;
  sha256: string;
  /** Present only for a migration whose destructive statements were reviewed; states why. */
  destructiveReviewed?: string;
}
export interface PlannedMigration extends ManifestEntry {
  when: number;
  sql: string;
}

/** Reads the journal and SQL, and requires both to equal the checked-in release manifest. */
export async function loadReleasePlan(migrationsFolder: string, manifest: readonly ManifestEntry[]): Promise<PlannedMigration[]> {
  const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const entries: Array<{ tag: string; when: number }> = journal.entries ?? [];
  if (entries.length !== manifest.length)
    refuse("MANIFEST", `The journal has ${entries.length} migrations; the release manifest reviews ${manifest.length}.`);
  const plan: PlannedMigration[] = [];
  for (const [index, entry] of entries.entries()) {
    const sql = await readFile(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const reviewed = manifest[index]!;
    if (entry.tag !== reviewed.tag || sha256 !== reviewed.sha256)
      refuse("MANIFEST", `Migration ${entry.tag} differs from the reviewed release manifest.`);
    if (index > 0 && entry.when <= plan[index - 1]!.when)
      refuse("MANIFEST", `Migration ${entry.tag} is not ordered after its predecessor.`);
    plan.push({ ...reviewed, when: entry.when, sql });
  }
  return plan;
}

const STATEMENT_SPLIT = /-->\s*statement-breakpoint|;/;
const DESTRUCTIVE_STATEMENT =
  /^\s*(?:DROP\s+(?:TABLE|SCHEMA|TYPE|VIEW|MATERIALIZED\s+VIEW)\b|TRUNCATE\b|DELETE\s+FROM\b)|\bDROP\s+COLUMN\b/i;

/** Statements that remove data or structure. «BEFORE TRUNCATE» triggers protect data and do not match. */
export function destructiveStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, "")
    .split(STATEMENT_SPLIT)
    .map((statement) => statement.trim())
    .filter((statement) => DESTRUCTIVE_STATEMENT.test(statement))
    .map((statement) => statement.slice(0, 80));
}

export type LedgerRow = { hash: string; created_at: string };

/** The applied ledger must be an exact prefix of the plan; anything else is a divergent database. */
export function pendingMigrations(plan: readonly PlannedMigration[], ledger: readonly LedgerRow[]): PlannedMigration[] {
  if (ledger.length > plan.length)
    refuse("LEDGER_AHEAD", `The database records ${ledger.length} migrations; this release knows ${plan.length}.`);
  ledger.forEach((row, index) => {
    const expected = plan[index]!;
    if (row.hash !== expected.sha256 || row.created_at !== String(expected.when))
      refuse("LEDGER_DIVERGENT", `Applied migration #${index + 1} does not match ${expected.tag}.`);
  });
  return plan.slice(ledger.length);
}

export interface ReleaseMigrationResult {
  target: ReleaseTarget;
  database: string;
  serverVersionNum: number;
  appliedBefore: number;
  pending: string[];
  applied: number;
  dryRun: boolean;
  status: "CURRENT" | "MIGRATED" | "PENDING_DRY_RUN";
}

async function readLedger(client: pg.Client): Promise<LedgerRow[]> {
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  if (!exists.rows[0]?.present) return [];
  const result = await client.query<LedgerRow>(
    "SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  return result.rows;
}

export async function runReleaseMigration(input: {
  config: ReleaseMigrationConfig;
  migrationsFolder: string;
  manifest: readonly ManifestEntry[];
  /** Test seam: stops after the lock is taken, to prove a second runner refuses. */
  afterLock?: () => Promise<void>;
}): Promise<ReleaseMigrationResult> {
  const { config } = input;
  // Verify the checked-in plan before any connection: an unreviewed migration never runs.
  const plan = await loadReleasePlan(input.migrationsFolder, input.manifest);
  const client = new pg.Client({ connectionString: config.connectionString, connectionTimeoutMillis: 15_000 });
  await client.connect();
  let locked = false;
  try {
    const identity = await client.query<{ database: string; version: string }>(
      "SELECT current_database() AS database, current_setting('server_version_num') AS version",
    );
    const database = identity.rows[0]!.database;
    const serverVersionNum = Number(identity.rows[0]!.version);
    if (database !== config.expectedDatabase)
      refuse("IDENTITY", "The connected database is not the expected database.");
    if (!(serverVersionNum >= MINIMUM_SERVER_VERSION_NUM))
      refuse("SERVER_VERSION", `PostgreSQL ${MINIMUM_SERVER_VERSION_NUM / 10000}+ is required.`);

    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [MIGRATION_LOCK_KEY]);
    locked = lock.rows[0]!.locked === true;
    if (!locked) refuse("LOCKED", "Another release migration holds the migration lock.");
    await input.afterLock?.();

    const appliedBefore = await readLedger(client);
    const pending = pendingMigrations(plan, appliedBefore);
    for (const migration of pending) {
      const destructive = destructiveStatements(migration.sql);
      if (destructive.length && !migration.destructiveReviewed)
        refuse("DESTRUCTIVE", `Migration ${migration.tag} contains unreviewed destructive SQL.`);
    }
    const base = {
      target: config.target,
      database,
      serverVersionNum,
      appliedBefore: appliedBefore.length,
      pending: pending.map((migration) => migration.tag),
      dryRun: config.dryRun,
    };
    if (!pending.length) return { ...base, applied: 0, status: "CURRENT" };
    if (config.dryRun) return { ...base, applied: 0, status: "PENDING_DRY_RUN" };

    await migrate(drizzle(client), { migrationsFolder: input.migrationsFolder, migrationsSchema: "drizzle" });

    const after = await readLedger(client);
    if (pendingMigrations(plan, after).length)
      refuse("INCOMPLETE", "The ledger does not match the release plan after migrating.");
    return { ...base, applied: after.length - appliedBefore.length, status: "MIGRATED" };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}
