import { ComposedSurfaceView } from "./surface/ComposedSurface";
import { purchaseSurface, type PurchaseReview } from "./surface/commerce-adapters";

/** Block F2/F3 comparison, purchase, order and payment reviews. Server-built; the client only renders them. */
type Comparison = {
  listings: { id: string; title: string; isSponsored: boolean }[];
  rows: { label: string; values: (string | number | null)[] }[];
  unknownLabel: string;
};
export function isComparison(value: unknown): value is Comparison {
  const item = value as Partial<Comparison> | undefined;
  return Boolean(
    item && Array.isArray(item.listings) && Array.isArray(item.rows),
  );
}

export function isPurchaseReview(value: unknown): value is PurchaseReview {
  const item = value as Partial<PurchaseReview> | undefined;
  return Boolean(
    item &&
    typeof item.actionId === "string" &&
    typeof item.status === "string",
  );
}

export function ComparisonPanel({ comparison }: { comparison: Comparison }) {
  return (
    <section
      className="ai-surface mt-3 max-w-full overflow-x-auto rounded-xl border border-border bg-card"
      aria-label="مقارنة العروض"
      data-testid="comparison"
    >
      <div
        className="ai-comparison-cards"
        role="region"
        tabIndex={0}
        aria-label="بطاقات مقارنة العروض"
      >
        {comparison.listings.map((listing, index) => (
          <article className="ai-comparison-card" key={listing.id}>
            <h3>{listing.title}</h3>
            {listing.isSponsored && (
              <p className="mt-1 text-xs text-muted-foreground">إعلان ممول</p>
            )}
            <dl>
              {comparison.rows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>
                    {row.values[index] == null
                      ? comparison.unknownLabel
                      : String(row.values[index])}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
      <table className="ai-comparison-table w-full text-sm">
        <thead>
          <tr>
            <th className="p-2 text-start text-muted-foreground" scope="col">
              الخاصية
            </th>
            {comparison.listings.map((listing) => (
              <th key={listing.id} className="p-2 text-start" scope="col">
                {listing.title}
                {listing.isSponsored && (
                  <span className="ms-1 text-xs text-muted-foreground">
                    (إعلان ممول)
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.label} className="border-t border-border">
              <th
                className="p-2 text-start font-normal text-muted-foreground"
                scope="row"
              >
                {row.label}
              </th>
              {row.values.map((value, index) => (
                <td key={index} className="p-2 break-words">
                  {value === null ? comparison.unknownLabel : String(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Item, order and simulated payment reviews, composed from the shared surface primitives. */
export function PurchaseReviewPanel({
  review,
  active,
  onSend,
}: {
  review: PurchaseReview;
  active: boolean;
  onSend?: (text: string) => void;
}) {
  return <ComposedSurfaceView surface={purchaseSurface(review)} active={active} onSend={onSend} />;
}
