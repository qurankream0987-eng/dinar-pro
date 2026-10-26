# DINAR NEXT — 00 Baseline

Command 00 (source audit, baseline, safety, execution preparation). Audit date: 2026-10-19.
Companion: [`IMPLEMENTATION_LEDGER.md`](./IMPLEMENTATION_LEDGER.md).

## 1. Project identity

| Item | Value |
|---|---|
| Repository root | `/home/runner/workspace` |
| Branch | `main` |
| Baseline HEAD | `f60e30d73c55df490b0eafd979a997e7f47f0ece` ("Update Replit configuration settings") |
| Commits on `main` | 391 |
| Package manager | pnpm 10.26.1 workspaces (`pnpm-workspace.yaml`: `artifacts/*`, `lib/*`, `lib/integrations/*`, `scripts`), Node 24.13.0, TypeScript ~5.9.3 |
| Remotes | `origin` = placeholder `https://github.com/USERNAME/REPOSITORY.git` (nothing pushed from here); `gitsafe-backup` (Replit internal mirror, at `f60e30d`); several `subrepl-*` Replit remotes |
| Other worktrees | `/home/runner/dinar-v3` (`codex/monetization-v3-continuation`), `/tmp/dinar-frontend-wave` (`codex/frontend-personal-experience`) — both marked prunable; untouched |

Working tree at audit start (preserved, unchanged at audit end):

- `M .replit` — adds `[[ports]]` 8080 and 8081.
- `M artifacts/mockup-sandbox/src/.generated/mockup-components.ts` — generated import order only.
- No untracked files (other than the `docs/dinar-next/` created by this command).

### Packages

| Path | Package | Role |
|---|---|---|
| `artifacts/dinar` | `@workspace/dinar` | Vite + React 19 frontend (Arabic RTL) |
| `artifacts/api-server` | `@workspace/api-server` | Express 5 API, conversation runtime, commerce services |
| `artifacts/mockup-sandbox` | `@workspace/mockup-sandbox` | Design mockups (not product runtime) |
| `lib/db` | `@workspace/db` | Drizzle schema (`src/schema/index.ts`, `src/schema/r5-delivery.ts`), 35 SQL migrations `drizzle/0000…0034` |
| `lib/api-spec` | `@workspace/api-spec` | `openapi.yaml` (81 paths) + Orval config |
| `lib/api-zod` | `@workspace/api-zod` | Generated Zod + hand-written contracts (`conversation-runtime.ts`, `marketplace-schemas.ts`) |
| `lib/api-client-react` | `@workspace/api-client-react` | Generated React Query client |
| `lib/global` | `@workspace/global` | Countries / currencies data |
| `lib/integrations-openai-ai-server` | — | OpenAI SDK wrapper |

## 2. Safe development checkpoint

Created without touching the working tree, index, or any branch:

| Artifact | Purpose |
|---|---|
| Tag `dinar-next-baseline-20261019` → `f60e30d` | Baseline HEAD |
| Ref `refs/dinar-next/checkpoint-00-worktree` → `8944369` | `git stash create` snapshot of the two uncommitted modifications (stash not applied, worktree unchanged) |
| `checkpoints/dinar-next-00/worktree.patch` (git-ignored dir) | Plain patch of the same diff |

Restore uncommitted state if ever lost: `git stash apply refs/dinar-next/checkpoint-00-worktree`
(or `git apply checkpoints/dinar-next-00/worktree.patch`).

Note: the tag and the snapshot ref both contain the leaked token described in §7 S-1, because the token is
in HEAD itself. They are local only.

## 3. Architecture map

### Frontend entrypoints
- `artifacts/dinar/src/main.tsx` → `App.tsx`. `CHAT_ONLY_MODE = true` (`App.tsx:62`): public routes are
  `/`, `/ai` (both `pages/Ai.tsx`), `/orders`, `/policies*`, `/terms`, and admin routes; every other path
  redirects to `/`. Standalone marketplace pages (`/search`, `/cart`, `/checkout`, `/seller/*`, …) remain in
  source but are unreachable.
