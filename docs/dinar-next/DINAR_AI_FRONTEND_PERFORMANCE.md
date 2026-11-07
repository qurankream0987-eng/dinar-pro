# DINAR AI: frontend performance

Production `vite build` of the baseline `b078317` and of this branch:

| Asset | `b078317` | This branch |
|---|---|---|
| Main chunk (gzip) | 272.20 KB | 272.67 KB |
| Camera | inside main | separate chunk `CameraCapture` 2.70 KB gzip, loaded on first tap |
| CSS (gzip) | 38.66 KB | about 39.4 KB (premium layer) |

- **Cart flight**, measured in Chromium at 390px with no throttling: 36 frames; maximum frame interval 67 ms; 1 frame over 34 ms (the first frame, while the clone is inserted).
- **Composer text width** after the fix:

| Width | Text area |
|---|---|
| 320 | 266px |
| 375 | 313px |
| 390 | 328px |
| 430 | 368px |

- **Horizontal overflow:** 0 at every width in the matrix (320–1440, light and dark).

**Budgets proposed:**
- the main chunk must not grow over 275 KB gzip without review;
- the camera stays lazy;
- flight frames over 34 ms must stay at 2 or fewer.

**Not measured:**
- real devices or CPU throttling;
- a long history on this branch (the last figure, 40 messages in about 2.2 s, comes from an older SHA).
