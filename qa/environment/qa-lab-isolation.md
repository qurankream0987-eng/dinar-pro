# qa-lab — environment and isolation proof (Claude, 2026-11-27 12:11–12:30 UTC)

| Item | Value |
|---|---|
| Environment | `qa-lab` (d39015ea-14e8-46b5-86dd-766ca6dd9e11), Railway fork of `production` |
| Expires | 2026-12-27 12:11 UTC (30 days) |
| App URL | https://jassimai-acceptance-gate-qa-lab.up.railway.app (HTTP Basic gate; credentials from the owner, never committed) |
| Deploy branch | `fork/d33eb4ba` (created from `claude/jassim-connect-universal-engine` @ c9477f5). Pushes to this branch redeploy qa-lab only |
| Database | `jassimai_production` on qa-lab's own `jassimai-production-postgres` (copy-on-write clone: starts with production's 2 owner accounts; new password) |
| Storage bucket | `jassimai-acceptance-ams-hhfz2e` (production uses `…-o9x5et`); app variables reference the qa-lab bucket via `${{jassimai-acceptance-ams.*}}` |

## Isolation tests
1. **Database marker** — inserted category `qa-isolation-marker-20261127121923-1639` directly into qa-lab's database.
   - qa-lab app `GET /api/categories` (private network): marker **present**.
   - production `GET https://jassimai.com/api/categories`: marker **absent** (8 categories). → PASS
2. **Storage** — qa-lab and production resolve to different physical buckets (`hhfz2e` vs `o9x5et`). → PASS. A write/read probe object test is still required from Antigravity before upload tests.
3. **External write paths reviewed and closed in qa-lab**

| Path | qa-lab state |
|---|---|
| Production DB | not reachable: env-private DNS, new DB password |
| Production bucket | app re-pointed to qa-lab bucket by reference |
| Nightly backup job (writes to backup bucket) | **disabled** (start command is a no-op) |
| Email (Resend) | `RESEND_API_KEY` emptied — no real email |
| Whop / billing | `WHOP_ENABLED=false`, `DINAR_WHOP_BILLING_ENABLED=false`, no Whop API key |
| Live providers / Connect live calls | `DINAR_LIVE_PROVIDERS_ENABLED=false`, `DINAR_CONNECT_LIVE_CALLS=false` |
| Origins | `APP_ORIGIN`/`JASSIMAI_PUBLIC_URL`/`APP_ADDITIONAL_ORIGINS` = qa-lab URL |
| AI model (DeepSeek) | **live and billed** on the same account as production — a cost, not a data path |
| Google sign-in | same OAuth client; qa-lab URL must be added as an authorised origin by the owner |

Production was not modified for any of this (only read-only public GETs against jassimai.com).

## Residual notes
- The clone contains production's 2 real owner accounts and their sessions; testers must not use or alter them.
- `SESSION_SECRET` and the gate credentials are inherited from production; they do not grant access to production data.
- The old `fcm-isolated` environment is kept (not deleted) until it expires on 2026-11-28 16:35 UTC; its rescued evidence is in `qa/evidence/run1-fcm-isolated/`.
