import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { aiResultSets, aiUiBlocks, cartItems, carts, conversations, db, messages, users } from "@workspace/db";
import { isMarketAvailable, marketFor } from "./markets";
import { categoryById } from "./marketplace-categories";
import { listing, offerRows } from "./marketplace-listings";
import { acceptedAgreementsByListing } from "./negotiations";
import { directPurchaseAllowed, priceRepresentationOf } from "@workspace/api-zod/listing-pricing";

type ResolvedMarket = Awaited<ReturnType<typeof marketFor>>;
type CartLine = { listingId: string; quantity: number };

const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

/** Same rule as checkout: only a definite asking price (FIXED) is bought without an agreement. */
export const CART_NEEDS_AGREEMENT =
  "سعر هذا الإعلان قابل للتفاوض؛ اتفق مع البائع على السعر قبل إضافته إلى السلة";
const money = (minor: number, scale: number) => (minor / 10 ** scale).toFixed(scale);

async function persistCart(
  tx: any,
  actor: typeof users.$inferSelect,
  market: ResolvedMarket,
  items: CartLine[],
) {
  if (!Array.isArray(items) || items.length > 100)
    throw fail(400, "السلة غير صالحة");

  const rows = await offerRows(market.id, tx);
  const categoryRows = await Promise.all(
    [...new Set(rows.map(({ offer }) => offer.data.categoryId).filter(Boolean))]
      .map((id) => categoryById(String(id), tx)),
  );
  const categories = new Map(
    categoryRows.filter(Boolean).map((category: any) => [category.id, category]),
  );
  const [stored] = await tx
    .select()
    .from(carts)
    .where(and(eq(carts.userId, actor.id), eq(carts.marketId, market.id)));
  const storedQuantities = new Map<string, number>(
    stored
      ? (await tx.select().from(cartItems).where(eq(cartItems.cartId, stored.id))).map(
          (line: typeof cartItems.$inferSelect) => [line.offerId, line.quantity],
        )
      : [],
  );
  const agreements = await acceptedAgreementsByListing(
    actor.id,
    market.id,
    items.map((item) => item.listingId).filter((id) => typeof id === "string"),
    tx,
  );
  const seen = new Set<string>();
  for (const item of items) {
    const row = rows.find(({ offer }) => offer.id === item.listingId);
    const semantics = row
      ? (categories.get(String(row.offer.data.categoryId)) as any)?.rules?.inventory?.semantics
      : undefined;
    if (row && semantics === "SINGLE" && item.quantity > 1)
      throw fail(409, "هذا العرض مخصص لوحدة واحدة");
    if (
      row &&
      row.offer.inventoryMode !== "UNLIMITED" &&
      item.quantity >
        Math.max(
          0,
          (row.offer.availableQuantity ?? 0) - row.offer.reservedQuantity,
        )
    )
      throw fail(409, "الكمية المطلوبة تتجاوز المخزون المتاح");
    if (
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 1000000 ||
      seen.has(item.listingId) ||
      !row ||
      row.offer.status !== "PUBLISHED" ||
      priceRepresentationOf(row.offer) === null ||
      row.seller.status !== "ACTIVE"
    )
      throw fail(409, "عنصر غير صالح أو من سوق آخر");
    const agreement = agreements.get(item.listingId);
    // An agreement prices any listing for this buyer (and caps its quantity); without one only a
    // definite asking price is purchasable.
    if (agreement || !directPurchaseAllowed(priceRepresentationOf(row.offer), row.offer.unitPriceMinor)) {
      // A line already in the cart may stay or shrink after its agreement lapses (checkout
      // refuses it with the reason); it can never be added or grow without an agreement.
      if (!agreement && item.quantity > (storedQuantities.get(item.listingId) ?? 0))
        throw fail(409, CART_NEEDS_AGREEMENT);
      if (agreement && item.quantity > agreement.quantity)
        throw fail(409, `السعر المتفق عليه يشمل ${agreement.quantity} فقط؛ عدّل الكمية`);
    }
    seen.add(item.listingId);
  }

  await tx
    .insert(carts)
    .values({ id: randomUUID(), userId: actor.id, marketId: market.id })
    .onConflictDoNothing();
  const [cart] = await tx
    .select()
    .from(carts)
    .where(and(eq(carts.userId, actor.id), eq(carts.marketId, market.id)));
  if (!cart) throw fail(500, "تعذر حفظ السلة");

  await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));
  if (items.length) {
    await tx.insert(cartItems).values(
      items.map((item) => ({
        id: randomUUID(),
        cartId: cart.id,
        offerId: item.listingId,
        quantity: item.quantity,
      })),
    );
  }
}

