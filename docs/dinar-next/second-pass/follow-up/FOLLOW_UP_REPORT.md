# Second-pass follow-up — final evidence, 11 November 2026

**Ready for independent Claude review: YES, with the limitations below. Not release-ready.** This packet is prepared for the owner; no message or handoff has been sent externally.

Starting evaluated runtime: `16f85e5a55ea360c646de56f4e42b93cf1755a1f`; starting delivery: `216e12e5ec54a0d9291577081c6e6433990e84f4`.

New runtime: **`28f26779fbc4b23c6269795656a0d42db7aff9ef`**. Commit `2276d5a` adds independent prompt-contract and test-only transport diagnostics; `28f2677` fixes prompt ordering. The sole application-source change puts the existing DINAR identity sentence first and retains Claude's identical no-emoji instruction immediately after it. No instruction is removed. A new RED/GREEN test preserves identity, presentation constraints, server authority and user-message framing. The previously failing DS-01 now completes all its assertions, including provider-reported usage/cost checks.

No UI/presentation, Card Envelope, registry, authorization, pricing/commission, checkout, schema, migration, dependency or lockfile change was made. No functionality was rebuilt. Exact source preservation is in `PRESERVATION.json`.

## The original nine failures

Original failing logs are copied byte-for-byte and hashed in `ORIGINAL_FAILURE_EVIDENCE_SHA256.json`. Each suite ran independently on a fresh loopback database before repair, then again on the new runtime. Detailed names, scenarios, source locations, causal limits, corrective actions and evidence paths are in `NINE_FAILURE_INVESTIGATION_MATRIX.json`.

| ID | Exact failing test | Finding and final disposition |
| --- | --- | --- |
| F01 | general text is not routed to checkout, market or recommendations | Deterministic contract conflict: old positive expects CHECKOUT for context-free «كمل الطلب»; frozen G03-015 forbids it. Clarification retained; assertion still FAIL. |
| F02 | D6-AI-01 scripted read-only tool results ground the final comparison | Deterministic contract conflict: arbitrary model prose marker versus approved C-12 server-grounded listing facts. Still FAIL; source binding preserved. |
| F03 | D6-AI-01 resumes a stale read-only loop from persisted feedback | Same prose-contract conflict for the resumed-result marker. Still FAIL; canonical read/recovery authority preserved. |
| F04 | SC01 REAL_E2E: seller's words → published listing → another user's completed order | Intermittent/environment-sensitive browser failure. Fresh unchanged test PASS; controlled load fails at a different navigation deadline. Original backend read failures and causal limits retained below. |
| F05 | SF-03 with no search documents (nothing backfilled) the SQL engine equals the legacy engine exactly | Historical golden includes eight contradictory-condition listings. Current authoritative condition excludes them. Still FAIL; independent current-contract SQL equivalence passes. |
| F06 | SF-01 after the backfill the SQL engine still equals the legacy engine and the pre-C1 golden | Same eight-row golden conflict after refresh. Still FAIL; no golden rewritten. |
| F07 | SC01: «أبي أبيع هاتفي المستعمل» starts a draft in the phone category | Intermittent HTTP `ECONNRESET`, not a failed DRAFT semantic assertion. Fresh unchanged suite and four loaded observed repetitions PASS; exact original peer-close cause not retained. |
| F08 | conversation seller drafts and order references remain reviewable and authorized | Deterministic contract conflict: owner-approved short draft defaults CHAT_ONLY/CASH_DIRECT lead to review; old flow expects separate contact/payment questions. Still FAIL; DRAFT defaults and confirmation preserved. |
| F09 | DS-01 general Arabic: canonical request reaches DeepSeek and the validated reply reaches the UI stream | Deterministic request-prefix compatibility defect, fixed without changing either instruction. PASS on final runtime, including assertions previously hidden behind the first failure. |

**Correction to the earlier report:** SQL query «أبي هاتف مستعمل» excludes **eight**, not two, rows. They say “used” in their titles but store authoritative condition `جديد`. `SQL_CONDITION_TRACE.json` records all eight IDs, titles and conditions. The new trace test proves each exclusion and that no resource was added; the existing stale/fresh SQL equivalence test also passes. These supplementary tests do not replace either frozen golden assertion.