- Conversation UI: `pages/Ai.tsx`, `features/ai/ConversationContent.tsx` (typed surface rendering),
  `ChatComposer.tsx`, `ConversationSidebar.tsx`, `ConversationHistory.tsx` (list/open/delete),
  `ai-api.ts` (SSE client), `conversation-storage.ts` (guest local transcript + handoff).
- Typed surfaces: `BuyerPanels`, `SellerListingsSurface`, `SellerDraftHelper/Insight`, `DeliverySurface`,
  `DriverPanel`, `CourierEconomicsSurfaces`, `PromotionSurface`, `CommercialSurface`, `EmploymentSurface`,
  `OrderTrackingSurface`, `ProviderPanel`, `SmartSurfaces`, `TutorialVideoCard`, `MemorySummary`.

### Conversation endpoints (`artifacts/api-server/src/routes/ai.ts`)
- `POST /ai/preview` (guest; IP rate-limited via `consumeRateLimit`, `ai.ts:707`)
- `POST /ai/conversations`, `GET /ai/conversations`, `GET /ai/conversations/:id`, `DELETE /ai/conversations/:id`
- `POST /ai/conversations/guest-handoff`
- `POST /ai/conversations/:id/turns` (SSE; idempotent by `clientMessageId`, atomic retry claim; `ai.ts:1641`)
- Action endpoints: `/ai/promotion-actions/:id/action`, `/ai/employment-actions/:id/action`, plus draft /
  listing / delivery / commerce actions (`ai.ts:1478`, `1573`)
- `GET/POST /ai/learning-history`, `GET /ai/vision-capability`

### Runtime orchestration flow
`routes/ai.ts` turn handler → `ai/conversation-runtime.ts` `executeAiConversationTurn`:
1. Strip leading acknowledgement; resolve action id (`resolveConversationActionId` in
   `lib/api-zod/src/conversation-runtime.ts`, plus `intent.ts` / `marketplace-intent.ts` hints).
2. `ai/conversation-router.ts` `resolveConversationRoute` → `AUTH_REQUIRED` / `MARKET_REQUIRED` /
   `PROVIDER_REQUIRED` gates from the action + capability registries.
3. Ordered deterministic handlers: photo suggestions → employment → personal memory → order contact →
   negotiation → buyer/purchase → cart → draft actions → seller listing management → delivery/driver →
   promotion → commerce → provider → smart turn (`smart-turn.ts` `executeSmartTurn`) → search.
4. Model fallback last: `smart-turn.ts` `executeModelFallback` → `model-turn.ts` `interpretWithModel` →
   `model-gateway.ts` `proposeThroughGateway`. Model output is a structured, allowlisted suggestion that is
   re-entered through the same deterministic review a typed command opens; it never executes directly.

### Provider boundary
- `ai/model-gateway.ts`: providers `GROQ` (default, `openai/gpt-oss-120b`, overridable by `DINAR_AI_MODEL`),
  `OPENROUTER` (`openrouter/free`), `OPENAI`; OpenAI-compatible chat completions with
  `tool_choice: "required"`, 25 s timeout, no retries, no automatic provider fallback.
- `ai/model-turn.ts` `modelGatewayFor`: returns a gateway only if `DINAR_AI_MODEL_FALLBACK === "true"` and
  the deployment environment matches the single registration (`environments: ["development"]`).
- `lib/market-capability-registry.ts` `resolveMarketProvider` + `lib/provider-boundaries.ts`: per-market
  provider policy.
- Vision: `resolveDevelopmentVisionProviderConfiguration` (development only, Groq `qwen/qwen3.8-27b`).
- Tests isolate providers: `test/run.mjs` forces `DINAR_AI_MODEL_FALLBACK=false`,
  `BDINAR_BLOCK_MODEL_CALLS=1` and deletes all provider keys.

