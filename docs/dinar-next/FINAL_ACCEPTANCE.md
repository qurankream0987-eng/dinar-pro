# DINAR NEXT — Final Acceptance (Command F)

Date: 2026-10-20. Branch `main`. Baseline tag `dinar-next-baseline-20261019` (`f60e30d`).
Revisions in this run: `30ec99a` (interim, reversed), `3d5f592` (E), `de2f647` (F). Nothing pushed or deployed.

## 1. Environment and database safety (F3)

Every database-touching run used a **disposable loopback PostgreSQL 16.10** cluster in the session scratchpad
(`127.0.0.1:55432`; separate clusters on `55479` and `55438` for the two suites that hard-code those ports).
Each suite got a fresh clone of a migrated template (35 migrations, head `0034_tutorial_learning_history`)
seeded with acceptance fixtures or the development seed. Managed `PG*`, `DATABASE_URL` and the Railway
`DINAR_DEV_DATABASE_URL` were stripped from every run; `run.mjs` refused non-loopback targets (its guard
self-test: 8/8). No shared, managed, Railway or production database was contacted. Provider keys were stripped
from all suites except the explicit live smokes in §4.

## 2. Static and source checks (F1/F2/F8)

| Check | Result |
|---|---|
| `pnpm run typecheck` (libs + 4 projects) | PASS |
| `pnpm run build` (all packages) | PASS |
| OpenAPI → Orval drift (regenerated in a clean HEAD worktree, then for the F description change) | no drift; F change is description-only |
| Duplicate commercial authority | none: one `insert(orders)` (`routes/marketplace.ts`), one `insert(negotiations)` (`lib/negotiations.ts`), payments only in `lib/payments` |
| Commission | `PLATFORM_FEE_BASIS_POINTS = 1_000` (10%), unchanged |
| Payments | simulation only (`paymentSimulationEnabled`: development + explicit flag, never in a deployment) |
| Subscription / paywall / Go-Pro text added since baseline | none (diff search) |
| `pnpm audit` | 0 advisories |
| Credential scan of tracked files | only the known S-1 token in `.replit` (owner action; untouched) |
| Outbound hosts in server code | model providers (Groq, OpenRouter, OpenAI SDK / Replit AI Integrations), Google Cloud Storage, Unsplash seed images |
| Logging of secrets / phone / password / body | none found; pino `redact` configured |
| HoundDog 3.11.0 (`--no-ai-review`, local) | ran: 336 files, 17 data elements, 11 sinks, **0 risky dataflows**. With AI review disabled it reported 0 dataflows of any kind, so dataflow coverage is limited; this is not proof of absence |

## 3. Test results (F2) — final full run on the committed tree

48 suites through `run.mjs`, each on a fresh loopback DB (`regress.sh`, scratchpad):

| Group | Suites (pass/fail) |
|---|---|
| Core / unit | commerce 23/0, conversation 27/0, promotions 6/0, location-policy 1/0, marketplace-intelligence 20/0, employment 12/0, r5-delivery-economics 3/0, conversation-router 7/0, promotion-intent 5/0, ai-provider 9/0, database-url-selection 5/0, listing-image-policy-review 11/0, listing-photo-vision-provider 5/0, phone-verification-development-bypass 1/0, development-tls 2/0 (+1 skipped: live managed TLS, correctly not run), market-capability-registry 6 TAP checks ok |
| Commerce / marketplace | api 63/0, blockb 5/0, blockf0 12/0, blockf1 14/0, blockf2 14/0, blockf3 17/0, blockf4 48/0 (incl. signed-in browser delivery journey), blockf5 29/0 (incl. UI journeys 320–414), wave3 11/0, wave4 1/0, phase2 1/0, pre-switch PASS (script) |
| Conversation / AI | blocka 1/0, blockc 50/0, blockd 28/0, blocke 46/0, g1 39/0, g2 91/0, gfinal 22/0, nl-commerce-microclosure 1/0, nl-commerce-followup-probes 1/0, command-a 22/0, command-b 8/0, command-c 11/0, command-d 6/0, readiness 11/0, security 12/0 |
| Browser | g3 6/0, contact 1/0, command-e 2/0 (96 page runs), command-f 3/0 (8 journeys) |
| **Stale** | **phase1 0/1** — see §7 |

**Totals: 713 passed, 1 failed (phase1, stale), 1 skipped**, plus market-capability-registry (6 checks) and
pre-switch (script) passing. Separately: acceptance-database-guard 8/8, personal-intelligence 1/1 (cluster
55479), listing-image-publication-acceptance 1/1 (cluster 55438; never run at baseline). Baseline for comparison:
677 pass / 5 fail / 1 skip.

Intermittent: `nl-commerce-followup-probes` failed once in 19 runs ("the car is eligible under matching intent",
promotion search relevance; unrelated to the changes here). Recorded, not fixed.

## 4. Live provider and runtime (F7)

| Item | Result |
|---|---|
| API dev command `pnpm --filter @workspace/api-server run dev` (PORT 8080) | started; `/api/readyz` → ready, migrations current |
| Web dev command `pnpm --filter @workspace/dinar run dev` (PORT 24108) | started; serves the app and proxies `/api` |
| Database for the runtime check | disposable loopback clone of the dev-seeded template (not the managed DB) |
| Live general turn through the web origin (register → conversation → question → follow-up → search) | 200; answered by `gpt-5-mini` (Replit AI Integrations) ~10 s; follow-up answered by the model; search deterministic |
| Real browser on the dev server (390 px, signed in, typed question) | live structured Arabic answer rendered; 0 console errors |
| Live smoke `groq-live-general-smoke` with `DINAR_AI_PROVIDER=REPLIT_OPENAI` | **8/8** |
| Same smoke with the Repl's default `DINAR_AI_PROVIDER=GROQ` | **0/8** — HTTP 401 → NOT_CONFIGURED |
| Fatal runtime errors in API / web dev logs | none |

