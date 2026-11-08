# DINAR AI Integrations Cost Model

**Prices checked:** 2026-11-08
**Currency:** USD unless stated otherwise
**Status:** Planning scenarios only; not a vendor quote, workload forecast or spending authorization.
**Audited application source SHA:** `6b56704ff04dc7682a57e0a6fa8fcc594600e53a`
**Canonical branch HEAD:** `995d2e57b94bfe552d25e902137c584e554b8114` (documentation-only; direct parent is the audited source SHA)

## Assumptions and billing model

- Railway currently charges a plan subscription and metered resource usage; the subscription contributes toward usage rather than being added twice. Estimate as `max(plan minimum, metered resource estimate)` before credits, taxes, account-level adjustments and optional services.
- Public Railway plan prices checked: Free $0/month, Hobby $5/month, Pro $20/month. Usage rates: RAM $10/GB-month, CPU $20/vCPU-month, service egress $0.05/GB, Volume storage $0.15/GB-month. Railway Buckets are $0.015/GB-month; S3 operations and bucket egress are listed as free, but uploading/downloading through a Railway service can incur service-egress charges.
- The Railway values below are assumed monthly average usage across app/database services, not recommended sizing. The current connected project inventory observed only development PostgreSQL, no DINAR app deployment or visible Bucket. These are hypothetical staging/launch scenarios, not current billing.
- Replit workspace cost, domain, paid AI, SMS, payment processing, legal services, CDN, tax and separately contracted monitoring are excluded unless shown below.
- All external prices and country/merchant eligibility can change; owner must re-check the quoted service and account before purchase.

## Railway usage scenarios

Formula:

`RAM_GB × $10 + vCPU × $20 + service_egress_GB × $0.05 + volume_GB × $0.15 + bucket_GB × $0.015`

| Scenario | Assumed monthly-average resources | Metered estimate | Approximate Railway bill |
|---|---|---:|---:|
| A — development plus isolated staging pilot | 2 GB RAM, 1 vCPU, 20 GB service egress, 10 GB volume, 25 GB Bucket | `$20 + $20 + $1 + $1.50 + $0.38 = $42.88` | About $42.88/month on Hobby or Pro before excluded items |
| B — small public launch | 4 GB RAM, 2 vCPU, 100 GB service egress, 40 GB volume, 100 GB Bucket | `$40 + $40 + $5 + $6 + $1.50 = $92.50` | About $92.50/month on Hobby or Pro before excluded items |
| C — growing marketplace | 8 GB RAM, 4 vCPU, 500 GB service egress, 100 GB volume, 250 GB Bucket | `$80 + $80 + $25 + $15 + $3.75 = $203.75` | About $203.75/month on Pro before excluded items |

These totals use assumed averages, not an uptime/availability guarantee. A combined number can hide app, database, replica and egress differences; measure per service once staging is authorized. It also does not size redundancy, backup storage, high availability, larger logs or geographic egress. Set owner-controlled budget alerts before creating services.

## Fixed, metered, and optional costs

