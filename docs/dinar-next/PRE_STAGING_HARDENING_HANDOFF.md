# DINAR pre-staging hardening handoff

Date: 2026-11-08
Base: `995d2e57b94bfe552d25e902137c584e554b8114`
Isolated branch: `codex/dinar-next-functional-audit`

This work is isolated from the active workspace, the Claude candidate, the documentation branch,
and the governance draft. It is local-only; review and cherry-pick it explicitly if desired.

## Implemented locally

- Account closure deletes only valid UUID-owned `visual-search/<account>/` objects. It does not
  delete listing photos or avatars through this path. Storage failures are logged without undoing
  the account closure.
- Buyer visual-search photos expire after **24 hours**. An initial sweep runs at API startup and
  repeats hourly. Only well-formed visual-search object paths with an old storage creation time
  are eligible. Failed sweeps are logged and retried at the next interval.
- The Replit and S3-compatible storage adapters expose scoped object listing and creation time.
  Synthetic S3 tests cover prefix isolation, the S3 listing route, and expiry metadata.
- For S3, the adapter's expiry age baseline is `LastModified` because S3 does not expose a
  separate creation timestamp. The visual-search ACL completion copy can reset that timestamp,
  so its 24-hour window starts no earlier than completion.
- Responses served by a deployment labelled `DINAR_DEPLOYMENT_ENV=staging` carry
  `X-Robots-Tag: noindex, nofollow, noarchive`. This applies to the app shell, static assets, and
  API responses; it does not replace authentication or weaken the API's existing access checks.
- Staging/production OpenRouter traffic must use the OpenAI-compatible route with an explicit,
  non-free model, exactly one provider in its routing order, `DATA_COLLECTION=deny`, `ZDR=true`,
  and `REQUIRE_PARAMETERS=true`. Direct `OPENROUTER` aliases/free routing and free fallback
  models are rejected before a provider request.
- The Docker build prunes development dependencies offline only after the web and API builds.

The 24-hour photo lifetime is an operational default for temporary buyer-search uploads, **not**
an approved launch-country legal retention schedule. Confirm it with the launch-market privacy
review before staging rollout.

## Recommendations only — no external action taken

### SMS sandbox

The existing `PhoneVerificationProvider` contract is `sendCode(normalizedPhone, code)`. Staging
accepts only a server-registered `SANDBOX` adapter; no vendor is currently registered, and
readiness remains fail-closed until one is configured.

Twilio's official [test-credentials documentation](https://www.twilio.com/docs/iam/test-credentials)
describes Messages API requests that do not charge the account or connect to real phone numbers.
It also says test messages do not trigger status callbacks, and that new test credentials cannot
be created in the current console. That makes existing legacy test credentials useful only for
testing the outbound Messages API request/result contract—not delivery, callback handling, or the
complete OTP user journey.

Recommendation: do not create credentials or activate a vendor now. If suitable existing test
credentials are later approved, restrict them to synthetic numbers and a staging-only `SANDBOX`
registration. Keep the complete OTP success/expiry/replay test on a local fixture adapter whose
code is available only to the test harness, never returned to staging clients. Re-check country
coverage, sender-ID registration, message pricing, and vendor terms before choosing a real SMS
provider.

### Gemma paid acceptance budget

The local acceptance suite is provider-free. It verifies request construction, tool schemas,
privacy controls, failure handling, and model-substitution refusal through a loopback stand-in;
it does not establish Arabic quality or live provider eligibility.

Recommended later paid run, subject to a separate owner approval:

| Limit | Proposed value |
| --- | ---: |
| Candidate | `google/gemma-4-31b-it` |
| Task set | Existing 24 synthetic benchmark turns |
| Provider calls | 24 maximum |
| Repetitions / retries / concurrency | 1 / 0 / 1 |
| Input / output ceiling | 8,000 / 1,000 tokens per call |
| Image requests | **0** in this run |
| Budget status | **PROPOSED — NOT AUTHORIZED; $0.25 maximum** |

