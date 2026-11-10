import { useEffect, useState } from "react";
import { Link } from "wouter";
import { money } from "@/lib/format";

type Glimpse = { id: string; title: string; imageUrl: string; unitPrice: string; currency: string; sellerName: string; isSponsored?: boolean };

const SHOW_MS = 4200;
const GAP_MS = 2600;
// Fixed, unobtrusive slots around the welcome logo; one card at a time.
const SLOTS = ["is-slot-a", "is-slot-b", "is-slot-c", "is-slot-d"];

/**
 * Small cards for real published listings that bloom near the welcome logo and fade away, one at
 * a time. Data comes only from the public listings endpoint of the current market; when it has
 * nothing (or browsing is closed), nothing renders. Sponsored listings carry «ممول».
 */
export function ListingGlimpses() {
  const [items, setItems] = useState<Glimpse[]>([]);
  const [turn, setTurn] = useState<{ index: number; slot: string; visible: boolean } | null>(null);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const controller = new AbortController();
    fetch("/api/listings?sort=NEWEST", { credentials: "include", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: unknown) => {
        if (!Array.isArray(rows)) return;
        const usable = (rows as Glimpse[]).filter((row) => row?.id && row.title && row.imageUrl && row.unitPrice && row.currency).slice(0, 24);
        for (let i = usable.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [usable[i], usable[j]] = [usable[j]!, usable[i]!]; }
        setItems(usable);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!items.length) return;
    let index = 0;
    let timer: number;
    const show = () => {
      setTurn({ index, slot: SLOTS[Math.floor(Math.random() * SLOTS.length)]!, visible: true });
      timer = window.setTimeout(hide, SHOW_MS);
    };
    const hide = () => {
      setTurn((current) => (current ? { ...current, visible: false } : current));
      index = (index + 1) % items.length;
      timer = window.setTimeout(show, GAP_MS);
    };
    timer = window.setTimeout(show, 1200);
    return () => window.clearTimeout(timer);
  }, [items]);

  if (!turn) return null;
  const item = items[turn.index];
  if (!item) return null;
  let price = "";
  try { price = money(item.unitPrice, item.currency); } catch { return null; }
  return (
    <div className="listing-glimpses" aria-hidden={!turn.visible}>
      <Link
        key={`${item.id}-${turn.slot}`}
        href={`/listings/${item.id}`}
        className={`listing-glimpse ${turn.slot}${turn.visible ? " is-visible" : ""}`}
        data-testid="listing-glimpse"
        tabIndex={turn.visible ? 0 : -1}
        aria-label={`${item.title}، ${price}${item.isSponsored ? "، ممول" : ""}`}
      >
        <img src={item.imageUrl} alt="" loading="lazy" decoding="async" />
        <span className="listing-glimpse-text">
          <strong>{item.title}</strong>
          <span>{price}{item.isSponsored ? <em> · ممول</em> : null}</span>
        </span>
      </Link>
    </div>
  );
}
