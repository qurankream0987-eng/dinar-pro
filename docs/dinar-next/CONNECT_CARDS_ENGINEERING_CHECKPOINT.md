# Universal cards and Connect onboarding checkpoint

This checkpoint implements the owner's universal interactive card request in the integrated application. It also delivers the first onboarding/catalog milestone of the larger DINAR Connect mission. It is **not** acceptance of the full Connect commission/connector platform or of every feature in the comprehensive project mission.

## Preserved baseline

Worktree `/workspace/dinar-next-unified`, local branch `codex/dinar-next-unified-development`, based on the verified Replit candidate `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a`. Authenticated remote reads still resolve the unified branch and PR #5 head to that SHA; main remains `b1b20e513ed25952bc086778fb71af88adcc54ba`. The original checkout `/workspace/dinar-pro` remains clean on its existing `work` branch at the main SHA. No remote refs were changed.

All original 57 SQL files and the original 57 manifest entries are byte-identical to the candidate. Appended `0057_dinar_connect` makes **58** migrations. Its SHA-256 is `4376a15434f865f4faf4a751df90f8a2de8dd5d1fe0d0e9b98c0ccbc637dcebd`; current manifest SHA-256 is `0a6c2f0030b84925c1099d845e05a909c6a83e7da42e68114f42f2c8f8a46cf4`. The release manifest, journal, clone guard and readiness checks agree. No old migration was replaced or renumbered.

Original Codex V2 history remains **PRESERVATION BLOCKED**, not declared lost: expected HEAD `719d4715a869f69831049a6a2f6c349cec934344`, tested source `442008a5fdcb9dc6529a55364cd66e033c6a0909`, expected artifact `codex-conversation-v2-authorized.bundle`. The previous task workspace/bundle is unavailable here; the exact objects were not recoverable from the checked sources. New local implementation commits do not recreate or impersonate those identities.

## Implemented paths and boundaries

- `lib/api-zod/src/connect.ts`: strict, typed universal presentation for internal products/services, external products/services, domain registration, comparison, order/transaction status and extensible capabilities. Unknown attributes remain null. Internal identities cannot masquerade as referrals; domains must match the typed authoritative registrar result. These are presentation schemas, not a new action engine. Existing canonical internal product, service, comparison and order cards retain their existing renderers and backend actions.
- `src/connect/conversation.ts` and the existing conversation runtime: domain intent and explicit partner-catalog search return `CONNECT_RESULTS`. Existing result-set persistence, history, Card Envelope and surface composition are reused. No second conversation/cart/pending-action runtime.
- `src/connect/domains.ts`: IDNA normalization, strict domain validation, bounded suggestions, provider adapter, explicit unknown/unavailable/premium states, registration/renewal money, currency, source time, timeout/rate-limit handling. No registration or purchase operation exists.
- `src/connect/provider-registry.ts`: trusted registrar registry and HTTPS destination templates. The card/model/browser sends identities, never a purchase URL. Built-in provider actions use **Search on provider** because a documented public domain-specific checkout URL is unavailable.
- `src/routes/connect.ts`: owned, expiring, same-origin navigation capabilities; current market/legal/ownership/integration checks on preparation and opening. No arbitrary redirect query parameters. HTTPS, no-referrer, no opener; click receipts explicitly say no internal order was created. Tracking is currently always disabled.
- `src/connect/partners.ts`: free registration on the canonical D2 business identity; expiring DNS TXT ownership evidence; independent admin approval; revision checks; approved site/path/capability registry; authenticated catalog ingestion with batch idempotency and source versions; external-only offer records; credential rotation, suspension and revocation. Internal marketplace provider keys and Connect keys have separate namespaces and DB scope constraints. Existing canonical provider credential hashing/auditing is reused.
- `src/connect/network.ts`: public DNS validation of every returned address, HTTPS only, no redirects, deadlines/byte limits, DNS pinning for generic connector transport, dedicated AES-GCM secret vault helper. The managed host-only egress proxy cannot guarantee DNS pinning, so generic outbound pulls fail closed with `PINNED_EGRESS_REQUIRED`; pushed catalogs work. Vault helpers have no configured key and no active OAuth integration.
- `/connect`: lazy-loaded responsive Arabic partner portal, using existing D2 profiles; free registration, DNS proof, review request, simulation-only API catalog registration, one-time credential display and revocation. `/admin/connect`: independent review queue and revision-bound decisions. `CHAT_ONLY_MODE` stays true; these explicit partner workflows are allowlisted, linked from settings.
- `0057_dinar_connect`: external partner/catalog/agreement/referral/commission schema and append-only/financial reconciliation guards. Agreement/referral/event/ledger tables are foundational only at this checkpoint: financial APIs and acceptance journeys are not yet implemented. No commission is accrued or settled by this milestone.
- OpenAPI inputs are generated from authored validators by `sync-connect-schema.ts`; generated clients/Zod files are regenerated, not manually edited. Admin response views currently use the repository's `ServerValidatedObject` response convention; refining these into dedicated response types remains work.

## Provider investigation

