import { MAX_CART_LINES, parseAmountToMinor, type CartEntry } from "./cart-domain";

export const CART_STORAGE_KEY = "bdinar-cart-v1";
const CART_VERSION = 1;

export type StorageAdapter = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type CartStorage = {
  load: () => CartEntry[];
  save: (items: CartEntry[]) => void;
  clear: () => void;
};

function isCartEntry(value: unknown): value is CartEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  let validUnitPrice = false;
  if (typeof item.unitPrice === "string") {
    try {
      if (typeof item.currency !== "string" || !item.currency) throw new Error("Missing currency");
      parseAmountToMinor(item.unitPrice, item.currency);
      validUnitPrice = true;
    } catch {
      validUnitPrice = false;
    }
  }
  return typeof item.listingId === "string"
    && typeof item.title === "string"
    && typeof item.imageUrl === "string"
    && typeof item.sellerId === "string"
    && typeof item.sellerName === "string"
    && validUnitPrice
    && typeof item.currency === "string"
    && Number.isSafeInteger(item.quantity)
    && (item.quantity as number) >= 1
    && typeof item.fulfilmentType === "string"
    && (item.inventoryMode === "LIMITED" || item.inventoryMode === "UNLIMITED")
    && (item.availableQuantity === null || (Number.isSafeInteger(item.availableQuantity) && (item.availableQuantity as number) >= 0));
}

export function createCartStorage(storage: StorageAdapter, key = CART_STORAGE_KEY): CartStorage {
  return {
    load() {
      const raw = storage.getItem(key);
      if (!raw) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") throw new Error("Invalid cart payload");
        const payload = parsed as { version?: unknown; items?: unknown };
        if (payload.version !== CART_VERSION || !Array.isArray(payload.items) || payload.items.length > MAX_CART_LINES || !payload.items.every(isCartEntry)) {
          throw new Error("Unsupported or invalid cart payload");
        }
        return payload.items;
      } catch {
        storage.removeItem(key);
        return [];
      }
    },
    save(items) {
      storage.setItem(key, JSON.stringify({ version: CART_VERSION, items }));
    },
    clear() {
      storage.removeItem(key);
    },
  };
}

export const browserCartStorage: CartStorage = {
  load: () => typeof window === "undefined" ? [] : createCartStorage(window.localStorage).load(),
  save: (items) => {
    if (typeof window !== "undefined") createCartStorage(window.localStorage).save(items);
  },
  clear: () => {
    if (typeof window !== "undefined") createCartStorage(window.localStorage).clear();
  },
};