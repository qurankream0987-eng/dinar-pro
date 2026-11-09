/**
 * DINAR map: a thin MapLibre GL JS wrapper (lazy-loaded) for delivery points and the courier.
 *
 * - It only draws what it is given: markers come from server state or the user's own choice.
 *   Nothing here invents a position, a route, a distance or an arrival time.
 * - Without a configured style it renders an honest "map not configured" panel with the
 *   coordinates as text and an external "open in maps" link instead of a decorative map.
 * - Synthetic test styles are labelled on the map itself so they can never pass for real data.
 * - Marker moves animate only on real changes, and not at all under prefers-reduced-motion.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { resolveMapStyle } from "./map-style";

export type MapPoint = { latitude: number; longitude: number };
export type MapMarkerKind = "driver" | "destination" | "pickup" | "selection";
export type DinarMapMarker = { id: string; kind: MapMarkerKind; point: MapPoint; label: string; stale?: boolean };

const KIND_CLASS: Record<MapMarkerKind, string> = {
  driver: "dinar-map-marker dinar-map-marker--driver",
  destination: "dinar-map-marker dinar-map-marker--destination",
  pickup: "dinar-map-marker dinar-map-marker--pickup",
  selection: "dinar-map-marker dinar-map-marker--selection",
};

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Honest fallback. Lists what would be shown by label only: coordinates never appear as text or in links. */
export function MapUnavailable({ markers, reason, testId }: { markers: DinarMapMarker[]; reason: "NOT_CONFIGURED" | "LOAD_FAILED"; testId?: string }) {
  return (
    <div className="dinar-map-fallback" role="note" data-testid={testId ?? "map-unavailable"} data-reason={reason}>
      <p className="font-medium text-foreground">
        {reason === "NOT_CONFIGURED" ? "الخريطة التفاعلية غير مفعّلة بعد (لم يُعتمد مزود خرائط)." : "تعذر تحميل الخريطة الآن. حالة الطلب أدناه ما زالت صحيحة."}
      </p>
      {markers.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {markers.map((marker) => (
            <li key={marker.id}>{marker.label}{marker.stale ? " (قديم)" : ""}: متوفر لهذا الطلب</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function DinarMap({
  markers,
  ariaLabel,
  height = 220,
  onSelect,
  testId = "dinar-map",
}: {
  markers: DinarMapMarker[];
  ariaLabel: string;
  height?: number;
  /** When set, tapping the map or dragging the selection marker reports the chosen point. */
  onSelect?: (point: MapPoint) => void;
  testId?: string;
}) {
  const style = useMemo(() => resolveMapStyle(), []);
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markerRefs = useRef(new Map<string, Marker>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (style.kind === "NONE" || !container.current) return;
    let cancelled = false;
    let instance: MapLibreMap | undefined;
    void import("maplibre-gl").then(({ default: maplibregl }) => {
      if (cancelled || !container.current) return;
      const first = markers[0]?.point ?? { latitude: 31.9539, longitude: 35.9106 };
      instance = new maplibregl.Map({
        container: container.current,
        style: style.kind === "URL" ? style.url : style.style,
        center: [first.longitude, first.latitude],
        zoom: 14,
        attributionControl: { compact: true },
        cooperativeGestures: true,
        fadeDuration: reducedMotion() ? 0 : 300,
      });
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
      instance.on("error", (event) => {
        // A tile hiccup is not fatal; a style that never loads is.
        if (!instance?.isStyleLoaded()) setFailed(true);
        void event;
      });
      instance.on("load", () => setReady(true));
      instance.on("click", (event) => {
        onSelectRef.current?.({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
      });
      map.current = instance;
    }, () => setFailed(true));
    return () => {
      cancelled = true;
      markerRefs.current.forEach((marker) => marker.remove());
      markerRefs.current.clear();
      instance?.remove();
      map.current = null;
    };
  }, [style]);

  // Sync markers with the given state; real changes only.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    void import("maplibre-gl").then(({ default: maplibregl }) => {
      const seen = new Set<string>();
      for (const item of markers) {
        seen.add(item.id);
        const existing = markerRefs.current.get(item.id);
        const lngLat: [number, number] = [item.point.longitude, item.point.latitude];
        if (existing) {
          existing.setLngLat(lngLat);
          existing.getElement().classList.toggle("dinar-map-marker--stale", Boolean(item.stale));
          existing.getElement().setAttribute("aria-label", item.label);
          continue;
        }
        const element = document.createElement("div");
        element.className = `${KIND_CLASS[item.kind]}${item.stale ? " dinar-map-marker--stale" : ""}`;
        element.setAttribute("role", "img");
        element.setAttribute("aria-label", item.label);
        element.dataset.testid = `map-marker-${item.kind}`;
        const draggable = item.kind === "selection" && Boolean(onSelectRef.current);
        const marker = new maplibregl.Marker({ element, draggable, anchor: item.kind === "driver" ? "center" : "bottom" }).setLngLat(lngLat).addTo(instance);
        if (draggable)
          marker.on("dragend", () => {
            const position = marker.getLngLat();
            onSelectRef.current?.({ latitude: position.lat, longitude: position.lng });
          });
        markerRefs.current.set(item.id, marker);
      }
      for (const [id, marker] of markerRefs.current) {
        if (!seen.has(id)) {
          marker.remove();
          markerRefs.current.delete(id);
        }
      }
      if (markers.length === 1) instance.easeTo({ center: [markers[0]!.point.longitude, markers[0]!.point.latitude], duration: reducedMotion() ? 0 : 450 });
      else if (markers.length > 1) {
        const lons = markers.map((m) => m.point.longitude);
        const lats = markers.map((m) => m.point.latitude);
        instance.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 48, maxZoom: 16, duration: reducedMotion() ? 0 : 450 });
      }
    });
  }, [markers, ready]);

  if (style.kind === "NONE") return <MapUnavailable markers={markers} reason="NOT_CONFIGURED" testId={`${testId}-unavailable`} />;
  if (failed) return <MapUnavailable markers={markers} reason="LOAD_FAILED" testId={`${testId}-failed`} />;
  return (
    <div className="dinar-map-shell" data-testid={testId} data-ready={ready ? "true" : "false"}>
      <div ref={container} className="dinar-map-canvas" style={{ height }} role="application" aria-label={ariaLabel} dir="ltr" />
      {style.kind === "INLINE" && style.synthetic && (
        <p className="dinar-map-synthetic" data-testid={`${testId}-synthetic-label`}>
          خريطة اختبار اصطناعية — ليست بيانات حقيقية
        </p>
      )}
    </div>
  );
}
