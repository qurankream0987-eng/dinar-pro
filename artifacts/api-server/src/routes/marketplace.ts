import { sellerDuesView } from "../lib/seller-dues";
import {
  validateCategoryAttributesAgainstSchema,
  type SearchSort,
} from "@workspace/api-zod/marketplace-schemas";
import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { attributeOrderConversions } from "../lib/promotion-attribution";
import {
  db,
  users,
  offers,
  carts,
  cartItems,
  orders,
  orderItems,
  deliveryProgressEvents,
  conversations,
  messages,
  disputes,
  sellerDues,
  checkoutRequests,
  paymentIntents,
  businessOperatingProfiles,
} from "@workspace/db";
import { and, eq, or, inArray, desc, lte, sql } from "drizzle-orm";
import { OPEN_ORDER_STATUSES } from "../lib/moderation";
import { phoneVerificationDeferred } from "../lib/auth";
/** Owner decision 2026-11-26: open orders allowed to a buyer whose phone is not verified. */
const UNVERIFIED_PHONE_OPEN_ORDER_LIMIT = 2;
import {
  CreateListingBody,
  UpdateListingBody,
  ChangeListingStatusBody,
  CheckoutCartBody,
  CreateOrderBody,
  SendOrderMessageBody,
  MarkOrderDeliveredBody,
  ConfirmOrderBody,
  CancelOrderBody,
  EnterOrderHandoverCodeBody,
  ReportOrderNotCompletedBody,
} from "@workspace/api-zod";
import { z } from "zod";
import { counterpartContact, setSettlementPreference, SETTLEMENT_METHODS } from "../lib/order-settlement";
import { requireAuth } from "../lib/auth";
import { applyTerminalOrderAccounting } from "../lib/order-terminal-accounting";
import { expireOrderReservation } from "../lib/order-expiry";
import { recordCourierCommissionAccrual } from "../lib/courier-economics";
import { EXECUTABLE_ORDER, getDeliveryView, orderHandoff, settleOrderFulfillment } from "../lib/delivery";
import {
  closureView,
  ensureHandoverCode,
  enterHandoverCode,
  recordBuyerConfirmation,
  reportNotCompleted,
  sellWithoutCode,
} from "../lib/order-closure";
import { marketAllowsCashDirect } from "../lib/market-capability-registry";
import { enqueuePublishedOfferEmailsBestEffort } from "../lib/notification-email-outbox";
import {
  getOrderTrackingView,
  type OrderTrackingProvider,
} from "../lib/order-tracking";
import { checkoutIssueMessage, planCheckout, type PlannedCheckoutLine } from "../lib/commerce";
import { acceptedNegotiationForCheckout, consumeNegotiation, resolveCommercialUnitPrice, type Negotiation } from "../lib/negotiations";
import { marketFor, assertMarketActive, assertMarketPolicy } from "../lib/markets";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
import { assertMinorProtection, requireCommercialCapability } from "../lib/compliance";
import {
  calculateCommissionMinor,
  commissionSnapshot,
  resolveCommissionPolicy,
} from "../lib/commission-policy";
import {
  commissionReversalsByOrder,
  netCommissionDueMinor,
  recordOrderFinancialEvent,
} from "../lib/order-journal";
import {
  inactiveBusinessListingIds,
  listing,
  offerRowsByIds,
  searchMarketplaceListings,
} from "../lib/marketplace-listings";
import {
  categorySchema,
  listMarketplaceCategories,
  resolveMarketplaceCategory,
} from "../lib/marketplace-categories";
import {
  getMarketplaceCart,
  replaceMarketplaceCart,
} from "../lib/marketplace-cart";
import {
  freezeReviewedListingPhotos,
  makeListingPhotosPublic,
  replaceListingPhotoReferences,
} from "../lib/listing-photos";
import { findListingContactText, listingContactTextRefusal, normalizeListingContactPhone } from "../lib/listing-contact";
import { getAuthorizedSellerContacts } from "../lib/contact-release";
import { assertPoliciesAccepted } from "../lib/policy-gate";
import { recordOrderDisputeOpened } from "../lib/payments/disputes";
import {
  activePolicyRules,
  assertListingPublicationPolicy,
  offerPolicyViolation,
} from "../lib/publication-policy";
import { ACCOUNT_STATUS } from "../lib/account-status";
import {
  archiveOwnedListing,
  changeOwnedListingStatus,
  resolveListingBehavior,
  updateOwnedListing,
  validateListingImages,
  withPriceRepresentation,
} from "../lib/listing-management";
import { assertPublishable, requireBusinessCapability } from "../lib/business-access";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

const router = Router();
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });
export const money = (amount: number, scale: number) =>
  (amount / 10 ** scale).toFixed(scale);
