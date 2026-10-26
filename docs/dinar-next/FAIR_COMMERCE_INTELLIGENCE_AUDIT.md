# DINAR — Fair commerce intelligence audit

**Audit date:** 2026-10-22  
**Repository:** `/home/runner/workspace`  
**Commit inspected:** `6b3bd80aec6182bff8377e5990492285bdb15e2a`  
**Scope:** Current source inspection and targeted test inventory. The database-backed acceptance runner was attempted but stopped at its disposable-database safety guard. No live model request was sent.

## Verdict

**FAIR COMMERCE ADVICE READY: PARTIAL.**

DINAR already has useful, context-aware and mostly deterministic commercial assistance. Seller price guidance is built from actual in-market listings and discloses when the sample is too small. Buyer search ranking uses transparent listing attributes and explicitly excludes payment as a signal. Paid placements have a sponsored label, and actual negotiations use a server-authoritative, confirmation-based workflow.

That is not enough to claim production-quality, neutral, model-backed advice across every scenario. In this audit, no signed-in conversation was run, no live model answer was inspected, and the current database readiness was not restored. Buyer-specific value/risk advice and offer-interpretation guidance are less complete than seller price advice and transaction execution. Historical mock-backed tests show deterministic routing and action safeguards, not the quality or neutrality of a current model response.

## Capability assessment

| Capability | Status | Current source evidence | Remaining gap |
|---|---|---|---|
| Seller pricing advice | PARTIAL | `src/ai/seller-management.ts` routes seller price questions to `comparablePrices`; it excludes the seller’s listing, uses the current market/category and listing attributes, and reports a range/median only when at least three comparable offers exist. With fewer than three, it explicitly says the evidence is insufficient and does not change the price. Returned surface labels the suggestion `DINAR_DERIVED`. | Did not run natural Arabic acceptance prompts in the current runtime. Sample comparability is a proxy based on internal listings, not completed-sale prices or external market research. Product condition, completeness, quantity, location granularity, stale/outlier listings, and fixed/negotiable modes need validated coverage before treating the median as fair value. |
| Seller listing improvement | PARTIAL | Same service reports verifiable listing facts separately from possible factors (price, photos, short description, missing attributes), states that it cannot confirm why an item did not sell, reports no engagement data when unavailable, and says it will not change anything without review. | Need test for unsupported promises, coercive advice, and Arabic variants. Price/quantity effects are not a calibrated causal analysis. |
| Buyer choice and comparison | PARTIAL | `src/ai/buyer-turn.ts` ranks actual listings using query relevance, condition, price or buyer target, listing completeness, availability/freshness, and seller rating. Reasons are returned to the UI. Source comment explicitly says payment is not a ranking signal. | Ranking is not itself a market-value estimate or full risk analysis. Test whether the assistant distinguishes listing claims from independently verified facts and discloses missing data in Arabic responses. |
| Buyer value and risk advice | PARTIAL | Buyer surfaces receive live listing facts and ranking reasons. General model conversation exists in `model-turn.ts`, with privacy filtering and non-authoritative action boundaries. | No dedicated, verified buyer valuation/risk contract was established in this audit. No model answer was inspected for “worth it,” risk, alternative, or insufficient-comparison prompts. Avoid assertions about defects, fraud, or market value absent evidence. |
| Negotiation advice vs. actual offers | PARTIAL | `negotiation-turn.ts`, `lib/negotiations.ts`, and action review surfaces model real negotiation state. Offers/counters are distinct from advice; action cards await confirmation. Histories are append-only; the agreed-price workflow gates checkout for negotiable listings. Test inventory includes party-isolation and confirmation cases in `g2-smart-conversation.test.ts`. | The actual commercial guidance “should I accept?” is not proven neutral or consistently evidence-based by workflow safety tests. Need a prompt suite that contrasts buyer and seller perspectives without exposing either party’s private limit, messages, or budget. |
| Sponsored-content separation | VERIFIED WITH MOCKED MODEL ONLY | `promotion-turn.ts` includes `SPONSORED_LABEL` in promotion surfaces; test `command-c-acceptance.test.ts` has a case asserting sponsored placement is labeled and organic order is untouched. Buyer ranking code documents payment as a non-signal. Paid promotion does not itself rewrite organic rank. | The acceptance test was not run now; no live conversational answer was inspected. Verify that assistant explanations never call promoted items “best” solely because they are sponsored and disclose the label in all relevant UI surfaces. |
| Privacy and authorization | VERIFIED WITH MOCKED MODEL ONLY | Seller advice selects only the actor’s own listing; inquiry reads/writes are party- and market-scoped (`lib/inquiries.ts`). Model-turn prompt filters secrets and payment-like identifiers; location notes state precise coordinates/addresses are excluded from model context. Negotiation services scope views to participants and preserve event history. | The current DB is migration-blocked and no signed-in multi-user acceptance run occurred. Need verify another buyer cannot obtain seller analytics, private negotiation bounds, inquiry contents, or order location. |
| Consent before state changes | VERIFIED WITH MOCKED MODEL ONLY | Seller advice does not mutate prices. Listing text changes and negotiation actions use typed review/confirmation surfaces; tool/action services are the authority, not model prose. Payment and promotion paths are explicitly simulation-only. | No end-to-end signed-in conversation was run here; no live model behavior can be inferred from contract tests alone. |
| General AI after commerce and reload | PARTIAL | Unified `conversation-runtime.ts` routes deterministic commerce tools and general model turns through one conversation/persistence surface. Historical development acceptance reports a working Replit AI general turn, follow-up, search, and reload paths. | Those reports are historical and not re-run; current API readiness is recorded as blocked by pending migrations. Conversation continuity and model quality after a commerce turn were not verified in this session. |

