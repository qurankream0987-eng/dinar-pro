// Read-only preflight and post-migration verification for the DINAR Preview database.
//
//   NODE_ENV=development node --experimental-strip-types ./scripts/preview-migration-check.mjs \
//     --phase=pre|post|unchanged --snapshot=/absolute/path/outside-repo.json [--target=preview|loopback]
//
// `pre` records a snapshot, `post` verifies a completed migration against it, and `unchanged`
// verifies that a database (after a failed run or a restore) still equals the pre-migration state.
//
// `preview` connects to DINAR_DEV_DATABASE_URL through the verified Railway TLS configuration.
// `loopback` connects to DINAR_CHECK_LOOPBACK_URL and refuses any non-loopback host; it exists for
// disposable rehearsals. Every query runs inside BEGIN READ ONLY and is rolled back. Output holds
// only counts, booleans, object names and in-database MD5 fingerprints; no row content or secret.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { verifiedDevelopmentCredentials } from "../src/development-tls.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  }),
);
const phase = args.phase;
const target = args.target ?? "preview";
const snapshotPath = args.snapshot;
if (!["pre", "post", "unchanged"].includes(phase)) throw new Error("--phase=pre|post|unchanged is required.");
const catalogPhase = phase === "post" ? "post" : "pre";
if (!["preview", "loopback"].includes(target)) throw new Error("--target=preview|loopback");
if (!snapshotPath || !path.isAbsolute(snapshotPath)) {
  throw new Error("--snapshot must be an absolute path outside the repository.");
}

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(packageDirectory, "../..");
if (path.resolve(snapshotPath).startsWith(repositoryDirectory + path.sep)) {
  throw new Error("--snapshot must not be written inside the repository.");
}
const migrationsDirectory = path.join(packageDirectory, "drizzle");

function connectionConfig() {
  if (target === "preview") {
    if (process.env.NODE_ENV !== "development") {
      throw new Error("Preview checks require NODE_ENV=development.");
    }
    return verifiedDevelopmentCredentials(process.env.DINAR_DEV_DATABASE_URL);
  }
  const value = process.env.DINAR_CHECK_LOOPBACK_URL;
  if (!value || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)) {
    throw new Error("DINAR_CHECK_LOOPBACK_URL must name a disposable loopback database.");
  }
  return { connectionString: value };
}

// Tables written by the app's background activity even during a write freeze.
const VOLATILE_TABLES = new Set(["sessions", "auth_rate_limit_buckets", "phone_verification_challenges"]);
// Tables whose rows the pending chain intentionally rewrites; verified by expectation instead.
const REWRITTEN_TABLES = new Set(["offers", "marketplace_categories"]);

// Corrected 0030: STARTING_FROM and QUOTE_REQUIRED become OPEN_TO_OFFERS and keep their meaning
// in data.priceRepresentation (a starting amount is never a binding FIXED price).
const EXPECTED_OFFER_MODE = `CASE
  WHEN pricing_mode IN ('STARTING_FROM', 'QUOTE_REQUIRED') THEN 'OPEN_TO_OFFERS'
  WHEN pricing_mode = 'FIXED' AND data->>'negotiable' = 'true' THEN 'NEGOTIABLE'
  ELSE pricing_mode END`;
const EXPECTED_OFFER_REPRESENTATION = `CASE
  WHEN pricing_mode IN ('STARTING_FROM', 'QUOTE_REQUIRED') THEN pricing_mode
  ELSE coalesce(data->>'priceRepresentation', '-') END`;
// 0029 then 0030 applied to a category default mode.
const EXPECTED_CATEGORY_DEFAULT = `CASE
  WHEN rules #>> '{pricing,defaultMode}' IS NULL THEN 'OPEN_TO_OFFERS'
  WHEN rules #>> '{pricing,defaultMode}' IN ('QUOTE_REQUIRED', 'OPEN_TO_OFFERS', 'STARTING_FROM') THEN 'OPEN_TO_OFFERS'
  WHEN rules #>> '{pricing,defaultMode}' = 'NEGOTIABLE' THEN 'NEGOTIABLE'
  ELSE 'FIXED' END`;

function fingerprint(selectRows) {
  return `SELECT count(*)::bigint AS rows, md5(coalesce(string_agg(r, '|' ORDER BY r), '')) AS md5
          FROM (${selectRows}) s(r)`;
}

