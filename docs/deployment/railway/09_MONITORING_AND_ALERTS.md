# 09 — Monitoring and alerts

**Status:** No DINAR app monitoring or alert integration was verified or configured.

## Available signals

- `/api/healthz`: process liveness only.
- `/api/readyz`: database reachability, expected migration ledger, essential configuration, and
  separately reported phone-verification configuration.
- Structured request logs: status and duration; database idle-connection failures now emit only a
  safe error code.
- Railway metrics: only the existing PostgreSQL service was measurable. The latest 168-hour
  hourly aggregation returned 169 samples; average RAM was about 0.06165 GB and average disk metric
  about 0.12255 GB. CPU/network units and disk scope remain uncertain.

There is no app-service latency/error baseline, configured alert destination, backup alert, or
verified monitoring account.

## Proposed staging alerts

Validate these provisional thresholds during staging; they are not currently configured:

| Signal | Provisional trigger | Response |
|---|---|---|
| Readiness | Three consecutive failed health checks | Keep traffic blocked; inspect DB, migration, and configuration checks |
| HTTP 5xx | More than 2% over 5 minutes after at least 100 requests | Review release logs and error class; do not expose request content |
| Database connections | More than 80% of the configured connection limit for 5 minutes | Check pool sizing and query saturation before scaling |
| Database storage | 70% warning / 85% critical of the verified data volume | Confirm the metric maps to the mounted volume before alerting |
| Backup freshness | Older than the accepted RPO (proposed 15 minutes) | Treat recovery objective as unmet; verify archive and restore point |
| Spend | 50%, 75%, and 90% of an owner-approved monthly ceiling | Pause optional resources/providers before the ceiling is reached |

The storage and spend triggers require owner confirmation and correct metric mapping. They must not
trigger automatic resource creation or database changes.

## Alert routing and incident notes

Choose an owner-approved notification channel after account access and data-handling terms are
reviewed. No paid monitoring provider is selected. Incident notes must omit secret values, session
cookies, phone numbers, message contents, and uploaded documents. Record release SHA, environment,
UTC time, health status, and sanitized error code.