### Canonical commercial services (`artifacts/api-server/src/lib/`)
Listings `marketplace-listings.ts`, `listing-management.ts`, `publication-policy.ts`; cart/checkout
`marketplace-cart.ts`, `commerce.ts` (`planCheckout`, `createOrdersFromPlan`, `createSellerDueForOrder`);
pricing `market-pricing.ts` (`PLATFORM_FEE_BASIS_POINTS = 1_000`, i.e. 10%); negotiation
`negotiations.ts`; delivery `delivery.ts`, `driver.ts`, `courier-economics.ts`, `courier-supply.ts`,
`order-tracking.ts`; promotions `promotions.ts`, `promotion-policy.ts`, `promotion-attribution.ts`,
`recommendations.ts`; analytics `market-pulse.ts`, `demand-*.ts`; business `business.ts`; payments
`payments/service.ts` (simulation); ledger `commercial-ledger.ts`; markets `markets.ts`.

### Typed surface registries
`lib/api-zod/src/conversation-runtime.ts`: `CONVERSATION_SURFACE_REGISTRY`,
`CONVERSATION_CAPABILITY_REGISTRY` (17 capabilities with availability), `CONVERSATION_ACTION_REGISTRY`
(≈40 actions with `authorization`, `marketRequired`, `routeKind`). Server tools:
`ai/tool-registry.ts` (`openSurface`, `addToCart`, `searchListings`, `getResource`,
`recommendListings`, `restoreResults`).

### Authorization boundaries
- Session cookie `bdinar_session` (httpOnly, SameSite=Lax, Secure in production) — `lib/auth.ts:109,176`.
- `requireAuth` (`lib/auth.ts:132`) on every conversation route except `/ai/preview`; conversation
  ownership via `ownedConversation`; admin routes behind `guard()` in the UI and server-side checks.
- Router decisions require authentication for all mutating actions (`authorization: "AUTHENTICATED"`).
- Market scope: `lib/markets.ts` `marketFor`, `isMarketAvailable`, `assertMarketPolicy`.

### Integration test infrastructure
- Runner `artifacts/api-server/test/run.mjs`: esbuild-bundles one suite, **refuses to start** unless
  `BDINAR_DISPOSABLE_ACCEPTANCE_DB=1` and the resolved DB is loopback with a name matching
  `dinar_(test|acceptance|waveN|migration)_*` and not containing prod/staging/canonical/legacy/development
  (`test/acceptance-database-guard.mjs`).
- Per-suite opt-in flags via `test/safe-development-database.ts` `requireSafeReplitDevelopmentDatabase`.
- Fixtures: `test/acceptance-fixtures.seed.ts` (markets/users/listings), `test/seed.ts` (development seed).
- Browser journeys: Playwright + `/repl/tools/bin/chromium`, scripts in `artifacts/dinar/test/*.mjs`, driven
  from API suites (e.g. `g3-ui.test.ts`, `block-c/d/f4/f5`, `wave3`).

## 4. Capability matrix

Legend: **WORKING** = existing and passing its executed tests at baseline.

