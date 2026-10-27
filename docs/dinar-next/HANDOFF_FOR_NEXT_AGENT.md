# DINAR — Handoff for the next engineering agent (Qoder or any other)

Written by Claude (Claude Code) on 2026-10-27, at the end of waves 00–03. Read this whole
file and `CLAUDE.md` before changing anything. `CLAUDE.md` rules apply to you exactly as to me.
The owner will have Claude review your work afterwards against section 8; work that cannot
show that evidence will be treated as not done.

---

## 0. Start from the right code (most important)

- **Base branch:** `claude/02-sc-acceptance`. Its head contains 15 commits above the old approved
  export `b1b20e5`. If that branch is not on GitHub yet, the owner has a git bundle
  (`dinar-claude-02.bundle`); restore it with:
  ```sh
  git clone <repo> dinar && cd dinar
  git fetch /path/to/dinar-claude-02.bundle claude/02-sc-acceptance:claude/02-sc-acceptance
  git checkout claude/02-sc-acceptance
  git log --oneline -3   # must show the Claude 03 commits
  ```
- **Never** start from `main` / `b1b20e5`: you would lose the D3 refund obligation, the S3 fix,
  the four REAL_E2E journeys and ~25 conversation fixes, and redo them.
- Work on your own branch from that head (e.g. `qoder/04-<topic>`), one topic per branch.
  Do not push to `main`, do not merge, do not rewrite history. The owner merges.

## 1. Product in one paragraph

DINAR is an Arabic-first conversational marketplace. **One interface: the chat.** Sellers
publish products/services, buyers search, negotiate and order, all from the conversation, with
interactive cards that the *server* chooses (never HTML/JS from a model). Payment is
`SIMULATION_ONLY`. The model (DeepSeek, not authorised for paid calls) only talks and may call
three read-only tools; every state change is a deterministic server action behind a review and
an explicit user confirmation. Stack: pnpm monorepo, Node 22/24, TypeScript 5.9, Express 5,
PostgreSQL + Drizzle (41 migrations), React/Vite, Playwright.

## 2. Map (where things are)

| Area | Files |
|---|---|
| Conversation entry | `artifacts/api-server/src/routes/ai.ts` → `src/ai/conversation-runtime.ts` (ordered deterministic layers, model last) |
| Buyer search / refine / purchase | `src/ai/buyer-turn.ts`, `src/ai/marketplace-intent.ts`, `src/ai/search-query.ts`, `src/ai/tool-registry.ts` (`searchListings`), `src/lib/marketplace-listings.ts` |
| **Arabic matching (general, no per-product rules)** | `src/lib/arabic-search-terms.ts` — request words, variants (clitics, ه/ة, ض/ظ, plurals, form II verb/agent ↔ noun), lexicon, generic nouns, purpose words |
| Seller draft → publish | `src/ai/listing-draft.ts`, `src/ai/draft-actions.ts`, `src/ai/action-foundation.ts` (`PUBLISH_LISTING`) |
| Seller stock / edits / pause | `src/ai/seller-management.ts`, `src/ai/seller-sales.ts` |
| Negotiation | `src/ai/negotiation-turn.ts`, `src/lib/negotiations.ts` |
| Orders, delivery | `src/routes/marketplace.ts` (`/orders`, `/orders/:id/:action`), `src/lib/delivery.ts`, `src/ai/order-context.ts`, `src/ai/delivery-turn.ts` |
| Payments (simulation) | `src/routes/payments.ts`, `src/lib/payments/service.ts`, `src/lib/payments/obligations.ts` |
| Disputes | confirm route (`received:false`), `src/routes/appeals.ts`, `src/routes/admin-disputes.ts` |
| Subscriptions | `src/ai/commerce-turn.ts` (AI_PLANS), `src/routes/commercial.ts`, `src/routes/integrations.ts` |
| Web chat cards | `artifacts/dinar/src/features/ai/*`, order card = `src/pages/OrderDetails.tsx` rendered **inside** the chat (`OrderInlineSurface`) |
| Schema / migrations | `lib/db/src/schema/index.ts`, `lib/db/drizzle/` (new migration ⇒ see CLAUDE.md "Gotchas") |
| Authority boundary | `test/ai-authority-boundary.test.ts` (do not weaken) |

`CHAT_ONLY_MODE = true` (App.tsx): `/orders/:id` redirects to chat. The order page is reached
*through the chat* («طلباتي» → row → card). Do not "fix" this by adding pages.

## 3. Rules you must not break

