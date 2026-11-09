# DINAR staging: external integration readiness

Base: reviewed Railway candidate `acc7c67`. Branch: `claude/dinar-staging-integrations` (local, not pushed).
Nothing in this branch is deployed, and no provider is activated.

## 1. SMS phone verification: Twilio adapter (disabled until configured)

### Design

`src/lib/sms/twilio-messaging.ts` delivers DINAR's own verification code.
- **DINAR keeps:** code generation, HMAC hashing, the 10-minute TTL, 5 attempts and the DB-backed rate limits (`lib/auth.ts`).
- **Twilio only delivers** the message, through a Messaging Service. Twilio picks the sender registered for each destination country.

### Twilio Verify was reviewed and not used, for these reasons

- Verify generates its own code. Keeping DINAR's code needs Verify **custom codes**, which Twilio enables only on request ("not available for all customers").
- With custom codes, Twilio requires a status report back after the user verifies. DINAR deliberately stores only the phone *hash* and no verification SID. Supporting that would need a schema change, and it is not needed when DINAR checks the code itself.

### Activation is gated in layers

- `DINAR_PHONE_VERIFICATION_PROVIDER=twilio-messaging`: without it, nothing registers.
- All settings must be valid. Otherwise only the *names* of the bad settings are logged, and `/api/readyz` stays `phoneVerification: not_configured`.
- Staging registers in `SANDBOX` mode and **sends only to numbers on `DINAR_SMS_STAGING_ALLOWLIST`**. This protects against SMS pumping and arbitrary sends.
- Production registers `LIVE` mode, which `phone-verification.ts` still refuses unless `DINAR_LIVE_PROVIDERS_ENABLED=true`. A staging allowlist present in production is rejected.

### Request safety

- It uses a restricted **API key** (`SK…`), never the account auth token.
- Destinations must match `DINAR_SMS_ALLOWED_COUNTRY_PREFIXES` (e.g. `+962,+965`).
- 10 s timeout, `redirect: "error"`, `ValidityPeriod=600`.
- Errors carry the Twilio error code only: never the phone, the code or the provider's response body.

### Settings

All are sealed Railway variables on `dinar-staging-app`.

| Name | Value |
|---|---|
| `DINAR_PHONE_VERIFICATION_PROVIDER` | `twilio-messaging` |
| `TWILIO_ACCOUNT_SID` | `AC…` |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | restricted API key |
| `TWILIO_MESSAGING_SERVICE_SID` | `MG…`, with registered JO/KW senders |
| `DINAR_SMS_ALLOWED_COUNTRY_PREFIXES` | `+962` (add `+965` once Kuwait is registered) |
| `DINAR_SMS_STAGING_ALLOWLIST` | the owner's 2–3 test numbers, E.164 |

### Country delivery requirements (Twilio's guidance; confirm in the Console before relying on it)

- **Jordan:** a pre-registered alphanumeric Sender ID is recommended. Zain and Orange block generic Sender IDs, and dynamic Sender IDs are overwritten.
- **Kuwait:** Sender ID registration is required for Zain and Ooredoo. Since 15 Sep 2026, unregistered Sender IDs to those networks are blocked.
  - Documents: operator NOCs, an LOA and a trade licence for domestic entities.
  - Fee: $95 one-time for domestic customers.

### Tests

`test/twilio-sms-adapter.test.ts` (7 cases, no network) covers:
- settings validation (names only);
- request shape (API-key Basic auth, Messaging Service, no `From`, 600 s validity);
- allowlist and country refusals;
- error redaction and the network/timeout path;
- registry gating (selection, SANDBOX vs LIVE, the staging registration never serving production, the live-provider switch).

## 2. AI model with a $5/month staging cap (not activated)

The existing gates already fail closed:
- `lib/ai-spend.ts` refuses every paid call in staging (`SPEND_BUDGET_UNCONFIGURED`) until the commercial policy sets `spend.global.limitMicros`;
- a call to an unpriced model is refused under `unpricedModel: "REFUSE"`;
- the gateway rejects free or alias OpenRouter routes in staging, so the route must be pinned.

`deploy/staging/ai-staging-policy.json` is a ready-to-submit `aiUsage` policy:
- **USD 5,000,000 micros ($5) per calendar month**, platform-wide;
- per-plan and per-account caps of $5 or less;
- an unpriced model is refused;
- guests get 5 text requests and no agent tasks;
- a daily global guard of 500 requests / 2M tokens;
- `approved: false`, because the owner flips approval.

