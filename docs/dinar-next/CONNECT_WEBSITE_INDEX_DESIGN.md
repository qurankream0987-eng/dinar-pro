# Single-page structured website indexing — design before implementation

Owner authority: complete Connect website/catalog integration while preserving the existing conversation, catalog importer, cart, financial/legal gates and contributor history. Parent published milestone is `35bd574f56438c89256211948c1465f4dfca83a0`.

## Scope and authority

An independently approved WEBSITE integration may explicitly fetch one configured same-host HTTPS page. No crawler, links, scripts, images, iframes, remote JSON-LD contexts or JavaScript are fetched/executed. The existing transport supplies DNS pinning, public-address validation, redirect refusal, deadlines, bytes and shared owner/host admission budgets. Missing configured endpoints remain unavailable rather than guessed.

Extract only bounded schema.org Product/Service JSON-LD with supported context and safe absolute provider URLs. Category is an explicit owner-selected DINAR mapping, independently reviewed and validated against current market/category/legal rules, never inferred from product text. Unknown/missing prices, currency, availability and attributes remain unknown. Only exact representable decimal prices are converted to integer minor units; Node's JSON primitive source preserves numeric literals, avoiding floating-point rounding. No market currency or price is invented.

Website IDs and versions describe DINAR's observations, not fabricated provider SKUs/versions. The actual fetch timestamp is the last-checked time. Stable URL-derived IDs identify observations; provider SKU is an optional literal fact. Under the existing owner/integration transaction, allocate versions, reject observations older than a committed one, hide prior source items missing from this complete page snapshot and import current eligible items through the existing catalog writer. A zero-eligible snapshot hides the previous source display, retains its history and reports NO_VERIFIABLE_DATA; it never marks products sold out or creates an order. Observation IDs/digests make replay idempotent. No deletion or financial mutation.

## Dependency justification and license review

A real HTML parser is necessary to extract script data without executing HTML or using fragile HTML regular expressions. Add only pinned `parse5@8.0.0` to the API server; it is a pure HTML5 parser, not a browser or network client. npm metadata review confirms MIT license. Its resolved entity decoder `entities@6.0.1` uses BSD-2-Clause. Both are permissive; no remote source is copied into application files. Metadata is retained at `/workspace/dinar-connect-evidence/parse5-package-review.json` and `entities-package-review.json`.

Required tests: malformed/hostile HTML, inert templates/scripts and remote contexts, exact numeric/string prices and overflow/precision rejection, unknown availability/currency, multiple offers, unsafe targets, bounded document/tree/JSON work, real owner approval/import/hide/replay/concurrency/revocation, no internal orders/commission, and actual RTL/mobile card/navigation evidence. Dependency installation, typecheck, API/web build and dependency/security checks must pass before publication.
