export type InventoryMode = "LIMITED" | "UNLIMITED";
export type ListingPricingMode = "FIXED" | "NEGOTIABLE" | "OPEN_TO_OFFERS";
export type { PriceRepresentation } from "@workspace/api-zod/listing-pricing";
import type { PriceRepresentation } from "@workspace/api-zod/listing-pricing";

export type ListingRecord = {
  id: string;
  title: string;
  description: string;
  category: string;
  categoryId?: string;
  marketId?: string;
  isSponsored?: boolean;
  /** Photo search only: computed from this persisted listing (ai/visual-search.ts). */
  visualMatch?: "EXACT" | "PROBABLE" | "SIMILAR";
  /** Server-only: the paid placement behind a sponsored slot (never trusted from a client). */
  sponsoredCampaignId?: string;
  sponsoredPlacement?: string;
  /** Public: VIP tier of a paid slot; always shown together with «ممول». */
  sponsoredTier?: "VIP" | "STANDARD";
  /** Public: opaque signed attribution token for a delivered paid card. */
  sponsoredToken?: string;
  /** Recommendation surfaces only: the deterministic signals that matched. */
  recommendationReasons?: string[];
  area: string;
  city?: string;
  attributes?: Record<string, string | number>;
  paymentMethods?: ("CASH_DIRECT" | "CARD")[];
  unitPrice: string | null;
  pricingMode: ListingPricingMode;
  /** What the price means (five representations over the three stored modes). */
  priceRepresentation?: PriceRepresentation;
  currency: string;
  availableQuantity: number | null;
  reservedQuantity: number;
  inventoryMode: InventoryMode;
  fulfilmentType: "PICKUP" | "DELIVERY" | "DIGITAL" | "SERVICE";
  sellerName: string;
  sellerAvatarObjectPath?: string | null;
  sellerId: string;
  rating: number;
  reviewCount: number;
  imageUrl: string;
  imageUrls?: string[];
  /** Universal negotiation: a buyer may propose a price on every listing with a known representation. */
  negotiable?: boolean;
  status: "DRAFT" | "PUBLISHED" | "PAUSED" | "ARCHIVED";
  createdAt: string;
};

export type OrderItemRecord = {
  listingId: string;
  listingTitle: string;
  listingImageUrl: string;
  quantity: number;
  unitPrice: string;
  total: string;
  currency: string;
  fulfilmentType: string;
  inventoryMode: InventoryMode;
};

export type OrderRecord = {
  id: string;
  sellerId?: string;
  items?: OrderItemRecord[];
  inventoryReservationOpen?: boolean;
  listingId: string;
  listingTitle: string;
  listingImageUrl: string;
  buyerName: string;
  buyerAvatarObjectPath?: string | null;
  sellerName: string;
  sellerAvatarObjectPath?: string | null;
  quantity: number;
  unitPrice: string;
  total: string;
  /** Immutable commission policy snapshot; omitted only by legacy records. */
  commissionRateBps?: number;
  currency: string;
  fulfilmentType: string;
  status:
    | "CREATED"
    | "PAYMENT_PENDING"
    | "PAID"
    | "ACCEPTED"
    | "IN_PROGRESS"
    | "SELLER_MARKED_DELIVERED"
    | "BUYER_CONFIRMED"
    | "COMPLETED"
    | "CANCELLED"
    | "DISPUTED";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  deliveryProof: string | null;
  issue: string | null;
};

export type MessageRecord = {
  id: string;
  orderId: string;
  senderName: string;
  senderRole: "BUYER" | "SELLER" | "SYSTEM";
  body: string;
  createdAt: string;
  isMine: boolean;
};

export type SellerDueRecord = {
  id: string;
  orderId: string;
  listingTitle: string;
  amount: string;
  currency: string;
  reason: string;
  dueAt: string;
  status: "PENDING" | "PAID" | "DISPUTED";
};

const now = Date.now();
const hoursFromNow = (hours: number) =>
  new Date(now + hours * 60 * 60 * 1000).toISOString();

