# JassimAI — isolated Staging deployment and Twilio SMS acceptance plan (2026-11-14)

Candidate: `claude/jassimai-release-candidate-2` `916f8e3` (published). Nothing in this plan has been
executed: every Railway change, deployment, key and message needs the owner's separate approval.

## 1. Battery on `916f8e3` (290 test files)

| Result | Files | Tests |
|---|---|---|
| PASS | 285 | 2,303 |
| FAIL | 3 | 3 |
| BLOCKED (infrastructure) | 2 | — |

Pass 1 ran in 3 workers: 233 passed. The other 57 were rerun one at a time (39 passed: the
browser stub binds port 443 and the fixture build is shared, so parallel browser suites collide).
13 more need their documented setup (unseeded, development seed, named database, built server,
browser) and passed with it. The pass-1 logs are kept separately.

| File | Status | Reason |
|---|---|---|
| hostile-input-performance (HIP-03) | FAIL | One spam input differs from a hash-only golden (known; speed and safety checks pass) |
| storage-s3-wire | FAIL (environment) | Virtual-hosted test hostname refused by the isolation guard; must pass against real S3 |
| storage-portability | FAIL (environment) | Same cause |
| personal-intelligence | BLOCKED | Needs its own PostgreSQL on 55479 |
| g33-docker-acceptance | BLOCKED | No Docker daemon in this container |

## 2. Model routing findings

- Catalog routing is disabled by default (`enabled: false`, no models). Staging today runs
  `bbfe8f3`, which has no catalog routing at all, and no policy script ever wrote a routing key.
  After the switch the policy therefore defaults to disabled and Staging keeps its configured
  provider (DeepSeek). The `structuredOutput` requirement cannot disable Staging unless a catalog
  is added later; then every catalog model must be marked `structuredOutput: true`, otherwise the
  turn is refused (no capacity, no silent fallback). Remaining check: one read-only query of the
  restored Staging policy when the isolated database exists.
- Context-window estimate (Replit `fe56c43`): counts UTF-8 bytes as tokens. Measured: 30.1k–43.8k
  estimated for requests of ~41k characters, about 3–4× the real token count; Arabic text is
  2 bytes a character. With the bounds in `model-turn.ts` (history 9,000, context 6,000, message
  4,000 characters) a long Arabic conversation estimates to roughly 80k. Confirmed defect for
  any catalog model with a window under ~96k: a 32k model refuses every request; a 64k model
  refuses long Arabic conversations that would fit. Not reachable today (no catalog). Minimal
  correction (not applied, needs approval): estimate `ceil(bytes / 2)` plus framing, still above
  the real count for Arabic and English, with a test that a long Arabic conversation passes a 64k
  window and J13's 12k refusal still holds. Until then: no catalog model below 128k.

## 3. Isolated Staging (does not touch `jassimai.com`)

Proposed: a new Railway environment `acceptance` in `dinar-development-canonical`.

| Resource | Setting |
|---|---|
| App | Source `claude/jassimai-release-candidate-2` at `916f8e3`, Dockerfile.railway, healthcheck `/api/healthz` |
| Domain | Railway-generated domain only; no custom domain; `APP_ORIGIN` = that domain |
| Database | New PostgreSQL 18 with a volume, restored from `pre-release-20261114` (`4aead5fc…`), then migrations 0063–0065 (accepted) |
| Storage | Separate bucket (or separate prefix) so test uploads never mix with Staging |
| `DINAR_DEPLOYMENT_ENV` | `staging` (SANDBOX SMS rules) |
| `NODE_ENV` | `production` |
| Payments | `SIMULATION_ONLY`; Whop off |
| Cost | One app and one database running for the acceptance period (approval needed) |

The public service, its database, domains, variables and source stay unchanged.

## 4. Twilio SMS

### Protections in `916f8e3` (verified by test)

