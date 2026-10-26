import {
  Bike,
  Building2,
  CarFront,
  CloudDownload,
  Handshake,
  LayoutGrid,
  MonitorSmartphone,
  Shirt,
  Smartphone,
  Sofa,
  Store,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { GetListingsParams, Listing } from "@workspace/api-client-react";
import {
  PRICE_REPRESENTATION_PRICE_NOTE,
  directPurchaseAllowed,
  listingBuyerActions,
  priceRepresentationOfRecord,
  type ListingBuyerAction,
  type PriceRepresentation,
} from "@workspace/api-zod/listing-pricing";

/** Listings carry `city` in their JSON payload even though the generated type omits it. */
export type Offer = Listing & { city?: string };

/** What the listing's price means (the server sends it; older payloads are derived). */
export const offerRepresentation = (offer: Offer): PriceRepresentation | null =>
  priceRepresentationOfRecord(offer);

/** Only a definite asking price is bought without an agreement with the seller. */
export const offerDirectPurchase = (offer: Offer) =>
  directPurchaseAllowed(offerRepresentation(offer), offer.unitPrice === null ? null : 1);

/** The short note beside a shown price: «يبدأ من», «سعر استرشادي», «قابل للتفاوض». */
export const offerPriceNote = (offer: Offer) => {
  const representation = offerRepresentation(offer);
  return representation ? PRICE_REPRESENTATION_PRICE_NOTE[representation] : undefined;
};

/** What stands in place of a missing price; never «free» or zero. */
export const offerPriceFallback = (offer: Offer) =>
  offerRepresentation(offer) === "QUOTE_REQUIRED"
    ? "اطلب تسعيرة"
    : offerRepresentation(offer) === "OPEN_TO_OFFERS"
      ? "قدّم عرضك"
      : "السعر غير متاح";

/** The buyer actions valid for this viewer and listing, primary first. */
export const offerBuyerActions = (
  offer: Offer,
  viewer: { isSeller: boolean; inStock: boolean },
): ListingBuyerAction[] =>
  listingBuyerActions({
    representation: offerRepresentation(offer),
    unitPriceMinor: offer.unitPrice === null ? null : 1,
    viewerIsSeller: viewer.isSeller,
    published: offer.status === "PUBLISHED",
    inStock: viewer.inStock,
  });

/* ---------------- Category icon hints (all labels come from the API registry) ---------- */

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  إلكترونيات: Smartphone,
  أزياء: Shirt,
  خدمات: Wrench,
  منزل: Sofa,
  "خدمات رقمية": MonitorSmartphone,
  سيارات: CarFront,
  عقارات: Building2,
};
export const categoryIcon = (c?: string) => (c && CATEGORY_ICONS[c]) || LayoutGrid;

/** The seller's own offers in the active market, any status (server supports `own=true`). */
export const OWN_LISTINGS = { own: "true" } as unknown as GetListingsParams;

/* ---------------- Fulfilment / execution ---------------------------------------------- */

export type Fulfilment = "PICKUP" | "DELIVERY" | "DIGITAL" | "SERVICE";

export const FULFILMENT: Record<
  string,
  { label: string; icon: LucideIcon; buyer: string; seller: string }
> = {
  PICKUP: {
    label: "استلام من البائع",
    icon: Store,
    buyer: "تستلم الطلب من البائع. يتفق الطرفان على المكان والوقت في محادثة الطلب.",
    seller: "المشتري يستلم منك. تحددان المكان والوقت في محادثة الطلب.",
  },
  DELIVERY: {
    label: "توصيل",
    icon: Bike,
    buyer: "يوصل البائع الطلب إليك. أضف تعليمات التوصيل عند إتمام الطلب.",
    seller: "توصل الطلب للمشتري حسب التعليمات التي يرسلها عند الطلب.",
  },
  DIGITAL: {
    label: "رقمي",
    icon: CloudDownload,
    buyer: "تسليم رقمي عن بُعد — لا حاجة لعنوان.",
    seller: "تسلّم عملك رقميًا عبر محادثة الطلب — لا حاجة لعنوان.",
  },
  SERVICE: {
    label: "خدمة",
    icon: Handshake,
    buyer: "خدمة تُنفَّذ لك. يتفق الطرفان على الموعد والتفاصيل في محادثة الطلب.",
    seller: "تنفّذ خدمة للمشتري وتتفقان على الموعد داخل محادثة الطلب.",
  },
};
export const fulfilment = (type?: string) =>
  FULFILMENT[type ?? ""] ?? { label: type ?? "—", icon: Store, buyer: "", seller: "" };

