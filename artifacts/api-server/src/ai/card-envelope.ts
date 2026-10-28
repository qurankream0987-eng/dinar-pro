import {
  CardEnvelopeSchema,
  actionLifecycleState,
  type CardEnvelope,
  type CardEnvelopeInput,
  type SurfaceState,
} from "@workspace/api-zod/surface-composition";
import {
  conversationSemanticSurfacesForToken,
  type ConversationSurfaceToken,
} from "@workspace/api-zod/conversation-runtime";

/**
 * Builds the card envelope from server state only. Every value here is either a record the
 * server just wrote (result set, action ledger, negotiation, payload status) or a derivation of
 * those records; nothing is read from the model output beyond the typed payload the tools built.
 */

const statusToken = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Z][A-Z_]{0,39}$/.test(value) ? value : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const instant = (value: unknown): Date | undefined => {
  const candidate = text(value);
  if (!candidate) return undefined;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const LABELS: Record<string, string> = {
  PRODUCT_RESULT_CARD: "نتائج العروض",
  LISTING_DETAIL_CARD: "تفاصيل العرض",
  SERVICE_RESULT_CARD: "نتائج الخدمات",
  SEARCH_RESULTS_RAIL: "نتائج البحث",
  CHECKOUT_CONFIRMATION: "مراجعة الشراء",
  CONFIRMATION_CARD: "مراجعة التأكيد",
  CART_SURFACE: "السلة",
  ORDER_STATUS_CARD: "حالة الطلب",
  TRACKING_CARD: "تتبع الطلب",
  COMPARISON_SURFACE: "مقارنة العروض",
  NEGOTIATION_SURFACE: "عرض السعر",
  INQUIRY_SURFACE: "استفسار عن عرض",
  DELIVERY_CARD: "التوصيل",
  PROMOTION_CARD: "الترويج",
  EMPLOYMENT_SURFACE: "الوظائف",
  DRIVER_SURFACE: "العمل والتوصيل",
  PROVIDER_SURFACE: "اتصال المزود",
  ASSISTANT_ADVICE_CARD: "نصيحة المساعد",
  PERSONAL_INTELLIGENCE: "معلوماتك الشخصية",
  MARKET_SELECTOR_CARD: "اختيار السوق",
  MARKET_PULSE_CARD: "حركة السوق",
  DINAR_BUSINESS_CARD: "أعمال دينار",
  AI_USAGE_CARD: "استخدام الذكاء",
  AI_PLANS_CARD: "خطط الذكاء",
  LISTING_DRAFT_CARD: "مسودة الإعلان",
  PUBLISHED_LISTING_CARD: "إعلان منشور",
  MY_LISTINGS_RAIL: "إعلاناتي",
  AUTH_CARD: "تسجيل الدخول",
  WORKFLOW_SURFACE: "متابعة",
  EMPTY_RESULT_CARD: "لا توجد نتائج",
  ERROR_CARD: "تنبيه",
  TUTORIAL_VIDEO_CARD: "شرح مصور",
  PRODUCT_CONTROL_SURFACE: "التحكم بالمنتج",
  VISION_SELLER_SURFACE: "مساعدة صور البائع",
};

function purchaseCapabilities(review: Record<string, unknown>): string[] {
  if (review.status !== "PENDING") return [];
  switch (review.stage) {
    case "PAYMENT":
      return ["CONFIRM", "PAYMENT_METHOD", "CANCEL"];
    case "ORDER":
      return ["CONFIRM", "FULFILMENT", "CANCEL"];
    default:
      return ["CONFIRM", "CONTINUE", "CANCEL"];
  }
}

function negotiationCapabilities(negotiation: Record<string, unknown>): string[] {
  const view = text(negotiation.view);
  const status = text(negotiation.status);
  if (view === "REVIEW") {
    if (status !== "PENDING") return [];
    switch (negotiation.action) {
      case "SEND_NEGOTIATION_OFFER":
        return ["SEND", "EDIT", "CANCEL"];
      case "REQUEST_BEST_PRICE":
        return ["SEND", "CANCEL"];
      default:
        return ["CONFIRM", "REJECT", "CANCEL"];
    }
  }
  if (view === "LIST") {
    const items = Array.isArray(negotiation.items) ? negotiation.items : [];
    return items.some((item) => record(item)?.role === "SELLER" && record(item)?.status === "OPEN")
      ? ["ACCEPT", "REJECT"]
      : [];
  }
  if (view === "HYPOTHETICAL") return negotiation.canOffer === true ? ["OFFER"] : [];
  if (view === "STATUS") {
    const decisions = Array.isArray(negotiation.decisions) ? negotiation.decisions : [];
    const capabilities = decisions
      .filter((decision): decision is string => typeof decision === "string" && /^[A-Z][A-Z_]{0,39}$/.test(decision))
      .slice(0, 8);
    if (negotiation.role === "BUYER" && status === "ACCEPTED" && negotiation.ordered !== true)
      capabilities.push("ORDER");
    return capabilities;
  }
  return [];
}

export type CardEnvelopeSource = {
  conversationId: string;
  marketId: string;
  currency?: string;
  /** SURFACE token, or absent for a listing result rail. */
  token?: string;
  presentation?: string;
  resultSetId: string;
  payload: Record<string, unknown>;
  sourceTimestamp: Date;
  expiresAt?: Date | null;
};

function semanticType(source: CardEnvelopeSource): string {
  if (source.token) {
    const [semantic] = conversationSemanticSurfacesForToken(source.token as ConversationSurfaceToken);
    if (semantic) return semantic;
    return source.token;
  }
  return source.presentation === "DETAILS" ? "LISTING_DETAIL_CARD" : "PRODUCT_RESULT_CARD";
}

function lifecycleOf(payload: Record<string, unknown>): { lifecycle: SurfaceState; resource?: string } {
  const purchase = record(payload.purchaseReview);
  if (purchase) {
    const status = text(purchase.status);
    return { lifecycle: actionLifecycleState(status ?? ""), resource: statusToken(status) };
  }
  const negotiation = record(payload.negotiation);
  if (negotiation) {
    const status = text(negotiation.status);
    const view = text(negotiation.view);
    if (view === "REVIEW") return { lifecycle: actionLifecycleState(status ?? ""), resource: statusToken(status) };
    if (status === "EXPIRED") return { lifecycle: "EXPIRED", resource: statusToken(status) };
    if (view === "UNAVAILABLE") return { lifecycle: "UNAVAILABLE", resource: statusToken(status) };
    return { lifecycle: "READY", resource: statusToken(status) };
  }
  const preview = record(payload.managementPreview);
  if (preview) {
    const status = text(preview.status);
    return { lifecycle: actionLifecycleState(status ?? ""), resource: statusToken(status) };
  }
  return { lifecycle: "READY" };
}

function resourceOf(source: CardEnvelopeSource): { kind: CardEnvelopeInput["resource"]["kind"]; id?: string } {
  const payload = source.payload;
  const negotiation = record(payload.negotiation);
  const purchase = record(payload.purchaseReview);
  const inquiry = record(payload.inquiry);
  const resourceId = text(payload.resourceId);
  if (payload.control) return { kind: "CONTROL" };
  if (payload.delivery) return { kind: "DELIVERY" };
  if (payload.employment) return { kind: "EMPLOYMENT" };
  if (payload.promotion) return { kind: "PROMOTION" };
  if (payload.driver) return { kind: "DRIVER" };
  if (payload.provider) return { kind: "PROVIDER" };
  if (negotiation) {
    const negotiationId = text(negotiation.negotiationId);
    if (negotiationId) return { kind: "NEGOTIATION", id: negotiationId };
    const listingId = text(negotiation.listingId) ?? resourceId;
    return listingId ? { kind: "LISTING", id: listingId } : { kind: "NONE" };
  }
  if (purchase) {
    const orderId = text(purchase.orderId);
    if (orderId) return { kind: "ORDER", id: orderId };
    const listingId = text(purchase.listingId) ?? resourceId;
    return listingId ? { kind: "LISTING", id: listingId } : { kind: "NONE" };
  }
  if (inquiry) {
    const listingId = text(inquiry.listingId) ?? resourceId;
    return listingId ? { kind: "LISTING", id: listingId } : { kind: "NONE" };
  }
  if (source.token === "CART") return { kind: "CART" };
  if (source.token === "MARKET_SELECTOR" || source.token === "MARKET") return { kind: "MARKET" };
  if (source.token?.includes("ORDER")) return resourceId ? { kind: "ORDER", id: resourceId } : { kind: "ORDER" };
  if (resourceId) return { kind: "LISTING", id: resourceId };
  const resourceIds = Array.isArray(payload.resourceIds) ? payload.resourceIds.filter((id): id is string => typeof id === "string") : [];
  if (source.presentation === "DETAILS" && resourceIds.length === 1) return { kind: "LISTING", id: resourceIds[0] };
  if (resourceIds.length === 1) return { kind: "LISTING", id: resourceIds[0] };
  if (source.presentation) return { kind: "LISTING" };
  return { kind: "NONE" };
}

/** Builds the envelope and validates it before it can reach a block; an invalid one is omitted. */
export function buildCardEnvelope(source: CardEnvelopeSource): CardEnvelope | null {
  const payload = source.payload;
  const purchase = record(payload.purchaseReview);
  const negotiation = record(payload.negotiation);
  const preview = record(payload.managementPreview);
  const surfaceType = semanticType(source);
  const status = lifecycleOf(payload);

  const reviewExpiry = instant(purchase?.expiresAt) ?? instant(negotiation?.expiresAt);
  const expiresAt = reviewExpiry ?? (source.expiresAt ?? undefined);
  const lifecycle: SurfaceState =
    status.lifecycle === "PENDING_REVIEW" && expiresAt && expiresAt.getTime() <= source.sourceTimestamp.getTime()
      ? "EXPIRED"
      : status.lifecycle;

  const pendingReviewId = (() => {
    if (lifecycle !== "PENDING_REVIEW") return undefined;
    if (purchase) return text(purchase.actionId);
    if (negotiation && text(negotiation.view) === "REVIEW") return text(negotiation.actionId);
    if (preview && text(preview.status) === "PENDING") return text(preview.previewId);
    return undefined;
  })();

  let allowedActions: string[] | undefined;
  if (purchase) allowedActions = lifecycle === "PENDING_REVIEW" && status.lifecycle === "PENDING_REVIEW" ? purchaseCapabilities(purchase) : [];
  else if (negotiation) allowedActions = lifecycle === "PENDING_REVIEW" && status.lifecycle === "PENDING_REVIEW" ? negotiationCapabilities(negotiation) : text(negotiation.view) === "REVIEW" ? [] : negotiationCapabilities(negotiation);
  else if (preview) allowedActions = lifecycle === "PENDING_REVIEW" ? ["CONFIRM", "CANCEL"] : [];
  else allowedActions = undefined;

  const resource = resourceOf(source);
  const role =
    negotiation?.role === "BUYER" || negotiation?.role === "SELLER"
      ? negotiation.role
      : purchase
        ? "BUYER"
        : undefined;

  const pending = lifecycle === "PENDING_REVIEW" && pendingReviewId !== undefined;
  const refresh =
    pending
      ? "SSE"
      : source.presentation || resource.id || purchase || negotiation || payload.control || preview
        ? "REFETCH"
        : "RESTORE";

  const envelope = {
    schemaVersion: 1 as const,
    surfaceType,
    surfaceId: `${source.resultSetId}:${surfaceType}`,
    resource,
    conversationId: source.conversationId,
    context: {
      ...(role ? { role } : {}),
      marketId: source.marketId,
      ...(source.currency ? { currency: source.currency } : {}),
    },
    status: { lifecycle, ...(status.resource ? { resource: status.resource } : {}) },
    ...(allowedActions ? { allowedActions } : {}),
    ...(pendingReviewId ? { pendingReviewId } : {}),
    ...(pending && expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    refresh: { strategy: refresh },
    sourceTimestamp: source.sourceTimestamp.toISOString(),
    accessibility: {
      label: LABELS[surfaceType] ?? "بطاقة المحادثة",
      ...(pending ? { description: "بانتظار قرارك." } : {}),
    },
  };
  const parsed = CardEnvelopeSchema.safeParse(envelope);
  return parsed.success ? parsed.data : null;
}
