/**
 * Smart Store Card visual renderer (Apple-Grade Royal Edition — UI-06 + Owner Mockup 3).
 * - Preserves 100% of the server Zod contract: all 13 section kinds in order, zero invented facts,
 *   server-only pricing & quotes, event-driven updates with revision tracking.
 * - Features the Notched Royal Blue & Gold «جاسم كونيكت» crown header, specular inner hairlines,
 *   44px touch controls, and reserved In-Chat Payment slot.
 */
import { memo, useState } from "react";
import {
  BadgeCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Heart,
  Link2,
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
      <div className="relative overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-b from-slate-900/90 to-[#061325] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_12px_28px_-10px_rgba(0,0,0,0.45)]">
        <figure className="relative m-0">
          <img
            src={current.url}
            alt={current.alt}
            loading="lazy"
            className="aspect-[4/3] w-full object-cover transition-transform duration-300"
          />
          {current.illustrative && (
            <figcaption className="absolute bottom-2.5 start-2.5 rounded-full border border-white/15 bg-black/70 px-2.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-md">
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
              className="pressable absolute start-2.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-amber-400/45 bg-[#07162c]/75 text-amber-300 shadow-md backdrop-blur-md transition hover:border-amber-300 hover:bg-[#07162c]/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="الصورة التالية"
              onClick={() => setActiveIndex((i) => (i + 1) % items.length)}
              className="pressable absolute end-2.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-amber-400/45 bg-[#07162c]/75 text-amber-300 shadow-md backdrop-blur-md transition hover:border-amber-300 hover:bg-[#07162c]/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {items.length > 1 && (
        <div className="flex items-center justify-center gap-2 overflow-x-auto pb-0.5" role="list" aria-label="مصغرات الصور">
          {items.map((item, idx) => {
            const selected = idx === safeIndex;
            return (
              <button
                key={idx}
                type="button"
                aria-label={`عرض الصورة ${idx + 1}`}
                aria-pressed={selected}
                onClick={() => setActiveIndex(idx)}
                className={`pressable relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                  selected
                    ? "border-amber-400 ring-2 ring-amber-400/40 shadow-[0_0_12px_rgba(242,184,75,0.3)]"
                    : "border-border/70 opacity-70 hover:opacity-100"
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
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-amber-400/35 bg-amber-500/12 ps-3 pe-1.5 text-xs font-medium text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] dark:text-amber-100"
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
              className={`pressable min-h-11 shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-60 ${
                tab.selected
                  ? "border-amber-400 bg-gradient-to-l from-amber-400/25 to-sky-500/20 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_4px_14px_rgba(242,184,75,0.18)] dark:text-amber-200"
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
              className={`pressable group relative flex flex-col overflow-hidden rounded-2xl border p-2.5 text-start transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                product.selected
                  ? "border-amber-400 bg-amber-500/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_0_0_1px_rgba(242,184,75,0.45)] dark:bg-amber-400/12"
                  : "border-border/80 bg-card/75 hover:border-amber-400/50 dark:bg-[#0a1a2e]/85"
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
        <div className="space-y-2 rounded-2xl border border-border/70 bg-muted/25 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] dark:border-sky-400/20 dark:bg-[#081729]/80">
          <div className="flex items-start justify-between gap-2">
            <h4 className="text-base font-bold leading-snug text-foreground">{section.title}</h4>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
              <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              متوفر
            </span>
          </div>
          {section.subtitle && (
            <p className="text-xs leading-relaxed text-muted-foreground">{section.subtitle}</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-xl font-extrabold tabular-nums text-amber-700 dark:text-[#f5c451]">
              <bdi>{section.price.label}</bdi>
            </p>
            {section.rating && (
              <p className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 bg-amber-400/12 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:text-amber-200">
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
            className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/60 px-3.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:border-sky-400/20 dark:bg-[#081729]/75"
            aria-label={section.label}
          >
            <span className="text-xs font-semibold text-foreground">{section.label}</span>
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                aria-label="إنقاص الكمية"
                disabled={!send || quantity <= 1}
                onClick={() => send?.({ type: "SET_QUANTITY", ...ref, productId, quantity: quantity - 1 })}
                className="pressable flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground transition hover:border-amber-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-40"
              >
                <Minus size={15} aria-hidden="true" />
              </button>
              <bdi className="min-w-8 text-center text-sm font-bold tabular-nums">{quantity}</bdi>
              <button
                type="button"
                aria-label="زيادة الكمية"
                disabled={!send || quantity >= 99}
                onClick={() => send?.({ type: "SET_QUANTITY", ...ref, productId, quantity: quantity + 1 })}
                className="pressable flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground transition hover:border-amber-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-40"
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      }
      return (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-semibold text-foreground">{section.label}</legend>
          <div className="flex flex-wrap gap-2">
            {section.options.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={option.selected}
                aria-label={option.label}
                disabled={!send || !option.available}
                onClick={() =>
                  send?.({
                    type: "SELECT_OPTION",
                    ...ref,
                    groupId: section.groupId,
                    optionId: option.id,
                    selected: true,
                  })
                }
                className={`pressable inline-flex min-h-11 items-center gap-2 rounded-xl border px-3.5 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                  option.selected
                    ? "border-amber-400 bg-amber-500/15 font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_0_0_1px_rgba(242,184,75,0.35)] dark:text-amber-100"
                    : "border-border/80 bg-card/70 text-muted-foreground hover:border-amber-400/45 hover:text-foreground"
                } ${option.available ? "" : "line-through opacity-45"}`}
              >
                {option.color && (
                  <span
                    aria-hidden="true"
                    className="inline-block size-3.5 shrink-0 rounded-full border border-white/35 shadow-xs"
                    style={{ background: option.color }}
                  />
                )}
                <span>{option.label}</span>
                {option.price && (
                  <bdi className="ms-1 text-[11px] font-bold tabular-nums text-amber-700 dark:text-amber-300">
                    {option.price.label}
                  </bdi>
                )}
              </button>
            ))}
          </div>
        </fieldset>
      );

    case "CUSTOMIZER":
      return (
        <fieldset className="space-y-1.5 rounded-2xl border border-border/70 bg-muted/20 p-3 dark:border-sky-400/20 dark:bg-[#081729]/60">
          <legend className="px-1 text-xs font-semibold text-foreground">{section.label}</legend>
          <div className="flex flex-wrap gap-2">
            {section.options.map((option) => (
              <label
                key={option.id}
                className={`pressable inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                  option.selected
                    ? "border-amber-400 bg-amber-500/15 font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]"
                    : "border-border/80 bg-card/70 text-muted-foreground hover:border-amber-400/40"
                }`}
              >
                <input
                  type={section.multi ? "checkbox" : "radio"}
                  name={section.groupId}
                  checked={option.selected}
                  disabled={!send}
                  onChange={(event) =>
                    send?.({
                      type: "SELECT_OPTION",
                      ...ref,
                      groupId: section.groupId,
                      optionId: option.id,
                      selected: event.target.checked,
                    })
                  }
                  className="accent-amber-500"
                />
                <span>{option.label}</span>
                {option.delta && (
                  <bdi className="text-[11px] font-bold tabular-nums text-amber-700 dark:text-amber-300">
                    +{option.delta.label}
                  </bdi>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      );

    case "BUNDLE_BUILDER":
      return (
        <div className="space-y-2 rounded-2xl border border-border/70 bg-muted/25 p-3.5 dark:border-sky-400/20 dark:bg-[#081729]/70">
          <h4 className="text-xs font-bold text-foreground">{section.label}</h4>
          <ul className="divide-y divide-border/50 text-xs">
            {section.slots.map((slot) => (
              <li key={slot.slotId} className="flex items-center justify-between gap-2 py-1.5">
                <span className="font-medium text-muted-foreground">{slot.label}</span>
                <span className="font-semibold text-foreground">
                  {slot.item ? (
                    <>
                      {slot.item.title} —{" "}
                      <bdi className="tabular-nums text-amber-700 dark:text-amber-300">
                        {slot.item.price.label}
                      </bdi>
                    </>
                  ) : (
                    <span className="text-muted-foreground">لم يُختر بعد</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {section.compatibility && (
            <p
              className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-foreground"
              role="status"
            >
              التوافق:{" "}
              {section.compatibility.status === "COMPATIBLE"
                ? "متوافق"
                : section.compatibility.status === "INCOMPATIBLE"
                  ? "غير متوافق"
                  : "غير متحقق منه"}
              {section.compatibility.note ? ` — ${section.compatibility.note}` : ""}
            </p>
          )}
        </div>
      );

    case "SPECS":
      return (
        <dl className="grid grid-cols-2 gap-2 rounded-2xl border border-border/70 bg-muted/20 p-3 text-xs dark:border-sky-400/15 dark:bg-[#071526]/70">
          {section.rows.map((row, index) => (
            <div key={index} className="rounded-xl border border-border/50 bg-card/50 px-2.5 py-1.5 dark:border-white/5">
              <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
              <dd className="mt-0.5 font-semibold text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      );

    case "POLICIES":
      return (
        <ul className="flex flex-wrap gap-1.5" aria-label="الضمانات والسياسات">
          {section.items.map((item, index) => (
            <li
              key={index}
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/25 bg-sky-500/10 px-3 py-1 text-[11px] font-medium text-foreground dark:text-sky-100"
            >
              <ShieldCheck size={13} className="shrink-0 text-amber-400" aria-hidden="true" />
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      );

    case "RECOMMENDATIONS":
      return (
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-muted-foreground">{section.label}</h4>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {section.items.map((item) => (
              <span
                key={item.id}
                className="shrink-0 rounded-xl border border-border/80 bg-card/70 px-3 py-1.5 text-xs font-medium text-foreground"
              >
                {item.title}
              </span>
            ))}
          </div>
        </div>
      );

    case "MEDIA_3D":
      return null;

    case "TRY_ON":
      return (
        <p className="rounded-xl border border-dashed border-amber-400/35 bg-amber-500/8 px-3 py-2 text-xs text-muted-foreground">
          {section.reason}
        </p>
      );
  }
}

export const SmartStoreCardView = memo(function SmartStoreCardView({
  card,
  onEvent,
  busy = false,
}: {
  card: SmartStoreCard;
  onEvent?: Send;
  busy?: boolean;
}) {
  const send = busy ? undefined : onEvent;
  const isBusiness = card.store.kind !== "INDIVIDUAL";

  return (
    <section
      dir="rtl"
      aria-label={card.store.name}
      data-testid="smart-store-card"
      data-vertical={card.vertical}
      data-revision={card.revision}
      className="dinar-royal-store-card mt-3 w-full min-w-0 max-w-xl overflow-hidden rounded-[26px] border border-amber-400/40 bg-card/95 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_22px_50px_-16px_rgba(0,8,24,0.65)] [overflow-wrap:anywhere] [contain:layout_paint] dark:bg-[#07182e]/98"
    >
      {/* Notched Royal Blue & Gold Crown Header matching Owner Mockup 3 */}
      <header className="relative overflow-hidden border-b border-amber-400/30 bg-gradient-to-l from-[#0a2752] via-[#113a78] to-[#081d3f] px-4 py-3 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-6 end-0 h-14 w-28 rotate-12 bg-gradient-to-l from-amber-300/35 via-amber-400/15 to-transparent blur-md"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-l from-amber-300 via-amber-400/70 to-sky-400/40"
        />
        <div className="relative z-10 flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-amber-300/45 bg-gradient-to-br from-amber-400/30 to-sky-500/20 text-amber-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
              {isBusiness ? <Link2 size={17} aria-hidden="true" /> : <UserRound size={17} aria-hidden="true" />}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="truncate text-sm font-extrabold tracking-tight text-white">
                  {card.store.name}
                </h3>
                {card.store.verified && (
                  <BadgeCheck size={15} className="shrink-0 text-amber-300" aria-hidden="true" />
                )}
              </div>
              <p className="truncate text-[11px] font-medium text-sky-100/85">
                {card.store.kind === "INDIVIDUAL"
                  ? "بائع فرد"
                  : card.store.verified
                    ? "جاسم كونيكت · نشاط تجاري موثّق"
                    : "جاسم كونيكت · نشاط تجاري"}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {card.store.sponsored && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/55 bg-gradient-to-l from-amber-400 to-amber-300 px-2.5 py-0.5 text-[11px] font-extrabold text-slate-950 shadow-xs">
                <Sparkles size={11} aria-hidden="true" />
                ممول
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="space-y-3.5 p-4">
        {card.source && (
          <p className="flex items-center justify-between gap-2 rounded-xl border border-sky-400/20 bg-sky-500/8 px-3 py-1.5 text-[11px] text-muted-foreground dark:text-sky-100/80">
            <span className="inline-flex items-center gap-1.5">
              <Store size={13} className="text-amber-400" aria-hidden="true" />
              <span>حسب نظام المتجر</span>
            </span>
            <span>
              تم التحقق{" "}
              <time dateTime={card.source.checkedAt} className="font-semibold tabular-nums">
                {new Date(card.source.checkedAt).toLocaleTimeString("ar", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </span>
          </p>
        )}

        {card.sections.map((section, index) => (
          <Section key={`${section.kind}-${index}`} section={section} card={card} send={send} />
        ))}

        {card.notice && (
          <p
            role="status"
            className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-foreground"
          >
            {card.notice}
          </p>
        )}

        <div data-slot="in-chat-payment-slot" aria-label="مساحة الدفع داخل المحادثة" />

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3.5 dark:border-sky-400/20">
          {card.quote ? (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">
                الإجمالي
                {!card.quote.final && (
                  <span className="ms-1 text-[11px] text-muted-foreground">(تقديري — يؤكده المتجر)</span>
                )}
              </p>
              <p className="text-lg font-extrabold tabular-nums text-amber-700 dark:text-[#f5c451]">
                <bdi>{card.quote.total.label}</bdi>
              </p>
            </div>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!send || card.status !== "READY"}
              onClick={() =>
                send?.({
                  type: "PRIMARY_ACTION",
                  cardId: card.cardId,
                  revision: card.revision,
                })
              }
              className="pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-amber-200/70 bg-gradient-to-l from-[#f7d47c] via-[#f1b944] to-[#e09c24] px-5 py-2 text-xs font-extrabold text-[#111c2d] shadow-[inset_0_1px_0_#fff9e2,0_8px_22px_rgba(241,185,68,0.34)] transition hover:brightness-105 disabled:opacity-50"
            >
              <span>{card.primaryAction.label}</span>
              <ExternalLink size={14} aria-hidden="true" />
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
});