Six persistent failures therefore remain acceptance-contract conflicts, not reclassified passes. Resolving their expectations requires review of the conflicting contracts; no punctuation hack, fabricated model marker, relaxed condition, removed assertion or changed commercial default was used.

## Why the passing retries do not close the original transport failures

F04's original acceptance POST returned HTTP 200. Around it, order and order-message GETs returned repeated HTTP 500s. The original PostgreSQL log records connection resets/EOF, and the UI did not expose its delivery-proof form within 30 seconds. Original error-message redaction prevents identifying the precise underlying exceptions. We cannot retrospectively prove a pool-acquisition timeout.

A controlled local experiment overlapped one unchanged browser journey with three isolated core workers under a four-CPU quota. Test-only pool/event-loop observation measured **4,641 ms maximum event-loop delay**, **zero acquisition timeouts** and **zero other acquisition errors**. The original delivery step passed in this experiment; a later `page.goto` exceeded its unchanged 30-second deadline. This confirms sensitivity to resource/timing conditions but is **not** an identical reproduction of the original missing-form failure or a production root-cause fix.

F07 failed before a fetch response with `read ECONNRESET`; no matching application semantic error was retained. The fresh original five-case suite passes. Four observed loaded repetitions also pass, with 3,400 pool acquisitions and no acquisition errors. This narrows the failure to intermittent transport/environment behavior; it does not identify which peer/timer closed the original connection. No automatic retry of a potentially state-changing POST was added.

Future operational acceptance should run browser suites after compiler/core workloads, on isolated resources, while retaining safe connection/error-code diagnostics if failures recur. Do not increase acceptance deadlines or call the production failure resolved based on passing retries. No production timeout or UI code was changed.

## Additional observations discovered during validation

One post-fix full DeepSeek run had **19 PASS / 2 FAIL**: DS-13b missed one of 40 original eight-second startup deadlines, and DS-15 also missed an eight-second orders-entry deadline. These are additional observations, not substitutions for the original nine. One initial failure had no initialized DOM; another showed one user bubble and an active typing indicator. No permanent answer loss is established by those observations.

A full-fixture diagnostic retained every original assertion and deadline. On a miss it would observe up to 12 further seconds and **still return failure**, even if an answer appeared late. That diagnostic passed **21/21**, including 40 startup attempts, without taking the late branch. The final unmodified DeepSeek suite also passed **21/21**. UI source was unchanged. These clean repetitions do not constitute a UI-race fix; intermittent startup latency remains a disclosed risk. `ADDITIONAL_STARTUP_OBSERVATIONS.json` and the safe network timeline retain the details.

The first diagnostic selected three cases without their earlier synthetic policy/price fixture setup. All three failed fixture preconditions before browser execution; those logs are preserved as **diagnostic setup failures**, not product-regression results. The complete fixture sequence was then used. No original test or assertion was edited.

## Verified results and provenance

| Recorded run | PASS | FAIL | BLOCKED / SKIP |
| --- | ---: | ---: | --- |
| Original frozen 500, source `16f85e5` — retained, not rerun as a new full evaluation | 409 | 0 | 91 BLOCKED |
| Original broad 126-suite battery — retained, not relabeled | 843 | 9 | 1 SKIP |
| Independent seven-suite reproduction before fix | 119 | 7 | 0 |
| Post-fix related 13-suite validation | 178 | 4 | 0; includes the two startup deadline observations |
| Final unmodified seven-suite recheck, source `28f2677` | **120** | **6** | 0 |
| Full-fixture startup diagnostic | 21 | 0 | 0 |
| Independent condition trace | 1 | 0 | 0 |
| 91-case deterministic recheck, source `28f2677` | 0 | 0 | **91 BLOCKED** |

Runs overlap; do not sum them as unique cases. All original failures, the controlled-load failure, setup failure and subsequent clean repetitions remain available. This follow-up did not rerun or mathematically “adjust” the full 843/9/1 battery. `VERIFIED_RESULTS.json` records the actual runs. API typecheck/build passed. No paid/outbound provider request was made.