export async function getMarketplaceCart(
  userId: string,
  market: ResolvedMarket,
  tx: any = db,
) {
  const [cart] = await tx
    .select()
    .from(carts)
    .where(and(eq(carts.userId, userId), eq(carts.marketId, market.id)));
  if (!cart) return [];

  const [items, rows] = await Promise.all([
    tx.select().from(cartItems).where(eq(cartItems.cartId, cart.id)),
    offerRows(market.id, tx),
  ]);
  const agreements = await acceptedAgreementsByListing(
    userId,
    market.id,
    items.map((item: typeof cartItems.$inferSelect) => item.offerId),
    tx,
  );
  return items.flatMap((item: typeof cartItems.$inferSelect) => {
    const row = rows.find(({ offer }: any) => offer.id === item.offerId);
    const agreement = agreements.get(item.offerId);
    // A line without any price (no agreement, no public amount) cannot be shown as a cart line.
    if (!row || priceRepresentationOf(row.offer) === null || (row.offer.unitPriceMinor === null && !agreement))
      return [];
    const current = listing(row.offer, row.seller, market);
    const available =
      current.inventoryMode === "UNLIMITED"
        ? null
        : Math.max(0, current.availableQuantity! - current.reservedQuantity);
    if (!agreement && directPurchaseAllowed(priceRepresentationOf(row.offer), row.offer.unitPriceMinor))
      return [{ ...current, listingId: current.id, quantity: item.quantity, availableQuantity: available }];
    // The cart shows exactly what checkout will charge: this buyer's agreed price, capped at the
    // agreed quantity, or a line that must be agreed first (never the public price as if buyable).
    return [
      agreement
        ? {
            ...current,
            listingId: current.id,
            quantity: item.quantity,
            unitPrice: money(agreement.agreedAmountMinor!, market.minorUnitScale),
            ...(current.unitPrice !== null ? { listedUnitPrice: current.unitPrice } : {}),
            agreedPrice: true,
            availableQuantity:
              available === null ? agreement.quantity : Math.min(available, agreement.quantity),
          }
        : {
            ...current,
            listingId: current.id,
            quantity: item.quantity,
            requiresAgreement: true,
            availableQuantity: available,
          },
    ];
  });
}

export async function replaceMarketplaceCart(
  userId: string,
  requestedMarketId: string,
  items: CartLine[],
) {
  await db.transaction(async (tx) => {
    const [actor] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!actor) throw fail(401, "سجّل الدخول للمتابعة");
    const market = await marketFor({ actor }, tx);
    if (requestedMarketId !== market.id)
      throw fail(409, "تغير السوق، أعد تحميل السلة");
    await persistCart(tx, actor, market, items);
  });
  return { ok: true };
}

async function validatedCartListing(
  tx: any,
  actor: typeof users.$inferSelect,
  market: ResolvedMarket,
  listingId: string,
) {
  const rows = await offerRows(market.id, tx);
  const row = rows.find(({ offer }: any) => offer.id === listingId);
  if (
    !row ||
    row.offer.status !== "PUBLISHED" ||
    !["FIXED", "NEGOTIABLE"].includes(row.offer.pricingMode) ||
    row.offer.unitPriceMinor === null ||
    row.seller.status !== "ACTIVE" ||
    market.restrictedCategories.includes(row.offer.data.category)
  )
    throw fail(409, "هذا العرض لم يعد متاحًا في سوقك الحالي");
  if (row.offer.sellerId === actor.id)
    throw fail(409, "لا يمكنك شراء عرضك الخاص");
  return row;
}

async function cartItemsAfterAdd(
  tx: any,
  actor: typeof users.$inferSelect,
  market: ResolvedMarket,
  row: any,
  listingId: string,
  quantity: number,
) {
  const [cart] = await tx
    .select()
    .from(carts)
    .where(and(eq(carts.userId, actor.id), eq(carts.marketId, market.id)));
  const currentItems = cart
    ? await tx
        .select()
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id))
    : [];
  const existing = currentItems.find((item: any) => item.offerId === listingId);
  const nextQuantity = (existing?.quantity ?? 0) + quantity;
  if (
    row.offer.inventoryMode === "LIMITED" &&
    nextQuantity >
      Math.max(
        0,
        (row.offer.availableQuantity ?? 0) - row.offer.reservedQuantity,
      )
  )
    throw fail(409, "الكمية المطلوبة تتجاوز المخزون المتاح");

  const items: CartLine[] = currentItems.map((item: any) => ({
    listingId: item.offerId,
    quantity: item.offerId === listingId ? nextQuantity : item.quantity,
  }));
  if (!existing) items.push({ listingId, quantity });
  return { items, nextQuantity };
}

