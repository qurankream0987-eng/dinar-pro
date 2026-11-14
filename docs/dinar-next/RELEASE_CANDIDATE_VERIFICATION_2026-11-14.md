# JassimAI release candidate — verification report (2026-11-14)

Branch `claude/jassimai-release-candidate` (local, not pushed). Base: published
`claude/jassimai-ads-connect-closure` `ddfa15d`. Feature freeze. Disposable loopback databases only;
no Railway, no SMS, no payments, no market activation.

## 1. Inventory and reconciled results

290 test files: the 288 that existed at the start + `sms-staging-safety` and
`arab-markets-readiness` added by this verification. Status = the latest valid run of each file
(first pass in 3 workers; browser-dependent and special-setup files rerun serially).

| Result | Files | Individual tests |
|---|---|---|
| PASS | 274 | 2,297 |
| FAIL (product or test) | 14 | 14 |
| BLOCKED (environment) | 2 | — |
| Not executed / timed out | 0 | 0 |

Runner root cause of the first-pass browser failures: suites were split by whether the test file
itself mentions Chromium; many launch it through helper modules, so they ran without a browser.
Serial reruns with Chromium turned 16 of them green. Special setups (unseeded DB, named databases,
legal-fixture authorization) turned 5 more green. Original logs are kept separately from reruns.

BLOCKED: `personal-intelligence` (needs a dedicated PostgreSQL on port 55479 and a database URL
the isolation runner deliberately refuses; not bypassed) and `g33-docker-acceptance` (no Docker
daemon in this container). Neither is release-critical for the web product; both must run in CI
before production.

## 2. Baseline versus candidate

Every one of the 14 remaining failures also fails on the published base `5b121e6`: none was
introduced by this verification. They were investigated anyway:

| File | Cause | Impact |
|---|---|---|
| ai-foundation (AI-F07) | Design conflict: a later listing read deliberately replaces an earlier comparison; the test expects the comparison. Behaviour is safe (stop message + verified result). | Low; owner decision |
| contact-browser-microclosure | Contact became a default (chat only) in an earlier mission; the test still expects the old question. | Low (test stale) |
| hostile-input-performance (HIP-03) | One spam input reads differently from a hash-only golden; speed/safety checks pass. | Low |
| storage-s3-wire, storage-portability | Virtual-hosted S3 hostname refused by the isolation layer. | Environment |
| phase2-commission | Needs a legacy completed order the development seed lacks. | Test data |
| phase1, sc01, sc03, sc10, followup-sc01, command-e-ui, pre-switch | Long browser/stream journeys (timeouts, make-filter, stream stage). Known historical failures. | Needs follow-up before production |
| search-sql-foundation | SQL engine differs from the pre-C1 golden for two cases. | Needs follow-up |

## 3. Defects fixed in this verification

| Commit | Fix |
|---|---|
| `c798f90` | Owner decisions: 0 % driver commission on new agreements (migration 0065 widens the rate check only; history unchanged; earnings history shows 0 % trips); USD ad tariffs in the versioned policy, enforced at product creation |
| `b99940d` | **Security**: a deployment labelled staging/production can no longer return phone-verification codes in the API response when NODE_ENV was left at development |
| `8b900d7` | `ACCOUNT_STATUS` surface declared in the OpenAPI contract |
| `1edb590` | Brand: one model instruction and the Twilio test |
| `e19666a`, `f95a8c7`, `d7f60bf`, `87a7338`, `be2ae64` | Stale test expectations aligned with verified current behaviour (26th capability, `/terms`, grounded wording, category options, complete listing body); no assertion weakened |
| `72c9bea` | 22 Arab markets readiness test (disposable DB only) |

## 4. Arab markets (testing only)

All 22 pass end to end in a disposable database: activation refused without a signed legal
intake; with a test-only signed intake, registration with a local number, publication at ISO 4217
precision, refusal of finer prices, search, isolation from other markets, local ad price. 19 of the
22 markets have no legal intake row at all. Palestine is configured as EGP (no ISO national
currency) — unresolved, owner decision. Nothing was activated outside the test database.

## 5. Financial safeguards (re-verified)

Driver 0 % (block-f4-driver 48/48), historical 10 % snapshots unchanged, marketplace commission
unchanged, tariffs USD 5/7, 5/10, 2/7 with no conversion (advertising 5/5), billing disabled.

## 6. SMS (MOCK TESTED / LIVE NOT VERIFIED)

Required staging settings, read from source: `DINAR_PHONE_VERIFICATION_PROVIDER=twilio-messaging`,
`DINAR_DEPLOYMENT_ENV=staging`, `TWILIO_ACCOUNT_SID` (AC…), `TWILIO_API_KEY_SID` (SK…),
`TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID` (MG…), `DINAR_SMS_ALLOWED_COUNTRY_PREFIXES`,
`DINAR_SMS_STAGING_ALLOWLIST` (required in staging, refused in production); never
`DINAR_LIVE_PROVIDERS_ENABLED` in staging. sms-staging-safety 3/3 covers the selection matrix, no
code in staging responses, allowlist/prefix enforcement, wrong/expired/reused codes, attempt cap
(5) and per-number rate limit (20 per 15 min).

## 7. Verdicts

- **Staging: GO with conditions** — the candidate is stable for the tested scope; 14 known
  historical failures remain documented; providers stay mock until each live test is approved.
- **Production: NO-GO** — live SMS, payments and AI providers are not verified; the historical
  browser journeys (phase1, sc01/03/10) and search-sql equivalence need closure; legal intakes,
  Palestine currency, backups/restore and monitoring are not verified here.
