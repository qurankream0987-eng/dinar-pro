import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explicitListingOrdinal,
  findOrdinalMention,
  normalizeMarketplaceText,
  parseNumericMentions,
  parseResultReference,
} from "../src/ai/arabic-normalization";
import { interpretMarketplaceTurn } from "../src/ai/marketplace-intent";
import { parseStructuredSearch } from "../src/ai/search-query";
import {
  applyUserPhotoTitleCorrection,
  buildDraftReview,
  createInitialSaleDraft,
  isListingPhotoSuggestionCommand,
  isListingPhotoTitleCorrection,
} from "../src/ai/listing-draft";
import { searchTerms, surfaceIntent } from "../src/ai/intent";
import { hasExplicitMarketplaceSearchIntent } from "../src/ai/marketplace-intent";
import {
  aliasStem,
  isCategoryNameAlias,
  normalizeSearch,
  resultPosition,
} from "../src/ai/search-context";
import { categoryAliasWords } from "../src/lib/marketplace-listings";
import {
  collectListingPhotoSuggestions,
  DeterministicPhotoSuggestionProvider,
} from "../src/ai/listing-photo-intelligence";
import { resolveDevelopmentVisionProviderConfiguration } from "../src/ai/model-gateway";
import {
  validateSearchFilters,
  type SearchQuery,
} from "@workspace/api-zod/marketplace-schemas";
import {
  categoryFixture,
  TEST_MARKETPLACE_CATEGORY_SCHEMAS,
} from "./fixtures/marketplace-categories";

const condition = {
  label: "الحالة",
  type: "string" as const,
  operators: ["eq", "contains"] as const,
  options: ["جديد", "مستعمل"],
  searchable: true,
  filterable: true,
};
const electronics = categoryFixture({
  id: "electronics",
  label: "إلكترونيات",
  aliases: ["إلكترونيات", "سماعة", "آيفون"],
  renderer: "GENERIC",
  attributes: { condition },
  searchFilters: {},
});
const home = categoryFixture({
  id: "home",
  label: "منزل",
  aliases: ["أثاث", "كنب"],
  renderer: "GENERIC",
  attributes: { condition },
  searchFilters: {},
});
const services = categoryFixture({
  id: "services",
  label: "خدمات",
  aliases: ["خدمة", "تنظيف", "صيانة"],
  resourceType: "SERVICE",
  renderer: "GENERIC",
  attributes: {},
  searchFilters: {},
});
const clothing = categoryFixture({
  id: "clothing",
  label: "ملابس",
  aliases: ["ملابس"],
  renderer: "GENERIC",
  attributes: {
    season: {
      label: "الموسم",
      type: "string",
      operators: ["eq", "contains"],
      options: ["شتوية", "صيفية"],
      searchable: true,
      filterable: true,
    },
    audience: {
      label: "الفئة",
      type: "string",
      operators: ["eq", "contains"],
      options: ["أطفال", "نسائي", "رجالي"],
      searchable: true,
      filterable: true,
    },
  },
  searchFilters: {},
});
const otherCategory = categoryFixture({
  id: "other",
  label: "أخرى",
  aliases: ["أخرى", "منتج آخر"],
  renderer: "GENERIC",
  attributes: {},
  searchFilters: {},
});
const categories = [...TEST_MARKETPLACE_CATEGORY_SCHEMAS, electronics, home, services, clothing];
const knownCities = ["عمان", "الكويت"];

const turn = (message: string, previous?: SearchQuery, currentResultCount?: number) =>
  interpretMarketplaceTurn(message, { previous, currentResultCount, categories, knownCities });

