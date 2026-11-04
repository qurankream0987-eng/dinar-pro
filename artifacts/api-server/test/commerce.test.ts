import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyInventoryModeUpdate,
  checkoutIssueMessage,
  createOrdersFromPlan,
  createSellerDueForOrder,
  getRemainingQuantity,
  planCheckout,
  settleOrderInventory,
} from "../src/lib/commerce";
import type { ListingRecord } from "../src/lib/dinar-data";
import {
  calculatePlatformFeeFils,
  calculatePlatformFeeMinor,
  formatKwdFromFils,
  formatMinorUnits,
  parseKwdToFils,
  parseMinorUnits,
} from "../src/lib/market-pricing";
import { CheckoutCartBody } from "@workspace/api-zod";
import {
  addCartEntry,
  setCartEntryQuantity,
  type CartEntry,
} from "../../dinar/src/cart/cart-domain";
import { createCartStorage } from "../../dinar/src/cart/cart-storage";

const makeListing = (overrides: Partial<ListingRecord> = {}): ListingRecord => ({
  id: "listing-1",
  title: "عرض تجريبي",
  description: "وصف تجريبي صالح للاختبارات",
  category: "خدمات",
  area: "مدينة الكويت",
  unitPrice: "1.000",
  pricingMode: "FIXED",
  currency: "KWD",
  availableQuantity: 10,
  reservedQuantity: 0,
  inventoryMode: "LIMITED",
  fulfilmentType: "PICKUP",
  sellerName: "بائع أول",
  sellerId: "seller-1",
  rating: 0,
  reviewCount: 0,
  imageUrl: "/sample-phone.svg",
  status: "PUBLISHED",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeCartEntry = (overrides: Partial<CartEntry> = {}): CartEntry => ({
  listingId: "listing-1",
  title: "عرض تجريبي",
  imageUrl: "/sample-phone.svg",
  sellerId: "seller-1",
  sellerName: "بائع أول",
  unitPrice: "1.000",
  currency: "KWD",
  quantity: 1,
  fulfilmentType: "PICKUP",
  inventoryMode: "LIMITED",
  availableQuantity: 5,
  ...overrides,
});

const line = (listingId: string, quantity: number, fulfilmentType = "PICKUP") => ({
  listingId,
  quantity,
  fulfilmentType,
});

function checkout(input: ReturnType<typeof line>[], listings: ListingRecord[]) {
  const result = planCheckout(input, listings);
  if (!result.ok) return result;
  const state = {
    currentUser: { id: "buyer-1", name: "مشتري تجريبي" },
    orders: [],
    messages: [],
  };
  return { ok: true as const, result: createOrdersFromPlan(result.plan, state, 1_800_000_000_000), state };
}

test("01 limited checkout reserves stock but does not decrement it", () => {
  const listing = makeListing();
  const result = checkout([line(listing.id, 3)], [listing]);
  assert.equal(result.ok, true);
  assert.equal(listing.reservedQuantity, 3);
  assert.equal(listing.availableQuantity, 10);
  assert.equal(getRemainingQuantity(listing), 7);
});

test("02 limited checkout rejects overselling with the fresh available quantity", () => {
  const listing = makeListing({ availableQuantity: 4, reservedQuantity: 1 });
  const result = planCheckout([line(listing.id, 4)], [listing]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issues[0].code, "OUT_OF_STOCK");
    assert.equal(result.issues[0].availableQuantity, 3);
  }
  assert.equal(listing.reservedQuantity, 1);
});

test("quote-required listings cannot be checked out or reserve inventory", () => {
  const listing = makeListing({
    unitPrice: null,
    pricingMode: "QUOTE_REQUIRED",
  });
  const result = planCheckout([line(listing.id, 1)], [listing]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0].code, "PRICING_UNAVAILABLE");
  assert.equal(listing.reservedQuantity, 0);
});

test("negotiable listings are not checked out at the public price without an agreement", () => {
  const listing = makeListing({ pricingMode: "NEGOTIABLE", unitPrice: "40.000" });
  const result = planCheckout([line(listing.id, 1)], [listing]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issues[0].code, "PRICING_UNAVAILABLE");
    assert.equal(checkoutIssueMessage(result.issues), "يحتاج هذا العرض إلى الاتفاق على السعر مع البائع ولا يمكن شراؤه مباشرة.");
  }
});

test("open-to-offers listings still need an agreed price before checkout", () => {
  const listing = makeListing({ pricingMode: "OPEN_TO_OFFERS", unitPrice: "40.000" });
  const result = planCheckout([line(listing.id, 1)], [listing]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issues[0].code, "PRICING_UNAVAILABLE");
    assert.equal(checkoutIssueMessage(result.issues), result.issues[0].message);
  }
});

