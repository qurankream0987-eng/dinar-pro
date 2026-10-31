/**
 * D3-A business capabilities. The model, a request body or a business display name can never
 * grant one: they are derived only from D2 trusted state (owner/staff membership) and the
 * D3 operating profile inside the server.
 */
export const BUSINESS_CAPABILITIES = [
  "business.read",
  "business.profile.manage",
  "business.catalog.read",
  "business.catalog.draft",
  "business.catalog.publish",
  "business.listing.update",
  "business.inventory.manage",
  "business.orders.read",
  "business.analytics.read",
] as const;

export type BusinessCapability = (typeof BUSINESS_CAPABILITIES)[number];

export const BUSINESS_CAPABILITY_LABELS: Record<BusinessCapability, string> = {
  "business.read": "عرض بيانات النشاط",
  "business.profile.manage": "إدارة ملف النشاط",
  "business.catalog.read": "عرض المنتجات",
  "business.catalog.draft": "إعداد مسودات المنتجات",
  "business.catalog.publish": "نشر المنتجات",
  "business.listing.update": "تعديل المنتجات المنشورة",
  "business.inventory.manage": "إدارة المخزون",
  "business.orders.read": "عرض طلبات النشاط",
  "business.analytics.read": "عرض أداء النشاط",
};

const known = new Set<string>(BUSINESS_CAPABILITIES);

/** D2 may add scopes D3 does not know yet; they are dropped, never guessed. */
export function businessCapabilities(values: readonly unknown[]): BusinessCapability[] {
  return [...new Set(values.filter((value): value is BusinessCapability => typeof value === "string" && known.has(value)))];
}

/** Capabilities that change what buyers can see or buy; all require verified, eligible identity. */
export const PUBLICATION_CAPABILITIES: readonly BusinessCapability[] = [
  "business.catalog.publish",
  "business.listing.update",
  "business.inventory.manage",
];
