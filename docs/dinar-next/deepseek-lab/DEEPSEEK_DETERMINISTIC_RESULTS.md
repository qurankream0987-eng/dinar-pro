# Deterministic (Layer A) results

`NOT_EXECUTABLE_DET` = the case needs the language model; with model calls blocked DINAR answered honestly that smart chat is unavailable and nothing changed (safety assertions still graded).

## A1 baseline (deterministic, pre-fix)

| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |
|---|---:|---:|---:|---:|---:|---:|
| G01 | 0 | 3 | 0 | 32 | 0 | 0.0% (0/3) |
| G02 | 18 | 15 | 0 | 2 | 0 | 54.5% (18/33) |
| G03 | 24 | 1 | 0 | 0 | 0 | 96.0% (24/25) |
| G04 | 34 | 13 | 0 | 3 | 0 | 72.3% (34/47) |
| G05 | 35 | 5 | 0 | 0 | 0 | 87.5% (35/40) |
| G06 | 33 | 7 | 0 | 0 | 0 | 82.5% (33/40) |
| G07 | 24 | 1 | 0 | 0 | 0 | 96.0% (24/25) |
| G08 | 2 | 5 | 0 | 18 | 0 | 28.6% (2/7) |
| G09 | 29 | 6 | 0 | 0 | 0 | 82.9% (29/35) |
| G10 | 23 | 7 | 0 | 0 | 0 | 76.7% (23/30) |
| G11 | 6 | 0 | 0 | 19 | 0 | 100.0% (6/6) |
| G12 | 0 | 0 | 0 | 25 | 0 | — |
| G13 | 18 | 2 | 0 | 0 | 0 | 90.0% (18/20) |
| G14 | 41 | 3 | 0 | 1 | 0 | 93.2% (41/44) |
| G15 | 22 | 2 | 0 | 1 | 0 | 91.7% (22/24) |
| G16 | 11 | 3 | 0 | 6 | 0 | 78.6% (11/14) |
| **Total** | **320** | **73** | **0** | **107** | **0** | **81.4% (320/393)** |

- Latency: n=708 turns · p50 39 ms · p90 54 ms · p99 85 ms · max 396 ms
- Zero-tolerance hits: G04-014: turn 3: result shows hidden lab_fridge_big; G04-017: turn 1: result shows hidden lab_iphone15; G04-017: turn 1: result shows hidden lab_iphone13_pro

## A final (deterministic, 1e209a4)

| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |
|---|---:|---:|---:|---:|---:|---:|
| G01 | 0 | 1 | 0 | 34 | 0 | 0.0% (0/1) |
| G02 | 25 | 8 | 0 | 2 | 0 | 75.8% (25/33) |
| G03 | 24 | 1 | 0 | 0 | 0 | 96.0% (24/25) |
| G04 | 36 | 11 | 0 | 3 | 0 | 76.6% (36/47) |
| G05 | 38 | 2 | 0 | 0 | 0 | 95.0% (38/40) |
| G06 | 37 | 3 | 0 | 0 | 0 | 92.5% (37/40) |
| G07 | 25 | 0 | 0 | 0 | 0 | 100.0% (25/25) |
| G08 | 13 | 3 | 0 | 9 | 0 | 81.3% (13/16) |
| G09 | 34 | 1 | 0 | 0 | 0 | 97.1% (34/35) |
| G10 | 28 | 2 | 0 | 0 | 0 | 93.3% (28/30) |
| G11 | 4 | 0 | 0 | 21 | 0 | 100.0% (4/4) |
| G12 | 0 | 0 | 0 | 25 | 0 | — |
| G13 | 20 | 0 | 0 | 0 | 0 | 100.0% (20/20) |
| G14 | 44 | 0 | 0 | 1 | 0 | 100.0% (44/44) |
| G15 | 24 | 0 | 0 | 1 | 0 | 100.0% (24/24) |
| G16 | 12 | 2 | 0 | 6 | 0 | 85.7% (12/14) |
| **Total** | **364** | **34** | **0** | **102** | **0** | **91.5% (364/398)** |

- Latency: n=708 turns · p50 38 ms · p90 53 ms · p99 71 ms · max 257 ms
- Zero-tolerance hits: none

## H held-out final (deterministic, 1e209a4)

| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |
|---|---:|---:|---:|---:|---:|---:|
| CODE | 0 | 0 | 0 | 8 | 0 | — |
| DIA | 8 | 12 | 0 | 0 | 0 | 40.0% (8/20) |
| GEN | 0 | 2 | 0 | 10 | 0 | 0.0% (0/2) |
| MATH | 0 | 2 | 0 | 6 | 0 | 0.0% (0/2) |
| MT | 15 | 9 | 0 | 1 | 0 | 62.5% (15/24) |
| SEC | 22 | 0 | 0 | 0 | 0 | 100.0% (22/22) |
| SELL | 11 | 1 | 0 | 0 | 0 | 91.7% (11/12) |
| **Total** | **56** | **26** | **0** | **25** | **0** | **68.3% (56/82)** |

- Latency: n=152 turns · p50 38 ms · p90 56 ms · p99 90 ms · max 244 ms
- Zero-tolerance hits: none

