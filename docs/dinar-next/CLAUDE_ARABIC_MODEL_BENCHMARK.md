# Arabic model benchmark (prepared, not run)

**Status:** no live or open-weight model has been evaluated. Nothing here is a model score.

**Ready:**
- the live benchmark (approval-gated, blind rater sheets, ledger, dedicated keys);
- `SELF_HOSTED` contracts for Qwen3-14B, Qwen3.5-9B and gpt-oss-20b, at 0 per-token price;
- the 42-case routing evaluation (scripted, orchestration only: 42/42 in LEGACY, HYBRID and MODEL_FIRST).

**Held-out coverage to run after approval:**
- MSA, Gulf, Levantine;
- mixed Arabic/English;
- negation;
- multi-step plans (MS-02 style);
- card references;
- partner, refund and policy questions;
- unknown capabilities;
- prompt injection;
- unauthorized requests (seller tools as buyer, forged ids).

**Metrics:**
- tool-call validity;
- correct tool and arguments;
- refusal correctness;
- Arabic answer quality (blind raters);
- time to first token;
- wall time per task;
- GPU-seconds per completed task.

Synthetic data only.
