/**
 * Map style resolution. DINAR ships no map provider: the style is owner configuration.
 *
 * VITE_DINAR_MAP_STYLE_URL may be:
 *  - an https style URL from the approved provider (e.g. a MapTiler style with a
 *    domain-restricted key; the provider host must also be in CSP_CONNECT_EXTRA_ORIGINS), or
 *  - an inline JSON style object (used by local tests for a clearly labelled synthetic map).
 * When it is unset, maps render an honest "map not configured" panel instead of a fake map.
 */
import type { StyleSpecification } from "maplibre-gl";

export type ResolvedMapStyle =
  | { kind: "NONE" }
  | { kind: "URL"; url: string }
  | { kind: "INLINE"; style: StyleSpecification; synthetic: boolean };

export function resolveMapStyle(raw: string | undefined = import.meta.env.VITE_DINAR_MAP_STYLE_URL): ResolvedMapStyle {
  const value = raw?.trim();
  if (!value) return { kind: "NONE" };
  if (value.startsWith("{")) {
    try {
      const style = JSON.parse(value) as StyleSpecification & { metadata?: Record<string, unknown> };
      return { kind: "INLINE", style, synthetic: style.metadata?.["dinar:synthetic"] === true };
    } catch {
      return { kind: "NONE" };
    }
  }
  try {
    const url = new URL(value);
    // Plain http is refused: a map style must never downgrade the page.
    return url.protocol === "https:" ? { kind: "URL", url: url.href } : { kind: "NONE" };
  } catch {
    return { kind: "NONE" };
  }
}
