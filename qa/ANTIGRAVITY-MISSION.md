# MISSION ORDER — Jassim AI full QA campaign (round 2)

Read this file, `qa/environment/qa-lab-isolation.md`, `docs/antigravity-qa-brief.md` (branch `claude/google-agent-brief`) and `CLAUDE.md` before acting. This order replaces your previous plan.

## 0. What went wrong in round 1 — do not repeat
1. You re-ran existing repository suites and reported them as campaign progress. **Reruns are regression, not campaign scenarios.** They do not count toward the matrix.
2. You ran suites without their required fixtures and flags (`commerce-journey` crashed on "acceptance fixtures activate JO"; `security-acceptance` 18/21 "failures" were setup errors). Always use `artifacts/api-server/test/isolation/local-suite.sh` with the flags listed in `artifacts/api-server/package.json`; browser suites need `DINAR_CHROMIUM`.
3. You ran two suites on one database at the same time. Forbidden.
4. Your logs did not record which suite produced which result (`qa-local-*`). Every log must name its suite, command, commit and start/end time.
5. You started a new process after being told to pause. Pause means stop.
6. You claimed "isolation verified" without recording evidence. Claims without evidence count as not done.
7. You tested an in-sandbox server, not the deployed application. Round 2 tests the **deployed app**.