test("Arabic-Indic digits, thousands words and k suffix become typed numbers", () => {
  const kinds = (message: string) =>
    parseNumericMentions(normalizeMarketplaceText(message)).map(
      ({ kind, comparator, value, rangeTo }) => ({ kind, comparator, value, rangeTo }),
    );
  assert.deepEqual(kinds("أقل من ٨ آلاف"), [
    { kind: "GENERAL", comparator: "lt", value: 8000, rangeTo: undefined },
  ]);
  assert.deepEqual(kinds("أقل من ثمانية آلاف"), kinds("أقل من 8 آلاف"));
  assert.equal(kinds("تحت 8k")[0]?.value, 8000);
  assert.deepEqual(kinds("موديل 2021 ماشية 70 ألف"), [
    { kind: "YEAR", comparator: "eq", value: 2021, rangeTo: undefined },
    { kind: "MILEAGE", comparator: "eq", value: 70000, rangeTo: undefined },
  ]);
  assert.deepEqual(kinds("3 غرف"), [
    { kind: "ROOMS", comparator: "eq", value: 3, rangeTo: undefined },
  ]);
  assert.equal(kinds("ثلاث غرف")[0]?.kind, "ROOMS");
  assert.equal(kinds("غرفتين")[0]?.value, 2);
  assert.deepEqual(kinds("من 3000 إلى 6000 دينار"), [
    { kind: "PRICE", comparator: "gte", value: 3000, rangeTo: 6000 },
  ]);
  assert.equal(kinds("بحدود 5000")[0]?.comparator, "approx");
  assert.equal(kinds("حد أقصى 400")[0]?.comparator, "lte");
  assert.equal(kinds("أقل من 70 ألف كم")[0]?.kind, "MILEAGE");
  assert.equal(kinds("أقل من 2000")[0]?.kind, "GENERAL", "a bounded 4-digit number is not a year guess");
});

test("QA-04: a dash between two numbers is a range only when it is not part of a longer code", () => {
  const ranges = (message: string) =>
    parseNumericMentions(normalizeMarketplaceText(message)).filter((mention) => mention.rangeTo !== undefined).map(({ value, rangeTo }) => [value, rangeTo]);
  // The exact token that made api.test fail one run in three: two all-digit UUID segments.
  const code = "174f6878-7754-4335-a1b2-c3d4e5f60718";
  assert.deepEqual(ranges(`ايفون ${code}`), []);
  assert.deepEqual(ranges("قطعة AB-1200-3400-C"), []);
  for (const message of ["ايفون 500-700", "ايفون 500 - 700", "ايفون من 500 - 700", "ايفون بين 500 و 700"])
    assert.deepEqual(ranges(message), [[500, 700]], message);

  const search = (message: string) => turn(message).query;
  assert.equal(search(`ايفون ${code}`)?.search, normalizeSearch(`ايفون ${code}`), "a code is searched whole");
  assert.deepEqual(search(`ايفون ${code}`)?.filters, []);
  const withFilter = search(`ايفون ${code} تحت 500`);
  assert.equal(withFilter?.search, normalizeSearch(`ايفون ${code}`), "a price filter does not strip the code's digits");
  assert.deepEqual(withFilter?.filters, [{ field: "price", operator: "lt", value: 500 }]);
  for (const message of ["ايفون 500-700", "ايفون 500 - 700"]) {
    assert.equal(search(message)?.search, "ايفون", `${message}: no number or stray dash left in the words`);
    assert.deepEqual(search(message)?.filters, [{ field: "price", operator: "gte", value: 500 }, { field: "price", operator: "lte", value: 700 }]);
  }
  assert.equal(search("ايفون 256GB تحت 500")?.search, "ايفون 256gb");
  assert.equal(search("ايفون 13")?.search, "ايفون 13");
});

test("ordinal and price in one seller message stay distinct", () => {
  const message = "غير سعر الإعلان الثاني إلى 50";
  assert.equal(explicitListingOrdinal(message), 1);
  const numbers = parseNumericMentions(normalizeMarketplaceText(message));
  assert.deepEqual(
    numbers.map(({ kind, value }) => ({ kind, value })),
    [{ kind: "PRICE", value: 50 }],
  );
  assert.equal(explicitListingOrdinal("غير سعر العرض رقم 3 إلى 75"), 2);
  assert.equal(explicitListingOrdinal("غير السعر إلى 50"), undefined);
});

