# DINAR development guidance for Gemini CLI

Use this file as project context, not as permission to make changes. Work only on the
`google-development` branch. Start with `bash scripts/gemini-safe.sh`, which removes
credential/database environment variables and launches Gemini CLI in read-only plan
mode. Do not switch to automatic edit or unrestricted approval modes.

## Repository map

- `artifacts/dinar` is the React web client.
- `artifacts/api-server` is the Express 5 TypeScript API and conversation orchestration.
- `artifacts/api-server/src/ai` contains conversational routing and typed AI surfaces.
- `artifacts/api-server/src/lib` contains the canonical marketplace, order, negotiation,
  delivery, payment, and provider authorities. Route new behavior through these services.
- `lib/db` owns the PostgreSQL/Drizzle schema and migrations.
- `lib/api-spec/openapi.yaml` is the API contract source. Generated clients and Zod
  schemas are regenerated with `pnpm --filter @workspace/api-spec run codegen`; do not
  edit generated output by hand.

## Product and authority boundaries

- Preserve one primary conversation runtime and its typed, server-owned surfaces. Do not
  create a second seller, negotiation, payment, identity, search, or marketplace engine.
- Keep state changes in existing canonical services. Keep action identifiers,
  confirmation requirements, surfaces, OpenAPI schemas, and shared action registries in
  sync.
- Keep the canonical listing pricing modes `FIXED`, `NEGOTIABLE`, and `OPEN_TO_OFFERS`.
  Negotiation events and accepted terms are server-authoritative; checkout, order totals,
  and commission must use the accepted price snapshot.
- Seller listing work stays on the same persisted draft through corrections, interruptions,
  and any compact wizard. Photo/Vision output is tentative; the seller corrects or confirms
  it, and publication always uses the existing explicit review and publish flow.
- Keep public listing location separate from private order/delivery locations. Seller
  contact details remain private until the existing order-bound authorization and current
  seller-consent checks pass.
- Payment stays simulation-only; do not enable real transfers, live payment providers, or
  advanced courier tips. Do not claim an external provider is connected from credentials
  or an interface alone.
- Keep country/market isolation, owner authorization, and fail-closed provider policy.

## Data and tool safety

- Never read, print, copy, or commit environment values, Replit Secrets, `.env` files,
  database URLs, credentials, OAuth caches, or private object-storage configuration.
- Do not inspect `~/.gemini` or add Gemini authentication material to this repository.
  Google sign-in is user-owned and must remain outside project files.
- Do not query or mutate shared Railway/production databases. Database-backed acceptance
  must use `artifacts/api-server/test/isolated-regression.mjs` with its explicit loopback
  PostgreSQL guards.
- Do not run migrations or database pushes against shared or production targets.
- Do not deploy, change production configuration, activate real money, or use unrestricted
  CLI approval modes. Do not modify uploaded files under `attached_assets/`.
- Before any code edits, summarize the proposed change and its affected canonical
  authority. Keep the change limited to a reproducible gap and ask for owner approval if
  its scope or irreversible effect is unclear.
