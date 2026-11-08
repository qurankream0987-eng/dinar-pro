# DINAR AI Owner Setup Checklist

**Purpose:** Owner decisions and approvals needed before an integration can be configured or tested.
**Status:** Documentation only. No secret values were read, no account created, and no service configuration changed.

## 1. Baseline and launch authority

- [ ] Use code SHA `6b56704ff04dc7682a57e0a6fa8fcc594600e53a`, with canonical documentation-only branch HEAD `995d2e57b94bfe552d25e902137c584e554b8114` and its direct-parent relationship verified.
- [ ] Keep the reported qualification attached to its exact tested SHA. Any later code change requires its own acceptance evidence.
- [ ] Confirm the first launch country, legal entity, seller eligibility, consumer terms, product policy, tax and dispute/refund responsibility with local counsel/finance.
- [ ] Complete country intake, counsel approval, technical verification and explicit owner approval before market activation. No country is represented as approved by this audit.
- [ ] Keep the separate unverified content-governance draft isolated. Do not treat it as production policy or image moderation.

## 2. Railway staging, database and storage

- [ ] Authorize a staging Railway environment and one initial container service from the checked-in root Dockerfile. Its static frontend and Express API are built together; test before choosing a split frontend/API topology.
- [ ] Authorize a separate synthetic-data PostgreSQL service and staging Bucket in the same environment. Keep the DB private; keep staging and production secrets/resources separate.
- [ ] Choose region based on service availability, customer latency, data-residency rules and provider coverage. A development database region is not a production recommendation.
- [ ] Put `DATABASE_URL`, object-storage configuration, `SESSION_SECRET` and other required runtime values only in Railway's environment/secret manager. Never paste values into chat or repository files.
- [ ] Set environment label, `PORT`, `APP_ORIGIN`, static web dist, cookies/CSRF origins, CSP connect origins, pool limits and health/readiness checks against source.
- [ ] Decide whether phone verification must be ready for staging. `/api/readyz` includes phone-provider readiness; without a registered staging provider it may remain not ready.
- [ ] Confirm Railway plan, spend limit, resource alerts, log retention, backup schedule, PITR and media retention with the account owner.
- [ ] Define RPO/RTO and authorize a staging database plus media restore drill into separate targets before production.
- [ ] Test Railway Bucket S3 wire compatibility, signatures/metadata, direct upload CORS, private ACL, deletion and restore before changing storage from Replit Object Storage.

**Replit can do after approval:** Prepare the Docker service, staged environment references, health/migration runbook and synthetic acceptance.
**Owner must do:** Authorize account/service/billing/region setup, supply secrets through the secure flow, choose retention, and approve every production change.

## 3. AI, privacy and visual search

- [ ] Decide whether AI text and buyer visual search are required for launch; the features have different provider/cost/privacy routes.
- [ ] Choose exact provider/model and approve the data class it may receive. Confirm actual OpenRouter routing and ZDR/Safety Retention settings in the owner's account.
- [ ] Do not weaken strict ZDR rules to reach a free model. OpenRouter's current free Gemma endpoint is Google AI Studio; verify its compatibility with the approved privacy policy.
- [ ] For buyer photo search, confirm that the `OPENAI_COMPATIBLE` image analyzer route is used with image input enabled. Do not assume the separate `OPENROUTER` text-provider selector automatically wires into visual search.
- [ ] Authorize a bounded synthetic Arabic/English acceptance run, model identity capture, request/output cap, per-user/day and monthly budget, timeout, retry policy and zero-paid-fallback rule.
- [ ] Do not upload real customer photos, documents, location, or order data to a model until data processing/retention is explicitly approved.
- [ ] Treat image generation/editing as optional and separate. If needed, select a provider, define seller consent, product fidelity, moderation, private draft storage and expiry.

**Replit can do after approval:** Configure the supported model route and tests, monitor reported usage and show provider/model metadata without exposing credentials.
**Owner must do:** Connect provider account, approve endpoint/data policy, budget and any live request.

## 4. Country verification, payments and subscriptions

- [ ] Select local counsel and finance owners for each launch country; complete country intake and record approved evidence through the application's canonical process.
- [ ] Decide whether real card/local payments are required for launch. Existing payment routes remain simulation-only.
- [ ] Ask PayTabs, Tap and/or MyFatoorah for written approval of the legal entity, marketplace/submerchant model, country scope, splits/commission, settlement bank/currency/timing, reserves, refunds, chargebacks and fees.
- [ ] Confirm KYB documents and sandbox availability; keep real payment credentials disabled until the owner separately approves live activation.
- [ ] Decide whether subscriptions are in launch scope; get written provider, tax, cancellation, refund and local pricing decisions. Existing lifecycle/webhook contracts do not mean a billing service is connected.
- [ ] Preserve immutable order price/fee snapshots and existing financial authorities. Do not let model or merchant connector output create payment or settlement authority.