export const listings: ListingRecord[] = [
  {
    id: "lst_phone",
    title: "iPhone 14 Pro بحالة ممتازة",
    description:
      "جهاز نظيف ومستعمل بعناية، مع العلبة والشاحن الأصلي. المعاينة والاستلام من السالمية.",
    category: "إلكترونيات",
    area: "السالمية",
    unitPrice: "1.000",
    pricingMode: "FIXED",
    currency: "KWD",
    availableQuantity: 1,
    reservedQuantity: 0,
    inventoryMode: "LIMITED",
    fulfilmentType: "PICKUP",
    sellerName: "محمد العتيبي",
    sellerId: "usr_seller_1",
    rating: 4.9,
    reviewCount: 32,
    imageUrl: "/sample-phone.svg",
    status: "PUBLISHED",
    createdAt: new Date(now - 1000 * 60 * 60 * 3).toISOString(),
  },
  {
    id: "lst_shirts",
    title: "تي شيرت قطن عضوي",
    description:
      "تي شيرت مريح من القطن العضوي، ألوان ومقاسات متعددة. اكتب اختيارك داخل الطلب.",
    category: "أزياء",
    area: "حولي",
    unitPrice: "1.000",
    pricingMode: "FIXED",
    currency: "KWD",
    availableQuantity: 20,
    reservedQuantity: 3,
    inventoryMode: "LIMITED",
    fulfilmentType: "DELIVERY",
    sellerName: "استوديو نون",
    sellerId: "usr_seller_2",
    rating: 4.8,
    reviewCount: 67,
    imageUrl:
      "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=1000&q=85",
    status: "PUBLISHED",
    createdAt: new Date(now - 1000 * 60 * 60 * 8).toISOString(),
  },
  {
    id: "lst_cleaning",
    title: "زيارة تنظيف منزلية",
    description:
      "زيارة تنظيف منظمة لمدة ساعتين. كل وحدة تعني زيارة واحدة، مع تحديد الموعد بعد قبول الطلب.",
    category: "خدمات",
    area: "الفروانية",
    unitPrice: "1.000",
    pricingMode: "FIXED",
    currency: "KWD",
    availableQuantity: 12,
    reservedQuantity: 0,
    inventoryMode: "LIMITED",
    fulfilmentType: "SERVICE",
    sellerName: "بيوت مرتبة",
    sellerId: "usr_seller_3",
    rating: 4.7,
    reviewCount: 19,
    imageUrl:
      "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1000&q=85",
    status: "PUBLISHED",
    createdAt: new Date(now - 1000 * 60 * 60 * 14).toISOString(),
  },
  {
    id: "lst_lamp",
    title: "مصباح طاولة خشبي",
    description:
      "مصباح بتصميم هادئ من الخشب الطبيعي، مناسب للمكتب أو غرفة النوم.",
    category: "منزل",
    area: "الروضة",
    unitPrice: "1.000",
    pricingMode: "FIXED",
    currency: "KWD",
    availableQuantity: 5,
    reservedQuantity: 0,
    inventoryMode: "LIMITED",
    fulfilmentType: "PICKUP",
    sellerName: "دار",
    sellerId: "usr_seller_4",
    rating: 4.6,
    reviewCount: 11,
    imageUrl:
      "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=1000&q=85",
    status: "PUBLISHED",
    createdAt: new Date(now - 1000 * 60 * 60 * 20).toISOString(),
  },
  {
    id: "lst_design",
    title: "تصميم منشور لوسائل التواصل",
    description:
      "تصميم منشور واحد جاهز للنشر بمقاس مناسب لحسابك، التسليم رقميًا داخل الطلب.",
    category: "خدمات رقمية",
    area: "عن بُعد",
    unitPrice: "1.000",
    pricingMode: "FIXED",
    currency: "KWD",
    availableQuantity: null,
    reservedQuantity: 0,
    inventoryMode: "UNLIMITED",
    fulfilmentType: "DIGITAL",
    sellerName: "لمسة",
    sellerId: "usr_seller_5",
    rating: 4.9,
    reviewCount: 44,
    imageUrl:
      "https://images.unsplash.com/photo-1558655146-9f40138edfeb?auto=format&fit=crop&w=1000&q=85",
    status: "PUBLISHED",
    createdAt: new Date(now - 1000 * 60 * 60 * 27).toISOString(),
  },
];

