/**
 * DINAR composed surfaces — protocol, renderer and adapters, without a browser or a model.
 * Run: pnpm --filter @workspace/dinar run test:surfaces
 *
 * The protocol must refuse anything that is not a known primitive with bounded display values;
 * the renderer must print untrusted text as text and offer actions only on live cards; and the
 * adapters must turn canonical payloads into valid compositions without inventing values.
 * Several compositions below are combinations no adapter produces today: the renderer is
 * judged on composition, not on named cards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import {
  COMPOSED_SURFACE_MAX_BYTES,
  ComposedSurfaceSchema,
  parseComposedSurface,
  type ComposedSurfaceInput,
} from "@workspace/api-zod/surface-composition";
import { SellerSalesInsight } from "@workspace/api-zod/conversation-runtime";
import { ComposedSurfaceView } from "../src/features/ai/surface/ComposedSurface";
import { businessSurface, plansSurface, salesSurface, usageSurface } from "../src/features/ai/surface/adapters";

const render = (surface: unknown, active = true) =>
  renderToStaticMarkup(
    <Router ssrPath="/">
      <ComposedSurfaceView surface={surface} active={active} onSend={() => {}} />
    </Router>,
  );
const valid = (surface: ComposedSurfaceInput) => {
  const result = ComposedSurfaceSchema.safeParse(surface);
  assert.ok(result.success, JSON.stringify(result.success ? "" : result.error.issues));
  return surface;
};
const count = (html: string, needle: string) => html.split(needle).length - 1;

// ─── Five+ compositions no adapter emits ────────────────────────────────────────

const deliveryNoTracking: ComposedSurfaceInput = {
  version: 1, label: "حالة التوصيل", size: "MEDIUM",
  sections: [
    { type: "header", title: "حالة طلبك", badge: { label: "قيد التجهيز", tone: "INFO" } },
    { type: "timeline", label: "مراحل الطلب", steps: [
      { label: "تم تأكيد الطلب", state: "DONE", at: "21 أكتوبر" },
      { label: "البائع يجهز الطلب", state: "CURRENT" },
      { label: "التسليم", state: "PENDING" },
    ] },
    { type: "facts", rows: [{ label: "رقم الطلب", value: "ORD-7Q2-19", ltr: true }, { label: "طريقة الاستلام", value: "استلام من البائع" }] },
    { type: "notice", tone: "INFO", text: "لا يوجد مزود تتبع مباشر لهذا الطلب؛ تظهر هنا الحالة المسجلة في DINAR فقط." },
  ],
};
const paymentReview: ComposedSurfaceInput = {
  version: 1, label: "مراجعة الدفع", size: "COMPACT",
  sections: [
    { type: "header", title: "مراجعة الدفع" },
    { type: "money", lines: [{ label: "السعر المتفق عليه", value: "280.000 JOD" }, { label: "التوصيل", value: "3.000 JOD" }],
      total: { label: "الإجمالي", value: "283.000 JOD" }, disclosure: "المبلغ محسوب من الخادم؛ لا يُعد الدفع ناجحًا قبل تأكيد المزود." },
    { type: "actions", items: [
      { kind: "SEND", label: "تأكيد", message: "نعم", emphasis: "PRIMARY", testId: "pay-confirm" },
      { kind: "SEND", label: "إلغاء", message: "إلغاء", emphasis: "QUIET" },
    ] },
  ],
};
const negotiationTimeline: ComposedSurfaceInput = {
  version: 1, label: "التفاوض", size: "MEDIUM",
  sections: [
    { type: "header", title: "لابتوب", subtitle: "بانتظار ردك" },
    { type: "metrics", items: [{ key: "listed", label: "السعر المعلن", value: "300 JOD" }, { key: "counter", label: "العرض المضاد", value: "285 JOD" }] },
    { type: "timeline", label: "العروض", steps: [
      { label: "عرضك 260 JOD", state: "DONE" },
      { label: "عرض البائع المضاد 285 JOD", state: "CURRENT" },
    ] },
    { type: "actions", items: [{ kind: "SEND", label: "قبول", message: "اقبل العرض", emphasis: "PRIMARY" }, { kind: "SEND", label: "عرض جديد", message: "أريد تقديم عرض جديد" }] },
  ],
};
const optionsWithBars: ComposedSurfaceInput = {
  version: 1, label: "مقارنة", size: "WIDE",
  sections: [
    { type: "options", label: "الخيارات", layout: "GRID", items: [
      { key: "a", title: "الأول", facts: [{ label: "السعر", value: "10 JOD", ltr: true }], actions: [{ kind: "NAVIGATE", label: "التفاصيل", path: "/listings/abc" }] },
      { key: "b", title: "الثاني", highlighted: true, badge: { label: "الأرخص", tone: "SUCCESS" } },
    ] },
    { type: "bars", label: "الطلب", items: [{ label: "الأول", value: 3, display: "3 طلبات" }, { label: "الثاني", value: 0, display: "0" }] },
  ],
};
const compactAck: ComposedSurfaceInput = {
  version: 1, label: "تم", size: "COMPACT", tone: "SUCCESS",
  sections: [{ type: "notice", tone: "SUCCESS", text: "فعّلت الوضع الداكن على هذا الجهاز." }],
};
const meterAndMoney: ComposedSurfaceInput = {
  version: 1, label: "رصيد", size: "COMPACT",
  sections: [
    { type: "meter", label: "الإعلانات المميزة", used: 4, limit: 5 },
    { type: "money", lines: [], total: { label: "الرصيد", value: "12.500 KWD" } },
    { type: "text", text: "مثال على تركيب لا تنتجه أي بطاقة حالية.", muted: true },
  ],
};

test("unanticipated combinations validate and render with their primitives", () => {
  const cases: [ComposedSurfaceInput, string[]][] = [
    [deliveryNoTracking, ["ds-timeline", 'data-state="CURRENT"', "ds-facts", "ds-notice", 'dir="ltr"']],
    [paymentReview, ["ds-money", "ds-total", "283.000 JOD", "pay-confirm"]],
    [negotiationTimeline, ["ds-metrics", "ds-timeline", "ds-actions"]],
    [optionsWithBars, ["ds-options", 'data-layout="GRID"', "ds-bars", 'href="/listings/abc"', "data-highlighted"]],
    [compactAck, ['data-size="COMPACT"', 'data-tone="SUCCESS"']],
    [meterAndMoney, ['role="progressbar"', 'data-level="HIGH"', "ds-total"]],
  ];
  for (const [surface, expected] of cases) {
    valid(surface);
    const html = render(surface);
    for (const needle of expected) assert.ok(html.includes(needle), `${surface.label}: ${needle}`);
    assert.ok(!html.includes("composed-surface-invalid"), surface.label);
  }
});

// ─── Safety ───────────────────────────────────────────────────────────────────

test("untrusted text is rendered as text, never as markup", () => {
  const html = render(valid({
    version: 1, label: "x", size: "COMPACT",
    sections: [
      { type: "header", title: `<img src=x onerror="alert(1)">` },
      { type: "text", text: `<script>window.__x=1</script>` },
      { type: "facts", rows: [{ label: "<b>a</b>", value: `"><svg onload=alert(1)>` }] },
    ],
  }));
  assert.ok(!/<script|<img|<svg|<b>/i.test(html));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("the protocol refuses anything outside its finite vocabulary", () => {
  const base = { version: 1, label: "x", size: "COMPACT" };
  const rejected: [string, unknown][] = [
    ["unknown primitive", { ...base, sections: [{ type: "html", html: "<b>x</b>" }] }],
    ["executable code", { ...base, sections: [{ type: "text", text: "x", onClick: "alert(1)" }] }],
    ["style injection", { ...base, style: "position:fixed", sections: [{ type: "text", text: "x" }] }],
    ["javascript: path", { ...base, sections: [{ type: "actions", items: [{ kind: "NAVIGATE", label: "x", path: "javascript:alert(1)" }] }] }],
    ["external link", { ...base, sections: [{ type: "actions", items: [{ kind: "NAVIGATE", label: "x", path: "//evil.example/x" }] }] }],
    ["absolute URL", { ...base, sections: [{ type: "actions", items: [{ kind: "NAVIGATE", label: "x", path: "https://evil.example" }] }] }],
    ["unknown action kind", { ...base, sections: [{ type: "actions", items: [{ kind: "PAY", label: "x", amount: 10 }] }] }],
    ["two primary actions", { ...base, sections: [{ type: "actions", items: [{ kind: "SEND", label: "a", message: "a", emphasis: "PRIMARY" }, { kind: "SEND", label: "b", message: "b", emphasis: "PRIMARY" }] }] }],
    ["unknown version", { ...base, version: 2, sections: [{ type: "text", text: "x" }] }],
    ["no sections", { ...base, sections: [] }],
    ["unbounded depth", { ...base, sections: Array.from({ length: 17 }, () => ({ type: "text", text: "x" })) }],
    ["oversized", { ...base, sections: Array.from({ length: 16 }, () => ({ type: "facts", rows: Array.from({ length: 24 }, () => ({ label: "x".repeat(200), value: "y".repeat(120) })) })) }],
    ["negative meter", { ...base, sections: [{ type: "meter", label: "x", used: -1, limit: 3 }] }],
  ];
  for (const [name, surface] of rejected) assert.equal(parseComposedSurface(surface), null, name);
  assert.ok(COMPOSED_SURFACE_MAX_BYTES <= 16_384);
});

test("an invalid composition is replaced, never partially rendered", () => {
  const html = render({ version: 1, label: "x", size: "COMPACT", sections: [{ type: "text", text: "visible?" }, { type: "html" }] });
  assert.ok(html.includes("composed-surface-invalid"));
  assert.ok(!html.includes("visible?"));
});

test("actions exist only on live, valid-state cards", () => {
  const live = render(paymentReview, true);
  assert.equal(count(live, "<button"), 2);
  const old = render(paymentReview, false);
  assert.equal(count(old, "<button"), 0, "an older card offers no SEND action");
  const expired = render({ ...paymentReview, state: "EXPIRED" }, true);
  assert.equal(count(expired, "<button"), 0, "an expired card offers no action");
  assert.ok(expired.includes("انتهت صلاحية هذه البطاقة"));
  const denied = render({ ...paymentReview, state: "DENIED" }, true);
  assert.equal(count(denied, "<button"), 0);
  // An in-app link is navigation, not a mutation: it stays available on older cards.
  assert.ok(render(optionsWithBars, false).includes('href="/listings/abc"'));
});

// ─── Adapters over canonical payloads ───────────────────────────────────────────

const metric = (key: string, label: string, raw: number, value = String(raw)) => ({ key, label, value, raw });
const salesMetrics = (orders: number, gross: number) => [
  metric("orders", "الطلبات", orders), metric("completed", "المكتملة", 0), metric("cancelled", "الملغاة", 0),
  metric("gross", "إجمالي قيمة الطلبات", gross, `${gross}.000 JOD`), metric("paid", "المدفوع (تجريبي)", 0, "0.000 JOD"),
  metric("refunded", "المسترد", 0, "0.000 JOD"), metric("recognized", "صافي المبيعات", 0, "0.000 JOD"),
];
const period = (key: "THIS_MONTH" | "LAST_MONTH" | "LAST_7_DAYS", label: string) => ({ key, label, start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T23:59:59.999Z", timeZone: "UTC" });
const sales = SellerSalesInsight.parse({
  kind: "BUSINESS_SUMMARY", source: "DINAR_ONLY", topic: "SALES", currencyCode: "JOD",
  period: period("THIS_MONTH", "هذا الشهر"), metrics: salesMetrics(2, 280),
  topProducts: [{ listingId: "l1", label: "لابتوب", units: 2, orders: 2 }],
  notes: ["الطلبات غير المدفوعة ليست أموالًا مستلمة."],
});

test("seller analytics: every figure copied, follow-ups are server utterances", () => {
  const surface = valid(salesSurface(sales));
  const html = render(surface);
  for (const key of ["orders", "completed", "cancelled", "gross", "paid", "refunded", "recognized"]) assert.ok(html.includes(`sales-metric-${key}`), key);
  assert.ok(html.includes("280.000 JOD") && html.includes("sales-top-product"));
  const actions = surface.sections.flatMap((section) => (section.type === "actions" ? section.items : []));
  assert.deepEqual(actions.map((action) => action.kind === "SEND" && action.message), [
    "إحصائيات مبيعاتي آخر 7 أيام",
    "قارن مبيعاتي هذا الشهر بالفترة السابقة",
  ]);
  const compared = SellerSalesInsight.parse({ ...sales, previous: { period: period("LAST_MONTH", "الشهر الماضي"), metrics: salesMetrics(1, 300) } });
  const comparedHtml = render(valid(salesSurface(compared)));
  assert.ok(comparedHtml.includes("هذا الشهر مقابل الشهر الماضي"));
  assert.ok(comparedHtml.includes('data-trend="UP"') && comparedHtml.includes('data-trend="DOWN"'), "trends come from raw values");
  assert.ok(!comparedHtml.includes("sales-compare"), "no second comparison offered");
  const empty = SellerSalesInsight.parse({ ...sales, metrics: salesMetrics(0, 0), topProducts: [] });
  assert.equal(parseComposedSurface(salesSurface(empty))?.state, "EMPTY");
});

test("business insights compose without the bespoke card", () => {
  for (const insight of [
    { kind: "BUSINESS_SUMMARY", source: "DINAR_ONLY", topic: "ORDERS", metrics: (["all", "active", "completed", "closed"] as const).map((key, index) => ({ key, label: key, value: index })) },
    { kind: "BUSINESS_SUMMARY", source: "DINAR_ONLY", topic: "INVENTORY", metrics: [{ listingId: "a", label: "معطف", value: "3 قطع", status: "PUBLISHED" }, { listingId: "b", label: "معطف", value: "1", status: "PAUSED" }] },
    { kind: "BUSINESS_SUMMARY", source: "DINAR_ONLY", topic: "PERFORMANCE", metrics: [{ listingId: "a", label: "معطف", orders: 2, priceOffers: 1 }] },
  ] as const) {
    const html = render(valid(businessSurface(insight as never)));
    assert.ok(html.includes('data-testid="business-summary"'), insight.topic);
  }
});

const tier = (id: string, label: string, priceLabel: string | null, current = false) => ({
  tier: id, label, current, priceLabel, priceConfigured: id === "FREE" || priceLabel !== null,
  allowances: [{ key: "TEXT_REQUEST", label: "المحادثات الذكية", value: 50 }, { key: "IMAGE", label: "الصور", value: 0 }], tokens: 100000,
});
const plans = {
  provisional: true,
  tiers: [tier("FREE", "المجاني", "مجانًا", true), tier("BUSINESS_GO", "Go", "5.000 JOD لكل 30 يومًا"), tier("BUSINESS_PRO", "Pro", null)],
  sameCapabilities: "كل الباقات تعطي القدرات نفسها.",
  billing: { status: "NOT_CONNECTED" as const, simulationAvailable: false, note: "الفوترة غير متصلة بعد؛ لن يُخصم أي مبلغ." },
  renewalNote: "لا تجديد تلقائي.",
};

test("plans: configured tiers only, no invented price, popularity or unlimited claim", () => {
  const surface = valid(plansSurface(plans));
  const html = render(surface);
  assert.equal(count(html, 'data-testid="ai-plan"'), 3);
  assert.ok(html.includes("السعر غير معتمد بعد"), "unpriced Pro says so");
  assert.ok(!/الأكثر|شائع|غير محدود|unlimited|popular/i.test(html));
  assert.ok(html.includes("ai-plans-billing") && html.includes("الفوترة غير متصلة"));
  const options = surface.sections.find((section) => section.type === "options");
  const actions = options?.type === "options" ? options.items.map((item) => item.actions?.[0]?.kind === "SEND" ? item.actions[0].message : null) : [];
  assert.deepEqual(actions, [null, "اشترك في Go", null], "only a priced, non-current paid tier offers review");
  assert.ok(!html.includes("IMAGE") && !html.includes("الصور"), "zero allowances are not advertised");
});

test("usage: meters from quota records, limits stated as provisional", () => {
  const html = render(valid(usageSurface({
    tierLabel: "المجاني", provisional: true, renewsAtLabel: "1 نوفمبر",
    resources: [
      { key: "TEXT_REQUEST", label: "المحادثات الذكية", used: 45, limit: 50, remaining: 5, percent: 90, included: true },
      { key: "IMAGE", label: "الصور", used: 0, limit: 0, remaining: 0, percent: null, included: false },
    ],
    tokens: { used: 1000, limit: 100000, percent: 1 }, exhaustedLabels: [], platformPaused: false,
    providerStatus: "NOT_CONFIGURED", costNote: "لا تكلفة عليك.", essentials: "الأساسيات متاحة دائمًا.",
  })));
  assert.equal(count(html, 'data-testid="usage-meter"'), 2);
  assert.ok(html.includes('data-level="HIGH"'), "90% shows the high level");
  assert.ok(html.includes("مؤقتة") && html.includes("غير مهيأ"));
});

// ─── Negotiation and purchase adapters ──────────────────────────────────────────

import { negotiationSurface, purchaseSurface } from "../src/features/ai/surface/commerce-adapters";

const valueOf = (html: string, id: string) => html.match(new RegExp(`data-testid="${id}"[^>]*>(?:<bdi[^>]*>)?([^<]*)`))?.[1];

test("negotiation: every view composes; amounts carry their own test ids; gold marks only what is current", () => {
  const base = { title: "طاولة", currency: "JOD", listedPrice: "10.000", offerAmount: "7.000" };
  const views = [
    { view: "REVIEW", action: "SEND_NEGOTIATION_OFFER", status: "PENDING", role: "BUYER", ...base },
    { view: "REVIEW", action: "ACCEPT_NEGOTIATION", status: "PENDING", role: "BUYER", ...base, counterAmount: "8.000" },
    { view: "REVIEW", action: "REJECT_NEGOTIATION", status: "CANCELLED", role: "SELLER", ...base },
    { view: "STATUS", status: "OPEN", role: "SELLER", ...base },
    { view: "STATUS", status: "COUNTERED", role: "BUYER", ...base, counterAmount: "8.000" },
    { view: "STATUS", status: "ACCEPTED", role: "BUYER", ...base, counterAmount: "8.000", agreedAmount: "8.000" },
    { view: "STATUS", status: "EXPIRED", role: "BUYER", ...base },
    { view: "LIST", items: [{ ...base, role: "SELLER", status: "OPEN" }, { ...base, role: "SELLER", status: "ACCEPTED", agreedAmount: "7.000" }] },
    { view: "LIST", items: [] },
    { view: "UNAVAILABLE" },
  ] as const;
  for (const negotiation of views) valid(negotiationSurface(negotiation as never));

  const counter = render(negotiationSurface(views[4] as never));
  assert.equal(valueOf(counter, "negotiation-public-price"), "10 JOD", "the value alone, for readers of the value");
  assert.ok(/data-emphasis="GOLD" data-testid="negotiation-counter"/.test(counter), "the counter awaiting the buyer is the gold figure");
  assert.ok(!/data-emphasis="GOLD" data-testid="negotiation-offer"/.test(counter), "a past offer is not gold");
  assert.ok(counter.includes('data-status="COUNTERED"') && counter.includes("ds-timeline") && counter.includes("بانتظار ردك"));

  const accepted = render(negotiationSurface(views[5] as never));
  assert.ok(/data-emphasis="GOLD" data-testid="negotiation-agreed"/.test(accepted) && accepted.includes("negotiation-order"));
  const pending = render(negotiationSurface(views[0] as never));
  assert.ok(pending.includes("pending-notice") && pending.includes("عرضك (لم يُرسل)") && pending.includes("negotiation-send"));
  assert.ok(!pending.includes("ds-timeline"), "an unsent review shows no history");
  const list = render(negotiationSurface(views[7] as never));
  assert.equal(count(list, 'data-testid="negotiation-item"'), 2);
  assert.ok(list.includes("negotiation-accept-1") && list.includes("negotiation-reject-1") && !list.includes("negotiation-accept-2"));
  assert.equal(count(render(negotiationSurface(views[5] as never), false), "<button"), 0, "an older card offers nothing");
});

test("negotiation status card: decision buttons only for the party the server allows", () => {
  const base = { view: "STATUS", title: "طاولة", currency: "JOD", listedPrice: "10.000", offerAmount: "7.000" } as const;
  const sellerOpen = render(valid(negotiationSurface({ ...base, status: "OPEN", role: "SELLER", decisions: ["ACCEPT", "COUNTER", "REJECT"] } as never)));
  for (const id of ["negotiation-status-accept", "negotiation-status-counter", "negotiation-status-reject"]) assert.ok(sellerOpen.includes(id), id);
  assert.ok(sellerOpen.includes("قبول العرض") && sellerOpen.includes("رفض العرض") && sellerOpen.includes("عرض مقابل"));
  assert.ok(!sellerOpen.includes("negotiation-status-withdraw"));
  const buyerWaiting = render(valid(negotiationSurface({ ...base, status: "OPEN", role: "BUYER", decisions: ["WITHDRAW"] } as never)));
  assert.ok(buyerWaiting.includes("negotiation-status-withdraw") && !buyerWaiting.includes("negotiation-status-accept"), "the buyer cannot accept its own offer");
  const closed = render(valid(negotiationSurface({ ...base, status: "REJECTED", role: "SELLER", decisions: [] } as never)));
  assert.ok(!closed.includes("negotiation-status-"), "a closed negotiation offers no decision");
  const legacy = render(valid(negotiationSurface({ ...base, status: "OPEN", role: "SELLER" } as never)));
  assert.ok(!legacy.includes("negotiation-status-accept"), "no decisions are shown unless the server sent them");
});

test("listing pricing: buyer actions per representation; no buy-now without a definite price", async () => {
  const { listingBuyerActions, LISTING_BUYER_ACTION_LABELS } = await import("@workspace/api-zod/listing-pricing");
  const of = (representation: any, price: number | null) =>
    listingBuyerActions({ representation, unitPriceMinor: price, viewerIsSeller: false, published: true, inStock: true }).map((action) => LISTING_BUYER_ACTION_LABELS[action]);
  assert.deepEqual(of("FIXED", 1), ["شراء بالسعر المعروض", "قدّم عرض سعر"]);
  assert.deepEqual(of("STARTING_FROM", 1), ["اطلب تسعيرة", "قدّم عرض سعر"]);
  assert.deepEqual(of("QUOTE_REQUIRED", null), ["اطلب تسعيرة", "قدّم عرض سعر"]);
  assert.deepEqual(of("NEGOTIABLE", 1), ["تفاوض مع البائع"]);
});

test("hypothetical price: arithmetic only, never gold, offer only through the review", () => {
  const base = { view: "HYPOTHETICAL", title: "هاتف", role: "BUYER", currency: "JOD", listedPrice: "120.000", reductionLabel: "10%", reductionAmount: "12.000", hypotheticalPrice: "108.000" } as const;
  const live = render(valid(negotiationSurface({ ...base, canOffer: true })));
  assert.equal(valueOf(live, "hypothetical-price"), "108 JOD");
  assert.equal(valueOf(live, "hypothetical-listed"), "120 JOD");
  assert.ok(!live.includes('data-emphasis="GOLD"') && !live.includes("data-verified"), "a calculation is never shown as an agreed or verified amount");
  assert.ok(live.includes("لم يتغير سعر الإعلان ولم يُرسل أي عرض") && live.includes("hypothetical-offer"));
  assert.ok(!live.includes("negotiation-send"), "the button opens a review; it never sends");
  const fixed = render(valid(negotiationSurface({ ...base, canOffer: false })));
  assert.equal(count(fixed, "<button"), 0, "no offer button where offers are not possible");
  const stale = render(valid(negotiationSurface({ ...base, canOffer: true, stale: true })));
  assert.ok(stale.includes("hypothetical-stale") && !stale.includes("hypothetical-offer") && stale.includes('data-status="STALE"'));
  assert.equal(count(render(negotiationSurface({ ...base, canOffer: true }), false), "<button"), 0, "an older card offers nothing");
});

test("purchase review: server totals only, gold only when priced, payment needs a method", () => {
  const review = { actionId: "a1", status: "PENDING", title: "لابتوب", sellerName: "متجر", unitPrice: "280.000", currency: "JOD", quantity: 1, total: "280.000", available: 3 };
  const item = render(valid(purchaseSurface({ ...review, stage: "ITEM" })));
  assert.ok(item.includes('data-verified="true"') && item.includes("purchase-continue") && item.includes("السلة"));
  const unknown = render(valid(purchaseSurface({ ...review, stage: "ITEM", unitPrice: null, total: null })));
  assert.ok(!unknown.includes("data-verified") && unknown.includes("بالاتفاق"), "an unpriced total is never gold");
  const payment = render(valid(purchaseSurface({ ...review, stage: "PAYMENT", paymentMethods: ["CASH_DIRECT", "CARD"], selectedPaymentMethod: null })));
  assert.ok(/data-testid="purchase-confirm"[^>]*disabled|disabled[^>]*data-testid="purchase-confirm"/.test(payment), "no method, no confirm");
  assert.ok(payment.includes("purchase-payment-CARD") && payment.includes("SIMULATION_ONLY"));
  const chosen = render(valid(purchaseSurface({ ...review, stage: "PAYMENT", paymentMethods: ["CASH_DIRECT", "CARD"], selectedPaymentMethod: "CARD" })));
  assert.ok(/aria-pressed="true"[^>]*data-testid="purchase-payment-CARD"|data-testid="purchase-payment-CARD"[^>]*aria-pressed="true"/.test(chosen));
  const negotiated = render(valid(purchaseSurface({ ...review, stage: "ORDER", negotiated: true, unitPrice: "8.000", publicUnitPrice: "10.000", fulfilmentOptions: [{ method: "PICKUP", label: "استلام شخصي" }] })));
  assert.equal(valueOf(negotiated, "purchase-agreed-price"), "8.000 JOD");
  assert.equal(valueOf(negotiated, "purchase-public-price"), "10.000 JOD");
  assert.ok(negotiated.includes("purchase-fulfilment-PICKUP"));
  const done = render(valid(purchaseSurface({ ...review, stage: "PAYMENT", status: "CONFIRMED" })));
  assert.ok(done.includes("لم تُحوَّل أموال") && count(done, "<button") === 0, "a confirmed simulated payment never claims money moved");
});
