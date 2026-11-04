import type {
  InventoryMode,
  ListingRecord,
  MessageRecord,
  OrderItemRecord,
  OrderRecord,
  SellerDueRecord,
} from "./dinar-data";
import {
  calculatePlatformFeeMinor,
  formatMinorUnits,
  MARKET_CURRENCY,
  MAX_ORDER_QUANTITY,
  PLATFORM_FEE_BASIS_POINTS,
  parseMinorUnits,
} from "./market-pricing";

export type CheckoutLineInput = {
  listingId: string;
  quantity: number;
  fulfilmentType: string;
};

export type CheckoutIssue = {
  listingId: string;
  code: "NOT_FOUND" | "NOT_ACTIVE" | "SELLER_UNAVAILABLE" | "FULFILMENT_UNAVAILABLE" | "OUT_OF_STOCK" | "INVALID_QUANTITY" | "PRICING_UNAVAILABLE";
  message: string;
  availableQuantity?: number | null;
};

export type PlannedCheckoutLine = {
  listing: ListingRecord;
  quantity: number;
  fulfilmentType: string;
  unitPriceFils: number;
  /** Integer minor units; unitPriceFils remains for legacy callers. */
  unitPriceMinor: number;
  currencyCode: string;
};

export type CheckoutPlan = {
  groups: Map<string, PlannedCheckoutLine[]>;
  totalFils: number;
  /** Integer minor units in the plan currency; totalFils remains for legacy callers. */
  totalMinor: number;
  currencyCode: string;
};

export type CheckoutPlanResult =
  | { ok: true; plan: CheckoutPlan }
  | { ok: false; issues: CheckoutIssue[] };

