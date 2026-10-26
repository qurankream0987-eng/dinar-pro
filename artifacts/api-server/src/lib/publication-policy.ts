import { db, marketplacePolicyRules } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { normalizeSearch } from "../ai/search-context";
import { assertAccountCanTransact } from "./account-status";
import { assertPublicListingLocation } from "./location-policy";
import { assertMarketPolicy, type marketFor } from "./markets";
import type { MarketplaceCategoryRow } from "./marketplace-categories";
import { currentPolicy } from "./policies";
import { reviewListingImagesForPublication } from "./listing-image-publication-review";

type Market = Awaited<ReturnType<typeof marketFor>>;
export type PolicyRule = typeof marketplacePolicyRules.$inferSelect;

/**
 * Deterministic marketplace policy for structured restrictions.
 *
 * CATEGORY, RESOURCE_TYPE, and FULFILMENT rules are exact structured checks.
 * TERM rules block known listing wording; text matching cannot establish legal
 * compliance, so uncertain content is left to reporting and moderation.
 */
export async function activePolicyRules(
  marketId: string,
  tx: any = db,
): Promise<PolicyRule[]> {
  return tx
    .select()
    .from(marketplacePolicyRules)
    .where(
      and(
        eq(marketplacePolicyRules.isActive, true),
        or(
          isNull(marketplacePolicyRules.marketId),
          eq(marketplacePolicyRules.marketId, marketId),
        ),
      ),
    );
}

export type PolicySubject = {
  categoryId?: string;
  categoryLabel?: string;
  resourceType?: string;
  fulfilmentType?: string;
  text: string;
};

export function matchingPolicyRule(
  rules: PolicyRule[],
  subject: PolicySubject,
): PolicyRule | undefined {
  const text = normalizeSearch(subject.text);
  return rules.find((rule) => {
    switch (rule.kind) {
      case "CATEGORY":
        return (
          rule.value === subject.categoryId ||
          rule.value === subject.categoryLabel
        );
      case "RESOURCE_TYPE":
        return rule.value === subject.resourceType;
      case "FULFILMENT":
        return rule.value === subject.fulfilmentType;
      case "TERM": {
        const term = normalizeSearch(rule.value);
        return term.length > 0 && text.includes(term);
      }
      default:
        return false;
    }
  });
}

export function listingPolicyText(data: Record<string, any>): string {
  return [
    data.title,
    data.description,
    ...Object.values(data.attributes ?? {}),
  ]
    .filter((value) => value != null)
    .map(String)
    .join(" ");
}

const POLICY_BLOCK_MESSAGE =
  "هذا العرض غير مسموح به وفق سياسة السوق الحالية. راجع قواعد السوق والمنتجات المحظورة.";

/**
 * Single server authority for whether a listing may be (re)published.
 * Every publish, edit, and resume path calls this, including chat-driven
 * seller management, so the conversation UI cannot bypass it.
 */
export async function assertListingPublicationPolicy(
  input: {
    market: Market;
    sellerId: string;
    category: MarketplaceCategoryRow;
    fulfilmentType: string;
    data: Record<string, any>;
  },
  tx: any = db,
) {
  await assertAccountCanTransact(input.sellerId, tx);
  assertPublicListingLocation({
    city: input.data.city,
    area: input.data.area,
  });
  await assertMarketPolicy(
    input.market,
    input.sellerId,
    input.category.label,
    input.fulfilmentType,
    tx,
    input.category.id,
  );
  const rules = await activePolicyRules(input.market.id, tx);
  const rule = matchingPolicyRule(rules, {
    categoryId: input.category.id,
    categoryLabel: input.category.label,
    resourceType: input.category.resourceType,
    fulfilmentType: input.fulfilmentType,
    text: listingPolicyText(input.data),
  });
  if (rule)
    throw Object.assign(new Error(POLICY_BLOCK_MESSAGE), {
      status: 409,
      code: "POLICY_RESTRICTED",
    });

  const prohibitedItemsPolicy = currentPolicy("prohibited-items");
  const policyText = prohibitedItemsPolicy
    ? JSON.stringify(prohibitedItemsPolicy)
    : "";
  return reviewListingImagesForPublication({
    ownerId: input.sellerId,
    marketId: input.market.id,
    categoryLabel: input.category.label,
    resourceType: input.category.resourceType,
    data: input.data,
    policyVersion: prohibitedItemsPolicy?.version ?? "",
    policyText,
    activeProhibitedRules: rules
      .filter((activeRule) => activeRule.reasonCode === "PROHIBITED_ITEM")
      .map(({ kind, value }) => ({ kind, value })),
  });
}

/** Re-evaluates a stored offer, e.g. after a rule is added post-publication. */
export function offerPolicyViolation(
  rules: PolicyRule[],
  offer: { data: Record<string, any> },
  categoriesById: Map<string, MarketplaceCategoryRow>,
): PolicyRule | undefined {
  if (!rules.length) return undefined;
  const category =
    typeof offer.data.categoryId === "string"
      ? categoriesById.get(offer.data.categoryId)
      : undefined;
  return matchingPolicyRule(rules, {
    categoryId: category?.id ?? offer.data.categoryId,
    categoryLabel: category?.label ?? offer.data.category,
    resourceType: category?.resourceType,
    fulfilmentType: offer.data.fulfilmentType,
    text: listingPolicyText(offer.data),
  });
}