| Capability | Status | Evidence |
|---|---|---|
| Conversation runtime, routing, auth/market gates | WORKING | `conversation-runtime.ts` `executeAiConversationTurn`; `conversation-router.ts`; `conversation-router.test` 7/7, `test:g2` 91/91, `test:gfinal` 22/22 |
| General-purpose AI conversation | PARTIAL | Only via model fallback, which is enabled only when `DINAR_AI_MODEL_FALLBACK=true` **and** env is development (`model-turn.ts` `modelGatewayFor`, registration `environments: ["development"]`). Otherwise replies "الدردشة الذكية غير متاحة" (`smart-turn.ts` `modelFailureMessage`). History limited to 6 msgs × 300 chars (`model-turn.ts` `contextMessage`). |
| AI model selection | WORKING (offline) | `model-gateway.ts` `resolveAIProviderConfiguration`; `ai-provider.test` 7/7; `test:g1` 39/39 |
| Model tool use | PARTIAL | One forced tool call per turn mapped onto allowlisted suggestions (`smart-turn.ts` `executeModelFallback`); `tool-registry.ts` `modelToolDefinitions`. No multi-step tool loop. |
| Live model quality / configured model id | UNVERIFIABLE | No provider call made at baseline (tests strip keys). `.replit` sets text model `qwen/qwen3.8-27b` on Groq — validity unverified. |
| Marketplace search | DEFECTIVE (routing) | Search itself works (`runBuyerSearch`, `searchMarketplaceListings`; `test:blockf2` 14/14, `test:api` 63/63). **But** bare-noun queries no longer route to search: F0-01 sent `مزهرية <runId>` and got the model-unavailable reply instead of 3 results (`block-f0-foundation.test.ts:138-140`). Explicit-intent gate `hasExplicitMarketplaceSearchIntent` added 2026-10-09/10 after the test (2026-10-07). Intended vs regression = owner decision. |
| Seller draft creation (text + photo) | WORKING | `listing-draft.ts` `listingDraft`; `test:blockf1` 14/14; `conversation.test` 27/27; vision `listing-photo-vision-provider` 5/5 (development-only) |
| Listing publication | WORKING | `draft-actions.ts` `publishDraft` (idempotent by action id); `test:blockf5` 29/29; `test:blockb` 5/5 |
| Publication image review | PARTIAL / UNVERIFIED | Capability `DEVELOPMENT_ONLY_SCHEMA_PENDING`; `listing-image-policy-review` 11/11; `listing-image-publication-acceptance` could not run (harness conflict, §5) |
| Listing management (price/pause/resume/archive) | WORKING | `seller-management.ts`, `listing-management.ts`; `test:blockf1`, `test:blockc` 50/50 |
| Negotiation & best-price requests | WORKING | `negotiation-turn.ts` `isBestPriceRequest`, `executeNegotiationTurn`; `lib/negotiations.ts`; `test:g2` 91/91, `test:blockf3` 17/17 |
| Buyer review, cart, orders | WORKING | `buyer-turn.ts` `executePurchaseTurn`; `commerce.ts`; `commerce.test` 20/20; `test:blockf3` 17/17; `test:phase2` 1/1 |
| Seller contact release | WORKING | `contact-release.ts`, `buyer-turn.ts` `executeOrderContactRequest`; `contact-browser-microclosure` 1/1; listing `contactPhone` is null unless order-bound (`marketplace-listings.ts:137`) |
| Delivery & courier workflows | WORKING | `delivery-turn.ts`, `driver-turn.ts`, `lib/delivery.ts`, `courier-economics.ts`; `test:blockf4` 48/48, `test:blockd` 28/28, `r5-delivery-economics` 3/3 |
| Live driver location / ETA | MISSING (by design) | `LIVE_DRIVER_LOCATION: PROVIDER_NOT_CONFIGURED`; ETA only from ephemeral provider snapshot (`order-tracking.ts:24,116`) |
| Advertising & promotion | WORKING (simulation) | `promotion-turn.ts`, `lib/promotions.ts` (`purchasePromotion`, `campaignAnalytics`); `promotions.test` 6/6, `test:blocke` 46/46 |
| Market Pulse / analytics | WORKING | `lib/market-pulse.ts` `marketPulse`; `commerce-turn.ts` `MARKET_PULSE`; `marketplace-intelligence.test` 20/20 |
| DINAR Business subscription | EXISTING (conflicts with "postponed") | `lib/business.ts` `subscribeBusiness` (simulation-only), reachable from conversation (`commerce-turn.ts:513,667`); gates `MARKET_PULSE_ADVANCED` (`routes/commercial.ts:193`) |
| Payments | SIMULATION ONLY (by decision) | `PAYMENTS: SIMULATION_ONLY`; `payments/service.ts`; `test:wave4` 1/1 |
| Authentication, guest, actor scope | WORKING | `lib/auth.ts`; guest preview + handoff (`guest-handoff.ts`); `test:security` 12/12, `test:api` 63/63, `phone-verification-development-bypass` 1/1 |
| Market & currency handling | WORKING | `lib/markets.ts`, `market-capability-registry.ts`, `lib/global`; `market-capability-registry` 6/6, `location-policy` 1/1 |
| Personal memory | WORKING | `personal-context-service.ts`; `personal-intelligence` 1/1 |
| Employment | WORKING | `employment-turn.ts`, `lib/employment.ts`; `employment.test` 12/12, `test:blockc` 50/50 |
| Typed conversation surfaces | WORKING | Registries in `lib/api-zod/src/conversation-runtime.ts`; `ConversationContent.tsx`; `test:g3` UI 6/6 |
| Sidebar & conversation frontend | WORKING (basic) | List/open/delete only (`ConversationHistory.tsx`); no rename/search. Main JS chunk 914 kB (build warning). |
| Fee policy text vs commission | WORKING | Policy renders 10% (`policies.ts:194`) = `PLATFORM_FEE_BASIS_POINTS 1_000`; `wave3` UI expectation of 15% is stale |

