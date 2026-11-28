import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import { markets, orders, users } from "./index";

/**
 * Deal payment agreement (0081). JassimAI arranges how buyer and seller settle; money never
 * passes through it. There is deliberately no balance, ledger, escrow or payout here.
 */
export const dealPaymentCatalogChanges = pgTable(
  "deal_payment_catalog_changes",
  {
    id: text("id").primaryKey(),
    countryCode: text("country_code").notNull(),
    methodCode: text("method_code"),
    status: text("status").notNull(),
    labelAr: text("label_ar"),
    kind: text("kind"),
    currencies: jsonb("currencies").$type<string[] | null>(),
    sourceReference: text("source_reference"),
    reason: text("reason").notNull(),
    actorId: text("actor_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("deal_payment_catalog_changes_lookup_idx").on(t.countryCode, t.methodCode, t.createdAt),
    check("deal_payment_catalog_changes_status_valid", sql`${t.status} IN ('ACTIVE', 'LIMITED', 'UNAVAILABLE', 'UNDER_REVIEW')`),
    check("deal_payment_catalog_changes_kind_valid", sql`${t.kind} IS NULL OR ${t.kind} IN ('DIRECT', 'COD')`),
    check("deal_payment_catalog_changes_active_sourced", sql`${t.status} <> 'ACTIVE' OR length(trim(coalesce(${t.sourceReference}, ''))) > 0`),
    check("deal_payment_catalog_changes_reason_present", sql`length(trim(${t.reason})) > 0`),
  ],
);

export const sellerPaymentMethods = pgTable(
  "seller_payment_methods",
  {
    sellerId: text("seller_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    methodCode: text("method_code").notNull(),
    customLabel: text("custom_label"),
    instructions: jsonb("instructions").$type<Record<string, string>>().default({}).notNull(),
    sharePolicy: text("share_policy").default("ON_REQUEST").notNull(),
    codAreas: jsonb("cod_areas").$type<string[]>().default([]).notNull(),
    paused: boolean("paused").default(false).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "seller_payment_methods_pk", columns: [t.sellerId, t.marketId, t.methodCode] }),
    check("seller_payment_methods_share_policy_valid", sql`${t.sharePolicy} IN ('ON_REQUEST', 'CONFIRMED_BUYERS')`),
  ],
);

export const DEAL_PAYMENT_STATUSES = [
  "DRAFT",
  "WAITING_FOR_SELLER",
  "WAITING_FOR_BUYER",
  "PAYMENT_METHOD_PROPOSED",
  "PAYMENT_METHOD_CONFIRMED",
  "AWAITING_PAYMENT",
  "BUYER_REPORTED_PAID",
  "SELLER_CONFIRMED_RECEIPT",
  "COD_PENDING_DELIVERY",
  "COD_COLLECTED",
  "COMPLETED",
  "CANCELLED",
  "DISPUTED",
] as const;