Cloudflare's official `cloudflare/api-schemas` OpenAPI documents `GET /accounts/{account}/registrar-sandbox/domain-search` (advisory) and **read-only** `POST /accounts/{account}/registrar-sandbox/domain-check` (authoritative checks). The adapter uses these exact methods and rechecks suggestions. It does not implement create/register/transfer/billing. Runtime configuration accepts only explicitly enabled sandbox discovery with a dedicated token and account ID. No unrelated service credentials are borrowed.

Spaceship official documentation was blocked by the environment's destination policy. No API method or domain-specific checkout URL was guessed. Its unconfigured card links to `https://www.spaceship.com/domains/`, with unknown price/availability. Cloudflare fallback is `https://dash.cloudflare.com/`; DINAR's API account is not assumed to be the end user's registrar account.

**LIVE_PROVIDER_ACCEPTANCE BLOCKED:** no authorized provider sandbox credentials are configured. Official protocol fixtures test the real adapter implementation deterministically; they do not prove live provider integration. The browser's public-site landing page is an explicit isolated HTTPS navigation fixture, not a live provider checkout or API result.

## Verified evidence for this source checkpoint

Raw logs, schema verification and browser screenshots: `/workspace/dinar-connect-evidence/`.

| Check | Successful cases | Evidence |
|---|---:|---|
| Card contract, domain adapter, network, partner API, domain/browser, unchanged AI authority | 25 | `cards-final.log`, corrected partner rerun `partners-final3.log` |
| Same card/domain/network/partner suites on fresh PostgreSQL 16 | 17 | `pg16-final.log` |
| PostgreSQL 18 release migration, upgrade/recovery/tamper/concurrency | 12 | `release58-final.log` |
| Existing surface composition, envelope, lifecycle, cart receipts, history rendering | 35 | `surfaces-final.log` |
| Existing financial state machine | 23 | `safeguards-final.log` |
| Existing W07 financial journal | 10 | `safeguards-final.log` |
| Existing internal provider boundary and secret log scan | 39 | `safeguards-final2.log` |
| D16 legal/readiness, including browser | 4 | `safeguards-final3.log` |
| D17 conversation memory | 50 | `safeguards-final3.log` |
| Actual internal four-product comparison/cart/photo/IME/reduced-motion browser | 1 | `safeguards-final3.log` |

These are 216 successful case executions (199 distinct cases, with 17 repeated on PostgreSQL 16), **not a full-project battery claim**. Every isolated API suite reports zero outbound attempts. Workspace typecheck, API build and web build pass. Web build retains a large main-chunk warning (about 913 kB minified / 270 kB gzip); no claim of a completed bundle optimization.

Browser evidence covers 320/390/1280 widths, keyboard external navigation, null opener, retained draft/history, no internal cart flight for referrals, real free partner registration, and no JS/console errors. Screenshots: `browser/domain-{320,390,1280}.png` and `browser/portal-{320,390,1280}.png`. The internal browser separately proves that an owned product image flies only after the canonical cart success receipt, reduced motion suppresses the flight, and a forged/rejected action creates neither a flight nor a cart row.

Retries are retained, not counted as success: initial partner routes were absent; the synthetic owner initially lacked the existing phone-verification prerequisite; registration initially returned an incomplete view; category code initially used the wrong existing field (`enabled` instead of `isActive`). The partner conversation test first failed because the read route was absent. A stricter card-kind test failed before validator hardening. A new admin test initially expected 404, but existing global admin middleware correctly returns 403; corrected to an exact 403 without changing authorization. An ineffective text replacement caused one redundant rerun, also retained. First regression runner omitted provider-only `BDINAR_LOG_SCAN=1`, omitted Chromium, and named a nonexistent surface suite; the corrected run accidentally propagated provider log-sentinel scanning to unrelated suites, whose assertions passed but wrapper failed. Reran those suites without that provider-only option; all passed. Codegen initially hit sandbox IPC `EPERM`; rerunning with the approved local process permission succeeded. No assertions were loosened into status ranges or skipped. Older battery attempts interrupted in earlier phases are not current acceptance evidence.

## Remaining engineering / external blockers

The universal card/domain referral milestone is working, with live-provider acceptance blocked as stated. The larger Connect platform is not complete: accepted agreement workflows, opt-in attribution/withdrawal, authenticated conversion events, commission projection and simulated settlement/reversal/dispute APIs, finance/partner dashboards, full OAuth/PKCE and MCP/read connector implementations, consent/export integration, ingestion concurrency/performance tests and complete commission lifecycle/browser journeys remain. Do not advertise these foundational tables or configuration kinds as active integrations.

Continue from the state/financial review in `CONNECT_DESIGN_REVIEW.md`, preserving explicit versioned commercial choices and internal/external financial separation. Generic connector pulls require approved pinned egress; Spaceship requires accessible official documentation and authorized test access. Real commissions, FX conversion, paid/live integrations, legal agreements/country decisions, publication, merge and deployment require separate external inputs or owner approval. No live financial receipt may be inferred from a simulation or a partner-reported settlement claim.

Authenticated Git read is confirmed. Write/publication authorization is unproven; no push (including dry-run) was attempted. No remote migrations, production access, merge, deploy or paid/live activation occurred. Preserve this checkpoint locally and continue the larger mission without publishing.
