import { X509Certificate } from "node:crypto";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";

const CLONE_MODE = "railway-clone";
const ACKNOWLEDGEMENT = "I_CONFIRM_RAILWAY_CLONE_ONLY";
const EXPECTED_BASELINE_MIGRATIONS = 28;

/**
 * The migrations a clone at the 28-entry baseline will receive, each reviewed for a populated
 * database and pinned by tag and SHA-256. Adding or editing a migration fails the rehearsal until
 * it is reviewed and appended here.
 */
export const REVIEWED_PENDING_MIGRATIONS: ReadonlyArray<{ tag: string; sha256: string }> = [
  { tag: "0028_fashion_search_attributes", sha256: "7509c80c243ba5dbdff45b815d26ba6db71bdcba211becfe2ea585092b6154fe" },
  { tag: "0029_soft_radioactive_man", sha256: "66c8bd410bffe867deb0d1af6f021013e9511f0202b9d774940057d4c3eb4f29" },
  // Corrected 2026-10-24 before any persistent database applied it: STARTING_FROM and QUOTE_REQUIRED
  // become OPEN_TO_OFFERS with data.priceRepresentation instead of losing their meaning.
  { tag: "0030_swift_living_mummy", sha256: "581225f625b613ef3fb8c2193ca2a5114d0b1076040bf267292b8206fa1c09d8" },
  { tag: "0031_negotiation_events_append_only", sha256: "093c083143c8f28bfef21607611f4a4ea272487132c4f6e16545659612b87be8" },
  { tag: "0032_wave63_delivery_progress", sha256: "a3d15757a0feca5f4c331f97cf404bc1f4c323de6439b112da86be0f7ff64a2c" },
  { tag: "0033_courier_fare_assignment_history", sha256: "6ae01af6fb456baaea43ac3213e36ba8a8a7856f9edfb28b96f705cfbd87e73e" },
  { tag: "0034_tutorial_learning_history", sha256: "c837c47336cd426668742d788469162263b72636b44e8ead8316cf57da3505ac" },
  { tag: "0035_ai_usage_allowances", sha256: "f9b2dca03b02a34c8f5f174d691bcea6162fdf48ce052ed7e02c82907fb3943d" },
  { tag: "0036_marketplace_inquiries", sha256: "9e7d22add1877e972f9d37de2742a1c1d50f1aa59cd6e1c6aed7df3df69300d7" },
  // Additive tables, indexes and append-only triggers; two CHECK constraints are only widened.
  { tag: "0037_pre_integration_closure", sha256: "d5459950c67a575b7a82eaae8e71d7d8d3ed37ecf0d5e6c423d61631307f9ea5" },
  // One nullable column and its foreign key; no existing row changes.
  { tag: "0038_ai_model_price_entry", sha256: "544c0349205974e6594b958c5c4459fbd4f8ce1b3c7f1bc05314187c33ecf776" },
  // Two nullable price columns and two zero-default counters on 0037 tables; no existing row changes.
  { tag: "0039_ai_cache_write_costs", sha256: "724d67853374cafc7263933a4b51f1ff1d45560549488dc39fe22a43175649cc" },
  // One new append-only table with guard triggers; payment_events_type_valid is only widened.
  { tag: "0040_refund_obligations", sha256: "211c7db104036fc74cb08c668e9bf5b26d8f038915b1ab8232d8a79d2e20bfbb" },
  // C1 search foundation: one new table, two defaulted columns on offers, indexes, pg_trgm and two
  // triggers that only mark search documents stale. No existing value changes.
  { tag: "0041_c1_sql_search", sha256: "382b69bdee1927c544ef6496530e33d5fae5f34ed804dc39b85a98d104456fa5" },
];
export const EXPECTED_JOURNAL_ENTRIES =
  EXPECTED_BASELINE_MIGRATIONS + REVIEWED_PENDING_MIGRATIONS.length;