test("result references are whole utterances; numbers inside requests never select a result", () => {
  assert.deepEqual(parseResultReference("الثانية"), { kind: "INDEX", index: 1 });
  assert.deepEqual(parseResultReference("افتح الثالثة"), { kind: "INDEX", index: 2 });
  assert.deepEqual(parseResultReference("العرض رقم ٢"), { kind: "INDEX", index: 1 });
  assert.deepEqual(parseResultReference("وريني الأولى لو سمحت"), { kind: "INDEX", index: 0 });
  assert.deepEqual(parseResultReference("الأخير"), { kind: "LAST" });
  assert.deepEqual(parseResultReference("افتح 2"), { kind: "INDEX", index: 1 });
  for (const request of [
    "أريد شقة للإيجار 3 غرف في عمان",
    "أريد 2 سماعة",
    "الطابق الثاني في عمان",
    "أقل من 3",
  ])
    assert.equal(resultPosition(request), undefined, request);
  assert.deepEqual(findOrdinalMention("أضف الثانية للسلة"), { kind: "INDEX", index: 1 });
  assert.equal(findOrdinalMention("أضف 3 قطع للسلة"), undefined);
});

test("multi-turn vehicle refinement is deterministic and typed", () => {
  const search = turn("أريد مرسيدس");
  assert.equal(search.intent, "SEARCH");
  const year = turn("من 2020 وفوق", search.query, 4);
  assert.equal(year.intent, "REFINE_SEARCH");
  const price = turn("أقل من 9000", year.query, 3);
  const city = turn("في عمان فقط", price.query, 3);
  const cheapest = turn("وريني الأرخص", city.query, 2);
  assert.equal(cheapest.intent, "SORT_RESULTS");
  assert.deepEqual(cheapest.query, {
    search: "",
    categoryId: "cars",
    filters: [
      { field: "make", operator: "contains", value: "مرسيدس" },
      { field: "year", operator: "gte", value: 2020 },
      { field: "price", operator: "lt", value: 9000 },
      { field: "city", operator: "contains", value: "عمان" },
    ],
    sort: "PRICE_ASC",
  });
  const second = turn("الثانية", cheapest.query, 2);
  assert.equal(second.intent, "OPEN_RESULT");
  assert.equal(second.selectedIndex, 1);
  assert.equal(validateSearchFilters("cars", cheapest.query!.filters, categories[0]).ok, true);
});

test("registry-defined sorts pass through; unsupported sorts are dropped", () => {
  const cars = turn("أريد مرسيدس").query;
  assert.equal(turn("موديل أحدث", cars, 3).query?.sort, "YEAR_DESC");
  const phones = turn("أريد سماعة").query;
  assert.equal(turn("موديل أحدث", phones, 3).query?.sort, undefined);
  assert.equal(turn("الأرخص", phones, 3).query?.sort, "PRICE_ASC");
});

test("property search keeps room count out of location and result selection", () => {
  const result = turn("أريد شقة للإيجار 3 غرف في عمان", undefined, 5);
  assert.equal(result.intent, "SEARCH");
  assert.equal(result.query?.categoryId, "property");
  assert.deepEqual(
    result.query?.filters.map(({ field, operator, value }) => [field, operator, value]),
    [
      ["propertyType", "contains", "شقة"],
      ["transactionType", "contains", "إيجار"],
      ["bedrooms", "eq", 3],
      ["city", "contains", "عمان"],
    ],
  );
});

test("negation produces a ne filter only where the registry allows equality", () => {
  const cars = turn("أريد مرسيدس").query;
  const used = turn("ما بدي مستعمل", cars, 3);
  assert.deepEqual(
    used.query?.filters.find((filter) => filter.field === "condition"),
    { field: "condition", operator: "ne", value: "مستعمل" },
  );
  assert.equal(validateSearchFilters("cars", used.query!.filters, categories[0]).ok, true);
  for (const phrase of ["بدون مستعمل", "لا أريد مستعملة", "مو مستعمل"])
    assert.equal(
      turn(phrase, cars, 3).query?.filters.find((filter) => filter.field === "condition")?.operator,
      "ne",
      phrase,
    );
  assert.equal(
    validateSearchFilters("cars", [{ field: "year", operator: "ne", value: "x" }], categories[0]).ok,
    false,
  );
  assert.equal(turn("ما بدي مستعمل").intent, "CLARIFY");
});

