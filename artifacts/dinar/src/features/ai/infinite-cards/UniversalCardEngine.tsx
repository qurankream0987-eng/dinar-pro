import { useMemo, useState } from "react";
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

export function UniversalCardEngine({ spec, onEvent, busy = false }: { spec: UniversalCardSpec; onEvent?: (event: UniversalCardEvent) => void; busy?: boolean }) {
  const valid = isValidUniversalCardSpec(spec);
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
    const activeLayerIds = exists ? selection.activeLayerIds.filter((id) => id !== item.id) : [...selection.activeLayerIds, item.id];
    updateSelection({ ...selection, activeLayerIds });
  };

  const isBusiness = spec.merchantTier === "BUSINESS" || spec.merchantTier === "CONNECT_PARTNER";

  return (
    <article dir="rtl" data-testid={`universal-card-${spec.cardId}`} data-stage-mode={spec.stageMode} className="animate-fade w-full max-w-[460px] overflow-hidden rounded-2xl border border-amber-500/30 bg-card/95 shadow-md backdrop-blur-sm">
      <header className={isBusiness ? "flex items-center justify-between gap-2 border-b border-amber-400/25 bg-gradient-to-l from-[#0a2347] via-[#10366c] to-[#0b2750] px-4 py-3 text-white" : "flex items-center justify-between gap-2 border-b border-border/70 bg-muted/40 px-4 py-3 text-foreground"}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-amber-500/20 text-amber-400">
            {spec.stageMode === "LAYERED_STACK" ? <Layers size={16} aria-hidden /> : <Store size={16} aria-hidden />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-bold">{spec.merchantName}</p>
            <p className={`truncate text-[11px] ${isBusiness ? "text-blue-100/80" : "text-muted-foreground"}`}>
              {spec.merchantTier === "CONNECT_PARTNER" ? "جاسم كونيكت · متجر تفاعلي" : isBusiness ? "متجر موثّق" : "بائع فرد"}
            </p>
          </div>
        </div>
        {spec.badge && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">
            <Sparkles size={11} aria-hidden />
            {spec.badge}
          </span>
        )}
      </header>
      <div className="space-y-3.5 p-4">
        <div>
          <h3 className="text-base font-bold leading-snug text-foreground">{spec.title}</h3>
          {spec.subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{spec.subtitle}</p>}
        </div>
        <LayeredStage mode={spec.stageMode} layers={stageData.layers} activeLayerIds={selection.activeLayerIds} outfitSlots={stageData.outfitSlots} outfitBySlot={selection.outfitBySlot} finishes={stageData.finishes} activeFinishId={selection.finishId} />
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
                        <button key={item.id} type="button" disabled={item.required} aria-pressed={active} onClick={() => toggleLayer(item)} data-testid={`layer-toggle-${item.id}`} className={`pressable inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition ${active ? "border-amber-500/60 bg-amber-500/12 font-semibold text-foreground ring-1 ring-amber-500/25" : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"} ${item.required ? "cursor-default opacity-80" : ""}`}>
                          <span className="size-2.5 shrink-0 rounded-full border border-black/20" style={{ backgroundColor: item.color }} aria-hidden />
                          <span>{item.label}</span>
                          {item.priceDeltaLabel && <bdi dir="ltr" className="text-[11px] tabular-nums text-amber-600 dark:text-amber-400">{item.priceDeltaLabel}</bdi>}
                          {active && <Check size={13} className="text-amber-500" aria-hidden />}
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
                            <button key={opt.id} type="button" aria-pressed={active} onClick={() => updateSelection({ ...selection, outfitBySlot: { ...selection.outfitBySlot, [slot.slot]: opt.id } })} data-testid={`outfit-${slot.slot}-${opt.id}`} className={`pressable inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-2.5 text-xs transition ${active ? "border-amber-500/60 bg-amber-500/12 font-semibold text-foreground ring-1 ring-amber-500/25" : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"}`}>
                              {opt.color !== "transparent" && opt.color !== "none" && <span className="size-3 shrink-0 rounded-full border border-white/30 shadow-xs" style={{ backgroundColor: opt.color }} aria-hidden />}
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
                        <button key={fin.id} type="button" aria-pressed={active} onClick={() => updateSelection({ ...selection, finishId: fin.id })} data-testid={`finish-${fin.id}`} className={`pressable inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-xs transition ${active ? "border-amber-500/60 bg-amber-500/12 font-semibold text-foreground ring-1 ring-amber-500/25" : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"}`}>
                          <span className="size-4 rounded-full border border-white/40 shadow-xs" style={{ backgroundColor: fin.color }} aria-hidden />
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
                        <button key={opt.id} type="button" aria-pressed={active} onClick={() => updateSelection({ ...selection, chipsByBlock: { ...selection.chipsByBlock, [block.id]: opt.id } })} className={`pressable min-h-10 rounded-xl border px-3 text-xs font-medium transition ${active ? "border-amber-500/60 bg-amber-500/12 font-semibold text-foreground" : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"}`}>
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            if (block.type === "STEPPER") {
              return (
                <div key={block.id} className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/30 px-3 py-2">
                  <span className="text-xs font-semibold text-foreground">{block.label}</span>
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label="تقليل الكمية" disabled={selection.quantity <= block.min} onClick={() => updateSelection({ ...selection, quantity: Math.max(block.min, selection.quantity - 1) })} className="pressable grid size-9 place-items-center rounded-lg border border-border bg-background text-foreground disabled:opacity-40"><Minus size={15} aria-hidden /></button>
                    <span className="min-w-6 text-center text-sm font-bold tabular-nums">{selection.quantity}</span>
                    <button type="button" aria-label="زيادة الكمية" disabled={selection.quantity >= block.max} onClick={() => updateSelection({ ...selection, quantity: Math.min(block.max, selection.quantity + 1) })} className="pressable grid size-9 place-items-center rounded-lg border border-border bg-background text-foreground disabled:opacity-40"><Plus size={15} aria-hidden /></button>
                  </div>
                </div>
              );
            }
            if (block.type === "TRUST_STRIP") {
              return (
                <div key={block.id} className="flex flex-wrap gap-1.5 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
                  {block.items.map((item) => (
                    <span key={item} className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2.5 py-0.5"><ShieldCheck size={12} className="text-emerald-500" aria-hidden />{item}</span>
                  ))}
                </div>
              );
            }
            return null;
          })}
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/35 px-3.5 py-2.5">
          <div>
            <p className="text-[11px] text-muted-foreground">{spec.quote.pendingRequote ? "جارٍ تحديث السعر من الخادم…" : "الإجمالي المعتمد من الخادم"}</p>
            <bdi dir="ltr" className="text-base font-bold tabular-nums text-foreground" data-testid="universal-card-total">{spec.quote.totalLabel}</bdi>
          </div>
          <button type="button" disabled={busy} onClick={() => onEvent?.({ cardId: spec.cardId, action: "PRIMARY_CTA", selection })} data-testid="universal-card-cta" className="pressable min-h-11 rounded-xl bg-gradient-to-l from-amber-500 to-amber-400 px-4 text-xs font-bold text-slate-950 shadow-xs transition hover:brightness-105 hover:shadow-[0_6px_20px_rgba(245,158,11,0.28)] disabled:opacity-60">
            {spec.primaryCtaLabel}
          </button>
        </div>
        <div data-slot="in-chat-payment-slot" aria-label="مساحة الدفع داخل المحادثة" />
        {spec.illustrative && <p className="text-center text-[11px] text-muted-foreground">معاينة تفاعلية تجريبية — الأسعار الحقيقية تُحسب دائمًا من الخادم.</p>}
      </div>
    </article>
  );
}
