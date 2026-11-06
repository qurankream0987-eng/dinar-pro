# Generative UI: component contract

## Proposal (model → server)

Defined by `PresentationProposalSchema` in `lib/api-zod/src/surface-composition.ts`. It is strict and versioned (`version: 1`).

| Field | Type | Bound |
|---|---|---|
| `layout` | `GRID` \| `CAROUSEL` \| `LIST` \| `COMPARISON` | closed enum |
| `positions` | 1-based positions in the result set **this turn** produced | 1–6 items, each 1–24, unique, ≤ result count |
| `highlight` | one shown position | must be shown; never a sponsored listing; not in a comparison |
| `dimensions` | `PRICE`, `CONDITION`, `CITY`, `AVAILABILITY`, `DELIVERY`, `SELLER` | 1–4; comparison only |

The contract has:
- no identifiers, prices, URLs, styles, markup, actions or nesting;
- no other fields (unknown properties fail).

The proposal is depth 1, has at most 6 + 4 small items, and its size is bounded by the model output limits.

## Resolution (server)

`resolvePresentationProposal(raw, listings)` is a pure function. It returns one of:
- `NONE`;
- `REJECTED { reason }`;
- `COMPARE { positions }`, which is executed through the canonical `compareListings` tool;
- `LAYOUT { order, composition }`.

Any unresolvable part rejects the **whole** proposal.

## Stored and rendered contract (server → client)

`ResultCompositionSchema` is attached to a `LISTING_RESULTS` block:

```
{ source: "MODEL_PROPOSAL", layout: "GRID" | "CAROUSEL" | "LIST", highlightId?: <listing id from this block> }
```

- It is declared in OpenAPI (`AiUiBlock.payload.composition`) and in the generated Zod/TS clients.
- It is validated again by the web client; an invalid composition is dropped, never partially applied.
- It is persisted in `aiUiBlocks.payload` and restored on reload. The highlight is dropped when that listing is no longer live.

## Supported presentations

| Proposal | Rendered with |
|---|---|
| CAROUSEL (default) | existing `ResultCarousel` |
| GRID | `ResultLayout` grid (1 / 2 / 3 columns by width), `role="list"` / `listitem` |
| LIST | `ResultLayout` vertical list |
| COMPARISON | existing COMPARISON surface from `compareListings` (server facts; unknown values stay «لم يذكر البائع») |

The highlight shows a visible badge «اقتراح دينار» and the same text in the card's accessible name.

The existing `ComposedSurface` primitives (metrics, timeline, money, options, notice, actions) remain the vocabulary for usage, order, business and review cards. This mission did not duplicate them.
