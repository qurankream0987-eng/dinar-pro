# Reviewed read-only MCP catalog connector — 2026-11-05

Parent published milestone: `ed4a6e56c4b0c56c8b157ca4eb635758b6d11472`. Same isolated worktree and owner-authorized Codex branch; reference integration remains `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a`. No migration or dependency was added. Current release chain remains 60 entries, preserving the original 57 SQL files and manifest entries.

## Implemented contract and reuse

`connect/mcp-catalog.ts` implements a fixed reviewed catalog adapter, not a general action executor or a provider tool registry for the model. It uses the same owner-confirmed sync route, `ConnectNetwork`, optional existing encrypted OAuth grant, existing catalog importer, external offer table, conversation cards and audit authority.

The initial server-validated interoperability contract is:

```json
{
  "name": "catalog.read_snapshot",
  "inputSchema": {"additionalProperties": false, "properties": {}, "type": "object"},
  "inputSchemaSha256": "99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa",
  "readOnly": true,
  "capability": "CATALOG_READ"
}
```

Independent integration approval binds the endpoint, revision, capability and proposed manifest. Runtime verifies the advertised tool, exact canonical schema hash and explicit non-destructive/read-only annotations before calling the fixed operation with `{}`. Other tools, server instructions, unstructured text and server-initiated requests never become DINAR model tools or financial authority. The result must contain the documented MCP content envelope plus a structured payload matching the existing ConnectCatalogBatch. Prices/availability remain null/unknown when the source says they are unknown.

The bounded protocol implements initialize, initialized notification, tools/list and the fixed tools/call, with documented protocol/session headers. JSON and completed SSE responses are supported. SSE comments/notifications are ignored; wrong/duplicate response IDs, truncated frames, excessive frames and callback requests fail closed. A valid session receives a best-effort same-endpoint DELETE on completion/failure; permitted provider 405 responses do not invalidate already verified catalog data and do not imply remote OAuth revocation. Persistent subscriptions, resumability, sampling and arbitrary tool execution are outside this single-snapshot adapter.

MCP may be public or use its own explicitly owner-authorized `catalog.read` OAuth grant. No incoming DINAR provider key or another integration's credentials are forwarded. Import rechecks current owner, market/legal gates, revision, website proof, revocation and any grant after network work. Shared integration/owner/host request budgets prevent multiplying egress by alternating connectors. There is no billing, purchase, registration or transaction-execution capability.

Owner setup and sync controls are integrated into the existing portal. The independent admin view now displays endpoint, allowed referral paths, tool/capability/hash and public OAuth configuration for actual review, rather than hiding the proposed contract behind a generic approve button. Human staff remain read-only. Repository branch guidance now reflects the current explicit owner authorization without weakening financial, migration, production or model-authority safeguards.

## Official protocol review

Official sources were inspected through the configured proxy; no external source code was copied into the application:

- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.ts — SHA-256 `7d7f4cc6f3adb76e3fd5e1eee6bab8b1e183cfaf719da66d2aa5661737ca9539`.
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/basic/transports.mdx — SHA-256 `df1217279334b6f3af8bb457191884ba831dce2c5389d7a0556ba920270ca902`.

The review added required SSE support, serverInfo/content-envelope validation and session cleanup. Providers must implement the documented DINAR snapshot tool and supported protocol; generic unrelated MCP tools are not silently adopted. Long-lived streams that do not complete within the transport budget fail with a timeout.

## Evidence

Local evidence: `/workspace/dinar-connect-evidence/`.

- `mcp-red.log`: the new reviewed MCP contract was unavailable before implementation; existing 18 cases passed.
- `mcp-green1.log`: first integrated public MCP ingestion passed with 19 Connect cases.
- `mcp-protocol1.log`: deterministic schema/tool/instruction isolation and safe protocol failures passed.
- `mcp-required-envelope-red.log`: newly added official required-metadata/content checks failed 2 cases before the protocol fix; 4 passed. Positive synthetic fixtures were corrected to include documented serverInfo and content fields; no authority assertion was weakened.
- `mcp-complete-pg18.log` and `mcp-complete-pg16.log`: each passes Connect 21, MCP protocol 6, structured adapter 4, network 4 and unchanged model-authority 6; outbound attempts zero. The 21 cases include real DB public/OAuth MCP ingestion, PKCE binding, grant disconnect with no later MCP calls, stale/revoked source checks and shared admission across alternating connectors.
- `mcp-browser-complete.log`: actual Chromium owner-reviewed MCP sync writes its verified structured result through the real importer. Independent admin metadata is visible at width 320; active OAuth review/link and owner controls also retain zero overflow at 320. All prior 320/390/1280 staff, agreement, referral/withdrawal, null-opener, preserved-draft, OAuth refresh/disconnect, zero basket-flight and website-proof lifecycle assertions pass. No page/console errors or unapproved external requests. The source is an isolated synthetic provider, not live MCP acceptance.
- `mcp-complete-typecheck.log`, `mcp-complete-api-build.log`, `mcp-web-build.log`, `mcp-codegen-final.log`: workspace typecheck, final API build, unchanged frontend build and reproducible authored-contract generation pass. The pre-existing frontend chunk-size warning remains.

The isolated GitHub Docker chain includes the MCP protocol suite on PostgreSQL 16/18. Git publication is authorized and available; Draft PR creation and remote Actions observation remain BLOCKED by GitHub API Forbidden, as recorded in the publication checkpoint. No green CI result/run ID is invented.

## Remaining work and external dependencies

Continue safe single-page structured website indexing, richer administrative agreement/finance browser workflows, diagnostics/performance and comprehensive project acceptance. Native generic egress remains blocked by the managed proxy's inability to prove DNS pinning; no bypass is used. Real provider sandbox interoperability requires separately authorized credentials and approved egress. Original Conversation V2 history remains BLOCKED pending the original task/bundle; no identities are reconstructed. This milestone does not establish launch readiness.
