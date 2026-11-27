/**
 * «جاسم روح بيع لي» (Jassim Go Sell for Me) — Autonomous Seller Marketing Agent Engine.
 * Operates strictly within an explicit SellerMarketingMandate (budget cap, allowed markets,
 * allowed placements, duration). Never invents discounts/warranties, never exposes buyer PII
 * (enforces k >= 10 privacy threshold on Demand Capture), and never creates spend without
 * explicit seller confirmation + verified payment.
 */
import { z } from "zod";

export const DEMAND_PRIVACY_THRESHOLD = 10;
export const AD_PLACEMENTS = ["FEATURED_LISTING", "VIP_LISTING", "REFRESH_LISTING", "SPONSORED_SEARCH", "SPONSORED_RECOMMENDATION", "WELCOME_SPONSORED", "MAIN_BANNER", "SIDEBAR_AD", "STORE_AD", "PRODUCT_PAGE_AD", "SEARCH_RESCUE", "DEMAND_MATCH"] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];
export const WHOP_RESTRICTED_MARKETS = new Set(["IQ", "SY", "LB", "LY", "YE", "SD", "SO", "DJ", "KM", "MR", "PS"]);

export const SellerMarketingMandateSchema = z.object({
  mandateId: z.string().min(4).max(80),
  sellerId: z.string().min(2).max(80),
  marketId: z.string().regex(/^[A-Z]{2}$/),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  allowedListingIds: z.array(z.string().min(1).max(80)).min(1).max(50),
  allowedPlacements: z.array(z.enum(AD_PLACEMENTS)).min(1),
  maxBudgetMinor: z.number().int().min(100),
  durationDays: z.number().int().min(1).max(90),
  allowAutoOptimizationProposals: z.boolean().default(true),
  requireConfirmationForNewSpend: z.literal(true),
});
export type SellerMarketingMandate = z.infer<typeof SellerMarketingMandateSchema>;

export interface SellerListingMetrics { listingId: string; title: string; category: string; stockQuantity: number; unitPriceMinor: number; recentViews: number; recentOrders: number; matchedDemandCount: number; }
export interface ScoredOpportunity { listingId: string; title: string; score: number; recommendedPlacement: AdPlacement; rationaleAr: string; aggregatedDemandBadge: string | null; }

