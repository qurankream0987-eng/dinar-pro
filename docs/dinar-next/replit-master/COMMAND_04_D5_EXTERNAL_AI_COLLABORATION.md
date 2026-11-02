# Command 04 — D5 External AI Collaboration

## Current behavior

The existing smart-turn model path receives a bounded `sellerEmployee` context only when:

- the actor is authenticated;
- the market is available;
- the request matches the seller-help/marketing intent gate; and
- exactly one live D4 intelligent read grant exists for that actor and market.

The server chooses the business, grant, configuration, capability, and scope. None is model-selectable. The data is revalidated through D4 on each qualifying turn.

## Data sent to the model

At most four published listing summaries are included, each with a title capped at 100 characters, category capped at 40 characters, formatted price when known, and pricing mode. Listing IDs, seller contact details, coordinates, inventory quantities, unpublished drafts, customer conversations, orders, and payment records are excluded.

The accompanying instruction treats listing text as untrusted seller data, tells the model not to invent absent specifications, and explicitly denies write, publish, pricing, negotiation, and message-sending authority.

## Provider and acceptance status

- Provider selection and model-tool registry are unchanged.
- No live model call was made for D5 acceptance.
- The D5 test invokes the server context builder directly; it does not claim model quality.
- No paid provider was intentionally invoked; the isolated test runs report `outbound=0`.
- Actual-model factuality, refusal behavior, latency, cost, and provider retention remain **NOT_RUN**.

This context is a limited read integration, not an autonomous employee or an externally connected agent.
