/**
 * A deterministic marketplace for search equivalence (C1). Fixed ids, sellers, timestamps
 * (strictly increasing, inserted in creation order, never updated before capture) and campaigns,
 * so the pre-C1 in-memory search and the PostgreSQL search can be compared result by result.
 */
import { eq } from "drizzle-orm";
import { db, listingPromotions, marketplacePolicyRules, markets, offers, promotionProducts, users } from "@workspace/db";

const BASE = Date.parse("2026-09-01T08:00:00.000Z");
export const SELLERS = { a: "sf-seller-a", b: "sf-seller-b", c: "sf-seller-c", suspended: "sf-seller-suspended" } as const;

type Spec = {
  title: string;
  description?: string;
  category: string;
  categoryId?: string;
  city?: string;
  area?: string;
  attributes?: Record<string, string | number>;
  price?: number | null;
  status?: string;
  seller?: keyof typeof SELLERS;
  inventory?: "UNLIMITED" | [available: number, reserved: number];
};

const L = (category: string, categoryId: string | undefined, rows: Omit<Spec, "category" | "categoryId">[]): Spec[] =>
  rows.map((row) => ({ category, ...(categoryId ? { categoryId } : {}), ...row }));

export const LISTINGS: Spec[] = [
  ...L("سيارات", "cars", [
    { title: "سيارة كيا سيراتو 2015", description: "سيارة عائلية بحالة ممتازة", city: "عمان", area: "خلدا", attributes: { make: "كيا", model: "سيراتو", year: 2015, mileage: 120000, fuel: "بنزين", condition: "مستعمل" }, price: 7000 },
    { title: "سيارة هيونداي النترا 2018", description: "اقتصادية في البنزين", city: "عمان", area: "الجبيهة", attributes: { make: "هيونداي", model: "النترا", year: 2018, mileage: 80000, condition: "مستعمل" }, price: 9500 },
    { title: "سيارة تويوتا كامري 2020 هايبرد", description: "هايبرد موفرة", city: "الزرقاء", attributes: { make: "تويوتا", model: "كامري", year: 2020, mileage: 40000, fuel: "هايبرد", condition: "مستعمل" }, price: 18000, seller: "b" },
    { title: "سيارة مرسيدس قديمة", description: "للهواة", city: "اربد", attributes: { make: "مرسيدس", year: 1999, mileage: "غير معروف", condition: "مستعمل" }, price: 3500, seller: "c" },
    { title: "Toyota Corolla 2016", description: "clean car, one owner", city: "عمان", attributes: { make: "تويوتا", model: "كورولا", year: "2016", mileage: 150000 }, price: 6800, seller: "b" },
    { title: "سيارة نيسان صني", description: "بدون سنة مسجلة", city: "عمان", attributes: { make: "نيسان" }, price: 4200 },
    { title: "سيارة كيا ريو موقوفة", city: "عمان", attributes: { make: "كيا", year: 2017 }, price: 6000, status: "PAUSED" },
    { title: "سيارة بيعت", city: "عمان", attributes: { make: "كيا", year: 2014 }, price: 5000, status: "SOLD_OUT" },
    { title: "سيارة من بائع موقوف", city: "عمان", attributes: { make: "كيا", year: 2019 }, price: 8000, seller: "suspended" },
    { title: "سيارة مخفية بالإشراف", city: "عمان", attributes: { make: "كيا" }, price: 8100, status: "MODERATION_HIDDEN" },
    { title: "سيارة مسودة", city: "عمان", attributes: { make: "كيا" }, price: 8200, status: "DRAFT" },
  ]),
  ...L("إلكترونيات", "electronics", [
    { title: "هاتف سامسونج جالكسي A55", description: "جوال أندرويد بكاميرا ممتازة للتصوير", city: "عمان", attributes: { condition: "جديد" }, price: 260 },
    { title: "جوال آيفون 13 مستعمل", description: "بطارية 88٪", city: "عمان", attributes: { condition: "مستعمل" }, price: 420, seller: "b" },
    { title: "ايفون 11 للبيع", description: "شاشة سليمة", city: "الزرقاء", attributes: { condition: "مستعمل" }, price: 210, seller: "c" },
    { title: "Samsung Galaxy S10 SM-G973", description: "refurbished grade A", city: "عمان", attributes: { condition: "مجدد" }, price: 150 },
    { title: "سماعات بلوتوث لاسلكية", description: "عزل ضوضاء", city: "اربد", attributes: { condition: "جديد" }, price: 35, inventory: "UNLIMITED" },
    { title: "سماعة رأس للألعاب", city: "عمان", attributes: { condition: "جديد" }, price: 45, inventory: [3, 3] },
    { title: "لابتوب ديل XPS 13", description: "رام 16 جيجا، مناسب للبرمجة", city: "عمان", attributes: { condition: "مستعمل" }, price: 480 },
    { title: "لابتوب لينوفو للطلاب", description: "مناسب للجامعة", city: "اربد", attributes: { condition: "مستعمل" }, price: 175, seller: "b" },
    { title: "هاتف نوكيا بسيط", description: "بطارية تدوم", city: "عمان", attributes: { condition: "مستعمل" }, price: 15 },
    { title: "هاتف بسعر مفتوح", description: "قابل للتفاوض", city: "عمان", attributes: { condition: "مستعمل" }, price: null },
    { title: "هاتف ممنوع البيع", description: "يحتوي كلمة محظورة ممنوع", city: "عمان", attributes: { condition: "جديد" }, price: 99 },
  ]),
  ...L("أزياء", "fashion", [
    { title: "تيشيرت قطن أسود", description: "مقاس L", city: "عمان", attributes: { audience: "رجالي", season: "صيفي", condition: "جديد" }, price: 8 },
    { title: "فستان سهرة أحمر", city: "عمان", attributes: { audience: "نسائي", condition: "جديد" }, price: 60, seller: "c" },
    { title: "جاكيت شتوي سوداء", city: "اربد", attributes: { audience: "رجالي", season: "شتوي" }, price: 35 },
    { title: "قميص أطفال أبيض", city: "الزرقاء", attributes: { audience: "أطفال" }, price: 6, inventory: "UNLIMITED" },
  ]),
  ...L("منزل", "home", [
    { title: "كنب زاوية رمادي", description: "استعمال خفيف", city: "عمان", area: "الجبيهة", attributes: { condition: "مستعمل" }, price: 300 },
    { title: "كنبة زرقاء ثلاث مقاعد", city: "عمان", attributes: { condition: "مستعمل" }, price: 120, seller: "b" },
    { title: "مصباح طاولة", city: "اربد", attributes: { condition: "جديد" }, price: 12 },
    { title: "غسالة اوتوماتيك", description: "فيها خدش على الجانب", city: "عمان", attributes: { condition: "مستعمل" }, price: 140 },
  ]),
  ...L("عقارات", "property", [
    { title: "شقة مفروشة للإيجار في خلدا", city: "عمان", area: "خلدا", attributes: { bedrooms: 2, bathrooms: 1, area: 110, propertyType: "شقة", transactionType: "إيجار" }, price: 550 },
    { title: "شقة للبيع في الزرقاء", city: "الزرقاء", attributes: { bedrooms: 3, area: 150, propertyType: "شقة", transactionType: "بيع" }, price: 45000, seller: "c" },
    { title: "بيت مستقل مع حديقة", city: "اربد", attributes: { bedrooms: 4, area: 240, propertyType: "بيت" }, price: 90000 },
  ]),
  ...L("خدمات", "services", [
    { title: "فني مكيفات صيانة وتركيب", description: "خدمة سريعة في عمان", city: "عمان", price: 15, inventory: "UNLIMITED" },
    { title: "خدمة تنظيف منازل", city: "عمان", price: 25, inventory: "UNLIMITED", seller: "b" },
    { title: "سباك محترف", city: "الزرقاء", price: 20, inventory: "UNLIMITED" },
    { title: "مترجمة معتمدة إنجليزي", city: "عمان", price: 30, inventory: "UNLIMITED", seller: "c" },
  ]),
  ...L("خدمات رقمية", "digital-services", [
    { title: "تصميم شعار احترافي", city: "عمان", price: 40, inventory: "UNLIMITED" },
  ]),
  ...L("أخرى", "other", [
    { title: "مزهرية زجاج", city: "عمان", attributes: { condition: "جديد" }, price: 9 },
    { title: "ماكينة تغليف صناعية", description: "للمصانع", city: "اربد", attributes: { condition: "مستعمل" }, price: 3100 },
  ]),
  // Legacy rows that name their category only by label (no categoryId).
  ...L("إلكترونيات", undefined, [
    { title: "هاتف قديم بتصنيف نصي", description: "جوال قديم", city: "عمان", price: 30 },
  ]),
  ...L("سيارات", undefined, [
    { title: "سيارة بتصنيف نصي فقط", city: "عمان", attributes: { make: "كيا", year: 2012 }, price: 3000 },
  ]),
  // Repeated near-duplicates so limits, ties and paging matter.
  ...Array.from({ length: 30 }, (_, index): Spec => ({
    title: `هاتف مستعمل رقم ${index + 1}`,
    description: index % 3 === 0 ? "جوال أندرويد" : index % 3 === 1 ? "phone used" : "بطارية جيدة",
    category: "إلكترونيات",
    categoryId: "electronics",
    city: index % 2 ? "عمان" : "اربد",
    attributes: { condition: index % 4 ? "مستعمل" : "جديد" },
    price: index % 5 === 0 ? 100 : 60 + index * 7,
    seller: (["a", "b", "c"] as const)[index % 3],
  })),
];

