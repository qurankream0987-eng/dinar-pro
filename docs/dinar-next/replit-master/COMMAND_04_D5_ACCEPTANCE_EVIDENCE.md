# Command 04 — D5 Acceptance Evidence

## Tested implementation

- Starting SHA: `3b962027d09c3e4a2eedfa49e4edad6e00e96dc2`
- Tested source SHA: `bb037d896d51faf58a66b399b25058678bf2a9dc`
- Branch: `replit/dinar-next-complete-development`
- Database: isolated loopback PostgreSQL databases created by `test/isolation/local-suite.sh`; each suite dropped its database afterward. No managed or production database was used.

## Checks and results

| Check | Result |
|---|---|
| `pnpm --filter @workspace/api-spec run codegen` | PASS; generated client/Zod types and workspace library typecheck |
| `pnpm --filter @workspace/api-server run typecheck` | PASS |
| `pnpm --filter @workspace/api-server run build` | PASS |
| `local-suite.sh business-delegations.test BDINAR_D4_ACCEPTANCE=development` | PASS, 4/4; outbound=0 |
| `local-suite.sh ai-authority-boundary.test` | PASS, 4/4; outbound=0 |
| `local-suite.sh next-g2-inquiry.test BDINAR_G2_ACCEPTANCE=development` | PASS, 17/17; outbound=0 |
| `local-suite.sh g2-smart-conversation.test BDINAR_G2_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development` | PASS, 91/91; outbound=0; payment simulation stayed in the disposable test database |
| `local-suite.sh readiness.test development-tls.test` | PASS; readiness 15/15, development TLS 7 passed/0 failed; outbound=0 |
| Apply migration 0050 using the isolated suite prelude | PASS; the test databases were dropped |
| Target-checkout SAST / HoundDog | NOT_RUN |
| Target-checkout dependency audit | NOT_RUN |
| Chromium/browser D5 acceptance | NOT_RUN |
| Live model/provider acceptance | NOT_RUN |

The D5 suite uses an injected test gateway, not a live model. It verifies that an explicit Arabic invocation without a grant is denied before a model call; an authorized invocation creates a persisted session; a follow-up without invocation wording reuses that session; inventory reads require the granted capability; grant revocation invalidates the session and prevents another model call; market change, account switch, and logout invalidate sessions; owner stop ends the session; and D5 session/capability audit events are recorded. The same suite checks wrong-actor, wrong-market, expired-grant, and ambiguous-grant behavior. The test catalog is empty, so populated product facts and stock quantities remain unverified.

G2 suites ran with the test runner's provider keys removed and its outbound guard enabled. The G2 payment simulation was enabled only because that suite exercises the simulated payment review path; its loopback database was dropped afterward. No real payment, live message, live provider call, production check, browser UI change, or deployment was made.

## D5-01 through D5-25

The scenario-by-scenario source paths, direct test evidence, status, and database result are maintained in `COMMAND_04_D5_SELLER_CAPABILITY_MATRIX.md`. D5 remains **PARTIAL**; D6 has not started. Publication, refunds, financial commitments, private-contact disclosure, and bulk messaging remain unavailable to the intelligent employee.

## Runtime and browser evidence

The configured API workflow points to the workspace-root artifact rather than this nested target checkout, so it was not used as source validation. The target checkout passed its typecheck, build, and isolated database suites. No browser screenshot, authenticated UI journey, or production check is claimed.