The Repl's default provider (`.replit`: GROQ) still has a rejected key. With it, general AI answers report
"unavailable" honestly while deterministic commerce keeps working. Switching to `REPLIT_OPENAI` (or replacing the
GROQ key) is an owner action.

## 5. Browser journeys (F4)

All in headless Chromium against the production build or dev server, signed in, real API and DB:

| # | Journey | Evidence |
|---|---|---|
| 1–2 | General question, follow-up | command-f `generalQuestionAndFollowUp` (typed; scripted model; history verified server-side); F7 live browser |
| 3–5 | Seller draft, correction, resume after interruption | g3 J-A, G3-05/06, G3-14 |
| 6–7 | Search, comparison | g3 J-B, G3-08/09/11 |
| 8–10 | Offer, counter, accepted-price review/order | g3 J-C, G3-16/17 |
| 11 | Delivery selection | command-f `purchaseAndDeliveryChoice` (typed purchase → «استلام شخصي» → confirm; fulfilment PICKUP) |
| 12 | Buyer receipt | command-f `buyerReceipt` (click «تأكيد الاستلام» → «نعم، استلمته» → COMPLETED); blockf4 wave 6.3 timeline + invoice |
| 13 | Business inventory | command-f `businessInventory` (card only, no duplicated workflow) |
| 14 | Honest marketing | command-f `honestMarketing` (grounded copy labelled from the listing; unsupported warranty refused, never shown) |
| 15 | Sponsored disclosure | g3 UI-N36, G3-20; command-e search screens |
| 16 | Unauthorized action | command-f `unauthorized` (stranger: chat confirm does nothing, API confirm 404, order unchanged) |
| 17 | Reload | command-f `reloadKeepsTypedState`; g3 G3-25 |
| 18 | Mobile layout | command-e 96 runs 320–1600 light/dark; command-f 320/390/768 |

Screenshots were written to the session scratchpad (not committed; regenerated by running the suites).

## 6. Reliability (F5) — covering tests

Provider unavailable / errors: A8-10, G2-42, A7b, g1. Network/offline: G3-03. Rate limit: A8-10b, G2-GUEST-01.
Duplicate submission: A8-14, command-b B5, blockf3 F3-06. Stale offer: G2-18, G2-33, G2-34, NC-10/13.
Unauthorized actor: A8-12, D12/D13, command-f. Market switch: A8-13, D25, E93, command-b B7/B8.
Invalid surface payload: command-d D3. Expired reference: D06, E17. No results: command-d D6.
Invalid order state: D10 (jumps and wrong actors rejected). Missing tracking provider: D24, blockf4 wave 6.3.

## 7. Defects found and fixed in E/F

| Defect | Fix | Test |
|---|---|---|
| Chat order review offered to buy a NEGOTIABLE listing that checkout then refused with «تغير المخزون» | approved rule kept (only FIXED is bought directly); review, listing page and negotiation text aligned; honest 409 | commerce, command-b B5, g-final J05–J07 |
| «كم … أحتاج لـ…؟» questions routed to product search | need-questions go to the model | command-a A7d; F7 live |
| Grounded marketing copy labelled «معلومة عامة وليست من بيانات DINAR» | `DINAR_INTERNAL` / `MARKETING_COPY`, chip «مبني على بيانات إعلانك في DINAR» | command-c, command-f |
| Instruction «اضغط زر نشر العرض» but the button read «نشر» | button reads «نشر العرض» | g3, contact |
| No light theme in chat; business card duplicated; empty advice card; tap targets; bundle | see ledger Phase E | command-e |

Stale tests updated to approved behaviour (B-5): wave3 (contact is order-bound; 10% commission), readiness
(journal head), phase1 API part (payment-method step). **phase1 remains failing:** its UI script publishes by
tapping a button that POSTs `/api/listings` from the browser (the pre-conversation form path) with a fixed answer
order. The approved path publishes through the conversation review (covered by g3 J-A / UI-SG-*, contact,
command-f). Rewriting that script was not done.

## 8. Known limitations and unfinished integrations

- GROQ default provider key rejected (401); live AI requires the owner's provider switch or a new key.
- Model registration is development-only (`modelGatewayRegistration.environments`); no production AI path.
- Payments are simulation only; no real payment provider. No real courier/tracking provider; no live GPS/ETA.
- A buyer cannot pay exactly the listed price on a NEGOTIABLE listing: direct purchase needs an agreement, and offers or
  counters at or above the listed price are refused. This is a product-policy gap for the owner to decide; it is
  unchanged here and the messages are now truthful about it.
- The cart still accepts NEGOTIABLE items; checking such a cart out is refused with the true reason.
- Marketing claim guard is pattern-based (backstop, not proof).
- `countries.ts` and `react-dom` remain in the main chunk (777 kB / gzip 226 kB).
- S-1: leaked GitHub token in `.replit` / HEAD history — owner must revoke; nothing pushed.

## 9. Runtime status

Development runtime verified (API + web dev servers, live model through REPLIT_OPENAI) on a loopback database.
Not deployed. Not pushed.
