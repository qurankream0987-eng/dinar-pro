import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import {
  businessProfiles,
  businessDelegations,
  markets,
  users,
  providerConnections,
  conversations,
  privacyConsentEvents,
} from "./index";
const created = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updated = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const minor = (name: string) => bigint(name, { mode: "number" });
export const connectPartners = pgTable(
  "connect_partners",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businessProfiles.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    status: text("status").default("DRAFT").notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("connect_partners_business_unique").on(t.businessId),
    index("connect_partners_market_status_idx").on(t.marketId, t.status),
    check(
      "connect_partners_status_valid",
      sql`${t.status} IN ('DRAFT','PENDING_REVIEW','APPROVED','REJECTED','SUSPENDED','REVOKED') AND ${t.revision}>0`,
    ),
  ],
);
export const connectSites = pgTable(
  "connect_sites",
  {
    id: text("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    hostname: text("hostname").notNull(),
    status: text("status").default("PENDING").notNull(),
    challengeDigest: text("challenge_digest").notNull(),
    challengeExpiresAt: timestamp("challenge_expires_at", {
      withTimezone: true,
    }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("connect_sites_id_partner_unique").on(t.id, t.partnerId),
    uniqueIndex("connect_sites_verified_host_unique")
      .on(t.hostname)
      .where(sql`${t.status}='VERIFIED'`),
    index("connect_sites_partner_idx").on(t.partnerId),
    check(
      "connect_sites_status_valid",
      sql`${t.status} IN ('PENDING','VERIFIED','REVOKED')`,
    ),
    check(
      "connect_sites_verification_valid",
      sql`${t.status}<>'VERIFIED' OR (${t.verifiedAt} IS NOT NULL AND ${t.validUntil}>${t.verifiedAt})`,
    ),
  ],
);
export const connectIntegrations = pgTable(
  "connect_integrations",
  {
    id: text("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    siteId: text("site_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    status: text("status").default("PENDING_REVIEW").notNull(),
    mode: text("mode").notNull(),
    endpointUrl: text("endpoint_url"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull(),
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    revision: integer("revision").default(1).notNull(),
    approvedRevision: integer("approved_revision"),
    providerConnectionId: text("provider_connection_id").references(
      () => providerConnections.id,
    ),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("connect_integrations_id_partner_unique").on(t.id, t.partnerId),
    uniqueIndex("connect_integrations_provider_unique").on(
      t.providerConnectionId,
    ),
    index("connect_integrations_partner_status_idx").on(t.partnerId, t.status),
    foreignKey({
      columns: [t.siteId, t.partnerId],
      foreignColumns: [connectSites.id, connectSites.partnerId],
      name: "connect_integrations_site_partner_fk",
    }),
    check(
      "connect_integrations_status_valid",
      sql`${t.status} IN ('PENDING_REVIEW','APPROVED','REJECTED','SUSPENDED','REVOKED') AND ${t.revision}>0 AND ${t.mode} IN ('SIMULATION_ONLY','LIVE')`,
    ),
    check(
      "connect_integrations_kind_valid",
      sql`${t.kind} IN ('WEBSITE','FEED','API','OAUTH','MCP')`,
    ),
  ],
);
export const connectOffers = pgTable(
  "connect_offers",
  {
    id: text("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    integrationId: text("integration_id").notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    categoryId: text("category_id").notNull(),
    priceMinor: minor("price_minor"),
    currencyCode: text("currency_code"),
    minorUnitScale: integer("minor_unit_scale"),
    availability: text("availability").notNull(),
    targetPath: text("target_path").notNull(),
    attributes: jsonb("attributes")
      .$type<{ label: string; value: string | null }[]>()
      .default([])
      .notNull(),
    sourceVersion: integer("source_version").notNull(),
    sourceCheckedAt: timestamp("source_checked_at", {
      withTimezone: true,
    }).notNull(),
    payloadDigest: text("payload_digest").notNull(),
    status: text("status").default("PUBLISHED").notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("connect_offers_integration_ref_unique").on(
      t.integrationId,
      t.externalId,
    ),
    uniqueIndex("connect_offers_identity_unique").on(
      t.id,
      t.partnerId,
      t.integrationId,
    ),
    index("connect_offers_partner_status_idx").on(t.partnerId, t.status),
    foreignKey({
      columns: [t.integrationId, t.partnerId],
      foreignColumns: [connectIntegrations.id, connectIntegrations.partnerId],
      name: "connect_offers_integration_partner_fk",
    }),
    check(
      "connect_offers_kind_status_valid",
      sql`${t.kind} IN ('PRODUCT','SERVICE') AND ${t.availability} IN ('AVAILABLE','UNAVAILABLE','UNKNOWN') AND ${t.status} IN ('PUBLISHED','HIDDEN') AND ${t.sourceVersion}>0`,
    ),
    check(
      "connect_offers_money_valid",
      sql`(${t.priceMinor} IS NULL AND ${t.currencyCode} IS NULL AND ${t.minorUnitScale} IS NULL) OR (${t.priceMinor} BETWEEN 0 AND 9007199254740991 AND ${t.currencyCode} ~ '^[A-Z]{3}$' AND ${t.minorUnitScale} BETWEEN 0 AND 4)`,
    ),
  ],
);
export const connectAgreements = pgTable(
  "connect_agreements",
  {
    id: text("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    version: integer("version").notNull(),
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
    termsDigest: text("terms_digest").notNull(),
    proposedBy: text("proposed_by")
      .notNull()
      .references(() => users.id),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("connect_agreements_partner_version_unique").on(
      t.partnerId,
      t.version,
    ),
    uniqueIndex("connect_agreements_id_partner_unique").on(t.id, t.partnerId),
    check(
      "connect_agreements_version_digest_valid",
      sql`${t.version}>0 AND ${t.termsDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const connectAgreementAcceptances = pgTable(
  "connect_agreement_acceptances",
  {
    agreementId: text("agreement_id")
      .primaryKey()
      .references(() => connectAgreements.id),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    acceptedBy: text("accepted_by")
      .notNull()
      .references(() => users.id),
    termsDigest: text("terms_digest").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    createdAt: created(),
  },
  (t) => [
    foreignKey({
      columns: [t.agreementId, t.partnerId],
      foreignColumns: [connectAgreements.id, connectAgreements.partnerId],
      name: "connect_acceptance_agreement_partner_fk",
    }),
  ],
);
export const connectReferrals = pgTable(
  "connect_referrals",
  {
    id: text("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    integrationId: text("integration_id").notNull(),
    offerId: text("offer_id").notNull(),
    agreementId: text("agreement_id").notNull(),
    consentEventId: text("consent_event_id")
      .notNull()
      .references(() => privacyConsentEvents.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    conversationId: text("conversation_id"),
    sourceCardId: text("source_card_id").notNull(),
    sourceResultSetId: text("source_result_set_id").notNull(),
    offerSnapshot: jsonb("offer_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("connect_referrals_id_partner_integration_unique").on(
      t.id,
      t.partnerId,
      t.integrationId,
    ),
    foreignKey({
      columns: [t.offerId, t.partnerId, t.integrationId],
      foreignColumns: [
        connectOffers.id,
        connectOffers.partnerId,
        connectOffers.integrationId,
      ],
      name: "connect_referrals_offer_scope_fk",
    }),
    foreignKey({
      columns: [t.agreementId, t.partnerId],
      foreignColumns: [connectAgreements.id, connectAgreements.partnerId],
      name: "connect_referrals_agreement_scope_fk",
    }),
    index("connect_referrals_partner_time_idx").on(t.partnerId, t.createdAt),
    check("connect_referrals_window_valid", sql`${t.expiresAt}>${t.createdAt}`),
  ],
);
export const connectTransactions = pgTable(
  "connect_transactions",
  {
    id: text("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    integrationId: text("integration_id").notNull(),
    externalId: text("external_id").notNull(),
    referralId: text("referral_id").notNull(),
    agreementId: text("agreement_id").notNull(),
    currencyCode: text("currency_code").notNull(),
    grossMinor: minor("gross_minor").notNull(),
    eligibleMinor: minor("eligible_minor").notNull(),
    commissionCeilingMinor: minor("commission_ceiling_minor").notNull(),
    refundedMinor: minor("refunded_minor").default(0).notNull(),
    itemsSnapshot: jsonb("items_snapshot")
      .$type<Record<string, unknown>[]>()
      .notNull(),
    state: text("state").notNull(),
    disputeFromState: text("dispute_from_state"),
    lastSequence: integer("last_sequence").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    mode: text("mode").notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("connect_transactions_external_unique").on(
      t.integrationId,
      t.externalId,
    ),
    uniqueIndex("connect_transactions_scope_unique").on(
      t.id,
      t.partnerId,
      t.integrationId,
    ),
    index("connect_transactions_partner_state_idx").on(t.partnerId, t.state),
    foreignKey({
      columns: [t.referralId, t.partnerId, t.integrationId],
      foreignColumns: [
        connectReferrals.id,
        connectReferrals.partnerId,
        connectReferrals.integrationId,
      ],
      name: "connect_transactions_referral_scope_fk",
    }),
    foreignKey({
      columns: [t.agreementId, t.partnerId],
      foreignColumns: [connectAgreements.id, connectAgreements.partnerId],
      name: "connect_transactions_agreement_scope_fk",
    }),
    check(
      "connect_transactions_money_valid",
      sql`${t.grossMinor} BETWEEN 0 AND 9007199254740991 AND ${t.eligibleMinor} BETWEEN 0 AND ${t.grossMinor} AND ${t.commissionCeilingMinor} BETWEEN 0 AND 9007199254740991 AND ${t.refundedMinor} BETWEEN 0 AND ${t.grossMinor} AND ${t.currencyCode} ~ '^[A-Z]{3}$' AND ${t.lastSequence}>0`,
    ),
    check(
      "connect_transactions_state_mode_valid",
      sql`${t.state} IN ('PENDING_VERIFICATION','VERIFIED','APPROVED','PAYABLE','SETTLED','REVERSED','DISPUTED','REJECTED') AND ${t.mode} IN ('SIMULATION_ONLY','LIVE')`,
    ),
  ],
);
export const connectExternalEvents = pgTable(
  "connect_external_events",
  {
    id: text("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    integrationId: text("integration_id")
      .notNull()
      .references(() => connectIntegrations.id),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => connectTransactions.id),
    externalEventId: text("external_event_id").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadDigest: text("payload_digest").notNull(),
    credentialPrefix: text("credential_prefix").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("connect_events_external_unique").on(
      t.integrationId,
      t.externalEventId,
    ),
    uniqueIndex("connect_events_sequence_unique").on(
      t.transactionId,
      t.sequence,
    ),
    foreignKey({
      columns: [t.transactionId, t.partnerId, t.integrationId],
      foreignColumns: [
        connectTransactions.id,
        connectTransactions.partnerId,
        connectTransactions.integrationId,
      ],
      name: "connect_events_transaction_scope_fk",
    }),
  ],
);
export const connectAuditEvents = pgTable(
  "connect_audit_events",
  {
    id: text("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => connectPartners.id),
    actorId: text("actor_id").references(() => users.id),
    actorKind: text("actor_kind").notNull(),
    action: text("action").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key"),
    requestDigest: text("request_digest"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("connect_audit_idempotency_unique").on(
      t.partnerId,
      t.actorId,
      t.idempotencyKey,
    ),
    index("connect_audit_partner_time_idx").on(t.partnerId, t.createdAt),
  ],
);
export const connectCommissionLedger = pgTable(
  "connect_commission_ledger",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => connectTransactions.id),
    sourceEventId: text("source_event_id").references(
      () => connectExternalEvents.id,
    ),
    sourceAuditId: text("source_audit_id").references(
      () => connectAuditEvents.id,
    ),
    sourceKey: text("source_key").notNull(),
    bucket: text("bucket").notNull(),
    deltaMinor: minor("delta_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    mode: text("mode").notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("connect_ledger_source_bucket_unique").on(
      t.transactionId,
      t.sourceKey,
      t.bucket,
    ),
    index("connect_ledger_transaction_idx").on(t.transactionId),
    check(
      "connect_ledger_bucket_valid",
      sql`${t.bucket} IN ('EARNED','APPROVED','PAYABLE','SIMULATED_SETTLED','RECOVERY_DUE') AND ${t.mode} IN ('SIMULATION_ONLY','LIVE') AND ${t.deltaMinor} BETWEEN -9007199254740991 AND 9007199254740991`,
    ),
    check(
      "connect_ledger_source_valid",
      sql`(${t.sourceEventId} IS NULL) <> (${t.sourceAuditId} IS NULL)`,
    ),
  ],
);
export const connectIngestionBatches = pgTable(
  "connect_ingestion_batches",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => connectIntegrations.id),
    externalBatchId: text("external_batch_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("connect_ingestion_batch_unique").on(
      t.integrationId,
      t.externalBatchId,
    ),
  ],
);
export const connectTeamPermissions = pgTable("connect_team_permissions", {
  delegationId: text("delegation_id")
    .primaryKey()
    .references(() => businessDelegations.id),
  partnerId: text("partner_id")
    .notNull()
    .references(() => connectPartners.id),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  grantedBy: text("granted_by")
    .notNull()
    .references(() => users.id),
  updatedAt: updated(),
});
export const connectSecrets = pgTable("connect_secrets", {
  id: text("id").primaryKey(),
  integrationId: text("integration_id")
    .notNull()
    .references(() => connectIntegrations.id),
  kind: text("kind").notNull(),
  ciphertext: text("ciphertext").notNull(),
  revision: integer("revision").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: created(),
});
export const connectOauthStates = pgTable(
  "connect_oauth_states",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => connectIntegrations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    stateDigest: text("state_digest").notNull(),
    verifierCiphertext: text("verifier_ciphertext").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("connect_oauth_state_unique").on(t.stateDigest)],
);
