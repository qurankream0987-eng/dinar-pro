/**
 * JassimAI Universal Infinite Card Protocol (JassimCardSpec v1).
 * Inspired by Google A2UI and MCP Apps: external AI models and Connect merchants emit
 * lightweight, typed JSON specifications mapped strictly to trusted local React primitives.
 * Zero raw HTML/JS execution; prices and totals are always authoritative from the server.
 */

export type StageMode = "LAYERED_STACK" | "MANNEQUIN" | "PRODUCT_STUDIO";

export interface LayerItem {
  id: string;
  label: string;
  category: "bun_top" | "bun_bottom" | "patty" | "cheese" | "lettuce" | "tomato" | "onion" | "sauce" | "extra";
  color: string;
  accentColor?: string;
  required?: boolean;
  /** Optional server-formatted price delta label. Never computed in browser. */
  priceDeltaLabel?: string;
}

export interface OutfitOption {
  id: string;
  label: string;
  color: string;
  secondaryColor?: string;
  priceDeltaLabel?: string;
}

export interface OutfitSlot {
  slot: "headwear" | "top" | "outerwear" | "bottom" | "shoes";
  label: string;
  options: OutfitOption[];
}

export interface StudioFinish {
  id: string;
  label: string;
  color: string;
  bandColor?: string;
  materialNote?: string;
}

export type CardBlock =
  | { type: "LAYER_BUILDER"; id: string; title: string; items: LayerItem[]; defaultActiveIds: string[] }
  | { type: "OUTFIT_SLOTS"; id: string; title: string; slots: OutfitSlot[]; defaults: Record<string, string> }
  | { type: "STUDIO_FINISHES"; id: string; title: string; finishes: StudioFinish[]; defaultFinishId: string }
  | { type: "OPTION_CHIPS"; id: string; title: string; options: { id: string; label: string }[]; defaultOptionId: string }
  | { type: "STEPPER"; id: string; label: string; min: number; max: number; defaultValue: number }
  | { type: "TRUST_STRIP"; id: string; items: string[] };

export interface UniversalCardQuote {
  totalLabel: string;
  unitLabel?: string;
  pendingRequote?: boolean;
  note?: string;
}

export interface UniversalCardSpec {
  schemaVersion: "1.0";
  cardId: string;
  vertical: string;
  merchantName: string;
  merchantTier: "BUSINESS" | "INDIVIDUAL" | "CONNECT_PARTNER";
  title: string;
  subtitle?: string;
  badge?: string;
  stageMode: StageMode;
  blocks: CardBlock[];
  quote: UniversalCardQuote;
  primaryCtaLabel: string;
  illustrative?: boolean;
}

export interface UniversalCardSelection {
  activeLayerIds: string[];
  outfitBySlot: Record<string, string>;
  finishId?: string;
  chipsByBlock: Record<string, string>;
  quantity: number;
}

export interface UniversalCardEvent {
  cardId: string;
  action: "SELECTION_CHANGED" | "PRIMARY_CTA";
  selection: UniversalCardSelection;
}

export function isValidUniversalCardSpec(value: unknown): value is UniversalCardSpec {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === "1.0" &&
    typeof v.cardId === "string" &&
    typeof v.title === "string" &&
    typeof v.merchantName === "string" &&
    (v.stageMode === "LAYERED_STACK" || v.stageMode === "MANNEQUIN" || v.stageMode === "PRODUCT_STUDIO") &&
    Array.isArray(v.blocks) &&
    typeof v.quote === "object" &&
    v.quote !== null
  );
}