## 5. Test results

All DB-backed runs used **new disposable loopback PostgreSQL 16.10** clusters created in the session scratchpad
(`127.0.0.1:55432`, and `127.0.0.1:55479` for the one suite that hard-codes it). Every suite received a
fresh database cloned from a migrated template; managed `PG*`, `DATABASE_URL` and the Railway
`DINAR_DEV_DATABASE_URL` were stripped from the environment. No managed/shared database was contacted.

Template preparation: `drizzle-kit migrate` (35 migrations → 64 tables), then
`acceptance-fixtures.seed.ts` (MARKET/USER/PRODUCT/PHASE1 modules); a second template with `test/seed.ts`
for suites that need the development seed (phase2, pre-switch). One-run random seed passwords.

### Static checks

| Check | Result |
|---|---|
| `pnpm run typecheck` | PASS (libs + 4 projects) |
| `pnpm -r --if-present run build` | PASS (warning: `index` chunk 914 kB) |
| OpenAPI codegen drift (Orval run in a scratch copy, diffed against committed `generated/`) | PASS — no drift in `api-zod` or `api-client-react` |
| `pnpm audit` | 0 advisories (info/low/moderate/high/critical all 0) |

### Unit / core regression (no fixtures needed)

| Suite | Result |
|---|---|
| commerce | 20/20 |
| conversation | 27/27 |
| promotions | 6/6 |
| location-policy | 1/1 |
| marketplace-intelligence | 20/20 |
| employment | 12/12 |
| r5-delivery-economics | 3/3 |
| conversation-router | 7/7 |
| promotion-intent | 4/4 |
| ai-provider | 7/7 |
| market-capability-registry | 6/6 checks |
| database-url-selection | 5/5 |
| acceptance-database-guard (`node --test`) | 8/8 |
| **Subtotal** | **126/126** |

### DB-backed acceptance and browser suites

