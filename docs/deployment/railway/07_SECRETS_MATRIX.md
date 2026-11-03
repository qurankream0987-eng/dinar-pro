# 07 — Secrets matrix

**Status:** No Railway app variables or secrets were created. Values below are names and handling
rules only; no credential values belong in this repository or report.

## Required for a future staging app

| Name | Handling |
|---|---|
| `PORT` | Railway-injected; do not pin |
| `NODE_ENV` | Image sets `production` |
| `DINAR_WEB_DIST` | Image sets built web directory |
| `DINAR_DEPLOYMENT_ENV` | Set to `staging` only in the approved staging service |
| `DATABASE_URL` | Secret/private staging PostgreSQL URL; obtain only after service identity and TLS are verified |
| `DINAR_DEV_DATABASE_URL` | Must be absent from deployed environments |
| `SESSION_SECRET` | Secret; at least 32 characters; generate and store through the platform secret flow |
| `OBJECT_STORAGE_PROVIDER` | `s3` outside Replit |
| `OBJECT_STORAGE_S3_ENDPOINT` | Approved HTTPS S3-compatible endpoint |
| `OBJECT_STORAGE_S3_REGION` | Owner-selected bucket region |
| `OBJECT_STORAGE_S3_BUCKET` | Separate private staging bucket |
| `OBJECT_STORAGE_S3_ACCESS_KEY_ID` | Least-privilege staging identity; secret |
| `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY` | Matching secret |
| `OBJECT_STORAGE_S3_PRIVATE_PREFIX` | `private` unless owner approves another prefix |
| `OBJECT_STORAGE_S3_PUBLIC_PREFIXES` | Leave empty unless each prefix is explicitly approved |
| `APP_ORIGIN` | Exact approved HTTPS origin if explicitly configured; no origin is approved now |

## Optional integrations — not selected or authorized

`DINAR_PHONE_VERIFICATION_PROVIDER` may be set only after a phone adapter and vendor are registered
and approved. A vendor name alone does not activate an adapter. Phone-dependent operations must
remain unavailable until then.

Keep `DINAR_LIVE_PROVIDERS_ENABLED` unset/false and `DINAR_AI_MODEL_FALLBACK` unset/false until the
owner approves a provider, cost limit, data-processing terms, and a separate live acceptance test.
No Railway AI, SMS, email, maps, web-search, embedding, monitoring, or payment provider is selected
by this package. Do not guess provider-specific secret names before that decision.

## Injection and rotation

1. Confirm the exact Railway project, environment, and service before entering a value.
2. Use Railway's secret/settings interface; do not put values in Git, `.env` files, build args,
   shell history, migration output, or chat.
3. Restrict access to the service that needs each secret. Use distinct credentials per environment.
4. Rotate by adding the new value through the secret flow, restarting only the approved service,
   validating readiness, then revoking the old value after the owner confirms success.
5. Redact values from screenshots, logs, support tickets, and PR descriptions.

Do not transfer Replit object-storage paths, Replit AI integration credentials, development
database URLs, benchmark keys, or Railway control-plane credentials into the deployed application.
No secret value was accessed or disclosed in this task.