export function planCheckout(
  lines: CheckoutLineInput[],
  listings: ListingRecord[],
  maxQuantity = MAX_ORDER_QUANTITY,
): CheckoutPlanResult {
  const merged = new Map<string, CheckoutLineInput>();
  const issues: CheckoutIssue[] = [];

  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > maxQuantity) {
      issues.push({
        listingId: line.listingId,
        code: "INVALID_QUANTITY",
        message: `الكمية يجب أن تكون عددًا صحيحًا من 1 إلى ${maxQuantity}.`,
      });
      continue;
    }
    const existing = merged.get(line.listingId);
    if (existing && existing.fulfilmentType !== line.fulfilmentType) {
      issues.push({
        listingId: line.listingId,
        code: "FULFILMENT_UNAVAILABLE",
        message: "لا يمكن إضافة العرض نفسه بطرق تنفيذ مختلفة في طلب واحد.",
      });
      continue;
    }
    const nextQuantity = (existing?.quantity ?? 0) + line.quantity;
    if (!Number.isSafeInteger(nextQuantity) || nextQuantity > maxQuantity) {
      issues.push({
        listingId: line.listingId,
        code: "INVALID_QUANTITY",
        message: `إجمالي الكمية يتجاوز الحد التقني ${maxQuantity}.`,
      });
      continue;
    }
    merged.set(line.listingId, { ...line, quantity: nextQuantity });
  }

  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  const planned: PlannedCheckoutLine[] = [];

  for (const line of merged.values()) {
    const listing = byId.get(line.listingId);
    if (!listing) {
      issues.push({ listingId: line.listingId, code: "NOT_FOUND", message: "العرض لم يعد موجودًا." });
      continue;
    }
    if (listing.status !== "PUBLISHED") {
      issues.push({ listingId: line.listingId, code: "NOT_ACTIVE", message: "العرض لم يعد نشطًا." });
      continue;
    }
    if (!listing.sellerId || !listing.sellerName) {
      issues.push({ listingId: line.listingId, code: "SELLER_UNAVAILABLE", message: "البائع غير متاح لاستقبال الطلبات." });
      continue;
    }
    if (line.fulfilmentType !== listing.fulfilmentType) {
      issues.push({ listingId: line.listingId, code: "FULFILMENT_UNAVAILABLE", message: "طريقة التنفيذ لم تعد متاحة لهذا العرض." });
      continue;
    }
    // Only FIXED listings are bought directly; NEGOTIABLE and OPEN_TO_OFFERS need an accepted
    // agreement, which the checkout route applies for that one buyer before planning.
    if (listing.pricingMode !== "FIXED" || listing.unitPrice === null) {
      issues.push({
        listingId: listing.id,
        code: "PRICING_UNAVAILABLE",
        message: "يحتاج هذا العرض إلى الاتفاق على السعر مع البائع ولا يمكن شراؤه مباشرة.",
      });
      continue;
    }
    if (listing.inventoryMode === "LIMITED") {
      const remaining = listing.availableQuantity === null
        ? 0
        : Math.max(0, listing.availableQuantity - listing.reservedQuantity);
      if (line.quantity > remaining) {
        issues.push({
          listingId: line.listingId,
          code: "OUT_OF_STOCK",
          message: remaining === 0 ? "نفد هذا العرض." : `المتوفر الآن ${remaining} فقط.`,
          availableQuantity: remaining,
        });
        continue;
      }
    }
    const currencyCode = listing.currency;
    let unitPriceMinor: number;
    try {
      unitPriceMinor = parseMinorUnits(listing.unitPrice, currencyCode);
    } catch {
      issues.push({ listingId: listing.id, code: "INVALID_QUANTITY", message: "سعر العرض غير صالح." });
      continue;
    }
    planned.push({
      listing,
      quantity: line.quantity,
      fulfilmentType: line.fulfilmentType,
      unitPriceFils: unitPriceMinor,
      unitPriceMinor,
      currencyCode,
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const groups = new Map<string, PlannedCheckoutLine[]>();
  let totalFils = 0;
  const currencyCode = planned[0]?.currencyCode ?? MARKET_CURRENCY;
  for (const line of planned) {
    if (line.currencyCode !== currencyCode) {
      return { ok: false, issues: [{ listingId: line.listing.id, code: "FULFILMENT_UNAVAILABLE", message: "لا يمكن خلط عملات مختلفة في السلة." }] };
    }
    const group = groups.get(line.listing.sellerId) ?? [];
    group.push(line);
    groups.set(line.listing.sellerId, group);
    totalFils += line.unitPriceFils * line.quantity;
    if (!Number.isSafeInteger(totalFils)) {
      return {
        ok: false,
        issues: [{
          listingId: line.listing.id,
          code: "INVALID_QUANTITY",
          message: "إجمالي السلة يتجاوز الحد الآمن للحساب.",
        }],
      };
    }
  }
  return { ok: true, plan: { groups, totalFils, totalMinor: totalFils, currencyCode } };
}

let idSequence = 0;
/** One honest buyer-facing sentence for a rejected plan: the actual reason, not a generic one. */
export function checkoutIssueMessage(issues: CheckoutIssue[]): string {
  if (issues.length === 1) return issues[0].message;
  if (issues.every((issue) => issue.code === "OUT_OF_STOCK")) return "تغير المخزون، راجع السلة";
  return "بعض عناصر السلة لم تعد قابلة للشراء، راجع السلة";
}

export function createOrdersFromPlan(
  plan: CheckoutPlan,
  state: {
    currentUser: { id: string; name: string };
    orders: OrderRecord[];
    messages: MessageRecord[];
  },
  now = Date.now(),
): { orders: OrderRecord[]; total: string; currency: string } {
  const createdAt = new Date(now).toISOString();
  const newOrders: OrderRecord[] = [];
  const newMessages: MessageRecord[] = [];

  for (const [sellerId, sellerLines] of plan.groups) {
    const linesByPrice = new Map<string, typeof sellerLines>();
    for (const line of sellerLines) {
      const key = `${line.currencyCode}:${line.unitPriceMinor}`;
      const group = linesByPrice.get(key);
      if (group) group.push(line);
      else linesByPrice.set(key, [line]);
    }

    for (const lines of linesByPrice.values()) {
      const first = lines[0];
      const items: OrderItemRecord[] = lines.map(({ listing, quantity, fulfilmentType, unitPriceMinor, currencyCode }) => ({
        listingId: listing.id,
        listingTitle: listing.title,
        listingImageUrl: listing.imageUrl,
        quantity,
        unitPrice: formatMinorUnits(unitPriceMinor, currencyCode),
        total: formatMinorUnits(unitPriceMinor * quantity, currencyCode),
        currency: currencyCode,
        fulfilmentType,
        inventoryMode: listing.inventoryMode,
      }));
      const orderTotalMinor = items.reduce((sum, item) => sum + parseMinorUnits(item.total, item.currency), 0);
      const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
      const fulfilmentTypes = new Set(items.map((item) => item.fulfilmentType));
      const order: OrderRecord = {
        id: `ord_${now}_${++idSequence}`,
        sellerId,
        items,
        inventoryReservationOpen: lines.some(({ listing }) => listing.inventoryMode === "LIMITED"),
        listingId: first.listing.id,
        listingTitle: items.length === 1
          ? first.listing.title
          : items.map((item) => `${item.listingTitle} ×${item.quantity}`).join(" · "),
        listingImageUrl: first.listing.imageUrl,
        buyerName: state.currentUser.name,
        sellerName: first.listing.sellerName,
        quantity: totalQuantity,
        unitPrice: formatMinorUnits(first.unitPriceMinor, first.currencyCode),
        total: formatMinorUnits(orderTotalMinor, first.currencyCode),
        commissionRateBps: PLATFORM_FEE_BASIS_POINTS,
        currency: first.currencyCode,
        fulfilmentType: fulfilmentTypes.size === 1 ? first.fulfilmentType : "MIXED",
        status: "CREATED",
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
        deliveryProof: null,
        issue: null,
      };
      newOrders.push(order);
      newMessages.push({
        id: `msg_${now}_${idSequence}`,
        orderId: order.id,
        senderName: "النظام",
        senderRole: "SYSTEM",
        body: "تم إنشاء الطلب وحجز الكمية المحدودة. يمكنك الآن التواصل داخل الطلب فقط.",
        createdAt,
        isMine: false,
      });
    }
  }

  // Express executes this in-memory handler synchronously; validate every line before changing any stock.
  for (const order of newOrders) {
    for (const item of order.items ?? []) {
      if (item.inventoryMode !== "LIMITED") continue;
      const listing = plan.groups.get(order.sellerId ?? "")?.find((line) => line.listing.id === item.listingId)?.listing;
      if (listing) listing.reservedQuantity += item.quantity;
    }
  }
  state.orders.unshift(...newOrders);
  state.messages.push(...newMessages);
  return {
    orders: newOrders,
    total: formatMinorUnits(plan.totalMinor, plan.currencyCode),
    currency: plan.currencyCode,
  };
}

function orderItems(order: OrderRecord, listings: ListingRecord[]): OrderItemRecord[] {
  if (order.items?.length) return order.items;
  const listing = listings.find((candidate) => candidate.id === order.listingId);
  return [{
    listingId: order.listingId,
    listingTitle: order.listingTitle,
    listingImageUrl: order.listingImageUrl,
    quantity: order.quantity,
    unitPrice: order.unitPrice,
    total: order.total,
    currency: order.currency,
    fulfilmentType: order.fulfilmentType,
    inventoryMode: listing?.inventoryMode ?? "LIMITED",
  }];
}

export function settleOrderInventory(
  order: OrderRecord,
  listings: ListingRecord[],
  disposition: "release" | "commit",
): void {
  if (!order.inventoryReservationOpen) return;
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  for (const item of orderItems(order, listings)) {
    if (item.inventoryMode !== "LIMITED") continue;
    const listing = byId.get(item.listingId);
    if (!listing) continue;
    listing.reservedQuantity = Math.max(0, listing.reservedQuantity - item.quantity);
    if (disposition === "commit" && listing.inventoryMode === "LIMITED" && listing.availableQuantity !== null) {
      listing.availableQuantity = Math.max(0, listing.availableQuantity - item.quantity);
    }
  }
  order.inventoryReservationOpen = false;
}

export function createSellerDueForOrder(
  order: OrderRecord,
  sellerDues: SellerDueRecord[],
  now = Date.now(),
): SellerDueRecord | null {
  if (sellerDues.some((due) => due.orderId === order.id)) return null;
  const totalMinor = parseMinorUnits(order.total, order.currency);
  const commissionRateBps = order.commissionRateBps ?? 1_000;
  const feeMinor = calculatePlatformFeeMinor(totalMinor, commissionRateBps);
  if (feeMinor === 0) return null;
  const due: SellerDueRecord = {
    id: `due_${order.id}`,
    orderId: order.id,
    listingTitle: order.listingTitle,
    amount: formatMinorUnits(feeMinor, order.currency),
    currency: order.currency,
    reason: `عمولة BDINAR بنسبة ${commissionRateBps / 100}% بعد اكتمال الطلب`,
    dueAt: new Date(now).toISOString(),
    status: "PENDING",
  };
  sellerDues.unshift(due);
  return due;
}

export function getRemainingQuantity(listing: ListingRecord): number | null {
  if (listing.inventoryMode === "UNLIMITED") return null;
  return Math.max(0, (listing.availableQuantity ?? 0) - listing.reservedQuantity);
}

export type InventoryModeUpdateResult =
  | { ok: true }
  | { ok: false; reason: "INVALID_QUANTITY" | "BELOW_RESERVED"; message: string };

export function applyInventoryModeUpdate(
  listing: ListingRecord,
  inventoryMode: InventoryMode,
  availableQuantity: number | null | undefined,
): InventoryModeUpdateResult {
  if (inventoryMode === "UNLIMITED") {
    listing.inventoryMode = "UNLIMITED";
    listing.availableQuantity = null;
    return { ok: true };
  }
  if (!Number.isSafeInteger(availableQuantity) || (availableQuantity ?? 0) < 1) {
    return { ok: false, reason: "INVALID_QUANTITY", message: "أدخل كمية محدودة صحيحة وموجبة." };
  }
  if ((availableQuantity ?? 0) < listing.reservedQuantity) {
    return {
      ok: false,
      reason: "BELOW_RESERVED",
      message: `لا يمكن أن يقل المخزون عن ${listing.reservedQuantity} وحدة محجوزة.`,
    };
  }
  listing.inventoryMode = "LIMITED";
  listing.availableQuantity = availableQuantity!;
  return { ok: true };
}

export type { InventoryMode };