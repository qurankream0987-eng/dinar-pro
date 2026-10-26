# BDINAR baseline audit
Checkpoint: checkpoints/bdinar-before-auth-markets.tar.gz. Git baseline: 4455e7cfb18ea92382cf578f3f308edfb53aceba.

React/Vite/TypeScript, Wouter, TanStack Query; Express 5; pnpm monorepo. Generated OpenAPI client and Zod contracts. Drizzle and pg are already installed, but schema is empty and runtime marketplace routes use mutable arrays in dinar-data.ts.

No real authentication, users, or sessions. Fixed currentUser (Ahmed), hardcoded profile (Maryam). Offer mutation checks only fixed identity. Orders, chat and dues lack participant authorization. Global dashboard includes other sellers' orders and synthetic statistics. Input validation exists, but parse errors have no centralized safe handler.

Quantity/cart implementation exists: LIMITED/UNLIMITED, reservations, release/commit, integer fils, 10% seller fee, multi-seller checkout grouping, 18 domain tests. Preserve these semantics. Cart source is localStorage. All prices/currency are hardcoded to KWD, with no country/market model or isolation.

Existing UI: discover/categories, listing/details, quantity, cart, create/edit offers, seller dashboard, orders/timeline, text order chat, proof code, confirmation/dispute text. No login/register/profile/settings or bottom navigation. RTL and light/dark themes exist; CSS retains template placeholders overridden later. Large mobile hero, hardcoded trust badges and support claims, missing failed-image fallback. Disputes are a single input; files/providers are not implemented. No payment provider or actual payouts.
