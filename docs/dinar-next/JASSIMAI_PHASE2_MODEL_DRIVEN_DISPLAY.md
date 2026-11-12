# JassimAI — Phase 2: Model-Driven Display

## Source identity

| | |
|---|---|
| Phase 1 (published, verified) | `origin/claude/jassimai-phase1-intelligent-ui-foundation` = `453935b953d776907b060feac8894beef9dcd6de` |
| Phase 2 branch (local only, **not pushed**) | `claude/jassimai-phase2-model-driven-display` |
| Starting SHA | `453935b` |
| Implementation commit | `dfe545b` (this report is committed on top) |
| Working tree | clean after commit |

## What changed, in one sentence

The model now chooses the **form** of an answer (text, cards, table, comparison, line, bar, donut, metric). The server decides whether its own verified data fits that form, builds the card from its records, and otherwise explains honestly. No figure ever comes from the model.

## Architecture (reused, not rebuilt)

| Step | Path | Phase 2 change |
|---|---|---|
| Model turn contract | `artifacts/api-server/src/ai/model-turn.ts` | optional `display` field (opaque in Zod like `presentation`); prompt rule: TEXT by default, form by goal and data shape, explicit wish wins, `LATEST_RESULTS` re-shows without searching |
| Display contract | `lib/api-zod/src/surface-composition.ts` | `DisplayDirectiveSchema` {version, format, scope?, positions?}, strict; `TABLE` added to the existing presentation layouts |
| Listing results | `smart-turn.ts` → existing `resolvePresentationProposal` | TABLE/COMPARISON map onto the same resolver; misfit formats (LINE/DONUT/METRIC on listings) are explained, not drawn |
| Re-display | `smart-turn.ts#redisplayLatestResults` → existing internal `restoreResults` / `compareListings` | the latest stored result set is re-read live; same ids, same order; expired sets are refused |
| Business figures | `display-composer.ts` (new, pure) ← `readBusinessOverview` ← `businessAnalytics` | LINE (monthly), BAR (category/month), DONUT (2–6 categories), TABLE, METRIC, AUTO, TEXT; every card carries «ليست ربحًا» |
| Persistence | `routes/ai.ts` (+ OpenAPI + codegen) | `displaySurface` stored on SURFACE blocks and re-validated on read; `composition.layout = TABLE` kept on listing blocks (listings re-read live) |
| Rendering | `ConversationContent.tsx`, `surface/ListingTable.tsx`, Phase 1 `DataTable`/`SeriesChart` | table above the existing cards; server display via `ComposedSurfaceView` (validated again) |
| Deterministic floor | `display-preference.ts` (new) | an explicit, short «…كجدول / بطاقات» request with a reference and no price/sale words is applied without a model call and never opens a sale draft; comparisons stay with the existing handlers |

Card Envelope, conversation runtime, cart, checkout and every action path are unchanged. A display directive carries no action and authorizes nothing.

## How incorrect proposals fail

- Malformed or forged directive (unknown format, extra `values`/`rows`/`html`): the directive is ignored whole and the turn is kept (tested).
- Format that does not fit the data: canonical card plus one honest sentence (listings: «ليست أرقامًا عبر الزمن…»; business: «لا يوجد اتجاه…», «لا يوجد أكثر من تصنيف…»).
- No business read or no analytics permission: nothing is drawn.
- Model prose containing a figure: never enters the card (the card is built only from records).
- Stale or expired result set: not re-shown.

## Test results (exact commit `dfe545b`)

| Set | Result |
|---|---|
| `phase2-model-display` (new) | **14/14 PASS** |
| `d3a-native-business` incl. P1-INSIGHTS and **P2-BUSINESS** | **50/50 PASS** |
| `phase1-presentation-contract` | 10/10 PASS |
| Browser harness, 320/390/768/1440, incl. Phase 2 listing table and server-composed business display | **20/20 PASS** |
| Frontend units (`test:surfaces`, `test:deepseek-stream`, `test:history-perf`) | 35 + 24 + 3 PASS |
| Regression battery: 101 suites | **979 PASS / 19 FAIL** |
| Of those failures: identical on Phase 1 `453935b` (pre-existing) | **all 19** (9 suites, listed below) |
| Lab: frozen 500 | 409 PASS / 0 FAIL / 91 MODEL_REQUIRED (unchanged) |
| Lab: held-out 107 | 68 PASS / 13 FAIL / 26 MODEL_REQUIRED (unchanged) |
| Lab: H5 | 30/30 |
| Typecheck | PASS |

