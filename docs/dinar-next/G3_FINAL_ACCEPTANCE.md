# DINAR NEXT G3 — Final Acceptance (G0–G3)

Date: 2026-10-20. Branch `main`. Start HEAD `d6bf588`. Checkpoints: `ebbf2df` (G0+G1), `b286e74` (G2), final commit
"DINAR NEXT G3". Nothing pushed or deployed. All database-touching runs used disposable loopback PostgreSQL 16
clusters in the session scratchpad (127.0.0.1:55432; port-pinned suites on 55479 / 55438); managed `PG*`,
`DATABASE_URL` and `DINAR_DEV_DATABASE_URL` were stripped; provider keys were stripped; every model call in tests
was a scripted gateway. Every result below was executed in this session.

```
USAGE PLANS IMPLEMENTED: FREE, BUSINESS_GO, BUSINESS_PRO (+ GUEST). Same capabilities; allowances only.
QUOTA CONFIGURATION:     commercial_policies.aiUsage; code v0 placeholders, approved=false (see §2)
REAL BILLING:            DISABLED
BUYER–SELLER INQUIRIES:  live (development) — review → confirm → in-app delivery
SELLER–BUYER INQUIRIES:  live within an existing inquiry, negotiation or order only
ASYNC REPLIES:           durable delivery into the other party's DINAR conversation; status/read/reply events
NOTIFICATIONS:           NOT CONFIGURED (no SMS/e-mail/push adapter exists); reported as such, never implied
CONVERSATION SURFACES:   AI_USAGE, AI_PLANS, INQUIRY_DRAFT/STATUS/INCOMING/LIST/NOTICE, SALES insight; rebuilt on reload
PRIVACY:                 no phone/e-mail/links in inquiries; party- and market-scoped reads; other party's words never
                         become model history; no prompt text in the usage ledger
TYPECHECK:               PASS (pnpm run typecheck)
BUILD:                   PASS (pnpm run build)
TEST COUNTS:             49 suites, 768 pass / 0 fail / 1 skip (+ guard 8/8, capability registry 6/6,
                         personal-intelligence 1/1, image-publication 1/1, pre-switch script PASS)
BROWSER ACCEPTANCE:      PASS — production build, signed in; no overflow, RTL, no console errors
BLOCKERS:                billing provider, notification transport, owner approval of prices/quotas, live provider key
FINAL COMMIT:            "DINAR NEXT G3: …" (see git log)
```

## 1. Phases

| Phase | Status | Evidence |
|---|---|---|
| G0 audit | DONE | `G0_EXISTING_CAPABILITY_AUDIT.md` |
| G1 usage allowances | VERIFIED (development) | next-g1-usage 21/21 |
| G2 mediated inquiries | VERIFIED (development) | next-g2-inquiry 17/17 (G2 §12 scenarios 1–20 + yes/no reply, injection guard, block) |
| G3 combined + conversation-first | VERIFIED (development) | next-g3-acceptance 14/14 incl. browser |

## 2. Implemented allowances (configuration placeholders, not approved)

Requests per calendar month (UTC) and token budget per tier, `DEFAULT_AI_USAGE_POLICY`:

| Tier | Text | Marketing | Business analytics | Images | Multi-step | Tokens |
|---|---|---|---|---|---|---|
| GUEST | 10 | 0 | 0 | 0 | 0 | 40,000 |
| FREE | 150 | 30 | 30 | 20 | 10 | 600,000 |
| BUSINESS_GO | 600 | 150 | 150 | 100 | 50 | 2,400,000 |
| BUSINESS_PRO | 2,000 | 600 | 600 | 400 | 200 | 8,000,000 |

Global guard: 200,000 requests / 400,000,000 tokens per UTC day. Reservation TTL 180 s; near-limit notice at 80 %.
Prices: none configured — a Go/Pro price exists only when an admin creates a `DINAR_BUSINESS` plan with an
`AI_USAGE_BUSINESS_GO/PRO` key; until then the conversation says «السعر غير معتمد بعد». `AGENT_MULTI_STEP` is
configured but DINAR has no expensive multi-step agent today (compound requests are deterministic); a marketing
corrective retry is metered as a second provider call inside one request.

## 3. G3 acceptance (next-g3-acceptance)