test("checkout rejection message names the actual reason", () => {
  const out = makeListing({ availableQuantity: 1 });
  const single = planCheckout([line(out.id, 2)], [out]);
  assert.equal(single.ok, false);
  if (!single.ok) assert.equal(checkoutIssueMessage(single.issues), "المتوفر الآن 1 فقط.");
  const gone = makeListing({ id: "listing-2", status: "PAUSED" } as Partial<ListingRecord>);
  const mixed = planCheckout([line(out.id, 2), line(gone.id, 1)], [out, gone]);
  assert.equal(mixed.ok, false);
  if (!mixed.ok) assert.equal(checkoutIssueMessage(mixed.issues), "بعض عناصر السلة لم تعد قابلة للشراء، راجع السلة");
});

test("03 zero quantity is rejected", () => {
  const result = planCheckout([line("listing-1", 0)], [makeListing()]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0].code, "INVALID_QUANTITY");
});

test("04 negative, fractional, unsafe, and over-limit quantities are rejected", () => {
  for (const quantity of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1_000_001]) {
    const result = planCheckout([line("listing-1", quantity)], [makeListing()]);
    assert.equal(result.ok, false, `quantity ${quantity} should be rejected`);
    if (!result.ok) assert.equal(result.issues[0].code, "INVALID_QUANTITY");
  }
});

test("05 unlimited listings do not reserve or decrement stock", () => {
  const listing = makeListing({ inventoryMode: "UNLIMITED", availableQuantity: null });
  const result = checkout([line(listing.id, 25)], [listing]);
  assert.equal(result.ok, true);
  assert.equal(listing.availableQuantity, null);
  assert.equal(listing.reservedQuantity, 0);
});

test("06 repeated cart lines for a listing merge before stock validation", () => {
  const listing = makeListing();
  const result = checkout([line(listing.id, 2), line(listing.id, 3)], [listing]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.orders.length, 1);
    assert.equal(result.result.orders[0].quantity, 5);
    assert.equal(result.result.orders[0].items?.length, 1);
  }
  assert.equal(listing.reservedQuantity, 5);
});

test("07 different prices from one seller split into arithmetically consistent orders", () => {
  const first = makeListing({
    id: "first",
    title: "الخدمة الأولى",
    unitPrice: "1.250",
  });
  const second = makeListing({
    id: "second",
    title: "الخدمة الثانية",
    unitPrice: "2.500",
  });
  const result = checkout([line(first.id, 2), line(second.id, 3)], [first, second]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.orders.length, 2);
    assert.deepEqual(
      result.result.orders.map((order) => [order.unitPrice, order.quantity, order.total]),
      [
        ["1.250", 2, "2.500"],
        ["2.500", 3, "7.500"],
      ],
    );
    for (const order of result.result.orders) {
      assert.equal(
        parseMinorUnits(order.unitPrice, order.currency) * order.quantity,
        parseMinorUnits(order.total, order.currency),
      );
    }
  }
});

test("07b same-price offers from one seller remain in one order", () => {
  const first = makeListing({ id: "first", unitPrice: "1.250" });
  const second = makeListing({ id: "second", unitPrice: "1.250" });
  const result = checkout([line(first.id, 2), line(second.id, 3)], [first, second]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.orders.length, 1);
    assert.equal(result.result.orders[0].quantity, 5);
    assert.equal(result.result.orders[0].total, "6.250");
    assert.equal(result.result.orders[0].items?.length, 2);
  }
});

test("08 different sellers get separate orders and untrusted client totals are ignored", () => {
  const first = makeListing({ id: "first", sellerId: "seller-1", sellerName: "بائع أول" });
  const second = makeListing({ id: "second", sellerId: "seller-2", sellerName: "بائع ثان" });
  const parsed = CheckoutCartBody.parse({
    items: [line(first.id, 1), line(second.id, 2)],
    idempotencyKey: "commerce-test-key-0001",
    total: "0.001",
    currency: "USD",
  });
  assert.equal("total" in parsed, false);
  const result = checkout(parsed.items, [first, second]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.orders.length, 2);
    assert.deepEqual(result.result.orders.map((order) => order.total).sort(), ["1.000", "2.000"]);
  }
});

test("09 stock changed since cart add rejects checkout without partial reservations", () => {
  const first = makeListing({ id: "first", availableQuantity: 10 });
  const second = makeListing({ id: "second", availableQuantity: 2, sellerId: "seller-2" });
  const result = planCheckout([line(first.id, 3), line(second.id, 3)], [first, second]);
  assert.equal(result.ok, false);
  assert.equal(first.reservedQuantity, 0);
  assert.equal(second.reservedQuantity, 0);
});

test("10 cancelling an unaccepted order releases its reservation", () => {
  const listing = makeListing({ availableQuantity: 8 });
  const result = checkout([line(listing.id, 3)], [listing]);
  assert.equal(result.ok, true);
  if (result.ok) {
    const order = result.result.orders[0];
    settleOrderInventory(order, [listing], "release");
    assert.equal(listing.reservedQuantity, 0);
    assert.equal(listing.availableQuantity, 8);
  }
});

