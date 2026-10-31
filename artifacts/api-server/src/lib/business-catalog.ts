/**
 * D3-A native catalog over the existing marketplace listings.
 *
 * Publication goes through `createListingForActor` (the shared seller-form/conversation
 * authority); edits and status changes go through `updateOwnedListing`,
 * `changeOwnedListingStatus` and `archiveOwnedListing`. This module only adds the business
 * scope, capability rechecks, association and audit — it never writes listings itself.
 */
import { and, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import type { UpdateListingBody } from "@workspace/api-zod";
import {
  businessListingLinks,
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
  type BusinessAccess,
  type BusinessProfile,
} from "./business-access";
import type { BusinessCapability } from "./business-capabilities";

type Market = Awaited<ReturnType<typeof marketFor>>;
type ListingUpdate = z.infer<typeof UpdateListingBody>;
type Executor = typeof db;

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
    .from(businessListingLinks)
    .innerJoin(offers, eq(offers.id, businessListingLinks.listingId))
    .where(and(
      eq(businessListingLinks.businessId, businessId),
      eq(businessListingLinks.marketId, marketId),
      eq(offers.marketId, marketId),
    ))
    .orderBy(desc(offers.createdAt));
}

export async function businessListings(business: BusinessProfile, marketId: string) {
  return (await businessListingRows(business.id, marketId)).map((row) => stateOf(row.offer));
}

/** The listing ids a storefront may show: published listings of one business in one market. */
export async function businessPublicListingIds(business: BusinessProfile, marketId: string) {
  const rows = await businessListingRows(business.id, marketId);
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
    .from(businessListingLinks)
    .innerJoin(offers, eq(offers.id, businessListingLinks.listingId))
    .where(and(
      eq(businessListingLinks.businessId, input.businessId),
      eq(businessListingLinks.listingId, input.listingId),
      eq(businessListingLinks.marketId, input.marketId),
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
    body.fulfilmentType !== undefined || body.contactPhone !== undefined || body.paymentMethods !== undefined ||
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
  return { business: row, access };
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
        businessId: business.id,
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
      businessId: business.id,
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
      businessId: business.id,
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

/** Orders that contain at least one of this business's listings; never another business's. */
export async function businessOrders(business: BusinessProfile, marketId: string, limit = 20): Promise<BusinessOrderView[]> {
  const rows = await db
    .select({
      order: orders,
      itemCount: sql<number>`count(${orderItems.id})::int`,
    })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(businessListingLinks, eq(businessListingLinks.listingId, orderItems.offerId))
    .where(and(
      eq(orders.sellerId, business.ownerUserId),
      eq(orders.marketId, marketId),
      eq(businessListingLinks.businessId, business.id),
    ))
    .groupBy(orders.id)
    .orderBy(desc(orders.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    orderId: row.order.id,
    status: row.order.status,
    currencyCode: row.order.currencyCode,
    subtotalMinor: row.order.subtotalMinor,
    sellerAmountMinor: row.order.sellerAmountMinor,
    createdAt: row.order.createdAt.toISOString(),
    itemCount: row.itemCount,
  }));
}

export async function businessAnalytics(business: BusinessProfile, marketId: string) {
  const listingIds = (await businessListingRows(business.id, marketId)).map((row) => row.offer.id);
  const [listingCounts] = await db
    .select({
      total: count(),
      published: sql<number>`count(*) filter (where ${offers.status} = 'PUBLISHED')::int`,
      paused: sql<number>`count(*) filter (where ${offers.status} = 'PAUSED')::int`,
    })
    .from(businessListingLinks)
    .innerJoin(offers, eq(offers.id, businessListingLinks.listingId))
    .where(and(eq(businessListingLinks.businessId, business.id), eq(businessListingLinks.marketId, marketId)));
  if (!listingIds.length)
    return { listings: Number(listingCounts?.total ?? 0), published: 0, paused: 0, completedOrders: 0, completedRevenueMinor: 0 };
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
  return {
    listings: Number(listingCounts?.total ?? 0),
    published: Number(listingCounts?.published ?? 0),
    paused: Number(listingCounts?.paused ?? 0),
    completedOrders: Number(orderStats?.completedOrders ?? 0),
    completedRevenueMinor: Number(orderStats?.completedRevenueMinor ?? 0),
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
  return row;
}
