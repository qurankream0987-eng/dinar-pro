# Jassim AI — Design System Specification (`UI-02`)

## 1. Core Principles
- **Arabic-First & Logical RTL:** Every layout uses CSS logical properties (`ms-`, `me-`, `ps-`, `pe-`, `start`, `end`, `text-start`, `rtl:rotate-180`). Physical `left`/`right` utilities are prohibited for layout. Prices, phone numbers, and codes use `dir="ltr"` / `<bdi>` with tabular numerals.
- **No Unverified Claims:** Prices, currency, fees, and statuses always come from the server.
- **Motion:** Fast and purposeful (`--dur-fast: 120ms`, `--dur-base: 200ms`, `--dur-slow: 320ms`, `--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1)`), strictly honoring `prefers-reduced-motion`.

## 2. Color Tokens (`artifacts/dinar/src/index.css`)
Defined separately for **Light (`:root`)** and **Dark (`.dark`)** modes with WCAG 2.1 AA contrast:
- **Brand:** `--primary`, `--primary-hover`, `--primary-foreground`, `--primary-soft`, `--accent` (warm gold `#f4b21f` accent only), `--accent-ink`.
- **Neutrals:** `--background`, `--foreground`, `--card`, `--elevated`, `--popover`, `--muted`, `--muted-foreground`, `--text-secondary`, `--border`, `--border-strong`, `--input`, `--ring`.
- **Semantic:** `--success` / `--success-soft`, `--warning` / `--warning-soft`, `--destructive` / `--destructive-soft`, `--info` / `--info-soft`, `--disabled`.

## 3. Spacing, Radius & Touch Scale
- **Spacing (4/8 grid):** `--space-1: 4px`, `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-6: 24px`, `--space-8: 32px`.
- **Radius:** `--radius-sm: 0.5rem`, `--radius-md: 0.75rem`, `--radius-lg: 1rem`, `--radius-xl: 1.25rem`, `--radius-pill: 9999px`.
- **Touch Targets:** `--touch-min: 44px` minimum for all interactive controls on mobile (`360px`–`390px`).
- **Typography:** `IBM Plex Sans Arabic` (`400, 500, 600, 700`), `--leading-arabic: 1.65`, body `>= 16px` on mobile.

## 4. Primitives Refactored in UI-02
Converted 16 UI primitives under `artifacts/dinar/src/components/ui/` (`dialog`, `alert-dialog`, `sheet`, `drawer`, `select`, `accordion`, `dropdown-menu`, `context-menu`, `menubar`, `table`, `command`, `alert`, `field`, `navigation-menu`, `pagination`, `toast`) from physical directional classes (`sm:text-left`, `pl-8`, `pr-2`, `ml-auto`, `left-4`) to logical RTL utilities (`sm:text-start`, `ps-8`, `pe-2`, `ms-auto`, `start-4`, `rtl:rotate-180`).