## Neutrality and conflict-of-interest findings

1. **Organic ranking is not visibly monetized in the inspected ranking function.** Ranking signals are listing/query facts; the source explicitly excludes payment. Sponsored placement is identified separately and has a label in promotion surfaces.
2. **Subscription tier does not appear to change advice policy in the usage policy.** The plan tiers alter request/token allowances; the recorded policy says the capabilities are the same. This can still create unequal access to more advice, but not evidence of advice favoring sellers with a higher plan.
3. **No evidence found that the model is instructed to maximize seller price or force buyer discounts.** However, a lack of such a prompt is not proof of neutral output. Live responses and regression fixtures are missing for this assertion.
4. **Internal comparable listing prices are asking prices, not completed transaction prices.** Presenting their median as a market-clearing or “fair” value would overstate the evidence. DINAR currently limits the wording and sample size, but should state the data type and limitations consistently.
5. **Verified facts and seller claims need clear separation in buyer-facing advice.** Listing attributes/descriptions originate from seller-submitted data unless a specific field has a separate verification source. Do not call them independently verified.
6. **Paid promotions and business subscriptions are financial conflicts to guard.** Paid content needs persistent labeling; neither payment nor subscription should influence neutral price/value explanations, buyer privacy, or organic ranking.

## Explicit answers

1. **Does DINAR genuinely advise sellers on pricing?** Yes, as a deterministic, development-code capability using DINAR asking-price comparables; quality is partial and current runtime acceptance is blocked.
2. **Does it genuinely advise buyers about value and risks?** It provides grounded ranking/comparison reasons; a comprehensive, verified buyer valuation/risk adviser is not established.
3. **Does it fairly support both parties?** The architecture has fair boundaries and seller/buyer tools, but end-to-end model neutrality has not been proven. Overall partial.
4. **Does it explain uncertainty?** Seller price advice does so explicitly for low sample counts and does not promise sales. Buyer/model uncertainty behavior is not verified.
5. **Does it respect private negotiation information?** Source-level participant scoping and privacy boundaries exist; current multi-account acceptance could not be run.
6. **Does it avoid covert commercial favoritism?** Organic ranking excludes payment and promotions are labeled in tested contracts. Live chat rendering/output has not been rechecked.
7. **Does it distinguish advice from binding actions?** Typed action reviews and explicit confirmations exist; no action should be inferred from model text. End-to-end current behavior is unverified.
8. **Does it use real comparisons or invented values?** Seller price guidance derives from actual DINAR listings; buyer rankings use actual current listings. No evidence of external market research. The assistant must not call asking-price ranges completed-sale evidence.
9. **Can general AI continue after a commerce discussion?** The shared runtime supports both, and historical development smoke passed; current persistence/reload is not verified.
10. **What is missing for production quality?** Current DB readiness, fresh authenticated acceptance, broader buyer advice/risk coverage, testable uncertainty/fact provenance, and live-provider response review with budget/privacy controls.

## Test and runtime evidence

### Executed in this audit

- `pnpm --filter @workspace/api-server run test:ai-provider` — **BLOCKED before test cases ran**. The test harness requires `BDINAR_DISPOSABLE_ACCEPTANCE_DB=1`; the required isolated disposable database was not configured. No bypass was attempted.
- Counts for this audit: **0 tests passed, 0 tests failed, 1 test command blocked before execution**. This is not a test failure and does not establish a pass.
- No live AI provider call, signed-in browser conversation, or database-backed acceptance was executed.

