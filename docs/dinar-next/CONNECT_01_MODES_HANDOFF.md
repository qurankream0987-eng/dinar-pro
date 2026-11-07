# DINAR Connect — Command 01: three merchant participation modes

**Branch:** `claude/connect-01-modes` (new, Claude-owned, isolated worktree `/home/user/dinar-connect`).
- Base: `ab196c5` (head of `codex/dinar-next-unified-development` at start).
- The Codex branch was not modified, nothing was merged into `main`, nothing was deployed, and no paid service was used.
- Final SHA: the commit that adds this file (see `git log`).

## Baseline audit

| Item | State at `ab196c5` |
|---|---|
| Migration chain | 60 SQL migrations, head `0059_connect_readonly_team` (same on Codex and Claude intelligence branches; `main` at 0039) |
| Connect source | `artifacts/api-server/src/connect/*` (21 modules, ~5.6k lines): partners, sites (DNS ownership), integrations, agreements, referrals, outbound, finance, team (D4 read-only staff) |
| Partner model | `connect_partners(status DRAFT/PENDING_REVIEW/APPROVED/REJECTED/SUSPENDED/REVOKED, revision)`; **no participation concept** |
| Commerce | external referral only; catalog imports create **0** internal listings (`internalListingsCreated: 0`) |
| Onboarding UI | `artifacts/dinar/src/pages/Connect.tsx` (Arabic RTL portal) |
| Identity | reuses D2 business profiles + verification; ownership via `connectAccess` (owner, or version-bound D4 staff for reads) |

**Reused, not rebuilt:**
- business profiles and verification;
- `connectAccess` and `connectAudit`;
- the partner review, sites, integrations and agreements;
- `discoverConnectCatalog`, `approvedConnectOffer` and the outbound route;
- the portal page.

No second onboarding flow or commerce runtime was added.

## What was built

| Mode | Arabic | What it records | What it can enable (server-derived) |
|---|---|---|---|
| `SELL_INSIDE_DINAR` | بيع منتجات موقعي داخل دينار | selling through DINAR's own listings / orders / checkout (simulation) | `internalSale` once the partner is APPROVED and the business VERIFIED; external offers are **not** served |
| `BUY_ON_MERCHANT_WEBSITE` | عرض منتجاتي في دينار والشراء من موقعي | the existing referral model (default) | `externalPurchase` once APPROVED + VERIFIED + verified site + approved `EXTERNAL_REFERRAL` integration |
| `HYBRID` | البيع داخل دينار ومن موقعي معًا | both | each part independently, under its own requirements |

`nativeCatalogCheckout` (turning website catalog items into DINAR checkout) is **always disabled**: that capability does not exist yet. Selecting a mode never enables it, and the UI says so.

## Files

**Schema and migration:**
- `lib/db/drizzle/0060_connect_participation_mode.sql`: additive.
  - `participation_mode text NOT NULL DEFAULT 'BUY_ON_MERCHANT_WEBSITE'` with a CHECK over the 3 values;
  - `participation_mode_changed_at timestamptz`.
- Registered in:
  - `drizzle/meta/_journal.json`;
  - `drizzle/release-manifest.json` (sha256 `5691852f…0a0d8`);
  - `lib/db/src/clone-migration-guard.ts`;
  - the head tag in `test/development-tls.test.ts` and `test/readiness.test.ts`.
- `lib/db/src/schema/connect.ts`: columns + check.

**Contracts and API:**
- `lib/api-zod/src/connect-platform.ts`:
  - `CONNECT_PARTICIPATION_MODES` and the Arabic labels;
  - the external / internal mode sets;
  - `ConnectPartnerInput.participationMode` (optional);
  - `ConnectParticipationModeInput {mode, expectedRevision}` (strict).
- `lib/api-spec/openapi.yaml` + `scripts/sync-connect-schema.ts`: new `POST /connect/partners/{id}/participation-mode`, generated input schemas; clients regenerated.

**Server:**
- `artifacts/api-server/src/connect/partners.ts`:
  - `connectParticipationCapabilities`;
  - `partnerView` (mode, changedAt, capabilities with Arabic requirements);
  - registration stores the mode;
  - `changeConnectParticipationMode`: owner-only lock, expected revision, refused when SUSPENDED / REVOKED / REJECTED, audited `PARTICIPATION_MODE_CHANGED`, revision bump, nothing deleted.
  - **Enforcement:** discovery serves only partners whose mode includes buying on their own website; `approvedConnectOffer` re-checks the mode at click / referral time, so old cards close too.
- `artifacts/api-server/src/routes/connect.ts`: the route.

