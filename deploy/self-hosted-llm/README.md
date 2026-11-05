# DINAR — self-hosted open-weight model (engineering preparation)

**Status:** prepared and locally tested, **not deployed**.
- No GPU has been provisioned and no paid inference has run.
- DINAR's active model is unchanged.
- Everything below that names a price, a parser flag or a model revision must be re-verified at approval time.

## 1. Architecture

```
DINAR API (Railway, server only)
  └─ existing model gateway, slot OPENAI_COMPATIBLE   (no new runtime)
       DINAR_AI_BASE_URL=https://<gateway-host>/v1     (HTTPS required outside development)
       DINAR_AI_API_KEY=<gateway token>                (server secret, never sent to clients)
       DINAR_AI_THINKING=disabled                      (Qwen chat_template_kwargs.enable_thinking=false)
         │  HTTPS, Bearer token
         ▼
GPU host (provider of the owner's choice)
  Caddy gateway (Caddyfile, this directory)
    - only POST /v1/chat/completions and GET /health
    - 401 without the gateway token; 404 for every other vLLM route
    - 256 KB request body limit; headers and URIs not logged
         │  127.0.0.1 only, separate internal key
         ▼
  vLLM OpenAI server (serve-vllm.sh): pinned image digest, pinned model revision,
    max-model-len, max-num-seqs, GPU memory fraction, tool-call parser
```

**What stays exactly as it is in DINAR:**
- authenticated user context, market isolation, the capability registry (22 entries) and role filtering;
- confirm-before-mutate, pending actions, action receipts and the claim guard;
- AI usage reservations, the spend refusal for unpriced models, the circuit breaker and the per-provider disable switch.

The model only proposes tool calls. Orders, payments, commissions and business writes still go only through the canonical services, after the user's confirmation.

## 2. Gateway integration (this branch)

| Change | Where | Test |
|---|---|---|
| `DINAR_AI_THINKING=disabled` sends `chat_template_kwargs: {enable_thinking: false}`. Opt-in, validated, OPENAI_COMPATIBLE only; shown in the readiness view | `src/ai/model-gateway.ts` | `self-hosted-model` SH-01, SH-02, SH-05 |
| Reasoning text in `reasoning_content` or `<think>` content never becomes the turn | existing behaviour | SH-03 |
| A text-only `<tool_call>` (parser not configured), HTTP 503 overload, a timeout and a malformed body all fail closed as `AIProviderError` | existing behaviour | SH-04 |
| Plain HTTP to a remote host is not configured; loopback HTTP is development only; `DINAR_AI_DISABLED_PROVIDERS=OPENAI_COMPATIBLE:<model>` or `*` disables it without a deploy | existing behaviour | SH-05 |
| No automatic fallback unless `DINAR_AI_FALLBACK_*` is explicitly set | existing behaviour | SH-06 |
| Live benchmark: `SELF_HOSTED` provider, HTTPS endpoint from `DINAR_BENCH_SELF_HOSTED_BASE_URL`, dedicated `DINAR_BENCH_SELF_HOSTED_API_KEY`, contracts for both Qwen candidates | `test/live-model-benchmark-core.ts` | SH-07, `live-model-benchmark` 26/26 |

Gateway boundary tested locally with Caddy 2.10 and a recording upstream: see the commit message.

## 3. Candidates (to be confirmed before approval)

| | Qwen/Qwen3-14B | Qwen/Qwen3.5-9B |
|---|---|---|
| Card | huggingface.co/Qwen/Qwen3-14B | huggingface.co/Qwen/Qwen3.5-9B |
| Serving (card) | vLLM ≥ 0.8.5; example `--reasoning-parser deepseek_r1`; `enable_thinking` switch documented | SGLang example uses `--tool-call-parser qwen3_coder`; **vLLM flag not confirmed** |
| Licence | to confirm on the card's LICENSE file | Apache-2.0 per third-party mirrors; **to confirm on the official repo** |
| Exact revision | pin a commit at approval | pin a commit at approval |

The two models do **not** share parsers.
- `serve-vllm.sh` refuses to start without an explicit `DINAR_TOOL_CALL_PARSER`, model revision and image digest.
- If the parser is wrong, the model's tool call arrives as text. DINAR then refuses it (SH-04) and never executes it.

## 4. GPU sizing (arithmetic, not a measurement)

