# DINAR Railway backup and PITR readiness

**Checked:** 2026-10-21  
**Scope:** Read-only metadata and official documentation review. No backup, restore, variable, service, or deployment action was taken.

## Exact target inspected

| Resource | Name | ID | Observed state |
| --- | --- | --- | --- |
| Railway project | `dinar-development-canonical` | `3810e583-cc70-434c-b6fa-9ea15779f3c1` | Identified |
| Environment | `development` | `4086de25-d270-4f39-89d1-93f611fe79c2` | Non-ephemeral |
| PostgreSQL service | `Postgres` | `6a02fe25-1305-437c-9fe7-b989836c8949` | Live; latest deployment reported `SUCCESS` |

The service metadata reports a live 500 MB volume in `iad` and no staged changes. No connection strings, passwords, or environment-variable values were requested or displayed. Production was not accessed.

## Findings

### BACKUP STATUS

**Not verified.** The Railway read-only service/environment metadata does not include volume-backup records or automatic backup schedules. The available Railway MCP tools expose no backup-list/status operation, and the Railway CLI is not installed in this workspace. No records were retrieved; this does **not** establish that no backups exist.

### PITR STATUS

**Not authoritatively verified; current metadata is consistent with PITR being off.** The inspected environment reports no Railway storage buckets, and the Postgres service's variable-name list contains no `WAL_ARCHIVE_*` names. Railway's PITR documentation says enabling Postgres PITR creates a `Postgres-PITR` bucket and adds archive variables. However, no direct PITR status/archiver-health response was available, so the service's actual PITR state remains unconfirmed.

### RECOVERY WINDOW

**No service-specific recovery window was verified.** Railway documents that Postgres PITR normally retains the last four full backups, giving an approximate four-week window when archiving is healthy. Coverage begins only after the first post-enable base backup completes; it is not retroactive. The actual range and archiver health for this service are unknown.

### LATEST VERIFIED BACKUP

**None verified in this inspection.** The latest backup record and its success state could not be retrieved. This is an information gap, not evidence that a backup is absent or failed.

### ISOLATED RESTORE SUPPORT

**Yes, for PITR.** Railway documents that a PITR restore provisions a new sibling Postgres service with a new volume and leaves the source service untouched. The restored service is initially non-archiving. By contrast, a volume-backup restore is an in-place/source-service operation (staged until applied), not the isolated full-data rehearsal path.

### REQUIRED PLAN OR COST

- Railway's PITR documentation inspected does not state a separate PITR fee or a specific minimum plan for enabling PITR. The account's current plan and eligibility were not exposed by the read-only inspection.
- PITR cost is usage-based: storage-bucket data is **$0.015 per GB-month**; uploads from the Postgres service incur service network egress, currently documented at **$0.05 per GB**. PITR has no separate fee; restore downloads from the bucket are free bucket egress.
- A restored sibling also consumes ordinary service resources and volume storage while it exists; the pricing page lists volume storage at **$0.15 per GB-month**, plus applicable compute and network usage.
- Bucket limits vary by plan: Limited Trial does not support buckets; Free permits up to 10 GB-month; Trial up to 50 GB-month; Hobby has a combined 1 TB bucket capacity; Pro is documented as unlimited. Applicable credits, hard usage limits, current plan and actual cost must be checked in the owner's Railway billing view.

### PERMISSIONS

Railway's role guide says project Owners have full project administration; Editors can deploy and change project settings; Viewers are read-only, cannot deploy, and cannot see environment variables. Railway's docs do not specify an exact role-to-permission mapping for backup status, backup listing, or PITR restore. The owner should perform or explicitly authorize these actions; do not grant broader access solely based on an assumed mapping.

### SAFE INTEGRITY AND RESTORE VERIFICATION

A successful backup record or a healthy archiver alone does not prove recoverability. Safely verify a selected recovery point only after separate owner approval by restoring it to a **new sibling service**, not over the canonical service. Then:

1. Confirm the sibling's service identity, deployment health, PostgreSQL readiness, TLS identity, and recovery target timestamp.
2. Run read-only database checks against the sibling: expected database and role, migration ledger hashes/timestamps, schema objects, and approved aggregate/invariant checks. Do not expose or export user rows.
3. Where appropriate, run PostgreSQL integrity checks against the sibling and a limited application smoke test pointed only at the sibling.
4. Record the checks and observed recovery point. Do not treat a successful restore as permission to switch the canonical application connection.

## OWNER ACTION REQUIRED

In Railway, select the project and `development` environment above, open the `Postgres` service's **Backups** tab, and report:

- PITR on/off, archiver health, and the exact available restore range;
- the latest successful volume backup timestamp and its status;
- any configured automatic volume-backup schedules.

The owner may also obtain the same details with the read-only Railway CLI commands, if available and authorized:

```sh
railway postgres pitr status \
  --project 3810e583-cc70-434c-b6fa-9ea15779f3c1 \
  --environment 4086de25-d270-4f39-89d1-93f611fe79c2 \
  --service 6a02fe25-1305-437c-9fe7-b989836c8949 \
  --json

railway postgres pitr backup list \
  --project 3810e583-cc70-434c-b6fa-9ea15779f3c1 \
  --environment 4086de25-d270-4f39-89d1-93f611fe79c2 \
  --service 6a02fe25-1305-437c-9fe7-b989836c8949

railway postgres pitr schedule list \
  --project 3810e583-cc70-434c-b6fa-9ea15779f3c1 \
  --environment 4086de25-d270-4f39-89d1-93f611fe79c2 \
  --service 6a02fe25-1305-437c-9fe7-b989836c8949
```

Do not enable PITR, create a backup, or restore a sibling as part of that status check. After reporting the status, the owner must separately approve any full-data PITR restore and rehearsal.

## FULL-DATA REHEARSAL READY

**NO.** Backup records, configured schedules, PITR state, archiver health, and the actual recovery window remain unverified. No recoverability claim can be made until an owner-authorized isolated restore is completed and checked.

## Evidence and sources

- Railway read-only `describeEnvironment` and `describeService` results for the exact project, environment, and Postgres service above. Environment contained no listed buckets; service metadata did not include backup records or schedules. Only variable names—not values—were inspected.
- Railway CLI was not installed in this workspace; no CLI backup/PITR status command was run.
- [Railway Point-in-Time Recovery](https://docs.railway.com/volumes/point-in-time-recovery)
- [Railway PostgreSQL CLI reference](https://docs.railway.com/cli/postgres)
- [Railway Storage Bucket billing](https://docs.railway.com/storage-buckets/billing)
- [Railway Pricing Plans](https://docs.railway.com/pricing/plans)
- [Railway project roles](https://docs.railway.com/guides/lock-down-production-project#restrict-who-can-change-production)
