# DINAR AI: brand implementation

The owner-approved logo, without the stars, was the reference. The marks below are new, original vectors drawn for the UI. They are not a trace of the reference image.

## Marks

| File | Use | Notes |
|---|---|---|
| `artifacts/dinar/public/brand/dinar-mark.svg` | full mark: sidebar, welcome, header, loading symbol | royal-blue glass stem with two circuit traces, gold D bowl, chat bubble with three dots, gold cart |
| `artifacts/dinar/public/brand/dinar-ai-icon.svg` | favicon and small sizes (16–32 px) | the D and the bubble only, on a navy tile; no circuitry or cart at tiny sizes |
| `artifacts/dinar/public/brand/dinar-mark-mono.svg` | monochrome / high contrast | `currentColor` shapes |

Size check: 16, 24 and 32 px (icon), 64 and 128 px (full mark), on light and dark backgrounds. See `evidence/premium-frontend/brand-marks.png`.

## Name and wordmark

The visible product name is now **DINAR AI**:
- sidebar wordmark: "DINAR" in ink and "AI" in gold (`.ai-wordmark-ai`);
- the shared `BrandMark` wordmark (`ui/Media.tsx`): "DINAR AI" with «دينار» underneath, keeping the Arabic identity;
- page `<title>`: «DINAR AI — دينار»;
- og:title, footer copyright, navigation `aria-label`s, the assistant's screen-reader label, the welcome logo alt.

**Deliberately unchanged:**
- «بدينار» where it is a product term, not the brand: the one-dinar price label on offer cards, «رسوم بدينار» in seller fees, market texts;
- `DINAR Connect`, a product name.

## Palette

| Token | Value |
|---|---|
| `--brand-royal` | `#123B91` |
| `--brand-gold` | `#D7AA42` |
| `--brand-sky` | `#DDF3FF` |
| `--brand-navy` | `#0B1E46` |

Chat tokens were re-tuned to this palette in light and dark (`AiChat.css`, "DINAR AI premium layer"):
- the light theme uses navy ink on near-white;
- the dark theme uses midnight surfaces `#07122b` / `#0d1d3d`, not an inversion.

## Limitation

The owner's image is a raster reference. The production mark is a clean redraw in the same spirit, not a pixel reproduction.
