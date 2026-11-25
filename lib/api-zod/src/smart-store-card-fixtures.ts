/**
 * Sample smart store cards, one per vertical, for UI development and tests only.
 * Every store, product and price here is fictional test data (no real business). Media are
 * placeholders marked `illustrative: true`. Each card is validated against the contract in tests.
 */
import type { SmartMedia, SmartMoney, SmartStoreCard } from "./smart-store-card";

export function kwd(fils: number): SmartMoney {
  return { minor: fils, currency: "KWD", scale: 3, label: `${(fils / 1000).toFixed(3)} د.ك` };
}
export function usd(cents: number): SmartMoney {
  return { minor: cents, currency: "USD", scale: 2, label: `$${(cents / 100).toFixed(2)}` };
}
const img = (name: string, alt: string): SmartMedia => ({ url: `/smart-store/fixtures/${name}.svg`, alt, kind: "IMAGE", illustrative: true });

const base = (cardId: string, vertical: SmartStoreCard["vertical"], name: string, mode: SmartStoreCard["store"]["mode"] = "SELL_INSIDE_JASSIM"): Pick<SmartStoreCard, "cardId" | "revision" | "vertical" | "store" | "status"> => ({
  cardId,
  revision: 1,
  vertical,
  store: { name, kind: "BUSINESS", sponsored: false, verified: true, mode },
  status: "READY",
});

