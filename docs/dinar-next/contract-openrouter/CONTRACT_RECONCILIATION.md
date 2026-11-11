# Six frozen contract conflicts — reconciliation, 2026-11-11

Application runtime: `28f26779fbc4b23c6269795656a0d42db7aff9ef`. Starting delivery: `15a517144b6804bb50b07817d7fbfdc803734d94`. Baseline: `eda6d4205c2f0553b26a87c19255e3b06b598706`. No runtime changes or frozen expectation edits in this reconciliation. The six failures remain FAIL; recommendations below are not acceptance overrides. Existing raw failing runs at this exact runtime are retained in the evidence archive, including original earlier failures and hashes. New targeted checks supplement them; they are not a replacement full regression run.

Exact test IDs below use file plus complete Node test name, since several cases have no unique numeric ID. Paths start at `artifacts/api-server/`.

## R01 — prior F01

ID: `test/lab-defect-regressions.test.ts::general text is not routed to checkout, market or recommendations` (line 135).

Frozen requirement: `assert.ok(ok.surfaces.includes("CHECKOUT"), "a real checkout request still opens checkout")` after `كمل الطلب` without a visible cart. Competing frozen catalog case G03-015 expects `كمل الطلب.` without checkout context to exclude CHECKOUT, PAYMENT_REVIEW and ORDER with no mutations. Punctuation does not supply meaningful purchase context.

Trace: `src/ai/conversation-runtime.ts:152–201`, `executeCartConversationTurn`, normalizes punctuation and requires visible CART for ambiguous order continuation; otherwise asks clarification. Original failure: CHECKOUT absent. Deterministic contract disagreement, not network/provider failure.

Owner authority: server-authorized commercial lifecycle/confirmation is required, but opening an empty checkout is read-only navigation. The owner has not explicitly forbidden that navigation. Therefore the previous report's security rationale does not settle this conflict.

Smallest recommendation: preserve current clarification while owner decides D01: clarification/selector (recommended) versus read-only checkout navigation without context. Then approve a versioned acceptance contract covering both requests identically, without rewriting either frozen case. Do not add punctuation-specific routing or bypass confirmations.

## R02 — prior F02

ID: `test/model-native-routing.test.ts::D6-AI-01 scripted read-only tool results ground the final comparison` (line 463).

Frozen requirement: `assert.match(reply.body, /SCRIPTED_GROUNDED_COMPARISON/u)`. The mock returns only that marker after searchListings and getResource. Other assertions cover tool feedback, identities, result-set persistence and zero cart/order mutation; failure at the marker prevents later assertions executing in that frozen test.

