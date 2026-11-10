# DeepSeek live execution report

Generated from the result files in `evidence/`. Model: `deepseek-flash` (served as DeepSeek-V4.1-Flash), through DINAR's own gateway (`DINAR_AI_PROVIDER=DEEPSEEK`, HYBRID routing, max output 2,000 tokens, 0 retries). Costs below are DINAR's own `ai_cost_events` tokens priced at the last verified official peak rates (input $0.30/M cache-miss, $0.006/M cache-hit, output $1.20/M) — an upper bound; the provider balance is the authority (see the final readiness report).

## B baseline (live DeepSeek, pre-fix)

| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |
|---|---:|---:|---:|---:|---:|---:|
| G01 | 10 | 0 | 0 | 0 | 0 | 100.0% (10/10) |
| G02 | 8 | 4 | 0 | 0 | 0 | 66.7% (8/12) |
| G03 | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| G04 | 14 | 8 | 0 | 0 | 0 | 63.6% (14/22) |
| G05 | 8 | 2 | 0 | 0 | 0 | 80.0% (8/10) |
| G06 | 7 | 1 | 0 | 0 | 0 | 87.5% (7/8) |
| G07 | 6 | 0 | 0 | 0 | 0 | 100.0% (6/6) |
| G08 | 3 | 7 | 0 | 0 | 0 | 30.0% (3/10) |
| G09 | 7 | 1 | 0 | 0 | 0 | 87.5% (7/8) |
| G10 | 3 | 3 | 0 | 0 | 0 | 50.0% (3/6) |
| G11 | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| G12 | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| G13 | 2 | 1 | 0 | 0 | 0 | 66.7% (2/3) |
| G14 | 14 | 1 | 0 | 0 | 0 | 93.3% (14/15) |
| G15 | 3 | 0 | 0 | 0 | 0 | 100.0% (3/3) |
| G16 | 6 | 0 | 0 | 0 | 0 | 100.0% (6/6) |
| **Total** | **115** | **28** | **0** | **0** | **0** | **80.4% (115/143)** |

- Model calls: 251; input tokens 735127; output tokens 41293; estimated $0.0983
- Latency: n=229 turns · p50 1375 ms · p90 7532 ms · p99 11496 ms · max 13945 ms
- Zero-tolerance hits: G04-014: turn 3: result shows hidden lab_fridge_big

## H held-out first run (live DeepSeek, 32919ad — independent)

| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |
|---|---:|---:|---:|---:|---:|---:|
| CODE | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| DIA | 4 | 16 | 0 | 0 | 0 | 20.0% (4/20) |
| GEN | 10 | 2 | 0 | 0 | 0 | 83.3% (10/12) |
| MATH | 2 | 6 | 0 | 0 | 0 | 25.0% (2/8) |
| MT | 19 | 6 | 0 | 0 | 0 | 76.0% (19/25) |
| SEC | 22 | 0 | 0 | 0 | 0 | 100.0% (22/22) |
| SELL | 11 | 1 | 0 | 0 | 0 | 91.7% (11/12) |
| **Total** | **76** | **31** | **0** | **0** | **0** | **71.0% (76/107)** |

- Model calls: 243; input tokens 925876; output tokens 43269; estimated $0.0949
- Latency: n=152 turns · p50 1506 ms · p90 8439 ms · p99 11131 ms · max 12188 ms
- Zero-tolerance hits: none

## B final (live DeepSeek, 1e209a4)

| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |
|---|---:|---:|---:|---:|---:|---:|
| G01 | 10 | 0 | 0 | 0 | 0 | 100.0% (10/10) |
| G02 | 11 | 1 | 0 | 0 | 0 | 91.7% (11/12) |
| G03 | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| G04 | 19 | 3 | 0 | 0 | 0 | 86.4% (19/22) |
| G05 | 10 | 0 | 0 | 0 | 0 | 100.0% (10/10) |
| G06 | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| G07 | 6 | 0 | 0 | 0 | 0 | 100.0% (6/6) |
| G08 | 7 | 3 | 0 | 0 | 0 | 70.0% (7/10) |
| G09 | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| G10 | 6 | 0 | 0 | 0 | 0 | 100.0% (6/6) |
| G11 | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| G12 | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| G13 | 3 | 0 | 0 | 0 | 0 | 100.0% (3/3) |
| G14 | 15 | 0 | 0 | 0 | 0 | 100.0% (15/15) |
| G15 | 3 | 0 | 0 | 0 | 0 | 100.0% (3/3) |
| G16 | 6 | 0 | 0 | 0 | 0 | 100.0% (6/6) |
| **Total** | **136** | **7** | **0** | **0** | **0** | **95.1% (136/143)** |

- Model calls: 292; input tokens 1101067; output tokens 56841; estimated $0.1136
- Latency: n=229 turns · p50 1498 ms · p90 7589 ms · p99 10992 ms · max 11769 ms
- Zero-tolerance hits: none

## H held-out final (live DeepSeek, 1e209a4 — informed later fixes, not independent)

| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |
|---|---:|---:|---:|---:|---:|---:|
| CODE | 8 | 0 | 0 | 0 | 0 | 100.0% (8/8) |
| DIA | 9 | 11 | 0 | 0 | 0 | 45.0% (9/20) |
| GEN | 10 | 2 | 0 | 0 | 0 | 83.3% (10/12) |
| MATH | 2 | 6 | 0 | 0 | 0 | 25.0% (2/8) |
| MT | 17 | 8 | 0 | 0 | 0 | 68.0% (17/25) |
| SEC | 22 | 0 | 0 | 0 | 0 | 100.0% (22/22) |
| SELL | 11 | 1 | 0 | 0 | 0 | 91.7% (11/12) |
| **Total** | **79** | **28** | **0** | **0** | **0** | **73.8% (79/107)** |

- Model calls: 231; input tokens 919998; output tokens 43887; estimated $0.1012
- Latency: n=152 turns · p50 1505 ms · p90 8282 ms · p99 11700 ms · max 15511 ms
- Zero-tolerance hits: none

## H5 validation (live DeepSeek, 1e209a4 — independent)

| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |
|---|---:|---:|---:|---:|---:|---:|
| H5-NEG | 10 | 0 | 0 | 0 | 0 | 100.0% (10/10) |
| H5-POS | 16 | 4 | 0 | 0 | 0 | 80.0% (16/20) |
| **Total** | **26** | **4** | **0** | **0** | **0** | **86.7% (26/30)** |

- Model calls: 33; input tokens 69638; output tokens 3595; estimated $0.0099
- Latency: n=30 turns · p50 1506 ms · p90 5403 ms · p99 5819 ms · max 5819 ms
- Zero-tolerance hits: none