export const dealPaymentAgreements = pgTable(
  "deal_payment_agreements",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    countryCode: text("country_code").notNull(),
    currencyCode: text("currency_code").notNull(),
    buyerId: text("buyer_id").notNull().references(() => users.id),
    sellerId: text("seller_id").notNull().references(() => users.id),
    acceptedMethods: jsonb("accepted_methods").$type<string[]>().notNull(),
    proposedMethod: text("proposed_method"),
    proposedLabel: text("proposed_label"),
    proposedBy: text("proposed_by"),
    agreedMethod: text("agreed_method"),
    agreedLabel: text("agreed_label"),
    status: text("status").notNull(),
    instructionsShared: jsonb("instructions_shared").$type<Record<string, string> | null>(),
    instructionsSharedAt: timestamp("instructions_shared_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("deal_payment_agreements_order_unique").on(t.orderId),
    index("deal_payment_agreements_seller_idx").on(t.sellerId, t.status),
    index("deal_payment_agreements_buyer_idx").on(t.buyerId, t.status),
    check(
      "deal_payment_agreements_status_valid",
      sql`${t.status} IN ('DRAFT', 'WAITING_FOR_SELLER', 'WAITING_FOR_BUYER', 'PAYMENT_METHOD_PROPOSED', 'PAYMENT_METHOD_CONFIRMED', 'AWAITING_PAYMENT', 'BUYER_REPORTED_PAID', 'SELLER_CONFIRMED_RECEIPT', 'COD_PENDING_DELIVERY', 'COD_COLLECTED', 'COMPLETED', 'CANCELLED', 'DISPUTED')`,
    ),
    check("deal_payment_agreements_proposed_by_valid", sql`${t.proposedBy} IS NULL OR ${t.proposedBy} IN ('BUYER', 'SELLER')`),
    check(
      "deal_payment_agreements_proposal_consistent",
      sql`(${t.status} = 'PAYMENT_METHOD_PROPOSED') = (${t.proposedMethod} IS NOT NULL AND ${t.proposedBy} IS NOT NULL)`,
    ),
    check(
      "deal_payment_agreements_agreed_consistent",
      sql`${t.status} NOT IN ('PAYMENT_METHOD_CONFIRMED', 'AWAITING_PAYMENT', 'BUYER_REPORTED_PAID', 'SELLER_CONFIRMED_RECEIPT', 'COD_PENDING_DELIVERY', 'COD_COLLECTED', 'COMPLETED') OR ${t.agreedMethod} IS NOT NULL`,
    ),
    check("deal_payment_agreements_parties_distinct", sql`${t.buyerId} <> ${t.sellerId}`),
  ],
);

export const dealPaymentEvents = pgTable(
  "deal_payment_events",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull().references(() => dealPaymentAgreements.id),
    orderId: text("order_id").notNull(),
    actorId: text("actor_id").references(() => users.id),
    actorRole: text("actor_role").notNull(),
    event: text("event").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("deal_payment_events_agreement_idx").on(t.agreementId, t.createdAt),
    check("deal_payment_events_actor_role_valid", sql`${t.actorRole} IN ('BUYER', 'SELLER', 'ADMIN', 'SYSTEM')`),
    check("deal_payment_events_admin_reason", sql`${t.actorRole} <> 'ADMIN' OR length(trim(coalesce(${t.detail}->>'reason', ''))) > 0`),
    check("deal_payment_events_actor_present", sql`${t.actorRole} = 'SYSTEM' OR ${t.actorId} IS NOT NULL`),
  ],
);

export const SELLER_CLASSIFICATIONS = ["PERSONAL_SELLER", "INDIVIDUAL_MERCHANT", "REGISTERED_BUSINESS", "CONNECT_PARTNER", "UNDER_REVIEW"] as const;

/** Seller classification history (0082), append-only; the latest row per seller and market is current. */
export const sellerClassifications = pgTable(
  "seller_classifications",
  {
    id: text("id").primaryKey(),
    sellerId: text("seller_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    classification: text("classification").notNull(),
    confidence: integer("confidence").notNull(),
    source: text("source").notNull(),
    signals: jsonb("signals").$type<{ key: string; weight: number; detail?: string }[]>().default([]).notNull(),
    reason: text("reason").notNull(),
    actorId: text("actor_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("seller_classifications_current_idx").on(t.sellerId, t.marketId, t.createdAt),
    check("seller_classifications_classification_valid", sql`${t.classification} IN ('PERSONAL_SELLER', 'INDIVIDUAL_MERCHANT', 'REGISTERED_BUSINESS', 'CONNECT_PARTNER', 'UNDER_REVIEW')`),
    check("seller_classifications_source_valid", sql`${t.source} IN ('USER_DECLARED', 'SIGNALS', 'BUSINESS_PROFILE', 'CONNECT_PARTNER', 'ADMIN', 'APPEAL')`),
    check("seller_classifications_confidence_range", sql`${t.confidence} BETWEEN 0 AND 100`),
    check("seller_classifications_reason_present", sql`length(trim(${t.reason})) > 0`),
    check("seller_classifications_actor_present", sql`${t.source} NOT IN ('USER_DECLARED', 'ADMIN', 'APPEAL') OR ${t.actorId} IS NOT NULL`),
  ],
);