test("ranges and approximations become min/max filters on the same field", () => {
  const cars = turn("أريد مرسيدس").query;
  const range = turn("من 3000 إلى 6000", cars, 3).query!;
  assert.deepEqual(
    range.filters.filter((filter) => filter.field === "price"),
    [
      { field: "price", operator: "gte", value: 3000 },
      { field: "price", operator: "lte", value: 6000 },
    ],
  );
  const narrowed = turn("أقل من 5000", range, 2).query!;
  assert.deepEqual(
    narrowed.filters.filter((filter) => filter.field === "price"),
    [{ field: "price", operator: "lt", value: 5000 }],
  );
  const about = turn("بحدود 5000", cars, 3).query!;
  assert.deepEqual(
    about.filters.filter((filter) => filter.field === "price").map((filter) => filter.operator),
    ["gte", "lte"],
  );
});

test("the same runtime serves electronics, home goods and services without per-category code", () => {
  const phones = turn("أريد سماعة آيفون سوداء");
  assert.equal(phones.query?.categoryId, "electronics");
  // Product aliases stay as search words; only the category's own name is removed.
  assert.equal(phones.query?.search, normalizeSearch("سماعة آيفون أسود"));
  assert.equal(turn("أريد إلكترونيات").query?.search, "");
  assert.equal(turn("أريد سيارة").query?.search, "");
  const sofa = turn("أريد كنب أقل من ٨ آلاف");
  assert.equal(sofa.query?.categoryId, "home");
  assert.equal(sofa.query?.search, "كنب");
  assert.deepEqual(sofa.query?.filters, [{ field: "price", operator: "lt", value: 8000 }]);
  assert.equal(validateSearchFilters("home", sofa.query!.filters, home).ok, true);
  const cleaning = turn("أريد خدمة تنظيف في الكويت");
  assert.equal(cleaning.query?.categoryId, "services");
  assert.equal(cleaning.query?.search, "تنظيف");
  assert.equal(cleaning.query?.filters[0]?.field, "city");
});

test("uncategorized requests use only core filters and real inventory cities", () => {
  const table = turn("أريد طاولة أقل من 50 في عمان");
  assert.deepEqual(table.query, {
    search: "طاولة",
    filters: [
      { field: "price", operator: "lt", value: 50 },
      { field: "city", operator: "contains", value: "عمان" },
    ],
  });
  assert.equal(validateSearchFilters(undefined, table.query!.filters).ok, true);
  const refined = turn("أقل من 30", table.query, 2).query!;
  assert.equal(refined.search, "طاولة");
  assert.deepEqual(refined.filters.find((filter) => filter.field === "price"), {
    field: "price", operator: "lt", value: 30,
  });
  assert.equal(
    parseStructuredSearch("أريد هدية في عيد ميلاد", undefined, categories, { knownCities }),
    undefined,
    "prose after في is not a city unless real inventory has it",
  );
});

