# Claude — capability orchestration matrix

**Source of truth:** `CAPABILITY_REGISTRY`. 23 model capabilities, all `availability: MODEL_TOOL`.

**Guarantees for every capability:**
- Actor and market are taken from the session.
- Arguments are strict-schema validated.
- Any write is a prepare, executed only after the user's explicit confirmation by the canonical service.

| Tool | Kind | Roles | Canonical service | Test |
|---|---|---|---|---|
| searchListings, getResource, compareListings | read | buyer/seller | marketplace search / live revalidation | ai-foundation, routing-eval |
| readInventory, readBusinessInquiries, readNegotiationStatus, readCart, reviewCheckout, readOrders, readFulfillment | read | per role | inventory, inquiries, negotiations, cart, commerce.planCheckout, orders, delivery | ai-foundation-02, wave04 |
| prepareInquiryMessage, prepareListingDraft, requestPublicationReview, prepareNegotiationProposal, prepareCartChange | prepare → confirm | per role | action-foundation pending action | ai-foundation-02, wave04 |
| searchDomains, searchPartnerOffers | read (external referral) | buyer/seller | connect/conversation (legal gate, rate limit, typed cards) | intelligence-capabilities INT-01..03 |
| describeDinarCapabilities | read | buyer/seller | derived from the registry | INT-02, INT-07 |
| readBusinessOverview | read | seller (owner) | resolveBusinessAccess + business-catalog | INT-06 |
| readOrderIssues | read | buyer/seller | disputes, refund obligations, cash refunds (own orders) | INT-06 |
| readSellerDues | read | seller | lib/seller-dues (shared with GET /seller-dues) | INT-08, phase2 |
| prepareBusinessListingAction | prepare → confirm | seller (owner) | executeBusinessTurn (D3-A) | d3a D3A-23M |
| **readAiUsage** | read | buyer/seller | usageCardView + aiUsageSummary + usageProjection | usage-intelligence (18) |

## Owner examples (scripted orchestration)

| Example | Status |
|---|---|
| A — «وين وصل طلبي؟» ("where is my order?") | Deterministic orders route; readOrders and readFulfillment for the model |
| B — «كم عليّ عمولات؟» ("how much commission do I owe?") | readSellerDues |
| C — «شوف أي منتجاتي خلصت» ("see which of my products ran out") | Deterministic seller advice; readInventory and readBusinessOverview for the model. Changes go only through prepareBusinessListingAction plus confirmation |
| D — project plus name, domain and designer | Name: model text. Domain: searchDomains (availability only, never a purchase). Designer: searchPartnerOffers (only real reviewed partners) |
| E — cart, compare, then prepare the order | readCart, compareListings, reviewCheckout. The order is placed only by the user's confirmation and the checkout authority |

**Gaps:**
- No model tool for delivery-driver operations or for opening disputes or refunds. Opening one is a write and stays on the existing typed routes.
- Connect partner owners have no model read of their referral or commission status.
