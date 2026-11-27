/**
 * AI-06 — Server-Side Adapter for Universal Infinite Card Engine (JassimCardSpec v1).
 * Validates external-LLM card proposals and hydrates authoritative server prices & totals
 * from the catalog price ledger — stripping any price guessed or hallucinated by the LLM.
 */
import { z } from "zod";

export const StageModeSchema = z.enum(["LAYERED_STACK", "MANNEQUIN", "PRODUCT_STUDIO"]);

export const ExternalModelCardProposalSchema = z.object({
  cardId: z.string().min(2).max(80),
  vertical: z.string().min(2).max(60),
  listingId: z.string().min(1).max(80),
  merchantName: z.string().min(1).max(120),
  merchantTier: z.enum(["BUSINESS", "INDIVIDUAL", "CONNECT_PARTNER"]),
  title: z.string().min(2).max(160),
  subtitle: z.string().max(240).optional(),
  badge: z.string().max(40).optional(),
  stageMode: StageModeSchema,
  selectedOptionIds: z.array(z.string().max(64)).max(30).default([]),
  quantity: z.number().int().min(1).max(50).default(1),
  primaryCtaLabel: z.string().min(2).max(60).default("اعتماد الاختيار"),
});
export type ExternalModelCardProposal = z.infer<typeof ExternalModelCardProposalSchema>;

export interface ServerCatalogPricing {
  listingId: string;
  currencyCode: string;
  currencyDecimals: number;
  baseUnitMinor: number;
  optionDeltasMinor: Readonly<Record<string, number>>;
}

export interface HydratedCardQuote {
  unitMinor: number;
  totalMinor: number;
  currencyCode: string;
  unitLabel: string;
  totalLabel: string;
  optionDeltaLabels: Record<string, string>;
}

export function formatMinorCurrency(minor: number, currencyCode: string, decimals = 2): string {
  const factor = Math.pow(10, decimals);
  return `${(minor / factor).toFixed(decimals)} ${currencyCode}`;
}

export function calculateAuthoritativeCardQuote(input: {
  pricing: ServerCatalogPricing;
  selectedOptionIds: readonly string[];
  quantity: number;
}): HydratedCardQuote {
  const qty = Math.max(1, Math.min(50, Math.trunc(input.quantity)));
  const uniqueIds = [...new Set(input.selectedOptionIds)];
  let extrasMinor = 0;
  const optionDeltaLabels: Record<string, string> = {};

  for (const id of uniqueIds) {
    const delta = input.pricing.optionDeltasMinor[id];
    if (typeof delta === "number" && Number.isFinite(delta) && delta >= 0) {
      extrasMinor += Math.trunc(delta);
      if (delta > 0) {
        optionDeltaLabels[id] = `+${formatMinorCurrency(delta, input.pricing.currencyCode, input.pricing.currencyDecimals)}`;
      }
    }
  }

  const unitMinor = Math.max(0, Math.trunc(input.pricing.baseUnitMinor)) + extrasMinor;
  const totalMinor = unitMinor * qty;

  return {
    unitMinor,
    totalMinor,
    currencyCode: input.pricing.currencyCode,
    unitLabel: formatMinorCurrency(unitMinor, input.pricing.currencyCode, input.pricing.currencyDecimals),
    totalLabel: formatMinorCurrency(totalMinor, input.pricing.currencyCode, input.pricing.currencyDecimals),
    optionDeltaLabels,
  };
}

export function buildHydratedUniversalCardEnvelope(rawProposal: unknown, pricing: ServerCatalogPricing) {
  const proposal = ExternalModelCardProposalSchema.parse(rawProposal);
  if (proposal.listingId !== pricing.listingId) {
    throw new Error("Proposal listingId does not match authoritative server catalog pricing.");
  }
  const quote = calculateAuthoritativeCardQuote({
    pricing,
    selectedOptionIds: proposal.selectedOptionIds,
    quantity: proposal.quantity,
  });
  return {
    schemaVersion: "1.0" as const,
    cardId: proposal.cardId,
    vertical: proposal.vertical,
    merchantName: proposal.merchantName,
    merchantTier: proposal.merchantTier,
    title: proposal.title,
    subtitle: proposal.subtitle,
    badge: proposal.badge,
    stageMode: proposal.stageMode,
    primaryCtaLabel: proposal.primaryCtaLabel,
    quote: {
      unitLabel: quote.unitLabel,
      totalLabel: quote.totalLabel,
      pendingRequote: false,
    },
    optionDeltaLabels: quote.optionDeltaLabels,
  };
}
