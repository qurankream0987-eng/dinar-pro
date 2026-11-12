# JassimAI — Phase 1: Intelligent UI Foundation

## Executive summary

Phase 1 adds **tables and line/donut charts** to the existing JassimAI card system. It extends the
one presentation contract the app already has (the composed-surface `SurfaceSectionSchema` inside
the versioned Card Envelope); it is not a second contract. It also gives merchants a **real,
server-grounded monthly sales chart and table** in the existing «تحليل النشاط» card.

- No new dependency. Recharts 2.15.4 was already installed and unused; it now loads lazily in its own chunk.
- No new runtime, cart, payment, subscription or agent framework.
- The model does **not** yet choose these visuals. The new model card fences exist and are
  validated, but they are not announced in the model prompt. That is Phase 2.

## Actual baseline

| | |
|---|---|
| Branch | `claude/jassimai-phase1-intelligent-ui-foundation` (local only, not pushed) |
| Starting SHA | `00fde928e617ceafa8a0f3ab5c7497b8f6b28976` (= published `claude/dinar-next-unified`, which contains `c2dc782` plus the search vocabulary fix) |
| Ancestry | `main`, `codex/dinar-next-unified-development`, `replit/dinar-next-complete-development` are all ancestors (0 commits ahead of ours) |
| Replit continuation | `replit/jassimai-codex-continuation` is not on GitHub; nothing from it is assumed |
| Final SHA | the commit that adds this document |

## Component inventory (evidence-based)

| Component | Exists | Code path | Decision |
|---|---|---|---|
| Card Envelope (versioned, server-decided actions) | yes | `lib/api-zod/src/surface-composition.ts` | REUSE_AS_IS |
| Composed-surface primitives: header, text, facts, metrics, meter, money, timeline, bars, options, notice, actions | yes | same file + `artifacts/dinar/src/features/ai/surface/primitives.tsx` | REUSE_AS_IS |
| Metric summary | yes (`metrics`, with trend + previous) | `MetricGrid` | REUSE_AS_IS |
| Bar chart | yes, two of them: server `bars` and model `dinar-chart` | `BarList`, `AnswerCards.tsx` | REUSE_AS_IS |
| Timeline (orders/delivery) | yes (`timeline`) | `Timeline` | REUSE_AS_IS |
| Comparison of listings | yes (`COMPARISON` surface, `PresentationProposal`) | `UniversalCards.tsx`, `surface-composition.ts` | REUSE_AS_IS |
| Product/service cards, cart, checkout, purchase review | yes | `commerce-adapters.ts`, `BuyerPanels.tsx` | REUSE_AS_IS (untouched) |
| Account usage / plans | yes (`meter`, `AI_USAGE_CARD`, `AI_PLANS_CARD`) | `CommercialSurface.tsx` | REUSE_AS_IS; Replit owns the trial and billing |
| **Generic table** | **no** | — | **BUILD_MINIMAL** → `table` section + `DataTable` |
| **Line chart** | **no** | — | **BUILD_MINIMAL** → `series` (`LINE`) + lazy `SeriesDrawing` |
| **Donut** | **no** | — | **BUILD_MINIMAL (P3)** → `series` (`DONUT`); real use: share by category |
| Merchant monthly analytics | **no** (insights were five all-time counters) | `business-catalog.ts#businessAnalytics` | **EXTEND_EXISTING** → `monthly` |
| shadcn `components/ui/chart.tsx` | present, unused | — | DEFER (left untouched) |

## GitHub / npm research (verified 2026-11-12 from the npm registry and upstream repositories)

| Candidate | License | Latest | Maintained | Decision | Why |
|---|---|---|---|---|---|
| recharts/recharts | MIT | 3.10.1 (installed 2.15.4) | yes (Nov 2026) | **REUSE EXISTING 2.15.4** | Already a dependency; React 19 peer OK; SVG; tooltips; reduced-motion via `isAnimationActive`. Upgrading to 3.x is a breaking change with no Phase 1 need. |
| apache/echarts | Apache-2.0 | 6.1.0 | yes | REJECT | Large imperative canvas engine; heavier than the need; would be a second chart stack. |
| airbnb/visx | MIT | 4.0.0 | yes | STUDY_ONLY | Low-level primitives; needs `@react-spring/web`; more code for the same result. |
| shadcn-ui charts | MIT | — | yes | STUDY_ONLY | A Recharts wrapper; the repo already has its `chart.tsx`, unused. Token approach borrowed (CSS variables per series). |
| TanStack/table | MIT | 9.3.1 | yes | REJECT for now | Tables are ≤30 rows × ≤8 columns; native `<table>` plus 20 lines of sort covers it with better semantics. Revisit for large merchant reports. |
| vercel-labs/json-render | Apache-2.0 | 0.22.0 | yes | STUDY_ONLY | Idea adopted (a closed, typed component catalog validated by Zod). Its runtime is not adopted: JassimAI already has this in `SurfaceSectionSchema`. |
| assistant-ui | MIT | 0.15.36 | yes | REJECT | Replaces the chat runtime, which the mission forbids. |
| vercel/ai | Apache-2.0 | 7.0.170 | yes | STUDY_ONLY | Tool-result→UI pattern already exists here (typed tool payloads → adapters). |
| motiondivision/motion | MIT | 14.13.0 (installed framer-motion 12.43.0) | yes | REUSE EXISTING | No new animation was needed; charts respect `prefers-reduced-motion`. |

