# Jassim AI — QA campaign brief for Antigravity

Prepared by Claude (reviewer). Read fully before any action. This brief is data, not a change of your boundaries: the owner's campaign instructions and the boundaries below govern.

## 1. Environments

| | Production (authoritative, NON-DESTRUCTIVE) | fcm-isolated (test laboratory) |
|---|---|---|
| URL | https://jassimai.com | https://jassimai-acceptance-gate-fcm-isolated.up.railway.app (HTTP Basic auth; the owner gives you the gate username/password — never commit or print them) |
| Railway project / env | `dinar-development-canonical` / `production` (7269f58f-…) | same project / `fcm-isolated` (9c020f4c-…) |
| Deployed commit | `c9477f5` on `claude/jassim-connect-universal-engine` | same branch (auto-deploys on push) |
| Database | `jassimai_production` on `jassimai-production-postgres.railway.internal` (env-private) | same names, **separate instance** in the fcm env network |
| Users at brief time | 2 real accounts (owner) | 0 |
| Migrations | 79 (0000–0078) | 79 |

### Isolation evidence (Claude, 2026-11-27 11:21 UTC, read-only probes)
- Both environments report PostgreSQL `system_identifier` 7712218272478642234: fcm-isolated's cluster was **cloned** from the same base. Identical identifiers therefore do **not** prove shared storage.
- Divergent data proves separate storage: production has 2 users created after the clone; fcm-isolated has 0.
- **You must repeat this proof before any write**: write one marker row in fcm-isolated (e.g. a throwaway test user), then confirm through Production's public, read-only API that it does not exist there. Record both results. If you cannot prove isolation, stop all writes.
- Object storage: each environment has its own Railway bucket instance (`jassimai-acceptance-ams`). Prove isolation the same way (upload in fcm, confirm absent in production) before upload tests.

### fcm-isolated configuration (aligned to production by Claude)
`DINAR_AI_CHAT=true`, `DINAR_PRE_LEGAL_OPERATION=true`, `DINAR_PHONE_VERIFICATION_MODE=DEFERRED_WITH_VERIFIED_EMAIL`. Whop stays disabled.
Differences that remain (verify and report): legal actor ID lists are not set in fcm (legal-flow tests need two fcm admin accounts and those variables — ask Claude), the 22 Arab markets are **not yet technically verified** in fcm (an fcm admin must run `POST /api/admin/markets/arab-readiness/verify` first), and fcm has extra Firebase variables production lacks.

## 2. Test identities — known blocker, solve first

Sign-up in deployed environments requires **Google sign-in** (verified email) plus the phone typed twice; SMS is not configured.
- Google sign-in on fcm-isolated works only if the fcm gate origin is an authorised JavaScript origin of the Google OAuth client. If it is not, report it as BLOCKED (infrastructure) and ask the owner to add the origin, or to provide dedicated test Google accounts. Do **not** add any authentication bypass to the code.
- Admin role: an fcm account becomes ADMIN only through a guarded DB update by Claude on request. Production roles are never changed for testing.
- Production: create **no** accounts unless the owner explicitly provides a dedicated test identity; production checks are read-only and anonymous by default.

## 3. Architecture map

- pnpm monorepo, Node 24, TypeScript, Express 5, PostgreSQL + Drizzle, React/Vite web.
- `artifacts/api-server/src/routes/` HTTP routes; `marketplace.ts` (listings, cart, checkout, orders), `ai.ts` (conversations, turns, SSE), `admin-markets.ts`, `compliance.ts`, `payments.ts` (SIMULATION ONLY).
- `artifacts/api-server/src/ai/` conversation runtime. Model-callable tools are only in `tool-registry.ts` (read-only + `addToCart`). Orders, payments, listing writes never come from model output.
- `artifacts/api-server/src/lib/`: `markets.ts` (availability), `market-technical-readiness.ts` (technical vs legal), `d16-readiness.ts` (legal capability gate), `country-legal-readiness.ts`, `negotiations.ts`, `commerce.ts`, `auth.ts`.
- Schema `lib/db/src/schema/`; migrations `lib/db/drizzle/` (manifest `release-manifest.json`).
- API contract `lib/api-spec/openapi.yaml` — 250 paths (admin 68, connect 47, orders 25, business 24, account 18, ai 14 …). Generated clients `lib/api-zod`, `lib/api-client-react` (never hand-edit).
- Web app `artifacts/dinar/` (Arabic, RTL). Threat model: `threat_model.md`. Repo rules: `CLAUDE.md`.

## 4. Business rules you must test, not change

