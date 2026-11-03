# 08 — Security review

**Status:** Preparation controls are documented; live Railway security posture is not fully verified.

## Findings

1. **Public database path:** an active public TCP proxy was observed. Its address is omitted. Do not
   use it for runtime or tests. The owner must approve whether it remains; any restriction/removal
   requires a private app-to-database path to be verified first.
2. **No app service or bucket:** the inspected environment has no DINAR runtime service or bucket.
   No production domain or app traffic was enabled.
3. **Backup evidence:** backup/PITR/retention/archive health and restore history are `UNVERIFIED`.
   Do not treat missing variable names as proof that backups are disabled.
4. **Database history:** a prior read-only report recorded 28/51 migrations on the development
   database. Current ledger state is `UNVERIFIED`; do not attach the app or migrate it.
5. **Document handling:** no scanner or automated retention/orphan cleanup is registered. Real
   business-verification documents must remain blocked until legal retention, scanning, and erasure
   controls are approved.
6. **Session and origin controls:** the local same-origin suite passed 8/8, including cross-origin
   write rejection. The signed-session/security suite was not fully accepted because its fresh
   database lacked approved active-market/price fixtures; see the local verification record.

## Required controls before staging

- Use a separate approved staging database and a private connection path.
- Keep the database proxy out of application configuration.
- Keep one app replica until scheduled maintenance work is made safe for multiple replicas.
- Keep user uploads private; use environment-specific storage credentials and an empty public-prefix
  list by default.
- Keep live providers, payments, and public domains disabled until separately approved.
- Do not log secrets, SQL parameters, session IDs, phone numbers, message bodies, or uploaded document
  contents.
- Keep production `SESSION_SECRET` private and distinct from development/staging.
- Deploy only an approved immutable release SHA; keep automatic production deployment disabled.

## Incident handling

Record environment, deployment SHA/ID, UTC time, endpoint, status code, and redacted symptom. Preserve
platform logs before changing configuration. If readiness fails, keep traffic blocked and inspect
only sanitized checks. Roll back the application image only through an approved release procedure.
Never reverse migrations or restore over a source database as an ad hoc response.

## Not performed

No penetration test, cloud configuration change, secret rotation, public-proxy change, bucket
creation, restore, or production deployment was performed.