`test/staging-fixtures.test.ts` validates it against `AiUsagePolicySchema`.

Activation steps, after owner approval:
1. Create the OpenRouter key with a **provider-side credit limit of $5**, as the second cap.
2. Admin: `POST /admin/ai/model-prices` with the model's published per-million-token prices (`source: PROVIDER_PUBLISHED`, plus a URL reference).
3. Admin: `POST /admin/commercial-policies` with the policy file.
4. Set the gateway variables (pinned `OPENAI_COMPATIBLE` OpenRouter route with ZDR and data-collection deny, as covered by `gemma-gateway-readiness`). `DINAR_LIVE_PROVIDERS_ENABLED` stays unset in staging.

## 3. Jordan staging market through the existing governance workflow

Market activation (`assertCountryActivationReady`) requires all four of:
- counsel approval APPROVED;
- owner approval APPROVED;
- technical verification PASSED;
- activation ACTIVE.

It runs through `/admin/compliance/country-readiness/:marketId/*`:
1. evidence;
2. review request;
3. topic reviews;
4. counsel review;
5. counsel approval;
6. owner approval;
7. technical verification;
8. activate.

**Separation of duties is enforced in code.**
- Counsel review and approval can only be recorded by accounts listed in `DINAR_COUNSEL_REVIEWER_IDS` / `DINAR_COUNSEL_APPROVER_IDS`.
- Owner approval can only be recorded by accounts listed in `DINAR_LEGAL_OWNER_IDS`.
- The same account can never hold both roles.

`deploy/staging/jo-staging-market-evidence.json` holds:
- 15 synthetic evidence items, one per topic (`STAGING_SYNTHETIC_PLACEHOLDER`, `STG-JO-nn`), which claim no legal review;
- **no `COUNSEL_FINDINGS`**, which only the designated counsel may author.

`test/staging-fixtures.test.ts` validates every item against `SubmitAdminCountryLegalEvidenceBody`.

## 4. End-to-end browser journey

`artifacts/dinar/test/staging-e2e-journey.mjs` uses real Chromium and the public API from the real page (cookies, Origin and JSON-only CSRF rules apply).

| Area | Checks |
|---|---|
| Preconditions | readiness, including SMS; the market is active through governance |
| Seller | SMS challenge → operator-typed code → register → logout → login; listing-photo presigned PUT **from the browser to the bucket (CORS)** → complete; create the listing |
| Buyer | the same auth flow; conversation search shows the **card**; cart; simulated checkout → order |
| Both | the order is visible to buyer and seller; a stranger can't change the listing; no overflow at 390 px |

Staging run:
`STG_BASE=https://dinar-staging-app-staging.up.railway.app STG_SELLER_PHONE=+962… STG_BUYER_PHONE=+962… node artifacts/dinar/test/staging-e2e-journey.mjs`

**Loopback rehearsal:** `test/staging-rehearsal-browser-journey.test.ts` runs the same script against:
- the local app;
- the development SMS adapter;
- the loopback S3 store;
- the fixture JO market.

Result: **26/26 checks passed, 0 outbound.**

**Visual search** is not part of the staging journey: no VISION provider is registered for staging, as the capability registry states. The camera flow stays covered locally by `camera-search-browser-journey`.

## 5. Payments: subscriptions and paid advertising only (sandbox)

- **Buyer checkout stays SIMULATION_ONLY.** No payment provider handles order money.
- **SUBSCRIPTION_BILLING:** the lifecycle state machine and signed, idempotent webhook intake exist. Without a registered provider it answers `BILLING_PROVIDER_NOT_CONNECTED`, and in production refuses unless `DINAR_LIVE_PROVIDERS_ENABLED=true`.
- **Needed:**
  - a provider adapter registered for `SUBSCRIPTION_BILLING` (staging `SANDBOX`);
  - test-mode secret key and webhook signing secret as sealed variables;
  - the provider's test-mode webhook pointed at the staging origin;
  - paid advertising (promotions) charged through the same billing adapter.
- **Owner choice:** a provider supporting JO/GCC subscriptions in test mode (e.g. Stripe, Tap or HyperPay).

## Verification on this branch

- `pnpm run typecheck`: 0 errors.
- `twilio-sms-adapter`: 7/7.
- `staging-fixtures`: 2/2.
- `staging-rehearsal-browser-journey`: 26/26 checks.
- Regressions: `readiness` 15/15, `api` 63/63, `security-acceptance` 12/12.
- All on loopback PostgreSQL 16, with 0 outbound requests.
