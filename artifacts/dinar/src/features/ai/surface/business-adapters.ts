import type { ComposedSurfaceInput, SurfaceAction } from "@workspace/api-zod/surface-composition";
import { orderStatus } from "@/lib/marketplace";
import type {
  BusinessDraft,
  BusinessListing,
  BusinessPayload,
} from "../business-types";

/**
 * Deterministic D3-A adapters: the server's typed business payload in, a composition of the
 * shared primitives out. Every figure, name and status is copied from the payload; the buttons
 * are utterances the conversation runtime resolves again (capability, ownership, expiry and
 * stale-review checks stay server-side). Nothing here can grant a permission or publish.
 */

const clip = (value: unknown, max: number) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "0";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسودة",
  ACTIVE: "نشط",
  SUSPENDED: "موقوف من الإدارة",
  CLOSED: "مغلق",
  PAUSED: "موقوف",
  PUBLISHED: "منشور",
  ARCHIVED: "مؤرشف",
  SOLD_OUT: "نفد",
};
const statusLabel = (status: string | undefined) =>
  status ? (STATUS_LABEL[status] ?? status) : "—";

const IDENTITY_LABEL: Record<string, string> = {
  VERIFIED: "هوية تجارية معتمدة",
  PENDING_D2: "هوية النشاط قيد الاعتماد",
  UNVERIFIED: "هوية غير معتمدة",
  REJECTED: "اعتماد الهوية مرفوض",
};

const listingLine = (listing: BusinessListing) =>
  [statusLabel(listing.status), listing.price ?? "السعر غير محدد"]
    .filter(Boolean)
    .join(" · ");

function allowed(payload: BusinessPayload, action: string): boolean {
  return Boolean(payload.allowedActions?.includes(action));
}

function followUps(payload: BusinessPayload): SurfaceAction[] {
  const actions: SurfaceAction[] = [];
  if (allowed(payload, "CATALOG"))
    actions.push({ kind: "SEND", label: "منتجاتي", message: "منتجاتي", emphasis: "SECONDARY", icon: "TAG", actionId: "CATALOG", testId: "business-action-catalog" });
  if (allowed(payload, "ORDERS"))
    actions.push({ kind: "SEND", label: "طلبات النشاط", message: "طلبات النشاط", emphasis: "SECONDARY", icon: "RECEIPT", actionId: "ORDERS", testId: "business-action-orders" });
  if (allowed(payload, "INSIGHTS"))
    actions.push({ kind: "SEND", label: "تحليل النشاط", message: "تحليل النشاط", emphasis: "SECONDARY", icon: "CHART", actionId: "INSIGHTS", testId: "business-action-insights" });
  return actions;
}

function identityRows(payload: BusinessPayload) {
  return [
    ...(payload.businessTypeLabel ? [{ label: "النوع", value: clip(payload.businessTypeLabel, 80) }] : []),
    { label: "الحالة", value: statusLabel(payload.status) },
    ...(payload.identityStatus
      ? [{ label: "الهوية التجارية", value: clip(IDENTITY_LABEL[payload.identityStatus] ?? payload.identityStatus, 120) }]
      : []),
    { label: "التشغيل", value: payload.operatingMode === "INTERNAL_DINAR" ? "داخل دينار فقط" : clip(payload.operatingMode ?? "—", 80) },
  ];
}

const notices = (payload: BusinessPayload) =>
  [
    ...(payload.blockedReason ? [{ tone: "WARNING" as const, text: clip(payload.blockedReason, 700), testId: "business-blocked-reason" }] : []),
    ...(payload.registrationNotice ? [{ tone: "INFO" as const, text: clip(payload.registrationNotice, 700), testId: "business-registration-notice" }] : []),
    ...(payload.notice ? [{ tone: "INFO" as const, text: clip(payload.notice, 700), testId: "business-notice" }] : []),
  ];

const truncate = <T,>(items: T[] | undefined, max: number) => (items ?? []).slice(0, max);

