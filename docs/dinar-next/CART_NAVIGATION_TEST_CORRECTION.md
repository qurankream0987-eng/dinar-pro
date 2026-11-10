# Authorized cart-navigation test correction

Base candidate: `8102cf9371ec714f0accfc85efd978e6e9b1e31e`.
Owner authorization: 2026-11-10, navigation-test correction only, local commit permitted;
no push, merge or deployment. Application code and API contracts are unchanged.

## Original failure and actual contract
Original assertion: `await page.waitForURL('**/cart')`, followed by Back/Forward checks
requiring that standalone URL and a prefilled composer to survive it.
The original FAIL is retained in `/workspace/dinar-premium-evidence/recovered-8102cf9`
and `/workspace/dinar-premium-evidence/release-candidate-8102cf9`.

`App.tsx` redirects `/cart` to `/ai?openSurface=cart`. `Ai.tsx` consumes that parameter,
removes it with `history.replaceState`, and sends the existing read-only «اعرض السلة»
command. When another conversation is active, `runCommand` opens a new read conversation;
it does not replace the original conversation. Conversation selection is persisted
separately from URL history. There is no standalone cart page or modal close operation.
Selecting the original conversation closes the cart view in the unified interface.

## Corrected checks
The generic nine-action loop keeps its prefill, focus, provider-call and forbidden-mutation
assertions. Navigation is moved into a dedicated check at 320px and 1440px:

- Activate the visible canonical cart control and verify an authoritative CART block in the
  server transcript and a rendered cart response inside the unified shell.
- Verify the entry parameter is consumed. Reload, Back and Forward must retain the persisted
  cart conversation/transcript, without replaying a turn or changing cart contents.
- Re-select the original conversation and verify its complete server response, pending state
  and confirmations remain unchanged. A different signed-in user must receive 403 or 404.
- Compare cart contents and order records before and after opening/closing the cart; forbid
  direct commerce/payment mutation requests.

The previous assumption that an unrelated unsent composer prefill persists across a command
which intentionally opens another conversation is not asserted as a product guarantee.
The original conversation's persisted pending state is checked instead. No assertion outside
this authorized navigation portion is removed or relaxed. No separate cart page is introduced.

## Evidence and limitations
The initial new run could not connect through a stale local PG relay (exit90); its logs remain
in `navigation-correction`. The restored isolated runner writes separate `navigation-qualified`
evidence. Only disposable test databases are used; no application migrations, financial rules,
market governance, Railway or production resources are modified.

Safari/WebKit remains BLOCKED by the unavailable binary and denied official download domain.
Real iPhone/Safari/VoiceOver testing remains NOT EXECUTED. Chromium acceptance cannot establish
universal cross-browser readiness. Final results will be appended after the regression runner
completes; this document does not itself establish PASS.

### Harness details recorded during implementation
The first navigation-check draft is archived as `navigation-qualified/first-navigation-test.mjs`.
Its exact-word cart text predicate did not recognize «سلتك». The final predicate accepts that
actual wording, while independently requiring the authoritative CART payload. The final setup
selects the original conversation through the real history UI: the general screenshot helper's
reload-time localStorage override would otherwise invalidate a persistence check.

The opt-in `DINAR_E_NAVIGATION_ONLY=1` rerun uses empty welcome screens at 320/1440 in both themes,
then retains the full nine-action, motion, drawer and cart-navigation assertions. Default full
matrix execution remains unchanged. This mode is explicitly recorded as a focused rerun, not
reported as another 160-screen campaign. Existing 160-screen and full regression evidence is
retained separately. A UI-only test correction does not change the application candidate code.

## Separately identified application defect
The corrected navigation check exposed repeated CART read conversations after browser Back:
Wouter's Redirect defaults to pushState, so `/cart` remained as an intermediate history entry.
Returning to that alias pushed a fresh read-command URL again and destroyed Forward history.
The failing 320/1440 evidence is retained in `navigation-corrected` (goForward timeout).

Application fix: `App.tsx` sets `replace` only on the legacy `/cart` redirect. The destination
remains `/ai?openSurface=cart`; no separate cart page, runtime, cart service, financial or legal
rule is introduced. This one-line fix is separately committed as `6128290`; navigation
assertions remain unchanged for its rerun in `navigation-history-fix`.

## Regression-attempt transparency
The first full post-fix experience run completed 26 journeys/22 layout cases but one journey,
registered-market-account-isolation, was interrupted by competing browser navigation from
/login to /. This occurred before its subsequent isolation assertions. Its report and screenshot
set are retained in `navigation-release/experience-first-attempt`; the test was not edited.
A single separate complete rerun is recorded in `navigation-experience-rerun`. Both the browser
script and API wrapper are byte-identical to their 8102cf9 versions. This timing-sensitive
harness observation must remain visible to Claude; it is not presented as an auth-logic fix.


## Final results
**CONDITIONALLY READY FOR CLAUDE REVIEW**. Latest relevant battery: 7 PASS, 0 FAIL.
The unchanged full experience rerun passed all 26 journeys and 22 layout cases. Its earlier
interrupted-login FAIL remains retained and is a timing-sensitive harness risk for review.
Full default browser matrix:160 PASS; welcome actions:18/18; motion:6 profiles; cart navigation:
2/2 at320/1440. Reload, Back, Forward, exact cart/transcript preservation, pending-state
restoration and foreign-account denial all PASS. No direct commerce mutation was observed;
orders/listings remained1/23 before and after the browser interaction campaign.

The relevant canonical regression suites also PASS: experience-upgrade, card accessibility,
long-conversation performance, Connect cards, SC03 and wave03 cart. Workspace typecheck and
production browser builds PASS. No tests other than the authorized navigation files changed.

WebKit remains BLOCKED; actual iPhone/Safari and spoken manual screen-reader output are
NOT EXECUTED (2 manual groups). Chromium observations do not establish universal acceptance.
The pre-existing large main-bundle warning and the retained interrupted-login harness attempt
remain disclosed risks. No production-ready claim, push, merge or deployment is authorized.

[Machine-readable results](cart-navigation-evidence/summary.json).
[Mobile cart](cart-navigation-evidence/cart-open-320.png),
[desktop cart](cart-navigation-evidence/cart-open-1440.png),
[restored mobile confirmation](cart-navigation-evidence/cart-navigation-320.png),
[restored desktop confirmation](cart-navigation-evidence/cart-navigation-1440.png).

Nonempty cart persistence and server-confirmed receipt behavior are covered by the unchanged
wave03 cart suite; the dedicated navigation fixtures contain an empty cart. All production
rules and database schemas remain unchanged. Only disposable local test fixtures were used.