const LISTING_SORTS: readonly SearchSort[] = [
  "RELEVANCE",
  "PRICE_ASC",
  "PRICE_DESC",
  "NEWEST",
  "YEAR_ASC",
  "YEAR_DESC",
  "MILEAGE_ASC",
  "MILEAGE_DESC",
  "PROPERTY_SIZE_ASC",
  "PROPERTY_SIZE_DESC",
];
// Operational restriction only: this does not collect or settle money.
async function assertSellerCanReceive(sellerId: string, tx: any = db) {
  const raw = process.env.BDINAR_DUES_LIMITS_MINOR;
  if (!raw) return; // No commercial threshold has been approved yet.
  let limits: Record<string, number>;
  try {
    limits = JSON.parse(raw);
  } catch {
    throw fail(503, "إعداد المستحقات غير متاح");
  }
  if (
    !limits ||
    Array.isArray(limits) ||
    typeof limits !== "object" ||
    Object.entries(limits).some(
      ([currency, amount]) =>
        !/^[A-Z]{3}$/.test(currency) ||
        !Number.isSafeInteger(amount) ||
        amount < 1,
    )
  )
    throw fail(503, "إعداد المستحقات غير متاح");
  const dues = await tx
    .select()
    .from(sellerDues)
    .where(
      and(
        eq(sellerDues.sellerId, sellerId),
        inArray(sellerDues.status, ["PENDING", "OVERDUE"]),
      ),
    );
  const totals: Record<string, number> = {};
  for (const due of dues)
    totals[due.currencyCode] =
      (totals[due.currencyCode] ?? 0) + due.amountMinor;
  if (
    Object.entries(totals).some(
      ([currency, amount]) =>
        limits[currency] !== undefined && amount >= limits[currency],
    )
  )
    throw fail(
      409,
      "استقبال الطلبات ونشر عروض جديدة متوقف بسبب المستحقات. يمكنك إكمال طلباتك القائمة.",
    );
}
function orderView(row: typeof orders.$inferSelect) {
  return {
    ...row.data,
    id: row.id,
    buyerId: row.buyerId,
    sellerId: row.sellerId,
    marketId: row.marketId,
    countryCode: row.countryCode,
    priceVersionId: row.priceVersionId,
    unitPriceMinor: row.unitPriceMinor,
    subtotalMinor: row.subtotalMinor,
    platformFeeMinor: row.platformFeeMinor,
    sellerAmountMinor: row.sellerAmountMinor,
    commissionRateBps:
      typeof row.data.commissionRateBps === "number"
        ? row.data.commissionRateBps
        : 1_000,
    minorUnitScale: row.minorUnitScale,
    status: row.status,
    quantity: row.quantity,
    currency: row.currencyCode,
    unitPrice: money(row.unitPriceMinor, row.minorUnitScale),
    total: money(row.subtotalMinor, row.minorUnitScale),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function orderViews(rows: (typeof orders.$inferSelect)[], tx: any = db) {
  if (!rows.length) return [];
  const participantIds = [
    ...new Set(rows.flatMap((row) => [row.buyerId, row.sellerId])),
  ];
  const participants = await tx
    .select({ id: users.id, avatarObjectPath: users.avatarObjectPath })
    .from(users)
    .where(inArray(users.id, participantIds));
  const avatars = new Map(
    participants.map(
      (participant: { id: string; avatarObjectPath: string | null }) => [
        participant.id,
        participant.avatarObjectPath,
      ],
    ),
  );
  return rows.map((row) => ({
    ...orderView(row),
    buyerAvatarObjectPath: avatars.get(row.buyerId) ?? null,
    sellerAvatarObjectPath: avatars.get(row.sellerId) ?? null,
  }));
}
export async function releaseExpiredReservations(now = new Date()) {
  return db.transaction(async (tx) => {
    const expired = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.status, "CREATED"),
          lte(orders.reservationExpiresAt, now),
        ),
      )
      .orderBy(orders.reservationExpiresAt, orders.id)
      .limit(100)
      .for("update", { skipLocked: true });
    for (const row of expired) await expireOrderReservation(tx, row, now);
    return expired.length;
  });
}
router.get("/listings", async (req, res) => {
  const market = await marketFor(req);
  await assertMarketLegalCapability(market.id, "BROWSING");
  if (!market.isActive || !["ACTIVE", "LIMITED"].includes(market.status)) {
    res.json([]);
    return;
  }
  const own = req.query.own === "true";
  if (own && !req.actor) throw fail(401, "سجل الدخول");
  const requestedSort = req.query.sort;
  if (
    requestedSort !== undefined &&
    (typeof requestedSort !== "string" ||
      !LISTING_SORTS.includes(requestedSort as SearchSort))
  )
    throw fail(400, "ترتيب العروض غير صالح.");
  res.json(
    await searchMarketplaceListings(market, {
      ownSellerId: own ? req.actor!.id : undefined,
      search: String(req.query.search ?? ""),
      category: String(req.query.category ?? "") || undefined,
      categoryId: String(req.query.categoryId ?? "") || undefined,
      sort:
        typeof requestedSort === "string"
          ? (requestedSort as SearchSort)
          : undefined,
    }),
  );
});
router.patch("/listings/:id/status", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  const body = ChangeListingStatusBody.parse(req.body);
  const result = await db.transaction(async (tx) => {
    const outcome = await changeOwnedListingStatus(
      {
        listingId: String(req.params.id),
        ownerId: req.actor!.id,
        market,
        action: body.action,
      },
      tx,
    );
    return listing(outcome.row, req.actor!, outcome.market, true);
  });
  res.json(result);
});
router.delete("/listings/:id", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  const archived = await db.transaction((tx) =>
    archiveOwnedListing(
      {
        listingId: String(req.params.id),
        ownerId: req.actor!.id,
        market,
      },
      tx,
    ),
  );
  res.json(listing(archived, req.actor!, market, true));
});
router.get("/listings/:id", async (req, res) => {
  const market = await marketFor(req);
  await assertMarketLegalCapability(market.id, "BROWSING");
  assertMarketActive(market);
  const rows = await offerRowsByIds(market.id, [req.params.id]);
  const row = rows.find(
    ({ offer, seller }: any) =>
      offer.id === req.params.id &&
      seller.status === "ACTIVE" &&
      !market.restrictedCategories.includes(offer.data.category) &&
      !market.restrictedCategories.includes(offer.data.categoryId ?? "") &&
      (offer.status === "PUBLISHED" || offer.sellerId === req.actor?.id),
  );
  if (!row) throw fail(404, "العرض غير موجود");
  if (row.offer.sellerId !== req.actor?.id) {
    // A suspended or closed business's listings are not public, even by direct id.
    if ((await inactiveBusinessListingIds(market.id)).has(row.offer.id))
      throw fail(404, "العرض غير موجود");
    const categoriesById = new Map(
      (await listMarketplaceCategories(true)).map((item) => [item.id, item]),
    );
    if (
      offerPolicyViolation(
        await activePolicyRules(market.id),
        row.offer,
        categoriesById,
      )
    )
      throw fail(404, "العرض غير موجود");
  }
  res.json(listing(row.offer, row.seller, market, row.offer.sellerId === req.actor?.id));
});
/**
 * The Block B create-and-publish authority, shared by the seller form (POST /listings)
 * and the conversation (Block F5). Every validation, policy check and idempotency rule
 * lives here once; callers pass the authenticated actor row, never a client claim.
 */
export type TrustedListingContext = {
  /** Passed only by server services after business authorization; never read from a request body. */
  businessId?: string;
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;
};

