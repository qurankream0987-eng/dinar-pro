import { z } from "zod";

export const ConnectMoney = z
  .object({
    amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    minorUnitScale: z.number().int().min(0).max(4),
  })
  .strict();
export const ConnectExternalAction = z
  .object({
    kind: z.literal("EXTERNAL_LINK"),
    providerId: z.string().min(1).max(80),
    targetId: z.string().min(1).max(400),
    intent: z.enum(["SEARCH_ON_PROVIDER", "VIEW_ON_PROVIDER"]),
    label: z.string().min(1).max(100),
  })
  .strict();
export const DomainOfferSchema = z
  .object({
    providerId: z.string().min(1).max(80),
    providerName: z.string().min(1).max(120),
    domain: z.string().min(3).max(253),
    availability: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]),
    premium: z.boolean().nullable(),
    registrationPrice: ConnectMoney.nullable(),
    renewalPrice: ConnectMoney.nullable(),
    source: z.string().min(1).max(200),
    lastCheckedAt: z.string().datetime().nullable(),
    status: z.enum([
      "CHECKED",
      "NOT_CONFIGURED",
      "RATE_LIMITED",
      "TIMEOUT",
      "UNAVAILABLE",
      "UNAUTHORIZED",
      "INVALID_RESPONSE",
    ]),
    providerMode: z.enum(["SANDBOX", "LIVE", "NOT_CONNECTED"]),
    retryAfterSeconds: z.number().int().min(1).max(3600).optional(),
    reason: z.string().max(100).optional(),
    action: ConnectExternalAction,
    affiliateRelationship: z.literal(false),
  })
  .strict()
  .superRefine((offer, ctx) => {
    if (
      offer.status !== "CHECKED" &&
      (offer.availability !== "UNKNOWN" ||
        offer.registrationPrice ||
        offer.renewalPrice ||
        offer.lastCheckedAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "Unverified registrar results must remain unknown",
      });
    if (
      offer.status === "CHECKED" &&
      (!offer.lastCheckedAt || offer.providerMode === "NOT_CONNECTED")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "A checked result requires its source environment and timestamp",
      });
    if (
      offer.availability === "UNAVAILABLE" &&
      (offer.registrationPrice || offer.renewalPrice)
    )
      ctx.addIssue({
        code: "custom",
        message: "Unavailable domains cannot carry a registration quote",
      });
  });
export type DomainOffer = z.infer<typeof DomainOfferSchema>;
export type ConnectMoneyValue = z.infer<typeof ConnectMoney>;

