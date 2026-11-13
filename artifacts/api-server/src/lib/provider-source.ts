/**
 * G1 source metadata. A listing's source is answered by its provider mapping: a
 * listing mapped to an ACTIVE connection is PROVIDER-synchronized, everything else
 * is SELF_SERVICE. Source never grants authority: moderation, promotion, payment and
 * status stay with their own DINAR authorities. While a connection is active its
 * synchronized content (price, stock, title, …) is owned by the provider; once it is
 * revoked the listing simply becomes the seller's again.
 */
import { and, eq } from "drizzle-orm";
import { db, providerConnections, providerResourceMappings } from "@workspace/db";

export type ListingSource = "SELF_SERVICE" | "PROVIDER";

/** Fields the provider owns while its connection is active; contact and status stay DINAR-side. */
export const PROVIDER_CONTROLLED_FIELDS = [
  "title",
  "description",
  "category",
  "categoryId",
  "area",
  "city",
  "attributes",
  "unitPrice",
  "pricingMode",
  "inventoryMode",
  "availableQuantity",
  "fulfilmentType",
  "imageUrl",
  "imageUrls",
] as const;

export async function listingSource(listingId: string, tx: any = db): Promise<ListingSource> {
  const [row] = await tx
    .select({ id: providerResourceMappings.id })
    .from(providerResourceMappings)
    .innerJoin(providerConnections, eq(providerConnections.id, providerResourceMappings.connectionId))
    .where(
      and(
        eq(providerResourceMappings.resourceType, "LISTING"),
        eq(providerResourceMappings.resourceId, listingId),
        eq(providerConnections.status, "ACTIVE"),
      ),
    )
    .limit(1);
  return row ? "PROVIDER" : "SELF_SERVICE";
}

export function sourceControlledMessage(fields: readonly string[]): string {
  if (fields.includes("unitPrice") || fields.includes("pricingMode"))
    return "هذا السعر متزامن من نظامك المتصل جاسم. عدّله من المصدر؛ لم يتم حفظ أي تغيير.";
  if (fields.includes("availableQuantity") || fields.includes("inventoryMode"))
    return "هذه الكمية متزامنة من نظامك المتصل جاسم. عدّلها من المصدر؛ لم يتم حفظ أي تغيير.";
  return "بيانات هذا العرض متزامنة من نظامك المتصل جاسم. عدّلها من المصدر؛ لم يتم حفظ أي تغيير.";
}
