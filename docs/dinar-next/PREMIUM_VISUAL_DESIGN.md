# DINAR premium visual upgrade

Baseline:0990a7ed4686b0778b9411e5cb16edb73de40f66. Isolated local branch codex/dinar-premium-visual. No publication permission inferred from prior audit publication.

## Reference and gaps (before implementation)
The attachments show a premium commerce workspace and a logo, not two before/after UI screenshots. Actual baseline is captured from the running application. The reference informs material, hierarchy and branding; sample ratings, discounts, prices, warranties and stock are not authorized data.

| Area | Actual baseline | Target |
| --- | --- | --- |
| Identity | Small woven diamond, DINAR/BDINAR/Arabic lockups differ | One legible DINAR AI lockup and shared vector mark, blue D/chat/cart and gold rim |
| Hierarchy | Small greeting and sparse sidebar | Larger expressive hero, branded sidebar, strong primary action |
| Material | Mostly flat opaque panels | Navy atmosphere, translucent layered surfaces, fine cyan strokes, warm highlights |
| Spacing/radii | Multiple independent rounded treatments | Consistent 12/18/26px material scale; preserve responsive grid |
| Commerce | Existing authoritative cards and comparison | Richer media framing, prominent stored prices, coherent CTA hierarchy, no invented claims |
| Motion | Scattered easing/entrances | Shared spring and duration tokens, quiet hover/entrance/focus, reduced-motion overrides |
| Mobile | Existing drawer and composer safeguards | Preserve safe areas/keyboard/RTL and native scrolling; reduce expensive blur |
| Accessibility | Radix focus/keyboard patterns | Retain semantics, visible focus, readable light/dark contrast and no looping distraction |

## Official library research and decisions
Read official repository documentation on2026-11-09. Sources: motiondivision/motion packages/framer-motion/README.md; radix-ui/primitives; shadcn-ui/ui; floating-ui/floating-ui; davidjerleke/embla-carousel; tailwindlabs/tailwindcss (raw.githubusercontent.com). Raw evidence retained in /workspace/dinar-premium-evidence.

Reuse installed framer-motion for a bounded spring entrance; Radix for existing dialogs, menus and focus restoration; Tailwind/CSS gradients, blur and design tokens for materials. Reuse existing carousel behavior (Embla already installed) without changing RTL interaction. Do not install another shadcn component set or direct Floating UI layer over current Radix. No Lenis: preserve native scrolling, keyboard and reduced-motion behavior. No additional dependency or lockfile change. Measure production build delta; cap blur on mobile and avoid continuous atmosphere animation.

## Integration boundary
Only presentation components/assets/styles. Preserve one runtime, cart, legal gates, server pricing and receipts. Claude intelligence source remains independent at974fb1e; visual overlap includes Ai.tsx, ConversationHistory.tsx, AiChat.css and shared branding; hand off these exact paths without merging either history.


## Incremental review checkpoint
Owner authorized publication of this isolated visual branch on 2026-11-09 for Claude review.
The baseline and first visual revision each passed all 160 Command E browser captures
(8 surfaces × 10 widths × 2 themes), with no overflow, unnamed controls, small touch
targets, hidden composer or console errors. Drawer Escape and composer focus passed.
Screenshots and complete reports are in [premium-visual-evidence](premium-visual-evidence).
They use disposable fixture listings; missing product images remain honest placeholders.
The isolated browser uses font stubs, so screenshots reflect the installed fallback fonts.

Workspace typecheck passed for the initial visual implementation. The final production web
build passes after narrowing Motion to LazyMotion/domAnimation: main JS 992.08 kB,
gzip 297.97 kB, versus baseline 915.74 kB / 271.49 kB. No package/lockfile changes.
The pre-existing >500 kB chunk warning remains. The final narrower Motion import and title
update are under a fresh Command E plus commerce/accessibility/performance regression run.
This is a review checkpoint, not a claim that final acceptance is complete.

The canonical mark is an original SVG adaptation of the supplied D/chat/cart direction,
not a pixel-identical export of the attached artwork. No model, API, database, cart or order
logic is changed. Historical audit evidence and original worktrees remain preserved.
