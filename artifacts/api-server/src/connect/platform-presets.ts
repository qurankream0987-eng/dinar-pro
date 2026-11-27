/**
 * Connect-01 — One-Click E-Commerce Platform Presets (Salla, Zid, Shopify, WooCommerce)
 * + Smart Auto-Mapper that infers RFC 6901 JSON Pointers from any merchant's sample JSON response.
 */

export type ConnectPlatformPresetId = "SALLA" | "ZID" | "SHOPIFY" | "WOOCOMMERCE";

export interface PlatformCardMappingPreset {
  id: ConnectPlatformPresetId;
  nameAr: string;
  itemsPointer: string;
  idPointer: string;
  titlePointer: string;
  pricePointer: string;
  imagePointer: string;
  availablePointer: string;
  modifiersPointer?: string;
}

export const CONNECT_PLATFORM_PRESETS: Readonly<Record<ConnectPlatformPresetId, PlatformCardMappingPreset>> = {
  SALLA: { id: "SALLA", nameAr: "سلة (Salla)", itemsPointer: "/data", idPointer: "/id", titlePointer: "/name", pricePointer: "/price/amount", imagePointer: "/main_image", availablePointer: "/is_available", modifiersPointer: "/options" },
  ZID: { id: "ZID", nameAr: "زد (Zid)", itemsPointer: "/results", idPointer: "/id", titlePointer: "/name/ar", pricePointer: "/price", imagePointer: "/images/0/image/full_size", availablePointer: "/in_stock", modifiersPointer: "/variants" },
  SHOPIFY: { id: "SHOPIFY", nameAr: "شوبيفاي (Shopify)", itemsPointer: "/products", idPointer: "/id", titlePointer: "/title", pricePointer: "/variants/0/price", imagePointer: "/image/src", availablePointer: "/status", modifiersPointer: "/variants" },
  WOOCOMMERCE: { id: "WOOCOMMERCE", nameAr: "ووكومرس (WooCommerce)", itemsPointer: "", idPointer: "/id", titlePointer: "/name", pricePointer: "/price", imagePointer: "/images/0/src", availablePointer: "/in_stock", modifiersPointer: "/attributes" },
};

export interface AutoDetectedMapping {
  itemsPointer: string;
  idPointer?: string;
  titlePointer?: string;
  pricePointer?: string;
  imagePointer?: string;
  availablePointer?: string;
  modifiersPointer?: string;
  confidence: number;
}

function findArrayRoot(payload: unknown): { pointer: string; items: unknown[] } | null {
  if (Array.isArray(payload)) return { pointer: "", items: payload };
  if (!payload || typeof payload !== "object") return null;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
      return { pointer: `/${k}`, items: v };
    }
  }
  return null;
}

function findKey(obj: Record<string, unknown>, patterns: RegExp[], prefix = ""): string | undefined {
  for (const [k, v] of Object.entries(obj)) {
    const path = `${prefix}/${k}`;
    if (patterns.some((re) => re.test(k))) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const nested = v as Record<string, unknown>;
        if ("amount" in nested) return `${path}/amount`;
        if ("ar" in nested) return `${path}/ar`;
        if ("src" in nested) return `${path}/src`;
      }
      return path;
    }
  }
  return undefined;
}

export function autoDetectCardMapping(samplePayload: unknown): AutoDetectedMapping | null {
  const root = findArrayRoot(samplePayload);
  if (!root || root.items.length === 0) return null;
  const first = root.items[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const rec = first as Record<string, unknown>;

  const idPointer = findKey(rec, [/^id$/i, /^sku$/i, /product_?id/i]);
  const titlePointer = findKey(rec, [/^title$/i, /^name$/i, /product_?name/i]);
  const pricePointer = findKey(rec, [/^price$/i, /unit_?price/i, /^amount$/i]);
  const imagePointer = findKey(rec, [/main_?image/i, /^image$/i, /thumbnail/i, /^photo/i]);
  const availablePointer = findKey(rec, [/in_?stock/i, /is_?available/i, /^available$/i, /^status$/i]);
  const modifiersPointer = findKey(rec, [/^options$/i, /^variants$/i, /^modifiers$/i, /^layers$/i]);

  const found = [idPointer, titlePointer, pricePointer].filter(Boolean).length;
  return { itemsPointer: root.pointer, idPointer, titlePointer, pricePointer, imagePointer, availablePointer, modifiersPointer, confidence: Number((found / 3).toFixed(2)) };
}
