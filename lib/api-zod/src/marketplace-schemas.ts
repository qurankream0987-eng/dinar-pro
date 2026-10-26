/** Single source for search operators; `ne` is derived for string equality fields, never configured. */
export const SEARCH_OPERATORS = ["eq", "ne", "contains", "gt", "gte", "lt", "lte"] as const;
export type SearchOperator = (typeof SEARCH_OPERATORS)[number];
export const SEARCH_SORTS = [
  "RELEVANCE",
  "PRICE_ASC",
  "PRICE_DESC",
  "NEWEST",
  "YEAR_ASC",
  "YEAR_DESC",
  "MILEAGE_ASC",
  "MILEAGE_DESC",
  "PROPERTY_SIZE_ASC",
  "PROPERTY_SIZE_DESC",
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export const GLOBAL_SEARCH_SORTS = ["RELEVANCE", "PRICE_ASC", "PRICE_DESC", "NEWEST"] as const;

export const LISTING_PRICING_MODES = [
  "FIXED",
  "NEGOTIABLE",
  "OPEN_TO_OFFERS",
] as const;
export type ListingPricingMode = (typeof LISTING_PRICING_MODES)[number];
export type InventoryMode = "LIMITED" | "UNLIMITED";
export type InventorySemantics = "TRACKED" | "SINGLE" | "NON_STOCK";

export type MarketplaceSortDefinition = {
  id: Exclude<SearchSort, "RELEVANCE">;
  label: string;
  field: "PRICE" | "CREATED_AT" | "ATTRIBUTE";
  direction: "ASC" | "DESC";
  attribute?: string;
};

export type SellerDraftField =
  | "TITLE"
  | "DESCRIPTION"
  | "PRICE"
  | "ATTRIBUTES"
  | "INVENTORY"
  | "FULFILMENT"
  | "LOCATION"
  | "CONTACT";

export type MarketplaceCategoryRules = {
  display: {
    cardAttributes: readonly string[];
    detailAttributes: readonly string[];
  };
  sorting: {
    defaultSort: Exclude<SearchSort, "RELEVANCE">;
    options: readonly MarketplaceSortDefinition[];
  };
  pricing: {
    allowedModes: readonly ListingPricingMode[];
    defaultMode: ListingPricingMode;
    minAmountMinor: number;
    maxAmountMinor: number;
  };
  inventory: {
    semantics: InventorySemantics;
    allowedModes: readonly InventoryMode[];
    defaultMode: InventoryMode;
    defaultQuantity?: number;
  };
  sellerDraft: {
    requiredFields: readonly SellerDraftField[];
  };
};

export function defaultMarketplaceCategoryRules(
  resourceType: "PRODUCT" | "SERVICE" | "MIXED" = "PRODUCT",
): MarketplaceCategoryRules {
  const service = resourceType === "SERVICE";
  return {
    display: { cardAttributes: [], detailAttributes: [] },
    sorting: {
      defaultSort: "NEWEST",
      options: [
        {
          id: "PRICE_ASC",
          label: "السعر: الأقل أولًا",
          field: "PRICE",
          direction: "ASC",
        },
        {
          id: "PRICE_DESC",
          label: "السعر: الأعلى أولًا",
          field: "PRICE",
          direction: "DESC",
        },
        {
          id: "NEWEST",
          label: "الأحدث",
          field: "CREATED_AT",
          direction: "DESC",
        },
      ],
    },
    pricing: {
      allowedModes: [...LISTING_PRICING_MODES],
      defaultMode: "FIXED",
      minAmountMinor: 1,
      maxAmountMinor: 2_000_000_000,
    },
    inventory: service
      ? {
          semantics: "NON_STOCK",
          allowedModes: ["UNLIMITED"],
          defaultMode: "UNLIMITED",
        }
      : {
          semantics: "TRACKED",
          allowedModes: ["LIMITED", "UNLIMITED"],
          defaultMode: "LIMITED",
          defaultQuantity: 1,
        },
    sellerDraft: {
      requiredFields: service
        ? ["TITLE", "DESCRIPTION", "PRICE", "ATTRIBUTES", "FULFILMENT", "LOCATION", "CONTACT"]
        : ["TITLE", "DESCRIPTION", "PRICE", "ATTRIBUTES", "INVENTORY", "FULFILMENT", "LOCATION", "CONTACT"],
    },
  };
}

export type CategoryAttributeDefinition = {
  label: string;
  type: "string" | "number";
  operators: readonly SearchOperator[];
  requiredForPublish?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  options?: readonly string[];
};

export type MarketplaceCategorySchema = {
  id: string;
  label: string;
  labelEn?: string;
  parentId?: string | null;
  aliases: readonly string[];
  resourceType?: "PRODUCT" | "SERVICE" | "MIXED";
  renderer: "GENERIC" | "CAR" | "PROPERTY";
  attributes: Readonly<Record<string, CategoryAttributeDefinition>>;
  searchFilters?: Readonly<Record<string, CategoryAttributeDefinition>>;
  allowAdditionalAttributes?: boolean;
  rules: MarketplaceCategoryRules;
};

export type MarketplaceCategoryId = string;

export type SearchFilter = {
  field: string;
  operator: SearchOperator;
  value: string | number;
};

export type SearchQuery = {
  search: string;
  categoryId?: MarketplaceCategoryId;
  filters: SearchFilter[];
  sort?: SearchSort;
};

export function categorySchemaById(
  id: string | undefined,
  categories: readonly MarketplaceCategorySchema[] = [],
): MarketplaceCategorySchema | undefined {
  return id ? categories.find((schema) => schema.id === id) : undefined;
}

export function categorySchemaByLabel(
  label: string | undefined,
  categories: readonly MarketplaceCategorySchema[] = [],
): MarketplaceCategorySchema | undefined {
  return categories.find((schema) => schema.label === label);
}

/**
 * Core listing fields every published offer carries (price column, city), so they are
 * filterable in any category, and without one. A category may override them.
 */
export const CORE_SEARCH_FILTERS: Readonly<Record<string, CategoryAttributeDefinition>> = {
  price: {
    label: "السعر",
    type: "number",
    operators: ["eq", "gt", "gte", "lt", "lte"],
    searchable: true,
    filterable: true,
  },
  city: {
    label: "المدينة",
    type: "string",
    operators: ["eq", "contains"],
    searchable: true,
    filterable: true,
  },
};

export function searchFilterDefinition(
  schema: MarketplaceCategorySchema | undefined,
  field: string,
): CategoryAttributeDefinition | undefined {
  return (
    schema?.attributes[field] ??
    schema?.searchFilters?.[field] ??
    CORE_SEARCH_FILTERS[field]
  );
}

/** Negation is allowed exactly where the registry already allows string equality or containment. */
export function searchOperatorAllowed(
  definition: CategoryAttributeDefinition,
  operator: SearchOperator,
): boolean {
  if (definition.operators.includes(operator)) return true;
  return (
    operator === "ne" &&
    definition.type === "string" &&
    (definition.operators.includes("eq") || definition.operators.includes("contains"))
  );
}

export function validateSearchFilters(
  categoryId: string | undefined,
  filters: readonly SearchFilter[] | undefined,
  configuredSchema?: MarketplaceCategorySchema,
  categories: readonly MarketplaceCategorySchema[] = [],
): { ok: true } | { ok: false; reason: string } {
  if (!filters?.length) return { ok: true };
  const schema = configuredSchema ?? categorySchemaById(categoryId, categories);
  if (!schema && categoryId) return { ok: false, reason: "يجب تحديد فئة صالحة للفلاتر." };
  for (const filter of filters) {
    const definition = searchFilterDefinition(schema, filter.field);
    if (
      !definition ||
      definition.filterable === false ||
      !searchOperatorAllowed(definition, filter.operator)
    )
      return { ok: false, reason: `مرشح البحث غير مدعوم: ${filter.field}` };
    if (
      definition.type === "number" &&
      (typeof filter.value !== "number" || !Number.isFinite(filter.value))
    )
      return { ok: false, reason: `قيمة البحث الرقمية غير صالحة: ${filter.field}` };
    if (definition.type === "string" && typeof filter.value !== "string")
      return { ok: false, reason: `قيمة البحث النصية غير صالحة: ${filter.field}` };
  }
  return { ok: true };
}

export function validateCategoryAttributes(
  category: string,
  values: unknown,
  requirePublishFields = true,
  categories: readonly MarketplaceCategorySchema[] = [],
):
  | { ok: true; attributes: Record<string, string | number>; missing: string[] }
  | { ok: false; reason: string } {
  const schema = categorySchemaByLabel(category, categories);
  if (!schema) {
    return { ok: false, reason: "تعذّر تحميل تعريف الفئة من السجل." };
  }
  return validateCategoryAttributesAgainstSchema(
    category,
    values,
    schema,
    requirePublishFields,
  );
}

export function validateCategoryAttributesAgainstSchema(
  category: string,
  values: unknown,
  schema: MarketplaceCategorySchema,
  requirePublishFields = true,
):
  | { ok: true; attributes: Record<string, string | number>; missing: string[] }
  | { ok: false; reason: string } {
  if (values === undefined) values = {};
  if (!values || typeof values !== "object" || Array.isArray(values))
    return { ok: false, reason: "خصائص العرض غير صالحة." };

  const input = values as Record<string, unknown>;
  if (Object.keys(input).length > 50)
    return { ok: false, reason: "عدد خصائص العرض يتجاوز الحد المسموح." };
  const attributes: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(input)) {
    const definition = schema.attributes[key];
    if (!definition) {
      if (!schema.allowAdditionalAttributes)
        return { ok: false, reason: `خاصية غير مدعومة للفئة: ${key}` };
      if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(key))
        return { ok: false, reason: "اسم الخاصية غير صالح." };
      if (typeof raw === "number" && Number.isFinite(raw)) {
        if (raw < -1_000_000_000 || raw > 1_000_000_000)
          return { ok: false, reason: `قيمة الخاصية ${key} خارج النطاق.` };
        attributes[key] = raw;
        continue;
      }
      if (typeof raw === "string" && raw.trim().length <= 500) {
        attributes[key] = raw.trim();
        continue;
      }
      return { ok: false, reason: `قيمة الخاصية ${key} غير صالحة.` };
    }
    if (definition.type === "number") {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value))
        return { ok: false, reason: `قيمة ${definition.label} غير صالحة.` };
      if (
        (definition.minimum !== undefined && value < definition.minimum) ||
        (definition.maximum !== undefined && value > definition.maximum)
      )
        return { ok: false, reason: `قيمة ${definition.label} خارج النطاق.` };
      attributes[key] = value;
    } else {
      if (
        typeof raw !== "string" ||
        raw.trim().length > (definition.maxLength ?? 160)
      )
        return { ok: false, reason: `قيمة ${definition.label} غير صالحة.` };
      const value = raw.trim();
      if (definition.options?.length && !definition.options.includes(value))
        return { ok: false, reason: `اختر قيمة معتمدة لحقل ${definition.label}.` };
      attributes[key] = value;
    }
  }
  const missing = requirePublishFields
    ? Object.entries(schema.attributes)
        .filter(([key, definition]) =>
          definition.requiredForPublish && attributes[key] == null,
        )
        .map(([, definition]) => definition.label)
    : [];
  return { ok: true, attributes, missing };
}

