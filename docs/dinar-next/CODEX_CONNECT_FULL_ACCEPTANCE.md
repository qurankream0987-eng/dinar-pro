# DINAR Connect — final local evidence

Source under qualification:5121c9198ca80fb0cb02be4ef168b396d8aa12c0. Reuse the existing connect registry, partners/sites, ingestion, outbound actions, agreement service and commission ledger; this audit creates none of them again.

| Capability | Canonical source/state | Required evidence |
| --- | --- | --- |
| Free onboarding and business association | connect/partners; connect_partners/business_profiles | Owner identity, eligible verified business, other-owner and anonymous denials |
| Site ownership | connect/sites; connect_sites | Server-issued TXT challenge, fixture verification, renewal and revocation; not live DNS acceptance |
| Credentials | Existing encrypted secret/credential service | Owner-only generation/rotation/revocation; no secret in reports/diagnostics |
| Feed catalog | Existing feed transport/normalization; connect_offers/ingestion_batches | Accepted authorized source, timestamp/freshness, real sync receipt, unsupported/invalid responses |
| MCP read catalog | Existing registered read-only connector | Approved catalog operations only, bounded results, no provider transaction tool |
| Website observation | Existing verified-site/robots/JSON-LD observation | Owner review and actual sync receipt; SSRF/origin restrictions preserved |
| Search/external cards | Existing domain/catalog contracts and Card Envelope | Real conversation results, authoritative supported attributes, no invented price/availability |
| Referral navigation | Existing EXTERNAL_LINK/outbound service | Server validation at use, legitimate destination, keyboard activation, opener=null, conversation retained |
| Consent/attribution | Existing referrals and privacy events | Default no opt-in, explicit acceptance, withdrawal and cancellation of unredeemed tracking |
| Agreements | Canonical immutable terms/acceptance | Independent admin proposal, owner review/consent, version/terms/acceptance persistence and idempotency |
| Commission/reversal | Existing verified-event transaction/ledger | Signed/authorized conversion evidence, deduplication, integer arithmetic and refund/reversal policy; no inferred external sale |
| Staff/diagnostics | Existing delegations and reporting | Catalog/reports read-only; owner retains keys, management and acceptance; revoked/expired/other-party denied |

`connect-cards-browser-journey.test.ts` and `connect-finance-browser-journey.test.ts` drive actual integrated frontend/API workflows. The finance journey exercises proposal edit/review/confirmation, owner acceptance, delegated read permissions, consent/withdrawal, feed/MCP/website sync, owner diagnostics and site lifecycle. External navigation uses explicitly authorized local fixture destinations and proves no internal marketplace order or basket animation. Deterministic provider fixtures are not claims of live partner sales or registration.

Unknown prices, renewal charges, premium state, availability and provider health remain unknown. Unconfigured registrars offer Search on provider; no domain purchase/registration is attempted. Live Spaceship/Cloudflare and partner credential/sandbox acceptance remain BLOCKED_PROVIDER. Production billing permissions were neither requested nor activated.

The current Codex model registry has15 bindings. Claude's separate branch adds model-facing partner/domain/status reads; do not claim25 bindings are integrated. Its agreement DTO mapper now uses terms.commission, accepted and acceptance.acceptedAt, with a positive accepted-owner regression. This correction exists on the independently inspected Claude source and still needs joint acceptance; canonical DTOs must not be changed to match an obsolete mapper.

Final-source records and per-PG evidence are attached below. API-only connector/rate-limit/math tests must not be labelled full browser acceptance. No production event, external booking, affiliate revenue, settlement or live payment success is inferred from a referral click.


Tested application and canonical acceptance source: `5121c9198ca80fb0cb02be4ef168b396d8aa12c0`. Local branch `codex/dinar-next-functional-audit`; preserved published foundation `ab196c55964ed42947d07a88dcd7f2e5f66ccfa0`. A later documentation/evidence-only delivery SHA must be identified separately; these results are not retroactively assigned to it.

Fresh immutable-source qualification: **350/350 groups PASS** (175 on PostgreSQL16,175 on18), **3548 passing case executions**,0failed cases,2 explicitly skipped development-TLS remote checks,0outbound attempts. All17 program phases and10 additional UI groups passed. These are local deterministic contracts and actual Chromium/API/disposable-database journeys, not live-provider or production approval.
Expanded final-source Connect presentation coverage adds36cards/navigation profiles and126finance profiles perPG. Only explicitly registered local fixture destinations are used. The supplemental browser transport follows the actual server303 and forwards to the canonical TLS fixture with exact CA/SNI verification; no live navigation/provider availability is inferred. Claude participation modes are on a separate61-migration branch and are not accepted by this60-migration run.

See [fresh evidence](CODEX_FINAL_FRESH_TEST_EVIDENCE.md), [14-field matrix](CODEX_COMPLETE_FEATURE_INVENTORY.md) and [handoff](CODEX_UPDATED_CLAUDE_HANDOFF.md).