| # | Scenario | Result |
|---|---|---|
| G3-01 | Free/Go/Pro: same general answer, search, inquiry draft, sales card; limits 2/4/6 in the test policy; no access to others' data | PASS |
| G3-02/04 | Free exhausted: no model call, truthful message, renewal, plan hint once, usage readable; inquiry sent and negotiation opened without AI allowance | PASS |
| G3-03 | «دينار اسأل البائع هل عنده 50 قطعة» → draft (stock 19 shown, no promise) → «نعم، أرسل» → seller «عندي 60 قطعة، ويمكن توفيرها خلال يومين.» → «دينار ماذا قال البائع؟»: verbatim, attributed, same conversation, stock unchanged, no order | PASS |
| G3-03b | Reverse inside an ORDER relationship; buyer answers asynchronously; order unchanged | PASS |
| G3-05 | Price wording refused as inquiry; phone refused; no public phone; KW cannot reach JO; duplicate refused; payments SIMULATION_ONLY; no auto-renew; commission 10 % | PASS |
| CF-A | «متى ينتهي اشتراكي؟», «أريد إلغاء التجديد» → review → CANCEL_AT_PERIOD_END, allowance kept to period end | PASS |
| CF-7/8/9 | Sales this month (orders, completed, gross, paid 0 for cash, net after 10 %), month comparison, top products, «كم طلب مكتمل»; another account sees only its own empty records | PASS |
| CF-10/11/17 | Inventory; price change previewed then confirmed; refused send reported, nothing stored | PASS |
| CF-15 | Provider unavailable: honest failure, nothing charged, usage/inquiries still work | PASS |
| CF-16 | Billing not configured: no activation, no subscription row | PASS |
| CF-13 | Reload: usage card, inquiry status, confirmed draft and negotiation rebuilt from live state | PASS |
| CF-account | Account surface, no secrets | PASS |
| BROWSER | Usage + plans at 320 (light), 390 (dark), 1280 (light); two-party inquiry by clicking «أرسل» on both sides, reload, attributed reply; sales card with comparison | PASS (0 overflow, RTL, 0 console errors) |

Conversation-first acceptance list (authority §REQUIRED ACCEPTANCE) 1–18: covered by G1-01/04, G3-01/02,
CF-7/8/9/10/11/13/15/16/17, G3-03, BROWSER (14 mobile/RTL), G3-02/04 (18).

## 4. Regression (49 suites on fresh clones)

Core/unit: commerce 23, conversation 28, promotions 6, location-policy 1, marketplace-intelligence 20,
employment 12, r5 3, conversation-router 7, promotion-intent 5, ai-provider 9, database-url-selection 5,
listing-image-policy-review 11, listing-photo-vision-provider 5, phone-verification-bypass 1, development-tls 2
(+1 skipped: live managed TLS, correctly not run). Commerce: api 63, blockb 5, blockf0 12, blockf1 14, blockf2 14,
blockf3 17, blockf4 48, blockf5 29, wave3 11, wave4 1, phase1 1, phase2 1. Conversation: blocka 1, blockc 50,
blockd 28, blocke 46, g1 39, g2 91, gfinal 22, nl-micro 1, nl-probes 1, command-a 22, -b 9, -c 11, -d 6,
readiness 11, security 12. Browser: g3 6, contact 1, command-e 2, command-f 3. New: next-g1 21, next-g2 17,
next-g3 14. **768 pass, 0 fail, 1 skip.** Compared with FINAL (713/1/1): phase1 now passes (updated in `d6bf588`).

Harness notes: blockc, blockd, wave3 and phase2 failed once only because their browser parts were started in
parallel with other suites (web server not ready within 60 s); rerun sequentially they passed. No product
change was made for them.

Test updates (intended contract changes): `readiness` expects journal head `0036_marketplace_inquiries`;
`ai-provider` expects the new `providerCalls: 1` metering field on a quota-limited call.

## 5. Defects found and fixed during G

| Defect | Fix |
|---|---|
| «كم باقي لي من المحادثات؟» answered as stock | usage intent (`usage-intent.ts`) excluded from seller inventory |
| Inquiry cards dropped the listing in focus | INQUIRY_* cards carry `resourceId`; listing-less notices do not steal focus |
| «وضح للمشتري أن التجهيز يحتاج يومين» rewritten to «تحتاج» | pronoun addressing only for questions |
| Bare «أرسل» with nothing pending reached the model | explicit «لا توجد رسالة بانتظار الإرسال» |
| General question under a status card captured as a reply | replies only under a delivered message, or statements under a status card |
| Seller text reached the model via DINAR's status answer | inquiry answers marked and excluded from history |
| «نعم» as an answer under a delivered question | becomes a reply draft |
| Buyer saw «بانتظار رد المشتري — بانتظار ردك» | viewer-relative status label |

## 6. Remaining integrations and blockers

| Item | State |
|---|---|
| Real billing for Go/Pro | Not connected. Development uses the existing simulated commercial balance (TEST_NO_TRANSFER); elsewhere the conversation says billing is not connected |
| Prices and quotas | Owner approval required; code values are placeholders (`approved:false`) |
| Notification transport (SMS/e-mail/push) | None exists; delivery is in-app only |
| Abuse report from the conversation | Block/close implemented; formal reports still via the existing `/reports` flow (needs reason codes) |
| Background memory topic extraction | Gated by allowance and global guard, not metered per user |
| Usage counters | Per account across markets; tier from the active market's subscription |
| Advanced Market Pulse | Still capability-gated by Business (baseline B-4, owner decision) |
| Live AI | Repl default GROQ key rejected (from F); REPLIT_OPENAI works (owner switch) |
| Seller statistics time zone | UTC calendar (markets have no time-zone field) |
| S-1 leaked token in `.replit` | Owner must revoke (baseline); untouched |
