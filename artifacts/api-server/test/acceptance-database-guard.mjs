import { resolveDatabaseUrl } from "@workspace/db/database-url-resolver";
import { isRailwayAcceptanceRequested, validateRailwayAcceptanceTarget } from "./railway-acceptance-target.mjs";

const DISPOSABLE_DATABASE_NAME =
  /^dinar_(?:test|acceptance|wave[0-9]+|migration)_[a-z0-9_]+$/i;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function fail(reason) {
  throw new Error(`Refusing DB-backed acceptance run: ${reason}`);
}

export function validateAcceptanceDatabase(env = process.env, { entry } = {}) {
  if (env.BDINAR_DISPOSABLE_ACCEPTANCE_DB !== "1") {
    fail("BDINAR_DISPOSABLE_ACCEPTANCE_DB=1 is required.");
  }
  // The single non-loopback exception: the synthetic fixture seed into Railway `acceptance`.
  // It has its own, stricter checks and is refused for every other entry point.
  if (isRailwayAcceptanceRequested(env)) return validateRailwayAcceptanceTarget(env, { entry });
  if (
    env.NODE_ENV === "production" ||
    env.REPLIT_DEPLOYMENT !== undefined ||
    env.RAILWAY_ENVIRONMENT !== undefined
  ) {
    fail("deployment environments cannot run disposable acceptance suites.");
  }

  let databaseUrl;
  try {
    databaseUrl = resolveDatabaseUrl(env);
  } catch {
    fail("the application's resolved database target is unavailable.");
  }

  let target;
  try {
    target = new URL(databaseUrl);
  } catch {
    fail("the application's resolved database target cannot be parsed.");
  }

  if (!["postgres:", "postgresql:"].includes(target.protocol)) {
    fail("the resolved target is not a PostgreSQL URL.");
  }

  // libpq/node-postgres can use this parameter to override the URL hostname.
  // Reject it rather than accidentally approving a remote host hidden in query.
  if (
    [...target.searchParams.keys()].some((key) =>
      ["host", "hostaddr", "service", "servicefile"].includes(key.toLowerCase()),
    )
  ) {
    fail("host overrides and Unix-socket targets are not approved.");
  }

  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) {
    fail("the resolved database host must be localhost, 127.0.0.1, or ::1.");
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(target.pathname.slice(1));
  } catch {
    fail("the resolved database name cannot be parsed.");
  }
  if (!DISPOSABLE_DATABASE_NAME.test(databaseName)) {
    fail("the resolved database name is not on the disposable acceptance allowlist.");
  }
  if (
    databaseName
      .toLowerCase()
      .split("_")
      .some((part) =>
        ["prod", "production", "staging", "canonical", "legacy", "development"].includes(part),
      )
  ) {
    fail("production, staging, canonical, legacy, and development databases are never disposable targets.");
  }

  return { host, databaseName };
}
