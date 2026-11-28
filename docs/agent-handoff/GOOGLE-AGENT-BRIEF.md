# Mission brief for the build-and-test agent (JassimAI / DINAR)

You are taking over **building and testing** on JassimAI (repository `qurankream0987-eng/dinar-pro`).
The owner has authorized the scope below. Work until every item in **§7 Definition of done** is
true and proven by evidence, or until you reach a **§6 stop point**: then stop and ask the owner.
Never treat "keep going until done" as permission to cross a stop point.

---

## 1. Read first (mandatory, before writing code)

1. `CLAUDE.md`: invariants, environment rules, and how to run tests. These rules are binding.
2. `docs/merchant-commerce/ARCHITECTURE-AR.md`: target architecture, the three operating modes, and the layers.
3. `docs/merchant-commerce/M1-DELIVERY-AR.md`: what M1 already built.
4. `docs/deal-payments/DESIGN-AR.md`: the payment agreement, open payment choice, and seller classification.
5. `docs/jassim-ads-phase2/REPORT-AR.md`: Jassim Ads Phase 2 (real Whop payment, switched off).
6. The code these documents point to (listed in §3).

Then write `docs/agent-handoff/AUDIT.md` before any change. For each item in §4, state:
- what already exists,
- what you will reuse,
- what is actually missing.

If an item already exists and works, do not rebuild it.

## 2. Branch and environment

- **Start from:** `claude/merchant-policies-m1`. It already contains `claude/deal-payment-agreement`, which contains `claude/jassim-ads-phase2`.
- **Work on:** a new branch, `agent/commerce-build`. Push only that branch.
- **Never:**
  - merge into `main` or any `release/*` branch;
  - force-push other branches;
  - delete branches.
- **Database:** only a disposable **loopback** PostgreSQL (`127.0.0.1`), with names matching `dinar_(test|acceptance|wave<n>|migration)_*`.
  - Never connect to Railway, Replit, Production, Staging, or any non-loopback database.
  - Never run `drizzle-kit push`.
- **Run suites with:**
  `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh <suite>.test BDINAR_TEST_DATABASE=development`
  (from `artifacts/api-server`). Add browser suites with `DINAR_CHROMIUM=<path>`.
- **No network or real money in tests:**
  - No live AI or model calls (`test/run.mjs` already blocks them).
  - No real payment provider calls: provider doubles run in-process (see `test/jassim-ads-phase2.test.ts`).
  - No real money, ever.

## 3. What already exists (reuse it; do not duplicate it)

| Area | Code | Migration |
|---|---|---|
| Jassim Ads Phase 1: assistant and placements | `ai/ads-assistant-turn.ts`, `routes/ads*.ts`, `lib/promotion-policy.ts` | — |
| Jassim Ads Phase 2: Whop payment per promotion, switched off | `lib/promotion-whop.ts`, `lib/billing/whop.ts`, `ai/commerce-turn.ts` | 0080 |
| Deal payment agreement: open choice, protected instructions, deal card | `lib/deal-payments/*`, `ai/deal-payment-turn.ts`, `routes/deal-payments.ts`, `dinar/src/features/ai/DealCardPanel.tsx` | 0081 |
| Seller classification and commission | `lib/seller-classification.ts`, `ai/seller-classification-turn.ts` | 0082 |
| Connect profit share (pure function) | `connect/profit-share.ts` | — |
| Merchant policies M1 | `lib/merchant-policies/*`, `ai/merchant-policy-turn.ts`, `routes/merchant-policies.ts` | 0083 |
| Connect: binding law, API connectors, tool router, store payment link, workflows, credential vault | `src/connect/*` | earlier |
| Smart store cards | `lib/smart-store-cards*`, `connect/tool-cards.ts`, `smart_store_cards` | earlier |

Next migration number: **0084**. Each new migration must be added to:
- `drizzle/meta/_journal.json`
- `drizzle/release-manifest.json` (sha256)
- `REVIEWED_PENDING_MIGRATIONS` in `lib/db/src/clone-migration-guard.ts`
- the head tag asserted in `test/development-tls.test.ts` and `test/readiness.test.ts`

Migrations must be additive only, and must never change or delete existing data.

## 4. Scope (authorized for building and testing in isolation)

