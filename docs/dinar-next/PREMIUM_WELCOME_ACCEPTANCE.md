# Premium welcome candidate — acceptance in progress

Starting branch: `codex/dinar-premium-visual`.
Starting and verified remote SHA: `bfb6e7c43cd6a3a15f0cb0df6eea9a44ea0cedca`.
Owner has not accepted that visual checkpoint as final. No merge or deployment is authorized.

## Architecture and action contract
`Ai.tsx` owns the existing conversation and guarded submission. `ConversationHistory.tsx`
provides one typed action registry and renders Welcome. `ChatComposer.tsx` retains ownership
of draft input, upload validation, recording, send/stop and pending state. Existing cards,
cart, orders, legal/market controls and server receipts are unchanged.

| Action | Existing destination | Side effects before confirmation |
| --- | --- | --- |
| أريد أن أشتري | `onStarter` → existing guarded conversation turn | Request intent only; no direct order/payment API |
| أريد أن أبيع | Existing seller-draft prompt through `onStarter` | Draft assistance; no direct listing publication |
| قارن الأسعار | Composer prefill requesting actual products | No provider call until user sends |
| ابحث بالصور | Existing attachment button and file input | Existing sign-in/type/size gates; no upload until send |
| ساعدني في البرمجة | Composer prefill | None |
| خطط معي | Composer prefill | None |
| اقترح فكرة | Composer prefill | None |
| أنشئ إعلانًا | Composer prefill | No ad publication or purchase |
| حلّل منتجي | Composer prefill asking for actual product data | None |

No mode lock or additional runtime is introduced. A subsequent unrelated question remains
supported. All submission errors and retries retain the current conversation recovery path.

## Reference reconciliation
The latest owner reference replaces the small starter row with three prominent commerce
cards and six secondary actions. Implemented hierarchy follows that structure, including
central brand composition, static atmospheric vector lighting, stronger glass edges, a warm
seller card, quiet spring entrances, hover/press feedback and an integrated composer.

The reference's simplified D/star differs from the current canonical D/chat/cart vector.
This candidate preserves `/brand/dinar-mark.svg` from the reviewed bfb6e7c checkpoint; it does
not silently introduce another logo. Decorative symbols are aria-hidden SVG components.
No reference prices, ratings, discounts, inventory or product imagery are copied into UI.

Mobile uses a scrollable action region and a separate composer row. Mobile/short-landscape
content must remain reachable without horizontal overflow. Reduced motion disables entrance
and hover movement. Background art is static SVG, with no canvas, WebGL or continuous loop.
The existing composer is the principal blurred surface (8px on phones, 16px desktop).

## Demonstrated defect and fix
The unlayered `.dinar-wordmark { display: inline-block }` defeated Tailwind's narrow-header
`hidden` utility, producing 34px overflow in Admin Categories and Connect at 320px. Removing
that display declaration preserves the canonical title and allows the responsive utility.
Both `experience-upgrade-acceptance` and `connect-cards-browser-journey` passed after the fix;
logs and measurements are retained in `/workspace/dinar-premium-evidence/brand-fix`.

## Acceptance status
Final integrated acceptance is running; this document is not a release approval.
Earlier 160 visual captures alone are not sufficient acceptance for this new welcome.

Safari: attempted Playwright WebKit launch; executable is absent at
`/home/agent/.cache/ms-playwright/webkit-2359/pw_run.sh`. Chromium device emulation does not
establish real iOS Safari, VoiceOver or physical-device GPU performance. These must not be
reported as passed. Frame/heap metrics from headless Chromium are diagnostic measurements.
