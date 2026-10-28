import { actionLifecycleState } from "@workspace/api-zod/surface-composition";
import type { ComposedSurfaceInput, SurfaceAction, SurfaceSection } from "@workspace/api-zod/surface-composition";

/**
 * Negotiation and purchase/payment reviews as compositions. Every amount, status and choice
 * is copied from the server's typed payload; nothing is added up or inferred. Buttons send
 * the same words a user could type, so the server's negotiation and order authorities decide
 * what happens (ownership, confirmation, expiry, idempotency).
 */

// ─── Negotiation ──────────────────────────────────────────────────────────────

export type NegotiationView = {
  negotiationId?: string;
  title?: string;
  role?: "BUYER" | "SELLER";
  status?: string;
  statusLabel?: string;
  currency?: string;
  listedPrice?: string | null;
  offerAmount?: string | null;
  counterAmount?: string | null;
  agreedAmount?: string | null;
  quantity?: number;
  yourTurn?: boolean;
  ordered?: boolean;
  /** Server-computed decisions this party may take now (only the awaited party accepts/rejects/counters). */
  decisions?: ("ACCEPT" | "REJECT" | "COUNTER" | "WITHDRAW")[];
  /** A buyer's amount-less request (quotation or best price), never a binding offer. */
  priceRequest?: boolean;
};

/**
 * Decision buttons for a status card. Labels follow the owner's wording; each sends words the
 * negotiation runtime resolves again against this party's own negotiation in view, so a button
 * can never decide for the other party.
 */
function negotiationDecisionActions(item: NegotiationView): SurfaceAction[] {
  const decisions = item.decisions ?? [];
  const actions: SurfaceAction[] = [];
  if (decisions.includes("ACCEPT"))
    actions.push({ kind: "SEND", actionId: "ACCEPT", label: "قبول العرض", message: "اقبل العرض", emphasis: "PRIMARY", icon: "CHECK", testId: "negotiation-status-accept" });
  if (decisions.includes("COUNTER"))
    actions.push({ kind: "SEND", actionId: "COUNTER", label: "عرض مقابل", message: "أريد إرسال عرض مقابل", emphasis: "SECONDARY", icon: "EDIT", testId: "negotiation-status-counter" });
  if (decisions.includes("REJECT"))
    actions.push({ kind: "SEND", actionId: "REJECT", label: "رفض العرض", message: "ارفض العرض", emphasis: "DANGER", testId: "negotiation-status-reject" });
  if (decisions.includes("WITHDRAW"))
    actions.push({ kind: "SEND", actionId: "WITHDRAW", label: "سحب العرض", message: "اسحب العرض", emphasis: "QUIET", icon: "CLOSE", testId: "negotiation-status-withdraw" });
  return actions;
}
export type Negotiation = NegotiationView & {
  view?: "REVIEW" | "STATUS" | "LIST" | "UNAVAILABLE" | "HYPOTHETICAL";
  action?: string;
  lines?: string[];
  items?: NegotiationView[];
  /** HYPOTHETICAL: a calculation on the listed price; nothing was changed or sent. */
  reductionLabel?: string;
  reductionAmount?: string;
  hypotheticalPrice?: string;
  canOffer?: boolean;
  stale?: boolean;
};

const amount = (value: string, currency?: string) => `${String(Number(value))} ${currency ?? ""}`.trim();
const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
const statusToken = (status?: string) => (status && /^[A-Z][A-Z_]{0,39}$/.test(status) ? status : undefined);

/** What a status means for this party, in plain words. */
export function negotiationHeadline(item: NegotiationView): string {
  const seller = item.role === "SELLER";
  switch (item.status) {
    case "OPEN":
      return seller ? "عرض سعر وصلك من مشترٍ" : "أُرسل عرضك — بانتظار رد البائع";
    case "COUNTERED":
      return seller ? "أرسلت عرضًا مضادًا — بانتظار رد المشتري" : "البائع أرسل لك عرضًا مضادًا";
    case "ACCEPTED":
      return item.ordered ? "تم الاتفاق واستُخدم في طلب" : "تم الاتفاق على السعر";
    case "REJECTED":
      return "رُفض عرض السعر";
    case "WITHDRAWN":
      return "سُحب عرض السعر";
    case "EXPIRED":
      return "انتهت صلاحية عرض السعر";
    default:
      return item.statusLabel ?? "عرض سعر";
  }
}

