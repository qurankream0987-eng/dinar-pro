import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  check,
  doublePrecision,
  type AnyPgColumn,
  bigint,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const dates = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
// Private advisory memory; never joined to public listings, seller views or analytics.
export const personalMemories = pgTable("personal_memories", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  topic: text("topic").notNull(),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  parent: text("parent"),
  value: text("value"),
  confidence: doublePrecision("confidence").notNull(),
  signalCount: integer("signal_count").notNull(),
  sourceTypes: jsonb("source_types").$type<string[]>().notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  conversationId: text("conversation_id"),
}, t => [
  primaryKey({ columns: [t.userId, t.topic, t.kind] }),
  index("personal_memories_user_recency_idx").on(t.userId, t.lastSeenAt),
  check("personal_memories_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1 AND ${t.signalCount} >= 0`),
  check("personal_memories_status_check", sql`${t.status} IN ('ACTIVE', 'SUPPRESSED', 'FORGOTTEN')`),
  check("personal_memories_kind_check", sql`${t.kind} IN ('SESSION_CONTEXT','EXPLICIT_PREFERENCES','INFERRED_INTERESTS','NEGATIVE_PREFERENCES','BEHAVIORAL_SIGNALS','LONG_TERM_FACTS','CONVERSATION_STYLE','RECENT_CONTEXT')`),
]);
export const personalMemoryEvents = pgTable("personal_memory_events", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(),
  topic: text("topic").notNull(),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, t => [
  primaryKey({ columns: [t.userId, t.eventId, t.topic, t.kind] }),
  index("personal_memory_events_topic_idx").on(t.userId, t.topic),
  check("personal_memory_events_source_check", sql`${t.source} IN ('EXPLICIT_USER_STATEMENT','CONVERSATION','SEARCH','LISTING_VIEW','SAVE','PURCHASE','SELLER_ACTIVITY','REPEATED_TOPIC','USER_CORRECTION')`),
]);
export const personalMemoryControls = pgTable("personal_memory_controls", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  control: text("control").notNull(),
  enabled: boolean("enabled").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.userId, t.control] })]);
export const markets = pgTable("markets", {
  id: text("id").primaryKey(),
  countryCode: text("country_code").notNull().unique(),
  countryNameAr: text("country_name_ar").notNull(),
  countryNameEn: text("country_name_en").notNull(),
  currencyCode: text("currency_code").notNull(),
  currencySymbolAr: text("currency_symbol_ar").notNull(),
  unitPriceMinor: integer("unit_price_minor"),
  minorUnitScale: integer("minor_unit_scale").notNull(),
  isActive: boolean("is_active").default(false).notNull(),
  status: text("status").default("COMING_SOON").notNull(),
  fulfilmentMethods: jsonb("fulfilment_methods").$type<string[]>().default(["PICKUP", "DELIVERY", "DIGITAL", "SERVICE"]).notNull(),
  paymentMethods: jsonb("payment_methods").$type<string[]>().default(["CASH_DIRECT"]).notNull(),
  restrictedCategories: jsonb("restricted_categories").$type<string[]>().default([]).notNull(),
  sellerEligibilityMode: text("seller_eligibility_mode").default("OPEN").notNull(),
  ...dates(),
}, (t) => [
  check(
    "markets_price_valid",
    sql`minor_unit_scale BETWEEN 0 AND 4 AND ((unit_price_minor IS NULL AND NOT is_active) OR (unit_price_minor IS NOT NULL AND unit_price_minor > 0))`,
  ),
]);
export const marketPriceVersions = pgTable("market_price_versions", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id),
  currencyCode: text("currency_code").notNull(),
  unitPriceMinor: integer("unit_price_minor").notNull(),
  minorUnitScale: integer("minor_unit_scale").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdBy: text("created_by"),
  ...dates(),
}, t => [uniqueIndex("price_market_start_unique").on(t.marketId, t.effectiveFrom)]);
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  phoneCountryCode: text("phone_country_code").notNull(),
  phoneNumber: text("phone_number").notNull(),
  normalizedPhone: text("normalized_phone").notNull().unique(),
  accountCountry: text("account_country").notNull(),
  activeMarketId: text("active_market_id")
    .notNull()
    .references(() => markets.id),
  passwordHash: text("password_hash").notNull(),
  avatarObjectPath: text("avatar_object_path"),
  city: text("city").default("").notNull(),
  area: text("area").default("").notNull(),
  administrativeArea: text("administrative_area").default("").notNull(),
  role: text("role").default("USER").notNull(),
  locale: text("locale").default("ar").notNull(),
  timeZone: text("time_zone").default("UTC").notNull(),
  phoneVerified: boolean("phone_verified").default(false).notNull(),
  status: text("status").default("ACTIVE").notNull(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  ...dates(),
}, (t) => [
  check(
    "users_status_valid",
    sql`${t.status} IN ('ACTIVE', 'RESTRICTED', 'SUSPENDED', 'DEACTIVATED')`,
  ),
  check("users_role_valid", sql`${t.role} IN ('USER', 'ADMIN')`),
  check(
    "users_deactivation_consistent",
    sql`(${t.status} = 'DEACTIVATED') = (${t.deactivatedAt} IS NOT NULL)`,
  ),
]);
export const marketplaceCategories = pgTable(
  "marketplace_categories",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id"),
    label: text("label").notNull().unique(),
    labelEn: text("label_en").notNull(),
    aliases: jsonb("aliases").$type<string[]>().default([]).notNull(),
    resourceType: text("resource_type").default("PRODUCT").notNull(),
    renderer: text("renderer").default("GENERIC").notNull(),
    attributes: jsonb("attributes")
      .$type<Record<string, Record<string, unknown>>>()
      .default({})
      .notNull(),
    searchFilters: jsonb("search_filters")
      .$type<Record<string, Record<string, unknown>>>()
      .default({})
      .notNull(),
    rules: jsonb("rules")
      .$type<Record<string, unknown>>()
      .notNull(),
    allowAdditionalAttributes: boolean("allow_additional_attributes")
      .default(true)
      .notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    ...dates(),
  },
  (t) => [
    index("marketplace_categories_parent_idx").on(t.parentId),
    index("marketplace_categories_active_idx").on(t.isActive),
  ],
);

export const marketplaceCategoryAudit = pgTable(
  "marketplace_category_audit",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id")
      .notNull()
      .references(() => marketplaceCategories.id),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("marketplace_category_audit_category_created_idx").on(
      t.categoryId,
      t.createdAt,
    ),
  ],
);
export const sellerMarketEligibility = pgTable("seller_market_eligibility", {
  userId: text("user_id").notNull().references(() => users.id),
  marketId: text("market_id").notNull().references(() => markets.id),
  approved: boolean("approved").default(false).notNull(),
  ...dates(),
}, t => [primaryKey({ columns: [t.userId, t.marketId] })]);
export const marketAudit = pgTable("market_audit", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id),
  actorId: text("actor_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  ...dates(),
});
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...dates(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_expiry_idx").on(t.expiresAt),
  ],
);
export const authRateLimitBuckets = pgTable(
  "auth_rate_limit_buckets",
  {
    keyHash: text("key_hash").primaryKey(),
    attempts: integer("attempts").notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "auth_rate_limit_attempts_valid",
      sql`${t.attempts} BETWEEN 1 AND 21`,
    ),
    index("auth_rate_limit_reset_idx").on(t.resetAt),
  ],
);
export const phoneVerificationChallenges = pgTable(
  "phone_verification_challenges",
  {
    id: text("id").primaryKey(),
    phoneHash: text("phone_hash").notNull(),
    codeHash: text("code_hash"),
    attempts: integer("attempts").default(0).notNull(),
    registrationTokenHash: text("registration_token_hash"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("phone_verification_registration_token_unique").on(
      t.registrationTokenHash,
    ),
    index("phone_verification_phone_created_idx").on(
      t.phoneHash,
      t.createdAt,
    ),
    index("phone_verification_expiry_idx").on(t.expiresAt),
    check(
      "phone_verification_attempts_valid",
      sql`${t.attempts} BETWEEN 0 AND 5`,
    ),
    check(
      "phone_verification_state_consistent",
      sql`(${t.verifiedAt} IS NULL) = (${t.registrationTokenHash} IS NULL)`,
    ),
    check(
      "phone_verification_consumption_requires_proof",
      sql`${t.consumedAt} IS NULL OR ${t.verifiedAt} IS NOT NULL`,
    ),
  ],
);
export const checkoutRequests = pgTable(
  "checkout_requests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: "checkout_requests_pkey",
      columns: [t.userId, t.idempotencyKey],
    }),
    index("checkout_requests_created_idx").on(t.createdAt),
  ],
);
export const offers = pgTable(
  "offers",
  {
    id: text("id").primaryKey(),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    status: text("status").notNull(),
    unitPriceMinor: integer("unit_price_minor"),
    pricingMode: text("pricing_mode").default("FIXED").notNull(),
    inventoryMode: text("inventory_mode").notNull(),
    availableQuantity: integer("available_quantity"),
    reservedQuantity: integer("reserved_quantity").default(0).notNull(),
    data: jsonb("data").$type<Record<string, any>>().notNull(),
    /**
     * C1 search index bookkeeping (migration 0041). A trigger bumps the revision and marks the row
     * stale whenever `data` changes (or its category changes); only the search refresher clears it,
     * after writing offer_search_documents for that exact revision. Not listing content.
     */
    searchRevision: bigint("search_revision", { mode: "number" }).default(0).notNull(),
    searchDocumentStale: boolean("search_document_stale").default(true).notNull(),
    ...dates(),
  },
  (t) => [
    check(
      "offers_inventory_valid",
      sql`reserved_quantity >= 0 AND ((inventory_mode = 'LIMITED' AND available_quantity IS NOT NULL AND available_quantity >= reserved_quantity) OR (inventory_mode = 'UNLIMITED' AND available_quantity IS NULL))`,
    ),
    check(
      "offers_pricing_valid",
      sql`(pricing_mode IN ('FIXED', 'NEGOTIABLE') AND unit_price_minor IS NOT NULL AND unit_price_minor >= 1) OR (pricing_mode = 'OPEN_TO_OFFERS' AND (unit_price_minor IS NULL OR unit_price_minor >= 1))`,
    ),
    check(
      "offers_status_valid",
      sql`${t.status} IN ('DRAFT', 'PUBLISHED', 'PAUSED', 'ARCHIVED', 'SOLD_OUT', 'MODERATION_HIDDEN', 'MODERATION_REMOVED')`,
    ),
    index("offers_market_status_idx").on(t.marketId, t.status),
    index("offers_seller_idx").on(t.sellerId),
    // C1: organic order walks (created_at, id); price sorts and the stale-row lookup.
    index("offers_market_status_created_idx").on(t.marketId, t.status, t.createdAt, t.id),
    index("offers_market_status_price_idx").on(t.marketId, t.status, t.unitPriceMinor),
    index("offers_search_stale_idx").on(t.marketId).where(sql`${t.searchDocumentStale}`),
    // C1: category predicates (by id, or by label on older rows) and a seller's own listings in order.
    index("offers_market_category_id_idx").on(t.marketId, sql`(${t.data}->>'categoryId')`),
    index("offers_market_category_label_idx").on(t.marketId, sql`(${t.data}->>'category')`),
    index("offers_seller_created_idx").on(t.sellerId, t.createdAt, t.id),
  ],
);
/**
 * C1: the searchable text of one listing, exactly as the search's JavaScript builds it
 * (marketplace-search-index.ts), for one source revision. Internal: never returned to clients.
 */
