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

function usePlacement(slot: "HERO" | "SIDEBAR") {
  const [cards, setCards] = useState<Card[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/ads/placements?slot=${slot}`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : { cards: [] }))
      .then((data: { cards?: Card[] }) => alive && setCards(Array.isArray(data.cards) ? data.cards : []))
      .catch(() => alive && setCards([]));
    return () => {
      alive = false;
    };
  }, [slot]);
  return cards;
}

/** A click on a paid card is recorded by the server (never who clicked, only a keyed count). */
function recordClick(slot: "HERO" | "SIDEBAR", card: Card) {
  if (!card.promotionId) return;
  void fetch("/api/ads/placements/engagement", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot, promotionId: card.promotionId, kind: card.kind ?? "LISTING" }), keepalive: true }).catch(() => undefined);
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function HeroSponsored() {
  const cards = usePlacement("HERO");
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
        <span className="h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-muted">
          {card.imagePath ? <SmartImage src={card.imagePath} alt="" /> : null}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900" data-testid="hero-sponsored-label">{card.label}</span>
          <strong className="block truncate text-base">{card.title}</strong>
          <span className="block text-sm text-muted-foreground">
            {card.kind === "STORE" ? "متجر على جاسم — تصفّح منتجاته" : card.price ? <span dir="ltr" className="num font-semibold text-foreground">{card.price} {card.currency}</span> : "السعر بالاتفاق"}
            {card.city ? ` · ${card.city}` : ""}
          </span>
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

export function SidebarSponsored() {
  const cards = usePlacement("SIDEBAR");
  if (!cards.length) return null;
  const card = cards[0]!;
  return (
    <aside className="mx-3 mb-3 hidden rounded-xl border border-amber-300/60 bg-card p-3 xl:block" aria-label="إعلان ممول" data-testid="sidebar-sponsored">
      <Link href={card.path} className="flex items-center gap-3" data-testid="sidebar-sponsored-card" data-kind={card.kind ?? "LISTING"} data-listing-id={card.listingId} onClick={() => recordClick("SIDEBAR", card)}>
        <span className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">{card.imagePath ? <SmartImage src={card.imagePath} alt="" /> : null}</span>
        <span className="min-w-0 space-y-0.5">
          <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">{card.label}</span>
          <strong className="block truncate text-sm">{card.title}</strong>
          {card.kind === "STORE" ? <span className="block text-xs text-muted-foreground">متجر على جاسم</span> : card.price && <span dir="ltr" className="num block text-xs font-semibold">{card.price} {card.currency}</span>}
        </span>
      </Link>
    </aside>
  );
}
