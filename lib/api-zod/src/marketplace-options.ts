export const LISTING_CATEGORIES = [
  "إلكترونيات",
  "أزياء",
  "خدمات",
  "منزل",
  "خدمات رقمية",
  "سيارات",
  "عقارات",
  "أخرى",
] as const;

export const FULFILMENT_OPTIONS = [
  { value: "PICKUP", label: "استلام" },
  { value: "DELIVERY", label: "توصيل" },
  { value: "DIGITAL", label: "رقمي" },
  { value: "SERVICE", label: "خدمة" },
] as const;