import {
  validateCategoryAttributesAgainstSchema,
  type ListingPricingMode,
} from "@workspace/api-zod/marketplace-schemas";
import {
  TAGGED_PRICE_REPRESENTATIONS,
  acceptsPriceProposals,
  defaultRepresentationFor,
  priceRepresentationOf,
  storedPricingFor,
  type PriceRepresentation,
  type TaggedPriceRepresentation,
} from "@workspace/api-zod/listing-pricing";
import {
  ChangeListingStatusBody,
  UpdateListingBody,
} from "@workspace/api-zod";
import {
  db,
  markets,
  offers,
  orderItems,
  orders,
  users,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { applyInventoryModeUpdate } from "./commerce";
import {
  categorySchema,
  resolveMarketplaceCategory,
  type MarketplaceCategoryRow,
} from "./marketplace-categories";
import {
  freezeReviewedListingPhotos,
  isOwnedListingPhotoPath,
  makeListingPhotosPublic,
  replaceListingPhotoReferences,
  validateListingPhotoPathsForOwner,
} from "./listing-photos";
import { findListingContactText, listingContactTextRefusal, normalizeListingContactPhone } from "./listing-contact";
import { listing } from "./marketplace-listings";
import { assertMarketActive, resolveMarket } from "./markets";
import { assertListingPublicationPolicy } from "./publication-policy";
import { parseMinorUnits } from "./market-pricing";
import { PROVIDER_CONTROLLED_FIELDS, listingSource, sourceControlledMessage } from "./provider-source";
import type { marketFor } from "./markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
type ListingUpdate = z.infer<typeof UpdateListingBody>;
type ListingStatusAction = z.infer<typeof ChangeListingStatusBody>;

const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

export function parseListingPriceMinor(
  amount: string,
  currencyCode: string,
): number {
  let minor: number;
  try {
    minor = parseMinorUnits(amount, currencyCode);
  } catch {
    throw fail(400, "سعر الوحدة غير صالح");
  }
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > 2_000_000_000)
    throw fail(400, "سعر الوحدة يجب أن يكون أكبر من صفر وضمن الحد المسموح");
  return minor;
}

export function resolveListingBehavior(
  category: MarketplaceCategoryRow,
  body: {
    pricingMode?: ListingPricingMode;
    priceRepresentation?: PriceRepresentation;
    negotiable?: boolean;
    unitPrice: string | null;
    inventoryMode: "LIMITED" | "UNLIMITED";
    availableQuantity?: number | null;
  },
  currencyCode: string,
  /** The stored listing on an update: an edit that does not name a representation keeps it. */
  current?: Pick<typeof offers.$inferSelect, "pricingMode" | "unitPriceMinor" | "data">,
): {
  pricingMode: ListingPricingMode;
  unitPriceMinor: number | null;
  priceRepresentation: TaggedPriceRepresentation | null;
} {
  const rules = categorySchema(category).rules;
  if (body.unitPrice !== null && typeof body.unitPrice !== "string")
    throw fail(400, "سعر الوحدة مطلوب لهذا التصنيف.");
  const unitPriceMinor =
    body.unitPrice === null ? null : parseListingPriceMinor(body.unitPrice, currencyCode);
  if (
    unitPriceMinor !== null &&
    (unitPriceMinor < rules.pricing.minAmountMinor ||
      unitPriceMinor > rules.pricing.maxAmountMinor)
  )
    throw fail(400, "سعر الوحدة خارج النطاق المعتمد لهذا التصنيف.");

  // An explicit pricingMode that disagrees with the named representation wins (older clients
  // change only pricingMode). An update naming neither keeps a stored starting/quote meaning.
  const explicit = body.priceRepresentation;
  const storedMode = (representation: PriceRepresentation) =>
    (TAGGED_PRICE_REPRESENTATIONS as readonly string[]).includes(representation) ? "OPEN_TO_OFFERS" : representation;
  const kept = current ? priceRepresentationOf(current) : null;
  const representation: PriceRepresentation =
    explicit && (!body.pricingMode || storedMode(explicit) === body.pricingMode)
      ? explicit
      : !explicit &&
          kept &&
          (TAGGED_PRICE_REPRESENTATIONS as readonly string[]).includes(kept) &&
          (body.pricingMode === undefined || body.pricingMode === "OPEN_TO_OFFERS") &&
          !("problem" in storedPricingFor(kept, unitPriceMinor))
        ? kept
        : defaultRepresentationFor({ pricingMode: body.pricingMode, negotiable: body.negotiable, unitPriceMinor });
  const stored = storedPricingFor(representation, unitPriceMinor);
  if ("problem" in stored)
    throw fail(400, unitPriceMinor === null && (representation === "FIXED" || representation === "NEGOTIABLE")
      ? "سعر الوحدة مطلوب لهذا التصنيف."
      : stored.problem);
  if (!rules.pricing.allowedModes.includes(stored.pricingMode))
    throw fail(400, "طريقة التسعير غير مسموحة لهذا التصنيف.");
  const pricingMode = stored.pricingMode;

  const inventory = rules.inventory;
  if (!inventory.allowedModes.includes(body.inventoryMode))
    throw fail(400, "طريقة إدارة المخزون غير مسموحة لهذا التصنيف.");
  if (
    inventory.semantics === "NON_STOCK" &&
    (body.inventoryMode !== "UNLIMITED" || body.availableQuantity != null)
  )
    throw fail(400, "هذا التصنيف لا يستخدم كمية مخزون.");
  if (
    inventory.semantics === "SINGLE" &&
    (body.inventoryMode !== "LIMITED" || body.availableQuantity !== 1)
  )
    throw fail(400, "هذا التصنيف مخصص لعرض وحدة واحدة.");
  if (body.inventoryMode === "LIMITED") {
    if (
      !Number.isSafeInteger(body.availableQuantity) ||
      body.availableQuantity! < 1 ||
      body.availableQuantity! > 1_000_000
    )
      throw fail(400, "الكمية غير صالحة.");
  } else if (body.availableQuantity != null) {
    throw fail(400, "لا ترسل كمية عند اختيار مخزون غير محدود.");
  }
  return { pricingMode, unitPriceMinor, priceRepresentation: stored.priceRepresentation };
}