Owner requirement (owner's C-12 relay in this conversation): “The prose and cards must be grounded in the same authoritative successful read relevant to the current user request.” Also: “If the prose cannot be grounded in the selected result, regenerate or safely qualify the response. Do not fabricate product information.”

Trace: `src/ai/smart-turn.ts:2058–2110` selects authoritative successful results and renders canonical titles/prices through `withModelToolAnswer(..., true, "DINAR")`; it replaces the opaque marker. Original failure is missing marker, not wrong product identity.

Judgment: preserving this marker is not an approved semantic requirement. Current response regeneration is permissible, but unconditional replacement also discards potentially useful grounded qualitative reasoning. The owner did not mandate unconditional server-authored prose. This remains a product limitation, not evidence that arbitrary model wording must always be discarded.

Smallest recommendation D02: technical acceptance approval for a new semantic contract asserting relevant answer, exact IDs/resultSet/market/account and no unauthorized mutations, with negative controls. Keep the old marker test/evidence frozen. If qualitative reasoning is required, validate a grounded explanation in this same runtime; do not restore unchecked prose, add a renderer or introduce another result store.

## R03 — prior F03

ID: `test/model-native-routing.test.ts::D6-AI-01 resumes a stale read-only loop from persisted feedback`.

Frozen requirement: `/RESUMED_FROM_PERSISTED_RESULTS/u` must occur in the final body. The fixture persists successful search feedback, expires the pending message and resumes the same turn. The same quoted C-12 owner requirement applies.

Trace: persisted actor/conversation/market/message/signature continuation enters the existing model-tool loop; `src/ai/smart-turn.ts` canonical-result finalization replaces the scripted marker as in R02. Original failure: marker absent. No separate provider or recovery outage is established by that assertion.

Smallest recommendation: D02 also covers explicit semantic recovery assertions: exact persisted result-set identity and authorized resources, bounded resume, no repeated writes, no stale cross-account/market source. Keep old assertion unchanged. New source-binding tests pass, including a broken-binding negative control, but do not claim they prove arbitrary provider prose quality.

## R04 — prior F05

ID: `test/search-sql-foundation.test.ts::SF-03 with no search documents (nothing backfilled) the SQL engine equals the legacy engine exactly` (line 77).

Frozen requirement quoted from helper: “the complete matching set of every query is identical (no listing gained or lost)”. It compares current legacy results with the pre-C1 golden before reaching SQL/stale equality.

Current owner direction: reliable buyer-filtered search. Repository acceptance scenario SC02 states “فلاتر السنة والسعر والسوق والحالة.” (`docs/dinar-next/DINAR_TEN_END_TO_END_ACCEPTANCE_SCENARIOS.md:54`). The used-condition request must respect authoritative stored condition.

Trace: `src/lib/marketplace-listings.ts:277–289` derives conversational condition and uses stored `attributes.condition`, falling back to title only when absent. For `أبي هاتف مستعمل`, old golden includes eight rows titled used but stored as new: sf-0043, sf-0047, sf-0051, sf-0055, sf-0059, sf-0063, sf-0067, sf-0071. Current result has 25 rather than 33. See preserved `SQL_CONDITION_TRACE.json` and fresh `followup-search-condition-trace` PASS.

Judgment: historical preservation of contradictory rows conflicts with reliable condition filtering. Smallest resolution: retain strict filtering; acceptance reviewer approves a new versioned semantic gate while original golden/test remain unchanged and FAIL. No commercial policy decision or data rewrite required. New current-engine equivalence evidence, rather than this prematurely failing assertion, covers stale SQL equality.

## R05 — prior F06

ID: `test/search-sql-foundation.test.ts::SF-01 after the backfill the SQL engine still equals the legacy engine and the pre-C1 golden` (line 84).

Requirement: “the SQL engine still equals the legacy engine and the pre-C1 golden”. Same owner condition requirement, implementation and eight contradictory rows as R04. `assert.deepEqual(fresh, legacy, "SQL/fresh equals LEGACY")` passes before the golden assertion fails. This is not evidence of a SQL/legacy mismatch. Existing independent second-pass search equivalence covers all 88 queries, stale and refreshed.

Smallest resolution: same versioned semantic acceptance approval as R04; preserve original FAIL and golden. Do not add exceptions admitting new-condition listings to a used-only request.

## R06 — prior F08

ID: `test/api.test.ts::conversation seller drafts and order references remain reviewable and authorized` (line 2577).

Frozen requirement: after area input `assert.equal(draft.draftStep, "contact")` (2607), followed by `payment_methods`, then review. Actual step is review.

Trace: `src/ai/listing-draft.ts:394–406`, invoked near 2043, defaults CHAT_ONLY and CASH_DIRECT with DINAR_DERIVED provenance and permits edits at review. Source comment claims “Short draft (owner decision): contact defaults to DINAR chat ... and payment to direct settlement between the parties ... Both appear in the review and change by saying so in the chat.” Introduced by Claude commit `8d9732fe9243007f967602bdccec72a1eaf360d5`, “draft: short draft defaults (chat contact, direct payment) editable from the chat”. Fresh draft-edit tests: 6 PASS.

Authority assessment: latest owner instruction says preserve completed DRAFT. A source comment/commit claiming owner approval is implementation evidence, not a separate primary approval record. No independent approval record for these exact defaults was found in the reviewed instructions/history. `OWNER_DECISIONS_2026-10-30.md` records direct-settlement preference as undecided. A draft payment preference must not be mistaken for approved settlement execution or activated payment capability.

Smallest recommendation D03: owner ratifies the short flow/defaults, editable provenance and deployment scope; then acceptance reviewer adds a versioned gate for review/edit/publish confirmation. Until then preserve completed Claude flow and the original failing API assertion. Do not revert the flow or activate/change financial settlement to make this test green.

## Pending decisions and correction of earlier claims

| Decision | Required authority | Proposed minimum |
|---|---|---|
| D01 | Owner | Choose context-free “كمل الطلب” clarification versus read-only checkout navigation. |
| D02 | Technical acceptance reviewer; owner for product-quality scope | Ratify semantic C-12/recovery acceptance; specify whether grounded qualitative model explanations must be retained. |
| D03 | Owner | Confirm exact draft contact/payment defaults and staging/production scope; distinguish preference from settlement authority. |
| D04 | Acceptance reviewer | Approve versioned strict-condition search gate alongside preserved historical golden failures. |

This document corrects prior overstatements: checkout navigation is not purchase authorization; unconditional server prose is an implementation choice; draft-default primary owner approval is not independently established. No claimed policy approval is derived solely from Codex's earlier C12_CONTRACT.md report. None of these pending decisions has been silently applied.
