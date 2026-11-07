# Claude — AI usage intelligence acceptance (owner's primary example)

**Implementation:**

| Piece | What it does |
|---|---|
| `readAiUsage` | Returns the same AI_USAGE card as the deterministic route, via the shared `aiUsageCardTurn`, with the ledger's numbers |
| `usageProjection` | Arithmetic on this period's real pace. Refuses to give a number without at least 6 hours of period and some use |
| Deterministic sufficiency | «يكفيني …» gets the same estimate, or an explicit "not enough data", **without a model call** |
| Bare «كم باقي؟» | Follows context: the stock of the listing in view, a clarification, or (only for sellers) seller stock. Never the AI allowance by default |

## Results (scripted model; `usage-intelligence` 18/18 PASS)

| Case | Interpreter | Surface |
|---|---|---|
| 5 explicit phrasings («كم تبقّى من استهلاكي», «كم باقي لي من حصتي», «ليش الذكاء وقف عندي», …) | deterministic, 0 model calls | AI_USAGE |
| 7 others incl. 5 held out («كم ضايل إلي؟», «شو استهلكت من الذكاء؟», «عندي مجال أسألك أكثر؟», «هل خلص رصيدي من الرسائل؟», «يا دينار شوفلي اللي باقي بحسابي») | model → readAiUsage | AI_USAGE |
| «كم باقي؟» with no context (buyer) | deterministic | CLARIFY (was MY_LISTINGS) |
| «كم باقي منه؟» after a search with 2 matches | deterministic | CLARIFY: which listing (was MY_LISTINGS) |
| «هل استهلاكي يكفيني حتى نهاية الأسبوع؟» | deterministic, 0 model calls | AI_USAGE + "not enough data" for a new account |
| «احسب لي المتبقي وبعدها ورني طلباتي المتأخرة» | planner: step 1 model → readAiUsage; «التالي» → orders | AI_USAGE, then ORDERS |
| Grounding | — | Card numbers = `aiUsageSummary`. The note forbids presenting a provider balance |
| Forged `userId`, `horizonDays: 90`, unknown `question` | — | all `CANONICAL_TOOL_REJECTED` |

**Not verified:** whether a live model selects `readAiUsage` for these phrasings. The scripted gateway chooses it.