/* ---------------- Inventory ----------------------------------------------------------- */

/** Units a buyer can still purchase; null = unlimited. */
export function remainingOf(o: Pick<Listing, "inventoryMode" | "availableQuantity" | "reservedQuantity">) {
  if (o.inventoryMode === "UNLIMITED") return null;
  return Math.max(0, (o.availableQuantity ?? 0) - (o.reservedQuantity ?? 0));
}

export type StockState = { tone: "ok" | "low" | "out"; label: string; remaining: number | null };
export function stockOf(o: Pick<Listing, "inventoryMode" | "availableQuantity" | "reservedQuantity">): StockState {
  const remaining = remainingOf(o);
  if (remaining === null) return { tone: "ok", label: "متوفر", remaining };
  if (remaining === 0) return { tone: "out", label: "نفد", remaining };
  if (remaining <= 3) return { tone: "low", label: `متبقي ${remaining}`, remaining };
  return { tone: "ok", label: `متوفر · ${remaining}`, remaining };
}

export const placeOf = (o: { city?: string; area?: string }) =>
  [o.city, o.area].filter((p) => p && p.trim()).filter((p, i, all) => all.indexOf(p) === i).join("، ");

/* ---------------- Orders -------------------------------------------------------------- */

export type Tone = "neutral" | "info" | "primary" | "warning" | "success" | "danger";
export type Role = "buyer" | "seller";

const OPEN = ["CREATED", "PAYMENT_PENDING", "PAID"];
const WORKING = ["ACCEPTED", "IN_PROGRESS"];
const DONE = ["COMPLETED", "BUYER_CONFIRMED"];

export function orderStatus(status: string, role: Role): { label: string; tone: Tone } {
  if (OPEN.includes(status))
    return role === "seller"
      ? { label: "جديد", tone: "info" }
      : { label: "بانتظار موافقة البائع", tone: "info" };
  if (WORKING.includes(status)) return { label: "قيد التنفيذ", tone: "primary" };
  if (status === "SELLER_MARKED_DELIVERED")
    return role === "buyer"
      ? { label: "بانتظار تأكيدك", tone: "warning" }
      : { label: "بانتظار تأكيد المشتري", tone: "warning" };
  if (DONE.includes(status)) return { label: "مكتمل", tone: "success" };
  if (status === "DISPUTED") return { label: "نزاع", tone: "danger" };
  if (status === "CANCELLED") return { label: "ملغي", tone: "neutral" };
  return { label: status, tone: "neutral" };
}

/** What this participant has to do next, if anything. */
export function nextAction(status: string, role: Role): string | null {
  if (role === "seller") {
    if (OPEN.includes(status)) return "راجع الطلب واقبله";
    if (WORKING.includes(status)) return "سلّم الطلب وأضف إثبات التسليم";
  } else {
    if (status === "SELLER_MARKED_DELIVERED") return "أكد الاستلام أو أبلغ عن مشكلة";
  }
  return null;
}

export const isActiveOrder = (status: string) =>
  [...OPEN, ...WORKING, "SELLER_MARKED_DELIVERED"].includes(status);
export const isClosedOrder = (status: string) => [...DONE, "CANCELLED"].includes(status);

export const TIMELINE = [
  { key: "CREATED", label: "تم إنشاء الطلب" },
  { key: "ACCEPTED", label: "وافق البائع" },
  { key: "DELIVERED", label: "تم التسليم" },
  { key: "COMPLETED", label: "أكد المشتري · مكتمل" },
] as const;

export function timelineIndex(status: string) {
  if (OPEN.includes(status)) return 0;
  if (WORKING.includes(status)) return 1;
  if (status === "SELLER_MARKED_DELIVERED" || status === "DISPUTED" || DONE.includes(status)) return 3;
  return 0;
}
