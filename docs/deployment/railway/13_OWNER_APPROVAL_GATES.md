# 13 — Owner approval gates

No owner approval to create resources, change networking, enable PITR, migrate a Railway database,
copy data, deploy DINAR, or merge this PR was provided. All cloud changes remain stopped.

| Gate | Required decision/evidence | Status |
|---|---|---|
| Railway target identity | Confirm project/environment and resolve the conflicting staged-patch status | `OWNER_APPROVAL_REQUIRED` / `UNVERIFIED` |
| Existing database access | Decide whether the current public TCP proxy is needed; approve any restriction only after private connectivity is tested | `OWNER_APPROVAL_REQUIRED` |
| Separate staging database | Approve service, database name, region, PostgreSQL version, private network, and budget | `OWNER_APPROVAL_REQUIRED` |
| Backup and recovery | Verify current backup/PITR/archive state; approve a restore into a new isolated service | `UNVERIFIED` |
| Unified migrations | Reconcile the Wave02 and D16 0051 histories on the approved unified release branch; pass fresh and upgrade tests | `BLOCKED` |
| Staging storage | Approve provider, region, private bucket, credentials, retention, malware/document scanning, and erasure policy | `OWNER_APPROVAL_REQUIRED` |
| Secrets | Approve exact variable names and secret owners; inject values only through Railway secret settings | `OWNER_APPROVAL_REQUIRED` |
| App deployment | Approve staging service, one-replica settings, healthcheck, HTTPS origin, and smoke-test scope | `PREPARED_NOT_DEPLOYED` |
| Optional providers | Approve sandbox vendors, data-processing terms, cost limits, and separate acceptance tests | `OWNER_APPROVAL_REQUIRED` |
| Production legal/commercial readiness | Approve country controls, payments, refund/dispute process, privacy, security, and consumer terms | `BLOCKED` |
| Production release | Approve exact SHA, backups, restore, migration plan, monitoring, spend ceiling, change window, and rollback authority | `BLOCKED` |
| GitHub delivery | Review the isolated branch and Draft PR; do not merge without a separate decision | `PREPARED_NOT_DEPLOYED` |

Approval must identify the exact environment, resource, operation, operator, and rollback boundary.
An approval for staging does not authorize production, and approval to prepare a migration does not
authorize applying it.
