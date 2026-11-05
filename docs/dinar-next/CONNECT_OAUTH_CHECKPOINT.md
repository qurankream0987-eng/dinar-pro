# Read-only public-client OAuth/PKCE — 2026-11-05

Parent local milestone `a6ad106f37b8beb3b660d0a560d896cf83d736a8`; same isolated Codex development branch and worktree. Current remote Replit/PR #5 authority reconfirmed `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a`. All 57 original migrations remain unchanged; current manifest has 60 migrations. This extension adds no dependency or migration.

The owner has now explicitly authorized publication **only** of `codex/dinar-next-unified-development` and a Draft PR toward the verified Replit branch. See `OWNER_GITHUB_PUBLICATION_AUTHORIZATION.md`, which supersedes earlier separate-approval requirements for this branch. Merge, deployment, production resources, force push and live financial activation remain forbidden. Previous checkpoint descriptions of no publication refer to their historical source cuts.

## Implemented authority and lifecycle

- `connect/oauth.ts` implements OAuth 2 public-client authorization code with PKCE S256, one exact `catalog.read` scope and independently approved authorization/token/catalog endpoints on one verified partner host. SIMULATION_ONLY is required. Google login identity verification remains separate; no account creation/session identity is inferred from a catalog token.
- Explicit owner commands start/restart, refresh and locally disconnect. Hashed random expiring state binds the owner, integration, revision, configuration digest, fixed callback and encrypted verifier. It is claimed once under the existing parent/integration locks before any exchange; a failed exchange cannot replay it. Concurrent callbacks yield one exchange and one rejection.
- Access and refresh tokens are validated for type, exact scope and bounded explicit expiry, then encrypted with the dedicated existing AES-GCM vault/AAD. Tokens never enter model context, browser responses, audit details or personal-data exports. Unconfigured vault/origin fails closed; no token from another service is used. Expiry begins when the token response arrives, rather than after waiting for a database lock.
- Refresh consumes the old local grant before network work, preventing duplicate refresh-token use. Failed refresh requires reauthorization. New authorization, disconnect, suspension or revocation retires the previous state material, preventing an old in-flight callback/refresh from reestablishing authorization. Revoking a site retires local authorization for every attached connector and preserves financial history.
- OAuth catalog reads reuse the structured pull adapter and existing importer. Only a server-decrypted current grant supplies the Authorization header; callers cannot submit it. Import rechecks grant identity/revocation/expiry after the network returns, so disconnect during a fetch cannot publish late results. No locks are held during provider requests.
- The callback accepts a code or a provider denial, never both; consumed/expired/superseded state fails closed. Query values are omitted by the existing safe HTTP logger. Successful/declined callbacks redirect only to configured DINAR `/connect`; the portal checks authorization status against the server rather than trusting a query-string success flag.
- Owner UI configures the public client, reviews each command, opens a verified provider authorization link with no opener/referrer, and shows only token-free server scope/expiry/status. Local disconnect explicitly does **not** claim provider-side revocation. Staff retain only their approved catalog/report permissions.
- Production callbacks require a fixed HTTPS APP_ORIGIN. The HTTP 127.0.0.1 callback exception is guarded by the same strict disposable test dependency-injection boundary; any deployment marker rejects it. It exists only for the isolated browser fixture, never as an HTTP production fallback.

## Evidence

Evidence directory `/workspace/dinar-connect-evidence/`:

- `oauth-red.log`: OAuth-specific configuration absent before implementation; existing 17 cases passed.
- `oauth-green1.log`: 18 integrated Connect cases passed, including owner-only one-use state, PKCE verifier/challenge, encrypted tokens, authenticated GET, refresh and truthful local disconnect.
- `oauth-green2.log`: expanded vault failure, extra-scope rejection, state expiry/replay and safe status cases passed, plus unchanged model authority 6.
- `oauth-regression-final.log`: Connect 18, catalog adapter 4, network 4, unchanged authority 6 and financial state machine 23 passed; outbound attempts zero. Includes controlled disconnect-during-read rejection with no late inserted offer, provider denial and audit-secret exclusions.
- `oauth-pg16.log`: Connect 18, adapter 4, network 4 and authority 6 repeated successfully on disposable PostgreSQL 16. Also explicitly rejects the HTTP loopback callback exception with a deployment marker. Primary acceptance used PostgreSQL 18.
- `oauth-browser2.log`: actual Chromium owner review → isolated HTTPS provider consent → authenticated callback → server-verified portal status → authenticated catalog DB import → refresh → local disconnect. Null popup opener, no browser-visible tokens, page/console errors or unapproved external requests. Earlier mobile/RTL, staff, agreement, referral, withdrawal, draft, basket and site lifecycle assertions still pass. Browser child environment excludes the synthetic vault key. Screenshots and result JSON retained in `browser-oauth/` and `oauth-browser-result.json`.
- `oauth-browser1.log` initially failed because the synthetic provider HTML omitted UTF-8 and its Arabic consent label decoded incorrectly. The fixture now declares UTF-8; the same Arabic accessible-label assertion passes. No application authorization assertion was weakened.
- `oauth-codegen.log`, `oauth-typecheck-final.log`, `oauth-api-build.log`, `oauth-web-build.log`: regenerated contracts, workspace typecheck and both builds passed. The existing frontend large-chunk warning remains.

## Limits and remaining engineering

This is a documented public-client catalog protocol, not universal confidential-client or provider-specific interoperability. The provider must support exact catalog.read, public-client PKCE and the reviewed same-host endpoint contract; other protocols require reviewed adapters. Provider-side revocation is not claimed by local disconnect. No billing, purchase, domain registration or financial execution scope exists.

Authorized live/sandbox provider credentials and approved pinned egress are absent; real-provider acceptance remains BLOCKED. Original Conversation V2 commit/task/bundle recovery remains BLOCKED without recreating identities. Continue reviewed read-only MCP, website indexing, administrative agreement/finance completion, diagnostics, performance and comprehensive project acceptance. Do not label the whole project launch-ready from this milestone.
