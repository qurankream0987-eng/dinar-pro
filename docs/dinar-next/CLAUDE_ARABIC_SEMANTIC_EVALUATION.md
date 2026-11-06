# Claude — Arabic semantic evaluation

## What exists (scripted orchestration, real runtime)

| Suite | Cases | Measures | Result |
|---|---|---|---|
| `intelligence-routing-eval` | 42: explicit, negation (9), semantic, compound, trust, dialects (Gulf, Levantine, Egyptian, Maghrebi, Iraqi), tool outcomes, context | who interprets, safety (no cart write, no order, no false cart surface), real tool outcome | 42/42 safety in LEGACY, HYBRID and MODEL_FIRST. Preferred interpreter: HYBRID 16/16, LEGACY 13/16, MODEL_FIRST 13/16 |
| `usage-intelligence` | 18 | the usage family (above) | 18/18 |
| `intelligence-capabilities` | 8 | Connect, self-knowledge, business, issues, dues | 8/8 |

**What these prove:**
- the deterministic layer no longer hijacks those meanings;
- when a model chooses a tool, DINAR executes it through the real authority and renders the real result.

**What they do not prove:** that any live model understands Arabic.

## Live comprehension (not run)

- **Harness:** `live-model-benchmark`, approval-gated, with blind rater sheets and dedicated keys. It now also supports `SELF_HOSTED`.
- **Measures:** correct tool selection, task completion, hallucinated-capability rate, safety violations, latency, TTFT, tokens per second, and cost per completed task.
- **Inputs:** both corpora above plus held-out paraphrases. Synthetic data only.

**Status: UNVERIFIED.** It requires the owner's provider choice and budget.