/** Display data, never a model-executable tool or a second transaction protocol. */
export const UniversalCardSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(400),
    kind: z.enum([
      "INTERNAL_PRODUCT",
      "INTERNAL_SERVICE",
      "EXTERNAL_PRODUCT",
      "EXTERNAL_SERVICE",
      "DOMAIN_REGISTRATION",
      "COMPARISON",
      "ORDER_STATUS",
      "TRANSACTION_STATUS",
      "CAPABILITY",
    ]),
    commerceMode: z.enum([
      "INTERNAL_DINAR",
      "EXTERNAL_REFERRAL",
      "EXTERNAL_AUTHORIZED_ACTION",
    ]),
    title: z.string().min(1).max(180),
    description: z.string().max(700).optional(),
    internalResourceId: z.string().min(1).max(200).optional(),
    providerId: z.string().min(1).max(80).optional(),
    facts: z
      .array(
        z
          .object({
            label: z.string().min(1).max(80),
            value: z.string().max(300).nullable(),
            source: z.enum(["INTERNAL_RECORD", "PROVIDER_RECORD", "UNKNOWN"]),
          })
          .strict(),
      )
      .max(20),
    price: ConnectMoney.nullable(),
    availability: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]),
    checkedAt: z.string().datetime().nullable(),
    sourceLabel: z.string().min(1).max(200),
    domain: DomainOfferSchema.optional(),
    externalActions: z.array(ConnectExternalAction).max(3),
    disclosure: z.string().min(1).max(500).optional(),
    authorizedCapabilityId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((card, ctx) => {
    if (
      card.facts.some(
        (fact) => fact.source === "UNKNOWN" && fact.value !== null,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Unknown attributes have no asserted value",
      });
    if (card.price && !card.checkedAt)
      ctx.addIssue({
        code: "custom",
        message: "A price requires its recorded verification timestamp",
      });
    const internalKind = [
      "INTERNAL_PRODUCT",
      "INTERNAL_SERVICE",
      "ORDER_STATUS",
      "TRANSACTION_STATUS",
    ].includes(card.kind);
    if (
      internalKind &&
      card.commerceMode === "INTERNAL_DINAR" &&
      !card.internalResourceId
    )
      ctx.addIssue({
        code: "custom",
        message: "Internal cards require the canonical resource identity",
      });
    if (
      ["EXTERNAL_PRODUCT", "EXTERNAL_SERVICE", "DOMAIN_REGISTRATION"].includes(
        card.kind,
      ) &&
      card.commerceMode === "INTERNAL_DINAR"
    )
      ctx.addIssue({
        code: "custom",
        message:
          "External commerce cannot be presented as an internal purchase",
      });
    if ((card.kind === "DOMAIN_REGISTRATION") !== Boolean(card.domain))
      ctx.addIssue({
        code: "custom",
        message: "Domain presentation requires its typed registrar result",
      });
    if (
      card.domain &&
      (card.providerId !== card.domain.providerId ||
        card.checkedAt !== card.domain.lastCheckedAt ||
        card.availability !== card.domain.availability ||
        JSON.stringify(card.price) !==
          JSON.stringify(card.domain.registrationPrice))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Domain presentation must match the authoritative registrar result",
      });
    if (
      card.commerceMode !== "INTERNAL_DINAR" &&
      (internalKind || card.internalResourceId)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "External referrals cannot carry an internal cart/order resource",
      });
    if (card.commerceMode === "INTERNAL_DINAR" && card.externalActions.length)
      ctx.addIssue({
        code: "custom",
        message: "Internal marketplace actions use the existing authority",
      });
    if (
      card.commerceMode !== "INTERNAL_DINAR" &&
      (!card.providerId || !card.disclosure)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "External cards require a provider and external checkout disclosure",
      });
    if (
      card.commerceMode === "EXTERNAL_AUTHORIZED_ACTION" &&
      !card.authorizedCapabilityId
    )
      ctx.addIssue({
        code: "custom",
        message: "Authorized external capability requires an approved grant",
      });
    if (
      card.externalActions.some(
        (action) => action.providerId !== card.providerId,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Card and action provider must match",
      });
  });
export const UniversalCardsPayloadSchema = z
  .object({
    version: z.literal(1),
    cards: z.array(UniversalCardSchema).max(12),
    note: z.string().max(700),
    comparisonNote: z.string().max(700).optional(),
  })
  .strict();
export type UniversalCard = z.infer<typeof UniversalCardSchema>;
export type UniversalCardsPayload = z.infer<typeof UniversalCardsPayloadSchema>;

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
    evidenceReference: z.string().trim().min(3).max(200),
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
    evidenceReference: z.string().min(3).max(200),
    providerEventId: connectRef.optional(),
    resolution: z.enum(["RESTORE_SUPPORTED_STATE", "REVERSE"]).optional(),
  })
  .strict();
export const CONNECT_TEAM_SCOPES = [
  "CATALOG_READ",
  "CATALOG_MANAGE",
  "INTEGRATIONS_MANAGE",
  "REPORTS_READ",
] as const;
export const ConnectTeamInput = z
  .object({
    delegationId: z.string().uuid(),
    scopes: z.array(z.enum(CONNECT_TEAM_SCOPES)).max(4),
  })
  .strict();