**Web:** `artifacts/dinar/src/pages/Connect.tsx`:
- a radio fieldset of the three modes with explanations at registration;
- an owner panel with the current mode, the three capability lines (enabled / not yet / not included, with requirements) and the change form;
- suspended accounts see a refusal note.

**Tests:**
- `artifacts/api-server/test/connect-partners.test.ts`: two new tests plus agreement DTO assertions;
- `test/connect-modes-browser-journey.test.ts` + `artifacts/dinar/test/connect-modes-ui.mjs`.

## Test results

Disposable loopback PostgreSQL 16; outbound = 0 everywhere.

| Requirement | Evidence | Result |
|---|---|---|
| Onboarding in all three modes | registration stores `SELL_INSIDE_DINAR` (API), browser registers SELL then switches to HYBRID; existing partner moves BUY → SELL → HYBRID | PASS |
| Unauthorized mode changes | stranger 404, unknown partner 404, other business registering it 404, bad mode 400, extra field 400, stale revision 409 | PASS |
| Suspended merchant | change refused 409, mode unchanged, external purchase disabled | PASS (see note) |
| Existing partner compatibility | partner created without a mode reads `BUY_ON_MERCHANT_WEBSITE` with external purchase enabled; all Connect suites unchanged and green | PASS |
| Persistence after reload | API re-read and browser reload (SELL, then HYBRID); DB value checked | PASS |
| Server-side gating | SELL removes the partner's card from discovery; HYBRID restores it; offers / agreements / orders / ledger counts unchanged; audit event recorded | PASS |
| Native checkout never enabled by mode | `nativeCatalogCheckout.enabled=false` in every mode (API + browser) | PASS |
| Migration safety | fresh migrate in every suite; **upgrade test:** DB at 0059 with an existing APPROVED partner → 0060 keeps it, adds `BUY_ON_MERCHANT_WEBSITE`, status / revision unchanged; the DB refuses an invalid mode; throwaway DB dropped | PASS |
| RTL and mobile UI | Chromium: RTL, no overflow, named buttons ≥ 32 px at 320 / 390 / 1280; keyboard selection; 0 console / page errors, 0 external requests | PASS |
| Agreement DTO correctness | canonical view: `terms.commission`, `accepted`, `acceptance.acceptedAt`; no top-level `status` / `commissionRateBasisPoints` / `rateBasisPoints` / `acceptedAt` | PASS |

**Suites run green on the final tree:**

| Suite | Tests |
|---|---|
| connect-partners | 24 |
| connect-modes-browser-journey | 1 |
| connect-agreement-draft | 4 |
| connect-card-contract | 4 |
| connect-card-presentation | 4 |
| connect-cards-browser-journey | 2 |
| connect-catalog-pull | 4 |
| connect-commission-math | 4 |
| connect-domain | 6 |
| connect-finance-browser-journey | 1 |
| connect-mcp-catalog | 6 |
| connect-network | 4 |
| connect-performance | 1 |
| connect-sync-observations | 3 |
| connect-website-catalog | 6 |
| readiness | 15 |
| development-tls | 7 |
| fresh-environment | 9 |
| admin-bootstrap | 5 |
| command-d-acceptance | 6 |
| same-origin-web | 14 |
| business-delegations | 4 |
| d1-d2-business-foundation | 25 |
| integration-business-listings | 4 |
| d16-readiness | 4 |

Typecheck (libs, api-server, web) is clean.

**Failures during the work** (all fixed or explained):
1. My first mode test ran while the previous test had **suspended** the partner's integration, so external purchase was rightly disabled. The capability was correct; the test was moved to after the integration is resumed.
2. Local PostgreSQL stopped twice between runs (environment) and was restarted; the runs were repeated.

## Notes and findings

- **No API path suspends an APPROVED partner.** Partner review accepts SUSPEND only from PENDING_REVIEW / SUSPENDED, and integrations have their own suspend. The suspended-merchant test therefore sets the partner status as a labelled DB fixture and exercises the mode endpoint over HTTP. **Owner / product decision needed:** whether admins should be able to suspend an approved partner.
- **`internalSale` routes to DINAR's existing listings flow.** It does not import the merchant's website catalog. Catalog import into native checkout (and its review) is future work and would need its own command.
- **Not run:**
  - `lib/db test:release-migration` (needs PostgreSQL 18; only 16 is local);
  - the G33 Docker CI (Actions only).

## Integration with Codex

- Built directly on Codex's head, so text conflicts are limited to files Codex changes afterwards.
- **Migration numbering:** if Codex adds its own `0060_*` before integration, renumber this one at integration time and recompute the manifest sha256 / guard entry / head-tag tests.
- It is independent of Claude's intelligence branch (PR #6), which does not change these Connect files. Claude's AI read `readConnectPartnerStatus` there should add `participationMode` + `participation` to its output once both are joined.