**Replit can do after approval:** Implement one selected provider adapter and sandbox webhook/reconciliation tests.
**Owner must do:** Legal entity onboarding, KYB/bank approval, written commercial terms, counsel sign-off and live-payment authorization.

## 5. DINAR Connect and merchants

- [ ] Decide whether the first partners sell inside DINAR, send customers to their own site, or use the existing hybrid participation mode.
- [ ] Identify exact merchant platforms and countries before commissioning connectors. Existing Connect handles reviewed API/feed/website/MCP/OAuth catalog reads and referral flows; it does not provide a generic Shopify/WooCommerce app.
- [ ] Confirm every partner's site ownership, reviewed source, allowed catalog scope, refresh cadence, data rights and termination process.
- [ ] Approve least-privilege OAuth scopes and redirect hosts. Connect's catalog OAuth is read-only PKCE and distinct from Google sign-in.
- [ ] Decide whether any external checkout integration is actually required. Imported partner catalog entries do not become native DINAR checkout; that capability is not enabled by participation mode.
- [ ] For future webhooks/platform APIs, approve signature/replay controls, retry/conflict policies, support contacts and vendor sandbox.

**Replit can do after approval:** Build reusable adapters around Connect's canonical import, moderation, ownership and revocation services.
**Owner must do:** Partner/platform approval, OAuth application registration, merchant authorization and any vendor contract.

## 6. Maps, delivery and location

- [ ] Keep manual area selection and courier agreements unless users demonstrate a specific need.
- [ ] If maps are needed, select only required features (map display, autocomplete, geocoding, distance, route/ETA or real-time location); compare per-SKU prices and coverage.
- [ ] Approve device-location consent, recipient, purpose, retention/deletion and location-provider terms.
- [ ] For Google/Mapbox, create a restricted API project/key and per-SKU quota/budget alert. Do not create one in this audit.
- [ ] Do not use public Nominatim for high-volume or bulk geocoding; obey its 1 request/second per-application cap, User-Agent/Referer, attribution, caching and switchability requirements.

## 7. Domain, public pages and Google

- [ ] Choose/purchase the domain in an owner-controlled registrar; never share registrar passwords.
- [ ] Authorize staging hostname first. Owner applies Railway's exact CNAME/TXT verification records and confirms TLS.
- [ ] Approve which business/listing fields are public and which products are excluded from indexing.
- [ ] Authorize public product detail routes, Arabic metadata, canonical URLs, Product structured data, `robots.txt`, sitemap and redirect policy. Current chat-only routing does not provide a crawlable product catalog.
- [ ] Verify a Search Console Domain property in the owner's account with DNS TXT, submit the sitemap and monitor indexing. Submission is not a ranking/indexing guarantee.
- [ ] Treat Merchant Center and Google Ads separately from organic Search. The checked free-listing country list excludes Jordan and Kuwait.

## 8. Phone, email, identity, WhatsApp, push and support

- [ ] Decide whether phone verification is mandatory by user role or operation. If mandatory, choose an SMS vendor with verified routes/sender approval for each active country and test delivery/abuse limits.
- [ ] Select an email sender only for required recovery/transactional use; approve SPF/DKIM/DMARC, bounce/suppression, retention and support ownership.
- [ ] Decide separately whether Google sign-in, WhatsApp Business or push notifications solve a real launch need. None is connected for outbound delivery.
- [ ] Ensure the existing consent/settings semantics, transactional vs marketing messages, and response SLA are approved.

## 9. Acceptance and independent review

- [ ] Use synthetic data and an isolated database/provider sandbox; do not use customer/production information.
- [ ] Before release, run the exact staging acceptance in the roadmap and record the code SHA, migration ledger, provider/model identity, resource spend and restore proof.
- [ ] Ask Claude to review AI image/data flow, model authority and costs; payment/webhook/accounting invariants; storage ACL/retention/restore; country activation; Connect SSRF/OAuth/sync/revocation; account deletion/session behavior; public crawler exposure; and Railway release/rollback.
- [ ] Obtain owner release approval separately. This checklist and the repository's local qualification report do not authorize push, merge, deployment or production activation.

Never put secrets in conversation or documentation. Use the owner's secure secrets flow and separate credentials for staging and production.