Pre-existing failures, unchanged by Phase 2 (verified by running the same suites on `453935b`):
`ai-foundation-acceptance` (4), `ai-foundation-02-acceptance` (1), `capability-init-order` (6; the registry now has 26 capabilities since `readMyAccountStatus`, while the test expects 25), `block-f4-driver` (3), `phase1-acceptance`, `phase2-commission-acceptance`, `sc01-browser-journey`, `sc03-browser-journey`, `followup-sc01-observed-browser` (1 each; the browser/seed suites need flags or a seed this battery runner does not pass).

### Mandatory list (B12)

| # | Check | Status |
|---|---|---|
| 1 | normal question → text | PASS (P2-01) |
| 2 | marketplace results → existing cards | PASS (P2-02) |
| 3 | comparison → comparison view | PASS (P2-03, same two records) |
| 4 | historical series → line | PASS (P2-BUSINESS, browser) |
| 5 | category totals → chart | PASS (DONUT/BAR in P2-BUSINESS and browser; honest notice when one category) |
| 6 | exact details → table | PASS (P2-03/04, browser) |
| 7 | single KPI → metric | PASS (P2-BUSINESS) |
| 8 | empty dataset → truthful fallback | PASS (no business / no sales / expired set) |
| 9–10 | «الأول» / «الثاني» | PASS (existing resolvers; comparison of 1 and 2; «ضيف الأول» adds the first stored result) |
| 11 | «حولها لجدول» keeps the dataset | PASS (same resultSetId, ids, order; 0 new result sets) |
| 12 | «رجع الرسم» keeps source identity | PARTIAL: listings re-show from the same set; a business chart is re-composed from a fresh read of the same records (no stored chart replay) |
| 13 | conversation switch does not leak | PASS (P2-13, incl. another account) |
| 14 | refresh keeps the display | PASS (P2-14; displaySurface contract P2-PERSIST) |
| 15–19 | Gulf, Jordanian/Levantine, Egyptian, MSA, non-literal | PASS **for plumbing** with a scripted model; the deterministic floor reads the explicit ones without a model |
| 20 | ambiguous reference → clarification | NOT_EXECUTED as a new test (existing clarification suites green) |
| 21 | forged analytics rejected | PASS |
| 22 | unauthorized merchant data blocked | PASS (P1-INSIGHTS, P2-BUSINESS, D3A-35/42) |
| 23–26 | unknown type, malformed, code, URLs | PASS (Phase 1 contract + P2-21/23/24/26) |
| 27 | forged action cannot purchase | PASS (form changes never touched the cart: 12/12 turns, 0 orders) |
| 28 | repeated confirmation not duplicated | PASS via regression (wave03, D3A-19) |
| 29–34 | seller, buyer, account, merchant, card persistence, security/financial | PASS (regression battery; pre-existing failures listed above) |

### Measured user effort (scripted model; real counts from the test)

| Request | Model calls | New result sets | Cart change |
|---|---|---|---|
| «كيف أكتب إعلانًا جيدًا» | 1 | 0 card | 0 |
| search | 2 (read + answer) | 1 | 0 |
| each «…بجدول» re-display (5 dialects) | 0–1 | **0** | 0 |
| comparison of 1 and 2 | ≤1 | 0 | 0 |
| chart of listings (misfit) | 1 | 0 | 0 |

## Limitations (honest)

- **Live model behaviour is not verified.** Every semantic choice in these tests is scripted; the judgement of a real model needs a separate, budgeted evaluation.
- HTTP end-to-end of the business display through the model loop is **BLOCKED** in the test fixture: the verified owner holds two businesses, and the existing business gate asks which one before any model turn. The composer, the read and isolation are tested against the same database rows.
- Existing deterministic findings, reported and not changed in Phase 2:
  - «أبي مقارنة … الأول» opens a **purchase review** of the first item. It needs «نعم», so nothing is bought, but it is a misreading.
  - «اعرضها + كلمة» (for example «اعرضها مع …») can open a **sale draft**. The explicit «اعرضها كجدول» is now protected.
- The monthly series is grouped by **order month**: there is no completion timestamp.
- There is no cost data, so profit is never shown.
- A re-displayed business chart is recomposed from the current records, not replayed from the earlier message.

## Replit compatibility

- **Free-model routing and the 15-message trial:** `display` is an optional field of the one existing tool call. A model that omits it, or produces invalid structure, falls back to today's behaviour. Nothing escalates to a paid model.
- **Research citations:** a future research read can return its own sections through the same `displaySurface` contract. Sources go in `source`; no new renderer is needed.
- **Usage accounting:** unchanged. The display decision costs no extra call. Explicit table and cards requests use none.
- **Shopify catalog:** imported listings are ordinary listings. TABLE, COMPARISON and re-display work on them unchanged.

## Not done (by instruction)

No push of Phase 2, no merge, no deploy, no paid model calls, no Phase 3.
