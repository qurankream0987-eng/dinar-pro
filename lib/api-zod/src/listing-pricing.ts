/**
 * The single, pure authority for what a listing's price means and which commercial
 * actions it permits. Server (checkout, cart, negotiation, conversation) and web share it.
 *
 * Storage keeps the three canonical `offers.pricing_mode` values. The two remaining
 * representations are stored as OPEN_TO_OFFERS plus `data.priceRepresentation`, because
 * neither is a binding purchase price:
 *
 *   FIXED           definite asking price; direct purchase or a buyer proposal
 *   NEGOTIABLE      asking price presented for negotiation; bought at an agreed price
 *   OPEN_TO_OFFERS  proposals with an optional guide price
 *   STARTING_FROM   advertised starting amount (stored price); the exact price is agreed
 *   QUOTE_REQUIRED  no price; the buyer asks, the seller quotes, the buyer accepts or negotiates
 *
 * Every published listing accepts a buyer proposal, whatever its category or representation.
 * Acceptance always belongs to the party the proposal is addressed to.
 */
import { LISTING_PRICING_MODES, type ListingPricingMode } from "./marketplace-schemas";

export const PRICE_REPRESENTATIONS = [
  "FIXED",
  "NEGOTIABLE",
  "OPEN_TO_OFFERS",
  "STARTING_FROM",
  "QUOTE_REQUIRED",
] as const;
export type PriceRepresentation = (typeof PRICE_REPRESENTATIONS)[number];

/** Representations stored as OPEN_TO_OFFERS with a `data.priceRepresentation` marker. */
export const TAGGED_PRICE_REPRESENTATIONS = ["STARTING_FROM", "QUOTE_REQUIRED"] as const;
export type TaggedPriceRepresentation = (typeof TAGGED_PRICE_REPRESENTATIONS)[number];

export const PRICE_REPRESENTATION_LABELS: Record<PriceRepresentation, string> = {
  FIXED: "سعر محدد",
  NEGOTIABLE: "سعر قابل للتفاوض",
  OPEN_TO_OFFERS: "يستقبل العروض",
  STARTING_FROM: "يبدأ من",
  QUOTE_REQUIRED: "حسب التسعيرة",
};

/** The short label shown next to (or instead of) a price on cards and details. */
export const PRICE_REPRESENTATION_PRICE_NOTE: Record<PriceRepresentation, string | undefined> = {
  FIXED: undefined,
  NEGOTIABLE: "قابل للتفاوض",
  OPEN_TO_OFFERS: "سعر استرشادي",
  STARTING_FROM: "يبدأ من",
  QUOTE_REQUIRED: undefined,
};

type PricedListing = {
  pricingMode: string;
  unitPriceMinor: number | null;
  data?: unknown;
};

const isPositive = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value >= 1;

function tagOf(data: unknown): unknown {
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).priceRepresentation
    : undefined;
}

/**
 * What a stored listing's price means. Pre-0030 rows (raw STARTING_FROM / QUOTE_REQUIRED
 * modes) keep their meaning; an inconsistent marker falls back to the stored mode.
 * Returns null for a mode this code does not know, which callers treat as unavailable.
 */
export function priceRepresentationOf(row: PricedListing): PriceRepresentation | null {
  const price = row.unitPriceMinor;
  switch (row.pricingMode) {
    case "FIXED":
    case "NEGOTIABLE":
      return isPositive(price) ? row.pricingMode : null;
    case "OPEN_TO_OFFERS": {
      const tag = tagOf(row.data);
      if (tag === "STARTING_FROM" && isPositive(price)) return "STARTING_FROM";
      if (tag === "QUOTE_REQUIRED" && price === null) return "QUOTE_REQUIRED";
      return "OPEN_TO_OFFERS";
    }
    case "STARTING_FROM":
      return isPositive(price) ? "STARTING_FROM" : null;
    case "QUOTE_REQUIRED":
      return price === null ? "QUOTE_REQUIRED" : null;
    default:
      return null;
  }
}

/** The representation a listing API record (major-unit string price) carries. */
export function priceRepresentationOfRecord(record: {
  pricingMode: string;
  unitPrice: string | null;
  priceRepresentation?: string | null;
}): PriceRepresentation | null {
  if (
    record.priceRepresentation &&
    (PRICE_REPRESENTATIONS as readonly string[]).includes(record.priceRepresentation)
  )
    return record.priceRepresentation as PriceRepresentation;
  return priceRepresentationOf({
    pricingMode: record.pricingMode,
    unitPriceMinor: record.unitPrice === null ? null : 1,
  });
}

export type StoredPricing = {
  pricingMode: ListingPricingMode;
  /** Written to `data.priceRepresentation`; null clears a previous marker. */
  priceRepresentation: TaggedPriceRepresentation | null;
};

/**
 * How a seller's chosen representation is stored, or the reason it cannot be.
 * The price rules are the representation's own: a definite or starting price needs an
 * amount, a quotation listing must not carry one.
 */