/** Listing data with its representation marker: set for STARTING_FROM/QUOTE_REQUIRED, removed otherwise. */
export function withPriceRepresentation<T extends Record<string, unknown>>(
  data: T,
  representation: TaggedPriceRepresentation | null,
): T {
  const { priceRepresentation: _previous, ...rest } = data;
  return (representation ? { ...rest, priceRepresentation: representation } : rest) as T;
}

export async function validateListingImages(
  imageUrl: string | undefined,
  imageUrls: string[] | undefined,
  ownerId: string,
) {
  const images = [imageUrl, ...(imageUrls ?? [])].filter(
    (url): url is string => Boolean(url?.trim()),
  );
  if (images.some((url) => !/^(https:\/\/|\/[^/])/.test(url)))
    throw fail(400, "رابط الصورة غير صالح");

  const objectPaths = images.filter((url) =>
    url.startsWith("/objects/listing-photos/"),
  );
  if (
    images.some(
      (url) =>
        url.startsWith("/objects/") &&
        !isOwnedListingPhotoPath(url, ownerId),
    )
  )
    throw fail(403, "لا يمكن استخدام صورة تخص حسابًا آخر.");
  await validateListingPhotoPathsForOwner(objectPaths, ownerId);
  return objectPaths;
}

async function ownedListing(
  tx: any,
  listingId: string,
  ownerId: string,
  marketId: string,
  lock = false,
) {
  let query = tx
    .select()
    .from(offers)
    .where(and(eq(offers.id, listingId), eq(offers.marketId, marketId)));
  if (lock) query = query.for("update");
  const [row] = await query;
  if (!row || row.sellerId !== ownerId)
    throw fail(404, "العرض غير موجود");
  if (!["PUBLISHED", "PAUSED"].includes(row.status))
    throw fail(409, "لا يمكن إدارة العرض في حالته الحالية");
  return row;
}

