import { z } from "zod";
import { ConnectMoney } from "./connect";

/**
 * How a merchant takes part in DINAR Connect. The mode records the merchant's choice; what it
 * may actually do is derived on the server (verification, review, a verified site, an approved
 * integration). No mode turns on native checkout by itself.
 */
export const CONNECT_PARTICIPATION_MODES = ["SELL_INSIDE_DINAR", "BUY_ON_MERCHANT_WEBSITE", "HYBRID"] as const;
export type ConnectParticipationMode = (typeof CONNECT_PARTICIPATION_MODES)[number];
export const CONNECT_PARTICIPATION_MODE_LABELS: Record<ConnectParticipationMode, string> = {
  SELL_INSIDE_DINAR: "بيع منتجات موقعي داخل دينار",
  BUY_ON_MERCHANT_WEBSITE: "عرض منتجاتي في دينار والشراء من موقعي",
  HYBRID: "البيع داخل دينار ومن موقعي معًا",
};
/** Modes in which a buyer may be sent to the merchant's own website. */
export const CONNECT_EXTERNAL_PURCHASE_MODES: readonly ConnectParticipationMode[] = ["BUY_ON_MERCHANT_WEBSITE", "HYBRID"];
/** Modes in which the merchant sells through DINAR's own listings and checkout. */
export const CONNECT_INTERNAL_SALE_MODES: readonly ConnectParticipationMode[] = ["SELL_INSIDE_DINAR", "HYBRID"];
export const ConnectPartnerInput = z
  .object({
    businessId: z.string().uuid(),
    participationMode: z.enum(CONNECT_PARTICIPATION_MODES).optional(),
  })
  .strict();