export function storedPricingFor(
  representation: PriceRepresentation,
  unitPriceMinor: number | null,
): StoredPricing | { problem: string } {
  switch (representation) {
    case "FIXED":
    case "NEGOTIABLE":
      return isPositive(unitPriceMinor)
        ? { pricingMode: representation, priceRepresentation: null }
        : { problem: "سعر الوحدة مطلوب لهذا النوع من التسعير." };
    case "STARTING_FROM":
      return isPositive(unitPriceMinor)
        ? { pricingMode: "OPEN_TO_OFFERS", priceRepresentation: "STARTING_FROM" }
        : { problem: "اكتب السعر الذي يبدأ منه العرض." };
    case "QUOTE_REQUIRED":
      return unitPriceMinor === null
        ? { pricingMode: "OPEN_TO_OFFERS", priceRepresentation: "QUOTE_REQUIRED" }
        : { problem: "أزل السعر عند اختيار «حسب التسعيرة»؛ يرسل البائع تسعيرته للمشتري." };
    case "OPEN_TO_OFFERS":
      return unitPriceMinor === null || isPositive(unitPriceMinor)
        ? { pricingMode: "OPEN_TO_OFFERS", priceRepresentation: null }
        : { problem: "السعر الاسترشادي غير صالح." };
  }
}

/** The representation a seller means when only the canonical mode (or legacy flag) is sent. */
export function defaultRepresentationFor(input: {
  pricingMode?: ListingPricingMode;
  negotiable?: boolean;
  unitPriceMinor: number | null;
}): PriceRepresentation {
  if (input.pricingMode && (LISTING_PRICING_MODES as readonly string[]).includes(input.pricingMode))
    return input.pricingMode;
  if (input.negotiable === true) return "NEGOTIABLE";
  return input.unitPriceMinor === null ? "OPEN_TO_OFFERS" : "FIXED";
}

/** Only a definite asking price is bought without an agreement. */
export function directPurchaseAllowed(
  representation: PriceRepresentation | null,
  unitPriceMinor: number | null,
): boolean {
  return representation === "FIXED" && isPositive(unitPriceMinor);
}

/** Universal negotiation: every known representation accepts a buyer proposal. */
export function acceptsPriceProposals(representation: PriceRepresentation | null): boolean {
  return representation !== null;
}

/**
 * The highest amount a proposal may carry. Above a definite asking price there is nothing to
 * negotiate (the buyer can buy it); a starting amount or guide price is not a ceiling.
 */
export function proposalCeilingMinor(
  representation: PriceRepresentation | null,
  unitPriceMinor: number | null,
): number | null {
  return (representation === "FIXED" || representation === "NEGOTIABLE") && isPositive(unitPriceMinor)
    ? unitPriceMinor
    : null;
}

export type ListingBuyerAction =
  | "BUY_AT_LISTED_PRICE"
  | "BUY_AT_AGREED_PRICE"
  | "MAKE_OFFER"
  | "NEGOTIATE"
  | "REQUEST_QUOTE";

export const LISTING_BUYER_ACTION_LABELS: Record<ListingBuyerAction, string> = {
  BUY_AT_LISTED_PRICE: "شراء بالسعر المعروض",
  BUY_AT_AGREED_PRICE: "شراء بالسعر المتفق عليه",
  MAKE_OFFER: "قدّم عرض سعر",
  NEGOTIATE: "تفاوض مع البائع",
  REQUEST_QUOTE: "اطلب تسعيرة",
};

/**
 * The buyer actions a listing card may show, primary first. A seller viewing their own
 * listing, or a listing that is not published or has no stock, gets none.
 */
export function listingBuyerActions(input: {
  representation: PriceRepresentation | null;
  unitPriceMinor: number | null;
  viewerIsSeller: boolean;
  published: boolean;
  inStock: boolean;
  hasAgreement?: boolean;
}): ListingBuyerAction[] {
  if (input.viewerIsSeller || !input.published || !input.inStock || input.representation === null) return [];
  if (input.hasAgreement) return ["BUY_AT_AGREED_PRICE"];
  switch (input.representation) {
    case "FIXED":
      return directPurchaseAllowed("FIXED", input.unitPriceMinor) ? ["BUY_AT_LISTED_PRICE", "MAKE_OFFER"] : ["MAKE_OFFER"];
    case "NEGOTIABLE":
      return ["NEGOTIATE"];
    case "OPEN_TO_OFFERS":
      return ["MAKE_OFFER"];
    case "STARTING_FROM":
      return ["REQUEST_QUOTE", "MAKE_OFFER"];
    case "QUOTE_REQUIRED":
      return ["REQUEST_QUOTE", "MAKE_OFFER"];
  }
}

export type NegotiationDecision = "ACCEPT" | "REJECT" | "COUNTER" | "WITHDRAW";

export const NEGOTIATION_DECISION_LABELS: Record<NegotiationDecision, string> = {
  ACCEPT: "قبول العرض",
  REJECT: "رفض العرض",
  COUNTER: "عرض مقابل",
  WITHDRAW: "سحب العرض",
};

/**
 * The decisions one party may take on a negotiation now. Only the party a proposal awaits
 * accepts, rejects or counters it; either party may withdraw while nothing is agreed.
 */
export function negotiationDecisions(input: {
  role: "BUYER" | "SELLER";
  status: string;
  amountOnTable: boolean;
}): NegotiationDecision[] {
  const awaiting = input.status === "OPEN" ? "SELLER" : input.status === "COUNTERED" ? "BUYER" : null;
  if (!awaiting) return [];
  if (awaiting !== input.role) return ["WITHDRAW"];
  const decisions: NegotiationDecision[] = input.amountOnTable ? ["ACCEPT", "COUNTER", "REJECT"] : ["COUNTER", "REJECT"];
  return input.role === "BUYER" ? [...decisions, "WITHDRAW"] : decisions;
}
