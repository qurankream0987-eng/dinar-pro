import { ComposedSurfaceView } from "./surface/ComposedSurface";
import { businessSurface } from "./surface/business-adapters";
import type { BusinessPayload } from "./business-types";

/**
 * D3-A business cards: setup, profile, catalog, drafts, review, orders and insights.
 * The server decides the view, the figures and which actions may exist; the client renders
 * them with the shared primitives and sends back utterances only.
 */
export function BusinessSurface({
  business,
  active = false,
  onSend,
}: {
  business: BusinessPayload;
  active?: boolean;
  onSend?: (text: string) => void;
}) {
  const composition = businessSurface(business);
  if (!composition) return null;
  return <ComposedSurfaceView surface={composition} active={active} onSend={onSend} />;
}
