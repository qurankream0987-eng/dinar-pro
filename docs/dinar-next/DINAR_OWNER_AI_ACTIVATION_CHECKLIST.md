# DINAR AI benchmark — owner activation checklist

**Status as of 2026-10-24: not authorized for live requests.** Local planning and simulation passed. No real provider request, provider activation, secret change, production-data access, deployment, or push has occurred.

## Before authorizing the first paid benchmark

- [ ] Choose whether OpenAI and Anthropic are both in scope; approve the exact model IDs and comparison settings in `DINAR_FIRST_LIVE_AI_BENCHMARK_READINESS.md`.
- [ ] Review the provider’s current data controls, retention terms, DPA, region, and account eligibility for the intended synthetic benchmark inputs.
- [ ] Set a provider-side project budget/limit for each provider. The harness’s $5 local ceiling is not a provider billing guarantee.
- [ ] Approve a real approval record: approver, date, providers, and a budget no higher than the provider-side cap. Keep its JSON outside the repository.
- [ ] Create separate, least-privilege benchmark credentials. Use only the dedicated `DINAR_BENCH_*_API_KEY` secrets; never use DINAR’s normal development, production, or `OPENAI_API_KEY` credentials.
- [ ] Verify only the required benchmark credentials are available to the isolated process; do not copy credentials into the config, output directory, or repository.
- [ ] Use new, empty result and blind-key directories outside the repository. Check the final `plan` is `ok: true`, has no warnings, and remains within the approved budget.
- [ ] Run and inspect `simulate` first. It is a scripted local check, not model evidence.
- [ ] Only after the above are complete, explicitly authorize one bounded live run. Compare result request IDs, reported usage, and estimated cost with both provider billing pages; stop and revoke the dedicated credentials after review.

## Remains separate from this benchmark

- [ ] A benchmark result does **not** enable AI in staging or production. Production use needs its own explicit owner decision, privacy/legal review, applicable OpenAI cache-write prices registered for the exact model/version, approved spend limits, and a deployment-specific acceptance.
- [ ] Do not modify the canonical conversation runtime, business-action authority, or fallback configuration to run this benchmark.
- [ ] Do not use real buyer, seller, employee, order, or account data as benchmark input.

## Safe local checks already completed

- `pnpm --filter @workspace/api-server run test:benchmark-guards`: 13 passing tests.
- `ai-transport.test`: 8 passing tests on a loopback server.
- `pnpm --filter @workspace/api-server run test:closure`: 46 passing tests against a temporary loopback PostgreSQL database.
- API-server typecheck/build and `pnpm --filter @workspace/db run check`: passed.
- The local benchmark plan estimated $4.517088 worst case against its $5 limit. Its scripted simulation produced 144 local-only synthetic outputs. Neither is evidence of provider model quality.
