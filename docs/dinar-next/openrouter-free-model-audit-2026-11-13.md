# OpenRouter free-model audit — 2026-11-13

## Decision

No model is qualified for DINAR user content or production. The catalog currently exposes four technically relevant exact `:free` candidates examined below, but zero price and tool metadata do not establish Arabic answer quality, account eligibility, or DINAR privacy suitability.

The two Gemma 4 IDs already present in DINAR's isolated synthetic-benchmark plan remain the only owner-reviewed benchmark candidates. This audit does not add models to an allowlist, change a provider default, or authorize any inference request. LFM3-1.7B is documented as Arabic-capable, but its provider's retention/training terms and its Arabic task quality remain insufficiently established for DINAR; it is not added to the benchmark set. ERNIE 5.5 Flash Preview has no Arabic-specific evidence in the reviewed official release.

## Method and limits

Checked public OpenRouter catalog and endpoint metadata, OpenRouter's public policy pages, and model-publisher documentation on 2026-11-13. The catalog query for zero-priced entries supporting `tools` returned 15 entries; the four below were examined in detail because they combine current tool metadata with official model documentation relevant to this audit. Each exact `:free` endpoint was checked for both prompt and completion price, provider, context/output limits, `tools`, and `tool_choice.required`.

These are public documentation and metadata reads only. No account endpoint, credential, inference request, account credit balance, or account-specific quota was checked. Catalog metadata is a dated snapshot, not a price guarantee or evidence of the user's eligibility. Tool metadata does not prove that a model will produce valid DINAR turns.

## Candidate matrix

| Exact OpenRouter ID | Catalog price; context / max output | Tool compatibility | Endpoint provider and published data terms | Arabic evidence and assessment |
| --- | --- | --- | --- | --- |
| `google/gemma-4-31b-it:free` | `$0` prompt / `$0` completion per token; 262,144 context / 32,768 max completion | `tools`, `tool_choice`, and required function choice are advertised. Dedicated `structured_outputs` is not listed; DINAR's current request uses its JSON-Schema function tool instead. | Google AI Studio. OpenRouter's provider table says prompts are retained for 55 days and not used for training. This is not zero data retention. | Gemma 4's model card reports 35+ languages supported out of the box and 140+ languages in pretraining, but the reviewed card gives no Arabic-specific result. Multilingual coverage is a reason to benchmark, not evidence of Arabic quality. Existing synthetic-benchmark candidate only. |
| `google/gemma-4-26b-a4b-it:free` | `$0` prompt / `$0` completion per token; 262,144 context / 32,768 max completion | Same advertised tool and required function-choice support as the 31B entry; no dedicated `structured_outputs` parameter listed. | Google AI Studio; same 55-day retention and no-training disclosure. Not zero data retention. | Same model-card evidence and limitation as the 31B entry. Existing synthetic-benchmark candidate only. |
| `liquid/lfm-3-1.7b:free` | `$0` prompt / `$0` completion per token; 262,144 context / 8,192 max completion | `tools`, `tool_choice`, required function choice, and `structured_outputs` are advertised. | Liquid. OpenRouter's provider table reports retention as unknown and says provider use for training may occur. Not acceptable for real user content on this evidence. | Liquid's exact-model documentation lists Arabic among 16 languages and describes tool calling and structured output. It also cautions that the 1.73B model is not recommended for complex multi-step reasoning. Language support is not a DINAR Arabic-quality evaluation. Not in the owner-reviewed benchmark set. |
| `baidu/ernie-5.5-flash-preview:free` | `$0` prompt / `$0` completion per token; 1,024,000 context / 921,600 max completion | `tools`, `tool_choice`, required function choice, and `structured_outputs` are advertised. | Endpoint label is Baidu; OpenRouter's provider table names Baidu Qianfan and reports unknown retention and no training. The label-to-policy mapping is not independently established here, so endpoint privacy remains unverified. | Baidu's official release describes a 280B-total / 14B-active preview with a 1M context and agent examples, but the reviewed release does not provide Arabic-specific support or quality evidence. Not in the owner-reviewed benchmark set. |

