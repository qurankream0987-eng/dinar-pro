import { ComposedSurfaceView } from "./surface/ComposedSurface";
import { purchaseSurface, type PurchaseReview } from "./surface/commerce-adapters";

/** Block F2/F3 comparison, purchase, order and payment reviews. Server-built; the client only renders them. */
type ComparisonSource = "RECORD" | "SELLER";
type Comparison = {
  listings: { id: string; title: string; isSponsored: boolean }[];
  /** `source` and `applies` are W02-ULTRA additions; older stored comparisons have neither. */
  rows: { key?: string; label: string; source?: ComparisonSource; values: (string | number | null)[]; applies?: boolean[] }[];
  /** Facts computed from the rows (lowest/highest), never a ranking of «better». */
  highlights?: { key: string; label: string; text: string; missing: number }[];
  unknownLabel: string;
  notApplicableLabel?: string;
  sourceLabels?: Partial<Record<ComparisonSource | "DERIVED", string>>;
};

function cellText(comparison: Comparison, row: Comparison["rows"][number], index: number): string {
  if (row.applies && row.applies[index] === false) return comparison.notApplicableLabel ?? "لا ينطبق";
  const value = row.values[index];
  return value == null ? comparison.unknownLabel : String(value);
}

function SourceTag({ comparison, source }: { comparison: Comparison; source?: ComparisonSource }) {
  const label = source ? comparison.sourceLabels?.[source] : undefined;
  return label ? <span className="ai-comparison-source block text-[0.7rem] text-muted-foreground">{label}</span> : null;
}
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
                <div key={row.key ?? row.label}>
                  <dt>
                    {row.label}
                    <SourceTag comparison={comparison} source={row.source} />
                  </dt>
                  <dd>{cellText(comparison, row, index)}</dd>
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
            <tr key={row.key ?? row.label} className="border-t border-border">
              <th
                className="p-2 text-start font-normal text-muted-foreground"
                scope="row"
              >
                {row.label}
                <SourceTag comparison={comparison} source={row.source} />
              </th>
              {row.values.map((_, index) => (
                <td key={index} className="p-2 break-words">
                  {cellText(comparison, row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {comparison.highlights && comparison.highlights.length > 0 && (
        <section className="border-t border-border p-3 text-sm" aria-label="حقائق محسوبة من المقارنة" data-testid="comparison-highlights">
          <h3 className="text-xs font-semibold text-muted-foreground">
            {comparison.sourceLabels?.DERIVED ?? "محسوب من القيم أعلاه"}
          </h3>
          <ul className="mt-1 space-y-1">
            {comparison.highlights.map((item) => (
              <li key={item.key} data-testid={`comparison-highlight-${item.key.replace(/[^A-Za-z0-9_-]/gu, "_")}`}>
                <span className="font-medium">{item.label}:</span> {item.text}
                {item.missing > 0 && (
                  <span className="text-muted-foreground"> ({item.missing === 1 ? "عرض واحد لم يذكر القيمة" : `${item.missing} عروض لم تذكر القيمة`})</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
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