**Weights.** At BF16, the weights alone take about 2 bytes per parameter:
- Qwen3-14B: about 30 GB.
- Qwen3.5-9B: about 18 GB.

**KV cache for Qwen3-14B.** With its grouped-query attention, the KV cache is about 40 layers × 8 KV heads × 128 × 2 (K and V) × 2 bytes ≈ **160 KB per token**. That is about 2.6 GB per 16k-token sequence. The 9B model's attention layout must be read from its `config.json` before sizing.

**Candidate GPUs:**

| GPU | VRAM | Qwen3-14B BF16 | Qwen3.5-9B BF16 |
|---|---|---|---|
| L4 / A10G | 24 GB | does not fit (FP8 only, little KV) | fits, small KV budget |
| L40S / A6000 | 48 GB | fits, ~15 GB KV (several 16k sequences) | comfortable |
| A100 / H100 | 80 GB | comfortable, highest concurrency | over-provisioned |

**Starting point for measurement:** one 48 GB GPU with `max-model-len 16384` and `max-num-seqs 16`.

## 5. Deployment models and cost (verify prices at approval)

Public 2026 price pages and comparisons disagree, and most are vendor or affiliate posts. So this plan records only what must be measured, not numbers to trust.

| Model | Pays for | Cold start | Fits DINAR when |
|---|---|---|---|
| Dedicated always-on pod | every hour, idle or not | none once loaded | steady traffic, or strict first-reply latency |
| Serverless GPU endpoint | active seconds (+ storage) | model load on scale-from-zero (tens of seconds to minutes for 18–30 GB weights) | bursty, low early traffic, if a cold first reply is acceptable |
| Managed dedicated endpoint | provider's hourly rate + margin | none | the owner wants less operations work |

**Evaluation procedure (owner-approved, time-boxed):**
1. Run the live benchmark against each deployment.
2. Measure:
   - cold-start time;
   - time to first token and tokens per second;
   - GPU utilisation at 1, 4 and 16 concurrent turns;
   - tool-call validity rate;
   - wall time per completed task.
3. Effective cost per completed task = approved hourly rate × measured GPU time ÷ completed tasks.

Prices are recorded from the provider's own pricing page on the day of the run. The candidate contracts therefore carry a 0 per-token price; the cost control is the approved GPU-hour budget.

## 6. Arabic evaluation (live, after approval)

- **Engine:** the existing live benchmark. It is approval-gated and uses blind rater sheets, a per-approval ledger and dedicated keys. Its tasks plus the 42-case routing evaluation give the held-out set.
- **Coverage:** MSA, Gulf, Levantine, mixed Arabic/English, negation, multi-step tasks, card references, partner and refund questions, unknown capabilities, prompt injection and unauthorized requests.
- **Status:** not run. No GPU endpoint exists, and the scripted results on this branch measure DINAR's orchestration, not the model's comprehension.
- **Data:** synthetic only. Real customer conversations are not used without authorization.

## 7. Operations

- **Health:** `GET /health` through the gateway. DINAR's `/api/readyz` and operator readiness show the configured slot, host, credential presence (never the value) and `thinking`.
- **Disable immediately:** `DINAR_AI_DISABLED_PROVIDERS=OPENAI_COMPATIBLE:<model>` (no deploy). The conversation falls back to DINAR's deterministic paths.
- **Rollback:** restore the previous `DINAR_AI_*` values; the GPU host can be stopped independently.
- **Rotation:** two secrets, rotated separately:
  - gateway token (DINAR → gateway);
  - internal key (gateway → vLLM).
- **Limits:** the gateway caps body size. vLLM caps context and concurrency. DINAR caps output tokens (`DINAR_AI_MAX_OUTPUT_TOKENS`), turn deadline (`DINAR_MODEL_TIMEOUT_MS`), retries, tool rounds and per-user AI usage.
- **Logs:** the gateway drops headers and URIs, and vLLM runs with `--disable-log-requests`. DINAR already redacts prompts in its own logs.

## 8. Owner approvals required

1. Model choice and its licence, after reading the official LICENSE.
2. GPU provider, region (data residency), deployment model and a capped GPU-hour budget for the evaluation run.
3. Creation of the gateway host and its DNS name.
4. Storing the two secrets in the provider's secret store and DINAR's Railway variables.
5. The live benchmark run (approval id, budget, synthetic data only).
6. Switching DINAR's active model (`DINAR_AI_PROVIDER=OPENAI_COMPATIBLE`), separately from all of the above.
