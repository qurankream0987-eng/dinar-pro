import type { Listing } from "@workspace/api-client-react";
import { offerRepresentation, placeOf, stockOf } from "@/lib/marketplace";
import { DataTable } from "./DataPrimitives";

/**
 * Phase 2: the block's own live listings as a table, when the model chose TABLE for them. Every
 * value is the listing record the server returned for this block (re-read on reload): title,
 * price and currency, condition, place and stock. A value the listing does not carry reads
 * «غير متوفر»; a negotiable price reads as such, never as zero. The cards with their actions stay
 * below the table, so nothing here can add to the cart or buy.
 */
export function ListingTable({ listings }: { listings: Listing[] }) {
  const condition = (listing: Listing) => {
    const value = (listing.attributes as Record<string, unknown> | undefined)?.condition;
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : null;
  };
  const price = (listing: Listing) => {
    const representation = offerRepresentation(listing);
    if (listing.unitPrice === null) return representation === "QUOTE_REQUIRED" ? "بالتسعير" : "بالاتفاق";
    return `${representation === "STARTING_FROM" ? "يبدأ من " : ""}${listing.unitPrice} ${listing.currency}`;
  };
  const rows = listings.slice(0, 30).map((listing, index) => {
    const numeric = listing.unitPrice === null ? undefined : Number(listing.unitPrice);
    return {
      key: `l${index}`,
      cells: [
        { display: `${index + 1}. ${listing.title}`.slice(0, 120) },
        { display: price(listing).slice(0, 120), ...(numeric !== undefined && Number.isFinite(numeric) ? { sort: numeric } : {}) },
        { display: condition(listing) },
        { display: placeOf(listing).slice(0, 120) || null },
        { display: stockOf(listing).label.slice(0, 120) },
      ],
    };
  });
  return (
    <div className="ai-listing-table" data-testid="ai-results-table">
      <DataTable
        label="جدول النتائج"
        caption="النتائج نفسها كجدول — أسعار وحالة من سجل جاسم"
        columns={[
          { key: "title", label: "العرض", kind: "TEXT" },
          { key: "price", label: "السعر", kind: "MONEY", sortable: true },
          { key: "condition", label: "الحالة", kind: "TEXT" },
          { key: "place", label: "المكان", kind: "TEXT" },
          { key: "stock", label: "التوفر", kind: "TEXT" },
        ]}
        rows={rows}
      />
    </div>
  );
}
