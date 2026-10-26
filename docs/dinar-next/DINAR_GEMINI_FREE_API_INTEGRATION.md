# DINAR — Gemini free-tier API pilot

**Checked:** 2026-10-24  
**Status:** native adapter and four-request synthetic benchmark are implemented locally. No Gemini API request has been sent. Live execution remains blocked pending owner verification and a dedicated benchmark secret.

## Verified model

Two relevant text models verified in Google's current pricing and model pages are `gemini-3.5-flash-lite` and `gemini-3.8-flash`; both list free standard input/output and support function calling. The pilot is pinned to `gemini-3.5-flash-lite`, a low-latency model aimed at agentic and simple tasks. The allowlist contains only those exact IDs; the four-call pilot schema accepts only the selected Flash-Lite model.

- Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing) lists standard input and output as free of charge on the Free Tier.
- The Flash-Lite [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) lists a 1,048,576-token input limit, a 65,536-token output limit, function calling, and structured outputs.
- The higher-capability [Gemini 3.8 Flash page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) also lists function calling and the pricing page lists free standard input/output; it is documented but not part of this four-call pilot.
- The [GenerateContent API](https://ai.google.dev/api/generate-content) accepts system instructions, function declarations, automatic function calling, and provider token usage.
- The pilot deliberately allows only this exact model ID. It does not accept aliases, paid models, or automatic model fallback.

The public model/pricing pages establish that the model is offered on the free tier; they do **not** establish that this owner's Google AI Studio project is currently on that tier, has quota remaining, or has billing disabled. Google applies limits per project and publishes the account-specific model limits in [AI Studio](https://aistudio.google.com/rate-limit). The owner must check the project and record confirmations in the private benchmark config before a live run.

## Privacy and billing boundary

Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms) state that unpaid-service inputs and outputs may be reviewed by people and used to improve Google products. The terms warn not to send sensitive, confidential, or personal information to unpaid services. Therefore:

- Only the four synthetic prompts below may be used in this pilot. Do not use real conversations, customer data, listing details, credentials, or personal information.
- The owner must explicitly confirm acceptance of the unpaid-service terms.
- The owner must confirm in AI Studio that this project is on the free tier and has no billing enabled. A local budget of `$0.01` is only a guardrail, not a provider billing cap.
- The key must be the dedicated `DINAR_BENCH_GEMINI_API_KEY`; never use a production or development runtime key.
- No inference runs until the owner has entered the dedicated key through Replit Secrets and set all three Gemini confirmation fields to `true` in the private approval JSON.
- The Gemini gateway requires both free-only and benchmark-context flags, is development-only, uses the native `generateContent` endpoint, has no fallback, and requires zero retries. A quota error ends that task; it is not retried.
- Google Search/Maps grounding, caching, media upload, and other potentially chargeable tools are not requested.

## Four-request evaluation

One candidate, one repetition, concurrency one, no retries, and `maxRequestsPerCandidate: 4` are enforced by the schema and benchmark plan. Each turn makes at most one GenerateContent HTTP request. DINAR's existing `interpretWithModel` asks for one `dinarConversationTurn` function call; it does not execute a tool or make a function-result continuation request. A missing or invalid function call is recorded as a failure without another generation request. Thus the run can issue at most four provider requests, including failed calls.

| Synthetic task | Checks |
|---|---|
| Arabic explanation of solar and wind energy | Arabic response and basic content |
| Levantine search for an affordable used laptop | Dialect, DINAR search tool, entity argument |
| Follow-up about whether previously discussed solar panels suit a home | Synthetic conversation context |
| Request to pay for an order immediately | Safe refusal to claim payment execution |

This small pilot is a functional smoke test, not a statistically meaningful model comparison or production-quality approval.

## Local checks and owner steps

Network-free checks:

```sh
cd artifacts/api-server
pnpm exec esbuild test/gemini-gateway.test.ts --bundle --packages=external --platform=node --format=esm --outfile=.test-build/gemini-gateway.test.mjs
node --test .test-build/gemini-gateway.test.mjs
node test/run-benchmark.mjs live-model-benchmark.test
pnpm --filter @workspace/api-server run typecheck
```

For a future owner-approved run:

1. In Google AI Studio, verify `gemini-3.5-flash-lite` is available to the exact project, its current project-specific quota, free-tier status, and that billing is disabled.
2. Review and accept Google's unpaid-service data terms for the synthetic-only prompts.
3. Add `DINAR_BENCH_GEMINI_API_KEY` using Replit's secret-entry flow.
4. Copy `artifacts/api-server/test/gemini-free-benchmark.example.json` outside the repository. Complete the owner approval, set the three `gemini*Confirmed` / `gemini*Accepted` fields to `true`, and keep all limits unchanged.
5. Run the `plan` mode first. A live run additionally requires the explicit execution flag and matching approval ID already documented in the benchmark readiness guide.

This work does not change the production/default AI provider, any deployment, database, migration, billing setting, or secret. It does not grant permission to run the benchmark.
