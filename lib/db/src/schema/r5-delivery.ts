import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { deliveryAssignments, markets, orders, users } from "./index";

/**
 * A mutable negotiation proposal. The separate agreement row below is the
 * immutable fare snapshot created only after both parties confirm this proposal.
 */
export const courierFareProposals = pgTable(
  "courier_fare_proposals",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id),
    assignmentId: text("assignment_id").notNull().references(() => deliveryAssignments.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    buyerId: text("buyer_id").notNull().references(() => users.id),
    courierId: text("courier_id").notNull().references(() => users.id),
    proposedByUserId: text("proposed_by_user_id").notNull().references(() => users.id),
    fareMinor: integer("fare_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    minorUnitScale: integer("minor_unit_scale").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("PENDING").notNull(),
    buyerConfirmedAt: timestamp("buyer_confirmed_at", { withTimezone: true }),
    courierConfirmedAt: timestamp("courier_confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("courier_fare_proposals_assignment_status_idx").on(t.assignmentId, t.status),
    uniqueIndex("courier_fare_proposals_pending_assignment_unique")
      .on(t.assignmentId)
      .where(sql`${t.status} = 'PENDING'`),
    uniqueIndex("courier_fare_proposals_actor_idempotency_unique").on(
      t.proposedByUserId,
      t.idempotencyKey,
    ),
    check(
      "courier_fare_proposals_status_valid",
      sql`${t.status} IN ('PENDING', 'SUPERSEDED', 'AGREED', 'CANCELLED')`,
    ),
    check("courier_fare_proposals_fare_positive", sql`${t.fareMinor} > 0`),
    check("courier_fare_proposals_currency_valid", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("courier_fare_proposals_scale_valid", sql`${t.minorUnitScale} BETWEEN 0 AND 3`),
    check("courier_fare_proposals_parties_distinct", sql`${t.buyerId} <> ${t.courierId}`),
    check(
      "courier_fare_proposals_confirmation_consistent",
      sql`(${t.status} = 'AGREED') = (${t.buyerConfirmedAt} IS NOT NULL AND ${t.courierConfirmedAt} IS NOT NULL)`,
    ),
    check(
      "courier_fare_proposals_confirmed_actor_valid",
      sql`${t.proposedByUserId} IN (${t.buyerId}, ${t.courierId})`,
    ),
  ],
);

/**
 * Write-once agreed fare and the market/currency snapshot used for later
 * commission calculation. No application route updates or deletes this row.
 */
export const courierFareAgreements = pgTable(
  "courier_fare_agreements",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id").notNull().references(() => courierFareProposals.id),
    assignmentId: text("assignment_id").notNull().references(() => deliveryAssignments.id),
    orderId: text("order_id").notNull().references(() => orders.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    buyerId: text("buyer_id").notNull().references(() => users.id),
    courierId: text("courier_id").notNull().references(() => users.id),
    fareMinor: integer("fare_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    minorUnitScale: integer("minor_unit_scale").notNull(),
    commissionRateBps: integer("commission_rate_bps").default(1000).notNull(),
    commissionEstimateMinor: integer("commission_estimate_minor").notNull(),
    agreedAt: timestamp("agreed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("courier_fare_agreements_proposal_unique").on(t.proposalId),
    uniqueIndex("courier_fare_agreements_assignment_unique").on(t.assignmentId),
    index("courier_fare_agreements_driver_market_idx").on(t.courierId, t.marketId),
    check("courier_fare_agreements_fare_positive", sql`${t.fareMinor} > 0`),
    check("courier_fare_agreements_currency_valid", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("courier_fare_agreements_scale_valid", sql`${t.minorUnitScale} BETWEEN 0 AND 3`),
    check("courier_fare_agreements_rate_fixed", sql`${t.commissionRateBps} = 1000`),
    check("courier_fare_agreements_commission_nonnegative", sql`${t.commissionEstimateMinor} >= 0`),
    check("courier_fare_agreements_parties_distinct", sql`${t.buyerId} <> ${t.courierId}`),
  ],
);

/**
 * Test-only settlement record. This is intentionally not a wallet or provider
 * payment record and cannot represent transferred money.
 */
export const courierCommissionSettlements = pgTable(
  "courier_commission_settlements",
  {
    id: text("id").primaryKey(),
    courierId: text("courier_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    minorUnitScale: integer("minor_unit_scale").notNull(),
    receivableCount: integer("receivable_count").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    mode: text("mode").default("SIMULATION_ONLY").notNull(),
    simulatedAt: timestamp("simulated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("courier_commission_settlements_idempotency_unique").on(
      t.courierId,
      t.marketId,
      t.idempotencyKey,
    ),
    index("courier_commission_settlements_driver_market_idx").on(t.courierId, t.marketId),
    check("courier_commission_settlements_mode_simulation_only", sql`${t.mode} = 'SIMULATION_ONLY'`),
    check("courier_commission_settlements_amount_positive", sql`${t.amountMinor} > 0`),
    check("courier_commission_settlements_count_positive", sql`${t.receivableCount} > 0`),
    check("courier_commission_settlements_currency_valid", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("courier_commission_settlements_scale_valid", sql`${t.minorUnitScale} BETWEEN 0 AND 3`),
  ],
);

/** A distinct courier receivable, separate from seller dues and Monetization V3. */
export const courierCommissionReceivables = pgTable(
  "courier_commission_receivables",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull().references(() => courierFareAgreements.id),
    assignmentId: text("assignment_id").notNull().references(() => deliveryAssignments.id),
    orderId: text("order_id").notNull().references(() => orders.id),
    courierId: text("courier_id").notNull().references(() => users.id),
    marketId: text("market_id").notNull().references(() => markets.id),
    fareMinor: integer("fare_minor").notNull(),
    commissionRateBps: integer("commission_rate_bps").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    minorUnitScale: integer("minor_unit_scale").notNull(),
    status: text("status").default("OUTSTANDING").notNull(),
    settlementId: text("settlement_id").references(() => courierCommissionSettlements.id),
    accruedAt: timestamp("accrued_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("courier_commission_receivables_agreement_unique").on(t.agreementId),
    uniqueIndex("courier_commission_receivables_assignment_unique").on(t.assignmentId),
    uniqueIndex("courier_commission_receivables_order_unique").on(t.orderId),
    index("courier_commission_receivables_driver_status_idx").on(t.courierId, t.status),
    index("courier_commission_receivables_driver_market_status_idx").on(
      t.courierId,
      t.marketId,
      t.status,
    ),
    check("courier_commission_receivables_fare_positive", sql`${t.fareMinor} > 0`),
    check("courier_commission_receivables_rate_fixed", sql`${t.commissionRateBps} = 1000`),
    check("courier_commission_receivables_amount_nonnegative", sql`${t.amountMinor} >= 0`),
    check("courier_commission_receivables_currency_valid", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("courier_commission_receivables_scale_valid", sql`${t.minorUnitScale} BETWEEN 0 AND 3`),
    check(
      "courier_commission_receivables_status_valid",
      sql`${t.status} IN ('OUTSTANDING', 'SIMULATION_CLEARED')`,
    ),
    check(
      "courier_commission_receivables_settlement_consistent",
      sql`(${t.status} = 'SIMULATION_CLEARED') = (${t.settlementId} IS NOT NULL AND ${t.settledAt} IS NOT NULL)`,
    ),
  ],
);

export const insertCourierFareProposalSchema = createInsertSchema(courierFareProposals);
export const insertCourierFareAgreementSchema = createInsertSchema(courierFareAgreements);
export const insertCourierCommissionSettlementSchema = createInsertSchema(courierCommissionSettlements);
export const insertCourierCommissionReceivableSchema = createInsertSchema(courierCommissionReceivables);

export type CourierFareProposal = typeof courierFareProposals.$inferSelect;
export type CourierFareAgreement = typeof courierFareAgreements.$inferSelect;
export type CourierCommissionSettlement = typeof courierCommissionSettlements.$inferSelect;
export type CourierCommissionReceivable = typeof courierCommissionReceivables.$inferSelect;