export const listingId = (index: number) => `sf-${String(index + 1).padStart(4, "0")}`;
export const idOf = (title: string) => listingId(LISTINGS.findIndex((spec) => spec.title === title));

export async function seedSearchFixture() {
  // The seed's own JO listings were bulk-inserted (equal timestamps): their order is unspecified.
  // They are archived here so every searchable row has a distinct, increasing creation time.
  await db.update(offers).set({ status: "ARCHIVED" }).where(eq(offers.marketId, "JO"));
  for (const [key, id] of Object.entries(SELLERS))
    await db.insert(users).values({
      id,
      displayName: `بائع ${key}`,
      phoneCountryCode: "+962",
      phoneNumber: `79000000${Object.keys(SELLERS).indexOf(key)}`,
      normalizedPhone: `+96279000000${Object.keys(SELLERS).indexOf(key)}`,
      accountCountry: "JO",
      activeMarketId: "JO",
      passwordHash: "fixture-not-a-hash",
      status: key === "suspended" ? "SUSPENDED" : "ACTIVE",
    });
  for (const [index, spec] of LISTINGS.entries()) {
    const createdAt = new Date(BASE + index * 60_000);
    const limited = spec.inventory !== "UNLIMITED";
    const [available, reserved] = Array.isArray(spec.inventory) ? spec.inventory : [5, 0];
    await db.insert(offers).values({
      id: listingId(index),
      sellerId: SELLERS[spec.seller ?? "a"],
      marketId: "JO",
      status: spec.status ?? "PUBLISHED",
      unitPriceMinor: spec.price === null ? null : (spec.price ?? 10) * 1000,
      pricingMode: spec.price === null ? "OPEN_TO_OFFERS" : "FIXED",
      inventoryMode: limited ? "LIMITED" : "UNLIMITED",
      availableQuantity: limited ? available : null,
      reservedQuantity: limited ? reserved : 0,
      data: {
        title: spec.title,
        description: spec.description ?? "",
        category: spec.category,
        ...(spec.categoryId ? { categoryId: spec.categoryId } : {}),
        city: spec.city ?? "عمان",
        area: spec.area ?? "",
        attributes: spec.attributes ?? {},
        fulfilmentType: spec.category === "خدمات" ? "SERVICE" : "PICKUP",
        imageUrl: index % 2 ? "https://images.example.test/x.png" : "",
        imageUrls: [],
      },
      createdAt,
      updatedAt: createdAt,
    });
  }
  // Market restriction and a policy term: both must keep excluding listings.
  await db.update(markets).set({ restrictedCategories: ["digital-services"] }).where(eq(markets.id, "JO"));
  await db.insert(marketplacePolicyRules).values({ id: "sf-rule-term", marketId: "JO", kind: "TERM", value: "ممنوع", reasonCode: "PROHIBITED_ITEM", note: "fixture" });
  // Serving campaigns: a matching listing early, one late in organic order, one on a paused listing.
  await db.insert(promotionProducts).values({ id: "sf-product", marketId: "JO", categoryId: "electronics", name: "SF fixture", priceMinor: 2_500, currencyCode: "JOD", durationDays: 7 });
  const campaign = (id: string, listing: string, seller: string, weight: number) => ({
    id, listingId: listing, sellerId: seller, marketId: "JO", productId: "sf-product", productNameSnapshot: "SF fixture",
    categoryIdSnapshot: "electronics", priceMinorSnapshot: 2_500, currencyCodeSnapshot: "JOD", placementSnapshot: "SEARCH_AND_CHAT",
    durationDaysSnapshot: 7, status: "ACTIVE", paymentStatus: "SIMULATION_CAPTURED", priorityWeightSnapshot: weight,
    startsAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  await db.insert(listingPromotions).values([
    campaign("sf-promo-1", idOf("جوال آيفون 13 مستعمل"), SELLERS.b, 100),
    campaign("sf-promo-2", idOf("هاتف مستعمل رقم 29"), SELLERS.b, 300),
    campaign("sf-promo-3", idOf("سماعة رأس للألعاب"), SELLERS.a, 200),
  ] as any);
}

type Options = Parameters<typeof import("../src/lib/marketplace-listings").searchMarketplaceListings>[1];
const own = SELLERS.b;
/** Every option shape the callers use (trace matrix), over the fixture. */
export const QUERIES: Options[] = [
  {},
  { limit: 200 },
  { search: "" , limit: 5 },
  { search: "هاتف", conversational: true },
  { search: "جوال", conversational: true },
  { search: "موبايل", conversational: true },
  { search: "هواتف", conversational: true },
  { search: "ايفون", conversational: true },
  { search: "آيفون 13", conversational: true },
  { search: "سامسونج", conversational: true },
  { search: "samsung", conversational: true },
  { search: "SM-G973", conversational: true },
  { search: "A55", conversational: true },
  { search: "سيارة", conversational: true },
  { search: "سيارات", conversational: true },
  { search: "سياره كيا", conversational: true },
  { search: "تويوتا", conversational: true },
  { search: "toyota", conversational: true },
  { search: "فني مكيفات", conversational: true },
  { search: "مكيفات", conversational: true },
  { search: "تنظيف", conversational: true },
  { search: "مترجم", conversational: true },
  { search: "كنب", conversational: true },
  { search: "كنبة", conversational: true },
  { search: "سوداء", conversational: true },
  { search: "اسود", conversational: true },
  { search: "تيشيرت", conversational: true },
  { search: "تي شيرت", conversational: true },
  { search: "لابتوب للبرمجة", conversational: true },
  { search: "شقة", conversational: true },
  { search: "شقق خلدا", conversational: true },
  { search: "أبي هاتف مستعمل", conversational: true },
  { search: "ابغى جوال جديد؟", conversational: true },
  { search: "بطارية", conversational: true },
  { search: "شعار", conversational: true },
  { search: "ممنوع", conversational: true },
  { search: "لا يوجد شيء كهذا", conversational: true },
  { search: "هاتف", conversational: true, limit: 3 },
  { search: "هاتف", conversational: true, limit: 1 },
  { search: "هاتف", conversational: true, limit: 50 },
  { search: "هاتف", conversational: true, sponsoredPlacement: false },
  { search: "هاتف", conversational: true, sponsoredSlots: 0 },
  { search: "هاتف", conversational: true, sponsoredSlots: 1 },
  { search: "هاتف", conversational: true, sponsoredSlots: 3 },
  { search: "هاتف", conversational: true, categoryId: "electronics" },
  { search: "هاتف", conversational: true, categoryId: "electronics", sort: "PRICE_ASC" },
  { search: "هاتف", conversational: true, categoryId: "electronics", sort: "PRICE_DESC" },
  { search: "هاتف", conversational: true, categoryId: "electronics", sort: "NEWEST" },
  { search: "هاتف", conversational: true, categoryId: "electronics", sort: "RELEVANCE" },
  { search: "هاتف", conversational: true, sort: "PRICE_ASC" },
  { search: "", categoryId: "electronics" },
  { search: "", categoryId: "electronics", limit: 200 },
  { search: "", category: "إلكترونيات", limit: 200 },
  { search: "", categoryId: "cars", limit: 200 },
  { search: "", categoryId: "cars", sort: "YEAR_DESC", limit: 200 },
  { search: "", categoryId: "cars", sort: "YEAR_ASC", limit: 200 },
  { search: "", categoryId: "cars", sort: "PRICE_ASC", limit: 3 },
  { search: "", categoryId: "cars", filters: [{ field: "year", operator: "gte", value: 2016 }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "mileage", operator: "lt", value: 100000 }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "make", operator: "eq", value: "كيا" }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "price", operator: "lte", value: 7000 }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "price", operator: "lt", value: 7000 }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "price", operator: "gt", value: 9500 }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "price", operator: "eq", value: 9500 }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "price", operator: "ne", value: 9500 }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "city", operator: "eq", value: "عمان" }], limit: 200 },
  { search: "", categoryId: "cars", filters: [{ field: "city", operator: "ne", value: "عمان" }], limit: 200 },
  { search: "سيارة", conversational: true, categoryId: "cars", filters: [{ field: "price", operator: "lte", value: 10000 }, { field: "city", operator: "eq", value: "عمان" }] },
  { search: "", categoryId: "property", filters: [{ field: "bedrooms", operator: "gte", value: 3 }], limit: 200 },
  { search: "", categoryId: "property", sort: "PROPERTY_SIZE_DESC", limit: 200 },
  { search: "", categoryId: "fashion", filters: [{ field: "audience", operator: "contains", value: "رجال" }], limit: 200 },
  { search: "هاتف", conversational: true, filters: [{ field: "price", operator: "lte", value: 100 }] },
  { search: "هاتف", conversational: true, filters: [{ field: "price", operator: "lt", value: 100 }], limit: 200 },
  { search: "هاتف", conversational: true, filters: [{ field: "city", operator: "contains", value: "ار" }], limit: 200 },
  { search: "", categoryId: "services", limit: 200 },
  { search: "", categoryId: "digital-services", limit: 200 },
  { search: "سيارة" },
  { search: "هاتف" },
  { search: "كيا", limit: 200 },
  { ownSellerId: own, limit: 200 },
  { ownSellerId: own, search: "هاتف", conversational: true },
  { ownSellerId: SELLERS.suspended, limit: 200 },
  { search: "", allowedIds: [idOf("هاتف مستعمل رقم 7"), idOf("سيارة بيعت"), idOf("جوال آيفون 13 مستعمل"), "sf-missing", idOf("هاتف مستعمل رقم 2")], limit: 24 },
  { search: "", allowedIds: [idOf("جوال آيفون 13 مستعمل"), idOf("هاتف مستعمل رقم 29")], sponsoredIds: [idOf("جوال آيفون 13 مستعمل")], limit: 6 },
  { search: "", allowedIds: [idOf("هاتف مستعمل رقم 29"), idOf("سيارة من بائع موقوف"), idOf("تصميم شعار احترافي")], sponsoredIds: [idOf("هاتف مستعمل رقم 29")], limit: 1 },
  { search: "", allowedIds: [], limit: 24 },
  { search: "هاتف", conversational: true, allowedIds: [idOf("هاتف مستعمل رقم 3"), idOf("كنب زاوية رمادي")], limit: 24 },
  { ownSellerId: own, allowedIds: [idOf("كنبة زرقاء ثلاث مقاعد"), idOf("جوال آيفون 13 مستعمل")], sponsoredIds: [idOf("جوال آيفون 13 مستعمل")], limit: 24 },
];

/** The comparable shape of one result: identity, order, price, status and paid labels. */
export function resultShape(records: Awaited<ReturnType<typeof import("../src/lib/marketplace-listings").searchMarketplaceListings>>) {
  return records.map((record: any) => [record.id, record.unitPrice, record.status, record.categoryId ?? null, record.isSponsored ? `${record.sponsoredCampaignId ?? "LABEL"}:${record.sponsoredPlacement ?? ""}` : null]);
}
