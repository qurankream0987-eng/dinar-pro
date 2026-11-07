# Command 03: premium chat UX final review

**Executed by Claude on its own branch**, per the owner's earlier choice. The command was addressed to Codex.
- Branch: `claude/dinar-next-intelligence`.
- Base: `5b540c8` (Command 02).
- Final SHA: the commit that adds this file.
- Command 01 is on `claude/connect-01-modes` `7d42dd0`.
- No merge, no deployment, no paid model or GPU, no production data.

**This is not a production-readiness claim for DINAR.**

## Audit result (what already existed, measured in the browser)

| Area | Finding |
|---|---|
| Identity | Blue / gold / sky tokens already central in `artifacts/dinar/src/index.css` (`--dinar-blue`, `--dinar-gold`, `--primary`, `--accent`, dark palette) |
| Motion language | One CSS system already exists: duration tokens `--dur-fast` 120 ms / `--dur-base` 200 ms / `--dur-slow` 320 ms, `--ease-out`, animations rise / fade / pop / shimmer / sheet / modal, `ai-message-in` for new turns, plus a global `prefers-reduced-motion` rule. Verified: no animation over 10 ms runs under reduced motion |
| Cart animation | `features/ai/cart-basket-animation.ts`: thumbnail-to-basket flight **only after the confirmed server cart mutation**; skipped and announced for reduced motion, no image or no target. Browser proof: `wave03-d7-cart-browser-journey` (pass) |
| Motion for React | `framer-motion` is a declared dependency but has **0 imports** |
| Theme | light / dark / system via `lib/theme.ts`; the matrix confirmed each across 8 widths |

## Decision on Motion for React

**Not added.** The CSS system already covers the following, and the browser measured no scroll frame over 50 ms (p95 17 ms):
- new-message entrance;
- sheets and modals;
- skeleton shimmer;
- the confirmed cart flight;
- reduced motion.

The main JS chunk is already 914 KB raw / 269 KB gzip. Pulling in Motion for decorative transitions would add weight with no measured gain.

Recommended only for a future shared-layout feature (card expand to a detail view), loaded lazily (`LazyMotion` + dynamic `domAnimation`), and re-measured.

## Changes in this command

| File | Change |
|---|---|
| `artifacts/api-server/src/ai/business-turn.ts` | UX16 defect: «سجّل متجري في دينار كونكت» created the D2 draft (correct first step) but never mentioned Connect. The reply now explains that Connect builds on this identity, points to `/connect` with the three participation modes, and states that nothing was registered in Connect yet |
| `artifacts/api-server/test/premium-ux-browser-journey.test.ts` + `artifacts/dinar/test/premium-ux-browser.mjs` | New Chromium suite: performance, 24-cell visual matrix, UX03 / UX08 / UX16 / UX24, reduced motion, short viewport |
| `docs/dinar-next/evidence/premium-ux/*.png` | 52 screenshots (before / after × 3 themes × 8 widths, reduced motion, keyboard open) |

## Accessibility status

**Verified in the browser:**
- RTL on every matrix cell;
- named buttons ≥ 32 px (existing `widths` helper in other suites);
- list / listitem semantics for generated grids;
- keyboard focus;
- reduced motion;
- `w02u3-card-accessibility-browser-journey` passes.

**Not run:** Lighthouse / axe. No audit tool is installed, and no dependency was added.

## Live model

BLOCKED_PROVIDER (see `MODEL_INTELLIGENCE_BENCHMARK.md`). All UX evidence uses DINAR's deterministic path plus a stub gateway.
