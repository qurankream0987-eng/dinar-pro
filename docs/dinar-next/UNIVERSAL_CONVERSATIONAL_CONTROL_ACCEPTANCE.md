# DINAR NEXT — Universal Conversational Product Control: Acceptance

Base revision `fcaa80b` (main). All changes are in the working tree, uncommitted (no commit, push or deployment was requested).

**Final result: PARTIALLY VERIFIED** — everything that can be implemented without external providers or owner decisions is implemented and verified (API, runtime, authorities, browser). Real billing, a map provider, live driver GPS and notification transport remain owner/provider blockers (§9).

## 1. Architecture

One conversation, one runtime. A new intent adapter, `product-control-turn.ts`, sits in the existing chain before the order, inquiry and commerce adapters. It reads slots from the user's words — a theme value, a country, a recipient, a name — rather than fixed sentences. It resolves them against server registries and hands every mutation to an existing authority:

```
words → slot extraction (theme | country+intent | recipient | name)
      → canonical resolution (THEME_PREFERENCES | markets table + global countries | order/inquiry relationship)
      → authorization (owner, participant, assigned driver, seller relationship, market availability)
      → typed surface (ProductControlPayload, compact)
      → confirmation (F0 pending action) or client acknowledgement (theme)
      → execution by the existing authority → real state → conversational result
```

The model can **name** a capability but cannot execute one. A new suggestion, `PRODUCT_CONTROL`, carries `capability.id` (an allowlisted catalog id) plus an optional `theme`/`countryCode`. The server turns that into the capability's canonical utterance (`capabilityUtterance`) and re-enters the deterministic runtime with the model disabled (`noModel`). An unknown id rejects the whole model output. Product control needs no model call and keeps working when the provider is down or the AI allowance is exhausted.

## 2. Capabilities

### Universal catalog (new)
`PRODUCT_CAPABILITY_CATALOG` in `lib/api-zod/src/conversation-runtime.ts`. Each entry carries id, intents, model-suppliable input, actor, resource scope, market scope, READ/WRITE/CLIENT, confirmation policy, executor, surface, idempotency, errors, availability and model discoverability. Entries:

| Capability | Executor | Confirmation |
|---|---|---|
| SET_THEME | client `lib/theme.setThemePreference` + server acknowledgement | none (device-local) |
| SWITCH_MARKET | `action-foundation:SWITCH_MARKET` | required |
| SELLER_MARKET_ELIGIBILITY | `lib/markets` eligibility (read) | none |
| UPDATE_DISPLAY_NAME | `action-foundation:UPDATE_DISPLAY_NAME` | required |
| VIEW_ACCOUNT / settings / logout | existing `openSurface` ACCOUNT, SETTINGS, LOGOUT | — |
| NOTIFICATION_PREFERENCES | none: no notification transport exists → honest UNAVAILABLE | — |
| AI_PLANS / AI_USAGE | existing commerce-turn, `lib/business`, `lib/ai-usage` | provider-verified |
| SELLER_SALES | existing `seller-sales` | — |
| SHARE_LOCATION, SHARE_LOCATION_WITH_DRIVER, SHARE_BUSINESS_LOCATION | delivery authority / inquiry authority | required |
| MARKETPLACE_INQUIRY | existing `SEND_INQUIRY_MESSAGE` | required |

### Registries extended
- `CONVERSATION_CAPABILITY_REGISTRY`: `APP_PREFERENCES`, `MARKET_SELECTION`, `ACCOUNT_SETTINGS`.
- `CONVERSATION_ACTION_REGISTRY`: `SET_THEME` (new route kind `CLIENT_ACTION`), `SWITCH_MARKET`, `UPDATE_DISPLAY_NAME`.
- Surface family `control`: `APP_THEME`, `MARKET_SWITCH_REVIEW`, `MARKET_SWITCH_STATUS`, `PROFILE_REVIEW`, `PROFILE_STATUS`, `CONTROL_NOTICE`, rendered by `PRODUCT_CONTROL_SURFACE`.
- `ProductControlPayload` (strict zod discriminated union) validates the payload on the server and the client.

### Reused, not rebuilt
Action foundation state machine, delivery/location authority (`lib/delivery`), driver assignment (`lib/driver`), inquiry authority (`lib/inquiries`), market registry (`lib/markets`, `@workspace/global` countries), Business/AI plans (`commerce-turn`, `lib/business`), AI usage, seller sales, theme authority (`lib/theme.ts`), and the existing ACCOUNT/SETTINGS/LOGOUT and market-selector surfaces.

## 3. Source paths