export const offerSearchDocuments = pgTable(
  "offer_search_documents",
  {
    offerId: text("offer_id")
      .primaryKey()
      .references(() => offers.id, { onDelete: "cascade" }),
    searchText: text("search_text").notNull(),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    textVersion: integer("text_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("offer_search_documents_text_trgm_idx").using("gin", sql`${t.searchText} gin_trgm_ops`),
    index("offer_search_documents_version_idx").on(t.textVersion),
  ],
);
export const promotionProducts = pgTable(
  "promotion_products",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    // Null: a product that is not category-scoped (bundles, DINAR Business).
    categoryId: text("category_id").references(() => marketplaceCategories.id),
    name: text("name").notNull(),
    placement: text("placement").default("SEARCH_AND_CHAT").notNull(),
    productType: text("product_type").default("STANDARD_PROMOTION").notNull(),
    chargingMode: text("charging_mode").default("FIXED").notNull(),
    pricingVersion: integer("pricing_version").default(1).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    /** PREPAID_BUDGET products: priceMinor is the minimum budget; this caps it. */
    maxBudgetMinor: integer("max_budget_minor"),
    /** Charge per qualified event (the campaign's bid) for budget products. */
    unitChargeMinor: integer("unit_charge_minor"),
    /** Commercial priority among eligible paid candidates (100 = standard, VIP higher). */
    priorityWeight: integer("priority_weight").default(100).notNull(),
    refundPolicy: text("refund_policy").default("NON_REFUNDABLE_ON_ACTIVATION").notNull(),
    bundleItems: jsonb("bundle_items").$type<{ productType: string; units: number; durationDays: number; priorityWeight?: number }[]>().default([]).notNull(),
    entitlementExpiryDays: integer("entitlement_expiry_days"),
    businessEntitlements: jsonb("business_entitlements").$type<string[]>().default([]).notNull(),
    /** D1: the public subscription plan a DINAR_BUSINESS product sells (null: legacy plan, derived). */
    planCode: text("plan_code"),
    taxPolicyVersion: text("tax_policy_version"),
    priceMinor: integer("price_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    durationDays: integer("duration_days").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdBy: text("created_by").references(() => users.id),
    updatedBy: text("updated_by").references(() => users.id),
    ...dates(),
  },
  (t) => [
    index("promotion_products_market_enabled_idx").on(t.marketId, t.enabled),
    // D1: at most one enabled catalog product per public plan and market (no ambiguous plan price).
    uniqueIndex("promotion_products_enabled_plan_unique")
      .on(t.marketId, t.planCode)
      .where(sql`${t.planCode} IS NOT NULL AND ${t.enabled}`),
    index("promotion_products_market_category_idx").on(t.marketId, t.categoryId),
    check("promotion_products_price_positive_check", sql`${t.priceMinor} > 0`),
    check(
      "promotion_products_plan_code_valid",
      sql`${t.planCode} IS NULL OR (${t.productType} = 'DINAR_BUSINESS' AND ${t.planCode} IN ('DINAR_GO', 'DINAR_PRO', 'DINAR_BUSINESS'))`,
    ),
    check(
      "promotion_products_duration_check",
      sql`${t.durationDays} >= 1 AND ${t.durationDays} <= 365`,
    ),
    check(
      "promotion_products_placement_valid",
      sql`${t.placement} IN ('SEARCH_AND_CHAT', 'FEATURED', 'VIP', 'REFRESH', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND', 'NONE')`,
    ),
    check(
      "promotion_products_type_valid",
      sql`${t.productType} IN ('STANDARD_PROMOTION', 'FEATURED_LISTING', 'VIP_LISTING', 'REFRESH_LISTING', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND_CAPTURE', 'PROMOTION_BUNDLE', 'EXTRA_LISTING_QUOTA', 'DINAR_BUSINESS', 'SPONSORED_SURFACE')`,
    ),
    // Each product type has exactly one placement; listing products need a category.
    check(
      "promotion_products_type_placement",
      sql`(${t.productType}, ${t.placement}) IN (('STANDARD_PROMOTION', 'SEARCH_AND_CHAT'), ('FEATURED_LISTING', 'FEATURED'), ('VIP_LISTING', 'VIP'), ('REFRESH_LISTING', 'REFRESH'), ('SPONSORED_SEARCH', 'SPONSORED_SEARCH'), ('SPONSORED_RECOMMENDATION', 'SPONSORED_RECOMMENDATION'), ('DEMAND_CAPTURE', 'DEMAND'), ('PROMOTION_BUNDLE', 'NONE'), ('EXTRA_LISTING_QUOTA', 'NONE'), ('DINAR_BUSINESS', 'NONE'), ('SPONSORED_SURFACE', 'NONE'))`,
    ),
    check(
      "promotion_products_category_scope",
      sql`(${t.placement} = 'NONE') = (${t.categoryId} IS NULL)`,
    ),
    check(
      "promotion_products_charging_mode_valid",
      sql`${t.chargingMode} IN ('FIXED', 'PREPAID_BUDGET', 'QUALIFIED_IMPRESSION', 'QUALIFIED_CLICK', 'QUALIFIED_ENGAGEMENT', 'QUALIFIED_LEAD', 'SUBSCRIPTION')`,
    ),
    // Only fully measured modes can be sold: fixed, prepaid budget charged per qualified
    // engagement, and subscriptions. Impression/click/lead billing stays prepared.
    check(
      "promotion_products_charging_mode_enabled",
      sql`${t.chargingMode} IN ('FIXED', 'PREPAID_BUDGET', 'SUBSCRIPTION') OR NOT ${t.enabled}`,
    ),
    check(
      "promotion_products_budget_terms",
      sql`(${t.chargingMode} = 'PREPAID_BUDGET') = (${t.unitChargeMinor} IS NOT NULL AND ${t.unitChargeMinor} > 0 AND ${t.unitChargeMinor} <= ${t.priceMinor} AND (${t.maxBudgetMinor} IS NULL OR ${t.maxBudgetMinor} >= ${t.priceMinor}))`,
    ),
    check(
      "promotion_products_refund_policy_valid",
      sql`${t.refundPolicy} IN ('NON_REFUNDABLE_ON_ACTIVATION', 'RELEASE_UNUSED_BUDGET', 'UNUSED_UNITS_TO_CREDIT', 'NO_REFUND')`,
    ),
    check("promotion_products_priority_valid", sql`${t.priorityWeight} >= 1 AND ${t.priorityWeight} <= 1000`),
    check("promotion_products_version_valid", sql`${t.pricingVersion} >= 1`),
    // No listing-count limit exists, so extra quota is prepared but cannot be sold;
    // sponsored surfaces are reserved for later.
    check(
      "promotion_products_prepared_types_disabled",
      sql`${t.productType} NOT IN ('EXTRA_LISTING_QUOTA', 'SPONSORED_SURFACE') OR NOT ${t.enabled}`,
    ),
    check(
      "promotion_products_currency_valid",
      sql`${t.currencyCode} ~ '^[A-Z]{3}$'`,
    ),
  ],
);
/**
 * One paid placement for one listing (Block E). The price, currency, duration and
 * placement are snapshots of the plan accepted at purchase; plan changes never
 * rewrite them. Serving requires ACTIVE, a captured simulated payment and
 * startsAt <= now < expiresAt, evaluated on every read — status alone never serves.
 * Promotion revenue is separate from order commission and never touches orders.
 */
export const listingPromotions = pgTable(
  "listing_promotions",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id")
      .notNull()
      .references(() => offers.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    productId: text("product_id")
      .notNull()
      .references(() => promotionProducts.id),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    categoryIdSnapshot: text("category_id_snapshot").notNull(),
    priceMinorSnapshot: integer("price_minor_snapshot").notNull(),
    currencyCodeSnapshot: text("currency_code_snapshot").notNull(),
    placementSnapshot: text("placement_snapshot").notNull(),
    durationDaysSnapshot: integer("duration_days_snapshot").notNull(),
    status: text("status").default("PENDING_PAYMENT").notNull(),
    paymentMode: text("payment_mode")
      .default("DEVELOPMENT_SIMULATED")
      .notNull(),
    paymentStatus: text("payment_status")
      .default("SIMULATION_PENDING")
      .notNull(),
    paymentProviderKey: text("payment_provider_key"),
    paymentReference: text("payment_reference"),
    idempotencyKey: text("idempotency_key"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Commercial economy snapshots (Monetization V3): immutable once accepted.
    productTypeSnapshot: text("product_type_snapshot").default("STANDARD_PROMOTION").notNull(),
    chargingModeSnapshot: text("charging_mode_snapshot").default("FIXED").notNull(),
    pricingVersionSnapshot: integer("pricing_version_snapshot").default(1).notNull(),
    refundPolicySnapshot: text("refund_policy_snapshot").default("NON_REFUNDABLE_ON_ACTIVATION").notNull(),
    priorityWeightSnapshot: integer("priority_weight_snapshot").default(100).notNull(),
    unitChargeMinorSnapshot: integer("unit_charge_minor_snapshot"),
    /** Reserved from the commercial balance (PREPAID_BUDGET only); promo part listed separately. */
    budgetMinor: integer("budget_minor"),
    budgetPromoMinor: integer("budget_promo_minor").default(0).notNull(),
    spentMinor: integer("spent_minor").default(0).notNull(),
    releasedMinor: integer("released_minor").default(0).notNull(),
    paymentSource: text("payment_source").default("SIMULATED_PROVIDER").notNull(),
    entitlementId: text("entitlement_id").references(() => commercialEntitlements.id),
    taxMinor: integer("tax_minor").default(0).notNull(),
    taxPolicyVersion: text("tax_policy_version"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...dates(),
  },
  (t) => [
    index("listing_promotions_market_status_expiry_idx").on(
      t.marketId,
      t.status,
      t.expiresAt,
    ),
    index("listing_promotions_listing_status_idx").on(t.listingId, t.status),
    index("listing_promotions_seller_created_idx").on(t.sellerId, t.createdAt),
    uniqueIndex("listing_promotions_seller_idempotency_unique")
      .on(t.sellerId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    uniqueIndex("listing_promotions_payment_reference_unique")
      .on(t.paymentProviderKey, t.paymentReference)
      .where(sql`${t.paymentReference} IS NOT NULL`),
    // No boost stacking: one pending/live campaign per listing and placement.
    uniqueIndex("listing_promotions_one_live_per_placement")
      .on(t.listingId, t.placementSnapshot)
      .where(sql`${t.status} IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED')`),
    check("listing_promotions_price_positive_check", sql`${t.priceMinorSnapshot} > 0`),
    check(
      "listing_promotions_duration_check",
      sql`${t.durationDaysSnapshot} >= 1 AND ${t.durationDaysSnapshot} <= 365`,
    ),
    check(
      "listing_promotions_simulation_only_check",
      sql`${t.paymentMode} = 'DEVELOPMENT_SIMULATED'`,
    ),
    check(
      "listing_promotions_status_valid",
      sql`${t.status} IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED', 'PAYMENT_FAILED', 'BUDGET_EXHAUSTED')`,
    ),
    check(
      "listing_promotions_payment_status_valid",
      sql`${t.paymentStatus} IN ('SIMULATION_PENDING', 'SIMULATION_CAPTURED', 'SIMULATION_FAILED', 'LEGACY_UNVERIFIED', 'BALANCE_CHARGED', 'ENTITLEMENT_CONSUMED')`,
    ),
    // ACTIVE/PAUSED rows need a payment outcome; only SIMULATION_CAPTURED ever serves.
    check(
      "listing_promotions_live_requires_payment",
      sql`${t.status} NOT IN ('ACTIVE', 'PAUSED') OR ${t.paymentStatus} IN ('SIMULATION_CAPTURED', 'LEGACY_UNVERIFIED', 'BALANCE_CHARGED', 'ENTITLEMENT_CONSUMED')`,
    ),
    check(
      "listing_promotions_failed_consistent",
      sql`(${t.status} = 'PAYMENT_FAILED') = (${t.paymentStatus} = 'SIMULATION_FAILED')`,
    ),
    check(
      "listing_promotions_reference_consistent",
      sql`(${t.paymentReference} IS NULL) = (${t.paymentProviderKey} IS NULL)`,
    ),
    check(
      "listing_promotions_window_valid",
      sql`${t.expiresAt} > ${t.startsAt}`,
    ),
    check(
      "listing_promotions_currency_valid",
      sql`${t.currencyCodeSnapshot} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "listing_promotions_placement_valid",
      sql`${t.placementSnapshot} IN ('SEARCH_AND_CHAT', 'FEATURED', 'VIP', 'REFRESH', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND')`,
    ),
    check(
      "listing_promotions_payment_source_valid",
      sql`${t.paymentSource} IN ('SIMULATED_PROVIDER', 'COMMERCIAL_BALANCE', 'BUNDLE_ENTITLEMENT')`,
    ),
    check(
      "listing_promotions_payment_source_status",
      sql`(${t.paymentSource} = 'SIMULATED_PROVIDER') OR (${t.paymentSource} = 'COMMERCIAL_BALANCE' AND ${t.paymentStatus} = 'BALANCE_CHARGED') OR (${t.paymentSource} = 'BUNDLE_ENTITLEMENT' AND ${t.paymentStatus} = 'ENTITLEMENT_CONSUMED' AND ${t.entitlementId} IS NOT NULL)`,
    ),
    // Budget accounting: never negative, spend plus release never exceeds the budget.
    check(
      "listing_promotions_budget_valid",
      sql`${t.spentMinor} >= 0 AND ${t.releasedMinor} >= 0 AND ${t.budgetPromoMinor} >= 0 AND ${t.taxMinor} >= 0 AND (${t.budgetMinor} IS NULL AND ${t.spentMinor} = 0 AND ${t.releasedMinor} = 0 AND ${t.budgetPromoMinor} = 0 OR ${t.budgetMinor} > 0 AND ${t.budgetPromoMinor} <= ${t.budgetMinor} AND ${t.spentMinor} + ${t.releasedMinor} <= ${t.budgetMinor})`,
    ),
    check(
      "listing_promotions_budget_terms",
      sql`(${t.chargingModeSnapshot} = 'PREPAID_BUDGET') = (${t.budgetMinor} IS NOT NULL AND ${t.unitChargeMinorSnapshot} IS NOT NULL)`,
    ),
  ],
);

// ════ Monetization V3: DINAR commercial economy ════════════════════════════
// Seller/business prepaid credit for DINAR commercial services only. Never buyer money,
// seller proceeds, escrow or a withdrawable balance. The ledger is the authority; the
// account row is its materialised state, mutated only together with a ledger entry.

export const commercialAccounts = pgTable(
  "commercial_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    currencyCode: text("currency_code").notNull(),
    paidAvailableMinor: integer("paid_available_minor").default(0).notNull(),
    promoAvailableMinor: integer("promo_available_minor").default(0).notNull(),
    reservedMinor: integer("reserved_minor").default(0).notNull(),
    spentMinor: integer("spent_minor").default(0).notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("commercial_accounts_user_market_unique").on(t.userId, t.marketId),
    check(
      "commercial_accounts_non_negative",
      sql`${t.paidAvailableMinor} >= 0 AND ${t.promoAvailableMinor} >= 0 AND ${t.reservedMinor} >= 0 AND ${t.spentMinor} >= 0`,
    ),
    check("commercial_accounts_currency_valid", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

export const commercialLedger = pgTable(
  "commercial_ledger",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => commercialAccounts.id),
    userId: text("user_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    currencyCode: text("currency_code").notNull(),
    entryType: text("entry_type").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    /** Signed effect on each materialised bucket of the account. */
    paidDeltaMinor: integer("paid_delta_minor").default(0).notNull(),
    promoDeltaMinor: integer("promo_delta_minor").default(0).notNull(),
    reservedDeltaMinor: integer("reserved_delta_minor").default(0).notNull(),
    spentDeltaMinor: integer("spent_delta_minor").default(0).notNull(),
    productId: text("product_id").references(() => promotionProducts.id),
    productType: text("product_type"),
    pricingVersion: integer("pricing_version"),
    promotionId: text("promotion_id").references(() => listingPromotions.id),
    subscriptionId: text("subscription_id").references(() => businessSubscriptions.id),
    entitlementId: text("entitlement_id").references(() => commercialEntitlements.id),
    topupId: text("topup_id").references(() => commercialTopups.id),
    reversesEntryId: text("reverses_entry_id"),
    policyVersion: integer("policy_version").default(0).notNull(),
    providerKey: text("provider_key"),
    providerRef: text("provider_ref"),
    idempotencyKey: text("idempotency_key").notNull(),
    trafficClass: text("traffic_class").default("TEST").notNull(),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("commercial_ledger_account_idempotency_unique").on(t.accountId, t.idempotencyKey),
    index("commercial_ledger_account_created_idx").on(t.accountId, t.createdAt),
    index("commercial_ledger_market_type_idx").on(t.marketId, t.entryType),
    index("commercial_ledger_promotion_idx").on(t.promotionId),
    check(
      "commercial_ledger_entry_type_valid",
      sql`${t.entryType} IN ('CREDIT_TOPUP', 'CREDIT_GRANTED', 'CAMPAIGN_RESERVE', 'CAMPAIGN_RELEASE', 'CAMPAIGN_CHARGE', 'FEATURED_PURCHASE', 'VIP_PURCHASE', 'REFRESH_PURCHASE', 'BUNDLE_PURCHASE', 'SUBSCRIPTION_CHARGE', 'PROMOTION_PURCHASE', 'QUALIFIED_CLICK_CHARGE', 'QUALIFIED_ENGAGEMENT_CHARGE', 'QUALIFIED_LEAD_CHARGE', 'ENTITLEMENT_CONSUMED', 'REFUND', 'CREDIT', 'ADJUSTMENT', 'EXPIRE', 'REVERSAL')`,
    ),
    check("commercial_ledger_amount_valid", sql`${t.amountMinor} >= 0`),
    check("commercial_ledger_currency_valid", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("commercial_ledger_traffic_valid", sql`${t.trafficClass} IN ('LIVE', 'TEST')`),
  ],
);

/** A top-up intent; only a verified provider capture posts its CREDIT_TOPUP. */
export const commercialTopups = pgTable(
  "commercial_topups",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => commercialAccounts.id),
    userId: text("user_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    status: text("status").default("PENDING").notNull(),
    paymentMode: text("payment_mode").default("SIMULATION_ONLY").notNull(),
    providerKey: text("provider_key").notNull(),
    providerRef: text("provider_ref").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    creditedEntryId: text("credited_entry_id"),
    ...dates(),
  },
  (t) => [
    uniqueIndex("commercial_topups_provider_ref_unique").on(t.providerKey, t.providerRef),
    uniqueIndex("commercial_topups_user_idempotency_unique").on(t.userId, t.idempotencyKey),
    check("commercial_topups_status_valid", sql`${t.status} IN ('PENDING', 'CREDITED', 'FAILED')`),
    check("commercial_topups_amount_valid", sql`${t.amountMinor} > 0`),
    check("commercial_topups_simulation_only", sql`${t.paymentMode} = 'SIMULATION_ONLY'`),
    check("commercial_topups_credit_consistent", sql`(${t.status} = 'CREDITED') = (${t.creditedEntryId} IS NOT NULL)`),
  ],
);

/** Units bought in a bundle; each use is consumed atomically and never below zero. */
export const commercialEntitlements = pgTable(
  "commercial_entitlements",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => commercialAccounts.id),
    userId: text("user_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    bundleProductId: text("bundle_product_id").notNull().references(() => promotionProducts.id),
    sourceEntryId: text("source_entry_id").notNull(),
    productType: text("product_type").notNull(),
    unitsTotal: integer("units_total").notNull(),
    unitsUsed: integer("units_used").default(0).notNull(),
    unitDurationDays: integer("unit_duration_days").notNull(),
    unitPriorityWeight: integer("unit_priority_weight").default(100).notNull(),
    pricingVersion: integer("pricing_version").notNull(),
    refundPolicy: text("refund_policy").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    index("commercial_entitlements_user_market_idx").on(t.userId, t.marketId, t.productType),
    check("commercial_entitlements_units_valid", sql`${t.unitsTotal} > 0 AND ${t.unitsUsed} >= 0 AND ${t.unitsUsed} <= ${t.unitsTotal}`),
    check("commercial_entitlements_type_valid", sql`${t.productType} IN ('FEATURED_LISTING', 'VIP_LISTING', 'REFRESH_LISTING')`),
    check("commercial_entitlements_duration_valid", sql`${t.unitDurationDays} >= 1 AND ${t.unitDurationDays} <= 365`),
  ],
);

export const businessSubscriptions = pgTable(
  "business_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    planId: text("plan_id").notNull().references(() => promotionProducts.id),
    planNameSnapshot: text("plan_name_snapshot").notNull(),
    priceMinorSnapshot: integer("price_minor_snapshot").notNull(),
    currencyCodeSnapshot: text("currency_code_snapshot").notNull(),
    periodDaysSnapshot: integer("period_days_snapshot").notNull(),
    pricingVersionSnapshot: integer("pricing_version_snapshot").notNull(),
    entitlementsSnapshot: jsonb("entitlements_snapshot").$type<string[]>().default([]).notNull(),
    /** D1: plan code at purchase (null: a subscription bought before D1; its plan is derived). */
    planCodeSnapshot: text("plan_code_snapshot"),
    /** D1/D2: the business a DINAR_BUSINESS subscription serves. Never a verification by itself. */
    businessProfileId: text("business_profile_id").references((): AnyPgColumn => businessProfiles.id),
    status: text("status").default("PENDING").notNull(),
    autoRenew: boolean("auto_renew").default(false).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    uniqueIndex("business_subscriptions_user_idempotency_unique").on(t.userId, t.idempotencyKey),
    uniqueIndex("business_subscriptions_one_live")
      .on(t.userId, t.marketId)
      .where(sql`${t.status} IN ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END')`),
    check(
      "business_subscriptions_status_valid",
      sql`${t.status} IN ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END', 'CANCELLED', 'EXPIRED', 'PAYMENT_FAILED')`,
    ),
    // No silent recurring charge in this phase.
    check("business_subscriptions_no_auto_renew", sql`NOT ${t.autoRenew}`),
    check(
      "business_subscriptions_plan_code_valid",
      sql`${t.planCodeSnapshot} IS NULL OR ${t.planCodeSnapshot} IN ('DINAR_GO', 'DINAR_PRO', 'DINAR_BUSINESS')`,
    ),
    // A DINAR Business subscription always names its business; Go and Pro never do.
    check(
      "business_subscriptions_business_link",
      sql`(${t.planCodeSnapshot} = 'DINAR_BUSINESS') = (${t.businessProfileId} IS NOT NULL)`,
    ),
    check(
      "business_subscriptions_period_valid",
      sql`${t.status} IN ('PENDING', 'PAYMENT_FAILED') OR (${t.currentPeriodStart} IS NOT NULL AND ${t.currentPeriodEnd} > ${t.currentPeriodStart})`,
    ),
  ],
);

/**
 * Normalised, allowlisted commercial intent from canonical DINAR searches. Never a phone,
 * email, address, coordinates, payment data, negotiation terms or message text; the actor
 * is an HMAC key that is never exposed and only counts distinct demand actors.
 */
export const demandSignals = pgTable(
  "demand_signals",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull().references(() => markets.id),
    actorKey: text("actor_key").notNull(),
    categoryId: text("category_id"),
    needKey: text("need_key").notNull(),
    normalizedNeed: text("normalized_need").notNull(),
    city: text("city"),
    priceMinMinor: integer("price_min_minor"),
    priceMaxMinor: integer("price_max_minor"),
    currencyCode: text("currency_code").notNull(),
    condition: text("condition"),
    resultCount: integer("result_count").notNull(),
    state: text("state").notNull(),
    trafficClass: text("traffic_class").default("TEST").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...dates(),
  },
  (t) => [
    index("demand_signals_market_created_idx").on(t.marketId, t.createdAt),
    index("demand_signals_market_need_idx").on(t.marketId, t.needKey),
    index("demand_signals_actor_idx").on(t.actorKey, t.createdAt),
    check(
      "demand_signals_state_valid",
      sql`${t.state} IN ('SEARCHED', 'ZERO_RESULTS', 'LOW_SUPPLY', 'USER_UNSATISFIED', 'SATISFIED', 'CONVERTED', 'EXPIRED')`,
    ),
    check("demand_signals_traffic_valid", sql`${t.trafficClass} IN ('LIVE', 'TEST')`),
    check("demand_signals_result_count_valid", sql`${t.resultCount} >= 0`),
  ],
);

/** Server-attributed paid-placement events; the viewer is an HMAC key, never an identity. */
export const promotionAttributions = pgTable(
  "promotion_attributions",
  {
    id: text("id").primaryKey(),
    promotionId: text("promotion_id").notNull().references(() => listingPromotions.id),
    listingId: text("listing_id").notNull().references(() => offers.id),
    sellerId: text("seller_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    placement: text("placement").notNull(),
    resultSetId: text("result_set_id"),
    viewerKey: text("viewer_key").notNull(),
    eventType: text("event_type").notNull(),
    engagementKind: text("engagement_kind"),
    orderId: text("order_id"),
    chargeMinor: integer("charge_minor").default(0).notNull(),
    chargeStatus: text("charge_status").notNull(),
    ledgerEntryId: text("ledger_entry_id"),
    dedupKey: text("dedup_key").notNull(),
    policyVersion: integer("policy_version").default(0).notNull(),
    trafficClass: text("traffic_class").default("TEST").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("promotion_attributions_dedup_unique").on(t.dedupKey),
    index("promotion_attributions_promotion_idx").on(t.promotionId, t.eventType),
    check("promotion_attributions_event_valid", sql`${t.eventType} IN ('IMPRESSION', 'ENGAGEMENT', 'CONVERSION')`),
    check(
      "promotion_attributions_kind_valid",
      sql`${t.engagementKind} IS NULL OR ${t.engagementKind} IN ('DETAIL_OPENED', 'COMPARISON_STARTED', 'NEGOTIATION_STARTED', 'PURCHASE_REVIEW_STARTED')`,
    ),
    check(
      "promotion_attributions_charge_valid",
      sql`${t.chargeStatus} IN ('NOT_BILLABLE', 'CHARGED', 'SKIPPED_SELF', 'SKIPPED_BUDGET', 'SKIPPED_INACTIVE') AND ${t.chargeMinor} >= 0 AND (${t.chargeStatus} = 'CHARGED') = (${t.chargeMinor} > 0)`,
    ),
    check("promotion_attributions_traffic_valid", sql`${t.trafficClass} IN ('LIVE', 'TEST')`),
  ],
);

/** Versioned commercial policy (slots, cohort threshold, dedup windows...). */
export const commercialPolicies = pgTable(
  "commercial_policies",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").references(() => markets.id),
    version: integer("version").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).defaultNow().notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("commercial_policies_market_version_unique").on(t.marketId, t.version),
    check("commercial_policies_version_valid", sql`${t.version} >= 1`),
  ],
);
export const carts = pgTable(
  "carts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    ...dates(),
  },
  (t) => [uniqueIndex("carts_user_market_unique").on(t.userId, t.marketId)],
);
export const cartItems = pgTable(
  "cart_items",
  {
    id: text("id").primaryKey(),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    offerId: text("offer_id")
      .notNull()
      .references(() => offers.id),
    quantity: integer("quantity").notNull(),
    ...dates(),
  },
  (t) => [uniqueIndex("cart_offer_unique").on(t.cartId, t.offerId)],
);
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    countryCode: text("country_code").notNull(),
    priceVersionId: text("price_version_id").references(() => marketPriceVersions.id),
    currencyCode: text("currency_code").notNull(),
    minorUnitScale: integer("minor_unit_scale").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    quantity: integer("quantity").notNull(),
    subtotalMinor: integer("subtotal_minor").notNull(),
    platformFeeMinor: integer("platform_fee_minor").notNull(),
    sellerAmountMinor: integer("seller_amount_minor").notNull(),
    status: text("status").notNull(),
    reservationExpiresAt: timestamp("reservation_expires_at", {
      withTimezone: true,
    }),
    data: jsonb("data").$type<Record<string, any>>().notNull(),
    ...dates(),
  },
  (t) => [
    index("orders_buyer_idx").on(t.buyerId),
    index("orders_seller_status_idx").on(t.sellerId, t.status),
    index("orders_reservation_expiry_idx").on(t.status, t.reservationExpiresAt),
  ],
);
export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    offerId: text("offer_id")
      .notNull()
      .references(() => offers.id),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    subtotalMinor: integer("subtotal_minor").notNull(),
    data: jsonb("data").$type<Record<string, any>>().notNull(),
    ...dates(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);