test("11 completing an order commits only its reserved quantity", () => {
  const listing = makeListing({ availableQuantity: 8 });
  const result = checkout([line(listing.id, 3)], [listing]);
  assert.equal(result.ok, true);
  if (result.ok) {
    settleOrderInventory(result.result.orders[0], [listing], "commit");
    assert.equal(listing.reservedQuantity, 0);
    assert.equal(listing.availableQuantity, 5);
  }
});

test("seller dues preserve historical 15% snapshots and current 10% orders, and are created once", () => {
  const listing = makeListing();
  const result = checkout([line(listing.id, 7)], [listing]);
  assert.equal(result.ok, true);
  if (result.ok) {
    const dues = [];
    const historicalOrder = { ...result.result.orders[0], commissionRateBps: 1_500 };
    assert.equal(result.result.orders[0].commissionRateBps, 1_000);
    const first = createSellerDueForOrder(historicalOrder, dues, 1_800_000_000_000);
    const second = createSellerDueForOrder(historicalOrder, dues, 1_800_000_000_001);
    assert.equal(first?.amount, "1.050");
    assert.equal(first?.reason, "عمولة BDINAR بنسبة 15% بعد اكتمال الطلب");
    assert.equal(second, null);
    assert.equal(dues.length, 1);

    const legacyOrder = { ...result.result.orders[0] };
    delete legacyOrder.commissionRateBps;
    const legacyDue = createSellerDueForOrder(
      legacyOrder,
      [],
      1_800_000_000_002,
    );
    assert.equal(legacyDue?.amount, "0.700");
    assert.equal(legacyDue?.reason, "عمولة BDINAR بنسبة 10% بعد اكتمال الطلب");
  }
});

test("13 KWD arithmetic stays exact in fils", () => {
  assert.equal(parseKwdToFils("4.019"), 4019);
  assert.equal(formatKwdFromFils(4019), "4.019");
  assert.equal(calculatePlatformFeeFils(7000), 700);
  assert.throws(() => parseKwdToFils("1.0001"), RangeError);
});

test("19 currency arithmetic uses the ISO minor-unit scale", () => {
  const cases = [
    ["JPY", "123", 123],
    ["USD", "12.34", 1234],
    ["KWD", "4.019", 4019],
    ["CLF", "7.1234", 71234],
  ] as const;
  for (const [currencyCode, decimal, minor] of cases) {
    assert.equal(parseMinorUnits(decimal, currencyCode), minor);
    assert.equal(formatMinorUnits(minor, currencyCode), decimal);
  }
  assert.equal(calculatePlatformFeeMinor(1234), 123);
  assert.equal(calculatePlatformFeeMinor(123), 12);
  assert.equal(calculatePlatformFeeMinor(1234, 1_500), 185);
  assert.equal(calculatePlatformFeeMinor(1234, 1_000), 123);
});

test("14 cart additions merge duplicates and enforce limited stock", () => {
  const entry = makeCartEntry();
  const first = addCartEntry([], entry, 2);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const merged = addCartEntry(first.items, entry, 2);
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].quantity, 4);
  const over = addCartEntry(merged.items, entry, 2);
  assert.equal(over.ok, false);
});

test("15 cart quantity updates can remove a line with quantity zero", () => {
  const result = setCartEntryQuantity([makeCartEntry()], "listing-1", 0);
  assert.deepEqual(result, { ok: true, items: [] });
});

test("16 cart storage restores valid state and clears invalid payloads", () => {
  const data = new Map<string, string>();
  let removed = false;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => { removed = true; data.delete(key); },
  };
  const cartStorage = createCartStorage(storage);
  const entry = makeCartEntry();
  cartStorage.save([entry]);
  assert.deepEqual(cartStorage.load(), [entry]);
  data.set("bdinar-cart-v1", "{");
  assert.deepEqual(cartStorage.load(), []);
  assert.equal(removed, true);
});

test("17 limited inventory can be switched to unlimited without affecting older reservations", () => {
  const listing = makeListing({ reservedQuantity: 2 });
  assert.deepEqual(applyInventoryModeUpdate(listing, "UNLIMITED", null), { ok: true });
  assert.equal(listing.availableQuantity, null);
  assert.equal(listing.reservedQuantity, 2);
  const result = checkout([line(listing.id, 20)], [listing]);
  assert.equal(result.ok, true);
  assert.equal(listing.reservedQuantity, 2);
});

test("18 unlimited inventory can be bounded only with a safe quantity at least as high as reservations", () => {
  const listing = makeListing({ inventoryMode: "UNLIMITED", availableQuantity: null, reservedQuantity: 2 });
  assert.equal(applyInventoryModeUpdate(listing, "LIMITED", 1).ok, false);
  assert.equal(applyInventoryModeUpdate(listing, "LIMITED", 0).ok, false);
  assert.deepEqual(applyInventoryModeUpdate(listing, "LIMITED", 4), { ok: true });
  assert.equal(listing.inventoryMode, "LIMITED");
  assert.equal(getRemainingQuantity(listing), 2);
});