test("natural-language corrections re-enter the existing marketplace search path", () => {
  for (const [message, expected] of [
    ["لا، أقصد شاحن آيفون", "شاحن آيفون"],
    ["قصدي جاكيت شتوي", "جاكيت شتوي"],
    ["I mean iphone charger", "iphone charger"],
    ["Actually, a phone charger", "a phone charger"],
    ["لا قصدي آيفون", "آيفون"],
    ["مو هذا، أبي سامسونج", "سامسونج"],
    ["بدلها بخيمة كبيرة", "خيمة كبيرة"],
    ["آسف أقصد خدمة تنظيف", "خدمة تنظيف"],
    ["no, I meant iPhone charger", "iPhone charger"],
    ["actually make it men's", "men's"],
    ["not that, I want a cleaning service", "a cleaning service"],
  ]) {
    assert.equal(searchTerms(message), expected, message);
    assert.equal(hasExplicitMarketplaceSearchIntent(message), true, message);
  }
  const initial = interpretMarketplaceTurn("أبي ملابس أطفال شتوية", {
    categories,
    knownCities,
  });
  const corrected = interpretMarketplaceTurn("لا، أقصد نسائي", {
    previous: initial.query,
    categories,
    knownCities,
  });
  assert.equal(corrected.query?.categoryId, "clothing");
  assert.deepEqual(
    corrected.query?.filters.map(({ field, value }) => [field, value]).sort(),
    [["audience", "نسائي"], ["season", "شتوية"]].sort(),
    "explicit correction replaces only the audience and preserves winter",
  );
  const colloquialCorrection = interpretMarketplaceTurn(
    "لا، أبي نسائي مو أطفال",
    { previous: initial.query, categories, knownCities },
  );
  assert.deepEqual(
    colloquialCorrection.query?.filters.map(({ field, value }) => [field, value]).sort(),
    [["audience", "نسائي"], ["season", "شتوية"]].sort(),
  );
  assert.deepEqual(
    turn("لا، مو هذا", initial.query).ambiguities,
    ["VAGUE_REQUEST"],
    "a correction without a corrected value asks instead of guessing",
  );
  assert.equal(surfaceIntent("أبي أبيع جاكيت أطفال"), "SELL");
  assert.equal(surfaceIntent("لا، نسائي"), undefined);
  assert.equal(
    hasExplicitMarketplaceSearchIntent("لا، نسائي"),
    false,
    "an incomplete seller correction must not switch to buyer search",
  );
  assert.equal(
    hasExplicitMarketplaceSearchIntent("لا، أقصد شيء رخيص"),
    false,
    "a correction still needs a concrete item",
  );
});

test("ambiguous or context-free requests ask instead of guessing", () => {
  assert.deepEqual(turn("أريد شيء رخيص").ambiguities, ["VAGUE_REQUEST"]);
  assert.deepEqual(turn("الثاني").ambiguities, ["NO_CURRENT_RESULTS"]);
  assert.deepEqual(turn("الثاني", undefined, 0).ambiguities, ["NO_CURRENT_RESULTS"]);
  assert.deepEqual(turn("افتح الخامسة", undefined, 3).ambiguities, ["RESULT_OUT_OF_RANGE"]);
  assert.equal(turn("رجعني").intent, "CLARIFY");
  assert.equal(turn("رجعني", undefined, 3).intent, "BACK_TO_RESULTS");
  assert.equal(turn("أريد برادو").query?.categoryId, "cars");
});

test("agreement forms fold so queries meet stored listing values", () => {
  assert.equal(normalizeSearch("سماعة سوداء"), normalizeSearch("سماعة أسود"));
  assert.equal(normalizeSearch("سيارة مستعملة"), normalizeSearch("سيارة مستعمل"));
  assert.equal(normalizeSearch("كالجديد"), "كالجديد");
  // Definite forms are usually proper nouns: the city of Zarqa must never become "blue".
  assert.equal(normalizeSearch("الزرقاء"), "الزرقاء");
  assert.equal(normalizeSearch("غير الموقع إلى الزرقاء"), "غير الموقع الي الزرقاء");
});

test("question and detail phrasings still reference a shown result", () => {
  assert.equal(resultPosition("أين الثانية؟"), 1);
  assert.equal(resultPosition("أريد تفاصيل الثاني"), 1);
  assert.equal(resultPosition("تفاصيل العرض الثالث"), 2);
});