const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;

export function validateMarketplaceCategoryRules(
  schema: Pick<
    MarketplaceCategorySchema,
    "id" | "attributes" | "rules"
  >,
): { ok: true } | { ok: false; reason: string } {
  const { rules } = schema;
  if (!rules || typeof rules !== "object")
    return { ok: false, reason: "تعريف سلوك الفئة مطلوب." };

  const displayFields = [
    ...rules.display.cardAttributes,
    ...rules.display.detailAttributes,
  ];
  if (
    !unique(rules.display.cardAttributes) ||
    !unique(rules.display.detailAttributes) ||
    displayFields.some((key) => !schema.attributes[key])
  )
    return { ok: false, reason: "حقول العرض يجب أن تشير إلى خصائص معرّفة وفريدة." };

  for (const [key, definition] of Object.entries(schema.attributes)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) ||
      (definition.type !== "number" &&
        (definition.minimum !== undefined || definition.maximum !== undefined)) ||
      (definition.minimum !== undefined &&
        definition.maximum !== undefined &&
        definition.minimum > definition.maximum) ||
      (definition.maxLength !== undefined &&
        (definition.type !== "string" ||
          !Number.isSafeInteger(definition.maxLength) ||
          definition.maxLength < 1 ||
          definition.maxLength > 500))
    )
      return { ok: false, reason: `تعريف الخاصية ${key} غير صالح.` };
  }

  const sortIds = rules.sorting.options.map((option) => option.id);
  if (
    !sortIds.length ||
    !unique(sortIds) ||
    !sortIds.includes(rules.sorting.defaultSort)
  )
    return { ok: false, reason: "خيارات الترتيب أو الترتيب الافتراضي غير صالحة." };
  for (const option of rules.sorting.options) {
    const expectedAttributes: Partial<
      Record<MarketplaceSortDefinition["id"], string>
    > = {
      YEAR_ASC: "year",
      YEAR_DESC: "year",
      MILEAGE_ASC: "mileage",
      MILEAGE_DESC: "mileage",
      PROPERTY_SIZE_ASC: "area",
      PROPERTY_SIZE_DESC: "area",
    };
    const expectedAttribute = expectedAttributes[option.id];
    if (
      (option.id === "PRICE_ASC" &&
        (option.field !== "PRICE" || option.direction !== "ASC")) ||
      (option.id === "PRICE_DESC" &&
        (option.field !== "PRICE" || option.direction !== "DESC")) ||
      (option.id === "NEWEST" &&
        (option.field !== "CREATED_AT" || option.direction !== "DESC"))
    )
      return { ok: false, reason: `تعريف الترتيب ${option.id} لا يطابق حقله.` };
    if (
      expectedAttribute &&
      (option.field !== "ATTRIBUTE" ||
        option.attribute !== expectedAttribute ||
        (option.id.endsWith("_ASC") && option.direction !== "ASC") ||
        (option.id.endsWith("_DESC") && option.direction !== "DESC"))
    )
      return { ok: false, reason: `تعريف الترتيب ${option.id} لا يطابق الخاصية.` };
    if (
      option.field === "ATTRIBUTE" &&
      (!option.attribute || schema.attributes[option.attribute]?.type !== "number")
    )
      return { ok: false, reason: `حقل ترتيب غير صالح: ${option.attribute ?? ""}` };
    if (option.field !== "ATTRIBUTE" && option.attribute !== undefined)
      return { ok: false, reason: `الترتيب ${option.id} لا يستخدم خاصية.` };
  }

  const { pricing, inventory, sellerDraft } = rules;
  if (
    pricing.allowedModes.length !== LISTING_PRICING_MODES.length ||
    !unique(pricing.allowedModes) ||
    pricing.allowedModes.some(
      (mode) => !LISTING_PRICING_MODES.includes(mode),
    ) ||
    LISTING_PRICING_MODES.some(
      (mode) => !pricing.allowedModes.includes(mode),
    ) ||
    !pricing.allowedModes.includes(pricing.defaultMode) ||
    !Number.isSafeInteger(pricing.minAmountMinor) ||
    !Number.isSafeInteger(pricing.maxAmountMinor) ||
    pricing.minAmountMinor < 1 ||
    pricing.maxAmountMinor < pricing.minAmountMinor
  )
    return { ok: false, reason: "قواعد التسعير غير صالحة." };
  if (
    !inventory.allowedModes.length ||
    !unique(inventory.allowedModes) ||
    !inventory.allowedModes.includes(inventory.defaultMode)
  )
    return { ok: false, reason: "قواعد المخزون غير صالحة." };
  if (
    inventory.semantics === "NON_STOCK" &&
    (inventory.allowedModes.length !== 1 ||
      inventory.allowedModes[0] !== "UNLIMITED" ||
      inventory.defaultMode !== "UNLIMITED")
  )
    return { ok: false, reason: "الفئة غير المخزّنة يجب أن تستخدم مخزونًا غير محدود." };
  if (
    inventory.semantics === "SINGLE" &&
    (inventory.allowedModes.length !== 1 ||
      inventory.allowedModes[0] !== "LIMITED" ||
      inventory.defaultMode !== "LIMITED" ||
      inventory.defaultQuantity !== 1)
  )
    return { ok: false, reason: "الفئة ذات العرض الفردي يجب أن تستخدم كمية واحدة." };
  if (
    inventory.allowedModes.includes("LIMITED") &&
    (!Number.isSafeInteger(inventory.defaultQuantity) ||
      (inventory.defaultQuantity ?? 0) < 1)
  )
    return { ok: false, reason: "الكمية الافتراضية للفئة غير صالحة." };
  if (
    !sellerDraft.requiredFields.length ||
    !unique(sellerDraft.requiredFields) ||
    sellerDraft.requiredFields.some(
      (field) =>
        ![
          "TITLE",
          "DESCRIPTION",
          "PRICE",
          "ATTRIBUTES",
          "INVENTORY",
          "FULFILMENT",
          "LOCATION",
          "CONTACT",
        ].includes(field),
    )
  )
    return { ok: false, reason: "حقول مسودة البائع المطلوبة غير صالحة." };
  return { ok: true };
}