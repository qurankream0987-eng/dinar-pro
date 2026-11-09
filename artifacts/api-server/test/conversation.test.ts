import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationTitle } from "../src/ai/conversation-title";
import { sanitizeGuestHandoffMessages } from "../src/ai/guest-handoff";
import { contextualQuery } from "../src/ai/search-context";
import { backIntent, surfaceIntent } from "../src/ai/intent";
import { parseStructuredSearch } from "../src/ai/search-query";
import {
  buildDraftReview,
  createInitialSaleDraft,
  parseSellerPaymentMethods,
  structuredDraftUpdates,
} from "../src/ai/listing-draft";
import {
  validateCategoryAttributes,
  validateCategoryAttributesAgainstSchema,
  validateSearchFilters,
} from "@workspace/api-zod/marketplace-schemas";
import {
  guestHandoffMessages,
  isSafeGuestHandoffText,
  restoreGuestConversation,
} from "../../dinar/src/features/ai/conversation-storage";
import {
  categoryFixture,
  TEST_MARKETPLACE_CATEGORY_SCHEMAS,
} from "./fixtures/marketplace-categories";
import {
  collectListingPhotoSuggestions,
  DeterministicPhotoSuggestionProvider,
} from "../src/ai/listing-photo-intelligence";

const message = { id: "user-1", role: "USER", body: "أريد تيشيرت", createdAt: "2026-09-29T12:00:00Z", blocks: [] };
test("guest restoration preserves mixed text and latest result ordering", () => {
  const context = { query: "تيشيرت أسود", resourceIds: ["second-price", "first-price"] };
  const restored = restoreGuestConversation(JSON.stringify({ marketId: "KW", messages: [message, { ...message, id: "assistant-1", role: "ASSISTANT", body: "2 عروض KWD 1.000", blocks: [{ type: "LISTING_RESULTS", version: 1, payload: { resultSetId: "results-1", listings: [{ id: "second-price" }, { id: "first-price" }] } }] }], context }), "KW");
  assert.deepEqual(restored?.context, context);
  assert.equal(restored?.messages[1].body, "2 عروض KWD 1.000");
  assert.deepEqual(restored?.messages[1].blocks[0].payload.listings.map(listing => listing.id), context.resourceIds);
});
test("guest restoration rejects another market, malformed storage and invalid message roles", () => {
  assert.equal(restoreGuestConversation(JSON.stringify({ marketId: "SA", messages: [message] }), "KW"), null);
  for (const raw of [null, "{", "null", "[]", JSON.stringify({ marketId: "KW", messages: [{ ...message, role: "SYSTEM" }] })]) assert.equal(restoreGuestConversation(raw, "KW"), null);
});
test("guest handoff keeps bounded text order and excludes the auth-triggering turn", () => {
  const messages = [
    { id: "00000000-0000-4000-8000-000000000001", role: "USER" as const, body: "Find camping tents", createdAt: "2026-09-29T12:00:00Z", blocks: [] },
    { id: "00000000-0000-4000-8000-000000000002", role: "ASSISTANT" as const, body: "I found two tents.", createdAt: "2026-09-29T12:00:01Z", blocks: [] },
    { id: "00000000-0000-4000-8000-000000000003", role: "USER" as const, body: "My API key is abc123", createdAt: "2026-09-29T12:00:02Z", blocks: [] },
    { id: "00000000-0000-4000-8000-000000000004", role: "USER" as const, body: "I want to sell one", createdAt: "2026-09-29T12:00:03Z", blocks: [] },
    { id: "00000000-0000-4000-8000-000000000005", role: "ASSISTANT" as const, body: "Sign in to continue.", createdAt: "2026-09-29T12:00:04Z", blocks: [] },
  ];
  const handoff = guestHandoffMessages(messages, messages[3].id);
  assert.deepEqual(handoff.map((item) => item.id), [messages[0].id, messages[1].id]);
  assert.deepEqual(handoff.map((item) => item.actor), ["USER", "ASSISTANT"]);
  assert.equal(isSafeGuestHandoffText("Call me at 555-234-9876"), false);
  assert.equal(isSafeGuestHandoffText("Meet near 24.7136,46.6753"), false);
  assert.equal(isSafeGuestHandoffText("Search camping tents"), true);
});
test("guest restoration retains handoff identity and binds resumed context to its account", () => {
  const restored = restoreGuestConversation(
    JSON.stringify({
      marketId: "KW",
      handoffId: "00000000-0000-4000-8000-000000000010",
      targetUserId: "buyer-fixture",
      messages: [message],
      authIntent: { messageId: message.id, marketId: "KW" },
    }),
    "KW",
  );
  assert.equal(restored?.handoffId, "00000000-0000-4000-8000-000000000010");
  assert.equal(restored?.targetUserId, "buyer-fixture");
  assert.deepEqual(restored?.authIntent, {
    messageId: message.id,
    marketId: "KW",
    message: message.body,
  });
});
test("guest restoration retains the selected listing reference for negotiation continuation", () => {
  const messageId = "00000000-0000-4000-8000-000000000011";
  const listingId = "00000000-0000-4000-8000-000000000012";
  const restored = restoreGuestConversation(
    JSON.stringify({
      marketId: "KW",
      messages: [{ ...message, id: messageId }],
      authIntent: { messageId, marketId: "KW", listingId },
    }),
    "KW",
  );
  assert.equal(restored?.authIntent?.listingId, listingId);
});
test("server handoff sanitizer removes secrets, contact details and temporary locations", () => {
  const retained = sanitizeGuestHandoffMessages([
    { id: "safe", actor: "USER", body: "  Find camping tents  " },
    { id: "secret", actor: "USER", body: "My API key is abc123" },
    { id: "contact", actor: "USER", body: "Call 555-234-9876" },
    { id: "location", actor: "USER", body: "24.7136,46.6753" },
    { id: "object", actor: "ASSISTANT", body: "private/uploads/temporary-photo.png" },
  ]);
  assert.deepEqual(retained, [
    { id: "safe", actor: "USER", body: "Find camping tents" },
  ]);
});
test("untrusted blocks are dropped while safe text and logout surfaces restore", () => {
  const restored = restoreGuestConversation(JSON.stringify({ marketId: "KW", messages: [{ ...message, role: "ASSISTANT", blocks: [{ type: "HTML", version: 1, payload: { html: "<script>" } }, { type: "SURFACE", version: 1, payload: { resultSetId: "logout-1", surface: "LOGOUT", listings: [] } }] }] }), "KW");
  assert.equal(restored?.messages[0].blocks.length, 1);
  assert.equal(restored?.messages[0].blocks[0].payload.surface, "LOGOUT");
});
test("conversation titles are concise and useful without a model", () => {
  assert.equal(conversationTitle("أريد سيارة برادو مستعملة"), "البحث عن سيارة برادو مستعملة");
  assert.equal(conversationTitle("أريد أبيع آيفون 15"), "بيع آيفون 15");
  assert.equal(conversationTitle("  مرحباً\n DINAR  "), "مرحباً DINAR");
  assert.equal(conversationTitle(""), "محادثة جديدة");
  assert.ok(conversationTitle("أريد " + "ع".repeat(200)).length <= 72);
});

