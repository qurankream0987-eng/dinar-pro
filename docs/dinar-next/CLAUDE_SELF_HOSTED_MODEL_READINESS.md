# Self-hosted model readiness (fixed cost, not deployed)

**Reuses `deploy/self-hosted-llm/`:** the Caddy gateway, `serve-vllm.sh` and DINAR's `OPENAI_COMPATIBLE` slot. No new runtime.

## Candidates

| | Qwen3.5-9B | gpt-oss-20b | DeepSeek-R1-Distill-Qwen-14B |
|---|---|---|---|
| Licence | Apache-2.0 (mirrors; confirm official LICENSE) | Apache-2.0 | MIT |
| Tool calling | Yes. vLLM ≥ 0.17.0, `--enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3` (vLLM recipe). SGLang tool calls reported broken | Native function calling; harmony format required (vLLM handles it) | **No documented tool calling**; community reports failure |
| Memory | ~18 GB BF16 weights | ~16 GB (MXFP4 MoE) | ~30 GB BF16 |
| Benchmark contract | yes | **added** (`openai/gpt-oss-20b`) | **not added**: DINAR's loop needs structured tool calls; a text tool call fails closed (SH-04) |
| Thinking control | `DINAR_AI_THINKING=disabled` | reasoning effort set via system prompt, not `enable_thinking` (leave `DINAR_AI_THINKING` unset) | always reasons; long outputs |

**Recommendation for the first measured run:** both fit one 24 GB GPU (L4/A10G), with gpt-oss-20b leaving more KV headroom.
- Qwen3.5-9B (Arabic breadth);
- gpt-oss-20b (tool reliability).

## Capacity is finite

One GPU serves a bounded number of concurrent turns (`max-num-seqs`).

**Fixed-cost overload:** under fixed cost, overload shows up as latency or 503s, not as a bill. DINAR already handles this:
- an HTTP 503 fails closed as `AIProviderError`;
- the circuit breaker opens;
- the conversation falls back to the deterministic paths;
- `DINAR_AI_DISABLED_PROVIDERS` turns the provider off without a deploy.

**Cost per completed task** = approved hourly rate × measured GPU time ÷ completed tasks. It is measured, never assumed.

## Owner approvals still required

These are the six approvals in `deploy/self-hosted-llm/README.md` §8:
1. model and licence;
2. GPU provider, region and budget;
3. gateway host;
4. secrets;
5. benchmark run;
6. switching the active model.
