/**
 * Read-only model capabilities for business owners and for order problems. Every read is scoped
 * on the server to the signed-in actor's own rows in the active market; the model supplies no
 * identity, and nothing here writes, refunds, resolves or approves anything.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { businessOperatingProfiles, cashRefundCases, db, disputes, orders, paymentRefundObligations } from "@workspace/db";
import { businessWithD2Identity, resolveBusinessAccess } from "../lib/business-access";
import { businessAnalytics, businessCatalogSummary } from "../lib/business-catalog";
import type { ToolContext, ToolResult } from "./tool-registry";

export type BusinessOverview = {
  businesses: {
    businessId: string;
    name: string;
    status: string;
    verified: boolean;
    publishable: boolean;
    catalog?: { total: number; published: number; paused: number; outOfStock: number };
    analytics?: {
      completedOrders: number;
      completedRevenue: string;
      currency: string;
      /** Phase 2: the server's own series for display; minor units plus the market's scale. */
      completedRevenueMinor?: number;
      minorUnitScale?: number;
      monthly?: { month: string; completedOrders: number; revenueMinor: number }[];
      byCategory?: { category: string; completedOrders: number; revenueMinor: number }[];
    };
    withheld: string[];
  }[];
};

export type OrderIssues = {
  orders: {
    orderId: string;
    role: "BUYER" | "SELLER";
    status: string;
    disputes: { status: string; reason: string }[];
    refundObligations: { status: string; amount: string; currency: string }[];
    cashRefunds: { status: string; amount: string; currency: string }[];
  }[];
  note: string;
};

const money = (minor: number, scale: number) => (minor / 10 ** scale).toFixed(scale);

export async function readBusinessOverview(context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw Object.assign(new Error("Sign-in required."), { status: 401 });
  const rows = await db
    .select()
    .from(businessOperatingProfiles)
    .where(and(eq(businessOperatingProfiles.ownerUserId, context.actorId), eq(businessOperatingProfiles.marketId, context.market.id)))
    .limit(5);
  const scale = context.market.minorUnitScale;
  const businesses: BusinessOverview["businesses"] = [];
  for (const row of rows) {
    const business = await businessWithD2Identity(row);
    const access = await resolveBusinessAccess({ business, actorId: context.actorId, marketId: context.market.id });
    const withheld: string[] = [];
    const entry: BusinessOverview["businesses"][number] = {
      businessId: business.id,
      name: business.displayName.slice(0, 120),
      status: business.status,
      verified: Boolean(access.verified),
      publishable: Boolean(access.publishable),
      withheld,
    };
    if (access.capabilities.has("business.catalog.read")) entry.catalog = await businessCatalogSummary(business, context.market.id);
    else withheld.push("catalog: permission not granted");
    if (access.capabilities.has("business.analytics.read") && business.d2BusinessId) {
      const stats = await businessAnalytics(business, context.market.id);
      entry.analytics = {
        completedOrders: Number(stats.completedOrders ?? 0),
        completedRevenue: money(Number(stats.completedRevenueMinor ?? 0), scale),
        currency: context.market.currencyCode,
        completedRevenueMinor: Number(stats.completedRevenueMinor ?? 0),
        minorUnitScale: scale,
        monthly: stats.monthly,
        byCategory: stats.byCategory,
      };
    } else withheld.push("analytics: permission not granted or identity pending");
    businesses.push(entry);
  }
  return {
    kind: "SURFACE",
    surface: "BUSINESS_INSIGHTS",
    query: {},
    listings: [],
    businessOverview: { businesses },
    prompt: businesses.length
      ? "هذه أنشطتك في سوقك الحالي من سجلات جاسم."
      : "لا يوجد نشاط تجاري مسجل لك في هذا السوق.",
  };
}

