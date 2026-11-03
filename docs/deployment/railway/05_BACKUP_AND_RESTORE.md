# 05 — Backup and restore

**Status:** `UNVERIFIED`; enabling PITR or restoring a Railway resource is outside this task.

## Evidence

The available Railway read-only connector did not expose backup schedules, snapshots, PITR
configuration, archive health, retention, or restore history. The environment showed no bucket and
no obvious `WAL_ARCHIVE_*` variable names, but neither observation proves that backups are disabled.
No backup job or restore point was verified.

Railway documents that enabling PITR creates a bucket, adds service variables, and redeploys the
database service. Those changes were not made.

Railway's PostgreSQL PITR documentation describes continuous WAL upload, weekly full and daily
differential backups, retention of the last four full backups, and a 5 GiB queue that can limit the
recovery window during sustained archive outages. These are documented product behaviors, not
evidence that PITR is enabled or healthy for DINAR.

Sources: [Railway PostgreSQL PITR](https://docs.railway.com/volumes/point-in-time-recovery) and
[Railway storage bucket billing](https://docs.railway.com/storage-buckets/billing), checked
2026-11-03.

## Proposed recovery objectives

| Objective | Proposal | State |
|---|---|---|
| RPO | 15 minutes or less | Proposed; not validated |
| RTO | 4 hours or less | Proposed; not validated |

Do not advertise either objective until an owner-approved restore drill measures it.

## Restore runbook (future, approval required)

1. Confirm the correct environment, source service, owner authorization, approved recovery point,
   legal/data scope, and incident lead.
2. Verify the selected backup/PITR point and archive health in Railway. If status or point-in-time
   is unclear, stop.
3. Restore into a **new, isolated PostgreSQL service** in the approved environment. Never restore
   over or delete the source service.
4. Keep the restored service private and disconnected from live application traffic.
5. Verify server version, TLS identity, schema/migration ledger, and only the minimum non-sensitive
   integrity checks needed. Do not export customer rows or copy the restore into development.
6. Record elapsed RPO/RTO evidence, data-loss window, validation outcome, and owner sign-off.
7. Cut over only through a separate approved change. Retain the source until the owner confirms the
   recovery and rollback plan.
8. Remove a temporary restored resource only after explicit owner approval and evidence retention.

No restore rehearsal was run in this task. PITR was not enabled, no bucket was created, and no
Railway data was changed.
