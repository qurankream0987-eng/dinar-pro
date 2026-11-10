# C-12 source binding and Claude presentation contract

Baseline: `eda6d4205c2f0553b26a87c19255e3b06b598706`. This branch does not merge any later Claude work.
The owner's relayed C-12 contract was received during implementation and governs this handoff.

## Root cause and limits of the historical evidence

The frozen laboratory register records the original live sofa/AC mismatch but retained only error
logs, so the exact historical provider/tool sequence cannot be reconstructed. The local scripted
reproduction establishes a concrete defect: successful listing reads supplied canonical card rows,
while `groundedModelProse` checked monetary assertions against *all* successful feedback and did
not establish that ordinary item prose described the selected rows. Unrelated prose without an
invented amount could therefore accompany a valid card. The duplicate-read stop guard itself
returns a server-authored partial-results message; bypassing that guard is not a solution.

A second identity discontinuity existed: `withModelToolAnswer` removed a successful search's
`resultSetId`, and the HTTP response created another result set. This impeded read-to-card tracing.

## Current engineering contract

- Use the existing tool registry, `ai_result_sets`, message/block persistence and `card-envelope.ts`.
- A prepared commercial review retains its higher-priority server authority. Existing confirmations,
  version checks, owner checks, lifecycle and receipts remain unchanged.
- A validated comparison retains its canonical rows. A resource read outside an earlier search
  replaces that unrelated search; a read inside it refreshes its row without inventing another set.
  A new search invalidates obsolete comparison/resource selection. This is dependency-aware
  read selection, not blanket selection of the last arbitrary tool call.
- Listing prose is regenerated from the selected canonical rows (including genuine empty results).
  Free model prose is not treated as proof of product identity. General conversation outside
  listing reads remains model-authored. An incomplete read loop remains explicitly qualified.
- Preserve a current-turn search's result-set identity through response/card persistence. Validate
  its conversation, market and owning user message before reuse. An explicit earlier `getResource`
  reference retains its validated original set ID. A stranger or another market cannot reuse it.
- `dinar_canonical_read` and `dinar_response_source` trace tool, user-message, conversation, market,
  source-set and exact resource IDs. They contain no prompt, image, credential or contact values.
- No Card Envelope/schema, renderer, result-store, cart, financial action or authority is added.

## Frozen local acceptance

`engineering-source-binding.test.ts` covers ten changing-topic turns, multiple searches, empty
reads, explicit earlier references after intervening topics, same-named products with different
IDs, cross-account and cross-market refusals, and conversation reload. `engineering-constraint-reentry`
checks exact tool-to-card source ID and one persisted canonical set. Original model-native,
card-concurrency/session, stream-recovery and commerce browser suites provide additional coverage.
The source-binding negative control deliberately restores unrelated model prose, fails the new
suite, and restores the source afterward. See the evidence manifest for exact outcomes.

## Claude compatibility

No edits to `artifacts/dinar/src`, `card-envelope.ts`, the shared envelope schema, OpenAPI, generated
clients, or migrations. Claude's DRAFT/DSLAB and premium contributions are inherited, not rebuilt.
The sole web asset change renders the existing approved star-free mark into the mobile touch PNG.
The icon generator uses the existing Playwright dependency. Two browser test changes redirect
screenshots to unique run directories instead of overwriting historical lab/maps evidence.

Some frozen historical model tests assert arbitrary markers such as
`SCRIPTED_GROUNDED_COMPARISON` and `RESUMED_FROM_PERSISTED_RESULTS`. Those markers are deliberately
not injected into server-authored listing facts. The assertions and their failures remain intact;
reviewing their compatibility with this approved C-12 contract is an explicit handoff item.

No live model quality, staging deployment, external provider operation or production security
acceptance is inferred from scripted local results.
