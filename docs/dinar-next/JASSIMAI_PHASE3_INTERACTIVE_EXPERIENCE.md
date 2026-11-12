# JassimAI — Phase 3: Working With What Is On Screen

## 1. Source identity

| | |
|---|---|
| Repository | `qurankream0987-eng/dinar-pro` |
| Phase 2 (published, verified) | `origin/claude/jassimai-phase2-model-driven-display` = `9fc2820` |
| Phase 3 branch (local only, **not pushed**) | `claude/jassimai-phase3-interactive-experience` |
| Starting SHA | `9fc2820` |
| Commits | `669a591` (implementation), then a fix and this report on top |
| Working tree | clean after the final commit |

**Phase 2 closure gate:**
- The final battery was 101 suites: 979 PASS / 19 FAIL. All 19 failures are in 9 suites that fail identically on Phase 1 `453935b`.
- The lab was unchanged.
- OpenAPI and the generated types are consistent (codegen).
- No display change touched a cart or an order.
- The merchant HTTP end-to-end blocker is classified BLOCKED (multi-business gate).

## 2. Architecture (reused)

| Need | Existing piece reused | Phase 3 addition |
|---|---|---|
| What a follow-up applies to | `ai_ui_blocks` (the conversation's stored blocks) | `activeDisplay()`: the latest block is either product results (a result set) or a business display (`displaySurface`) |
| Re-showing results | internal `restoreResults` (live re-validation) | form switch keeps the same set; the table form survives a sort |
| Sorting / filtering | `ai_result_sets` + the existing ordinal resolvers | a **derived result set** of the same ids (`query.derivedFrom`, `displayOperation`), so «الأول/الثاني/الأخير» follow the view; agreed prices sort last, never as zero |
| «افتح/ضيف الأرخص» | existing open/add handlers and their review | the superlative is resolved over the active display to an ordinal (action verbs only; «أبي الأرخص فقط» stays the existing ranking preference) |
| Business follow-ups | `readBusinessOverview` (ownership-scoped) + Phase 2 composer | format switches; `monthAnalysis`: highest, lowest, highest vs lowest, this month vs last, deterministic in minor units, ties to the earliest month, no percentage over a zero base, causes never invented |
| Next steps | composed-surface `actions` (SEND utterances) | three suggestions on a business display with sales; each re-enters through the same path |
| Interpretation | — | `displayInteraction()`: a small, explicit floor (format, sort, filter, analysis); applied only when the active display matches; anything else goes to the model or DINAR's handlers |

No new runtime, store, cart, order, payment or publication path was added. A display operation never writes a cart line, an order or a listing.

## 3. Files

`src/ai/display-interaction.ts` (new); `src/ai/display-preference.ts` (interaction floor); `src/ai/conversation-runtime.ts` (applies interactions before sale/plan handling; superlative rewrite); `src/ai/display-composer.ts` (next-step actions); `artifacts/dinar/src/features/ai/ConversationContent.tsx` (business display actions live on the latest message); tests: `test/phase3-interactive-experience.test.ts`, `P3-BUSINESS` in `test/d3a-native-business.test.ts`, browser harness `P3-ACTIONS`.

## 4. Demonstrations (reproducible; `test/isolation/local-suite.sh phase3-interactive-experience.test`)

- **Cards → table → sort → cards:** «ورني الجوالات» → «خلهم بجدول» → «رتبهم من الأغلى» (180, 150, 120; the table is kept) → «طب رجعهم بطاقات» (the same order). There are 0 model calls, and the sort creates one derived set from the same records.
- **Sorting, then reference:** «ضيف الثاني للسلة» after the descending sort adds the 150 phone, the second as shown, through the existing review («نعم»). 0 orders are created.
- **Superlatives:**
  - «افتح الأخير» after an ascending sort opens the 180 phone.
  - «افتح الأرخص» opens the 120 phone.
  - «ضيف الأرخص للسلة» adds the 120 phone even when it is shown last.
- **Services and dialects:**
  - Jordanian «بدي أشوفهم كجدول», Egyptian «عايزهم في جدول» and the non-literal «اعرض الأرقام مش الرسم» all produce a table.
  - «رتبهم من الأرخص» gives 25, 90, then the agreed-price service last.
  - «خلها رسم خطي» on listings gets an honest misfit note.
  - «خلني أشوف المتوفر بس» filters to available items.
- **Business follow-ups** (verified owner, real orders):
  - «أي شهر كان الأعلى؟» equals `monthAnalysis` over the server's own rows, plus the «ليست ربحًا» note.
  - «قارن الشهر الحالي بالشهر اللي قبله» states that the causes are not in the data.
  - «خلها أعمدة» gives bars, and «ورني الأرقام بالتفصيل» gives a table. 0 model calls.
  - Another owner gets only their own figures.
- **Refresh:** reopening the conversation restores the sorted table with the same order.

## 5. Tests (exact commits)

| Set | Result |
|---|---|
| `phase3-interactive-experience` | **9/9 PASS** |
| `d3a-native-business` (P1-INSIGHTS, P2-BUSINESS, P3-BUSINESS) | **51/51 PASS** |
| Browser harness, 320/390/768/1440, incl. P3 next-step actions (keyboard, touch size, utterance only) | **21/21 PASS** |
| Frontend units | 35 + 24 + 3 PASS |
| Regression battery (102 suites) on `669a591` | 987 PASS / 21 FAIL |
| Of those: new failures | `block-f2-buyer` (2), caused by the superlative rewrite capturing «أبي الأرخص فقط»; **fixed** (action verbs only), re-run **14/14 PASS** |
| Remaining failures | the same 9 pre-existing suites as Phase 1 and Phase 2 (19 tests, identical counts) |
| Lab: frozen 500 / held-out / H5 | 409 PASS · 0 FAIL / 68 PASS · 13 FAIL / 30 PASS (unchanged) |

### Acceptance groups (section 17)

| Group | Status |
|---|---|
| A display transformation (1–6) | PASS: cards↔table, line→bar, chart→table, misfit explained. Text→table for model-authored text: MODEL_REQUIRED |
| B references (7–14) | PASS: first, second, last, cheapest, sort-then-second, no cross-conversation leak. «اللي قبله» uses the existing resolver (no new test). The ambiguity clarification is NOT_EXECUTED as a new test |
| C analytics (15–21) | PASS: highest, lowest, shares (Phase 2 browser), zero, no fabricated months, fils precision, other owner isolated |
| D commerce safety (22–28) | PASS: sort/format never touch the cart (measured each turn), canonical id added, review kept, 0 orders. Stale price shows the live record: conditional on the listing-edit route accepting the change |
| E persistence/isolation (29–35) | PASS: refresh, reopen, stranger 404, other owner, invalid schema (Phase 1). Back/forward is covered by existing browser suites, not re-run for P3 specifically. A provider switch carries no state (the display lives in stored blocks) but is NOT_EXECUTED live |
| F browser (36–43) | PASS: four widths, keyboard, reduced motion, touch-sized actions. Loading/failure: Phase 1 lazy skeleton and invalid-card notice |
| G generality (44–50) | PASS for plumbing in Kuwaiti/Gulf, Jordanian, Egyptian and non-literal phrasings, multi-turn chains and return to cards. **Live semantic quality: MODEL_REQUIRED** |

### Measured effort (from the tests)

Every display interaction (table, cards, sorts, filter, misfit, business follow-ups) took **0 model calls**, created at most one derived result set, ran **no new search**, and changed the cart **0 times**.

## 6. Performance

- No new dependency.
- Main chunk: 308.04 kB gzip, against 307.49 kB in Phase 1 (+0.55 kB). Recharts stays lazy.
- Display operations run deterministically on the server, with no model call.
- Browser latency was not measured reliably in this environment.

## 7. Replit compatibility

- **Free-model routing and the 15-message trial:** the floor needs no model, which saves trial and free-tier calls. Model-driven forms use the optional `display` field.
- **Web Search/Web Fetch:** display operations never trigger research.
- **Shopify:** imported listings are ordinary result sets. Sort, filter, table and superlatives apply unchanged.
- **Usage and billing:** untouched.

## 8. Remaining blockers and limits

- **Live model:** not evaluated (owner budget required). All semantic choices here are scripted, or come from the explicit floor.
- **Shopify:** live acceptance is BLOCKED (adapter and test store).
- **Business display end-to-end through the model loop:** BLOCKED in the fixture (multi-business gate). Phase 3 follow-ups were tested end-to-end through HTTP, from a business display placed in the conversation as test state.
- **Existing deterministic findings (unchanged):** «أبي مقارنة … الأول» opens a purchase review, and «اعرضها مع …» can open a sale draft.
- **Re-display:** a re-displayed view shows live records. Changed prices are shown as they are now, without a "price changed since" banner.

**Readiness:** suitable for an isolated GitHub publication review, under the same conditions as Phases 1 and 2. Not pushed.