export const ConnectParticipationModeInput = z
  .object({
    mode: z.enum(CONNECT_PARTICIPATION_MODES),
    /** The partner revision the owner saw; a stale view is refused instead of overwritten. */
    expectedRevision: z.number().int().positive(),
  })
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
export const CONNECT_MCP_CATALOG_TOOL = "catalog.read_snapshot" as const;
export const CONNECT_MCP_CATALOG_INPUT_SCHEMA = Object.freeze({ additionalProperties: false, properties: Object.freeze({}), type: "object" });
export const CONNECT_MCP_CATALOG_INPUT_SHA256 = "99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa" as const;
export const ConnectOAuthConfiguration = z.object({
  authorizationEndpoint: z.string().url().max(500), tokenEndpoint: z.string().url().max(500),
  clientId: z.string().regex(/^[A-Za-z0-9._~-]{1,200}$/), scopes: z.array(z.literal("catalog.read")).length(1),
}).strict();
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
    oauth: ConnectOAuthConfiguration.optional(),
    websiteCategoryId: z.string().min(1).max(80).optional(),
    reviewedTools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/),
            inputSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
            readOnly: z.literal(true),
            capability: z.literal("CATALOG_READ"),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict().superRefine((input, ctx) => {
    if (input.kind === "OAUTH" && (!input.oauth || !input.endpointUrl || input.mode !== "SIMULATION_ONLY"))
      ctx.addIssue({ code: "custom", message: "OAuth requires a sandbox public-client configuration and catalog endpoint" });
    if (input.kind === "WEBSITE" && input.endpointUrl && !input.websiteCategoryId)
      ctx.addIssue({ code: "custom", message: "Website indexing requires an explicitly reviewed category mapping" });
    if (input.kind !== "WEBSITE" && input.websiteCategoryId !== undefined)
      ctx.addIssue({ code: "custom", message: "Website category mapping belongs only to website indexing" });
    if (input.kind === "MCP" && (input.mode !== "SIMULATION_ONLY" || input.reviewedTools?.length !== 1 ||
        input.reviewedTools[0]?.name !== CONNECT_MCP_CATALOG_TOOL || input.reviewedTools[0]?.inputSchemaSha256 !== CONNECT_MCP_CATALOG_INPUT_SHA256))
      ctx.addIssue({ code: "custom", message: "MCP requires the fixed reviewed read-only catalog contract" });
    if (!["OAUTH", "MCP"].includes(input.kind) && input.oauth)
      ctx.addIssue({ code: "custom", message: "OAuth configuration belongs only to OAuth integrations" });
  });
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
export const ConnectCatalogReceiptSchema = z.object({
  batchId: connectRef, accepted: z.number().int().min(0).max(100), duplicate: z.boolean(), internalListingsCreated: z.literal(0),
  source: z.literal("WEBSITE").optional(), websiteStatus: z.enum(["OBSERVED", "NO_VERIFIABLE_DATA"]).optional(),
  hiddenCount: z.number().int().nonnegative().optional(), observedAt: z.string().datetime().optional(), observationDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type ConnectCatalogReceipt = z.infer<typeof ConnectCatalogReceiptSchema>;
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
export const ConnectAgreementViewSchema = z.object({
 id:z.string().uuid(),partnerId:z.string().uuid(),version:z.number().int().positive(),terms:ConnectAgreementTerms,
 termsDigest:z.string().regex(/^[a-f0-9]{64}$/),proposedBy:z.string().uuid(),createdAt:z.string().datetime(),accepted:z.boolean(),
 acceptance:z.object({acceptedBy:z.string().uuid(),acceptedAt:z.string().datetime(),termsDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable(),
}).strict().superRefine((row,ctx)=>{if(row.accepted!==Boolean(row.acceptance)||row.acceptance&&row.acceptance.termsDigest!==row.termsDigest)ctx.addIssue({code:"custom",message:"Acceptance must match the exact proposed terms"});});
export type ConnectAgreementRecord = z.infer<typeof ConnectAgreementViewSchema>;

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
export const ConnectOAuthStatusSchema = z.object({ connected: z.boolean(), canRefresh: z.boolean(), expiresAt: z.string().datetime().nullable(), scope: z.literal("catalog.read").nullable() }).strict();
export type ConnectOAuthStatus = z.infer<typeof ConnectOAuthStatusSchema>;
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

export const CONNECT_SYNC_FAILURE_REASONS = [
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_INVALID_RESPONSE",
  "PROVIDER_INVALID_CONTENT_TYPE",
  "PROVIDER_INVALID_CATALOG",
  "PROVIDER_RESPONSE_TOO_LARGE",
  "PROVIDER_HEADERS_REFUSED",
  "PRIVATE_ENDPOINT",
  "REDIRECT_REFUSED",
  "UNSAFE_EXTERNAL_URL",
  "MCP_INVALID_RESPONSE",
  "MCP_REVIEW_REQUIRED",
  "PINNED_EGRESS_REQUIRED",
  "STALE_INTEGRATION",
  "SITE_NOT_VERIFIED",
  "OAUTH_GRANT_UNAVAILABLE",
  "WEBSITE_TOO_LARGE",
  "WEBSITE_TOO_COMPLEX",
  "WEBSITE_TOO_MANY_ITEMS",
  "WEBSITE_INVALID_CONTENT_TYPE",
  "UNEXPECTED_FAILURE",
] as const;
export const ConnectSyncObservationSchema = z
  .object({
    integrationId: z.string().uuid(),
    outcome: z.enum(["COMPLETED", "FAILED"]),
    reason: z.enum(CONNECT_SYNC_FAILURE_REASONS).nullable(),
    reviewedRevision: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.outcome === "COMPLETED") !== (value.reason === null))
      ctx.addIssue({ code: "custom", message: "Outcome/reason mismatch" });
  });
const connectCount = z.string().regex(/^\d+$/);
export const ConnectDiagnosticsQuerySchema = z
  .object({
    integrationCursor: z.string().uuid().optional(),
    auditCursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
export const ConnectDiagnosticsSchema = z
  .object({
    partnerId: z.string().uuid(),
    generatedAt: z.string().datetime(),
    observationWindowStart: z.string().datetime(),
    providerHealth: z.literal("NOT_PROBED"),
    integrations: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().min(1).max(100),
            kind: z.enum(["WEBSITE", "FEED", "API", "OAUTH", "MCP"]),
            status: z.enum([
              "PENDING_REVIEW",
              "APPROVED",
              "REJECTED",
              "SUSPENDED",
              "REVOKED",
            ]),
            revision: z.number().int().positive(),
            approvedRevision: z.number().int().positive().nullable(),
            endpointConfigured: z.boolean(),
            siteStatus: z.enum(["PENDING", "VERIFIED", "REVOKED"]),
            proofValidUntil: z.string().datetime().nullable(),
            proofCurrentlyValid: z.boolean(),
            ingressStatus: z.enum(["ACTIVE", "REVOKED", "NOT_CONFIGURED"]),
            activeIngressCredentials: connectCount,
            lastSuccessfulIngressAt: z.string().datetime().nullable(),
            lastCatalogAcceptedAt: z.string().datetime().nullable(),
            catalog: z
              .object({
                published: connectCount,
                hidden: connectCount,
                stale: connectCount,
              })
              .strict(),
            lastObservedSync: ConnectSyncObservationSchema.safeExtend({
              observedAt: z.string().datetime(),
            }).nullable(),
          })
          .strict(),
      )
      .max(50),
    audit: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            actorKind: z.enum(["OWNER", "ADMIN", "PROVIDER", "SYSTEM"]),
            action: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(50),
    reviewSignals: z
      .object({
        failedAdmittedReads24h: connectCount,
        protectedResponseRefusals24h: connectCount,
        suspensions24h: connectCount,
        currentDisputes: connectCount,
        recoveryObligationTransactions: connectCount,
      })
      .strict(),
    nextIntegrationCursor: z.string().uuid().nullable(),
    nextAuditCursor: z.string().uuid().nullable(),
    secretsIncluded: z.literal(false),
    disclosure: z.string().min(1).max(700),
  })
  .strict();
export type ConnectDiagnostics = z.infer<typeof ConnectDiagnosticsSchema>;
