import { memo, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Layers, Minus, Plus, ShieldCheck, Sparkles, Store } from "lucide-react";
import { LayeredStage } from "./LayeredStage";
import {
  isValidUniversalCardSpec,
  type LayerItem,
  type OutfitSlot,
  type StudioFinish,
  type UniversalCardEvent,
  type UniversalCardSelection,
  type UniversalCardSpec,
} from "./schema";

const PILL_SPRING = { type: "spring" as const, stiffness: 400, damping: 30, mass: 0.7 };

function buildInitialSelection(spec: UniversalCardSpec): UniversalCardSelection {
  let activeLayerIds: string[] = [];
  let outfitBySlot: Record<string, string> = {};
  let finishId: string | undefined;
  const chipsByBlock: Record<string, string> = {};
  let quantity = 1;
  for (const block of spec.blocks) {
    if (block.type === "LAYER_BUILDER") activeLayerIds = [...block.defaultActiveIds];
    if (block.type === "OUTFIT_SLOTS") outfitBySlot = { ...block.defaults };
    if (block.type === "STUDIO_FINISHES") finishId = block.defaultFinishId;
    if (block.type === "OPTION_CHIPS") chipsByBlock[block.id] = block.defaultOptionId;
    if (block.type === "STEPPER") quantity = block.defaultValue;
  }
  return { activeLayerIds, outfitBySlot, finishId, chipsByBlock, quantity };
}

