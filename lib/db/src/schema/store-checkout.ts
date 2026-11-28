import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { businessProfiles, markets, orders, users } from "./index";

/** Store checkout adapters (0084): merchant-owned hosted payment gateway adapters. */
export const storeCheckoutAdapters = pgTable(
  "store_checkout_adapters",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businessProfiles.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    adapterKind: text("adapter_kind").notNull(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    supportedCountries: jsonb("supported_countries").$type<string[]>().default([]).notNull(),
    supportedCurrencies: jsonb("supported_currencies").$type<string[]>().default([]).notNull(),
    minAmountMinor: integer("min_amount_minor").default(1).notNull(),
    maxAmountMinor: integer("max_amount_minor"),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("store_checkout_adapters_business_idx").on(t.businessId, t.enabled),
    check("store_checkout_adapters_kind_valid", sql`${t.adapterKind} IN ('SIMULATED_GATEWAY', 'CUSTOM_OPENAPI')`),
    check("store_checkout_adapters_amount_bounds", sql`${t.minAmountMinor} >= 1 AND (${t.maxAmountMinor} IS NULL OR ${t.maxAmountMinor} >= ${t.minAmountMinor})`),
  ],
);

/** Store checkout sessions (0084): hosted checkout sessions created by a store's adapter. */
export const storeCheckoutSessions = pgTable(
  "store_checkout_sessions",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id),
    businessId: text("business_id").notNull().references(() => businessProfiles.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    buyerId: text("buyer_id").notNull().references(() => users.id),
    adapterId: text("adapter_id").notNull().references(() => storeCheckoutAdapters.id),
    adapterKind: text("adapter_kind").notNull(),
    providerSessionId: text("provider_session_id").notNull(),
    checkoutUrl: text("checkout_url").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    paidEventId: text("paid_event_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("store_checkout_sessions_order_idem_unique").on(t.orderId, t.idempotencyKey),
    uniqueIndex("store_checkout_sessions_provider_session_unique").on(t.adapterId, t.providerSessionId),
    index("store_checkout_sessions_order_idx").on(t.orderId, t.createdAt),
    check("store_checkout_sessions_amount_positive", sql`${t.amountMinor} > 0`),
    check("store_checkout_sessions_currency_valid", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("store_checkout_sessions_status_valid", sql`${t.status} IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'MISMATCH_REVIEW')`),
  ],
);

/** Store checkout webhook events (0084): replay-protected audit log of gateway notifications. */
export const storeCheckoutWebhookEvents = pgTable(
  "store_checkout_webhook_events",
  {
    id: text("id").primaryKey(),
    adapterId: text("adapter_id").notNull().references(() => storeCheckoutAdapters.id),
    eventId: text("event_id").notNull(),
    sessionId: text("session_id").references(() => storeCheckoutSessions.id),
    eventType: text("event_type").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("store_checkout_webhook_events_dedupe").on(t.adapterId, t.eventId),
    index("store_checkout_webhook_events_session_idx").on(t.sessionId, t.receivedAt),
    check("store_checkout_webhook_events_outcome_valid", sql`${t.outcome} IN ('APPLIED', 'DUPLICATE', 'REJECTED', 'IGNORED')`),
  ],
);
