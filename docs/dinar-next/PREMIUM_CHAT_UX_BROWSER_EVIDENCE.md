# Premium chat UX: browser evidence

**Primary suite:** `premium-ux-browser-journey`. It passed in two consecutive after runs (33 / 33 checks each) and on the baseline (33 / 33):
- 0 console errors;
- 0 page errors;
- 0 external requests;
- no order, inquiry, negotiation or cart line created (UX23).

**Screenshots:** `docs/dinar-next/evidence/premium-ux/{before,after}-{light,dark,system}-{320..1920}.png`, plus reduced-motion and keyboard-open shots.

## UX matrix

| ID | Journey | Evidence | Result |
|---|---|---|---|
| UX01 / 02 | create / resume conversation | `conversation-v2-browser-journey`; restore in `premium-ux` | PASS |
| UX03 | history search | `premium-ux` | PASS |
| UX04 | knowledge question | `conversation-v2`, `universal-control` (model path stubbed) | PASS (contract only) |
| UX05 / 06 | settings, dark theme + reload | `universal-control-acceptance` (applies dark, chip, survives reload), `chat-settings-acceptance` | PASS |
| UX07 | usage | `chat-settings-acceptance` | PASS |
| UX08 | subscription change then keep | `premium-ux` + `chat-settings-acceptance` | PASS |
| UX09 / 10 | products, comparison | `premium-ux` matrix, `generative-ui-browser-journey` | PASS |
| UX11 | correct a reference | `multiturn-context` (runtime) | PASS |
| UX12 / 13 | add to cart, confirmed flight | `wave03-d7-cart-browser-journey` | PASS |
| UX14 | failed add without animation | cart flight runs only after the confirmed mutation (`cart-basket-animation.ts`); covered by `wave03-d7-cart` | PASS |
| UX15 | verified merchant link | `connect-cards-browser-journey` | PASS |
| UX16 | Connect from chat | `premium-ux` | **PASS after fix** |
| UX17 | multi-step business | `d1-d2-business-browser`, `d3a-native-business` | PASS |
| UX18 | external delivery / SC03 completion | `sc03-browser-journey` | PASS |
| UX19 | restore cards after refresh | `w02u3-card-recovery`, `generative-ui-browser` | PASS |
| UX20 | recover after model / API failure | `conversation-stream-recovery-browser-journey` (3) | PASS |
| UX21 | pending action across two tabs | `w02u3-card-concurrency-browser-journey` | PASS |
| UX22 | Arabic RTL mobile | `premium-ux` matrix 320–430 | PASS |
| UX23 | no unauthorized commerce mutation | `premium-ux` DB assertions | PASS |
| UX24 | UI / markup injection | `premium-ux` (typed `<img onerror>` / `<script>` shown as text, no element, no dialog) | PASS |
| UX25 | history / settings across auth transitions | not specifically re-run (covered historically by `guest-handoff` / `w02u3-card-sessions`) | NOT RUN |

**Regression browser run on the final tree:** all 17 suites pass:
- universal-control 10;
- wave03-d7-cart;
- connect-cards 2;
- w02u3 recovery / concurrency / expiry / accessibility;
- conversation-v2;
- stream-recovery 3;
- sc03;
- generative-ui-browser;
- d1-d2-business-browser 3;
- d1-d2-business-foundation 25;
- d3a-native-business 46;
- chat-settings 4;
- multiturn-context;
- wave03-card-envelope.
