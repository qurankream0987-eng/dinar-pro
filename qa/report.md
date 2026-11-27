# Jassim AI — Dual-Environment QA Campaign Report

**Date:** 2026-11-27  
**Target Branch:** `claude/jassim-connect-universal-engine` (GitHub HEAD `c9477f5`, Production deployed `29e67022`)  
**Deliverable Branch:** `antigravity/qa-campaign`  

---

## Report 1: Production Live Verification Report (`https://jassimai.com`)

All checks against `production` (`7269f58f-5e4e-49d7-86c5-8fdc4d443b32`) were strictly **read-only and non-destructive**. Zero records, settings, or payment flags were modified.

| Check | Result | Details |
|---|---|---|
| **Health (`/api/healthz`)** | ✅ PASS | `200 OK` `{"status":"ok"}` |
| **Readiness (`/api/readyz`)** | ✅ PASS (Expected) | `503` `{"status":"not_ready","checks":{"database":"ready","migrations":"current","configuration":"ready","phoneVerification":"not_configured"}}` |
| **Public SPA & RTL** | ✅ PASS | `/`, `/auth`, `/search`, `/ai`, `/policies` all `200 OK`; `<html lang="ar" dir="rtl">`; JS/CSS bundles `200 OK` |
| **22 Arab Markets (`/api/markets`)** | ✅ PASS | `249` total markets; **22/22** Arab markets `technicalStatus=READY`, `legalApprovalStatus=PENDING`, `operationMode=PRE_LEGAL` (`JO` is `isActive=true, LIMITED`; other 21 `COMING_SOON`); **0** non-Arab markets open |
| **Read-Only Marketplace & Search** | ✅ PASS | `/api/categories` `200 OK`; `/api/listings` & `/api/listings?q=iphone` `200 OK []`; nonexistent listing `404` |
| **Auth & Origin Guards** | ✅ PASS | `/api/orders`, `/api/seller-dues`, `/api/dashboard`, `/api/whop/status` return `401`; unauthenticated cross-origin `POST /api/listings` & `POST /api/ai/chat` return `403` |
| **Security Headers & CORS** | ✅ PASS | `CSP` includes `api.maptiler.com`, `t3.storageapi.dev`, `accounts.google.com/gsi/`; `HSTS`, `nosniff` present; `x-powered-by` absent; `Origin: https://evil.example.com` refused |
| **Body Size Limit (128 KB)** | ✅ PASS | 150 KB JSON `POST /api/auth/login` returned `413 {"error":"request entity too large"}` |
| **Deployment Sync Note** | ⚠️ INFO | Production service config still references commit `29e67022` while GitHub `claude/jassim-connect-universal-engine` HEAD is `c9477f5` |

---

## Report 2: Comprehensive Isolated QA Report (`fcm-isolated`)

### 1. Infrastructure & Isolation Proof
- **`jassimai-production-postgres` (in `fcm-isolated`):** `jassimai-production-postgres.railway.internal` (`fd12:420e:bf1a:1:b000:14e:914a:1c8d`), DB `jassimai_production`, 151 tables, 79 migrations, 249 markets, **0 users**.
- **`Postgres-J--D` (in `fcm-isolated`):** `postgres-j-d.railway.internal` (`fd12:420e:bf1a:1:b000:133:fc84:cec2`), DB `jassimai_acceptance`, 141 tables, 68 migrations, 249 markets, **0 users**.
- **Marker Proof:** Inserted and deleted `QA Isolation Marker` (`aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001`) in `fcm-isolated` (`before: 0 -> after: 0`). Production remained untouched.
- **Object Storage:** `describe-environment` showed the same bucket ID (`cb656224-d630-4bd5-b647-dccd44db0eaf`) in both environments, so bucket upload tests were **blocked/skipped** for safety.

### 2. Automated Regression & E2E Suites Executed (on Disposable Loopback PostgreSQL 18 DBs via `local-suite.sh`, `outbound=0`)

| Suite | Passed | Failed | Skipped | Notes |
|---|---|---|---|---|
| `arab-markets-readiness.test` | 22 | 0 | 0 | All 22 Arab markets verified |
| `arab-markets-pre-legal.test` | 29 | 0 | 0 | All 22 Arab markets in `PRE_LEGAL` + suspended/closed checks |
| `commerce.test` | 24 | 0 | 0 | Core marketplace & pricing invariants |
| `commerce-journey.test` | 8 | 0 | 0 | Full lifecycle + concurrent last-unit purchase + stock guard |
| `conversation.test` | 29 | 0 | 0 | Multi-turn structured search, drafts, recovery |
| `arabic-understanding.test` | 3 | 0 | 0 | Arabic dialects & negation |
| `g2-smart-conversation.test` | 16 | 0 | 0 | `G2-01`..`G2-07`, `S-G01`..`S-G04` grounded AI turns |
| `wave08-cash-and-refunds.test` | 12 | 0 | 0 | Requires `BDINAR_WAVE4_ACCEPTANCE=development` |
| `closure-privacy.test` | 12 | 0 | 0 | Privacy rights & data isolation |
| `closure-ai-cost.test` | 19 | 0 | 0 | AI spend & usage caps |
| `closure-notifications.test` | 7 | 0 | 0 | Template-only notifications |
| `closure-integrations.test` | 9 | 0 | 0 | Billing & appeals state machines |
| `promotions.test` | 6 | 0 | 0 | Campaign eligibility & admin-only config |
| `location-policy.test` | 1 | 0 | 0 | Street-term privacy |
| `r5-delivery-economics.test` | 3 | 0 | 0 | SAR/JOD/KWD minor-unit fare arithmetic |
| `monitoring.test` | 5 | 0 | 0 | 5xx redaction & boundary |
| `business-delegations.test` | 4 | 0 | 0 | D4/D5 delegation & revocation |
| `security-acceptance.test` | 8 | 1 | 0 | All 8 API security checks passed; 1 browser XSS check failed due to `NO_CHROMIUM` in Railway sandbox |
| **Total** | **217** | **1** | **0** | **99.5% pass rate (only failure is missing Chromium in sandbox)** |

### 3. Remaining Blockers & Limitations
1. **Live Gate Browser & Multi-User Tests (`fcm-isolated`):** Blocked because `jassimai-acceptance-gate` Basic Auth credentials are not provided, `fcm-isolated` has `0` users/admins, and `POST /api/admin/markets/arab-readiness/verify` has not been run in `fcm-isolated`.
2. **Browser Chromium Suites (`artifacts/dinar/test/*.mjs`):** Blocked in Railway sandbox (`NO_CHROMIUM`) and in IDE webview (`USER_TAKEOVER`).
3. **Production Readiness Assessment:** Core API, 22 Arab markets (`PRE_LEGAL`), security headers, CORS/413 guards, and database isolation are **verified healthy**. Before full live-gate E2E sign-off, run Chromium browser XSS/UI suites and verify `fcm-isolated` gate with test identities.
