import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { conversations, markets, messages, users } from "./index";

/**
 * Smart store cards issued by the server. The card is stored so that every event is applied to the
 * server's own copy (never to a card sent back by a browser) and every revision is ordered.
 */
export const smartStoreCards = pgTable(
  "smart_store_cards",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    /** The assistant reply the card belongs to (one card per reply). */
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    revision: integer("revision").default(1).notNull(),
    card: jsonb("card").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("smart_store_cards_message_unique").on(t.messageId).where(sql`${t.messageId} IS NOT NULL`),
    index("smart_store_cards_owner_idx").on(t.ownerUserId, t.createdAt),
    check("smart_store_cards_revision_valid", sql`${t.revision} >= 1`),
  ],
);
