# 06 — Storage and uploads

**Status:** S3-compatible storage support is `READY_AND_VERIFIED` against a local mock; no live
Railway-compatible bucket is configured or verified.

## Application storage contract

Outside Replit, the application requires explicit `OBJECT_STORAGE_PROVIDER=s3`. The adapter requires
`OBJECT_STORAGE_S3_ENDPOINT`, `OBJECT_STORAGE_S3_REGION`, `OBJECT_STORAGE_S3_BUCKET`,
`OBJECT_STORAGE_S3_ACCESS_KEY_ID`, and `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`. It supports private
prefix handling, owner/permission checks, presigned uploads, and object-generation metadata.

Keep objects private by default. Set `OBJECT_STORAGE_S3_PRIVATE_PREFIX=private`; leave
`OBJECT_STORAGE_S3_PUBLIC_PREFIXES` empty unless each public prefix has an approved purpose and
access policy. Do not select the Replit sidecar provider for Railway; it is unavailable outside
Replit.

The local S3 protocol suite passed 7/7 against its local mock server. It verified signed save/read,
range requests, ACL/delete behavior, generation metadata, presigned browser PUT, credential
rejection, path traversal protection, and no fallback to the Replit sidecar. It does not prove
live provider availability.

## Business-verification documents

Code limits business-verification files to owner-scoped PDF/JPEG/PNG uploads up to 10 MB, with
15-minute upload URLs. No malware/document scanner is registered. New files remain
`NOT_SCANNED`/quarantined and cannot verify a business. The code records a 365-day retention
deadline after a decision, but that period is not legally reviewed and no periodic expiry/orphan
deletion worker was found.

Before enabling these uploads in staging, the owner must approve jurisdiction, purpose, retention,
deletion/erasure workflow, least-privilege bucket credentials, and an approved scanner. Do not upload
real identity or business documents before those controls are verified.

## Staging storage checklist (not executed)

1. Choose a provider and region; confirm residency and applicable deletion requirements.
2. Create a separate private staging bucket only after approval.
3. Create a least-privilege identity scoped to that bucket and required prefixes.
4. Inject the required S3 settings through the Railway secret/settings interface.
5. Keep public prefixes empty; set only the approved staging origin in bucket CORS if browser
   uploads require it.
6. Run synthetic upload, download, range, delete, wrong-owner, traversal, and expiration checks.
7. Verify retention and orphan cleanup with synthetic fixtures before any real document is accepted.

No bucket, object, credential, or customer data was created, read, copied, or deleted in this task.
