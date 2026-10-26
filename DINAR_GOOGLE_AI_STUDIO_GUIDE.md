# DINAR Google AI Studio development guide

## Purpose

DINAR is an Arabic-first, conversation-led marketplace. Buyers discover products
and services, sellers draft and publish listings, and buyers, sellers, and
couriers coordinate orders through one conversation experience. This repository
is the real monorepo, not a demo scaffold.

Use the dedicated `feature/dinar-next-google` branch for proposed work. Submit
changes as a pull request for Replit integration and verification. Do not commit
directly to protected production branches, force-push, or rewrite project history.

## Repository map

- `artifacts/dinar` — React, TypeScript, and Vite web client; Arabic RTL
  conversation, marketplace, account, seller, buyer, and courier interfaces.
- `artifacts/api-server` — Express 5 and TypeScript API, authentication and
  authorization boundaries, conversational orchestration, and canonical
  marketplace services.
- `artifacts/api-server/src/ai` — conversation routing/runtime, typed surfaces,
  and role-specific turn handling.
- `artifacts/api-server/src/lib` — authoritative marketplace, listing, order,
  negotiation, delivery, payment-simulation, and provider services.
- `lib/db` — Drizzle PostgreSQL schema and ordered SQL migrations.
- `lib/api-spec/openapi.yaml` — API contract source.
- `lib/api-zod`, `lib/api-client-react` — generated validation and client
  packages. Regenerate these; do not hand-edit generated outputs.
- `lib/global` — shared workspace code.
- `docs` — product, architecture, readiness, and verification records.
- `artifacts/api-server/test` — API, service, security, acceptance, and browser
  tests.

## Run and verify

Use Node and pnpm versions compatible with the checked-in workspace configuration.
From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/dinar run build
pnpm --filter @workspace/api-server run build
```

The standard API test script is `pnpm --filter @workspace/api-server run test`.
Additional acceptance scripts are documented in
`artifacts/api-server/package.json`, including `test:g3`, `test:gfinal`, and
role-specific Block A–F suites. Use the project’s guarded isolated-test runner
and a disposable loopback PostgreSQL database for database-mutating acceptance.
Never point tests or migrations at shared Railway or production databases.

For local app development, the configured Dinar web workflow runs
`pnpm --filter @workspace/dinar run dev`; the API workflow runs
`pnpm --filter @workspace/api-server run dev`. Keep local credentials in Replit
Secrets or a developer-local ignored environment file. Do not commit them.

When changing the API contract, update `lib/api-spec/openapi.yaml` and regenerate
the client/Zod packages:

```sh
pnpm --filter @workspace/api-spec run codegen
```

## Conversation and business authority

There is one primary conversation runtime. It routes user intent to existing
server-owned services and renders registered, typed surfaces. The conversation
is an interface to canonical capabilities, not a second source of business
truth.

Before redesigning a screen, trace its current surface/action registration and
API contract. State changes must continue through existing canonical services.
Keep action identifiers, confirmation rules, typed surfaces, generated response
schemas, OpenAPI definitions, and shared registries aligned.

Current product flows include:

- Seller listing drafts, corrections, interruption/resume, tentative photo
  suggestions, review, and explicit publication.
- Product and service search, listing details, saved conversation history, and
  buyer/cart/order flows.
- Fixed, negotiable, and open-to-offers pricing, with server-authoritative
  negotiation events and accepted-price snapshots used by checkout and
  commission.
- Delivery coordination, courier assignment and milestones, and private order
  location handling.
- Account, market, provider, and role-specific experiences.

Do not replace these workflows with mock/demo commerce modules or duplicate
seller, buyer, search, negotiation, identity, payment, order, or courier engines.

## Privacy, integrations, and financial boundaries

- Preserve country/market isolation, owner authorization, and fail-closed
  provider behavior.
- Keep public listing location separate from private delivery/order locations.
- Seller contact details remain private unless existing order-bound
  authorization and current seller-consent checks pass.
- Photo/Vision suggestions are tentative and never publish a listing; the seller
  must correct or confirm details and use the existing review/publish flow.
- Do not claim an integration is connected based only on a credential or
  interface. Preserve provider allowlists and development-only boundaries.
- Payments remain simulation-only. Do not enable real transfers, live payment
  providers, or advanced courier tips.

## UI and Arabic RTL requirements

Redesigns may target the existing frontend components and styles, especially
`artifacts/dinar/src/pages` and `artifacts/dinar/src/features`. Preserve the
existing navigation, typed conversation surfaces, and canonical action wiring.

- Arabic is a primary language; validate Arabic text, numerals, mixed-direction
  content, punctuation, and focus order in RTL.
- Check narrow mobile viewports, touch scrolling, safe areas, virtual-keyboard
  resizing, and landscape/orientation changes.
- Keep history and message lists scrollable without causing page-level overflow.
- Maintain accessible labels, visible focus, keyboard operation, and adequate
  contrast.
- Test desktop and mobile; do not assume a desktop layout will adapt correctly.

## Performance targets

No DINAR-specific numeric performance budget is recorded in the repository.
Use the Core Web Vitals “good” thresholds as provisional targets on representative
mobile devices: LCP at or below 2.5 s, INP at or below 200 ms, and CLS at or
below 0.1. Avoid adding large eager-loaded bundles, and compare production build
output before and after UI changes. Record any new project-specific budget with
the owner rather than silently relaxing these targets.

## Verification and handoff

For each proposed change:

1. Explain the affected UI and canonical business authority before editing.
2. Make the smallest change that closes a reproducible gap.
3. Add or update focused tests, including reload/rehydration checks where
   persisted conversation or surface data changes.
4. Run typechecks, affected builds, focused tests, and `git diff --check`.
5. Include changed files, dependency changes, and verification results in the PR.
6. Leave deployment, production data, real-money enablement, and history
   rewriting to separately authorized Replit work.

Do not include secrets, environment files, database dumps, local application
state, user data, or credentials in commits.