### A. M2: apply merchant policies to orders and cards
1. **`PAYMENT_OPTIONS` card composer.** One card per order, built from:
   - the store's `PAYMENT_METHODS` policy,
   - the seller's accepted methods (`seller_payment_methods`),
   - and, only when a real adapter exists and is enabled, the store gateway (it does not exist yet, so it must never appear).

   Choosing a direct method uses the existing `deal_payment_*` flow; do not duplicate it.
2. **Enforce at checkout and in chat:**
   - `MIN_ORDER`, `ORDERING_PAUSED` and `GEO_RESTRICTION` are refused server-side with a clear Arabic reason.
   - `OUT_OF_STOCK` follows the merchant's message and records interest through the existing demand-alert mechanism. It never promises a date the merchant did not set.
   - `ALTERNATIVES` suggests in-stock items from the same store.
   - `SHIPPING`: fees are computed by code and shown on `ORDER_REVIEW`. The order's price snapshot must stay immutable.
   - `COD_AREAS` limits cash on delivery by area.
3. **Provenance on every fact shown:** `STORE_SYSTEM` | `MERCHANT_POLICY` (with version) | `UNCONFIRMED` | `NEEDS_MERCHANT_APPROVAL`. Reuse `ai/fact-provenance.ts`.
4. **Web review card** for merchant policies (`MERCHANT_POLICY_REVIEW`):
   - Arabic, RTL, mobile-first.
   - Confirms through `POST /merchant-policies/:id/confirm` with `expectedVersion`.
   - Shows conflicts, and "sign in again" for HIGH_RISK changes.

### B. M3: store checkout adapter, simulated only
1. Implement the `StoreCheckoutAdapter` interface from ARCHITECTURE §5:
   - a `SimulatedStoreGateway` used only by tests, behind a test-only flag;
   - the `custom-openapi` adapter built on `connect/api-connector.ts` (owner-authorized "create session" and "payment status" tools, mapped with JSON pointers).
2. **Webhook:**
   - verify the signature;
   - dedupe by provider event id;
   - re-read the payment from the provider;
   - match order, amount, currency and provider id.

   Only then may the status become `PAID`. A buyer saying "I paid" or a return URL is never proof.
3. **`PAYMENT_STATUS` card.** The hosted checkout opens in a secure browser surface. Card data is never collected inside Jassim.

### C. Jassim Ads: verify and finish (still switched off)
- Re-run and keep green: `jassim-ads-phase1`, `jassim-ads-phase2`, `promotions`, `promotion-intent`, `advertising-acceptance`, `welcome-ads-browser`.
- Close the known gaps, with tests:
  - Whop's blocked-country list must include the sanctioned set IQ, SY, LY, YE, SD, SO, KM and PS (`lib/whop/config.ts`).
  - Paid promotions must stop being served when a market's legal approval is withdrawn.
- **Do not** build the prepaid Ads Wallet (study only, not approved).

### D. Smart payment cards: browser verification
- Add Playwright browser suites (in the style of `welcome-ads-browser`) for:
  - `DEAL_CARD`, including the protected instructions view and the seller's instructions form;
  - `PAYMENT_OPTIONS`, `PAYMENT_STATUS` and `MERCHANT_POLICY_REVIEW`.
- **Viewports:** 320, 360, 390, 414 and 1280 px.
- **Checks:**
  - RTL;
  - no horizontal scroll;
  - keyboard focus;
  - payment values never present in stored chat blocks or in the DOM before the protected view is opened.
- Screenshots go to `docs/agent-handoff/screens/`.

## 5. Rules that must never be weakened (from CLAUDE.md and owner decisions)

**Prices and money**
- Prices, totals, fees, commission and currency come from server state. Client amounts are ignored.
- An order's price and commission snapshot is immutable.

**Model output**
- Model output is untrusted. No tool may create orders, payments, approvals or policy activations.
- Writes need the person's confirmation in the app.

**Payment proof**
- `PAID` only comes from a provider-signed, deduplicated, amount-matched event.
- A buyer's report is never proof. A seller's confirmation is never bank verification.
- COD collection is never inferred from delivery.

**Custody**
- JassimAI holds no buyer or seller funds, executes no direct transfers, and builds **no gateway of its own**.

**Sensitive data**
- No card numbers, passwords, OTPs or bank logins anywhere.
- Payment details are never stored in chat history.

