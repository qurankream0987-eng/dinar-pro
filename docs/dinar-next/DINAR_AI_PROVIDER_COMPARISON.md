# DINAR AI Provider Comparison

**Code SHA reviewed:** `6b56704ff04dc7682a57e0a6fa8fcc594600e53a`
**Canonical branch HEAD:** `995d2e57b94bfe552d25e902137c584e554b8114` (documentation-only; direct parent is the reviewed code SHA)
**Checked:** 2026-11-08
**Rule:** Public capability, source code or a credential name does not establish account connection, approved data handling, legal eligibility or production readiness.

## Recommendation summary

| Capability | Existing DINAR capability | Provider choice |
|---|---|---|
| Arabic text AI | Provider-neutral gateway, structured output, budget/usage boundary, optional fallback configuration; no staging/live provider connected | Choose one explicit model/endpoint after privacy and budget approval. Do not turn a free endpoint into an automatic fallback. |
| Buyer photo search | Private image upload, image analyzer, canonical catalog retrieval and deterministic result ranking are implemented | Gemma 4 image input can serve this need through a supported image-capable compatible route; no separate vision vendor is inherently necessary. Test exact OpenRouter route/config first. |
| Seller image suggestions | Development-only Groq/Qwen advisory provider | Not a production reviewer; keep advisory or defer. |
| Image generation/edit | No generator adapter | Optional; use seller replacement upload by default. Choose a generator only if image editing is required. |
| Payments | Test/simulation contract only | One country-approved marketplace PSP is needed only if real-money payments are approved for launch. No candidate is legally approved for DINAR by public pages alone. |
| Maps/routing | Interfaces and manual courier/area workflow; no external provider | Defer until a specific feature requires it. Compare Google, Mapbox, or self-hosted OpenStreetMap; public Nominatim is not a general production service. |
| Object storage | Replit platform adapter plus S3-compatible adapter | Keep current storage until Railway Bucket staging acceptance; do not add a second store by default. |
| Merchant catalog connections | DINAR Connect has reviewed API/feed/OAuth/website/MCP read paths and external referral modes | Build platform-specific adapters only for named merchant demand; no general Shopify/WooCommerce integration should be presumed. |
| Email/SMS/push/WhatsApp | In-app notices and consent/readiness contracts; no external delivery sender | SMS is a readiness dependency if phone verification is required. Email and other channels are conditional, not automatic launch requirements. |

## AI provider and Gemma 4

### Model capability vs. DINAR routing

OpenRouter's current free model pages list `google/gemma-4-31b-it:free` and `google/gemma-4-26b-a4b-it:free`. Both list image input, text output, native function calling, structured output, a 256K context window and free token pricing; OpenRouter currently lists Google AI Studio as the free provider. Availability, quotas and latency are not an SLA.

The canonical gateway in `artifacts/api-server/src/ai/model-gateway.ts` supports those exact IDs in Gemma free-only mode and constrains that mode to the primary model without provider fallback. The separate buyer visual analyzer (`artifacts/api-server/src/ai/visual-search.ts`) accepts an `OPENAI_COMPATIBLE` primary slot only when `DINAR_AI_IMAGE_INPUT=true`, an endpoint and its credential are configured. It sends a still image as a data URL to a strict `describeProduct` schema. It rejects substituted model identity when OpenRouter routing is explicitly configured. The dedicated `OPENROUTER` provider selection is not automatically the analyzer slot. Therefore:

- The end-to-end visual-search product flow exists; earlier claims that DINAR has no multimodal image route were based on the wrong source baseline.
- A separate vision company is not inherently necessary. An image-capable Gemma endpoint can be used if configured through the analyzer's supported compatible route and approved for the data.
- This audit did not send an image or verify the owner's OpenRouter account, routing, free quota or policy settings. Exact route behavior remains `NOT_VERIFIED`.
- The model describes a product only; DINAR's catalog search provides listings, and deterministic logic labels matches. Never treat model text as seller/price/availability truth.