export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .unique()
    .references(() => orders.id),
  ownerUserId: text("owner_user_id").references(() => users.id),
  marketId: text("market_id").references(() => markets.id),
  kind: text("kind").default("ORDER").notNull(),
  title: text("title").default("محادثة جديدة").notNull(),
  ...dates(),
}, (t) => [
  index("conversations_owner_updated_idx").on(t.ownerUserId, t.updatedAt),
  index("conversations_market_updated_idx").on(t.marketId, t.updatedAt),
  check("conversations_shape_check", sql`(kind = 'ORDER' AND order_id IS NOT NULL) OR (kind = 'AI' AND order_id IS NULL AND owner_user_id IS NOT NULL AND market_id IS NOT NULL) OR (kind = 'INQUIRY' AND order_id IS NULL AND owner_user_id IS NULL AND market_id IS NOT NULL)`),
]);
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    senderId: text("sender_id").references(() => users.id),
    body: text("body").notNull(),
    actor: text("actor").default("USER").notNull(),
    contentType: text("content_type").default("TEXT").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    ...dates(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);
export const aiResultSets = pgTable("ai_result_sets", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  marketId: text("market_id").notNull().references(() => markets.id),
  messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
  query: jsonb("query").$type<Record<string, unknown>>().notNull(),
  resourceIds: jsonb("resource_ids").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [index("ai_result_sets_conversation_idx").on(t.conversationId, t.createdAt)]);
export const aiUiBlocks = pgTable("ai_ui_blocks", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  blockType: text("block_type").notNull(),
  version: integer("version").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  ordinal: integer("ordinal").notNull(),
  ...dates(),
}, (t) => [index("ai_ui_blocks_message_idx").on(t.messageId, t.ordinal)]);
export const tutorialLearningEvents = pgTable(
  "tutorial_learning_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    tutorialId: text("tutorial_id").notNull(),
    eventType: text("event_type").notNull(),
    milestonePercent: integer("milestone_percent"),
    currentTimeSeconds: integer("current_time_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("tutorial_learning_events_user_key_uq").on(t.userId, t.idempotencyKey),
    index("tutorial_learning_events_user_created_idx").on(t.userId, t.createdAt),
    check(
      "tutorial_learning_events_type_check",
      sql`${t.eventType} IN ('TUTORIAL_OPENED', 'PLAYBACK_STARTED', 'PLAYBACK_PROGRESS_MILESTONE', 'TEXT_FALLBACK_VIEWED', 'CONTINUATION_TRIGGERED')`,
    ),
    check(
      "tutorial_learning_events_tutorial_check",
      sql`${t.tutorialId} IN ('SELL_FIRST_LISTING', 'PHOTO_FIRST_SELLING', 'PROMOTION_OVERVIEW', 'FEATURED_EXPLAINER', 'VIP_EXPLAINER', 'DEMAND_CAPTURE_EXPLAINER')`,
    ),
    check(
      "tutorial_learning_events_milestone_check",
      sql`(${t.eventType} = 'PLAYBACK_PROGRESS_MILESTONE' AND ${t.milestonePercent} IN (25, 50, 75, 100)) OR (${t.eventType} <> 'PLAYBACK_PROGRESS_MILESTONE' AND ${t.milestonePercent} IS NULL)`,
    ),
    check(
      "tutorial_learning_events_time_check",
      sql`${t.currentTimeSeconds} IS NULL OR ${t.currentTimeSeconds} BETWEEN 0 AND 3600`,
    ),
  ],
);
export const disputes = pgTable("disputes", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  openedBy: text("opened_by")
    .notNull()
    .references(() => users.id),
  reason: text("reason").notNull(),
  description: text("description").default("").notNull(),
  resolution: text("resolution"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  status: text("status").default("OPEN").notNull(),
  evidence: jsonb("evidence").default([]).notNull(),
  ...dates(),
});
export const sellerDues = pgTable(
  "seller_dues",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .unique()
      .references(() => orders.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    status: text("status").default("PENDING").notNull(),
    ...dates(),
  },
  (t) => [index("dues_seller_status_idx").on(t.sellerId, t.status)],
);
/**
 * Versioned commission policy. The platform baseline (1,000 bps) is seeded as a published
 * global policy. Orders snapshot the policy they were priced under, so later policy
 * changes never rewrite the commission of an existing order.
 */
