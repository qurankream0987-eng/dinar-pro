# Premium chat UX: performance

**How it was measured:**
- real headless Chromium, built web app, real API, disposable loopback PostgreSQL, stub model;
- mobile context (390×844, touch);
- single runs on a shared cloud container, so the numbers carry noise of roughly ±20 %.

The "before" run was on ; the "after" run includes this command's change. The change is server text only, so the web bundle is identical.

## Bundle (production build)

| Asset | Raw | Gzip |
|---|---|---|
| Main chunk  | 914,482 B | 268,914 B |
| All JS | 1,404,596 B | 402,963 B |
| CSS | 222,940 B | 38,535 B |

## Runtime

| Metric | Before | After |
|---|---|---|
| timeToUsableChatMs | 1384 | 1271 |
| domContentLoadedMs | 1101 | 1019 |
| longTasksAtLoad | 2 | 2 |
| longTaskMsAtLoad | 290 | 250 |
| jsHeapMbAtLoad | 52 | 51.9 |
| longHistoryRenderMs | 2207 | 2207 |
| longHistoryMessages | 40 | 40 |
| domNodesLongHistory | 3309 | 3309 |
| jsHeapMbLongHistory | 72.8 | 57.5 |
| sendToCardMs | 301 | 312 |
| inputLatencyMs | 22 | 30 |
| clsTotal | 0.012 | 0.0163 |
| scroll frames p50/p95/max/over50ms | 17/17/41/0 | 17/17/43/0 |

LCP reported 0: Chromium headless did not emit a largest-contentful-paint entry in this harness. Time to a usable chat (composer enabled) is the substitute.

## Proposed regression thresholds (from these measurements)

| Metric | Measured | Threshold |
|---|---|---|
| Time to usable chat (local) | ~1.2–1.4 s | ≤ 2.0 s |
| Send to first result card (deterministic) | ~0.3–0.5 s | ≤ 1.0 s |
| Long history (40 messages) | ~2.2 s | ≤ 3.0 s |
| Scroll frames over 50 ms | 0 | ≤ 3 per 60 steps (enforced in the suite) |
| CLS | ≤ 0.02 | ≤ 0.1 |
| Main chunk | 269 KB gzip | must not grow without review |

## Not measured

- Lighthouse;
- real devices / CPU throttling;
- memory over hours;
- model latency or tokens (no live model).

**Observation:** the long-history view renders 40 messages / 3,309 DOM nodes in about 2.2 s. List virtualization is a candidate if histories grow.
