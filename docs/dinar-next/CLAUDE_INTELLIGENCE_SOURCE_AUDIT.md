# Claude — intelligence source audit

**Branch and base:**
- Branch `claude/dinar-next-intelligence`.
- Base: Codex `34bb754`. Codex head at the time of audit: `4143314`, with nothing newer.
- Initial SHA for this mission: `a20706f`.

**Evidence types used:**
- **source:** read in the code.
- **scripted:** run against the real runtime, API and disposable PostgreSQL with a deterministic model.
- **live:** a real model provider. **No live evidence exists in this report.**

## Architecture as it actually runs (source)

| Layer | File | Decides |
|---|---|---|
| Routing mode | `ai/routing-mode.ts` | `DINAR_AI_ROUTING_MODE`. Absent or unknown means **LEGACY**: deterministic first, model only when nothing answered |
| Deterministic handlers | `ai/conversation-runtime.ts`, `intent.ts`, `commerce-turn.ts`, `business-turn.ts`, `seller-management.ts`, `stock-question.ts`, `usage-intent.ts` | Explicit and sensitive commands. Regex-based by design |
| Model loop | `ai/smart-turn.ts` | Bounded tool rounds, per-call timeout, turn deadline, AI-usage reservation per round, duplicate-call refusal, claim guard |
| Tool authority | `ai/tool-registry.ts`, `ai/model-capability-tools.ts` | Schema-validated arguments. Actor and market from the server; role filtering from server rows |
| Capability map | `ai/capability-registry.ts` (23 entries), `ai/dinar-capabilities.ts` | The only list of what the model may call. Self-knowledge is derived from it (INT-07) |
| Gateway | `ai/model-gateway.ts` | Provider slots (PRIMARY / FALLBACK / HEAVY), HTTPS-only credentials, disable switch, circuit breaker, usage accounting |
| Planner | `ai/task-plan.ts` | Splits compound requests into at most 3 steps; each later step runs on «التالي» ("next") |

## Model reasoning vs deterministic rules (source + scripted)

- **Deterministic, kept on purpose:** confirmations and cancellations, cart and checkout writes, publication, negotiation decisions, explicit navigation, the usage card for explicit phrasing, and the seller's explicit stock questions. These are cheap, auditable and safe.
- **Model:** anything the deterministic layer does not claim, depending on the routing mode. In HYBRID it also handles soft misses.
- **Defects found and fixed during this mission, each now covered by tests:**
  1. A cart word not governed by its verb opened the cart.
  2. A refused-action clause polluted search.
  3. «عندي مشروع… وما أعرف من وين أبدأ» ("I have a project… don't know where to start") hijacked into business setup.
  4. A bare «كم باقي؟» ("how much is left?") from a buyer opened seller inventory.
  5. «يكفيني حتى نهاية الأسبوع؟» ("will it last until the end of the week?") ignored the question.
  6. An import cycle left the search tool without its input schema.
  7. A user could be blocked after an unconfirmed turn until reload.

## Not verified

The language quality of any live model on Arabic. That needs an approved provider and budget (`deploy/self-hosted-llm`, `live-model-benchmark`).
