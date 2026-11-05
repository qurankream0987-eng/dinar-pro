# Connect site ownership lifecycle — 2026-11-05

Parent local milestone: `98bb679bb92fe4735d8199ce4ca245320cfc5260`. Development remains in `/workspace/dinar-next-unified` on local branch `codex/dinar-next-unified-development`. Unified authority remains `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a`; original checkout and all original 57 migrations remain unchanged. Current manifest has 60 migrations. This milestone adds no migration or dependency and performs no remote mutation or live service activation.

## Implemented

`connect/sites.ts` and the existing Connect portal now support owner-confirmed renewal of the 15-minute TXT challenge and terminal site-wide revocation. A renewed challenge immediately replaces the prior challenge digest; it does not extend or fabricate website verification. Existing verified evidence keeps its original expiry until a new DNS check succeeds. The existing verify operation rechecks the current digest under the parent/site locks after DNS returns, so an old in-flight DNS result cannot overwrite a newer challenge. Plaintext challenges are returned once, not stored in audit details or used as provider credentials.

Site revocation takes the parent partner lock before child locks, retires every attached integration and provider credential in the same transaction, and preserves catalog, contracts, referral, transaction and accounting history. Retrying revocation is idempotent. A revoked site cannot renew or verify, issue keys or create another connector. Integration creation rechecks the site under the parent lock after initial endpoint validation, closing a revocation race.

The portal requires a review followed by explicit confirmation for renewal/revocation; the destructive review explains the terminal result and preservation of accounting evidence. Revoked sites disable TXT verification and hide renewal/revocation controls. Team policy remains read-only; all site operations require the owner. Shared OpenAPI inputs and clients were regenerated from authored contracts.

## Evidence

Evidence directory `/workspace/dinar-connect-evidence/`:

- `site-lifecycle-red.log`: missing renewal endpoint failed the new regression before implementation. Existing 15 cases passed.
- `site-lifecycle-green1.log`: 16 Connect cases passed, including renewal, old TXT rejection, a controlled DNS-in-flight/challenge-rotation race, foreign-owner denial, terminal/idempotent revocation, all linked keys revoked and unchanged financial-ledger count.
- `site-regression-final.log`: Connect 16, network 4, card contract 4 and unchanged model authority 6 passed; all suites outbound zero. Also proves preserved version-zero staff mappings (including old management strings) remain inert until explicit current-version owner confirmation.
- `site-browser-final.log`: real Chromium owner renewal and revocation with explicit two-step confirmation; terminal verification disabled; all earlier mobile/RTL staff, agreement, privacy/referral, null-opener, preserved-draft and zero-basket-flight assertions pass. Widths 320/390/1280; page/console errors and external requests zero. HTTPS provider navigation uses an isolated fixture, not a live provider.
- `site-browser1.log` initially sampled a 94px overflow immediately after resizing. Instrumented `site-browser-red2.log` captured the stable screenshot and passed without a layout change. The final test explicitly waits for fonts and two rendering frames before measuring; it retains the exact zero-overflow assertion, rather than increasing tolerance or hiding overflow.
- `site-codegen.log`, `site-typecheck-final.log`, `site-api-build.log`, `site-web-build.log`: generated contracts, workspace typecheck and both builds passed. The existing frontend chunk-size warning remains.

No production database, remote migration, purchase, provider registration, deployment or push occurred. Authorized provider sandbox credentials and original Conversation V2 task/bundle recovery remain blocked as documented in the previous checkpoints. The broader mission still includes native feed/API/website pull adapters, reviewed read-only MCP, OAuth/PKCE lifecycle, administrative proposal/finance browser completion, performance and comprehensive project closure.