export async function updateOwnedListing(
  input: {
    listingId: string;
    ownerId: string;
    market: Market;
    body: ListingUpdate;
    expectedUpdatedAt?: string;
    /** Only the provider sync path (G1) may change provider-controlled fields. */
    source?: "PROVIDER";
  },
  tx: any = db,
) {
  const { listingId, ownerId, market, body } = input;
  if (
    body.city !== undefined &&
    (typeof body.city !== "string" || body.city.length > 100)
  )
    throw fail(400, "المدينة غير صالحة");

  // A phone in the text would bypass the order-bound contact release (lib/contact-release.ts).
  const editedText = [body.title, body.description].filter((value): value is string => typeof value === "string").join("\n");
  if (editedText && findListingContactText(editedText, market.id)) throw listingContactTextRefusal();
  const row = await ownedListing(tx, listingId, ownerId, market.id, true);
  if (
    input.expectedUpdatedAt &&
    row.updatedAt.toISOString() !== input.expectedUpdatedAt
  )
    throw fail(409, "تغيّر العرض منذ المعاينة. حدّثه ثم أعد المحاولة.");

  const [marketRow] = await tx
    .select()
    .from(markets)
    .where(eq(markets.id, row.marketId));
  const currentMarket = await resolveMarket(marketRow, tx);
  assertMarketActive(currentMarket);
  if (input.source !== "PROVIDER" && (await listingSource(row.id, tx)) === "PROVIDER") {
    const changed = providerFieldChanges(buildListingUpdateBody(row, currentMarket), body, currentMarket);
    if (changed.length)
      throw Object.assign(fail(409, sourceControlledMessage(changed)), { code: "SOURCE_CONTROLLED" });
  }
  const category = await resolveMarketplaceCategory(
    body.categoryId ?? row.data.categoryId,
    body.category,
    tx,
  );
  if (!category) throw fail(400, "التصنيف غير صالح أو غير نشط");
  const attributes = validateCategoryAttributesAgainstSchema(
    category.label,
    body.attributes ?? row.data.attributes ?? {},
    categorySchema(category),
    true,
  );
  if (!attributes.ok) throw fail(400, attributes.reason);
  if (attributes.missing.length)
    throw fail(
      400,
      `أكمل خصائص العرض المطلوبة: ${attributes.missing.join("، ")}`,
    );
  const mergedData = {
    ...row.data,
    ...body,
    city: body.city ?? row.data.city ?? "",
    attributes: attributes.attributes,
  };
  const imageUrls = Array.isArray(mergedData.imageUrls)
    ? mergedData.imageUrls.filter(
        (value: unknown): value is string => typeof value === "string",
      )
    : undefined;
  const photoPaths = await validateListingImages(
    typeof mergedData.imageUrl === "string" ? mergedData.imageUrl : undefined,
    imageUrls,
    ownerId,
  );
  const reviewedPhotos = await assertListingPublicationPolicy(
    {
      market: currentMarket,
      sellerId: ownerId,
      category,
      fulfilmentType: String(mergedData.fulfilmentType ?? ""),
      data: mergedData,
    },
    tx,
  );
  const behavior = resolveListingBehavior(
    category,
    body,
    currentMarket.currencyCode,
    row,
  );
  const [seller] = await tx.select().from(users).where(eq(users.id, ownerId));
  if (!seller) throw fail(404, "الحساب غير موجود");
  const item = listing(row, seller, currentMarket, true);
  const inventory = applyInventoryModeUpdate(
    item,
    body.inventoryMode,
    body.availableQuantity,
  );
  if (!inventory.ok) throw fail(409, inventory.message);
  const contactPhone =
    body.contactPhone === undefined
      ? row.data.contactPhone ?? null
      : normalizeListingContactPhone(body.contactPhone);
  const finalPhotoPaths = reviewedPhotos
    ? await freezeReviewedListingPhotos(reviewedPhotos, ownerId)
    : photoPaths;
  const updatedData = reviewedPhotos
    ? replaceListingPhotoReferences(mergedData, finalPhotoPaths)
    : mergedData;
  await makeListingPhotosPublic(finalPhotoPaths, ownerId);

  const [updated] = await tx
    .update(offers)
    .set({
      unitPriceMinor: behavior.unitPriceMinor,
      pricingMode: behavior.pricingMode,
      data: {
        ...withPriceRepresentation(updatedData, behavior.priceRepresentation),
        pricingMode: behavior.pricingMode,
        contactPhone,
        category: category.label,
        categoryId: category.id,
      },
      inventoryMode: item.inventoryMode,
      availableQuantity: item.availableQuantity,
      updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
    })
    .where(eq(offers.id, row.id))
    .returning();
  return { row: updated, market: currentMarket, seller };
}

export async function changeOwnedListingStatus(
  input: {
    listingId: string;
    ownerId: string;
    market: Market;
    action: ListingStatusAction["action"];
    expectedUpdatedAt?: string;
  },
  tx: any = db,
) {
  const row = await ownedListing(
    tx,
    input.listingId,
    input.ownerId,
    input.market.id,
    true,
  );
  if (
    input.expectedUpdatedAt &&
    row.updatedAt.toISOString() !== input.expectedUpdatedAt
  )
    throw fail(409, "تغيّر العرض منذ المعاينة. حدّثه ثم أعد المحاولة.");

  if (input.action === "PAUSE" && row.status === "PAUSED")
    return { row, market: input.market };
  if (input.action === "RESUME" && row.status === "PUBLISHED")
    return { row, market: input.market };
  if (
    (input.action === "PAUSE" && row.status !== "PUBLISHED") ||
    (input.action === "RESUME" && row.status !== "PAUSED")
  )
    throw fail(409, "لا يمكن تغيير حالة العرض الحالية");

  let reviewedData: Record<string, any> | undefined;
  if (input.action === "RESUME") {
    assertMarketActive(input.market);
    const category = await resolveMarketplaceCategory(
      typeof row.data.categoryId === "string" ? row.data.categoryId : undefined,
      typeof row.data.categoryId === "string"
        ? undefined
        : String(row.data.category ?? ""),
      tx,
    );
    if (!category) throw fail(409, "تصنيف العرض لم يعد نشطًا");
    const reviewedPhotos = await assertListingPublicationPolicy(
      {
        market: input.market,
        sellerId: input.ownerId,
        category,
        fulfilmentType: String(row.data.fulfilmentType ?? ""),
        data: row.data,
      },
      tx,
    );
    if (reviewedPhotos) {
      const finalPhotoPaths = await freezeReviewedListingPhotos(
        reviewedPhotos,
        input.ownerId,
      );
      await makeListingPhotosPublic(finalPhotoPaths, input.ownerId);
      reviewedData = replaceListingPhotoReferences(row.data, finalPhotoPaths);
    }
  }
  const [updated] = await tx
    .update(offers)
    .set({
      status: input.action === "PAUSE" ? "PAUSED" : "PUBLISHED",
      updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
      ...(reviewedData ? { data: reviewedData } : {}),
    })
    .where(eq(offers.id, row.id))
    .returning();
  return { row: updated, market: input.market };
}

