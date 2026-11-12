/**
 * D3-A native catalog over the existing marketplace listings.
 *
 * Publication goes through `createListingForActor` (the shared seller-form/conversation
 * authority); edits and status changes go through `updateOwnedListing`,
 * `changeOwnedListingStatus` and `archiveOwnedListing`. This module only adds the business
 * scope, capability rechecks, association and audit — it never writes listings itself.
 */
import { and, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import type { UpdateListingBody } from "@workspace/api-zod";
import {
  businessOperatingProfiles,
  db,
  offers,
  orderItems,
  orders,
  users,
} from "@workspace/db";
import type { marketFor } from "./markets";
import {
  archiveOwnedListing,
  changeOwnedListingStatus,
  updateOwnedListing,
} from "./listing-management";
import { createListingForActor } from "../routes/marketplace";
import {
  assertPublishable,
  recordBusinessAudit,
  requireBusinessCapability,
  resolveBusinessAccess,
  businessWithD2Identity,
  type BusinessAccess,
  type BusinessProfile,
} from "./business-access";
import type { BusinessCapability } from "./business-capabilities";
import { d2BusinessIdentity } from "./d2-business-identity";

type Market = Awaited<ReturnType<typeof marketFor>>;
type ListingUpdate = z.infer<typeof UpdateListingBody>;
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export type BusinessListingState = {
  listingId: string;
  title: string;
  status: string;
  priceMinor: number | null;
  pricingMode: string;
  inventoryMode: string;
  availableQuantity: number | null;
  reservedQuantity: number;
  category: string;
  updatedAt: string;
};

const stateOf = (row: typeof offers.$inferSelect): BusinessListingState => ({
  listingId: row.id,
  title: typeof row.data.title === "string" ? row.data.title : "منتج",
  status: row.status,
  priceMinor: row.unitPriceMinor,
  pricingMode: row.pricingMode,
  inventoryMode: row.inventoryMode,
  availableQuantity: row.availableQuantity,
  reservedQuantity: row.reservedQuantity,
  category: typeof row.data.category === "string" ? row.data.category : "",
  updatedAt: row.updatedAt.toISOString(),
});

export async function businessListingRows(
  businessId: string,
  marketId: string,
  executor: Executor = db,
) {
  return executor
    .select({ offer: offers })
    .from(offers)
    .where(and(
      eq(offers.businessProfileId, businessId),
      eq(offers.marketId, marketId),
    ))
    .orderBy(desc(offers.createdAt));
}

export async function businessListings(business: BusinessProfile, marketId: string) {
  return (await businessListingRows(business.d2BusinessId, marketId)).map((row) => stateOf(row.offer));
}

/** The listing ids a storefront may show: published listings of one business in one market. */
export async function businessPublicListingIds(business: BusinessProfile, marketId: string) {
  const rows = await businessListingRows(business.d2BusinessId, marketId);
  return rows.filter((row) => row.offer.status === "PUBLISHED").map((row) => row.offer.id);
}

export async function businessListingForBusiness(input: {
  businessId: string;
  listingId: string;
  marketId: string;
  executor: Executor;
  lock?: boolean;
}) {
  let query = input.executor
    .select({ offer: offers })
    .from(offers)
    .where(and(
      eq(offers.businessProfileId, input.businessId),
      eq(offers.id, input.listingId),
      eq(offers.marketId, input.marketId),
    ));
  if (input.lock) query = query.for("share") as typeof query;
  const [row] = await query.limit(1);
  return row?.offer;
}

export async function businessCatalogSummary(business: BusinessProfile, marketId: string) {
  const rows = await businessListings(business, marketId);
  return {
    total: rows.length,
    published: rows.filter((row) => row.status === "PUBLISHED").length,
    paused: rows.filter((row) => row.status === "PAUSED").length,
    outOfStock: rows.filter((row) => row.inventoryMode === "LIMITED" && (row.availableQuantity ?? 0) <= 0).length,
  };
}

function requiredUpdateCapabilities(body: ListingUpdate): BusinessCapability[] {
  const inventory = body.inventoryMode !== undefined || body.availableQuantity !== undefined;
  const price = body.unitPrice !== undefined || body.pricingMode !== undefined || body.priceRepresentation !== undefined;
  const content = body.title !== undefined || body.description !== undefined || body.category !== undefined ||
    body.categoryId !== undefined || body.attributes !== undefined || body.imageUrl !== undefined ||
    body.imageUrls !== undefined || body.area !== undefined || body.city !== undefined ||
    body.fulfilmentType !== undefined || body.contactPhone !== undefined ||
    body.negotiable !== undefined;
  const capabilities: BusinessCapability[] = [];
  if (price || content) capabilities.push("business.listing.update");
  if (inventory) capabilities.push("business.inventory.manage");
  return capabilities.length ? capabilities : ["business.listing.update"];
}

async function lockedBusiness(
  executor: Executor,
  input: { businessId: string; actorId: string; marketId: string },
) {
  const [row] = await executor
    .select()
    .from(businessOperatingProfiles)
    .where(and(
      eq(businessOperatingProfiles.id, input.businessId),
      eq(businessOperatingProfiles.marketId, input.marketId),
    ))
    .for("share");
  if (!row) throw fail(404, "النشاط غير موجود");
  const access = await resolveBusinessAccess({
    business: row,
    actorId: input.actorId,
    marketId: input.marketId,
  });
  if (access.actorClass === "NONE") throw fail(404, "النشاط غير موجود");
  return { business: await businessWithD2Identity(row), access };
}

function requireCapabilities(access: BusinessAccess, capabilities: readonly BusinessCapability[]) {
  for (const capability of capabilities)
    if (!access.capabilities.has(capability))
      throw fail(403, "لا تملك صلاحية تنفيذ هذا الإجراء على هذا النشاط");
}

/** Creates and publishes one typed business draft through the canonical listing authority. */
export async function publishBusinessDraft(input: {
  businessId: string;
  actor: typeof users.$inferSelect;
  market: Market;
  body: unknown;
  idempotencyKey: string;
}) {
  return db.transaction(async (tx) => {
    const { business, access } = await lockedBusiness(tx, {
      businessId: input.businessId,
      actorId: input.actor.id,
      marketId: input.market.id,
    });
    requireCapabilities(access, ["business.catalog.publish"]);
    assertPublishable(access);
    const created = await createListingForActor(
      input.actor,
      input.body,
      input.idempotencyKey,
      { businessId: business.id, tx },
    );
    await recordBusinessAudit({
      businessId: business.id,
      actorId: input.actor.id,
      action: "LISTING_PUBLISHED",
      resourceType: "LISTING",
      resourceId: created.listing.id,
      detail: { status: created.status, title: created.listing.title },
      executor: tx,
    });
    return created;
  });
}

export async function updateBusinessListing(input: {
  businessId: string;
  listingId: string;
  actorId: string;
  market: Market;
  body: ListingUpdate;
  expectedUpdatedAt?: string;
}) {
  const capabilities = requiredUpdateCapabilities(input.body);
  return db.transaction(async (tx) => {
    const { business, access } = await lockedBusiness(tx, {
      businessId: input.businessId,
      actorId: input.actorId,
      marketId: input.market.id,
    });
    requireCapabilities(access, capabilities);
    // Publication-facing edits require a publishable business; inventory-only corrections do too
    // for published listings, because buyers see the result.
    if (capabilities.some((capability) => capability !== "business.catalog.read")) {
      const linked = await businessListingForBusiness({
        businessId: business.d2BusinessId,
        listingId: input.listingId,
        marketId: input.market.id,
        executor: tx,
        lock: true,
      });
      if (!linked) throw fail(404, "المنتج غير موجود في هذا النشاط");
      if (linked.status === "PUBLISHED") assertPublishable(access);
    }
    const updated = await updateOwnedListing(
      {
        listingId: input.listingId,
        ownerId: business.ownerUserId,
        market: input.market,
        body: input.body,
        expectedUpdatedAt: input.expectedUpdatedAt,
      },
      tx,
    );
    await recordBusinessAudit({
      businessId: business.id,
      actorId: input.actorId,
      action: "LISTING_UPDATED",
      resourceType: "LISTING",
      resourceId: input.listingId,
      detail: { fields: Object.keys(input.body), capabilities },
      executor: tx,
    });
    return updated;
  });
}

export async function changeBusinessListingStatus(input: {
  businessId: string;
  listingId: string;
  actorId: string;
  market: Market;
  action: "PAUSE" | "RESUME";
  expectedUpdatedAt?: string;
}) {
  return db.transaction(async (tx) => {
    const { business, access } = await lockedBusiness(tx, {
      businessId: input.businessId,
      actorId: input.actorId,
      marketId: input.market.id,
    });
    requireCapabilities(access, ["business.listing.update"]);
    const linked = await businessListingForBusiness({
      businessId: business.d2BusinessId,
      listingId: input.listingId,
      marketId: input.market.id,
      executor: tx,
      lock: true,
    });
    if (!linked) throw fail(404, "المنتج غير موجود في هذا النشاط");
    if (input.action === "RESUME") assertPublishable(access);
    const updated = await changeOwnedListingStatus(
      {
        listingId: input.listingId,
        ownerId: business.ownerUserId,
        market: input.market,
        action: input.action,
        expectedUpdatedAt: input.expectedUpdatedAt,
      },
      tx,
    );
    await recordBusinessAudit({
      businessId: business.id,
      actorId: input.actorId,
      action: input.action === "PAUSE" ? "LISTING_PAUSED" : "LISTING_RESUMED",
      resourceType: "LISTING",
      resourceId: input.listingId,
      executor: tx,
    });
    return updated;
  });
}

export async function archiveBusinessListing(input: {
  businessId: string;
  listingId: string;
  actorId: string;
  market: Market;
  expectedUpdatedAt?: string;
}) {
  return db.transaction(async (tx) => {
    const { business, access } = await lockedBusiness(tx, {
      businessId: input.businessId,
      actorId: input.actorId,
      marketId: input.market.id,
    });
    requireCapabilities(access, ["business.listing.update"]);
    const linked = await businessListingForBusiness({
      businessId: business.d2BusinessId,
      listingId: input.listingId,
      marketId: input.market.id,
      executor: tx,
      lock: true,
    });
    if (!linked) throw fail(404, "المنتج غير موجود في هذا النشاط");
    const archived = await archiveOwnedListing(
      {
        listingId: input.listingId,
        ownerId: business.ownerUserId,
        market: input.market,
        expectedUpdatedAt: input.expectedUpdatedAt,
      },
      tx,
    );
    await recordBusinessAudit({
      businessId: business.id,
      actorId: input.actorId,
      action: "LISTING_ARCHIVED",
      resourceType: "LISTING",
      resourceId: input.listingId,
      executor: tx,
    });
    return archived;
  });
}

export type BusinessOrderView = {
  orderId: string;
  status: string;
  currencyCode: string;
  subtotalMinor: number;
  sellerAmountMinor: number;
  createdAt: string;
  itemCount: number;
};

/**
 * Orders that contain at least one of this business's listings; never another business's.
 *
 * One owner may hold several businesses in one market, and checkout groups a seller's lines into
 * one order. Totals are therefore scoped to the items linked to this business, and the order's
 * stored platform fee is allocated pro rata to those items. This is a display allocation only:
 * the order row, its fee snapshot and the financial ledger are never changed here.
 */
export async function businessOrders(business: BusinessProfile, marketId: string, limit = 20): Promise<BusinessOrderView[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      status: orders.status,
      currencyCode: orders.currencyCode,
      orderSubtotalMinor: orders.subtotalMinor,
      platformFeeMinor: orders.platformFeeMinor,
      subtotalMinor: sql<number>`coalesce(sum(${orderItems.subtotalMinor}), 0)::int`,
      itemCount: sql<number>`count(${orderItems.id})::int`,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(offers, eq(offers.id, orderItems.offerId))
    .where(and(
      eq(orders.sellerId, business.ownerUserId),
      eq(orders.marketId, marketId),
      eq(offers.businessProfileId, business.d2BusinessId),
    ))
    .groupBy(orders.id, orders.status, orders.currencyCode, orders.subtotalMinor, orders.platformFeeMinor, orders.createdAt)
    .orderBy(desc(orders.createdAt))
    .limit(limit);
  return rows.map((row) => {
    const scopedFeeMinor =
      row.orderSubtotalMinor > 0
        ? Math.round((row.platformFeeMinor * row.subtotalMinor) / row.orderSubtotalMinor)
        : 0;
    return {
      orderId: row.orderId,
      status: row.status,
      currencyCode: row.currencyCode,
      subtotalMinor: row.subtotalMinor,
      sellerAmountMinor: row.subtotalMinor - scopedFeeMinor,
      createdAt: row.createdAt.toISOString(),
      itemCount: row.itemCount,
    };
  });
}

export async function businessAnalytics(business: BusinessProfile, marketId: string) {
  const listingIds = (await businessListingRows(business.d2BusinessId, marketId)).map((row) => row.offer.id);
  const [listingCounts] = await db
    .select({
      total: count(),
      published: sql<number>`count(*) filter (where ${offers.status} = 'PUBLISHED')::int`,
      paused: sql<number>`count(*) filter (where ${offers.status} = 'PAUSED')::int`,
    })
    .from(offers)
    .where(and(eq(offers.businessProfileId, business.d2BusinessId), eq(offers.marketId, marketId)));
  if (!listingIds.length)
    return { listings: Number(listingCounts?.total ?? 0), published: 0, paused: 0, completedOrders: 0, completedRevenueMinor: 0, monthly: [] as { month: string; completedOrders: number; revenueMinor: number }[] };
  const [orderStats] = await db
    .select({
      completedOrders: sql<number>`count(distinct ${orders.id}) filter (where ${orders.status} = 'COMPLETED')::int`,
      completedRevenueMinor: sql<number>`coalesce(sum(${orderItems.subtotalMinor}) filter (where ${orders.status} = 'COMPLETED'), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(orders.sellerId, business.ownerUserId),
      eq(orders.marketId, marketId),
      inArray(orderItems.offerId, listingIds),
      ne(orders.status, "CANCELLED"),
    ));
  // Completed orders per calendar month (UTC) of the order's creation, last six months including
  // the current one. Orders carry no separate completion time, so the month is the order month;
  // the card says so. A month with no completed order is a recorded zero from the same query.
  const monthStarts = Array.from({ length: 6 }, (_, index) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - index), 1));
  });
  const monthRows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${orders.createdAt} at time zone 'UTC'), 'YYYY-MM')`,
      completedOrders: sql<number>`count(distinct ${orders.id})::int`,
      revenueMinor: sql<number>`coalesce(sum(${orderItems.subtotalMinor}), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(orders.sellerId, business.ownerUserId),
      eq(orders.marketId, marketId),
      inArray(orderItems.offerId, listingIds),
      eq(orders.status, "COMPLETED"),
      gte(orders.createdAt, monthStarts[0]!),
    ))
    .groupBy(sql`1`);
  const byMonth = new Map(monthRows.map((row) => [row.month, row]));
  const monthly = monthStarts.map((start) => {
    const month = start.toISOString().slice(0, 7);
    const row = byMonth.get(month);
    return { month, completedOrders: Number(row?.completedOrders ?? 0), revenueMinor: Number(row?.revenueMinor ?? 0) };
  });
  return {
    listings: Number(listingCounts?.total ?? 0),
    published: Number(listingCounts?.published ?? 0),
    paused: Number(listingCounts?.paused ?? 0),
    completedOrders: Number(orderStats?.completedOrders ?? 0),
    completedRevenueMinor: Number(orderStats?.completedRevenueMinor ?? 0),
    monthly,
  };
}

/** Re-reads a business for a public storefront; suspended or closed businesses do not exist publicly. */
export async function publicBusiness(businessId: string, marketId: string) {
  const [row] = await db
    .select()
    .from(businessOperatingProfiles)
    .where(and(
      eq(businessOperatingProfiles.id, businessId),
      eq(businessOperatingProfiles.marketId, marketId),
      eq(businessOperatingProfiles.status, "ACTIVE"),
    ))
    .limit(1);
  if (!row?.d2BusinessId) return undefined;
  const identity = await d2BusinessIdentity.forBusiness(row.d2BusinessId, marketId);
  if (
    !identity ||
    identity.ownerUserId !== row.ownerUserId ||
    identity.marketId !== row.marketId ||
    identity.verificationStatus !== "VERIFIED" ||
    identity.publicationEligibility !== "ELIGIBLE" ||
    identity.businessStatus !== "ACTIVE"
  ) return undefined;
  return businessWithD2Identity(row);
}