export async function createListingForActor(
  actor: typeof users.$inferSelect,
  rawBody: unknown,
  idempotencyKey?: string,
  trusted?: TrustedListingContext,
) {
  const executor = trusted?.tx ?? db;
  const body = CreateListingBody.parse(rawBody);
  await assertSellerCanReceive(actor.id);
  const rawCity = (rawBody as { city?: unknown } | null)?.city;
  if (
    rawCity !== undefined &&
    (typeof rawCity !== "string" || rawCity.length > 100)
  )
    throw fail(400, "المدينة غير صالحة");
  const category = await resolveMarketplaceCategory(
    body.categoryId,
    body.category,
  );
  if (!category) throw fail(400, "التصنيف غير صالح أو غير نشط");
  const attributes = validateCategoryAttributesAgainstSchema(
    category.label,
    body.attributes,
    categorySchema(category),
    true,
  );
  if (!attributes.ok) throw fail(400, attributes.reason);
  if (attributes.missing.length)
    throw fail(400, `أكمل خصائص العرض المطلوبة: ${attributes.missing.join("، ")}`);
  await assertPoliciesAccepted(actor.id);
  const market = await marketFor({ actor });
  // The business association is applied inside the listing write trust boundary: the id comes
  // from a server service, never from the request, and capability + verification are rechecked.
  let business: typeof businessOperatingProfiles.$inferSelect | undefined;
  if (trusted?.businessId) {
    const [row] = await executor
      .select()
      .from(businessOperatingProfiles)
      .where(and(
        eq(businessOperatingProfiles.id, trusted.businessId),
        eq(businessOperatingProfiles.marketId, market.id),
      ))
      .limit(1);
    if (!row || row.ownerUserId !== actor.id) throw fail(404, "النشاط غير موجود");
    const access = await requireBusinessCapability({
      business: row,
      actorId: actor.id,
      marketId: market.id,
      capability: "business.catalog.publish",
    });
    assertPublishable(access);
    business = row;
  }
  // A phone in the text would bypass the order-bound contact release (lib/contact-release.ts).
  if (findListingContactText(`${body.title}\n${body.description ?? ""}`, market.id)) throw listingContactTextRefusal();
  const photoPaths = await validateListingImages(
    body.imageUrl,
    body.imageUrls,
    actor.id,
  );
  const reviewedPhotos = await assertListingPublicationPolicy({
    market,
    sellerId: actor.id,
    category,
    fulfilmentType: body.fulfilmentType,
    data: { ...body, attributes: attributes.attributes },
  });
  const behavior = resolveListingBehavior(
    category,
    body,
    market.currencyCode,
  );
  const contactPhone = normalizeListingContactPhone(body.contactPhone);
  const rawKey = idempotencyKey?.trim();
  if (rawKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawKey))
    throw fail(400, "مفتاح نشر العرض غير صالح");
  const listingId = rawKey || randomUUID();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        canonicalJson({
          title: body.title,
          description: body.description,
          category: category.label,
          categoryId: category.id,
          area: body.area,
          city: body.city ?? "",
          attributes: attributes.attributes,
          unitPrice: body.unitPrice,
          pricingMode: behavior.pricingMode,
          priceRepresentation: behavior.priceRepresentation,
          inventoryMode: body.inventoryMode,
          availableQuantity:
            body.inventoryMode === "LIMITED" ? body.availableQuantity : null,
          fulfilmentType: body.fulfilmentType,
          imageUrl: body.imageUrl,
          imageUrls: body.imageUrls ?? [],
          contactPhone,
          paymentMethods: body.paymentMethods ?? [],
          negotiable: body.negotiable === true,
          businessId: business?.id ?? null,
        }),
      ),
    )
    .digest("hex");

  const existingFingerprint = (row: typeof offers.$inferSelect) =>
    (row.data as Record<string, unknown>).__publishFingerprint;
  const completePublish = async (
    row: typeof offers.$inferSelect,
    photoPaths: string[],
    reviewed: typeof reviewedPhotos,
  ) => {
    const finalPhotoPaths = reviewed
      ? await freezeReviewedListingPhotos(reviewed, actor.id)
      : photoPaths;
    const finalData = reviewed
      ? replaceListingPhotoReferences(
          row.data as Record<string, any>,
          finalPhotoPaths,
        )
      : undefined;
    await makeListingPhotosPublic(finalPhotoPaths, actor.id);
    const [published] = await executor
      .update(offers)
      .set({
        status: "PUBLISHED",
        businessProfileId: business?.d2BusinessId ?? null,
        ...(finalData ? { data: finalData } : {}),
      })
      .where(
        and(
          eq(offers.id, row.id),
          eq(offers.sellerId, actor.id),
          eq(offers.status, "DRAFT"),
        ),
      )
      .returning();
    if (published) {
      await enqueuePublishedOfferEmailsBestEffort(executor, published, market);
      return published;
    }
    const [current] = await executor
      .select()
      .from(offers)
      .where(eq(offers.id, row.id))
      .limit(1);
    if (
      current?.status === "PUBLISHED" &&
      current.sellerId === actor.id &&
      current.marketId === market.id &&
      existingFingerprint(current) === fingerprint
    )
      return current;
    throw fail(409, "تعذر إكمال نشر العرض. حدّث المسودة ثم أعد المحاولة.");
  };

  const existing = await executor
    .select()
    .from(offers)
    .where(eq(offers.id, listingId))
    .limit(1)
    .then((rows) => rows[0]);
  if (existing) {
    if (
      existing.sellerId !== actor.id ||
      existing.marketId !== market.id ||
      existingFingerprint(existing) !== fingerprint
    )
      throw fail(409, "مفتاح النشر مستخدم لبيانات أخرى.");
    if (existing.businessProfileId !== (business?.d2BusinessId ?? null))
      throw fail(409, "هذا العرض مرتبط بهوية نشاط مختلفة.");
    if (existing.status === "DRAFT") {
      const published = await completePublish(
        existing,
        photoPaths,
        reviewedPhotos,
      );
      return { status: 200 as const, listing: listing(published, actor, market, true) };
    }
    return { status: 200 as const, listing: listing(existing, actor, market, true) };
  }

  const [inserted] = await executor
    .insert(offers)
    .values({
      id: listingId,
      marketId: market.id,
      sellerId: actor.id,
      businessProfileId: business?.d2BusinessId ?? null,
      status: "DRAFT",
      unitPriceMinor: behavior.unitPriceMinor,
      pricingMode: behavior.pricingMode,
      inventoryMode: body.inventoryMode,
      availableQuantity:
        body.inventoryMode === "LIMITED" ? body.availableQuantity! : null,
      data: {
        ...withPriceRepresentation(body, behavior.priceRepresentation),
        pricingMode: behavior.pricingMode,
        contactPhone,
        category: category.label,
        categoryId: category.id,
        city: body.city ?? "",
        attributes: attributes.attributes,
        negotiable: body.negotiable === true,
        rating: 0,
        reviewCount: 0,
        __publishFingerprint: fingerprint,
      },
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    const published = await completePublish(
      inserted,
      photoPaths,
      reviewedPhotos,
    );
    return { status: 201 as const, listing: listing(published, actor, market, true) };
  }

  const [raced] = await executor
    .select()
    .from(offers)
    .where(eq(offers.id, listingId))
    .limit(1);
  if (
    !raced ||
    raced.sellerId !== actor.id ||
    raced.marketId !== market.id ||
    existingFingerprint(raced) !== fingerprint
  )
    throw fail(409, "مفتاح النشر مستخدم لبيانات أخرى.");
  if (raced.businessProfileId !== (business?.d2BusinessId ?? null))
    throw fail(409, "هذا العرض مرتبط بهوية نشاط مختلفة.");
  if (raced.status === "DRAFT") {
    const published = await completePublish(
      raced,
      photoPaths,
      reviewedPhotos,
    );
    return { status: 200 as const, listing: listing(published, actor, market, true) };
  }
  return { status: 200 as const, listing: listing(raced, actor, market, true) };
}
router.post("/listings", requireAuth, async (req, res) => {
  const created = await createListingForActor(req.actor!, req.body, req.get("Idempotency-Key"));
  res.status(created.status).json(created.listing);
});
router.patch("/listings/:id", requireAuth, async (req, res) => {
  const { expectedUpdatedAt, ...body } = UpdateListingBody.parse(req.body);
  if ("marketId" in req.body || "sellerId" in req.body)
    throw fail(400, "لا يمكن تغيير سوق العرض أو مالكه");
  const market = await marketFor(req);
  const result = await db.transaction(async (tx) => {
    const updated = await updateOwnedListing(
      {
        listingId: String(req.params.id),
        ownerId: req.actor!.id,
        market,
        body,
        expectedUpdatedAt,
      },
      tx,
    );
    return listing(updated.row, updated.seller, updated.market, true);
  });
  res.json(result);
});
router.use(
  ["/cart", "/checkout", "/orders", "/dashboard", "/seller-dues"],
  requireAuth,
);
// Bind queued browser intents to the authenticated actor who prepared them. The hint
// never grants access; legacy callers without it retain the authenticated API contract.
router.use("/cart", (req, res, next) => {
  const preparedFor = req.get("X-Dinar-Cart-Actor");
  if (preparedFor !== undefined && preparedFor !== req.actor!.id) {
    res.status(409).json({ error: "تغيّر الحساب. أعد تحميل السلة قبل المتابعة.", code: "CART_ACTOR_CHANGED" });
    return;
  }
  next();
});
router.get("/cart", async (req, res) => {
  const market = await marketFor(req);
  res.json(await getMarketplaceCart(req.actor!.id, market));
});
router.put("/cart", async (req, res) => {
  const result = await replaceMarketplaceCart(
    req.actor!.id,
    req.body.marketId,
    req.body.items,
  );
  res.json(result);
});
async function checkout(
  req: any,
  lines: any[],
  idempotencyKey: string,
  deliveryInstructions?: string,
) {
  const safeInstructions = deliveryInstructions?.trim().slice(0, 1000) || null;
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        items: lines.map(({ listingId, quantity, fulfilmentType }) => ({
          listingId,
          quantity,
          fulfilmentType,
        })),
        deliveryInstructions: safeInstructions,
      }),
    )
    .digest("hex");
  const result = await db.transaction(async (tx) => {
    const [actor] = await tx
      .select()
      .from(users)
      .where(eq(users.id, req.actor.id))
      .for("update");
    if (!actor) throw fail(401, "سجّل الدخول للمتابعة");
    const [previousRequest] = await tx
      .select()
      .from(checkoutRequests)
      .where(
        and(
          eq(checkoutRequests.userId, actor.id),
          eq(checkoutRequests.idempotencyKey, idempotencyKey),
        ),
      );
    if (previousRequest) {
      if (previousRequest.requestHash !== requestHash)
        throw fail(
          409,
          "مفتاح الطلب استُخدم لبيانات مختلفة. ابدأ محاولة جديدة.",
        );
      const cachedResponse = previousRequest.response as {
        orders: Array<{ id: string; [key: string]: unknown }>;
        total: string;
        currency: string;
      };
      const cachedIds = cachedResponse.orders.map((order) => order.id);
      const currentRows = cachedIds.length
        ? await tx.select().from(orders).where(inArray(orders.id, cachedIds))
        : [];
      const currentOrders = await orderViews(currentRows, tx);
      const currentById = new Map(
        currentOrders.map((order: { id: string }) => [order.id, order]),
      );
      return {
        ...cachedResponse,
        orders: cachedResponse.orders.map(
          (order) => currentById.get(order.id) ?? order,
        ),
      };
    }
    // Deferred phone verification (no SMS): a buyer whose phone is not verified may hold only a
    // few open orders at once, so a mistyped or false number cannot tie up many sellers.
    if (phoneVerificationDeferred() && !actor.phoneVerified) {
      const [open] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .where(and(eq(orders.buyerId, actor.id), inArray(orders.status, [...OPEN_ORDER_STATUSES])));
      if ((open?.n ?? 0) + lines.length > UNVERIFIED_PHONE_OPEN_ORDER_LIMIT)
        throw fail(
          409,
          `حسابك برقم هاتف غير موثّق، فيمكنك أن تملك ${UNVERIFIED_PHONE_OPEN_ORDER_LIMIT} طلبات مفتوحة كحد أقصى. أكمل طلباتك الحالية أو ألغِها أولًا.`,
        );
    }
    // Contract acceptance before a new order (an idempotent replay above still returns its order).
    await assertPoliciesAccepted(actor.id, tx);
    if (actor.status !== ACCOUNT_STATUS.active)
      throw fail(
        403,
        "حسابك مقيّد حاليًا. يمكنك متابعة طلباتك القائمة، ولا يمكن بدء عمليات شراء جديدة.",
      );
    const market = await marketFor({ actor }, tx, true);
    assertMarketActive(market);
    await assertMarketLegalCapability(market.id, "TRANSACTIONS", tx);
    await assertMarketLegalCapability(market.id, "CASH_PAYMENT", tx);
    if (lines.some((line) => line.fulfilmentType !== "PICKUP"))
      await assertMarketLegalCapability(market.id, "DELIVERY_OPERATIONS", tx);
    await assertMinorProtection(actor.id, market.id, tx);
    await requireCommercialCapability(market.id, "PAYMENTS", tx);
    if (!marketAllowsCashDirect(market)) throw fail(409, "لا توجد طريقة دفع متاحة في هذا السوق");
    const ids = [...new Set<string>(lines.map((l) => l.listingId))].sort();
    if (!ids.length) throw fail(400, "السلة فارغة");
    const locked = await tx
      .select()
      .from(offers)
      .where(inArray(offers.id, ids))
      .orderBy(offers.id)
      .for("update");
    if (
      locked.length !== ids.length ||
      locked.some((o) => o.marketId !== market.id)
    )
      throw fail(409, "لا يمكن خلط عروض أسواق مختلفة");
    const sellers = await tx
      .select()
      .from(users)
      .where(
        inArray(
          users.id,
          locked.map((o) => o.sellerId),
        ),
      );
    if (sellers.some((s) => s.status !== "ACTIVE"))
      throw fail(409, "البائع غير متاح");
    // A suspended or closed business's catalog is not purchasable, even when a buyer kept the
    // listing in the cart from before the suspension.
    const inactive = await inactiveBusinessListingIds(market.id, tx);
    if (locked.some((offer) => inactive.has(offer.id)))
      throw fail(409, "أحد العروض لم يعد متاحًا");
    for (const seller of sellers) await assertSellerCanReceive(seller.id, tx);
    for (const offer of locked)
      await assertMarketPolicy(
        market,
        offer.sellerId,
        offer.data.category,
        offer.data.fulfilmentType,
        tx,
        offer.data.categoryId,
      );
    const rules = await activePolicyRules(market.id, tx);
    const categoriesById = new Map(
      (await listMarketplaceCategories(true, tx)).map((row) => [row.id, row]),
    );
    if (
      locked.some((offer) =>
        offerPolicyViolation(rules, offer, categoriesById),
      )
    )
      throw fail(409, "أحد العروض لم يعد متاحًا وفق سياسة السوق");
    const listings = locked.map((o) =>
      listing(
        o,
        sellers.find((s) => s.id === o.sellerId)!,
        market,
      ),
    );
    const negotiated = new Map<string, Negotiation>();
    const listingById = new Map(listings.map((item) => [item.id, item]));
    const offerById = new Map(locked.map((item) => [item.id, item]));
    for (const line of lines) {
      const item = listingById.get(line.listingId);
      const offer = offerById.get(line.listingId);
      const accepted = await acceptedNegotiationForCheckout(tx, actor.id, line.listingId);
      const price = offer ? resolveCommercialUnitPrice(offer, accepted) : null;
      if (!item || !price)
        throw fail(409, "هذا العرض بلا سعر متفق عليه؛ تفاوض مع البائع أولًا");
      if (accepted) {
        if (accepted.marketId !== market.id || accepted.currencyCode !== market.currencyCode)
          throw fail(409, "السعر المتفق عليه لم يعد صالحًا في هذا السوق");
        if (line.quantity > accepted.quantity)
          throw fail(409, `السعر المتفق عليه يشمل ${accepted.quantity} فقط؛ عدّل الكمية`);
        negotiated.set(line.listingId, accepted);
      }
      item.unitPrice = money(price.unitPriceMinor, market.minorUnitScale);
      // planCheckout validates that the cart is directly purchasable. An accepted
      // negotiation authorizes this one buyer to purchase at its private agreed price,
      // without changing the public listing or its stored pricing mode.
      if (accepted) item.pricingMode = "FIXED";
    }
    const plan = planCheckout(lines, listings);
    if (!plan.ok)
      throw Object.assign(fail(409, checkoutIssueMessage(plan.issues)), {
        issues: plan.issues,
      });
    // G2: a price this buyer agreed with the seller is resolved here, on the server, from
    // the negotiation authority; the request never carries a price. The public listing
    // price is untouched, and commission below is computed on the agreed subtotal.
    const commissionPolicy = await resolveCommissionPolicy(tx, {
      marketId: market.id,
    });
    const created: (typeof orders.$inferSelect)[] = [];
    let grandTotal = 0;
    // orders.unit_price_minor is a single per-order price and the database enforces
    // subtotal = quantity × unit price, so one seller's differently priced lines become
    // separate orders. Same-priced lines still share one order.
    const orderGroups: Array<[string, PlannedCheckoutLine[]]> = [];
    for (const [sellerId, group] of plan.plan.groups) {
      const byPrice = new Map<number, PlannedCheckoutLine[]>();
      for (const line of group) {
        const lines = byPrice.get(line.unitPriceMinor) ?? [];
        lines.push(line);
        byPrice.set(line.unitPriceMinor, lines);
      }
      for (const lines of byPrice.values()) orderGroups.push([sellerId, lines]);
    }
    for (const [sellerId, group] of orderGroups) {
      const quantity = group.reduce((sum, l) => sum + l.quantity, 0);
      const subtotal = group.reduce(
        (sum, line) => sum + line.unitPriceMinor * line.quantity,
        0,
      );
      if (!Number.isSafeInteger(subtotal) || subtotal > 2000000000)
        throw fail(400, "الإجمالي يتجاوز الحد المسموح");
      const commissionRateBps = commissionPolicy.rateBasisPoints;
      const fee = calculateCommissionMinor(subtotal, commissionPolicy);
      const id = randomUUID();
      const first = group[0].listing;
      const reservationExpiresAt = new Date(Date.now() + 1800000);
      const items = group.map((l) => ({
        listingId: l.listing.id,
        listingTitle: l.listing.title,
        listingImageUrl: l.listing.imageUrl,
        quantity: l.quantity,
        unitPrice: money(l.unitPriceMinor, market.minorUnitScale),
        total: money(l.quantity * l.unitPriceMinor, market.minorUnitScale),
        currency: market.currencyCode,
        fulfilmentType: l.fulfilmentType,
        inventoryMode: l.listing.inventoryMode,
        paymentMethods: l.listing.paymentMethods,
      }));
      const [row] = await tx
        .insert(orders)
        .values({
          id,
          buyerId: actor.id,
          sellerId,
          marketId: market.id,
          countryCode: market.countryCode,
          priceVersionId: market.priceVersionId,
          currencyCode: market.currencyCode,
          minorUnitScale: market.minorUnitScale,
          unitPriceMinor: group[0].unitPriceMinor,
          quantity,
          subtotalMinor: subtotal,
          platformFeeMinor: fee,
          sellerAmountMinor: subtotal - fee,
          status: "CREATED",
          reservationExpiresAt,
          data: {
            items,
            listingId: first.id,
            listingTitle: items
              .map((i) => `${i.listingTitle} ×${i.quantity}`)
              .join(" · "),
            listingImageUrl: first.imageUrl,
            buyerName: actor.displayName,
            sellerName: first.sellerName,
            fulfilmentType:
              new Set(group.map((l) => l.fulfilmentType)).size === 1
                ? group[0].fulfilmentType
                : "MIXED",
            expiresAt: reservationExpiresAt.toISOString(),
            deliveryProof: null,
            issue: null,
            paymentMode: "TEST_NO_TRANSFER",
            commissionRateBps,
            commissionPolicy: commissionSnapshot(commissionPolicy),
            deliveryInstructions: safeInstructions,
            ...(group.some((line) => negotiated.has(line.listing.id))
              ? { negotiationIds: group.flatMap((line) => (negotiated.has(line.listing.id) ? [negotiated.get(line.listing.id)!.id] : [])) }
              : {}),
          },
        })
        .returning();
      for (const line of group) {
        const agreed = negotiated.get(line.listing.id);
        if (agreed) await consumeNegotiation(tx, agreed.id, id);
      }
      await tx.insert(orderItems).values(
        group.map((line, index) => ({
          id: randomUUID(),
          orderId: id,
          offerId: line.listing.id,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          subtotalMinor: line.quantity * line.unitPriceMinor,
          data: items[index],
        })),
      );
      await recordOrderFinancialEvent(tx, {
        orderId: id,
        eventType: "ORDER_CREATED",
        accountObligation: "BUYER_RECEIVABLE",
        businessRef: id,
        actorType: "BUYER",
        actorId: actor.id,
        currencyCode: market.currencyCode,
        amountMinor: subtotal,
        idempotencyKey: `order-created:${id}`,
        authorizationContext: {
          source: "CHECKOUT",
          marketId: market.id,
          checkoutIdempotencyKey: idempotencyKey,
        },
        data: {
          subtotalMinor: subtotal,
          platformFeeMinor: fee,
          commissionRateBps,
          commissionPolicy: commissionSnapshot(commissionPolicy),
          priceVersionId: market.priceVersionId,
        },
      });
      await tx.insert(conversations).values({ id, orderId: id });
      await tx.insert(messages).values({
        id: randomUUID(),
        conversationId: id,
        body: "تم إنشاء الطلب وحجز المخزون. هذه بيئة اختبار؛ لم يتم تحويل أي مبلغ.",
      });
      for (const line of group)
        if (line.listing.inventoryMode === "LIMITED")
          await tx
            .update(offers)
            .set({
              reservedQuantity: line.listing.reservedQuantity + line.quantity,
              updatedAt: new Date(),
            })
            .where(eq(offers.id, line.listing.id));
      created.push(row);
      grandTotal += subtotal;
    }
    const [cart] = await tx
      .select()
      .from(carts)
      .where(and(eq(carts.userId, actor.id), eq(carts.marketId, market.id)));
    if (cart)
      await tx
        .delete(cartItems)
        .where(
          and(eq(cartItems.cartId, cart.id), inArray(cartItems.offerId, ids)),
        );
    const response = {
      orders: await orderViews(created, tx),
      total: money(grandTotal, market.minorUnitScale),
      currency: market.currencyCode,
    };
    await tx.insert(checkoutRequests).values({
      userId: actor.id,
      idempotencyKey,
      requestHash,
      response,
    });
    return response;
  });
  // Paid-placement conversions are recorded after the canonical order commits; the order,
  // its price and its commission snapshot never depend on a campaign.
  const buyerId = req.actor?.id;
  const orderIds = ((result as { orders?: { id?: unknown }[] }).orders ?? []).map((order) => order.id).filter((id): id is string => typeof id === "string");
  if (buyerId && orderIds.length) {
    const [order] = await db.select({ marketId: orders.marketId }).from(orders).where(eq(orders.id, orderIds[0]!));
    if (order)
      await attributeOrderConversions({ buyerId, marketId: order.marketId, orderIds }).catch(() => 0);
  }
  return result;
}
/**
 * The same checkout authority for a caller that holds only the actor id (the Block F3
 * conversation). Every check, the current commission snapshot and the idempotency record are shared.
 */
