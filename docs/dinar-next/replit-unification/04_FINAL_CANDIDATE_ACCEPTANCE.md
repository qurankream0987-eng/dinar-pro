# DINAR NEXT — final candidate acceptance

- **Date:** 2026-11-04
- **Candidate branch:** `replit/dinar-next-six-wave-unification`
- **Pull request:** Draft PR #5, based on `replit/dinar-next-complete-development`
- **Base before closure changes:** `f2f19f5cfa18ff305aed5aee32b9459f7011eb77`

## Decision

**Critical internal acceptance passed on frozen implementation SHA `f4981d8ddaf11284641ef6b43edb3603e1cf9110`.** G33 passed on PostgreSQL 16 and 18, and the final-SHA browser, security, and OpenAPI checks passed. This is not full-suite, production, deployment, merge, or launch approval. The local Docker replay remains unavailable in this workspace; work remains confined to the candidate branch and Draft PR #5.

## Candidate changes

- Require approved country legal intake before an administrator can set a market to `ACTIVE` or `LIMITED`; lock the market and intake state in the same transaction.
- Preserve strict order-to-line reconciliation: migration 0056 keeps existing order rows on legacy version 0, requires version 1 for new inserts, and protects the financial snapshot and order items from later mutation.
- Handle idle PostgreSQL client errors without terminating the API or logging connection details; drain the server, stop background maintenance, and close the pool on shutdown.
- Keep Arabic basket navigation separate from listing searches and update affected acceptance fixtures.
- Add a production Dockerfile and ignore rules. The image built successfully and its offline runtime smoke passed. The local Docker database-connected replay remains unavailable; G33 GitHub Actions acceptance is recorded below.

## Validation completed

- `pnpm run build` passed workspace typechecking and all builds. Vite reported a non-blocking large-chunk advisory.
- Fresh PG18 release smoke applied all 57 reviewed migrations and passed 9/9. The populated migration rehearsal passed 12/12, including interrupted 0055→0056 retry, preservation of synthetic business/order/payment/dispute/ledger/audit history, idempotency, and refusal of divergent or tampered migration state.
- Fresh-environment legal guard smoke passed 9/9. Synthetic JO legal acceptance passed; no non-test market or remote market was changed.
- W02U3 reliability/accessibility automation, sessions, concurrency, expiry, recovery, and performance checks passed. Accessibility automation is not a manual screen-reader review.
- D15 acceptance passed 5/5; D15 money-model passed 11/11 after authorized synthetic JO setup in a disposable database.
- Financial-state-machine, payment-order-state, W07 journal, W08 cash/refunds, and cash-lock-order suites passed on disposable JO. Wave 4 passed 10/10 on a fresh JO/JOD database; the strict reconciliation assertion was not weakened.
- Readiness passed 15/15, shutdown/pool handling 1/1, and D16 readiness 4/4 on PG16 and PG18.
- The disposable PG18 outage/recovery rehearsal kept liveness at 200, returned 503 readiness during outage, recovered readiness after restart, logged idle-pool disconnects safely, exited on SIGTERM, and recorded zero outbound attempts.
- The Docker image built successfully. An offline container smoke of the built API runtime returned `healthz=200`, readiness 503 with the database unavailable, phone-verification 503, the disabled payment-simulation route 404, and a clean process exit.
- G33 Docker acceptance passed in GitHub Actions run `41814480105` at baseline `58b100af9d62b1ec067dca1fe35dc3c832288f47` on PostgreSQL 16 and 18. Both legs used the same 57-migration fingerprint, passed synthetic legal acceptance and the post-restart transaction journey, recorded zero outbound attempts, and left the migration ledger unchanged. This is historical baseline evidence; the frozen implementation result is recorded next.
- G33 Docker acceptance also passed in GitHub Actions run `41821045947` at frozen implementation SHA `f4981d8ddaf11284641ef6b43edb3603e1cf9110`; both PostgreSQL legs and preflight completed successfully.
- On that frozen SHA, SC01/SC03/SC07/SC10 and D3-A browser checks passed, security acceptance passed 12/12, OpenAPI coverage passed 2/2, and the earlier three-run browser batches and D16/D17 suites passed on the same application/test tree. All disposable acceptance suites recorded zero outbound attempts.

## Explicitly unresolved

- The local Docker database-connected replay remains blocked: the environment could not start a second client container in the shared network namespace or execute inside the PostgreSQL container; internal-network host-port publishing was unavailable. The release runner rejected a Unix-socket host override, so no migration was applied in that local Docker attempt. This does not negate the separate passing G33 CI run above.
- The Docker smoke did not establish readiness: its response reported `database=unavailable`, `migrations=unchecked`, `configuration=invalid`, and `phoneVerification=not_configured`. It must not be represented as database or checkout acceptance.
- Manual screen-reader testing, external legal signoff, live payment-provider behavior, and external launch readiness remain out of scope and unverified.

## Safety and test-data note

No Railway resource, production database, deployment, or paid/live provider was used. The isolated legal and financial suites used disposable loopback databases, which are dropped by the suite runner. Docker used `network none` for its runtime smoke, with no real provider credentials.

One earlier release-smoke attempt, before the administrator legal-intake guard was added, activated JO inside a disposable loopback database. That database was dropped; no remote or production market was changed. The final release smoke after the guard confirmed that activation is refused and every market remains inactive.

Supporting evidence is in `04_FINANCIAL_INTEGRITY.md`, reports `05`–`12`, and the current authoritative matrix in `13_CAPABILITY_COMPLETENESS_MATRIX.md`. The frozen implementation passed G33; the local Docker replay and external launch work remain separate and unverified.
