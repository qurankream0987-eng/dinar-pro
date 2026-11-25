import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { markets, users } from "./index";

/**
 * Multi-company workflows: an ordered plan of connector tool uses across stores, confirmed once by
 * the person, executed step by step and recorded honestly (a later failure never hides an earlier
 * success).
 */
export const connectWorkflows = pgTable(
  "connect_workflows",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    status: text("status").default("PENDING").notNull(),
    steps: jsonb("steps").$type<Record<string, unknown>[]>().notNull(),
    results: jsonb("results").$type<Record<string, unknown>[]>().default([]).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("connect_workflows_actor_idx").on(t.actorId, t.createdAt),
    check("connect_workflows_status_valid", sql`${t.status} IN ('PENDING','RUNNING','COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED') AND (${t.status} IN ('PENDING','CANCELLED','EXPIRED') OR ${t.startedAt} IS NOT NULL)`),
  ],
);
