import { SellerBusinessInsight, SellerSalesInsight } from "@workspace/api-zod/conversation-runtime";
import { ComposedSurfaceView } from "./surface/ComposedSurface";
import { businessSurface, salesSurface } from "./surface/adapters";

type Insight = SellerBusinessInsight | SellerSalesInsight;

/** DINAR NEXT C/D: the seller's own stock, order counts, per-listing results or period sales, as the server parsed them. */
export function isBusinessInsight(value: unknown): value is Insight {
  return SellerBusinessInsight.safeParse(value).success || SellerSalesInsight.safeParse(value).success;
}

/** Server-computed figures, composed from the shared surface primitives; follow-ups only on the live card. */
export function BusinessSummaryPanel({ insight, active = false, onSend }: { insight: Insight; active?: boolean; onSend?: (text: string) => void }) {
  return (
    <ComposedSurfaceView
      surface={insight.topic === "SALES" ? salesSurface(insight) : businessSurface(insight)}
      active={active}
      onSend={onSend}
    />
  );
}