| Area | Path |
|---|---|
| Adapter | `artifacts/api-server/src/ai/product-control-turn.ts` (new) |
| Runtime wiring, model re-entry | `artifacts/api-server/src/ai/conversation-runtime.ts` |
| Pending actions SWITCH_MARKET, UPDATE_DISPLAY_NAME | `artifacts/api-server/src/ai/action-foundation.ts` |
| Driver / pickup-point sharing, wider share phrases | `artifacts/api-server/src/ai/delivery-turn.ts` (`shareLocationWithAssignedDriver`, `shareBusinessPickupPoint`) |
| Public business area via inquiry | `artifacts/api-server/src/ai/inquiry-turn.ts` (`draftPublicBusinessLocation`) |
| Model contract | `artifacts/api-server/src/ai/model-turn.ts` (`PRODUCT_CONTROL`, `capability`), `smart-turn.ts` |
| Plans phrasing («أريد Go», «أريد دفع اشتراكي», «كم تكلفة برو») | `artifacts/api-server/src/ai/commerce-turn.ts` |
| Route: payload, reload refresh, acknowledgement | `artifacts/api-server/src/routes/ai.ts` |
| Shared contract | `lib/api-zod/src/conversation-runtime.ts` |
| OpenAPI / generated | `lib/api-spec/openapi.yaml` → `lib/api-zod`, `lib/api-client-react` |
| UI | `artifacts/dinar/src/features/ai/ControlSurface.tsx` (new), `ConversationContent.tsx`, `pages/Ai.tsx`, `pages/AiChat.css` |
| Theme authority | `artifacts/dinar/src/lib/theme.ts`, `main.tsx` |
| Tests | `artifacts/api-server/test/universal-control-acceptance.test.ts`, `artifacts/dinar/test/universal-control-browser.mjs`, script `test:ucc` |

## 4. Backend contracts

- `POST /ai/conversations/{id}/control-actions/{resultSetId}/acknowledgement` `{status: APPLIED|FAILED}` → `{status}`. Only the owner of a REQUESTED theme action can call it. The first report is recorded and later reports return that recorded outcome. Anything else returns 404.
- `AiUiBlockPayload.control` (OpenAPI) plus six new surface tokens in the surface enum; history responses validate against them.
- `SWITCH_MARKET` (`market:<from>><to>`): checks the target market is available again under a row lock, then updates `users.active_market_id` **and** rebinds the AI conversation to the new market. Old result sets can then no longer be resolved for new mutations. Orders keep their market and financial snapshot. Seller eligibility, licensing and the legal/account country are never touched.
- `UPDATE_DISPLAY_NAME` (`profile:<actor>@<market>`): same rules as `PATCH /account/profile` (2–80 characters). Phone numbers, e-mails and links are refused.
- Both go through F0: owner-bound, 10-minute expiry, voided by any newer conversation step, server state re-read before execution, executed once. A repeated «نعم» only gets «تمت معالجة هذا الطلب من قبل».

## 5. UI

- **Compact surfaces.** `conversationSurfaceSize(token)` assigns COMPACT, MEDIUM or WIDE. The block wrapper carries `data-surface-size`. COMPACT cards size to their content: `fit-content`, at least 260px and at most 440px, bounded by the column. MEDIUM cards are at most 640px. Only rails and comparisons use the full column. This applies to existing surfaces too: AI usage, notices, reviews, location, inquiry.
- **Theme.** A small status chip that reads «جارٍ تفعيل…», then «تم تفعيل الوضع الداكن.» once the device has really applied it, or «تعذر…». It is applied once, for the newest request only. The assistant's text is hidden for control-only answers, so the card isn't duplicated.
- **Market and profile reviews.** From/to (or current/new), what stays unchanged, status, and Confirm/Cancel buttons that send the same conversational confirmation. On success the account context and queries refresh, so the header, listings and currency follow.
- RTL, `bdi` for currencies and names, light and dark tokens, 44px buttons (existing `dinar-button`).

## 6. Behaviour by area