export async function readOrderIssues(context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw Object.assign(new Error("Sign-in required."), { status: 401 });
  const own = await db
    .select({ id: orders.id, buyerId: orders.buyerId, status: orders.status, scale: orders.minorUnitScale })
    .from(orders)
    .where(and(eq(orders.marketId, context.market.id), or(eq(orders.buyerId, context.actorId), eq(orders.sellerId, context.actorId))))
    .orderBy(desc(orders.createdAt))
    .limit(30);
  const ids = own.map((row) => row.id);
  const [disputeRows, obligationRows, cashRows] = ids.length
    ? await Promise.all([
        db.select().from(disputes).where(inArray(disputes.orderId, ids)),
        db.select().from(paymentRefundObligations).where(inArray(paymentRefundObligations.orderId, ids)),
        db.select().from(cashRefundCases).where(inArray(cashRefundCases.orderId, ids)),
      ])
    : [[], [], []];
  const view: OrderIssues["orders"] = own
    .map((row) => ({
      orderId: row.id,
      role: (row.buyerId === context.actorId ? "BUYER" : "SELLER") as "BUYER" | "SELLER",
      status: row.status,
      disputes: disputeRows.filter((item) => item.orderId === row.id).map((item) => ({ status: String(item.status), reason: String(item.reason ?? "").slice(0, 120) })),
      refundObligations: obligationRows.filter((item) => item.orderId === row.id).map((item) => ({ status: String(item.status), amount: money(item.amountMinor, row.scale), currency: item.currencyCode })),
      cashRefunds: cashRows.filter((item) => item.orderId === row.id).map((item) => ({ status: String(item.status), amount: money(item.amountMinor, row.scale), currency: item.currencyCode })),
    }))
    .filter((row) => row.disputes.length || row.refundObligations.length || row.cashRefunds.length || /DISPUT|REFUND|CANCEL/u.test(row.status));
  return {
    kind: "SURFACE",
    surface: "ORDERS_LIST",
    query: {},
    listings: [],
    orderIssues: {
      orders: view,
      note: "Read only. A refund is paid only after a provider-confirmed REFUND_SUCCEEDED; an open obligation is not money received.",
    },
    prompt: view.length ? "هذه طلباتك التي عليها نزاع أو استرداد، من سجلات جاسم." : "لا توجد نزاعات أو استردادات مفتوحة على طلباتك في هذا السوق.",
  };
}

export async function readSellerDues(context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw Object.assign(new Error("Sign-in required."), { status: 401 });
  const { sellerDuesView } = await import("../lib/seller-dues");
  const dues = (await sellerDuesView(context.actorId, context.market.id)).slice(0, 30);
  return {
    kind: "SURFACE",
    surface: "DUES",
    query: {},
    listings: [],
    sellerDues: {
      dues: dues.map((row) => ({ orderId: row.orderId, listingTitle: String(row.listingTitle ?? "").slice(0, 120), amount: row.amount, currency: row.currency, status: row.status, dueAt: row.dueAt })),
      note: "Commission dues from the order's immutable policy snapshot, net of recorded reversals. There is no electronic payment of dues; never say a due was paid unless its status says so.",
    },
    prompt: dues.length ? "هذه مستحقات عمولة جاسم على طلباتك المكتملة." : "لا توجد مستحقات عمولة عليك في هذا السوق.",
  };
}

/**
 * The actor's own AI allowance: the same card as the deterministic usage route (recorded
 * consumption, limits, renewal, provisional flag), plus an optional server-side projection.
 * Read only; identity from the session; a provider's own token balance is never involved.
 */