/**
 * The amounts, labelled for this party. The public price and private amounts are kept apart;
 * gold marks only the amount that matters now: the offer awaiting this party's answer, or the
 * agreed price once it exists.
 */
function negotiationFacts(item: NegotiationView, pendingOffer = false) {
  const awaitingMe =
    (item.status === "OPEN" && item.role === "SELLER") || (item.status === "COUNTERED" && item.role === "BUYER");
  const rows: { label: string; value: string; ltr: true; emphasis?: "GOLD" | "STRONG" | "MUTED"; testId: string }[] = [];
  if (item.listedPrice) rows.push({ label: "السعر المعلن", value: amount(item.listedPrice, item.currency), ltr: true, emphasis: "MUTED", testId: "negotiation-public-price" });
  if (item.offerAmount)
    rows.push({
      label: pendingOffer ? "عرضك (لم يُرسل)" : item.role === "SELLER" ? "عرض المشتري" : "عرضك",
      value: amount(item.offerAmount, item.currency),
      ltr: true,
      emphasis: awaitingMe && item.status === "OPEN" && !item.counterAmount ? "GOLD" : pendingOffer ? "STRONG" : undefined,
      testId: "negotiation-offer",
    });
  if (item.counterAmount)
    rows.push({ label: "العرض المضاد", value: amount(item.counterAmount, item.currency), ltr: true, emphasis: awaitingMe && item.status === "COUNTERED" ? "GOLD" : undefined, testId: "negotiation-counter" });
  if (item.agreedAmount)
    rows.push({
      label: item.role === "SELLER" ? "السعر المتفق عليه مع المشتري" : "السعر المتفق عليه لك",
      value: amount(item.agreedAmount, item.currency),
      ltr: true,
      emphasis: "GOLD",
      testId: "negotiation-agreed",
    });
  return rows;
}

/** The recorded sequence, oldest first; nothing is dated or invented, only what the amounts show. */
function negotiationTimeline(item: NegotiationView): SurfaceSection | null {
  if (!item.offerAmount) return null;
  const seller = item.role === "SELLER";
  const closed = ["REJECTED", "WITHDRAWN", "EXPIRED"].includes(item.status ?? "");
  const steps: { label: string; state: "DONE" | "CURRENT" | "PENDING" | "CANCELLED" }[] = [
    {
      label: `${seller ? "عرض المشتري" : "عرضك"} ${amount(item.offerAmount, item.currency)}`,
      state: item.status === "OPEN" ? "CURRENT" : "DONE",
    },
  ];
  if (item.counterAmount)
    steps.push({
      label: `${seller ? "عرضك المضاد" : "عرض البائع المضاد"} ${amount(item.counterAmount, item.currency)}`,
      state: item.status === "COUNTERED" ? "CURRENT" : "DONE",
    });
  if (item.status === "ACCEPTED" && item.agreedAmount)
    steps.push({ label: `تم الاتفاق على ${amount(item.agreedAmount, item.currency)}`, state: "DONE" });
  else if (closed) steps.push({ label: negotiationHeadline(item), state: "CANCELLED" });
  else if (item.status === "OPEN" || item.status === "COUNTERED")
    steps.push({
      label: (item.status === "OPEN") === seller ? "بانتظار ردك" : seller ? "بانتظار رد المشتري" : "بانتظار رد البائع",
      state: "PENDING",
    });
  return steps.length > 1 ? { type: "timeline", label: "تسلسل العروض", steps } : null;
}

const NEGOTIATION_ACTION_TITLE: Record<string, string> = {
  SEND_NEGOTIATION_OFFER: "مراجعة عرض السعر",
  REQUEST_BEST_PRICE: "طلب معرفة أفضل سعر",
  COUNTER_NEGOTIATION: "مراجعة العرض المضاد",
  REJECT_NEGOTIATION: "رفض عرض السعر",
};
const NEGOTIATION_REVIEW_OUTCOME: Record<string, string> = {
  CONFIRMED: "تم بعد تأكيدك.",
  CANCELLED: "أُلغي دون أي تغيير.",
  EXPIRED: "انتهت صلاحية هذه المراجعة دون أي تغيير.",
  REJECTED: "لم يُنفذ؛ لم يتغير شيء.",
};
const PUBLIC_PRICE_NOTE = "السعر المعلن لا يتغير؛ أي سعر متفق عليه خاص بهذا المشتري فقط.";

