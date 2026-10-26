# DINAR R4 — Provider readiness and market capabilities

## Scope and safety

- The market row remains the source of truth for country, currency, cash payment, and configured fulfilment methods. The capability projection is server-only; provider selection is never supplied by the browser.
- Each provider resolution requires a server-derived market, an environment-specific registration, and an allowed market policy. Unknown deployment environments fail closed. Live selection additionally requires `DINAR_LIVE_PROVIDERS_ENABLED=true`; no live adapter is registered.
- The market policy defaults to deny. The existing text-AI fallback is permitted only in development, only for the resolved market, and only when `DINAR_AI_MODEL_FALLBACK=true`.
- No database schema, migration, seed, or production data was changed. A development API key alone is not reported as a sandbox or live provider connection.
- Markets remain country-scoped. Cross-border delivery, international shipping, and cross-border driver assignment are unavailable. DINAR remains authoritative for marketplace search, orders, payment state, delivery state, and promotions.

## Readiness matrix

`Sandbox` and `Live` below describe actual provider connections, not test doubles or interfaces. No row is marked connected because no provider connection was tested or registered.

| Capability | Boundary / adapter today | Sandbox | Live | Credential names | Can connect from credentials alone? |
| --- | --- | --- | --- | --- | --- |
| AI text | OpenRouter `openrouter/free` by default; OpenAI remains an explicit server-configured option; development opt-in | Not connected | Not connected | `OPENROUTER_API_KEY`, `OPENAI_API_KEY` | **Development only:** provider selection is server-side and requires `DINAR_AI_MODEL_FALLBACK=true`; the OpenRouter route has no paid-OpenAI fallback. |
| Vision | Suggestion interface and validation; no real image-model adapter | Not connected | Not connected | Not selected | No; implement/select a vision adapter first. |
| SMS / phone verification | Provider interface plus development/test code delivery only | Not connected | Not connected | Not selected | No; choose a vendor and implement its adapter. |
| Google login | Identity-verification contract only; no login route or account-linking flow | Not connected | Not connected | Not selected | No; implement the OAuth flow and DINAR-owned account/session linking. |
| Maps | Provider contract only | Not connected | Not connected | Not selected | No; choose and implement a map adapter. |
| Geocoding | Provider contract only | Not connected | Not connected | Not selected | No; choose and implement a geocoding adapter. |
| Routes | Provider contract only | Not connected | Not connected | Not selected | No; choose and implement a route adapter. |
| Payment | DINAR payment contract and test-only adapter; market configuration currently permits cash direct only | Not connected | Not connected | Not selected | No; vendor adapter, market policy, legal review, and a separate sandbox verification are required. Real money remains disabled. |
| Notifications | In-app order action items only; no outbound provider adapter | Not connected | Not connected | Not selected | No; choose a channel/vendor and implement delivery. |
| Driver GPS | Ephemeral tracking contract; no location provider registration | Not connected | Not connected | Not selected | No; implement and verify a market-scoped provider adapter. Precise coordinates must remain out of logs, chat, and analytics. |
| External delivery | Contract only; no carrier adapter | Not connected | Not connected | Not selected | No; choose and implement a carrier adapter. DINAR keeps order and delivery-state authority. |

For unselected vendors, credential names are intentionally left unspecified rather than inventing environment-variable names. Credential *values* were not read or copied.

## Market capability projection

`buildMarketCapabilityRegistry` builds a country-keyed snapshot from the current market rows; `getMarketCapabilityProfile` projects one resolved market at a time:

- Currency and minor-unit scale come from that market's resolved values.
- Cash direct and seller delivery come from the market's existing `paymentMethods` and `fulfilmentMethods`.
- Independent courier is market-controlled by `COURIER`; the admin validator now accepts that method, but this change did not enable it in any market.
- Electronic payment, SMS delivery, Google login, maps, geocoding, routes, outbound notifications, and external delivery remain unavailable until both policy and a provider adapter exist.
- Phone verification's development code response is not counted as an SMS connection. In-app order action items are not counted as an outbound notification provider.

The existing user-owned `provider-connections` feature is for seller catalog synchronization and driver links. It is not a registry of DINAR's upstream service providers and is not reused for that purpose.

