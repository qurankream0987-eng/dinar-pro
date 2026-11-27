import { memo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
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

const APPLE_SPRING = {
  type: "spring" as const,
  stiffness: 410,
  damping: 30,
  mass: 0.65,
};

const BurgerLayerSvg = memo(function BurgerLayerSvg({
  item,
  index,
  reduced,
}: {
  item: LayerItem;
  index: number;
  reduced: boolean | null;
}) {
  const zIndex = 50 - index;
  const uid = `layer-${item.id}`;

  return (
    <motion.div
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: -12, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? undefined : { opacity: 0, scale: 0.88, y: 6 }}
      transition={reduced ? { duration: 0 } : APPLE_SPRING}
      style={{ zIndex, willChange: reduced ? undefined : "transform, opacity" }}
      className="relative flex justify-center"
    >
      {item.category === "bun_top" && (
        <div className="-mb-2.5">
          <svg width="184" height="52" viewBox="0 0 184 52" aria-hidden="true">
            <defs>
              <radialGradient id={`${uid}-grad`} cx="45%" cy="28%" r="65%">
                <stop offset="0%" stopColor="#fbd38d" />
                <stop offset="48%" stopColor={item.color} />
                <stop offset="100%" stopColor="#8c4a0e" />
              </radialGradient>
              <linearGradient id={`${uid}-sheen`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="rgba(255,255,255,0.42)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </linearGradient>
            </defs>
            <path
              d="M14 46 C14 12, 48 4, 92 4 C136 4, 170 12, 170 46 C170 48, 14 48, 14 46 Z"
              fill={`url(#${uid}-grad)`}
              stroke="#783d09"
              strokeWidth="1.4"
            />
            <path
              d="M30 22 C44 10, 72 7, 114 9 C134 10, 146 16, 152 24 C126 15, 62 14, 30 22 Z"
              fill={`url(#${uid}-sheen)`}
            />
            <ellipse cx="56" cy="20" rx="4.5" ry="2.1" fill="#fff7e0" transform="rotate(-15 56 20)" />
            <ellipse cx="92" cy="15" rx="5" ry="2.2" fill="#fff7e0" />
            <ellipse cx="128" cy="21" rx="4.5" ry="2.1" fill="#fff7e0" transform="rotate(15 128 21)" />
            <ellipse cx="73" cy="29" rx="4" ry="1.9" fill="#fde9b8" transform="rotate(6 73 29)" />
            <ellipse cx="111" cy="29" rx="4" ry="1.9" fill="#fde9b8" transform="rotate(-8 111 29)" />
            <ellipse cx="44" cy="33" rx="3.6" ry="1.7" fill="#fde9b8" transform="rotate(-22 44 33)" />
            <ellipse cx="140" cy="33" rx="3.6" ry="1.7" fill="#fde9b8" transform="rotate(20 140 33)" />
          </svg>
        </div>
      )}

      {item.category === "bun_bottom" && (
        <div className="-mt-1.5">
          <svg width="178" height="34" viewBox="0 0 178 34" aria-hidden="true">
            <defs>
              <linearGradient id={`${uid}-bgrad`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#fde6b4" />
                <stop offset="28%" stopColor={item.color} />
                <stop offset="100%" stopColor="#7a3e09" />
              </linearGradient>
            </defs>
            <ellipse cx="89" cy="29" rx="74" ry="4" fill="rgba(0,0,0,0.38)" />
            <path
              d="M14 5 H164 C166 5, 166 19, 154 25 C144 28, 34 28, 24 25 C12 19, 12 5, 14 5 Z"
              fill={`url(#${uid}-bgrad)`}
              stroke="#783d09"
              strokeWidth="1.4"
            />
            <rect x="18" y="6" width="142" height="4.5" rx="2.25" fill="#fff6db" opacity="0.65" />
          </svg>
        </div>
      )}

      {item.category === "lettuce" && (
        <div className="-my-1.5">
          <svg width="188" height="22" viewBox="0 0 188 22" aria-hidden="true">
            <defs>
              <linearGradient id={`${uid}-lgrad`} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#86efac" />
                <stop offset="50%" stopColor={item.color} />
                <stop offset="100%" stopColor="#15803d" />
              </linearGradient>
            </defs>
            <path
              d="M8 11 Q20 2, 34 10 T62 10 T90 10 T118 10 T146 10 Q164 3, 178 12 Q166 20, 150 14 T120 15 T90 14 T60 15 T26 14 Z"
              fill={`url(#${uid}-lgrad)`}
              stroke="#14532d"
              strokeWidth="1.2"
            />
            <path
              d="M20 10 Q36 6, 52 11 T86 10 T124 11 T160 10"
              fill="none"
              stroke="#bbf7d0"
              strokeWidth="1.3"
              opacity="0.6"
            />
          </svg>
        </div>
      )}

      {item.category === "cheese" && (
        <div className="-my-2">
          <svg width="182" height="22" viewBox="0 0 182 22" aria-hidden="true">
            <defs>
              <linearGradient id={`${uid}-cgrad`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#fef08a" />
                <stop offset="45%" stopColor={item.color} />
                <stop offset="100%" stopColor="#d97706" />
              </linearGradient>
            </defs>
            <path
              d="M12 4 L170 4 L162 14 L138 9 L112 19 L86 9 L56 17 L24 11 Z"
              fill={`url(#${uid}-cgrad)`}
              stroke="#b45309"
              strokeWidth="1.2"
            />
            <path d="M22 6 H158" stroke="#fef9c3" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
          </svg>
        </div>
      )}

      {item.category === "patty" && (
        <div className="-my-1">
          <svg width="176" height="26" viewBox="0 0 176 26" aria-hidden="true">
            <defs>
              <linearGradient id={`${uid}-pgrad`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#92400e" />
                <stop offset="45%" stopColor={item.color} />
                <stop offset="100%" stopColor="#291208" />
              </linearGradient>
            </defs>
            <rect
              x="10"
              y="2"
              width="156"
              height="22"
              rx="11"
              fill={`url(#${uid}-pgrad)`}
              stroke="#271006"
              strokeWidth="1.5"
            />
            <path
              d="M26 6 H150"
              stroke="rgba(255,215,170,0.28)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M34 11 H56 M76 15 H102 M120 11 H142 M52 17 H68"
              stroke="#1c0a03"
              strokeWidth="2.4"
              strokeLinecap="round"
              opacity="0.6"
            />
          </svg>
        </div>
      )}

      {item.category === "tomato" && (
        <div className="-my-1">
          <svg width="166" height="16" viewBox="0 0 166 16" aria-hidden="true">
            <defs>
              <linearGradient id={`${uid}-tgrad`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#f87171" />
                <stop offset="50%" stopColor={item.color} />
                <stop offset="100%" stopColor="#991b1b" />
              </linearGradient>
            </defs>
            <rect
              x="14"
              y="2"
              width="138"
              height="12"
              rx="6"
              fill={`url(#${uid}-tgrad)`}
              stroke="#7f1d1d"
              strokeWidth="1.2"
            />
            <ellipse cx="52" cy="8" rx="18" ry="2.6" fill="#fecaca" opacity="0.65" />
            <ellipse cx="114" cy="8" rx="18" ry="2.6" fill="#fecaca" opacity="0.65" />
          </svg>
        </div>
      )}

      {!["bun_top", "bun_bottom", "lettuce", "cheese", "patty", "tomato"].includes(item.category) && (
        <div className="-my-1">
          <svg width="168" height="16" viewBox="0 0 168 16" aria-hidden="true">
            <path
              d="M18 8 Q34 2, 50 8 T82 8 T114 8 T146 8"
              fill="none"
              stroke={item.color}
              strokeWidth="6.5"
              strokeLinecap="round"
            />
            <path
              d="M20 7 Q34 3, 50 7 T82 7 T114 7 T144 7"
              fill="none"
              stroke="rgba(255,255,255,0.45)"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}
    </motion.div>
  );
});

const MannequinStage = memo(function MannequinStage({
  slots,
  selected,
  reduced,
}: {
  slots: OutfitSlot[];
  selected: Record<string, string>;
  reduced: boolean | null;
}) {
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
      <svg
        width="176"
        height="210"
        viewBox="0 0 176 210"
        role="img"
        aria-label="معاينة الإطلالة على المانيكان"
      >
        <defs>
          <radialGradient id="mannequin-floor" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(242,184,75,0.34)" />
            <stop offset="100%" stopColor="rgba(242,184,75,0)" />
          </radialGradient>
          <linearGradient id="mannequin-sheen" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.26)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.25)" />
          </linearGradient>
        </defs>

        <ellipse cx="88" cy="196" rx="58" ry="9" fill="url(#mannequin-floor)" />
        <ellipse cx="88" cy="193" rx="34" ry="4" fill="rgba(0,0,0,0.42)" />
        <circle cx="88" cy="24" r="14.5" fill="#dec8b2" stroke="rgba(255,255,255,0.45)" strokeWidth="1.2" />
        <path d="M82 14 C86 11, 92 12, 95 16" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        <rect x="82" y="37" width="12" height="10" rx="4" fill="#ccb49b" />

        <g>
          <path
            d="M58 48 L118 48 L130 85 L114 90 L109 68 L109 110 L67 110 L67 68 L62 90 L46 85 Z"
            fill={topColor}
            style={{ transition: "fill 220ms cubic-bezier(0.22, 1, 0.36, 1)" }}
            stroke="rgba(255,255,255,0.3)"
            strokeWidth="1.3"
          />
          <path
            d="M58 48 L118 48 L130 85 L114 90 L109 68 L109 110 L67 110 L67 68 L62 90 L46 85 Z"
            fill="url(#mannequin-sheen)"
          />
          <path d="M79 48 L88 60 L97 48" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.3" />
        </g>

        <AnimatePresence>
          {hasOuter && (
            <motion.g
              key="outerwear-layer"
              initial={reduced ? false : { opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduced ? undefined : { opacity: 0, scale: 0.95 }}
              transition={reduced ? { duration: 0 } : APPLE_SPRING}
            >
              <path
                d="M55 46 L77 46 L81 112 L62 112 L65 70 L44 87 L53 54 Z M121 46 L99 46 L95 112 L114 112 L111 70 L132 87 L123 54 Z"
                fill={outerColor}
                style={{ transition: "fill 220ms cubic-bezier(0.22, 1, 0.36, 1)" }}
                stroke="rgba(255,255,255,0.38)"
                strokeWidth="1.4"
              />
              <path
                d="M77 46 L83 76 L77 82 M99 46 L93 76 L99 82"
                fill="none"
                stroke="rgba(255,255,255,0.32)"
                strokeWidth="1.2"
              />
            </motion.g>
          )}
        </AnimatePresence>

        <g>
          <path
            d="M67 110 L109 110 L114 174 L94 174 L88 134 L82 174 L62 174 Z"
            fill={bottomColor}
            style={{ transition: "fill 220ms cubic-bezier(0.22, 1, 0.36, 1)" }}
            stroke="rgba(255,255,255,0.24)"
            strokeWidth="1.3"
          />
          <path
            d="M67 110 L109 110 L114 174 L94 174 L88 134 L82 174 L62 174 Z"
            fill="url(#mannequin-sheen)"
          />
        </g>

        <rect
          x="59"
          y="175"
          width="24"
          height="12"
          rx="6"
          fill={shoeColor}
          stroke="rgba(255,255,255,0.3)"
          strokeWidth="1"
          style={{ transition: "fill 220ms cubic-bezier(0.22, 1, 0.36, 1)" }}
        />
        <rect
          x="93"
          y="175"
          width="24"
          height="12"
          rx="6"
          fill={shoeColor}
          stroke="rgba(255,255,255,0.3)"
          strokeWidth="1"
          style={{ transition: "fill 220ms cubic-bezier(0.22, 1, 0.36, 1)" }}
        />
        <line x1="61" y1="185" x2="81" y2="185" stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="95" y1="185" x2="115" y2="185" stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>

      <div className="mt-1.5 flex flex-wrap justify-center gap-1.5 text-[11px] text-slate-200">
        {slots.map((s) => {
          const lbl = findLabel(s.slot);
          return lbl ? (
            <span
              key={s.slot}
              className="rounded-full border border-amber-400/30 bg-white/10 px-2.5 py-0.5 font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
            >
              {lbl}
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
});

const ProductStudioStage = memo(function ProductStudioStage({
  finishes,
  activeFinishId,
  reduced,
}: {
  finishes: StudioFinish[];
  activeFinishId?: string;
  reduced: boolean | null;
}) {
  const active = finishes.find((f) => f.id === activeFinishId) ?? finishes[0];
  if (!active) return null;
  return (
    <div className="flex flex-col items-center justify-center py-2.5">
      <AnimatePresence mode="wait">
        <motion.div
          key={active.id}
          initial={reduced ? false : { opacity: 0, scale: 0.94, y: 5 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduced ? undefined : { opacity: 0, scale: 0.96, y: -3 }}
          transition={reduced ? { duration: 0 } : APPLE_SPRING}
          style={{ willChange: reduced ? undefined : "transform, opacity" }}
          className="flex flex-col items-center"
        >
          <svg
            width="156"
            height="182"
            viewBox="0 0 156 182"
            role="img"
            aria-label={active.label}
          >
            <defs>
              <linearGradient id="watch-glass-sheen" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(255,255,255,0.28)" />
                <stop offset="38%" stopColor="rgba(255,255,255,0.04)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </linearGradient>
              <linearGradient id="watch-case-rim" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(255,255,255,0.65)" />
                <stop offset="50%" stopColor="rgba(255,255,255,0.18)" />
                <stop offset="100%" stopColor="rgba(242,184,75,0.45)" />
              </linearGradient>
            </defs>

            <ellipse cx="78" cy="175" rx="44" ry="4.5" fill="rgba(0,0,0,0.45)" />

            <rect
              x="54"
              y="6"
              width="48"
              height="40"
              rx="11"
              fill={active.bandColor ?? "#1e293b"}
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="1"
            />
            <line x1="62" y1="16" x2="94" y2="16" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="62" y1="24" x2="94" y2="24" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" strokeLinecap="round" />

            <rect
              x="54"
              y="130"
              width="48"
              height="40"
              rx="11"
              fill={active.bandColor ?? "#1e293b"}
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="1"
            />
            <line x1="62" y1="152" x2="94" y2="152" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="62" y1="160" x2="94" y2="160" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" strokeLinecap="round" />

            <rect
              x="32"
              y="34"
              width="92"
              height="108"
              rx="26"
              fill={active.color}
              stroke="url(#watch-case-rim)"
              strokeWidth="2.2"
            />
            <rect x="124" y="58" width="7.5" height="22" rx="3.5" fill={active.color} stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
            <rect x="124" y="88" width="5" height="14" rx="2.5" fill={active.color} stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />

            <rect x="40" y="42" width="76" height="92" rx="20" fill="#050d1a" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
            <circle cx="78" cy="88" r="26" fill="none" stroke="rgba(242,184,75,0.18)" strokeWidth="4" />
            <circle
              cx="78"
              cy="88"
              r="26"
              fill="none"
              stroke="#f2b84b"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="122 44"
            />
            <circle cx="78" cy="88" r="18" fill="none" stroke="rgba(56,189,248,0.18)" strokeWidth="3.5" />
            <circle
              cx="78"
              cy="88"
              r="18"
              fill="none"
              stroke="#38bdf8"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray="84 32"
            />
            <text x="78" y="92" textAnchor="middle" fill="#f8fafc" fontSize="11.5" fontWeight="800">
              10:09
            </text>
            <path d="M42 44 L96 44 L54 132 L42 132 Z" fill="url(#watch-glass-sheen)" rx="18" />
          </svg>
          <p className="mt-1 text-xs font-extrabold tracking-tight text-white">{active.label}</p>
          {active.materialNote && (
            <p className="mt-0.5 rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-200">
              {active.materialNote}
            </p>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
});

export const LayeredStage = memo(function LayeredStage({
  mode,
  layers = [],
  activeLayerIds = [],
  outfitSlots = [],
  outfitBySlot = {},
  finishes = [],
  activeFinishId,
}: LayeredStageProps) {
  const reduced = useReducedMotion();
  const activeBurgerLayers = layers.filter((item) => activeLayerIds.includes(item.id));

  return (
    <div
      data-testid="infinite-card-stage"
      data-stage-mode={mode}
      className="relative flex min-h-[214px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-b from-[#061224] via-[#0b1f3b] to-[#050e1c] px-4 py-3.5 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_30px_-12px_rgba(0,0,0,0.55)] [contain:layout_paint]"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_26%,rgba(242,184,75,0.20),rgba(56,189,248,0.08)_42%,transparent_70%)]"
      />
      <div className="relative z-10 flex w-full flex-col items-center">
        {mode === "LAYERED_STACK" && (
          <motion.div
            layout={!reduced}
            className="flex flex-col items-center py-2"
            role="img"
            aria-label="معاينة الطبقات المختارة"
          >
            <AnimatePresence initial={false}>
              {activeBurgerLayers.map((item, idx) => (
                <BurgerLayerSvg key={item.id} item={item} index={idx} reduced={reduced} />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
        {mode === "MANNEQUIN" && (
          <MannequinStage slots={outfitSlots} selected={outfitBySlot} reduced={reduced} />
        )}
        {mode === "PRODUCT_STUDIO" && (
          <ProductStudioStage finishes={finishes} activeFinishId={activeFinishId} reduced={reduced} />
        )}
      </div>
    </div>
  );
});