test("photos may propose a registry category, never an invented one or authoritative fields", async () => {
  const photos = [
    "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000001.jpg",
    "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000002.jpg",
  ];
  const proposal = await collectListingPhotoSuggestions({
    imageObjectPaths: photos,
    categories,
    provider: new DeterministicPhotoSuggestionProvider([
      { field: "category", value: "smartwatches", confidence: 0.99, imageObjectPath: photos[0] },
      { field: "category", value: "electronics", confidence: 0.8, imageObjectPath: photos[1] },
      { field: "condition", value: "مستعمل", confidence: 0.7, imageObjectPath: photos[0] },
      { field: "price", value: 999, confidence: 0.9, imageObjectPath: photos[0] },
      { field: "title", value: "iPhone 15 Pro 256GB أصلي 100%", confidence: 0.9, imageObjectPath: photos[0] },
      { field: "title", value: "iPhone 15 Pro Used", confidence: 0.87, imageObjectPath: photos[0] },
      { field: "title", value: "iPhone 15 Pro 256GB", confidence: 0.85, imageObjectPath: photos[0] },
      { field: "description", value: "هاتف ذكي تظهر واجهته وخلفيته بثلاث كاميرات", confidence: 0.75, imageObjectPath: photos[1] },
      { field: "condition", value: "جديد", confidence: 0.6, imageObjectPath: "/objects/listing-photos/other/x.jpg" },
    ]),
  });
  assert.equal(proposal.status, "SUGGESTIONS");
  assert.deepEqual(
    proposal.suggestions.map(({ field, value }) => [field, value]),
    [
      ["category", "إلكترونيات"],
      ["title", "iPhone 15 Pro 256GB"],
      ["description", "هاتف ذكي تظهر واجهته وخلفيته بثلاث كاميرات"],
      ["condition", "مستعمل"],
    ],
  );
  assert.deepEqual(proposal.uncertainties, ["CONDITION_NOT_VERIFIABLE"]);
  const conditionReview = buildDraftReview(
    { category: "إلكترونيات", categoryId: "electronics" },
    categories,
    proposal.suggestions.filter(({ field }) => field === "condition"),
  );
  const conditionField = conditionReview.fields.find(
    ({ field }) => field === "attributes.condition",
  );
  assert.deepEqual(
    conditionField,
    {
      field: "attributes.condition",
      label: "الحالة",
      value: "مستعمل",
      source: "IMAGE_INFERRED",
      needsConfirmation: true,
    },
    "photo condition stays tentative and is not applied to the seller's draft",
  );

  const invented = await collectListingPhotoSuggestions({
    imageObjectPaths: photos,
    categories: [...categories, otherCategory],
    provider: new DeterministicPhotoSuggestionProvider([
      { field: "category", value: "luxury-watches", confidence: 1, imageObjectPath: photos[0] },
    ]),
  });
  assert.deepEqual(
    invented.suggestions.map(({ field, value }) => [field, value]),
    [["category", "أخرى"]],
  );
  assert.deepEqual(
    await collectListingPhotoSuggestions({ imageObjectPaths: photos, categories }),
    { status: "UNAVAILABLE", suggestions: [] },
  );
});

test("photo suggestion controls are deterministic and development Vision is separate from chat", () => {
  assert.equal(isListingPhotoSuggestionCommand("أكد اقتراحات الصور"), true);
  assert.equal(isListingPhotoSuggestionCommand("تجاهل اقتراحات الصور"), true);
  assert.equal(isListingPhotoSuggestionCommand("تعديل اقتراحات الصور:\nالعنوان المقترح: هاتف"), true);
  assert.equal(isListingPhotoTitleCorrection("لا، هذا آيفون 14 برو"), true);
  assert.equal(isListingPhotoTitleCorrection("أبي أبيع هذا"), false);

  const development = resolveDevelopmentVisionProviderConfiguration({
    NODE_ENV: "development",
  });
  assert.equal(development?.provider, "GROQ");
  assert.equal(development?.requestedModel, "qwen/qwen3.8-27b");
  assert.equal(
    resolveDevelopmentVisionProviderConfiguration({
      NODE_ENV: "production",
    }),
    undefined,
  );
  assert.equal(
    resolveDevelopmentVisionProviderConfiguration({
      NODE_ENV: "development",
      DINAR_VISION_PROVIDER: "OPENAI",
    }),
    undefined,
  );
  assert.equal(
    resolveDevelopmentVisionProviderConfiguration({
      NODE_ENV: "development",
      DINAR_VISION_MODEL: "some/text-only-model",
    }),
    undefined,
  );
});