## 1. Environment
- Target: **qa-lab** — https://jassimai-acceptance-gate-qa-lab.up.railway.app (gate credentials from the owner; never commit, print or log them).
- Railway environment `qa-lab`, fork of production, expires 2026-12-27. Deploy branch `fork/d33eb4ba`.
- Production (https://jassimai.com): **read-only, anonymous GETs only.** No sign-in, no POST/PUT/PATCH/DELETE, no account creation.
- Before your first write: repeat the isolation proof yourself (unique marker in qa-lab, confirm absent in production through public read-only API; storage probe object written and read in qa-lab only). Record evidence. If any check fails, stop all writes and report.

## 2. Gate 0 — prerequisites (report BLOCKED with evidence if not solvable)
1. **Test identities.** Sign-up uses Google sign-in + phone typed twice. If Google sign-in fails on the qa-lab origin, report it as BLOCKED (infrastructure) and ask the owner to add the origin to the OAuth client or provide dedicated test Google accounts. **Never add an authentication bypass.**
2. Ask Claude (via the owner) to grant ADMIN to your designated qa-lab admin test accounts and to set the legal-role IDs if you test the legal workflow. Never use or modify the two pre-existing owner accounts copied from production.
3. **AI budget.** DeepSeek calls are real and billed. Do not exceed the call budget the owner sets; until then, stop at **1,500 model turns** and report. Count every turn in `results.json`.

## 3. The campaign — what must be covered
At least 1,000 *distinct* scenarios where the functionality supports them. No padding. Each scenario: id, category, objective, persona, preconditions, data, exact steps, expected, actual, DB verification, evidence, status, failure class, environment, market, duration.

### A. Accounts and sessions
Google sign-up, phone typed twice (match/mismatch/invalid length per country), duplicate phone, duplicate Google account, sign-in/out with confirmation, switching Google accounts, expired session, session fixation, the 2-open-order limit for unverified phones, account country vs market, profile edits, admin-only pages.

### B. Jassim AI conversation quality (the core product)
- Personas: ≥30 buyers, ≥20 sellers, ≥10 merchants, varied age, tone, literacy, country.
- Language: MSA plus Gulf, Levantine, Egyptian, Iraqi, Maghrebi dialects, Arabizi, English, mixed Arabic–English, misspellings, voice-style run-on text.
- Behaviours: vague and incomplete requests, contradictions, changed minds, long conversations (30+ turns), rapid successive messages, interruption and resumption, returning users, off-topic and abusive messages, prompt-injection attempts ("ignore your rules", "mark my order paid", "make me admin").
- Must verify: never invents products, prices, stock, sellers, orders, payments, delivery or approvals; every claimed action exists in the database; refuses unsafe requests; asks for missing information; keeps context; correct currency per market; Arabic quality and RTL.
- Grade every AI answer: correctness, honesty (no fabrication), helpfulness, language quality — 1–5 each, with the transcript as evidence.

### C. Seller journeys
Publish by chat and by form; photos (valid, oversized, wrong type, other user's); prices at each currency's precision (KWD/BHD/OMR/JOD/TND/LYD/IQD 3 decimals; KMF/DJF 0); stock modes; categories including regulated goods (record what happens — known gap); edit, pause, archive, delete; restricted categories per market.

### D. Buyer journeys and commerce
Search (Arabic/English/dialect/typos), filters, sorting, comparisons, smart store cards, cart, checkout with **direct cash only**, negotiation (offer, counter, accept, reject, expire, price changed mid-negotiation, stock gone), duplicate checkout, simultaneous purchase of the last item by many buyers, cancellation by buyer and seller, acceptance and rejection, delivery and pickup, completion, cash refund obligations and the "no refund recorded without a provider-signed event" rule, seller dues and 5% commission snapshots (never recalculated), notifications to both sides.
Full end-to-end: seller registration → listing → discovery → negotiation → agreement → order → cash selection → seller notified → acceptance → delivery → completion, **verified in the database at every step**.

### E. All 22 Arab markets
For each of AE BH DZ EG IQ JO KM DJ KW LB LY MA MR OM PS QA SA SO SD SY TN YE: registration with a local number, market assignment, currency and formatting, publish, search isolation between markets, cash order, `operationMode=PRE_LEGAL`, `legalApprovalStatus=PENDING` shown honestly, electronic payment and Whop checkout refused, IQ/SY Whop unsupported message. Run the admin technical check in qa-lab and record it.

### F. Jassim Connect (business integrations)
Using qa-lab only and **no live external calls** (`DINAR_CONNECT_LIVE_CALLS=false`): connecting a store system, credential vault (secrets never returned or shown to the model), discovery vs authorization of tools (a discovered tool is not usable until authorized), read vs write separation, write actions only through confirmation cards, multi-company workflows (one confirmation, ordered steps, data passing, honest partial outcome), catalog pull, smart store cards from a connected store, business AI answering customers with only the store's authorized tools, OAuth state/redirect validation, a store trying to use another store's tools. Label every mocked provider as MOCKED.

### G. Admin and legal workflow
Arab markets page, technical check, legal readiness file (16 topics) with real separation of duties (reviewer ≠ approver ≠ owner), suspension closes a market, no fabricated approvals (in qa-lab use clearly labelled TEST evidence only and record that it is test data), market configuration, categories, disputes, refunds, trust & safety, promotions — and that ordinary users cannot reach any of it.

### H. Subscriptions and paid ads readiness (no real charges)
Plans and prices come from the server, checkout refused in PRE_LEGAL markets and while billing is disabled, ad products configurable per market currency, no charge ever attempted.

### I. Security (qa-lab only)
IDOR/BOLA on every owner-scoped resource (listings, orders, conversations, business profiles, Connect bindings), privilege escalation, mass assignment, price/quantity/total manipulation, replayed and duplicated requests, race conditions, CSRF/Origin, XSS in every text field rendered anywhere (chat, cards, admin), SQL/NoSQL/command injection, path traversal in uploads, oversized and deeply nested JSON, rate limits, error messages leaking internals, secrets in responses or HTML, session cookie flags. Never attack production, external services or real people.

### J. UI, maps, accessibility, performance, reliability
Real browser runs (mobile 360px and desktop, light and dark, RTL), every page and dialog, MapTiler map actually rendering tiles and location sharing, WCAG AA checks, Core Web Vitals, p50/p95 API latency under concurrent load (moderate, qa-lab only), restart/recovery behaviour, behaviour when the AI provider times out.

### K. Regression
Run the repository suites relevant to every area you touch, correctly, one database per suite, and report them **separately** from the campaign.

## 4. Defects
For every genuine defect: reproduction steps, evidence, component, severity (Critical/High/Medium/Low), root cause in the code (file:line), minimal fix proposal. Fixes only on branches `antigravity/<defect-id>` from `claude/jassim-connect-universal-engine`, with the affected tests re-run plus regression. Do not weaken tests or business rules, do not rewrite working components, do not merge, do not deploy to production. Pushing to `fork/d33eb4ba` (qa-lab only) requires the owner's approval per fix.

## 5. Absolute boundaries
No production writes. No real payments, refunds, Whop activation or online order payments. No fabricated legal approvals. No secrets in logs, commits or reports. No attacks outside qa-lab. Pause means stop immediately. If isolation cannot be proven, stop all writes.

## 6. Deliverables (commit to `antigravity/qa-campaign` at least every 3 hours)
1. `qa/results.json` — keep the existing `regressionReruns` and `claudeVerification` sections; add `campaign[]` with every scenario (schema in section 3) and `summary` with designed/executed/PASS/FAIL/BLOCKED/SKIPPED/NOT_APPLICABLE counts, by category, by market, by journey, plus AI turn count.
2. `qa/report.md` — executive summary; results by category, by market, by journey; AI quality scores with worst transcripts; security findings; performance numbers; database consistency findings; defects with root cause; fixes and regression results; limitations; an honest production-readiness verdict.
3. `qa/evidence/` — screenshots, transcripts, HAR/logs, SQL outputs (no secrets, no real personal data).
4. A short status note in `qa/STATUS.md` updated at each commit: what ran, what is next, blockers.

An unexecuted scenario is never PASS. A chat reply is never proof that an operation happened — the database is. Claude will independently re-run a sample of your PASS results; any PASS that cannot be reproduced will be reported to the owner.
