# Selling and buying — final local evidence

Candidate5121c9198ca80fb0cb02be4ef168b396d8aa12c0 preserves the unified conversation, offers/search, negotiation, persistent cart, checkout, order lifecycle and immutable accounting. No replacement marketplace/cart/order service or migration was introduced.

| Journey | Existing acceptance and authoritative outcome |
| --- | --- |
| Conversational selling | SC01 creates one seller-owned draft from Arabic details, applies a correction, reviews and explicitly publishes; another actor finds the stored offer |
| Seller management | Existing listings/status/archive/stock services; actual seller profile shortcuts open those surfaces. The existing inline EditOffer now returns through the same memory router after back/cancel/save |
| Editing | Opening/cancelling writes nothing; fields are reviewed in the existing form; one explicit save yields one canonical PATCH receipt. Exact stored JSON title and seller ownership are independently checked and reload restores the result |
| Search/comparison | Server result-set identities, Arabic normalization, filters/sorting and comparison; header search retains the user query until explicitly sent. Missing attributes/prices remain unknown |
| Cart | Existing persistent service, quantity/remove/reload and backend receipts. A late queued A intent under B is rejected409; A's acknowledged quantity remains2 and B stays empty |
| Checkout | Existing review/consent and idempotent order creation; server prices, stock, fulfilment and currency. Sponsored discovery now follows that exact offer through cart and cash checkout with one actual order |
| Negotiation | SC01/SC03 and commerce journeys preserve party ownership, proposal/review/acceptance, agreed price and one order; a negotiable asking price cannot bypass agreement |
| Fulfilment | Existing participant-authorized order cards; seller handoff and buyer receipt must reach actual persisted completion, not merely a changed DOM |
| Dispute/refund | SC10 and financial APIs preserve reviewer permissions, participant-only private reads, signed refunds and immutable accounting |

The original SC03 failure was a false async wait: the browser could resolve an async predicate before the actual receipt transition. The correction awaits the authenticated API status and retains exact terminal DB/order/snapshot assertions. SC01/SC10 neighboring waits were audited too. Admin private-order GET remains404; resolving a dispute is not permission to read a participant-only order.

Graphical components reused inside the memory router are real existing forms/services. Standalone routes disabled by CHAT_ONLY_MODE remain NOT_IN_APPROVED_SCOPE; the audit does not enable a second storefront application. In particular, the seller editor already existed inline: only its return-path alias was missing.

Physical products, services and digital listings share the canonical offer architecture. Non-price negotiation terms, food/options, service appointments, digital deliverables/IP, inspection terms and cross-market FX retain their specific owner-policy gates. No courier tracking, automated real payment/refund, arbitrary appointment or digital delivery is fabricated where the canonical capability/provider/policy is absent.

Exact-source per-PG suite records and case results are supplied in the final evidence package after the completed350-group run. A cash test is not card-provider capture; a listing or campaign receipt is not purchase payment; a confirmed order is not yet physical delivery. Live providers and legal launch approval remain separate.


Tested application and canonical acceptance source: `5121c9198ca80fb0cb02be4ef168b396d8aa12c0`. Local branch `codex/dinar-next-functional-audit`; preserved published foundation `ab196c55964ed42947d07a88dcd7f2e5f66ccfa0`. A later documentation/evidence-only delivery SHA must be identified separately; these results are not retroactively assigned to it.

Fresh immutable-source qualification: **350/350 groups PASS** (175 on PostgreSQL16,175 on18), **3548 passing case executions**,0failed cases,2 explicitly skipped development-TLS remote checks,0outbound attempts. All17 program phases and10 additional UI groups passed. These are local deterministic contracts and actual Chromium/API/disposable-database journeys, not live-provider or production approval.
The editor concurrency defect was independently reproduced before repair (two same-version200s). Current canonical PATCH extracts expectedUpdatedAt and passes it to the existing locked update service. Version timestamps advance monotonically. Current browser/API regressions prove one200, stale/repeated409, preserved draft on refetch, explicit reload and reviewed save200, owner isolation and independent stored title/stock/snapshot checks. No record changes on open/edit/cancel.

See [fresh evidence](CODEX_FINAL_FRESH_TEST_EVIDENCE.md), [14-field matrix](CODEX_COMPLETE_FEATURE_INVENTORY.md) and [handoff](CODEX_UPDATED_CLAUDE_HANDOFF.md).