| Protection | Evidence |
|---|---|
| A staging/production-labelled deployment never returns the code, even with NODE_ENV=development | sms-staging-safety SS-01/02 |
| Staging sends only to `DINAR_SMS_STAGING_ALLOWLIST` and `DINAR_SMS_ALLOWED_COUNTRY_PREFIXES` | SS-03 |
| Allowlist refused in production; LIVE only with `DINAR_LIVE_PROVIDERS_ENABLED=true` | SS-01 |
| Wrong, expired (10 min) and reused codes refused; 5 attempts; 20 requests / 15 min per number | SS-04 |
| No code in logs: the SMS modules log nothing; request bodies are not logged; cookies and authorization redacted | code review (`lib/logger.ts`, `lib/sms/*`) |

Gap: no delivery-status callback. Delivery is confirmed by reading the message status in Twilio
(read-only) during the test.

### Railway sealed variables (entered by the owner only)

| Variable | Value | Who |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | AC… | owner, sealed |
| `TWILIO_API_KEY_SID` | SK… (restricted API key) | owner, sealed |
| `TWILIO_API_KEY_SECRET` | secret | owner, sealed |
| `TWILIO_MESSAGING_SERVICE_SID` | MG… | owner, sealed |
| `DINAR_PHONE_VERIFICATION_PROVIDER` | `twilio-messaging` | Claude, after approval |
| `DINAR_SMS_ALLOWED_COUNTRY_PREFIXES` | e.g. `+962,+965` | Claude, after approval |
| `DINAR_SMS_STAGING_ALLOWLIST` | the owner's test numbers only | Claude, after approval |
| `DINAR_LIVE_PROVIDERS_ENABLED` | never set in this environment | — |

### Messaging Service (Twilio console)

1. Create one Messaging Service for the acceptance environment.
2. Add a sender (a number able to send to the approved countries, or an approved alphanumeric
   sender where the country allows it).
3. Geo permissions: allow only the approved countries.
4. Validity period: 600 s (matches the 10-minute code).
5. A restricted API key limited to sending messages.

### End-to-end test (after separate approval; one allowlisted number)

1. `POST /api/auth/phone-verification/challenges` for the allowlisted number: 202; the body has
   no `developmentCode` and no 6-digit number.
2. Twilio (read-only): the message for that request is `delivered`; record its SM id only.
3. Enter the code from the phone: 200 and a verification token.
4. Reuse the same code: 400.
5. A second challenge, wait more than 10 minutes, enter its code: 400 (expired).
6. Five wrong codes on a third challenge, then the right one: 400 (attempt cap).
7. A number outside the allowlist, and a country outside the prefixes: 503, nothing sent.
8. Rate limit: requests 1–20 within 15 minutes are accepted without sending more than the
   owner agrees to (stop after delivery is proven; request 21 must be 429, which can be checked
   against a non-allowlisted number so no message is sent).
9. Search the deployment logs for the code: no match.

Expected cost: two or three messages.

## 5. Integration readiness

| Integration | State | Before launch |
|---|---|---|
| PostgreSQL | Backup and restore verified; 0063–0065 accepted, not applied | Apply after a fresh backup |
| AI (DeepSeek) | Key on Staging; mock-tested | One live acceptance on the isolated deployment |
| Twilio SMS | Code and protections tested with a synthetic provider | Section 4 |
| Google OAuth | Client configured for Staging | Add the isolated domain to the authorised origins; one sign-in test |
| S3 (Railway bucket) | Bucket exists | storage-s3-wire and storage-portability against the real bucket |
| OpenRouter | Optional; pinned Gemma settings exist locally (`9730d0a`, not published) | Only if catalog routing is enabled; note the context-estimate defect |
| Whop | Adapter contract and fake-provider tests; billing disabled | Stays off; payments remain SIMULATION_ONLY |
| Maps | Driver location sharing without an external map provider | Browser check on the isolated deployment |
| Monitoring and alerts | Not configured | Required before public launch |
| Scheduled backups | One verified manual backup | Required before public launch |

## 6. Order of approvals

1. Create the isolated environment (app and database; costs).
2. Restore the backup into it and apply 0063–0065.
3. Deploy `916f8e3` there.
4. Owner adds the Twilio sealed variables; Claude sets the SMS settings.
5. The controlled SMS test (section 4).
6. Full acceptance on the isolated deployment; then a separate decision on the public service.