function setupSurface(payload: BusinessPayload): ComposedSurfaceInput {
  return {
    version: 1,
    label: "إعداد نشاطك على دينار",
    size: "MEDIUM",
    state: "READY",
    tone: "INFO",
    testId: "business-setup",
    sections: [
      {
        type: "header",
        title: clip(payload.name || "نشاطك على دينار", 120),
        subtitle: "التسجيل داخل DINAR دون موقع أو متجر خارجي.",
        icon: "TAG",
      },
      { type: "facts", rows: identityRows(payload) },
      { type: "text", text: clip(payload.prompt || "أكمل بيانات النشاط من المحادثة.", 700), testId: "business-setup-prompt" },
      ...notices(payload).map((notice) => ({ type: "notice" as const, ...notice })),
    ],
  };
}

function profileReviewSurface(payload: BusinessPayload): ComposedSurfaceInput {
  const lines = truncate(payload.reviewLines, 10).map((line) => clip(line, 240));
  const canActivate = allowed(payload, "ACTIVATE");
  const canCancel = allowed(payload, "CANCEL");
  const actions: SurfaceAction[] = [
    ...(canActivate
      ? [{ kind: "SEND" as const, label: "تشغيل النشاط", message: "أكد", emphasis: "PRIMARY" as const, icon: "CHECK" as const, actionId: "ACTIVATE", testId: "business-activate" }]
      : []),
    ...(canCancel
      ? [{ kind: "SEND" as const, label: "إلغاء", message: "إلغاء", emphasis: "SECONDARY" as const, icon: "CLOSE" as const, actionId: "CANCEL", testId: "business-cancel" }]
      : []),
  ];
  return {
    version: 1,
    label: "مراجعة نشاطك",
    size: "MEDIUM",
    state: canActivate ? "PENDING_REVIEW" : "READY",
    tone: "INFO",
    testId: "business-profile-review",
    sections: [
      { type: "header", title: clip(payload.name || "نشاطك", 120), subtitle: "مراجعة قبل التشغيل", icon: "CHECK", badge: { label: statusLabel(payload.status), tone: "NEUTRAL" } },
      ...(lines.length ? [{ type: "facts" as const, rows: lines.map((line) => ({ label: "التفاصيل", value: line, testId: "business-review-line" })) }] : []),
      { type: "notice", tone: "PENDING", text: "لن يُشغَّل النشاط ولن يُنشر أي منتج قبل تأكيدك. اعتماد الهوية التجارية مستقل عن التشغيل." },
      ...notices(payload).map((notice) => ({ type: "notice" as const, ...notice })),
      ...(actions.length ? [{ type: "actions" as const, items: actions }] : []),
    ],
  };
}

