# DINAR Connect engineering scope and state review — 2026-11-05

Owner approved free company registration, basic connection, organic eligible discovery and basic referrals. External commissions require a separately accepted, versioned agreement; internal marketplace policy stays unchanged. No automatic domain registration, payment, production credential use or live activation.

Reuse: existing conversation runtime, tool registry, Card Envelope, composed surface renderer, business identity/delegation, provider credential hashing/rotation/scope checks, rate limiter and audit patterns. External catalog items never become `offers`, internal cart items, orders, seller dues or marketplace financial events.

Proposed internal commission state review (reviewed here against the owner’s supplied invariants before implementation):

| Current state | Admissible evidence / next state | Forbidden shortcut |
| --- | --- | --- |
| PENDING_VERIFICATION | authoritative authenticated conversion + valid consented attribution + accepted effective agreement → VERIFIED | a link click or browser callback cannot earn money |
| VERIFIED | authenticated commission approval matching calculated snapshotted amount/currency → APPROVED | no partner-supplied arbitrary recalculation |
| APPROVED | explicit finance review and contractual due date reached → PAYABLE | approval is not receipt of funds |
| PAYABLE | authenticated settlement evidence, verified reference and finance reconciliation → SETTLED | clicking an admin button cannot claim money received without evidence |
| VERIFIED/APPROVED/PAYABLE | authenticated cancellation/refund/chargeback → append-only adjustment; full reversal → REVERSED | no overwriting accrued history; partial refunds cap cumulative reversal at original eligible base |
| Any verified non-reversed state | dispute evidence → DISPUTED; resolution returns only to supported prior state or REVERSED | no dispute self-approval or contradictory settlement |
| SETTLED | later refund/chargeback records a separate recovery obligation / reversal event | never erase actual settlement evidence |

Amounts remain integer minor units, currency-specific, no implicit FX. Percentage commission uses accepted agreement rounding rules and net eligible base. Fixed commission is earned once; partial refunds follow the explicitly accepted agreement policy. Excluded products/categories earn zero. Out-of-order provider events are retained pending predecessors or refused for reconciliation, never speculatively accrued. Identical event IDs/body hashes are idempotent; reused IDs with a different hash are conflicts. All accounting/evidence events append-only; state summaries are projections.

Unspecified commercial choices are fields of a proposed agreement and require explicit partner acceptance; no default external 10% rate, return period, attribution window or exchange rate is invented. Settlement mode in acceptance is explicitly SIMULATION_ONLY; real receipts remain unverified until authorized integration/evidence exists. EXTERNAL_AUTHORIZED_ACTION is default-denied until an individually reviewed capability is approved; connecting a website grants discovery/referral only.

Cloudflare official schema reviewed: `cloudflare/api-schemas` main `openapi.yaml`, retrieved through the configured proxy. `registrar[-sandbox]/domain-search` is advisory; `POST .../domain-check` is documented read-only and authoritative. Only those operations are eligible for the domain adapter. Domain creation/registration/transfer/billing operations are excluded. Spaceship official docs are presently blocked by the environment’s network policy; do not invent endpoint methods or purchase links.

## Read-only OAuth extension review — 2026-11-05, before implementation

Reuse existing approved integrations, dedicated AES-GCM vault, one-use OAuth state table, ConnectNetwork and catalog importer. Google identity verification is a login boundary, not an external catalog authorization grant; it must not be repurposed.

Initial interoperability scope: OAuth 2 authorization-code **public clients with PKCE S256**, fixed `catalog.read` scope, independently approved authorization/token/catalog endpoints on the same verified partner hostname. No dynamic discovery, confidential-client secrets, model tools, transactional scopes or provider URL overrides. Explicit owner commands only, SIMULATION_ONLY for this phase. `APP_ORIGIN` supplies the fixed HTTPS callback; caller Host/return URLs never select it. Missing dedicated vault/origin fails closed.

State is random, hashed in storage, owner/integration/revision-bound, expiring and consumed under lock before exchange. The encrypted verifier binds the approved source and callback. Provider network work holds no database lock; ownership, revision and revocation are rechecked before encrypted token storage/import. Access/refresh tokens never enter browser responses, logs, model context or privacy exports. Refresh is serialized by consuming the old encrypted grant before egress; failure requires explicit reauthorization rather than reusing a potentially rotated refresh token. Website/integration revocation retires local OAuth material and states. Local disconnect does not claim remote provider revocation; provider account revocation remains an explicit provider action unless a separately reviewed revocation adapter exists.

Only token exchange/refresh may POST; catalog reads remain GET. Token scopes/type/expiry are validated; extra scopes are rejected. No billing, purchase, registration or financial execution is permitted. Live OAuth acceptance remains unverified without separately authorized sandbox credentials and approved pinned egress.

## Reviewed MCP catalog adapter — before implementation

Reuse the existing approved Connect integration, owner-only catalog-sync command, transport, optional read-only OAuth grant and catalog importer. Do not register provider tools/prompts with the DINAR model or introduce a general action executor. The initial reviewed protocol is MCP Streamable HTTP with JSON responses, protocol 2025-06-18, and one fixed `catalog.read_snapshot` operation taking the canonical empty-object input schema and returning the existing structured ConnectCatalogBatch. This is a versioned read-only interoperability contract, not arbitrary MCP execution.

Independent integration approval binds the exact endpoint, revision, CATALOG_READ capability, tool name and canonical input-schema hash. Runtime verifies the advertised tool/schema/read-only annotations and ignores other tools, server instructions and text content. A provider's hint alone is never authorization. Only validated structured catalog output enters the existing importer. Billing, booking, purchase, registration and other write capabilities are absent.

Initialize/list/call use fixed server-selected JSON-RPC methods/arguments and the same approved host; MCP cannot select URLs, arbitrary headers or model authority. Session metadata remains bounded and local to the pull. Provider failures/redirects/rate limits/timeouts remain sanitized. Import rechecks current approval/revocation and any OAuth grant after network work. Initial JSON transport limitations must be reported honestly rather than inventing SSE/provider interoperability.

Official MCP review confirmed the transport requires both JSON and SSE POST responses. The adapter now supports bounded completed SSE replies, validates required serverInfo/content envelopes and attempts the documented same-endpoint DELETE for session cleanup (405 is permitted). It never executes server-initiated requests and advertises no sampling/prompt capabilities. Persistent subscriptions/resumption remain outside this single-snapshot adapter. Official source hashes are recorded in the MCP checkpoint; no external source code was copied into the application.