**Policies**
- Merchant policies apply only from validated ACTIVE settings, never from free text.
- Confirmation tiers stay as built: NORMAL (in chat), SENSITIVE (review card), HIGH_RISK (review card plus a fresh platform sign-in).
- Financial permission scopes are never implied by other scopes.

**Commission and agreements**
- Personal sellers pay 0%, merchants and businesses pay the published rate, and Connect partners are under their own agreement.
- Never reprice past orders.
- Existing Connect agreements must not be modified.
- New Connect profit-share terms apply only to new agreement versions a partner accepts. This is **not in your scope** unless the owner approves it.

**Separation and flags**
- Keep the Ads wallet, subscriptions, marketplace commission and deal payments separate.
- Every new capability ships switched off in production (env flag) and on in development and tests.

**Token economy**
- Never send whole catalogs or all policies to the model; send at most 5 relevant results.
- Calculations are done in code.
- Cards are fixed contracts filled by code.
- Clear phrases are handled deterministically, without the model.

## 6. Stop points: stop and ask the owner; do not work around them

- Anything touching Production, Staging or Railway, including variables, migrations and deploys.
- Merging, or opening a PR to `main`.
- Real payment provider keys (sandbox or live), paid services, or real transactions.
- Choosing the first real gateway provider for M4. No connected store exists today (checked against a Production copy on 2026-11-27), so wait for real usage.
- Changing commission rates, existing Connect agreements or settlements.
- Building the Ads Wallet, M4 or M5.
- A test that fails on the base commit too: record it as pre-existing, do not "fix" the expectation, and continue.
- Any rule in §5 that blocks you: ask, never weaken it.

## 7. Definition of done (you are not finished until all are true)

1. `docs/agent-handoff/AUDIT.md` exists and was written before the code changes.
2. M2 (§4A) and M3 (§4B) are implemented on `agent/commerce-build`, each behind its flag, and reuse the existing modules listed in §3.
3. **New tests exist and pass,** at minimum covering:
   - every policy kind enforced (allowed and refused cases);
   - provenance labels;
   - the `PAYMENT_OPTIONS` composition for the three operating modes (connected store with a simulated gateway, store without a gateway, independent seller);
   - the webhook path: bad signature, duplicate event, amount mismatch, currency mismatch, unknown order, and a valid event that sets `PAID` exactly once;
   - a gateway option never shown without an enabled adapter;
   - the Jassim Ads gaps from §4C;
   - the browser suites from §4D at all five viewports.
4. **Every suite below passes, or fails exactly as it does on the base commit `dac2315`.** Prove it with the same suites run on the base. Required:
   - `merchant-policies`, `deal-payment-agreement`, `deal-payment-open-methods`, `seller-classification`
   - `conversation`, `api`, `commerce-journey`, `block-f3-commerce`, `order-settlement`, `closure-privacy`
   - `development-tls`, `readiness`, `integration-openapi-coverage`
   - `business-delegations`, `d1-d2-business-foundation`, `d4-d5-isolation-security`, `d5-seller-employee-acceptance`
   - `jassim-ads-phase1`, `jassim-ads-phase2`, `promotions`, `whop-billing`, `arab-markets-pre-legal`, `arab-markets-readiness`
   - `block-e-acceptance` and `block-f5-unified`: these have known pre-existing failures (E01/E02; F5-07/10/21/24), which must stay exactly those and nothing more.
5. Builds pass: `pnpm run typecheck`, the api-server build and the dinar build.
6. Every suite run reports `outbound=0`.
7. **Security self-review** written in `docs/agent-handoff/SECURITY.md`, covering for every new route:
   - authorization (404 for strangers);
   - mass assignment;
   - webhook replay;
   - secrets reaching the model, the browser or the logs;
   - payment values in chat history.
8. `docs/agent-handoff/REPORT.md` (Arabic) contains:
   - the files and migrations changed (with the migration design);
   - test results with numbers, and the base-versus-branch comparison;
   - screenshots;
   - everything not finished or not verified, stated plainly. No claim may lack evidence.
9. The branch is pushed. The last commit message lists the evidence. Nothing is merged or deployed.

When all nine are true, stop and report to the owner. If a §6 stop point blocks an item, finish
everything else, mark that item **BLOCKED — owner decision needed** with the exact question, and
stop.
