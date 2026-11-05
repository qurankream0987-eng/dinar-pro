# Platform / intelligence coordination — owner directive, 2026-11-05

The platform is preserved and extended, not rebuilt. Latest authenticated Git-head inspection found:

| Reference | Exact SHA |
| --- | --- |
| Replit six-wave integration and PR #5 Git head | `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a` |
| Published Codex platform parent | `34bb754d60617fbb49c26e6f1726f141234c8598` |
| Claude intelligence branch, inspection snapshot | `56b0b51fccfef3d5c814e4fd97b4fa942ea9ee58` |
| Historical Qoder temporary closure | `44dfbf639fda27d4b8de7908c0aea8df25ab50ef` |
| Main, unchanged | `b1b20e513ed25952bc086778fb71af88adcc54ba` |

Claude's merge base with the platform is exactly `34bb754d60617fbb49c26e6f1726f141234c8598`: Claude already starts with the verified Codex website, card, partner and administrative finance work. None of it needs rebuilding or copying into a new engine. The new local platform changes do not modify Claude's intelligence files or its branch. No merge/cherry-pick of that active branch was performed, and no claim that its tests passed here is made. The branch may advance after this snapshot.

## Active contribution classification

All nine unique Claude commits are **missing and worth integrating into the final joint candidate, pending Claude's coordinated review**. They remain in their original accessible Git history, not relabeled as Codex work:

| Commit | Reviewed contribution / integration requirement |
| --- | --- |
| `2b62e92ab7e49453c2b11312f3a505356fa11fac` | Model-discoverable Connect reads, capability self-knowledge and negation-safe cart routing. Its extracted `connectPartnerSearchTurn` / `connectDomainSearchTurn` reuse current server services; retain their legal/rate/typed-card boundaries and no-purchase semantics. |
| `b21bc927bca90f10f376cc72e1803bf9289035ec` | Declares CAPABILITIES in the OpenAPI surface contract and removes the test's CART-first assumption. Combine this authored enum change with current diagnostic paths/schemas, then regenerate. |
| `03939c8cac0b0f2f53128110c3b5ccba0cda5c07` | DeepSeek test aligns with the existing model-tool contract. Review with the actual tool registry; do not silently edit this Claude-owned test merely to obtain a green local battery. |
| `6cc370e8b463f2c0e245e0c9e5aa50c917cf0689` | Routing evaluation and advisory/business-setup intent repair. Intelligence-owned; keep platform permission/business services authoritative. |
| `8f5e67a26d94553da3e76c792515b7eac81da0fa` | XP market-pulse expectation for a DINAR-scoped demand question. Pending joint semantic acceptance, with zero model calls still required. |
| `aadff91ecf7e099a0805b40e5309952b532b8d0f` | Expanded 42-case routing evaluation with actual outcomes/context references. Pending joint execution; source inspection is not acceptance evidence. |
| `701acb262408196a80dd5c945a4fe3d10f9fb436` | Business/order-issue read capabilities and module-cycle correction. The cycle correction is part of the coherent series; do not transplant the initial feature commit in isolation. |
| `0173a441fb5dac9473c098c3e2371e843bc3a948` | Registry-derived self-knowledge and initialization-order regression. Retain the guard and registry as the semantic source of truth. |
| `56b0b51fccfef3d5c814e4fd97b4fa942ea9ee58` | Model-prepared business product changes through current D3-A authority. No bypass of stored review/owner authorization; intelligence-owned. |

## Exact overlap

Claude changes `src/ai/{business-turn,capability-registry,dinar-capabilities,intent,model-capability-tools,model-read-capabilities,smart-turn,tool-registry}.ts`, `src/connect/conversation.ts` and its associated intelligence tests. This platform milestone changes none of those files.

The overlap with the platform diagnostics milestone is limited to:

- `lib/api-spec/openapi.yaml`: Claude adds CAPABILITIES; platform adds typed diagnostic operations/schema. Preserve both in the authored source.
- `lib/api-client-react/src/generated/api.schemas.ts`.
- `lib/api-zod/src/generated/api.ts`.

The generated overlap is derivative, not a reason to copy one branch's generated tree over the other. After an explicitly authorized joint integration, regenerate clients/Zod once from the combined OpenAPI and authored schemas. Preserve the authored path/query export aliases in `lib/api-zod/src/index.ts`, and run reproducibility/typecheck, initialization-order, capability/role-union, routing, Connect/cards, D3-A/D4, financial/legal and real browser regressions. Neither branch is rewritten; merge/integration authorization is not inferred from this report.

## Historical work retained

The existing preservation inventory contains 47 historical branch tips. A new authenticated read of all 49 current remote heads found only the newly visible Claude branch and the Codex publication branch absent from that inventory; every historical tip still matches. Therefore completed historical review is reused rather than restarted.

