import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, uniqueIndex, index, check, doublePrecision, primaryKey } from "drizzle-orm/pg-core";
import { conversations, listingPromotions, markets, offers, users } from "./index";

const created = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updated = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

/**
 * Welcome-screen sponsored cards (placement WELCOME of the Sponsored Conversation product): one row
 * per card shown on an empty, newly created conversation. It is the exposure record behind the
 * frequency caps (per viewer per day, once per conversation) and the dismissal. Never a message.
 */
export const welcomeAdExposures = pgTable(
  "welcome_ad_exposures",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    /** The empty conversation's id, or the client's nonce for a not-yet-created conversation screen. */
    welcomeKey: text("welcome_key").notNull(),
    conversationId: text("conversation_id").references(() => conversations.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    promotionId: text("promotion_id").notNull().references(() => listingPromotions.id),
    listingId: text("listing_id").notNull().references(() => offers.id),
    slot: integer("slot").notNull(),
    shownAt: timestamp("shown_at", { withTimezone: true }).defaultNow().notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** Why this card was chosen for this viewer (the interest that matched), or null when unpersonalized. */
    personalizationReason: text("personalization_reason"),
  },
  (t) => [
    uniqueIndex("welcome_ad_exposures_key_slot_unique").on(t.userId, t.welcomeKey, t.slot),
    uniqueIndex("welcome_ad_exposures_key_promotion_unique").on(t.userId, t.welcomeKey, t.promotionId),
    index("welcome_ad_exposures_user_shown_idx").on(t.userId, t.shownAt),
    check("welcome_ad_exposures_slot_valid", sql`${t.slot} IN (1, 2)`),
    check("welcome_ad_exposures_key_valid", sql`${t.welcomeKey} ~ '^[0-9a-f-]{36}$'`),
  ],
);

/**
 * A buyer's saved, explicitly authorised request («نبّهني إذا توفر»): the only demand «جاسم روح بِع
 * لي» may match proactively. Structured fields only — never a copy of the conversation. It expires,
 * can be opted out of or deleted by the buyer, and no seller ever sees who made it.
 */
export const buyerDemandRequests = pgTable(
  "buyer_demand_requests",
  {
    id: text("id").primaryKey(),
    buyerId: text("buyer_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    needText: text("need_text").notNull(),
    categoryId: text("category_id"),
    city: text("city"),
    priceMaxMinor: integer("price_max_minor"),
    currencyCode: text("currency_code").notNull(),
    consentVersion: text("consent_version").notNull(),
    status: text("status").default("ACTIVE").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("buyer_demand_requests_market_status_idx").on(t.marketId, t.status, t.expiresAt),
    index("buyer_demand_requests_buyer_idx").on(t.buyerId, t.createdAt),
    check("buyer_demand_requests_status_valid", sql`${t.status} IN ('ACTIVE', 'OPTED_OUT', 'DELETED', 'EXPIRED')`),
    check("buyer_demand_requests_need_valid", sql`char_length(${t.needText}) BETWEEN 2 AND 200`),
    check("buyer_demand_requests_price_valid", sql`${t.priceMaxMinor} IS NULL OR ${t.priceMaxMinor} >= 0`),
  ],
);

/** One in-app notice per (request, listing): duplicate matching can never notify twice. */
export const demandMatchNotices = pgTable(
  "demand_match_notices",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull().references(() => buyerDemandRequests.id),
    buyerId: text("buyer_id").notNull().references(() => users.id),
    promotionId: text("promotion_id").notNull().references(() => listingPromotions.id),
    listingId: text("listing_id").notNull().references(() => offers.id),
    status: text("status").default("UNREAD").notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("demand_match_notices_request_listing_unique").on(t.requestId, t.listingId),
    index("demand_match_notices_buyer_idx").on(t.buyerId, t.matchedAt),
    index("demand_match_notices_promotion_idx").on(t.promotionId),
    check("demand_match_notices_status_valid", sql`${t.status} IN ('UNREAD', 'SEEN', 'DISMISSED')`),
  ],
);

/**
 * Interest-based ads: the viewer's own choice. Absent row = never asked (no personalization).
 * OFF erases every stored interest; ON lets search and cart signals build interests.
 */
export const adPersonalizationSettings = pgTable(
  "ad_personalization_settings",
  {
    userId: text("user_id").primaryKey().references(() => users.id),
    status: text("status").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  },
  () => [check("ad_personalization_settings_status_valid", sql`status IN ('ON','OFF')`)],
);

/**
 * Coarse interests only: a category id or a normalized keyword, a decayed score and when it was last
 * seen. Never the message text. Rows older than the retention window are deleted on read and write.
 */
export const adInterestSignals = pgTable(
  "ad_interest_signals",
  {
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    score: doublePrecision("score").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.key] }),
    index("ad_interest_signals_user_idx").on(t.userId, t.lastSeenAt),
    check("ad_interest_signals_kind_valid", sql`${t.kind} IN ('CATEGORY','TERM')`),
    check("ad_interest_signals_key_valid", sql`char_length(${t.key}) BETWEEN 1 AND 60`),
    check("ad_interest_signals_score_valid", sql`${t.score} > 0`),
  ],
);
