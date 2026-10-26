import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpretMarketplaceTurn,
  needsMarketplaceCategoryContext,
} from "../src/ai/marketplace-intent";

test("ordinary general questions do not require marketplace category context", () => {
  for (const message of [
    "مرحباً",
    "من أنت؟",
    "اشرح الطاقة الشمسية",
    "ما الفرق بين الطاقة الشمسية وطاقة الرياح؟",
  ]) {
    const intent = interpretMarketplaceTurn(message, {
      categories: [],
      knownCities: [],
    }).intent;
    assert.equal(
      needsMarketplaceCategoryContext(message, intent),
      false,
      `${message} (${intent})`,
    );
  }
});

test("explicit search and recognized result refinements require marketplace category context", () => {
  assert.equal(
    needsMarketplaceCategoryContext("ابحث لي عن هاتف مستعمل", "UNKNOWN"),
    true,
  );
  assert.equal(needsMarketplaceCategoryContext("أرخص", "REFINE_SEARCH"), true);
  assert.equal(needsMarketplaceCategoryContext("رتب حسب السعر", "SORT_RESULTS"), true);
});

// NEW-P1-1 (Block A «من 2020 وفوق», Block E E25 «أرخص»): with a categorized result set, the
// catalog-free first pass cannot read a bare constraint (no schema for the stored category),
// so the turn must still load the catalog instead of falling through to the model.
test("bare refinements of a categorized result set require marketplace category context", () => {
  const previous = {
    search: "",
    categoryId: "cars",
    filters: [{ field: "make", operator: "contains" as const, value: "مرسيدس" }],
  };
  for (const message of [
    "من 2020 وفوق",
    "موديل 2021 وأحدث",
    "سنة 2019 فما فوق",
    "أرخص",
    "الأرخص",
    "أقل من 9000",
    "بأقل من 5 آلاف",
    "في عمان فقط",
    "مستعملة",
  ]) {
    const intent = interpretMarketplaceTurn(message, {
      previous,
      currentResultCount: 3,
      categories: [],
      knownCities: [],
    }).intent;
    assert.equal(
      needsMarketplaceCategoryContext(message, intent, previous),
      true,
      `${message} (${intent})`,
    );
  }
});

test("general questions without a categorized result set still skip the catalog", () => {
  for (const previous of [undefined, { search: "هاتف", filters: [] }]) {
    for (const message of ["مرحباً", "اشرح الطاقة الشمسية"]) {
      const intent = interpretMarketplaceTurn(message, {
        previous,
        categories: [],
        knownCities: [],
      }).intent;
      assert.equal(needsMarketplaceCategoryContext(message, intent, previous), false, message);
    }
  }
});

// Security regression for the rule above: once the catalog is loaded for a categorized result
// set, an unrelated question must still be read as non-marketplace (model or clarification),
// never as a refinement that silently rewrites the buyer's search.
test("with the real catalog loaded, unrelated questions after a car search are not refinements", async () => {
  const { categorySchema, listMarketplaceCategories } = await import("../src/lib/marketplace-categories");
  const categories = (await listMarketplaceCategories()).map(categorySchema);
  assert.ok(categories.some((category) => category.id === "cars"), "migrated catalog includes cars");
  const previous = { search: "", categoryId: "cars", filters: [{ field: "make", operator: "contains" as const, value: "مرسيدس" }] };
  for (const message of ["اشرح الطاقة الشمسية", "من أنت؟", "شكراً لك", "كيف حالك اليوم؟"]) {
    const { intent } = interpretMarketplaceTurn(message, { previous, currentResultCount: 3, categories, knownCities: [] });
    assert.ok(!["REFINE_SEARCH", "SORT_RESULTS", "SEARCH"].includes(intent), `${message} → ${intent}`);
  }
  const { pool } = await import("@workspace/db");
  await pool.end();
});