test("back-to-results intent recognizes short and explicit Arabic requests", () => {
  assert.equal(backIntent("رجوع"), true);
  assert.equal(backIntent("ارجع إلى النتائج السابقة"), true);
  assert.equal(backIntent("أبحث عن شيء آخر"), false);
});
test("AI color refinements preserve the product when the user says 'the black color'", () => {
  assert.equal(
    contextualQuery("أريد اللون الأسود", "سماعة هاتف أبيض"),
    "سماعة هاتف اسود",
  );
  assert.equal(
    contextualQuery("أريد اللون الأسود فقط", "سماعة هاتف أبيض XL"),
    "سماعة هاتف xl اسود",
  );
});

test("an alphanumeric car model code is a model filter; a plain word is free text", () => {
  // Pins the heuristic behind the former nl-commerce-followup-probes intermittency: a token shaped
  // like a model code (letters, 2–4 digits, up to 3 letters) is read as the model.
  const code = (message: string) =>
    parseStructuredSearch(message, undefined, TEST_MARKETPLACE_CATEGORY_SCHEMAS)?.filters?.find((filter) => filter.field === "model")?.value;
  assert.equal(code("أبي سيارة مستعملة lc200"), "lc200");
  assert.equal(code("أبي سيارة مستعملة nlee06eeb"), "nlee06eeb");
  assert.equal(code("أبي سيارة مستعملة nlqzxwtrk"), undefined);
});

test("a request to compare the results is not searched for as product text", () => {
  const query = parseStructuredSearch("دور لي على سيارة مستعملة وقارن الخيارات.", undefined, TEST_MARKETPLACE_CATEGORY_SCHEMAS);
  assert.equal(query?.categoryId, "cars");
  assert.deepEqual(query?.filters, [{ field: "condition", operator: "contains", value: "مستعمل" }]);
  assert.equal(query?.search, "");
  // A product word next to the request is kept; a decimal is not punctuation.
  assert.equal(parseStructuredSearch("أبي سيارة مرسيدس هايبرد وقارن بينها", undefined, TEST_MARKETPLACE_CATEGORY_SCHEMAS)?.search, "هايبرد");
  assert.match(parseStructuredSearch("أبي سيارة محرك 1.5 تيربو", undefined, TEST_MARKETPLACE_CATEGORY_SCHEMAS)?.search ?? "", /1\.5|تيربو/u);
});