export async function archiveOwnedListing(
  input: {
    listingId: string;
    ownerId: string;
    market: Market;
    expectedUpdatedAt?: string;
  },
  tx: any = db,
) {
  const row = await tx
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.id, input.listingId),
        eq(offers.marketId, input.market.id),
      ),
    )
    .for("update")
    .then((rows: (typeof offers.$inferSelect)[]) => rows[0]);
  if (!row || row.sellerId !== input.ownerId)
    throw fail(404, "العرض غير موجود");
  if (input.expectedUpdatedAt && row.updatedAt.toISOString() !== input.expectedUpdatedAt)
    throw fail(409, "تغيّر العرض منذ المعاينة. حدّثه ثم أعد المحاولة.");
  if (row.status === "ARCHIVED") return row;
  if (!["PUBLISHED", "PAUSED"].includes(row.status))
    throw fail(409, "لا يمكن أرشفة العرض في حالته الحالية");
  if (row.reservedQuantity > 0)
    throw fail(409, "لا يمكن أرشفة عرض عليه كمية محجوزة");

  const openOrders = await tx
    .select({ id: orders.id })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.offerId, row.id),
        inArray(orders.status, [
          "CREATED",
          "PAYMENT_PENDING",
          "PAID",
          "ACCEPTED",
          "IN_PROGRESS",
          "SELLER_MARKED_DELIVERED",
          "BUYER_CONFIRMED",
          "DISPUTED",
        ]),
      ),
    )
    .limit(1);
  if (openOrders.length)
    throw fail(409, "أكمل الطلبات القائمة أو عالج النزاع قبل أرشفة العرض");

  const [archived] = await tx
    .update(offers)
    .set({ status: "ARCHIVED", updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)) })
    .where(eq(offers.id, row.id))
    .returning();
  return archived;
}

export function buildListingUpdateBody(
  row: typeof offers.$inferSelect,
  market: Market,
): ListingUpdate {
  const representation = priceRepresentationOf(row);
  return UpdateListingBody.parse({
    title: row.data.title,
    description: row.data.description,
    category: row.data.category,
    ...(typeof row.data.categoryId === "string"
      ? { categoryId: row.data.categoryId }
      : {}),
    area: row.data.area ?? "",
    city: row.data.city ?? "",
    attributes: row.data.attributes ?? {},
    unitPrice:
      row.unitPriceMinor === null
        ? null
        : (row.unitPriceMinor / 10 ** market.minorUnitScale).toFixed(
            market.minorUnitScale,
          ),
    pricingMode: row.pricingMode as ListingPricingMode,
    ...(representation ? { priceRepresentation: representation } : {}),
    inventoryMode: row.inventoryMode,
    availableQuantity: row.availableQuantity,
    fulfilmentType: row.data.fulfilmentType,
    imageUrl: row.data.imageUrl ?? "",
    imageUrls: Array.isArray(row.data.imageUrls) ? row.data.imageUrls : [],
    contactPhone: row.data.contactPhone ?? null,
    negotiable: acceptsPriceProposals(representation),
  });
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  ) ?? "null";

/** Provider-controlled fields a seller-side update would change; omitted optional fields keep their value. */
function providerFieldChanges(current: ListingUpdate, next: ListingUpdate, market: Market): string[] {
  return PROVIDER_CONTROLLED_FIELDS.filter((field) => {
    const after = next[field];
    if (after === undefined) return false;
    const before = current[field];
    if (field === "unitPrice")
      return (before === null ? null : parseListingPriceMinor(String(before), market.currencyCode)) !==
        (after === null ? null : parseListingPriceMinor(String(after), market.currencyCode));
    return canonical(before ?? null) !== canonical(after ?? null);
  });
}

export function listingManagementError(status: number, message: string) {
  return fail(status, message);
}