export const SMART_STORE_FIXTURES: Record<SmartStoreCard["vertical"], SmartStoreCard> = {
  FASHION: {
    ...base("fx-fashion", "FASHION", "بوتيك تجريبي للأزياء الرجالية"),
    sections: [
      { kind: "UNDERSTOOD_REQUEST", chips: [{ id: "c-men", label: "ملابس رجالية" }, { id: "c-office", label: "للمكتب" }, { id: "c-budget", label: "حتى 30.000 د.ك" }] },
      { kind: "CATEGORY_TABS", tabs: ["الكل", "بدلات", "قمصان", "بناطيل", "أحذية"].map((label, index) => ({ id: `t${index}`, label, selected: index === 0 })) },
      { kind: "HERO_GALLERY", media: [img("fashion-rack", "رف جاكيتات"), img("fashion-shelf", "رف إكسسوارات")] },
      {
        kind: "PRODUCT_GRID",
        products: [
          { id: "p-jacket", title: "جاكيت رسمي", price: kwd(17900), media: img("jacket", "جاكيت كحلي"), available: true, selected: true },
          { id: "p-shirt", title: "قميص رسمي", price: kwd(7500), media: img("shirt", "قميص أبيض"), available: true, selected: true },
          { id: "p-pants", title: "بنطال كلاسيكي", price: kwd(8900), media: img("pants", "بنطال رمادي"), available: true, selected: true },
          { id: "p-shoes", title: "حذاء رسمي", price: kwd(11900), media: img("shoes", "حذاء بني"), available: false },
        ],
      },
      {
        kind: "BUNDLE_BUILDER",
        label: "إطلالتك المختارة",
        slots: [
          { slotId: "s-top", label: "جاكيت", item: { id: "p-jacket", title: "جاكيت رسمي", price: kwd(17900), media: img("jacket", "جاكيت كحلي") } },
          { slotId: "s-shirt", label: "قميص", item: { id: "p-shirt", title: "قميص رسمي", price: kwd(7500), media: img("shirt", "قميص أبيض") } },
          { slotId: "s-pants", label: "بنطال", item: { id: "p-pants", title: "بنطال كلاسيكي", price: kwd(8900), media: img("pants", "بنطال رمادي") } },
          { slotId: "s-shoes", label: "حذاء" },
        ],
      },
      { kind: "VARIANT_PICKER", groupId: "size", label: "المقاس", style: "SIZE", options: ["S", "M", "L", "XL"].map((label) => ({ id: `size-${label}`, label, available: label !== "XL", selected: label === "L" })) },
      { kind: "TRY_ON", available: false, reason: "تجربة القياس على الصورة ستتوفر لاحقًا بعد موافقتك الصريحة على معالجة صورتك." },
    ],
    primaryAction: { kind: "ADD_TO_CART", label: "إضافة الإطلالة إلى السلة" },
    quote: { total: kwd(34300), lines: [{ label: "جاكيت رسمي", amount: kwd(17900) }, { label: "قميص رسمي", amount: kwd(7500) }, { label: "بنطال كلاسيكي", amount: kwd(8900) }], final: false },
  },
  FOOD: {
    ...base("fx-food", "FOOD", "مطعم تجريبي للبرجر"),
    sections: [
      { kind: "HERO_GALLERY", media: [img("burger", "برجر دجاج مقرمش")] },
      { kind: "PRODUCT_DETAIL", productId: "p-burger", title: "برجر دجاج مقرمش", subtitle: "صدر دجاج مقرمش مع الخس والطماطم والجبن", price: kwd(2500), media: [] },
      { kind: "VARIANT_PICKER", groupId: "size", label: "الحجم", style: "CHIP", options: [{ id: "small", label: "صغير", price: kwd(2250), available: true, selected: false }, { id: "regular", label: "عادي", price: kwd(2500), available: true, selected: true }, { id: "large", label: "كبير", price: kwd(3250), available: true, selected: false }] },
      { kind: "CUSTOMIZER", groupId: "custom", label: "تخصيص البرجر", multi: true, options: [{ id: "cheese", label: "جبن إضافي", delta: kwd(350), selected: true }, { id: "pickles", label: "مخلل", selected: false }, { id: "sauce", label: "صلصة خاصة", delta: kwd(150), selected: true }] },
      { kind: "CUSTOMIZER", groupId: "sides", label: "إضافات الوجبة", multi: true, options: [{ id: "fries", label: "بطاطس", delta: kwd(750), selected: true }, { id: "drink", label: "مشروب غازي", delta: kwd(500), selected: true }, { id: "salad", label: "سلطة جانبية", delta: kwd(600), selected: false }] },
      { kind: "VARIANT_PICKER", groupId: "qty", label: "الكمية", style: "STEPPER", options: [{ id: "q1", label: "1", available: true, selected: true }] },
    ],
    primaryAction: { kind: "ADD_TO_CART", label: "إضافة إلى السلة" },
    quote: { total: kwd(4250), lines: [{ label: "برجر عادي", amount: kwd(2500) }, { label: "جبن إضافي", amount: kwd(350) }, { label: "صلصة خاصة", amount: kwd(150) }, { label: "بطاطس", amount: kwd(750) }, { label: "مشروب غازي", amount: kwd(500) }], final: false },
  },
  FURNITURE: {
    ...base("fx-furniture", "FURNITURE", "معرض تجريبي للأثاث"),
    sections: [
      { kind: "HERO_GALLERY", media: [img("sofa", "أريكة رمادية بثلاثة مقاعد"), img("sofa-fabric", "قماش الأريكة")] },
      { kind: "PRODUCT_DETAIL", productId: "p-sofa", title: "أريكة عصرية بثلاثة مقاعد", subtitle: "قماش متين", price: kwd(119900), media: [] },
      { kind: "VARIANT_PICKER", groupId: "color", label: "اللون", style: "SWATCH", options: [["grey", "رمادي", "#6b7280"], ["navy", "كحلي", "#1e3a8a"], ["green", "أخضر", "#166534"], ["beige", "بيج", "#d6c7a1"]].map(([optionId, label, color], index) => ({ id: optionId!, label: label!, color: color!, available: true, selected: index === 0 })) },
      { kind: "SPECS", rows: [{ label: "العرض", value: "220 سم" }, { label: "العمق", value: "90 سم" }, { label: "الارتفاع", value: "85 سم" }] },
      { kind: "POLICIES", items: [{ icon: "DELIVERY", label: "توصيل وتركيب حسب سياسة المعرض" }, { icon: "RETURNS", label: "الإرجاع حسب سياسة المعرض المنشورة" }] },
      { kind: "RECOMMENDATIONS", label: "مناسب لـ", items: [{ id: "r-modern", title: "غرفة معاصرة", media: img("room-modern", "غرفة معاصرة") }, { id: "r-classic", title: "غرفة كلاسيكية", media: img("room-classic", "غرفة كلاسيكية") }] },
    ],
    primaryAction: { kind: "REVIEW_ORDER", label: "شراء الآن" },
  },
  OCCASION: {
    ...base("fx-occasion", "OCCASION", "دار أزياء تجريبية للمناسبات"),
    sections: [
      { kind: "PRODUCT_DETAIL", productId: "p-dress", title: "فستان سهرة", subtitle: "تصميم لمناسباتك الرسمية", price: kwd(59000), media: [img("dress", "فستان سهرة كحلي")] },
      { kind: "VARIANT_PICKER", groupId: "color", label: "اللون", style: "SWATCH", options: [["navy", "كحلي", "#1e3a8a"], ["black", "أسود", "#111827"], ["wine", "عنابي", "#7f1d1d"]].map(([optionId, label, color], index) => ({ id: optionId!, label: label!, color: color!, available: true, selected: index === 0 })) },
      { kind: "VARIANT_PICKER", groupId: "size", label: "المقاس", style: "SIZE", options: ["S", "M", "L", "XL", "XXL"].map((label) => ({ id: `size-${label}`, label, available: true, selected: label === "M" })) },
      { kind: "PRODUCT_GRID", products: [{ id: "p-d2", title: "فستان عنابي", price: kwd(64000), media: img("dress-wine", "فستان عنابي"), available: true }, { id: "p-d3", title: "فستان أسود", price: kwd(52000), media: img("dress-black", "فستان أسود"), available: true }] },
    ],
    primaryAction: { kind: "ADD_TO_CART", label: "إضافة إلى السلة" },
  },
  ACCESSORIES: {
    ...base("fx-accessories", "ACCESSORIES", "متجر تجريبي للساعات"),
    sections: [
      { kind: "HERO_GALLERY", media: [img("watch", "ساعة يد فضية")] },
      { kind: "PRODUCT_GRID", products: [{ id: "p-watch", title: "ساعة يد فضية", price: kwd(45000), media: img("watch", "ساعة يد فضية"), available: true, selected: true }, { id: "p-belt", title: "حزام جلد", price: kwd(9500), media: img("belt", "حزام جلد بني"), available: true }] },
    ],
    primaryAction: { kind: "ADD_TO_CART", label: "إضافة إلى السلة" },
  },
  GIFTS: {
    ...base("fx-gifts", "GIFTS", "متجر تجريبي للهدايا"),
    sections: [
      { kind: "BUNDLE_BUILDER", label: "صندوق هديتك", slots: [{ slotId: "flowers", label: "ورد", item: { id: "g-roses", title: "باقة ورد أحمر", price: kwd(8000), media: img("roses", "ورد أحمر") } }, { slotId: "sweets", label: "شوكولاتة", item: { id: "g-choc", title: "علبة شوكولاتة", price: kwd(6500), media: img("chocolate", "شوكولاتة") } }, { slotId: "card", label: "بطاقة" }] },
      { kind: "VARIANT_PICKER", groupId: "box", label: "لون الصندوق", style: "SWATCH", options: [["navy", "كحلي", "#1e3a8a"], ["pink", "وردي", "#f9a8d4"]].map(([optionId, label, color], index) => ({ id: optionId!, label: label!, color: color!, available: true, selected: index === 0 })) },
    ],
    primaryAction: { kind: "ADD_TO_CART", label: "إضافة الصندوق إلى السلة" },
    quote: { total: kwd(14500), lines: [{ label: "باقة ورد أحمر", amount: kwd(8000) }, { label: "علبة شوكولاتة", amount: kwd(6500) }], final: false },
  },
  ELECTRONICS: {
    ...base("fx-electronics", "ELECTRONICS", "متجر تجريبي للحاسبات"),
    sections: [
      { kind: "BUNDLE_BUILDER", label: "تجميعتك", slots: [{ slotId: "cpu", label: "المعالج", item: { id: "e-cpu", title: "معالج 8 أنوية", price: kwd(95000), media: img("cpu", "معالج") } }, { slotId: "gpu", label: "كرت الشاشة" }, { slotId: "psu", label: "مزود الطاقة" }], compatibility: { status: "NOT_VERIFIED", note: "لا يملك المتجر قواعد توافق منشورة؛ تحقّق قبل الشراء." } },
      { kind: "SPECS", rows: [{ label: "المقبس", value: "حسب بيانات المتجر" }] },
    ],
    primaryAction: { kind: "ADD_TO_CART", label: "إضافة التجميعة إلى السلة" },
  },
  VEHICLES: {
    ...base("fx-vehicles", "VEHICLES", "معرض سيارات تجريبي", "MERCHANT_SYSTEM"),
    source: { kind: "MERCHANT_SYSTEM", checkedAt: "2026-11-25T07:24:00.000Z" },
    sections: [
      { kind: "HERO_GALLERY", media: [img("suv", "سيارة رياضية زرقاء")] },
      { kind: "VARIANT_PICKER", groupId: "paint", label: "اللون الخارجي", style: "SWATCH", options: [["blue", "أزرق", "#1d4ed8"], ["white", "أبيض", "#f8fafc"], ["red", "أحمر", "#b91c1c"]].map(([optionId, label, color], index) => ({ id: optionId!, label: label!, color: color!, available: true, selected: index === 0 })) },
      { kind: "SPECS", rows: [{ label: "السعر", value: "حسب عرض الوكيل" }] },
    ],
    primaryAction: { kind: "BOOK_TEST_DRIVE", label: "احجز تجربة قيادة" },
  },
  GENERAL: {
    ...base("fx-general", "GENERAL", "متجر تجريبي عام", "BUY_ON_MERCHANT_WEBSITE"),
    sections: [{ kind: "PRODUCT_GRID", products: [{ id: "p-gen", title: "منتج تجريبي", price: usd(1999), media: img("generic", "منتج"), available: true }] }],
    primaryAction: { kind: "OPEN_MERCHANT_SITE", label: "افتح موقع المتجر" },
  },
};