export const commissionPolicies = pgTable(
  "commission_policies",
  {
    id: text("id").primaryKey(),
    policyKey: text("policy_key").notNull(),
    version: integer("version").notNull(),
    rateBasisPoints: integer("rate_basis_points").notNull(),
    basis: text("basis").default("GROSS_ITEM_SUBTOTAL").notNull(),
    roundingMode: text("rounding_mode").default("HALF_UP").notNull(),
    marketId: text("market_id").references(() => markets.id),
    status: text("status").default("DRAFT").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    contentHash: text("content_hash").notNull(),
    approvedBy: text("approved_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: text("created_by"),
    ...dates(),
  },
  (t) => [
    uniqueIndex("commission_policies_key_version_unique").on(t.policyKey, t.version),
    index("commission_policies_lookup_idx").on(t.policyKey, t.status, t.effectiveFrom),
    check(
      "commission_policies_rate_valid",
      sql`${t.rateBasisPoints} BETWEEN 0 AND 10000`,
    ),
    check("commission_policies_basis_valid", sql`${t.basis} IN ('GROSS_ITEM_SUBTOTAL')`),
    check("commission_policies_rounding_valid", sql`${t.roundingMode} IN ('HALF_UP')`),
    check(
      "commission_policies_status_valid",
      sql`${t.status} IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')`,
    ),
    check(
      "commission_policies_publication_valid",
      sql`${t.status} <> 'PUBLISHED' OR (${t.publishedAt} IS NOT NULL)`,
    ),
    check(
      "commission_policies_window_valid",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);
/**
 * Append-only financial journal for an order. Every entry names the business event that
 * caused it, the account obligation it moves, the currency and integer minor amount, the
 * actor and authorization context, and a per-order idempotency key. Corrections are new
 * reversing entries; rows are never updated or deleted (guard triggers enforce this).
 */
export const orderFinancialEvents = pgTable(
  "order_financial_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    eventType: text("event_type").notNull(),
    accountObligation: text("account_obligation").notNull(),
    businessRef: text("business_ref").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").references(() => users.id),
    currencyCode: text("currency_code").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    reversesEventId: text("reverses_event_id").references(
      (): AnyPgColumn => orderFinancialEvents.id,
    ),
    authorizationContext: jsonb("authorization_context")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("order_financial_events_idempotency_unique").on(
      t.orderId,
      t.idempotencyKey,
    ),
    index("order_financial_events_reversal_idx").on(t.reversesEventId),
    index("order_financial_events_order_idx").on(t.orderId, t.recordedAt),
    index("order_financial_events_type_idx").on(t.eventType, t.recordedAt),
    check(
      "order_financial_events_event_type_valid",
      sql`${t.eventType} IN ('ORDER_CREATED', 'PAYMENT_CAPTURED', 'PAYMENT_REFUNDED', 'ORDER_COMPLETED', 'ORDER_CANCELLED', 'COMMISSION_ACCRUED', 'COMMISSION_REVERSED', 'SELLER_PAYABLE_DUE', 'REFUND_OBLIGATION_OPENED', 'REFUND_OBLIGATION_RESOLVED')`,
    ),
    check(
      "order_financial_events_obligation_valid",
      sql`${t.accountObligation} IN ('BUYER_RECEIVABLE', 'BUYER_PAYMENT', 'BUYER_REFUND', 'SELLER_PAYABLE', 'PLATFORM_COMMISSION', 'REFUND_OBLIGATION', 'NONE')`,
    ),
    check(
      "order_financial_events_actor_valid",
      sql`${t.actorType} IN ('BUYER', 'SELLER', 'SYSTEM', 'ADMIN', 'PROVIDER')`,
    ),
    check("order_financial_events_amount_valid", sql`${t.amountMinor} >= 0`),
    check(
      "order_financial_events_currency_valid",
      sql`char_length(${t.currencyCode}) = 3`,
    ),
  ],
);
export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .unique()
      .references(() => orders.id),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id),
    providerKey: text("provider_key").notNull(),
    providerIntentId: text("provider_intent_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    capturedAmountMinor: integer("captured_amount_minor").default(0).notNull(),
    refundedAmountMinor: integer("refunded_amount_minor").default(0).notNull(),
    disputeId: text("dispute_id").references(() => disputes.id),
    currencyCode: text("currency_code").notNull(),
    status: text("status").default("SIMULATION_PENDING").notNull(),
    mode: text("mode").default("SIMULATION_ONLY").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("payment_intents_buyer_idempotency_unique").on(
      t.buyerId,
      t.idempotencyKey,
    ),
    uniqueIndex("payment_intents_provider_id_unique").on(
      t.providerKey,
      t.providerIntentId,
    ),
    uniqueIndex("payment_intents_dispute_id_unique").on(t.disputeId),
    index("payment_intents_status_created_idx").on(t.status, t.createdAt),
    check("payment_intents_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "payment_intents_capture_refund_bounds",
      sql`${t.capturedAmountMinor} >= 0 AND ${t.capturedAmountMinor} <= ${t.amountMinor} AND ${t.refundedAmountMinor} >= 0 AND ${t.refundedAmountMinor} <= ${t.capturedAmountMinor}`,
    ),
    check(
      "payment_intents_status_valid",
      sql`${t.status} IN ('SIMULATION_PENDING', 'SIMULATION_CAPTURED', 'SIMULATION_PARTIALLY_REFUNDED', 'SIMULATION_REFUNDED', 'SIMULATION_FAILED', 'SIMULATION_DISPUTED', 'SIMULATION_BUYER_REFUND_DUE', 'SIMULATION_SELLER_RELEASE_DUE')`,
    ),
    check(
      "payment_intents_simulation_only",
      sql`${t.mode} = 'SIMULATION_ONLY'`,
    ),
  ],
);
export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    id: text("id").primaryKey(),
    paymentIntentId: text("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    providerRefundId: text("provider_refund_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    reason: text("reason").default("").notNull(),
    status: text("status").default("REQUESTED").notNull(),
    mode: text("mode").default("SIMULATION_ONLY").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("payment_refunds_intent_idempotency_unique").on(
      t.paymentIntentId,
      t.idempotencyKey,
    ),
    uniqueIndex("payment_refunds_provider_id_unique").on(
      t.providerRefundId,
    ),
    index("payment_refunds_intent_status_idx").on(
      t.paymentIntentId,
      t.status,
    ),
    check("payment_refunds_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "payment_refunds_status_valid",
      sql`${t.status} IN ('REQUESTED', 'SIMULATED_COMPLETED', 'FAILED')`,
    ),
    check("payment_refunds_simulation_only", sql`${t.mode} = 'SIMULATION_ONLY'`),
  ],
);
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    paymentIntentId: text("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    refundId: text("refund_id").references(() => paymentRefunds.id),
    providerKey: text("provider_key").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    mode: text("mode").default("SIMULATION_ONLY").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("payment_events_provider_event_unique").on(
      t.providerKey,
      t.providerEventId,
    ),
    index("payment_events_intent_created_idx").on(
      t.paymentIntentId,
      t.createdAt,
    ),
    check(
      "payment_events_type_valid",
      sql`${t.eventType} IN ('CAPTURE_SUCCEEDED', 'REFUND_SUCCEEDED', 'REFUND_FAILED')`,
    ),
    check("payment_events_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "payment_events_payload_sha256_valid",
      sql`${t.payloadSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check("payment_events_simulation_only", sql`${t.mode} = 'SIMULATION_ONLY'`),
  ],
);
/**
 * A verified payment the platform owes back because its order was cancelled (reservation
 * expiry, or a capture that arrived after cancellation). One per intent; append-only except
 * OPEN → RESOLVED, which requires the provider's REFUND_SUCCEEDED event (enforced by triggers).
 */
export const paymentRefundObligations = pgTable(
  "payment_refund_obligations",
  {
    id: text("id").primaryKey(),
    paymentIntentId: text("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    sourcePaymentEventId: text("source_payment_event_id")
      .notNull()
      .references(() => paymentEvents.id),
    reason: text("reason").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    status: text("status").default("OPEN").notNull(),
    resolvedRefundEventId: text("resolved_refund_event_id").references(
      () => paymentEvents.id,
    ),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    mode: text("mode").default("SIMULATION_ONLY").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("payment_refund_obligations_intent_unique").on(t.paymentIntentId),
    uniqueIndex("payment_refund_obligations_source_event_unique").on(
      t.sourcePaymentEventId,
    ),
    index("payment_refund_obligations_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    check(
      "payment_refund_obligations_reason_valid",
      sql`${t.reason} IN ('RESERVATION_EXPIRED', 'CAPTURE_AFTER_CANCELLATION')`,
    ),
    check(
      "payment_refund_obligations_amount_positive",
      sql`${t.amountMinor} > 0`,
    ),
    check(
      "payment_refund_obligations_status_valid",
      sql`${t.status} IN ('OPEN', 'RESOLVED')`,
    ),
    check(
      "payment_refund_obligations_resolution_evidence",
      sql`(${t.status} = 'OPEN' AND ${t.resolvedRefundEventId} IS NULL AND ${t.resolvedAt} IS NULL) OR (${t.status} = 'RESOLVED' AND ${t.resolvedRefundEventId} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL)`,
    ),
    check(
      "payment_refund_obligations_simulation_only",
      sql`${t.mode} = 'SIMULATION_ONLY'`,
    ),
  ],
);
export const paymentDisputeEvents = pgTable(
  "payment_dispute_events",
  {
    id: text("id").primaryKey(),
    paymentIntentId: text("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    disputeId: text("dispute_id")
      .notNull()
      .references(() => disputes.id),
    sourcePaymentEventId: text("source_payment_event_id").references(
      () => paymentEvents.id,
    ),
    eventType: text("event_type").notNull(),
    financialOutcome: text("financial_outcome").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    commissionRateBps: integer("commission_rate_bps").notNull(),
    platformFeeMinor: integer("platform_fee_minor").notNull(),
    sellerAmountMinor: integer("seller_amount_minor").notNull(),
    mode: text("mode").default("SIMULATION_ONLY").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("payment_dispute_events_intent_dispute_type_unique").on(
      t.paymentIntentId,
      t.disputeId,
      t.eventType,
    ),
    uniqueIndex("payment_dispute_events_source_event_unique").on(
      t.sourcePaymentEventId,
    ),
    check(
      "payment_dispute_events_type_valid",
      sql`${t.eventType} IN ('DISPUTE_OPENED', 'PAYMENT_CAPTURED', 'DISPUTE_RESOLVED')`,
    ),
    check(
      "payment_dispute_events_outcome_valid",
      sql`${t.financialOutcome} IN ('HOLD_PENDING', 'HOLD_CAPTURED', 'BUYER_REFUND_DUE', 'SELLER_RELEASE_DUE')`,
    ),
    check("payment_dispute_events_amount_nonnegative", sql`${t.amountMinor} >= 0`),
    check(
      "payment_dispute_events_commission_bps_valid",
      sql`${t.commissionRateBps} BETWEEN 0 AND 10000`,
    ),
    check(
      "payment_dispute_events_order_snapshot_nonnegative",
      sql`${t.platformFeeMinor} >= 0 AND ${t.sellerAmountMinor} >= 0`,
    ),
    check(
      "payment_dispute_events_simulation_only",
      sql`${t.mode} = 'SIMULATION_ONLY'`,
    ),
  ],
);
export const paymentReconciliationRuns = pgTable(
  "payment_reconciliation_runs",
  {
    id: text("id").primaryKey(),
    providerKey: text("provider_key").notNull(),
    status: text("status").notNull(),
    matchedCount: integer("matched_count").default(0).notNull(),
    mismatchCount: integer("mismatch_count").default(0).notNull(),
    mode: text("mode").default("SIMULATION_ONLY").notNull(),
    ...dates(),
  },
  (t) => [
    index("payment_reconciliation_runs_created_idx").on(t.createdAt),
    check(
      "payment_reconciliation_runs_status_valid",
      sql`${t.status} IN ('MATCHED', 'MISMATCHED')`,
    ),
    check(
      "payment_reconciliation_runs_counts_valid",
      sql`${t.matchedCount} >= 0 AND ${t.mismatchCount} >= 0`,
    ),
    check(
      "payment_reconciliation_runs_simulation_only",
      sql`${t.mode} = 'SIMULATION_ONLY'`,
    ),
  ],
);
export const paymentReconciliationItems = pgTable(
  "payment_reconciliation_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => paymentReconciliationRuns.id),
    paymentIntentId: text("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    result: text("result").notNull(),
    localStatus: text("local_status").notNull(),
    providerStatus: text("provider_status"),
    localCapturedAmountMinor: integer("local_captured_amount_minor").notNull(),
    providerCapturedAmountMinor: integer("provider_captured_amount_minor"),
    localRefundedAmountMinor: integer("local_refunded_amount_minor").notNull(),
    providerRefundedAmountMinor: integer("provider_refunded_amount_minor"),
    mode: text("mode").default("SIMULATION_ONLY").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("payment_reconciliation_items_run_intent_unique").on(
      t.runId,
      t.paymentIntentId,
    ),
    check(
      "payment_reconciliation_items_result_valid",
      sql`${t.result} IN ('MATCH', 'MISMATCH')`,
    ),
    check(
      "payment_reconciliation_items_simulation_only",
      sql`${t.mode} = 'SIMULATION_ONLY'`,
    ),
  ],
);

/**
 * Wave 08: direct buyer→seller cash. A buyer's "I paid" is a claim, not proof. Only the
 * seller's confirmation attests that cash was received; only the buyer's later confirmation
 * attests that a cash refund was repaid. No row here moves money through the platform.
 */
export const cashPaymentClaims = pgTable(
  "cash_payment_claims",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    status: text("status").default("CLAIMED").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => users.id),
    decisionReason: text("decision_reason"),
    evidence: jsonb("evidence").$type<unknown[]>().default([]).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    mode: text("mode").default("CASH_DIRECT").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("cash_payment_claims_order_unique").on(t.orderId),
    uniqueIndex("cash_payment_claims_buyer_key_unique").on(
      t.buyerId,
      t.idempotencyKey,
    ),
    index("cash_payment_claims_status_idx").on(t.status, t.createdAt),
    check("cash_payment_claims_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "cash_payment_claims_currency_valid",
      sql`char_length(${t.currencyCode}) = 3`,
    ),
    check(
      "cash_payment_claims_status_valid",
      sql`${t.status} IN ('CLAIMED', 'CONFIRMED', 'DENIED', 'DISPUTED')`,
    ),
    check("cash_payment_claims_mode_valid", sql`${t.mode} = 'CASH_DIRECT'`),
    check(
      "cash_payment_claims_decision_valid",
      sql`(${t.status} = 'CLAIMED' AND ${t.decidedAt} IS NULL AND ${t.decidedBy} IS NULL AND ${t.decisionReason} IS NULL) OR (${t.status} IN ('CONFIRMED', 'DENIED', 'DISPUTED') AND ${t.decidedAt} IS NOT NULL AND ${t.decidedBy} IS NOT NULL)`,
    ),
  ],
);
/**
 * A cash refund is its own engine. The case can exist as OPEN before any repayment happens;
 * a seller's repayment claim is unverified until the buyer confirms receiving the cash.
 */
export const cashRefundCases = pgTable(
  "cash_refund_cases",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    paymentClaimId: text("payment_claim_id")
      .notNull()
      .references(() => cashPaymentClaims.id),
    openedBy: text("opened_by")
      .notNull()
      .references(() => users.id),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    reason: text("reason").default("").notNull(),
    status: text("status").default("OPEN").notNull(),
    repaymentClaimedAt: timestamp("repayment_claimed_at", { withTimezone: true }),
    repaymentNote: text("repayment_note"),
    repaymentEvidence: jsonb("repayment_evidence")
      .$type<unknown[]>()
      .default([])
      .notNull(),
    buyerConfirmedAt: timestamp("buyer_confirmed_at", { withTimezone: true }),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    disputeReason: text("dispute_reason"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    mode: text("mode").default("CASH_DIRECT").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("cash_refund_cases_opener_key_unique").on(
      t.openedBy,
      t.idempotencyKey,
    ),
    index("cash_refund_cases_order_idx").on(t.orderId, t.createdAt),
    index("cash_refund_cases_status_idx").on(t.status, t.createdAt),
    check("cash_refund_cases_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "cash_refund_cases_currency_valid",
      sql`char_length(${t.currencyCode}) = 3`,
    ),
    check(
      "cash_refund_cases_status_valid",
      sql`${t.status} IN ('OPEN', 'REPAYMENT_CLAIMED', 'CONFIRMED', 'DISPUTED', 'WITHDRAWN')`,
    ),
    check("cash_refund_cases_mode_valid", sql`${t.mode} = 'CASH_DIRECT'`),
    check(
      "cash_refund_cases_evidence_valid",
      sql`(${t.status} <> 'REPAYMENT_CLAIMED' OR ${t.repaymentClaimedAt} IS NOT NULL) AND (${t.status} <> 'CONFIRMED' OR ${t.buyerConfirmedAt} IS NOT NULL) AND (${t.status} <> 'DISPUTED' OR (${t.disputedAt} IS NOT NULL AND ${t.disputeReason} IS NOT NULL)) AND (${t.status} <> 'WITHDRAWN' OR ${t.withdrawnAt} IS NOT NULL)`,
    ),
  ],
);

// Wave 3: one report authority for every reportable marketplace target.
export const moderationReasonCodes = pgTable(
  "moderation_reason_codes",
  {
    code: text("code").primaryKey(),
    labelAr: text("label_ar").notNull(),
    labelEn: text("label_en").notNull(),
    targetTypes: jsonb("target_types").$type<string[]>().notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    ...dates(),
  },
  (t) => [
    check("moderation_reason_code_format", sql`${t.code} ~ '^[A-Z][A-Z_]{1,40}$'`),
  ],
);
export const marketplaceReports = pgTable(
  "marketplace_reports",
  {
    id: text("id").primaryKey(),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    reasonCode: text("reason_code")
      .notNull()
      .references(() => moderationReasonCodes.code),
    note: text("note").default("").notNull(),
    status: text("status").default("OPEN").notNull(),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    ...dates(),
  },
  (t) => [
    check(
      "marketplace_reports_target_type_valid",
      sql`${t.targetType} IN ('LISTING', 'USER', 'ORDER')`,
    ),
    check(
      "marketplace_reports_status_valid",
      sql`${t.status} IN ('OPEN', 'DISMISSED', 'ACTIONED')`,
    ),
    check(
      "marketplace_reports_resolution_consistent",
      sql`(${t.status} = 'OPEN') = (${t.resolvedAt} IS NULL AND ${t.resolvedBy} IS NULL)`,
    ),
    check("marketplace_reports_note_length", sql`char_length(${t.note}) <= 1000`),
    uniqueIndex("marketplace_reports_open_unique")
      .on(t.reporterId, t.targetType, t.targetId)
      .where(sql`${t.status} = 'OPEN'`),
    index("marketplace_reports_status_created_idx").on(t.status, t.createdAt),
    index("marketplace_reports_target_idx").on(t.targetType, t.targetId),
    index("marketplace_reports_reporter_created_idx").on(t.reporterId, t.createdAt),
  ],
);
// Append-only: migration 0013 installs a trigger rejecting UPDATE and DELETE.
export const moderationAudit = pgTable(
  "moderation_audit",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    reportId: text("report_id").references(() => marketplaceReports.id),
    reason: text("reason").default("").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("moderation_audit_target_idx").on(t.targetType, t.targetId, t.createdAt),
    index("moderation_audit_actor_idx").on(t.actorId, t.createdAt),
  ],
);
export const marketplacePolicyRules = pgTable(
  "marketplace_policy_rules",
  {
    id: text("id").primaryKey(),
    // NULL applies to every market.
    marketId: text("market_id").references(() => markets.id),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    reasonCode: text("reason_code")
      .notNull()
      .references(() => moderationReasonCodes.code),
    note: text("note").default("").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdBy: text("created_by").references(() => users.id),
    updatedBy: text("updated_by").references(() => users.id),
    ...dates(),
  },
  (t) => [
    check(
      "marketplace_policy_rules_kind_valid",
      sql`${t.kind} IN ('CATEGORY', 'RESOURCE_TYPE', 'FULFILMENT', 'TERM')`,
    ),
    check(
      "marketplace_policy_rules_value_valid",
      sql`char_length(btrim(${t.value})) BETWEEN 1 AND 120`,
    ),
    index("marketplace_policy_rules_active_idx").on(t.isActive, t.kind),
  ],
);
export const policyAcceptances = pgTable(
  "policy_acceptances",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    policyKey: text("policy_key").notNull(),
    policyVersion: text("policy_version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: "policy_acceptances_pkey",
      columns: [t.userId, t.policyKey, t.policyVersion],
    }),
  ],
);

// Block C — employment. Jobs, candidate profiles and applications are domain
// authorities; conversation, result sets, auth and moderation stay shared.
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    status: text("status").notNull(),
    title: text("title").notNull(),
    description: text("description").default("").notNull(),
    skills: jsonb("skills").$type<string[]>().default([]).notNull(),
    minExperienceYears: integer("min_experience_years"),
    city: text("city").default("").notNull(),
    area: text("area").default("").notNull(),
    workplaceMode: text("workplace_mode").notNull(),
    employmentType: text("employment_type").notNull(),
    salaryMinMinor: integer("salary_min_minor"),
    salaryMaxMinor: integer("salary_max_minor"),
    salaryCurrency: text("salary_currency"),
    salaryPeriod: text("salary_period"),
    // Every edit increments the version that application snapshots record.
    version: integer("version").default(1).notNull(),
    // Idempotency: one logical job per employer draft.
    publishKey: text("publish_key").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    check("jobs_status_valid", sql`${t.status} IN ('PUBLISHED', 'PAUSED', 'CLOSED', 'ARCHIVED')`),
    check("jobs_title_length", sql`char_length(btrim(${t.title})) BETWEEN 2 AND 120`),
    check("jobs_description_length", sql`char_length(${t.description}) <= 4000`),
    check("jobs_skills_array", sql`jsonb_typeof(${t.skills}) = 'array' AND jsonb_array_length(${t.skills}) <= 30`),
    check("jobs_experience_valid", sql`${t.minExperienceYears} IS NULL OR ${t.minExperienceYears} BETWEEN 0 AND 50`),
    check("jobs_workplace_mode_valid", sql`${t.workplaceMode} IN ('ONSITE', 'REMOTE', 'HYBRID')`),
    check("jobs_employment_type_valid", sql`${t.employmentType} IN ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP')`),
    check("jobs_location_valid", sql`${t.workplaceMode} = 'REMOTE' OR char_length(btrim(${t.city})) > 0`),
    check(
      "jobs_salary_valid",
      sql`(${t.salaryMinMinor} IS NULL AND ${t.salaryMaxMinor} IS NULL AND ${t.salaryCurrency} IS NULL AND ${t.salaryPeriod} IS NULL) OR (${t.salaryMinMinor} IS NOT NULL AND ${t.salaryMinMinor} >= 1 AND (${t.salaryMaxMinor} IS NULL OR ${t.salaryMaxMinor} >= ${t.salaryMinMinor}) AND ${t.salaryCurrency} IS NOT NULL AND ${t.salaryPeriod} IN ('HOUR', 'DAY', 'MONTH', 'YEAR'))`,
    ),
    check(
      "jobs_lifecycle_consistent",
      sql`(${t.status} IN ('PUBLISHED', 'PAUSED') AND ${t.closedAt} IS NULL AND ${t.archivedAt} IS NULL) OR (${t.status} = 'CLOSED' AND ${t.closedAt} IS NOT NULL AND ${t.archivedAt} IS NULL) OR (${t.status} = 'ARCHIVED' AND ${t.archivedAt} IS NOT NULL)`,
    ),
    check("jobs_version_positive", sql`${t.version} >= 1`),
    uniqueIndex("jobs_owner_publish_key_unique").on(t.ownerUserId, t.publishKey),
    index("jobs_market_status_published_idx").on(t.marketId, t.status, t.publishedAt),
    index("jobs_owner_updated_idx").on(t.ownerUserId, t.updatedAt),
  ],
);
export const candidateProfiles = pgTable(
  "candidate_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    professionalTitle: text("professional_title").default("").notNull(),
    summary: text("summary").default("").notNull(),
    skills: jsonb("skills").$type<string[]>().default([]).notNull(),
    experienceYears: integer("experience_years"),
    experiences: jsonb("experiences").$type<Record<string, unknown>[]>().default([]).notNull(),
    education: jsonb("education").$type<Record<string, unknown>[]>().default([]).notNull(),
    city: text("city").default("").notNull(),
    area: text("area").default("").notNull(),
    workplacePreferences: jsonb("workplace_preferences").$type<string[]>().default([]).notNull(),
    employmentTypePreferences: jsonb("employment_type_preferences").$type<string[]>().default([]).notNull(),
    portfolioLinks: jsonb("portfolio_links").$type<string[]>().default([]).notNull(),
    // The account login phone is never used; a profile phone is chosen explicitly.
    contactMode: text("contact_mode").default("NO_DIRECT_CONTACT").notNull(),
    contactPhone: text("contact_phone"),
    // Privacy-preserving default: a candidate must opt in to discovery.
    visibility: text("visibility").default("PRIVATE").notNull(),
    ...dates(),
  },
  (t) => [
    check("candidate_profiles_visibility_valid", sql`${t.visibility} IN ('PRIVATE', 'DISCOVERABLE')`),
    check("candidate_profiles_contact_mode_valid", sql`${t.contactMode} IN ('NO_DIRECT_CONTACT', 'PROFILE_CONTACT')`),
    check(
      "candidate_profiles_contact_consistent",
      sql`(${t.contactMode} = 'PROFILE_CONTACT') = (${t.contactPhone} IS NOT NULL)`,
    ),
    check("candidate_profiles_experience_valid", sql`${t.experienceYears} IS NULL OR ${t.experienceYears} BETWEEN 0 AND 60`),
    check("candidate_profiles_title_length", sql`char_length(${t.professionalTitle}) <= 120`),
    check("candidate_profiles_summary_length", sql`char_length(${t.summary}) <= 2000`),
    check(
      "candidate_profiles_arrays",
      sql`jsonb_typeof(${t.skills}) = 'array' AND jsonb_array_length(${t.skills}) <= 40 AND jsonb_typeof(${t.experiences}) = 'array' AND jsonb_array_length(${t.experiences}) <= 20 AND jsonb_typeof(${t.education}) = 'array' AND jsonb_array_length(${t.education}) <= 10 AND jsonb_typeof(${t.portfolioLinks}) = 'array' AND jsonb_array_length(${t.portfolioLinks}) <= 5`,
    ),
    index("candidate_profiles_market_visibility_idx").on(t.marketId, t.visibility),
  ],
);
export const jobApplications = pgTable(
  "job_applications",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    candidateUserId: text("candidate_user_id")
      .notNull()
      .references(() => users.id),
    candidateProfileId: text("candidate_profile_id")
      .notNull()
      .references(() => candidateProfiles.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    status: text("status").default("SUBMITTED").notNull(),
    // What the employer and candidate saw at submission; current rows may change later.
    jobSnapshot: jsonb("job_snapshot").$type<Record<string, unknown>>().notNull(),
    candidateSnapshot: jsonb("candidate_snapshot").$type<Record<string, unknown>>().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    // Status changes are always made by an authorized human actor.
    statusChangedBy: text("status_changed_by").references(() => users.id),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    check(
      "job_applications_status_valid",
      sql`${t.status} IN ('SUBMITTED', 'VIEWED', 'SHORTLISTED', 'REJECTED', 'WITHDRAWN')`,
    ),
    check(
      "job_applications_withdrawal_consistent",
      sql`(${t.status} = 'WITHDRAWN') = (${t.withdrawnAt} IS NOT NULL)`,
    ),
    check(
      "job_applications_status_actor_consistent",
      sql`(${t.statusChangedBy} IS NULL) = (${t.statusChangedAt} IS NULL)`,
    ),
    uniqueIndex("job_applications_job_candidate_unique").on(t.jobId, t.candidateUserId),
    index("job_applications_job_submitted_idx").on(t.jobId, t.submittedAt),
    index("job_applications_candidate_submitted_idx").on(t.candidateUserId, t.submittedAt),
  ],
);

