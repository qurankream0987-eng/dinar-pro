# WAVE 05 — D13 / D14 / D15 evidence index

Branch `qoder/wave05-d13-d15-closure`. No merge, no deployment, no paid provider, no production database.

| Document | Covers | Headline |
| --- | --- | --- |
| [WAVE05_D13_PERFORMANCE.md](WAVE05_D13_PERFORMANCE.md) | query plans, latencies, history scaling, multi-replica index work, capacity, shutdown, synthetic load baseline | every measured path < 4 ms at the SQL layer on 20,000 offers; `SIGTERM` drain 26 ms; load numbers are runner-only |
| [WAVE05_D14_INTELLIGENCE.md](WAVE05_D14_INTELLIGENCE.md) | Arabic evaluation dataset, three modes, scoring and cost | scripted 38/38, recorded 6/10 contract-valid, live plan capped at $0.0288; language quality and dialect `NOT_MEASURED` |
| [WAVE05_D15_ACCEPTANCE.md](WAVE05_D15_ACCEPTANCE.md) | integrated buyer/seller/assistant/infrastructure/security journeys and the browser matrix | single-price commerce, seller dues, authority withholding and security pass; mixed-price, refunds, disputes, WebKit/Firefox and screen readers `BLOCKED` |
| [WAVE05_SECURITY_AND_FINANCIAL_CONSISTENCY.md](WAVE05_SECURITY_AND_FINANCIAL_CONSISTENCY.md) | the money gate, precision, idempotency, concurrency, privacy | Wave 01 + Wave 02 are **not** a valid combined money model (`mm11`, `mm20`, `mm20StrictReimposition`) |
| [WAVE05_INTEGRATION_REQUIREMENTS.md](WAVE05_INTEGRATION_REQUIREMENTS.md) | what Replit and Claude must do before integration | decide the order-money rule; reconcile `0051`–`0053` (wave06b); page conversation history; pool budget; `SIGTERM`; re-pin browser evidence |
| [WAVE05_GO_NO_GO.md](WAVE05_GO_NO_GO.md) | production recommendation | **NO-GO** for integrated commerce; **GO with conditions** for infrastructure, security and assistant authority |

Latest green load evidence: runs `41682386840` (pool 10) and `41683066149` (pool 20) at `fd23782`, 7/7 tests each, 5,000 JO listings; raw `WAVE05_LOAD_BASELINE` is in the job logs and the summary is `WAVE05_D13_PERFORMANCE.md` §7.

The table and run IDs above are source-branch evidence, not results for the unified candidate. Candidate-specific verification and the selected money strategy are recorded in the integration-candidate addendum in [WAVE05_GO_NO_GO.md](WAVE05_GO_NO_GO.md); the source branch's original findings remain preserved.

## Reproducing

- Profile: `wave05-d13-db-profile.test` with `BDINAR_WAVE05_PROFILE=development`
- Load: `wave05-d13-load-baseline.test` with `BDINAR_WAVE05_LOAD=development` (optionally `DINAR_WAVE05_LISTINGS`, `DINAR_DB_POOL_MAX`)
- Shutdown: `wave05-d13-shutdown.test` with `BDINAR_WAVE05_SHUTDOWN=development`
- Evaluation: `wave05-d14-evaluation.test` with `BDINAR_WAVE05_EVALUATION=development`
- Acceptance: `wave05-d15-acceptance.test` with `BDINAR_WAVE05_ACCEPTANCE=development`
- Browser: `command-e-ui.test`, `command-f-journeys.test`, `w02u3-card-accessibility-browser-journey.test`

All of them are dispatched through `.github/workflows/qoder-api-suite.yml` (closed allowlists, fresh loopback PostgreSQL per run, artifacts uploaded from `artifacts/api-server/*.log`).
