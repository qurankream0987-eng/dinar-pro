# Staging and provider status

This mission authorizes local engineering and read-only Railway staging inspection only.
No push, merge, deployment, production mutation, live SMS, live OAuth sign-in, driver activation,
commercial policy application or paid model call was performed.

## Observed Railway access

The attached environment reports `RAILWAY_TOKEN` present and ready. The token value was never
printed, written to the repository, or copied into instructions. The read-only metadata request
used the existing binding. A sandbox connectivity failure was retried with the supported outer
executor; the proxy refused `backboard.railway.com` with CONNECT HTTP 403. This is a network-policy
block, not evidence of an invalid credential. The owner subsequently instructed that Railway troubleshooting be postponed. No further connectivity attempts are planned.

Therefore deployed source SHA, actual staging environment/service identity, variable bindings,
SMS/Google readiness and staging HTTP health remain BLOCKED. GitHub integration head is not
claimed as the deployment SHA. No staging database connection was attempted.

## Repository readiness and unchanged external gates

- Guest default JO is already restricted to `DINAR_DEPLOYMENT_ENV=staging`; other environments
  retain the existing default. Closed markets remain selected and explain that commerce is
  unavailable instead of silently routing to another market.
- Phone verification outside development requires the registered deployment-matched SMS adapter;
  readiness fails without it. Development-only test behavior is not staging approval or a bypass.
- Google identity verifies signature/issuer/audience/expiry and verified email. It does not prove
  phone ownership. A valid protected client ID, authorized origin and Google's signing-key access
  must be configured for actual staging. No client ID or OAuth success was invented.
- Driver sharing remains deployment-gated, actor/assignment/order-scoped, revocable and expiring.
  No live location service was enabled.
- Jordan listing-price flexibility and versioned commercial policy were inspected and preserved.
  Historical one-unit market metadata is not a unilateral instruction to reprice listing/order
  snapshots. The existing guarded policy CLI remains operator-controlled; no policy was applied.
- Railway Docker configuration builds the existing API/web, runs as the non-root node user, and
  serves the built frontend through the API. Actual Railway health/pre-deploy settings require
  read-only service inspection once access is allowed. `/api/healthz` alone is not readiness;
  `/api/readyz` must validate DB, migration ledger, deployment settings and phone verification.
- All 63 migration SQL files and their journal/release manifest are unchanged. PostgreSQL 18.6
  release-runner tests, including concurrency and interruption/recovery, are separately recorded.

## Vision

The existing dedicated `DINAR_AI_VISION_*` OpenAI-compatible slot supports the configured
Gemini 2.5 Flash-Lite/OpenRouter route without replacing DeepSeek text chat. Staging/production
OpenRouter configuration requires one pinned provider, no fallbacks, `data_collection=deny`,
`zdr=true`, and parameter support. Returned model substitution is refused. These are verified
request/configuration contracts, not proof of the external provider's actual handling/retention.

Ordinary image questions and screenshots reuse the authenticated conversation route and private
visual-image ownership/validation/24-hour cleanup path. Image text is untrusted input. Answers
are model advice and cannot perform commerce or assert a server action receipt. Search photos
still use canonical marketplace search; seller listing photos retain their separate namespace.

Every non-injected vision call now needs a configured global budget and a concurrent-safe spend
hold. No configured cap means no call. Provider-reported input/output/cache token counts and
request/model IDs reach cost accounting; failed/unknown calls are not priced as zero, and unsent
calls release their holds. Settlement errors retain the hold for reconciliation and log only
safe metadata. No budget, price table, credential, provider or commercial terms were created for
actual paid operation. Live quality and operator-approved cost calibration remain BLOCKED.