function negotiationReviewActions(negotiation: Negotiation): SurfaceAction[] {
  const buyerFacingCounter = negotiation.action === "ACCEPT_NEGOTIATION" && negotiation.role === "BUYER";
  const actions: SurfaceAction[] =
    negotiation.action === "SEND_NEGOTIATION_OFFER"
      ? [
          { kind: "SEND", actionId: "SEND", label: "إرسال العرض", message: "إرسال العرض", emphasis: "PRIMARY", icon: "SEND", testId: "negotiation-send" },
          { kind: "SEND", actionId: "EDIT", label: "تعديل المبلغ", message: "تعديل", emphasis: "SECONDARY", icon: "EDIT", testId: "negotiation-edit" },
        ]
      : negotiation.action === "REQUEST_BEST_PRICE"
        ? [{ kind: "SEND", actionId: "SEND", label: "إرسال طلب السعر", message: "نعم", emphasis: "PRIMARY", icon: "SEND", testId: "negotiation-best-price-send" }]
        : [
            {
              kind: "SEND",
              actionId: "CONFIRM",
              label:
                negotiation.action === "ACCEPT_NEGOTIATION" ? "قبول السعر" : negotiation.action === "REJECT_NEGOTIATION" ? "تأكيد الرفض" : "إرسال العرض المضاد",
              message: buyerFacingCounter ? "موافق" : "نعم",
              emphasis: negotiation.action === "REJECT_NEGOTIATION" ? "DANGER" : "PRIMARY",
              icon: "CHECK",
              testId: "negotiation-confirm",
            },
          ];
  if (buyerFacingCounter) actions.push({ kind: "SEND", actionId: "REJECT", label: "رفض", message: "رفض", emphasis: "DANGER", testId: "negotiation-decline" });
  actions.push({ kind: "SEND", actionId: "CANCEL", label: "إلغاء", message: "إلغاء", emphasis: "QUIET", icon: "CLOSE", testId: "negotiation-cancel" });
  return actions;
}

/**
 * «ماذا لو كان السعر أقل بـ10%؟»: arithmetic shown as arithmetic. The result is STRONG, never
 * gold (nobody agreed to it), and the only way forward is the ordinary offer review.
 */
function hypotheticalSurface(negotiation: Negotiation): ComposedSurfaceInput {
  const currency = negotiation.currency;
  return {
    version: 1,
    label: "حساب سعر افتراضي",
    size: "COMPACT",
    testId: "negotiation-hypothetical",
    status: negotiation.stale ? "STALE" : "CALCULATION",
    sections: [
      { type: "header", title: negotiation.title || "حساب سعر", subtitle: "حساب افتراضي", icon: "GAUGE", badge: { label: "ليس عرضًا", tone: "NEUTRAL" } },
      {
        type: "money",
        lines: [
          ...(negotiation.listedPrice ? [{ label: "السعر المعلن", value: amount(negotiation.listedPrice, currency), testId: "hypothetical-listed" }] : []),
          ...(negotiation.reductionAmount
            ? [{ label: `أقل بـ${negotiation.reductionLabel ?? ""}`.trim(), value: `− ${amount(negotiation.reductionAmount, currency)}`, emphasis: "MUTED" as const }]
            : []),
          ...(negotiation.hypotheticalPrice
            ? [{ label: "السعر بعد التخفيض", value: amount(negotiation.hypotheticalPrice, currency), emphasis: "STRONG" as const, testId: "hypothetical-price" }]
            : []),
        ],
        disclosure: "حساب فقط: لم يتغير سعر الإعلان ولم يُرسل أي عرض.",
      },
      ...(negotiation.stale
        ? [{ type: "notice" as const, tone: "WARNING" as const, text: "تغيّر السعر المعلن منذ هذا الحساب؛ احسبه من جديد قبل أي عرض.", testId: "hypothetical-stale" }]
        : negotiation.canOffer
          ? [{
              type: "actions" as const,
              items: [{ kind: "SEND" as const, actionId: "OFFER" as const, label: "مراجعة عرض بهذا السعر", message: "أرسل عرضا بهذا السعر", emphasis: "SECONDARY" as const, icon: "HANDSHAKE" as const, testId: "hypothetical-offer" }],
            }]
          : []),
    ],
  };
}

