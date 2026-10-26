# Threat Model

## Project Overview

DINAR V1 is a regional buyer/seller marketplace with offer discovery, carts, order lifecycle, disputes, seller profiles, messaging, and AI-assisted search and listing creation. The stack is a React/Vite client, an Express 5/TypeScript API, and PostgreSQL accessed through Drizzle. Users register with phone numbers and passwords; sessions are stored in PostgreSQL and issued in secure, HTTP-only cookies. The API uses Replit Object Storage for media and the Replit-managed OpenAI integration for AI conversations. Current payment behavior is non-settlement: market payment methods are direct cash and promotion payments are development-simulated; the application must not represent its order or dues records as evidence that money moved.

## Assets

- **Accounts and sessions** — phone numbers, profile data, password hashes, session tokens, and role assignments. Account compromise exposes the user's marketplace activity and can enable unauthorized listing or order actions.
- **Marketplace and order records** — listings, prices, inventory, carts, idempotent checkout requests, order snapshots, reservations, disputes, and seller dues. These records affect fulfillment and user trust; internal amounts are not proof of payment or settlement.
- **Personal and conversation data** — names, phone numbers, profile images, messages, and AI conversation history. This data must be scoped to the owning user except for explicitly public listing and avatar content.
- **Uploaded media** — listing photos and profile avatars in object storage. Incorrect path ownership or ACL handling could expose or replace another user's files.
- **Application secrets** — database credentials, session-related configuration, storage configuration, and AI integration credentials. Exposure can enable account impersonation, data access, file access, or unauthorized external service use.
- **Audit and policy records** — market/category policy changes and order state transitions. These support investigation and must identify the actor and time of sensitive changes.

## Trust Boundaries

- **Browser to API** — all client input is untrusted. The API must authenticate and authorize protected actions, validate request bodies, enforce market scope, and calculate prices and totals from persisted server-side values.
- **Public to authenticated user** — public marketplace discovery and explicitly public images are separate from profile, cart, order, message, and conversation data. Access checks must be enforced on the server, not inferred from client routes.
- **User to administrator** — administrative market, category, and dispute actions require a server-side ADMIN role check and auditable mutations.
- **API to PostgreSQL** — the API has broad data access. Parameterized queries, ownership-scoped operations, database constraints, immutable order snapshots, and checked-in migrations are required. Direct database writes must not be able to bypass critical market, price, or inventory invariants.
- **API to AI service** — user prompts and selected marketplace context cross to an external model service. Model output and proposed tool calls are untrusted; only allowlisted, validated server-side tools may perform marketplace actions.
- **API to object storage** — uploads use signed URLs and later server-side ownership, size, type, and content checks. Object ACLs and public/private paths must remain consistent with the intended visibility.
- **Development to production** — seed and acceptance-test operations must remain guarded to development databases. Migration checks and test evidence must never be obtained by writing to production.

## Scan Anchors

- Production API entry and route wiring: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/`.
- Authentication, sessions, and roles: `artifacts/api-server/src/lib/auth.ts`; admin routes under `artifacts/api-server/src/routes/admin-*.ts`.
- AI prompt/tool boundary: `artifacts/api-server/src/ai/`, `artifacts/api-server/src/routes/ai.ts`, and `artifacts/api-server/src/ai/model-gateway.ts`.
- Marketplace pricing, inventory, cart, and order lifecycle: `artifacts/api-server/src/lib/market-pricing.ts`, `marketplace-cart.ts`, `marketplace-listings.ts`, and `order-terminal-accounting.ts`.
- Media ownership and storage: `artifacts/api-server/src/lib/objectStorage.ts`, `artifacts/api-server/src/routes/profile-avatar.ts`, and `artifacts/api-server/src/routes/listing-photos.ts`.
- Database source of truth and migrations: `lib/db/src/schema/index.ts` and `lib/db/drizzle/`. Acceptance tests and guarded development seeding live under `artifacts/api-server/test/`.

## Threat Categories

### Spoofing

An attacker could guess or steal a session, abuse registration/login, or impersonate an administrator. Passwords are scrypt-hashed; session tokens are random, stored as digests, and sent in HTTP-only cookies with `SameSite=Lax` and `Secure` in production. Every protected request MUST validate an unexpired session and active account, and every admin route MUST check the server-side role. Authentication throttling must remain effective across multiple server instances, not only within one process.

### Tampering

Client-supplied prices, quantities, market IDs, or AI tool arguments could alter listings, carts, or orders. The API MUST validate inputs and derive financial snapshots from persisted market and offer data; tool calls MUST be allowlisted and validated before execution. Order price/currency snapshots and offer identity must remain immutable where required, and cart items must not cross market boundaries.

Database defenses are not currently sufficient for all invariants: the PostgreSQL `markets_price_valid` and `offers_inventory_valid` CHECK expressions admit some NULL values because CHECK treats UNKNOWN as passing. They MUST explicitly reject missing prices for active markets and missing stock for LIMITED offers. Migration `0007_warm_marvel_boy.sql` also falls back to the market price without preserving a legacy offer's stored JSON price; this can corrupt offer prices or make the migration fail when no market baseline exists. Migration repair must preserve the offer's actual price where recoverable and fail before changing data otherwise. A disposable `drizzle-kit push` probe removed migration-owned SQL checks, so checked-in SQL migrations—not schema push—must remain the release authority.

### Repudiation

Market and category policy changes have audit records, but operational order actions and financial-looking records can be disputed. Sensitive changes MUST record the actor, action, timestamp, and relevant before/after state in a durable audit trail. Internal order, fee, and seller-due entries MUST NOT be described as payment proof. Real collection, refunds, or settlement require a licensed provider, signed and deduplicated events, and the launch-country/legal decision described by the product boundary.

### Information Disclosure

Broken user scoping could expose another buyer's orders, conversations, profile data, or uploaded files. Queries and media reads MUST verify ownership or explicit public visibility, and API responses/logs MUST exclude password hashes, session tokens, storage credentials, and unnecessary phone or conversation data. Avatar uploads are intentionally public after ownership and content validation; this visibility must not be extended to private uploads. Prompts and selected marketplace context sent to the AI service MUST be limited to what the request needs.

### Denial of Service

Registration/login, public search, AI turns, and file uploads can be abused to consume database, model, or storage resources. Authentication has a per-process attempt limit; AI requests have a bounded timeout and no automatic retries; avatar uploads are size-limited. Production protections MUST also bound request bodies, search result work, model-call frequency, and storage use, with throttling that remains effective across replicas.

### Elevation of Privilege

An ordinary user could attempt administrative actions, access another seller's listing, or use an AI conversation to trigger an unauthorized write. Authorization MUST be enforced in API routes and domain services for each operation; UI hiding is not a security control. Listing edits, cart writes, order actions, and media changes MUST verify the authenticated user's ownership and market scope. Database queries MUST remain parameterized, and user-controlled object names or paths MUST be validated before storage access.