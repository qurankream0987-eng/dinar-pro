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
    analytics?: { completedOrders: number; completedRevenue: string; currency: string };
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
      ? "هذه أنشطتك في سوقك الحالي من سجلات DINAR."
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
    prompt: view.length ? "هذه طلباتك التي عليها نزاع أو استرداد، من سجلات DINAR." : "لا توجد نزاعات أو استردادات مفتوحة على طلباتك في هذا السوق.",
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
    prompt: dues.length ? "هذه مستحقات عمولة DINAR على طلباتك المكتملة." : "لا توجد مستحقات عمولة عليك في هذا السوق.",
  };
}