export function negotiationSurface(negotiation: Negotiation): ComposedSurfaceInput {
  if (negotiation.view === "HYPOTHETICAL") return hypotheticalSurface(negotiation);
  if (negotiation.view === "LIST") {
    const items = negotiation.items ?? [];
    const sellerOpen = items.some((item) => item.role === "SELLER" && item.status === "OPEN");
    return {
      version: 1,
      label: "عروض الأسعار",
      size: "MEDIUM",
      testId: "negotiation-list",
      state: items.length ? "READY" : "EMPTY",
      sections: [
        { type: "header", title: "عروض الأسعار", icon: "HANDSHAKE" },
        ...(items.length
          ? [{
              type: "options" as const,
              label: "عروض الأسعار",
              layout: "LIST" as const,
              items: items.slice(0, 6).map((item, index) => ({
                key: `negotiation-${index + 1}`,
                title: `${index + 1}. ${item.title || "عرض سعر"}`,
                subtitle: negotiationHeadline(item),
                subtitleMuted: true,
                status: statusToken(item.status),
                facts: negotiationFacts(item),
                actions:
                  item.role === "SELLER" && item.status === "OPEN"
                    ? [
                        { kind: "SEND" as const, actionId: "ACCEPT" as const, label: "قبول", message: `اقبل ${ORDINALS[index] ?? `رقم ${index + 1}`}`, emphasis: "SECONDARY" as const, icon: "CHECK" as const, testId: `negotiation-accept-${index + 1}` },
                        { kind: "SEND" as const, actionId: "REJECT" as const, label: "رفض", message: `ارفض ${ORDINALS[index] ?? `رقم ${index + 1}`}`, emphasis: "DANGER" as const, testId: `negotiation-reject-${index + 1}` },
                      ]
                    : undefined,
                testId: "negotiation-item",
              })),
            }]
          : [{ type: "text" as const, text: "لا توجد عروض أسعار حاليًا.", muted: true, testId: "negotiation-empty" }]),
        ...(sellerOpen ? [{ type: "text" as const, muted: true, text: "للعرض المضاد اكتب مثلًا «عرض مضاد 8». لا يتغير السعر المعلن." }] : []),
      ],
    };
  }
  if (negotiation.view === "UNAVAILABLE")
    return {
      version: 1,
      label: "عرض السعر",
      size: "COMPACT",
      state: "UNAVAILABLE",
      testId: "negotiation-unavailable",
      sections: [{ type: "notice", tone: "INFO", text: "عرض السعر هذا لم يعد متاحًا." }],
    };

  const review = negotiation.view === "REVIEW";
  const pending = review && negotiation.status === "PENDING";
  const buyerFacingCounter = negotiation.action === "ACCEPT_NEGOTIATION" && negotiation.role === "BUYER";
  const subtitle = review
    ? (buyerFacingCounter ? "عرض مضاد من البائع" : negotiation.action === "ACCEPT_NEGOTIATION" ? "قبول عرض المشتري" : NEGOTIATION_ACTION_TITLE[negotiation.action ?? ""] ?? "مراجعة")
    : negotiationHeadline(negotiation);
  const timeline = review ? null : negotiationTimeline(negotiation);
  const facts = negotiationFacts(negotiation, pending && negotiation.action === "SEND_NEGOTIATION_OFFER");
  const outcome = review && !pending && negotiation.status ? NEGOTIATION_REVIEW_OUTCOME[negotiation.status] : undefined;
  return {
    version: 1,
    label: review ? "مراجعة عرض السعر" : "حالة عرض السعر",
    size: "MEDIUM",
    // A review follows the action ledger's lifecycle; a status card is only terminal when the
    // negotiation itself expired. An accepted price still offers its order step.
    state: review ? actionLifecycleState(negotiation.status ?? "") : negotiation.status === "EXPIRED" ? "EXPIRED" : "READY",
    testId: review ? "negotiation-review" : "negotiation-status",
    status: statusToken(negotiation.status),
    sections: [
      { type: "header", title: negotiation.title || "عرض سعر", subtitle, icon: "HANDSHAKE" },
      ...(facts.length ? [{ type: "facts" as const, rows: facts }] : []),
      ...(timeline ? [timeline] : []),
      { type: "text", muted: true, text: PUBLIC_PRICE_NOTE },
      ...(pending
        ? [{
            type: "notice" as const,
            tone: "PENDING" as const,
            testId: "pending-notice",
            text: negotiation.action === "SEND_NEGOTIATION_OFFER" || negotiation.action === "REQUEST_BEST_PRICE" ? "لم يُرسل بعد — بانتظار تأكيدك." : "لم يُنفذ بعد — بانتظار تأكيدك.",
          }]
        : []),
      ...(outcome ? [{ type: "notice" as const, tone: "NEUTRAL" as const, text: outcome }] : []),
      ...(pending ? [{ type: "actions" as const, items: negotiationReviewActions(negotiation) }] : []),
      ...(!review && negotiation.view === "STATUS" && negotiationDecisionActions(negotiation).length
        ? [{ type: "actions" as const, items: negotiationDecisionActions(negotiation) }]
        : []),
      ...(!review && negotiation.role === "BUYER" && negotiation.status === "ACCEPTED" && !negotiation.ordered
        ? [{
            type: "actions" as const,
            items: [{ kind: "SEND" as const, actionId: "ORDER" as const, label: "مراجعة الطلب بالسعر المتفق عليه", message: "اطلبه", emphasis: "PRIMARY" as const, icon: "CART" as const, testId: "negotiation-order" }],
          }]
        : []),
    ],
  };
}