All of `CLAUDE.md` "Invariants" and "Environment rules", plus what these waves taught:
1. **No new AI authority.** No chat action named for capture/refund/cancel/settle/commission/
   delivered/confirm-receipt/dispute. Delivery, receipt and disputes are **buttons on the order
   card** calling the existing REST routes. `ai-authority-boundary` must stay green unchanged.
2. **No success text without a server receipt.** Never let a reply say paid / subscribed /
   published / agreed unless the server did it.
3. **General rules only.** No per-product handling («برادو», «بروستد»). A fix must be a rule
   about Arabic or about the conversation, proven by a test with *other* words too.
4. **Precision before recall.** Every recall rule needs a negative test. A derived form must end
   a word (lesson from the XP-14 regression: a stem matched another word's prefix).
5. **Relaxation is announced.** If a word is relaxed (purpose word, generic noun, category), the
   reply must say so (`broadenedFrom`, `widenedFromCategory`).
6. **Do not invent policy.** Anything in section 7 "owner decisions" stays undecided in code.
7. **Never weaken an assertion to pass.** If an old assertion checks wording that legitimately
   changed, keep its substance (example: `command-a` A7c) and say why in the commit.
8. No Railway, no production DB, no real payment, no paid model call, no SMS.

## 4. Environment (what works, what does not)

Works in a plain Linux container:
```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/dinar run build
# PostgreSQL 16 on loopback, e.g. a cluster on 127.0.0.1:55432 with role dinar_isolation
cd artifacts/api-server
DINAR_LOCAL_PG=postgres://dinar_isolation@127.0.0.1:55432 \
  test/isolation/local-suite.sh <suite>.test BDINAR_TEST_DATABASE=development
```
- `local-suite.sh`: fresh DB per suite, 41 migrations, clean env (`env -i`), net-guard.
  Only `BDINAR_*`/`DINAR_*` variables pass through.
- **Browser suites** need: `DINAR_CHROMIUM=<wrapper>` (Chromium with
  `--host-resolver-rules="MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1"`)
  **and** the fonts stub running on 443:
  `node test/isolation/third-party-stub.mjs <cert> <key> 443 <log>`. Without the stub every
  browser suite fails on `ERR_CONNECTION_REFUSED` console errors — this is environment, not code.
- After a container restart, PostgreSQL and the stub are stopped: restart them first.
- Flags: simulated payment needs `BDINAR_WAVE4_ACCEPTANCE=development`; many suites want
  `BDINAR_PROMOTIONS_ENABLED=true`; per-suite flags are in `artifacts/api-server/package.json`.
- Blocked: PostgreSQL 18 (`lib/db` release-migration test), `sandbox.sh` (needs user
  namespaces), `phase1-acceptance` (external Unsplash images). `pre-switch` needs
  `DINAR_SUITE_SEED=development`. `personal-intelligence` needs its own DB on 127.0.0.1:55479
  passed as `DINAR_PERSONAL_TEST_DATABASE_URL`.
- Do not run two copies of the same suite at once (shared `.test-build/<suite>.mjs`).

## 5. Current state (measured, head of `claude/02-sc-acceptance`)

- Full battery (86 suites via `local-suite.sh`): **84 pass**, 1,092 cases, 0 outbound attempts;
  the 2 failures are `phase1` (environment) and `pre-switch` (seed; passes on development seed).
  Separate: personal-intelligence 1/1, storage 2/2 + 7/7. Typecheck and builds clean.
- **REAL_E2E PASS** (real UI + API + DB, independent users, 320/390/desktop, RTL, no console
  errors, no outbound, no model fallback): SC01, SC03, SC07, SC10 —
  `test/sc0{1,3,7}-browser-journey.test.ts`, `test/sc10-browser-journey.test.ts`, UI scripts in
  `artifacts/dinar/test/sc*-ui-journey.mjs`, shared helper `sc-ui-session.mjs`.
- Arabic generality (`test/arabic-generality.test.ts`): safety 28/28, understanding 21/22
  (floor 0.95). Written by Claude → not independent; owner phrases go in the fixture's `owner`.
- Evidence: `docs/dinar-next/DINAR_SC01_SC10_ACCEPTANCE_EVIDENCE.md`,
  `docs/dinar-next/CLAUDE_03_EXECUTION_REPORT.md`, earlier `CLAUDE_00…`, `CLAUDE_01…`.

## 6. Work to do next, in order, with acceptance criteria

Do them one per branch. For each: red test first, then fix, then the battery.

### T1 — SC02 REAL_E2E (Prado: narrow, sort, compare, refer)
Journey in the browser with three car listings (2021 / 2018 / another 2022): «دينار أبي برادو
مستعملة» → «من 2020 وفوق» → «رتبهم من الأرخص» → «خلها بحد أقصى 5 آلاف» → «رجعني للنتائج» →
«أرخص» → «قارن أول إعلان بالثاني» → «هذا الأول كم ماشي؟» → offer → agreement → order.
Known gaps to fix first (API tests): «كم ماشي؟» on a listing without mileage must answer
deterministically «لم يذكر البائع الممشى» and offer to ask the seller (inquiry review), never
the model; the comparison must label missing attributes «لم يذكر البائع».
**Done when:** `sc02-browser-journey` passes 3 runs in a row; no step in `modelFallbacks`.

### T2 — SC06 REAL_E2E (industrial machine, spec questions)
«أريد ماكينة صناعية مستعملة لتغليف المنتجات» → «اعرض لي الماكينات 220 فولت فقط» → «هل تعمل 8 ساعات
متواصلة؟». Gap: questions about an unrecorded spec fall to the model; route them to an
inquiry review to the seller («أسأل البائع؟») with no invented answer. Inspection terms are an
owner decision (P-SC06): the reply must say they are not recorded.
**Done when:** journey passes 3×; the spec question is a DINAR inquiry review.

### T3 — Buyer stock question
«كم المتبقي؟» about the listing in view → current available quantity from the DB (minus
reservations), never the model. API test + add the step to SC01.

### T4 — Currency question honesty (SC09 partial, no FX)
«كم يطلع سعر هالمنتج بالريال؟» → deterministic: no approved FX, the listing is in its market
currency and not sold outside its market. No rate, no conversion. Test with three phrasings.

### T5 — Cards (owner phase 4)
Expired/denied/superseded cards keep no live actions (check every surface that renders actions);
proportional size (short confirmations are small; financial reviews show all terms, nothing
material folded). Browser test across 320/390/desktop for each card type touched.

### T6 — Owner phase 5 items, honest-first
Change country in chat (MARKET_SELECTOR) end to end; external search only on explicit request or
a real empty internal result, labelled as external and never turned into a DINAR order; «ابحث
لي عن سائق» bound to the right order or an honest "no delivery provider" answer. No fake
driver, no fake subscription.

### T7 — Maintenance
Zod 3.25.76 advisory (GHSA-mrhx-c7xc-m3w5): plan the upgrade against the codegen
(`lib/api-zod`, `lib/api-client-react`) and Drizzle; no blind major upgrade. Keep the 2000-element
JSON bound.

Not to start without the owner: food options (SC04), quotes/appointments (SC05), digital
deliverables (SC08), cross-market/FX (SC09), wholesale/partial returns/companies.

## 7. Owner decisions still open (do not decide in code)

P-SC03 non-price terms in counters · P-SC04 food & options · P-SC05 quotes & appointments ·
P-SC06 inspection terms · P-SC08 deliverables & IP · P-SC09 cross-market & FX · P-01 admin
refund of an active order · subscription prices, quotas, renewal (all `approved:false`) ·
return policy (no 7/14-day guesses) · launch market and scope.

## 8. Evidence required for review (Definition of Done)

Each branch's last commit (or `docs/dinar-next/<AGENT>_<NN>_REPORT.md`) must contain:
1. Base SHA and head SHA.
2. The red test output **before** the fix (first attempt), and green after.
3. The exact commands run (from section 4), and every retry with its cause.
4. Full battery result on the head: suites passed/failed, cases, outbound attempts; each failure
   classified (code / test / environment) with the log line.
5. For browser work: the suite name, widths checked, `consoleErrors`, `externalRequests`,
   `modelFallbacks` (must be empty except listed, justified bare «نعم»).
6. What was *not* done and why. No "PASS" without the suite that proves it.
Claude's review will re-run the battery from a clean checkout of your head and diff against
`claude/02-sc-acceptance`; anything that weakens an assertion, adds AI authority, adds
per-product rules or decides an owner policy will be reverted.

## 9. Pitfalls already paid for

- No provider configured ⇒ the model "fallback" reply never increments the model call counter.
  Detect fallbacks by text (`MODEL_FALLBACK_REPLY` in `sc-ui-session.mjs`).
- `offers` has no `description` column: it is in `offers.data`. Reservations raise
  `reservedQuantity`; `availableQuantity` drops only on completion.
- A pickup order needs «جاهز للاستلام» (chat, confirmed) before the hand-off can be recorded.
- Negotiable listings need an agreement before purchase (correct behaviour).
- Tests are bundled into `.test-build/`; read fixtures relative to `process.cwd()`.
- Jordan test phones: `79xxxxxxx` (+962); `78…` was rejected.
- Editing `src` while a battery runs contaminates later suites — re-run what ran before the edit.