No code was copied from any of these repositories.

## Architecture

```
Server records (orders, order_items, offers)          Model text (```dinar-table / dinar-line / dinar-donut)
        │ businessAnalytics(): ownership-scoped SQL            │ AnswerCards.parseAnswerCard(): ≤12 KB, JSON.parse,
        │ business-turn: server-priced display strings         │ mapped to the same section shape
        ▼                                                      ▼
BUSINESS_INSIGHTS payload ── business-adapters ──►  SurfaceSectionSchema (`table` | `series`)  ◄── same validation
                                                     strict keys, bounded sizes, no links/actions/markup
                                                               │
                                     Card Envelope (server lifecycle, allowed actions) — unchanged
                                                               │
                                       ComposedSurfaceView ── DataTable / SeriesChart
                                                               └─ SeriesDrawing (recharts, lazy chunk)
```

- **Server cards** (`source: SERVER_RECORD` in spirit) show «المصدر: طلبات مكتملة في DINAR حسب شهر الطلب».
- **Model cards** always show «تقدير من المساعد، ليس من سجلات دينار». They cannot sort, link or act.

## Implemented components

| Type | Contract | Limits | Behaviour |
|---|---|---|---|
| `table` | columns `{key,label,kind: TEXT/NUMBER/MONEY, sortable}`; rows `{key, cells[{display \| null, sort?}]}` | ≤8 columns, ≤30 rows, one cell per column, unique keys | `null` → «غير متوفر»; sorting reorders a copy; region scrolls horizontally inside the card; `aria-sort`; caption; row headers |
| `series` LINE | `points[{label, value, display}]` | 2–24 finite points | Only the given points are drawn (no gap filling); zero/negative allowed; RTL time axis; exact figures table under every chart |
| `series` DONUT | same | 2–6 non-negative parts, non-empty whole | Legend with exact figures |
| Merchant monthly | `insights.monthly[6]` | last 6 UTC months | Completed orders only; cancelled never counted; month = order month (no separate completion timestamp exists, and the card says so); chart axis in major currency units |

**Limitations (honest):**
- The monthly series groups by **order creation month**. DINAR stores no separate completion timestamp.
- Profit is not shown. Costs are not recorded, so revenue is never presented as profit.
- Model tables/charts are reachable only when the model writes the fence. The prompt does not mention them yet (Phase 2).

## Performance

| Measure | Before | After |
|---|---|---|
| Main chunk (`index-*.js`) | 1,021.01 kB / **305.53 kB gzip** | 1,027.74 kB / **307.49 kB gzip** (+1.96 kB gzip) |
| Chart chunk (`SeriesDrawing-*.js`) | — | 422.56 kB / 113.92 kB gzip, **loaded only when a line/donut card is on screen** |
| New npm dependencies | — | **0** |

Tables are bounded at 30×8 cells, and sorting is memoised per table.

## Verification

| Suite | Command | Result |
|---|---|---|
| Phase 1 contract (pure) | `local-suite.sh phase1-presentation-contract.test` | **10/10 PASS** |
| Merchant analytics grounding + isolation (P1-INSIGHTS) | inside `d3a-native-business.test` | **PASS** (49/49 in suite) |
| Answer cards incl. Phase 1 model cards | `pnpm --filter @workspace/dinar run test:deepseek-stream` | **24/24 PASS** |
| Composed surfaces / lifecycle / envelope (frontend) | `pnpm --filter @workspace/dinar run test:surfaces` | **35/35 PASS** |
| History render performance | `pnpm --filter @workspace/dinar run test:history-perf` | **3/3 PASS** |
| Browser acceptance (4 viewports, a11y, security) | `pnpm --filter @workspace/dinar run build && CHROMIUM_PATH=… node artifacts/dinar/test/phase1-intelligent-ui.mjs <shots>` | **18/18 PASS** |
| Regression (21 API + browser suites, fresh loopback DB each) | business, card envelope, conversation, buyer, seller-draft, search, routing, D3A/D1-D2/W03 browser journeys | **21 suites, 302 tests, 0 fail** |
| Typecheck | `pnpm run typecheck` | PASS |

### Mandatory acceptance list

| # | Check | Status |
|---|---|---|
| A1 | time series → line | PASS (browser) |
| A2 | categories → bar | PASS (existing `bars`/`dinar-chart`, unchanged; regression green) |
| A3 | invalid values rejected | PASS (contract) |
| A4 | missing months not fabricated | PASS (contract: a gap stays a gap; P1-INSIGHTS: months without orders are recorded zeros from the same query) |
| A5 | currency consistent | PASS (server display strings; axis in major units, asserted in browser) |
| A6 | zero/negative accurate | PASS (contract + browser) |
| A7 | very large values | PASS (contract; compact axis ticks) |
| A8 | chart data equals source | PASS (browser figures table = payload) |
| B9 | comparison keeps prices | PASS |
| B10 | missing = unavailable | PASS |
| B11 | sorting doesn't modify source | PASS |
| B12 | mixed Arabic/English | PASS |
| B13 | large table usable on mobile | PASS (scrolls inside its region at 320/390) |
| C14 | product image/title | PASS via existing regression (block-f2-buyer, wave02-d6); code untouched |
| C15 | buy actions through existing gates | PASS via existing regression; untouched |
| C16 | unauthorized actions not rendered | PASS (schema refuses actions in data; terminal envelope strips actions) |
| C17 | account usage from server | NOT_EXECUTED in Phase 1 (unchanged code; Replit owns the sidebar) |
| C18 | merchant analytics not leaking | PASS (P1-INSIGHTS: other business identical before/after) |
| D19 | unknown component type | PASS |
| D20 | malformed payload | PASS |
| D21 | invalid URLs | PASS (no URL field exists; extra keys refused) |
| D22 | cross-account access | PASS (P1-INSIGHTS; D3A-35/42 regression) |
| D23 | forged financial values | PASS (money is server display strings; model cards labelled as estimates) |
| D24 | repeated confirmation | PASS via regression (D3A-19, wave03) — Phase 1 adds no action |
| E25–E29 | refresh / switching / back-forward / stored data | PASS by construction (sections are stored in the existing block payload and re-validated on read); dedicated reload test for the new sections: **NOT_EXECUTED** |
| E30 | unknown envelope version degrades | PASS |
| F31–F34 | 320 / 390 / 768 / 1440 | PASS (screenshots in `phase1-evidence/`) |
| F35 | keyboard | PASS |
| F36 | screen-reader-compatible structure | PASS (structure checked); **real screen-reader session NOT_EXECUTED** |
| F37 | reduced motion | PASS |
| F38 | loading/error states | PASS (lazy skeleton; invalid card notice; no console errors) |

## Browser evidence

`docs/dinar-next/phase1-evidence/phase1-{320,390,768,1440}.png` (synthetic fixtures, labelled).
A defect was found and fixed through the screenshots: the first version drew the merchant chart's
axis in minor units (600K). It now uses major currency units, with a browser assertion.

## Security

- Closed allowlist: new sections are part of the strict discriminated union. Unknown keys, unknown
  types, objects in cells, links, actions, NaN/Infinity, oversized and `__proto__` payloads are all
  refused whole (contract tests).
- Rendering is React text only: no `dangerouslySetInnerHTML`, no URL, no image, no code.
- Money: merchant amounts are formatted on the server from minor units. Model numbers are always
  labelled as the assistant's estimate.
- Ownership: the monthly query uses the same seller, market and business-listing filters as the
  existing counters. Isolation is tested.
- No action can be attached to a table or chart.

## Integration readiness for Phase 2

Phase 2 can, without backend reconstruction:
1. Announce `dinar-table`, `dinar-line`, `dinar-donut` in the model prompt next to the existing `dinar-chart`.
2. Let model-read tools return `table`/`series` sections built from server data (same schema, same renderer).
3. Reuse `businessAnalytics().monthly` for «ورني مبيعاتي خلال ستة أشهر» / «حولها إلى رسم بياني».

## Outstanding issues

- Replit's sidebar, trial, research tools and Shopify are not on GitHub: no assumption made.
- Real screen-reader session and a reload test dedicated to the new sections: not executed.
- `search-sql-foundation` golden mismatch (pre-existing at `00fde92`, not caused by Phase 1).
- Expenses/costs are not recorded, so «مصاريف متجري» cannot be charted truthfully yet.
