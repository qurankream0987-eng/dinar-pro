export type InventoryMode = "LIMITED" | "UNLIMITED";
export const MAX_CART_LINES = 100;

export type CartEntry = {
  listingId: string;
  title: string;
  imageUrl: string;
  sellerId: string;
  sellerName: string;
  unitPrice: string;
  currency: string;
  quantity: number;
  fulfilmentType: string;
  inventoryMode: InventoryMode;
  /** Latest buyer-purchasable quantity observed from the API; null means unlimited. */
  availableQuantity: number | null;
  /** A negotiable listing at this buyer's agreed price (unitPrice); quantity is capped by the agreement. */
  agreedPrice?: boolean;
  listedUnitPrice?: string;
  /** A negotiable listing without a usable agreement: it stays visible but cannot be checked out or grow. */
  requiresAgreement?: boolean;
};

/** Lines whose quantity has a ceiling: limited stock, or the quantity covered by an agreed price. */
export const isQuantityCapped = (item: CartEntry) =>
  item.inventoryMode === "LIMITED" || item.agreedPrice === true;

const capMessage = (item: CartEntry, available: number) =>
  item.agreedPrice ? `السعر المتفق عليه يتيح لك ${available} فقط.` : `المتوفر الآن ${available} فقط.`;
export const AGREEMENT_REQUIRED_MESSAGE = "اتفق مع البائع على السعر أولًا؛ لا يُشترى هذا العرض بالسعر المعلن.";

export type CartResult =
  | { ok: true; items: CartEntry[] }
  | { ok: false; message: string; availableQuantity?: number };

export { currencyScale } from '@workspace/global';
import { decimalToMinor, minorToDecimal } from '@workspace/global';
export const parseAmountToMinor = (amount: string | number, currency: string) => decimalToMinor(amount, currency);
export const formatMinorAmount = (minor: number, currency: string) => minorToDecimal(minor, currency);

/** Cart totals are only meaningful within one isolated market/currency. */
export function getCartTotalMinor(items: CartEntry[]): number {
  const currencies = new Set(items.map((item) => item.currency));
  if (currencies.size > 1) throw new Error("لا يمكن جمع أسعار بعملات مختلفة في سلة واحدة.");
  const total = items.reduce((sum, item) => sum + parseAmountToMinor(item.unitPrice, item.currency) * item.quantity, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError("إجمالي السلة يتجاوز النطاق الآمن.");
  return total;
}

export function getCartUnitCount(items: CartEntry[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

function validQuantity(quantity: number): boolean {
  return Number.isSafeInteger(quantity) && quantity >= 1;
}

export function addCartEntry(items: CartEntry[], incoming: CartEntry, quantity: number): CartResult {
  if (!validQuantity(quantity)) return { ok: false, message: "أدخل كمية صحيحة لا تقل عن 1." };
  const existingIndex = items.findIndex((item) => item.listingId === incoming.listingId);
  if (existingIndex === -1 && items.length >= MAX_CART_LINES) {
    return { ok: false, message: `يمكن إضافة ${MAX_CART_LINES} عروض كحد أقصى في السلة.` };
  }
  const currentQuantity = existingIndex === -1 ? 0 : items[existingIndex].quantity;
  const nextQuantity = currentQuantity + quantity;
  if (!Number.isSafeInteger(nextQuantity)) return { ok: false, message: "الكمية تتجاوز الحد التقني الآمن." };
  if (incoming.requiresAgreement) return { ok: false, message: AGREEMENT_REQUIRED_MESSAGE };
  if (isQuantityCapped(incoming) && incoming.availableQuantity !== null && nextQuantity > incoming.availableQuantity) {
    return {
      ok: false,
      message: capMessage(incoming, incoming.availableQuantity),
      availableQuantity: incoming.availableQuantity,
    };
  }

  const entry = { ...incoming, quantity: nextQuantity };
  if (existingIndex === -1) return { ok: true, items: [...items, entry] };
  return {
    ok: true,
    items: items.map((item, index) => index === existingIndex ? entry : item),
  };
}

export function setCartEntryQuantity(items: CartEntry[], listingId: string, quantity: number): CartResult {
  if (quantity === 0) return { ok: true, items: items.filter((item) => item.listingId !== listingId) };
  if (!validQuantity(quantity)) return { ok: false, message: "أدخل عددًا صحيحًا موجبًا." };
  const entry = items.find((item) => item.listingId === listingId);
  if (!entry) return { ok: true, items };
  if (entry.requiresAgreement && quantity > entry.quantity) return { ok: false, message: AGREEMENT_REQUIRED_MESSAGE };
  if (isQuantityCapped(entry) && entry.availableQuantity !== null && quantity > entry.availableQuantity) {
    return {
      ok: false,
      message: capMessage(entry, entry.availableQuantity),
      availableQuantity: entry.availableQuantity,
    };
  }
  return {
    ok: true,
    items: items.map((item) => item.listingId === listingId ? { ...item, quantity } : item),
  };
}

export function updateCartAvailability(
  items: CartEntry[],
  listingId: string,
  availableQuantity: number | null,
): CartEntry[] {
  // An agreed line keeps the server's cap (stock and agreement); listing stock alone cannot raise it.
  return items.map((item) => item.listingId === listingId && !item.agreedPrice
    ? { ...item, availableQuantity: item.inventoryMode === "UNLIMITED" ? null : availableQuantity }
    : item);
}