| Cost type | Example/checkpoint | Estimated amount and exclusions |
|---|---|---|
| Platform subscription floor | Railway Hobby / Pro | $5 / $20 monthly; contributes toward metered usage. Free plan has limits and is not a production recommendation. |
| Platform metering | Railway CPU, RAM, egress, Volumes | Rates above; actual bill depends on measured service uptime and usage. |
| Object storage | Railway Bucket | $0.015/GB-month. Bucket S3 operations and bucket egress are free per current billing page, but service network traffic remains chargeable. Backup/PITR footprint must be measured. |
| OpenRouter Gemma free variants | Current 31B and 26B A4B `:free` pages list free input/output; current free provider is Google AI Studio | $0 while that endpoint remains available and the account is eligible. No SLA/quota promise. Strict Google ZDR-only routing excludes Safety Retention endpoints; don't weaken privacy to save cost. |
| Paid text/vision AI | No provider/model selected | Not estimated; use selected model's current official rate, real usage and a hard budget. No live inference was performed. |
| Image generation/editing | No DINAR adapter or model selected | Not estimated per image: model, resolution, quality and candidate count change cost. Optional; calculator/quote required before activation. |
| Email example: Amazon SES Essentials | Current published rate for first 0–10M emails/month | $0.16 per 1,000 emails, charged per recipient; 1,000 ≈ $0.16, 20,000 ≈ $3.20, 100,000 ≈ $16. Sender domain, deliverability operations and taxes are not a chosen integration. |
| SMS | Country route, sender and OTP design not selected | Quote required; count segments, retries, verification attempts, sender registration and country surcharges separately. |
| Payments | PayTabs/Tap/MyFatoorah not contracted | Quote required. Transaction rate, fixed fee, payout/FX, reserves, chargebacks, refunds, tax and marketplace splits depend on approved entity and signed terms. Do not model from marketing pages. |
| Domain | No domain selected | Registrar/TLD-dependent purchase and renewal; owner checks checkout and taxes. Search Console has no fee. |
| Google Maps Platform | Dynamic Maps: first 10,000 events free then $7/1,000 in first band; Autocomplete Requests: first 10,000 free then $2.83/1,000 | Other Places, Geocoding and Routes SKUs are separate. 15,000 map loads ≈ $35; 100,000 ≈ $630; 50,000 autocomplete requests ≈ $113.20 using the first paid band after the free cap. |
| Mapbox | GL JS: 50,000 map loads free, next band $5/1,000; Temporary Geocoding: 100,000 requests free, then $0.75/1,000; Permanent Geocoding begins $5/1,000 | Temporary vs permanent storage rights differ; these are separate products, not direct substitutes for every Google SKU. |
| Public Nominatim | No API charge | Public endpoint is capped at 1 request/second per application, requires an identifying User-Agent/Referer and attribution, and forbids heavy/bulk usage. Not a dependable production-scale free tier. Self-hosting has infrastructure/operations cost not estimated. |
| Monitoring/error service | DINAR currently has redacted logs/log-only boundary; Railway monitor features depend on plan | No vendor selected; Pro is $20/month minimum as above. Additional provider cost depends on events, retention and attachments. |
| Counsel, KYB and compliance | Launch markets/legal entity not finalized | Not estimated; written local advice/provider onboarding is required before activation. |

## Cost controls and budgeting gates

1. Keep Railway staging and production isolated; alert before app, bucket, egress and backup usage reaches the owner's ceiling.
2. No automatic paid AI fallback. Set per-call output/token limits, model/provider allowlist, user/day quota and month budget. Treat free-model quota as variable, not guaranteed.
3. Gate map APIs behind product need, consent, SKU quotas and a feature off switch. Do not store precise location without an approved need/retention period.
4. Rate-limit OTP/recovery sends and retries; measure per-country segment counts and sender charges.
5. Count email recipients, bounces and suppression events; use the smallest required transactional flows.
6. Payment forecast requires signed quotes and volume assumptions for payment method mix, GMV, refunds, disputes and payouts. GMV is not DINAR revenue.
7. If image editing is introduced, cap attempts and define draft expiration/deletion before enabling it.

## Sources

Checked 2026-11-08:

- [Railway pricing and resource rates](https://docs.railway.com/reference/pricing)
- [Railway Bucket billing](https://docs.railway.com/storage-buckets/billing)
- [Railway PITR](https://docs.railway.com/volumes/point-in-time-recovery)
- [OpenRouter Gemma 4 31B free](https://openrouter.ai/google/gemma-4-31b-it:free)
- [OpenRouter Gemma 4 26B A4B free](https://openrouter.ai/google/gemma-4-26b-a4b-it:free)
- [OpenRouter ZDR](https://openrouter.ai/docs/features/zdr)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Mapbox pricing](https://www.mapbox.com/pricing)
- [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
- [PayTabs country FAQ](https://site.paytabs.com/en/faq)
- [Tap Kuwait marketplace page](https://www.tap.company/en-kw/products/marketplaces)
- [MyFatoorah Kuwait terms](https://portal.myfatoorah.com/En/KWT/Home/TermsAndConditions)
