# DINAR AI Architecture Gap Report

**Audit date:** 2026-09-29  
**Scope:** Phase 1 / Foundation from the attached DINAR AI V1 specification  
**Status:** Read-only codebase trace completed before implementation

## Executive summary

BDINAR already has the transactional marketplace core that DINAR AI needs: authenticated accounts, independently scoped account and browsing markets, real offers/listings, server-side market filtering, carts, checkout, orders, and order messaging. The requested product is not present yet: there is no general AI conversation experience, model gateway, conversation runtime, tool registry, result-set persistence, typed generative-card protocol, or chat-first frontend.

The implementation should add a conversation and interaction layer on top of the existing marketplace. It must not create another product database, cart, order engine, or payment flow.

## Reusable systems

| Area | Existing capability to reuse |
|---|---|
| Persistence | PostgreSQL and Drizzle schemas in `lib/db`; current user, market, offer, cart, order, conversation, and message data |
| Identity | Session-backed authentication and server-derived actor identity in `artifacts/api-server/src/lib/auth.ts` |
| Market policy | Authenticated active-market resolution and availability/policy checks in `artifacts/api-server/src/lib/markets.ts` |
| Listings | `GET /listings` and `GET /listings/:id` query canonical offers and sellers, enforce market visibility, and return real resources |
| Search UI | Existing `/search` page, listing types, `OfferCard`, and listing-detail route |
| Cart and orders | Existing market-scoped cart, transactional/idempotent checkout, order authorization, and order messages; later conversation actions must call these services rather than create parallel state |
| API conventions | OpenAPI, Zod, generated client, shared API server, and existing request security/origin checks |

## Gaps against Phase 1

1. **General conversation persistence:** `conversations` and `messages` currently represent order-bound buyer/seller chat. They do not provide free-standing AI conversations with owner and market context, assistant turns, structured UI blocks, or saved listing result sets. The order-chat authorization and existing rows must remain intact.
2. **Chat experience:** The home page is a traditional listing grid. There is no general chat shell, message history/composer, card registry, result carousel, or typed action dispatcher.
3. **AI gateway and runtime:** No server-side model adapter, conversation planner, or runtime exists. The browser must never call a model provider directly, and the model must not decide identity, market access, listing truth, inventory, or order state.
4. **Tool registry:** There are no versioned, schema-validated tools. Phase 1 needs a narrow read-only registry for listing search and resource lookup; it must not expose database access to the model.
5. **Conversational listing search:** Existing search returns genuine market-scoped listings using basic text matching. It does not preserve conversation context, resolve references such as “the second one,” or persist result sets. It is the source to wrap, not duplicate.
6. **Typed cards and actions:** Existing listing/order cards are page-specific. There is no versioned UI-block envelope, stable `resourceRef`/`resultSetId`, or safe typed action contract.
7. **Tests and observability:** Current tests cover marketplace, auth, inventory, and checkout behavior, but not AI turns, result-set references, structured cards, provider failure, or conversation persistence.

## Phase 1 implementation boundary

- Add persistent general AI conversations without changing the meaning or authorization of existing order conversations.
- Add one server-side AI gateway/runtime and a narrowly scoped, validated `searchListings` / resource-lookup tool backed by current offers and current market rules.
- Support natural-language listing search, a follow-up refinement, prior-result references, honest no-result behavior, and a safe fallback to traditional search when the provider is unavailable.
- Return typed, versioned listing-card blocks that reference canonical offer IDs; render only registered UI components, never arbitrary model HTML.
- Add a chat surface that uses existing account/session and market context. Persisted AI conversations require authentication; guests keep using existing public search until an anonymous-session ownership design is added. Protected actions remain unavailable until later phases.
- Gate the new experience for development verification and keep it disabled by default in production until explicitly enabled.

## Conversation migration compatibility decision

The current `conversations.order_id` is required and unique, and order endpoints intentionally identify their conversation through the order. Keep that contract for all existing rows and routes. The additive design is to allow `order_id` to be null only for explicitly typed AI conversations, add owner/market/kind fields with a backfill for existing order rows, and enforce valid ORDER versus AI row shapes with a database constraint. Keep order-message `body`, generated DTOs, order authorization, and lifecycle transactions unchanged.

AI-specific roles and structured content must not be inferred from order-chat fields. Persist validated, versioned UI blocks and canonical listing result references separately from free-text `messages.body`. Use the next sequential Drizzle migration and update the schema; do not use force-push schema mutation. Add conversation-owner and active-market checks in a separate AI authorization path.

## Explicitly deferred

Cart and checkout tools, seller draft/publish flows, cars, properties, jobs, CVs, services, food, delivery, recommendations, sponsored ranking, voice, image search, maps, and payment/payout work remain outside Phase 1. No financial movement or payment success may be represented by the AI layer.

## Source trace

- `artifacts/api-server/src/lib/auth.ts`
- `artifacts/api-server/src/lib/markets.ts`
- `artifacts/api-server/src/routes/marketplace.ts`
- `artifacts/api-server/src/app.ts` and `artifacts/api-server/src/routes/index.ts`
- `artifacts/dinar/src/App.tsx` and `artifacts/dinar/src/features/AppShell.tsx`
- `artifacts/dinar/src/pages/Search.tsx`
- `artifacts/dinar/src/features/OfferCard.tsx`
- `artifacts/dinar/src/cart/CartContext.tsx`
- `lib/db/src/schema/index.ts`
- Attached DINAR AI specification, §§39–42, 71–74, 97–101, 112, and 127–131