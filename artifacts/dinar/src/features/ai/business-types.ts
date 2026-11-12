/** Allowlisted business views sent by the server (D3-A). The client only renders them. */
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";

export const BUSINESS_SURFACES = CONVERSATION_SURFACE_FAMILIES.business;
export type BusinessSurface = (typeof BUSINESS_SURFACES)[number];

export type BusinessListing = {
  listingId: string;
  title: string;
  status: string;
  priceMinor: number | null;
  price?: string | null;
  currency?: string;
  inventoryMode: "UNLIMITED" | "LIMITED";
  availableQuantity: number | null;
  reservedQuantity: number;
  category?: string;
  updatedAt?: string;
};

export type BusinessDraft = {
  draftId: string;
  title: string;
  description?: string;
  priceMinor: number;
  price?: string;
  currency?: string;
  category?: string | null;
  categoryId?: string | null;
  area?: string;
  fulfilment?: string;
};

export type BusinessOrder = {
  orderId: string;
  status: string;
  currencyCode: string;
  subtotalMinor: number;
  sellerAmountMinor: number;
  total?: string;
  createdAt: string;
  itemCount: number;
};

export type BusinessInsights = {
  listings: number;
  published: number;
  paused: number;
  completedOrders: number;
  completedRevenueMinor: number;
  completedRevenue?: string;
  /** Completed orders by order month (server-computed, last six months, display amounts priced server-side). */
  monthly?: { month: string; completedOrders: number; revenueMinor: number; revenue?: string }[];
  currencyCode?: string;
  minorUnitScale?: number;
};

export type BusinessSelection = {
  businessId: string;
  name: string;
  businessTypeLabel?: string;
  status?: string;
  identityStatus?: string;
};

export type BusinessSummary = {
  total: number;
  published: number;
  paused: number;
  outOfStock?: number;
};

export type BusinessPayload = {
  view: string;
  businessId?: string;
  name?: string;
  businessName?: string;
  description?: string;
  businessType?: string;
  businessTypeLabel?: string;
  status?: string;
  operatingMode?: string;
  identityStatus?: string;
  verificationStatus?: string;
  publicationEligibility?: string;
  publishable?: boolean;
  canPublish?: boolean;
  canDraft?: boolean;
  canManageProfile?: boolean;
  missingField?: string;
  prompt?: string;
  registrationNotice?: string;
  blockedReason?: string;
  publicPath?: string;
  summary?: BusinessSummary;
  listings?: BusinessListing[];
  drafts?: BusinessDraft[];
  orders?: BusinessOrder[];
  insights?: BusinessInsights;
  selection?: boolean;
  businesses?: BusinessSelection[];
  title?: string;
  lines?: string[];
  reviewLines?: string[];
  listingId?: string;
  pendingActionId?: string;
  expiresAt?: string;
  resultSetId?: string;
  notice?: string;
  stale?: boolean;
  empty?: boolean;
  allowedActions?: string[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stringArray = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
const itemsOf = (value: unknown, key: string) =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => isObject(item) && typeof item[key] === "string"));

/**
 * The card's view is the surface token's suffix, and every list it carries is checked before
 * anything is rendered. A block whose business payload does not describe its own surface is
 * dropped rather than partially shown.
 */
export function normalizeBusiness(value: unknown, surface: string): BusinessPayload | null {
  if (!isObject(value)) return null;
  if (!(BUSINESS_SURFACES as readonly string[]).includes(surface)) return null;
  if (surface !== `BUSINESS_${value.view}`) return null;
  if (!stringArray(value.allowedActions) || !stringArray(value.lines) || !stringArray(value.reviewLines))
    return null;
  if (!itemsOf(value.listings, "listingId") || !itemsOf(value.drafts, "draftId")) return null;
  if (!itemsOf(value.orders, "orderId") || !itemsOf(value.businesses, "businessId")) return null;
  return value as unknown as BusinessPayload;
}

export const BUSINESS_ACTION_IDS = [
  "CONFIRM",
  "CANCEL",
  "ACTIVATE",
  "CATALOG",
  "ORDERS",
  "INSIGHTS",
  "DRAFTS",
  "PAUSE",
  "RESUME",
  "PRICE",
  "STOCK_OUT",
  "PUBLISH",
] as const;