/**
 * Block D fulfilment execution metadata for an existing order. The order stays the
 * commerce authority (parties, items, price, commission, payment, completion); this
 * row records only the selected method and its server-validated delivery state.
 */
export const orderFulfillments = pgTable(
  "order_fulfillments",
  {
    orderId: text("order_id")
      .primaryKey()
      .references(() => orders.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    method: text("method").notNull(),
    status: text("status").default("REQUESTED").notNull(),
    failureReason: text("failure_reason"),
    selectedBy: text("selected_by")
      .notNull()
      .references(() => users.id),
    // NULL when the platform settled the state (expiry, dispute resolution).
    statusChangedBy: text("status_changed_by").references(() => users.id),
    version: integer("version").default(1).notNull(),
    ...dates(),
  },
  (t) => [
    check(
      "order_fulfillments_method_valid",
      sql`${t.method} IN ('PICKUP', 'SELLER_DELIVERY', 'COURIER', 'EXTERNAL_PROVIDER')`,
    ),
    check(
      "order_fulfillments_status_valid",
      sql`${t.status} IN ('REQUESTED', 'ACCEPTED', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED')`,
    ),
    check(
      "order_fulfillments_status_method_consistent",
      sql`(${t.method} = 'PICKUP' AND ${t.status} IN ('REQUESTED', 'READY_FOR_PICKUP', 'PICKED_UP', 'CANCELLED', 'FAILED')) OR (${t.method} <> 'PICKUP' AND ${t.status} IN ('REQUESTED', 'ACCEPTED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED'))`,
    ),
    check(
      "order_fulfillments_failure_consistent",
      sql`(${t.status} = 'FAILED') = (${t.failureReason} IS NOT NULL) AND (${t.failureReason} IS NULL OR ${t.failureReason} IN ('BUYER_UNAVAILABLE', 'ADDRESS_UNREACHABLE', 'SELLER_UNABLE', 'OTHER'))`,
    ),
    check("order_fulfillments_version_positive", sql`${t.version} >= 1`),
  ],
);
/**
 * One current, purpose-scoped location snapshot per order. Changing it replaces the
 * row; there is no location history, movement trail or tracking stream. Precise
 * fields are cleared (redactedAt) once the order no longer needs them.
 */
export const transactionLocations = pgTable(
  "transaction_locations",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    purpose: text("purpose").notNull(),
    source: text("source").notNull(),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    accuracyMeters: integer("accuracy_meters"),
    city: text("city").default("").notNull(),
    area: text("area").default("").notNull(),
    addressText: text("address_text"),
    note: text("note"),
    sharedBy: text("shared_by")
      .notNull()
      .references(() => users.id),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    uniqueIndex("transaction_locations_order_purpose_unique").on(t.orderId, t.purpose),
    check(
      "transaction_locations_purpose_valid",
      sql`${t.purpose} IN ('DELIVERY_DESTINATION', 'PICKUP_POINT', 'SERVICE_APPOINTMENT')`,
    ),
    check("transaction_locations_source_valid", sql`${t.source} IN ('DEVICE', 'MANUAL')`),
    check(
      "transaction_locations_coordinates_paired",
      sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`,
    ),
    check(
      "transaction_locations_coordinates_range",
      sql`${t.latitude} IS NULL OR (${t.latitude} BETWEEN -90 AND 90 AND ${t.longitude} BETWEEN -180 AND 180)`,
    ),
    check(
      "transaction_locations_accuracy_range",
      sql`${t.accuracyMeters} IS NULL OR ${t.accuracyMeters} BETWEEN 0 AND 100000`,
    ),
    check(
      "transaction_locations_text_lengths",
      sql`char_length(${t.city}) <= 100 AND char_length(${t.area}) <= 100 AND (${t.addressText} IS NULL OR char_length(${t.addressText}) <= 300) AND (${t.note} IS NULL OR char_length(${t.note}) <= 300)`,
    ),
    check(
      "transaction_locations_content_present",
      sql`${t.redactedAt} IS NOT NULL OR (${t.source} = 'DEVICE' AND ${t.latitude} IS NOT NULL) OR (${t.source} = 'MANUAL' AND ${t.addressText} IS NOT NULL)`,
    ),
    check(
      "transaction_locations_redaction_consistent",
      sql`${t.redactedAt} IS NULL OR (${t.latitude} IS NULL AND ${t.accuracyMeters} IS NULL AND ${t.addressText} IS NULL AND ${t.note} IS NULL)`,
    ),
  ],
);
/**
 * Block F4: a user's delivery-driver capability in one market. Not a role flag: the
 * profile has a server lifecycle (DRAFT → PENDING_VERIFICATION → APPROVED / SUSPENDED)
 * that only an administrator moves to APPROVED, and availability is the driver's own
 * explicit statement, never inferred. No location, history or earnings live here.
 */
export const driverProfiles = pgTable(
  "driver_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    status: text("status").default("DRAFT").notNull(),
    availability: text("availability").default("UNAVAILABLE").notNull(),
    vehicleType: text("vehicle_type"),
    // Coarse operating city; never a coordinate.
    serviceCity: text("service_city"),
    reviewedBy: text("reviewed_by").references(() => users.id),
    version: integer("version").default(1).notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("driver_profiles_user_market_unique").on(t.userId, t.marketId),
    check("driver_profiles_status_valid", sql`${t.status} IN ('DRAFT', 'PENDING_VERIFICATION', 'APPROVED', 'SUSPENDED')`),
    check("driver_profiles_availability_valid", sql`${t.availability} IN ('AVAILABLE', 'UNAVAILABLE')`),
    // Only an approved driver can be available, whatever path wrote the row.
    check("driver_profiles_available_requires_approval", sql`${t.availability} = 'UNAVAILABLE' OR ${t.status} = 'APPROVED'`),
    check("driver_profiles_vehicle_valid", sql`${t.vehicleType} IS NULL OR ${t.vehicleType} IN ('CAR', 'MOTORCYCLE', 'BICYCLE')`),
    check("driver_profiles_city_length", sql`${t.serviceCity} IS NULL OR char_length(${t.serviceCity}) BETWEEN 1 AND 100`),
    check("driver_profiles_version_positive", sql`${t.version} >= 1`),
  ],
);
/**
 * Block F4: which driver is authorized to carry a COURIER order. Delivery progress stays
 * in order_fulfillments (Block D); an assignment is only ACCEPTED or RELEASED, and at
 * most one ACCEPTED assignment can exist per order.
 */
export const deliveryAssignments = pgTable(
  "delivery_assignments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    driverProfileId: text("driver_profile_id")
      .notNull()
      .references(() => driverProfiles.id),
    driverId: text("driver_id")
      .notNull()
      .references(() => users.id),
    status: text("status").default("ACCEPTED").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    uniqueIndex("delivery_assignments_one_active_per_order").on(t.orderId).where(sql`${t.status} = 'ACCEPTED'`),
    index("delivery_assignments_driver_status_idx").on(t.driverId, t.status),
    check("delivery_assignments_status_valid", sql`${t.status} IN ('ACCEPTED', 'RELEASED')`),
    check("delivery_assignments_release_consistent", sql`(${t.status} = 'RELEASED') = (${t.releasedAt} IS NOT NULL)`),
  ],
);
/** Append-only, actor-authorized courier/buyer progress for one order. */
export const deliveryProgressEvents = pgTable(
  "delivery_progress_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    assignmentId: text("assignment_id").references(() => deliveryAssignments.id),
    actorId: text("actor_id").notNull().references(() => users.id),
    type: text("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("delivery_progress_order_type_unique").on(t.orderId, t.type),
    index("delivery_progress_order_created_idx").on(t.orderId, t.createdAt),
    check("delivery_progress_event_type_valid", sql`${t.type} IN ('PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'HANDED_OFF', 'BUYER_RECEIVED')`),
    check("delivery_progress_assignment_event_consistent", sql`(${t.type} = 'BUYER_RECEIVED') = (${t.assignmentId} IS NULL)`),
  ],
);
/**
 * G1 provider boundary. A connection binds one owner account to one market and an
 * explicit scope allowlist; it never owns business data. Provider resources are
 * ordinary offers / driver_profiles, reached only through provider_resource_mappings.
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    name: text("name").notNull(),
    status: text("status").default("ACTIVE").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    index("provider_connections_owner_idx").on(t.ownerUserId, t.createdAt),
    check("provider_connections_status_valid", sql`${t.status} IN ('ACTIVE', 'REVOKED')`),
    check("provider_connections_revoked_consistent", sql`(${t.status} = 'REVOKED') = (${t.revokedAt} IS NOT NULL)`),
    check("provider_connections_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 80`),
  ],
);
/** Only a SHA-256 of the 256-bit secret is stored; key_id is the public lookup prefix. */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => providerConnections.id),
    keyId: text("key_id").notNull().unique(),
    secretHash: text("secret_hash").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("provider_credentials_one_active_per_connection").on(t.connectionId).where(sql`${t.revokedAt} IS NULL`),
  ],
);
/** One external reference per connection and kind, one provider link per DINAR resource. */
export const providerResourceMappings = pgTable(
  "provider_resource_mappings",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => providerConnections.id),
    resourceType: text("resource_type").notNull(),
    externalRef: text("external_ref").notNull(),
    resourceId: text("resource_id").notNull(),
    payloadHash: text("payload_hash"),
    ...dates(),
  },
  (t) => [
    uniqueIndex("provider_resource_mappings_external_unique").on(t.connectionId, t.resourceType, t.externalRef),
    uniqueIndex("provider_resource_mappings_resource_unique").on(t.resourceType, t.resourceId),
    check("provider_resource_mappings_type_valid", sql`${t.resourceType} IN ('LISTING', 'DRIVER_PROFILE')`),
    check("provider_resource_mappings_ref_valid", sql`${t.externalRef} ~ '^[A-Za-z0-9._:-]{1,100}$'`),
  ],
);
/**
 * G2 price negotiation. One generic authority for any negotiable listing (products and
 * services alike). Parties are server-derived: seller = listing owner, buyer = the
 * authenticated actor. An agreed amount is private to this buyer and never changes the
 * public listing price; checkout consumes it once by setting order_id.
 */