test("car search stays deterministic and accumulates typed filters across turns", () => {
  const make = parseStructuredSearch(
    "أريد سيارة مرسيدس",
    undefined,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(make?.categoryId, "cars");
  assert.deepEqual(make?.filters, [
    { field: "make", operator: "contains", value: "مرسيدس" },
  ]);

  const year = parseStructuredSearch(
    "2022 وفوق",
    make,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.ok(year?.filters.some(
    (filter) => filter.field === "year" && filter.operator === "gte" && filter.value === 2022,
  ));

  const price = parseStructuredSearch(
    "أقل من 20,000",
    year,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.ok(price?.filters.some(
    (filter) => filter.field === "price" && filter.operator === "lt" && filter.value === 20_000,
  ));
  const mileage = parseStructuredSearch(
    "الممشى 90 ألف",
    price,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.ok(mileage?.filters.some(
    (filter) => filter.field === "mileage" && filter.operator === "eq" && filter.value === 90_000,
  ));
  const adjustedPrice = parseStructuredSearch(
    "السعر إلى 8,500",
    mileage,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.ok(adjustedPrice?.filters.some(
    (filter) => filter.field === "price" && filter.operator === "eq" && filter.value === 8_500,
  ));
  assert.equal(
    validateSearchFilters(
      adjustedPrice?.categoryId,
      adjustedPrice?.filters,
      TEST_MARKETPLACE_CATEGORY_SCHEMAS[0],
    ).ok,
    true,
  );
  assert.equal(
    validateSearchFilters(
      "cars",
      [{ field: "sellerId", operator: "eq", value: "someone" }],
      TEST_MARKETPLACE_CATEGORY_SCHEMAS[0],
    ).ok,
    false,
  );
});

test("property query uses the same category-neutral structured search contract", () => {
  const query = parseStructuredSearch(
    "أريد شقة للإيجار في عمان غرفتين أقل من 350",
    undefined,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(query?.categoryId, "property");
  assert.deepEqual(query?.filters, [
    { field: "propertyType", operator: "contains", value: "شقة" },
    { field: "transactionType", operator: "contains", value: "إيجار" },
    { field: "bedrooms", operator: "eq", value: 2 },
    { field: "price", operator: "lt", value: 350 },
    { field: "city", operator: "contains", value: "عمان" },
  ]);
  assert.equal(query?.search, "");
  const numericRooms = parseStructuredSearch(
    "أريد شقة للإيجار 3 غرف في عمان بسعر 350",
    undefined,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.deepEqual(numericRooms?.filters, [
    { field: "propertyType", operator: "contains", value: "شقة" },
    { field: "transactionType", operator: "contains", value: "إيجار" },
    { field: "bedrooms", operator: "eq", value: 3 },
    { field: "price", operator: "eq", value: 350 },
    { field: "city", operator: "contains", value: "عمان" },
  ]);
  assert.equal(
    validateSearchFilters(
      query?.categoryId,
      query?.filters,
      TEST_MARKETPLACE_CATEGORY_SCHEMAS[1],
    ).ok,
    true,
  );
});

test("category aliases match whole words without mistaking household-use text for property intent", () => {
  const householdUse = "طاولة خشب مستعملة للاستخدام المنزلي";
  const property = TEST_MARKETPLACE_CATEGORY_SCHEMAS[1];
  const other = categoryFixture({
    id: "other",
    label: "أخرى",
    aliases: ["أخرى", "other"],
    resourceType: "MIXED",
    renderer: "GENERIC",
    attributes: {},
    searchFilters: {},
    allowAdditionalAttributes: true,
  });
  const categories = [property, other];
  assert.equal(parseStructuredSearch(householdUse, undefined, categories), undefined);
  assert.equal(
    parseStructuredSearch("أبحث عن المنزل", undefined, categories)?.categoryId,
    "property",
  );

  const sale = createInitialSaleDraft(
    "أريد أبيع طاولة خشب مستعملة بـ 15 دينار",
    categories,
  );
  const updated = structuredDraftUpdates(sale.draft, householdUse, categories);
  assert.equal(sale.step, "category");
  assert.equal(sale.draft.categoryId, undefined);
  assert.equal(updated.draft.categoryId, undefined);
  const selected = structuredDraftUpdates(sale.draft, "أخرى", categories);
  assert.equal(selected.draft.categoryId, "other");
});

test("unclassified seller details stay category-neutral until valid registry rules are selected", () => {
  const electronics = categoryFixture({
    id: "electronics",
    label: "إلكترونيات",
    aliases: ["إلكترونيات", "هاتف"],
    resourceType: "PRODUCT",
    renderer: "GENERIC",
    attributes: {
      condition: {
        label: "الحالة",
        type: "string",
        operators: ["eq", "contains"],
        options: ["جديد", "مستعمل"],
        searchable: true,
        filterable: true,
        requiredForPublish: true,
      },
    },
    searchFilters: {},
    allowAdditionalAttributes: false,
  });
  const categories = [electronics];
  const initial = createInitialSaleDraft(
    "أريد أبيع آيفون 15",
    categories,
  );
  assert.equal(initial.step, "category");
  assert.equal(initial.draft.categoryId, undefined);

  const pending = structuredDraftUpdates(
    initial.draft,
    "مستعمل ونظيف، سعة 256 جيجابايت، 180 دينار، كمية 2",
    categories,
  );
  assert.equal(pending.draft.categoryId, undefined);
  assert.equal(pending.draft.unitPrice, "180");
  assert.equal(pending.draft.availableQuantity, "2");
  assert.equal(pending.draft.attributes?.condition, "مستعمل");
  assert.match(pending.draft.description ?? "", /256/);

  const selected = structuredDraftUpdates(
    pending.draft,
    electronics.label,
    categories,
  );
  assert.equal(selected.draft.categoryId, electronics.id);
  assert.equal(selected.draft.unitPrice, "180");
  assert.equal(selected.draft.availableQuantity, "2");
  assert.equal(selected.draft.inventoryMode, "LIMITED");
  assert.equal(selected.draft.attributes?.condition, "مستعمل");
  assert.match(selected.draft.description ?? "", /256/);
});

test("structured search supports sorting, filter clearing, and category switches", () => {
  const carSearch = parseStructuredSearch(
    "سيارة تويوتا سوداء",
    undefined,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  const cheapest = parseStructuredSearch(
    "الأرخص",
    carSearch,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(cheapest?.sort, "PRICE_ASC");
  assert.deepEqual(cheapest?.filters, carSearch?.filters);

  const cleared = parseStructuredSearch(
    "امسح الفلاتر",
    cheapest,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(cleared?.sort, "RELEVANCE");
  assert.deepEqual(cleared?.filters, []);

  const propertySearch = parseStructuredSearch(
    "عقارات",
    cheapest,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(propertySearch?.categoryId, "property");
  assert.deepEqual(propertySearch?.filters, []);
  assert.equal(propertySearch?.search, "");
});

test("a generic color refinement does not guess a category or discard prior text", () => {
  const clothing = categoryFixture({
    id: "clothing",
    label: "ملابس",
    aliases: [],
    renderer: "GENERIC",
    attributes: {
      color: { label: "اللون", type: "string", operators: ["eq", "contains"] },
    },
    searchFilters: {},
  });
  assert.equal(
    parseStructuredSearch(
      "الأسود فقط",
      { search: "تيشيرت أبيض XL", filters: [] },
      [clothing],
    ),
    undefined,
  );
});

test("configured categories parse typed fields without inventing unsupported fields", () => {
  const tools = categoryFixture({
    id: "tools",
    label: "معدات",
    aliases: ["معدات", "أدوات"],
    renderer: "GENERIC",
    attributes: {
      brand: { label: "الشركة", type: "string", operators: ["eq", "contains"] },
      weight: { label: "الوزن", type: "number", operators: ["eq", "gt", "gte", "lt", "lte"] },
      condition: { label: "الحالة", type: "string", operators: ["eq", "contains"], options: ["مستعمل", "جديد"] },
    },
    searchFilters: {
      price: { label: "السعر", type: "number", operators: ["eq", "gt", "gte", "lt", "lte"] },
      city: { label: "المدينة", type: "string", operators: ["eq", "contains"] },
    },
  });
  const result = parseStructuredSearch(
    "معدات مستعملة وزنها 5 أقل من 100 في الكويت",
    undefined,
    [tools],
  );
  assert.equal(result?.categoryId, "tools");
  assert.deepEqual(result?.filters, [
    { field: "weight", operator: "eq", value: 5 },
    { field: "condition", operator: "contains", value: "مستعمل" },
    { field: "price", operator: "lt", value: 100 },
    { field: "city", operator: "contains", value: "الكويت" },
  ]);
  assert.equal(
    result?.filters.some((filter) => filter.field === "sellerId"),
    false,
  );
  assert.equal(validateSearchFilters("tools", result?.filters, tools).ok, true);
});

test("photo suggestions require a permitted field and matching photo provenance", async () => {
  const photo =
    "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000001.jpg";
  const result = await collectListingPhotoSuggestions({
    imageObjectPaths: [photo],
    schema: TEST_MARKETPLACE_CATEGORY_SCHEMAS[0],
    provider: new DeterministicPhotoSuggestionProvider([
      { field: "color", value: "أسود", confidence: 0.71, imageObjectPath: photo },
      { field: "color", value: "أبيض", confidence: 0.93, imageObjectPath: photo },
      { field: "price", value: 100, confidence: 0.99, imageObjectPath: photo },
      { field: "fuel", value: "بنزين", confidence: 0.88, imageObjectPath: "/other.jpg" },
      { field: "sellerId", value: "seller-1", confidence: 1, imageObjectPath: photo },
    ]),
  });
  assert.equal(result.status, "SUGGESTIONS");
  assert.deepEqual(result.suggestions, [
    { field: "color", value: "أبيض", confidence: 0.93, imageObjectPath: photo },
  ]);
});

test("photo suggestions cannot establish hidden storage or warranty attributes", async () => {
  const photo = "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000001.jpg";
  const category = categoryFixture({
    id: "electronics", label: "إلكترونيات", aliases: [], renderer: "GENERIC",
    attributes: {
      storage: { label: "التخزين", type: "number", operators: ["eq"] },
      warranty: { label: "الضمان", type: "string", operators: ["eq"] },
    },
    searchFilters: {},
  });
  const result = await collectListingPhotoSuggestions({
    imageObjectPaths: [photo], schema: category,
    provider: new DeterministicPhotoSuggestionProvider([
      { field: "storage", value: 256, confidence: 1, imageObjectPath: photo },
      { field: "warranty", value: "سنة", confidence: 1, imageObjectPath: photo },
    ]),
  });
  assert.equal(result.status, "NO_SUGGESTIONS");
  assert.deepEqual(result.suggestions, []);
});

test("photo analysis is explicit when no provider is configured or one fails", async () => {
  const imageObjectPaths = [
    "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000001.jpg",
  ];
  assert.deepEqual(
    await collectListingPhotoSuggestions({
      imageObjectPaths,
      schema: TEST_MARKETPLACE_CATEGORY_SCHEMAS[0],
    }),
    { status: "UNAVAILABLE", suggestions: [] },
  );
  assert.deepEqual(
    await collectListingPhotoSuggestions({
      imageObjectPaths,
      schema: TEST_MARKETPLACE_CATEGORY_SCHEMAS[0],
      provider: { async suggest() { throw new Error("provider unavailable"); } },
    }),
    { status: "FAILED", suggestions: [] },
  );
});

test("guest conversation restoration keeps validated structured search context", () => {
  const searchState = {
    search: "سماعة",
    categoryId: "electronics",
    filters: [{ field: "color", operator: "contains", value: "أسود" }],
    sort: "PRICE_ASC",
  } as const;
  const restored = restoreGuestConversation(
    JSON.stringify({
      marketId: "KW",
      messages: [message],
      context: { query: "سماعة", resourceIds: ["offer-1"], searchState },
    }),
    "KW",
  );
  assert.deepEqual(restored?.context.searchState, searchState);
  const invalid = restoreGuestConversation(
    JSON.stringify({
      marketId: "KW",
      messages: [message],
      context: {
        searchState: {
          search: "سماعة",
          filters: [{ field: "sellerId", operator: "eq", value: "private" }],
        },
      },
    }),
    "KW",
  );
  assert.equal(invalid?.context.searchState, undefined);
});

test("category attributes are normalized and publication requirements are explicit", () => {
  assert.deepEqual(
    validateCategoryAttributes(
      "سيارات",
      { make: "تويوتا", model: "كامري", year: "2020", condition: "مستعمل" },
      true,
      TEST_MARKETPLACE_CATEGORY_SCHEMAS,
    ),
    {
      ok: true,
      attributes: { make: "تويوتا", model: "كامري", year: 2020, condition: "مستعمل" },
      missing: [],
    },
  );
  const missing = validateCategoryAttributes(
    "سيارات",
    { make: "تويوتا" },
    true,
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(missing.ok, true);
  if (missing.ok) assert.deepEqual(missing.missing, ["الطراز", "سنة الصنع", "الحالة"]);
});

test("Camry sale drafts accept price and mileage changes without publishing", () => {
  const inferred = createInitialSaleDraft(
    "أريد أبيع كامري 2020",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(inferred.draft.categoryId, "cars");
  assert.equal(inferred.draft.attributes?.make, "تويوتا");
  assert.equal(inferred.draft.attributes?.model, "كامري");
  assert.equal(inferred.draft.attributes?.year, 2020);
  const initial = createInitialSaleDraft(
    "أبيع سيارة تويوتا كامري 2020",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(initial.step, "attribute:condition");
  assert.equal(initial.draft.category, "سيارات");
  assert.equal(initial.draft.title, "سيارة تويوتا كامري 2020");
  assert.deepEqual(initial.draft.attributes, {
    make: "تويوتا",
    model: "كامري",
    year: 2020,
  });

  const price = structuredDraftUpdates(
    initial.draft,
    "السعر إلى 8500",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(price.changed, true);
  assert.equal(price.draft.unitPrice, "8500");
  const mileage = structuredDraftUpdates(
    price.draft,
    "الممشى 90 ألف",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(mileage.changed, true);
  assert.equal(mileage.draft.unitPrice, "8500");
  assert.equal(mileage.draft.attributes?.mileage, 90_000);
});

test("data-configured categories use generic sale drafts, validation, and filter fields", () => {
  const tools = categoryFixture({
    id: "agricultural-tools",
    label: "معدات زراعية",
    labelEn: "Agricultural equipment",
    aliases: ["محراث", "آلة زراعية"],
    resourceType: "PRODUCT",
    renderer: "GENERIC",
    attributes: {
      manufacturer: {
        label: "الشركة المصنعة",
        type: "string",
        operators: ["eq", "contains"],
        requiredForPublish: true,
      },
      capacity: {
        label: "السعة",
        type: "number",
        operators: ["eq", "gt", "gte", "lt", "lte"],
      },
    },
    searchFilters: {
      city: {
        label: "المدينة",
        type: "string",
        operators: ["eq", "contains"],
      },
    },
    allowAdditionalAttributes: false,
  });
  const other = categoryFixture({
    id: "other",
    label: "أخرى",
    aliases: ["أخرى", "other"],
    resourceType: "MIXED",
    renderer: "GENERIC",
    attributes: {},
    searchFilters: {},
    allowAdditionalAttributes: true,
  });

  const sale = createInitialSaleDraft("أبيع محراث هيدروليكي", [tools, other]);
  assert.equal(sale.step, "attribute:manufacturer");
  assert.equal(sale.draft.categoryId, tools.id);
  assert.equal(sale.draft.title, "محراث هيدروليكي");
  const selectedTools = structuredDraftUpdates(sale.draft, tools.label, [
    tools,
    other,
  ]);
  assert.equal(selectedTools.draft.category, tools.label);
  assert.equal(selectedTools.draft.categoryId, tools.id);

  const unknownSale = createInitialSaleDraft("أبيع آلة ثلج تجارية", [tools, other]);
  assert.equal(unknownSale.step, "category");
  assert.equal(unknownSale.draft.categoryId, undefined);
  const selectedOther = structuredDraftUpdates(
    unknownSale.draft,
    "أخرى",
    [tools, other],
  );
  assert.equal(selectedOther.draft.categoryId, other.id);

  const attributes = validateCategoryAttributesAgainstSchema(
    tools.label,
    { manufacturer: "الحصاد", capacity: "12" },
    tools,
  );
  assert.deepEqual(
    attributes.ok ? attributes.attributes : attributes,
    { manufacturer: "الحصاد", capacity: 12 },
  );
  assert.equal(
    validateSearchFilters(
      tools.id,
      [{ field: "capacity", operator: "gte", value: 10 }],
      tools,
    ).ok,
    true,
  );
  assert.equal(
    validateSearchFilters(
      tools.id,
      [{ field: "ownerId", operator: "eq", value: "seller" }],
      tools,
    ).ok,
    false,
  );
});

test("generic seller prompts extract ordinary price, quantity, and service titles", () => {
  const other = categoryFixture({
    id: "other",
    label: "أخرى",
    aliases: ["أخرى", "other"],
    resourceType: "MIXED",
    renderer: "GENERIC",
    attributes: {},
    searchFilters: {},
    allowAdditionalAttributes: true,
  });
  const services = categoryFixture({
    id: "services",
    label: "خدمات",
    aliases: ["خدمة", "خدمات", "مترجم"],
    resourceType: "SERVICE",
    renderer: "GENERIC",
    attributes: {},
    searchFilters: {},
    allowAdditionalAttributes: true,
  });
  const electronics = categoryFixture({
    id: "electronics",
    label: "إلكترونيات",
    aliases: ["إلكترونيات", "آيفون"],
    resourceType: "PRODUCT",
    renderer: "GENERIC",
    attributes: {},
    searchFilters: {},
    allowAdditionalAttributes: true,
  });

  const phone = createInitialSaleDraft("أريد أبيع آيفون 15", [
    electronics,
    services,
    other,
  ]);
  assert.equal(phone.draft.title, "آيفون 15");
  assert.equal(phone.step, "description");
  assert.equal(phone.draft.categoryId, electronics.id);

  const soilDevice = createInitialSaleDraft(
    "أريد أبيع جهاز قياس رطوبة للتربة",
    [services, other],
  );
  assert.equal(soilDevice.draft.title, "جهاز قياس رطوبة للتربة");
  assert.equal(soilDevice.step, "category");
  assert.equal(soilDevice.draft.categoryId, undefined);

  const table = createInitialSaleDraft(
    "أريد أبيع طاولة خشب مستعملة بـ 15 دينار",
    [services, other],
  );
  assert.equal(table.draft.title, "طاولة خشب مستعملة");
  assert.equal(table.step, "category");
  assert.equal(table.draft.unitPrice, "15");
  assert.match(table.draft.description ?? "", /مستعملة/);
  const selectedTable = structuredDraftUpdates(
    table.draft,
    "أخرى",
    [services, other],
  );
  assert.equal(selectedTable.draft.unitPrice, "15");
  assert.equal(selectedTable.draft.pricingMode, "FIXED");

  const cups = createInitialSaleDraft(
    "عندي 200 كوب مطبوع للبيع، الحبة بنص دينار",
    [services, other],
  );
  assert.equal(cups.draft.title, "كوب مطبوع");
  assert.equal(cups.draft.unitPrice, "0.5");
  assert.equal(cups.draft.inventoryMode, undefined);
  assert.equal(cups.draft.availableQuantity, "200");
  const selectedCups = structuredDraftUpdates(
    cups.draft,
    "أخرى",
    [services, other],
  );
  assert.equal(selectedCups.draft.inventoryMode, "LIMITED");
  assert.equal(selectedCups.draft.availableQuantity, "200");

  const translation = createInitialSaleDraft(
    "أريد أعرض خدمة ترجمة",
    [services, other],
  );
  assert.equal(translation.draft.categoryId, "services");
  assert.equal(translation.draft.title, "خدمة ترجمة");
  assert.equal(translation.draft.inventoryMode, "UNLIMITED");
  assert.equal(translation.draft.availableQuantity, undefined);
  assert.notEqual(translation.step, "quantity");

  const selectedService = structuredDraftUpdates(
    soilDevice.draft,
    "خدمات",
    [services, other],
  );
  assert.equal(selectedService.changed, true);
  assert.equal(selectedService.draft.categoryId, "services");
  assert.equal(selectedService.draft.inventoryMode, "UNLIMITED");
  assert.equal(selectedService.draft.availableQuantity, undefined);
  assert.equal(selectedService.draft.fulfilmentType, "SERVICE");

  const selectedProduct = structuredDraftUpdates(
    translation.draft,
    "أخرى",
    [services, other],
  );
  assert.equal(selectedProduct.changed, true);
  assert.equal(selectedProduct.draft.categoryId, "other");
  assert.equal(selectedProduct.draft.inventoryMode, undefined);
  assert.equal(selectedProduct.draft.availableQuantity, undefined);
  assert.equal(selectedProduct.draft.fulfilmentType, undefined);

  const naturalService = createInitialSaleDraft(
    "أقدم خدمة ترجمة بـ 10 دنانير",
    [services, other],
  );
  assert.equal(naturalService.draft.categoryId, "services");
  assert.equal(naturalService.draft.title, "خدمة ترجمة");
  assert.equal(naturalService.draft.unitPrice, "10");

  const unstructuredProduct = createInitialSaleDraft(
    "للبيع كنبة نظيفة جدًا طولها 3 متر، 70 دينار، موجودة في ماركا الشمالية",
    [services, other],
  );
  assert.equal(unstructuredProduct.draft.title, "كنبة");
  assert.equal(unstructuredProduct.step, "category");
  assert.equal(unstructuredProduct.draft.categoryId, undefined);
  assert.equal(unstructuredProduct.draft.unitPrice, "70");
  assert.equal(unstructuredProduct.draft.area, "ماركا الشمالية");
  assert.match(unstructuredProduct.draft.description ?? "", /نظيفة/);
  assert.match(unstructuredProduct.draft.description ?? "", /طولها 3 متر/);
  const selectedProductCategory = structuredDraftUpdates(
    unstructuredProduct.draft,
    "أخرى",
    [services, other],
  );
  assert.equal(selectedProductCategory.draft.categoryId, "other");
  assert.equal(selectedProductCategory.draft.unitPrice, "70");
  assert.equal(selectedProductCategory.draft.area, "ماركا الشمالية");

  const photoPath =
    "/objects/listing-photos/seller-1/00000000-0000-4000-8000-000000000001.jpg";
  const photoFirst = createInitialSaleDraft(
    "أريد انشر إعلان",
    [services, other],
    [photoPath],
  );
  assert.equal(photoFirst.draft.title, undefined);
  assert.equal(photoFirst.draft.imageUrl, photoPath);
  assert.equal(photoFirst.step, "category");

  const contactAndDetails = createInitialSaleDraft(
    "أبيع محراث هيدروليكي، حالته ممتازة، للتواصل: +965 5000 1234، متوفر في منطقة السالمية",
    [services, other],
    [photoPath],
  );
  assert.equal(contactAndDetails.draft.title, "محراث هيدروليكي");
  assert.equal(contactAndDetails.draft.contactPhone, "+96550001234");
  assert.equal(contactAndDetails.draft.area, "السالمية");
  assert.match(contactAndDetails.draft.description ?? "", /حالته ممتازة/);
  assert.equal(contactAndDetails.draft.imageUrl, photoPath);
  assert.equal(contactAndDetails.step, "category");
  const selectedContactCategory = structuredDraftUpdates(
    contactAndDetails.draft,
    "أخرى",
    [services, other],
  );
  assert.equal(selectedContactCategory.draft.categoryId, "other");
  assert.equal(selectedContactCategory.draft.contactPhone, "+96550001234");
  assert.equal(selectedContactCategory.draft.area, "السالمية");

  const genericUsedItem = createInitialSaleDraft(
    "أريد أبيع سماعة سوداء مستعملة",
    [services, other],
  );
  assert.equal(genericUsedItem.draft.categoryId, undefined);
  assert.equal(genericUsedItem.draft.attributes?.condition, "مستعمل");
  const selectedGenericItem = structuredDraftUpdates(
    genericUsedItem.draft,
    "أخرى",
    [services, other],
  );
  assert.equal(selectedGenericItem.draft.categoryId, "other");
  assert.equal(selectedGenericItem.draft.attributes?.condition, "مستعمل");

  const vehicle = createInitialSaleDraft(
    "أريد أبيع سيارة مرسيدس C200 موديل 2021 ماشية 70 ألف",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(vehicle.draft.categoryId, "cars");
  assert.equal(vehicle.draft.attributes?.year, 2021);
  assert.equal(vehicle.draft.attributes?.mileage, 70_000);
  const correctedVehicle = structuredDraftUpdates(
    vehicle.draft,
    "الممشى 60 ألف",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.equal(correctedVehicle.draft.attributes?.mileage, 60_000);
});

test("generic offer wording enters the sell flow without hijacking account navigation", () => {
  assert.equal(surfaceIntent("عندي شقة للإيجار في عمان ثلاث غرف"), "SELL");
  assert.equal(surfaceIntent("أريد أعرض خدمة ترجمة"), "SELL");
  assert.equal(surfaceIntent("دينار أقدم خدمة تنظيف منازل"), "SELL");
  assert.equal(surfaceIntent("اعرض حسابي"), "ACCOUNT");
});

test("seller payment choices use canonical values; the short draft defaults to direct payment", () => {
  assert.deepEqual(parseSellerPaymentMethods("كاش", true), ["CASH_DIRECT"]);
  assert.deepEqual(parseSellerPaymentMethods("فيزا", true), ["CARD"]);
  assert.deepEqual(parseSellerPaymentMethods("الاثنين", true), [
    "CASH_DIRECT",
    "CARD",
  ]);
  assert.deepEqual(
    parseSellerPaymentMethods("كاش أو فيزا عادي"),
    ["CASH_DIRECT", "CARD"],
  );
  assert.equal(parseSellerPaymentMethods("الاثنين"), undefined);

  const incompleteSale = createInitialSaleDraft(
    "أريد أبيع سيارة تويوتا برادو 2020",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  // Short draft (owner decision): payment is not asked; it defaults to direct settlement,
  // labelled as a DINAR default (not the seller's statement) and editable in the chat.
  assert.ok(
    !buildDraftReview(incompleteSale.draft, TEST_MARKETPLACE_CATEGORY_SCHEMAS)
      .missingFields.some((field) => field.field === "payment_methods"),
  );
  assert.deepEqual(incompleteSale.draft.paymentMethods, ["CASH_DIRECT"]);
  assert.equal(incompleteSale.draft.sources?.paymentMethods, "DINAR_DERIVED");

  const sale = createInitialSaleDraft(
    "أريد أبيع سيارة تويوتا برادو 2020، والدفع كاش أو فيزا",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.deepEqual(sale.draft.paymentMethods, ["CASH_DIRECT", "CARD"]);

  const cash = structuredDraftUpdates(
    sale.draft,
    "طريقة الدفع كاش",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.deepEqual(cash.draft.paymentMethods, ["CASH_DIRECT"]);
  const corrected = structuredDraftUpdates(
    cash.draft,
    "كاش أو فيزا عادي",
    TEST_MARKETPLACE_CATEGORY_SCHEMAS,
  );
  assert.deepEqual(corrected.draft.paymentMethods, ["CASH_DIRECT", "CARD"]);
});