function profileSurface(payload: BusinessPayload): ComposedSurfaceInput {
  if (payload.selection || payload.businesses?.length)
    return {
      version: 1,
      label: "اختيار النشاط",
      size: "MEDIUM",
      state: "READY",
      tone: "INFO",
      testId: "business-selection",
      sections: [
        { type: "header", title: "أنشطتك على دينار", subtitle: "اختر النشاط الذي تريد إدارته. لا يُعرض نشاط حساب آخر.", icon: "TAG" },
        {
          type: "options",
          label: "الأنشطة",
          items: truncate(payload.businesses, 6).map((item) => ({
            key: `business-${clip(item.businessId, 40).replace(/[^A-Za-z0-9_-]/gu, "_")}`,
            title: clip(item.name || "نشاط", 120),
            subtitle: statusLabel(item.status),
            subtitleMuted: true,
            facts: [
              ...(item.businessTypeLabel ? [{ label: "النوع", value: clip(item.businessTypeLabel, 80) }] : []),
              ...(item.identityStatus ? [{ label: "الهوية", value: clip(IDENTITY_LABEL[item.identityStatus] ?? item.identityStatus, 120) }] : []),
            ].slice(0, 8),
            actions: [{ kind: "SEND", label: "إدارة", message: `افتح نشاط ${clip(item.name, 100)}`, emphasis: "SECONDARY" }],
            testId: "business-selection-row",
          })),
        },
        ...(payload.notice ? [{ type: "notice" as const, tone: "INFO" as const, text: clip(payload.notice, 700) }] : []),
      ],
    };
  const summary = payload.summary;
  const actions = followUps(payload);
  return {
    version: 1,
    label: "نشاطك",
    size: "MEDIUM",
    state: "READY",
    tone: "NEUTRAL",
    testId: "business-profile",
    sections: [
      {
        type: "header",
        title: clip(payload.name || "نشاطك", 120),
        subtitle: "تعمل داخل DINAR",
        icon: "TAG",
        badge: { label: statusLabel(payload.status), tone: payload.status === "ACTIVE" ? "SUCCESS" : "NEUTRAL" },
      },
      ...(payload.description ? [{ type: "text" as const, text: clip(payload.description, 700) }] : []),
      { type: "facts", rows: identityRows(payload) },
      ...(summary
        ? [{
            type: "metrics" as const,
            label: "الكتالوج",
            items: [
              { key: "business-total", label: "المنتجات", value: number(summary.total) },
              { key: "business-published", label: "منشور", value: number(summary.published) },
              { key: "business-paused", label: "موقوف", value: number(summary.paused) },
            ],
          }]
        : []),
      ...notices(payload).map((notice) => ({ type: "notice" as const, ...notice })),
      ...(payload.publicPath && payload.status === "ACTIVE"
        ? [{ type: "actions" as const, items: [{ kind: "NAVIGATE" as const, label: "معاينة الصفحة العامة", path: `/business/${clip(payload.businessId, 64)}`, emphasis: "QUIET" as const, testId: "business-public-link" }] }]
        : []),
      ...(actions.length ? [{ type: "actions" as const, items: actions }] : []),
    ],
  };
}

function listingOptionActions(payload: BusinessPayload, listing: BusinessListing): SurfaceAction[] {
  const actions: SurfaceAction[] = [];
  if (allowed(payload, "PAUSE") && listing.status === "PUBLISHED")
    actions.push({ kind: "SEND", label: "إيقاف", message: `أوقف المنتج ${clip(listing.title, 100)}`, emphasis: "SECONDARY", actionId: "PAUSE" });
  if (allowed(payload, "RESUME") && listing.status === "PAUSED")
    actions.push({ kind: "SEND", label: "تفعيل", message: `فعل المنتج ${clip(listing.title, 100)}`, emphasis: "SECONDARY", actionId: "RESUME" });
  return actions;
}

function catalogSurface(payload: BusinessPayload): ComposedSurfaceInput {
  const listings = truncate(payload.listings, 6);
  const summary = payload.summary;
  const actions = followUps(payload);
  return {
    version: 1,
    label: "منتجات النشاط",
    size: "WIDE",
    state: payload.empty || !listings.length ? "EMPTY" : "READY",
    tone: "NEUTRAL",
    testId: "business-catalog",
    sections: [
      {
        type: "header",
        title: "منتجات النشاط",
        subtitle: payload.selection ? "اختر المنتج من القائمة" : clip(payload.name ?? "", 240) || undefined,
        icon: "TAG",
        badge: summary ? { label: `${number(summary.total)} منتج`, tone: "NEUTRAL" } : undefined,
      },
      ...(summary
        ? [{
            type: "metrics" as const,
            label: "الحالة",
            items: [
              { key: "business-published", label: "منشور", value: number(summary.published) },
              { key: "business-paused", label: "موقوف", value: number(summary.paused) },
              { key: "business-out", label: "نفد المخزون", value: number(summary.outOfStock ?? 0) },
            ],
          }]
        : []),
      ...(listings.length
        ? [{
            type: "options" as const,
            label: "المنتجات",
            items: listings.map((listing) => ({
              key: `listing-${clip(listing.listingId, 40).replace(/[^A-Za-z0-9_-]/gu, "_")}`,
              title: clip(listing.title || "منتج", 120),
              subtitle: listingLine(listing),
              subtitleMuted: listing.status !== "PUBLISHED",
              badge: {
                label: statusLabel(listing.status),
                tone: listing.status === "PUBLISHED" ? ("SUCCESS" as const) : ("NEUTRAL" as const),
              },
              actions: listingOptionActions(payload, listing),
              status: /^[A-Z][A-Z_]{0,39}$/u.test(listing.status) ? listing.status : undefined,
              testId: "business-catalog-listing",
            })),
          }]
        : []),
      ...notices(payload).map((notice) => ({ type: "notice" as const, ...notice })),
      ...(actions.length ? [{ type: "actions" as const, items: actions }] : []),
    ],
  };
}

