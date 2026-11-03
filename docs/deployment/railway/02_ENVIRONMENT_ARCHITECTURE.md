# 02 — Environment architecture

**Status:** `PREPARED_NOT_DEPLOYED`.

## Current shape

Only the Railway `development` environment was visible. It contains one PostgreSQL service and
one attached 500 MB volume. There is no DINAR API/web service, no object-storage bucket, and no
separate staging or production environment visible in the inspected project.

The existing development database is not a staging target. Its migration ledger was previously
reported as behind, and the present ledger is `UNVERIFIED`. The public TCP proxy is not an approved
application connection path.

## Proposed future topology

```text
Approved GitHub release SHA
          │
          ▼
One Railway Node service per environment
  ├── serves DINAR web and /api on one origin
  ├── one replica initially
  ├── private connection to that environment's PostgreSQL
  └── private S3-compatible object storage for that environment
```

Keep development, staging, and production isolated:

| Environment | Database | Object storage | Public app domain |
|---|---|---|---|
| Development | Existing resource; do not attach or mutate in this task | None verified | None |
| Staging | New, separate PostgreSQL service after approval | Separate private staging bucket after approval | None until approved |
| Production | Separate production PostgreSQL service after release gates | Separate private production bucket after approval | Exact approved origin only |

## Runtime constraints

- Use one Node service for the first staging rehearsal. The API already serves the built web app,
  preserving same-origin session and write protections.
- Keep one replica. The API process starts scheduled maintenance work; multi-replica safety has
  not been established.
- Do not create a separate worker, public database endpoint, production domain, or production
  autodeploy as part of this preparation.
- Use Railway private networking for app-to-database and app-to-storage traffic where supported.
- Do not copy production data, sessions, phone numbers, messages, or business documents to staging.
- A staging restore, if approved, must target a new isolated service; never overwrite the source.

## Owner inputs before provisioning

Record the exact Railway project and environment, service names, private connection path, database
name, region, object-storage provider/region/bucket, retention policy, and approved origin before
creating anything. These values are currently unknown and are not guessed here.