// ─── Purchase, order and (simulated) payment review ──────────────────────────

export type PurchaseReview = {
  actionId: string;
  /** ITEM (add to cart), ORDER (place the order) or PAYMENT (simulated payment intent). */
  stage?: "ITEM" | "ORDER" | "PAYMENT";
  status: string;
  title: string;
  sellerName: string;
  unitPrice: string | null;
  paymentMethods?: ("CASH_DIRECT" | "CARD")[];
  selectedPaymentMethod?: "CASH_DIRECT" | "CARD" | null;
  currency: string;
  quantity: number;
  total: string | null;
  available: number | null;
  fulfilment?: string | null;
  fulfilmentOptions?: { method: string; label: string }[];
  /** G2: the server applied this buyer's private agreed price. */
  negotiated?: boolean;
  publicUnitPrice?: string | null;
};

const PURCHASE_STATUS: Record<string, string> = {
  CANCELLED: "أُلغي دون أي تغيير.",
  EXPIRED: "انتهت صلاحية هذه المراجعة دون أي تغيير.",
  REJECTED: "لم يُنفذ؛ لم يتغير شيء.",
};
const PURCHASE_CONFIRMED = {
  ITEM: "أُضيف إلى السلة بعد تأكيدك.",
  ORDER: "أُنشئ الطلب بعد تأكيدك.",
  PAYMENT: "أُنشئ طلب دفع تجريبي؛ لم تُحوَّل أموال.",
};
const PURCHASE_NOTE = {
  ITEM: "لن يُدفع أي شيء الآن؛ التأكيد يضيف العرض إلى سلتك بعد التحقق من السعر والتوفر.",
  ORDER: "لن يُدفع أي شيء الآن؛ التأكيد ينشئ الطلب ويحجز الكمية بعد التحقق من السعر والتوفر.",
  PAYMENT: "دفع تجريبي (SIMULATION_ONLY): لا تُحوَّل أموال حقيقية.",
};
const PURCHASE_CONFIRM = { ITEM: "تأكيد الإضافة إلى السلة", ORDER: "تأكيد الطلب", PAYMENT: "إنشاء دفع تجريبي" };
const FULFILMENT_LABEL: Record<string, string> = { PICKUP: "استلام شخصي", SELLER_DELIVERY: "توصيل من البائع" };
const PAYMENT_METHOD_LABEL: Record<"CASH_DIRECT" | "CARD", string> = { CASH_DIRECT: "كاش", CARD: "بطاقة / فيزا" };