function draftSurface(payload: BusinessPayload): ComposedSurfaceInput {
  const drafts = truncate(payload.drafts, 6);
  const canPublish = allowed(payload, "PUBLISH");
  return {
    version: 1,
    label: "مسودات المنتجات",
    size: "WIDE",
    state: drafts.length ? "READY" : "EMPTY",
    tone: !payload.publishable ? "WARNING" : "NEUTRAL",
    testId: "business-catalog-draft",
    sections: [
      {
        type: "header",
        title: "مسودات جاهزة للمراجعة",
        subtitle: clip(payload.businessName ?? payload.name ?? "", 240) || undefined,
        icon: "EDIT",
        badge: { label: `${number(drafts.length)} مسودة`, tone: "INFO" },
      },
      ...(drafts.length
        ? [{
            type: "options" as const,
            label: "المسودات",
            items: drafts.map((draft: BusinessDraft, index) => ({
              key: `draft-${clip(draft.draftId, 40).replace(/[^A-Za-z0-9_-]/gu, "_")}`,
              title: clip(draft.title || "منتج", 120),
              subtitle: [draft.price, draft.category ?? "بدون تصنيف"].filter(Boolean).join(" · "),
              facts: [
                ...(draft.area ? [{ label: "المنطقة", value: clip(draft.area, 120) }] : []),
                ...(draft.category ? [{ label: "التصنيف", value: clip(draft.category, 120) }] : []),
              ].slice(0, 8),
              actions: canPublish
                ? [{ kind: "SEND" as const, label: "نشر", message: `انشر المسودة ${index + 1}`, emphasis: "SECONDARY" as const, actionId: "PUBLISH", testId: "business-draft-publish" }]
                : [],
              testId: "business-draft",
            })),
          }]
        : []),
      { type: "notice", tone: "PENDING", text: "لن يُنشر أي شيء قبل مراجعتك وتأكيدك. النشر يمر بفحص النشاط والتصنيف والهوية كما في مسار النشر العادي." },
      ...notices(payload).map((notice) => ({ type: "notice" as const, ...notice })),
    ],
  };
}

function listingReviewSurface(payload: BusinessPayload): ComposedSurfaceInput {
  const lines = truncate(payload.lines, 10).map((line) => clip(line, 240));
  const pending = Boolean(payload.pendingActionId);
  const state = pending ? "PENDING_REVIEW" : payload.stale ? "EXPIRED" : payload.notice ? "FAILED" : "READY";
  const actions: SurfaceAction[] = pending && allowed(payload, "CONFIRM")
    ? [
        { kind: "SEND", label: "أكد", message: "أكد", emphasis: "PRIMARY", icon: "CHECK", actionId: "CONFIRM", testId: "business-confirm" },
        ...(allowed(payload, "CANCEL")
          ? [{ kind: "SEND" as const, label: "إلغاء", message: "إلغاء", emphasis: "SECONDARY" as const, icon: "CLOSE" as const, actionId: "CANCEL", testId: "business-cancel" }]
          : []),
      ]
    : [];
  return {
    version: 1,
    label: "مراجعة التغيير",
    size: "MEDIUM",
    state,
    tone: state === "PENDING_REVIEW" ? "INFO" : state === "READY" ? "NEUTRAL" : "WARNING",
    testId: "business-listing-review",
    sections: [
      {
        type: "header",
        title: clip(payload.title || payload.businessName || "تغيير على منتج", 120),
        subtitle: payload.businessName ? clip(payload.businessName, 240) : undefined,
        icon: "EDIT",
        badge: pending ? { label: "بانتظار تأكيدك", tone: "GOLD" } : undefined,
      },
      ...(lines.length ? [{ type: "facts" as const, rows: lines.map((line) => ({ label: "التفاصيل", value: line, testId: "business-review-line" })) }] : []),
      ...notices(payload).map((notice) => ({ type: "notice" as const, ...notice })),
      ...(pending
        ? [{ type: "notice" as const, tone: "PENDING" as const, text: "لن يُنفَّذ شيء قبل تأكيدك، والتأكيد يتحقق من الحالة الحالية للمنتج قبل الكتابة." }]
        : []),
      ...(actions.length ? [{ type: "actions" as const, items: actions }] : []),
    ],
  };
}