The official [OpenRouter model page](https://openrouter.ai/models/google/gemma-4-31b-it) currently lists
standard endpoint rates up to approximately $0.75 per million input tokens and $1.15 per million
output tokens among the endpoints shown. Using those separate maxima conservatively:

`24 × (8,000 × $0.75 + 1,000 × $1.15) / 1,000,000 = $0.1716`

The $0.25 proposal leaves room for rounding and provider-rate changes, but is not approval to
spend. Before any run:

1. Re-check the chosen provider's current price and ZDR eligibility; pin exactly that one provider.
   Do not assume the locally tested `deepinfra` route is approved for real user data.
2. Refresh the dated model-price contract and confirm the benchmark plan's computed worst case is
   at or below $0.25. The checked-in Gemma benchmark snapshot predates the current endpoint table.
3. Use a dedicated OpenRouter key with a $0.25 key credit limit and no unrelated traffic. Check the
   account's documented credit/balance view and `GET /api/v1/key` for positive credits, remaining
   key limit, and enough available spending headroom to cover one maximum request (approximately
   $0.00715 at the rates above). $0.25 is the proposed available balance, not a claimed OpenRouter
   minimum.
4. Keep image requests at zero. OpenRouter's [limits documentation](https://openrouter.ai/docs/api-reference/limits)
   says its in-flight estimate does not include image pricing. If vision quality must be measured,
   first confirm the pinned endpoint's image billing and provider-side cap, then request a separate
   budget approval.
5. Use the existing benchmark's owner-approval record and durable ledger. The local cost ledger is
   not itself a provider billing cap. The test runner is designed not to run in a deployment.

Required deployment route settings remain explicit: `DINAR_AI_PROVIDER=OPENAI_COMPATIBLE`,
`DINAR_AI_BASE_URL=https://openrouter.ai/api/v1`, one reviewed
`DINAR_AI_PROVIDER_ORDER`, `DINAR_AI_DATA_COLLECTION=deny`, `DINAR_AI_ZDR=true`, and
`DINAR_AI_REQUIRE_PARAMETERS=true`. No provider key, inference, or route activation was used here.

### Railway S3-compatible storage

The S3 adapter was exercised against the synthetic loopback server with signed requests. No Railway
Bucket was created, no credentials were issued, and no files were copied.

Before an approved staging cutover:

1. Create separate staging and production buckets and credentials only after environment ownership,
   region, access policy, and budget are approved. Keep the existing Replit store as the source of
   truth until cutover is verified.
2. Configure the S3 adapter per environment using
   `OBJECT_STORAGE_PROVIDER=s3`,
   `OBJECT_STORAGE_S3_ENDPOINT`,
   `OBJECT_STORAGE_S3_REGION`,
   `OBJECT_STORAGE_S3_BUCKET`,
   `OBJECT_STORAGE_S3_ACCESS_KEY_ID`,
   `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`,
   `OBJECT_STORAGE_S3_PRIVATE_PREFIX`, and
   `OBJECT_STORAGE_S3_PUBLIC_PREFIXES`. Store credentials through the platform secrets flow; do
   not put values in this repository or logs.
3. Keep private search uploads—including `visual-search/`—private. Do not add that namespace to
   public prefixes. Configure bucket CORS for only the approved app origin and the methods/headers
   needed for signed uploads. Add only the configured S3 endpoint to the browser connect allowlist.
4. Before copying, inventory object counts, sizes, paths, content types, ACL metadata, and current
   public/private behavior. Copy while preserving object names and required metadata; compare
   counts and checksums, then verify signed PUT/GET, ranges, ACL checks, deletion, list pagination,
   avatar resolution, listing photos, and search-photo expiry using synthetic data.
5. Cut over only after those checks pass in staging. Use a write freeze or an explicitly reconciled
   final delta so writes cannot diverge between stores. Keep the original store unchanged through a
   defined rollback window. Roll back only while the source is authoritative or after a verified
   reverse sync; do not delete the original objects as part of the initial cutover.

See the existing [integration plan](DINAR_INTEGRATIONS_MASTER_PLAN.md) and its Railway
[bucket documentation](https://docs.railway.com/storage-buckets) references for provider-specific
setup and operational constraints.

### Guarded `migrate:release`

Recommendation: use `pnpm --filter @workspace/db run migrate:release` as Railway's staging
pre-deploy command only after staging DB identity, backup, and release approval are confirmed.
First run with `DINAR_MIGRATION_DRY_RUN=1`, then inspect the pending migration plan. The runner
requires PostgreSQL 18+, verifies the checked-in release manifest and target identity, takes an
advisory lock, checks the applied-ledger prefix, and refuses unreviewed destructive SQL.

Staging must explicitly set:

- `NODE_ENV=production`
- `DINAR_DEPLOYMENT_ENV=staging`
- `DINAR_MIGRATION_TARGET=staging`
- `DINAR_MIGRATION_ACK=APPLY_STAGING_MIGRATIONS`
- `DINAR_MIGRATION_EXPECTED_DATABASE=<exact staging database name>`
- `DATABASE_URL=<staging database URL>`

Do not provide `DINAR_DEV_DATABASE_URL` to the release command. Production requires a separate
backup and owner approval, `DINAR_DEPLOYMENT_ENV=production`,
`DINAR_MIGRATION_TARGET=production`, and
`DINAR_MIGRATION_ACK=APPLY_PRODUCTION_MIGRATIONS`; do not promote staging credentials or target
names into that run. Do not use schema push, manually edit the migration ledger, or automatically
retry a failed migration. Investigate the recorded phase and resolve forward under the same
explicit target controls.

No staging or production migration was run.

## Verification evidence

- `pnpm run build` — passed, including workspace typechecks and API/web builds. Vite emitted a
  non-blocking large-chunk advisory.
- Isolated local suites — all passed with `outbound=0`: visual search 11/11, OpenRouter readiness
  10/10, staging noindex/auth 16/16, S3 wire 9/9, and account-closure privacy 12/12.
- `node --test scripts/ci/docker-runtime.test.mjs` — 2/2 passed.
- `git diff --check` — passed.
- Docker image build — **NOT VERIFIED**; only static Docker checks ran.
- G33 Docker acceptance — **NOT VERIFIED**.
- Railway S3 integration — **NOT VERIFIED**; only a synthetic loopback S3 server was exercised.
- Live Gemma inference, including vision — **NOT VERIFIED**; no paid test ran. The proposed run's
  zero image requests do not qualify live visual search.

## Not done

No push, merge, deploy, Railway provisioning, DNS change, production-data access, live SMS,
paid inference, provider activation, or marketplace/financial-policy change occurred. Docker G33
acceptance was not run in the shared Replit environment.
