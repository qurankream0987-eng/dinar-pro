/**
 * Smart Store Card visual renderer (UI-06 — docs/design/SMART-STORE-CARDS-BRIEF.md).
 * - Preserves 100% of the server Zod contract: sections in order, zero invented facts,
 *   server-only pricing & quotes, event-driven updates with revision tracking.
 * - Matches the approved JassimAI blue-and-gold glassmorphic design language (light & dark, RTL).
 */
import { useState } from "react";
import {
  BadgeCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Layers,
  Minus,
  Plus,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  UserRound,
  X,
} from "lucide-react";
import type { CardEvent, SmartSection, SmartStoreCard } from "@workspace/api-zod/smart-store-card";

type Send = (event: CardEvent) => void;

function HeroGallery({ section }: { section: Extract<SmartSection, { kind: "HERO_GALLERY" }> }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const items = section.media;
  const safeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
  const current = items[safeIndex];
  if (!current) return null;

  return (
    <div className="space-y-2.5">
      <div className="relative overflow-hidden rounded-2xl border border-amber-400/25 bg-muted/40 dark:bg-[#071526]">
        <figure className="relative m-0">
          <img
            src={current.url}
            alt={current.alt}
            loading="lazy"
            className="aspect-[4/3] w-full object-cover transition-opacity duration-200"
          />
          {current.illustrative && (
            <figcaption className="absolute bottom-2 start-2 rounded-full bg-black/65 px-2.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
              صورة توضيحية
            </figcaption>
          )}
        </figure>
        {items.length > 1 && (
          <>
            <button
              type="button"
              aria-label="الصورة السابقة"
              onClick={() => setActiveIndex((i) => (i - 1 + items.length) % items.length)}
              className="absolute start-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-amber-400/40 bg-black/55 text-amber-300 backdrop-blur-md transition hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="الصورة التالية"
              onClick={() => setActiveIndex((i) => (i + 1) % items.length)}
              className="absolute end-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-amber-400/40 bg-black/55 text-amber-300 backdrop-blur-md transition hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {items.length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5" role="list" aria-label="مصغرات الصور">
          {items.map((item, idx) => {
            const selected = idx === safeIndex;
            return (
              <button
                key={idx}
                type="button"
                aria-label={`عرض الصورة ${idx + 1}`}
                aria-pressed={selected}
                onClick={() => setActiveIndex(idx)}
                className={`relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                  selected
                    ? "border-amber-400 ring-2 ring-amber-400/35"
                    : "border-border/70 opacity-75 hover:opacity-100"
                }`}
              >
                <img src={item.url} alt="" loading="lazy" className="h-full w-full object-cover" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Section({ section, card, send }: { section: SmartSection; card: SmartStoreCard; send?: Send }) {
  const ref = { cardId: card.cardId, revision: card.revision };
  switch (section.kind) {
    case "UNDERSTOOD_REQUEST":
      return (
        <div className="flex flex-wrap gap-2" aria-label="فهمت طلبك">
          {section.chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-amber-400/35 bg-amber-500/10 ps-3 pe-1.5 text-xs font-medium text-foreground dark:text-amber-100"
            >
              <span>{chip.label}</span>
              {send && (
                <button
                  type="button"
                  aria-label={`إزالة ${chip.label}`}
                  onClick={() => send({ type: "REFINE_REMOVE", ...ref, chipId: chip.id })}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition hover:bg-amber-400/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </div>
      );

    case "CATEGORY_TABS":
      return (
        <div role="tablist" className="flex gap-2 overflow-x-auto pb-1">
          {section.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.selected}
              disabled={!send}
              onClick={() => send?.({ type: "SELECT_TAB", ...ref, tabId: tab.id })}
              className={`min-h-11 shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-60 ${
                tab.selected
                  ? "border-amber-400 bg-gradient-to-l from-amber-400/20 to-sky-500/20 text-foreground shadow-xs dark:text-amber-200"
                  : "border-border bg-card/60 text-muted-foreground hover:border-amber-400/45 hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      );

    case "HERO_GALLERY":
      return <HeroGallery section={section} />;

    case "PRODUCT_GRID":
      return (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {section.products.map((product) => (
            <button
              key={product.id}
              type="button"
              disabled={!send || !product.available}
              aria-pressed={product.selected ?? false}
              onClick={() => send?.({ type: "SELECT_PRODUCT", ...ref, productId: product.id })}
              className={`group relative flex flex-col overflow-hidden rounded-2xl border p-2.5 text-start transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                product.selected
                  ? "border-amber-400 bg-amber-500/10 shadow-[0_0_0_1px_rgba(242,184,75,0.45)] dark:bg-amber-400/10"
                  : "border-border/80 bg-card/70 hover:border-amber-400/50 dark:bg-[#0a1a2e]/80"
              } ${product.available ? "" : "opacity-55"}`}
            >
              {product.selected && (
                <span
                  aria-hidden="true"
                  className="absolute end-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 text-[#061321] shadow"
                >
                  <Check size={13} strokeWidth={3} />
                </span>
              )}
              <div className="mb-2 aspect-square w-full overflow-hidden rounded-xl bg-muted/50">
                <img
                  src={product.media.url}
                  alt={product.media.alt}
                  loading="lazy"
                  className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.03]"
                />
              </div>
              <span className="line-clamp-2 text-xs font-semibold leading-snug text-foreground">
                {product.title}
              </span>
              <span className="mt-auto pt-1.5 text-xs font-extrabold tabular-nums text-amber-700 dark:text-amber-300">
                <bdi>{product.available ? product.price.label : "غير متوفر"}</bdi>
              </span>
            </button>
          ))}
        </div>
      );

    case "PRODUCT_DETAIL":
      return (
        <div className="space-y-1.5 rounded-2xl border border-border/70 bg-muted/25 p-3.5 dark:border-sky-400/20 dark:bg-[#081729]/75">
          <h4 className="text-base font-bold leading-snug text-foreground">{section.title}</h4>
          {section.subtitle && (
            <p className="text-xs leading-relaxed text-muted-foreground">{section.subtitle}</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-lg font-extrabold tabular-nums text-amber-700 dark:text-amber-300">
              <bdi>{section.price.label}</bdi>
            </p>
            {section.rating && (
              <p className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                <Star size={12} className="fill-amber-400 text-amber-400" aria-hidden="true" />
                <bdi>{section.rating.value.toFixed(1)}</bdi>
                <span className="text-muted-foreground">
                  (<bdi>{section.rating.count}</bdi> تقييم)
                </span>
              </p>
            )}
          </div>
        </div>
      );

    case "VARIANT_PICKER":
      if (section.style === "STEPPER") {
        const quantity = Number(section.options.find((option) => option.selected)?.label ?? 1) || 1;
        const productId =
          (card.sections.find((item) => item.kind === "PRODUCT_DETAIL") as { productId?: string } | undefined)
            ?.productId ?? "item";
        return (
          <div
            className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/60 px-3.5 py-2 dark:border-sky-400/20 dark:bg-[#081729]/70"
            aria-label={section.label}
          >
            <span className="text-xs font-semibold text-foreground">{section.label}</span>
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                aria-label="إنقاص الكمية"
                disabled={!send || quantity <= 1}
                onClick={() => send?.({ type: "SET_QUANTITY", ...ref, productId, quantity: quantity - 1 })}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground transition hover:border-amber-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-40"
              >
                <Minus size={15} aria-hidden="true" />
              </button>
              <bdi className="min-w-8 text-center text-sm font-bold tabular-nums">{quantity}</bdi>
              <button
                type="button"
                aria-label="زيادة الكمية"
                disabled={!send || quantity >= 99}
                onClick={() => send?.({ type: "SET_QUANTITY", ...ref, productId, quantity: quantity + 1 })}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground transition hover:border-amber-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-40"
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      }
  