import {
  defaultMarketplaceCategoryRules,
  type MarketplaceCategorySchema,
} from "@workspace/api-zod/marketplace-schemas";

const text = (label: string, options?: readonly string[]) => ({
  label,
  type: "string" as const,
  operators: ["eq", "contains"] as const,
  searchable: true,
  filterable: true,
  ...(options ? { options } : {}),
});

const number = (label: string, minimum?: number, maximum?: number) => ({
  label,
  type: "number" as const,
  operators: ["eq", "gt", "gte", "lt", "lte"] as const,
  searchable: true,
  filterable: true,
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});

export function categoryFixture(
  category: Omit<MarketplaceCategorySchema, "rules"> & {
    rules?: MarketplaceCategorySchema["rules"];
  },
): MarketplaceCategorySchema {
  return {
    ...category,
    rules:
      category.rules ??
      defaultMarketplaceCategoryRules(category.resourceType ?? "PRODUCT"),
  };
}

const carRules = defaultMarketplaceCategoryRules("PRODUCT");
const propertyRules = defaultMarketplaceCategoryRules("PRODUCT");

export const TEST_MARKETPLACE_CATEGORY_SCHEMAS: MarketplaceCategorySchema[] = [
  {
    id: "cars",
    label: "سيارات",
    aliases: ["سيارة", "سيارات", "مركبة", "مركبات"],
    resourceType: "PRODUCT",
    renderer: "CAR",
    attributes: {
      make: text("الشركة"),
      model: { ...text("الطراز"), requiredForPublish: true },
      year: { ...number("سنة الصنع", 1900, 2100), requiredForPublish: true },
      mileage: number("الممشى", 0),
      condition: {
        ...text("الحالة", ["جديد", "مستعمل"]),
        requiredForPublish: true,
      },
      color: text("اللون"),
      transmission: text("ناقل الحركة"),
      fuel: text("الوقود"),
    },
    searchFilters: {
      price: number("السعر"),
      city: text("المدينة"),
    },
    allowAdditionalAttributes: false,
    rules: {
      ...carRules,
      display: {
        cardAttributes: ["make", "model", "year", "mileage"],
        detailAttributes: [
          "make",
          "model",
          "year",
          "mileage",
          "condition",
          "color",
          "transmission",
          "fuel",
        ],
      },
      sorting: {
        ...carRules.sorting,
        options: [
          ...carRules.sorting.options,
          {
            id: "YEAR_ASC",
            label: "سنة الصنع: الأقدم أولًا",
            field: "ATTRIBUTE",
            direction: "ASC",
            attribute: "year",
          },
          {
            id: "YEAR_DESC",
            label: "سنة الصنع: الأحدث أولًا",
            field: "ATTRIBUTE",
            direction: "DESC",
            attribute: "year",
          },
          {
            id: "MILEAGE_ASC",
            label: "الممشى: الأقل أولًا",
            field: "ATTRIBUTE",
            direction: "ASC",
            attribute: "mileage",
          },
          {
            id: "MILEAGE_DESC",
            label: "الممشى: الأعلى أولًا",
            field: "ATTRIBUTE",
            direction: "DESC",
            attribute: "mileage",
          },
        ],
      },
      inventory: {
        semantics: "SINGLE",
        allowedModes: ["LIMITED"],
        defaultMode: "LIMITED",
        defaultQuantity: 1,
      },
    },
  },
  {
    id: "property",
    label: "عقارات",
    aliases: ["عقار", "عقارات", "شقة", "المنزل", "منزل"],
    resourceType: "PRODUCT",
    renderer: "PROPERTY",
    attributes: {
      propertyType: text("نوع العقار"),
      transactionType: text("نوع المعاملة"),
      bedrooms: number("غرف النوم", 0),
      bathrooms: number("دورات المياه", 0),
      area: number("المساحة", 0),
      district: text("الحي"),
    },
    searchFilters: {
      price: number("السعر"),
      city: text("المدينة"),
    },
    allowAdditionalAttributes: false,
    rules: {
      ...propertyRules,
      display: {
        cardAttributes: ["propertyType", "transactionType", "bedrooms", "area"],
        detailAttributes: [
          "propertyType",
          "transactionType",
          "bedrooms",
          "bathrooms",
          "area",
          "district",
        ],
      },
      sorting: {
        ...propertyRules.sorting,
        options: [
          ...propertyRules.sorting.options,
          {
            id: "PROPERTY_SIZE_ASC",
            label: "المساحة: الأصغر أولًا",
            field: "ATTRIBUTE",
            direction: "ASC",
            attribute: "area",
          },
          {
            id: "PROPERTY_SIZE_DESC",
            label: "المساحة: الأكبر أولًا",
            field: "ATTRIBUTE",
            direction: "DESC",
            attribute: "area",
          },
        ],
      },
      inventory: {
        semantics: "SINGLE",
        allowedModes: ["LIMITED"],
        defaultMode: "LIMITED",
        defaultQuantity: 1,
      },
    },
  },
];