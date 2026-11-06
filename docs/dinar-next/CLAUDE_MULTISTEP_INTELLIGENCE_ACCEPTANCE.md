# Multi-step intelligence acceptance

**Suite:** `test/multistep-intelligence.test.ts`. Scripted model: the scripted gateway decides the tool calls, and DINAR's real services and guards run.

| ID | Journey | Proves |
|---|---|---|
| MS-01 | «ماذا تستطيع أن تفعل؟» as buyer and as seller | catalogue is role-filtered (buyer has no `readSellerDues`) |
| MS-02 | «أريد أبدأ مشروع قهوة، اقترح اسم وبعدها افحص دومين وبعدها دوّر مصمم» | 3-step plan; names from the model, domains as CONNECT_RESULTS, honest "no partner offer" |
| MS-03 | usage + late orders + issues in one request | multiple reads composed, no tool names in the reply |
| MS-04 | policy questions | `readPolicy`, unknown key → honest not-found |
| MS-05 | Connect status for a non-partner + forged `partnerId` argument | `NOT_PERMITTED`; strict schema rejects the forged argument |
| MS-06 | bare «كم باقي؟» with no context | CLARIFY, no model call |
| MS-07 | model calls a refused tool | refusal reported honestly, no success text |

**Regression battery on `7f84cfb`:** all green, outbound=0.

| Suite | Tests |
|---|---|
| model-native-routing | 14 |
| intelligence-capabilities | 8 |
| universal-negotiation-acceptance | 38 |
| multistep-intelligence | 7 |
| ai-foundation-acceptance | 13 |
| ai-foundation-02-acceptance | 13 |
| capability-init-order | 6 |
| wave04-d10-d11 | 14 |
| wave04-d10-d12 | 20 |
| intelligence-routing-eval (42 cases) | 42 |
| live-model-benchmark | 26 |
| self-hosted-model | 7 |

The earlier 26-suite run (488 tests) was also green after the three fixes:
- U-33;
- D6-AI-01 tool list;
- INT-07 external classification.

Typecheck is clean.