export async function readAiUsage(
  input: { question?: "SUMMARY" | "RENEWAL" | "WHY_STOPPED"; horizonDays?: number },
  context: ToolContext,
): Promise<ToolResult> {
  if (!context.actorId) throw Object.assign(new Error("Sign-in required."), { status: 401 });
  const [{ aiUsageCardTurn }, { aiUsageSummary }, { usageProjection }] = await Promise.all([
    import("./commerce-turn"),
    import("../lib/ai-usage"),
    import("./usage-turn"),
  ]);
  const turn = await aiUsageCardTurn(context.actorId, context.market as never, input.question ?? "SUMMARY");
  const summary = await aiUsageSummary({ kind: "USER", userId: context.actorId, market: context.market as never });
  const text = summary.resources.find((item) => item.resource === "TEXT_REQUEST");
  const until = input.horizonDays ? new Date(Date.now() + input.horizonDays * 24 * 60 * 60 * 1000) : undefined;
  const projection = text
    ? usageProjection({ used: text.used, limit: text.limit, remaining: text.remaining }, summary.period, new Date(), until)
    : { kind: "INSUFFICIENT_DATA" as const, reason: "NO_TEXT_RESOURCE" };
  return {
    ...turn.result,
    aiUsage: {
      tier: summary.tierLabel,
      provisional: !summary.approved,
      renewsAt: summary.period.renewsAt,
      resources: summary.resources.map((item) => ({ resource: item.resource, label: item.label, used: item.used, limit: item.limit, remaining: item.remaining })),
      tokens: { used: summary.tokens.used, limit: summary.tokens.limit },
      projection,
      note: "DINAR's own allowance from its usage ledger, not any AI provider's balance. A projection is an estimate from this period's pace; say so, and when it is INSUFFICIENT_DATA do not give a number.",
    },
  };
}

/**
 * The actor's own DINAR Connect partnerships (owner or delegated team): partner status and the
 * agreement status/terms, through connect/partners and connect/agreements, whose access checks
 * apply unchanged. A partner whose agreements the actor may not read shows status only.
 */
