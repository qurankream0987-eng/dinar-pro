# DINAR R3 — readiness and environment audit

## Safety decision

**Do not publicly launch. Do not connect real money.** This audit did not publish the app, create a production database, alter a database, read production data, or read secret values.

## Current status

| Area | Result | Evidence / remaining work |
| --- | --- | --- |
| Development | **Not ready** | The connected development migration journal ends at `0008`; the repository’s canonical journal ends at `0025`. `/api/readyz` now returns `503` until the database is caught up. An API startup maintenance job also fails because `listing_promotions.budget_minor` is absent, confirming application/schema drift. |
| Staging | **Not isolated / not created** | No separate Replit project exists. Another artifact in this project would still share project-level configuration and storage; it is not an isolated staging environment. |
| Production | **Not deployed** | No active deployment or custom domain was found. No production database was provisioned or inspected. |
| Migration safety | **Blocked** | Migrations `0009` and `0010` have database objects not represented in the journal. Migration `0011` rejects 178 of 237 existing offers even though their `unit_price_minor` values are valid. Do not run migrations, `db push`, reset, manual DDL, or a publish/schema sync until a reviewed recovery plan exists. |
| Secrets isolation | **Fail** | The six listed secrets are shared; none are scoped separately for development, staging, and production. Values were not read. |
| Object-storage isolation | **Fail** | The bucket/path configuration is shared in this project. Strict environment isolation requires a separate project and storage configuration. |
| Storage access controls | **Partial pass** | Uploads require authentication, accept JPEG/PNG/WebP with a 5 MB limit, and validate file signatures. Draft listing images are private and published listing images become public. Profile avatars are public. Upload URLs expire after 15 minutes. |
| Liveness/readiness | **Implemented; development fails readiness as intended** | `/api/healthz` is independent of the database. `/api/readyz` checks database connectivity and whether the latest canonical migration is recorded. The production startup probe now uses readiness. |
| Logs | **Partial pass** | Pino emits structured request logs with request IDs, status and response time. Query strings and sensitive headers are excluded; error objects expose only bounded type/code metadata, not SQL, parameters, details, messages, or stacks. There is no active deployment to inspect platform monitoring or production log retention. |
| Backups and restore | **Not verified** | Replit documents database backup/PITR capabilities subject to plan and environment. No restore was attempted because there is no isolated staging target; a restore test must not be performed against development or production data. |
| Rollback | **Documented, not rehearsed** | Application rollback requires restoring an appropriate checkpoint and republishing. Database recovery must use the supported backup/PITR path. No production deployment exists to roll back. |
| Real-money providers | **Not connected** | No integrations are connected. Payment-related behavior remains simulation-only; do not add live credentials or enable live processing. |

## Replit configuration observed

- Root deployment target is `autoscale`, using Replit’s application router.
- DINAR web is built as static files and serves `artifacts/dinar/dist/public`; its development port is `24108`.
- API development runs through the existing managed workflow. The production build is `pnpm --filter @workspace/api-server run build`; production runs the built Node entrypoint on port `8080`.
- The API startup check is `/api/readyz`. A failed readiness check is an intentional release gate, not a reason to weaken the check.
- `scripts/post-merge.sh` installs workspace packages and prints the reviewed migration command; it does not apply database changes automatically.
- Replit’s managed-database Publish flow compares development and production schemas and applies the reviewed schema diff. Since development currently has migration drift, **do not use Publish as a migration or as a launch step**.

## Secret names and scope

Only names and scope were inspected. No secret value was displayed or read.

| Secret name | Current scope |
| --- | --- |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Shared |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Shared |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Shared |
| `PRIVATE_OBJECT_DIR` | Shared |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Shared |
| `SESSION_SECRET` | Shared |

No staging-specific or production-specific secret names were present. Treat `DATABASE_URL` as a separately provisioned environment resource; it must point to a different database in each isolated project. Do not copy its value into this report.

## Required environment boundary

1. Keep the current project development-only.
2. Create staging as a separate private Replit project with its own database, storage bucket/paths, session secret, AI configuration, and any future provider configuration.
3. Keep production in a separate project/environment with separately provisioned database and storage resources. Do not create it by copying production data into development.
4. Keep real-money providers disabled until launch-country legal review and a licensed provider are selected. Use separate non-live credentials in isolated staging only if later approved.
5. Resolve development migration drift from the checked-in migration history and valid fixtures. Do not repair it with `db push`, reset, copied schema, manual SQL, or ad-hoc journal edits.
6. Before any production publish, review the development-to-production schema diff and backup/restore plan. A working `/api/readyz` is a prerequisite, not permission to launch.

## Backup and rollback rehearsal checklist

Run only after a separate private staging project and database exist:

- Confirm the database, storage, session, and provider configuration are staging-only.
- Capture a staging backup using the documented Replit control for the selected plan.
- Restore into an isolated staging target, never over development or production.
- Verify `/api/healthz`, `/api/readyz`, sign-in, a listing read, a private draft image, and a published image after restore.
- Record restore duration, data-loss window, and who can authorize recovery.
- Test application rollback by restoring a staging checkpoint and republishing the previous build; verify API and web artifacts together.
- Keep schema changes backwards-compatible across the rollback window. Do not rely on application rollback to reverse database changes.

## Health probe contract

- `GET /api/healthz` returns `200` when the HTTP process is alive; it does not require authentication or a database connection.
- `GET /api/readyz` returns `200` only when the database is reachable and `drizzle.__drizzle_migrations` records at least the latest canonical migration. It returns `503` with non-sensitive check statuses otherwise.
- When adding a migration, update the readiness threshold in the same reviewed change as the canonical migration journal.
