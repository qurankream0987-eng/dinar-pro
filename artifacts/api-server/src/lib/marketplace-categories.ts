import {
  db,
  marketplaceCategories,
  type markets,
} from "@workspace/db";
import { and, asc, eq, or } from "drizzle-orm";
import type { MarketplaceCategorySchema } from "@workspace/api-zod/marketplace-schemas";
import {
  LISTING_PRICING_MODES,
  validateMarketplaceCategoryRules,
} from "@workspace/api-zod/marketplace-schemas";

export type MarketplaceCategoryRow = typeof marketplaceCategories.$inferSelect;
export type CategoryTx = typeof db;

const LEGACY_PRICING_MODES = new Set([
  ...LISTING_PRICING_MODES,
  "STARTING_FROM",
  "QUOTE_REQUIRED",
]);

/**
 * Adapt the known pre-canonical category pricing JSON in memory. This mirrors
 * migration 0030's category-rule mapping without writing to the database.
 */
function canonicalCategoryRules(value: unknown): MarketplaceCategorySchema["rules"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value as MarketplaceCategorySchema["rules"];
  const rules = value as Record<string, unknown>;
  const pricing = rules.pricing;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing))
    return value as MarketplaceCategorySchema["rules"];
  const pricingRules = pricing as Record<string, unknown>;
  const allowedModes = pricingRules.allowedModes;
  const defaultMode = pricingRules.defaultMode;
  if (
    !Array.isArray(allowedModes) ||
    !allowedModes.length ||
    !allowedModes.every(
      (mode) => typeof mode === "string" && LEGACY_PRICING_MODES.has(mode),
    ) ||
    typeof defaultMode !== "string" ||
    !LEGACY_PRICING_MODES.has(defaultMode)
  )
    return value as MarketplaceCategorySchema["rules"];

  // A starting amount and a quotation are not binding prices: both default to OPEN_TO_OFFERS.
  const canonicalDefault =
    defaultMode === "STARTING_FROM" || defaultMode === "QUOTE_REQUIRED"
      ? "OPEN_TO_OFFERS"
      : defaultMode as MarketplaceCategorySchema["rules"]["pricing"]["defaultMode"];
  return {
    ...rules,
    pricing: {
      ...pricingRules,
      allowedModes: [...LISTING_PRICING_MODES],
      defaultMode: canonicalDefault,
    },
  } as unknown as MarketplaceCategorySchema["rules"];
}

export function categorySchema(
  row: MarketplaceCategoryRow,
): MarketplaceCategorySchema {
  const schema: MarketplaceCategorySchema = {
    id: row.id,
    label: row.label,
    labelEn: row.labelEn,
    parentId: row.parentId,
    aliases: row.aliases,
    resourceType: row.resourceType as "PRODUCT" | "SERVICE" | "MIXED",
    renderer: row.renderer as "GENERIC" | "CAR" | "PROPERTY",
    attributes: row.attributes as MarketplaceCategorySchema["attributes"],
    searchFilters: row.searchFilters as MarketplaceCategorySchema["searchFilters"],
    allowAdditionalAttributes: row.allowAdditionalAttributes,
    rules: canonicalCategoryRules(row.rules),
  };
  const validation = validateMarketplaceCategoryRules(schema);
  if (!validation.ok)
    throw new Error(`Invalid category registry entry ${row.id}: ${validation.reason}`);
  return schema;
}

export function categoryApiRecord(row: MarketplaceCategoryRow) {
  return {
    ...categorySchema(row),
    isActive: row.isActive,
  };
}

export async function listMarketplaceCategories(
  includeInactive = false,
  tx: any = db,
): Promise<MarketplaceCategoryRow[]> {
  const query = tx.select().from(marketplaceCategories);
  return (includeInactive
    ? query
    : query.where(eq(marketplaceCategories.isActive, true))
  ).orderBy(asc(marketplaceCategories.label));
}

export async function resolveMarketplaceCategory(
  id: string | undefined,
  label: string | undefined,
  tx: any = db,
  includeInactive = false,
): Promise<MarketplaceCategoryRow | undefined> {
  const identifier = id?.trim();
  const name = label?.trim();
  if (!identifier && !name) return undefined;
  const selector =
    identifier && name
      ? and(
          eq(marketplaceCategories.id, identifier),
          eq(marketplaceCategories.label, name),
        )
      : identifier
        ? eq(marketplaceCategories.id, identifier)
        : or(
            eq(marketplaceCategories.id, name!),
            eq(marketplaceCategories.label, name!),
          );
  const [row] = await tx
    .select()
    .from(marketplaceCategories)
    .where(selector)
    .limit(1);
  if (!row || (!includeInactive && !row.isActive)) return undefined;
  return row;
}

export async function categoryById(
  id: string,
  tx: any = db,
): Promise<MarketplaceCategoryRow | undefined> {
  const [row] = await tx
    .select()
    .from(marketplaceCategories)
    .where(eq(marketplaceCategories.id, id))
    .limit(1);
  return row;
}

export function categoryIsRestricted(
  market: typeof markets.$inferSelect,
  category: Pick<MarketplaceCategoryRow, "id" | "label">,
): boolean {
  return market.restrictedCategories.some(
    (restricted) => restricted === category.id || restricted === category.label,
  );
}