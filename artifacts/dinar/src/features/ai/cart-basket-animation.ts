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

  // A basketball shot: a quadratic arc whose apex sits above both ends, sampled into keyframes
  // so the browser interpolates transforms only (no layout work during the flight).
  const lift = Math.min(160, 56 + Math.abs(dx) * 0.22);
  const control = { x: dx * 0.5, y: Math.min(0, dy) - lift };
  const frames: Keyframe[] = [];
  const steps = 10;
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    const x = 2 * (1 - t) * t * control.x + t * t * dx;
    const y = 2 * (1 - t) * t * control.y + t * t * dy;
    const scale = 1 + (arrivalScale - 1) * t;
    frames.push({
      transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`,
      opacity: t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2,
      offset: t,
    });
  }
  const animation = flight.animate(frames, {
    duration: 620,
    easing: "cubic-bezier(.33,.0,.67,1)",
    fill: "forwards",
  });
  const finish = () => {
    flight.remove();
    // The basket "catches" the product: a short scale/tilt on the real cart target.
    target.classList.remove("dinar-basket-catch");
    void target.offsetWidth; // restart the animation for consecutive adds
    target.classList.add("dinar-basket-catch");
    window.setTimeout(() => target.classList.remove("dinar-basket-catch"), 420);
    announce("dinar:cart-flight-end", {});
  };
  animation.finished.then(finish, finish);
  return "animated";
}