The image upload is private and uploader-bound (`artifacts/api-server/src/lib/visual-search-images.ts`): one JPEG/PNG/WebP image up to 5 MB, strict file signature checks. Before real users' images are sent, test deletion and retention, route/model identity, refusal, quota, timeout, MIME/size/path abuse and Arabic retrieval with synthetic data.

### Privacy, routing and fallback

OpenRouter distinguishes **ZDR** (no routine prompt/response storage), **Safety Retention**, and **Retention and Training**. Its current ZDR documentation says Google-group ZDR-only routing excludes endpoints that permit Safety Retention; the listed free Gemma provider is Google AI Studio. Consequently, the free route may be incompatible with an owner's strict Google ZDR-only setting. Do not weaken ZDR or permit Safety Retention to retain a free route. If policy and route do not match, use another approved route or defer live image/text inference.

Code flags are not proof of account policy. Confirm the endpoint policy and selected provider in the owner's account, without exposing credential values. The exact free-model request limit is dynamic/not established here; do not promise a daily quota. Keep fallback disabled for a visual/commercial call unless every candidate is explicitly approved for the same data class, privacy policy, output contract, cost cap and action boundary. A model fallback can change behavior; provider substitution must fail closed for visual match data.

**Cost:** listed free model is $0 per token at check time, not a free SLA or guaranteed capacity. No paid model is selected or budgeted.
**Priority:** P0 provider/privacy route readiness for any AI launch; visual model quality P0 only if buyer photo search is a launch feature.
**Owner:** approve provider account, exact model/endpoint, retention, spend ceiling, request limits and synthetic acceptance run.
**Claude review:** provider selection and fallback equivalence, model identity, tool schema validity, Arabic quality, image data flow and all failure paths.

## Payments and marketplace settlement

DINAR's canonical payment and commission authorities remain in `artifacts/api-server/src/lib/payments/`, `routes/payments.ts`, `lib/commercial-ledger.ts` and `connect/finance.ts`. Payment intents are simulation-only; no processor adapter or live funds flow is registered. Subscription lifecycle/webhook contracts do not imply a billing provider. Connect participation or an external referral does not itself create a DINAR order, payment, commission or settlement.

| Provider | Public information reviewed | What remains unproven for DINAR |
|---|---|---|
| PayTabs | Public country FAQ lists methods/currencies and test-account information for Jordan and Kuwait. | Legal-entity and country eligibility; marketplace and split approval; settlement bank/currency/timing; actual merchant fees; reserves, refunds, chargebacks and KYB. |
| Tap Payments | Kuwait marketplace page advertises marketplace onboarding/splitting, commission handling and payouts. | Owner entity approval, Jordan coverage, seller/submerchant rules, bank settlement, reserves/disputes and contracted pricing. Marketing capability is not DINAR approval. |
| MyFatoorah | Kuwait terms prohibit receiving funds for submerchants not approved by MyFatoorah. | Written submerchant/marketplace approval, entity/country eligibility, settlement and fee schedule, refund/dispute process and sandbox. |
| Stripe | No DINAR adapter or connected account was found. | Do not shortlist until the owner's entity and marketplace model are confirmed eligible in the target markets and available contractually. |

**Cost:** quote required; do not substitute a generic percentage for a merchant quote.
**Priority:** P1 only after country/legal readiness; not needed to run current simulation-only commerce.
**Acceptance:** provider sandbox with signature verification, replay/idempotency, amount/currency checks, order state transitions, refund/chargeback obligations and reconciliation. Claude must review the financial state machine before any live activation. Owner retains account, legal, fee, bank and activation decisions.

## Maps, geocoding and delivery alternatives

The source's current manual area/courier flows do not prove that routing or tracking is needed. First define whether the actual need is address autocomplete, geocoding, distance pricing, route/ETA or live location. These products and prices are not interchangeable.

