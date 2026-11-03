# 12 — Production release runbook

**Status:** `BLOCKED` until every release gate is explicitly approved and verified. This package
does not authorize a production deployment.

## Mandatory release gates

Do not begin production activation until all items are true:

- The approved Claude unified DINAR source is merged and the production SHA is immutable.
- A second engineer independently tested that exact SHA.
- The owner approved the production project/environment, change window, operator, and rollback
  authority.
- Launch-country legal, privacy, consumer-protection, and seller-document controls are accepted.
- A valid payment provider, merchant ownership, refund/dispute path, and production payment
  configuration are approved. Until then, payments stay simulated and DINAR must not claim an
  unsupported payment or transaction is complete.
- Production secrets are entered through the platform secret flow and reviewed without exposing
  values.
- Backup/PITR status, archive health, retention, and restore point are verified; a restore has been
  tested into a separate service and RPO/RTO objectives accepted.
- The final migration manifest and history are reconciled; fresh and upgrade rehearsals passed on
  the final SHA.
- Staging acceptance, authenticated browser flows, performance evidence, and incident-response
  ownership are documented.
- Monitoring alerts, spend controls, and application rollback are ready.

## Controlled activation sequence (after approval)

1. Freeze the approved release SHA and record the source PR, commit, build image digest, operator,
   and UTC change window.
2. Confirm the exact production environment and separate production database. Verify private
   networking and TLS identity; do not use a public database proxy.
3. Verify the owner-approved backup point and run the production-target plan-only migration check.
4. Review the plan and target identity with a second operator. Stop on any manifest, ledger, schema,
   or database-name mismatch.
5. Obtain explicit production migration authorization. Run the release migrator with
   `DINAR_MIGRATION_TARGET=production`,
   `DINAR_MIGRATION_ACK=APPLY_PRODUCTION_MIGRATIONS`,
   `DINAR_DEPLOYMENT_ENV=production`, exact `DINAR_MIGRATION_EXPECTED_DATABASE`, and the approved
   private `DATABASE_URL`. Keep `DINAR_DEV_DATABASE_URL` absent.
6. Deploy only the approved image. Keep one replica initially, `/api/readyz` as the healthcheck,
   production autodeploy disabled, and public access limited to the approved domain.
7. Verify liveness/readiness, same-origin session behavior over HTTPS, smoke transactions that do
   not imply payment settlement, storage access, alert delivery, and error-log redaction.
8. Monitor the agreed rollout window. Stop traffic on a readiness, payment, privacy, backup, or
   cost-control failure.
9. Roll back the app image only to a previously reviewed SHA. Do not reverse migrations. Use a
   separately restored database only under the incident/recovery approval process.
10. Record final owner approval, exact SHA, deployment reference, migration result, backup point,
    test evidence, and any residual risks.

## Current blockers

No production app or domain was configured. The current Railway database ledger and backup/PITR
state are unverified, the 0051 migration collision is unresolved, no live provider is approved, and
legal/payment readiness is not established. Operational preparation is not legal or commercial
approval.
