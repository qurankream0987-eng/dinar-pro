import { and, eq, inArray } from "drizzle-orm";
import { db, offers, orders, users } from "@workspace/db";

export type SellerContactRelease = {
  orderId: string;
  contacts: { listingTitle: string; phone: string }[];
};

/**
 * Read-only, buyer-only contact gate. A simulated card intent is never proof
 * of payment; this release path currently authorizes confirmed cash orders only.
 */
export async function getAuthorizedSellerContacts(input: {
  actorId: string;
  orderId: string;
  marketId: string;
  now?: Date;
}): Promise<SellerContactRelease | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (
    !order ||
    order.buyerId !== input.actorId ||
    order.marketId !== input.marketId ||
    !["CREATED", "ACCEPTED", "SELLER_MARKED_DELIVERED", "COMPLETED"].includes(order.status) ||
    (order.status === "CREATED" &&
      (!order.reservationExpiresAt ||
        order.reservationExpiresAt <= (input.now ?? new Date()))) ||
    order.data.selectedPaymentMethod !== "CASH_DIRECT"
  ) return null;

  const items = Array.isArray(order.data.items) ? order.data.items : [];
  const listingIds = [...new Set(items.map((item: any) => item?.listingId).filter((id: unknown): id is string => typeof id === "string"))];
  if (!listingIds.length) return null;
  const contactOffers = await db
    .select({ offer: offers, sellerStatus: users.status })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(and(
      inArray(offers.id, listingIds),
      eq(offers.sellerId, order.sellerId),
      eq(offers.marketId, order.marketId),
    ));
  const byId = new Map(contactOffers.map(({ offer, sellerStatus }) => [offer.id, { offer, sellerStatus }]));
  const contacts = items.flatMap((item: any) => {
    const row = typeof item?.listingId === "string" ? byId.get(item.listingId) : undefined;
    const phone = row?.sellerStatus === "ACTIVE" && typeof row.offer.data.contactPhone === "string" ? row.offer.data.contactPhone.trim() : "";
    return phone
      ? [{ listingTitle: String(item.listingTitle ?? ""), phone }]
      : [];
  });
  const unique = [...new Map(contacts.map((contact) => [contact.phone, contact])).values()];
  return unique.length ? { orderId: order.id, contacts: unique } : null;
}