export function checkoutForActor(
  actorId: string,
  lines: { listingId: string; quantity: number; fulfilmentType: string }[],
  idempotencyKey: string,
) {
  return checkout({ actor: { id: actorId } }, lines, idempotencyKey);
}
router.post("/checkout", async (req, res) => {
  const body = CheckoutCartBody.parse(req.body);
  res
    .status(201)
    .json(
      await checkout(
        req,
        body.items,
        body.idempotencyKey,
        body.deliveryInstructions,
      ),
    );
});
router.post("/orders", async (req, res) => {
  const body = CreateOrderBody.parse(req.body);
  const { idempotencyKey, deliveryInstructions, ...line } = body;
  const result = await checkout(
    req,
    [line],
    idempotencyKey,
    deliveryInstructions,
  );
  res.status(201).json(result.orders[0]);
});
router.get("/orders", async (req, res) => {
  const actor = req.actor!.id;
  const rows = await db
    .select()
    .from(orders)
    .where(
      req.query.role === "seller"
        ? eq(orders.sellerId, actor)
        : req.query.role === "buyer"
          ? eq(orders.buyerId, actor)
          : or(eq(orders.buyerId, actor), eq(orders.sellerId, actor)),
    )
    .orderBy(desc(orders.createdAt));
  res.json(
    await orderViews(
      rows.filter((o) => !req.query.status || o.status === req.query.status),
    ),
  );
});
async function authorizedOrder(
  req: any,
  tx: any = db,
  lock = false,
): Promise<typeof orders.$inferSelect> {
  let q = tx.select().from(orders).where(eq(orders.id, req.params.id));
  if (lock) q = q.for("update");
  const [row] = await q;
  if (!row || ![row.buyerId, row.sellerId].includes(req.actor.id))
    throw fail(404, "الطلب غير موجود");
  return row;
}
router.get("/orders/:id", async (req, res) => {
  const [view] = await orderViews([await authorizedOrder(req)]);
  const [dispute] = await db
    .select()
    .from(disputes)
    .where(eq(disputes.orderId, String(req.params.id)));
  res.json({ ...view, dispute: dispute ?? null });
});
router.get("/orders/:id/contact", async (req, res) => {
  res.set("Cache-Control", "private, no-store, no-cache, max-age=0");
  res.set("Pragma", "no-cache");
  const row = await authorizedOrder(req);
  if (row.buyerId !== req.actor!.id) throw fail(404, "بيانات التواصل غير متاحة");
  const release = await getAuthorizedSellerContacts({
    actorId: req.actor!.id,
    orderId: row.id,
    marketId: req.actor!.activeMarketId,
  });
  if (!release) throw fail(404, "بيانات التواصل غير متاحة");
  res.json(release);
});
// Buyer and seller of this order only: the other party's name and phone after the seller accepts,
// and the buyer's stated off-platform payment preference (information only, never a payment).
router.get("/orders/:id/counterpart-contact", async (req, res) => {
  res.set("Cache-Control", "private, no-store, no-cache, max-age=0");
  res.set("Pragma", "no-cache");
  const market = await marketFor(req);
  res.json(await counterpartContact({ actorId: req.actor!.id, orderId: String(req.params.id), marketId: market.id, countryCode: market.countryCode }));
});
router.put("/orders/:id/settlement-preference", async (req, res) => {
  const body = z.object({ method: z.enum(SETTLEMENT_METHODS) }).strict().parse(req.body);
  const market = await marketFor(req);
  res.json(await setSettlementPreference({ actorId: req.actor!.id, orderId: String(req.params.id), marketId: market.id, countryCode: market.countryCode, method: body.method }));
});
// Buyer and seller of this order only; the explicit delivery serializer, never a row spread.
router.get("/orders/:id/fulfillment", async (req, res) => {
  res.set("Cache-Control", "private, no-store, no-cache, max-age=0");
  res.set("Pragma", "no-cache");
  const market = await marketFor(req);
  res.json(
    await getDeliveryView({ actorId: req.actor!.id, orderId: String(req.params.id), market }),
  );
});
router.get("/orders/:id/tracking", async (req, res) => {
  res.set("Cache-Control", "private, no-store, no-cache, max-age=0");
  res.set("Pragma", "no-cache");
  const provider = req.app.locals.orderTrackingProvider as
    | OrderTrackingProvider
    | undefined;
  const market = await marketFor(req);
  res.json(
    await getOrderTrackingView({
      actorId: req.actor!.id,
      orderId: String(req.params.id),
      market,
      provider,
    }),
  );
});
router.get("/orders/:id/messages", async (req, res) => {
  const order = await authorizedOrder(req);
  const rows = await db
    .select({ message: messages, sender: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(eq(messages.conversationId, order.id))
    .orderBy(messages.createdAt);
  res.json(
    rows.map(({ message: m, sender }) => ({
      id: m.id,
      orderId: order.id,
      senderName: sender?.displayName ?? "النظام",
      senderRole: !m.senderId
        ? "SYSTEM"
        : sender?.role === "ADMIN"
          ? "ADMIN"
        : m.senderId === order.sellerId
          ? "SELLER"
          : "BUYER",
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      isMine: m.senderId === req.actor!.id,
    })),
  );
});
router.post("/orders/:id/messages", async (req, res) => {
  const order = await authorizedOrder(req);
  const body = SendOrderMessageBody.parse(req.body).body.trim();
  if (!body || body.length > 4000)
    throw fail(400, "الرسالة يجب أن تكون بين 1 و4000 حرف");
  const [m] = await db
    .insert(messages)
    .values({
      id: randomUUID(),
      conversationId: order.id,
      senderId: req.actor!.id,
      body,
    })
    .returning();
  res.status(201).json({
    id: m.id,
    orderId: order.id,
    senderName: req.actor!.displayName,
    senderRole: order.sellerId === req.actor!.id ? "SELLER" : "BUYER",
    body,
    createdAt: m.createdAt.toISOString(),
    isMine: true,
  });
});
// Deal closure (owner-approved design 2026-11-07, answers 2026-11-15): lib/order-closure.ts.
// Registered before "/orders/:id/:action" so these paths are not read as actions.
router.get("/orders/:id/closure", async (req, res) => {
  const view = await db.transaction(async (tx) => closureView(tx, await authorizedOrder(req, tx, true), req.actor!.id));
  res.setHeader("Cache-Control", "no-store");
  res.json(view);
});
router.post("/orders/:id/handover-code", async (req, res) => {
  const { code } = EnterOrderHandoverCodeBody.parse(req.body);
  // A wrong entry is committed (never rolled back), so the five-attempt limit holds across retries.
  const result = await db.transaction(async (tx) =>
    enterHandoverCode(tx, await authorizedOrder(req, tx, true), req.actor!.id, code, new Date()),
  );
  if (result.outcome === "REJECTED") {
    res.status(422).json({ error: "رمز التسليم غير صحيح", attemptsRemaining: result.attemptsRemaining });
    return;
  }
  if (result.outcome === "LOCKED") {
    res.status(423).json({ error: "قُفل رمز التسليم بعد خمس محاولات خاطئة. استخدم «تم البيع بدون رمز»." });
    return;
  }
  const [view] = await orderViews([result.order]);
  res.json(view);
});
router.post("/orders/:id/sold-without-code", async (req, res) => {
  const updated = await db.transaction(async (tx) =>
    sellWithoutCode(tx, await authorizedOrder(req, tx, true), req.actor!.id, new Date()),
  );
  const [view] = await orderViews([updated]);
  res.json(view);
});
router.post("/orders/:id/not-completed", async (req, res) => {
  const { outcome } = ReportOrderNotCompletedBody.parse(req.body);
  const updated = await db.transaction(async (tx) =>
    reportNotCompleted(tx, await authorizedOrder(req, tx, true), req.actor!.id, outcome, new Date()),
  );
  const [view] = await orderViews([updated]);
  res.json(view);
});
router.post("/orders/:id/:action", async (req, res) => {
  const result = await db.transaction(async (tx) => {
    const row = await authorizedOrder(req, tx, true);
    const action = req.params.action;
    const now = new Date();
    if (
      action === "accept" &&
      row.status === "CREATED" &&
      row.reservationExpiresAt &&
      row.reservationExpiresAt <= now
    ) {
      await expireOrderReservation(tx, row, now);
      return { expired: true as const };
    }
    let status = row.status;
    const data = { ...row.data };
    let system = "";
    if (
      (["accept", "delivery"].includes(action) &&
        row.sellerId !== req.actor!.id) ||
      (action === "confirm" && row.buyerId !== req.actor!.id)
    )
      throw fail(403, "هذا الإجراء غير متاح لدورك في الطلب");
    if (action === "accept") {
      if (status !== "CREATED")
        throw fail(409, "لا يمكن قبول الطلب في حالته الحالية");
      status = "ACCEPTED";
      data.acceptedAt = now.toISOString();
      system = "وافق البائع على الطلب. يظهر للمشتري وحده رمز تسليم من أربعة أرقام؛ لا تسلّم قبل استلام المبلغ والرمز معًا.";
    } else if (action === "delivery") {
      const body = MarkOrderDeliveredBody.parse(req.body);
      const handoff = await orderHandoff(tx, row, req.actor!.id, body, now);
      status = handoff.status;
      Object.assign(data, handoff.data);
      system = "تم رفع إثبات التسليم";
    } else if (action === "confirm") {
      const body = ConfirmOrderBody.parse(req.body);
      if (status === "COMPLETED" && body.received)
        return { expired: false as const, order: (await orderViews([row], tx))[0] };
      // The buyer's «استلمت» alone closes the deal from acceptance on (owner decision
      // 2026-11-07/15); a dispute still needs the seller's recorded delivery first.
      if (
        status !== "SELLER_MARKED_DELIVERED" &&
        !(body.received && EXECUTABLE_ORDER.includes(status))
      )
        throw fail(409, "انتظر إثبات التسليم");
      if (body.received) await recordBuyerConfirmation(tx, row, req.actor!.id);
      status = body.received ? "COMPLETED" : "DISPUTED";
      data.issue = body.dispute
        ? `${body.dispute.reason}: ${body.dispute.description}${body.dispute.evidence.length ? ` — الدليل: ${body.dispute.evidence.join(" · ")}` : ""}`
        : body.issue;
      if (!body.received) {
        if (!body.dispute && (!body.issue || body.issue.trim().length < 5))
          throw fail(400, "صف سبب النزاع بوضوح");
        const [openedDispute] = await tx
          .insert(disputes)
          .values({
          id: randomUUID(),
          orderId: row.id,
          openedBy: req.actor!.id,
          reason:
            body.dispute?.reason ??
            (body.issue!.includes(": ")
              ? body.issue!.split(": ")[0]
              : "سبب آخر"),
          description:
            body.dispute?.description ?? body.issue!.split(" — الدليل: ")[0],
          evidence: (
            body.dispute?.evidence ??
            (body.issue!.includes(" — الدليل: ")
              ? [body.issue!.split(" — الدليل: ").slice(1).join(" — الدليل: ")]
              : [])
          ).map((reference) => ({
            type: "TEXT",
            reference,
            submittedBy: req.actor!.id,
            createdAt: now.toISOString(),
          })),
          })
          .returning();
        await recordOrderDisputeOpened(tx, row, openedDispute);
      } else {
        await tx.insert(deliveryProgressEvents).values({
          id: randomUUID(),
          orderId: row.id,
          marketId: row.marketId,
          assignmentId: null,
          actorId: req.actor!.id,
          type: "BUYER_RECEIVED",
        }).onConflictDoNothing();
      }
      system = body.received ? "أكد المشتري الاستلام" : "فتح المشتري نزاعًا";
    } else if (action === "cancel") {
      const body = CancelOrderBody.parse(req.body);
      if (status !== "CREATED")
        throw fail(409, "لا يمكن الإلغاء بعد بدء التنفيذ");
      // The order row is locked above and capture locks it too, so this read cannot race a capture.
      // Cancelling would release the stock while the captured money stays recorded.
      const [paid] = await tx
        .select({ id: paymentIntents.id })
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.orderId, row.id),
            sql`${paymentIntents.capturedAmountMinor} > ${paymentIntents.refundedAmountMinor}`,
          ),
        );
      if (paid)
        throw fail(409, "تم تحصيل دفعة لهذا الطلب؛ لا يمكن إلغاؤه قبل استردادها");
      status = "CANCELLED";
      data.issue = body.reason;
      system = "تم إلغاء الطلب وإعادة المخزون";
    } else throw fail(404, "الإجراء غير موجود");
    if (["COMPLETED", "CANCELLED"].includes(status)) {
      // Read fulfilment before terminal cleanup so only an already-delivered courier
      // trip can create its receivable; dispute resolution alone is not delivery.
      if (status === "COMPLETED") await recordCourierCommissionAccrual(tx, row, now);
      await applyTerminalOrderAccounting(
        tx,
        row,
        status as "COMPLETED" | "CANCELLED",
        now,
      );
    }
    const [updated] = await tx
      .update(orders)
      .set({ status, data, updatedAt: new Date() })
      .where(eq(orders.id, row.id))
      .returning();
    if (action === "accept") await ensureHandoverCode(tx, updated);
    await tx
      .insert(messages)
      .values({ id: randomUUID(), conversationId: row.id, body: system });
    const [view] = await orderViews([updated], tx);
    return { expired: false as const, order: view };
  });
  if (result.expired) {
    res.status(409).json({ error: "انتهت مهلة قبول الطلب وأُعيد المخزون." });
    return;
  }
  res.json(result.order);
});
router.get("/seller-dues", async (req, res) => {
  res.json(await sellerDuesView(req.actor!.id));
});
router.get("/dashboard", async (req, res) => {
  const market = await marketFor(req);
  const mine = await db
    .select()
    .from(offers)
    .where(
      and(eq(offers.sellerId, req.actor!.id), eq(offers.marketId, market.id)),
    );
  const sales = await db
    .select()
    .from(orders)
    .where(
      and(eq(orders.sellerId, req.actor!.id), eq(orders.marketId, market.id)),
    )
    .orderBy(desc(orders.createdAt));
  const dues = await db
    .select()
    .from(sellerDues)
    .where(
      and(
        eq(sellerDues.sellerId, req.actor!.id),
        eq(sellerDues.currencyCode, market.currencyCode),
        eq(sellerDues.status, "PENDING"),
      ),
    );
  const reversals = await commissionReversalsByOrder(
    dues.map((due) => due.orderId),
  );
  res.json({
    userName: req.actor!.displayName,
    activeListings: mine.filter((o) => o.status === "PUBLISHED").length,
    activeOrders: sales.filter((o) =>
      [
        "CREATED",
        "ACCEPTED",
        "IN_PROGRESS",
        "SELLER_MARKED_DELIVERED",
      ].includes(o.status),
    ).length,
    completedOrders: sales.filter((o) => o.status === "COMPLETED").length,
    pendingDues: dues.length,
    pendingDuesAmount: money(
      dues.reduce(
        (s, d) =>
          s + netCommissionDueMinor(d.amountMinor, reversals.get(d.orderId) ?? 0),
        0,
      ),
      market.minorUnitScale,
    ),
    recentOrders: sales.slice(0, 3).map(orderView),
    sellerStats: {
      sales: sales.filter((o) => o.status === "COMPLETED").length,
      rating: 0,
      responseRate: 0,
    },
  });
});
export default router;