- **Theme:** LIGHT, DARK and SYSTEM. Persisted in the existing `dinar-theme` storage key (SYSTEM clears it). Followed live by settings `useTheme` instances in the same tab and by other tabs (`storage` event). Questions about themes in other software, and product colours, are not theme changes.
- **Subscriptions:** server plans and real entitlement, with «السعر غير معتمد» when no price is configured. Go/Pro requests run the existing review, which goes nowhere without an approved price and billing. «تم الدفع، فعّل Pro» activates nothing. A forged `POST /business/subscriptions` is refused. Card data never passes through chat. No checkout surface was built because no provider is approved.
- **Location:** device location is read only by an explicit tap (existing `one-time-location`). Manual entry, cancel, accuracy notes and redaction work as in Block D.
  - New phrasings: «سأرسل لك موقعي», «استخدم موقعي الحالي للتوصيل».
  - **To the driver:** only the buyer's own COURIER order with an ACCEPTED assignment. The destination is the one location that driver can read, and it is deleted when the delivery settles. Another driver or a stranger gets 404. Without an assigned driver nothing is sent.
  - **Business to customer:** for a confirmed PICKUP order, the pickup point (precise, seen by that order's buyer only, labelled as a public business location). Otherwise only the listing's public area (district, city) as a reviewed inquiry message inside an existing relationship. A precise address in a message and a home address are refused. With no relationship nothing is sent.
- **Markets:** browse, sell, residence and «pick» are distinguished.
  - Browse leads to a review. Sell reads eligibility (OPEN, or APPROVAL_REQUIRED and refused without approval). Residence and legal country are refused. A bare «غيّر السوق» opens the existing selector.
  - Unknown and inactive markets are reported honestly and the available ones offered. No exchange rates.
  - «عمان» alone is never Oman.
- **Account:** name review, then confirmation. «غيّر اسمي» without a name asks for it. Notification preferences and business-profile edits report UNAVAILABLE honestly, because no such authority exists. Account, settings and logout use the existing surfaces.
- **Continuity:** no sticky modes. Theme, a general question, plans, a market review and a return to the earlier topic all work in one conversation. An unconfirmed review is voided by the topic change and cannot execute later.

## 7. Tests executed

All runs used disposable loopback PostgreSQL 16 (`127.0.0.1:55432`, `dinar_test_*`, a fresh migrated and seeded DB per suite, dropped afterwards), with provider keys stripped and a scripted model gateway. No Railway or Replit database was touched.

### New suite `test:ucc` (`universal-control-acceptance.test.ts`)
**10/10 PASS** (UCC-00, A, B, C, C2, D, E, F, G and the summary):

| ID | What was proven |
|---|---|
| UCC-00 | Theme, country and market slots are read from varied wording; theme questions, product colours, «عمان», «عندي سيارة للبيع في الكويت» and a search with a place are **not** claimed |
| UCC-A | LIGHT, DARK and SYSTEM run as client actions with no model call. The server never says «تم». Acknowledgement is recorded once (APPLIED stays APPLIED); another user or an unknown id gets 404, and a bad status gets 400. Reload shows REQUESTED, APPLIED or FAILED |
| UCC-B | Plans, «أريد Go/Pro», «أريد دفع اشتراكي» and «كم تكلفة برو» are honest about unapproved prices and billing. A fake «تم الدفع» activates nothing; a forged `POST /business/subscriptions` is refused. No subscription and no payment intent exist. Usage stays readable |
| UCC-C | JO→SA review with nothing changed before confirmation. Confirm switches the user and the conversation. A duplicate «نعم» is idempotent. Search returns SA listings in SAR and no JO listing. The old JO order keeps market, currency, unit, subtotal and scale. KW cancel, expired confirmation, UAE unsupported, QA inactive and residence refusal all work; the account country is unchanged |
| UCC-C2 | Selling in OPEN JO is explained; selling in APPROVAL_REQUIRED KW is refused; no eligibility is granted |
| UCC-D | Dark → general question → Pro → market review → «نرجع للبرمجة» works with no sticky mode, and the stale review cannot execute. A model-named SWITCH_MARKET/KW is rebuilt as a server review, and the model's «تم تحويل» is not shown. An unregistered capability is rejected. With the provider down, theme and market still work |
| UCC-E | A name without a value is asked for, a phone in the name is refused, and review → confirm updates `/auth/me`. Notifications and business profile report UNAVAILABLE. Account and logout surfaces work. Reload shows the review as SUCCEEDED |
| UCC-F | No order → nothing shared. «سأرسل لك موقعي» → request, then cancel stores nothing. Manual address → preview → confirm stores one location. COURIER with no assignment → refused; after `assignDelivery` the assigned driver gets 200, another driver and a stranger 404. Seller with no relationship → refused; home address and precise address refused. Inquiry-only seller → public «خلدا، عمان» draft → sent → buyer reads it verbatim. Pickup order → pickup-point request labelled as the business location |
| UCC-G | Browser journey, below |

Scenario map (prompt §16): A 1–4 → UCC-A, UCC-G; B 5–12 → UCC-B; C 13–20 → UCC-F (the device-permission prompt itself is the existing client flow, also exercised by the block-d browser suite); D 21–27 → UCC-C, UCC-C2; E 28–32 → UCC-D; F 33–42 → UCC-E, UCC-A, UCC-B, UCC-C, UCC-D (provider down); G 43–47 → UCC-G; 48 → regression below; 49 → OpenAPI contract plus history validation; 50 → typecheck/build.

### Browser (`universal-control-browser.mjs`, production build, Chromium)
**PASS, 0 console errors, 0 horizontal overflow, RTL.**

- **Theme at all 11 widths** (320, 360, 375, 390, 414, 430, 768, 1024, 1280, 1440, 1600): dark is applied, the chip reads «تم تفعيل الوضع الداكن.», the reload keeps dark, and the light switch is applied. The theme chip is **260px** while the column is 296–780px, so it is compact at every width.
- **System and tabs:** «لايت مود» in tab 1 → tab 2 turns light. «حسب الجهاز» on a dark device → both tabs dark, and the stored preference is cleared.
- **Market by click** (320 light, 1280 dark): the review card is 261px / 277px in columns of 296px / 780px. Clicking «تأكيد» → SUCCEEDED, the server reports `activeMarketId=SA`, the header shows Saudi Arabia, and **the same conversation stays open**. The unsupported-market notice is compact and offers the available markets.
- **Profile by keyboard:** focus on «تأكيد» + Enter → SUCCEEDED; the server name is updated; after a reload the review shows as done with no confirm button.

Screenshots were saved under the session scratchpad (`ucc-browser/shots`).

### Regression
52 suites, each on a fresh disposable DB. Browser-bearing suites were rerun sequentially, because parallel runs contend for the same Vite build output.

**776 pass, 10 fail, 1 skip** (the skip is live managed TLS, correctly not run). New-feature and conversation suites are all green:

- conversation 28, commerce 23, api 63, g1 39, g2 91, g-final 22, next-g1 21, next-g2 17, next-g3 14 (including its production-build browser part)
- command-a 22, b 9, c 11, d 6, f 3
- block-f0 12, f1 14, f2 14, f3 17, f5 29
- wave3 11, wave4 1, phase2 1, readiness 11, ai-provider 10, conversation-router 7, personal-intelligence 1, marketplace-intelligence 20, employment 12, and others

**All 10 failures are pre-existing and environment-bound, reproduced identically on the unmodified base `fcaa80b` (stash → run → restore):**

| Suite (failing case) | Signature | Base `fcaa80b` |
|---|---|---|
| block-a, block-c C23, block-d D21, block-e E34, block-f4 F4-21, phase1 | the Vite **dev-server** error overlay (`<vite-error-overlay>` intercepts clicks); the same suites' API cases all pass | same (block-a, phase1 rerun on base) |
| command-e | a composer icon button is 38×44 at 320px (tap target < 40) | same |
| experience-upgrade | «320-light: compact top bar on phones/tablets» | same |
| g3-ui G3-03 (+ its summary assertion) | the transient «processing» status was not observed during a fast search turn | same |

Regressions found and fixed during this work:
- a bare «غيّر السوق» was being taken over by the new adapter; it now opens the existing selector again (api.test);
- after a conversational market switch the page jumped to a blank chat; the conversation is now kept open (UCC-G).

`security-acceptance`, `pre-switch`, `xp-probe`, `command-a-probe` and `listing-image-publication-acceptance` were not run in this session.

Workspace `pnpm run typecheck` passes; the frontend production build and the API build succeed.

## 8. Security results

- The model output stays strict. Only allowlisted capability ids are accepted, and suggestions run nothing; the model's own «تم» never reaches the user for a control action (UCC-D).
- Every write is an F0 pending action bound to its owner and conversation, with expiry, re-validation and single execution. Expired, cancelled and duplicate confirmations were verified.
- Acknowledgements are owner-only (another user gets 404), and the first one recorded stands.
- Location goes only to order participants and the assigned driver (another driver gets 404). A precise or home address is never sent through messages. No coordinates enter model context (existing redaction) or conversation blocks (existing scrubbing).
- No secrets reach the model. No billing activation and no payment intent were created.

## 9. External providers and owner decisions

| Item | State |
|---|---|
| Real subscription billing / hosted checkout | Not connected; no provider approved. Go/Pro prices are unapproved, so the conversation says so and nothing activates |
| Map provider (pick on map) | Not configured; manual address plus a one-time device reading only |
| Live driver GPS | `LIVE_DRIVER_LOCATION` remains PROVIDER_NOT_CONFIGURED |
| Notification transport | None; preferences reported as unavailable |
| Live LLM | Unchanged from G3: the Repl default GROQ key is rejected; REPLIT_OPENAI works (owner switch) |

## 10. Known limitations

- A theme change is a conversation step, so like any newer step it voids a pending purchase or market review, which must then be requested again.
- Guest `/ai/preview` does not run product control (guest chat is model-only); guests change the theme in settings.
- Switching market from the header does not rebind an existing conversation (existing behaviour). Only a conversational switch does.
- Old-market cards in a rebound conversation show their stored state; their actions resolve against the new market and are refused.
- There is no separate business or storefront profile. The «business location» is the pickup point inside an order, or the listing's public area.