export const orders: OrderRecord[] = [
  {
    id: "ord_1001",
    sellerId: "usr_seller_2",
    inventoryReservationOpen: true,
    listingId: "lst_shirts",
    listingTitle: "تي شيرت قطن عضوي",
    listingImageUrl: listings[1].imageUrl,
    buyerName: "أحمد",
    sellerName: "استوديو نون",
    quantity: 3,
    unitPrice: "1.000",
    total: "3.000",
    commissionRateBps: 1_000,
    currency: "KWD",
    fulfilmentType: "DELIVERY",
    status: "IN_PROGRESS",
    createdAt: new Date(now - 1000 * 60 * 60 * 22).toISOString(),
    updatedAt: new Date(now - 1000 * 60 * 45).toISOString(),
    expiresAt: hoursFromNow(26),
    deliveryProof: null,
    issue: null,
  },
  {
    id: "ord_1002",
    sellerId: "usr_seller_5",
    inventoryReservationOpen: true,
    listingId: "lst_design",
    listingTitle: "تصميم منشور لوسائل التواصل",
    listingImageUrl: listings[4].imageUrl,
    buyerName: "أحمد",
    sellerName: "لمسة",
    quantity: 2,
    unitPrice: "1.000",
    total: "2.000",
    commissionRateBps: 1_000,
    currency: "KWD",
    fulfilmentType: "DIGITAL",
    status: "SELLER_MARKED_DELIVERED",
    createdAt: new Date(now - 1000 * 60 * 60 * 45).toISOString(),
    updatedAt: new Date(now - 1000 * 60 * 30).toISOString(),
    expiresAt: hoursFromNow(12),
    deliveryProof: "تم رفع الملف داخل الطلب",
    issue: null,
  },
  {
    id: "ord_1003",
    sellerId: "usr_seller_4",
    inventoryReservationOpen: false,
    listingId: "lst_lamp",
    listingTitle: "مصباح طاولة خشبي",
    listingImageUrl: listings[3].imageUrl,
    buyerName: "أحمد",
    sellerName: "دار",
    quantity: 1,
    unitPrice: "1.000",
    total: "1.000",
    commissionRateBps: 1_000,
    currency: "KWD",
    fulfilmentType: "PICKUP",
    status: "COMPLETED",
    createdAt: new Date(now - 1000 * 60 * 60 * 72).toISOString(),
    updatedAt: new Date(now - 1000 * 60 * 60 * 50).toISOString(),
    expiresAt: new Date(now - 1000 * 60 * 60 * 24).toISOString(),
    deliveryProof: "رمز الاستلام 4821",
    issue: null,
  },
];

export const messages: MessageRecord[] = [
  {
    id: "msg_1",
    orderId: "ord_1001",
    senderName: "النظام",
    senderRole: "SYSTEM",
    body: "تم إنشاء الطلب وحجز الكمية. لا تشارك بيانات التواصل خارج BDINAR.",
    createdAt: new Date(now - 1000 * 60 * 60 * 21).toISOString(),
    isMine: false,
  },
  {
    id: "msg_2",
    orderId: "ord_1001",
    senderName: "استوديو نون",
    senderRole: "SELLER",
    body: "أهلًا أحمد، تم تجهيز المقاسات. هل تفضل التوصيل مساء اليوم؟",
    createdAt: new Date(now - 1000 * 60 * 60 * 2).toISOString(),
    isMine: false,
  },
  {
    id: "msg_3",
    orderId: "ord_1001",
    senderName: "أحمد",
    senderRole: "BUYER",
    body: "نعم، مناسب. المقاسات: قطعتان M وقطعة L.",
    createdAt: new Date(now - 1000 * 60 * 50).toISOString(),
    isMine: true,
  },
];

export const sellerDues: SellerDueRecord[] = [
  {
    id: "due_1",
    orderId: "ord_1003",
    listingTitle: "مصباح طاولة خشبي",
    amount: "0.100",
    currency: "KWD",
    reason: "عمولة المنصة بعد إتمام الطلب",
    dueAt: new Date(now + 1000 * 60 * 60 * 48).toISOString(),
    status: "PENDING",
  },
];

export const currentUser = {
  name: "أحمد",
  id: "usr_buyer_demo",
};

export function findOrder(id: string) {
  return orders.find((order) => order.id === id);
}

export function findListing(id: string) {
  return listings.find((listing) => listing.id === id);
}