/**
 * Explicit targeting for operator commands that write to a deployed database (release
 * migrations, first-admin bootstrap). The development database is never a target; staging and
 * production need NODE_ENV=production, a matching DINAR_DEPLOYMENT_ENV and a per-command
 * acknowledgement; "disposable" is limited to loopback test databases. Every ambiguity refuses.
 */
export type DeployedTarget = "staging" | "production" | "disposable";

export class TargetRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TargetRefusedError";
  }
}
export const refuseTarget = (code: string, message: string): never => {
  throw new TargetRefusedError(code, message);
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DISPOSABLE_DATABASE = /^dinar_(?:test|migration)_[a-z0-9_]+$/;
/** The canonical development database; a deployed environment never writes to it. */
const FORBIDDEN_HOSTS = new Set(["iriguchi.proxy.rlwy.net"]);

export interface DeployedTargetSpec {
  /** e.g. DINAR_MIGRATION — reads <prefix>_TARGET, <prefix>_ACK, <prefix>_EXPECTED_DATABASE. */
  prefix: string;
  acknowledgements: Record<"staging" | "production", string>;
}
export interface ResolvedDeployedTarget {
  target: DeployedTarget;
  connectionString: string;
  expectedDatabase: string;
}

export function resolveDeployedTarget(
  env: NodeJS.ProcessEnv,
  spec: DeployedTargetSpec,
): ResolvedDeployedTarget {
  const target = env[`${spec.prefix}_TARGET`];
  if (target !== "staging" && target !== "production" && target !== "disposable")
    refuseTarget("TARGET", `${spec.prefix}_TARGET must be staging, production or disposable.`);
  const resolved = target as DeployedTarget;
  if (env.DINAR_DEV_DATABASE_URL !== undefined)
    refuseTarget("DEV_URL_PRESENT", "A deployed-database command must not carry DINAR_DEV_DATABASE_URL.");
  if (resolved !== "disposable") {
    if (env.NODE_ENV !== "production")
      refuseTarget("NODE_ENV", "Staging and production commands require NODE_ENV=production.");
    if (env.DINAR_DEPLOYMENT_ENV !== resolved)
      refuseTarget("DEPLOYMENT_ENV", `DINAR_DEPLOYMENT_ENV must equal ${spec.prefix}_TARGET.`);
    const acknowledgement = spec.acknowledgements[resolved];
    if (env[`${spec.prefix}_ACK`] !== acknowledgement)
      refuseTarget("ACK", `${spec.prefix}_ACK=${acknowledgement} is required.`);
  }

  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) refuseTarget("DATABASE_URL", "DATABASE_URL must be set.");
  let url: URL;
  try {
    url = new URL(connectionString!);
  } catch {
    return refuseTarget("DATABASE_URL", "DATABASE_URL cannot be parsed.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    refuseTarget("DATABASE_URL", "DATABASE_URL is not a PostgreSQL URL.");
  // libpq parameters can silently redirect the connection to another host.
  if ([...url.searchParams.keys()].some((key) => ["host", "hostaddr", "service", "servicefile"].includes(key.toLowerCase())))
    refuseTarget("DATABASE_URL", "Host overrides in DATABASE_URL are not allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) refuseTarget("DATABASE_URL", "DATABASE_URL must name a host.");
  if (FORBIDDEN_HOSTS.has(host)) refuseTarget("FORBIDDEN_HOST", "The development database is never a deployed target.");
  const databaseName = decodeURIComponent(url.pathname.slice(1));

  const expectedDatabase = env[`${spec.prefix}_EXPECTED_DATABASE`]?.trim();
  if (!expectedDatabase)
    refuseTarget("EXPECTED_DATABASE", `${spec.prefix}_EXPECTED_DATABASE must name the target database.`);
  if (databaseName !== expectedDatabase)
    refuseTarget("EXPECTED_DATABASE", "DATABASE_URL does not name the expected database.");

  const loopback = LOOPBACK_HOSTS.has(host);
  if (resolved === "disposable") {
    if (!loopback || !DISPOSABLE_DATABASE.test(databaseName))
      refuseTarget("DISPOSABLE", "Disposable targets are limited to loopback dinar_test_*/dinar_migration_* databases.");
  } else if (loopback) {
    refuseTarget("LOOPBACK", "A staging or production target is never a loopback database.");
  }
  return { target: resolved, connectionString: connectionString!, expectedDatabase: expectedDatabase! };
}
