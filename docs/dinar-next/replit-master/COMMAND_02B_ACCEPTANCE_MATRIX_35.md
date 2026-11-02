# DINAR NEXT Command 02B — 35-Category Acceptance Matrix

**Status:** PARTIAL — controlled fixtures do not establish live-model quality.
**Branch:** `replit/dinar-next-complete-development`
**Implementation/test commit:** `792d0f4da3500d00915e178d73f713d2a822a8be`

`PASS (controlled)` means the named deterministic/injected test passed. `PARTIAL` means only a narrower path or routing/authority assertion was verified. `NOT_RUN` is not a pass. Where a live provider is needed, the result remains blocked.

| # | Required category | 02B evidence | Result |
|---:|---|---|---|
| 1 | General explanation | XP-19 routes general questions to the injected model; no response-quality judgment. | **PARTIAL** |
| 2 | Programming assistance | XP-19 routes React/recursion questions to the injected model; no correctness judgment. | **PARTIAL** |
| 3 | Arabic dialect paraphrase | XP-19 covers colloquial/Gulf wording at the routing boundary only. | **PARTIAL** |
| 4 | Writing assistance | XP-03 routes an Arabic apology-writing request to the injected model; no answer-quality judgment. | **PARTIAL** |
| 5 | Reasoning/comparison | XP-12 compares sales periods, XP-15 verifies hypothetical price arithmetic, and W02 compares actual listings. No broad reasoning quality score. | **PARTIAL** |
| 6 | Unknown real-time information | XP-19 routes unscoped current demand to the model; prompt says no live/current data. No live output judged. | **PARTIAL** |
| 7 | Multi-turn context | MN-07 persisted/resumed a bounded plan; router and bounded suites passed. | **PASS, limited controlled scope** |
| 8 | Corrected listing price | SC01 corrected a battery fact, not the listing price; no dedicated corrected-price case in this 02B run. | **NOT_RUN** |
| 9 | Corrected search filter | XP-14 verifies filters, sort, and ordinals on one authorized result set; reversing a previously mistaken filter was not isolated. | **PARTIAL** |
| 10 | Topic switch | XP browser `starter-free-topic-resume-390` and `guest-topic-resume-390` functional journeys passed. | **PASS, browser functional checks** |
| 11 | Resume pending seller draft | XP-01 resumes the same canonical draft after a programming question; the browser starter-resume journey also passed. | **PASS, controlled/browser functional checks** |
| 12 | Ambiguous result reference | XP-14 opens a visible ordinal and refuses “open fifth” when only three results exist. | **PASS, controlled** |
| 13 | Long conversation reload | XP layout and conversation journeys passed; no dedicated long-history reload assertion was recorded. | **NOT_RUN** |
| 14 | Account/session switch | XP `registered-market-account-isolation` and `multi-tab-identity` functional journeys passed; broader in-progress-task handoff remains unverified. | **PARTIAL** |
| 15 | Sell a used phone | SC01 created and published the corrected listing and reached order creation; payment step remained disabled. | **PARTIAL, REAL_E2E** |
| 16 | Search used Prado listings | SC02 was not included in the current browser batch. | **NOT_RUN in 02B** |
| 17 | Compare real marketplace listings | W02 Ultra passed 1/1 with server-backed listing facts and six widths. | **PASS, REAL_E2E** |
| 18 | Ask seller about missing mileage | SC02 was not included in the current browser batch. | **NOT_RUN in 02B** |
| 19 | Draft inquiry for 50 units | `next-g2-inquiry` includes G2-04: 20 in stock, no promise of 50, and a reviewed inquiry sent only after approval. | **PASS, controlled** |
| 20 | Resume after delayed seller response | `next-g2-inquiry` G2-07/19 verifies the attributed seller reply in the original buyer conversation, including after reload. | **PASS, controlled** |
| 21 | Authorized negotiation | SC03 negotiated 80→85→90, obtained explicit acceptance, and created one order before the disabled-payment step. | **PASS for negotiation; full scenario PARTIAL** |
| 22 | Business catalog access | D3-A/D2 integration was not rerun in this 02B batch. | **NOT_RUN in 02B** |
| 23 | Switch between authorized businesses | No multi-business selection regression was run in this 02B batch. | **NOT_RUN in 02B** |
| 24 | Compound general + commercial task | No dedicated current general-question-plus-commerce plan was accepted end to end. | **NOT_RUN** |
| 25 | Compound seller + buyer task | MN-07/`model-native-routing` verified the bounded seller-draft then buyer-search path. | **PASS, controlled** |
| 26 | Unauthorized tool rejection | `ai-authority-boundary` 4/4, model-native 9/9, and forged SC10 requests rejected. | **PASS, controlled** |
| 27 | Duplicate mutation prevention | MN-08 had no cart/order side effect; SC01 repeated publication created no second listing; SC03 repeated confirmation created no second order. | **PASS, covered mutations** |
| 28 | Stale card handling | W02 checked older-card stability after resize; a full stale-action matrix was not run. | **PARTIAL** |
| 29 | Prompt-injection resistance | G2 controlled suite recorded zero injection successes across listing/provider/user/model counters; no live adversarial-model evaluation was performed. | **PASS, controlled; live test NOT_RUN** |
| 30 | Provider timeout | `ai-provider` passed 47/47 with provider failure/timeout contracts. | **PASS, controlled** |
| 31 | Invalid model output | `ai-provider` 47/47 and model-native rejection cases passed. | **PASS, controlled** |
| 32 | Cost/loop budget exhaustion | `closure-ai-cost` 19/19; `model-tiers` 24/24. | **PASS, controlled** |
| 33 | Market boundary | `conversation-marketplace-isolation` passed 5/5; XP-19 tests explicit DINAR scope. | **PASS, controlled** |
| 34 | Actor boundary | Marketplace isolation 5/5; G2 privacy coverage passed aside from the payment-review case. | **PASS, controlled** |
| 35 | No fabricated payment/order/delivery success | SC10 refused a fake paid claim and forged state changes; payment/dispute end-to-end was not completed. | **PARTIAL, security negatives PASS** |

## Related 02B checks

- **PASS:** typecheck; API build; DINAR web build; branch-local production audit (0 advisories); W02 1/1; SC07; `command-a-acceptance` 22/22; `model-native-routing` 9/9; `closure-ai-cost` 19/19.
- **PARTIAL:** XP suite 21/22 because of one browser resource console error; G2 suite 90/91 because payment is disabled in development; SC01/SC03/SC10 browser paths stop at the same disabled-payment boundary.
- **BLOCKED:** live model/provider acceptance.
- **NOT_RUN:** GitHub Actions.
- **NOT_RUN:** D3-A/D2 cross-phase regression in this 02B batch.

Do not summarize this matrix as “35/35 passed.”
