# Command 04 — D5 Reference Traceability

## Status

**PARTIAL** — this branch implements a narrowly gated, read-only catalog context for the existing smart-turn model path. It does not implement the universal seller employee described by Command 04.

## Authoritative request

The active scope is the supplied Command 04 attachment, “DINAR NEXT REPLIT EXECUTION COMMAND 04 — D5 UNIVERSAL INTELLIGENT SELLER EMPLOYEE.” Its D5-01 through D5-25 acceptance scenarios are reproduced in `COMMAND_04_D5_ACCEPTANCE_EVIDENCE.md`.

This command controls over older repository documents that reuse the D5 label for other work. Command 02B remains cancelled and was not continued.

## Requirements-to-source map

| Command area | Relevant existing authority | D5 change/evidence |
|---|---|---|
| D2 business identity and ownership | `artifacts/api-server/src/lib/business-delegations.ts`: `lockOwnedBusiness`, `delegatedBusinessCatalog` | Reuses D4’s owner, market, status, and grant checks; no parallel identity or database schema was added. |
| D4 intelligent read grant | `artifacts/api-server/src/lib/business-delegations.ts`: `delegatedSellerModelContext` | Resolves exactly one unexpired ACTIVE intelligent grant for the authenticated actor and current market; otherwise returns no catalog context. |
| Smart conversation model context | `artifacts/api-server/src/ai/smart-turn.ts`: `modelContext` | Adds at most four abbreviated published-catalog facts only for recognized seller-help requests. |
| D5 acceptance test | `artifacts/api-server/test/business-delegations.test.ts` | Tests no-grant, active-grant, expiration, actor/market isolation, ambiguous grants, and unrelated-request behavior. |
| Model tool authority | `artifacts/api-server/test/ai-authority-boundary.test.ts` | Existing regression confirms the model’s read-only tool set and rejects model-proposed financial/order tools. No D5 tool was registered. |
| G2 inquiry and conversation | `artifacts/api-server/src/ai/smart-turn.ts`, existing G2 routes/services and acceptance suites | Regressions were run; no D5 employee reply or approval path was added. |

## Change inventory

Changed source:

- `artifacts/api-server/src/ai/smart-turn.ts`
- `artifacts/api-server/src/lib/business-delegations.ts`
- `artifacts/api-server/test/business-delegations.test.ts`

Changed function responsibilities:

- `delegatedSellerModelContext` selects the grant only from server-known actor and market values, then reuses `delegatedBusinessCatalog`.
- `modelContext` conditionally attaches the read-only facts and explicit no-write/no-invention instructions.

No routes, OpenAPI definitions, generated API clients, schemas, migrations, frontend files, or model-tool registries changed.

## Source authority and tested source revision

- Starting revision: `f939595922171974626ef2cfd2c516aec8b86428`
- Tested source commit: `d0b63b36b9d4b4982ed192126682c51fa3882e0f`
- Target branch: `replit/dinar-next-complete-development`

The tested source commit contains only the three files above. Documentation is committed separately so the tested code SHA can be recorded without a self-referential commit hash.
