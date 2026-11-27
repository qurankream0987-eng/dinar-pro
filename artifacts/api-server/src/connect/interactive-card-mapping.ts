/**
 * Connect-03 — Interactive Card Mapping Extension.
 * Extends Jassim Connect's flat tool-card mapping to map merchant modifiers/layers/variants
 * into JassimCardSpec v1 (LAYERED_STACK / MANNEQUIN / PRODUCT_STUDIO) with bounded RFC 6901 reads.
 */

/** RFC 6901 pointer, bounded; returns undefined on any miss. */
function readPointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current = value;
  for (const raw of path.slice(1).split("/").slice(0, 16)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current) && /^\d{1,4}$/.test(key)) current = current[Number(key)];
    else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, key)) current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}

export type InteractiveStageMode = "LAYERED_STACK" | "MANNEQUIN" | "PRODUCT_STUDIO";

export interface InteractiveCardMappingConfig {
  stageMode: InteractiveStageMode;
  itemsPointer: string;
  idPointer: string;
  titlePointer: string;
  pricePointer: string;
  modifiersPointer?: string;
  modifierIdPointer?: string;
  modifierLabelPointer?: string;
  modifierDeltaPointer?: string;
  modifierColorPointer?: string;
  currencyCode: string;
}

export interface MappedInteractiveModifier {
  id: string;
  label: string;
  deltaMinor: number;
  color: string;
}

export interface MappedInteractiveProduct {
  id: string;
  title: string;
  basePriceMinor: number;
  currencyCode: string;
  stageMode: InteractiveStageMode;
  modifiers: MappedInteractiveModifier[];
}

function toMinorSafe(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

export function mapMerchantPayloadToInteractiveCards(payload: unknown, config: InteractiveCardMappingConfig): MappedInteractiveProduct[] {
  const rawItems = readPointer(payload, config.itemsPointer);
  if (!Array.isArray(rawItems)) return [];
  const results: MappedInteractiveProduct[] = [];
  for (const item of rawItems.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const id = String(readPointer(item, config.idPointer) ?? "").trim().slice(0, 64);
    const title = String(readPointer(item, config.titlePointer) ?? "").trim().slice(0, 140);
    const basePriceMinor = toMinorSafe(readPointer(item, config.pricePointer));
    if (!id || !title || basePriceMinor === undefined) continue;
    const modifiers: MappedInteractiveModifier[] = [];
    if (config.modifiersPointer) {
      const rawMods = readPointer(item, config.modifiersPointer);
      if (Array.isArray(rawMods)) {
        for (const mod of rawMods.slice(0, 20)) {
          if (!mod || typeof mod !== "object") continue;
          const mId = String(readPointer(mod, config.modifierIdPointer ?? "/id") ?? "").trim().slice(0, 64);
          const mLabel = String(readPointer(mod, config.modifierLabelPointer ?? "/label") ?? "").trim().slice(0, 80);
          const mDelta = toMinorSafe(readPointer(mod, config.modifierDeltaPointer ?? "/priceDelta") ?? 0) ?? 0;
          const rawColor = String(readPointer(mod, config.modifierColorPointer ?? "/color") ?? "#d97706").trim();
          const mColor = /^#[0-9a-fA-F]{3,8}$/.test(rawColor) ? rawColor : "#d97706";
          if (mId && mLabel) modifiers.push({ id: mId, label: mLabel, deltaMinor: mDelta, color: mColor });
        }
      }
    }
    results.push({ id, title, basePriceMinor, currencyCode: config.currencyCode, stageMode: config.stageMode, modifiers });
  }
  return results;
}