- **Already integrated:** Replit six waves; ancestor Claude commerce/C1/business contributions; canonical Qoder seller/delegation/cart/campaign/delivery/legal/memory work. Original histories and the original 57 SQL files/manifest entries remain intact.
- **Already integrated, attributed selective corrections:** nine Qoder operational/test corrections listed in `CODEX_CLOUD_ENGINEERING_STATUS.md`, with their original source IDs in `cherry-pick -x` commit messages. No wholesale historical branch merge.
- **Superseded by the verified canonical implementation:** divergent old native-business/stock/recovery alternatives where the current canonical services and source-specific acceptance already cover the contribution. Historical refs and alternative tests remain preserved.
- **Incompatible/unsafe as a wholesale import:** older Qoder/Codex alternative migration sequences and integration trees that would replace the 57-migration authority or remove later safeguards. Do not import their SQL numbering or overwrite current services.
- **Preserved historical evidence, no application contribution to import:** Qoder's four commits after `5446ccb8e4b0164c339a78350dd155c985b54c74` modify three documentation/evidence files only. The full original tip is retained; its historical run IDs/billing observations do not establish current Cloud CI results.

Full source-level inventory remains `/workspace/dinar-completion/SOURCE_PRESERVATION.md`, `source-inventory.json` and `nonancestor-diffs.txt`. These distinguish ancestry, semantic contribution and acceptance, rather than treating a divergent tip as automatically missing code.

Original Conversation V2 remains a separate **preservation blocker**, not an accessible branch contribution: expected `719d4715a869f69831049a6a2f6c349cec934344`, tested source `442008a5fdcb9dc6529a55364cd66e033c6a0909`, expected `codex-conversation-v2-authorized.bundle`. The owner confirmed the old workspace is unavailable here. No original identities have been recreated.

## Acceptance follow-up: test-only overlap, original runtime untouched

The complete frozen platform run at `414331473448a35426d4187587fdb095402baffe` reproduced three stale test contracts on both PostgreSQL versions. Minimal independently justified assertions now align with the current platform: `command-d-acceptance.test.ts` locates the enum without CART-first ordering and still checks every emitted surface; `deepseek-chat-compatibility.test.ts` checks the exact existing 13-tool contract (not an unrestricted set); `experience-upgrade-acceptance.test.ts` requires the actual MARKET_OPPORTUNITY insufficient-data card and still requires zero model calls.

These three files overlap respectively with Claude commits `b21bc927bca90f10f376cc72e1803bf9289035ec`, `03939c8cac0b0f2f53128110c3b5ccba0cda5c07` and `8f5e67a26d94553da3e76c792515b7eac81da0fa`. Classify these as **partially aligned at the test-contract level only**; no active intelligence commit/runtime is imported, merged, rewritten or claimed as accepted here. Claude's CAPABILITIES/routing/read/preparation features remain pending coordinated integration. Preserve the strict combined registry/fixture contract when resolving test-file conflicts. The authored OpenAPI/generated-file overlap above remains.

Recovery/performance fixture corrections are in `artifacts/dinar/test/w02u3-card-{recovery,performance}-ui.mjs` and `artifacts/api-server/test/w02u3-card-recovery-browser-journey.test.ts`; they preserve server-owned execution and exact correlation, rather than editing intelligence code. All original financial, legal and AI-authority assertions remain. The current comprehensive report records retries and the exact accepted source cut.

## Closure refresh: active Claude head a20706f (2026-11-05)

Authenticated read/fetch found `a20706fb5e9330883ea882eb6f3b92130615fd49`, six new commits after the prior snapshot. Preserve them: `46157ded7f60999c1adf763bd22603cdd90ae6eb` (bounded verification and isolated test fixes), `2eea411f57818e856debc60929047c1034550584` (render-based performance wait), `53ca8efbd25d9140dce48602a560b85f359306d4` (deployment frame restriction), `b4f308386f9b69d527e804c0ba983ce33fce3ea0` (shared seller-dues read), `e1a063d65588eb40f8345b49b11035987537ca01` (integration plan), `a20706fb5e9330883ea882eb6f3b92130615fd49` (prepared self-hosted model slot, not deployed). No migration was added by Claude. These remain unmerged original commits.

Additional necessary overlap: `artifacts/dinar/test/w02u3-card-{performance,recovery}-ui.mjs`, recovery wrapper, `artifacts/api-server/src/app.ts` and `test/same-origin-web.test.ts`. The platform reproduces and minimally repairs production framing locally (also requiring self-only under NODE_ENV=production), independently aligned with Claude's security finding 53ca8efb; no active branch commit is imported or rewritten. At integration retain both label and runtime-production protection and attribute the existing original commit.

The platform's new `routes/ai.ts` correction ends copied message timestamps before the next live turn; otherwise a 500-message copy can sort a newly edited turn into the middle of its history after hydration. Preserve this server ordering correction alongside Claude's rendered-completion wait. Keep exact correlated persistence, visible edited text and idle composer assertions; do not replace them with transport-only waits or a weaker fixture. Claude's bounded-verification `Ai.tsx` changes remain intelligence-branch work, not silently claimed integrated.
