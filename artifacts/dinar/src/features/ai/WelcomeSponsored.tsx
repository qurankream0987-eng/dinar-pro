import { memo, useEffect, useState } from "react";
import { Link } from "wouter";
import { Crown, ShoppingCart, Sparkles, X } from "lucide-react";
import { SmartImage } from "@/ui/Media";

/**
 * Welcome-screen sponsored cards (Sponsored Conversation, WELCOME placement). The server decides
 * everything: eligibility, at most three cards (policy-set), caps, stability per screen and dismissal. This only
 * renders what it returns, once per welcome key — typing never refetches or rotates them, and
 * nothing here is ever added to the conversation. No eligible card → nothing at all.
 */
type Card = {
  slot: number;
  listingId: string;
  title: string;
  price: string | null;
  currency: string;
  city: string | null;
  imagePath: string | null;
  sellerName: string;
  label: string;
  path: string;
};

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

export const WelcomeSponsored = memo(function WelcomeSponsored({ conversationId }: { conversationId?: string }) {
  const [key] = useState(() => welcomeKeyFor(conversationId));
  const [cards, setCards] = useState<Card[]>([]);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams({ key, ...(conversationId ? { conversationId } : {}) });
    fetch(`/api/ai/welcome-sponsored?${query}`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : { cards: [] }))
      .then((data: { cards?: Card[] }) => {
        if (alive) setCards(Array.isArray(data.cards) ? data.cards.slice(0, 3) : []);
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
    void fetch("/api/ai/welcome-sponsored/dismiss", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }).catch(() => undefined);
  };
  return (
    <section className="welcome-sponsored" aria-label="إعلانات ممولة" data-testid="welcome-sponsored">
      <div className="welcome-sponsored-head">
        <span className="welcome-sponsored-divider" aria-hidden="true" />
        <span className="welcome-sponsored-heading">
          <Sparkles size={13} aria-hidden="true" className="welcome-sponsored-spark" />
          <span>إعلانات مميزة لك</span>
          <Sparkles size={13} aria-hidden="true" className="welcome-sponsored-spark" />
        </span>
        <span className="welcome-sponsored-divider" aria-hidden="true" />
        <button
          type="button"
          className="welcome-sponsored-close"
          onClick={dismiss}
          aria-label="إخفاء الإعلانات الممولة"
          data-testid="welcome-sponsored-dismiss"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="welcome-sponsored-row">
        {cards.map((card, index) => (
          <Link
            key={card.listingId}
            href={card.path}
            className="welcome-sponsored-card"
            data-testid="welcome-sponsored-card"
            data-listing-id={card.listingId}
            data-vip={index === 0 ? "true" : undefined}
          >
            <span className="welcome-sponsored-media">
              {card.imagePath ? (
                <SmartImage src={card.imagePath} alt="" />
              ) : (
                <span className="welcome-sponsored-placeholder" aria-hidden />
              )}
            </span>
            <span className="welcome-sponsored-copy">
              <span className="welcome-sponsored-top">
                <span className="welcome-sponsored-label" data-testid="welcome-sponsored-label">
                  {index === 0 && <Crown size={10} aria-hidden="true" className="inline me-1" />}
                  {card.label}
                </span>
                {card.city && <span className="welcome-sponsored-city">{card.city}</span>}
              </span>
              <strong className="welcome-sponsored-title">{card.title}</strong>
              <span className="welcome-sponsored-bottom">
                <span className="welcome-sponsored-meta">
                  {card.price ? (
                    <bdi className="num welcome-sponsored-price">
                      {card.price} {card.currency}
                    </bdi>
                  ) : (
                    <span className="welcome-sponsored-price-alt">السعر بالاتفاق</span>
                  )}
                  <span aria-hidden> · </span>
                  <span className="welcome-sponsored-seller">{card.sellerName}</span>
                </span>
                <span className="welcome-sponsored-cta" aria-hidden="true">
                  <ShoppingCart size={13} />
                </span>
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
});
