# Model profiles v1 — optional operator configuration, disabled inference unchanged

Profiles bind to the existing gateway; they do not select credentials, change endpoint/privacy, approve a model, enable calls or bypass spend/capability policy. Legacy configuration remains valid when no profile configuration is supplied. Once a manifest is supplied, every configured PRIMARY/FALLBACK/HEAVY slot must have its matching selector. Invalid bindings fail closed and report no raw manifest content.

New names:

- DINAR_AI_MODEL_PROFILES: bounded JSON (24,000 characters, at most 16 entries), schemaVersion=1, releaseId and profiles.
- DINAR_AI_PROFILE: primary profile ID.
- DINAR_AI_FALLBACK_PROFILE / DINAR_AI_HEAVY_PROFILE: selectors for existing optional slots.

Example manifest (fixtures only; NOT an approved model/provider or live configuration):

```json
{"schemaVersion":1,"releaseId":"synthetic-eval-v1","profiles":[{"id":"general","revision":1,"provider":"OPENAI_COMPATIBLE","model":"fixture/general","capabilities":{"toolCalling":true,"structuredOutput":"TOOL_SCHEMA","imageInput":false,"tokenStreaming":false,"maxInputChars":60000}}]}
```

Exact provider/model must match existing DINAR_AI_PROVIDER/DINAR_AI_MODEL configuration. Keys and endpoint fields are rejected in profiles. Duplicate IDs, unknown schema, unsupported structured-output/token-streaming claims and image-input mismatch are rejected. Preserve old manifest revisions externally for reproducibility; revision monotonicity across deployments is an operator review responsibility, not a new database registry.

maxInputChars is an operator-declared limit on serialized JSON messages+tool schemas, **not a token-context guarantee**. Calibrate conservatively against the actual model tokenizer before approval. Existing output-token and whole-turn limits still apply. Each dispatch through proposeThroughGateway checks its selected slot's limit before provider contact; local refusals create no billed attempt. A profiled fallback must preserve primary declared image support; configured slots without matching profiles fail closed when the manifest is enabled. Legacy unprofiled behavior is preserved, not retroactively certified capability-aware. A larger context requirement cannot silently fall through to a smaller profiled fallback.

Readiness exposes profile id/revision/releaseId, declared capabilities and DECLARED_NOT_LIVE_VERIFIED; it does not expose secrets. Final interpretation metadata/logs include exact active-slot profile identity alongside existing provider/model/latency/usage and per-attempt records. Existing aiCostEvents remain the monetary authority; no financial schema or snapshot changes. Profile IDs are not new cost-price keys: pricing remains exact accounting provider+model. Profile identity is not added as a new column on every monetary event; correlate existing modelCall/turn telemetry with usage reservations/cost evidence during review. releaseId is operator supplied, not attestation of deployed Git SHA; integration receipt must bind it to the exact accepted source and manifest hash.

OpenRouter staging still requires OPENAI_COMPATIBLE, https://openrouter.ai/api/v1, exact non-free model, one provider, DATA_COLLECTION=deny, ZDR=true, REQUIRE_PARAMETERS=true. Compatible HEAVY still reads DINAR_AI_FALLBACK_API_KEY; this package does not silently rename protected credentials. Explicit vision profile configuration can use DINAR_AI_VISION_MODEL_PROFILES and DINAR_AI_VISION_PROFILE through existing vision namespace mapping. Text profile capabilities do not verify actual remote vision. Retain dedicated vision credentials.

Capability evidence:

| Feature | Local engineering evidence | Remaining live evidence |
|---|---|---|
| Tools / structured output | Existing TOOL_SCHEMA protocol plus strict server validation; profile requires it | Exact approved model/provider tool compliance unverified |
| Vision | Profile image declaration and existing isolated vision runtime | Remote image support, billing and privacy unverified |
| Reasoning | Existing separate-model HEAVY and limited provider-specific effort | OpenRouter per-call effort remains unsupported; actual reasoning quality unverified |
| Streaming | Existing status/delta/complete/error SSE, buffered final text | No provider token streaming implemented or claimed |
| Failures/fallback | Existing retries, timeout, breaker, explicit fallback, cost accounting; new per-slot serialized context refusal | Real-provider errors and remote compatibility unverified |

Keep DINAR_AI_MODEL_FALLBACK=false until explicit budget authorization and staging gate approval. No profile, model, provider, price or paid-call policy is activated in this branch.
