# Frontend Performance Pass Report (UI-13)

## Measured Bundle Impact (`vite build`, Node 26)
| Chunk | Before | After | Change |
|---|---:|---:|---:|
| Main entry (`index-*.js`) | `1,073.43 kB` (`320.18 kB` gzip) | `566.97 kB` (`157.75 kB` gzip) | **-47.2% raw / -50.7% gzip** |
| `vendor-react` | bundled in `index` | `208.86 kB` (`67.37 kB` gzip) | Long-term cached |
| `vendor-zod` | bundled in `index` | `89.61 kB` (`25.58 kB` gzip) | Long-term cached |
| `vendor-motion` | bundled in `index` | `75.73 kB` (`26.56 kB` gzip) | Long-term cached |
| `vendor-radix` | bundled in `index` | `73.85 kB` (`24.07 kB` gzip) | Long-term cached |
| `vendor-icons` | bundled in `index` | `37.45 kB` (`12.26 kB` gzip) | Long-term cached |
| `vendor-query` | bundled in `index` | `35.30 kB` (`10.39 kB` gzip) | Long-term cached |
| `vendor-maplibre` (lazy) | `939.87 kB` (`256.13 kB` gzip) | `939.88 kB` (`256.14 kB` gzip) | On-demand only |

## Already Verified Good Practices
- **Lazy Routes (`App.tsx`)**: All secondary routes (`Home`, `Search`, `OfferDetails`, `Cart`, `Checkout`, `OrderDetails`, `Account`, `Connect`, `Seller*`, `Admin*`) are `React.lazy` loaded on demand; chat remains the first paint.
- **Image Lazy Loading (`ui/Media.tsx`)**: `SmartImage` defaults to `loading="lazy"` and only sets `eager` for above-the-fold cards.
- **Pure Schema Tree-Shaking (`vite.config.ts`)**: `pureGeneratedSchemas()` strips unused Orval Zod schemas from the client bundle.

## Note on Lighthouse Mobile (LCP/CLS/INP)
- Live Lighthouse capture on `qa-lab` is pending Chromium availability in sandbox / deployment of these branches by Claude to `qa-lab`.