| Option | Public cost/limits checked | Fit and caveats |
|---|---|---|
| Google Maps Platform | Dynamic Maps: first 10,000 monthly events free, then $7/1,000 in the first paid band. Places Autocomplete Requests: first 10,000 free, then $2.83/1,000. Other SKUs bill separately. | Mature maps/places/routing stack, but per-SKU billing and precise-location privacy. Restrict keys, set quotas and budget alerts. |
| Mapbox | Mapbox GL JS map loads: first 50,000/month free, then $5/1,000 for 50,001–100,000. Temporary Geocoding: first 100,000 requests free, then $0.75/1,000 for the next tier. Permanent Geocoding starts at $5/1,000. | Useful alternative for map display/geocoding; permanent storage has a different price and license purpose. Check current plan and regional coverage before selecting. |
| OpenStreetMap public Nominatim | No API fee, but absolute maximum 1 request/second, application-identifying User-Agent/Referer, attribution, caching/switchability requirements and no heavy/bulk use. | Suitable only for low-volume, user-initiated experiments that meet its policy. Not a free production-scale geocoding backend or an SLA. Consider a paid provider or owner-operated service for sustained production. |

**Cost:** no map service is currently selected; no setup is recommended.
**Priority:** P3; continue manual market/area and courier agreement flows.
**Acceptance:** privacy consent and minimization, address accuracy in approved markets, per-SKU spend caps, offline/error state, provider-switch path, coordinate expiry. Claude reviews precise-location flows and cost controls.

## Storage, messaging, and visibility

- **Storage:** Railway Bucket is a possible S3-compatible target at $0.015/GB-month, with S3 operations and bucket egress listed free; application-service egress may still be billed. Existing Replit Object Storage remains active. Validate signatures, CORS, ACL, retention, deletion and restore before migration. No additional storage vendor is justified without measured residency, compatibility or cost need.
- **SMS:** no SMS vendor is selected. Staging/production phone challenge readiness remains blocked until a provider is registered. Owner must approve supported countries, sender ID, OTP abuse controls, privacy terms and quote.
- **Email:** no external sender is registered. Add only for a demonstrated recovery or transactional flow. SES Essentials is a cost illustration, not a recommendation or connected sender.
- **Google/WhatsApp/push:** Google identity contract is not Google sign-in; Connect's read-only catalog OAuth is not user login. WhatsApp consent/readiness exists but no sender is registered. Email/SMS/push delivery flags currently report disconnected. Select none without a use case, consent and retention plan.
- **Search:** Search Console ownership verification is free; domain/DNS is owner-controlled. Organic Search is separate from Merchant Center and Google Ads. The checked Google free-listing country list excludes Jordan and Kuwait; this does not prevent organic indexing. A public product-page/sitemap implementation is still needed.

## Official external references

Checked 2026-11-08:

- [OpenRouter Gemma 4 31B free](https://openrouter.ai/google/gemma-4-31b-it:free)
- [OpenRouter Gemma 4 26B A4B free](https://openrouter.ai/google/gemma-4-26b-a4b-it:free)
- [OpenRouter ZDR and data-policy tiers](https://openrouter.ai/docs/features/zdr)
- [Google Gemma 4 documentation](https://ai.google.dev/gemma/docs/gemma-4)
- [PayTabs country FAQ](https://site.paytabs.com/en/faq)
- [Tap Kuwait marketplace page](https://www.tap.company/en-kw/products/marketplaces)
- [MyFatoorah Kuwait terms](https://portal.myfatoorah.com/En/KWT/Home/TermsAndConditions)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Mapbox pricing](https://www.mapbox.com/pricing)
- [Mapbox Geocoding API](https://docs.mapbox.com/api/search/geocoding/)
- [OpenStreetMap Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
- [Google Search Console ownership verification](https://support.google.com/webmasters/answer/9008080?hl=en)
- [Google Merchant Center free listings and country eligibility](https://support.google.com/merchants/answer/13692890?hl=en)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