export const negotiations = pgTable(
  "negotiations",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id")
      .notNull()
      .references(() => offers.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => users.id),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull(),
    currencyCode: text("currency_code").notNull(),
    minorUnitScale: integer("minor_unit_scale").notNull(),
    listedPriceMinor: integer("listed_price_minor"),
    offerAmountMinor: integer("offer_amount_minor"),
    counterAmountMinor: integer("counter_amount_minor"),
    agreedAmountMinor: integer("agreed_amount_minor"),
    quantity: integer("quantity").default(1).notNull(),
    lastActor: text("last_actor").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    orderId: text("order_id")
      .unique()
      .references(() => orders.id),
    version: integer("version").default(1).notNull(),
    ...dates(),
  },
  (t) => [
    index("negotiations_buyer_idx").on(t.buyerId, t.updatedAt),
    index("negotiations_seller_status_idx").on(t.sellerId, t.status),
    uniqueIndex("negotiations_one_active_per_buyer_listing")
      .on(t.listingId, t.buyerId)
      .where(sql`${t.status} IN ('OPEN', 'COUNTERED')`),
    check("negotiations_status_valid", sql`${t.status} IN ('OPEN', 'COUNTERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED')`),
    check("negotiations_last_actor_valid", sql`${t.lastActor} IN ('BUYER', 'SELLER')`),
    check("negotiations_parties_distinct", sql`${t.buyerId} <> ${t.sellerId}`),
    check(
      "negotiations_amounts_positive",
      sql`(${t.listedPriceMinor} IS NULL OR ${t.listedPriceMinor} >= 1) AND (${t.offerAmountMinor} IS NULL OR ${t.offerAmountMinor} >= 1) AND (${t.counterAmountMinor} IS NULL OR ${t.counterAmountMinor} >= 1) AND ${t.quantity} >= 1`,
    ),
    check("negotiations_countered_has_counter", sql`${t.status} <> 'COUNTERED' OR ${t.counterAmountMinor} IS NOT NULL`),
    check("negotiations_agreed_consistent", sql`(${t.status} = 'ACCEPTED') = (${t.agreedAmountMinor} IS NOT NULL AND ${t.agreedAmountMinor} >= 1)`),
    check("negotiations_order_requires_accepted", sql`${t.orderId} IS NULL OR ${t.status} = 'ACCEPTED'`),
  ],
);

/** Append-only negotiation actions and price offers; thread rows point at the latest state. */
export const negotiationEvents = pgTable(
  "negotiation_events",
  {
    id: text("id").primaryKey(),
    negotiationId: text("negotiation_id")
      .notNull()
      .references(() => negotiations.id),
    version: integer("version").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id),
    actorRole: text("actor_role").notNull(),
    eventType: text("event_type").notNull(),
    amountMinor: integer("amount_minor"),
    currencyCode: text("currency_code").notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("negotiation_events_thread_version_uq").on(t.negotiationId, t.version),
    index("negotiation_events_thread_idx").on(t.negotiationId, t.createdAt),
    check("negotiation_events_role_valid", sql`${t.actorRole} IN ('BUYER', 'SELLER')`),
    check("negotiation_events_type_valid", sql`${t.eventType} IN ('BUYER_PRICE_OFFER', 'BEST_PRICE_REQUEST', 'SELLER_COUNTER_OFFER', 'BUYER_COUNTER_OFFER', 'ACCEPT', 'REJECT', 'WITHDRAW', 'EXPIRE')`),
    check("negotiation_events_amount_valid", sql`${t.amountMinor} IS NULL OR ${t.amountMinor} >= 1`),
  ],
);

// ════ DINAR NEXT G1: AI usage allowances ════════════════════════════════════
// Every user keeps the same AI capabilities; a plan tier only changes how much can be used.
// The reservation row is the ledger (one per idempotent request); counters are its
// materialised state, mutated only in the same transaction as a reservation transition.
// No prompt or reply text is ever stored here.