### Existing test/code evidence (not re-executed)

- `test/command-c-acceptance.test.ts`: source contains a sponsored/organic-separation acceptance case.
- `test/command-d-acceptance.test.ts`: source contains seller-insight parsing/persistence checks.
- `test/g2-smart-conversation.test.ts`: source contains party-isolation, immutable negotiation-history, and explicit-confirmation cases.
- `test/experience-upgrade-acceptance.test.ts`: source contains a global usage-guard case.
- `docs/dinar-next/FINAL_ACCEPTANCE.md`: dated prior evidence records Replit AI `gpt-5-mini` development smoke 8/8 and the Groq default smoke 0/8 (HTTP 401). This was a historical provider test and was not repeated at the inspected commit.
- `docs/dinar-next/INDEPENDENT_FULL_VERIFICATION.md` and `docs/DINAR-DEV-MIGRATION-REHEARSAL-2026-10-21.md`: record the latest known database readiness as 28/37 migrations with `0028`–`0036` pending and API readiness `503`. The migration chain passed a schema-only disposable rehearsal, not a full-data clone. No managed DB was changed.

## Required follow-up implementation and acceptance work

1. **Restore a safe test target first.** Create/use only an isolated disposable PostgreSQL database following the project guard. Do not enable the guard against Railway or production. Rerun focused seller advice, buyer comparison, sponsored neutrality, cross-party privacy, negotiation confirmation, and reload suites.
2. **Seller price evidence:** fixtures with 0, 1, 2, and 3+ same-market comparable offers; different categories/attributes/conditions, unit quantities, fixed and negotiable modes, stale/outlier listings, and no cross-market currency mixing. Verify only actual DINAR asking prices are reported, small samples are disclosed, no estimate is described as a guaranteed sale, and no listing value changes.
3. **Buyer value/risk:** test “is this worth the price?”, compare actual offers, missing condition/specification, seller-stated versus verified data, unavailable inventory, alternative choices, budget, and insufficient evidence. Fail the test on invented defects, accusations, demand/scarcity, or unsupported market claims.
4. **Negotiation symmetry and privacy:** run the same price gap from buyer and seller roles. Check balanced tradeoffs, no private minimum/maximum/budget/message leakage, no invented competing offers, and no financial offer or counteroffer until the authorized user reviews and confirms it.
5. **Sponsored neutrality:** verify the sponsored label in every UI surface and assistant explanation; verify paid plan, promotion spend, commission, and engagement do not alter organic ranking or market-value advice.
6. **Live model assessment:** only after explicit provider/budget approval and restoration of a safe database, test Arabic prompts through the selected provider. Keep mock-provider evidence separate from live response-quality results; record model and date without exposing credentials or private prompts.
7. **Conversation continuity:** test commerce-to-general topic switch, return to the same listing/market, reload, and ensure persisted data does not introduce stale actions or replay offers.

## Relevant source paths

- Conversation orchestration and model safety: `artifacts/api-server/src/ai/conversation-runtime.ts`, `model-turn.ts`, `smart-turn.ts`, `model-gateway.ts`.
- Seller advice and comparables: `artifacts/api-server/src/ai/seller-management.ts`, `artifacts/api-server/src/lib/recommendations.ts`.
- Buyer ranking and recommendation reasons: `artifacts/api-server/src/ai/buyer-turn.ts`.
- Negotiation and inquiry authority: `artifacts/api-server/src/ai/negotiation-turn.ts`, `artifacts/api-server/src/ai/inquiry-turn.ts`, `artifacts/api-server/src/lib/negotiations.ts`, `artifacts/api-server/src/lib/inquiries.ts`.
- Promotion disclosure and ranking: `artifacts/api-server/src/ai/promotion-turn.ts`, `artifacts/api-server/src/lib/recommendations.ts`, `artifacts/api-server/test/command-c-acceptance.test.ts`.
- UI rendering: `artifacts/dinar/src/features/ai/ConversationContent.tsx`, buyer panels, smart surfaces, and promotion surface components.

## Limitations

This is a source-level audit, not a live certification. Code contracts and historical tests do not prove that all 15 requested Arabic scenarios route correctly, render correctly, or produce neutral live-model wording at the inspected commit. The current DB-backed acceptance was blocked by the required safety guard; no attempt was made to bypass it.
