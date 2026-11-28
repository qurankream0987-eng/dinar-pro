import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { SmartImage } from "@/ui/Media";

/**
 * Jassim Ads Phase 1 display placements: the welcome hero carousel (paid VIP campaigns) and the
 * desktop sidebar card. The server decides everything (eligibility, order, label) and returns
 * nothing while DINAR_JASSIM_ADS is off — then this renders nothing at all. Every card shows the
 * sponsored label; it is never presented as Jassim's own answer. Visual polish: Google UI-15.
 */
type Card = { slot: number; kind?: "LISTING" | "STORE"; promotionId?: string; businessId?: string; listingId: string; title: string; price: string | null; currency: string; city: string | null; imagePath: string | null; sellerName: string; label: string; path: string };

function usePlacement(slot: "HERO" | "SIDEBAR", conversationId?: string, refreshKey?: string) {
  const [cards, setCards] = useState<Card[]>([]);
  const [context, setContext] = useState<"CONVERSATION" | "MARKET">("MARKET");
  useEffect(() => {
    let alive = true;
    // The sidebar follows the open conversation: the server reads its context (owner-checked).
    const params = new URLSearchParams({ slot, ...(conversationId ? { conversationId } : {}) });
    fetch(`/api/ads/placements?${params}`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : { cards: [] }))
      .then((data: { cards?: Card[]; context?: "CONVERSATION" | "MARKET" }) => {
        if (!alive) return;
        setCards(Array.isArray(data.cards) ? data.cards : []);
        setContext(data.context === "CONVERSATION" ? "CONVERSATION" : "MARKET");
      })
      .catch(() => alive && setCards([]));
    return () => {
      alive = false;
    };
  }, [slot, conversationId, refreshKey]);
  return { cards, context };
}

/** A click on a paid card is recorded by the server (never who clicked, only a keyed count). */
function recordClick(slot: "HERO" | "SIDEBAR", card: Card) {
  if (!card.promotionId) return;
  void fetch("/api/ads/placements/engagement", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot, promotionId: card.promotionId, kind: card.kind ?? "LISTING" }), keepalive: true }).catch(() => undefined);
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function HeroSponsored() {
  const { cards } = usePlacement("HERO");
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (cards.length < 2 || paused || reducedMotion()) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % cards.length), 6000);
    return () => window.clearInterval(timer);
  }, [cards.length, paused]);
  if (!cards.length) return null;
  const card = cards[index % cards.length]!;
  const go = (step: number) => setIndex((value) => (value + step + cards.length) % cards.length);
  return (
    <section
      className="relative mx-auto mb-4 w-full max-w-3xl overflow-hidden rounded-2xl border border-amber-300/60 bg-card shadow-sm"
      aria-roledescription="carousel"
      aria-label="عروض ممولة"
      data-testid="hero-sponsored"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") go(1);
        if (event.key === "ArrowRight") go(-1);
      }}
    >
      <Link href={card.path} className="flex min-h-32 items-center gap-4 p-4" data-testid="hero-sponsored-card" data-kind={card.kind ?? "LISTING"} data-listing-id={card.listingId} onClick={() => recordClick("HERO", card)}>
        <span className="h-28 w-28 shrink-0 overflow-hidden rounded-xl bg-muted sm:h-36 sm:w-36" data-testid="hero-sponsored-image">
          {card.imagePath ? <SmartImage src={card.imagePath} alt="" /> : null}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900" data-testid="hero-sponsored-label">{card.label}</span>
          <strong className="block truncate text-base">{card.title}</strong>
          <span className="block text-sm text-muted-foreground">
            {card.kind === "STORE" ? "متجر على جاسم — تصفّح منتجاته" : card.price ? <span dir="ltr" className="num font-semibold text-foreground">{card.price} {card.currency}</span> : "السعر بالاتفاق"}
            {card.city ? ` · ${card.city}` : ""}
          </span>
          <span className="mt-1 inline-flex h-8 items-center rounded-full bg-amber-400 px-3 text-xs font-semibold text-amber-950">{card.kind === "STORE" ? "زيارة المتجر" : "عرض التفاصيل والشراء"}</span>
        </span>
      </Link>
      {cards.length > 1 && (
        <div className="flex items-center justify-center gap-2 pb-3">
          <button type="button" className="grid h-9 w-9 place-items-center rounded-full border" aria-label="العرض السابق" onClick={() => go(-1)}><ChevronRight size={16} aria-hidden /></button>
          {cards.map((item, i) => (
            <span key={item.listingId} className={`h-2 w-2 rounded-full ${i === index % cards.length ? "bg-amber-500" : "bg-muted-foreground/30"}`} aria-hidden />
          ))}
          <button type="button" className="grid h-9 w-9 place-items-center rounded-full border" aria-label="العرض التالي" onClick={() => go(1)}><ChevronLeft size={16} aria-hidden /></button>
        </div>
      )}
    </section>
  );
}

/**
 * Sidebar ad space (owner design, 2026-11-27): one card at a time with the product photo, the price and
 * a call to action, rotating through up to three ranked ads (dots). The server ranks; the first card
 * is always the most relevant one. With an open conversation the server shows only ads related to it.
 */
export function SidebarSponsored({ conversationId, refreshKey }: { conversationId?: string; refreshKey?: string } = {}) {
  const { cards, context } = usePlacement("SIDEBAR", conversationId, refreshKey);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => setIndex(0), [cards]);
  useEffect(() => {
    if (cards.length < 2 || paused || reducedMotion()) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % cards.length), 7000);
    return () => window.clearInterval(timer);
  }, [cards.length, paused]);
  if (!cards.length) return null;
  const card = cards[index % cards.length]!;
  return (
    <aside className="mx-3 mb-3 hidden rounded-xl border border-amber-300/60 bg-card p-3 xl:block" aria-label="إعلان ممول" aria-roledescription="carousel" data-testid="sidebar-sponsored" data-count={cards.length} data-context={context}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <Link href={card.path} className="block space-y-2" data-testid="sidebar-sponsored-card" data-kind={card.kind ?? "LISTING"} data-listing-id={card.listingId} data-slot={card.slot} onClick={() => recordClick("SIDEBAR", card)}>
        <span className="flex items-start justify-between gap-2">
          <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">{card.label}</span>
        </span>
        <span className="flex items-center gap-3">
          <span className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-muted" data-testid="sidebar-sponsored-image">{card.imagePath ? <SmartImage src={card.imagePath} alt="" /> : null}</span>
          <span className="min-w-0 space-y-1">
            <strong className="block truncate text-sm">{card.title}</strong>
            {card.kind === "STORE" ? <span className="block text-xs text-muted-foreground">متجر على جاسم</span> : card.price && <span dir="ltr" className="num block text-sm font-semibold text-amber-700">{card.price} {card.currency}</span>}
            <span className="inline-flex h-7 items-center rounded-full bg-amber-400 px-2.5 text-[11px] font-semibold text-amber-950">{card.kind === "STORE" ? "زيارة المتجر" : "عرض التفاصيل"}</span>
          </span>
        </span>
      </Link>
      {cards.length > 1 && (
        <div className="mt-2 flex items-center justify-center gap-1.5" data-testid="sidebar-sponsored-dots">
          {cards.map((item, i) => (
            <button key={`${item.kind}-${item.listingId}`} type="button" className={`h-2 w-2 rounded-full ${i === index % cards.length ? "bg-amber-500" : "bg-muted-foreground/30"}`} aria-label={`الإعلان ${i + 1} من ${cards.length}`} aria-current={i === index % cards.length} onClick={() => setIndex(i)} />
          ))}
        </div>
      )}
    </aside>
  );
}
