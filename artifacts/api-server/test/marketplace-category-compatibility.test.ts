import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultMarketplaceCategoryRules,
  LISTING_PRICING_MODES,
} from "@workspace/api-zod/marketplace-schemas";
import {
  categorySchema,
  type MarketplaceCategoryRow,
} from "../src/lib/marketplace-categories";

function legacyCategory(
  allowedModes: string[],
  defaultMode: string,
): MarketplaceCategoryRow {
  const rules = defaultMarketplaceCategoryRules("SERVICE");
  return {
    id: "legacy-service",
    label: "خدمات",
    labelEn: "Services",
    parentId: null,
    aliases: [],
    resourceType: "SERVICE",
    renderer: "GENERIC",
    attributes: {},
    searchFilters: [],
    allowAdditionalAttributes: false,
    rules: {
      ...rules,
      pricing: {
        ...rules.pricing,
        allowedModes: allowedModes as typeof rules.pricing.allowedModes,
        defaultMode: defaultMode as typeof rules.pricing.defaultMode,
      },
    },
    isActive: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as MarketplaceCategoryRow;
}

test("legacy category pricing modes normalize to the canonical three without mutating the row", () => {
  const row = legacyCategory(
    ["FIXED", "STARTING_FROM", "QUOTE_REQUIRED"],
    "STARTING_FROM",
  );
  const before = structuredClone(row.rules);

  const schema = categorySchema(row);

  assert.deepEqual(schema.rules.pricing.allowedModes, [...LISTING_PRICING_MODES]);
  // A starting amount is not a binding price (owner policy 2026-10-24; corrected 0030).
  assert.equal(schema.rules.pricing.defaultMode, "OPEN_TO_OFFERS");
  assert.deepEqual(row.rules, before);
});

test("legacy quote-required default maps to open-to-offers", () => {
  const schema = categorySchema(
    legacyCategory(["FIXED", "QUOTE_REQUIRED"], "QUOTE_REQUIRED"),
  );

  assert.equal(schema.rules.pricing.defaultMode, "OPEN_TO_OFFERS");
  assert.deepEqual(schema.rules.pricing.allowedModes, [...LISTING_PRICING_MODES]);
});

test("unknown category pricing modes remain invalid", () => {
  assert.throws(
    () => categorySchema(legacyCategory(["FIXED", "UNRECOGNIZED"], "FIXED")),
    /Invalid category registry entry legacy-service/,
  );
});