test("photo-first sale starts a normal attached draft, and seller correction replaces the image title", () => {
  const paths = [
    "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000001.jpg",
    "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000002.jpg",
  ];
  const phrase = "أبي أبيع هذا";
  assert.equal(surfaceIntent(phrase), "SELL");
  const initial = createInitialSaleDraft(phrase, categories, paths);
  assert.equal(initial.draft.imageUrl, paths[0]);
  assert.deepEqual(initial.draft.imageUrls, [paths[1]]);

  const corrected = applyUserPhotoTitleCorrection(
    {
      categoryId: "electronics",
      category: "إلكترونيات",
      title: "iPhone 15 Pro",
      sources: { title: "IMAGE_INFERRED" },
    },
    "لا، هذا آيفون 14 برو",
  );
  assert.equal(corrected?.title, "آيفون 14 برو");
  assert.equal(corrected?.sources?.title, "USER_DECLARED");
});

test("photo provider failures become a manual-seller fallback, not a thrown draft error", async () => {
  const failed = await collectListingPhotoSuggestions({
    imageObjectPaths: [
      "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000001.jpg",
    ],
    schema: electronics,
    categories,
    provider: {
      async suggest() {
        throw new Error("synthetic provider failure");
      },
    },
  });
  assert.deepEqual(failed, { status: "FAILED", suggestions: [] });
});

test("only aliases that repeat the category's own name are treated as category words", () => {
  assert.equal(isCategoryNameAlias(categories[0]!, "سيارة"), true);
  assert.equal(isCategoryNameAlias(electronics, "إلكترونيات"), true);
  assert.equal(isCategoryNameAlias(electronics, "سماعة"), false);
  assert.equal(isCategoryNameAlias(services, "خدمة"), true);
  assert.equal(isCategoryNameAlias(services, "تنظيف"), false);
  assert.equal(aliasStem("سماعات"), aliasStem("السماعة"));
  assert.deepEqual(categoryAliasWords(home, "كنب احمر"), { aliasWords: ["كنب"], remaining: "احمر" });
});

test("2000-character adversarial turns stay fast for search and seller drafting", () => {
  const inputs = [
    "أقل من" + " ".repeat(1990) + "x",
    "أريد أبيع" + "\t ".repeat(990) + "x",
    "من 1 الى 2 ".repeat(180),
    "اقل من ".repeat(285),
    "رقمي " + "1 ".repeat(995),
  ];
  for (const input of inputs) {
    const message = input.slice(0, 2000);
    const started = performance.now();
    turn(message, { search: "", categoryId: "cars", filters: [] }, 3);
    createInitialSaleDraft(message, categories);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `${elapsed.toFixed(0)}ms for ${JSON.stringify(input.slice(0, 20))}`);
  }
});

test("R3: a request to compare what the market has, and an unrecorded quality, never become product text", () => {
  for (const [message, wanted] of [
    ["دور لي على سيارة مستعملة اقتصادية وقارن الموجود عندك.", ""],
    ["دور لي على سيارة مستعملة وقارن الموجود.", ""],
    ["ابحث عن سيارة موفرة وقارن المتوفر بالسوق", ""],
    ["ابحث عن طاولة أقل من 50 وقارن الخيارات", "طاولة"],
  ] as const) {
    const parsed = parseStructuredSearch(message, undefined, categories);
    assert.equal(parsed?.search, wanted, `${message}: ${JSON.stringify(parsed)}`);
  }
  // The quality words are only dropped as whole words: a product that contains them stays.
  assert.match(String(parseStructuredSearch("كتاب الاقتصاد أقل من 20", undefined, categories)?.search), /اقتصاد/u);
});

