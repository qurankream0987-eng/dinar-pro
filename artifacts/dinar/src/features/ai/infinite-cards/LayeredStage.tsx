import type { LayerItem, OutfitSlot, StageMode, StudioFinish } from "./schema";

interface LayeredStageProps {
  mode: StageMode;
  layers?: LayerItem[];
  activeLayerIds?: string[];
  outfitSlots?: OutfitSlot[];
  outfitBySlot?: Record<string, string>;
  finishes?: StudioFinish[];
  activeFinishId?: string;
}

function BurgerLayerSvg({ item, index }: { item: LayerItem; index: number }) {
  const style = {
    transition: "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease",
    zIndex: 40 - index,
  };
  if (item.category === "bun_top") {
    return (
      <div style={style} className="relative -mb-2 flex justify-center animate-fade">
        <svg width="164" height="44" viewBox="0 0 164 44" aria-hidden>
          <path d="M12 40 C12 10, 42 4, 82 4 C122 4, 152 10, 152 40 Z" fill={item.color} stroke="#9a5c14" strokeWidth="1.5" />
          <ellipse cx="52" cy="18" rx="4" ry="2" fill="#fff4d6" transform="rotate(-14 52 18)" />
          <ellipse cx="82" cy="14" rx="4.5" ry="2" fill="#fff4d6" />
          <ellipse cx="112" cy="19" rx="4" ry="2" fill="#fff4d6" transform="rotate(14 112 19)" />
          <ellipse cx="67" cy="26" rx="3.5" ry="1.8" fill="#fff4d6" />
          <ellipse cx="99" cy="26" rx="3.5" ry="1.8" fill="#fff4d6" />
        </svg>
      </div>
    );
  }
  if (item.category === "bun_bottom") {
    return (
      <div style={style} className="relative -mt-1 flex justify-center animate-fade">
        <svg width="160" height="26" viewBox="0 0 160 26" aria-hidden>
          <rect x="10" y="2" width="140" height="20" rx="10" fill={item.color} stroke="#9a5c14" strokeWidth="1.5" />
          <rect x="16" y="4" width="128" height="5" rx="2.5" fill="#f7cf86" opacity="0.55" />
        </svg>
      </div>
    );
  }
  if (item.category === "lettuce") {
    return (
      <div style={style} className="relative -my-1 flex justify-center animate-fade">
        <svg width="168" height="18" viewBox="0 0 168 18" aria-hidden>
          <path d="M8 10 Q18 2, 30 9 T54 9 T78 9 T102 9 T126 9 T150 9 Q158 5, 160 11 Q148 17, 134 12 T106 13 T78 12 T50 13 T22 12 Z" fill={item.color} stroke="#1f6f3c" strokeWidth="1.2" />
        </svg>
      </div>
    );
  }
  if (item.category === "cheese") {
    return (
      <div style={style} className="relative -my-1.5 flex justify-center animate-fade">
        <svg width="162" height="18" viewBox="0 0 162 18" aria-hidden>
          <path d="M12 4 L150 4 L144 12 L120 8 L96 16 L72 8 L46 14 L18 10 Z" fill={item.color} stroke="#c27a0e" strokeWidth="1.2" />
        </svg>
      </div>
    );
  }
  if (item.category === "patty") {
    return (
      <div style={style} className="relative -my-1 flex justify-center animate-fade">
        <svg width="158" height="22" viewBox="0 0 158 22" aria-hidden>
          <rect x="8" y="2" width="142" height="18" rx="9" fill={item.color} stroke="#3c1d10" strokeWidth="1.5" />
          <path d="M28 8 H46 M66 12 H88 M108 8 H128" stroke="#2c1208" strokeWidth="2" strokeLinecap="round" opacity="0.45" />
        </svg>
      </div>
    );
  }
  if (item.category === "tomato") {
    return (
      <div style={style} className="relative -my-1 flex justify-center animate-fade">
        <svg width="150" height="14" viewBox="0 0 150 14" aria-hidden>
          <rect x="14" y="2" width="122" height="10" rx="5" fill={item.color} stroke="#991b1b" strokeWidth="1.2" />
          <ellipse cx="46" cy="7" rx="14" ry="2.2" fill="#fca5a5" opacity="0.55" />
          <ellipse cx="104" cy="7" rx="14" ry="2.2" fill="#fca5a5" opacity="0.55" />
        </svg>
      </div>
    );
  }
  return (
    <div style={style} className="relative -my-1 flex justify-center animate-fade">
      <svg width="154" height="14" viewBox="0 0 154 14" aria-hidden>
        <path d="M16 7 Q30 2, 44 7 T72 7 T100 7 T128 7 L138 7" fill="none" stroke={item.color} strokeWidth="6" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function MannequinStage({ slots, selected }: { slots: OutfitSlot[]; selected: Record<string, string> }) {
  const findColor = (slotName: OutfitSlot["slot"], fallback: string) =>
    slots.find((s) => s.slot === slotName)?.options.find((o) => o.id === selected[slotName])?.color ?? fallback;
  const findLabel = (slotName: OutfitSlot["slot"]) =>
    slots.find((s) => s.slot === slotName)?.options.find((o) => o.id === selected[slotName])?.label;

  const topColor = findColor("top", "#3b82f6");
  const outerColor = findColor("outerwear", "transparent");
  const bottomColor = findColor("bottom", "#1e293b");
  const shoeColor = findColor("shoes", "#0f172a");
  const hasOuter = outerColor !== "transparent" && outerColor !== "none";

  return (
    <div className="flex flex-col items-center justify-center py-2">
      <svg width="160" height="196" viewBox="0 0 160 196" role="img" aria-label="معاينة الإطلالة على المانيكان" className="drop-shadow-[0_8px_18px_rgba(0,0,0,0.28)]">
        <ellipse cx="80" cy="186" rx="46" ry="7" fill="currentColor" opacity="0.14" />
        <circle cx="80" cy="24" r="14" fill="#d6c2ad" stroke="#94a3b8" strokeOpacity="0.35" />
        <rect x="74" y="37" width="12" height="9" rx="4" fill="#c7b097" />
        <path d="M52 48 L108 48 L118 82 L104 86 L100 66 L100 106 L60 106 L60 66 L56 86 L42 82 Z" fill={topColor} style={{ transition: "fill 260ms cubic-bezier(0.22, 1, 0.36, 1)" }} stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
        {hasOuter && (
          <path d="M49 46 L68 46 L72 108 L55 108 L58 68 L40 84 L48 54 Z M111 46 L92 46 L88 108 L105 108 L102 68 L120 84 L112 54 Z" fill={outerColor} style={{ transition: "fill 260ms cubic-bezier(0.22, 1, 0.36, 1)" }} stroke="rgba(255,255,255,0.28)" strokeWidth="1.3" />
        )}
        <path d="M60 106 L100 106 L104 166 L85 166 L80 128 L75 166 L56 166 Z" fill={bottomColor} style={{ transition: "fill 260ms cubic-bezier(0.22, 1, 0.36, 1)" }} stroke="rgba(255,255,255,0.18)" strokeWidth="1.2" />
        <rect x="54" y="167" width="21" height="11" rx="5" fill={shoeColor} style={{ transition: "fill 260ms cubic-bezier(0.22, 1, 0.36, 1)" }} />
        <rect x="85" y="167" width="21" height="11" rx="5" fill={shoeColor} style={{ transition: "fill 260ms cubic-bezier(0.22, 1, 0.36, 1)" }} />
      </svg>
      <div className="mt-1 flex flex-wrap justify-center gap-1.5 text-[11px] text-slate-300">
        {slots.map((s) => {
          const lbl = findLabel(s.slot);
          return lbl ? <span key={s.slot} className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5">{lbl}</span> : null;
        })}
      </div>
    </div>
  );
}

function ProductStudioStage({ finishes, activeFinishId }: { finishes: StudioFinish[]; activeFinishId?: string }) {
  const active = finishes.find((f) => f.id === activeFinishId) ?? finishes[0];
  if (!active) return null;
  return (
    <div className="flex flex-col items-center justify-center py-3">
      <svg width="144" height="164" viewBox="0 0 144 164" role="img" aria-label={active.label} className="drop-shadow-[0_10px_24px_rgba(0,0,0,0.3)]">
        <rect x="50" y="6" width="44" height="40" rx="10" fill={active.bandColor ?? "#1e293b"} style={{ transition: "fill 260ms ease" }} />
        <rect x="50" y="118" width="44" height="40" rx="10" fill={active.bandColor ?? "#1e293b"} style={{ transition: "fill 260ms ease" }} />
        <rect x="30" y="34" width="84" height="96" rx="24" fill={active.color} stroke="rgba(255,255,255,0.35)" strokeWidth="2" style={{ transition: "fill 260ms ease" }} />
        <rect x="114" y="62" width="7" height="18" rx="3" fill={active.color} />
        <rect x="38" y="42" width="68" height="80" rx="18" fill="#07111f" />
        <circle cx="72" cy="82" r="24" fill="none" stroke="#f2b84b" strokeWidth="3.5" strokeDasharray="112 40" />
        <circle cx="72" cy="82" r="16" fill="none" stroke="#38bdf8" strokeWidth="3" strokeDasharray="78 30" />
        <text x="72" y="86" textAnchor="middle" fill="#f8fafc" fontSize="11" fontWeight="700">10:09</text>
      </svg>
      <p className="mt-1 text-xs font-semibold text-white">{active.label}</p>
      {active.materialNote && <p className="text-[11px] text-slate-300">{active.materialNote}</p>}
    </div>
  );
}

export function LayeredStage({ mode, layers = [], activeLayerIds = [], outfitSlots = [], outfitBySlot = {}, finishes = [], activeFinishId }: LayeredStageProps) {
  return (
    <div data-testid="infinite-card-stage" data-stage-mode={mode} className="relative flex min-h-[196px] flex-col items-center justify-center overflow-hidden rounded-xl border border-amber-500/20 bg-gradient-to-b from-slate-950/90 via-slate-900/85 to-slate-950/95 px-4 py-3 text-slate-100">
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(242,184,75,0.14),transparent_62%)]" />
      <div className="relative z-10 flex w-full flex-col items-center">
        {mode === "LAYERED_STACK" && (
          <div className="flex flex-col items-center py-2" role="img" aria-label="معاينة الطبقات المختارة">
            {layers.filter((item) => activeLayerIds.includes(item.id)).map((item, idx) => (
              <BurgerLayerSvg key={item.id} item={item} index={idx} />
            ))}
          </div>
        )}
        {mode === "MANNEQUIN" && <MannequinStage slots={outfitSlots} selected={outfitBySlot} />}
        {mode === "PRODUCT_STUDIO" && <ProductStudioStage finishes={finishes} activeFinishId={activeFinishId} />}
      </div>
    </div>
  );
}
