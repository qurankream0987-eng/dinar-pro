# Command 04 — D5 Source and Authority Map

## Implemented D5 path

1. The existing authenticated conversation path supplies the actor, conversation, and selected market to `modelContext` in `artifacts/api-server/src/ai/smart-turn.ts`.
2. The context builder checks for a seller-help request and an available market.
3. `delegatedSellerModelContext` in `artifacts/api-server/src/lib/business-delegations.ts` queries at most two grants for the actor and market, requiring an `INTELLIGENT` employee, `ACTIVE` status, and a future expiry. Zero or multiple matching grants fail closed.
4. Exactly one match is passed to the established `delegatedBusinessCatalog` authority with the server-stored configuration ID. That service rechecks the grant, business, capability, market, status, and scope and records its catalog-read audit event.
5. The model receives up to four short published-catalog summaries. It receives no listing IDs, contact details, coordinates, owner-selected grant ID, or write authority.

## Canonical authorities reused

| Concern | Existing authority |
|---|---|
| Business owner and market | D2/D3 identity and operating-profile checks in `business-delegations.ts` |
| Grant lifecycle and read capability | D4 `delegatedBusinessCatalog` |
| Published listing records | D3 business catalog and `offers` records, read through D4 |
| Conversation routing and model tools | G2 `smart-turn.ts`, `model-turn.ts`, and existing tool registry |
| State-changing marketplace actions | Existing canonical D3/G2 services and confirmation flows; not exposed by this D5 change |
| Model/provider configuration | Existing model gateway and provider selection; unchanged |

## Explicitly absent

- No new D5 permission or capability was added.
- No employee draft, listing edit, inventory, publication, order, inquiry-reply, message-send, promotion, or negotiation action was added.
- No new endpoint, surface, database table/column, migration, generated API, or client change was made.
- No direct model execution or live provider acceptance was performed.

The repository’s D4 intelligent grant currently allows only `business.catalog.read`. The D5 change preserves that boundary rather than treating the broader human approval list as delegated model authority.
