# DINAR Connect engineering scope and state review — 2026-11-05

Owner approved free company registration, basic connection, organic eligible discovery and basic referrals. External commissions require a separately accepted, versioned agreement; internal marketplace policy stays unchanged. No automatic domain registration, payment, production credential use or live activation.

Reuse: existing conversation runtime, tool registry, Card Envelope, composed surface renderer, business identity/delegation, provider credential hashing/rotation/scope checks, rate limiter and audit patterns. External catalog items never become `offers`, internal cart items, orders, seller dues or marketplace financial events.

Proposed internal commission state review (reviewed here against the owner’s supplied invariants before implementation):

| Current state | Admissible evidence / next state | Forbidden shortcut |
| --- | --- | --- |
| PENDING_VERIFICATION | authoritative authenticated conversion + valid consented attribution + accepted effective agreement → VERIFIED | a link click or browser callback cannot earn money |
| VERIFIED | authenticated commission approval matching calculated snapshotted amount/currency → APPROVED | no partner-supplied arbitrary recalculation |
| APPROVED | explicit finance review and contractual due date reached → PAYABLE | approval is not receipt of funds |
| PAYABLE | authenticated settlement evidence, verified reference and finance reconciliation → SETTLED | clicking an admin button cannot claim money received without evidence |
| VERIFIED/APPROVED/PAYABLE | authenticated cancellation/refund/chargeback → append-only adjustment; full reversal → REVERSED | no overwriting accrued history; partial refunds cap cumulative reversal at original eligible base |
| Any verified non-reversed state | dispute evidence → DISPUTED; resolution returns only to supported prior state or REVERSED | no dispute self-approval or contradictory settlement |
| SETTLED | later refund/chargeback records a separate recovery obligation / reversal event | never erase actual settlement evidence |

Amounts remain integer minor units, currency-specific, no implicit FX. Percentage commission uses accepted agreement rounding rules and net eligible base. Fixed commission is earned once; partial refunds follow the explicitly accepted agreement policy. Excluded products/categories earn zero. Out-of-order provider events are retained pending predecessors or refused for reconciliation, never speculatively accrued. Identical event IDs/body hashes are idempotent; reused IDs with a different hash are conflicts. All accounting/evidence events append-only; state summaries are projections.

Unspecified commercial choices are fields of a proposed agreement and require explicit partner acceptance; no default external 10% rate, return period, attribution window or exchange rate is invented. Settlement mode in acceptance is explicitly SIMULATION_ONLY; real receipts remain unverified until authorized integration/evidence exists. EXTERNAL_AUTHORIZED_ACTION is default-denied until an individually reviewed capability is approved; connecting a website grants discovery/referral only.

Cloudflare official schema reviewed: `cloudflare/api-schemas` main `openapi.yaml`, retrieved through the configured proxy. `registrar[-sandbox]/domain-search` is advisory; `POST .../domain-check` is documented read-only and authoritative. Only those operations are eligible for the domain adapter. Domain creation/registration/transfer/billing operations are excluded. Spaceship official docs are presently blocked by the environment’s network policy; do not invent endpoint methods or purchase links.
