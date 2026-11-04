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
