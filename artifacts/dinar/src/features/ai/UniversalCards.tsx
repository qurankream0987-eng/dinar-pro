import { UniversalCardsPayloadSchema } from "@workspace/api-zod/connect";
import { universalCardSurface } from "./universal-card-surface";
import { ComposedSurfaceView } from "./surface/ComposedSurface";

export function UniversalCards({ payload, resultSetId }: { payload: unknown; resultSetId: string }) {
  const parsed = UniversalCardsPayloadSchema.safeParse(payload);
  if (!parsed.success) return <p role="status">تعذر التحقق من بيانات البطاقات؛ أعد البحث.</p>;
  return <section aria-label="نتائج المزوّدين الخارجيين" className="mt-3 min-w-0 max-w-full" data-testid="connect-results">
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">{parsed.data.cards.map(card => <ComposedSurfaceView key={card.id} surface={universalCardSurface(card,resultSetId)} active />)}</div>
    <p className="mt-3 text-sm text-muted-foreground">{parsed.data.note}</p>
    {parsed.data.comparisonNote && <p className="mt-2 text-sm text-muted-foreground">{parsed.data.comparisonNote}</p>}
  </section>;
}
