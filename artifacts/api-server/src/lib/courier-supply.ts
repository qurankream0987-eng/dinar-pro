import { and, eq } from "drizzle-orm";
import { db, driverProfiles, offers, users } from "@workspace/db";
import { ACCOUNT_STATUS } from "./account-status";
import { getCourierCommissionAccount } from "./courier-economics";

type OrderRow = {
  buyerId: string;
  sellerId: string;
  marketId: string;
  data: Record<string, unknown>;
};

/** Keep the exact city normalization used by Block F4 work discovery. */
export const sameCourierCity = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b) && a!.trim().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه") === b!.trim().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");

/**
 * Read-only, identity-free supply check for this order. It mirrors Block F4's
 * eligibility rules; accepted assignments do not make a driver busy because F4
 * currently permits a driver to carry multiple active orders.
 */
export async function hasEligibleCourierSupply(order: OrderRow, tx: any = db): Promise<boolean> {
  const listingId = typeof order.data.listingId === "string" ? order.data.listingId : "";
  if (!listingId) return false;
  const [listing] = await tx.select({ data: offers.data }).from(offers).where(eq(offers.id, listingId)).limit(1);
  const pickupCity = typeof listing?.data?.city === "string" ? listing.data.city : "";
  if (!pickupCity) return false;

  const candidates = await tx
    .select({
      userId: driverProfiles.userId,
      marketId: driverProfiles.marketId,
      status: driverProfiles.status,
      availability: driverProfiles.availability,
      vehicleType: driverProfiles.vehicleType,
      serviceCity: driverProfiles.serviceCity,
      userStatus: users.status,
      activeMarketId: users.activeMarketId,
    })
    .from(driverProfiles)
    .innerJoin(users, eq(users.id, driverProfiles.userId))
    .where(and(
      eq(driverProfiles.marketId, order.marketId),
      eq(driverProfiles.status, "APPROVED"),
      eq(driverProfiles.availability, "AVAILABLE"),
      eq(users.status, ACCOUNT_STATUS.active),
      eq(users.activeMarketId, order.marketId),
    ));
  for (const candidate of candidates) {
    if (
      candidate.userId === order.buyerId ||
      candidate.userId === order.sellerId ||
      candidate.marketId !== order.marketId ||
      candidate.status !== "APPROVED" ||
      candidate.availability !== "AVAILABLE" ||
      candidate.userStatus !== ACCOUNT_STATUS.active ||
      candidate.activeMarketId !== order.marketId ||
      !candidate.vehicleType ||
      !candidate.serviceCity ||
      !sameCourierCity(candidate.serviceCity, pickupCity)
    ) continue;
    const commissionAccount = await getCourierCommissionAccount({ courierId: candidate.userId }, tx);
    if (!commissionAccount.hold) return true;
  }
  return false;
}
