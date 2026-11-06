# Financial and security closure evidence

Qualified code `9101672a7370bb8080e598344840d1fde2f88291`. The full fresh inventory ran on `c2a8717e1f345b4c9a2c5f39ae5a41b6e868ad82`; the final bounded deployment-marker correction and deterministic test refinements are separately qualified on their actual source SHA. Raw failures are retained. This is simulation/disposable-service evidence, not live financial authorization.

## Authority checked in source

Internal authority remains `src/routes/marketplace.ts`, `src/lib/marketplace-cart.ts`, `src/lib/payments/{service,obligations,cash}.ts`, `src/lib/order-terminal-accounting.ts` and the existing order journal. Checkout uses persisted/locked prices, quantities and immutable fee/order-line snapshots; terminal accounting consumes the snapshot rather than recomputing a fee. Payment events verify signatures before mutation and match provider identity/currency/amount; cancelled/lapsed captures create the existing refund obligation. Cash claims and simulated money are not funds held by DINAR. Party/admin ownership, explicit confirmation, idempotency and reservation locks remain unchanged.

External authority remains `src/connect/{agreements,finance,commission-math,partners,reports}.ts` and SQL `0057`–`0059`. Agreements require an independently proposed version/digest and explicit verified owner acceptance. Referrals require current consent; withdrawal permanently invalidates older unconverted referrals. A click creates no accrual. Provider events use separate CONNECT credentials/scopes, sequence/digest checks and locked integration/transaction state. Settlement claims do not write settled funds; only an independent admin can reconcile a simulation, never their own partner's transaction. Currency-separated integer minor units and BigInt calculations reject unsafe values, duplicate items, unknown refunds and cumulative refund regressions. Refund/reversal/dispute balances remain bounded by immutable economic snapshots.

Append-only triggers protect agreements, acceptances, referrals, events, audit, ledger and ingestion evidence. Deferred `0058` projection checks also cover ledger-only appends and the final header state. Foreign evidence cannot fund another transaction; simulated-settled entries cannot represent LIVE money. The report batch-read optimization reuses the same reconciliation boundary and repeatable-read snapshot; its 14-query count for one and multiple rows is not a production latency/SLO claim.

## Hostile and failure-path acceptance

Names below are files under `artifacts/api-server/test/`; source-cut status/counts are in the acceptance ledger, not inferred from an endpoint existing.

| Counterexample | Existing acceptance and expected boundary |
| --- | --- |
| Seller edits price / two buyers race for last unit | `financial-state-machine`, `sc07-browser-journey`: locked current state or reviewed conflict; no oversell/client amount |
| Duplicate buyer confirmation / two tabs | `w02u3-card-concurrency-browser-journey`, finance state tests: one canonical effect/receipt |
| Foreign account's order/listing/dispute | `security-acceptance`, `sc10-browser-journey`: deny without data/authority leak |
| Staff revoked/expired between prepare and confirm | `d4-d5-isolation-security`, `connect-partners`: live canonical grant/version/expiry rechecked; no stale write/key access |
| Forged event / webhook replay / changed payload under same ID | `wave4-payment-acceptance`, `connect-partners`: reject forged/conflicting evidence; identical replay cannot duplicate money |
| Duplicate provider settlement / own-partner admin | `connect-partners`, `connect-finance-browser-journey`: claim alone earns/settles nothing; independent reconciliation only |
| Partial refund after simulated settlement | `connect-commission-math`, partner finance browser: cumulative immutable basis, exact recovery due, no re-earning |
| Delayed/dropped provider / revision revoked during I/O | `connect-catalog-pull`, `connect-sync-observations`, `connect-partners`: bounded error, recheck before import, no phantom source version |
| Expired DNS proof / OAuth revoked or swapped across integrations | `connect-partners`, `connect-network`: fail current readiness; retired state/AES-GCM AAD cannot resurrect a grant |
| Malicious catalog HTML / MCP prompt text | `connect-website-catalog`, `connect-mcp-catalog`, card presentation: no JS/resource fetch or dynamic provider tools; only bounded structured data |
| Private IP / mixed DNS / malicious redirect | `connect-network`, domain/card contract suites: HTTPS exact hosts, all-address validation, pinned socket, no redirect following |
| Model invents payment/order success | Unchanged `ai-authority-boundary`, DeepSeek replay matrix: no direct writer, no success without canonical receipt |
| Lost acknowledgement after the canonical writer commits | `d12-execution-recovery`, `d3a-native-business`: real writes survive an injected acknowledgement outage, ledger/reply stay UNKNOWN, repeated confirmation never writes again; claim evidence and later CONFIRMED state survive |
| Mobile loses response after commit / Stop | `conversation-stream-recovery-browser-journey`, V2/recovery: read owned correlated outcome; never resend a possibly executed request |
| Storage/media provider failure | `storage-s3-wire`, image publication/policy suites: unavailable/unauthorized storage is not a missing object or successful upload; 503 review failure never publishes |
| Changed migration SQL / journal / concurrent migration | `development-tls`, PG18 release/concurrency scripts: reviewed fingerprints/ordering reject changed history; original 57 unchanged |
| Deployed clickjacking / stored XSS / cross-origin write | `same-origin-web`, `security-acceptance`: production self framing, inert stored text and server origin/ownership gates |

## Privacy, credentials and logs

`connectAccess` joins canonical business ownership and live D4 delegation; staff receives catalog/report reads only, never integrations, secrets, agreements or diagnostics. OAuth is fixed read-only PKCE and encrypted under an explicitly configured vault key; it has no fallback to a session or another provider token. State is consumed before exchange and identity/revision/retirement rechecked afterward. Generic proxied outbound requests fail closed when DNS pinning is unavailable. Test dependency injection requires both disposable acknowledgements, loopback DB identity, development and no deployment markers.

Navigation is an expiring actor/conversation/market-bound capability, with trusted server destinations, no-referrer/no-opener and no internal cart/order/commission interpretation. Export reuses the password-confirmed privacy route, selects owned fields only, and excludes credentials/ciphertext, raw provider payloads and other customers. Diagnostics emits allowlisted metadata only; an audit append failure cannot turn an already committed import into failure, and fixed warnings expose no provider exception. Retention remains explicitly unapproved pending legal policy.

Current package audit reports zero known advisories at all severities. Official gitleaks 8.30.1, verified against official checksums, scans all accessible refs including full merge-parent diffs with 100% redaction; zero findings. Exact scan source/counts and tool provenance are retained. Historical pattern scanning is an additional narrower check, not a substitute. Actual hosted CI remains unverified because API access is blocked. No live credentials, provider activation, paid inference, production DB or money transfer was used.

No unresolved demonstrated P0/P1 internal finding remains within the recorded local platform scope. Financial/legal/permission protections pass the actual current regressions. External approval, native sit0 harness failures, historical C1 space/snapshot equivalence and unmerged Claude intelligence remain explicit limits; this is not production certification.

## Delivery-only scanner review

The post-documentation sweep flagged two non-secret documentation values, independently verified as ordinary policy prose and a real Git tree object ID. Exactly two historical fingerprints are reviewed in [DELIVERY_SCANNER_TRIAGE](evidence/DELIVERY_SCANNER_TRIAGE.md). No global exclusion or history rewrite is used; full scanning and a different-commit/path negative probe verify scope. Raw detections and reviewed exclusions remain explicit. No application, authorization, financial, migration or generated-contract source changed after qualification.
