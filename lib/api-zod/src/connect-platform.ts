import { z } from "zod";
import { ConnectMoney } from "./connect";

export const ConnectPartnerInput = z
  .object({ businessId: z.string().uuid() })
  .strict();
export const ConnectSiteInput = z
  .object({ hostname: z.string().min(3).max(253) })
  .strict();
export const CONNECT_CAPABILITIES = [
  "CATALOG_READ",
  "CATALOG_IMPORT",
  "EXTERNAL_REFERRAL",
  "TRANSACTION_REPORT",
] as const;
export const ConnectIntegrationInput = z
  .object({
    siteId: z.string().uuid(),
    kind: z.enum(["WEBSITE", "FEED", "API", "OAUTH", "MCP"]),
    name: z.string().trim().min(2).max(100),
    endpointUrl: z.string().max(500).optional(),
    capabilities: z.array(z.enum(CONNECT_CAPABILITIES)).min(1).max(4),
    mode: z.enum(["SIMULATION_ONLY", "LIVE"]),
    allowedPathPrefixes: z.array(z.string().min(1).max(120)).min(1).max(8),
    referralParameter: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
    reviewedTools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/),
            inputSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
            readOnly: z.literal(true),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
export const ConnectReviewInput = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "SUSPEND"]),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const connectRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
export const ConnectCatalogItem = z
  .object({
    externalId: connectRef,
    kind: z.enum(["PRODUCT", "SERVICE"]),
    title: z.string().trim().min(2).max(180),
    description: z.string().max(700),
    categoryId: z.string().min(1).max(80),
    price: ConnectMoney.nullable(),
    availability: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]),
    targetPath: z.string().min(1).max(400),
    sourceVersion: z.number().int().positive(),
    sourceCheckedAt: z.string().datetime(),
    attributes: z
      .array(
        z
          .object({
            label: z.string().min(1).max(80),
            value: z.string().max(300).nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export const ConnectCatalogBatch = z
  .object({
    batchId: connectRef,
    items: z.array(ConnectCatalogItem).min(1).max(100),
  })
  .strict();
export const ConnectAgreementTerms = z
  .object({
    mode: z.enum(["SIMULATION_ONLY", "LIVE"]),
    currency: z.string().regex(/^[A-Z]{3}$/),
    commission: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("PERCENTAGE"),
          basisPoints: z.number().int().min(0).max(10000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("FIXED"),
          amountMinor: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    ]),
    categoryRates: z
      .array(
        z
          .object({
            categoryId: z.string().min(1).max(80),
            basisPoints: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .max(30),
    excludedProductIds: z.array(connectRef).max(100),
    excludedCategoryIds: z.array(z.string().min(1).max(80)).max(30),
    attributionPolicy: z.literal("CLICK_SNAPSHOT"),
    attributionWindowSeconds: z.number().int().min(60).max(31_536_000),
    reportingGraceSeconds: z.number().int().min(0).max(31_536_000),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime().nullable(),
    refundPolicy: z.enum([
      "PRO_RATA_ELIGIBLE_BASE",
      "FULL_REVERSAL_ON_ANY_REFUND",
    ]),
    rounding: z.enum(["HALF_UP", "FLOOR"]),
    eligibleEvents: z
      .array(
        z.enum([
          "PURCHASE_COMPLETED",
          "BOOKING_CONFIRMED",
          "SERVICE_COMPLETED",
        ]),
      )
      .min(1)
      .max(3),
    settlementDueDays: z.number().int().min(0).max(3650),
    paymentTerms: z.string().min(3).max(1000),
    cancellationPolicy: z.string().min(3).max(1000),
    termsText: z.string().min(10).max(12000),
    attributionNotice: z.string().min(10).max(700),
    privacyPolicyVersion: z.string().min(1).max(80),
  })
  .strict()
  .superRefine((terms, ctx) => {
    if (
      terms.effectiveUntil &&
      Date.parse(terms.effectiveUntil) <= Date.parse(terms.effectiveFrom)
    )
      ctx.addIssue({
        code: "custom",
        message: "Agreement effective interval is empty",
      });
    if (terms.commission.kind === "FIXED" && terms.categoryRates.length)
      ctx.addIssue({
        code: "custom",
        message: "Category percentage rates require a percentage agreement",
      });
    if (
      new Set(terms.categoryRates.map((row) => row.categoryId)).size !==
      terms.categoryRates.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate category rate" });
  });
export type ConnectAgreement = z.infer<typeof ConnectAgreementTerms>;
export const ConnectAgreementAcceptInput = z
  .object({
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    accept: z.literal(true),
    idempotencyKey: connectRef,
  })
  .strict();
export const ConnectPartnerEvent = z
  .object({
    eventId: connectRef,
    transactionId: connectRef,
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    type: z.enum([
      "PURCHASE_COMPLETED",
      "BOOKING_CONFIRMED",
      "SERVICE_COMPLETED",
      "CANCELLATION",
      "REFUND",
      "CHARGEBACK",
      "COMMISSION_APPROVED",
      "COMMISSION_REJECTED",
      "COMMISSION_SETTLED",
      "DISPUTE_OPENED",
    ]),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    referralId: z.string().uuid().optional(),
    items: z
      .array(
        z
          .object({
            externalId: connectRef,
            amountMinor: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    refundedTotalMinor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    refundItems: z
      .array(
        z
          .object({
            externalId: connectRef,
            amountMinor: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    evidenceReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}$/),
  })
  .strict();
export type ConnectEvent = z.infer<typeof ConnectPartnerEvent>;
export const ConnectFinanceCommand = z
  .object({
    action: z.enum([
      "MARK_PAYABLE",
      "RECONCILE_SIMULATED_SETTLEMENT",
      "OPEN_DISPUTE",
      "RESOLVE_DISPUTE",
    ]),
    idempotencyKey: connectRef,
    evidenceReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}$/),
    providerEventId: connectRef.optional(),
    resolution: z.enum(["RESTORE_SUPPORTED_STATE", "REVERSE"]).optional(),
  })
  .strict();
export const ConnectCatalogSyncInput = z.object({ confirm: z.literal(true), expectedRevision: z.number().int().positive() }).strict();
export const ConnectSiteCommandInput = z.object({ confirm: z.literal(true) }).strict();
export const CONNECT_TEAM_SCOPES = ["CATALOG_READ", "REPORTS_READ"] as const;
export const ConnectTeamInput = z.object({
  delegationId: z.string().uuid(),
  expectedDelegationVersion: z.number().int().positive(),
  scopes: z.array(z.enum(CONNECT_TEAM_SCOPES)).min(1).max(2)
    .refine(values => new Set(values).size === values.length, "Duplicate scopes"),
  confirm: z.literal(true),
}).strict();

const safeConnectMinor = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const ConnectCommissionBalancesSchema = z
  .object({
    earnedMinor: safeConnectMinor,
    approvedMinor: safeConnectMinor,
    payableMinor: safeConnectMinor,
    simulatedSettledMinor: safeConnectMinor,
    recoveryDueMinor: safeConnectMinor,
  })
  .strict();
export const ConnectExternalTransactionSchema = z
  .object({
    id: z.string().uuid(),
    externalId: connectRef,
    partnerId: z.string().uuid(),
    integrationId: z.string().uuid(),
    state: z.enum([
      "PENDING_VERIFICATION",
      "VERIFIED",
      "APPROVED",
      "PAYABLE",
      "SETTLED",
      "REVERSED",
      "DISPUTED",
      "REJECTED",
    ]),
    currency: z.string().regex(/^[A-Z]{3}$/),
    grossMinor: safeConnectMinor,
    refundedMinor: safeConnectMinor,
    commissionCeilingMinor: safeConnectMinor,
    lastSequence: z.number().int().positive(),
    mode: z.enum(["SIMULATION_ONLY", "LIVE"]),
    balances: ConnectCommissionBalancesSchema,
    actuallyReceivedMinor: safeConnectMinor.nullable(),
    internalOrderCreated: z.literal(false),
    disclosure: z.string().max(700),
  })
  .strict()
  .superRefine((row, ctx) => {
    const b = row.balances;
    if (
      row.refundedMinor > row.grossMinor ||
      b.earnedMinor > row.commissionCeilingMinor ||
      b.approvedMinor > b.earnedMinor ||
      b.recoveryDueMinor > b.simulatedSettledMinor ||
      BigInt(b.payableMinor) +
        BigInt(b.simulatedSettledMinor) -
        BigInt(b.recoveryDueMinor) >
        BigInt(b.approvedMinor) ||
      (row.state === "REVERSED" && b.earnedMinor !== 0) ||
      (row.state === "DISPUTED" && b.payableMinor !== 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "External accounting projection does not reconcile",
      });
    if (row.mode === "SIMULATION_ONLY" && row.actuallyReceivedMinor !== 0)
      ctx.addIssue({
        code: "custom",
        message: "A simulation cannot claim received real funds",
      });
  });
export type ConnectExternalTransaction = z.infer<
  typeof ConnectExternalTransactionSchema
>;
const minorText = z.string().regex(/^\d+$/);
export const ConnectPartnerReportSchema = z
  .object({
    partnerId: z.string().uuid(),
    generatedAt: z.string().datetime(),
    counts: z
      .object({
        offers: minorText,
        preparedConsentedReferrals: minorText,
        integrations: minorText,
        sites: minorText,
      })
      .strict(),
    totals: z.array(
      z
        .object({
          currency: z.string().regex(/^[A-Z]{3}$/),
          mode: z.enum(["SIMULATION_ONLY", "LIVE"]),
          minorUnitScale: z.number().int().min(0).max(4),
          earnedMinor: minorText,
          approvedMinor: minorText,
          payableMinor: minorText,
          simulatedSettledMinor: minorText,
          recoveryDueMinor: minorText,
          actuallyReceivedMinor: minorText.nullable(),
        })
        .strict(),
    ),
    transactions: z.array(ConnectExternalTransactionSchema).max(50),
    nextCursor: z.string().uuid().nullable(),
    internalOrdersCreated: z.literal(0),
    disclosure: z.string().max(700),
  })
  .strict();
export type ConnectPartnerReport = z.infer<typeof ConnectPartnerReportSchema>;
export const ConnectFinancialReceiptSchema = z
  .object({
    duplicate: z.boolean(),
    eventId: connectRef.optional(),
    transaction: ConnectExternalTransactionSchema,
  })
  .strict();
