import { useEffect, useState } from "react";
import { Link } from "wouter";
import { X } from "lucide-react";
import { SmartImage } from "@/ui/Media";

/**
 * Welcome-screen sponsored cards (Sponsored Conversation, WELCOME placement). The server decides
 * everything: eligibility, at most two cards, caps, stability per screen and dismissal. This only
 * renders what it returns, once per welcome key — typing never refetches or rotates them, and
 * nothing here is ever added to the conversation. No eligible card → nothing at all.
 */
type Card = { slot: number; listingId: string; title: string; price: string | null; currency: string; city: string | null; imagePath: string | null; sellerName: string; label: string; path: string; whyShown?: string };

const NONCE_KEY = "jassim-welcome-key";
/** The new-conversation screen's key: the empty conversation's id, or a nonce for this screen. */
export function welcomeKeyFor(conversationId?: string): string {
  if (conversationId) return conversationId;
  try {
    const existing = sessionStorage.getItem(NONCE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(NONCE_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}
/** Called when the first message is sent: the next new conversation gets its own key. */
export function retireWelcomeKey() {
  try {
    sessionStorage.removeItem(NONCE_KEY);
  } catch {
    // Storage unavailable: a fresh key is generated per screen anyway.
  }
}

export function WelcomeSponsored({ conversationId }: { conversationId?: string }) {
  const [key] = useState(() => welcomeKeyFor(conversationId));
  const [cards, setCards] = useState<Card[]>([]);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams({ key, ...(conversationId ? { conversationId } : {}) });
    fetch(`/api/ai/welcome-sponsored?${query}`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : { cards: [] }))
      .then((data: { cards?: Card[] }) => {
        if (alive) setCards(Array.isArray(data.cards) ? data.cards.slice(0, 2) : []);
      })
      .catch(() => alive && setCards([]));
    return () => {
      alive = false;
    };
    // One read per screen key; never on keystrokes.
  }, [key, conversationId]);
  if (hidden || cards.length === 0) return null;
  const dismiss = () => {
    setHidden(true);
    void fetch("/api/ai/welcome-sponsored/dismiss", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }).catch(() => undefined);
  };
  return (
    <section className="welcome-sponsored" aria-label="إعلانات ممولة" data-testid="welcome-sponsored">
      <div className="welcome-sponsored-head">
        <span>إعلانات ممولة</span>
        <button type="button" className="welcome-sponsored-close" onClick={dismiss} aria-label="إخفاء الإعلانات الممولة" data-testid="welcome-sponsored-dismiss">
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="welcome-sponsored-row">
        {cards.map((card) => (
          <Link key={card.listingId} href={card.path} className="welcome-sponsored-card" data-testid="welcome-sponsored-card" data-listing-id={card.listingId}>
            <span className="welcome-sponsored-media">
              {card.imagePath ? <SmartImage src={card.imagePath} alt="" /> : <span className="welcome-sponsored-placeholder" aria-hidden />}
            </span>
            <span className="welcome-sponsored-copy">
              <span className="welcome-sponsored-label" data-testid="welcome-sponsored-label">{card.label}</span>
              <strong>{card.title}</strong>
              <span className="welcome-sponsored-meta">
                {card.price ? <span className="num">{card.price} {card.currency}</span> : <span>السعر بالاتفاق</span>}
                <span aria-hidden> · </span>
                <span>{card.sellerName}</span>
              </span>
              {card.whyShown ? (
                <span className="welcome-sponsored-why" data-testid="welcome-sponsored-why" title="لماذا أرى هذا الإعلان؟">
                  {card.whyShown}
                </span>
              ) : null}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
