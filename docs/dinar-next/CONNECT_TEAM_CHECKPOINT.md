# Connect read-only human teams and credential concurrency — 2026-11-05

This implements the owner's explicit policy in `CONNECT_TEAM_POLICY.md`. It extends the financial checkpoint; the larger Connect/project mission remains in progress.

## Preserved baseline

Worktree `/workspace/dinar-next-unified`, local branch `codex/dinar-next-unified-development`, parent checkpoint `816a707984a4d093c035de725a8fde38b4c97f5f`, unified authority `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a`. Original checkout `/workspace/dinar-pro` remains clean at `b1b20e513ed25952bc086778fb71af88adcc54ba`. No remote mutation, deployment or production access.

Original 57 SQL files and their manifest entries are byte-identical to the unified authority. The current 60-entry manifest adds only reviewed 0057, 0058 and 0059 migrations. `0059_connect_readonly_team` adds the captured D4 delegation version; existing mappings remain intact at version zero and cannot authorize access until the owner explicitly confirms a current grant. Its SHA-256 is `f47049420d4b63b77c07c88e3866ad95f173616b3ce48aa3d8a355b426fb556d`. No migration was rewritten.

Original Conversation V2 preservation remains **BLOCKED**, not declared lost: expected original HEAD `719d4715a869f69831049a6a2f6c349cec934344`, tested source `442008a5fdcb9dc6529a55364cd66e033c6a0909`, expected `codex-conversation-v2-authorized.bundle`. The owner confirmed that the previous workspace is unavailable here. No identities/history were reconstructed.

## Implemented behavior

- Canonical D4 authority was extracted without weakening its policy: shared business/owner/employee identity, memberships, grant status/version/expiry, market and capability checks. The existing D4 catalog still uses the same policy and denial auditing. Connect is a version-bound read scope extension, not a second delegation lifecycle.
- Owner-only team endpoints list existing human D4 grants, explicitly confirm CATALOG_READ and/or REPORTS_READ at an expected active version, and remove Connect access without revoking D4. Management/write scopes are rejected by the contract. No new business subscription or identity is created.
- Owner UI presents the existing grant, current version/expiry, unchecked confirmation and only the two approved read scopes. Staff see authorized partner catalogs/reports, never connector configuration, keys, agreement acceptance or owner controls. Staff catalogs use the existing external offer table; no cart/action runtime was added.
- D4 suspension, revocation, expiry and version changes fail closed. Resuming a grant does not silently restore an older Connect approval. Personal-data export includes only the requesting employee's bounded grant/scope metadata, excluding the owner's identity and provider secrets.
- Connect operations consistently lock the parent partner before its integrations. CONNECT connection quota uses an owner-scoped advisory transaction lock with shared owner identity locking, avoiding the lock upgrade deadlock between independent credential issues. MARKETPLACE keeps its original lock/quota behavior. Ownership is checked before waiting for exclusive private parent locks.
- Shared OpenAPI contracts and generated clients were regenerated from authored sources. Orval's existing validator/type name collision is resolved in the authored export surface, not by editing generated files.

## Evidence

Local evidence directory: `/workspace/dinar-connect-evidence/`.

- `connect-team-red2.log`: actual missing team endpoint 404 before implementation; 14 existing Connect cases passed.
- `credential-lock-order-red.log` → `credential-lock-order-green1.log`: PostgreSQL barrier forces two independent issuance requests to queue together; both now succeed instead of deadlocking.
- `private-lock-auth-red.log` → `private-lock-auth-green1.log`: foreign catalog/key/status writes are denied before the private parent lock is released.
- `team-regression-final.log`: Connect 15, unchanged D4 4, D4/D5 isolation 8, unchanged model-authority boundary 6 passed. This invocation also contained two mistaken nonexistent test filenames; those build-selection failures are retained and were corrected in the next invocation, not presented as a wholly successful chain.
- `team-finance-privacy-final.log`: correct existing financial-state-machine 23 and closure-privacy 11 passed, outbound attempts zero.
- `team-d4-green.log`: unchanged canonical D4 4 passed independently. One earlier D4 invocation omitted its required `BDINAR_D4_ACCEPTANCE` flag; it was refused before running and then corrected.
- `team-release60.log`: release migration runner 12 passed, including fresh, prefix, rollback, interrupted history, concurrency and tampering checks.
- `team-readiness-final.log`: readiness 15 and TLS 7 passed; one existing optional TLS-service integration skipped because no dedicated service is configured.
- `team-g1.log`: existing G1 provider 39 passed; secret/address/coordinate log-canary scan zero, outbound attempts zero.
- `team-pg16.log`: all 15 Connect cases repeated successfully on disposable PostgreSQL 16; primary checks used PostgreSQL 18.
- `team-browser1.log`: actual Chromium owner grants catalog access via UI with explicit confirmation; staff sees catalog and no management/acceptance controls. Arabic RTL at widths 320/390/1280, no horizontal overflow, page/console errors or external requests. Existing agreement acceptance, referral default-off consent, withdrawal, opaque navigation, null opener, draft preservation and zero internal basket flights still pass. Screenshots: `browser-team/`. Isolated HTTPS fixture is not live provider evidence.
- `team-codegen2.log`, `team-typecheck-final.log`, `team-api-build.log`, `team-web-build.log`: code generation, workspace typecheck and both builds passed. Web still emits its existing large-chunk warning; not claimed resolved. The first codegen found an Orval export-name collision; the authored export correction regenerated successfully.
- `team-migration60-preservation.json`: original SQL/manifest identity and all current manifest hashes verified.

The broader financial checkpoint's evidence remains historical evidence for its source cut; it is not counted as a complete project acceptance battery for every later change.

## Remaining scope and blockers

Continue provider feed/API/website adapters, reviewed read-only MCP and OAuth/PKCE lifecycle, site proof renewal/revocation, richer administrative agreement creation, full administrative finance browser acceptance and comprehensive project closure. Authorized provider sandbox credentials are absent. Spaceship official documentation and GitHub REST are restricted by current network policy; authenticated Git reads work, but write authorization is not established and no push was attempted. Native pinned egress must remain fail-closed under this environment's proxy. Legal retention/live agreements remain unapproved, and original V2 preservation remains blocked.
