# 11 — Staging activation runbook

**Status:** `PREPARED_NOT_DEPLOYED`. Do not execute without the approvals below.

## Stop conditions and required approvals

Before creating a staging service, obtain written owner approval for:

- Exact Railway project and new staging environment.
- Resolution of the conflicting staged `EnvironmentPatch` status.
- A separate PostgreSQL service/database, region, version, private connection path, and budget.
- Backup/PITR status and a restore drill into a separate service.
- A private staging object-storage provider, bucket, region, retention policy, and upload policy.
- The approved unified GitHub release branch and immutable SHA after the Wave02/D16 migration
  history is reconciled.
- The approved staging origin and any provider sandbox integrations.

If any identity, migration manifest, database name, backup point, or cost limit is unclear, stop.
Do not substitute the existing `development` database.

## Provisioning checklist (after approval)

1. Create only the specifically approved staging environment and isolated resources.
2. Create one Node service from the approved GitHub SHA using repository root `/` and the root
   `Dockerfile`.
3. Configure one replica, image-default start command, `/api/readyz` healthcheck, 120-second
   timeout, and `ON_FAILURE` with at most 5 retries.
4. Do not configure a public PostgreSQL proxy, public app domain, production autodeploy, or
   pre-deploy migration.
5. Establish private app-to-PostgreSQL and app-to-storage connectivity. Keep the service out of
   public traffic until smoke tests pass.
6. Inject only the approved names from `07_SECRETS_MATRIX.md` through Railway's secret/settings
   interface. Do not place values in Git or command history.
7. Verify required configuration and `/api/healthz`. A healthy liveness response alone is not
   sufficient.
8. Run the plan-only staging migration procedure in `04_DATABASE_AND_MIGRATIONS.md`; obtain
   separate owner approval before applying migrations.
9. Confirm `/api/readyz` returns 200 only after the approved migration ledger is current.
10. Run same-origin, session, listing, upload, notification/provider-sandbox, and browser smoke
    checks using synthetic staging data. Payments must remain simulated unless separately
    approved and legally enabled.
11. Record the release SHA, environment, service settings, sanitized test evidence, cost baseline,
    and owner sign-off. Do not copy production data to make tests pass.

## HTTPS and domains

Local verification used loopback HTTP only. No Railway HTTPS endpoint or custom domain was tested.
Enable a staging domain only after the owner approves the exact hostname and origin; verify TLS,
secure session-cookie behavior, CORS/origin protections, and browser flows over HTTPS before
accepting traffic.

## Rollback

For an app regression, restore the previous reviewed app image/SHA through Railway's deployment
history. Do not reverse database migrations. If data recovery is required, restore to a new isolated
service and follow `05_BACKUP_AND_RESTORE.md`. Do not delete or overwrite the source as a rollback
shortcut.