export const UniversalCardEngine = memo(function UniversalCardEngine({
  spec,
  onEvent,
  busy = false,
}: {
  spec: UniversalCardSpec;
  onEvent?: (event: UniversalCardEvent) => void;
  busy?: boolean;
}) {
  const valid = isValidUniversalCardSpec(spec);
  const reduced = useReducedMotion();
  const [selection, setSelection] = useState<UniversalCardSelection>(() =>
    valid ? buildInitialSelection(spec) : { activeLayerIds: [], outfitBySlot: {}, chipsByBlock: {}, quantity: 1 },
  );

  const stageData = useMemo(() => {
    let layers: LayerItem[] = [];
    let outfitSlots: OutfitSlot[] = [];
    let finishes: StudioFinish[] = [];
    for (const block of spec.blocks) {
      if (block.type === "LAYER_BUILDER") layers = block.items;
      if (block.type === "OUTFIT_SLOTS") outfitSlots = block.slots;
      if (block.type === "STUDIO_FINISHES") finishes = block.finishes;
    }
    return { layers, outfitSlots, finishes };
  }, [spec.blocks]);

  if (!valid) return null;

  const updateSelection = (next: UniversalCardSelection) => {
    setSelection(next);
    onEvent?.({ cardId: spec.cardId, action: "SELECTION_CHANGED", selection: next });
  };

  const toggleLayer = (item: LayerItem) => {
    if (item.required) return;
    const exists = selection.activeLayerIds.includes(item.id);
    const activeLayerIds = exists
      ? selection.activeLayerIds.filter((id) => id !== item.id)
      : [...selection.activeLayerIds, item.id];
    updateSelection({ ...selection, activeLayerIds });
  };

  const isBusiness = spec.merchantTier === "BUSINESS" || spec.merchantTier === "CONNECT_PARTNER";

  return (
    <article
      dir="rtl"
      data-testid={`universal-card-${spec.cardId}`}
      data-stage-mode={spec.stageMode}
      className="animate-fade w-full max-w-[468px] overflow-hidden rounded-[26px] border border-amber-400/40 bg-card/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_22px_50px_-16px_rgba(0,8,24,0.65)] dark:bg-[#07182e]/98 [contain:layout_paint]"
    >
      <header
        className={
          isBusiness
            ? "relative overflow-hidden border-b border-amber-400/30 bg-gradient-to-l from-[#0a2752] via-[#113a78] to-[#081d3f] px-4 py-3 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
            : "flex items-center justify-between gap-2 border-b border-border/70 bg-muted/40 px-4 py-3 text-foreground"
        }
      >
        {isBusiness && (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-6 end-0 h-14 w-28 rotate-12 bg-gradient-to-l from-amber-300/35 via-amber-400/15 to-transparent blur-md"
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-l from-amber-300 via-amber-400/70 to-sky-400/40"
            />
          </>
        )}
        <div className="relative z-10 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-amber-300/45 bg-gradient-to-br from-amber-400/30 to-sky-500/20 text-amber-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
              {spec.stageMode === "LAYERED_STACK" ? <Layers size={16} aria-hidden /> : <Store size={16} aria-hidden />}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-extrabold">{spec.merchantName}</p>
              <p className={`truncate text-[11px] ${isBusiness ? "text-sky-100/85" : "text-muted-foreground"}`}>
                {spec.merchantTier === "CONNECT_PARTNER"
                  ? "جاسم كونيكت · متجر تفاعلي"
                  : isBusiness
                    ? "متجر موثّق"
                    : "بائع فرد"}
              </p>
            </div>
          </div>
          {spec.badge && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/45 bg-amber-500/18 px-2.5 py-0.5 text-[11px] font-bold text-amber-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
              <Sparkles size={11} aria-hidden />
              {spec.badge}
            </span>
          )}
        </div>
      </header>

      <div className="space-y-3.5 p-4">
        <div>
          <h3 className="text-base font-extrabold leading-snug text-foreground">{spec.title}</h3>
          {spec.subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{spec.subtitle}</p>}
        </div>

        <LayeredStage
          mode={spec.stageMode}
          layers={stageData.layers}
          activeLayerIds={selection.activeLayerIds}
          outfitSlots={stageData.outfitSlots}
          outfitBySlot={selection.outfitBySlot}
          finishes={stageData.finishes}
          activeFinishId={selection.finishId}
        />

        <div className="space-y-3">
          {spec.blocks.map((block) => {
            if (block.type === "LAYER_BUILDER") {
              return (
                <div key={block.id} className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">{block.title}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {block.items.map((item) => {
                      const active = selection.activeLayerIds.includes(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={item.required}
                          aria-pressed={active}
                          onClick={() => toggleLayer(item)}
                          data-testid={`layer-toggle-${item.id}`}
                          className={`pressable inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition ${
                            active
                              ? "border-amber-400/75 bg-amber-500/15 font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ring-1 ring-amber-400/30"
                              : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"
                          } ${item.required ? "cursor-default opacity-80" : ""}`}
                        >
                          <span
                            className="size-2.5 shrink-0 rounded-full border border-white/30 shadow-xs"
                            style={{ backgroundColor: item.color }}
                            aria-hidden
                          />
                          <span>{item.label}</span>
                          {item.priceDeltaLabel && (
                            <bdi dir="ltr" className="text-[11px] font-bold tabular-nums text-amber-600 dark:text-amber-300">
                              {item.priceDeltaLabel}
                            </bdi>
                          )}
                          {active && <Check size={13} className="text-amber-400" aria-hidden />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            if (block.type === "OUTFIT_SLOTS") {
              return (
                <div key={block.id} className="space-y-2.5">
                  <p className="text-xs font-semibold text-foreground">{block.title}</p>
                  {block.slots.map((slot) => (
                    <div key={slot.slot} className="space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">{slot.label}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {slot.options.map((opt) => {
                          const active = selection.outfitBySlot[slot.slot] === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              aria-pressed={active}
                              onClick={() =>
                                updateSelection({
                                  ...selection,
                                  outfitBySlot: { ...selection.outfitBySlot, [slot.slot]: opt.id },
                                })
                              }
                              data-testid={`outfit-${slot.slot}-${opt.id}`}
                              className={`pressable relative inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-2.5 text-xs transition ${
                                active
                                  ? "border-amber-400/75 bg-amber-500/15 font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ring-1 ring-amber-400/30"
                                  : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"
                              }`}
                            >
                              {opt.color !== "transparent" && opt.color !== "none" && (
                                <span
                                  className="size-3 shrink-0 rounded-full border border-white/35 shadow-xs"
                                  style={{ backgroundColor: opt.color }}
                                  aria-hidden
                                />
                              )}
                              <span>{opt.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              );
            }
            if (block.type === "STUDIO_FINISHES") {
              return (
                <div key={block.id} className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">{block.title}</p>
                  <div className="flex flex-wrap gap-2">
                    {block.finishes.map((fin) => {
                      const active = selection.finishId === fin.id;
                      return (
                        <button
                          key={fin.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => updateSelection({ ...selection, finishId: fin.id })}
                          data-testid={`finish-${fin.id}`}
                          className={`pressable relative inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-xs transition ${
                            active
                              ? "border-amber-400/75 bg-amber-500/15 font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ring-1 ring-amber-400/30"
                              : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"
                          }`}
                        >
                          <span
                            className="size-4 rounded-full border border-white/45 shadow-xs"
                            style={{ backgroundColor: fin.color }}
                            aria-hidden
                          />
                          <span>{fin.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            if (block.type === "OPTION_CHIPS") {
              return (
                <div key={block.id} className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">{block.title}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {block.options.map((opt) => {
                      const active = selection.chipsByBlock[block.id] === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() =>
                            updateSelection({
                              ...selection,
                              chipsByBlock: { ...selection.chipsByBlock, [block.id]: opt.id },
                            })
                          }
                          className={`pressable relative min-h-10 rounded-xl border px-3 text-xs font-medium transition ${
                            active
                              ? "border-amber-400/75 text-foreground"
                              : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"
                          }`}
                        >
                          {active && (
                            <motion.span
                              layoutId={`chip-pill-${spec.cardId}-${block.id}`}
                              transition={reduced ? { duration: 0 } : PILL_SPRING}
                              className="absolute inset-0 rounded-xl bg-amber-500/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                            />
                          )}
                          <span className="relative z-10 font-semibold">{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            if (block.type === "STEPPER") {
              return (
                <div
                  key={block.id}
                  className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/30 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                >
                  <span className="text-xs font-semibold text-foreground">{block.label}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="تقليل الكمية"
                      disabled={selection.quantity <= block.min}
                      onClick={() =>
                        updateSelection({
                          ...selection,
                          quantity: Math.max(block.min, selection.quantity - 1),
                        })
                      }
                      className="pressable grid size-9 place-items-center rounded-lg border border-border bg-background text-foreground disabled:opacity-40"
                    >
                      <Minus size={15} aria-hidden />
                    </button>
                    <span className="min-w-6 text-center text-sm font-bold tabular-nums">{selection.quantity}</span>
                    <button
                      type="button"
                      aria-label="زيادة الكمية"
                      disabled={selection.quantity >= block.max}
                      onClick={() =>
                        updateSelection({
                          ...selection,
                          quantity: Math.min(block.max, selection.quantity + 1),
                        })
                      }
                      className="pressable grid size-9 place-items-center rounded-lg border border-border bg-background text-foreground disabled:opacity-40"
                    >
                      <Plus size={15} aria-hidden />
                    </button>
                  </div>
                </div>
              );
            }
            if (block.type === "TRUST_STRIP") {
              return (
                <div
                  key={block.id}
                  className="flex flex-wrap gap-1.5 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground"
                >
                  {block.items.map((item) => (
                    <span
                      key={item}
                      className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-2.5 py-0.5 text-foreground"
                    >
                      <ShieldCheck size={12} className="text-emerald-400" aria-hidden />
                      {item}
                    </span>
                  ))}
                </div>
              );
            }
            return null;
          })}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-400/30 bg-muted/35 px-3.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] dark:bg-[#08172b]/85">
          <div>
            <p className="text-[11px] text-muted-foreground">
              {spec.quote.pendingRequote ? "جارٍ تحديث السعر من الخادم…" : "الإجمالي المعتمد من الخادم"}
            </p>
            <bdi
              dir="ltr"
              className="text-lg font-extrabold tabular-nums text-amber-700 dark:text-[#f5c451]"
              data-testid="universal-card-total"
            >
              {spec.quote.totalLabel}
            </bdi>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => onEvent?.({ cardId: spec.cardId, action: "PRIMARY_CTA", selection })}
            data-testid="universal-card-cta"
            className="pressable min-h-11 rounded-full border border-amber-200/70 bg-gradient-to-l from-[#f7d47c] via-[#f1b944] to-[#e09c24] px-5 text-xs font-extrabold text-[#111c2d] shadow-[inset_0_1px_0_#fff9e2,0_8px_22px_rgba(241,185,68,0.34)] transition hover:brightness-105 disabled:opacity-60"
          >
            {spec.primaryCtaLabel}
          </button>
        </div>
        <div data-slot="in-chat-payment-slot" aria-label="مساحة الدفع داخل المحادثة" />
        {spec.illustrative && (
          <p className="text-center text-[11px] text-muted-foreground">
            معاينة تفاعلية تجريبية — الأسعار الحقيقية تُحسب دائمًا من الخادم.
          </p>
        )}
      </div>
    </article>
  );
});
