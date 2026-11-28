import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { businessProfiles, markets, users } from "./index";

/** Merchant policies (0083): validated, versioned store rules managed through Jassim. */
export const merchantPolicies = pgTable(
  "merchant_policies",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businessProfiles.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    kind: text("kind").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeRef: text("scope_ref"),
    rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
    sensitivity: text("sensitivity").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull(),
    sourceText: text("source_text"),
    version: integer("version").notNull(),
    supersedesId: text("supersedes_id").references((): AnyPgColumn => merchantPolicies.id),
    proposedBy: text("proposed_by").notNull().references(() => users.id),
    confirmedBy: text("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("merchant_policies_one_active").on(t.businessId, t.kind, t.scopeKind, sql`coalesce(${t.scopeRef}, '')`).where(sql`${t.status} = 'ACTIVE'`),
    index("merchant_policies_business_idx").on(t.businessId, t.status, t.kind),
    check("merchant_policies_kind_valid", sql`${t.kind} IN ('PAYMENT_METHODS', 'PAYMENT_GATEWAY', 'PAYOUT_DETAILS', 'SHIPPING', 'COD_AREAS', 'OUT_OF_STOCK', 'PRE_ORDER', 'ALTERNATIVES', 'MIN_ORDER', 'ORDERING_PAUSED', 'GEO_RESTRICTION', 'PRICE_NEGOTIATION', 'DISCOUNT', 'BULK_INQUIRY', 'B2B_QUESTIONS')`),
    check("merchant_policies_scope_valid", sql`${t.scopeKind} IN ('STORE', 'PRODUCT', 'CATEGORY', 'REGION') AND ((${t.scopeKind} = 'STORE') = (${t.scopeRef} IS NULL))`),
    check("merchant_policies_sensitivity_valid", sql`${t.sensitivity} IN ('NORMAL', 'SENSITIVE', 'HIGH_RISK')`),
    check("merchant_policies_status_valid", sql`${t.status} IN ('PROPOSED', 'ACTIVE', 'REPLACED', 'REVOKED', 'CANCELLED')`),
    check("merchant_policies_source_valid", sql`${t.source} IN ('CHAT', 'API')`),
    check("merchant_policies_rule_object", sql`jsonb_typeof(${t.rule}) = 'object'`),
    check("merchant_policies_version_positive", sql`${t.version} >= 1`),
    check("merchant_policies_confirmed_consistent", sql`(${t.status} NOT IN ('ACTIVE', 'REPLACED') OR (${t.confirmedBy} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL)) AND (${t.status} NOT IN ('PROPOSED', 'CANCELLED') OR ${t.confirmedAt} IS NULL)`),
  ],
);

export const MERCHANT_POLICY_SCOPES = [
  "policy.products",
  "policy.inventory",
  "policy.shipping",
  "policy.orders",
  "policy.discounts",
  "policy.negotiation",
  "policy.payment_methods",
  "policy.payment_gateway",
  "policy.payout_details",
  "policy.financial_data",
  "policy.store_pause",
] as const;

export const merchantPolicyGrants = pgTable(
  "merchant_policy_grants",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businessProfiles.id),
    granteeUserId: text("grantee_user_id").notNull().references(() => users.id),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    status: text("status").notNull(),
    grantedBy: text("granted_by").notNull().references(() => users.id),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("merchant_policy_grants_one_active").on(t.businessId, t.granteeUserId).where(sql`${t.status} = 'ACTIVE'`),
    check("merchant_policy_grants_status_valid", sql`${t.status} IN ('ACTIVE', 'REVOKED')`),
    check(
      "merchant_policy_grants_scopes_valid",
      sql`jsonb_typeof(${t.scopes}) = 'array' AND ${t.scopes} <@ '["policy.products","policy.inventory","policy.shipping","policy.orders","policy.discounts","policy.negotiation","policy.payment_methods","policy.payment_gateway","policy.payout_details","policy.financial_data","policy.store_pause"]'::jsonb`,
    ),
  ],
);

export const merchantPolicyEvents = pgTable(
  "merchant_policy_events",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businessProfiles.id),
    policyId: text("policy_id").references(() => merchantPolicies.id),
    grantId: text("grant_id").references(() => merchantPolicyGrants.id),
    actorId: text("actor_id").notNull().references(() => users.id),
    event: text("event").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("merchant_policy_events_business_idx").on(t.businessId, t.createdAt),
    check("merchant_policy_events_target", sql`${t.policyId} IS NOT NULL OR ${t.grantId} IS NOT NULL`),
  ],
);
