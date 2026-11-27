import { memo, useEffect, useRef } from "react";

/**
 * 120fps GPU-Composited Interactive Neural-Circuit Backdrop for JassimAI.
 * - Uses a pre-rasterized 600x600 spotlight disc moved strictly via `transform: translate3d(x, y, 0)`
 *   on its own compositor layer (`will-change: transform`), causing 0ms layout and 0ms paint!
 * - Skips pointer listeners on coarse-pointer (touch) devices and under prefers-reduced-motion.
 * - Wrapped in React.memo() so typing or token streaming in AiPage never re-renders the backdrop.
 */
export const InteractiveCircuitBg = memo(function InteractiveCircuitBg() {
  const spotlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const spot = spotlightRef.current;
    if (!spot || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;

    let raf = 0;
    let clientX = window.innerWidth * 0.5;
    let clientY = window.innerHeight * 0.38;

    const updateTransform = () => {
      raf = 0;
      spot.style.transform = `translate3d(${Math.round(clientX - 300)}px, ${Math.round(clientY - 300)}px, 0)`;
    };

    updateTransform();

    const onMove = (e: PointerEvent) => {
      clientX = e.clientX;
      clientY = e.clientY;
      if (!raf) {
        raf = window.requestAnimationFrame(updateTransform);
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="jassim-circuit-bg" aria-hidden="true">
      <div ref={spotlightRef} className="jassim-circuit-spotlight" />
      <svg
        className="jassim-circuit-svg"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        <defs>
          <linearGradient id="jassim-gold-trace" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--circuit-gold)" stopOpacity="0.1" />
            <stop offset="50%" stopColor="var(--circuit-gold)" stopOpacity="0.72" />
            <stop offset="100%" stopColor="var(--circuit-gold)" stopOpacity="0.15" />
          </linearGradient>
          <linearGradient id="jassim-blue-trace" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="var(--circuit-blue)" stopOpacity="0.12" />
            <stop offset="50%" stopColor="var(--circuit-blue)" stopOpacity="0.65" />
            <stop offset="100%" stopColor="var(--circuit-blue)" stopOpacity="0.1" />
          </linearGradient>
        </defs>

        <g className="jassim-circuit-lines" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
          <path d="M-10 120 H165 L235 190 H335" stroke="url(#jassim-blue-trace)" />
          <path d="M-10 185 H125 L195 255 H295 L345 205" stroke="url(#jassim-gold-trace)" className="jassim-pulse-path" />
          <path d="M-10 265 H95 L155 325 H225" stroke="url(#jassim-blue-trace)" />
          <path d="M-10 420 H110 L175 485 H270" stroke="url(#jassim-blue-trace)" />
          <path d="M-10 560 H140 L215 635 H320" stroke="url(#jassim-gold-trace)" className="jassim-pulse-path jassim-pulse-delay-1" />
          <path d="M-10 720 H185 L265 640 H365" stroke="url(#jassim-blue-trace)" />
          <path d="M60 910 V780 L145 695 H240" stroke="url(#jassim-gold-trace)" />
        </g>

        <g className="jassim-circuit-lines" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1450 110 H1260 L1185 185 H1085" stroke="url(#jassim-gold-trace)" className="jassim-pulse-path jassim-pulse-delay-2" />
          <path d="M1450 190 H1300 L1225 265 H1130" stroke="url(#jassim-blue-trace)" />
          <path d="M1450 310 H1330 L1255 385 H1175" stroke="url(#jassim-blue-trace)" />
          <path d="M1450 510 H1310 L1235 585 H1145" stroke="url(#jassim-gold-trace)" className="jassim-pulse-path jassim-pulse-delay-1" />
          <path d="M1450 670 H1270 L1190 750 H1075" stroke="url(#jassim-blue-trace)" />
          <path d="M1370 910 V795 L1285 710 H1190" stroke="url(#jassim-gold-trace)" />
        </g>

        <g className="jassim-circuit-lines" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M520 -10 V75 L585 140 H645" stroke="url(#jassim-blue-trace)" />
          <path d="M920 -10 V70 L855 135 H795" stroke="url(#jassim-gold-trace)" />
        </g>

        <g className="jassim-circuit-nodes">
          <circle cx="335" cy="190" r="3.2" fill="var(--circuit-blue)" />
          <circle cx="345" cy="205" r="3.6" fill="var(--circuit-gold)" />
          <circle cx="225" cy="325" r="2.8" fill="var(--circuit-blue)" />
          <circle cx="270" cy="485" r="3" fill="var(--circuit-blue)" />
          <circle cx="320" cy="635" r="3.5" fill="var(--circuit-gold)" />
          <circle cx="365" cy="640" r="3" fill="var(--circuit-blue)" />
          <circle cx="1085" cy="185" r="3.6" fill="var(--circuit-gold)" />
          <circle cx="1130" cy="265" r="3" fill="var(--circuit-blue)" />
          <circle cx="1175" cy="385" r="2.8" fill="var(--circuit-blue)" />
          <circle cx="1145" cy="585" r="3.5" fill="var(--circuit-gold)" />
          <circle cx="1075" cy="750" r="3" fill="var(--circuit-blue)" />
          <circle cx="645" cy="140" r="2.8" fill="var(--circuit-blue)" />
          <circle cx="795" cy="135" r="3.2" fill="var(--circuit-gold)" />
        </g>
      </svg>
    </div>
  );
});