async function journalEntries() {
  const journal = JSON.parse(await readFile(path.join(migrationsDirectory, "meta/_journal.json"), "utf8"));
  const entries = [];
  for (const entry of journal.entries) {
    const sql = await readFile(path.join(migrationsDirectory, `${entry.tag}.sql`), "utf8");
    entries.push({ tag: entry.tag, when: String(entry.when), hash: createHash("sha256").update(sql).digest("hex"), sql });
  }
  return entries;
}

function declaredObjects(sql) {
  const names = (pattern) => [...sql.matchAll(pattern)].map((match) => match[1]);
  return {
    tables: names(/CREATE TABLE "([a-z0-9_]+)"/g),
    indexes: names(/CREATE (?:UNIQUE )?INDEX "([a-z0-9_]+)"/g),
    functions: names(/CREATE OR REPLACE FUNCTION ([a-z0-9_]+)\(/g),
    triggers: names(/CREATE TRIGGER ([a-z0-9_]+)/g),
    columns: [...sql.matchAll(/ALTER TABLE "([a-z0-9_]+)" ADD COLUMN "([a-z0-9_]+)"/g)].map((m) => `${m[1]}.${m[2]}`),
    droppedIndexes: names(/DROP INDEX "([a-z0-9_]+)"/g),
  };
}

async function existing(client) {
  // One client runs one query at a time.
  const tables = await client.query(`SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`);
  const indexes = await client.query(`SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public'`);
  const functions = await client.query(`SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public'`);
  const triggers = await client.query(`SELECT t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND NOT t.tgisinternal`);
  const columns = await client.query(`SELECT table_name || '.' || column_name AS n FROM information_schema.columns WHERE table_schema = 'public'`);
  const set = (result) => new Set(result.rows.map((row) => row.n));
  return { tables: set(tables), indexes: set(indexes), functions: set(functions), triggers: set(triggers), columns: set(columns) };
}

async function scalar(client, sql) {
  return Number((await client.query(sql)).rows[0].n);
}

async function tableFingerprints(client, tableNames) {
  const result = {};
  for (const table of [...tableNames].sort()) {
    if (VOLATILE_TABLES.has(table) || REWRITTEN_TABLES.has(table)) continue;
    const { rows } = await client.query(fingerprint(`SELECT row_to_json(t)::text FROM "${table}" t`));
    result[table] = { rows: Number(rows[0].rows), md5: rows[0].md5 };
  }
  // Every offer column except the two the chain rewrites must be unchanged.
  const offers = await client.query(fingerprint(
    `SELECT ((to_jsonb(t) - 'pricing_mode' - 'data') || jsonb_build_object('data', t.data - 'pricingMode' - 'priceRepresentation'))::text FROM offers t`));
  result["offers (excluding pricing_mode, data.pricingMode, data.priceRepresentation)"] = { rows: Number(offers.rows[0].rows), md5: offers.rows[0].md5 };
  const categories = await client.query(fingerprint(
    `SELECT ((to_jsonb(t) - 'rules' - CASE WHEN id = 'fashion' THEN ARRAY['aliases','attributes'] ELSE ARRAY[]::text[] END)
              || jsonb_build_object('rules', rules #- '{pricing,allowedModes}' #- '{pricing,defaultMode}'))::text
       FROM marketplace_categories t`));
  result["marketplace_categories (excluding pricing rules, fashion search fields)"] = {
    rows: Number(categories.rows[0].rows), md5: categories.rows[0].md5,
  };
  return result;
}

async function rewrittenTableFingerprints(client) {
  const result = {};
  for (const table of REWRITTEN_TABLES) {
    const { rows } = await client.query(fingerprint(`SELECT row_to_json(t)::text FROM "${table}" t`));
    result[table] = { rows: Number(rows[0].rows), md5: rows[0].md5 };
  }
  return result;
}

const client = new pg.Client({ ...connectionConfig(), connectionTimeoutMillis: 15_000 });
const report = { phase, target, checkedAt: new Date().toISOString(), blockers: [], warnings: [] };
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const identity = (await client.query(`SELECT current_database() AS database, inet_server_port() AS port,
      current_setting('server_version') AS version, current_setting('transaction_read_only') AS read_only,
      coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl`)).rows[0];
  if (identity.read_only !== "on") throw new Error("Transaction is not read-only.");
  if (target === "preview" && identity.ssl !== true) throw new Error("Preview connection is not TLS.");
  report.identity = { database: identity.database, serverVersion: identity.version, tls: identity.ssl, readOnly: true };

  const entries = await journalEntries();
  const ledgerExists = await scalar(client, `SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'drizzle' AND tablename = '__drizzle_migrations'`);
  const ledger = ledgerExists
    ? (await client.query(`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`)).rows
    : [];
  const prefixMatches = ledger.every((row, index) =>
    entries[index] && row.hash === entries[index].hash && row.created_at === entries[index].when);
  const pending = entries.slice(ledger.length);
  report.ledger = {
    journalEntries: entries.length,
    appliedEntries: ledger.length,
    appliedHashesMatchJournal: prefixMatches,
    lastApplied: ledger.length ? entries[ledger.length - 1]?.tag : null,
    pending: pending.map((entry) => entry.tag),
  };
  if (!prefixMatches || ledger.length > entries.length) report.blockers.push("Ledger does not match the checked-in journal prefix.");

  const present = await existing(client);
  const objectReport = [];
  for (const entry of entries.slice(Math.min(ledger.length, 28))) {
    const declared = declaredObjects(entry.sql);
    const applied = entries.indexOf(entry) < ledger.length;
    const missing = [], unexpected = [];
    for (const kind of ["tables", "indexes", "functions", "triggers", "columns"]) {
      for (const name of declared[kind]) {
        const exists = present[kind].has(name);
        if (catalogPhase === "pre" && !applied && exists) unexpected.push(`${kind}:${name}`);
        if (catalogPhase === "post" && !exists) missing.push(`${kind}:${name}`);
      }
    }
    for (const name of declared.droppedIndexes) {
      const exists = present.indexes.has(name);
      if (catalogPhase === "pre" && !applied && !exists) missing.push(`index-to-drop:${name}`);
      if (catalogPhase === "post" && exists) unexpected.push(`dropped-index-still-present:${name}`);
    }
    objectReport.push({ tag: entry.tag, applied, missing, unexpected });
    if (missing.length || unexpected.length) report.blockers.push(`${entry.tag}: catalog state does not match the migration.`);
  }
  report.objects = objectReport;

  report.estimatedRows = Object.fromEntries((await client.query(
    `SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname`)).rows
    .map((row) => [row.relname, Number(row.n_live_tup)]));
  report.otherSessions = await scalar(client,
    `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);

  const offerModes = (await client.query(`SELECT pricing_mode, (data->>'negotiable' = 'true') AS negotiable_flag,
      (unit_price_minor IS NOT NULL) AS priced, count(*)::int AS n FROM offers GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)).rows;
  report.offerPricingModes = offerModes;

  if (phase === "pre") {
    const guards = {
      // 0029 re-adds offers_pricing_valid with legacy semantics before 0030 normalises modes.
      offersViolating0029Check: await scalar(client, `SELECT count(*) AS n FROM offers WHERE
        ((pricing_mode IN ('QUOTE_REQUIRED', 'OPEN_TO_OFFERS') AND unit_price_minor IS NULL) OR
         (pricing_mode IN ('FIXED', 'STARTING_FROM', 'NEGOTIABLE') AND unit_price_minor IS NOT NULL AND unit_price_minor >= 1)) IS FALSE`),
      offersViolating0030Check: await scalar(client, `SELECT count(*) AS n FROM (SELECT ${EXPECTED_OFFER_MODE} AS m, unit_price_minor FROM offers) o WHERE
        ((m IN ('FIXED', 'NEGOTIABLE') AND unit_price_minor IS NOT NULL AND unit_price_minor >= 1) OR
         (m = 'OPEN_TO_OFFERS' AND (unit_price_minor IS NULL OR unit_price_minor >= 1))) IS FALSE`),
      offersWithNonObjectData: await scalar(client, `SELECT count(*) AS n FROM offers WHERE data IS NULL OR jsonb_typeof(data) <> 'object'`),
      negotiationsViolating0029Check: await scalar(client, `SELECT count(*) AS n FROM negotiations WHERE
        ((listed_price_minor IS NULL OR listed_price_minor >= 1) AND (offer_amount_minor IS NULL OR offer_amount_minor >= 1)
         AND (counter_amount_minor IS NULL OR counter_amount_minor >= 1) AND quantity >= 1) IS FALSE`),
      categoriesWithNonArrayAllowedModes: await scalar(client, `SELECT count(*) AS n FROM marketplace_categories
        WHERE jsonb_typeof(rules->'pricing') = 'object' AND rules #> '{pricing,allowedModes}' IS NOT NULL
          AND jsonb_typeof(rules #> '{pricing,allowedModes}') <> 'array'`),
      fashionCategoryWithIncompatibleSearchFields: await scalar(client, `SELECT count(*) AS n FROM marketplace_categories
        WHERE id = 'fashion' AND (jsonb_typeof(aliases) IS DISTINCT FROM 'array' OR jsonb_typeof(attributes) IS DISTINCT FROM 'object')`),
      conversationsViolating0036Check: await scalar(client, `SELECT count(*) AS n FROM conversations WHERE
        ((kind = 'ORDER' AND order_id IS NOT NULL) OR (kind = 'AI' AND order_id IS NULL AND owner_user_id IS NOT NULL AND market_id IS NOT NULL)
         OR (kind = 'INQUIRY' AND order_id IS NULL AND owner_user_id IS NULL AND market_id IS NOT NULL)) IS FALSE`),
    };
    report.dataGuards = guards;
    for (const [name, count] of Object.entries(guards)) {
      if (count > 0) report.blockers.push(`${name}: ${count}`);
    }
    report.semanticChanges = {
      startingFromToOpenToOffersWithStartingPrice: await scalar(client, `SELECT count(*) AS n FROM offers WHERE pricing_mode = 'STARTING_FROM'`),
      startingFromWithNegotiableFlag: await scalar(client, `SELECT count(*) AS n FROM offers WHERE pricing_mode = 'STARTING_FROM' AND data->>'negotiable' = 'true'`),
      quoteRequiredToOpenToOffers: await scalar(client, `SELECT count(*) AS n FROM offers WHERE pricing_mode = 'QUOTE_REQUIRED'`),
      fixedNegotiableToNegotiable: await scalar(client, `SELECT count(*) AS n FROM offers WHERE pricing_mode = 'FIXED' AND data->>'negotiable' = 'true'`),
      offersWhoseDataPricingModeChanges: await scalar(client, `SELECT count(*) AS n FROM offers WHERE data->>'pricingMode' IS DISTINCT FROM ${EXPECTED_OFFER_MODE}`),
      categoriesWithPricingRules: await scalar(client, `SELECT count(*) AS n FROM marketplace_categories WHERE jsonb_typeof(rules->'pricing') = 'object'`),
      categoriesWithoutDefaultModeBecomingOpenToOffers: await scalar(client, `SELECT count(*) AS n FROM marketplace_categories WHERE jsonb_typeof(rules->'pricing') = 'object' AND rules #>> '{pricing,defaultMode}' IS NULL`),
      // Orders snapshot their own price; these only reference an offer whose mode is rewritten.
      ordersReferencingRewrittenOffers: await scalar(client, `SELECT count(DISTINCT i.order_id) AS n FROM order_items i JOIN offers f ON f.id = i.offer_id
        WHERE ${EXPECTED_OFFER_MODE.replaceAll("pricing_mode", "f.pricing_mode").replaceAll("data->>", "f.data->>")} <> f.pricing_mode`),
      activeNegotiationsOnRewrittenOffers: await scalar(client, `SELECT count(*) AS n FROM negotiations n JOIN offers f ON f.id = n.listing_id
        WHERE ${EXPECTED_OFFER_MODE.replaceAll("pricing_mode", "f.pricing_mode").replaceAll("data->>", "f.data->>")} <> f.pricing_mode`),
    };
    const expectations = {
      offerModes: (await client.query(fingerprint(`SELECT id || ':' || ${EXPECTED_OFFER_MODE} || ':' || ${EXPECTED_OFFER_REPRESENTATION} FROM offers`))).rows[0],
      categoryPricing: (await client.query(fingerprint(
        `SELECT id || ':' || ${EXPECTED_CATEGORY_DEFAULT} FROM marketplace_categories WHERE jsonb_typeof(rules->'pricing') = 'object'`))).rows[0],
    };
    const snapshot = {
      createdAt: report.checkedAt, target, ledgerEntries: ledger.length,
      fingerprints: await tableFingerprints(client, present.tables), expectations,
      rewrittenTables: await rewrittenTableFingerprints(client),
    };
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
    report.snapshot = { path: snapshotPath, tables: Object.keys(snapshot.fingerprints).length };
  } else if (phase === "unchanged") {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    if (snapshot.target !== target) report.blockers.push("Snapshot was taken against a different target.");
    if (ledger.length !== snapshot.ledgerEntries) report.blockers.push(`Ledger has ${ledger.length} entries; snapshot had ${snapshot.ledgerEntries}.`);
    const now = { ...(await tableFingerprints(client, present.tables)), ...(await rewrittenTableFingerprints(client)) };
    const before = { ...snapshot.fingerprints, ...snapshot.rewrittenTables };
    const names = [...new Set([...Object.keys(before), ...Object.keys(now)])];
    const changed = names.filter((name) => before[name]?.md5 !== now[name]?.md5 || before[name]?.rows !== now[name]?.rows);
    report.unchangedTables = { compared: names.length, changed };
    if (changed.length) report.blockers.push(`Rows differ from the pre-migration snapshot: ${changed.join(", ")}`);
  } else {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    if (snapshot.target !== target) report.blockers.push("Snapshot was taken against a different target.");
    if (ledger.length !== entries.length) report.blockers.push(`Ledger has ${ledger.length} of ${entries.length} entries.`);
    const after = await tableFingerprints(client, Object.keys(snapshot.fingerprints).filter((name) => present.tables.has(name)));
    const changed = Object.keys(snapshot.fingerprints).filter((name) =>
      !after[name] || after[name].md5 !== snapshot.fingerprints[name].md5 || after[name].rows !== snapshot.fingerprints[name].rows);
    report.preservedTables = { compared: Object.keys(snapshot.fingerprints).length, changed };
    if (changed.length) report.blockers.push(`Rows changed outside the reviewed rewrite: ${changed.join(", ")}`);
    const offerModes = (await client.query(fingerprint(`SELECT id || ':' || pricing_mode || ':' || coalesce(data->>'priceRepresentation', '-') FROM offers`))).rows[0];
    const categoryPricing = (await client.query(fingerprint(
      `SELECT id || ':' || (rules #>> '{pricing,defaultMode}') FROM marketplace_categories WHERE jsonb_typeof(rules->'pricing') = 'object'`))).rows[0];
    const checks = {
      offerModesMatchExpectation: offerModes.md5 === snapshot.expectations.offerModes.md5,
      categoryDefaultsMatchExpectation: categoryPricing.md5 === snapshot.expectations.categoryPricing.md5,
      legacyOfferModesRemaining: await scalar(client, `SELECT count(*) AS n FROM offers WHERE pricing_mode NOT IN ('FIXED', 'NEGOTIABLE', 'OPEN_TO_OFFERS')`),
      offersWithDataPricingModeMismatch: await scalar(client, `SELECT count(*) AS n FROM offers WHERE data->>'pricingMode' IS DISTINCT FROM pricing_mode`),
      categoriesWithNonCanonicalAllowedModes: await scalar(client, `SELECT count(*) AS n FROM marketplace_categories
        WHERE jsonb_typeof(rules->'pricing') = 'object' AND rules #> '{pricing,allowedModes}' <> '["FIXED", "NEGOTIABLE", "OPEN_TO_OFFERS"]'::jsonb`),
      fashionSearchFieldsPresent: await scalar(client, `SELECT count(*) AS n FROM marketplace_categories
        WHERE id = 'fashion' AND aliases ? 'جاكيت' AND attributes ? 'season' AND attributes ? 'audience'`),
      fashionCategoryRows: await scalar(client, `SELECT count(*) AS n FROM marketplace_categories WHERE id = 'fashion'`),
      notValidatedConstraints: await scalar(client, `SELECT count(*) AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace WHERE s.nspname = 'public' AND NOT c.convalidated`),
      aiUsageReservationsTable: await scalar(client, `SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_usage_reservations'`),
    };
    report.postChecks = checks;
    if (!checks.offerModesMatchExpectation) report.blockers.push("Offer pricing modes differ from the reviewed mapping.");
    if (!checks.categoryDefaultsMatchExpectation) report.blockers.push("Category default modes differ from the reviewed mapping.");
    for (const key of ["legacyOfferModesRemaining", "offersWithDataPricingModeMismatch", "categoriesWithNonCanonicalAllowedModes", "notValidatedConstraints"]) {
      if (checks[key] > 0) report.blockers.push(`${key}: ${checks[key]}`);
    }
    if (checks.fashionSearchFieldsPresent !== checks.fashionCategoryRows) report.blockers.push("Fashion search fields missing.");
    if (checks.aiUsageReservationsTable !== 1) report.blockers.push("ai_usage_reservations is missing.");
  }
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  report.blockers.push(`Check failed (${error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "CHECK_FAILED"}): ${String(error?.message ?? "").slice(0, 200)}`);
} finally {
  await client.end().catch(() => {});
}
report.verdict = report.blockers.length ? "STOP" : "PASS";
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.blockers.length ? 1 : 0;