export const aiUsageReservations = pgTable(
  "ai_usage_reservations",
  {
    id: text("id").primaryKey(),
    /** `user:<id>` or `guest:<hmac>`; the global guard never has reservations of its own. */
    ownerKey: text("owner_key").notNull(),
    userId: text("user_id").references(() => users.id),
    marketId: text("market_id").references(() => markets.id),
    resource: text("resource").notNull(),
    planTier: text("plan_tier").notNull(),
    /** DEFAULT_FREE, GUEST or `subscription:<id>`: where the tier came from at reservation time. */
    entitlementSource: text("entitlement_source").notNull(),
    policyVersion: integer("policy_version").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    globalPeriodStart: timestamp("global_period_start", { withTimezone: true }).notNull(),
    /** Whether this reservation was counted against the global guard (settled the same way). */
    globalGuarded: boolean("global_guarded").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("RESERVED").notNull(),
    outcome: text("outcome"),
    reservedRequests: integer("reserved_requests").notNull(),
    reservedTokens: integer("reserved_tokens").notNull(),
    chargedRequests: integer("charged_requests").default(0).notNull(),
    chargedTokens: integer("charged_tokens").default(0).notNull(),
    providerCalls: integer("provider_calls").default(0).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    tokenSource: text("token_source"),
    provider: text("provider"),
    model: text("model"),
    attempts: integer("attempts").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    uniqueIndex("ai_usage_reservations_owner_key_unique").on(t.ownerKey, t.idempotencyKey),
    index("ai_usage_reservations_owner_status_idx").on(t.ownerKey, t.status, t.expiresAt),
    index("ai_usage_reservations_status_expiry_idx").on(t.status, t.expiresAt),
    check("ai_usage_reservations_status_valid", sql`${t.status} IN ('RESERVED', 'SETTLED', 'RELEASED', 'EXPIRED')`),
    check("ai_usage_reservations_outcome_valid", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('SUCCESS', 'PROVIDER_FAILED', 'TIMEOUT', 'INVALID_OUTPUT', 'ABANDONED', 'CANCELLED')`),
    check("ai_usage_reservations_tier_valid", sql`${t.planTier} IN ('GUEST', 'FREE', 'BUSINESS_GO', 'BUSINESS_PRO')`),
    check("ai_usage_reservations_resource_valid", sql`${t.resource} IN ('TEXT_REQUEST', 'MARKETING_GENERATION', 'BUSINESS_ANALYTICS', 'IMAGE_UNDERSTANDING', 'AGENT_MULTI_STEP', 'AUDIO_TRANSCRIPTION')`),
    check("ai_usage_reservations_amounts_valid", sql`${t.reservedRequests} >= 0 AND ${t.reservedTokens} >= 0 AND ${t.chargedRequests} >= 0 AND ${t.chargedTokens} >= 0 AND ${t.providerCalls} >= 0`),
    check("ai_usage_reservations_settled_consistent", sql`(${t.status} = 'RESERVED') = (${t.settledAt} IS NULL)`),
    check("ai_usage_reservations_token_source_valid", sql`${t.tokenSource} IS NULL OR ${t.tokenSource} IN ('PROVIDER_REPORTED', 'ESTIMATED', 'NONE')`),
    check("ai_usage_reservations_period_valid", sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);

/** Materialised totals per owner, period and resource (`ALL` holds the token budget). */
export const aiUsageCounters = pgTable(
  "ai_usage_counters",
  {
    ownerKey: text("owner_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    resource: text("resource").notNull(),
    reservedRequests: integer("reserved_requests").default(0).notNull(),
    consumedRequests: integer("consumed_requests").default(0).notNull(),
    reservedTokens: integer("reserved_tokens").default(0).notNull(),
    consumedTokens: integer("consumed_tokens").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerKey, t.periodStart, t.resource] }),
    check("ai_usage_counters_non_negative", sql`${t.reservedRequests} >= 0 AND ${t.consumedRequests} >= 0 AND ${t.reservedTokens} >= 0 AND ${t.consumedTokens} >= 0`),
    check("ai_usage_counters_resource_valid", sql`${t.resource} IN ('TEXT_REQUEST', 'MARKETING_GENERATION', 'BUSINESS_ANALYTICS', 'IMAGE_UNDERSTANDING', 'AGENT_MULTI_STEP', 'AUDIO_TRANSCRIPTION', 'ALL')`),
  ],
);

// ════ DINAR NEXT G2: buyer–seller inquiries mediated by DINAR ════════════════
// A listing-scoped thread between one buyer and one seller. Messages live in the shared
// `messages` table under a `conversations` row of kind INQUIRY (the same persistence as
// order threads); this header holds the parties, scope and state. Events are append-only and
// keep submission, in-app delivery, read and reply apart. Never a price offer: offers stay in
// the negotiation authority.

export const marketplaceInquiries = pgTable(
  "marketplace_inquiries",
  {
    id: text("id").primaryKey(),
    threadConversationId: text("thread_conversation_id").notNull().unique().references(() => conversations.id),
    listingId: text("listing_id").notNull().references(() => offers.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    buyerId: text("buyer_id").notNull().references(() => users.id),
    sellerId: text("seller_id").notNull().references(() => users.id),
    initiatorRole: text("initiator_role").notNull(),
    /** The commercial relationship that authorises the thread. */
    relationship: text("relationship").notNull(),
    negotiationId: text("negotiation_id").references(() => negotiations.id),
    orderId: text("order_id").references(() => orders.id),
    status: text("status").notNull(),
    /** Each party's DINAR conversation where the thread's updates are delivered. */
    buyerConversationId: text("buyer_conversation_id").references(() => conversations.id),
    sellerConversationId: text("seller_conversation_id").references(() => conversations.id),
    blockedByRole: text("blocked_by_role"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("marketplace_inquiries_one_open_per_pair_listing")
      .on(t.listingId, t.buyerId)
      .where(sql`${t.status} NOT IN ('CLOSED', 'BLOCKED')`),
    index("marketplace_inquiries_seller_idx").on(t.sellerId, t.lastMessageAt),
    index("marketplace_inquiries_buyer_idx").on(t.buyerId, t.lastMessageAt),
    check("marketplace_inquiries_parties_distinct", sql`${t.buyerId} <> ${t.sellerId}`),
    check("marketplace_inquiries_initiator_valid", sql`${t.initiatorRole} IN ('BUYER', 'SELLER')`),
    check("marketplace_inquiries_relationship_valid", sql`${t.relationship} IN ('LISTING_INQUIRY', 'NEGOTIATION', 'ORDER')`),
    check("marketplace_inquiries_status_valid", sql`${t.status} IN ('AWAITING_SELLER', 'AWAITING_BUYER', 'CLOSED', 'BLOCKED')`),
    check("marketplace_inquiries_blocked_consistent", sql`(${t.status} = 'BLOCKED') = (${t.blockedByRole} IS NOT NULL)`),
    check("marketplace_inquiries_blocked_role_valid", sql`${t.blockedByRole} IS NULL OR ${t.blockedByRole} IN ('BUYER', 'SELLER')`),
    // A seller may open a thread only inside an existing negotiation or order.
    check("marketplace_inquiries_seller_scope", sql`${t.initiatorRole} = 'BUYER' OR ${t.relationship} IN ('NEGOTIATION', 'ORDER')`),
  ],
);

export const marketplaceInquiryEvents = pgTable(
  "marketplace_inquiry_events",
  {
    id: text("id").primaryKey(),
    inquiryId: text("inquiry_id").notNull().references(() => marketplaceInquiries.id),
    messageId: text("message_id").references(() => messages.id),
    eventType: text("event_type").notNull(),
    actorRole: text("actor_role").notNull(),
    actorId: text("actor_id").references(() => users.id),
    detail: jsonb("detail").$type<Record<string, string | number | boolean>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("marketplace_inquiry_events_inquiry_idx").on(t.inquiryId, t.createdAt),
    uniqueIndex("marketplace_inquiry_events_message_type_unique").on(t.messageId, t.eventType).where(sql`${t.messageId} IS NOT NULL`),
    check(
      "marketplace_inquiry_events_type_valid",
      sql`${t.eventType} IN ('INQUIRY_SUBMITTED', 'INQUIRY_DELIVERED', 'INQUIRY_READ', 'INQUIRY_REPLIED', 'INQUIRY_CLOSED', 'INQUIRY_FAILED', 'INQUIRY_BLOCKED')`,
    ),
    check("marketplace_inquiry_events_role_valid", sql`${t.actorRole} IN ('BUYER', 'SELLER', 'SYSTEM')`),
  ],
);

// ════ DINAR NEXT pre-integration closure ══════════════════════════════════════
// Monetary AI cost accounting (integer micro-units of `currency_code`), privacy rights and
// subscription billing webhooks. See migration 0037. No prompt, reply, audio or coordinate
// is stored here.

/** Versioned provider price list. TEST_PLACEHOLDER rows are ignored outside development/test. */
export const aiModelPrices = pgTable(
  "ai_model_prices",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    version: integer("version").notNull(),
    currencyCode: text("currency_code").notNull(),
    inputPerMillionMicros: bigint("input_per_million_micros", { mode: "number" }).notNull(),
    outputPerMillionMicros: bigint("output_per_million_micros", { mode: "number" }).notNull(),
    cachedInputPerMillionMicros: bigint("cached_input_per_million_micros", { mode: "number" }),
    cacheWriteInputPerMillionMicros: bigint("cache_write_input_per_million_micros", { mode: "number" }),
    cacheWrite12hInputPerMillionMicros: bigint("cache_write_12h_input_per_million_micros", { mode: "number" }),
    imageUnitMicros: bigint("image_unit_micros", { mode: "number" }),
    audioSecondMicros: bigint("audio_second_micros", { mode: "number" }),
    requestMicros: bigint("request_micros", { mode: "number" }).default(0).notNull(),
    source: text("source").notNull(),
    sourceReference: text("source_reference"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    /** The admin who entered this version; null for rows written before admin entry existed. */
    createdBy: text("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("ai_model_prices_version_unique").on(t.provider, t.model, t.version),
    index("ai_model_prices_lookup_idx").on(t.provider, t.model, t.effectiveFrom),
    check("ai_model_prices_source_valid", sql`${t.source} IN ('PROVIDER_PUBLISHED', 'CONTRACT', 'TEST_PLACEHOLDER')`),
  ],
);

/** A monetary hold taken before a provider call; settled once with the calls' real cost. */
export const aiSpendHolds = pgTable(
  "ai_spend_holds",
  {
    id: text("id").primaryKey(),
    usageReservationId: text("usage_reservation_id").references(() => aiUsageReservations.id),
    ownerKey: text("owner_key").notNull(),
    purpose: text("purpose").notNull(),
    currencyCode: text("currency_code").notNull(),
    reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
    chargedMicros: bigint("charged_micros", { mode: "number" }).default(0).notNull(),
    scopes: jsonb("scopes").$type<Array<{ scopeKey: string; periodStart: string }>>().notNull(),
    status: text("status").default("HELD").notNull(),
    /** False when the hold was only recorded (no budget configured in a development environment). */
    enforced: boolean("enforced").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    index("ai_spend_holds_usage_idx").on(t.usageReservationId, t.status),
    index("ai_spend_holds_status_expiry_idx").on(t.status, t.expiresAt),
    check("ai_spend_holds_status_valid", sql`${t.status} IN ('HELD', 'SETTLED', 'RELEASED', 'EXPIRED')`),
  ],
);

export const aiSpendCounters = pgTable(
  "ai_spend_counters",
  {
    scopeKey: text("scope_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    currencyCode: text("currency_code").notNull(),
    reservedMicros: bigint("reserved_micros", { mode: "number" }).default(0).notNull(),
    spentMicros: bigint("spent_micros", { mode: "number" }).default(0).notNull(),
    unpricedCalls: integer("unpriced_calls").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "ai_spend_counters_pk", columns: [t.scopeKey, t.periodStart, t.currencyCode] }),
    check("ai_spend_counters_non_negative", sql`${t.reservedMicros} >= 0 AND ${t.spentMicros} >= 0 AND ${t.unpricedCalls} >= 0`),
  ],
);

/** One row per provider call (primary, retry, fallback, correction). */
export const aiCostEvents = pgTable(
  "ai_cost_events",
  {
    id: text("id").primaryKey(),
    holdId: text("hold_id").notNull().references(() => aiSpendHolds.id),
    usageReservationId: text("usage_reservation_id").references(() => aiUsageReservations.id),
    ownerKey: text("owner_key").notNull(),
    purpose: text("purpose").notNull(),
    callIndex: integer("call_index").notNull(),
    callKind: text("call_kind").notNull(),
    callOutcome: text("call_outcome").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    priceId: text("price_id").references(() => aiModelPrices.id),
    usageSource: text("usage_source").notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    cachedInputTokens: integer("cached_input_tokens").default(0).notNull(),
    cacheWriteInputTokens: integer("cache_write_input_tokens").default(0).notNull(),
    cacheWrite12hInputTokens: integer("cache_write_12h_input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    imageUnits: integer("image_units").default(0).notNull(),
    audioSeconds: integer("audio_seconds").default(0).notNull(),
    currencyCode: text("currency_code").notNull(),
    estimatedCostMicros: bigint("estimated_cost_micros", { mode: "number" }),
    finalCostMicros: bigint("final_cost_micros", { mode: "number" }),
    /** What the spend counters were charged for this call (an unpriced call is charged its hold share). */
    budgetChargedMicros: bigint("budget_charged_micros", { mode: "number" }).notNull(),
    costStatus: text("cost_status").notNull(),
    providerRequestId: text("provider_request_id"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    uniqueIndex("ai_cost_events_call_unique").on(t.holdId, t.callIndex),
    uniqueIndex("ai_cost_events_provider_request_unique").on(t.provider, t.providerRequestId).where(sql`${t.providerRequestId} IS NOT NULL`),
    index("ai_cost_events_created_idx").on(t.provider, t.createdAt),
    check("ai_cost_events_status_valid", sql`${t.costStatus} IN ('ESTIMATED', 'UNPRICED', 'FINAL', 'DISPUTED')`),
  ],
);

export const aiBillingReconciliations = pgTable("ai_billing_reconciliations", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  currencyCode: text("currency_code").notNull(),
  source: text("source").notNull(),
  matchedEvents: integer("matched_events").notNull(),
  unmatchedProviderItems: integer("unmatched_provider_items").notNull(),
  unreportedLocalEvents: integer("unreported_local_events").notNull(),
  localEstimatedMicros: bigint("local_estimated_micros", { mode: "number" }).notNull(),
  providerBilledMicros: bigint("provider_billed_micros", { mode: "number" }).notNull(),
  providerTotalMicros: bigint("provider_total_micros", { mode: "number" }),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    status: text("status").default("RECEIVED").notNull(),
    channel: text("channel").notNull(),
    subject: text("subject"),
    details: text("details"),
    outcomeCode: text("outcome_code"),
    outcomeNote: text("outcome_note"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("privacy_requests_idempotency_unique").on(t.userId, t.idempotencyKey),
    index("privacy_requests_queue_idx").on(t.status, t.createdAt),
    check("privacy_requests_kind_valid", sql`${t.kind} IN ('ACCESS', 'EXPORT', 'CORRECTION', 'DELETION', 'CONSENT_WITHDRAWAL', 'OBJECTION', 'RESTRICTION', 'INQUIRY')`),
    check("privacy_requests_status_valid", sql`${t.status} IN ('RECEIVED', 'IN_REVIEW', 'COMPLETED', 'REJECTED', 'WITHDRAWN')`),
  ],
);

export const privacyRequestEvents = pgTable(
  "privacy_request_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull().references(() => privacyRequests.id),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").references(() => users.id),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("privacy_request_events_request_idx").on(t.requestId, t.createdAt)],
);

export const userPrivacyPreferences = pgTable(
  "user_privacy_preferences",
  {
    userId: text("user_id").primaryKey().references(() => users.id),
    marketingInApp: boolean("marketing_in_app").default(false).notNull(),
    marketingEmail: boolean("marketing_email").default(false).notNull(),
    marketingSms: boolean("marketing_sms").default(false).notNull(),
    marketingPush: boolean("marketing_push").default(false).notNull(),
    deviceLocationSharing: text("device_location_sharing").default("ASK_EACH_TIME").notNull(),
    version: integer("version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check("user_privacy_preferences_location_valid", sql`${t.deviceLocationSharing} IN ('ASK_EACH_TIME', 'DISABLED')`)],
);

export const privacyConsentEvents = pgTable(
  "privacy_consent_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    consentKey: text("consent_key").notNull(),
    granted: boolean("granted").notNull(),
    source: text("source").notNull(),
    policyVersion: text("policy_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("privacy_consent_events_user_idx").on(t.userId, t.consentKey, t.createdAt)],
);

export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    id: text("id").primaryKey(),
    providerKey: text("provider_key").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    status: text("status").notNull(),
    subscriptionId: text("subscription_id").references(() => businessSubscriptions.id),
    failureCode: text("failure_code"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("billing_webhook_events_provider_unique").on(t.providerKey, t.providerEventId),
    check("billing_webhook_events_status_valid", sql`${t.status} IN ('APPLIED', 'IGNORED', 'REJECTED')`),
  ],
);

/** An appeal of one trust decision by the affected party; a human decides with a recorded reason. */
export const trustAppeals = pgTable(
  "trust_appeals",
  {
    id: text("id").primaryKey(),
    appellantId: text("appellant_id").notNull().references(() => users.id),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    marketId: text("market_id").references(() => markets.id),
    /** Who made the appealed decision, when recorded: an appeal is reviewed by someone else. */
    originalDeciderId: text("original_decider_id").references(() => users.id),
    statement: text("statement").notNull(),
    status: text("status").default("SUBMITTED").notNull(),
    decisionNote: text("decision_note"),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("trust_appeals_idempotency_unique").on(t.appellantId, t.idempotencyKey),
    uniqueIndex("trust_appeals_one_open_per_subject").on(t.appellantId, t.subjectType, t.subjectId).where(sql`${t.status} IN ('SUBMITTED', 'UNDER_REVIEW')`),
    index("trust_appeals_queue_idx").on(t.status, t.createdAt),
    check("trust_appeals_subject_valid", sql`${t.subjectType} IN ('LISTING_MODERATION', 'ACCOUNT_STATUS', 'REPORT_DECISION', 'DISPUTE_RESOLUTION')`),
    check("trust_appeals_status_valid", sql`${t.status} IN ('SUBMITTED', 'UNDER_REVIEW', 'UPHELD', 'OVERTURNED', 'WITHDRAWN')`),
  ],
);

export const trustAppealEvents = pgTable(
  "trust_appeal_events",
  {
    id: text("id").primaryKey(),
    appealId: text("appeal_id").notNull().references(() => trustAppeals.id),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").references(() => users.id),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("trust_appeal_events_appeal_idx").on(t.appealId, t.createdAt)],
);

// ─── D2: DINAR Business identity ─────────────────────────────────────────────

export const BUSINESS_VERIFICATION_STATUSES = ["DRAFT", "DOCUMENTS_REQUIRED", "PENDING_REVIEW", "VERIFIED", "REJECTED", "SUSPENDED"] as const;

/**
 * A business introduced by an account. The display name is what the owner calls it; the legal
 * name and registration are claims until a DINAR reviewer (never the owner, never payment, never
 * the model) records VERIFIED. Publication requires VERIFIED.
 */
export const businessProfiles = pgTable(
  "business_profiles",
  {
    id: text("id").primaryKey(),
    /** The applicant: the authenticated account that created the record. Not a legal owner by itself. */
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    displayName: text("display_name").notNull(),
    /** Folded display name, for duplicate and impersonation review within a market. */
    normalizedName: text("normalized_name").notNull(),
    legalName: text("legal_name"),
    legalForm: text("legal_form"),
    categoryKey: text("category_key").notNull(),
    description: text("description").default("").notNull(),
    contact: jsonb("contact").$type<Record<string, string>>().default({}).notNull(),
    address: jsonb("address").$type<Record<string, string>>().default({}).notNull(),
    openingHours: jsonb("opening_hours").$type<Array<{ day: number; opens: string; closes: string }>>().default([]).notNull(),
    servicePreferences: jsonb("service_preferences").$type<Record<string, unknown>>().default({}).notNull(),
    integrationPreferences: jsonb("integration_preferences").$type<Record<string, unknown>>().default({}).notNull(),
    /** sha256 of the normalised registration number the owner typed (never the number itself in logs). */
    registrationNumberSha256: text("registration_number_sha256"),
    registrationNumberLast4: text("registration_number_last4"),
    verificationStatus: text("verification_status").default("DRAFT").notNull(),
    publicationStatus: text("publication_status").default("UNPUBLISHED").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by").references(() => users.id),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    revision: integer("revision").default(1).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("business_profiles_owner_idempotency_unique").on(t.ownerUserId, t.idempotencyKey),
    // One open record per owner, market and name: a retry or a repeated introduction finds it.
    uniqueIndex("business_profiles_owner_name_open_unique")
      .on(t.ownerUserId, t.marketId, t.normalizedName)
      .where(sql`${t.verificationStatus} <> 'REJECTED'`),
    // One registration number per market among records under review or verified.
    uniqueIndex("business_profiles_registration_unique")
      .on(t.marketId, t.registrationNumberSha256)
      .where(sql`${t.registrationNumberSha256} IS NOT NULL AND ${t.verificationStatus} IN ('PENDING_REVIEW', 'VERIFIED', 'SUSPENDED')`),
    index("business_profiles_owner_idx").on(t.ownerUserId, t.marketId, t.createdAt),
    index("business_profiles_queue_idx").on(t.verificationStatus, t.updatedAt),
    index("business_profiles_market_name_idx").on(t.marketId, t.normalizedName),
    check("business_profiles_display_name_valid", sql`char_length(btrim(${t.displayName})) BETWEEN 2 AND 120`),
    check("business_profiles_normalized_name_valid", sql`char_length(${t.normalizedName}) BETWEEN 1 AND 120`),
    check("business_profiles_legal_name_valid", sql`${t.legalName} IS NULL OR char_length(btrim(${t.legalName})) BETWEEN 2 AND 200`),
    check("business_profiles_legal_form_valid", sql`${t.legalForm} IS NULL OR ${t.legalForm} IN ('SOLE_PROPRIETORSHIP', 'COMPANY', 'PARTNERSHIP', 'OTHER')`),
    check("business_profiles_category_valid", sql`${t.categoryKey} ~ '^[A-Z][A-Z_]{1,39}$'`),
    check("business_profiles_description_valid", sql`char_length(${t.description}) <= 1000`),
    check("business_profiles_json_valid", sql`jsonb_typeof(${t.contact}) = 'object' AND jsonb_typeof(${t.address}) = 'object' AND jsonb_typeof(${t.openingHours}) = 'array' AND jsonb_typeof(${t.servicePreferences}) = 'object' AND jsonb_typeof(${t.integrationPreferences}) = 'object'`),
    check("business_profiles_registration_valid", sql`(${t.registrationNumberSha256} IS NULL AND ${t.registrationNumberLast4} IS NULL) OR (${t.registrationNumberSha256} ~ '^[0-9a-f]{64}$' AND ${t.registrationNumberLast4} ~ '^[0-9A-Za-z]{1,4}$')`),
    check("business_profiles_status_valid", sql`${t.verificationStatus} IN ('DRAFT', 'DOCUMENTS_REQUIRED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED')`),
    check("business_profiles_publication_valid", sql`${t.publicationStatus} IN ('UNPUBLISHED', 'PUBLISHED')`),
    // Only a verified business is ever published.
    check("business_profiles_publication_requires_verified", sql`${t.publicationStatus} = 'UNPUBLISHED' OR ${t.verificationStatus} = 'VERIFIED'`),
    // VERIFIED carries its reviewer, and the reviewer is never the applicant.
    check("business_profiles_verified_by_reviewer", sql`${t.verificationStatus} NOT IN ('VERIFIED', 'SUSPENDED') OR (${t.verifiedAt} IS NOT NULL AND ${t.verifiedBy} IS NOT NULL AND ${t.verifiedBy} <> ${t.ownerUserId})`),
    check("business_profiles_suspended_at", sql`(${t.verificationStatus} = 'SUSPENDED') = (${t.suspendedAt} IS NOT NULL)`),
    check("business_profiles_revision_valid", sql`${t.revision} >= 1`),
  ],
);

/**
 * Who may act for a business. The applicant row is created with the business; VERIFIED_OWNER is
 * written only by the review authority. ADMIN and STAFF are defined for later phases and have no
 * grant path in D2.
 */
export const businessMemberships = pgTable(
  "business_memberships",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businessProfiles.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
    status: text("status").default("ACTIVE").notNull(),
    grantedBy: text("granted_by").references(() => users.id),
    ...dates(),
  },
  (t) => [
    uniqueIndex("business_memberships_business_user_unique").on(t.businessId, t.userId),
    index("business_memberships_user_idx").on(t.userId, t.status),
    check("business_memberships_role_valid", sql`${t.role} IN ('APPLICANT', 'VERIFIED_OWNER', 'ADMIN', 'STAFF')`),
    check("business_memberships_status_valid", sql`${t.status} IN ('ACTIVE', 'REVOKED')`),
  ],
);

/**
 * A private verification document. Bytes live in private object storage under
 * business-documents/<owner>/; this row never holds them and no public route serves the prefix.
 * A document is reviewable only after a registered scanner reports CLEAN.
 */
export const businessVerificationDocuments = pgTable(
  "business_verification_documents",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businessProfiles.id),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    objectPath: text("object_path").notNull(),
    objectGeneration: text("object_generation"),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status").default("UPLOAD_PENDING").notNull(),
    scanStatus: text("scan_status").default("NOT_SCANNED").notNull(),
    purpose: text("purpose").default("BUSINESS_VERIFICATION").notNull(),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    reviewNote: text("review_note"),
    idempotencyKey: text("idempotency_key").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("business_verification_documents_path_unique").on(t.objectPath),
    uniqueIndex("business_verification_documents_idempotency_unique").on(t.ownerUserId, t.idempotencyKey),
    index("business_verification_documents_business_idx").on(t.businessId, t.kind, t.createdAt),
    check("business_verification_documents_kind_valid", sql`${t.kind} IN ('COMMERCIAL_REGISTRATION', 'COMMERCIAL_LICENSE', 'MUNICIPALITY_LICENSE', 'AUTHORIZATION_LETTER', 'OWNER_IDENTITY')`),
    check("business_verification_documents_path_valid", sql`${t.objectPath} ~ '^/objects/business-documents/[A-Za-z0-9-]+/[A-Za-z0-9.-]+$' AND position(${t.ownerUserId} in ${t.objectPath}) = 29`),
    check("business_verification_documents_type_valid", sql`${t.contentType} IN ('application/pdf', 'image/jpeg', 'image/png')`),
    check("business_verification_documents_size_valid", sql`${t.sizeBytes} BETWEEN 1 AND 10485760`),
    check("business_verification_documents_status_valid", sql`${t.status} IN ('UPLOAD_PENDING', 'UPLOADED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')`),
    check("business_verification_documents_scan_valid", sql`${t.scanStatus} IN ('NOT_SCANNED', 'CLEAN', 'INFECTED')`),
    // A document is accepted only after a clean scan.
    check("business_verification_documents_accept_requires_clean", sql`${t.status} <> 'ACCEPTED' OR ${t.scanStatus} = 'CLEAN'`),
    check("business_verification_documents_purpose_valid", sql`${t.purpose} = 'BUSINESS_VERIFICATION'`),
  ],
);

/** Every business status move and review decision, with actor and reason. Append-only by trigger. */
export const businessVerificationEvents = pgTable(
  "business_verification_events",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businessProfiles.id),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").references(() => users.id),
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    reason: text("reason"),
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("business_verification_events_business_idx").on(t.businessId, t.createdAt),
    check("business_verification_events_actor_valid", sql`${t.actorKind} IN ('OWNER', 'REVIEWER', 'SYSTEM')`),
    check("business_verification_events_action_valid", sql`${t.action} IN ('CREATED', 'UPDATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_SCANNED', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'DOCUMENTS_REQUESTED', 'SUSPENDED', 'REINSTATED', 'PUBLISHED', 'UNPUBLISHED', 'DOCUMENT_ACCESSED')`),
    check("business_verification_events_reviewer_reason", sql`${t.actorKind} <> 'REVIEWER' OR ${t.action} IN ('VERIFIED', 'DOCUMENT_ACCESSED') OR (${t.reason} IS NOT NULL AND btrim(${t.reason}) <> '')`),
    check("business_verification_events_documents_valid", sql`jsonb_typeof(${t.documentIds}) = 'array'`),
  ],
);

// Wave 09: policy lifecycle registry. Wording still comes from lib/policies.ts, which stays
// PENDING_LEGAL_APPROVAL until counsel signs off. This table only records lifecycle state,
// content hash and who moved it. Nothing is created APPROVED or PUBLISHED by a migration.
export const policyRegistryVersions = pgTable(
  "policy_registry_versions",
  {
    id: text("id").primaryKey(),
    policyKey: text("policy_key").notNull(),
    version: text("version").notNull(),
    lifecycle: text("lifecycle").default("DRAFT").notNull(),
    contentSha256: text("content_sha256").notNull(),
    effectiveDate: text("effective_date").notNull(),
    marketScope: text("market_scope").default("GLOBAL").notNull(),
    requiresAcceptance: boolean("requires_acceptance").default(false).notNull(),
    materialChange: boolean("material_change").default(false).notNull(),
    legalReference: text("legal_reference"),
    registeredBy: text("registered_by").references(() => users.id),
    approvedBy: text("approved_by").references(() => users.id),
    publishedBy: text("published_by").references(() => users.id),
    supersededBy: text("superseded_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    uniqueIndex("policy_registry_versions_unique").on(
      t.policyKey,
      t.version,
      t.marketScope,
    ),
    index("policy_registry_versions_key_idx").on(t.policyKey, t.lifecycle),
    check(
      "policy_registry_versions_lifecycle_valid",
      sql`${t.lifecycle} IN ('DRAFT', 'LEGAL_REVIEW', 'APPROVED', 'PUBLISHED', 'SUPERSEDED')`,
    ),
    check(
      "policy_registry_versions_hash_valid",
      sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "policy_registry_versions_effective_valid",
      sql`${t.effectiveDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
    check(
      "policy_registry_versions_scope_valid",
      sql`${t.marketScope} = 'GLOBAL' OR char_length(${t.marketScope}) BETWEEN 2 AND 32`,
    ),
    check(
      "policy_registry_versions_state_valid",
      sql`(${t.lifecycle} IN ('DRAFT', 'LEGAL_REVIEW') AND ${t.approvedAt} IS NULL AND ${t.publishedAt} IS NULL AND ${t.supersededAt} IS NULL AND ${t.legalReference} IS NULL)
        OR (${t.lifecycle} = 'APPROVED' AND ${t.approvedAt} IS NOT NULL AND ${t.approvedBy} IS NOT NULL AND ${t.legalReference} IS NOT NULL AND ${t.publishedAt} IS NULL AND ${t.supersededAt} IS NULL)
        OR (${t.lifecycle} = 'PUBLISHED' AND ${t.approvedAt} IS NOT NULL AND ${t.publishedAt} IS NOT NULL AND ${t.publishedBy} IS NOT NULL AND ${t.legalReference} IS NOT NULL AND ${t.supersededAt} IS NULL)
        OR (${t.lifecycle} = 'SUPERSEDED' AND ${t.approvedAt} IS NOT NULL AND ${t.publishedAt} IS NOT NULL AND ${t.supersededAt} IS NOT NULL AND ${t.supersededBy} IS NOT NULL AND ${t.legalReference} IS NOT NULL)`,
    ),
  ],
);

/** Wave 09: every explicit policy decision, append-only. A chat message is never a row here. */
export const policyConsentEvents = pgTable(
  "policy_consent_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    policyKey: text("policy_key").notNull(),
    policyVersion: text("policy_version").notNull(),
    contentSha256: text("content_sha256").notNull(),
    decision: text("decision").notNull(),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("policy_consent_events_idempotency_unique").on(
      t.userId,
      t.idempotencyKey,
    ),
    index("policy_consent_events_user_idx").on(t.userId, t.createdAt),
    check(
      "policy_consent_events_decision_valid",
      sql`${t.decision} IN ('ACCEPTED', 'DECLINED')`,
    ),
    check(
      "policy_consent_events_source_valid",
      sql`${t.source} IN ('SIGNUP', 'POLICY_REVIEW', 'API')`,
    ),
    check(
      "policy_consent_events_hash_valid",
      sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** Wave 09: per-market legal entity. No row exists by default and no entity is invented. */
export const legalEntities = pgTable(
  "legal_entities",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    legalName: text("legal_name").notNull(),
    entityType: text("entity_type").notNull(),
    registrationCountry: text("registration_country").notNull(),
    status: text("status").default("DISABLED").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().default([]).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedBy: text("activated_by").references(() => users.id),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedBy: text("deactivated_by").references(() => users.id),
    createdBy: text("created_by").references(() => users.id),
    ...dates(),
  },
  (t) => [
    uniqueIndex("legal_entities_market_unique").on(t.marketId),
    index("legal_entities_status_idx").on(t.status),
    check(
      "legal_entities_name_valid",
      sql`char_length(btrim(${t.legalName})) BETWEEN 2 AND 200`,
    ),
    check(
      "legal_entities_type_valid",
      sql`${t.entityType} IN ('COMPANY', 'INDIVIDUAL', 'PARTNERSHIP')`,
    ),
    check(
      "legal_entities_country_valid",
      sql`${t.registrationCountry} ~ '^[A-Z]{2}$'`,
    ),
    check(
      "legal_entities_status_valid",
      sql`${t.status} IN ('DISABLED', 'ACTIVE')`,
    ),
    check(
      "legal_entities_capabilities_valid",
      sql`jsonb_typeof(${t.capabilities}) = 'array'`,
    ),
    check(
      "legal_entities_active_valid",
      sql`(${t.status} = 'DISABLED') OR (${t.activatedAt} IS NOT NULL AND ${t.activatedBy} IS NOT NULL AND jsonb_array_length(${t.capabilities}) > 0)`,
    ),
  ],
);

/** Wave 09: compliance switches; absence of a row means every safeguard is off. */
export const marketComplianceSettings = pgTable(
  "market_compliance_settings",
  {
    marketId: text("market_id")
      .primaryKey()
      .references(() => markets.id),
    sellerVerificationRequired: boolean("seller_verification_required")
      .default(false)
      .notNull(),
    minorProtectionEnabled: boolean("minor_protection_enabled")
      .default(false)
      .notNull(),
    minimumAge: integer("minimum_age").default(18).notNull(),
    guardianConsentRequired: boolean("guardian_consent_required")
      .default(false)
      .notNull(),
    /** Enables the legal-entity capability gate for this market; off means the gate is not claimed. */
    legalEntityRequired: boolean("legal_entity_required").default(false).notNull(),
    updatedBy: text("updated_by").references(() => users.id),
    ...dates(),
  },
  (t) => [
    check(
      "market_compliance_settings_age_valid",
      sql`${t.minimumAge} BETWEEN 13 AND 21`,
    ),
    check(
      "market_compliance_settings_guardian_valid",
      sql`NOT ${t.guardianConsentRequired} OR ${t.minorProtectionEnabled}`,
    ),
  ],
);

/** Wave 09: risk-based seller verification. UNASSESSED is honest: no score is invented. */
export const sellerVerificationProfiles = pgTable(
  "seller_verification_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    requestedLevel: text("requested_level").notNull(),
    status: text("status").default("PENDING").notNull(),
    riskBasis: text("risk_basis").default("UNASSESSED").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().default([]).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => users.id),
    decisionReason: text("decision_reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    ...dates(),
  },
  (t) => [
    uniqueIndex("seller_verification_profiles_idempotency_unique").on(
      t.userId,
      t.idempotencyKey,
    ),
    index("seller_verification_profiles_user_idx").on(
      t.userId,
      t.marketId,
      t.createdAt,
    ),
    index("seller_verification_profiles_queue_idx").on(t.status, t.createdAt),
    check(
      "seller_verification_profiles_level_valid",
      sql`${t.requestedLevel} IN ('BASIC', 'ENHANCED')`,
    ),
    check(
      "seller_verification_profiles_status_valid",
      sql`${t.status} IN ('PENDING', 'VERIFIED', 'REJECTED')`,
    ),
    check(
      "seller_verification_profiles_risk_valid",
      sql`${t.riskBasis} IN ('UNASSESSED', 'LOW', 'MEDIUM', 'HIGH')`,
    ),
    check(
      "seller_verification_profiles_evidence_valid",
      sql`jsonb_typeof(${t.evidenceRefs}) = 'array'`,
    ),
    check(
      "seller_verification_profiles_decision_valid",
      sql`(${t.status} = 'PENDING' AND ${t.decidedAt} IS NULL AND ${t.decidedBy} IS NULL AND ${t.decisionReason} IS NULL)
        OR (${t.status} IN ('VERIFIED', 'REJECTED') AND ${t.decidedAt} IS NOT NULL AND ${t.decidedBy} IS NOT NULL AND ${t.decidedBy} <> ${t.userId})`,
    ),
    check(
      "seller_verification_profiles_rejection_reason",
      sql`${t.status} <> 'REJECTED' OR (${t.decisionReason} IS NOT NULL AND btrim(${t.decisionReason}) <> '')`,
    ),
  ],
);

/**
 * Wave 09: minor protection declarations. Append-only: the newest row wins, so a guardian
 * decision never rewrites the self-declaration that preceded it. Only a hash of the guardian
 * reference is stored.
 */
export const minorProtectionDeclarations = pgTable(
  "minor_protection_declarations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id),
    declaredStatus: text("declared_status").notNull(),
    guardianStatus: text("guardian_status").notNull(),
    guardianReferenceSha256: text("guardian_reference_sha256"),
    guardianDecidedAt: timestamp("guardian_decided_at", {
      withTimezone: true,
    }),
    source: text("source").default("SELF_DECLARATION").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("minor_protection_declarations_idempotency_unique").on(
      t.userId,
      t.idempotencyKey,
    ),
    index("minor_protection_declarations_user_idx").on(
      t.userId,
      t.marketId,
      t.createdAt,
    ),
    check(
      "minor_protection_declarations_status_valid",
      sql`${t.declaredStatus} IN ('ADULT', 'MINOR')`,
    ),
    check(
      "minor_protection_declarations_guardian_status_valid",
      sql`${t.guardianStatus} IN ('NOT_REQUIRED', 'PENDING', 'GRANTED', 'DENIED')`,
    ),
    check(
      "minor_protection_declarations_source_valid",
      sql`${t.source} IN ('SELF_DECLARATION', 'GUARDIAN_VERIFICATION')`,
    ),
    check(
      "minor_protection_declarations_guardian_hash_valid",
      sql`${t.guardianReferenceSha256} IS NULL OR ${t.guardianReferenceSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "minor_protection_declarations_state_valid",
      sql`(${t.declaredStatus} = 'ADULT' AND ${t.guardianStatus} = 'NOT_REQUIRED' AND ${t.guardianReferenceSha256} IS NULL AND ${t.guardianDecidedAt} IS NULL AND ${t.source} = 'SELF_DECLARATION')
        OR (${t.declaredStatus} = 'MINOR' AND ${t.guardianStatus} IN ('NOT_REQUIRED', 'PENDING') AND ${t.guardianReferenceSha256} IS NULL AND ${t.guardianDecidedAt} IS NULL AND ${t.source} = 'SELF_DECLARATION')
        OR (${t.declaredStatus} = 'MINOR' AND ${t.guardianStatus} IN ('GRANTED', 'DENIED') AND ${t.guardianReferenceSha256} IS NOT NULL AND ${t.guardianDecidedAt} IS NOT NULL AND ${t.source} = 'GUARDIAN_VERIFICATION')`,
    ),
  ],
);
