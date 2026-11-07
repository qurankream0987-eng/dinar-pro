# Model intelligence benchmark (G9)

## A. Deterministic contract acceptance: PASS

Every Command 02 suite uses a repeatable test gateway. This proves routing, tool authority, renderer contracts, persistence and fallbacks. It does **not** prove language understanding.

## B. Real model intelligence acceptance: **BLOCKED_PROVIDER**

Environment check at execution time:
- no DINAR provider credential (`OPENAI_*`, `DEEPSEEK_*`, `GROQ_*`, `DINAR_AI_*`, `DINAR_BENCH_*` unset);
- no local model server (ports 11434 / 8000 / 8080);
- no GPU.

The coding agent's own API endpoint is not a DINAR provider and was not used.

**Therefore nothing here shows GPT-level or any live-model intelligence.** Not measured:
- dialect understanding (Gulf, Levantine, Egyptian, MSA, English, mixed);
- implicit goals («خل التطبيق يريح عيوني»);
- tool-choice accuracy;
- UI composition relevance;
- structured-output validity;
- latency;
- cost.

## Ready for an approved run

**Harness:** `test/live-model-benchmark-core.ts` + `live-model-benchmark` (approval-gated, blind rater sheets, per-approval ledger, dedicated keys).

**Contracts:**
- Qwen3-14B, Qwen3.5-9B and gpt-oss-20b as `SELF_HOSTED` (0 per-token, GPU-hour budget);
- hosted contracts as listed in the core.

**Held-out cases to run:**
- the G1 list in this command;
- the 42-case routing evaluation;
- `multiturn-context` M / H sets;
- `chat-settings` G5;
- the coffee multi-step plan;
- the G6 shopping + Connect request.

**Owner approvals needed:**
1. Provider or GPU.
2. Budget.
3. Synthetic-data-only run.
