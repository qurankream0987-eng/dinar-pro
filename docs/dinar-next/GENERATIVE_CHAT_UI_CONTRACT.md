# Generative chat UI contract (Command 02)

**Reused unchanged from the generative UI mission:**
- `lib/api-zod/src/surface-composition.ts`:
  - `ComposedSurfaceSchema` (11 primitives: header, text, facts, metrics, meter, money, timeline, bars, options, notice, actions; 16 KB; ≤ 16 sections; one primary action; no SEND action in terminal states);
  - `CardEnvelopeSchema` (server `allowedActions`, lifecycle, expiry, pending review);
  - `SurfaceActionSchema` (SEND utterance / NAVIGATE path regex / EXTERNAL_LINK by `resultSetId` + `cardId` only).
- `PresentationProposalSchema` v1: model layout proposal over the same turn's verified results (GRID / CAROUSEL / LIST / COMPARISON, ≤ 6 positions, highlight, ≤ 4 dimensions, flat, strict). Resolved by `resolvePresentationProposal`; a rejected proposal falls back to the typed card.

**Mapping of the requested compositions to existing typed surfaces** (all server-built from canonical services):

| Requested | Surface |
|---|---|
| Settings controls | `SETTINGS`, `APP_THEME` (`SET_THEME` client action), `NOTIFICATION_PREFERENCES` |
| Profile summary | `ACCOUNT`, `PROFILE_REVIEW` / `PROFILE_STATUS` |
| Usage dashboard | `AI_USAGE` (ledger numbers, renewal, projection) |
| Subscription info | `AI_PLANS`, `BUSINESS_PLAN_REVIEW`, `BUSINESS_STATUS` |
| Product cards / comparison | `LISTING_RESULTS` (+ composition), `COMPARISON` |
| Cart / delivery choice | `CART`, `DELIVERY_OPTIONS` |
| External merchant purchase | `CONNECT_RESULTS` + `EXTERNAL_LINK` |
| Business plan / Connect wizard | `BUSINESS_SETUP`, `BUSINESS_PLAN_REVIEW`; Connect portal (`/connect`, Command 01 modes) |
| Order timeline | `ORDER_STATUS` / `ORDER_TRACKING` timeline primitive |
| Driver opportunities | `DELIVERY_WORK_RESULTS`, `DRIVER_*` |

**New in Command 02:** none. The contract needed no new primitive for these scenarios.

Generic Input / Toggle / free-form multi-step form primitives were **not** added. Each mutation keeps its own typed review card so the server owns validation and confirmation. Adding a generic form primitive needs a separate design review.