export async function readConnectPartnerStatus(context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw Object.assign(new Error("Sign-in required."), { status: 401 });
  const [{ listConnectPartners }, { listConnectAgreements }] = await Promise.all([import("../connect/partners"), import("../connect/agreements")]);
  const partners = (await listConnectPartners(context.actorId, context.market.id)).slice(0, 10);
  const view = [];
  for (const partner of partners) {
    let agreements: Record<string, unknown>[] | "NOT_PERMITTED" = "NOT_PERMITTED";
    try {
      agreements = (await listConnectAgreements(context.actorId, context.market as never, String(partner.id))).slice(0, 5).map((row): Record<string, unknown> => {
        // The canonical ConnectAgreementView: terms.commission, accepted, acceptance.acceptedAt.
        // Mapped field by field; nothing is guessed, so a known fact never turns unknown.
        const terms = row.terms;
        return {
          version: row.version,
          accepted: row.accepted,
          acceptedAt: row.acceptance?.acceptedAt ?? null,
          mode: terms.mode,
          currency: terms.currency,
          commission: terms.commission.kind === "PERCENTAGE"
            ? { kind: "PERCENTAGE", basisPoints: terms.commission.basisPoints }
            : { kind: "FIXED", amountMinor: terms.commission.amountMinor },
          categoryRates: terms.categoryRates.length,
          eligibleEvents: terms.eligibleEvents,
          effectiveFrom: terms.effectiveFrom,
          effectiveUntil: terms.effectiveUntil,
        };
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 403 && status !== 404) throw error;
    }
    view.push({ partnerId: partner.id, name: String(partner.displayName ?? "").slice(0, 120), status: partner.status, role: partner.role, businessVerification: partner.businessVerificationStatus, agreements });
  }
  return {
    kind: "SURFACE",
    surface: "CONNECT_RESULTS",
    query: {},
    listings: [],
    connectStatus: {
      partners: view,
      note: "Free onboarding: no registration, display or basic referral fee. Commission exists only under an accepted agreement and only on provider-confirmed conversions; a click is not revenue.",
    },
    prompt: view.length ? "هذه حالة شراكاتك في جاسم Connect من سجلات جاسم." : "لا توجد لديك شراكة في جاسم Connect في هذا السوق.",
  };
}

/** Published DINAR policies (terms, privacy, fees, refunds...): the current versions only. */
export async function readPolicy(input: { key?: string }, context: ToolContext): Promise<ToolResult> {
  const { currentPolicies, currentPolicy } = await import("../lib/policies");
  const one = input.key ? currentPolicy(input.key) : undefined;
  if (input.key && !one) throw Object.assign(new Error("Unknown policy."), { status: 404 });
  const documents = one ? [one] : currentPolicies();
  void context;
  return {
    kind: "SURFACE",
    surface: "POLICIES",
    query: {},
    listings: [],
    policies: documents.map((document) => ({
      key: document.key,
      title: document.titleAr,
      version: document.version,
      effectiveDate: document.effectiveDate,
      summary: document.summaryAr,
      legalReviewStatus: document.legalReviewStatus,
      ...(one ? { sections: document.sections.slice(0, 12).map((section) => JSON.stringify(section).slice(0, 600)) } : {}),
    })),
    prompt: one ? `هذه سياسة «${one.titleAr}» المنشورة حاليًا.` : "هذه سياسات جاسم المنشورة حاليًا.",
  };
}

/**
 * The signed-in user's own account status, from server records only: display name, phone
 * verification, account state, role, country and active market, the current subscription as the
 * subscription ledger resolves it, whether a live billing provider exists, and the AI allowance.
 * Nothing the client or the conversation says can change any field. No phone number, credential
 * or payment detail is returned. Guests get an explicit GUEST state and nothing else.
 */
export async function readMyAccountStatus(_input: Record<string, never>, context: ToolContext): Promise<ToolResult> {
  const base = { kind: "SURFACE" as const, surface: "ACCOUNT_STATUS", query: {}, listings: [] };
  if (!context.actorId)
    return { ...base, accountStatus: { signedIn: false, state: "GUEST", note: "الزائر غير مسجّل الدخول؛ لا توجد بيانات حساب أو اشتراك." } } as never;
  const [{ db, users }, { eq }, { accessPlanFor }, { subscriptionBillingStatus }, { aiUsageSummary }, { getCommercialPolicy }] = await Promise.all([
    import("@workspace/db"), import("drizzle-orm"), import("../lib/business"), import("../lib/subscription-billing"), import("../lib/ai-usage"), import("../lib/commercial-policy"),
  ]);
  const [user] = await db.select({
    displayName: users.displayName, phoneVerified: users.phoneVerified, status: users.status, role: users.role,
    accountCountry: users.accountCountry, activeMarketId: users.activeMarketId,
  }).from(users).where(eq(users.id, context.actorId));
  if (!user) return { ...base, accountStatus: { signedIn: false, state: "UNKNOWN" } } as never;
  const market = context.market as never as { id: string };
  let subscription: Record<string, unknown>;
  try {
    const policy = (await getCommercialPolicy(market.id)).subscriptionPlans;
    if (!policy) subscription = { status: "NOT_CONFIGURED" };
    else {
      const access = await accessPlanFor(context.actorId, market);
      subscription = access.plan === "FREE"
        ? { status: "NOT_SUBSCRIBED", plan: "FREE" }
        : { status: "ACTIVE", plan: access.plan, periodEnd: access.periodEnd };
    }
  } catch {
    subscription = { status: "UNKNOWN", reason: "TEMPORARY_READ_FAILURE" };
  }
  const billing = subscriptionBillingStatus();
  let usage: Record<string, unknown> | undefined;
  try {
    const summary = await aiUsageSummary({ kind: "USER", userId: context.actorId, market: context.market as never });
    usage = { tier: summary.tierLabel, renewsAt: summary.period.renewsAt, resources: summary.resources.map((item) => ({ resource: item.resource, used: item.used, limit: item.limit, remaining: item.remaining })) };
  } catch {
    usage = { status: "UNAVAILABLE" };
  }
  return {
    ...base,
    accountStatus: {
      signedIn: true,
      state: user.status,
      displayName: user.displayName,
      phoneVerified: user.phoneVerified,
      role: user.role,
      accountCountry: user.accountCountry,
      activeMarketId: user.activeMarketId,
      subscription: { ...subscription, billing: billing.mode === "REGISTERED_ADAPTER" ? "LIVE_PROVIDER" : "SIMULATION_NO_LIVE_BILLING" },
      aiUsage: usage,
      source: "DINAR_SERVER_RECORDS",
    },
  } as never;
}