export async function addMarketplaceCartItem(input: {
  userId: string;
  expectedMarketId: string;
  listingId: string;
  quantity: number;
}) {
  const { userId, expectedMarketId, listingId, quantity } = input;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100)
    throw fail(400, "الكمية غير صالحة");

  return db.transaction(async (tx) => {
    const [actor] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!actor) throw fail(401, "سجّل الدخول للمتابعة");
    const market = await marketFor({ actor }, tx);
    if (market.id !== expectedMarketId)
      throw fail(409, "تغير السوق، أعد تحميل المحادثة");
    if (!isMarketAvailable(market))
      throw fail(409, "هذا السوق غير متاح حاليًا");

    const row = await validatedCartListing(tx, actor, market, listingId);
    const { items, nextQuantity } = await cartItemsAfterAdd(
      tx,
      actor,
      market,
      row,
      listingId,
      quantity,
    );
    await persistCart(tx, actor, market, items);
    return {
      listing: listing(row.offer, row.seller, market),
      quantity: nextQuantity,
    };
  });
}

/**
 * A card's "add to cart" is one request with one effect. The card's identity — conversation,
 * result set and listing — is the idempotency key, recorded as the assistant receipt in the same
 * transaction as the cart write, under the user's row lock. A repeat, a retry after a timeout, a
 * reload, or the same card from a second session returns the stored receipt and never increments
 * the cart again. The listing, result-set expiry and stock are revalidated inside that lock.
 */
export type CardAddReceipt = {
  id: string;
  body: string;
  createdAt: Date;
  block: { resultSetId: string; listings: unknown[]; surface: "CART" };
};

const CARD_ADD_SCOPE = "CARD_ADD_V1";
export function cardAddReceiptKey(input: { conversationId: string; resultSetId: string; listingId: string }) {
  return createHash("sha256")
    .update(`${CARD_ADD_SCOPE}:${input.conversationId}:${input.resultSetId}:${input.listingId}`)
    .digest("hex");
}

function receiptOf(row: typeof messages.$inferSelect): CardAddReceipt {
  const metadata = row.metadata as Record<string, unknown>;
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt,
    block: { resultSetId: String(metadata.blockResultSetId ?? ""), listings: [], surface: "CART" },
  };
}

export async function findCardAddReceipt(input: {
  conversationId: string;
  resultSetId: string;
  listingId: string;
}): Promise<CardAddReceipt | null> {
  const key = cardAddReceiptKey(input);
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, input.conversationId), sql`${messages.metadata}->>'cardAddKey' = ${key}`))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row ? receiptOf(row) : null;
}

export async function addMarketplaceCartItemOnce(input: {
  userId: string;
  expectedMarketId: string;
  conversationId: string;
  resultSetId: string;
  listingId: string;
  quantity: number;
}) {
  const { userId, expectedMarketId, conversationId, resultSetId, listingId, quantity } = input;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100)
    throw fail(400, "الكمية غير صالحة");
  const key = cardAddReceiptKey({ conversationId, resultSetId, listingId });

  return db.transaction(async (tx) => {
    const [actor] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!actor) throw fail(401, "سجّل الدخول للمتابعة");
    const market = await marketFor({ actor }, tx);
    if (market.id !== expectedMarketId)
      throw fail(409, "تغير السوق، أعد تحميل المحادثة");
    if (!isMarketAvailable(market))
      throw fail(409, "هذا السوق غير متاح حاليًا");

    const [prior] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), sql`${messages.metadata}->>'cardAddKey' = ${key}`))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (prior) return { receipt: receiptOf(prior), replayed: true };

    const [resultSet] = await tx
      .select()
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.id, resultSetId),
          eq(aiResultSets.conversationId, conversationId),
          eq(aiResultSets.marketId, market.id),
        ),
      )
      .for("update");
    if (
      !resultSet ||
      (resultSet.expiresAt && resultSet.expiresAt.getTime() <= Date.now()) ||
      !resultSet.resourceIds.includes(listingId)
    )
      throw fail(409, "لم يعد هذا العرض ضمن نتائج هذه المحادثة؛ أعد البحث ثم حاول مجددًا");

    const row = await validatedCartListing(tx, actor, market, listingId);
    const { items, nextQuantity } = await cartItemsAfterAdd(
      tx,
      actor,
      market,
      row,
      listingId,
      quantity,
    );
    await persistCart(tx, actor, market, items);

    const title = listing(row.offer, row.seller, market).title;
    const body = `أُضيف «${title}» إلى سلتك (${nextQuantity}). راجع السلة قبل إكمال الطلب.`;
    const blockResultSetId = randomUUID();
    const [message] = await tx
      .insert(messages)
      .values({
        id: randomUUID(),
        conversationId,
        actor: "ASSISTANT",
        body,
        contentType: "TEXT",
        metadata: {
          cardAddKey: key,
          cardAdd: "ADD_TO_CART",
          resultSetId,
          listingId,
          quantity: nextQuantity,
          blockResultSetId,
        },
      })
      .returning();
    await tx.insert(aiUiBlocks).values({
      id: randomUUID(),
      conversationId,
      messageId: message!.id,
      blockType: "SURFACE",
      version: 1,
      payload: { resultSetId: blockResultSetId, listings: [], surface: "CART" },
      ordinal: 0,
    });
    await tx.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
    return { receipt: receiptOf(message!), replayed: false };
  });
}

