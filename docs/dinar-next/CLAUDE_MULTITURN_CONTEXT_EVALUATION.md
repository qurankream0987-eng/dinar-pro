# Multi-turn context evaluation

**Branch:** `claude/dinar-next-intelligence`.
- Start: `623014b`.
- Not merged with Codex.
- Codex's branch was not touched.

**Suite:** `artifacts/api-server/test/multiturn-context.test.ts`. It exercises whole conversations over real HTTP, the real turn runtime and a disposable loopback PostgreSQL. It is not a test of text-parsing functions.

## What this measures, and what it does not

The model gateway is a stub: it never proposes a tool and always answers `MODEL_FALLBACK`.

**Deterministic success**
- A turn passes only when DINAR's own runtime resolved it (`model: false`) and the reply carries the expected listing or surface.
- These are the results reported below.

**Model hand-off**
- A turn that reached the stub is recorded as `model: true`.
- It counts as passing only where the expectation explicitly accepts a *safe hand-off* (no commercial action prepared). That proves routing and safety, not comprehension.
- Two such turns exist (H04 «طيب وأكواب شاي؟», M06/H06 acknowledgements).

**Live model**
- Not measured. No paid API or GPU was used.

## Safety, asserted on every turn (all runs)

These are hard failures, not measured scores:
- no order, inquiry or negotiation exists for the buyer;
- the cart stays empty;
- no listing's price, quantity or status changes;
- a stranger gets 404 on the buyer's conversation and cannot post a turn to it.

In M06 and H06, «نعم» or «اوكي» after a cancelled purchase review executes nothing.

## Results

| Set | Before (`623014b`) | After |
|---|---|---|
| Tuned M01–M07 (29 turns) | 3/7 scenarios, 22/29 turns | **7/7, 29/29** |
| Held-out H01–H08 (27 turns), first run | 6/8, 24/27 | **8/8, 27/27** |
| Safety | PASS | PASS |

The held-out set was written after M01–M07 were fixed and first run unchanged.
- Its first run exposed two real defects: D8 and D9.
- One expectation was wrong and was corrected, not deleted: H04 turn 2 now accepts a real search *or* a safe model hand-off.

## Proven defects, all fixed with general rules (no phrase lists)

| # | Turn (scenario) | Before | Cause | Fix |
|---|---|---|---|---|
| D1 | «طيب واللي قبله؟» (M01) | model fallback | no notion of the listing in focus | `parseContextualReference` PREVIOUS/NEXT, resolved against the last single-listing card of the current result set; honest edge reply at the ends (H08) |
| D2 | «أي واحد الأرخص فيهم؟» (M01) | re-sorted list | superlatives were only sort orders | CHEAPEST/PRICIEST over the result set's persisted prices when qualified by a set word, a which-question or a correction. Bare «الأرخص» stays a sort |
| D3 | «هذا مو اللي أقصده، أقصد الأغلى» (M01) | new sorted search | rejection preface unknown; correction signal lost | new correction prefix; the correction flag qualifies the superlative |
| D4 | «لا، أقصد الثالث، ولا تضيفه للسلة» (M02) | CLARIFY | trailing refusal kept the reference from parsing | `requestCore` strips the correction and trailing refusals for **reference resolution only**. The listing is opened read-only |
| D5 | «ارجع للابتوبات اللي شفناها» (M03) | model fallback | no return to an earlier result set | the matching stored search (by topic stem) is re-run live as the current results |
| D6 | «هل ينفع أضيف الأول للسلة بعدين؟» (M05) | cart-add path | first-person question read as a command | `addToCartIntent`: «هل» + first-person verb is information. Second person («هل تضيفه؟») stays a request, still confirmed |
| D7 | «لا تشتري ولا تضيف شي، بس قارن بينهم» (M05) | empty search | refusal preface hid the comparison | comparison (read-only) matches on `requestCore` |
| D8 | «لا مش هذا، قصدي الأول، بس ما تحطه في السلة» (H03) | CLARIFY | refusal introduced by «بس / لكن» | trailing-refusal connectors |
| D9 | «خلينا نرجع للجوالات» (H04) | "which offer?" | any «نرجع» was read as returning to a price offer | negotiation treats a return as offer-related only when its target is unnamed or names an offer (`repair.meant`); the current topic can be re-run too |

**Recorded, not changed:** for a buyer, «كم مستحقاتي؟» opens the dues surface with generic copy («تفضل، يمكنك متابعة طلبك هنا»). No data leaks, but the wording is not specific. This is a copy issue for a later wave.

## Files

- `src/ai/intent.ts`:
  - `requestCore`;
  - `refusesCommercialAction`;
  - rejection prefix;
  - trailing refusals;
  - first-person questions.
- `src/ai/arabic-normalization.ts`: `parseContextualReference`.
- `src/ai/conversation-runtime.ts`:
  - `resolveConversationReference`, called before the buyer turn and before the correction clarify;
  - `recentListingResultSets`;
  - `focusedIndex`;
  - return to topic.
- `src/ai/buyer-turn.ts`: comparison on `requestCore`.
- `src/ai/negotiation-turn.ts`: return-to-topic is not an offer reference.

Every reference resolves only against a persisted result set of the same conversation and market, and opens listings through `getResource` (read-only). The model path, the confirmation flow and the canonical services are unchanged.