Financial state machine **23/23**, commission preview **4/4**, vision allowance/accounting **2/2**, security acceptance **12/12**, DRAFT **6/6**, model tiers **24/24**, AI provider **47/47**, transport **8/8** and conversation router **16/16** pass in post-fix validation. Model-native routing retains its two declared prose-contract failures. Real provider latency/cache behavior remains unverified.

## Classification of all 91 blocked scenarios

`BLOCKED_91_CLASSIFICATION.json` enumerates every ID, prompt, blocked turn, original and fresh evidence, and shared prerequisite. Every selected case was rechecked in deterministic mode; all 91 remain BLOCKED, with zero provider calls/tokens/spend. No case became newly executable under authorized conditions.

| Mutually exclusive primary dependency | Cases |
| --- | ---: |
| Live text-AI/general-model answer | 91 |
| Vision provider | 0 |
| External network restriction alone | 0 |
| Environment/credentials alone | 0 |
| Other prerequisite alone | 0 |

All 91 also share prerequisites: a capable configured text model, valid protected credentials where required, explicit paid-test budget or an authorized free local model, approved live execution, and endpoint network permission. These overlapping prerequisites do not create additional distinct cases. No local general model is configured; provider validity/budget is not established; deterministic execution blocks model calls. DeepSeek/OpenRouter are outside the current package-manager network preset. The recorded blocking reply was model unavailability, **not** an attempted network request.

No image attachment is required by these 91 catalog cases. Live vision verification is separately blocked outside this population; staging CONNECT restrictions are also separate. Mocked providers prove contracts, not the quality of generated answers.

## Staging and minimal access remediation

Original HTTP and Chromium CONNECT failures are preserved byte-for-byte in `staging-proxy-evidence/`. Current Cloud observations remain revision 3, enforced restricted/package-manager policy, without either required Railway host. No repeated origin probe was attempted under that unchanged denial. No new application HTTP status or readiness body was obtained. Health, database, migrations, configuration, phone verification, deployed SHA and deployed/local comparison therefore remain **BLOCKED**, not FAIL. No SMS-only 503 is inferred.

Railway management connectivity is a separate BLOCKED item. Protected-token presence does not prove token validity, staging scope or project/environment identity.

Minimal owner-side remediation, without deployment or service modification:

1. Review Cloud network settings for the exact application host `dinar-staging-app-staging.up.railway.app`; allow `backboard.railway.com` separately only for approved read-only management metadata. No draft/settings change was applied here.
2. Keep the existing staging credential protected; do not paste it in chat or rotate it merely because CONNECT was denied. Verify scope only after connectivity works.
3. Refresh current/enforced Cloud observations, then perform one read-only GET each to `/api/healthz`, `/api/readyz` and `/`. Record origin status/body per readiness component; SMS-only unavailability must not imply database failure.
4. Establish deployed commit/image identity reliably from approved read-only metadata, then compare it with the source SHA above. Do not run migrations, deploy, restart, send SMS, purchase or activate drivers as part of these checks.

Live text/vision quality, provider privacy/retention operation, SMS/OAuth operation and staging migration/deployment acceptance remain external dependencies.

## Security, finance and Claude integration notes

The database tree, financial snapshot/ledger/refund implementation, inactive commission preview, policy versions, all market pricing, API schema/clients, Card Envelope and UI source are unchanged from `16f85e5`. The approved 5%/10% direction remains disabled for activation pending approved thresholds/effective dates; no historical order, commission or settlement was recalculated.

The only production diff is the order of two existing system-instruction strings. Server-owned identities, result-set/market/account/conversation binding, allowed actions, pending reviews, confirmation and receipts remain authoritative. No purchase authority moved into cards or model output. Claude's cards, floating cards, mobile work, DRAFT and DSLAB implementations are preserved. The C-12 marker conflicts must be reviewed without weakening source-binding negative controls. The new prompt prefix may change provider cache reuse; no live cache/cost-performance claim is made.

**Independent Claude review readiness: YES, with known red acceptance contracts and disclosed flakiness. Release/staging readiness: NO. Engineering completion is not claimed.** Review the one-hunk source change, new tests/diagnostics, nine-row matrix, per-91 classification and preserved raw evidence. Nothing was pushed, merged, deployed, restarted remotely or changed in Production. The owner controls any subsequent handoff, integration or deployment authorization.