OpenRouter's catalog values are per token and were explicitly read from each endpoint's `pricing` object. A base model ID without `:free` is a different catalog entry and can be priced; never remove the suffix or substitute `openrouter/free`. The dynamic `openrouter/free` router does not pin an exact model and is rejected by DINAR's exact-ID policy.

## Shared limits and privacy constraints

- OpenRouter's published free-model limits are 20 requests per minute and 50 requests per day for accounts below $10 in lifetime credits, or 1,000 per day at/above that threshold. This is account-level policy, not a verified limit for this project. No credit balance or eligibility was checked, and no credits should be purchased for this audit.
- These figures do not establish that a particular account can invoke a model, that the provider is currently available, or that a request will remain free. A free catalog row only describes the snapshot.
- The Gemma endpoints' disclosed 55-day provider retention is incompatible with a zero-retention claim. The other reviewed candidates have unknown retention; Liquid may train on data. None is approved for real user content by this audit.
- DINAR's deployment privacy controls require a pinned provider, parameter compatibility, data-collection denial, and zero-data-retention routing. A public free endpoint listing does not prove that the exact free endpoint is available under those filters. Do not relax privacy routing to make a candidate work.
- Free-only quota exhaustion must remain a visible failure. There is no paid fallback, dynamic router, or automatic model substitution.

## Compatibility and evidence links

The local fixtures added with this audit require a literal `:free` ID, explicit zero prompt and completion prices, `tools`, `tool_choice`, and advertised `required` function choice. They also prove that catalog compatibility alone does not populate DINAR's owner-reviewed allowlist. Existing loopback-only Gemma tests cover exact returned model identity, the canonical strict `dinarConversationTurn` schema, unsupported/text-only tool output, pinned routing, and privacy parameters. A focused provider test covers a 429 quota response and refusal to configure a fallback. All checks are deterministic and use local mocks.

- [OpenRouter models API: zero-priced tool catalog query](https://openrouter.ai/api/v1/models?max_price=0&supported_parameters=tools)
- [Gemma 4 31B free endpoint metadata](https://openrouter.ai/api/v1/models/google/gemma-4-31b-it:free/endpoints)
- [Gemma 4 26B A4B free endpoint metadata](https://openrouter.ai/api/v1/models/google/gemma-4-26b-a4b-it:free/endpoints)
- [LFM3-1.7B free endpoint metadata](https://openrouter.ai/api/v1/models/liquid/lfm-3-1.7b:free/endpoints)
- [ERNIE 5.5 Flash Preview free endpoint metadata](https://openrouter.ai/api/v1/models/baidu/ernie-5.5-flash-preview:free/endpoints)
- [OpenRouter Models API documentation](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter free model variants](https://openrouter.ai/docs/guides/routing/model-variants/free)
- [OpenRouter FAQ and free rate limits](https://openrouter.ai/docs/faq)
- [OpenRouter provider logging and retention](https://openrouter.ai/docs/guides/privacy/provider-logging)
- [OpenRouter provider selection and privacy controls](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Google Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4)
- [Liquid AI LFM3-1.7B documentation](https://docs.liquid.ai/lfm/models/lfm3-1.7b)
- [Liquid AI tool-use documentation](https://docs.liquid.ai/lfm/key-concepts/tool-use)
- [Baidu ERNIE 5.5 Flash Preview release](https://ernie.baidu.com/release/ernie-5-5-flash-preview/)

## Conclusion

No candidate satisfies all requirements for real DINAR traffic. Preserve the existing exact Gemma IDs only as synthetic benchmark candidates pending separate owner approval and Arabic evaluation; keep the deployable provider defaults, active model allowlists, and live-provider behavior unchanged.
