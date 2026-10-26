/** Allowlisted seller promotion views sent by the server (Block E). The client only renders them. */
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
export const PROMOTION_SURFACES = CONVERSATION_SURFACE_FAMILIES.promotion;
export type PromotionSurface = (typeof PROMOTION_SURFACES)[number];

export type PromotionPlan = {
  id: string;
  name: string;
  placement: string;
  durationDays: number;
  priceMinor: number;
  currencyCode: string;
  priceLabel: string;
};

export type PromotionCampaign = {
  id: string;
  listingId: string;
  listingTitle: string;
  productName: string;
  placementLabel: string;
  durationDays: number;
  priceLabel: string;
  status: string;
  effectiveStatus: string;
  paymentStatus: string;
  serving: boolean;
  servingNote: string;
  startsAt: string;
  expiresAt: string;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  autoRenew: false;
};

export type PromotionPayload = {
  view: PromotionSurface;
  step?: "LISTING" | "PLAN" | "INFO";
  sponsoredLabel?: string;
  notice?: string;
  listings?: { id: string; title: string; hasLivePromotion: boolean }[];
  listing?: { id: string; title: string };
  plans?: PromotionPlan[];
  planGroups?: { categoryId: string; categoryLabel: string; plans: PromotionPlan[] }[];
  review?: {
    listingId: string;
    listingTitle: string;
    plan: PromotionPlan;
    placementLabel: string;
    sponsoredLabel: string;
    startNote: string;
    endNote: string;
  };
  promotion?: PromotionCampaign;
  promotions?: PromotionCampaign[];
  action?: {
    actionId: string;
    type: "PURCHASE" | "CANCEL";
    status: "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED" | "REJECTED";
    statusLabel: string;
  };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const arrayOfObjects = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every((item) => isObject(item) && typeof item.id === "string"));

/** Shape check of a server promotion payload; anything unexpected is not rendered. */
export function normalizePromotion(value: unknown, surface: string): PromotionPayload | null {
  if (!isObject(value) || value.view !== surface) return null;
  if (!(PROMOTION_SURFACES as readonly string[]).includes(surface)) return null;
  if (!arrayOfObjects(value.listings) || !arrayOfObjects(value.plans) || !arrayOfObjects(value.promotions)) return null;
  if (value.promotion !== undefined && (!isObject(value.promotion) || typeof value.promotion.id !== "string")) return null;
  if (value.review !== undefined && (!isObject(value.review) || !isObject(value.review.plan))) return null;
  if (value.action !== undefined && (!isObject(value.action) || typeof value.action.actionId !== "string")) return null;
  return value as unknown as PromotionPayload;
}