| Suite | Result | Notes |
|---|---|---|
| test:api | 63/63 | needs `BDINAR_TEST_DATABASE=development`, which the npm script omits |
| test:blockb | 5/5 | requires DB name `dinar_test_blockb_*` |
| test:blockf0 | **11/12** | F0-01 fails — search routing (see §4) |
| test:blockf1 | 14/14 | |
| test:blockf2 | 14/14 | |
| test:blockf3 | 17/17 | |
| test:blockf4 | 48/48 | includes browser journeys |
| test:blockf5 | 29/29 | |
| test:g1 | 39/39 | |
| test:g2 (+ promotion-intent, conversation-router) | 91/91 + 4/4 + 7/7 | |
| test:gfinal | 22/22 | |
| test:blocka | 1/1 | |
| test:blockc | 50/50 | |
| test:blockd | 28/28 | |
| test:blocke | 46/46 | |
| test:security | 12/12 | |
| test:wave3 | **9/11** | stale: expects public `contactPhone` (now order-bound) and 15% fee (now 10%) |
| test:wave4 | 1/1 | payments simulation |
| test:readiness | **10/11** | stale: hard-codes migration head `0027`; journal head is `0034` |
| test:phase1 | **0/1** | stale: "Unexpected required seller field: payment_methods" |
| test:phase2 (commission) | 1/1 | on dev-seeded clone; needs `BDINAR_PHASE2_ACCEPTANCE`, omitted by npm script |
| pre-switch | PASS (exit 0, script-style, no count) | on dev-seeded clone |
| nl-commerce-microclosure | 1/1 | |
| nl-commerce-followup-probes | 1/1 | |
| personal-intelligence | 1/1 | hard-codes port 55479 |
| listing-image-policy-review | 11/11 | |
| listing-photo-vision-provider | 5/5 | |
| phone-verification-development-bypass | 1/1 | |
| development-tls | 2/2, 1 skipped | live-TLS case skipped (needs live managed DB — correctly not run) |
| g3-ui (browser) | 6/6 | |
| contact-browser-microclosure (browser) | 1/1 | |
| **Subtotal** | **551 pass / 5 fail / 1 skip (557)** | |

**Totals: 683 test cases executed — 677 pass, 5 fail, 1 skipped**, plus pre-switch script PASS.

### Not executed

| Item | Reason |
|---|---|
| `listing-image-publication-acceptance.test.ts` | Harness conflict: hard-requires DB `dinar_image_review_test` on port 55438 with `DATABASE_URL` unset, but `run.mjs`' guard only allows `dinar_(test|acceptance|…)_*` names. Not bypassed. |
| `openrouter-live-smoke.ts` | Live provider call; out of scope for a baseline. |
| Frontend scripts in `artifacts/dinar/test/*.mjs` not driven by an API suite (e.g. `conversation-quality.mjs`, `visual.mjs`, `premium-ui-acceptance.mjs`) | Need a manually started UI/API stack; not wired into a runner. |
| Any test against the managed / Railway database | Forbidden by Command 00. |

### Failure classification

| Failure | Class |
|---|---|
| F0-01 bare-noun search | Behaviour change after test was written — **owner decision** (B-1) |
| wave3 `contactPhone` | Stale test (contact release is now order-bound, matching the approved design) |
| wave3 fee 15% | Stale test (commission is 10%, unchanged since 2026-09-26; must not be changed) |
| readiness head `0027` | Stale test (journal advanced to `0034`) |
| phase1 `payment_methods` | Stale test (field became required) |

## 6. Reproducing the baseline test environment

```sh
P=<scratch>/pg; initdb -D $P/data -U dinar_test --auth=trust -E UTF8 --locale=C.UTF-8
pg_ctl -D $P/data -o "-c listen_addresses=127.0.0.1 -c port=55432 -c unix_socket_directories=$P -c fsync=off" -l $P/server.log start
psql -h 127.0.0.1 -p 55432 -U dinar_test -d postgres -c "create database dinar_test_template00;"
# Always strip managed credentials:
E="env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE DATABASE_URL=$URL DINAR_DEV_DATABASE_URL=$URL BDINAR_DISPOSABLE_ACCEPTANCE_DB=1 BDINAR_DISPOSABLE_TEST_DATABASE=1 NODE_ENV=development"
(cd lib/db && $E pnpm run migrate)
(cd artifacts/api-server && $E BDINAR_ACCEPTANCE_FIXTURES=development BDINAR_SEED_PASSWORD=<random-12+> \
   BDINAR_ACCEPTANCE_FIXTURE_MODULES=MARKET_FIXTURES,USER_FIXTURES,PRODUCT_LISTINGS,PHASE1_LISTINGS \
   node test/run.mjs acceptance-fixtures.seed)
# then per suite: create database dinar_test_<suite>_b00 template dinar_test_template00; run with $E.
```

