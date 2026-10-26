import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReleaseMigrationError,
  resolveReleaseMigrationConfig,
  runReleaseMigration,
} from "../src/release-migration.ts";

// Staging/production release migrations (see src/release-migration.ts). Railway pre-deploy:
//   pnpm --filter @workspace/db run migrate:release
// with DINAR_MIGRATION_TARGET, DINAR_MIGRATION_ACK, DINAR_MIGRATION_EXPECTED_DATABASE,
// NODE_ENV=production and DINAR_DEPLOYMENT_ENV set explicitly for that environment.
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
let phase = "configuration";
try {
  const config = resolveReleaseMigrationConfig(process.env);
  phase = "plan";
  const manifest = JSON.parse(await readFile(path.join(migrationsFolder, "release-manifest.json"), "utf8"));
  phase = "migration";
  const result = await runReleaseMigration({ config, migrationsFolder, manifest });
  console.log(JSON.stringify({ releaseMigration: result }));
} catch (error) {
  const code =
    error instanceof ReleaseMigrationError
      ? error.code
      : error?.code && /^[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : "FAILED";
  // Guard messages carry no secrets; driver errors may, so only their code is printed.
  const message = error instanceof ReleaseMigrationError ? error.message : "see the database server log";
  console.error(JSON.stringify({ releaseMigration: { status: "REFUSED_OR_FAILED", phase, code, message } }));
  process.exitCode = 1;
}
