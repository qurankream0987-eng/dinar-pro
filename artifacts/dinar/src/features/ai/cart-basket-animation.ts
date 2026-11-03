/**
 * Product-thumbnail-to-basket flight used after the canonical REST cart action
 * returns success. The caller decides success from the server response; this module
 * only draws the acknowledgement and never mutates the cart or shows a receipt.
 */
export type BasketFlightResult =
  | "animated"
  | "reduced-motion"
  | "no-image"
  | "no-target"
  | "unsupported";

const CART_SELECTORS = [
  '[data-testid="link-cart"]',
  '[data-testid="sidebar-cart"]',
  '[data-testid="footer-cart"]',
];

function visibleCartTarget(): HTMLElement | undefined {
  for (const selector of CART_SELECTORS) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return element;
  }
  return undefined;
}

function announce(name: string, detail: Record<string, unknown>) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

export function animateListingToBasket(
  source: Element | null | undefined,
): BasketFlightResult {
  if (typeof window === "undefined" || typeof document === "undefined")
    return "unsupported";
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    announce("dinar:cart-flight-skipped", { reason: "reduced-motion" });
    return "reduced-motion";
  }
  const image =
    source instanceof HTMLImageElement
      ? source
      : (source?.querySelector("img") ?? null);
  if (!image || !image.complete || image.naturalWidth === 0) {
    announce("dinar:cart-flight-skipped", { reason: "no-image" });
    return "no-image";
  }
  const target = visibleCartTarget();
  if (!target) {
    announce("dinar:cart-flight-skipped", { reason: "no-target" });
    return "no-target";
  }
  const from = image.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (from.width <= 0 || from.height <= 0) {
    announce("dinar:cart-flight-skipped", { reason: "no-image" });
    return "no-image";
  }
  const flight = image.cloneNode(true) as HTMLImageElement;
  flight.removeAttribute("data-testid");
  flight.setAttribute("data-testid", "cart-flight");
  flight.setAttribute("aria-hidden", "true");
  flight.alt = "";
  flight.style.cssText = [
    "position:fixed",
    `left:${from.left}px`,
    `top:${from.top}px`,
    `width:${from.width}px`,
    `height:${from.height}px`,
    "margin:0",
    "border-radius:16px",
    "object-fit:cover",
    "pointer-events:none",
    "z-index:9999",
    "will-change:transform,opacity",
    "box-shadow:0 18px 40px rgba(0,0,0,.28)",
  ].join(";");
  document.body.appendChild(flight);

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const arrivalScale = Math.max(
    0.12,
    Math.min(0.5, to.width / Math.max(from.width, 1)),
  );
  if (typeof flight.animate !== "function") {
    flight.remove();
    announce("dinar:cart-flight-skipped", { reason: "unsupported" });
    return "unsupported";
  }
  announce("dinar:cart-flight-start", { left: from.left, top: from.top });

  const animation = flight.animate(
    [
      { transform: "translate(0px, 0px) scale(1)", opacity: 1, offset: 0 },
      {
        transform: `translate(${dx * 0.55}px, ${dy * 0.45 - Math.min(48, Math.abs(dy) * 0.15)}px) scale(${(1 + arrivalScale) / 2})`,
        opacity: 0.92,
        offset: 0.55,
      },
      {
        transform: `translate(${dx}px, ${dy}px) scale(${arrivalScale})`,
        opacity: 0,
        offset: 1,
      },
    ],
    {
      duration: 620,
      easing: "cubic-bezier(.22,.61,.36,1)",
      fill: "forwards",
    },
  );
  const finish = () => {
    flight.remove();
    announce("dinar:cart-flight-end", {});
  };
  animation.finished.then(finish, finish);
  return "animated";
}