The baseline clusters were stopped at the end of Command 00 (scratch storage is session-scoped).

## 7. Security findings

| ID | Severity | Finding | Evidence | Action |
|---|---|---|---|---|
| S-1 | **CRITICAL** | A GitHub fine-grained personal access token is committed as a **key name** under `[userenv.shared]` in `.replit` | `.replit:35`, introduced in HEAD `f60e30d`; also in local `gitsafe-backup/main` mirror and in the local checkpoint tag/ref. Not present in any earlier commit. `origin` is a placeholder, so it has not been pushed to GitHub from this repo. | **Owner must revoke the token at GitHub now.** Then remove the line from `.replit`. History rewrite (to purge `f60e30d`) is the owner's call — not done here, per the no-history-rewrite rule. Do not push until resolved. |
| S-2 | MEDIUM | No per-actor rate limit on authenticated `POST /ai/conversations/:id/turns`; only guest `/ai/preview` is limited | `routes/ai.ts:707-728` vs `1641` | Phase A: reuse `consumeRateLimit` |
| S-3 | LOW | Inner test guard `requireSafeReplitDevelopmentDatabase` accepts the Replit editor's development DB (Railway) when the disposable flag is absent; only the outer `run.mjs` guard enforces loopback | `test/safe-development-database.ts:23-60`, `test/acceptance-database-guard.mjs` | Keep running suites only via `run.mjs`; consider tightening the inner guard |
| S-4 | LOW | `DINAR_DEV_DATABASE_URL` in this Repl points to a managed Railway host; `drizzle-kit migrate` and several npm scripts target it by default | `lib/db/drizzle.config.ts`, `lib/db/src/database-url.ts` | Always use the env-stripping wrapper in §6 |
| S-5 | INFO | Session cookie httpOnly + SameSite=Lax, Secure only in production; no CSRF token (Lax mitigates cross-site POST) | `lib/auth.ts:176-221` | None now |
| S-6 | INFO | `.opencode/opencode.db*` (agent session DB) is tracked in Git; no secret patterns found in it | `git ls-files .opencode` | Consider untracking |
| S-7 | INFO | Dependency audit clean | `pnpm audit` → 0 | — |

## 8. Frozen product decisions

One Arabic-first general AI conversation; real DINAR marketplace capabilities inside it; no mandatory
separate commercial dashboard; no bubble architecture; no new cryptocurrency or wallet; no new
subscription gating; Business Go/Pro postponed; no commission changes (10% stays); no real payment
activation; no invented GPS or ETAs; no advanced courier tips; no duplicate commerce engines; no
production deployment.

## 9. Blockers requiring owner input

| ID | Blocker | Blocks |
|---|---|---|
| B-0 | Revoke the leaked GitHub PAT (S-1) and decide whether to purge `f60e30d` from history | Any push / export |
| B-1 | Bare-noun messages (e.g. «مزهرية») — should they search the marketplace deterministically (F0-01 expectation) or go to the general conversation model (current runtime)? | Phase A routing |
| B-2 | Confirm the scope of phases A–F (the ledger's split is proposed, not given) | Phase A start |
| B-3 | Should the general AI conversation be available outside development? Today the only model registration is `environments: ["development"]`. Which provider/model is approved? | Phase A "general conversation" |
| B-4 | DINAR Business subscription is already reachable from the conversation (simulation-only) and gates advanced Market Pulse. Keep, hide, or leave untouched while "Go/Pro is postponed"? | Phase F |
| B-5 | Approve updating the four stale tests (wave3 ×2, readiness, phase1) to current approved behaviour | Clean regression baseline |
