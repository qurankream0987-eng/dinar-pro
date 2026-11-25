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
  // Versioned commission policies and the append-only order financial journal; the markets
  // price CHECK is only relaxed so activation no longer depends on a legacy unit price.
  { tag: "0041_wave07_financial_journal", sha256: "4403b20eefd37d18cfe29086722946975a4765192ad5b3cc86b089ac54347cf0" },
  // Two additive cash tables with transition-guard triggers; no existing table or row changes.
  { tag: "0042_wave08_cash_engines", sha256: "44e4a812ae36f25ef2210627741e76898e02ddf58c1e5ec78abb3379798a326d" },
  // Six additive compliance tables; policies start DRAFT and no legal entity row is seeded.
  { tag: "0043_wave09_policy_consent_compliance", sha256: "29127432970d98e5a98e138ed78b9cfe781fa35a6f0366762b6ab36786b12316" },
  // Seven additive trust/support/WhatsApp tables, review and consent triggers, and five reason
  // codes; marketplace_reports_target_type_valid is only widened. WhatsApp intents stay NOT_SENT.
  { tag: "0044_wave10_trust_support_whatsapp", sha256: "edb8ca5702215790271b405cc086152fb1fb8ea3090d599008a7a828b3bb50e0" },
  // C1 search foundation: one new table, two defaulted columns on offers, indexes, pg_trgm and two
  // triggers that only mark search documents stale. No existing value changes.
  { tag: "0045_c1_sql_search", sha256: "945ccc5622390b1a6a2e9af94aaa2d9010ac8b0e164de3b90571742dc1b05a5c" },
  { tag: "0046_d1_d2_business_foundation", sha256: "5d2c6fc28d2f910528d43a3e4efb7676bf7839a1fd90a30c1c39a78d887765db" },
  // Integration: nullable offers.business_profile_id, an index and an owner/market guard trigger.
  { tag: "0047_business_listing_association", sha256: "f524e2c36c1304ef95accddf8f62c412eb2e8d08ca7f365a1f57d155aed45878" },
  // D3-A operating metadata is one-to-one with D2 identity; no parallel listing link or verification state.
  { tag: "0048_d3a_native_business_d2_link", sha256: "9beee24dbfd31cd5f58b0705348266930baf5004cdb21ee0b2cdddd833af7003" },
  { tag: "0049_d4_business_delegations", sha256: "74cabd4bd6ce17220af24c783d0522cf0c87901f91b5263503595799c2d37591" },
  // D5 adds revocable persisted employee sessions and an explicit bounded capability set.
  { tag: "0050_normal_nico_minoru", sha256: "50cc9e7ca9ec351d26df4ca0e8e0fc5d7c19d1c9e724b0735b91d0908bb121ac" },
  // D16 adds default-closed legal capability approvals and append-only incident records.
  { tag: "0051_d16_legal_readiness_incidents", sha256: "d0e8f19788d18b531a82dcb929bd747d1fb978f54cd25d029e7fd388ddac12f2" },
  { tag: "0052_d16_readiness_constraints", sha256: "e059800b4aa2f6f88171cc705cd0d955bebb8cc1b2d84274c71b9fbc34c265ff" },
  // Country intake starts unresolved for JO/KW/SA; no legal positions or active approval are seeded.
  { tag: "0053_d16_country_legal_intake", sha256: "1c74587d36ec1d2f255321023b1441bb0b2113fcde1960b045432a09d2b9ede3" },
  // D17 adds disposable per-conversation summaries plus the trigram index behind owner-scoped search.
  { tag: "0054_conversation_memory", sha256: "7112f4a23aba466fabb9dcf43ac4da6207b649c597f53cf70c168c0976e1d700" },
  // D16 makes incident records append-only after closure and requires a matching OPENED event.
  { tag: "0055_d16_incident_integrity", sha256: "88cc4b7da6a788bb27478b1fc07f0160cc536dd36d7b9d3e39e684d8e277d4bd" },
  // New orders reconcile immutable line items with the financial header; legacy rows remain untouched.
  { tag: "0056_order_line_integrity", sha256: "cf43a95bfe0d9418aa9f0d9b3fe862b8e131116299dca92be3ac5815028c234c" },
  // Connect is separate from marketplace cart, orders, dues and financial journal.
  { tag: "0057_dinar_connect", sha256: "4376a15434f865f4faf4a751df90f8a2de8dd5d1fe0d0e9b98c0ccbc637dcebd" },
  { tag: "0058_connect_projection_hardening", sha256: "3ee1e9ec70af16c93fc2da80f2acac5cde30da5d6abc9e337b932716097aa864" },
  { tag: "0059_connect_readonly_team", sha256: "f47049420d4b63b77c07c88e3866ad95f173616b3ce48aa3d8a355b426fb556d" },
  { tag: "0060_connect_participation_mode", sha256: "5691852fafdc9a2410f4cf08139d6b6207b7192043ad948c71e273d60510a0d8" },
  { tag: "0061_driver_location_sharing", sha256: "fcf438b0ebfc10daa2107e63b29846fdfa70a679552de5321a1a2f79c9102177" },
  { tag: "0062_account_identities", sha256: "a109f2fdd27eda8bd17484ab8e78080570de1df4a99076b0ef329c2eb613b071" },
  { tag: "0063_volatile_xorn", sha256: "d12c0cee16ec8444814c6f0a1ff8e17f9d47cb2b2eb192e226c0f1043911ed11" },
  // Welcome-screen ad exposures, buyer-authorised demand requests and match notices (additive).
  { tag: "0064_welcome_ads_demand_requests", sha256: "0460fd3750b97249d26102fda4543210d114977a00e6fafb09b533baa85cb23a" },
  // Phase-one 0% independent-driver commission: new agreements may snapshot rate 0 (constraint only).
  { tag: "0065_courier_commission_phase_one_zero", sha256: "1f489637f10c73b71c35dc54c6fed93bf3ab7ab92b0d011895a5cc6b0c2aea1d" },
  // Deal closure (owner-approved 2026-11-07/15): buyer-only handover code, 48 h window, audit events.
  { tag: "0066_order_handover_closure", sha256: "36326b1cf84ce67f785eaf3c744dc1af0049c2c926ec4e012ed669ee2f40917f" },
  // Staging-only Resend email notifications and email verification (owner commit 0510b41).
  { tag: "0067_curved_titania", sha256: "910cbbccbdb09815927a574b19462553b1d100df0d988bb036a7c1c06cb0e277" },
  // Monthly and annual subscription plans (owner-approved 2026-11-16): unique per plan, period, market.
  { tag: "0068_plan_period_catalog", sha256: "ee31d1126e7bf49034716c0d2b77e56e4a52b7d1aa8039307a9df4239f761aa0" },
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