export function scoreGoSellOpportunities(listings: readonly SellerListingMetrics[], mandate: SellerMarketingMandate): ScoredOpportunity[] {
  const allowedSet = new Set(mandate.allowedListingIds);
  const out: ScoredOpportunity[] = [];
  for (const item of listings) {
    if (!allowedSet.has(item.listingId) || item.stockQuantity <= 0) continue;
    const hasPrivacySafeDemand = item.matchedDemandCount >= DEMAND_PRIVACY_THRESHOLD;
    let score = 20;
    let recommendedPlacement: AdPlacement = mandate.allowedPlacements[0];
    let rationaleAr = "منتج متوفر في المخزون وجاهز للترويج الواضح داخل السوق.";
    if (hasPrivacySafeDemand && mandate.allowedPlacements.includes("DEMAND_MATCH")) {
      score += 45; recommendedPlacement = "DEMAND_MATCH"; rationaleAr = "يتطابق مع طلب حقيقي مُجمّع في السوق (مع حماية كاملة لخصوصية المشترين).";
    } else if (item.recentViews >= 50 && item.recentOrders === 0 && mandate.allowedPlacements.includes("SPONSORED_SEARCH")) {
      score += 30; recommendedPlacement = "SPONSORED_SEARCH"; rationaleAr = "يحظى بزيارات جيدة؛ يناسبه ظهور ممول في نتائج البحث مع مراجعة وضوح العرض.";
    } else if (item.recentOrders >= 3 && mandate.allowedPlacements.includes("VIP_LISTING")) {
      score += 35; recommendedPlacement = "VIP_LISTING"; rationaleAr = "أداء مبيعات قوي ومخزون متوفر؛ مرشح مثالي لموضع VIP البارز.";
    } else if (mandate.allowedPlacements.includes("FEATURED_LISTING")) {
      score += 20; recommendedPlacement = "FEATURED_LISTING";
    }
    const aggregatedDemandBadge = hasPrivacySafeDemand ? `طلب مرتفع في السوق (+${Math.floor(item.matchedDemandCount / 10) * 10} مهتم)` : null;
    out.push({ listingId: item.listingId, title: item.title, score, recommendedPlacement, rationaleAr, aggregatedDemandBadge });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface CampaignDraftPlan { mandateId: string; marketId: string; paymentChannelStatus: "WHOP_AVAILABLE" | "LOCAL_ALTERNATIVE_REQUIRED" | "MARKET_PRE_LEGAL_BLOCKED"; selectedItems: ScoredOpportunity[]; allocatedBudgetMinor: number; currencyCode: string; durationDays: number; status: "AWAITING_SELLER_CONFIRMATION"; auditSummary: string; }

export function buildGoSellCampaignDraft(input: { mandate: SellerMarketingMandate; listings: readonly SellerListingMetrics[]; marketOperationMode: "FULL" | "PRE_LEGAL" | "CLOSED"; requestedBudgetMinor: number }): CampaignDraftPlan {
  const mandate = SellerMarketingMandateSchema.parse(input.mandate);
  if (input.requestedBudgetMinor > mandate.maxBudgetMinor) throw new Error("Requested budget exceeds SellerMarketingMandate maxBudgetMinor.");
  const paymentChannelStatus = input.marketOperationMode !== "FULL" ? "MARKET_PRE_LEGAL_BLOCKED" : WHOP_RESTRICTED_MARKETS.has(mandate.marketId) ? "LOCAL_ALTERNATIVE_REQUIRED" : "WHOP_AVAILABLE";
  const selectedItems = scoreGoSellOpportunities(input.listings, mandate).slice(0, 3);
  return { mandateId: mandate.mandateId, marketId: mandate.marketId, paymentChannelStatus, selectedItems, allocatedBudgetMinor: Math.max(0, Math.trunc(input.requestedBudgetMinor)), currencyCode: mandate.currencyCode, durationDays: mandate.durationDays, status: "AWAITING_SELLER_CONFIRMATION", auditSummary: `Draft prepared for ${selectedItems.length} listing(s); zero spend executed prior to seller approval and verified payment.` };
}

export interface CampaignRawMetrics { campaignId: string; impressions: number; qualifiedClicks: number; attributedOrders: number; spendMinor: number; attributedRevenueMinor: number; }
export interface HonestCampaignAnalytics { campaignId: string; impressions: number; qualifiedClicks: number; ctrPercent: number; attributedOrders: number; conversionRatePercent: number; cpcMinor: number | null; cacMinor: number | null; recommendationAr: string; }

export function evaluateCampaignAnalytics(m: CampaignRawMetrics): HonestCampaignAnalytics {
  const ctrPercent = m.impressions > 0 ? Number(((m.qualifiedClicks / m.impressions) * 100).toFixed(2)) : 0;
  const conversionRatePercent = m.qualifiedClicks > 0 ? Number(((m.attributedOrders / m.qualifiedClicks) * 100).toFixed(2)) : 0;
  const cpcMinor = m.qualifiedClicks > 0 ? Math.round(m.spendMinor / m.qualifiedClicks) : null;
  const cacMinor = m.attributedOrders > 0 ? Math.round(m.spendMinor / m.attributedOrders) : null;
  let recommendationAr = "البيانات لا تزال أولية — نوصي بالمتابعة قبل اتخاذ قرار بتعديل الميزانية.";
  if (m.impressions >= 500 && ctrPercent < 1.0) recommendationAr = "معدل النقر منخفض مقارنة بالظهور — نقترح تحسين عنوان الإعلان أو الصورة الرئيسية.";
  else if (m.qualifiedClicks >= 40 && m.attributedOrders === 0) recommendationAr = "النقرات جيدة لكن لا توجد طلبات منسوبة بعد — راجع السعر وتفاصيل صفحة المنتج أو أوقف الحملة مؤقتًا.";
  else if (m.attributedOrders >= 3 && conversionRatePercent >= 3.0) recommendationAr = "أداء الحملة قوي ومثبت بطلبات فعلية — يمكنك الاستمرار ضمن نفس حدود التفويض.";
  return { campaignId: m.campaignId, impressions: m.impressions, qualifiedClicks: m.qualifiedClicks, ctrPercent, attributedOrders: m.attributedOrders, conversionRatePercent, cpcMinor, cacMinor, recommendationAr };
}
