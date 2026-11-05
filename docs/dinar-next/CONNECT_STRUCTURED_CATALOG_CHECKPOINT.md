# Structured Connect FEED/API catalog pulls — 2026-11-05

Parent local milestone `42d06ddab79b6b66ea99994e48b39b3909c78ab3`; same isolated worktree/branch and authoritative Replit source as previous checkpoints. No new migration or dependency; current 60-entry release chain and original 57 migrations remain unchanged. No push, deployment, production access or paid/live activation.

## Implemented architecture

`connect/catalog-pull.ts` reads one approved FEED/API endpoint through the existing `ConnectNetwork` and sends its validated result into the existing `importConnectOwnerCatalog`/`importBatch` service. It creates no second catalog, action executor, conversation runtime or cart.

The command accepts only explicit confirmation and the expected approved integration revision. It never accepts a URL, arbitrary headers, credentials, model-selected method or redirect target. Before egress the server locks and verifies the owner, market/legal gates, partner approval, current website proof, connector revision and both CATALOG_READ/CATALOG_IMPORT capabilities. A persistent per-integration request budget applies. No database lock is held while the provider responds. The import transaction rechecks current authorization, website proof and exact revision/endpoint/site binding after the network returns, so revocation during a fetch cannot publish late data.

The initial adapter is public read-only HTTPS GET, bounded to one JSON batch of at most 100 items. Existing transport checks every DNS answer, pins public addresses where supported, refuses redirects, limits response bytes and deadlines and sanitizes provider failures. HTML, malformed JSON, deep/excessive documents and fields outside the published catalog contract are refused. Prompts or tool definitions cannot register behavior through this adapter. Missing prices/attributes and unknown availability remain unknown; the existing ingestion service still validates currencies, legal categories, safe provider paths, freshness, source versions and idempotency.

The owner portal now configures FEED or API JSON endpoints and offers a review followed by explicit sync confirmation for approved sources. Staff cannot configure or sync. Shared API schemas/clients are generated from authored contracts.

## Provider contract

Publish the existing `ConnectCatalogBatch` JSON contract at the approved endpoint:

```json
{
  "batchId": "supplier-batch-42",
  "items": [{
    "externalId": "service-1",
    "kind": "SERVICE",
    "title": "خدمة المزوّد",
    "description": "تفاصيل يقرها المصدر",
    "categoryId": "other",
    "price": null,
    "availability": "UNKNOWN",
    "targetPath": "/products/service-1",
    "sourceVersion": 1,
    "sourceCheckedAt": "2026-11-05T05:00:00.000Z",
    "attributes": [{"label": "مدة التنفيذ", "value": null}]
  }]
}
```

Supply the actual check timestamp and increment the source version when item data changes. Reusing a batch ID with changed content is refused; replaying identical content is idempotent. Currency prices, when known, use the existing integer minor-unit object. Only real permitted market categories and independently approved provider path prefixes pass ingestion. This is a documented DINAR feed contract, not a claim of support for every third-party API or scraping arbitrary HTML.

## Verification

Evidence `/workspace/dinar-connect-evidence/`:

- `feed-red.log`: missing sync route regression before implementation.
- `feed-green1.log`: fixture incorrectly supplied pre-review revision 1 instead of the actual approved revision 2; correctly refused 409. Fixture now uses the returned approved revision; no version check was weakened.
- `feed-green2.log`: all 17 integrated Connect cases passed, including strict owner/version/command checks before network access, GET-only approved endpoint, null/unknown values, duplicate replay and a controlled revoke-during-fetch barrier preventing late ingestion.
- `feed-regression-final.log`: adapter 4, Connect 17, network 4, card contract 4 and unchanged authority 6 passed; all outbound zero. Covers malformed/HTML/instruction/deep/large inputs, private DNS, redirects, provider 429/500 errors, timeout and secret-safe failures.
- `feed-browser1.log`: real Chromium owner clicks review and sync confirmation, the approved synthetic provider fixture feeds the actual API/DB importer, and the resulting row is verified. Existing staff/mobile/RTL, agreement acceptance, default-off referral consent, withdrawal, null opener, retained conversation draft, zero internal basket flight and site lifecycle assertions continue to pass. Page/console errors and unapproved external requests zero.
- `feed-codegen.log`, `feed-typecheck-final.log`, `feed-api-build.log`, `feed-web-build.log`: contract generation, workspace typecheck and both builds passed. Existing large frontend chunk warning remains.
- `feed-pg16.log`: integrated Connect 17 and adapter 4 also passed on disposable PostgreSQL 16.

## Explicit operational limits and remaining work

Current managed proxy cannot establish the generic native transport's DNS pinning; native pulls therefore return `PINNED_EGRESS_REQUIRED` instead of bypassing the proxy. Existing authenticated push/import remains available. Browser/API evidence uses the guarded disposable-environment transport injection, never a live provider or a production secret. OAuth credentials and provider-specific API adapters are not inferred from this public JSON adapter.

Continue website indexing, encrypted OAuth/PKCE lifecycle, independently reviewed read-only MCP, richer admin agreement/finance browser workflows, diagnostics/performance and comprehensive project closure. Original Conversation V2 recovery remains BLOCKED pending the original task/bundle; exact history is not reconstructed.
