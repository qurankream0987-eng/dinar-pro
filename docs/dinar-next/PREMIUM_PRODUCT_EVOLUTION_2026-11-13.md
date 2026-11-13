# JassimAI — Premium product evolution: evidence report (2026-11-13)

Branch `claude/jassimai-premium-product-evolution` (local only, not published, not deployed).
Base: `claude/jassimai-general-agent-evolution` `a00f946` (published) merged with the published
`claude/jassimai-responsive-ui-consent` `5002bde` → merge `8ee38c6`.

## A. Summary

| Area | Result |
|---|---|
| Authorised publication | `claude/jassimai-general-agent-evolution` pushed as a new remote branch; remote SHA `a00f946` = local; history intact (`a640323` is an ancestor); no force. |
| Flexible cards | Arrangement on request (image size, price position, density, details placement) for results and the seller draft, via deterministic floor or model directive; illustrative example cards that can never carry a capability; draft card redesigned as a listing card. |
| Visual | Calmer premium layer: solid materials, hairline edges, one soft shadow, consistent radii, gold for accents only, smaller mark, calm dark mode, compact search-context chip, visible focus, reduced motion. 60 before / 60 after screenshots; strict tour 4/4. |
| Intelligence | 14 understanding defects found by an end-to-end probe and fixed (see D); 1 regression from the previous mission found and fixed («روّج»). |
| Payments | Whop adapter (flag-gated, off) built from current official docs + SDK source; mock suite 11/11; pre-existing lifecycle defect fixed (DB trigger vs state machine). |
| Blocked | Real Whop (account/KYB/eligibility/credentials), approved plan prices, SMS, OpenRouter budget, legal entity, staging/production deployment approval. |

## B. Git and architecture

- Commits on the branch after the merge: `189a647` (Whop + lifecycle), `3b00a8b` (flexible cards,
  visual layer, intelligence fixes) and this report commit.
- No migration, no new dependency, no lockfile change. Generated clients untouched.
- One conversation runtime and one card contract: presentation is a closed-enum field on the
  existing `DisplayDirective` and `ResultComposition`; illustration is a flag on the existing
  `ComposedSurface`; Whop maps onto the existing `subscription-billing.ts` machine and ledger.

## C. Visual results

Evidence: `premium-visual-browser.test.ts` (real Chromium, production build, disposable DB),
15 steps × {phone 390×844, desktop 1280×720} × {light, dark}: welcome (guest/user), login,
register, results, enlarged results, table, cart turn, plans, illustrative card, cart page,
settings, draft, enlarged draft, draft preview. After: horizontal overflow 0 on all 60 steps,
composer visible on every chat step, 0 console errors (asserted).

Corrected: full-width «سياق البحث» launcher on phones (flex shell ignored `justify-self`); decorative
dark atmosphere and gradient action cards; heavy glass/glow; gold gradient buttons; 100 px glowing
mark; plain-list draft card; technical «الرموز» label on plans; example requests drawn as a tutorial.

Not done (remaining): auth pages were already flattened on the UI branch and are unchanged here;
a full 11-viewport matrix was run on the UI branch (ui-shell-browser 6/6 in this battery) but the
new tour covers 2 viewports; Core Web Vitals were not measured (asset delta only: CSS +8.5 KB,
JS +3.3 KB).

## D. Intelligence

Probe: `premium-journeys.test.ts`, the owner's own prompts through the runtime, scripted model.
Defects found and fixed (each now asserted):

| Prompt | Before | After |
|---|---|---|
| «جاسم روّج إعلاني» (g3-ui) | marketing copy (regression) | promotion product |
| «جاسم روح بيع لي تلفوني» (no listings) | dead end «لا توجد إعلانات» | sale draft «تلفوني» |
| «عندي آيفون 13 برو، مستعمل، أبي أبيعه بالكويت» after S01 | swallowed as one field | same draft rebuilt: «آيفون 13 برو» |
| «لا، خله 14 برو» | ignored | title «آيفون 14 برو» |
| «أبي أبيع مسدس حقيقي» | draft accepted | refused before any draft; also at publication |
| «قارن أول اثنين» | clarification | comparison of 1 and 2 |
| «حولهم لجدول» | model | table, no model call |
| «أبي اللي بعمّان فقط» | new empty search | 2 of 3 results kept, no search |
| «ورني تفاصيل الثاني» | model | result 2 opened |
| «ضيف الثاني للسلة» after details | clarification | second card of the list added |
| «كم سعر جاسم برو؟» | model | plans card (price not approved) |
| «لا قصدي للكويت تحديدًا» after a general answer | marketplace search | model (correction) |
| «خلاص نرجع للتسوق، أبي سماعة» | model | search |
| «ورني مثال لبطاقة إعلان سيارة» | tutorial / search | illustrative card |
| «كم عمولة جاسم على البائع؟» (AU-01) | not policies | policies |

Known remaining: «السعر 280 دينار والكمية 0» (two fields in one sentence) goes to the model;
«أي منتج عندي أكثر مبيعًا؟» goes to the model (no product-level ranking read); marketing quality
and general answers need a real model (not measured here: no paid calls).

LAB_RESULTS_PLACEHOLDER

## E. Commerce journeys

COMMERCE_TABLE_PLACEHOLDER

## F. Subscription simulation

SUBSCRIPTION_PLACEHOLDER

## G. Whop

See `WHOP_READINESS_2026-11-13.md`.

## H. Regression

REGRESSION_PLACEHOLDER

## I–L

FINAL_PLACEHOLDER
