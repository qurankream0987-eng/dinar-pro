# Negotiated Commerce N01–N36 evidence matrix

Results below refer to the named assertions, not to similarity of test names. The
G2 suite was executed against a fresh loopback-only disposable PostgreSQL database
(90/90); G3 browser acceptance (6/6) and F5 (27/27) also passed on disposable databases.

| ID | Contract | Existing implementation / evidence | Execution | Missing assertion / final status |
|---|---|---|---|---|
| N01 | Fixed-price publication | F5 `F5-01` publishes via canonical draft and publish action; verifies PUBLISHED, FIXED, and the exact 290.000 JOD amount | F5 27/27 | None — **VERIFIED** |
| N02 | Negotiable-price publication | G2 `G2-21` publishes canonical draft and asserts `NEGOTIABLE` | G2 90/90 | None — **VERIFIED** |
| N03 | Publish without public price | G2 `S-G01`–`S-G05` publish through chat after explicit confirmation; asserts `OPEN_TO_OFFERS` and null price | G2 90/90 | None — **VERIFIED** |
| N04 | No-price search display | `FINAL-SAME-LISTING` discovers the same conversationally published listing; G3 `UI-N04` asserts the rendered card says «قدّم عرضك», never free or zero | G2 90/90; G3 6/6 | None — **VERIFIED** |
| N05 | No-price comparison | G2 `N05` compares canonical-search results and asserts «بالاتفاق» for the null-priced item and the exact numeric price for the other | G2 90/90 | None — **VERIFIED** |
| N06 | No-price purchase requires negotiation | `FINAL-SAME-LISTING` blocks both pre-agreement chat/cart purchase and direct order creation; then negotiates, accepts, and orders the same listing | G2 90/90 | None — **VERIFIED** |
| N07 | Buyer price offer | G2 `G2-22` verifies review without mutation; `G2-23` confirms an OPEN offer | G2 90/90 | None — **VERIFIED** |
| N08 | Seller accepts offer | G2 `NC-08/14/17/20` accepts through negotiation authority | G2 90/90 | None — **VERIFIED** |
| N09 | Seller rejects offer | G2 `NC-10/13` asserts seller rejection is terminal | G2 90/90 | None — **VERIFIED** |
| N10 | Seller counter-offer | G2 `G2-26` confirms seller counter and COUNTERED status | G2 90/90 | None — **VERIFIED** |
| N11 | Buyer counter-offer | G2 `G2-26B` confirms buyer counter and event history | G2 90/90 | None — **VERIFIED** |
| N12 | Buyer accepts seller counter | G2 `G2-27` asserts ACCEPTED after revalidation | G2 90/90 | None — **VERIFIED** |
| N13 | Best-price request | G2 `G2-36B` creates a null-amount request and records its event | G2 90/90 | None — **VERIFIED** |
| N14 | Fixed-price negotiation opt-out | G2 `G2-24` verifies a fixed listing refuses an offer with no effects | G2 90/90 | None — **VERIFIED** |
| N15 | Duplicate offer protection | G2 `NC-FINAL-02/03/04` replays handoff/client message and submits simultaneous same-ID retries; confirms one review and one offer event | G2 90/90 | None — **VERIFIED** |
| N16 | Duplicate acceptance protection | G2 `G2-34` retries after resolution and races two same-version accepts through canonical authority; exactly one succeeds, version and ACCEPT event advance once, and no order is created by acceptance | G2 90/90 | None — **VERIFIED** |
| N17 | Stale acceptance rejection | G2 `NC-10/13` rejects acceptance at the old version | G2 90/90 | None — **VERIFIED** |
| N18 | Expired offer rejection | G2 `G2-34` expires/resolves an offer and verifies it cannot be reused | G2 90/90 | None — **VERIFIED** |
| N19 | Listing unavailable before checkout | G2 `G2-33` rejects stale/sold acceptance; `G2-36B` races checkout against one stock unit | G2 90/90 | None — **VERIFIED** |
| N20 | Negotiated BUY_REVIEW | G2 `G2-30` and `G2-36B` assert the accepted amount and negotiated flag in review | G2 90/90 | None — **VERIFIED** |
| N21 | Negotiated order snapshot | G2 `G2-30` / `G2-36B` assert order unit price and subtotal equal agreed price | G2 90/90 | None — **VERIFIED** |
| N22 | Commission based on agreed price | G2 `G2-32` and `G2-36B` assert 1000 bps and amount derived from agreement | G2 90/90 | None — **VERIFIED** |
| N23 | Public listing price unchanged | G2 `G2-29` and `G2-36B` assert public price remains unchanged or null | G2 90/90 | None — **VERIFIED** |
| N24 | Add public price later | G2 `N24/N25` uses the canonical seller edit route to change a published null-priced listing to 25.000 JOD | G2 90/90 | None — **VERIFIED** |
| N25 | Remove public price / enable offers | G2 `N24/N25` removes the canonical listing price, switches to OPEN_TO_OFFERS, and preserves negotiation-event history | G2 90/90 | None — **VERIFIED** |
| N26 | Service negotiation | G2 `G2-38` and G-FINAL `J06` use shared negotiation authority for services | G2 90/90; G-FINAL 22/22 | None — **VERIFIED** |
| N27 | Car negotiation | G2 `G2-36B` negotiates a single-stock car and races two checkouts | G2 90/90 | None — **VERIFIED** |
| N28 | Unusual lawful item negotiation | G2 `G2-36B` completes an unpriced industrial packaging machine negotiation and order | G2 90/90 | None — **VERIFIED** |
| N29 | Guest offer requires authentication | G2 `NC-FINAL-01` asserts auth required and no negotiation/event created | G2 90/90 | None — **VERIFIED** |
| N30 | Cross-user access denied | G2 `G2-35/36`, G-FINAL `J05`, and guest-handoff tests deny foreign access | G2 90/90; G-FINAL 22/22 | None — **VERIFIED** |
| N31 | Buyer negotiation list with ordinals | G2 `N31/N32` lists two buyer-owned negotiations using «اعرض عروضي» and verifies «الثاني» resolves to the second | G2 90/90 | None — **VERIFIED** |
| N32 | Seller incoming-offers list with ordinals | G2 `N31/N32` lists two seller-owned incoming offers using «اعرض عروض السعر»; «الثاني» then «اقبل» accepts only the selected offer | G2 90/90 | None — **VERIFIED** |
| N33 | Advice does not create negotiation | G2 `G2-39` snapshots effects and asserts advice creates no send action | G2 90/90 | None — **VERIFIED** |
| N34 | Natural-language negotiation | G2 `G2-22`–`G2-27` exercises offer, counter, and acceptance via chat turns | G2 90/90 | None — **VERIFIED** |
| N35 | Unknown price excluded from numeric filters | G2 `NC-FINAL-09/10/11/12` checks lt/gt/range/sort with null-price listing | G2 90/90 | None — **VERIFIED** |
| N36 | Sponsored no-price listing remains price-truthful | G3 `UI-N36` joins a simulated active campaign to a null-priced listing and asserts the buyer card shows both «إعلان ممول» and «قدّم عرضك», never free or zero | G3 6/6 | None — **VERIFIED** |

## Closure

Verified: 36/36. Partial: none. The same seller-created unpriced iPhone is
published, discovered by a separate buyer, blocked from purchase before agreement,
negotiated, accepted, and ordered with the agreed amount and commission snapshots.
Seller draft and publication journeys also pass in the browser at desktop and
mobile widths. Promotions remain simulation-only; no live provider or real-money
path was exercised.