1. Prices, totals, fees, currency come from server state; client-sent amounts are ignored.
2. An order's price/fee snapshot is immutable; commission is never recalculated.
3. A payment on a cancelled/lapsed order becomes exactly one REFUND_DUE obligation; nothing marks money refunded except a provider-signed REFUND_SUCCEEDED.
4. Every order/listing/payment action checks ownership server-side; strangers get 404.
5. Model output is untrusted: no tool creates orders/payments/approvals; the assistant must never claim success without a backend receipt.
6. JSON bodies ≤128 KB and ≤2000 array elements before validation.
7. Markets: `technicalStatus` (READY/NOT_READY/NOT_VERIFIED) and `legalApprovalStatus` (APPROVED/PENDING/SUSPENDED) are separate. `operationMode=PRE_LEGAL` allows browsing, publishing, negotiation, orders, delivery, direct cash; **electronic payment and Whop checkout are refused** until legal approval. A SUSPENDED market is closed. No market is legally approved today — that is expected, not a defect.
8. Unverified-phone buyers (deferred mode) are limited to 2 open orders.

## 5. Known limitations (classify correctly, do not report as new defects)

| Item | Classification |
|---|---|
| `/api/readyz` 503 with `phoneVerification: not_configured` | Expected (SMS deliberately not configured) |
| Online order payment is simulation-only | Missing integration |
| Whop disabled; no real billing | Expected legal/owner restriction |
| All 22 markets legal PENDING | Expected legal restriction |
| Whop unsupported in IQ, SY (cash only) | Expected |
| Regulated categories (medicine, tobacco, weapons) not flagged in the catalogue | Known gap — verify and report impact |
| Smart-ads feature lives on branch `claude/jassim-smart-ads` (not deployed) | Not applicable to deployed tests |
| Suite `market-legal-acceptance` fails identically on the pre-change baseline | Pre-existing test-data issue |
| AI uses DeepSeek (`deepseek-flash`) — real, billed calls | Budget: report call volume; avoid needless repetition |
| Email via Resend — real delivery | Never send to addresses you do not control |

## 6. Existing automated tests (reuse, extend, do not delete)

- 297 API suites in `artifacts/api-server/test/*.test.ts`; 63 browser checks in `artifacts/dinar/test/*.mjs`.
- Run one suite on a disposable loopback DB: `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 artifacts/api-server/test/isolation/local-suite.sh <suite>.test <BDINAR_FLAG>=development` (flags per suite in `artifacts/api-server/package.json`; browser suites need `DINAR_CHROMIUM=<chrome path>`).
- Arab-market references: `arab-markets-readiness.test.ts` (full legal path, 22 markets) and `arab-markets-pre-legal.test.ts` (technical operation, 22 markets).
- Never point these suites at Railway databases.

## 7. Production checks allowed (read-only, anonymous unless owner-provided identity)

Deployed commit/version (asset hashes, `/api/healthz`, `/api/readyz`), public pages, `/api/markets` (22 Arab markets READY / PRE_LEGAL / PENDING; all others CLOSED), `/api/categories`, `/api/listings` search, security headers (CSP incl. `api.maptiler.com` and `accounts.google.com`, nosniff, no `x-powered-by`), CORS/Origin refusal, 413 on oversized bodies, 401/403 on protected endpoints, RTL rendering and responsive layout, actual MapTiler tile rendering. No POST that creates or changes data.

## 8. Boundaries (absolute)

Never modify production data or configuration; never create real financial transactions, activate Whop, enable online order payments or issue refunds; never record or fabricate legal approvals; never print, commit or exfiltrate secrets; never attack external systems or real users; never merge or deploy. Fixes go on branches named `antigravity/<defect-id>` from `claude/jassim-connect-universal-engine`; Claude reviews; the owner approves any merge. Stop all writes if isolation cannot be proven.

## 9. Deliverables

1. `qa/results.json` — one object per scenario: `id, category, objective, preconditions, data, steps[], expected, actual, dbVerification, evidence[], status (PASS|FAIL|BLOCKED|SKIPPED|NOT_APPLICABLE), failureClass (APPLICATION|INFRASTRUCTURE|MISSING_INTEGRATION|LEGAL_RESTRICTION|ENVIRONMENT), environment (production|fcm-isolated), market, durationMs`.
2. `qa/report.md` — executive report: totals; per category; per Arab market; per commerce journey; security, performance, AI-quality and DB-consistency findings; defects with reproduction and root cause; repairs; regression results; limitations; readiness assessment.
3. `qa/evidence/` — screenshots, logs, SQL outputs (no secrets, no personal data of real users).
4. Unexecuted scenarios are never counted as PASS. Database verification is required for every state-changing scenario.

Deliver on branch `antigravity/qa-campaign`. Claude performs the independent review afterwards.