export interface CloneMigrationTarget {
  connectionString: string;
  proxyHost: string;
  proxyPort: number;
  serverIdentity: string;
  databaseName: string;
  databaseUser: string;
  caCertificate: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required clone setting: ${key}`);
  return value;
}

function parsePort(value: string, key: string): number {
  if (!/^\d{1,5}$/.test(value)) throw new Error(`Invalid clone setting: ${key}`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error(`Invalid clone setting: ${key}`);
  return port;
}

function parseDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid clone database URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.pathname.length <= 1 ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
    (url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "verify-full")
  ) {
    throw new Error("Clone database URL must use PostgreSQL credentials and verified TLS.");
  }
  return url;
}

function proxyEndpoint(host: string, port: number, key: string): string {
  const normalizedHost = host.toLowerCase();
  if (
    normalizedHost !== host ||
    !/^[a-z0-9.-]+\.proxy\.rlwy\.net$/.test(normalizedHost) ||
    normalizedHost.includes("..")
  ) {
    throw new Error(`Invalid Railway proxy host: ${key}`);
  }
  return `${normalizedHost}:${port}`;
}

function serviceIdentity(value: string, key: string): string {
  if (
    value !== value.toLowerCase() ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.railway\.internal$/.test(value)
  ) {
    throw new Error(`Invalid Railway service identity: ${key}`);
  }
  return value;
}

function normalizedFingerprint(value: string): string {
  const normalized = value.replaceAll(":", "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) {
    throw new Error("Invalid clone CA fingerprint.");
  }
  return normalized;
}

export function resolveCloneMigrationTarget(
  env: NodeJS.ProcessEnv = process.env,
): CloneMigrationTarget {
  if (env.NODE_ENV !== "development") {
    throw new Error("Clone migrations are allowed only in development.");
  }
  if (env.DINAR_MIGRATION_TARGET !== CLONE_MODE) {
    throw new Error("Explicit Railway clone migration mode is required.");
  }
  if (env.DINAR_CLONE_MIGRATION_ACK !== ACKNOWLEDGEMENT) {
    throw new Error("Explicit clone-only migration acknowledgement is required.");
  }

  const canonicalValue = required(env, "DINAR_DEV_DATABASE_URL");
  const canonicalUrl = parseDatabaseUrl(canonicalValue);
  const canonicalEndpoint = `${canonicalUrl.hostname.toLowerCase()}:${canonicalUrl.port}`;
  const canonicalIdentity = "postgres-57f7f853.railway.internal";

  const cloneValue = required(env, "DINAR_CLONE_DATABASE_URL");
  const cloneUrl = parseDatabaseUrl(cloneValue);
  const proxyHost = required(env, "DINAR_CLONE_PROXY_HOST");
  const proxyPort = parsePort(required(env, "DINAR_CLONE_PROXY_PORT"), "DINAR_CLONE_PROXY_PORT");
  const cloneEndpoint = proxyEndpoint(proxyHost, proxyPort, "DINAR_CLONE_PROXY_HOST");
  const serverIdentity = serviceIdentity(
    required(env, "DINAR_CLONE_SERVER_IDENTITY"),
    "DINAR_CLONE_SERVER_IDENTITY",
  );
  const databaseName = required(env, "DINAR_CLONE_DATABASE_NAME");
  const databaseUser = required(env, "DINAR_CLONE_DATABASE_USER");

  if (
    cloneUrl.hostname !== proxyHost ||
    Number(cloneUrl.port) !== proxyPort ||
    decodeURIComponent(cloneUrl.pathname.slice(1)) !== databaseName ||
    decodeURIComponent(cloneUrl.username) !== databaseUser
  ) {
    throw new Error("Clone URL does not match the approved endpoint, database, and user.");
  }

  const productionHost = required(env, "DINAR_PRODUCTION_PROXY_HOST");
  const productionPort = parsePort(
    required(env, "DINAR_PRODUCTION_PROXY_PORT"),
    "DINAR_PRODUCTION_PROXY_PORT",
  );
  const productionEndpoint = proxyEndpoint(
    productionHost,
    productionPort,
    "DINAR_PRODUCTION_PROXY_HOST",
  );
  const productionIdentity = serviceIdentity(
    required(env, "DINAR_PRODUCTION_SERVER_IDENTITY"),
    "DINAR_PRODUCTION_SERVER_IDENTITY",
  );

  if (
    cloneEndpoint === canonicalEndpoint ||
    cloneEndpoint === productionEndpoint ||
    serverIdentity === canonicalIdentity ||
    serverIdentity === productionIdentity
  ) {
    throw new Error("Canonical development and production targets are forbidden.");
  }
  if (productionEndpoint === canonicalEndpoint || productionIdentity === canonicalIdentity) {
    throw new Error("Canonical and production denylist settings are ambiguous.");
  }

  if (env.DATABASE_URL) {
    const legacyEndpoint = parseDatabaseUrl(env.DATABASE_URL);
    if (`${legacyEndpoint.hostname.toLowerCase()}:${legacyEndpoint.port}` === cloneEndpoint) {
      throw new Error("Clone endpoint matches the workspace database URL.");
    }
  }

  const caCertificate = required(env, "DINAR_CLONE_CA_CERT");
  const expectedFingerprint = normalizedFingerprint(
    required(env, "DINAR_CLONE_CA_FINGERPRINT_SHA256"),
  );
  let actualFingerprint: string;
  try {
    actualFingerprint = normalizedFingerprint(
      new X509Certificate(caCertificate).fingerprint256,
    );
  } catch {
    throw new Error("Clone CA certificate is invalid.");
  }
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error("Clone CA fingerprint does not match the independently pinned value.");
  }

  return {
    connectionString: cloneValue,
    proxyHost,
    proxyPort,
    serverIdentity,
    databaseName,
    databaseUser,
    caCertificate,
  };
}

export function verifiedCloneDatabaseCredentials(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const target = resolveCloneMigrationTarget(env);
  if (connectionString !== target.connectionString) {
    throw new Error("Clone connection does not match the approved clone target.");
  }
  const url = parseDatabaseUrl(connectionString);
  const ssl: ConnectionOptions = {
    ca: target.caCertificate,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    checkServerIdentity: (_proxyHostname, certificate) =>
      checkServerIdentity(target.serverIdentity, certificate),
  };
  return {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl,
  };
}

export function assertCloneDatabaseIdentity(
  identity: {
    databaseName: string;
    databaseUser: string;
    serverPort: number;
    ssl: boolean;
    readOnly: boolean;
  },
  target: Pick<CloneMigrationTarget, "databaseName" | "databaseUser">,
): void {
  if (
    identity.databaseName !== target.databaseName ||
    identity.databaseUser !== target.databaseUser ||
    identity.serverPort !== 5432 ||
    identity.ssl !== true ||
    identity.readOnly !== true
  ) {
    throw new Error("Connected database failed the read-only clone identity check.");
  }
}

export function assertCloneMigrationBaseline(
  rows: Array<{ hash: string; created_at: string }>,
  expected: Array<{ hash: string; when: number }>,
): void {
  if (
    rows.length !== EXPECTED_BASELINE_MIGRATIONS ||
    expected.length !== EXPECTED_BASELINE_MIGRATIONS
  ) {
    throw new Error("Clone is not at the expected 28-migration baseline.");
  }
  for (let index = 0; index < EXPECTED_BASELINE_MIGRATIONS; index += 1) {
    if (
      rows[index].hash !== expected[index].hash ||
      rows[index].created_at !== String(expected[index].when)
    ) {
      throw new Error("Clone migration ledger does not match the checked-in baseline.");
    }
  }
}

/** Rejects a journal whose length, or any migration past the baseline, differs from the reviewed set. */
export function assertCloneMigrationJournal(
  entries: Array<{ tag: string; sha256: string }>,
): void {
  if (entries.length !== EXPECTED_JOURNAL_ENTRIES) {
    throw new Error(
      `Migration journal has ${entries.length} entries; the reviewed clone plan expects ${EXPECTED_JOURNAL_ENTRIES}.`,
    );
  }
  REVIEWED_PENDING_MIGRATIONS.forEach((reviewed, offset) => {
    const entry = entries[EXPECTED_BASELINE_MIGRATIONS + offset];
    if (entry.tag !== reviewed.tag || entry.sha256 !== reviewed.sha256) {
      throw new Error(`Migration ${reviewed.tag} differs from its reviewed version.`);
    }
  });
}
