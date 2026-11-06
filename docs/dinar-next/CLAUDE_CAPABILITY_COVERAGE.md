# Capability coverage (registry 25)

**Legend for the "Model" column:**
- R: read tool.
- P: prepares a review that the user must confirm (the server re-validates).
- X: external, third party at check time.
- —: not exposed to the model.

| Domain | Model | Capabilities | Real service |
|---|---|---|---|
| Search / compare / listing detail | R | `searchListings`, `compareListings`, `getResource` | marketplace search (C1 SQL) |
| Cart / checkout | R + P | `readCart`, `reviewCheckout`, `prepareCartChange` | commerce |
| Orders / delivery | R | `readOrders`, `readFulfillment`, `readOrderIssues` | orders, fulfillment |
| Negotiation / inquiries | R + P | `readNegotiationStatus`, `prepareNegotiationProposal`, `prepareInquiryMessage`, `readBusinessInquiries` | negotiations |
| Business | R (seller only) | `readBusinessOverview`, `readSellerDues` | business, commissions |
| AI usage | R | `readAiUsage` (with projection) | usage reservations |
| Connect | R | `readConnectPartnerStatus` | connect/partners |
| Connect | X | `searchDomains`, `searchPartnerOffers` | connect/conversation |
| Policies | R | `readPolicy` | lib/policies |
| Self-knowledge | R | `describeDinarCapabilities` | registry (role-filtered) |
| Disputes / refunds / payouts / subscriptions | — | not exposed | provider-signed events, admin |
| Admin, markets, agreements | — | not exposed | admin |

**Open gaps** (no canonical service exists yet, so no tool was added):
- partner commission statements for the partner;
- dispute status timeline beyond order issues.