export function purchaseSurface(review: PurchaseReview): ComposedSurfaceInput {
  const stage = review.stage ?? "ITEM";
  const state = actionLifecycleState(review.status);
  const pending = review.status === "PENDING";
  const awaitingExecution = state === "PENDING_REVIEW";
  const fulfilment = review.fulfilment ? (FULFILMENT_LABEL[review.fulfilment] ?? review.fulfilment) : null;
  const confirmLabel =
    stage === "PAYMENT"
      ? review.selectedPaymentMethod === "CASH_DIRECT"
        ? "تأكيد اختيار كاش"
        : review.selectedPaymentMethod === "CARD"
          ? "إنشاء دفع تجريبي"
          : "اختر طريقة الدفع"
      : PURCHASE_CONFIRM[stage];
  const money = (value: string) => `${value} ${review.currency}`;
  const facts = [
    ...(review.paymentMethods?.length
      ? [{ label: "طرق الدفع لدى البائع", value: review.paymentMethods.map((method) => PAYMENT_METHOD_LABEL[method]).join("، "), testId: "purchase-payment-methods" }]
      : []),
    ...(stage === "PAYMENT"
      ? [{ label: "طريقة الدفع المختارة", value: review.selectedPaymentMethod ? PAYMENT_METHOD_LABEL[review.selectedPaymentMethod] : "لم تُختر بعد", testId: "purchase-selected-payment-method" }]
      : []),
    ...(stage !== "ITEM" ? [{ label: "التسليم", value: fulfilment ?? "لم يُحدد بعد" }] : []),
  ];
  const actions: SurfaceAction[] = [
    {
      kind: "SEND",
      actionId: "CONFIRM",
      label: confirmLabel,
      message: "نعم",
      emphasis: "PRIMARY",
      icon: "CHECK",
      // The server refuses a payment without a method; the button says so instead of failing.
      disabled: stage === "PAYMENT" && !review.selectedPaymentMethod,
      testId: "purchase-confirm",
    },
    ...(stage === "PAYMENT"
      ? (review.paymentMethods ?? []).map((method): SurfaceAction => ({
          kind: "SEND",
          actionId: "PAYMENT_METHOD",
          label: PAYMENT_METHOD_LABEL[method],
          message: method === "CASH_DIRECT" ? "كاش" : "فيزا",
          emphasis: "SECONDARY",
          icon: method === "CASH_DIRECT" ? "CASH" : "CARD",
          pressed: review.selectedPaymentMethod === method,
          testId: `purchase-payment-${method}`,
        }))
      : []),
    ...(stage === "ITEM" ? [{ kind: "SEND" as const, actionId: "CONTINUE" as const, label: "متابعة الطلب", message: "اطلبه الآن", emphasis: "SECONDARY" as const, testId: "purchase-continue" }] : []),
    ...(stage === "ORDER" && !review.fulfilment
      ? (review.fulfilmentOptions ?? []).map((option): SurfaceAction => ({
          kind: "SEND",
          actionId: "FULFILMENT",
          label: option.label,
          message: option.label,
          emphasis: "SECONDARY",
          icon: option.method === "PICKUP" ? "PIN" : "TRUCK",
          testId: `purchase-fulfilment-${option.method}`,
        }))
      : []),
    { kind: "SEND", actionId: "CANCEL", label: "إلغاء", message: "إلغاء", emphasis: "QUIET", icon: "CLOSE", testId: "purchase-cancel" },
  ];
  return {
    version: 1,
    label: "مراجعة الشراء",
    size: "MEDIUM",
    state,
    testId: "purchase-review",
    status: statusToken(review.status),
    sections: [
      { type: "header", title: review.title, subtitle: `البائع: ${review.sellerName}`, icon: stage === "PAYMENT" ? "RECEIPT" : "CART" },
      ...(facts.length ? [{ type: "facts" as const, rows: facts }] : []),
      {
        type: "money",
        lines: [
          ...(review.negotiated
            ? [
                { label: "السعر المعلن", value: money(review.publicUnitPrice ?? "—"), emphasis: "MUTED" as const, testId: "purchase-public-price" },
                { label: "السعر المتفق عليه لك", value: money(review.unitPrice ?? "—"), emphasis: "STRONG" as const, testId: "purchase-agreed-price" },
              ]
            : [{ label: "السعر", value: review.unitPrice === null ? "بالاتفاق" : money(review.unitPrice) }]),
          { label: "الكمية", value: String(review.quantity) },
        ],
        // The server priced this total; an unknown total is shown as unknown, never as gold.
        total: { label: "الإجمالي", value: review.total === null ? "—" : money(review.total), verified: review.total !== null },
        disclosure: PURCHASE_NOTE[stage],
      },
      ...(awaitingExecution
        ? [{ type: "notice" as const, tone: "PENDING" as const, text: pending ? "لم يُنفذ بعد — بانتظار تأكيدك." : "جارٍ تنفيذ هذا الإجراء؛ لا يمكن تكراره الآن.", testId: "pending-notice" }]
        : [{ type: "notice" as const, tone: "NEUTRAL" as const, text: review.status === "CONFIRMED" ? PURCHASE_CONFIRMED[stage] : (PURCHASE_STATUS[review.status] ?? "تمت مراجعة هذا الطلب.") }]),
      ...(pending ? [{ type: "actions" as const, items: actions }] : []),
    ],
  };
}
