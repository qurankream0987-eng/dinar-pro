# Claude — model routing evaluation

## Current configuration (source)

- **Routing mode:** `DINAR_AI_ROUTING_MODE`, default **LEGACY**.
- **Provider slots:**
  - PRIMARY defaults to GROQ in development.
  - Production needs an explicit, approved configuration (`DINAR_AI_PRODUCTION_APPROVED`).
  - Optional FALLBACK and HEAVY slots exist only when set.
- **Tiering:** `DINAR_AI_TIERING` LIGHT/HEAVY is off unless set.
- **Self-hosted:** `OPENAI_COMPATIBLE` slot plus `DINAR_AI_THINKING=disabled` (deploy/self-hosted-llm).
- **Spend controls:**
  - per-user AI usage reservation on every model round;
  - an unpriced model is refused;
  - per-provider disable switch and circuit breaker.
- **Never bypassed by fallback or escalation:** financial and security refusals happen on the server before or after the model.

## Policy as implemented

| Request | Path | Model calls (scripted measurement) |
|---|---|---|
| Explicit usage, orders, cart, confirmations | deterministic | 0 |
| Usage sufficiency estimate | deterministic arithmetic | 0 |
| Semantic or paraphrased request (HYBRID soft miss, LEGACY nothing found) | one model call plus ≤ N tool rounds | 2–3 (decide, tool, answer) |
| Compound | planner, one step per turn | per step |

**Recommendation:** HYBRID is the measured candidate (16/16 preferred interpreters, scripted). It is not proven optimal with a live model; confirm with the live benchmark before switching the production mode.

**Not measured:** live latency, cost and accounted usage. These need an approved provider.
