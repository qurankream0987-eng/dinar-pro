# DINAR frontend experience wave

Scope: frontend presentation, conversational controls, RTL, accessibility and browser contract fixtures. No backend, database, migrations, infrastructure, financial authority or provider integration changes.

## Repository trace

- Shared starting branch: `main`.
- Starting HEAD: `2194a428ef06c4015ff53116d15fd56162dc330d`.
- Starting worktree: clean.
- Shared recent commits: `2194a42`, `880c0da`, `6a0d7fb`, `4d2db6b`, `0913e95`.
- Concurrent Replit work appeared in `model-turn.ts` and `ai-provider.test.ts`, then was checkpointed separately. It was never overwritten or staged by this wave.
- Delivery branch: `codex/frontend-personal-experience`, isolated at `/tmp/dinar-frontend-wave` from the starting HEAD. Shared `main` and attached assets are preserved. Only frontend files are included in delivery commits.

## Changes

- Arabic typed memory summaries distinguish server-provided explicit, inferred and negative preference groups. View, add, edit, forget and suppress commands go through the existing chat API. Older cards cannot submit actions, and errors never produce local success. Empty confirmations remain readable. `MEMORY_REMOVED` is supported for rendering; the current canonical forget handler emits `MEMORY_UPDATED`.
- Existing commercial payloads now pass the frontend allowlist and render inside the conversation. Prices, balances, campaign figures and subscription status come from the server. Simulation, sponsored disclosure and no-sale-guarantee wording are explicit. No financial calculations were added.
- Courier fare cards show server proposal, next confirming party and agreed fare. Commission cards show server balance, count, threshold and hold. Loading and errors have accessible status and retry controls.
- Order cards wrap narrow metadata; tracking states retain canonical status and retry. The approved physical-left 260px sidebar, mobile drawer and conversation-first layout are preserved.
- Delivery location summaries no longer print coordinates. Transcript display and copy redact credentials, card numbers and precise coordinates. Arabic error handling rejects implementation details.

## Verification

Commands:

```sh
pnpm --filter @workspace/dinar exec node test/frontend-closure-ui-acceptance.mjs
pnpm run typecheck
pnpm --filter @workspace/dinar run typecheck
pnpm --filter @workspace/dinar run build
git diff --check
```

The memory renderer retains the existing direct-call RTL metadata contract while interactive hooks remain inside its React child.

The closure harness uses real Chromium with isolated API contract fixtures and direct frontend contract assertions. It tests 1600, 1440, 1280, 1100, 1024, 800, 650, 414, 390, 360 and 320px; memory actions and rejection; commercial surfaces and canonical commands; orders and order-detail timelines in canonical created/accepted/confirmed/cancelled states; tracking; delivery fare and commission hold; drawer/dialog focus; account-scoped memory presentation; secret and coordinate exclusion. The former premium harness was retired after its API route and starter contracts became obsolete. Its overlapping coverage is maintained by `experience-upgrade-browser.mjs`, `frontend-closure-ui-acceptance.mjs`, and the domain-specific G3/Block acceptance suites. These are rendering/interaction tests, not authenticated backend E2E.

Evidence: the current closure run is in `/tmp/dinar-frontend-closure-final/report.json` with screenshots; historical runs remain under `/tmp/dinar-frontend-closure/`.

Real development runtime was available. A separate browser context made an unintercepted authentication request and opened the real homepage. It returned no signed-in user: **AUTHENTICATED_BROWSER_TEST: BLOCKED**. Authentication was not bypassed. Authenticated managed-environment E2E remains with Replit.

Historical Block A 320px clipping checks already allow subpixel tolerance; the final matrix checks actual overflow. The older premium navigation test expected the retired 56px rail and was updated to the approved 260px sidebar and current accessible navigation controls. Its compact-height test checks helper reachability with clearance in the existing scrollable hero. Its courier fixture now supplies the canonical commission-account object. The mobile seller summary assertion uses available container width instead of a fixed 200px minimum, with 0.5px layout tolerance. The standalone policy assertion preserves the existing default theme after chat unmounts, rather than demanding a global chat theme leak.

## Missing backend capability/data

- No separate canonical `COUNTERED` fare status is exposed. The frontend displays the actual pending proposal and confirmation flags; it does not invent a counter state.
- Business successful-sale allowance/usage is absent from the current presentation contract: **BACKEND_DATA_NOT_AVAILABLE**. No fake 10-sale usage meter was added.
- Numbered Market Pulse Demand Capture commands currently route to a listing draft before Demand Capture in the existing backend handler. The frontend only offers the valid unnumbered first-opportunity command; other per-opportunity activation requires a backend capability. Backend unchanged.

No backend suites, live payments, deployment or infrastructure mutations were performed. Nonfatal build warnings about existing sourcemaps and bundle size remain.

## Final results

- Closure browser/contract checks: PASS (199 checks).
- The legacy premium harness was retired after current UI/API contracts diverged; the last attempt failed on a retired starter contract. The earlier 203-check pass is historical, not current evidence. Replacement suites passed as recorded in `REPLIT_FINAL_ENGINEERING_ACCEPTANCE.md`.
- All eleven requested widths: PASS.
- Measured overflow, clipped CTA, composer overlap, RTL, secret-display, cross-account memory-display and precise GPS transcript counters: 0.
- Workspace typecheck, final frontend typecheck, web build and diff check: PASS.
- Authenticated browser E2E: BLOCKED; fixture tests are not backend E2E.
- Delivery branch backend/DB/migration/financial/payment authority changes: 0.