function ordersSurface(payload: BusinessPayload): ComposedSurfaceInput {
  const orders = truncate(payload.orders, 20);
  return {
    version: 1,
    label: "طلبات النشاط",
    size: "MEDIUM",
    state: orders.length ? "READY" : "EMPTY",
    tone: "NEUTRAL",
    testId: "business-orders",
    sections: [
      { type: "header", title: "طلبات النشاط", subtitle: clip(payload.name ?? "", 240) || undefined, icon: "RECEIPT", badge: { label: `${number(orders.length)} طلب`, tone: "NEUTRAL" } },
      ...(orders.length
        ? [{
            type: "facts" as const,
            rows: orders.map((order) => ({
              label: `#${clip(order.orderId, 8)} · ${number(order.itemCount)} منتج`,
              value: `${statusLabel(orderStatus(order.status, "seller").label)} · ${clip(order.total ?? "", 120)}`,
              testId: "business-order-row",
            })),
          }]
        : []),
      { type: "text", muted: true, text: "تُعرض الطلبات التي تحتوي منتجات هذا النشاط فقط، ولا تتغير حالتها من هذه البطاقة." },
    ],
  };
}

function insightsSurface(payload: BusinessPayload): ComposedSurfaceInput {
  const insights = payload.insights;
  const hasData = Boolean(insights && insights.listings > 0);
  return {
    version: 1,
    label: "تحليل النشاط",
    size: "MEDIUM",
    state: hasData ? "READY" : "EMPTY",
    tone: "NEUTRAL",
    testId: "business-insights",
    sections: [
      { type: "header", title: "تحليل النشاط", subtitle: clip(payload.name ?? "", 240) || undefined, icon: "CHART" },
      ...(insights
        ? [{
            type: "metrics" as const,
            label: "الأرقام",
            items: [
              { key: "insight-listings", label: "المنتجات", value: number(insights.listings) },
              { key: "insight-published", label: "منشور", value: number(insights.published) },
              { key: "insight-paused", label: "موقوف", value: number(insights.paused) },
              { key: "insight-orders", label: "طلبات مكتملة", value: number(insights.completedOrders) },
              { key: "insight-revenue", label: "إيراد مكتمل", value: clip(insights.completedRevenue ?? "", 120), ltr: true },
            ].slice(0, 8),
          }]
        : []),
      { type: "text", muted: true, text: "أرقام من سجلات DINAR لهذا النشاط فقط؛ لا تُعرض بيانات نشاط آخر." },
    ],
  };
}

/** One composition per business view; an unknown view renders nothing. */
export function businessSurface(payload: BusinessPayload): ComposedSurfaceInput | undefined {
  switch (payload.view) {
    case "SETUP":
      return setupSurface(payload);
    case "PROFILE_REVIEW":
      return profileReviewSurface(payload);
    case "PROFILE":
      return profileSurface(payload);
    case "CATALOG":
      return catalogSurface(payload);
    case "CATALOG_DRAFT":
      return draftSurface(payload);
    case "LISTING_REVIEW":
      return listingReviewSurface(payload);
    case "ORDERS":
      return ordersSurface(payload);
    case "INSIGHTS":
      return insightsSurface(payload);
    default:
      return undefined;
  }
}