/**
 * Add all explicitly selected result-set items in one cart transaction. A failed
 * line rejects the whole operation; callers must not loop over single-item writes.
 */
export async function addMarketplaceCartItems(input: {
  userId: string;
  expectedMarketId: string;
  items: CartLine[];
}) {
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 24 ||
    input.items.some(
      (item) =>
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 100,
    ) ||
    new Set(input.items.map((item) => item.listingId)).size !== input.items.length
  )
    throw fail(400, "العناصر المحددة غير صالحة");

  return db.transaction(async (tx) => {
    const [actor] = await tx
      .select()
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!actor) throw fail(401, "سجّل الدخول للمتابعة");
    const market = await marketFor({ actor }, tx);
    if (market.id !== input.expectedMarketId)
      throw fail(409, "تغير السوق، أعد تحميل المحادثة");
    if (!isMarketAvailable(market))
      throw fail(409, "هذا السوق غير متاح حاليًا");

    const [cart] = await tx
      .select()
      .from(carts)
      .where(and(eq(carts.userId, actor.id), eq(carts.marketId, market.id)));
    const existing = cart
      ? await tx.select().from(cartItems).where(eq(cartItems.cartId, cart.id))
      : [];
    const quantities = new Map<string, number>(
      existing.map((item: typeof cartItems.$inferSelect) => [
        item.offerId,
        item.quantity,
      ]),
    );
    for (const item of input.items) {
      quantities.set(
        item.listingId,
        (quantities.get(item.listingId) ?? 0) + item.quantity,
      );
    }
    const next = [...quantities].map(([listingId, quantity]) => ({
      listingId,
      quantity,
    }));
    const rows = await offerRows(market.id, tx);
    for (const item of input.items) {
      const row = rows.find(({ offer }) => offer.id === item.listingId);
      if (
        !row ||
        row.offer.status !== "PUBLISHED" ||
        !["FIXED", "NEGOTIABLE"].includes(row.offer.pricingMode) ||
        row.offer.unitPriceMinor === null ||
        row.seller.status !== "ACTIVE" ||
        row.offer.sellerId === actor.id ||
        market.restrictedCategories.includes(row.offer.data.category)
      )
        throw fail(409, "أحد العروض المحددة لم يعد متاحًا");
    }
    await persistCart(tx, actor, market, next);
    return { items: await getMarketplaceCart(actor.id, market, tx) };
  });
}

/** Update or remove one existing cart line under the cart owner's transaction lock. */
export async function updateMarketplaceCartLine(input: {
  userId: string;
  expectedMarketId: string;
  listingId: string;
  quantity: number | null;
}) {
  if (
    input.quantity !== null &&
    (!Number.isSafeInteger(input.quantity) ||
      input.quantity < 1 ||
      input.quantity > 100)
  )
    throw fail(400, "الكمية غير صالحة");

  return db.transaction(async (tx) => {
    const [actor] = await tx
      .select()
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!actor) throw fail(401, "سجّل الدخول للمتابعة");
    const market = await marketFor({ actor }, tx);
    if (market.id !== input.expectedMarketId)
      throw fail(409, "تغير السوق، أعد تحميل السلة");
    const [cart] = await tx
      .select()
      .from(carts)
      .where(and(eq(carts.userId, actor.id), eq(carts.marketId, market.id)));
    const current = cart
      ? await tx.select().from(cartItems).where(eq(cartItems.cartId, cart.id))
      : [];
    if (!current.some((item: typeof cartItems.$inferSelect) => item.offerId === input.listingId))
      throw fail(409, "تغيرت السلة؛ راجع العناصر الحالية");
    const next: CartLine[] = current.flatMap((item: typeof cartItems.$inferSelect) => {
      if (item.offerId !== input.listingId) {
        return [{ listingId: item.offerId, quantity: item.quantity }];
      }
      return input.quantity === null
        ? []
        : [{ listingId: item.offerId, quantity: input.quantity }];
    });
    await persistCart(tx, actor, market, next);
    return { items: await getMarketplaceCart(actor.id, market, tx) };
  });
}